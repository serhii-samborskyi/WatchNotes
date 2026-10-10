import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { PNG } from 'pngjs';
import ffmpegPath from 'ffmpeg-static';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { availableParallelism, networkInterfaces, tmpdir } from 'node:os';
import path from 'node:path';
import { createDemo, DEFAULT_SETTINGS } from '../lib/project';
import { frameRanges, renderResources } from '../server/render-resources';
import { ExportMemoryError, GiB, systemMemory } from '../server/render-memory';
import express from 'express';
import { createServer } from 'node:http';
import { registerServerExport } from '../server/server-export';
const base = 'http://127.0.0.1:14311/api/export';
let server: ChildProcess;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
before(async () => {
  server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    env: { ...process.env, EXPORT_PORT: '14311', EXPORT_CAPTURE: 'rgba', EXPORT_WORKERS: '1' },
    stdio: 'pipe',
  });
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error('Test export server did not start.');
});
after(async () => {
  server.kill('SIGTERM');
  await once(server, 'exit');
});
async function create(audio = false) {
  const response = await fetch(`${base}/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      width: 1280,
      height: 720,
      fps: 24,
      frames: 6,
      name: 'Test score',
      audio,
    }),
  });
  assert.equal(response.status, 201);
  return (await response.json()) as { id: string; token: string };
}
function headers(job: { token: string }, extra: Record<string, string> = {}) {
  return { 'x-export-token': job.token, ...extra };
}
function frame() {
  const png = new PNG({ width: 1280, height: 720 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 24;
    png.data[i + 1] = 31;
    png.data[i + 2] = 22;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}
function wav() {
  const samples = 11025,
    buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(44100, 24);
  buffer.writeUInt32LE(88200, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++)
    buffer.writeInt16LE(Math.round(Math.sin(((i * 440) / 44100) * Math.PI * 2) * 3000), 44 + i * 2);
  return buffer;
}
for (const audio of [false, true])
  test(
    `encodes ordered PNG frames into a playable MP4${audio ? ' with AAC audio' : ''}`,
    { timeout: 30000 },
    async () => {
      const job = await create(audio);
      try {
        const early = await fetch(`${base}/jobs/${job.id}/finish`, {
          method: 'POST',
          headers: headers(job),
        });
        assert.equal(early.status, 409);
        const png = frame();
        for (let i = 0; i < 6; i++) {
          const r = await fetch(`${base}/jobs/${job.id}/frames/${i}`, {
            method: 'PUT',
            headers: headers(job, { 'content-type': 'image/png' }),
            body: Uint8Array.from(png).buffer,
          });
          assert.equal(r.status, 200, await r.text());
        }
        if (audio) {
          const r = await fetch(`${base}/jobs/${job.id}/audio`, {
            method: 'PUT',
            headers: headers(job, { 'content-type': 'audio/wav' }),
            body: wav(),
          });
          assert.equal(r.status, 200);
        }
        const finish = await fetch(`${base}/jobs/${job.id}/finish`, {
          method: 'POST',
          headers: headers(job),
        });
        assert.equal(finish.status, 202);
        let state = '';
        for (let i = 0; i < 100; i++) {
          const status = (await (
            await fetch(`${base}/jobs/${job.id}`, { headers: headers(job) })
          ).json()) as { state: string };
          state = status.state;
          if (state === 'complete' || state === 'error') break;
          await delay(100);
        }
        assert.equal(state, 'complete');
        const response = await fetch(`${base}/jobs/${job.id}/download`, { headers: headers(job) });
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type') || '', /video\/mp4/);
        const bytes = Buffer.from(await response.arrayBuffer());
        assert.equal(bytes.toString('ascii', 4, 8), 'ftyp');
        const dir = await mkdtemp(path.join(tmpdir(), 'watch-notes-test-'));
        try {
          const file = path.join(dir, 'export.mp4');
          await writeFile(file, bytes);
          const inspect = spawn(ffmpegPath!, ['-i', file, '-f', 'null', '-']);
          let output = '';
          inspect.stderr.on('data', (c) => (output += String(c)));
          const [code] = await once(inspect, 'close');
          assert.equal(code, 0, output);
          assert.match(output, /1280x720/);
          assert.match(output, /24 fps/);
          if (audio) assert.match(output, /Audio: aac/);
          else assert.doesNotMatch(output, /Audio:/);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      } finally {
        await fetch(`${base}/jobs/${job.id}`, { method: 'DELETE', headers: headers(job) });
      }
    },
  );
test('accepts the app on a server LAN address and rejects unrelated origins', async () => {
  const address = Object.values(networkInterfaces())
    .flatMap((addresses) => addresses || [])
    .find((entry) => entry.family === 'IPv4' && !entry.internal)?.address;
  if (address) {
    const response = await fetch(`${base}/health`, {
      headers: { origin: `http://${address}:3002` },
    });
    assert.equal(response.status, 200);
    const wrongPort = await fetch(`${base}/health`, {
      headers: { origin: `http://${address}:9876` },
    });
    assert.equal(wrongPort.status, 403);
  }
  const foreign = await fetch(`${base}/health`, {
    headers: { origin: 'http://192.0.2.55:3002' },
  });
  assert.equal(foreign.status, 403);
});
test('rejects invalid settings, foreign origins, missing tokens, and out-of-order frames; cancellation frees the worker', async () => {
  let response = await fetch(`${base}/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ width: 1 }),
  });
  assert.equal(response.status, 400);
  response = await fetch(`${base}/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://example.com' },
    body: '{}',
  });
  assert.equal(response.status, 403);
  const job = await create();
  response = await fetch(`${base}/jobs/${job.id}`);
  assert.equal(response.status, 403);
  response = await fetch(`${base}/jobs/${job.id}/frames/1`, {
    method: 'PUT',
    headers: headers(job, { 'content-type': 'image/png' }),
    body: Uint8Array.from(frame()).buffer,
  });
  assert.equal(response.status, 409);
  response = await fetch(`${base}/jobs/${job.id}`, { method: 'DELETE', headers: headers(job) });
  assert.equal(response.status, 204);
  response = await fetch(`${base}/jobs/${job.id}`, { headers: headers(job) });
  assert.equal(response.status, 404);
  const another = await create();
  await fetch(`${base}/jobs/${another.id}`, { method: 'DELETE', headers: headers(another) });
});

test('parallel frame ranges have no duplicated or missing frames, including short and odd clips', () => {
  for (const frames of [1, 2, 7, 59, 36000])
    for (const workers of [1, 2, 3, 4, 8]) {
      const ranges = frameRanges(frames, workers);
      assert.equal(ranges[0].from, 0);
      assert.equal(ranges.at(-1)!.to, frames);
      ranges.forEach((range, i) => {
        assert.ok(range.to > range.from);
        if (i) assert.equal(range.from, ranges[i - 1].to);
      });
    }
});

const serverInput = () => ({
  project: { version: 1, song: createDemo(), settings: DEFAULT_SETTINGS },
  // Nonzero start, changed playback speed, and seven output frames exercise segment boundaries.
  options: {
    width: 1280,
    height: 720,
    fps: 24,
    start: 4,
    end: 4.4,
    rate: 1.5,
    audio: true,
    workers: 3,
  },
});

test(
  'adaptive export waits under pressure, resumes saved segments and enforces the percentage CPU quota',
  { timeout: 90000 },
  async () => {
    const app = express(),
      http = createServer(app);
    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    const port = (http.address() as { port: number }).port;
    const api = `http://127.0.0.1:${port}/api/export/server-jobs`;
    let pressure = false,
      induced = false,
      checkedQuota = false;
    const service = registerServerExport(
      app,
      { port, encoder: ffmpegPath!, otherBusy: () => false },
      {
        systemMemory: async () =>
          pressure ? { totalBytes: 32 * GiB, availableBytes: GiB } : systemMemory(),
        prepareWorker: async (page, _attempt, worker) => {
          if (!checkedQuota) {
            const membership = await readFile(
              `/proc/${page.browser().process()!.pid}/cgroup`,
              'utf8',
            );
            const group = /^0::(.+)$/m.exec(membership)![1];
            assert.match(group, /watch-notes-render-/);
            const [quota, period] = (
              await readFile(path.join('/sys/fs/cgroup', group, 'cpu.max'), 'utf8')
            )
              .trim()
              .split(' ')
              .map(Number);
            assert.ok(Math.abs(quota / period - availableParallelism() * 0.8) < 0.01);
            checkedQuota = true;
          }
          // One complete 48-frame segment already exists before the second page.
          // Simulate pressure without actually filling host RAM.
          if (worker === 1 && !induced) {
            induced = pressure = true;
            await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 30000)));
          }
        },
      },
    );
    let job: { id: string; token: string } | undefined;
    const dir = await mkdtemp(path.join(tmpdir(), 'watch-notes-adaptive-test-'));
    try {
      const input = serverInput();
      const created = await fetch(api, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...input,
          options: { ...input.options, start: 1.25, end: 9.1875, resourcePercent: 80, workers: 1 },
        }),
      });
      assert.equal(created.status, 201, await created.clone().text());
      job = (await created.json()) as typeof job;
      let waited = false,
        completed = false;
      for (let i = 0; i < 350; i++) {
        const status = (await (
          await fetch(`${api}/${job!.id}`, { headers: headers(job!) })
        ).json()) as {
          state: string;
          error?: string;
          received: number;
          frames: number;
          completedSegments: number;
          workers: number;
          waitingForResources?: boolean;
          attempt: number;
          resourcePercent: number;
        };
        assert.notEqual(status.state, 'error', status.error);
        if (pressure && status.waitingForResources && status.workers === 0) {
          assert.equal(status.received, 48);
          assert.equal(status.completedSegments, 1);
          waited = true;
          pressure = false;
        }
        if (status.state === 'complete') {
          assert.ok(waited && checkedQuota);
          assert.equal(status.attempt, 1, 'Pressure must not restart the whole video.');
          assert.equal(status.frames, 127);
          assert.equal(status.received, 127);
          assert.equal(status.completedSegments, 3);
          assert.equal(status.resourcePercent, 80);
          const response = await fetch(`${api}/${job!.id}/download`, { headers: headers(job!) });
          assert.equal(response.status, 200);
          const file = path.join(dir, 'adaptive.mp4');
          await writeFile(file, Buffer.from(await response.arrayBuffer()));
          const inspect = spawn(ffmpegPath!, [
            '-hide_banner',
            '-i',
            file,
            '-map',
            '0:v:0',
            '-f',
            'null',
            '-',
          ]);
          let output = '';
          inspect.stderr.on('data', (chunk) => {
            output += String(chunk);
          });
          const [code] = await once(inspect, 'close');
          assert.equal(code, 0, output);
          assert.match(output, /frame=\s*127\b/);
          assert.match(output, /Audio: aac/);
          completed = true;
          break;
        }
        await delay(200);
      }
      assert.ok(completed, 'Adaptive render did not finish.');
    } finally {
      if (job) await fetch(`${api}/${job.id}`, { method: 'DELETE', headers: headers(job) });
      await service.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  'adaptive export waits at startup and cancellation releases the export slot',
  { timeout: 10000 },
  async () => {
    const app = express(),
      http = createServer(app);
    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    const port = (http.address() as { port: number }).port;
    const api = `http://127.0.0.1:${port}/api/export/server-jobs`;
    let startedWorker = false;
    const service = registerServerExport(
      app,
      { port, encoder: ffmpegPath!, otherBusy: () => false },
      {
        resources: async () => ({
          workers: 8,
          threads: 2,
          memoryLimitBytes: 0,
          memoryReserveBytes: 6 * GiB,
          workerLimitReason: undefined,
        }),
        systemMemory: async () => ({ totalBytes: 32 * GiB, availableBytes: GiB }),
        prepareWorker: async () => {
          startedWorker = true;
        },
      },
    );
    let job: { id: string; token: string } | undefined;
    try {
      const input = serverInput();
      const created = await fetch(api, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...input, options: { ...input.options, resourcePercent: 80 } }),
      });
      assert.equal(created.status, 201);
      job = (await created.json()) as typeof job;
      let waiting = false;
      for (let i = 0; i < 50; i++) {
        const status = (await (
          await fetch(`${api}/${job!.id}`, { headers: headers(job!) })
        ).json()) as {
          state: string;
          waitingForResources?: boolean;
        };
        assert.notEqual(status.state, 'error');
        if (status.waitingForResources) {
          waiting = true;
          break;
        }
        await delay(100);
      }
      assert.ok(waiting);
      assert.equal(startedWorker, false);
      const cancelled = await fetch(`${api}/${job!.id}`, {
        method: 'DELETE',
        headers: headers(job!),
      });
      assert.equal(cancelled.status, 204);
      assert.equal(service.busy(), false);
      job = undefined;
    } finally {
      if (job) await fetch(`${api}/${job.id}`, { method: 'DELETE', headers: headers(job) });
      await service.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  },
);

for (const requestedWorkers of [1, 3])
  test(
    `server rendering with ${requestedWorkers} requested workers produces exactly seven H.264 frames with AAC audio`,
    { timeout: 90000 },
    async (t) => {
      try {
        await renderResources(7, 1280 * 720, 0.3, requestedWorkers);
      } catch (error) {
        if (!(error instanceof ExportMemoryError)) throw error;
        t.skip(
          'Host lacks the production RAM reserve; tiny, hard-limited fixtures below still exercise real rendering.',
        );
        return;
      }
      const created = await fetch(`${base}/server-jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...serverInput(),
          options: { ...serverInput().options, workers: requestedWorkers },
        }),
      });
      assert.equal(created.status, 201, await created.clone().text());
      const job = (await created.json()) as { id: string; token: string };
      const dir = await mkdtemp(path.join(tmpdir(), 'watch-notes-server-test-'));
      try {
        assert.equal((await fetch(`${base}/server-jobs/${job.id}`)).status, 403);
        assert.equal(
          (
            await fetch(`${base}/server-jobs/${job.id}/workers/0/frames/0`, {
              method: 'PUT',
              headers: headers(job),
              body: 'client cannot impersonate a worker',
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await fetch(`${base}/jobs`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                width: 1280,
                height: 720,
                fps: 24,
                frames: 1,
                name: 'Busy',
                audio: false,
              }),
            })
          ).status,
          409,
        );
        let completed = false;
        for (let i = 0; i < 320; i++) {
          const status = (await (
            await fetch(`${base}/server-jobs/${job.id}`, { headers: headers(job) })
          ).json()) as {
            state: string;
            error?: string;
            received: number;
            frames: number;
            workers: number;
            requestedWorkers: number;
            workerLimitReason?: string;
          };
          assert.notEqual(status.state, 'error', status.error);
          if (status.state === 'complete') {
            assert.equal(status.frames, 7);
            assert.equal(status.received, 7);
            assert.equal(status.requestedWorkers, requestedWorkers);
            assert.ok(status.workers >= 1 && status.workers <= requestedWorkers);
            if (status.workers < requestedWorkers) assert.ok(status.workerLimitReason);
            else assert.equal(status.workerLimitReason, undefined);
            completed = true;
            break;
          }
          await delay(250);
        }
        assert.ok(completed, 'Server export timed out.');
        const response = await fetch(`${base}/server-jobs/${job.id}/download`, {
          headers: headers(job),
        });
        assert.equal(response.status, 200);
        const file = path.join(dir, 'server.mp4');
        await writeFile(file, Buffer.from(await response.arrayBuffer()));
        const inspect = spawn(ffmpegPath!, [
          '-hide_banner',
          '-i',
          file,
          '-map',
          '0:v:0',
          '-f',
          'null',
          '-',
        ]);
        let output = '';
        inspect.stderr.on('data', (c) => {
          output += String(c);
        });
        const [code] = await once(inspect, 'close');
        assert.equal(code, 0, output);
        assert.match(output, /1280x720/);
        assert.match(output, /24 fps/);
        assert.match(output, /Audio: aac/);
        assert.match(output, /frame=\s*7\b/);
      } finally {
        await fetch(`${base}/server-jobs/${job.id}`, { method: 'DELETE', headers: headers(job) });
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

test(
  'server export validates ranges and cancellation releases the shared export slot',
  { timeout: 40000 },
  async () => {
    const input = serverInput();
    const invalid = await fetch(`${base}/server-jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...input, options: { ...input.options, end: 3 } }),
    });
    assert.equal(invalid.status, 400);
    const created = await fetch(`${base}/server-jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    assert.equal(created.status, 201);
    const job = (await created.json()) as { id: string; token: string };
    assert.equal(
      (await fetch(`${base}/server-jobs/${job.id}`, { method: 'DELETE', headers: headers(job) }))
        .status,
      204,
    );
    assert.equal(
      (await fetch(`${base}/server-jobs/${job.id}`, { headers: headers(job) })).status,
      404,
    );
    const legacy = await create();
    await fetch(`${base}/jobs/${legacy.id}`, { method: 'DELETE', headers: headers(legacy) });
  },
);

test(
  'a custom RAM budget reaches both the job status and the kernel limit',
  { timeout: 60000 },
  async () => {
    const memory = await systemMemory();
    // The chosen cap need not be fully available: the server must clamp it and
    // explain that reduction while still enforcing the effective cap in Linux.
    const app = express(),
      http = createServer(app);
    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    const port = (http.address() as { port: number }).port;
    const api = `http://127.0.0.1:${port}/api/export/server-jobs`;
    let enforcedBytes = 0;
    const service = registerServerExport(
      app,
      { port, encoder: ffmpegPath!, otherBusy: () => false },
      {
        prepareWorker: async (page) => {
          const membership = await readFile(
            `/proc/${page.browser().process()!.pid}/cgroup`,
            'utf8',
          );
          const group = /^0::(.+)$/m.exec(membership)![1];
          assert.match(
            group,
            /watch-notes-render-/,
            `Chrome must remain in its protected cgroup: ${group}`,
          );
          enforcedBytes = Number(
            await readFile(path.join('/sys/fs/cgroup', group, 'memory.max'), 'utf8'),
          );
          assert.equal(
            (await readFile(path.join('/sys/fs/cgroup', group, 'memory.swap.max'), 'utf8')).trim(),
            '0',
          );
          const session = await page.browser().target().createCDPSession();
          try {
            const { processInfo } = await session.send('SystemInfo.getProcessInfo');
            for (const process of processInfo) {
              const childMembership = await readFile(`/proc/${process.id}/cgroup`, 'utf8');
              assert.equal(
                /^0::(.+)$/m.exec(childMembership)?.[1],
                group,
                `${process.type} must share the RAM cap`,
              );
            }
          } finally {
            await session.detach();
          }
        },
      },
    );
    let job: { id: string; token: string } | undefined;
    try {
      const input = serverInput();
      const created = await fetch(api, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...input,
          options: { ...input.options, workers: 1, memoryLimitGiB: 16 },
        }),
      });
      assert.equal(created.status, 201);
      job = (await created.json()) as typeof job;
      let completed = false;
      for (let i = 0; i < 200; i++) {
        const status = (await (
          await fetch(`${api}/${job!.id}`, { headers: headers(job!) })
        ).json()) as {
          state: string;
          error?: string;
          requestedMemoryLimitGiB: number;
          memoryLimitBytes: number;
          memoryLimitReason?: string;
          received: number;
        };
        assert.notEqual(status.state, 'error', status.error);
        if (status.state === 'complete') {
          assert.equal(status.requestedMemoryLimitGiB, 16);
          assert.equal(status.memoryLimitBytes, enforcedBytes);
          assert.ok(enforcedBytes <= 16 * GiB);
          if (memory.availableBytes > 23 * GiB)
            assert.ok(enforcedBytes > 8 * GiB, 'The previous 8 GiB cap must not remain.');
          if (enforcedBytes < 16 * GiB - 4096) assert.match(status.memoryLimitReason!, /reduced/);
          else assert.equal(status.memoryLimitReason, undefined);
          assert.equal(status.received, 7);
          assert.equal(
            (await fetch(`${api}/${job!.id}/download`, { headers: headers(job!) })).status,
            200,
          );
          completed = true;
          break;
        }
        await delay(200);
      }
      assert.ok(completed);
    } finally {
      if (job) await fetch(`${api}/${job.id}`, { method: 'DELETE', headers: headers(job) });
      await service.close();
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);

for (const scenario of ['recover', 'cpu', 'exhausted', 'cancel', 'memory'] as const) {
  test(`graphics failure recovery: ${scenario}`, { timeout: 120000 }, async () => {
    const app = express();
    const http = createServer(app);
    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    const port = (http.address() as { port: number }).port;
    const api = `http://127.0.0.1:${port}/api/export/server-jobs`;
    const workerTokens = new Set<string>();
    const attempts = new Set<number>();
    let simulatePressure = false;
    const service = registerServerExport(
      app,
      {
        port,
        encoder: ffmpegPath!,
        otherBusy: () => false,
      },
      {
        // This known 14-frame fixture fits inside 1 GiB. Keep the real kernel
        // cap and OS headroom checks, without relying on another app unloading
        // its model before testing the render/stream/recovery pipeline.
        resources: async () => ({
          workers: 1,
          threads: 2,
          memoryLimitBytes: GiB,
          memoryReserveBytes: 6 * GiB,
          workerLimitReason: 'One worker for the small integration fixture.',
        }),
        systemMemory: async () =>
          simulatePressure ? { totalBytes: 32 * GiB, availableBytes: GiB } : systemMemory(),
        prepareWorker: async (page, attempt) => {
          attempts.add(attempt);
          if (scenario === 'memory') {
            simulatePressure = true;
            await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 10000)));
            return;
          }
          await page.exposeFunction('recordToken', (token: string) => workerTokens.add(token));
          await page.evaluateOnNewDocument(() => {
            const original = window.fetch;
            window.fetch = (input, init) => {
              const token = new Headers(init?.headers).get('x-export-token');
              if (token)
                void (
                  window as unknown as { recordToken: (token: string) => Promise<void> }
                ).recordToken(token);
              return original(input, init);
            };
          });
          if (scenario === 'exhausted' || attempt <= (scenario === 'cpu' ? 2 : 1)) {
            await page.evaluateOnNewDocument(() => {
              // Use the actual WebGL context-loss API halfway through capture,
              // exercising both raw GPU readback and software PNG capture.
              const read = WebGL2RenderingContext.prototype.readPixels;
              let rawFrames = 0;
              WebGL2RenderingContext.prototype.readPixels = function (
                this: WebGL2RenderingContext,
                ...args: Parameters<typeof read>
              ) {
                if (args[2] > 1 && ++rawFrames === 3)
                  this.getExtension('WEBGL_lose_context')?.loseContext();
                return Reflect.apply(read, this, args);
              } as typeof read;
              const blob = HTMLCanvasElement.prototype.toBlob;
              let pngFrames = 0;
              HTMLCanvasElement.prototype.toBlob = function (...args: Parameters<typeof blob>) {
                if (++pngFrames === 3)
                  this.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();
                return Reflect.apply(blob, this, args);
              };
            });
          }
        },
      },
    );
    const dir = await mkdtemp(path.join(tmpdir(), 'watch-notes-recovery-test-'));
    let job: { id: string; token: string } | undefined;
    try {
      const input = serverInput();
      const response = await fetch(api, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...input, options: { ...input.options, end: 4.875, workers: 2 } }),
      });
      assert.equal(response.status, 201);
      job = (await response.json()) as { id: string; token: string };
      let status:
        | {
            state: string;
            attempt: number;
            received: number;
            frames: number;
            workers: number;
            encoder: string;
            graphics: string;
            recoveryMessage?: string;
            error?: string;
          }
        | undefined;
      const deadline = Date.now() + 100000;
      while (Date.now() < deadline) {
        status = (await (
          await fetch(`${api}/${job.id}`, { headers: headers(job) })
        ).json()) as typeof status;
        if (scenario === 'cancel' && status!.attempt >= 2) break;
        if (status!.state === 'complete' || status!.state === 'error') break;
        await delay(50);
      }
      assert.ok(status);
      if (scenario === 'memory') {
        assert.equal(status.state, 'error');
        assert.equal(status.attempt, 1, 'RAM pressure must not trigger a CPU retry.');
        assert.match(status.error!, /available server RAM/);
        assert.equal(service.busy(), false);
        assert.equal(
          (await fetch(`${api}/${job.id}/download`, { headers: headers(job) })).status,
          409,
        );
        return;
      }
      if (scenario === 'cancel') {
        assert.equal(status.attempt, 2);
        assert.equal(
          (await fetch(`${api}/${job.id}`, { method: 'DELETE', headers: headers(job) })).status,
          204,
        );
        assert.equal(service.busy(), false);
        assert.equal((await fetch(`${api}/${job.id}`, { headers: headers(job) })).status, 404);
        return;
      }
      if (scenario === 'exhausted') {
        assert.equal(status.state, 'error');
        assert.ok(status.attempt >= 2 && status.attempt <= 3);
        assert.match(status.error!, /automatic recovery/);
        assert.doesNotMatch(status.error!, /http:|readFrame|render\.js/);
        assert.equal(
          (await fetch(`${api}/${job.id}/download`, { headers: headers(job) })).status,
          409,
        );
        return;
      }
      assert.equal(status.state, 'complete', JSON.stringify(status));
      assert.ok(status.attempt >= 2 && status.attempt <= 3);
      assert.equal(attempts.size, status.attempt);
      assert.equal(
        workerTokens.size,
        status.attempt,
        'Each retry must revoke the previous worker token.',
      );
      assert.equal(status.workers, 1);
      assert.equal(status.frames, 14);
      assert.equal(
        status.received,
        14,
        'Failed-attempt frames must not leak into the final count.',
      );
      assert.ok(status.recoveryMessage);
      if (scenario === 'cpu') {
        assert.equal(status.encoder, 'CPU H.264');
        assert.equal(status.graphics, 'software');
      }
      for (const token of workerTokens) {
        const stale: Response = await fetch(`${api}/${job.id}/workers/0/device`, {
          method: 'PUT',
          headers: headers({ token }, { 'content-type': 'application/json' }),
          body: JSON.stringify({ device: 'stale worker' }),
        });
        assert.equal(stale.status, 403);
      }
      const video = await fetch(`${api}/${job.id}/download`, { headers: headers(job) });
      assert.equal(video.status, 200);
      const file = path.join(dir, 'recovered.mp4');
      await writeFile(file, Buffer.from(await video.arrayBuffer()));
      const inspect = spawn(ffmpegPath!, [
        '-hide_banner',
        '-i',
        file,
        '-map',
        '0:v:0',
        '-f',
        'null',
        '-',
      ]);
      let output = '';
      inspect.stderr.on('data', (chunk) => {
        output += String(chunk);
      });
      const [code] = await once(inspect, 'close');
      assert.equal(code, 0, output);
      assert.match(output, /Audio: aac/);
      assert.match(output, /frame=\s*14\b/);
    } finally {
      if (job) await fetch(`${api}/${job.id}`, { method: 'DELETE', headers: headers(job) });
      await service.close();
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(dir, { recursive: true, force: true });
    }
  });
}
