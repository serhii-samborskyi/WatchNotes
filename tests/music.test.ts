import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Midi } from '@tonejs/midi/dist/Midi.js';
import {
  createDemo,
  DEFAULT_SETTINGS,
  getBars,
  tickToTime,
  timeToTick,
  staffPosition,
} from '../lib/project.js';
import { parseProject, exportRequestSchema } from '../lib/validation.js';
import { parseMidi } from '../lib/midi.js';
test('MIDI tempo changes preserve note start and duration across the tempo boundary', () => {
  const midi = new Midi();
  midi.header.tempos = [
    { ticks: 0, bpm: 120 },
    { ticks: 480, bpm: 60 },
  ];
  midi.header.update();
  const track = midi.addTrack();
  track.name = 'Test piano';
  track.addNote({ midi: 60, ticks: 240, durationTicks: 720, velocity: 0.8 });
  const data = midi.toArray();
  const song = parseMidi(data.buffer as ArrayBuffer, 'tempo.mid');
  assert.equal(song.tracks[0].notes[0].time, 0.25);
  assert.equal(song.tracks[0].notes[0].duration, 1.25);
  assert.equal(song.tempos.length, 2);
  assert.equal(tickToTime(960, song), 1.5);
  assert.equal(timeToTick(1.5, song), 960);
});
test('bar positions respect tempo and time signature changes', () => {
  const song = createDemo();
  song.duration = 12;
  song.tempos = [
    { ticks: 0, time: 0, bpm: 120 },
    { ticks: 1920, time: 2, bpm: 60 },
  ];
  song.signatures = [
    { ticks: 0, numerator: 4, denominator: 4 },
    { ticks: 1920, numerator: 3, denominator: 4 },
  ];
  assert.deepEqual(getBars(song).slice(0, 4), [
    { time: 0, number: 1 },
    { time: 2, number: 2 },
    { time: 5, number: 3 },
    { time: 8, number: 4 },
  ]);
});
test('pitches use diatonic staff positions and preserve sharps', () => {
  assert.equal(staffPosition(64).y, 2.26);
  assert.ok(Math.abs(staffPosition(65).y - staffPosition(64).y - 0.26) < 1e-10);
  assert.equal(staffPosition(61).y, staffPosition(60).y);
  assert.equal(staffPosition(61).accidental, true);
  assert.equal(staffPosition(43).y, -4.34);
});
test('saved projects round-trip all notes and scene settings', () => {
  const project = {
    version: 1,
    song: createDemo(),
    settings: { ...DEFAULT_SETTINGS, theme: 'sage', angle: 65 },
  };
  assert.deepEqual(parseProject(JSON.stringify(project)), project);
});
test('invalid project versions, duplicate IDs, malformed timing and non-finite scene values are rejected', () => {
  const project = { version: 1, song: createDemo(), settings: { ...DEFAULT_SETTINGS } };
  assert.throws(() => parseProject('{bad'));
  assert.throws(() => parseProject(JSON.stringify({ ...project, version: 7 })));
  project.song.tracks[0].notes[1].id = project.song.tracks[0].notes[0].id;
  assert.throws(() => parseProject(JSON.stringify(project)), /unique/);
  project.song = createDemo();
  project.song.tempos.push({ ticks: 480, time: 50, bpm: 90 });
  assert.throws(() => parseProject(JSON.stringify(project)), /tempo/i);
  project.song = createDemo();
  project.settings.zoom = NaN;
  assert.throws(() => parseProject(JSON.stringify(project)));
});
test('empty and non-MIDI files fail with useful errors', () => {
  assert.throws(() => parseMidi(new ArrayBuffer(0), 'empty.mid'), /MIDI/);
  const midi = new Midi();
  assert.throws(() => parseMidi(midi.toArray().buffer as ArrayBuffer, 'empty.mid'), /no notes/);
});
test('export config rejects mismatched resolution and excessive duration', () => {
  const value = { width: 1280, height: 720, fps: 30, frames: 300, name: 'Test', audio: true };
  assert.equal(exportRequestSchema.safeParse(value).success, true);
  assert.equal(exportRequestSchema.safeParse({ ...value, height: 1080 }).success, false);
  assert.equal(exportRequestSchema.safeParse({ ...value, frames: 18001 }).success, false);
});
