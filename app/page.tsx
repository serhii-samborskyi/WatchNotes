'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Music2,
  Upload,
  Play,
  Pause,
  Download,
  SlidersHorizontal,
  Layers,
  Camera,
  Sparkles,
  FolderOpen,
  Volume2,
  VolumeX,
  SkipBack,
  Repeat2,
  Save,
  RotateCcw,
  Check,
  X,
  Keyboard,
  Maximize2,
  FileMusic,
  Info,
} from 'lucide-react';
import ScorePreview from '@/components/ScorePreview';
import Timeline from '@/components/Timeline';
import Dialog from '@/components/Dialog';
import ExportDialog from '@/components/ExportDialog';
import TrackEditor from '@/components/TrackEditor';
import { createOrchestraDemo } from '@/lib/orchestra-demo';
import {
  createDemo,
  DEFAULT_SETTINGS,
  MAX_NOTE_SPACING,
  formatTime,
  getBars,
  timeToTick,
  THEMES,
  type Project,
  type SceneSettings,
  type Song,
  type Track,
} from '@/lib/project';
import { AudioPlayer } from '@/lib/audio';
import { parseProject } from '@/lib/validation';
function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: () => void;
}) {
  return (
    <div className="toggle-row">
      <span>{label}</span>
      <button
        type="button"
        role="switch"
        aria-label={label}
        aria-checked={value}
        className={`toggle ${value ? 'on' : ''}`}
        onClick={onChange}
      >
        <span />
      </button>
    </div>
  );
}
function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  suffix = '',
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="slider-field">
      <span className="field-label">
        {label}
        <span>
          {step < 1 ? value.toFixed(step < 0.1 ? 2 : 1) : Math.round(value)}
          {suffix}
        </span>
      </span>
      <input
        aria-label={label}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(+e.target.value)}
      />
    </label>
  );
}
export default function Home() {
  const [song, setSong] = useState<Song>(createOrchestraDemo),
    [settings, setSettings] = useState<SceneSettings>(DEFAULT_SETTINGS),
    [time, setTime] = useState(0),
    [playing, setPlaying] = useState(false),
    [loop, setLoop] = useState(false),
    [rate, setRate] = useState(1),
    [saved, setSaved] = useState(true),
    [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null),
    [dialog, setDialog] = useState<'export' | 'help' | null>(null),
    [loading, setLoading] = useState(false),
    [audioLoading, setAudioLoading] = useState(false),
    [dragging, setDragging] = useState(false),
    [trackPanel, setTrackPanel] = useState(false);
  const midiInput = useRef<HTMLInputElement>(null),
    projectInput = useRef<HTMLInputElement>(null),
    audio = useRef<AudioPlayer | null>(null),
    playbackToken = useRef(0),
    viewport = useRef<HTMLDivElement>(null),
    currentTime = useRef(0),
    noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const notes = useMemo(() => song.tracks.reduce((total, t) => total + t.notes.length, 0), [song]),
    bars = useMemo(() => getBars(song), [song]);
  const tempo = [...song.tempos].reverse().find((t) => t.time <= time)?.bpm ?? 120;
  const signature =
    [...song.signatures].reverse().find((s) => s.ticks <= timeToTick(time, song)) ??
    song.signatures[0];
  const notify = useCallback((text: string, error = false) => {
    clearTimeout(noticeTimer.current);
    setNotice({ text, error });
    noticeTimer.current = setTimeout(() => setNotice(null), error ? 9000 : 4000);
  }, []);
  const updateSettings = useCallback((value: Partial<SceneSettings>) => {
    setSettings((previous) => ({ ...previous, ...value }));
    setSaved(false);
  }, []);
  const pause = useCallback(() => {
    playbackToken.current++;
    if (audio.current?.isPlaying) {
      currentTime.current = audio.current.currentTime;
      setTime(currentTime.current);
    }
    audio.current?.stop();
    setAudioLoading(false);
    setPlaying(false);
  }, []);
  const start = useCallback(
    async (offset: number, playbackRate = rate, source = song) => {
      const token = ++playbackToken.current;
      try {
        setAudioLoading(true);
        audio.current ??= new AudioPlayer();
        await audio.current.prepare(source);
        if (token !== playbackToken.current) return;
        await audio.current.play(source, offset, playbackRate, settings.volume);
        if (token !== playbackToken.current) return;
        setAudioLoading(false);
        setPlaying(true);
      } catch (error) {
        if (token !== playbackToken.current) return;
        setAudioLoading(false);
        setPlaying(false);
        notify(
          error instanceof Error
            ? error.message
            : 'Audio could not start. Try pressing Play again.',
          true,
        );
      }
    },
    [rate, song, settings.volume, notify],
  );
  const togglePlayback = useCallback(() => {
    if (playing || audioLoading) pause();
    else void start(currentTime.current >= song.duration ? 0 : currentTime.current);
  }, [playing, audioLoading, pause, start, song.duration]);
  const seek = useCallback(
    (value: number) => {
      const position = Math.max(0, Math.min(song.duration, value));
      currentTime.current = position;
      setTime(position);
      if (position >= song.duration) {
        pause();
        currentTime.current = position;
        setTime(position);
      } else if (playing || audioLoading) void start(position);
    },
    [playing, audioLoading, start, song.duration, pause],
  );
  useEffect(() => {
    if (!playing) return;
    let frame = 0,
      cancelled = false;
    const tick = () => {
      if (!audio.current) return;
      if (audio.current.error) {
        notify(audio.current.error, true);
        pause();
        return;
      }
      const position = audio.current.currentTime;
      currentTime.current = position;
      setTime(position);
      if (position >= song.duration) {
        if (loop) {
          void start(0).then(() => {
            if (!cancelled) frame = requestAnimationFrame(tick);
          });
          return;
        }
        pause();
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [playing, song.duration, loop, pause, start, notify]);
  useEffect(() => {
    audio.current?.setVolume(settings.volume);
  }, [settings.volume]);
  useEffect(
    () => () => {
      playbackToken.current++;
      audio.current?.dispose();
      clearTimeout(noticeTimer.current);
    },
    [],
  );
  // Pause when a background tab could no longer schedule audio reliably.
  useEffect(() => {
    const visibility = () => {
      if (document.hidden && playing) pause();
    };
    document.addEventListener('visibilitychange', visibility);
    return () => document.removeEventListener('visibilitychange', visibility);
  }, [playing, pause]);
  const loadSong = useCallback(
    (value: Song, newSettings?: SceneSettings) => {
      pause();
      setSong(value);
      setTime(0);
      currentTime.current = 0;
      if (newSettings) setSettings(newSettings);
      setSaved(Boolean(newSettings));
    },
    [pause],
  );
  const save = useCallback(() => {
    const project: Project = { version: 1, song, settings };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `${song.name.replace(/[<>:"/\\|?*]/g, '_')}.watchnotes.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setSaved(true);
    notify('Project saved. Open it any time to keep editing.');
  }, [song, settings, notify]);
  const openFile = useCallback(
    async (file: File) => {
      setLoading(true);
      try {
        if (/\.json$/i.test(file.name)) {
          if (file.size > 30 * 1024 * 1024) throw new Error('Choose a project smaller than 30 MB.');
          const project = parseProject(await file.text());
          loadSong(project.song, project.settings);
          notify(`Opened ${project.song.name}.`);
        } else {
          if (file.size > 10 * 1024 * 1024)
            throw new Error('Choose a MIDI file smaller than 10 MB.');
          const { parseMidi } = await import('@/lib/midi');
          const value = parseMidi(await file.arrayBuffer(), file.name);
          loadSong(value, { ...settings, layout: 'orchestra', musicians: true, focusTrack: '' });
          notify(`Imported ${value.tracks.length} tracks. MIDI notation is an approximation.`);
        }
      } catch (e) {
        notify(e instanceof Error ? e.message : 'Could not open this file.', true);
      } finally {
        setLoading(false);
        if (midiInput.current) midiInput.current.value = '';
        if (projectInput.current) projectInput.current.value = '';
      }
    },
    [loadSong, notify, settings],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (
        dialog ||
        ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(tag) ||
        (e.target as HTMLElement)?.isContentEditable
      )
        return;
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        save();
      } else if (e.code === 'Space') {
        e.preventDefault();
        togglePlayback();
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        seek(currentTime.current + 5);
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        seek(currentTime.current - 5);
      } else if (e.code === 'Home') {
        e.preventDefault();
        seek(0);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog, save, togglePlayback, seek]);
  const changeSong = (next: Song) => {
    setSong(next);
    setSaved(false);
    if (playing || audioLoading) void start(currentTime.current, rate, next);
  };
  const updateTrack = (id: string, patch: Partial<Track>) => {
    const sound =
      patch.program !== undefined ||
      patch.volume !== undefined ||
      patch.enabled !== undefined ||
      patch.solo !== undefined;
    const next = {
      ...song,
      tracks: song.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    };
    if (sound) changeSong(next);
    else {
      setSong(next);
      setSaved(false);
    }
  };
  const moveTrack = (id: string, delta: number) => {
    const tracks = [...song.tracks],
      i = tracks.findIndex((t) => t.id === id),
      j = i + delta;
    if (i < 0 || j < 0 || j >= tracks.length) return;
    [tracks[i], tracks[j]] = [tracks[j], tracks[i]];
    setSong({ ...song, tracks });
    setSaved(false);
  };
  const reset = () => {
    updateSettings({ ...DEFAULT_SETTINGS, volume: settings.volume });
    notify('Scene reset to Ember.');
  };
  return (
    <main
      className="studio"
      onDragOver={(e) => {
        e.preventDefault();
        if (e.dataTransfer.types.includes('Files')) setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const file = e.dataTransfer.files[0];
        if (file && !dialog) void openFile(file);
      }}
    >
      <input
        ref={midiInput}
        type="file"
        accept=".mid,.midi"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void openFile(file);
        }}
      />
      <input
        ref={projectInput}
        type="file"
        accept=".json"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void openFile(file);
        }}
      />
      <header className="topbar">
        <Link className="brand" href="/" aria-label="Watch Notes home">
          <span className="brand-icon">
            <Music2 size={19} />
          </span>
          watch<span className="brand-light">notes</span>
          <span className="beta">STUDIO</span>
        </Link>
        <div className="project-name">
          <span>{song.name}</span>
          <span
            className={`saved-dot ${saved ? '' : 'unsaved'}`}
            title={saved ? 'Project loaded or saved' : 'Unsaved scene changes'}
          />
        </div>
        <div className="top-actions">
          <button
            className="button subtle open-project"
            title="Open a saved .watchnotes.json project"
            onClick={() => projectInput.current?.click()}
          >
            <FolderOpen size={15} />
            <span>Open project</span>
          </button>
          <button
            className="button subtle save-project"
            title="Save project · Ctrl/⌘ S"
            onClick={save}
          >
            <Save size={15} />
            <span>Save</span>
          </button>
          <button
            className="button primary"
            onClick={() => {
              pause();
              setDialog('export');
            }}
          >
            <Download size={15} />
            Export video
          </button>
        </div>
      </header>
      <div className="workspace">
        <aside className={`library ${trackPanel ? 'mobile-open' : ''}`}>
          <div className="section-label">
            YOUR PROJECT{' '}
            <button
              className="mobile-close icon-button"
              aria-label="Close tracks"
              onClick={() => setTrackPanel(false)}
            >
              <X size={14} />
            </button>
            <span>01</span>
          </div>
          <div className="file-card">
            <div className="file-icon">
              <Music2 size={20} />
            </div>
            <div>
              <strong title={song.name}>{song.name}</strong>
              <small title={song.source}>{song.source}</small>
            </div>
            <span className="file-badge">MIDI</span>
          </div>
          <button
            className="import-button"
            disabled={loading}
            onClick={() => midiInput.current?.click()}
          >
            <Upload size={15} />
            {loading ? 'Reading your music…' : 'Import MIDI'}
            <span>＋</span>
          </button>
          <button
            className="demo-button"
            onClick={() => {
              loadSong(createDemo(), { ...DEFAULT_SETTINGS, layout: 'piano', musicians: false });
              notify('Original demo loaded.');
            }}
          >
            Piano demo <RotateCcw size={10} />
          </button>
          <button
            className="demo-button"
            onClick={() => {
              loadSong(createOrchestraDemo(), DEFAULT_SETTINGS);
              notify('The little orchestra is ready. Press Play.');
            }}
          >
            Orchestra demo <Music2 size={10} />
          </button>
          <div className="divider" />
          <div className="section-label">
            TRACKS <span>{song.tracks.length}</span>
          </div>
          <TrackEditor song={song} onChange={updateTrack} onMove={moveTrack} />
          <div className="library-bottom">
            <div className="project-detail">
              <span>Tempo{song.tempos.length > 1 ? ' · variable' : ''}</span>
              <strong>{Math.round(tempo)} BPM</strong>
            </div>
            <div className="project-detail">
              <span>Time signature</span>
              <strong>
                {signature.numerator} / {signature.denominator}
              </strong>
            </div>
            <div className="project-detail">
              <span>Duration</span>
              <strong>{formatTime(song.duration)}</strong>
            </div>
            <div className="local-note">
              <span className="saved-dot" />
              Local processing. No cloud uploads.
            </div>
          </div>
        </aside>
        <section className="main-panel">
          <div className="preview-toolbar">
            <div className="view-tab">
              <Layers size={14} />
              Scene preview
            </div>
            <div className="preview-tags">
              <button
                className="mobile-import"
                onClick={() => midiInput.current?.click()}
                title="Import MIDI"
                aria-label="Import MIDI"
              >
                <Upload size={14} />
              </button>
              <button
                className="mobile-tracks"
                onClick={() => setTrackPanel(true)}
                title="Show tracks"
                aria-label="Show tracks"
              >
                <Layers size={14} />
              </button>
              <span>Perspective</span>
              <span className="ratio-tag">16:9</span>
              <button
                className="icon-button fullscreen-button"
                aria-label="Toggle fullscreen preview"
                title="Fullscreen preview"
                onClick={() => {
                  if (document.fullscreenElement) void document.exitFullscreen();
                  else
                    void viewport.current
                      ?.requestFullscreen()
                      .catch(() => notify('Fullscreen is unavailable in this browser.', true));
                }}
              >
                <Maximize2 size={13} />
              </button>
            </div>
          </div>
          <div className="viewport" ref={viewport}>
            <ScorePreview
              song={song}
              settings={settings}
              time={time}
              onCameraChange={updateSettings}
            />
            <div
              className={`scene-heading${settings.cameraMode === 'cinematic' && settings.layout === 'orchestra' ? ' cinematic-heading' : ''}`}
            >
              <span className="eyebrow">A LITTLE MUSIC, IN A NEW DIMENSION</span>
              <h1>
                {song.name}
                <span>.</span>
              </h1>
              <p>{`${song.tracks.length} parts · ${notes.toLocaleString()} notes`}</p>
            </div>
            <div className="scene-caption">
              <span className="live-dot" style={{ background: THEMES[settings.theme].accent }} />
              {THEMES[settings.theme].name.toUpperCase()} SCENE <span className="caption-line" />
              {audioLoading ? 'LOADING INSTRUMENTS…' : playing ? 'PLAYING' : 'REAL-TIME PREVIEW'}
            </div>
            <div className="camera-hint">
              <Camera size={13} />
              {settings.cameraMode === 'cinematic' && settings.layout === 'orchestra'
                ? 'Cinematic director'
                : 'Drag to orbit'}
            </div>
            {!song.tracks.some((t) => t.enabled) && (
              <div className="empty-track-note">Enable a track to bring your score back.</div>
            )}
          </div>
          <div className="transport">
            <div className="transport-buttons">
              <button
                className="icon-button"
                aria-label="Restart"
                title="Back to start · Home"
                onClick={() => seek(0)}
              >
                <SkipBack size={17} />
              </button>
              <button
                className="play-button"
                aria-label={playing ? 'Pause' : 'Play'}
                title="Play / pause · Space"
                onClick={togglePlayback}
              >
                {playing ? (
                  <Pause size={17} fill="currentColor" />
                ) : (
                  <Play size={19} fill="currentColor" />
                )}
              </button>
              <button
                className={`icon-button ${loop ? 'active' : ''}`}
                aria-label="Loop playback"
                title="Loop playback"
                aria-pressed={loop}
                onClick={() => setLoop(!loop)}
              >
                <Repeat2 size={17} />
              </button>
            </div>
            <div className="time-readout">
              <b>{formatTime(time)}</b>
              <span>/ {formatTime(song.duration)}</span>
            </div>
            <div className="transport-right">
              <select
                className="speed-select"
                aria-label="Playback speed"
                value={rate}
                onChange={(e) => {
                  const value = +e.target.value;
                  setRate(value);
                  if (playing) void start(currentTime.current, value);
                }}
              >
                {[0.5, 0.75, 1, 1.25, 1.5, 2].map((v) => (
                  <option key={v} value={v}>
                    {v}×
                  </option>
                ))}
              </select>
              <button
                className="icon-button volume-button"
                aria-label={settings.volume ? 'Mute audio' : 'Unmute audio'}
                onClick={() => updateSettings({ volume: settings.volume ? 0 : 0.65 })}
              >
                {settings.volume ? <Volume2 size={16} /> : <VolumeX size={16} />}
              </button>
              <input
                className="volume-slider"
                type="range"
                aria-label="Volume"
                min="0"
                max="1"
                step=".01"
                value={settings.volume}
                onChange={(e) => updateSettings({ volume: +e.target.value })}
              />
              <button
                className="shortcut-button"
                title="Keyboard shortcuts and help"
                onClick={() => setDialog('help')}
              >
                <span className="keyboard-hint">space</span>
                <span>to play</span>
              </button>
            </div>
          </div>
          <Timeline song={song} time={time} onSeek={seek} disabled={dialog === 'export'} />
        </section>
        <aside className="inspector">
          <div className="inspector-heading">
            <SlidersHorizontal size={16} />
            <strong>Scene settings</strong>
            <button
              className="icon-button reset-button"
              aria-label="Reset scene settings"
              title="Reset scene"
              onClick={reset}
            >
              <RotateCcw size={13} />
            </button>
          </div>
          <div className="settings-section orchestra-settings">
            <div className="settings-title">
              <Layers size={14} />
              ORCHESTRA
            </div>
            <label className="field-label" htmlFor="score-layout">
              Score layout
            </label>
            <select
              id="score-layout"
              className="preset-select"
              value={settings.layout}
              onChange={(e) =>
                updateSettings({
                  layout: e.target.value as SceneSettings['layout'],
                  ...(e.target.value === 'piano' ? { cameraMode: 'static' as const } : {}),
                })
              }
            >
              <option value="orchestra">Staves by instrument</option>
              <option value="piano">Combined piano score</option>
            </select>
            <label className="field-label" htmlFor="audio-mode">
              Sound
            </label>
            <select
              id="audio-mode"
              className="preset-select"
              value={song.audioMode ?? 'soft-keys'}
              onChange={(e) =>
                changeSong({ ...song, audioMode: e.target.value as Song['audioMode'] })
              }
            >
              <option value="orchestra">Sampled orchestra</option>
              <option value="soft-keys">Soft keys</option>
            </select>
            <Toggle
              label="Miniature musicians"
              value={settings.musicians}
              onChange={() => updateSettings({ musicians: !settings.musicians })}
            />
            {settings.layout === 'orchestra' && (
              <>
                <Slider
                  label="Space between parts"
                  value={settings.staffGap}
                  min={4}
                  max={12}
                  step={0.5}
                  onChange={(staffGap) => updateSettings({ staffGap })}
                />
                <label className="field-label" htmlFor="focus-part">
                  Focus part
                </label>
                <select
                  id="focus-part"
                  className="preset-select"
                  value={settings.focusTrack}
                  disabled={settings.cameraMode === 'cinematic'}
                  onChange={(e) => updateSettings({ focusTrack: e.target.value })}
                >
                  <option value="">All parts</option>
                  {song.tracks.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                <p className="orchestra-hint">
                  {settings.cameraMode === 'cinematic'
                    ? 'Use Feature this track in Camera to choose a cinematic subject. All audible parts keep playing.'
                    : 'Focus changes the view. Use Solo to hear one part. Select a track to edit its musician.'}
                </p>
              </>
            )}
          </div>
          <div className="settings-section">
            <div className="settings-title">
              <Sparkles size={14} />
              APPEARANCE
            </div>
            <label className="field-label" htmlFor="scene-preset">
              Scene preset
            </label>
            <div className={`preset-preview preset-${settings.theme}`}>
              <span>𝅘𝅥</span>
              <span>𝅘𝅥</span>
              <span>𝅘𝅥</span>
            </div>
            <select
              id="scene-preset"
              className="preset-select"
              value={settings.theme}
              onChange={(e) => updateSettings({ theme: e.target.value as SceneSettings['theme'] })}
            >
              {Object.entries(THEMES).map(([id, t]) => (
                <option key={id} value={id}>
                  {t.name}{' '}
                  {id === 'ember'
                    ? '· Warm & cinematic'
                    : id === 'moonlight'
                      ? '· Cool & luminous'
                      : '· Soft & organic'}
                </option>
              ))}
            </select>
            <div className="field-label">
              Note color{' '}
              <span className="color-value">
                {settings.theme === 'ember'
                  ? 'Warm gold'
                  : settings.theme === 'moonlight'
                    ? 'Glacier blue'
                    : 'Soft green'}
                <i style={{ background: THEMES[settings.theme].accent }} />
              </span>
            </div>
            <Slider
              label="Glow intensity"
              min={0}
              max={2.5}
              step={0.05}
              value={settings.glow}
              onChange={(glow) => updateSettings({ glow })}
            />
          </div>
          <div className="settings-section">
            <div className="settings-title">
              <Camera size={14} />
              CAMERA
            </div>
            <label className="field-label" htmlFor="camera-mode">
              Camera mode
            </label>
            <select
              id="camera-mode"
              className="preset-select"
              value={settings.cameraMode ?? DEFAULT_SETTINGS.cameraMode}
              onChange={(e) =>
                updateSettings(
                  e.target.value === 'cinematic'
                    ? {
                        cameraMode: 'cinematic',
                        layout: 'orchestra',
                        musicians: true,
                        focusTrack: '',
                      }
                    : { cameraMode: 'static' },
                )
              }
            >
              <option value="static">Static · manual camera</option>
              <option value="cinematic">Cinematic Orchestra</option>
            </select>
            {settings.cameraMode === 'cinematic' && settings.layout === 'orchestra' ? (
              <>
                <p className="orchestra-hint">
                  Solo, section and wide shots follow the music. Nearby moves glide; distant moves
                  cut. The same camera edit is included in your video.
                </p>
                <label className="field-label" htmlFor="camera-pacing">
                  Pacing
                </label>
                <select
                  id="camera-pacing"
                  className="preset-select"
                  value={settings.cameraPacing ?? DEFAULT_SETTINGS.cameraPacing}
                  onChange={(e) =>
                    updateSettings({
                      cameraPacing: e.target.value as SceneSettings['cameraPacing'],
                    })
                  }
                >
                  <option value="calm">Calm · 6–10 second shots</option>
                  <option value="balanced">Balanced · 4–8 second shots</option>
                  <option value="energetic">Energetic · 3–5 second shots</option>
                </select>
                <label className="field-label" htmlFor="camera-track">
                  Feature this track
                </label>
                <select
                  id="camera-track"
                  className="preset-select"
                  value={
                    song.tracks.some(
                      (t) =>
                        t.id === settings.cameraTrack &&
                        t.enabled &&
                        (!song.tracks.some((s) => s.enabled && s.solo) || t.solo),
                    )
                      ? settings.cameraTrack
                      : ''
                  }
                  onChange={(e) => updateSettings({ cameraTrack: e.target.value })}
                >
                  <option value="">Automatic director</option>
                  {song.tracks
                    .filter(
                      (t) => t.enabled && (!song.tracks.some((s) => s.enabled && s.solo) || t.solo),
                    )
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                </select>
                <p className="orchestra-hint">
                  Selecting a track keeps the camera on that part without muting the orchestra.
                  Choose Automatic director to resume shot selection.
                </p>
              </>
            ) : (
              <>
                <Slider
                  label="Elevation"
                  min={18}
                  max={88}
                  value={settings.angle}
                  suffix="°"
                  onChange={(angle) => updateSettings({ angle })}
                />
                <Slider
                  label="Zoom"
                  min={0.6}
                  max={1.8}
                  step={0.05}
                  value={settings.zoom}
                  suffix="×"
                  onChange={(zoom) => updateSettings({ zoom })}
                />
                <Toggle
                  label="Follow the music"
                  value={settings.follow}
                  onChange={() => updateSettings({ follow: !settings.follow })}
                />
              </>
            )}
          </div>
          <div className="settings-section lights-section">
            <div className="settings-title">
              <Sparkles size={14} />
              NOTE LIGHTS
            </div>
            <Toggle
              label="Flying lights"
              value={settings.flyingLights ?? DEFAULT_SETTINGS.flyingLights}
              onChange={() =>
                updateSettings({
                  flyingLights: !(settings.flyingLights ?? DEFAULT_SETTINGS.flyingLights),
                })
              }
            />
            <p className="setting-hint">Glowing trails that arrive with the next note.</p>
            <fieldset
              className="light-controls"
              disabled={!(settings.flyingLights ?? DEFAULT_SETTINGS.flyingLights)}
            >
              <legend className="sr-only">Flying light appearance</legend>
              <Slider
                label="Light brightness"
                min={0.2}
                max={2.5}
                step={0.05}
                value={settings.flightIntensity ?? DEFAULT_SETTINGS.flightIntensity}
                onChange={(flightIntensity) => updateSettings({ flightIntensity })}
              />
              <Slider
                label="Trail length"
                min={0.15}
                max={1.5}
                step={0.05}
                suffix=" s"
                value={settings.flightTail ?? DEFAULT_SETTINGS.flightTail}
                onChange={(flightTail) => updateSettings({ flightTail })}
              />
              <Slider
                label="Arc height"
                min={0.2}
                max={2.5}
                step={0.1}
                suffix="×"
                value={settings.flightArc ?? DEFAULT_SETTINGS.flightArc}
                onChange={(flightArc) => updateSettings({ flightArc })}
              />
            </fieldset>
          </div>
          <div className="settings-section details-section">
            <div className="settings-title">
              <Layers size={14} />
              DETAILS
            </div>
            <Slider
              label="Note spacing"
              min={1.2}
              max={MAX_NOTE_SPACING}
              step={0.1}
              value={settings.spacing}
              suffix="×"
              onChange={(spacing) => updateSettings({ spacing })}
            />
            <Toggle
              label="Duration trails"
              value={settings.trails}
              onChange={() => updateSettings({ trails: !settings.trails })}
            />
            <Toggle
              label="Ground grid"
              value={settings.grid}
              onChange={() => updateSettings({ grid: !settings.grid })}
            />
          </div>
          <div className="inspector-note">
            Made to move with your music.
            <br />
            Make this scene your own.
          </div>
        </aside>
      </div>
      <footer className="statusbar">
        <span>
          <span className={`saved-dot ${saved ? '' : 'unsaved'}`} />
          {saved ? 'LOCAL WORKSPACE' : 'UNSAVED SCENE CHANGES'}
        </span>
        <span>
          {notes.toLocaleString()} notes · {song.tracks.length} tracks · {bars.length} bars
          <span className="footer-separator">/</span>Soft keys synth
        </span>
        <button className="footer-help" onClick={() => setDialog('help')}>
          WATCH NOTES <span className="version">v0.1</span>
          <Info size={10} />
        </button>
      </footer>
      {dragging && (
        <div className="drop-overlay">
          <FileMusic size={45} />
          <h2>Give your music a new dimension.</h2>
          <p>Drop a MIDI file or Watch Notes project here.</p>
        </div>
      )}
      {notice && (
        <div
          className={`toast ${notice.error ? 'error' : ''}`}
          role={notice.error ? 'alert' : 'status'}
        >
          {notice.error ? <Info size={16} /> : <Check size={16} />}
          <span>{notice.text}</span>
          <button aria-label="Dismiss notification" onClick={() => setNotice(null)}>
            <X size={14} />
          </button>
        </div>
      )}
      {dialog === 'export' && (
        <ExportDialog
          project={{ version: 1, song, settings }}
          rate={rate}
          onClose={() => setDialog(null)}
        />
      )}{' '}
      {dialog === 'help' && (
        <Dialog title="A little help" onClose={() => setDialog(null)}>
          <p className="dialog-description">
            Bring in a MIDI, shape the scene, and give your music a new dimension.
          </p>
          <div className="help-content">
            <h3>
              <Keyboard size={15} />
              Keyboard shortcuts
            </h3>
            <div>
              <span>Play / pause</span>
              <kbd>Space</kbd>
            </div>
            <div>
              <span>Seek backward / forward</span>
              <kbd>← / →</kbd>
            </div>
            <div>
              <span>Back to the beginning</span>
              <kbd>Home</kbd>
            </div>
            <div>
              <span>Save project</span>
              <kbd>Ctrl / ⌘ S</kbd>
            </div>
            <h3>Working with your music</h3>
            <p>
              Drop a .mid or .midi file anywhere. Mute tracks to hide them from the scene and audio.
              Drag the preview to orbit the camera.
            </p>
            <p>
              Flying lights connect successive notes within each track and staff, arriving on the
              next onset. Adjust their brightness, trail length, and arc height under Note lights.
              The effect follows seeking and playback speed, and is included in video exports.
            </p>
            <p>
              Save downloads an editable .watchnotes.json file containing your notes and scene
              settings. Open project restores it. Keep a saved copy before refreshing.
            </p>
            <p>
              Sampled instruments use GeneralUser GS by S. Christian Collins.{' '}
              <a href="/sounds/LICENSE-GeneralUser-GS.txt" target="_blank" rel="noreferrer">
                Sound bank license
              </a>
              .
            </p>
            <h3>Sound and notation</h3>
            <p>
              MIDI gives us pitch and timing; notation is an approximation. Orchestra mode gives
              each part its own staves and a performer. Piano and keyboard parts use paired treble
              and bass staves. Sampled sounds follow instrument programs, sustain, expression and
              pitch bend. Performer gestures approximate playing technique. Duration trails are
              visual guides, not musical ties. Notes are shown at concert pitch; detailed engraving
              and exact fingering are not inferred.
            </p>
            <p>
              Video export includes the 3D scene, without the editor controls or preview title. The
              Node export service must be running alongside the app.
            </p>
          </div>
        </Dialog>
      )}
    </main>
  );
}
