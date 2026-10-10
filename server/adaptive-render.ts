import { setTimeout as delay } from 'node:timers/promises';
import { GiB } from './render-memory';

/** The percentage is a total-host RAM target, not a percentage of free RAM. */
export function adaptiveMemoryBudget(
  total: number,
  available: number,
  used: number,
  percent: number,
) {
  const reserveBytes = Math.max(2 * GiB, total * (1 - percent / 100));
  const limitBytes = Math.max(
    0,
    Math.floor(
      Math.min(total - reserveBytes, used + available - reserveBytes - 512 * 1024 ** 2) / 4096,
    ) * 4096,
  );
  return { limitBytes, reserveBytes };
}

export type CapacitySample = {
  used: number;
  limit: number;
  available: number;
  reserve: number;
  apiRss: number;
  active: number;
  maximum: number;
  percent: number;
  cpu?: number;
  gpu?: number;
  gpuFree?: number;
};

export class AdaptiveCapacity {
  workers = 1;
  message = 'Starting with one worker and measuring available capacity.';
  retire = false;
  private lastChange = 0;
  update(s: CapacitySample, now = Date.now()) {
    const tight = s.available < s.reserve || s.used > s.limit * 0.9 || s.apiRss > GiB;
    // Cancel only unfinished short segments if draining normally is too slow.
    // Completed files stay on disk and are never part of this cancellation.
    this.retire = s.available < Math.max(GiB, s.reserve * 0.6) || s.used > s.limit * 0.96;
    if (tight) {
      this.workers = 0;
      this.lastChange = now;
      this.message = 'Waiting for RAM to become available. Finished segments are saved.';
    } else if (
      (s.cpu ?? 0) > s.percent + 4 ||
      (s.gpu ?? 0) > s.percent + 4 ||
      (s.gpuFree ?? GiB) < 384 * 1024 ** 2
    ) {
      if (now - this.lastChange >= 2000) {
        if (this.workers > 0) this.workers = Math.max(1, this.workers - 1);
        this.lastChange = now;
      }
      this.message = 'Reducing concurrency while the server is busy.';
    } else {
      // Account for the observed footprint, rather than rejecting a scene using
      // a fixed 2–3 GiB estimate for every page before it has even started.
      const nextWorker = Math.max(512 * 1024 ** 2, s.used / Math.max(1, s.active));
      const room = s.available > s.reserve + nextWorker && s.used + nextWorker < s.limit * 0.9;
      if (room && (s.active > 0 || this.workers === 0) && now - this.lastChange >= 2000) {
        this.workers = Math.min(s.maximum, this.workers + 1);
        this.lastChange = now;
      }
      this.message =
        this.workers === 0
          ? 'Waiting for enough RAM to resume. Finished segments are saved.'
          : `Adapting to the ${s.percent}% resource target.`;
    }
    this.workers = Math.min(this.workers, s.maximum);
    return { workers: this.workers, retire: this.retire, message: this.message };
  }
}

export type Segment = { from: number; to: number; index: number };
export function renderSegments(frames: number, fps: number) {
  const size = Math.max(1, fps * 2);
  return Array.from({ length: Math.ceil(frames / size) }, (_, index) => ({
    index,
    from: index * size,
    to: Math.min(frames, (index + 1) * size),
  }));
}

/** A bounded queue: relinquish resources between segments, retry only retired work. */
export async function renderQueue(
  segments: Segment[],
  run: (segment: Segment, signal: AbortSignal) => Promise<void>,
  capacity: () => { workers: number; retire: boolean },
  signal: AbortSignal,
  changed: (active: number, completed: number) => void,
) {
  const pending = [...segments];
  const active = new Map<Segment, { controller: AbortController; done: Promise<void> }>();
  let completed = 0,
    failure: unknown;
  const abort = () => {
    for (const task of active.values()) task.controller.abort();
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (pending.length || active.size) {
      signal.throwIfAborted();
      if (failure) throw failure;
      const target = capacity();
      if (target.retire) abort();
      while (!target.retire && pending.length && active.size < target.workers) {
        const segment = pending.shift()!;
        const controller = new AbortController();
        const task = { controller, done: Promise.resolve() };
        active.set(segment, task);
        changed(active.size, completed);
        task.done = run(segment, controller.signal)
          .then(() => {
            completed++;
          })
          .catch((error: unknown) => {
            if (controller.signal.aborted && !signal.aborted) pending.unshift(segment);
            else failure = error;
          })
          .finally(() => {
            active.delete(segment);
            changed(active.size, completed);
          });
      }
      await Promise.race([
        delay(100, undefined, { signal }),
        ...[...active.values()].map((task) => task.done),
      ]);
    }
    if (failure) throw failure;
  } finally {
    signal.removeEventListener('abort', abort);
    abort();
    await Promise.allSettled([...active.values()].map((task) => task.done));
  }
}
