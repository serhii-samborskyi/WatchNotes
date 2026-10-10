export type Note = {
  id: string;
  midi: number;
  time: number;
  duration: number;
  velocity: number;
  ticks: number;
  durationTicks: number;
};
export type Track = {
  id: string;
  name: string;
  instrument: string;
  color: string;
  enabled: boolean;
  percussion: boolean;
  notes: Note[];
  program?: number;
  channel?: number;
  volume?: number;
  solo?: boolean;
  controls?: { time: number; number: number; value: number }[];
  pitchBends?: { time: number; value: number }[];
  musician?: {
    kind?: 'auto' | 'piano' | 'violin' | 'cello' | 'flute' | 'trumpet' | 'drums';
    visible?: boolean;
    scale?: number;
    x?: number;
    y?: number;
    groupWith?: string;
  };
};
export type Tempo = { ticks: number; bpm: number; time: number };
export type Song = {
  name: string;
  source: string;
  duration: number;
  ppq: number;
  tempos: Tempo[];
  signatures: { ticks: number; numerator: number; denominator: number }[];
  tracks: Track[];
  audioMode?: 'soft-keys' | 'orchestra';
};
export type SceneSettings = {
  theme: 'ember' | 'moonlight' | 'sage';
  angle: number;
  azimuth: number;
  zoom: number;
  spacing: number;
  glow: number;
  trails: boolean;
  flyingLights: boolean;
  flightIntensity: number;
  flightTail: number;
  flightArc: number;
  grid: boolean;
  follow: boolean;
  noteScale: number;
  volume: number;
  layout: 'piano' | 'orchestra';
  musicians: boolean;
  staffGap: number;
  focusTrack: string;
  cameraMode: 'static' | 'cinematic';
  cameraPacing: 'calm' | 'balanced' | 'energetic';
  cameraTrack: string;
};
export type Project = { version: 1; song: Song; settings: SceneSettings };
export const MAX_NOTE_SPACING = 20;
export const DEFAULT_SETTINGS: SceneSettings = {
  theme: 'ember',
  angle: 48,
  azimuth: -8,
  zoom: 1,
  spacing: 5,
  glow: 0.1,
  trails: true,
  flyingLights: true,
  flightIntensity: 1,
  flightTail: 0.65,
  flightArc: 1,
  grid: true,
  follow: true,
  noteScale: 1,
  volume: 0.65,
  layout: 'orchestra',
  musicians: true,
  staffGap: 5.5,
  focusTrack: '',
  cameraMode: 'static',
  cameraPacing: 'balanced',
  cameraTrack: '',
};
export const THEMES = {
  ember: {
    name: 'Ember',
    accent: '#ffd391',
    background: '#101313',
    note: '#abb3ae',
    trail: '#d99750',
  },
  moonlight: {
    name: 'Moonlight',
    accent: '#b9ceff',
    background: '#0d111c',
    note: '#9caabe',
    trail: '#7099e8',
  },
  sage: {
    name: 'Sage',
    accent: '#b7ebc6',
    background: '#0c1613',
    note: '#9daea4',
    trail: '#64b98a',
  },
};
export const TRACK_COLORS = ['#e6b675', '#8bab9a', '#91a7ca', '#bd97b7', '#d39483', '#9aa1d0'];
export function createDemo(): Song {
  const ppq = 480,
    beat = 60 / 84;
  const melody = [76, 79, 83, 81, 79, 76, 74, 71, 72, 76, 79, 78, 76, 74, 72, 71];
  const chords = [
    [48, 55, 60],
    [45, 52, 57],
    [41, 48, 53],
    [43, 50, 55],
  ];
  const right: Note[] = [],
    left: Note[] = [];
  for (let bar = 0; bar < 16; bar++) {
    for (let i = 0; i < 8; i++) {
      const b = bar * 4 + i * 0.5;
      right.push({
        id: `r-${bar}-${i}`,
        midi: melody[(bar * 3 + i) % melody.length] - (bar > 7 ? 12 : 0),
        time: b * beat,
        duration: beat * (i === 7 ? 0.9 : 0.46),
        ticks: b * ppq,
        durationTicks: i === 7 ? 480 : 240,
        velocity: 0.55 + (i % 3) * 0.12,
      });
    }
    chords[bar % 4].forEach((midi, i) =>
      left.push({
        id: `l-${bar}-${i}`,
        midi,
        time: bar * 4 * beat,
        duration: beat * 3.7,
        ticks: bar * 4 * ppq,
        durationTicks: ppq * 4,
        velocity: 0.46,
      }),
    );
  }
  return {
    name: 'First light',
    source: 'Original piano study · built-in demo',
    duration: 64 * beat + 1.5,
    ppq,
    tempos: [{ ticks: 0, time: 0, bpm: 84 }],
    signatures: [{ ticks: 0, numerator: 4, denominator: 4 }],
    tracks: [
      {
        id: 'right',
        name: 'Piano · right hand',
        instrument: 'Acoustic grand piano',
        color: TRACK_COLORS[0],
        enabled: true,
        percussion: false,
        notes: right,
      },
      {
        id: 'left',
        name: 'Piano · left hand',
        instrument: 'Acoustic grand piano',
        color: TRACK_COLORS[1],
        enabled: true,
        percussion: false,
        notes: left,
      },
    ],
  };
}
export function formatTime(seconds: number) {
  const s = Math.max(0, seconds);
  return `${Math.floor(s / 60)
    .toString()
    .padStart(2, '0')}:${Math.floor(s % 60)
    .toString()
    .padStart(2, '0')}`;
}
export function tickToTime(ticks: number, song: Song) {
  const t = [...song.tempos].reverse().find((t) => t.ticks <= ticks) ?? song.tempos[0];
  return t.time + (((ticks - t.ticks) / song.ppq) * 60) / t.bpm;
}
export function timeToTick(time: number, song: Song) {
  const t = [...song.tempos].reverse().find((t) => t.time <= time) ?? song.tempos[0];
  return t.ticks + ((time - t.time) * song.ppq * t.bpm) / 60;
}
export function getBars(song: Song): { time: number; number: number }[] {
  const bars: { time: number; number: number }[] = [];
  let tick = 0,
    number = 1;
  while (tickToTime(tick, song) <= song.duration && number < 10000) {
    bars.push({ time: tickToTime(tick, song), number: number++ });
    const signature = [...song.signatures].reverse().find((s) => s.ticks <= tick) ?? {
      numerator: 4,
      denominator: 4,
    };
    const next = song.signatures.find((s) => s.ticks > tick);
    tick = Math.min(
      tick + (signature.numerator * song.ppq * 4) / signature.denominator,
      next?.ticks ?? Infinity,
    );
  }
  return bars;
}
export function staffPosition(midi: number): { staff: number; y: number; accidental: boolean } {
  const pitch = midi % 12,
    octave = Math.floor(midi / 12) - 1;
  const steps = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6];
  const staff = midi >= 60 ? 0 : 1;
  const step = octave * 7 + steps[pitch];
  return {
    staff,
    y: (staff === 0 ? 2.26 : -4.34) + (step - (staff === 0 ? 30 : 18)) * 0.26,
    accidental: [1, 3, 6, 8, 10].includes(pitch),
  };
}
