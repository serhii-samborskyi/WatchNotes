import express from 'express';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { exportRequestSchema, type ExportRequest } from '../lib/validation.js';
import { registerServerExport } from './server-export.js';

type Job = {
  id: string;
  dir: string;
  config: ExportRequest;
  process: ChildProcessWithoutNullStreams;
  done: Promise<void>;
  state: 'rendering' | 'encoding' | 'complete' | 'error';
  received: number;
  audioReceived: boolean;
  busy: boolean;
  error: string;
  updated: number;
  token: string;
};
let creating = false;
const jobs = new Map<string, Job>();
const app = express();
app.disable('x-powered-by');
const port = Number(process.env.EXPORT_PORT || 4311);
// Accept the frontend on this machine's LAN interfaces, while keeping the
// encoder bound to loopback and rejecting unrelated browser origins.
const appPort = process.env.APP_PORT || '3002';
const appOrigins = new Set(
  Object.values(networkInterfaces()).flatMap((addresses) =>
    (addresses || [])
      .filter((address) => address.family === 'IPv4' && !address.internal)
      .map((address) => `http://${address.address}:${appPort}`),
  ),
);
if (process.env.APP_ORIGIN) appOrigins.add(process.env.APP_ORIGIN);
const encoder = process.env.FFMPEG_PATH || ffmpegPath;
if (!encoder)
  throw new Error('FFmpeg is unavailable. Set FFMPEG_PATH to an installed FFmpeg executable.');
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (
    origin &&
    !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) &&
    !appOrigins.has(origin)
  ) {
    res.status(403).json({ error: 'Unrecognized app origin.' });
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.get('/api/export/health', async (_req, res) => {
  try {
    await access(encoder);
    res.json({ ready: true, maxDuration: 600 });
  } catch {
    res.status(503).json({ ready: false, error: 'FFmpeg executable is missing.' });
  }
});
const serverExports = registerServerExport(app, {
  port,
  encoder,
  otherBusy: () =>
    creating || [...jobs.values()].some((j) => j.state === 'rendering' || j.state === 'encoding'),
});
function launch(args: string[]) {
  return spawn(encoder!, args, { stdio: ['pipe', 'pipe', 'pipe'] });
}
function completion(child: ChildProcessWithoutNullStreams, onMessage?: (message: string) => void) {
  return new Promise<void>((resolve, reject) => {
    let messages = '';
    child.stderr.on('data', (chunk) => {
      messages = (messages + chunk.toString()).slice(-4000);
      onMessage?.(messages);
    });
    child.stdout.resume();
    child.stdin.on('error', () => {});
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error(messages || `FFmpeg exited with code ${code}`)),
    );
  });
}
app.post('/api/export/jobs', express.json({ limit: '8kb' }), async (req, res) => {
  const parsed = exportRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  if (
    creating ||
    serverExports.busy() ||
    [...jobs.values()].some((j) => j.state === 'rendering' || j.state === 'encoding')
  ) {
    res.status(409).json({ error: 'An export is already running. Finish or cancel it first.' });
    return;
  }
  creating = true;
  let dir: string;
  try {
    dir = await mkdtemp(path.join(tmpdir(), 'watch-notes-'));
  } catch (error) {
    creating = false;
    throw error;
  }
  const config = parsed.data,
    id = randomUUID();
  const child = launch([
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'image2pipe',
    '-framerate',
    String(config.fps),
    '-i',
    'pipe:0',
    '-vf',
    `scale=${config.width}:${config.height}`,
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    'fast',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    path.join(dir, 'video.mp4'),
  ]);
  const job: Job = {
    id,
    dir,
    config,
    process: child,
    done: Promise.resolve(),
    state: 'rendering',
    received: 0,
    audioReceived: false,
    busy: false,
    error: '',
    updated: Date.now(),
    token: randomUUID(),
  };
  job.done = completion(child).catch((error) => {
    job.error = String(error);
    job.state = 'error';
  });
  jobs.set(id, job);
  creating = false;
  res.status(201).json({ id, token: job.token });
});
app.use('/api/export/jobs/:id', (req, res, next) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: 'Export not found.' });
    return;
  }
  if (req.headers['x-export-token'] !== job.token) {
    res.status(403).json({ error: 'Export access token required.' });
    return;
  }
  job.updated = Date.now();
  res.locals.job = job;
  next();
});
app.put(
  '/api/export/jobs/:id/frames/:index',
  express.raw({ type: 'image/png', limit: '16mb' }),
  async (req, res) => {
    const job: Job = res.locals.job;
    const index = Number(req.params.index);
    if (
      job.state !== 'rendering' ||
      job.busy ||
      index !== job.received ||
      index >= job.config.frames
    ) {
      res.status(409).json({ error: job.error || 'Frames must be submitted in order.' });
      return;
    }
    const data = req.body;
    if (
      !Buffer.isBuffer(data) ||
      data.length < 24 ||
      data.toString('hex', 0, 8) !== '89504e470d0a1a0a' ||
      data.readUInt32BE(16) !== job.config.width ||
      data.readUInt32BE(20) !== job.config.height
    ) {
      res.status(400).json({ error: 'Frame must be a PNG with the selected video dimensions.' });
      return;
    }
    job.busy = true;
    try {
      await new Promise<void>((resolve, reject) =>
        job.process.stdin.write(data, (error) => (error ? reject(error) : resolve())),
      );
      job.received++;
      res.json({ received: job.received });
    } catch (error) {
      job.state = 'error';
      job.error = String(error);
      res.status(500).json({ error: 'Video encoder stopped. Cancel this export and try again.' });
    } finally {
      job.busy = false;
    }
  },
);
app.put(
  '/api/export/jobs/:id/audio',
  express.raw({ type: 'audio/wav', limit: '110mb' }),
  async (req, res) => {
    const job: Job = res.locals.job;
    if (job.state !== 'rendering' || !job.config.audio) {
      res.status(409).json({ error: 'This export is not accepting audio.' });
      return;
    }
    if (
      !Buffer.isBuffer(req.body) ||
      req.body.length < 44 ||
      req.body.toString('ascii', 0, 4) !== 'RIFF' ||
      req.body.toString('ascii', 8, 12) !== 'WAVE'
    ) {
      res.status(400).json({ error: 'Expected WAV audio.' });
      return;
    }
    await writeFile(path.join(job.dir, 'audio.wav'), req.body);
    job.audioReceived = true;
    res.json({ ok: true });
  },
);
app.post('/api/export/jobs/:id/finish', async (req, res) => {
  const job: Job = res.locals.job;
  if (
    job.state !== 'rendering' ||
    job.busy ||
    job.received !== job.config.frames ||
    (job.config.audio && !job.audioReceived)
  ) {
    res.status(409).json({ error: 'All frames and requested audio must arrive before finishing.' });
    return;
  }
  job.state = 'encoding';
  job.process.stdin.end();
  res.status(202).json({ state: 'encoding' });
  try {
    await job.done;
    if (job.error) throw new Error(job.error);
    if (!jobs.has(job.id)) return;
    if (job.config.audio) {
      const process = launch([
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        path.join(job.dir, 'video.mp4'),
        '-i',
        path.join(job.dir, 'audio.wav'),
        '-c:v',
        'copy',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-t',
        String(job.config.frames / job.config.fps),
        '-movflags',
        '+faststart',
        path.join(job.dir, 'final.mp4'),
      ]);
      job.process = process;
      job.done = completion(process);
      await job.done;
    }
    job.state = 'complete';
    job.updated = Date.now();
  } catch (error) {
    job.state = 'error';
    job.error = String(error);
  }
});
app.get('/api/export/jobs/:id', (req, res) => {
  const job: Job = res.locals.job;
  res.json({
    state: job.state,
    received: job.received,
    frames: job.config.frames,
    error:
      job.state === 'error'
        ? 'Video encoding failed. Please cancel and try a lower resolution.'
        : undefined,
  });
});
app.get('/api/export/jobs/:id/download', (req, res) => {
  const job: Job = res.locals.job;
  if (job.state !== 'complete') {
    res.status(409).json({ error: 'Your video is still being rendered.' });
    return;
  }
  const filename =
    job.config.name.replace(/[^\p{L}\p{N}\- _]/gu, '').slice(0, 100) || 'watch-notes';
  res.download(path.join(job.dir, job.config.audio ? 'final.mp4' : 'video.mp4'), `${filename}.mp4`);
});
async function removeJob(job: Job) {
  jobs.delete(job.id);
  if (job.process.exitCode === null) {
    const closed = new Promise<void>((resolve) => job.process.once('close', () => resolve()));
    job.process.kill('SIGKILL');
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
  await rm(job.dir, { recursive: true, force: true });
}
app.delete('/api/export/jobs/:id', async (req, res) => {
  await removeJob(res.locals.job);
  res.status(204).end();
});
// Express identifies error middleware by its four-argument signature.
app.use(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  (error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(400).json({ error: error.message || 'Invalid request.' });
  },
);
const server = app.listen(port, '127.0.0.1', () =>
  console.log(`Watch Notes export service: http://127.0.0.1:${port}`),
);
const cleanup = setInterval(() => {
  for (const job of jobs.values())
    if (Date.now() - job.updated > 30 * 60 * 1000) void removeJob(job);
}, 60000);
cleanup.unref();
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, async () => {
    clearInterval(cleanup);
    server.close();
    await Promise.all([...jobs.values()].map(removeJob).concat(serverExports.close()));
    process.exit(0);
  });
