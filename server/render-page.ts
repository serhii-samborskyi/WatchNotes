import { ScoreRenderer } from '../lib/score-renderer';
import { renderAudio } from '../lib/render-audio';
import type { ServerExportRequest } from '../lib/validation';

export type RenderTask = ServerExportRequest & {
  id: string;
  token: string;
  worker: number;
  from: number;
  to: number;
  capture: 'rgba' | 'png';
};

async function render(task: RenderTask) {
  const { project, options: o, id, token, worker, from, to } = task;
  const timings = { drawingMs: 0, captureMs: 0, uploadMs: 0 };
  const base = `/api/export/server-jobs/${id}`;
  const send = async (url: string, body: BodyInit, contentType: string) => {
    const started = performance.now();
    const response = await fetch(base + url, {
      method: 'PUT',
      headers: { 'x-export-token': token, 'content-type': contentType },
      body,
    });
    if (!response.ok)
      throw new Error(
        ((await response.json()) as { error?: string }).error || 'Frame transfer failed.',
      );
    await response.arrayBuffer();
    if (url.includes('/frames/')) timings.uploadMs += performance.now() - started;
  };
  await document.fonts.load('40px "Noto Music"');
  const canvas = document.createElement('canvas');
  const renderer = new ScoreRenderer(canvas, project.song, project.settings, 1);
  renderer.resize(o.width, o.height);
  await send(
    `/workers/${worker}/device`,
    JSON.stringify({ device: renderer.graphicsDevice() }),
    'application/json',
  );
  const frameBytes = o.width * o.height * 4;
  const buffers =
    task.capture === 'rgba' ? [new Uint8Array(frameBytes * 2), new Uint8Array(frameBytes * 2)] : [];
  let pending = Promise.resolve();
  try {
    const batchSize = task.capture === 'rgba' ? 2 : 1;
    for (let index = from, batch = 0; index < to; index += batchSize, batch++) {
      if (task.capture === 'png') {
        // Chrome's native capture is faster than raw readback under SwiftShader.
        const started = performance.now();
        renderer.render(o.start + (index / o.fps) * o.rate);
        const drawn = performance.now();
        const frame = await renderer.frame();
        timings.drawingMs += drawn - started;
        timings.captureMs += performance.now() - drawn;
        await pending;
        pending = send(`/workers/${worker}/frames/${index}`, frame, 'image/png');
        void pending.catch(() => {});
        continue;
      }
      const count = Math.min(2, to - index);
      const buffer = buffers[batch % 2];
      for (let n = 0; n < count; n++) {
        const started = performance.now();
        renderer.render(o.start + ((index + n) / o.fps) * o.rate);
        const drawn = performance.now();
        await renderer.readFrame(buffer.subarray(n * frameBytes, (n + 1) * frameBytes));
        timings.drawingMs += drawn - started;
        timings.captureMs += performance.now() - drawn;
      }
      // Double buffering overlaps the next render with a bounded, backpressured upload.
      await pending;
      pending = send(
        `/workers/${worker}/frames/${index}`,
        buffer.subarray(0, count * frameBytes),
        'application/octet-stream',
      );
      void pending.catch(() => {});
    }
    await pending;
    return timings;
  } finally {
    renderer.dispose();
  }
}

async function renderScoreAudio(task: ServerExportRequest & { id: string; token: string }) {
  const { project, options: o, id, token } = task;
  const base = `/api/export/server-jobs/${id}`;
  let last = 0;
  const wav = await renderAudio(
    project.song,
    o.start,
    o.end,
    project.settings.volume,
    o.rate,
    (progress) => {
      if (progress < 1 && performance.now() - last < 500) return;
      last = performance.now();
      void fetch(`${base}/audio-progress`, {
        method: 'PUT',
        headers: { 'x-export-token': token, 'content-type': 'application/json' },
        body: JSON.stringify({ progress }),
      }).catch(() => {});
    },
  );
  const response = await fetch(`${base}/audio`, {
    method: 'PUT',
    headers: { 'x-export-token': token, 'content-type': 'audio/wav' },
    body: wav,
  });
  if (!response.ok) throw new Error('Audio transfer failed.');
  await response.arrayBuffer();
}

declare global {
  interface Window {
    renderScore: typeof render;
    renderScoreAudio: typeof renderScoreAudio;
  }
}
window.renderScore = render;
window.renderScoreAudio = renderScoreAudio;
