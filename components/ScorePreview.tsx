'use client';
import { useEffect, useRef, useState } from 'react';
import type { Song, SceneSettings } from '@/lib/project';
import type { ScoreRenderer } from '@/lib/score-renderer';
export default function ScorePreview({
  song,
  settings,
  time,
  onCameraChange,
}: {
  song: Song;
  settings: SceneSettings;
  time: number;
  onCameraChange?: (v: Partial<SceneSettings>) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    engine = useRef<ScoreRenderer | null>(null);
  const latest = useRef({ song, settings, time });
  const [error, setError] = useState('');
  useEffect(() => {
    latest.current = { song, settings, time };
  }, [song, settings, time]);
  useEffect(() => {
    let cancelled = false;
    let resize: ResizeObserver | undefined;
    import('@/lib/score-renderer')
      .then(async ({ ScoreRenderer }) => {
        await document.fonts.load('40px "Noto Music"');
        if (cancelled || !canvas.current) return;
        const value = latest.current;
        const instance = new ScoreRenderer(
          canvas.current,
          value.song,
          value.settings,
          window.devicePixelRatio,
        );
        engine.current = instance;
        resize = new ResizeObserver((entries) => {
          const r = entries[0].contentRect;
          instance.resize(r.width, r.height);
          instance.render(latest.current.time);
        });
        resize.observe(canvas.current.parentElement!);
        instance.render(value.time);
      })
      .catch((e) => setError(e instanceof Error ? e.message : '3D preview unavailable'));
    return () => {
      cancelled = true;
      resize?.disconnect();
      engine.current?.dispose();
      engine.current = null;
    };
  }, []);
  useEffect(() => {
    engine.current?.setSong(song);
    engine.current?.render(time);
  }, [song]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    engine.current?.setSettings(settings);
    engine.current?.render(time);
  }, [settings]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    engine.current?.render(time);
  }, [time]);
  const drag = useRef<{ x: number; y: number; angle: number; azimuth: number } | null>(null);
  return (
    <div className="score-canvas-wrap">
      <canvas
        aria-label={
          settings.cameraMode === 'cinematic' && settings.layout === 'orchestra'
            ? '3D musical score with automatic cinematic camera.'
            : '3D musical score. Drag to orbit the camera.'
        }
        ref={canvas}
        onPointerDown={(e) => {
          if (settings.cameraMode === 'cinematic' && settings.layout === 'orchestra') return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = {
            x: e.clientX,
            y: e.clientY,
            angle: settings.angle,
            azimuth: settings.azimuth,
          };
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onPointerMove={(e) => {
          if (settings.cameraMode === 'cinematic' && settings.layout === 'orchestra') return;
          if (!drag.current) return;
          onCameraChange?.({
            angle: Math.max(
              18,
              Math.min(88, drag.current.angle + (e.clientY - drag.current.y) * 0.2),
            ),
            azimuth: Math.max(
              -65,
              Math.min(65, drag.current.azimuth - (e.clientX - drag.current.x) * 0.15),
            ),
          });
        }}
      />
      {error && (
        <div className="canvas-error">
          <strong>3D preview unavailable</strong>
          <p>{error}</p>
          <p>Try a browser with WebGL 2 and hardware acceleration enabled.</p>
        </div>
      )}
    </div>
  );
}
