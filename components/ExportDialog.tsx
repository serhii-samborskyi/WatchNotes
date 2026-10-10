'use client';
import { useEffect, useRef, useState } from 'react';
import { Check, Download, Film, LoaderCircle } from 'lucide-react';
import Dialog from './Dialog';
import type { Project } from '@/lib/project';
import type { ExportProgress } from '@/lib/export';
import {
  AUTO_RENDER_WORKERS,
  MAX_RENDER_WORKERS,
  DEFAULT_EXPORT_RESOURCE_PERCENT,
  MIN_EXPORT_RESOURCE_PERCENT,
  MAX_EXPORT_RESOURCE_PERCENT,
} from '@/lib/export-settings';
export default function ExportDialog({
  project,
  rate,
  onClose,
}: {
  project: Project;
  rate: number;
  onClose: () => void;
}) {
  const [resolution, setResolution] = useState('720'),
    [fps, setFps] = useState<24 | 30 | 60>(30),
    [start, setStart] = useState(0),
    [end, setEnd] = useState(Math.min(project.song.duration, 600 * rate)),
    [audio, setAudio] = useState(true),
    [mode, setMode] = useState<'server' | 'device'>('server'),
    [workers, setWorkers] = useState(AUTO_RENDER_WORKERS),
    [resourcePercent, setResourcePercent] = useState(DEFAULT_EXPORT_RESOURCE_PERCENT),
    [error, setError] = useState(''),
    [progress, setProgress] = useState<ExportProgress | null>(null),
    [download, setDownload] = useState('');
  const controller = useRef<AbortController | null>(null),
    downloadRef = useRef('');
  useEffect(
    () => () => {
      controller.current?.abort();
      if (downloadRef.current) URL.revokeObjectURL(downloadRef.current);
    },
    [],
  );
  const duration = (end - start) / rate,
    busy = progress !== null && progress.phase !== 'complete',
    invalid =
      !Number.isFinite(duration) ||
      duration <= 0 ||
      duration > 600 ||
      start < 0 ||
      end > project.song.duration ||
      (mode === 'server' &&
        (!Number.isInteger(resourcePercent) ||
          resourcePercent < MIN_EXPORT_RESOURCE_PERCENT ||
          resourcePercent > MAX_EXPORT_RESOURCE_PERCENT)) ||
      !project.song.tracks.some((t) => t.enabled);
  const close = () => {
    controller.current?.abort();
    onClose();
  };
  async function begin() {
    setError('');
    setProgress({ phase: 'preparing', progress: 0 });
    controller.current = new AbortController();
    try {
      const { exportVideo } = await import('@/lib/export');
      const blob = await exportVideo(
        project,
        {
          width: resolution === '720' ? 1280 : 1920,
          height: resolution === '720' ? 720 : 1080,
          fps,
          start,
          end,
          audio,
          rate,
          mode,
          workers: mode === 'server' ? workers : undefined,
          resourcePercent: mode === 'server' ? resourcePercent : undefined,
        },
        controller.current.signal,
        setProgress,
      );
      const url = URL.createObjectURL(blob);
      downloadRef.current = url;
      setDownload(url);
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError'))
        setError(e instanceof Error ? e.message : 'Export failed.');
      setProgress(null);
    }
  }
  return (
    <Dialog title="Export your scene" onClose={close}>
      <p className="dialog-description">
        Turn this moment into a video. Your scene, enabled tracks, and playback speed are included.
      </p>
      {!progress && (
        <>
          <div className="export-setting-grid">
            <label>
              Resolution
              <select value={resolution} onChange={(e) => setResolution(e.target.value)}>
                <option value="720">HD · 1280 × 720</option>
                <option value="1080">Full HD · 1920 × 1080</option>
              </select>
            </label>
            <label>
              Frame rate
              <select value={fps} onChange={(e) => setFps(+e.target.value as 24 | 30 | 60)}>
                <option value="24">24 fps · cinematic</option>
                <option value="30">30 fps · standard</option>
                <option value="60">60 fps · smooth</option>
              </select>
            </label>
            <label>
              Start · seconds
              <input
                type="number"
                min="0"
                max={end - 0.01}
                step=".1"
                value={start}
                onChange={(e) => setStart(e.target.valueAsNumber)}
              />
            </label>
            <label>
              End · seconds
              <input
                type="number"
                min={start + 0.01}
                max={project.song.duration}
                step=".1"
                value={end}
                onChange={(e) => setEnd(e.target.valueAsNumber)}
              />
            </label>
          </div>
          <label className="export-render-mode">
            Render with
            <select value={mode} onChange={(e) => setMode(e.target.value as 'server' | 'device')}>
              <option value="server">Server · parallel rendering</option>
              <option value="device">This device · browser rendering</option>
            </select>
          </label>
          {mode === 'server' && (
            <>
              <label className="export-render-mode">
                Render workers
                <select
                  value={workers}
                  onChange={(e) => setWorkers(Number(e.target.value))}
                  aria-describedby="render-workers-help"
                >
                  <option value={AUTO_RENDER_WORKERS}>Automatic</option>
                  {Array.from({ length: MAX_RENDER_WORKERS }, (_, i) => i + 1).map((count) => (
                    <option value={count} key={count}>
                      {count} {count === 1 ? 'worker' : 'workers'}
                    </option>
                  ))}
                </select>
              </label>
              <p id="render-workers-help" className="export-footnote">
                Automatic adjusts up to 8 workers as capacity changes. A manual selection sets the
                maximum, rather than forcing every worker to run.
              </p>
              <label className="export-render-mode">
                Server resource target · {resourcePercent}%
                <input
                  type="range"
                  min={MIN_EXPORT_RESOURCE_PERCENT}
                  max={MAX_EXPORT_RESOURCE_PERCENT}
                  step="5"
                  value={resourcePercent}
                  onChange={(e) => setResourcePercent(e.target.valueAsNumber)}
                  aria-describedby="render-resources-help"
                />
              </label>
              <p id="render-resources-help" className="export-footnote">
                Sets the export CPU ceiling and the target for total server RAM use. GPU load guides
                worker count; its percentage is approximate. The export speeds up when capacity is
                available and slows down or waits when the server is busy, keeping finished
                segments. Some RAM always stays reserved for the system.
              </p>
            </>
          )}
          <label className="checkbox-label">
            <input type="checkbox" checked={audio} onChange={(e) => setAudio(e.target.checked)} />
            Include audio{' '}
            <span>
              {project.song.audioMode === 'orchestra' ? 'Sampled orchestra' : 'Soft keys synth'}
            </span>
          </label>
          <div className="export-summary">
            <Film size={16} />
            <span>
              MP4 · H.264 · {Number.isFinite(duration) ? duration.toFixed(1) : '—'} seconds · {rate}
              × speed
            </span>
          </div>
          <p className="export-footnote">
            {mode === 'server'
              ? 'The server renders and encodes in parallel. Keep this tab open to collect your video.'
              : 'This device renders the scene and sends frames to the server. Keep this tab open.'}{' '}
            Exports can be up to 10 minutes.
          </p>
        </>
      )}
      {progress && (
        <div className="export-progress">
          {progress.phase === 'complete' ? (
            <div className="export-check">
              <Check size={27} />
            </div>
          ) : (
            <LoaderCircle size={28} className="spinner" />
          )}
          <strong>
            {progress.waitingForResources
              ? 'Waiting for server capacity…'
              : progress.phase === 'preparing'
                ? 'Preparing the renderer…'
                : progress.phase === 'audio'
                  ? 'Rendering audio…'
                  : progress.phase === 'rendering'
                    ? 'Rendering your scene…'
                    : progress.phase === 'encoding'
                      ? 'Finishing your video…'
                      : 'Your video is ready'}
          </strong>
          <p>
            {progress.phase === 'rendering'
              ? `Frame ${progress.frame?.toLocaleString()} of ${progress.total?.toLocaleString()}`
              : progress.phase === 'audio'
                ? `Soundtrack ${Math.round((progress.audioProgress || 0) * 100)}% complete${mode === 'server' ? ' · video frames are saved' : ''}`
                : progress.phase === 'complete'
                  ? 'Save it, share it, or make another scene.'
                  : 'Every note, exactly in time.'}
          </p>
          <progress max="1" value={progress.progress} />
          <span>{Math.round(progress.progress * 100)}% overall</span>
          {progress.phase === 'audio' && (
            <progress
              aria-label="Soundtrack progress"
              max="1"
              value={progress.audioProgress || 0}
            />
          )}
          {progress.recoveryMessage && progress.phase !== 'complete' && (
            <p className="export-footnote" role="status">
              {progress.recoveryMessage}
            </p>
          )}
          {progress.resourceMessage && progress.phase !== 'complete' && (
            <p className="export-footnote" role="status">
              {progress.resourceMessage}
            </p>
          )}
          {progress.phase !== 'complete' && progress.workers !== undefined && (
            <p className="export-footnote">
              {progress.phase === 'audio' ? (
                'Synthesizing the soundtrack'
              ) : (
                <>
                  {progress.workers} render {progress.workers === 1 ? 'worker' : 'workers'}
                  {progress.renderFps ? ` · ${progress.renderFps.toFixed(1)} frames/sec` : ''}
                  {progress.encoder ? ` · ${progress.encoder}` : ''}
                </>
              )}
              {!!progress.memoryLimitBytes && (
                <>
                  <br />
                  Render RAM: {((progress.memoryBytes || 0) / 1024 ** 3).toFixed(1)} /{' '}
                  {(progress.memoryLimitBytes / 1024 ** 3).toFixed(1)} GiB limit
                </>
              )}
              {progress.memoryLimitReason && (
                <>
                  <br />
                  {progress.memoryLimitReason}
                </>
              )}
              {progress.workerLimitReason && progress.phase !== 'audio' && (
                <>
                  <br />
                  {progress.workerLimitReason}
                </>
              )}
              {progress.graphics === 'software' && progress.phase !== 'audio' && (
                <>
                  <br />
                  GPU rendering unavailable; using the server CPU.
                </>
              )}
            </p>
          )}
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button className="button" onClick={close}>
          {busy ? 'Cancel export' : 'Close'}
        </button>
        {download ? (
          <a className="button primary" href={download} download={`${project.song.name}.mp4`}>
            <Download size={15} />
            Download MP4
          </a>
        ) : !busy ? (
          <button className="button primary" onClick={begin} disabled={invalid}>
            <Film size={15} />
            Render video
          </button>
        ) : null}
      </div>
    </Dialog>
  );
}
