'use client';
import { useState } from 'react';
import { ArrowUp, ArrowDown, ChevronDown, Volume2, VolumeX } from 'lucide-react';
import type { Song, Track } from '@/lib/project';
import {
  INSTRUMENTS,
  trackProgram,
  DEFAULT_MUSICIAN_SCALE,
  MAX_MUSICIAN_SCALE,
} from '@/lib/orchestra';
export default function TrackEditor({
  song,
  onChange,
  onMove,
}: {
  song: Song;
  onChange: (id: string, patch: Partial<Track>) => void;
  onMove: (id: string, delta: number) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <div className="tracks-list">
      {song.tracks.map((t, index) => {
        const selected = `${trackProgram(t)}:${t.percussion ? 1 : 0}`,
          m = t.musician || {};
        const musician = (patch: Partial<NonNullable<Track['musician']>>) =>
          onChange(t.id, { musician: { ...m, ...patch } });
        const known = INSTRUMENTS.some(
          (i) => `${i.program}:${'percussion' in i ? 1 : 0}` === selected,
        );
        return (
          <div className="track-card" key={t.id}>
            <div className={`track ${t.enabled ? '' : 'muted'}`}>
              <span className="track-color" style={{ background: t.color }} />
              <button
                className="track-text track-expand"
                aria-expanded={expanded === t.id}
                aria-label={`Edit ${t.name}`}
                onClick={() => setExpanded(expanded === t.id ? null : t.id)}
              >
                <strong>{t.name}</strong>
                <small>
                  {t.instrument} · {t.notes.length.toLocaleString()} notes
                </small>
              </button>
              <button
                className={`track-solo ${t.solo ? 'selected' : ''}`}
                aria-label={`Solo ${t.name}`}
                aria-pressed={!!t.solo}
                onClick={() => onChange(t.id, { solo: !t.solo, enabled: true })}
              >
                S
              </button>
              <button
                className="track-mute"
                aria-label={`${t.enabled ? 'Mute' : 'Enable'} ${t.name}`}
                aria-pressed={!t.enabled}
                onClick={() => onChange(t.id, { enabled: !t.enabled })}
              >
                {t.enabled ? <Volume2 size={14} /> : <VolumeX size={14} />}
              </button>
              <button
                className="track-chevron"
                aria-label={`Settings for ${t.name}`}
                aria-expanded={expanded === t.id}
                onClick={() => setExpanded(expanded === t.id ? null : t.id)}
              >
                <ChevronDown size={12} />
              </button>
            </div>
            {expanded === t.id && (
              <div className="track-controls">
                <label>
                  Name
                  <input
                    value={t.name}
                    maxLength={100}
                    onChange={(e) => onChange(t.id, { name: e.target.value })}
                  />
                </label>
                <label>
                  Instrument
                  <select
                    value={selected}
                    onChange={(e) => {
                      const i = INSTRUMENTS.find(
                        (i) => `${i.program}:${'percussion' in i ? 1 : 0}` === e.target.value,
                      );
                      if (i)
                        onChange(t.id, {
                          program: i.program,
                          instrument: i.name,
                          percussion: 'percussion' in i,
                        });
                    }}
                  >
                    {!known && (
                      <option value={selected}>
                        {t.instrument} · MIDI {trackProgram(t) + 1}
                      </option>
                    )}
                    {INSTRUMENTS.map((i) => (
                      <option key={i.name} value={`${i.program}:${'percussion' in i ? 1 : 0}`}>
                        {i.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Track volume <span>{Math.round((t.volume ?? 1) * 100)}%</span>
                  <input
                    aria-label={`${t.name} volume`}
                    type="range"
                    min="0"
                    max="1"
                    step=".01"
                    value={t.volume ?? 1}
                    onChange={(e) => onChange(t.id, { volume: +e.target.value })}
                  />
                </label>
                <label>
                  Color
                  <input
                    aria-label={`${t.name} color`}
                    type="color"
                    value={t.color}
                    onChange={(e) => onChange(t.id, { color: e.target.value })}
                  />
                </label>
                <label>
                  Musician
                  <select
                    value={m.kind ?? 'auto'}
                    onChange={(e) => musician({ kind: e.target.value as typeof m.kind })}
                  >
                    <option value="auto">Match instrument</option>
                    <option value="piano">Pianist</option>
                    <option value="violin">Violinist</option>
                    <option value="cello">Cellist</option>
                    <option value="flute">Flutist</option>
                    <option value="trumpet">Trumpeter</option>
                    <option value="drums">Percussionist</option>
                  </select>
                </label>
                <label className="track-check">
                  <input
                    type="checkbox"
                    checked={m.visible !== false}
                    onChange={(e) => musician({ visible: e.target.checked })}
                  />
                  Show musician
                </label>
                <label>
                  Share performer
                  <select
                    value={m.groupWith ?? ''}
                    disabled={song.tracks.some((x) => x.musician?.groupWith === t.id)}
                    onChange={(e) => musician({ groupWith: e.target.value })}
                  >
                    <option value="">Own musician</option>
                    {song.tracks
                      .filter((x) => x.id !== t.id && !x.musician?.groupWith)
                      .map((x) => (
                        <option value={x.id} key={x.id}>
                          {x.name}
                        </option>
                      ))}
                  </select>
                </label>
                {[
                  {
                    key: 'scale' as const,
                    label: 'Size',
                    min: 0.4,
                    max: MAX_MUSICIAN_SCALE,
                    step: 0.1,
                    value: m.scale ?? DEFAULT_MUSICIAN_SCALE,
                  },
                  {
                    key: 'x' as const,
                    label: 'Position along staff',
                    min: -10,
                    max: 10,
                    step: 0.25,
                    value: m.x ?? 0,
                  },
                  {
                    key: 'y' as const,
                    label: 'Position across staff',
                    min: -5,
                    max: 5,
                    step: 0.25,
                    value: m.y ?? 0,
                  },
                ].map((field) => (
                  <label key={field.key}>
                    {field.label}
                    <span>{field.value.toFixed(1)}</span>
                    <input
                      aria-label={`${t.name} musician ${field.label.toLowerCase()}`}
                      type="range"
                      min={field.min}
                      max={field.max}
                      step={field.step}
                      value={field.value}
                      onChange={(e) => musician({ [field.key]: +e.target.value })}
                    />
                  </label>
                ))}
                <div className="track-order">
                  <button disabled={index === 0} onClick={() => onMove(t.id, -1)}>
                    <ArrowUp size={12} />
                    Move up
                  </button>
                  <button
                    disabled={index === song.tracks.length - 1}
                    onClick={() => onMove(t.id, 1)}
                  >
                    <ArrowDown size={12} />
                    Move down
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
