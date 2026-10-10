/** Compare both real export paths on the server, without opening the editor UI. */
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { createDemo, DEFAULT_SETTINGS } from '../lib/project';
import { chromeGraphicsArgs, findChrome } from '../server/render-resources';

const origin = process.env.EXPORT_BENCH_ORIGIN || 'http://127.0.0.1:4311';
const duration = Number(process.env.EXPORT_BENCH_SECONDS || 2);
const workers = Number(process.env.EXPORT_BENCH_WORKERS || 0);
if (!(duration > 0 && duration <= 20)) throw new Error('Benchmark duration must be 0–20 seconds.');
if (!Number.isInteger(workers) || workers < 0 || workers > 8)
  throw new Error('Benchmark workers must be 0 (automatic) through 8.');
const project = { version: 1 as const, song: createDemo(), settings: DEFAULT_SETTINGS };
const options = {
  width: 1280 as const,
  height: 720 as const,
  fps: 30 as const,
  start: 0,
  end: duration,
  rate: 1,
  audio: true,
  workers,
};
const base = `${origin}/api/export/server-jobs`;
const start = performance.now();
const created = await fetch(base, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ project, options }),
});
if (!created.ok) throw new Error(await created.text());
const job = (await created.json()) as { id: string; token: string };
const headers = { 'x-export-token': job.token };
let software = false,
  serverSeconds = 0;
try {
  for (;;) {
    const status = (await (await fetch(`${base}/${job.id}`, { headers })).json()) as {
      state: string;
      error?: string;
      received: number;
      frames: number;
      renderFps: number;
      workers: number;
      graphics: string;
      encoder: string;
    };
    if (status.state === 'error') throw new Error(status.error);
    if (status.state === 'complete') {
      const bytes = (await (await fetch(`${base}/${job.id}/download`, { headers })).arrayBuffer())
        .byteLength;
      serverSeconds = (performance.now() - start) / 1000;
      software = status.graphics === 'software';
      console.log(
        JSON.stringify({ path: 'server', seconds: +serverSeconds.toFixed(2), bytes, ...status }),
      );
      break;
    }
    if (performance.now() - start > 300000) throw new Error('Benchmark timed out.');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
} finally {
  await fetch(`${base}/${job.id}`, { method: 'DELETE', headers });
}

const compiled = await build({
  stdin: {
    contents: `import { exportVideo } from './lib/export';
  window.runLegacy = async (project, options) => {
    const start = performance.now();
    const file = await exportVideo(project, {...options, mode: 'device'}, new AbortController().signal, () => {});
    return { seconds: (performance.now() - start) / 1000, bytes: file.size };
  };`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  minify: true,
});
const browser = await puppeteer.launch({
  executablePath: await findChrome(),
  headless: true,
  args: [...chromeGraphicsArgs(software), '--autoplay-policy=no-user-gesture-required'],
  protocolTimeout: 300000,
});
try {
  const page = await browser.newPage();
  await page.setBypassCSP(true); // This benchmark injects the original export entry point.
  await page.goto(`${origin}/api/export/render-worker`);
  await page.addScriptTag({ content: compiled.outputFiles[0].text });
  const legacy = await page.evaluate(
    async ({ project, options }) => {
      const runner = (
        window as unknown as {
          runLegacy: (p: unknown, o: unknown) => Promise<{ seconds: number; bytes: number }>;
        }
      ).runLegacy;
      return runner(project, options);
    },
    { project, options },
  );
  console.log(
    JSON.stringify({
      path: 'original PNG pipeline',
      ...legacy,
      speedup: +(legacy.seconds / serverSeconds).toFixed(2),
    }),
  );
  console.log(
    'Loopback comparison, including server startup and audio. A remote device also avoids per-frame LAN uploads.',
  );
} finally {
  await browser.close();
}
