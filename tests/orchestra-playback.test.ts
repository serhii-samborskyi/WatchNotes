import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import express from 'express';
import puppeteer from 'puppeteer-core';
import { createRenderMemoryGroup, GiB } from '../server/render-memory';
import { findChrome } from '../server/render-resources';

test(
  'orchestra playback streams a bounded queue, seeks at speed, cancels and restarts',
  { timeout: 60000 },
  async () => {
    const worker = await build({
      entryPoints: ['lib/orchestra-audio-worker.ts'],
      bundle: true,
      format: 'iife',
      write: false,
      platform: 'browser',
    });
    const entry = await build({
      stdin: {
        resolveDir: process.cwd(),
        contents: `
    import { OrchestraPlayer } from './lib/orchestra-player';
    import { createOrchestraDemo } from './lib/orchestra-demo';
    window.check = async () => {
      const player = new OrchestraPlayer(), song = createOrchestraDemo();
      const delay=ms=>new Promise(r=>setTimeout(r,ms));
      try {
        await player.prepare();await player.play(song,0,1,.5);
        await delay(2300);
        const first={time:player.currentTime,error:player.error,queued:player.sources.size};
        await player.play(song,4,2,.5);await delay(450);
        const seek={time:player.currentTime,error:player.error};
        player.stop();const paused=player.currentTime;await delay(150);
        const stopped=player.currentTime;
        const cancelled=player.play(song,8,1,.5);player.stop();await cancelled;
        await player.play(song,1,1,.5);await delay(250);
        return {first,seek,paused,stopped,restarted:player.currentTime,error:player.error};
      }finally{player.dispose();}
    };
  `,
      },
      bundle: true,
      format: 'iife',
      write: false,
      platform: 'browser',
      plugins: [
        {
          name: 'worker-test-route',
          setup(b) {
            b.onLoad({ filter: /orchestra-player\.ts$/ }, async ({ path: p }) => ({
              contents: (await readFile(p, 'utf8')).replace(
                "new URL('./orchestra-audio-worker.ts', import.meta.url)",
                "'/audio-worker.js'",
              ),
              loader: 'ts',
            }));
          },
        },
      ],
    });
    const app = express();
    app.get('/', (_req, res) => res.type('html').send('<script src="/test.js"></script>'));
    app.get('/test.js', (_req, res) => res.type('js').send(entry.outputFiles[0].text));
    app.get('/audio-worker.js', (_req, res) => res.type('js').send(worker.outputFiles[0].text));
    app.get('/sounds/GeneralUser-GS.sf2', (_req, res) =>
      res.sendFile(path.resolve('public/sounds/GeneralUser-GS.sf2')),
    );
    const server = createServer(app);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const dir = await mkdtemp(path.join(tmpdir(), 'watch-notes-orchestra-audio-'));
    const group = await createRenderMemoryGroup(dir, 2 * GiB, 400);
    let browser;
    try {
      browser = await puppeteer.launch({
        executablePath: await group.chromeLauncher(await findChrome()),
        headless: true,
        pipe: true,
        networkEnabled: false,
        env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/dev/null' },
        args: ['--disable-gpu', '--autoplay-policy=no-user-gesture-required'],
      });
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
      const result = await page.evaluate(() =>
        (
          window as unknown as {
            check: () => Promise<{
              first: { time: number; error: string; queued: number };
              seek: { time: number; error: string };
              paused: number;
              stopped: number;
              restarted: number;
              error: string;
            }>;
          }
        ).check(),
      );
      assert.equal(result.first.error, '');
      assert.ok(result.first.time > 1.9 && result.first.time < 2.6);
      assert.ok(result.first.queued <= 6, 'Playback queue must remain bounded');
      assert.equal(result.seek.error, '');
      assert.ok(result.seek.time > 4.3 && result.seek.time < 5.2);
      assert.equal(result.stopped, result.paused);
      assert.ok(result.restarted >= 1 && result.restarted < 1.6);
      assert.equal(result.error, '');
    } finally {
      await browser?.close();
      await group.stop();
      await new Promise<void>((r) => server.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    }
  },
);
