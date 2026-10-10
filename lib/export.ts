import type { Project } from './project';
import { ScoreRenderer } from './score-renderer';
import { renderAudio } from './render-audio';
export type ExportOptions = {
  width: 1280 | 1920;
  height: 720 | 1080;
  fps: 24 | 30 | 60;
  start: number;
  end: number;
  audio: boolean;
  rate: number;
  mode?: 'server' | 'device';
  workers?: number;
  memoryLimitGiB?: number;
  resourcePercent?: number;
};
export type ExportProgress = {
  phase: 'preparing' | 'audio' | 'rendering' | 'encoding' | 'complete';
  progress: number;
  frame?: number;
  total?: number;
  workers?: number;
  requestedWorkers?: number;
  workerLimitReason?: string;
  recoveryMessage?: string;
  memoryBytes?: number;
  memoryLimitBytes?: number;
  memoryLimitReason?: string;
  resourceMessage?: string;
  waitingForResources?: boolean;
  renderFps?: number;
  audioProgress?: number;
  encoder?: string;
  graphics?: 'pending' | 'software' | 'gpu';
};
export async function exportVideo(
  project: Project,
  options: ExportOptions,
  signal: AbortSignal,
  onProgress: (value: ExportProgress) => void,
): Promise<Blob> {
  if (options.mode !== 'device') return exportOnServer(project, options, signal, onProgress);
  let id = '',
    token = '',
    renderer: ScoreRenderer | undefined;
  const request = async (url: string, init: RequestInit = {}) => {
    const response = await fetch(url, {
      ...init,
      signal,
      headers: { ...init.headers, ...(token ? { 'x-export-token': token } : {}) },
    });
    if (!response.ok) {
      const data = (await response.json().catch(() => ({
        error: 'Export service is unavailable. Start the app with npm run dev.',
      }))) as { error?: string };
      throw new Error(data.error || 'Export failed.');
    }
    return response;
  };
  try {
    const duration = (options.end - options.start) / options.rate,
      frames = Math.ceil(duration * options.fps);
    if (duration <= 0 || duration > 600)
      throw new Error('Choose an export range between 0 and 10 minutes.');
    const response = await request('/api/export/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        width: options.width,
        height: options.height,
        fps: options.fps,
        frames,
        name: project.song.name,
        audio: options.audio,
      }),
    });
    ({ id, token } = (await response.json()) as { id: string; token: string });
    if (options.audio) {
      onProgress({ phase: 'audio', progress: 0 });
      const audio = await renderAudio(
        project.song,
        options.start,
        options.end,
        project.settings.volume,
        options.rate,
        (audioProgress) => onProgress({ phase: 'audio', progress: 0, audioProgress }),
      );
      signal.throwIfAborted();
      await request(`/api/export/jobs/${id}/audio`, {
        method: 'PUT',
        headers: { 'Content-Type': 'audio/wav' },
        body: audio,
      });
    }
    await document.fonts.load('40px "Noto Music"');
    const canvas = document.createElement('canvas');
    renderer = new ScoreRenderer(canvas, project.song, project.settings, 1);
    renderer.resize(options.width, options.height);
    for (let i = 0; i < frames; i++) {
      signal.throwIfAborted();
      renderer.render(options.start + (i / options.fps) * options.rate);
      const frame = await renderer.frame();
      await request(`/api/export/jobs/${id}/frames/${i}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/png' },
        body: frame,
      });
      onProgress({
        phase: 'rendering',
        progress: ((i + 1) / frames) * 0.95,
        frame: i + 1,
        total: frames,
      });
    }
    renderer.dispose();
    renderer = undefined;
    onProgress({ phase: 'encoding', progress: 0.96 });
    await request(`/api/export/jobs/${id}/finish`, { method: 'POST' });
    for (;;) {
      signal.throwIfAborted();
      const job = (await (await request(`/api/export/jobs/${id}`)).json()) as {
        state: string;
        error?: string;
      };
      if (job.state === 'error') throw new Error(job.error || 'Encoding failed.');
      if (job.state === 'complete') break;
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    const file = await (await request(`/api/export/jobs/${id}/download`)).blob();
    onProgress({ phase: 'complete', progress: 1 });
    return file;
  } finally {
    renderer?.dispose();
    if (id)
      await fetch(`/api/export/jobs/${id}`, {
        method: 'DELETE',
        headers: { 'x-export-token': token },
      }).catch(() => {});
  }
}

async function exportOnServer(
  project: Project,
  options: ExportOptions,
  signal: AbortSignal,
  onProgress: (value: ExportProgress) => void,
): Promise<Blob> {
  let id = '',
    token = '';
  const base = '/api/export/server-jobs';
  const request = async (url: string, init: RequestInit = {}) => {
    const response = await fetch(url, {
      ...init,
      signal,
      headers: { ...init.headers, ...(token ? { 'x-export-token': token } : {}) },
    });
    if (!response.ok) {
      const data = (await response.json().catch(() => ({
        error: 'Export service is unavailable. Start the app with npm run dev.',
      }))) as { error?: string };
      throw new Error(data.error || 'Server export failed.');
    }
    return response;
  };
  try {
    onProgress({ phase: 'preparing', progress: 0 });
    // Receive the job token even if cancellation happens during creation, so cleanup is possible.
    signal.throwIfAborted();
    const created = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project, options }),
    });
    if (!created.ok) {
      const data = (await created.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error || 'The server could not start this export.');
    }
    ({ id, token } = (await created.json()) as { id: string; token: string });
    for (;;) {
      signal.throwIfAborted();
      const job = (await (await request(`${base}/${id}`)).json()) as {
        state: 'preparing' | 'rendering' | 'audio' | 'encoding' | 'complete' | 'error';
        received: number;
        frames: number;
        workers: number;
        requestedWorkers: number;
        workerLimitReason?: string;
        recoveryMessage?: string;
        memoryBytes?: number;
        memoryLimitBytes?: number;
        memoryLimitReason?: string;
        resourceMessage?: string;
        waitingForResources?: boolean;
        renderFps: number;
        audioProgress: number;
        encoder: string;
        graphics: 'pending' | 'software' | 'gpu';
        error?: string;
      };
      if (job.state === 'error') throw new Error(job.error || 'Server export failed.');
      onProgress({
        phase: job.state === 'complete' ? 'encoding' : job.state,
        progress:
          job.state === 'complete'
            ? 0.99
            : job.state === 'encoding'
              ? 0.97
              : job.state === 'audio'
                ? 0.95 + job.audioProgress * 0.02
                : (job.received / job.frames) * 0.95,
        frame: job.received,
        total: job.frames,
        workers: job.workers,
        requestedWorkers: job.requestedWorkers,
        workerLimitReason: job.workerLimitReason,
        recoveryMessage: job.recoveryMessage,
        memoryBytes: job.memoryBytes,
        memoryLimitBytes: job.memoryLimitBytes,
        memoryLimitReason: job.memoryLimitReason,
        resourceMessage: job.resourceMessage,
        waitingForResources: job.waitingForResources,
        renderFps: job.renderFps,
        audioProgress: job.audioProgress,
        encoder: job.encoder,
        graphics: job.graphics,
      });
      if (job.state === 'complete') break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const file = await (await request(`${base}/${id}/download`)).blob();
    onProgress({ phase: 'complete', progress: 1 });
    return file;
  } finally {
    if (id)
      await fetch(`${base}/${id}`, {
        method: 'DELETE',
        headers: { 'x-export-token': token },
      }).catch(() => {});
  }
}
