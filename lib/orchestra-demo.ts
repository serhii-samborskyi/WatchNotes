import { createDemo, type Song, type Note } from './project';
export function createOrchestraDemo(): Song {
  const base = createDemo(),
    beat = 60 / 96;
  const notes = (pitches: number[], step: number, duration: number, prefix: string): Note[] =>
    Array.from({ length: Math.floor(32 / step) }, (_, i) => ({
      id: `${prefix}-${i}`,
      midi: pitches[i % pitches.length],
      time: i * step * beat,
      duration: duration * beat,
      velocity: 0.55 + (i % 3) * 0.1,
      ticks: i * step * 480,
      durationTicks: duration * 480,
    }));
  return {
    ...base,
    name: 'The little orchestra',
    source: 'Original quartet · built-in demo',
    duration: 32 * beat + 2,
    tempos: [{ ticks: 0, bpm: 96, time: 0 }],
    audioMode: 'orchestra',
    tracks: [
      {
        id: 'piano',
        name: 'Piano',
        instrument: 'Grand piano',
        program: 0,
        channel: 0,
        color: '#e6b675',
        enabled: true,
        percussion: false,
        notes: notes([48, 55, 60, 64, 45, 52, 57, 60], 0.5, 0.8, 'p'),
      },
      {
        id: 'violin',
        name: 'Violin',
        instrument: 'Violin',
        program: 40,
        channel: 1,
        color: '#bd97b7',
        enabled: true,
        percussion: false,
        notes: notes([72, 76, 79, 77, 76, 74, 72, 71], 2, 1.8, 'v'),
      },
      {
        id: 'flute',
        name: 'Flute',
        instrument: 'Flute',
        program: 73,
        channel: 2,
        color: '#8bab9a',
        enabled: true,
        percussion: false,
        notes: notes([84, 83, 79, 81, 79, 76, 74, 76], 1, 0.6, 'f').filter((_, i) => i % 8 < 6),
      },
      {
        id: 'drums',
        name: 'Percussion',
        instrument: 'Percussion kit',
        program: 0,
        channel: 9,
        color: '#91a7ca',
        enabled: true,
        percussion: true,
        notes: notes([36, 42, 38, 42], 0.5, 0.12, 'd'),
      },
    ],
  };
}
