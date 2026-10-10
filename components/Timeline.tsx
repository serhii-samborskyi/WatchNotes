'use client';
import { memo, useEffect, useRef } from 'react';
import { formatTime, type Song } from '@/lib/project';
import { audibleTracks } from '@/lib/orchestra';
const NoteLanes = memo(function NoteLanes({ song }: { song: Song }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!canvas.current) return;
    const element = canvas.current;
    const draw = () => {
      const width = element.clientWidth,
        height = element.clientHeight,
        ratio = window.devicePixelRatio || 1;
      element.width = width * ratio;
      element.height = height * ratio;
      const ctx = element.getContext('2d')!;
      ctx.scale(ratio, ratio);
      const tracks = audibleTracks(song),
        count = Math.max(1, tracks.length);
      ctx.strokeStyle = '#293527';
      ctx.lineWidth = 1;
      for (let i = 0; i <= 10; i++) {
        ctx.beginPath();
        ctx.moveTo((i * width) / 10, 0);
        ctx.lineTo((i * width) / 10, height);
        ctx.stroke();
      }
      tracks.forEach((track, index) => {
        const row = index % count,
          h = height / count;
        ctx.fillStyle = track.color;
        ctx.globalAlpha = 0.65;
        for (const note of track.notes) {
          const x = (note.time / song.duration) * width,
            y = row * h + 4 + (1 - note.midi / 127) * (h - 9);
          ctx.fillRect(x, y, Math.max(1.6, (note.duration / song.duration) * width), 2.5);
        }
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#293527';
        ctx.fillRect(0, row * h, width, 1);
      });
    };
    const observer = new ResizeObserver(draw);
    observer.observe(element);
    draw();
    return () => observer.disconnect();
  }, [song]);
  return (
    <canvas
      ref={canvas}
      className="note-lanes-canvas"
      style={{ height: Math.max(60, audibleTracks(song).length * 18) }}
      aria-hidden="true"
    />
  );
});
export default function Timeline({
  song,
  time,
  onSeek,
  disabled,
}: {
  song: Song;
  time: number;
  onSeek: (t: number) => void;
  disabled: boolean;
}) {
  const times = Array.from({ length: 6 }, (_, i) => (song.duration * i) / 5);
  return (
    <div className="timeline">
      <div className="timeline-head">
        <span>TIMELINE</span>
        <span>ALL ENABLED TRACKS</span>
        <span className="timeline-duration">{formatTime(song.duration)}</span>
      </div>
      <div className="ruler">
        {times.map((t, i) => (
          <span key={i}>{formatTime(t)}</span>
        ))}
      </div>
      <div className="timeline-lanes">
        <div className="timeline-notes-scroll">
          <NoteLanes song={song} />
        </div>
        <div className="timeline-playhead" style={{ left: `${(time / song.duration) * 100}%` }}>
          <span />
        </div>
        <input
          className="timeline-scrubber"
          type="range"
          min="0"
          max={song.duration}
          step="0.01"
          value={time}
          onChange={(e) => onSeek(+e.target.value)}
          aria-label="Playback position"
          aria-valuetext={formatTime(time)}
          disabled={disabled}
        />
      </div>
    </div>
  );
}
