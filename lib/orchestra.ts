import { staffPosition, type Note, type SceneSettings, type Song, type Track } from './project';

export const INSTRUMENTS = [
  { program: 0, name: 'Grand piano', kind: 'piano' },
  { program: 40, name: 'Violin', kind: 'violin' },
  { program: 41, name: 'Viola', kind: 'violin' },
  { program: 42, name: 'Cello', kind: 'cello' },
  { program: 43, name: 'Double bass', kind: 'cello' },
  { program: 48, name: 'String ensemble', kind: 'violin' },
  { program: 73, name: 'Flute', kind: 'flute' },
  { program: 71, name: 'Clarinet', kind: 'flute' },
  { program: 68, name: 'Oboe', kind: 'flute' },
  { program: 70, name: 'Bassoon', kind: 'flute' },
  { program: 56, name: 'Trumpet', kind: 'trumpet' },
  { program: 60, name: 'French horn', kind: 'trumpet' },
  { program: 57, name: 'Trombone', kind: 'trumpet' },
  { program: 46, name: 'Harp', kind: 'piano' },
  { program: 47, name: 'Timpani', kind: 'drums' },
  { program: 0, name: 'Percussion kit', kind: 'drums', percussion: true },
] as const;
export type MusicianKind = Exclude<NonNullable<Track['musician']>['kind'], 'auto' | undefined>;
export const DEFAULT_MUSICIAN_SCALE = 2.2;
export const MAX_MUSICIAN_SCALE = 4;
// Set the whole orchestra farther behind the playhead to leave room for the flying-note trails.
export const MUSICIAN_X = -11.5;
export const GRAND_STAFF_GAP = 4.4;
export function usesGrandStaff(track: Track) {
  if (track.percussion) return false;
  if (track.program === undefined)
    return /piano|keyboard|\bkeys\b|organ|clavi|harpsichord|celesta|synth/i.test(track.instrument);
  const p = track.program;
  return p <= 8 || (p >= 16 && p <= 21) || p === 23 || (p >= 80 && p <= 103);
}
export function trackProgram(track: Track) {
  if (track.program !== undefined) return track.program;
  const name = track.instrument.toLowerCase();
  return INSTRUMENTS.find((i) => name.includes(i.name.toLowerCase()))?.program ?? 0;
}
export function musicianKind(track: Track): MusicianKind {
  if (track.musician?.kind && track.musician.kind !== 'auto') return track.musician.kind;
  if (track.percussion) return 'drums';
  const program = trackProgram(track);
  if (program === 47) return 'drums';
  if (program === 42 || program === 43 || (program >= 32 && program <= 39)) return 'cello';
  if (program >= 40 && program <= 55) return 'violin';
  if (program >= 56 && program <= 63) return 'trumpet';
  if (program >= 64 && program <= 79) return 'flute';
  return 'piano';
}
export function audibleTracks(song: Song): Track[] {
  const solo = song.tracks.some((t) => t.enabled && t.solo);
  return song.tracks.filter((t) => t.enabled && (!solo || t.solo));
}
export type StaffLane = {
  id: string;
  track: Track;
  center: number;
  partCenter: number;
  grandStaff: boolean;
  clef: 'treble' | 'bass' | 'percussion';
};
export function scoreLanes(song: Song, settings: SceneSettings): StaffLane[] {
  const all = audibleTracks(song);
  const focused = all.filter((t) => t.id === settings.focusTrack);
  const lanes: StaffLane[] = [];
  let top = 0;
  for (const track of focused.length ? focused : all) {
    const grandStaff = settings.layout === 'orchestra' && usesGrandStaff(track);
    const partCenter = top - (grandStaff ? GRAND_STAFF_GAP / 2 : 0);
    if (grandStaff) {
      for (const [index, clef] of (['treble', 'bass'] as const).entries())
        lanes.push({
          id: JSON.stringify([track.id, clef]),
          track,
          center: top - index * GRAND_STAFF_GAP,
          partCenter,
          grandStaff,
          clef,
        });
      top -= GRAND_STAFF_GAP;
    } else {
      const clef = track.percussion
        ? 'percussion'
        : track.notes.length &&
            track.notes.reduce((sum, n) => sum + n.midi, 0) / track.notes.length < 58
          ? 'bass'
          : 'treble';
      lanes.push({
        id: JSON.stringify([track.id, clef]),
        track,
        center: top,
        partCenter,
        grandStaff,
        clef,
      });
    }
    top -= settings.staffGap;
  }
  const midpoint = (lanes.at(-1)?.center ?? 0) / 2;
  return lanes.map((lane) => ({
    ...lane,
    center: lane.center - midpoint,
    partCenter: lane.partCenter - midpoint,
  }));
}
/** One performer per musical part even when that part has two staves. */
export function partLanes(lanes: StaffLane[]) {
  return lanes.filter(
    (lane, index) => lanes.findIndex((l) => l.track.id === lane.track.id) === index,
  );
}
export function noteLane(midi: number, trackId: string, lanes: StaffLane[]) {
  return lanes.find(
    (l) => l.track.id === trackId && (!l.grandStaff || l.clef === (midi >= 60 ? 'treble' : 'bass')),
  );
}
export function lanePosition(midi: number, lane: StaffLane) {
  if (lane.clef === 'percussion')
    return { staff: 0, y: lane.center + ((midi % 5) - 2) * 0.26, accidental: false };
  const steps = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6];
  const step = (Math.floor(midi / 12) - 1) * 7 + steps[midi % 12];
  return {
    staff: lane.grandStaff && lane.clef === 'bass' ? 1 : 0,
    y: lane.center + (step - (lane.clef === 'bass' ? 22 : 34)) * 0.26,
    accidental: [1, 3, 6, 8, 10].includes(midi % 12),
  };
}
export function scorePosition(
  midi: number,
  trackId: string,
  lanes: StaffLane[],
  layout: SceneSettings['layout'],
) {
  const lane = noteLane(midi, trackId, lanes);
  return layout === 'orchestra' && lane ? lanePosition(midi, lane) : staffPosition(midi);
}

export type Gesture = {
  energy: number;
  stroke: number;
  strike: number;
  pitch: number;
  keys: number[];
  active: boolean;
};
/** Index built once per performer; queries depend only on song time, never frame history. */
export class Performance {
  readonly notes: Note[];
  private maxEnd: number[] = [];
  constructor(notes: Note[]) {
    this.notes = [...notes].sort((a, b) => a.time - b.time || a.midi - b.midi);
    let max = 0;
    this.maxEnd = this.notes.map((n) => (max = Math.max(max, n.time + n.duration)));
  }
  at(time: number): Gesture {
    let lo = 0,
      hi = this.notes.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.notes[mid].time <= time + 0.15) lo = mid + 1;
      else hi = mid;
    }
    let energy = 0,
      strike = 0,
      stroke = 0,
      pitch = 60,
      latest = -Infinity;
    const keys: number[] = [];
    for (let i = lo - 1; i >= 0; i--) {
      if (this.maxEnd[i] + 0.3 < time) break;
      const n = this.notes[i],
        age = time - n.time,
        remaining = n.time + n.duration - time;
      if (age >= -0.15 && age < 0.22) {
        const hit = age < 0 ? 1 - Math.abs(age) / 0.15 : Math.exp(-age * 18);
        strike = Math.max(strike, hit);
      }
      if (age < 0 || remaining < -0.3) continue;
      const power =
        n.velocity *
        Math.min(1, Math.max(0, age / 0.04)) *
        Math.min(1, Math.max(0, 1 + remaining / 0.3));
      energy = Math.max(energy, power);
      if (remaining > 0) keys.push(n.midi);
      if (n.time > latest) {
        latest = n.time;
        pitch = n.midi;
        stroke = Math.sin((age / Math.max(0.25, Math.min(n.duration, 1.4))) * Math.PI * 2);
      }
    }
    return { energy, strike, stroke, pitch, keys, active: keys.length > 0 };
  }
}
