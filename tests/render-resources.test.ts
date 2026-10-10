import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocateRenderResources, gpuWorkerBudget } from '../server/render-resources';
import { isGraphicsFailure, publicExportError } from '../server/export-recovery';
import { serverExportSchema } from '../lib/validation';
import { createDemo, DEFAULT_SETTINGS } from '../lib/project';
import {
  ExportMemoryError,
  GiB,
  memoryBudget,
  memoryPressure,
  memoryPressureReason,
} from '../server/render-memory';

const generous = {
  frames: 300,
  pixels: 1280 * 720,
  audioSeconds: 10,
  cpuThreads: 24,
  memoryBytes: 24 * 1024 ** 3,
  totalMemoryBytes: 32 * 1024 ** 3,
};

test('GPU memory limits concurrency and falls back to CPU when even one worker will not fit', () => {
  assert.deepEqual(gpuWorkerBudget(8, 1280 * 720, 12 * 1024 ** 3), { workers: 8, software: false });
  assert.deepEqual(gpuWorkerBudget(8, 1280 * 720, 2.6 * 1024 ** 3), {
    workers: 3,
    software: false,
  });
  assert.deepEqual(gpuWorkerBudget(8, 1920 * 1080, 2.6 * 1024 ** 3), {
    workers: 2,
    software: false,
  });
  assert.deepEqual(gpuWorkerBudget(4, 1920 * 1080, 256 * 1024 ** 2), {
    workers: 1,
    software: true,
  });
  assert.deepEqual(gpuWorkerBudget(4, 1920 * 1080), { workers: 4, software: false });
});

test('only renderer failures are retried, and public errors omit internal traces', () => {
  for (const message of [
    'The video renderer lost its graphics context. Np.readFrame (http://127.0.0.1:4311/render.js:4636:16603)',
    'Protocol error: Target closed',
    'The GPU stopped responding while reading a video frame.',
    'OpenEncodeSessionEx failed: out of memory',
  ]) {
    assert.ok(isGraphicsFailure(new Error(message)));
    assert.doesNotMatch(publicExportError(new Error(message)), /127\.0\.0\.1|render\.js|Np\./);
  }
  for (const message of [
    'ENOSPC: no space left',
    'Frame transfer failed.',
    'Audio rendering did not finish.',
  ])
    assert.equal(isGraphicsFailure(new Error(message)), false);
  assert.match(publicExportError(new Error('ENOSPC at /tmp/private/file')), /disk space/);
});

test('explicit worker counts override defaults but never the protected memory budget', () => {
  for (const requestedWorkers of [1, 3, 4, 8]) {
    const result = allocateRenderResources({ ...generous, requestedWorkers, defaultWorkers: 2 });
    assert.equal(result.workers, Math.min(requestedWorkers, 3));
    if (requestedWorkers > 3) assert.match(result.workerLimitReason!, /memory/);
    else assert.equal(result.workerLimitReason, undefined);
    assert.ok(result.threads * result.workers <= generous.cpuThreads);
  }
  assert.equal(allocateRenderResources({ ...generous, requestedWorkers: 0 }).workers, 2);
  assert.equal(
    allocateRenderResources({ ...generous, requestedWorkers: 0, defaultWorkers: 2 }).workers,
    2,
  );
});

test('worker budgets explain memory, CPU and short-clip limits', () => {
  const ram = allocateRenderResources({
    ...generous,
    requestedWorkers: 8,
    memoryBytes: 11 * 1024 ** 3,
  });
  assert.equal(ram.workers, 1);
  assert.match(ram.workerLimitReason!, /memory/);
  const cpu = allocateRenderResources({ ...generous, requestedWorkers: 8, cpuThreads: 4 });
  assert.equal(cpu.workers, 2);
  assert.match(cpu.workerLimitReason!, /CPU/);
  const short = allocateRenderResources({ ...generous, requestedWorkers: 8, frames: 3 });
  assert.equal(short.workers, 3);
  assert.match(short.workerLimitReason!, /short clip/);
});

test('unsafe starts are refused; eight requested workers cannot consume all host RAM', () => {
  assert.throws(
    () => allocateRenderResources({ ...generous, memoryBytes: 2 * GiB, requestedWorkers: 8 }),
    ExportMemoryError,
  );
  const result = allocateRenderResources({
    ...generous,
    pixels: 1920 * 1080,
    audioSeconds: 196,
    requestedWorkers: 8,
  });
  assert.equal(result.workers, 2);
  assert.equal(result.memoryLimitBytes, 8 * GiB);
  assert.equal(result.memoryReserveBytes, 6 * GiB);
  assert.equal(memoryBudget(100 * GiB, 128 * GiB).limitBytes, 8 * GiB);
  assert.equal(
    isGraphicsFailure(new ExportMemoryError()),
    false,
    'RAM pressure must not retry on CPU.',
  );
  assert.match(publicExportError(new ExportMemoryError()), /memory limit/);
});

test('live cutoff uses available RAM and export usage, not misleading total-minus-free RAM', () => {
  assert.equal(memoryPressure(2 * GiB, 8 * GiB, 12 * GiB, 6 * GiB, 0.5 * GiB), false);
  assert.equal(memoryPressure(6.5 * GiB, 8 * GiB, 12 * GiB, 6 * GiB, 0.5 * GiB), true);
  assert.equal(memoryPressure(2 * GiB, 8 * GiB, 5 * GiB, 6 * GiB, 0.5 * GiB), true);
  assert.equal(memoryPressure(2 * GiB, 8 * GiB, 12 * GiB, 6 * GiB, 1.6 * GiB), true);
});

test('custom RAM budgets exceed 8 GiB and the old percentage cap while preserving system headroom', () => {
  assert.equal(memoryBudget(24 * GiB, 32 * GiB, 16).limitBytes, 16 * GiB);
  assert.equal(memoryBudget(24 * GiB, 32 * GiB, 24).limitBytes, 17 * GiB);
  assert.equal(memoryBudget(12 * GiB, 32 * GiB, 16).limitBytes, 5 * GiB);
  assert.equal(memoryBudget(2 * GiB, 32 * GiB, 256).limitBytes, 0);
  const higher = allocateRenderResources({
    ...generous,
    pixels: 1920 * 1080,
    requestedWorkers: 8,
    requestedMemoryGiB: 16,
  });
  assert.equal(higher.memoryLimitBytes, 16 * GiB);
  assert.equal(higher.workers, 4);
  assert.equal(memoryPressure(9 * GiB, 16 * GiB, 12 * GiB, 6 * GiB, 0.5 * GiB), false);
  assert.equal(memoryPressure(13 * GiB, 16 * GiB, 12 * GiB, 6 * GiB, 0.5 * GiB), true);
  assert.match(
    memoryPressureReason(2 * GiB, 16 * GiB, 5 * GiB, 6 * GiB, 0.5 * GiB)!,
    /available server RAM/,
  );
  assert.match(
    memoryPressureReason(2 * GiB, 16 * GiB, 12 * GiB, 6 * GiB, 2 * GiB)!,
    /frame transfers/,
  );
});

test('RAM limit accepts whole GiB values and preserves the 8 GiB default for existing clients', () => {
  const request = {
    project: { version: 1, song: createDemo(), settings: DEFAULT_SETTINGS },
    options: { width: 1280, height: 720, fps: 30, start: 0, end: 2, rate: 1, audio: false },
  };
  assert.equal(serverExportSchema.parse(request).options.memoryLimitGiB, 8);
  for (const memoryLimitGiB of [4, 8, 12, 16, 24, 256])
    assert.equal(
      serverExportSchema.parse({ ...request, options: { ...request.options, memoryLimitGiB } })
        .options.memoryLimitGiB,
      memoryLimitGiB,
    );
  for (const memoryLimitGiB of [0, 3, 7.5, 257, '16', null, Infinity, NaN])
    assert.equal(
      serverExportSchema.safeParse({ ...request, options: { ...request.options, memoryLimitGiB } })
        .success,
      false,
    );
});

test('older clients use automatic workers; invalid worker counts are rejected', () => {
  const request = {
    project: { version: 1, song: createDemo(), settings: DEFAULT_SETTINGS },
    options: { width: 1280, height: 720, fps: 30, start: 0, end: 2, rate: 1, audio: false },
  };
  assert.equal(serverExportSchema.parse(request).options.workers, 0);
  for (const workers of [0, 1, 3, 8])
    assert.ok(
      serverExportSchema.safeParse({ ...request, options: { ...request.options, workers } })
        .success,
    );
  for (const workers of [-1, 1.5, 9, '4', null])
    assert.equal(
      serverExportSchema.safeParse({ ...request, options: { ...request.options, workers } })
        .success,
      false,
    );
});
