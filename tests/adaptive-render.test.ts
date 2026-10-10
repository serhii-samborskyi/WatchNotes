import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import {
  AdaptiveCapacity,
  adaptiveMemoryBudget,
  renderQueue,
  renderSegments,
} from '../server/adaptive-render';
import { GiB } from '../server/render-memory';
import { allocateRenderResources } from '../server/render-resources';
import { serverExportSchema } from '../lib/validation';
import { createDemo, DEFAULT_SETTINGS } from '../lib/project';

test('percentage budget uses available RAM, reserves the system, and grows after other apps exit', () => {
  const empty = adaptiveMemoryBudget(32 * GiB, 24 * GiB, 0, 80);
  assert.ok(empty.limitBytes > 16 * GiB && empty.limitBytes < 18 * GiB);
  assert.ok(empty.reserveBytes >= 6.4 * GiB - 1);
  const loaded = adaptiveMemoryBudget(32 * GiB, 10 * GiB, 2 * GiB, 80);
  assert.ok(loaded.limitBytes < empty.limitBytes);
  assert.equal(adaptiveMemoryBudget(32 * GiB, GiB, 0, 95).limitBytes, 0);
  assert.equal(adaptiveMemoryBudget(32 * GiB, 28 * GiB, 0, 95).reserveBytes, 2 * GiB);
  const resources = allocateRenderResources({
    frames: 1000,
    pixels: 1920 * 1080,
    audioSeconds: 100,
    requestedWorkers: 0,
    cpuThreads: 24,
    memoryBytes: 24 * GiB,
    totalMemoryBytes: 32 * GiB,
    resourcePercent: 80,
  });
  assert.equal(resources.workers, 8, 'Automatic is no longer capped at two.');
  assert.ok(resources.memoryLimitBytes > 8 * GiB);
  assert.doesNotThrow(
    () =>
      allocateRenderResources({
        frames: 100,
        pixels: 1920 * 1080,
        audioSeconds: 100,
        requestedWorkers: 0,
        cpuThreads: 24,
        memoryBytes: GiB,
        totalMemoryBytes: 32 * GiB,
        resourcePercent: 80,
      }),
    'Low RAM waits instead of failing an estimate.',
  );
});

test('capacity backs off, waits, and resumes without the old 80% abort', () => {
  const controller = new AdaptiveCapacity();
  const sample = {
    used: 2 * GiB,
    limit: 16 * GiB,
    available: 20 * GiB,
    reserve: 6 * GiB,
    apiRss: 0.3 * GiB,
    active: 1,
    maximum: 8,
    percent: 80,
    cpu: 10,
    gpu: 10,
  };
  for (let t = 2000; t <= 14000; t += 2000) controller.update(sample, t);
  assert.equal(controller.workers, 8);
  controller.update({ ...sample, cpu: 96 }, 16000);
  assert.equal(controller.workers, 7);
  controller.update({ ...sample, used: 13 * GiB }, 18000);
  assert.ok(controller.workers > 0, '81% usage must not terminate the export.');
  controller.update({ ...sample, available: 5 * GiB }, 20000);
  assert.equal(controller.workers, 0);
  assert.equal(controller.retire, false, 'Ordinary pressure drains in-flight segments.');
  controller.update({ ...sample, available: GiB }, 21000);
  assert.equal(controller.retire, true);
  controller.update(sample, 24000);
  assert.equal(controller.workers, 1);
  assert.equal(controller.retire, false);
});

test('queue preserves completed segments, retries retired work, and assembles every frame once', async () => {
  const ranges = renderSegments(125, 24);
  assert.deepEqual(
    ranges.map(({ from, to }) => [from, to]),
    [
      [0, 48],
      [48, 96],
      [96, 125],
    ],
  );
  const controller = new AbortController();
  const capacity = { workers: 1, retire: false };
  const attempts: number[] = [];
  const finished: number[] = [];
  let pressure = false;
  const task = renderQueue(
    ranges,
    async (segment, signal) => {
      attempts.push(segment.index);
      if (segment.index === 1 && !pressure) {
        pressure = true;
        capacity.workers = 0;
        capacity.retire = true;
        await delay(10000, undefined, { signal });
      }
      await delay(10, undefined, { signal });
      finished.push(segment.index);
    },
    () => capacity,
    controller.signal,
    () => {},
  );
  while (!pressure) await delay(10);
  await delay(200);
  assert.deepEqual(finished, [0]);
  capacity.retire = false;
  capacity.workers = 2;
  await task;
  assert.deepEqual(attempts, [0, 1, 1, 2]);
  assert.deepEqual([...finished].sort(), [0, 1, 2]);
});

test('cancelling a waiting queue exits promptly without starting work', async () => {
  const controller = new AbortController();
  let started = false;
  const task = renderQueue(
    renderSegments(100, 24),
    async () => {
      started = true;
    },
    () => ({ workers: 0, retire: false }),
    controller.signal,
    () => {},
  );
  controller.abort();
  await assert.rejects(task, { name: 'AbortError' });
  assert.equal(started, false);
});

test('resource percentage validation rejects invalid and unbounded requests', () => {
  const input = {
    project: { version: 1, song: createDemo(), settings: DEFAULT_SETTINGS },
    options: { width: 1280, height: 720, fps: 30, start: 0, end: 2, rate: 1, audio: false },
  };
  for (const resourcePercent of [20, 50, 80, 95])
    assert.ok(
      serverExportSchema.safeParse({ ...input, options: { ...input.options, resourcePercent } })
        .success,
    );
  for (const resourcePercent of [0, 19, 96, 100, 50.5, '80', null])
    assert.equal(
      serverExportSchema.safeParse({ ...input, options: { ...input.options, resourcePercent } })
        .success,
      false,
    );
});
