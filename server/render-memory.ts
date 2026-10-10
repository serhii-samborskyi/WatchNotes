import { access, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { freemem, totalmem } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_EXPORT_MEMORY_GIB,
  MIN_EXPORT_MEMORY_GIB,
  MAX_EXPORT_MEMORY_GIB,
  EXPORT_MEMORY_STOP_RATIO,
} from '../lib/export-settings';

const exec = promisify(execFile);
export const GiB = 1024 ** 3;
export class ExportMemoryError extends Error {
  constructor(
    message = 'Export reached its render memory limit. Increase the RAM limit in export settings, or try fewer workers or 720p.',
  ) {
    super(message);
    this.name = 'ExportMemoryError';
  }
}

export async function systemMemory() {
  let totalBytes = totalmem(),
    availableBytes = freemem();
  try {
    const info = await readFile('/proc/meminfo', 'utf8');
    totalBytes = Number(/MemTotal:\s+(\d+) kB/.exec(info)?.[1]) * 1024 || totalBytes;
    availableBytes = Number(/MemAvailable:\s+(\d+) kB/.exec(info)?.[1]) * 1024;
    if (!Number.isFinite(availableBytes)) availableBytes = freemem();
  } catch {
    /* Non-Linux hosts use the OS memory API. */
  }
  try {
    const membership = await readFile('/proc/self/cgroup', 'utf8');
    const relative = /^0::(.+)$/m.exec(membership)?.[1];
    if (relative) {
      let dir = path.join('/sys/fs/cgroup', relative);
      // A service/container can have limits on any ancestor, not just the root.
      while (dir.startsWith('/sys/fs/cgroup/')) {
        const [limit, used] = await Promise.all([
          readFile(path.join(dir, 'memory.max'), 'utf8'),
          readFile(path.join(dir, 'memory.current'), 'utf8'),
        ]);
        if (Number.isFinite(Number(limit))) {
          totalBytes = Math.min(totalBytes, Number(limit));
          availableBytes = Math.min(availableBytes, Number(limit) - Number(used));
        }
        dir = path.dirname(dir);
      }
    }
  } catch {
    /* cgroup v2 is not available on every host. */
  }
  return { totalBytes, availableBytes: Math.max(0, availableBytes) };
}

export function memoryBudget(
  availableBytes: number,
  totalBytes: number,
  requestedGiB = DEFAULT_EXPORT_MEMORY_GIB,
) {
  if (
    !Number.isInteger(requestedGiB) ||
    requestedGiB < MIN_EXPORT_MEMORY_GIB ||
    requestedGiB > MAX_EXPORT_MEMORY_GIB
  )
    throw new RangeError('Invalid export RAM limit.');
  const reserveBytes = Math.max(2 * GiB, Math.min(6 * GiB, totalBytes * 0.2));
  // Leave room for the API's bounded frame buffers in addition to OS headroom.
  const limitBytes =
    Math.floor(
      Math.min(
        requestedGiB * GiB,
        availableBytes - reserveBytes - GiB,
        totalBytes - reserveBytes - GiB,
      ) / 4096,
    ) * 4096;
  return { reserveBytes, limitBytes: Math.max(0, limitBytes) };
}

export function memoryPressure(
  usedBytes: number,
  limitBytes: number,
  availableBytes: number,
  reserveBytes: number,
  apiRss: number,
) {
  return (
    memoryPressureReason(usedBytes, limitBytes, availableBytes, reserveBytes, apiRss) !== undefined
  );
}

export function memoryPressureReason(
  usedBytes: number,
  limitBytes: number,
  availableBytes: number,
  reserveBytes: number,
  apiRss: number,
) {
  if (availableBytes < reserveBytes)
    return 'Export stopped because available server RAM became too low. Free some RAM or try fewer workers.';
  if (apiRss > 1.5 * GiB)
    return 'Export stopped because frame transfers used too much server RAM. Try fewer workers or 720p.';
  if (usedBytes >= limitBytes * EXPORT_MEMORY_STOP_RATIO)
    return 'Export reached its render memory limit. Increase the RAM limit in export settings, or try fewer workers or 720p.';
  return undefined;
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** A kernel-enforced budget shared by Chrome, its descendants and all encoders. */
export async function createRenderMemoryGroup(
  dir: string,
  limitBytes: number,
  cpuQuotaPercent?: number,
) {
  if (process.platform !== 'linux')
    throw new Error(
      'Protected server rendering currently requires Linux with a systemd user session. Select This device on this computer.',
    );
  const unit = `watch-notes-render-${randomUUID()}.service`;
  const stop = async () => {
    await exec('systemctl', ['--user', 'stop', unit], { timeout: 10000 }).catch(() => {});
    await exec('systemctl', ['--user', 'reset-failed', unit], { timeout: 5000 }).catch(() => {});
  };
  try {
    await exec(
      'systemd-run',
      [
        '--user',
        `--unit=${unit}`,
        '--quiet',
        '--service-type=exec',
        `--property=MemoryMax=${limitBytes}`,
        `--property=MemoryHigh=${Math.floor(limitBytes * 0.9)}`,
        '--property=MemorySwapMax=0',
        '--property=OOMPolicy=kill',
        '--property=KillMode=control-group',
        '--property=TimeoutStopSec=3',
        // Adaptive jobs may wait for other workloads while retaining segments.
        `--property=RuntimeMaxSec=${cpuQuotaPercent === undefined ? 3600 : 43200}`,
        ...(cpuQuotaPercent === undefined
          ? []
          : [
              `--property=CPUQuota=${cpuQuotaPercent}%`,
              '--property=CPUWeight=25',
              '--property=IOWeight=25',
            ]),
        '/usr/bin/sleep',
        'infinity',
      ],
      { timeout: 10000 },
    );
    const { stdout } = await exec(
      'systemctl',
      ['--user', 'show', unit, '--property=ControlGroup', '--value'],
      { timeout: 5000 },
    );
    const group = stdout.trim();
    if (!group.startsWith('/') || !group.endsWith(`/${unit}`))
      throw new Error('Invalid render cgroup.');
    const directory = path.join('/sys/fs/cgroup', group);
    const procs = path.join(directory, 'cgroup.procs');
    await access(procs, constants.W_OK);
    const [maximum, swap] = await Promise.all([
      readFile(path.join(directory, 'memory.max'), 'utf8'),
      readFile(path.join(directory, 'memory.swap.max'), 'utf8'),
    ]);
    if (Number(maximum) !== limitBytes || Number(swap) !== 0)
      throw new Error('Memory controls were not applied.');
    // Join before exec/fork so every descendant inherits the limit. Never move
    // the API, editor, Codex, or another application's processes into this group.
    const launcher = path.join(dir, 'contained-exec.sh');
    await writeFile(
      launcher,
      `#!/bin/sh\nprintf '%s\\n' "$$" > ${quote(procs)} || exit 78\nexec ${cpuQuotaPercent === undefined ? '' : '/usr/bin/nice -n 10 '}"$@"\n`,
      { mode: 0o700 },
    );
    await exec(launcher, ['/bin/true'], { timeout: 5000 });
    return {
      unit,
      directory,
      launcher,
      limitBytes,
      async resize(bytes: number) {
        if (bytes === limitBytes) return;
        // Only grow during active rendering. Shrinking a live cgroup can block
        // on reclaim or kill processes before the queue has relinquished pages.
        if (bytes < limitBytes) return;
        await exec(
          'systemctl',
          [
            '--user',
            'set-property',
            '--runtime',
            unit,
            `MemoryMax=${bytes}`,
            `MemoryHigh=${Math.floor(bytes * 0.9)}`,
          ],
          { timeout: 5000 },
        );
        limitBytes = bytes;
      },
      async assertContains(pid: number | undefined) {
        if (!pid) throw new Error('Export memory protection stopped unexpectedly.');
        const membership = await readFile(`/proc/${pid}/cgroup`, 'utf8');
        const current = /^0::(.+)$/m.exec(membership)?.[1];
        if (current !== group && !current?.startsWith(`${group}/`))
          throw new Error(
            'Export memory protection stopped unexpectedly. The renderer left its protected process group.',
          );
      },
      async chromeLauncher(executable: string) {
        const file = path.join(dir, 'contained-chrome.sh');
        await writeFile(file, `#!/bin/sh\nexec ${quote(launcher)} ${quote(executable)} "$@"\n`, {
          mode: 0o700,
        });
        return file;
      },
      async sample() {
        try {
          const [current, events, stat] = await Promise.all([
            readFile(path.join(directory, 'memory.current'), 'utf8'),
            readFile(path.join(directory, 'memory.events'), 'utf8'),
            readFile(path.join(directory, 'memory.stat'), 'utf8'),
          ]);
          // Clean file cache is reclaimable; counting it as live renderer RAM
          // causes false pressure after writing many video segments.
          const inactiveFile = Number(/^inactive_file (\d+)$/m.exec(stat)?.[1] || 0);
          return {
            usedBytes: Number(current),
            workingBytes: Math.max(0, Number(current) - inactiveFile),
            oom: /^oom_kill [1-9]/m.test(events),
          };
        } catch {
          const { stdout: result } = await exec(
            'systemctl',
            ['--user', 'show', unit, '--property=Result', '--value'],
            { timeout: 3000 },
          );
          if (result.trim() === 'oom-kill')
            return { usedBytes: limitBytes, workingBytes: limitBytes, oom: true };
          throw new Error('Export memory protection stopped unexpectedly.');
        }
      },
      stop,
    };
  } catch (error) {
    await stop();
    console.error('Cannot establish export memory limit:', error);
    throw new Error(
      'The server could not enable its memory protection. Server export has been stopped; check the systemd user session or select This device.',
    );
  }
}
export type RenderMemoryGroup = Awaited<ReturnType<typeof createRenderMemoryGroup>>;
