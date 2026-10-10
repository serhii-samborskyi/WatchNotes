import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { availableParallelism, cpus } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_EXPORT_MEMORY_GIB, MAX_RENDER_WORKERS } from '../lib/export-settings';
import { ExportMemoryError, GiB, memoryBudget, systemMemory } from './render-memory';
import { adaptiveMemoryBudget } from './adaptive-render';

const exec = promisify(execFile);
export function chromeGraphicsArgs(software = false) {
  return [
    ...(software
      ? ['--use-angle=swiftshader']
      : process.platform === 'linux'
        ? [
            '--enable-gpu',
            '--use-angle=vulkan',
            '--enable-features=Vulkan',
            '--disable-vulkan-surface',
          ]
        : ['--enable-gpu']),
    '--enable-unsafe-swiftshader',
  ];
}
async function executable(candidates: string[]) {
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return undefined;
}
export async function findChrome() {
  const chrome = await executable(
    [
      process.env.CHROME_PATH || '',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      ...['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA'].map((key) =>
        path.join(process.env[key] || '', 'Google/Chrome/Application/chrome.exe'),
      ),
    ].filter(Boolean),
  );
  if (!chrome)
    throw new Error(
      'Server rendering needs Chrome or Chromium. Set CHROME_PATH, or select This device.',
    );
  return chrome;
}

export type Encoder = { executable: string; codec: 'libx264' | 'h264_nvenc'; label: string };
let encoderPromise: Promise<Encoder> | undefined;
export function selectEncoder(fallback: string) {
  return (encoderPromise ??= (async () => {
    const installed = await executable(
      (process.env.PATH || '')
        .split(path.delimiter)
        .map((dir) => path.join(dir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')),
    );
    const local = await executable([
      fileURLToPath(new URL('../.cache/ffmpeg/ffmpeg', import.meta.url)),
    ]);
    const candidates = process.env.FFMPEG_PATH
      ? [process.env.FFMPEG_PATH]
      : [installed, local, fallback];
    for (const binary of [...new Set(candidates.filter((value): value is string => !!value))]) {
      try {
        const { stdout } = await exec(binary, ['-hide_banner', '-encoders'], { timeout: 10000 });
        if (!stdout.includes('h264_nvenc')) continue;
        // Listing an encoder does not prove that the driver/GPU can actually use it.
        await exec(
          binary,
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-f',
            'lavfi',
            '-i',
            // Probe a supported output size; 128px is below NVENC's minimum on some GPUs.
            'color=size=1280x720:rate=30',
            '-frames:v',
            '1',
            '-c:v',
            'h264_nvenc',
            '-f',
            'null',
            '-',
          ],
          { timeout: 15000 },
        );
        return { executable: binary, codec: 'h264_nvenc', label: 'NVIDIA H.264' };
      } catch {
        /* Driver unavailable: the bundled CPU encoder remains usable. */
      }
    }
    return {
      executable: process.env.FFMPEG_PATH || fallback,
      codec: 'libx264',
      label: 'CPU H.264',
    };
  })());
}

export function frameRanges(frames: number, workers: number) {
  return Array.from({ length: Math.min(frames, workers) }, (_, index) => ({
    from: Math.floor((index * frames) / Math.min(frames, workers)),
    to: Math.floor(((index + 1) * frames) / Math.min(frames, workers)),
  }));
}

export async function availableGpuMemory() {
  try {
    const { stdout } = await exec(
      'nvidia-smi',
      ['--query-gpu=memory.free', '--format=csv,noheader,nounits'],
      { timeout: 3000 },
    );
    const values = stdout.trim().split(/\r?\n/).map(Number);
    // On multi-GPU hosts Chrome's selected adapter is not known yet. Avoid
    // budgeting against a different card from the one that will render.
    if (values.length === 1 && Number.isFinite(values[0]) && values[0] >= 0)
      return values[0] * 1024 ** 2;
  } catch {
    /* Non-NVIDIA hosts still use RAM and CPU budgets. */
  }
  return undefined;
}

export function cpuSnapshot() {
  return cpus().reduce(
    (sum, cpu) => ({
      idle: sum.idle + cpu.times.idle,
      total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0),
    }),
    { idle: 0, total: 0 },
  );
}
export async function gpuLoad() {
  try {
    const { stdout } = await exec(
      'nvidia-smi',
      ['--query-gpu=utilization.gpu,memory.free', '--format=csv,noheader,nounits'],
      { timeout: 1500 },
    );
    if (stdout.trim().includes('\n')) return undefined;
    const [utilization, free] = stdout.trim().split(',').map(Number);
    if (Number.isFinite(utilization) && Number.isFinite(free))
      return { utilization, freeBytes: free * 1024 ** 2 };
  } catch {
    /* Other adapters still have CPU/RAM and concurrency controls. */
  }
  return undefined;
}

export function gpuWorkerBudget(workers: number, pixels: number, freeBytes?: number) {
  // Include Chrome render targets/bloom, note textures, readback and NVENC
  // surfaces, with headroom for the display and other applications. This is
  // a conservative estimate, not a guarantee against driver failures.
  const reserve = 512 * 1024 ** 2;
  const perWorker = 384 * 1024 ** 2 + pixels * 256;
  const capacity =
    freeBytes === undefined ? workers : Math.max(0, Math.floor((freeBytes - reserve) / perWorker));
  return { workers: Math.max(1, Math.min(workers, capacity)), software: capacity === 0 };
}

export function allocateRenderResources({
  frames,
  pixels,
  audioSeconds,
  requestedWorkers,
  cpuThreads,
  memoryBytes,
  totalMemoryBytes = memoryBytes,
  defaultWorkers = 2,
  requestedMemoryGiB = DEFAULT_EXPORT_MEMORY_GIB,
  resourcePercent,
}: {
  frames: number;
  pixels: number;
  audioSeconds: number;
  requestedWorkers: number;
  cpuThreads: number;
  memoryBytes: number;
  totalMemoryBytes?: number;
  defaultWorkers?: number;
  requestedMemoryGiB?: number;
  resourcePercent?: number;
}) {
  if (resourcePercent !== undefined) {
    const budget = adaptiveMemoryBudget(totalMemoryBytes, memoryBytes, 0, resourcePercent);
    const workers = Math.max(
      1,
      Math.min(
        frames,
        requestedWorkers || MAX_RENDER_WORKERS,
        Math.ceil((cpuThreads * resourcePercent) / 100 / 2),
      ),
    );
    return {
      workers,
      memoryLimitBytes: budget.limitBytes,
      memoryReserveBytes: budget.reserveBytes,
      threads: Math.max(1, Math.min(8, Math.floor((cpuThreads * resourcePercent) / 100 / workers))),
      workerLimitReason: undefined as string | undefined,
    };
  }
  const requested = requestedWorkers || defaultWorkers;
  const target = Number.isFinite(requested)
    ? Math.max(1, Math.min(MAX_RENDER_WORKERS, Math.floor(requested)))
    : 2;
  const budget = memoryBudget(memoryBytes, totalMemoryBytes, requestedMemoryGiB);
  const reserve = GiB + audioSeconds * 44100 * 24;
  const perWorker = pixels > 1280 * 720 ? 3 * GiB : 2 * GiB;
  const cpuLimit = Math.max(1, Math.floor(cpuThreads / 2));
  const memoryLimit = Math.floor((budget.limitBytes - reserve) / perWorker);
  if (memoryLimit < 1)
    throw new ExportMemoryError(
      'There is not enough available RAM to start a protected export. Close other memory-heavy tasks or try 720p.',
    );
  const workers = Math.max(1, Math.min(target, cpuLimit, memoryLimit, frames));
  let workerLimitReason: string | undefined;
  if (workers < requestedWorkers) {
    workerLimitReason =
      frames < requestedWorkers && workers === frames
        ? `Using ${workers} workers for this short clip.`
        : memoryLimit <= cpuLimit && workers === memoryLimit
          ? `Using ${workers} of ${requestedWorkers} requested workers to fit available memory.`
          : `Using ${workers} of ${requestedWorkers} requested workers to fit available CPU threads.`;
  }
  return {
    workers,
    memoryLimitBytes: budget.limitBytes,
    memoryReserveBytes: budget.reserveBytes,
    threads: Math.max(1, Math.min(8, Math.floor((cpuThreads - 2) / workers))),
    workerLimitReason,
  };
}

export async function renderResources(
  frames: number,
  pixels: number,
  audioSeconds: number,
  requestedWorkers = 0,
  requestedMemoryGiB = DEFAULT_EXPORT_MEMORY_GIB,
  resourcePercent?: number,
) {
  const memory = await systemMemory();
  return allocateRenderResources({
    frames,
    pixels,
    audioSeconds,
    requestedWorkers,
    requestedMemoryGiB,
    resourcePercent,
    cpuThreads: availableParallelism(),
    memoryBytes: memory.availableBytes,
    totalMemoryBytes: memory.totalBytes,
    defaultWorkers: Number(process.env.EXPORT_WORKERS || 2),
  });
}
