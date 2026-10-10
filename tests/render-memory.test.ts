import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRenderMemoryGroup } from '../server/render-memory';

test(
  'kernel limit contains an allocating child, disables swap, and leaves the parent alive',
  { timeout: 20000 },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'watch-notes-memory-test-'));
    const before = await readFile('/proc/self/cgroup', 'utf8');
    const group = await createRenderMemoryGroup(dir, 128 * 1024 ** 2);
    try {
      await assert.rejects(group.assertContains(process.pid), /left its protected process group/);
      assert.equal(
        (await readFile(path.join(group.directory, 'memory.max'), 'utf8')).trim(),
        String(128 * 1024 ** 2),
      );
      assert.equal(
        (await readFile(path.join(group.directory, 'memory.swap.max'), 'utf8')).trim(),
        '0',
      );
      // Exercise the kernel's hard stop quickly; the production soft threshold
      // deliberately throttles first, which can delay an OOM for many seconds.
      await writeFile(path.join(group.directory, 'memory.high'), 'max');
      const child = spawn(
        group.launcher,
        [
          process.execPath,
          '-e',
          `
      const held = [];
      setInterval(() => held.push(Buffer.alloc(16 * 1024 * 1024, 1)), 20);
    `,
        ],
        { stdio: 'ignore' },
      );
      const [code, signal] = await once(child, 'exit');
      assert.equal(code, null);
      assert.equal(signal, 'SIGKILL');
      assert.equal((await group.sample()).oom, true);
      assert.equal(
        await readFile('/proc/self/cgroup', 'utf8'),
        before,
        'The parent must remain outside the export limit.',
      );
    } finally {
      await group.stop();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
