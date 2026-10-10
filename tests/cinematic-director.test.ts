import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CinematicDirector } from '../lib/cinematic-director';
import { createDemo, DEFAULT_SETTINGS, getBars, type Song } from '../lib/project';
import { MUSICIAN_X, scoreLanes } from '../lib/orchestra';
import { parseProject } from '../lib/validation';
import { activeNoteFlights, buildNoteFlights } from '../lib/note-flights';

const settings = { ...DEFAULT_SETTINGS, cameraMode: 'cinematic' as const };
function orchestra(count = 29, duration = 60): Song {
  const base = createDemo();
  return {
    ...base,
    duration,
    tempos: [{ ticks: 0, time: 0, bpm: 120 }],
    tracks: Array.from({ length: count }, (_, i) => ({
      ...base.tracks[0],
      id: `part-${String(i).padStart(2, '0')}`,
      name: `Part ${i + 1}`,
      program: i === 0 ? 0 : 40,
      notes: Array.from({ length: duration }, (_, j) => ({
        id: `${i}-${j}`,
        midi: i === 0 && j % 2 ? 48 : 72,
        time: j,
        duration: 0.9,
        velocity: 0.7,
        ticks: j * 960,
        durationTicks: 864,
      })),
    })),
  };
}
test('a 29-part edit has readable shots, bounded pacing, bar-aligned changes and varied subjects', () => {
  const song = orchestra();
  const bars = getBars(song).map((bar) => bar.time);
  for (const cameraPacing of ['calm', 'balanced', 'energetic'] as const) {
    const s = { ...settings, cameraPacing };
    const director = new CinematicDirector(song, s, scoreLanes(song, s));
    assert.equal(director.shots[0].start, 0);
    assert.notEqual(
      director.shots[0].type,
      'wide',
      'Enabling cinematic mode should immediately improve readability',
    );
    assert.equal(director.shots.at(-1)?.end, song.duration);
    const range =
      cameraPacing === 'calm' ? [6, 10] : cameraPacing === 'balanced' ? [4, 8] : [3, 5.5];
    for (const [i, shot] of director.shots.entries()) {
      assert.ok(bars.includes(shot.start));
      if (i) assert.equal(shot.start, director.shots[i - 1].end);
      if (shot.end !== song.duration) assert.ok(shot.end - shot.start >= range[0]);
      assert.ok(shot.end - shot.start <= range[1]);
      if (shot.type !== 'wide') assert.ok(shot.trackIds.length <= 3);
    }
    assert.ok(director.shots.some((shot) => shot.type === 'section'));
    assert.ok(director.shots.some((shot) => shot.type === 'wide'));
    assert.ok(new Set(director.shots.map((shot) => shot.leadId).filter(Boolean)).size >= 4);
  }
});
test('entrances choose sounding parts, with glides nearby and cuts across distant sections', () => {
  const song = orchestra(12, 18);
  song.tracks.forEach((track, i) => {
    const start = i === 0 ? 0 : i === 1 ? 6 : i === 11 ? 12 : -1;
    track.notes = start < 0 ? [] : [{ ...track.notes[0], time: start, duration: 6 }];
  });
  const director = new CinematicDirector(song, settings, scoreLanes(song, settings));
  assert.deepEqual(
    director.shots.map((shot) => shot.leadId),
    ['part-00', 'part-01', 'part-11'],
  );
  assert.equal(director.shots[1].transition, 'glide');
  assert.equal(director.shots[2].transition, 'cut');
  const before = director.at(6 - 1e-7),
    after = director.at(6);
  assert.ok(before.position.distanceTo(after.position) < 1e-4);
  assert.ok(before.target.distanceTo(after.target) < 1e-4);
});
test('manual featuring preserves both piano staves and all audio assignments', () => {
  const song = orchestra();
  const original = JSON.stringify(song);
  const s = { ...settings, cameraTrack: 'part-00' };
  const lanes = scoreLanes(song, s);
  const director = new CinematicDirector(song, s, lanes);
  assert.ok(director.shots.every((shot) => shot.type === 'solo' && shot.leadId === 'part-00'));
  for (const aspect of [16 / 9, 1, 9 / 16]) {
    const frame = director.at(3, aspect);
    const camera = new THREE.PerspectiveCamera(36, aspect, 0.1, 1500);
    camera.position.copy(frame.position);
    camera.lookAt(frame.target);
    camera.updateMatrixWorld();
    const centers = lanes.filter((lane) => lane.track.id === 'part-00').map((lane) => lane.center);
    assert.equal(centers.length, 2);
    for (const center of centers) {
      for (const x of [-2, 8]) {
        const point = new THREE.Vector3(3 * s.spacing + x, 0, -center).project(camera);
        assert.ok(Math.abs(point.x) < 1 && Math.abs(point.y) < 1, 'Both staves must fit');
      }
    }
    const performer = new THREE.Vector3(
      3 * s.spacing + MUSICIAN_X,
      5,
      -lanes[0].partCenter,
    ).project(camera);
    assert.ok(
      Math.abs(performer.x) < 1 && Math.abs(performer.y) < 1,
      'The performer must fit beside the score',
    );
  }
  assert.equal(JSON.stringify(song), original);
});
test('seeks and independently planned export chunks reproduce the exact same camera', () => {
  const song = orchestra();
  const first = new CinematicDirector(song, settings, scoreLanes(song, settings));
  const second = new CinematicDirector(song, settings, scoreLanes(song, settings));
  assert.deepEqual(first.shots, second.shots);
  for (const time of [0, 0.5, 6, 6.4, 17.3, 42, 59.9, 60]) {
    const expected = first.at(time);
    first.at(50);
    first.at(0);
    assert.deepEqual(first.at(time), expected);
    assert.deepEqual(second.at(time), expected);
    assert.ok(expected.position.toArray().every(Number.isFinite));
    assert.ok(expected.target.toArray().every(Number.isFinite));
  }
});
test('muted and silent parts do not steal automatic shots, and empty scenes stay finite', () => {
  const song = orchestra(4);
  song.tracks[0].enabled = false;
  song.tracks[1].volume = 0;
  song.tracks[2].solo = true;
  const s = { ...settings, cameraTrack: song.tracks[0].id };
  const director = new CinematicDirector(song, s, scoreLanes(song, s));
  assert.ok(director.shots.every((shot) => shot.leadId === song.tracks[2].id));
  song.tracks.forEach((track) => {
    track.enabled = false;
  });
  const empty = new CinematicDirector(song, s, scoreLanes(song, s)).at(4);
  assert.ok(empty.position.toArray().every(Number.isFinite));
  assert.deepEqual(empty.labels, []);
});
test('cinematic settings round-trip and existing projects keep a static camera', () => {
  const song = orchestra(3);
  const s = { ...settings, cameraPacing: 'calm', cameraTrack: 'part-00' };
  const saved = parseProject(JSON.stringify({ version: 1, song, settings: s }));
  assert.deepEqual(saved.settings, s);
  const old = Object.fromEntries(Object.entries(s).filter(([key]) => !key.startsWith('camera')));
  const loaded = parseProject(JSON.stringify({ version: 1, song, settings: old }));
  assert.equal(loaded.settings.cameraMode, 'static');
  assert.equal(loaded.settings.cameraPacing, 'balanced');
  assert.equal(loaded.settings.cameraTrack, '');
});
test('featured note lights are selected before the light pool limit is applied', () => {
  const song = orchestra();
  const flights = buildNoteFlights(song, settings);
  const featured = new Set([song.tracks[0].id]);
  const lights = activeNoteFlights(flights, 0.5, 1, featured);
  assert.equal(lights.length, 1);
  assert.equal(lights[0].trackId, song.tracks[0].id);
});
