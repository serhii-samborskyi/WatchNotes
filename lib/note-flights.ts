import { staffPosition, type Note, type Song, type SceneSettings } from './project';
import { audibleTracks, scoreLanes, scorePosition } from './orchestra';

export const MAX_FLIGHT_SECONDS = 8;
export const ARRIVAL_FADE_SECONDS = 0.24;
const CHORD_TOLERANCE_SECONDS = 0.015;

export type NoteFlight = {
  id: string;
  trackId: string;
  from: Note;
  to: Note;
  start: number;
  end: number;
  fromY: number;
  toY: number;
};
export type FlightPoint = { x: number; y: number; z: number };

/** Connect successive onsets independently within each track and staff. */
export function buildNoteFlights(song: Song, settings?: SceneSettings): NoteFlight[] {
  const lanes = settings ? scoreLanes(song, settings) : [];
  const orchestra = settings?.layout === 'orchestra';
  const flights: NoteFlight[] = [];
  for (const track of audibleTracks(song)) {
    if (orchestra && !lanes.some((l) => l.track.id === track.id)) continue;
    const split = !orchestra || lanes.some((l) => l.track.id === track.id && l.grandStaff);
    for (const staff of split ? [0, 1] : [0]) {
      const notes = track.notes
        .filter((note) => !split || staffPosition(note.midi).staff === staff)
        .sort((a, b) => a.time - b.time || a.midi - b.midi || a.id.localeCompare(b.id));
      const groups: Note[][] = [];
      for (const note of notes) {
        const last = groups.at(-1);
        if (last && note.time - last[0].time <= CHORD_TOLERANCE_SECONDS) last.push(note);
        else groups.push([note]);
      }
      for (let i = 1; i < groups.length; i++) {
        const sources = [...groups[i - 1]].sort((a, b) => a.midi - b.midi);
        const targets = [...groups[i]].sort((a, b) => a.midi - b.midi);
        // Pair chord tones in pitch order to avoid crossing ribbons. A larger
        // chord can fan out from the preceding notes; a melody uses its nearest voice.
        targets.forEach((to, index) => {
          const from =
            targets.length === 1
              ? sources.reduce((nearest, note) =>
                  Math.abs(note.midi - to.midi) < Math.abs(nearest.midi - to.midi) ? note : nearest,
                )
              : sources[Math.round((index * (sources.length - 1)) / (targets.length - 1))];
          const duration = to.time - from.time;
          // Long rests should stay quiet, rather than sending lights across the entire score.
          if (duration <= CHORD_TOLERANCE_SECONDS || duration > MAX_FLIGHT_SECONDS) return;
          flights.push({
            id: JSON.stringify([track.id, from.id, to.id]),
            trackId: track.id,
            from,
            to,
            start: from.time,
            end: to.time,
            fromY: scorePosition(from.midi, track.id, lanes, settings?.layout ?? 'piano').y,
            toY: scorePosition(to.midi, track.id, lanes, settings?.layout ?? 'piano').y,
          });
        });
      }
    }
  }
  return flights.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}

/** Absolute-time selection works equally for live playback, scrubbing, and export. */
export function activeNoteFlights(
  flights: NoteFlight[],
  time: number,
  limit = 48,
  tracks?: ReadonlySet<string>,
): NoteFlight[] {
  if (limit <= 0 || !Number.isFinite(time)) return [];
  let left = 0;
  let right = flights.length;
  while (left < right) {
    const mid = (left + right) >>> 1;
    if (flights[mid].start <= time) left = mid + 1;
    else right = mid;
  }
  const active: NoteFlight[] = [];
  for (let i = left - 1; i >= 0; i--) {
    const flight = flights[i];
    if (time - flight.start > MAX_FLIGHT_SECONDS + ARRIVAL_FADE_SECONDS) break;
    if (tracks && !tracks.has(flight.trackId)) continue;
    if (time < flight.end + ARRIVAL_FADE_SECONDS) {
      active.push(flight);
      if (active.length === limit) break;
    }
  }
  return active;
}

/** XY follows the sheet; Z lifts the light above it before landing on the next note. */
export function flightPoint(
  flight: NoteFlight,
  progress: number,
  spacing: number,
  arcHeight: number,
  out: FlightPoint = { x: 0, y: 0, z: 0 },
): FlightPoint {
  const u = Math.max(0, Math.min(1, progress));
  const bow = 4 * u * (1 - u);
  const span = (flight.end - flight.start) * spacing;
  out.x = (flight.start + (flight.end - flight.start) * u) * spacing;
  out.y = flight.fromY + (flight.toY - flight.fromY) * u + bow * arcHeight * 0.22;
  out.z = 0.16 + bow * arcHeight * Math.min(1.8, 0.5 + span * 0.13);
  return out;
}

export function flightFade(flight: NoteFlight, time: number): number {
  if (time < flight.start) return 0;
  return Math.max(0, 1 - Math.max(0, time - flight.end) / ARRIVAL_FADE_SECONDS);
}
