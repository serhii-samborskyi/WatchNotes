import express from 'express';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile, mkdir, rename } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { build } from 'esbuild';
import { serverExportSchema, type ServerExportRequest } from '../lib/validation';
import {
  availableGpuMemory,
  cpuSnapshot,
  gpuLoad,
  chromeGraphicsArgs,
  findChrome,
  frameRanges,
  gpuWorkerBudget,
  renderResources,
  selectEncoder,
} from './render-resources';
import {
  AdaptiveCapacity,
  adaptiveMemoryBudget,
  renderQueue,
  renderSegments,
  type Segment,
} from './adaptive-render';
import { isGraphicsFailure, publicExportError } from './export-recovery';
import { streamFrameUpload } from './frame-upload';
import {
  createRenderMemoryGroup,
  ExportMemoryError,
  memoryPressureReason,
  GiB,
  systemMemory,
  type RenderMemoryGroup,
} from './render-memory';

type Worker = {
  from: number;
  to: number;
  received: number;
  busy: boolean;
  active?: boolean;
  child: ChildProcessWithoutNullStreams;
  done: Promise<void>;
};
type Job = {
  id: string;
  token: string;
  workerToken: string;
  dir: string;
  workDir: string;
  input: ServerExportRequest;
  state: 'preparing' | 'rendering' | 'audio' | 'encoding' | 'complete' | 'error';
  frames: number;
  received: number;
  workers: Worker[];
  workerCount: number;
  workerLimitReason?: string;
  attempt: number;
  recoveryMessage?: string;
  software: boolean;
  browser?: Browser;
  memoryGroup?: RenderMemoryGroup;
  memoryFailure?: Error;
  memoryBytes: number;
  memoryPeakBytes: number;
  memoryLimitBytes: number;
  memoryLimitReason?: string;
  resourceMessage?: string;
  waitingForResources?: boolean;
  completedSegments: number;
  completedFrames: number;
  savedSegments: Set<number>;
  ranges?: Segment[];
  checkpointDir: string;
  children: Set<ChildProcessWithoutNullStreams>;
  done: Promise<void>;
  abort: AbortController;
  running: boolean;
  updated: number;
  started: number;
  renderStarted: number;
  renderSeconds: number;
  renderBaseFrames: number;
  encoder: string;
  device: string;
  audioReceived: boolean;
  audioProgress: number;
  audioUpdated: number;
  capture: 'rgba' | 'png';
  error?: string;
};
function currentUpload(req: express.Request, job: Job) {
  // Body parsing is asynchronous: recheck authorization after it finishes and
  // after writes, so a late request cannot mutate a replacement attempt.
  return (
    req.headers['x-export-token'] === job.workerToken &&
    (job.state === 'rendering' || job.state === 'audio') &&
    !job.abort.signal.aborted
  );
}
const root = fileURLToPath(new URL('../', import.meta.url));
const assetDir = path.join(root, '.cache/render');
let bundle: Promise<void> | undefined;
function prepareBundle() {
  return (bundle ??= (async () => {
    await mkdir(assetDir, { recursive: true });
    await build({
      entryPoints: [path.join(root, 'server/render-page.ts')],
      outfile: path.join(assetDir, 'render.js'),
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: 'chrome120',
      minify: true,
    });
  })().finally(() => {
    // Rebuild on the next export so later scene edits also reach rendered videos.
    bundle = undefined;
  }));
}

export function registerServerExport(
  app: express.Express,
  options: {
    port: number;
    encoder: string;
    otherBusy: () => boolean;
  },
  // Programmatic instrumentation for renderer integration tests; never exposed over HTTP.
  hooks: {
    prepareWorker?: (
      page: Page,
      attempt: number,
      worker: number,
      segment: Segment,
    ) => Promise<void>;
    prepareAudio?: (page: Page) => Promise<void>;
    resources?: typeof renderResources;
    systemMemory?: typeof systemMemory;
    // Keep timeout tests short without weakening the production watchdog.
    renderTimeoutMs?: number;
  } = {},
) {
  const jobs = new Map<string, Job>();
  let creating = false;
  const busy = () => creating || [...jobs.values()].some((job) => job.running);
  const base = '/api/export/server-jobs';
  const renderPath = '/api/export/render-worker';
  const origin = `http://127.0.0.1:${options.port}`;

  app.get(renderPath, (_req, res) =>
    res
      .setHeader(
        'Content-Security-Policy',
        "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; font-src 'self'; connect-src 'self'; worker-src 'self' blob:",
      )
      .type('html').send(`<!doctype html><html><head>
    <meta charset="utf-8"><style>@font-face{font-family:"Noto Music";src:url("${renderPath}/font.ttf")}</style>
    </head><body><script src="${renderPath}/render.js"></script></body></html>`),
  );
  app.get(`${renderPath}/render.js`, (_req, res) =>
    res.sendFile(path.join(assetDir, 'render.js'), { dotfiles: 'allow' }),
  );
  app.get(`${renderPath}/font.ttf`, (_req, res) =>
    res.sendFile(path.join(root, 'public/fonts/NotoMusic-Regular.ttf')),
  );

  app.get('/sounds/GeneralUser-GS.sf2', (_req, res) =>
    res.sendFile(path.join(root, 'public/sounds/GeneralUser-GS.sf2')),
  );

  function launch(job: Job, executable: string, args: string[]) {
    job.abort.signal.throwIfAborted();
    if (job.memoryFailure) throw job.memoryFailure;
    if (!job.memoryGroup) throw new Error('Export memory protection stopped unexpectedly.');
    const child = spawn(
      job.memoryGroup.launcher,
      [executable, '-hide_banner', '-loglevel', 'error', '-y', ...args],
      {
        stdio: 'pipe',
      },
    );
    job.children.add(child);
    let stderr = '';
    child.stdout.resume();
    child.stderr.on('data', (data) => {
      stderr = (stderr + data).slice(-4000);
    });
    child.stdin.on('error', () => {});
    const done = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => {
        job.children.delete(child);
        if (code === 0) resolve();
        else reject(new Error(stderr || `Encoder exited with code ${code}.`));
      });
    });
    void done.catch(() => {});
    return { child, done };
  }

  async function stopResources(job: Job) {
    const stopping = [...job.children].map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) return resolve();
          child.once('close', () => resolve());
          child.kill('SIGKILL');
        }),
    );
    if (job.memoryGroup) stopping.push(job.memoryGroup.stop());
    const browser = job.browser;
    if (browser)
      stopping.push(
        (async () => {
          const timer = setTimeout(() => browser.process()?.kill('SIGKILL'), 5000);
          try {
            await browser.close();
          } catch {
            browser.process()?.kill('SIGKILL');
          } finally {
            clearTimeout(timer);
          }
        })(),
      );
    await Promise.all(stopping);
    if (job.browser === browser) job.browser = undefined;
  }

  async function runAttempt(job: Job, workerCap: number, forceCpu: boolean) {
    let tasks: Promise<void>[] = [];
    let watchdog: ReturnType<typeof setInterval> | undefined;
    let memoryMonitor: ReturnType<typeof setInterval> | undefined;
    let checkingMemory: Promise<void> | undefined;
    let rejectMemory: (error: Error) => void = () => {};
    const memoryStopped = new Promise<never>((_, reject) => {
      rejectMemory = reject;
    });
    void memoryStopped.catch(() => {});
    try {
      const o = job.input.options;
      const adaptive = o.resourcePercent !== undefined;
      const capacity = new AdaptiveCapacity();
      job.workDir = path.join(job.dir, `attempt-${job.attempt}`);
      await mkdir(job.workDir);
      await mkdir(job.checkpointDir, { recursive: true });
      const [chrome, preferredEncoder, resources, gpuMemory] = await Promise.all([
        findChrome(),
        forceCpu
          ? Promise.resolve({
              executable: options.encoder,
              codec: 'libx264',
              label: 'CPU H.264',
            } as const)
          : selectEncoder(options.encoder),
        (hooks.resources || renderResources)(
          job.frames,
          o.width * o.height,
          o.audio ? (o.end - o.start) / o.rate : 0,
          workerCap || o.workers,
          o.memoryLimitGiB,
          o.resourcePercent,
        ),
        forceCpu ? Promise.resolve(undefined) : availableGpuMemory(),
        prepareBundle(),
      ]);
      job.abort.signal.throwIfAborted();
      if (adaptive) {
        // Low headroom is a wait, not a failed export. No render processes exist yet.
        while (resources.memoryLimitBytes < GiB) {
          job.abort.signal.throwIfAborted();
          job.waitingForResources = true;
          job.resourceMessage = 'Waiting for server RAM before starting the renderer.';
          await delay(1000, undefined, { signal: job.abort.signal });
          const host = await (hooks.systemMemory || systemMemory)();
          resources.memoryLimitBytes = adaptiveMemoryBudget(
            host.totalBytes,
            host.availableBytes,
            0,
            o.resourcePercent!,
          ).limitBytes;
        }
      }
      job.waitingForResources = false;
      job.memoryLimitBytes = resources.memoryLimitBytes;
      job.memoryLimitReason =
        !adaptive && resources.memoryLimitBytes + 4096 < o.memoryLimitGiB * GiB
          ? `RAM cap reduced from ${o.memoryLimitGiB} to ${(resources.memoryLimitBytes / GiB).toFixed(1)} GiB to leave memory available for the system and other apps.`
          : undefined;
      job.memoryGroup = await createRenderMemoryGroup(
        job.workDir,
        resources.memoryLimitBytes,
        adaptive ? availableParallelism() * o.resourcePercent! : undefined,
      );
      job.abort.signal.throwIfAborted();
      const memoryGroup = job.memoryGroup;
      let previousCpu = cpuSnapshot(),
        lastGpuCheck = 0;
      let gpu: Awaited<ReturnType<typeof gpuLoad>>;
      const checkMemory = async () => {
        try {
          const [sample, host] = await Promise.all([
            memoryGroup.sample(),
            (hooks.systemMemory || systemMemory)(),
          ]);
          job.memoryBytes = sample.workingBytes;
          job.memoryPeakBytes = Math.max(job.memoryPeakBytes, sample.workingBytes);
          if (sample.oom) throw new ExportMemoryError();
          if (adaptive) {
            const budget = adaptiveMemoryBudget(
              host.totalBytes,
              host.availableBytes,
              sample.workingBytes,
              o.resourcePercent!,
            );
            if (budget.limitBytes > job.memoryLimitBytes + 256 * 1024 ** 2) {
              await memoryGroup.resize(budget.limitBytes);
              job.memoryLimitBytes = budget.limitBytes;
            }
            const cpu = cpuSnapshot();
            const usage =
              cpu.total > previousCpu.total
                ? 100 * (1 - (cpu.idle - previousCpu.idle) / (cpu.total - previousCpu.total))
                : 0;
            previousCpu = cpu;
            if (Date.now() - lastGpuCheck > 2000) {
              gpu = await gpuLoad();
              lastGpuCheck = Date.now();
            }
            capacity.update({
              used: sample.workingBytes,
              limit: Math.min(job.memoryLimitBytes, budget.limitBytes),
              available: host.availableBytes,
              reserve: budget.reserveBytes,
              apiRss: process.memoryUsage().rss,
              active: job.workerCount,
              maximum: resources.workers,
              percent: o.resourcePercent!,
              cpu: usage,
              gpu: gpu?.utilization,
              gpuFree: job.software ? undefined : gpu?.freeBytes,
            });
            if (job.state === 'preparing' || job.state === 'rendering') {
              job.resourceMessage = capacity.message;
              job.waitingForResources = capacity.workers === 0;
            }
            // The queue drains/retire pages first. This is a last-resort host
            // emergency, not the old 80% budget cutoff.
            if (host.availableBytes < 256 * 1024 ** 2 || process.memoryUsage().rss > 2 * GiB)
              throw new ExportMemoryError(
                'Export stopped because server memory became critically low, even after reducing workers.',
              );
          } else {
            const reason = memoryPressureReason(
              sample.usedBytes,
              resources.memoryLimitBytes,
              host.availableBytes,
              resources.memoryReserveBytes,
              process.memoryUsage().rss,
            );
            if (reason) throw new ExportMemoryError(reason);
          }
        } catch (error) {
          if (job.abort.signal.aborted || job.memoryFailure) return;
          job.memoryFailure = error instanceof Error ? error : new ExportMemoryError();
          job.workerToken = randomUUID();
          rejectMemory(job.memoryFailure);
          await memoryGroup.stop();
        }
      };
      await checkMemory();
      if (job.memoryFailure) throw job.memoryFailure;
      memoryMonitor = setInterval(() => {
        if (!checkingMemory)
          checkingMemory = checkMemory().finally(() => {
            checkingMemory = undefined;
          });
      }, 500);
      const containedChrome = await memoryGroup.chromeLauncher(chrome);
      const budget = gpuWorkerBudget(resources.workers, o.width * o.height, gpuMemory);
      let softwareGraphics = forceCpu || budget.software;
      if (budget.software)
        resources.workerLimitReason = 'Available GPU memory is low; using one CPU render worker.';
      else if (!adaptive && budget.workers < resources.workers)
        resources.workerLimitReason = `Using ${budget.workers} render workers to fit available GPU memory.`;
      resources.workers = softwareGraphics ? 1 : adaptive ? resources.workers : budget.workers;
      if (workerCap)
        resources.workerLimitReason = `Using ${resources.workers} ${forceCpu ? 'CPU ' : ''}render ${resources.workers === 1 ? 'worker' : 'workers'} after a graphics failure.`;
      job.workerCount = adaptive ? 0 : resources.workers;
      // Each job launches a fresh GPU process. Warm up that process even when
      // the previous job already identified the graphics device.
      const launchBrowser = () =>
        puppeteer.launch({
          executablePath: containedChrome,
          headless: true,
          pipe: true,
          // Do not mirror multi-megabyte frame POST bodies into DevTools events.
          // Workers only need page lifecycle and evaluation, not network inspection.
          networkEnabled: false,
          // Desktop Chrome otherwise asks the session bus to move itself into
          // a separate, unlimited app scope. Headless export needs no desktop
          // integration; keep it and its children inside the render cgroup.
          env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/dev/null' },
          dumpio: process.env.EXPORT_DEBUG === '1',
          protocolTimeout: 0,
          timeout: 30000,
          args: [
            ...chromeGraphicsArgs(softwareGraphics),
            '--disable-dev-shm-usage',
            '--autoplay-policy=no-user-gesture-required',
            '--disable-background-timer-throttling',
            '--disable-renderer-backgrounding',
          ],
        });
      job.browser = await launchBrowser();
      if (!softwareGraphics) {
        const probe = await job.browser.newPage();
        softwareGraphics = await probe.evaluate(() => {
          const gl = document.createElement('canvas').getContext('webgl2');
          if (!gl) return true;
          const info = gl.getExtension('WEBGL_debug_renderer_info');
          const name = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
          gl.clearColor(0, 0, 0, 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
          const pixel = new Uint8Array(4);
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
          const software = gl.isContextLost() || /swiftshader|llvmpipe|software/i.test(name);
          gl.getExtension('WEBGL_lose_context')?.loseContext();
          return software;
        });
        await probe.close();
        // Pin the fallback explicitly: broken drivers can otherwise restart the GPU
        // process and invalidate an already-created software context mid-export.
        if (softwareGraphics) {
          await job.browser.close();
          job.abort.signal.throwIfAborted();
          job.browser = await launchBrowser();
        }
      }
      job.abort.signal.throwIfAborted();
      await memoryGroup.assertContains(job.browser.process()?.pid);
      job.software = softwareGraphics;
      const encoder =
        forceCpu || budget.software
          ? { executable: options.encoder, codec: 'libx264', label: 'CPU H.264' }
          : preferredEncoder;
      job.encoder = encoder.label;
      // Software contexts share Chrome's CPU rasterizer; extra contexts add overhead.
      // Operators can still benchmark a chosen count using EXPORT_WORKERS.
      if (
        (softwareGraphics || job.frames < o.fps * 3) &&
        o.workers === 0 &&
        !process.env.EXPORT_WORKERS
      )
        resources.workers = 1;
      job.workerCount = adaptive ? 0 : resources.workers;
      job.workerLimitReason = resources.workerLimitReason;
      capacity.workers = Math.min(capacity.workers, resources.workers);
      job.capture =
        process.env.EXPORT_CAPTURE === 'rgba' ||
        (!softwareGraphics && process.env.EXPORT_CAPTURE !== 'png')
          ? 'rgba'
          : 'png';
      // A retry must use the same boundaries, even after reducing concurrency
      // or switching encoders. Only fully closed MP4s enter the saved set.
      const ranges = (job.ranges ??= adaptive
        ? renderSegments(job.frames, o.fps)
        : frameRanges(job.frames, resources.workers).map((range, index) => ({ ...range, index })));
      const pendingRanges = ranges.filter((range) => !job.savedSegments.has(range.index));
      const startWorker = (range: Segment) => {
        const encoding =
          encoder.codec === 'h264_nvenc'
            ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '18', '-b:v', '0']
            : [
                '-c:v',
                'libx264',
                '-preset',
                'fast',
                '-crf',
                '18',
                '-threads',
                String(resources.threads),
              ];
        return {
          ...range,
          active: true,
          received: 0,
          busy: false,
          ...launch(job, encoder.executable, [
            ...(job.capture === 'rgba'
              ? ['-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', `${o.width}x${o.height}`]
              : ['-f', 'image2pipe']),
            '-framerate',
            String(o.fps),
            '-i',
            'pipe:0',
            '-vf',
            job.capture === 'rgba' ? 'vflip,format=yuv420p' : 'format=yuv420p',
            '-filter_threads',
            '1',
            '-an',
            ...encoding,
            '-profile:v',
            'high',
            '-level:v',
            '4.2',
            '-video_track_timescale',
            '15360',
            path.join(job.workDir, `segment-${range.index}.mp4`),
          ]),
        };
      };
      job.workers = [];
      job.state = 'rendering';
      job.renderStarted = Date.now();
      job.renderBaseFrames = job.completedFrames;
      const browser = job.browser;
      const workerToken = job.workerToken;
      const runSegment = async (range: Segment, signal: AbortSignal) => {
        signal.throwIfAborted();
        const worker = startWorker(range);
        const index = job.workers.push(worker) - 1;
        let page: Page | undefined;
        let completed = false;
        const cancel = () => {
          worker.active = false;
          worker.child.kill('SIGKILL');
          void page?.close().catch(() => {});
        };
        signal.addEventListener('abort', cancel, { once: true });
        try {
          page = await browser.newPage();
          signal.throwIfAborted();
          await hooks.prepareWorker?.(page, job.attempt, index, range);
          page.on('pageerror', (error) => console.error('Render worker:', String(error)));
          if (process.env.EXPORT_DEBUG === '1')
            page.on('console', (message) => console.log('Render worker:', message.text()));
          await page.goto(origin + renderPath, { waitUntil: 'load', timeout: 30000 });
          job.abort.signal.throwIfAborted();
          signal.throwIfAborted();
          const timings = await Promise.race([
            page.evaluate((task) => window.renderScore(task), {
              ...job.input,
              options: { ...o, audio: false },
              id: job.id,
              token: workerToken,
              worker: index,
              from: worker.from,
              to: worker.to,
              capture: job.capture,
            }),
            worker.done.then(() => {
              if (worker.received !== worker.to - worker.from)
                throw new Error('Encoder stopped early.');
            }),
          ]);
          if (process.env.EXPORT_PROFILE === '1') console.log('Render timings:', index, timings);
          if (worker.received !== worker.to - worker.from)
            throw new Error('Renderer did not deliver every frame.');
          worker.child.stdin.end();
          await worker.done;
          signal.throwIfAborted();
          await rename(
            path.join(job.workDir, `segment-${range.index}.mp4`),
            path.join(job.checkpointDir, `segment-${range.index}.mp4`),
          );
          job.savedSegments.add(range.index);
          job.completedSegments = job.savedSegments.size;
          job.completedFrames += range.to - range.from;
          completed = true;
        } finally {
          signal.removeEventListener('abort', cancel);
          worker.active = false;
          if (!completed) {
            worker.child.kill('SIGKILL');
            job.received -= worker.received;
          }
          await page?.close().catch(() => {});
          await worker.done.catch(() => {});
          // Never retain closed pages' encoders/streams across a long export.
          // Keep monotonically increasing IDs so late uploads cannot target a new worker.
          delete job.workers[index];
        }
      };
      const queueAbort = new AbortController();
      const abortQueue = () => queueAbort.abort();
      job.abort.signal.addEventListener('abort', abortQueue, { once: true });
      const rendering = renderQueue(
        pendingRanges,
        runSegment,
        () => (adaptive ? capacity : { workers: resources.workers, retire: false }),
        queueAbort.signal,
        (active) => {
          if (adaptive) job.workerCount = active;
        },
      );
      // Audio has its own page and progress watchdog. Video checkpoints do not
      // wait for a long soundtrack, and completed audio survives GPU recovery.
      const audioTask =
        !o.audio || job.audioReceived
          ? Promise.resolve()
          : (async () => {
              job.audioProgress = 0;
              job.audioUpdated = Date.now();
              const page = await browser.newPage();
              let timer: ReturnType<typeof setInterval> | undefined;
              try {
                await hooks.prepareAudio?.(page);
                await page.goto(origin + renderPath, { waitUntil: 'load', timeout: 30000 });
                const stalledAudio = new Promise<never>((_, reject) => {
                  timer = setInterval(() => {
                    if (Date.now() - job.audioUpdated > 120000)
                      reject(new Error('Audio rendering stopped responding.'));
                  }, 1000);
                });
                await Promise.race([
                  page.evaluate((task) => window.renderScoreAudio(task), {
                    ...job.input,
                    id: job.id,
                    token: workerToken,
                  }),
                  stalledAudio,
                ]);
              } finally {
                clearInterval(timer);
                await page.close().catch(() => {});
              }
            })();
      void audioTask.catch(() => {});
      tasks = [rendering, audioTask];
      const removeAbortListener = () => job.abort.signal.removeEventListener('abort', abortQueue);
      void rendering.then(removeAbortListener, removeAbortListener);
      // Ensure a queue waiting for capacity also exits on a failed attempt.
      void memoryStopped.catch(abortQueue);
      // A crashed/hung GPU can leave page.evaluate pending indefinitely. The
      // server supervises progress even if Chrome's JavaScript thread is blocked.
      let lastProgress = Date.now(),
        lastReceived = job.received;
      const stalled = new Promise<never>((_, reject) => {
        watchdog = setInterval(
          () => {
            if (lastReceived !== job.received || (adaptive && job.waitingForResources)) {
              lastReceived = job.received;
              lastProgress = Date.now();
            } else if (Date.now() - lastProgress > (hooks.renderTimeoutMs ?? 60000)) {
              reject(new Error('The renderer stopped responding.'));
            }
          },
          hooks.renderTimeoutMs ? 100 : 1000,
        );
      });
      try {
        await Promise.race([
          rendering,
          stalled,
          memoryStopped,
          // A failed soundtrack should surface even while frames are arriving.
          audioTask.then(() => new Promise<never>(() => {})),
        ]);
        clearInterval(watchdog);
        job.renderSeconds = (Date.now() - job.renderStarted) / 1000;
        if (o.audio && !job.audioReceived) {
          job.state = 'audio';
          job.waitingForResources = false;
          job.resourceMessage = 'Video frames are saved. Finishing the soundtrack…';
        }
        await Promise.race([audioTask, memoryStopped]);
      } finally {
        queueAbort.abort();
      }
      clearInterval(watchdog);
      job.abort.signal.throwIfAborted();
      if (o.audio && !job.audioReceived) throw new Error('Audio rendering did not finish.');
      job.state = 'encoding';
      job.waitingForResources = false;
      job.resourceMessage = undefined;
      await job.browser.close();
      job.browser = undefined;
      await writeFile(
        path.join(job.checkpointDir, 'segments.txt'),
        ranges.map((range) => `file 'segment-${range.index}.mp4'`).join('\n'),
      );
      const mux = launch(job, encoder.executable, [
        '-f',
        'concat',
        '-safe',
        '1',
        '-i',
        path.join(job.checkpointDir, 'segments.txt'),
        ...(o.audio
          ? [
              '-i',
              path.join(job.checkpointDir, 'audio.wav'),
              '-map',
              '0:v:0',
              '-map',
              '1:a:0',
              '-c:a',
              'aac',
              '-b:a',
              '192k',
              '-af',
              'apad',
            ]
          : ['-an']),
        '-c:v',
        'copy',
        '-t',
        String(job.frames / o.fps),
        '-movflags',
        '+faststart',
        path.join(job.dir, 'final.mp4'),
      ]);
      mux.child.stdin.end();
      await Promise.race([mux.done, memoryStopped]);
      job.abort.signal.throwIfAborted();
      job.state = 'complete';
    } catch (error) {
      if (job.memoryFailure) throw job.memoryFailure;
      // A kernel OOM kill can reach Puppeteer before the next monitoring tick.
      if (job.memoryGroup && !job.abort.signal.aborted) {
        const sample = await job.memoryGroup.sample().catch(() => undefined);
        if (sample?.oom) throw new ExportMemoryError();
      }
      throw error;
    } finally {
      clearInterval(watchdog);
      clearInterval(memoryMonitor);
      await checkingMemory;
      // Revoke old workers before draining uploads and closing their processes.
      job.workerToken = randomUUID();
      await stopResources(job);
      job.memoryGroup = undefined;
      await Promise.allSettled(tasks);
      await rm(job.workDir, { recursive: true, force: true });
    }
  }

  async function run(job: Job) {
    let workerCap = 0,
      forceCpu = false;
    try {
      for (;;) {
        try {
          await runAttempt(job, workerCap, forceCpu);
          break;
        } catch (error) {
          job.abort.signal.throwIfAborted();
          if (!isGraphicsFailure(error) || job.attempt >= 3 || forceCpu) throw error;
          console.warn(`Export attempt ${job.attempt} lost its renderer:`, error);
          forceCpu = job.attempt === 2 || job.software;
          workerCap = forceCpu ? 1 : Math.max(1, Math.floor(job.workerCount / 2));
          job.attempt++;
          job.state = 'preparing';
          job.recoveryMessage = forceCpu
            ? `Continuing the remaining frames on the CPU. Keeping ${job.completedFrames.toLocaleString()} of ${job.frames.toLocaleString()} saved frames.`
            : `Recovering with ${workerCap} ${workerCap === 1 ? 'worker' : 'workers'}. Keeping ${job.completedFrames.toLocaleString()} of ${job.frames.toLocaleString()} saved frames.`;
          job.received = job.completedFrames;
          job.workers = [];
          job.device = '';
          job.renderStarted = 0;
          job.renderSeconds = 0;
        }
      }
    } catch (error) {
      job.state = 'error';
      job.error = job.abort.signal.aborted ? 'Export cancelled.' : publicExportError(error);
      if (!job.abort.signal.aborted) console.error('Server export failed:', error);
    } finally {
      await stopResources(job);
      job.running = false;
      job.updated = Date.now();
    }
  }

  app.post(base, express.json({ limit: '30mb' }), async (req, res) => {
    const parsed = serverExportSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message });
      return;
    }
    if (busy() || options.otherBusy()) {
      res.status(409).json({ error: 'An export is already running. Finish or cancel it first.' });
      return;
    }
    creating = true;
    try {
      const dir = await mkdtemp(path.join(tmpdir(), 'watch-notes-server-'));
      const o = parsed.data.options;
      const job: Job = {
        id: randomUUID(),
        token: randomUUID(),
        workerToken: randomUUID(),
        dir,
        workDir: '',
        input: parsed.data,
        state: 'preparing',
        frames: Math.ceil(((o.end - o.start) / o.rate) * o.fps),
        received: 0,
        workers: [],
        workerCount: 0,
        attempt: 1,
        software: false,
        memoryBytes: 0,
        memoryPeakBytes: 0,
        memoryLimitBytes: 0,
        completedSegments: 0,
        completedFrames: 0,
        savedSegments: new Set(),
        checkpointDir: path.join(dir, 'completed'),
        children: new Set(),
        done: Promise.resolve(),
        abort: new AbortController(),
        running: true,
        started: Date.now(),
        updated: Date.now(),
        renderStarted: 0,
        renderSeconds: 0,
        renderBaseFrames: 0,
        encoder: '',
        device: '',
        audioReceived: false,
        audioProgress: 0,
        audioUpdated: Date.now(),
        capture: 'png',
      };
      jobs.set(job.id, job);
      job.done = run(job);
      res.status(201).json({ id: job.id, token: job.token });
    } finally {
      creating = false;
    }
  });
  app.use(`${base}/:id`, (req, res, next) => {
    const job = jobs.get(req.params.id);
    if (!job) {
      res.status(404).json({ error: 'Export not found.' });
      return;
    }
    const workerRequest = req.method === 'PUT';
    if (req.headers['x-export-token'] !== (workerRequest ? job.workerToken : job.token)) {
      res.status(403).json({ error: 'Export access token required.' });
      return;
    }
    job.updated = Date.now();
    res.locals.job = job;
    next();
  });
  app.put(`${base}/:id/workers/:worker/device`, express.json({ limit: '2kb' }), (req, res) => {
    const job: Job = res.locals.job;
    if (!currentUpload(req, job))
      return void res.status(409).json({ error: 'This render attempt has ended.' });
    if (typeof req.body?.device === 'string') job.device = req.body.device.slice(0, 512);
    res.json({ ok: true });
  });
  app.put(`${base}/:id/workers/:worker/frames/:index`, async (req, res) => {
    const job: Job = res.locals.job;
    const worker = job.workers[Number(req.params.worker)],
      index = Number(req.params.index),
      o = job.input.options;
    if (
      !currentUpload(req, job) ||
      job.abort.signal.aborted ||
      job.state !== 'rendering' ||
      !worker ||
      !worker.active ||
      worker.busy ||
      index !== worker.from + worker.received ||
      index >= worker.to
    ) {
      res.status(409).json({ error: 'Frames must arrive in order within their segment.' });
      return;
    }
    const count = job.capture === 'rgba' ? Math.min(2, worker.to - index) : 1;
    if (!req.is(job.capture === 'rgba' ? 'application/octet-stream' : 'image/png')) {
      res.status(400).json({ error: 'Incorrect frame content type.' });
      return;
    }
    worker.busy = true;
    try {
      await streamFrameUpload(
        req,
        worker.child.stdin,
        { capture: job.capture, width: o.width, height: o.height, count },
        () => {
          if (!currentUpload(req, job) || !worker.active)
            throw new Error('This render attempt has ended.');
        },
      );
      if (!currentUpload(req, job) || !worker.active)
        return void res.status(409).json({ error: 'This render attempt has ended.' });
      worker.received += count;
      job.received += count;
      res.json({ received: worker.received });
    } catch {
      res.status(500).json({ error: 'Video encoder stopped.' });
    } finally {
      worker.busy = false;
    }
  });
  app.put(
    `${base}/:id/audio`,
    express.raw({ type: 'audio/wav', limit: '110mb' }),
    async (req, res) => {
      const job: Job = res.locals.job;
      if (
        !currentUpload(req, job) ||
        job.abort.signal.aborted ||
        !job.input.options.audio ||
        job.audioReceived
      ) {
        res.status(409).json({ error: 'This job is not accepting audio.' });
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
      const partial = path.join(job.workDir, 'audio.wav');
      await writeFile(partial, req.body);
      if (!currentUpload(req, job))
        return void res.status(409).json({ error: 'This render attempt has ended.' });
      await rename(partial, path.join(job.checkpointDir, 'audio.wav'));
      job.audioReceived = true;
      job.audioProgress = 1;
      res.json({ ok: true });
    },
  );
  app.put(`${base}/:id/audio-progress`, express.json({ limit: '1kb' }), (req, res) => {
    const job: Job = res.locals.job;
    const progress: unknown = req.body?.progress;
    if (!currentUpload(req, job) || !job.input.options.audio || job.audioReceived)
      return void res.status(409).json({ error: 'This audio render has ended.' });
    if (typeof progress !== 'number' || !Number.isFinite(progress) || progress < 0 || progress > 1)
      return void res.status(400).json({ error: 'Invalid audio progress.' });
    if (progress > job.audioProgress) {
      job.audioProgress = progress;
      job.audioUpdated = Date.now();
    }
    res.json({ ok: true });
  });
  app.get(`${base}/:id`, (_req, res) => {
    const job: Job = res.locals.job;
    const seconds =
      job.renderSeconds || (job.renderStarted ? (Date.now() - job.renderStarted) / 1000 : 0);
    res.json({
      state: job.state,
      received: job.received,
      frames: job.frames,
      workers: job.workerCount,
      requestedWorkers: job.input.options.workers,
      workerLimitReason: job.workerLimitReason,
      attempt: job.attempt,
      recoveryMessage: job.recoveryMessage,
      memoryBytes: job.memoryBytes,
      memoryPeakBytes: job.memoryPeakBytes,
      memoryLimitBytes: job.memoryLimitBytes,
      memoryLimitReason: job.memoryLimitReason,
      resourcePercent: job.input.options.resourcePercent,
      resourceMessage: job.resourceMessage,
      waitingForResources: job.waitingForResources,
      completedSegments: job.completedSegments,
      completedFrames: job.completedFrames,
      audioProgress: job.audioProgress,
      requestedMemoryLimitGiB: job.input.options.memoryLimitGiB,
      encoder: job.encoder,
      graphics: job.device
        ? /swiftshader|llvmpipe|software/i.test(job.device)
          ? 'software'
          : 'gpu'
        : 'pending',
      renderFps: seconds > 0 ? Math.max(0, job.received - job.renderBaseFrames) / seconds : 0,
      elapsed: (Date.now() - job.started) / 1000,
      error: job.state === 'error' ? job.error : undefined,
    });
  });
  app.get(`${base}/:id/download`, (_req, res) => {
    const job: Job = res.locals.job;
    if (job.state !== 'complete') {
      res.status(409).json({ error: 'Your video is still rendering.' });
      return;
    }
    const name =
      job.input.project.song.name.replace(/[^\p{L}\p{N}\- _]/gu, '').slice(0, 100) || 'watch-notes';
    res.download(path.join(job.dir, 'final.mp4'), `${name}.mp4`);
  });
  async function remove(job: Job) {
    job.abort.abort();
    await stopResources(job);
    await job.done;
    await rm(job.dir, { recursive: true, force: true });
    jobs.delete(job.id);
  }
  app.delete(`${base}/:id`, async (_req, res) => {
    await remove(res.locals.job);
    res.status(204).end();
  });
  const expiry = setInterval(() => {
    for (const job of jobs.values())
      if (Date.now() - job.updated > 30 * 60 * 1000) void remove(job).catch(console.error);
  }, 60000);
  expiry.unref();
  return {
    busy,
    close: async () => {
      clearInterval(expiry);
      await Promise.all([...jobs.values()].map(remove));
    },
  };
}
