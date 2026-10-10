import { Midi } from '@tonejs/midi/dist/Midi.js';
import { DEFAULT_SETTINGS, TRACK_COLORS, type Song } from './project';
import { projectSchema } from './validation';
import { parseMidi as readMidi } from 'midi-file';
export function parseMidi(buffer: ArrayBuffer, filename: string): Song {
  if (buffer.byteLength > 10 * 1024 * 1024)
    throw new Error('Choose a MIDI file smaller than 10 MB.');
  if (buffer.byteLength < 14 || new TextDecoder().decode(new Uint8Array(buffer, 0, 4)) !== 'MThd')
    throw new Error('This is not a Standard MIDI file. Choose a .mid or .midi file.');
  const midi = new Midi(buffer);
  midi.header.update();
  // Controllers may be on an empty track or precede a program split.
  const controls: NonNullable<Song['tracks'][number]['controls']>[] = Array.from(
    { length: 16 },
    () => [],
  );
  const bends: NonNullable<Song['tracks'][number]['pitchBends']>[] = Array.from(
    { length: 16 },
    () => [],
  );
  for (const rawTrack of readMidi(new Uint8Array(buffer)).tracks) {
    let ticks = 0;
    for (const event of rawTrack) {
      ticks += event.deltaTime;
      const time = midi.header.ticksToSeconds(ticks);
      if (event.type === 'controller')
        controls[event.channel].push({
          time,
          number: event.controllerType,
          value: event.value / 127,
        });
      if (event.type === 'pitchBend')
        bends[event.channel].push({ time, value: event.value / 8192 });
    }
  }
  const tracks = midi.tracks
    .filter((track) => track.notes.length)
    .map((track, index) => ({
      id: `track-${index}`,
      name: track.name?.trim() || `Track ${index + 1}`,
      instrument: track.instrument.name || 'Instrument',
      color: TRACK_COLORS[index % TRACK_COLORS.length],
      enabled: true,
      percussion: track.instrument.percussion,
      program: track.instrument.number,
      channel: track.channel,
      controls: controls[track.channel].sort((a, b) => a.time - b.time),
      pitchBends: bends[track.channel].sort((a, b) => a.time - b.time),
      notes: track.notes
        .map((n, i) => ({
          id: `${index}-${i}`,
          midi: n.midi,
          time: n.time,
          duration: Math.max(0.025, n.duration),
          velocity: n.velocity,
          ticks: n.ticks,
          durationTicks: Math.max(1, n.durationTicks),
        }))
        .sort((a, b) => a.time - b.time),
    }));
  if (!tracks.length) throw new Error('This MIDI file contains no notes.');
  const noteCount = tracks.reduce((s, t) => s + t.notes.length, 0);
  if (noteCount > 60000 || tracks.length > 64)
    throw new Error('This version supports up to 60,000 notes across 64 tracks.');
  const duration =
    Math.max(
      ...tracks.map((t) => t.notes.reduce((max, n) => Math.max(max, n.time + n.duration), 0)),
    ) + 1.5;
  if (duration > 3600) throw new Error('This version supports pieces up to one hour long.');
  const tempos = midi.header.tempos.map((t) => ({
    ticks: t.ticks,
    bpm: t.bpm,
    time: t.time ?? midi.header.ticksToSeconds(t.ticks),
  }));
  if (!tempos.length || tempos[0].ticks > 0) tempos.unshift({ ticks: 0, time: 0, bpm: 120 });
  const signatures = midi.header.timeSignatures.map((s) => ({
    ticks: s.ticks,
    numerator: s.timeSignature[0],
    denominator: s.timeSignature[1],
  }));
  if (!signatures.length || signatures[0].ticks > 0)
    signatures.unshift({ ticks: 0, numerator: 4, denominator: 4 });
  const song = {
    name: midi.name?.trim() || filename.replace(/\.midi?$/i, ''),
    source: filename,
    duration,
    ppq: midi.header.ppq,
    tempos,
    signatures,
    tracks,
    audioMode: 'orchestra',
  };
  const parsed = projectSchema.safeParse({ version: 1, song, settings: DEFAULT_SETTINGS });
  if (!parsed.success) throw new Error(`Unsupported MIDI data: ${parsed.error.issues[0].message}`);
  return parsed.data.song;
}
