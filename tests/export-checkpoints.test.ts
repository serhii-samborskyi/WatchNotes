import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import express from 'express';
import ffmpeg from 'ffmpeg-static';
import { registerServerExport } from '../server/server-export';
import { createDemo, DEFAULT_SETTINGS } from '../lib/project';

for (const scenario of ['late-failure', 'slow-audio'] as const) {
  test(`export checkpoint regression: ${scenario}`, { timeout: 90000 }, async () => {
    const app = express(),
      http = createServer(app);
    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    const port = (http.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}/api/export/server-jobs`;
    const attempted: { attempt: number; from: number }[] = [];
    let checkpointHashes: string[] = [],
      audioRenders = 0;
    const tokens = new Set<string>();
    const service = registerServerExport(
      app,
      { port, encoder: ffmpeg!, otherBusy: () => false },
      {
        renderTimeoutMs: scenario === 'slow-audio' ? 5000 : undefined,
        prepareAudio: async (page) => {
          audioRenders++;
          if (scenario === 'slow-audio')
            await page.evaluateOnNewDocument(() => {
              const original = window.fetch;
              window.fetch = async (input, init) => {
                if (String(input).endsWith('/audio'))
                  await new Promise((resolve) => setTimeout(resolve, 10000));
                return original(input, init);
              };
            });
        },
        prepareWorker: async (page, attempt, _worker, segment) => {
          attempted.push({ attempt, from: segment.from });
          await page.exposeFunction('recordCheckpointToken', (token: string) => tokens.add(token));
          await page.evaluateOnNewDocument(() => {
            const original = window.fetch;
            window.fetch = (input, init) => {
              const token = new Headers(init?.headers).get('x-export-token');
              if (token)
                void (
                  window as unknown as { recordCheckpointToken: (t: string) => Promise<void> }
                ).recordCheckpointToken(token);
              return original(input, init);
            };
          });
          if (scenario === 'late-failure' && segment.from === 192) {
            // All four earlier segments must survive byte-for-byte, across both
            // the GPU retry and the third attempt's CPU encoder.
            const directory = path.join(
              path.dirname(path.dirname(page.browser().process()!.spawnfile)),
              'completed',
            );
            const hashes = await Promise.all(
              [0, 1, 2, 3].map(async (n) =>
                createHash('sha256')
                  .update(await readFile(path.join(directory, `segment-${n}.mp4`)))
                  .digest('hex'),
              ),
            );
            if (attempt === 1) checkpointHashes = hashes;
            else assert.deepEqual(hashes, checkpointHashes);
            if (attempt <= 2)
              await page.evaluateOnNewDocument(() => {
                const read = WebGL2RenderingContext.prototype.readPixels;
                let frames = 0;
                  WebGL2RenderingContext.prototype.readPixels = function (
                    this: WebGL2RenderingContext,
                    ...args: Parameters<typeof read>
                ) {
                  if (args[2] > 1 && ++frames === 3)
                    this.getExtension('WEBGL_lose_context')?.loseContext();
                  return Reflect.apply(read, this, args);
                } as typeof read;
                const blob = HTMLCanvasElement.prototype.toBlob;
                let captures = 0;
                HTMLCanvasElement.prototype.toBlob = function (...args: Parameters<typeof blob>) {
                  if (++captures === 3)
                    this.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();
                  return Reflect.apply(blob, this, args);
                };
              });
          }
        },
      },
    );
    const directory = await mkdtemp(path.join(tmpdir(), 'watch-notes-checkpoint-test-'));
    let job: { id: string; token: string } | undefined;
    try {
      const frames = scenario === 'late-failure' ? 199 : 7;
      const response = await fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project: { version: 1, song: createDemo(), settings: DEFAULT_SETTINGS },
          options: {
            width: 1280,
            height: 720,
            fps: 24,
            start: 1.25,
            end: 1.25 + (frames / 24) * 1.5,
            rate: 1.5,
            workers: 1,
            resourcePercent: 80,
            audio: true,
          },
        }),
      });
      assert.equal(response.status, 201, await response.clone().text());
      job = (await response.json()) as typeof job;
      const headers = { 'x-export-token': job!.token };
      let complete = false,
        sawAudio = false,
        saved = 0;
      for (let i = 0; i < 700; i++) {
        const status = (await (await fetch(`${base}/${job!.id}`, { headers })).json()) as {
          state: string;
          error?: string;
          attempt: number;
          frames: number;
          received: number;
          completedFrames: number;
          completedSegments: number;
          recoveryMessage?: string;
        };
        assert.notEqual(status.state, 'error', status.error);
        assert.ok(status.completedFrames >= saved, 'Saved progress must never reset.');
        saved = status.completedFrames;
        if (status.attempt > 1) {
          assert.ok(status.received >= 192);
          assert.match(status.recoveryMessage!, /Keeping 192/);
        }
        if (status.state === 'audio') {
          sawAudio = true;
          assert.equal(status.received, frames);
        }
        if (status.state === 'complete') {
          assert.equal(status.attempt, scenario === 'late-failure' ? 3 : 1);
          assert.equal(status.received, frames);
          assert.equal(status.completedFrames, frames);
          assert.equal(audioRenders, 1, 'A completed soundtrack must not be regenerated.');
          if (scenario === 'late-failure') {
            assert.deepEqual(
              attempted.filter((x) => x.attempt > 1),
              [
                { attempt: 2, from: 192 },
                { attempt: 3, from: 192 },
              ],
            );
            assert.equal(tokens.size, 3);
          } else
            assert.ok(sawAudio, 'Show the audio stage instead of falsely reporting a GPU stall.');
          const download = await fetch(`${base}/${job!.id}/download`, { headers });
          assert.equal(download.status, 200);
          const file = path.join(directory, 'recovered.mp4');
          await writeFile(file, Buffer.from(await download.arrayBuffer()));
          // Decode across all NVENC/x264 segment boundaries; a successful mux
          // alone does not prove the mixed-encoder stream is playable.
          const child = spawn(ffmpeg!, [
            '-hide_banner',
            '-xerror',
            '-err_detect',
            'explode',
            '-i',
            file,
            '-map',
            '0:v:0',
            '-map',
            '0:a:0',
            '-f',
            'null',
            '-',
          ]);
          let log = '';
          child.stderr.on('data', (chunk) => {
            log += String(chunk);
          });
          const [code] = await once(child, 'close');
          assert.equal(code, 0, log);
          assert.match(log, new RegExp(`frame=\\s*${frames}\\b`));
          assert.match(log, /Audio: aac/);
          complete = true;
          break;
        }
        await delay(100);
      }
      assert.ok(complete, 'Checkpoint test timed out.');
      for (const token of tokens) {
        const stale = await fetch(`${base}/${job!.id}/audio-progress`, {
          method: 'PUT',
          headers: { 'x-export-token': token, 'content-type': 'application/json' },
          body: '{"progress":1}',
        });
        assert.equal(stale.status, 403);
      }
    } finally {
      if (job)
        await fetch(`${base}/${job.id}`, {
          method: 'DELETE',
          headers: { 'x-export-token': job.token },
        });
      await service.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
}
