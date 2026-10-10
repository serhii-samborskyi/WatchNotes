import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { FlyingLights } from '../lib/flying-lights.js';
import {
  activeNoteFlights,
  ARRIVAL_FADE_SECONDS,
  buildNoteFlights,
  flightPoint,
} from '../lib/note-flights.js';
import {
  createDemo,
  DEFAULT_SETTINGS,
  staffPosition,
  type Note,
  type Song,
} from '../lib/project.js';
import { parseProject } from '../lib/validation.js';

function note(id: string, midi: number, time: number): Note {
  return { id, midi, time, duration: 0.8, velocity: 0.8, ticks: time * 480, durationTicks: 384 };
}
function songWith(notes: Note[]): Song {
  const song = createDemo();
  song.tracks = [{ ...song.tracks[0], notes }];
  return song;
}

test('chord tones have parallel paths within their own track and staff', () => {
  const song = songWith([
    note('high-a', 76, 0),
    note('low-a', 64, 0),
    note('high-b', 79, 2),
    note('low-b', 67, 2),
    note('bass-a', 43, 0),
    note('bass-b', 48, 2),
  ]);
  song.tracks.push({ ...song.tracks[0], id: 'muted', enabled: false });
  const original = JSON.stringify(song);
  const flights = buildNoteFlights(song);
  assert.equal(flights.length, 3);
  assert.deepEqual(
    flights.map((f) => [f.from.midi, f.to.midi]).sort((a, b) => a[0] - b[0]),
    [
      [43, 48],
      [64, 67],
      [76, 79],
    ],
  );
  assert.ok(flights.every((f) => f.end > f.start && f.trackId === 'right'));
  assert.equal(JSON.stringify(song), original, 'building paths must not mutate imported notes');
});

test('lights fan out into a larger chord and a melody continues from the nearest voice', () => {
  const song = songWith([note('a', 64, 0), note('b', 67, 1), note('c', 72, 1), note('d', 74, 2)]);
  const flights = buildNoteFlights(song);
  assert.deepEqual(
    flights.map((f) => [f.from.id, f.to.id]),
    [
      ['a', 'b'],
      ['a', 'c'],
      ['c', 'd'],
    ],
  );
});

test('paths depart and arrive at exact note positions and lift above the sheet in between', () => {
  const [flight] = buildNoteFlights(songWith([note('a', 64, 1), note('b', 72, 3.5)]));
  const start = flightPoint(flight, 0, 2.7, 1);
  const end = flightPoint(flight, 1, 2.7, 1);
  assert.deepEqual(start, { x: 2.7, y: staffPosition(64).y, z: 0.16 });
  assert.deepEqual(end, { x: 3.5 * 2.7, y: staffPosition(72).y, z: 0.16 });
  assert.ok(flightPoint(flight, 0.5, 2.7, 1).z > 1);
  assert.deepEqual(flightPoint(flight, -2, 2.7, 1), start);
  assert.deepEqual(flightPoint(flight, 2, 2.7, 1), end);
});

test('absolute-time selection respects onset, arrival fade, long rests, and the pool limit', () => {
  const song = songWith([note('a', 64, 0), note('b', 67, 2), note('c', 72, 20)]);
  const flights = buildNoteFlights(song);
  assert.equal(flights.length, 1, 'long rests do not get connecting flights');
  assert.equal(activeNoteFlights(flights, -0.1).length, 0);
  assert.equal(activeNoteFlights(flights, 0).length, 1);
  assert.equal(activeNoteFlights(flights, 2.1).length, 1);
  assert.equal(activeNoteFlights(flights, 2 + ARRIVAL_FADE_SECONDS).length, 0);
  assert.equal(activeNoteFlights(flights, 1, 0).length, 0);
  const demo = buildNoteFlights(createDemo());
  assert.ok(activeNoteFlights(demo, 2, 2).length <= 2);
});

function geometrySnapshot(effect: FlyingLights) {
  return effect.group.children
    .filter((child) => child instanceof THREE.Group && child.visible)
    .map((group) =>
      group.children.map((child) => ({
        position: child.position.toArray(),
        rotation: child.quaternion.toArray(),
        scale: child.scale.toArray(),
        vertices:
          child instanceof THREE.Mesh || child instanceof THREE.Line
            ? Array.from(child.geometry.getAttribute('position').array)
            : null,
        colors:
          child instanceof THREE.Mesh && child.geometry.getAttribute('color')
            ? Array.from(child.geometry.getAttribute('color').array)
            : null,
      })),
    );
}

test('preview, backward scrubbing, and direct export produce identical comet geometry', () => {
  const song = createDemo();
  const preview = new FlyingLights();
  const exported = new FlyingLights();
  try {
    preview.setSong(song);
    exported.setSong(song);
    for (let frame = 0; frame <= 30; frame++) preview.render(frame / 30, DEFAULT_SETTINGS);
    const expected = geometrySnapshot(preview);
    assert.ok(expected.length > 0);
    preview.render(13, DEFAULT_SETTINGS);
    preview.render(1, DEFAULT_SETTINGS);
    assert.deepEqual(geometrySnapshot(preview), expected);
    exported.render(1, DEFAULT_SETTINGS);
    assert.deepEqual(geometrySnapshot(exported), expected);
    for (const visual of expected)
      for (const child of visual) {
        assert.ok(child.vertices?.every(Number.isFinite) ?? true);
      }
  } finally {
    preview.dispose();
    exported.dispose();
  }
});

test('disabling lights or muting tracks removes comets and their illumination', () => {
  const effect = new FlyingLights();
  try {
    const song = createDemo();
    effect.setSong(song);
    effect.render(1, DEFAULT_SETTINGS);
    assert.ok(geometrySnapshot(effect).length > 0);
    effect.render(1, { ...DEFAULT_SETTINGS, flyingLights: false });
    assert.equal(effect.group.visible, false);
    assert.ok(
      effect.group.children
        .filter((c) => c instanceof THREE.PointLight)
        .every((c) => (c as THREE.PointLight).intensity === 0),
    );
    effect.setSong({ ...song, tracks: song.tracks.map((t) => ({ ...t, enabled: false })) });
    effect.render(1, DEFAULT_SETTINGS);
    assert.equal(geometrySnapshot(effect).length, 0);
  } finally {
    effect.dispose();
  }
});

test('old projects receive defaults; new light settings survive saving and reject bad values', () => {
  const settings = { ...DEFAULT_SETTINGS } as Partial<typeof DEFAULT_SETTINGS>;
  delete settings.flyingLights;
  delete settings.flightIntensity;
  delete settings.flightTail;
  delete settings.flightArc;
  const legacy = parseProject(JSON.stringify({ version: 1, song: createDemo(), settings }));
  assert.deepEqual(legacy.settings, DEFAULT_SETTINGS);
  const updated = {
    ...legacy,
    settings: {
      ...legacy.settings,
      flyingLights: false,
      flightTail: 1.2,
      flightIntensity: 1.8,
      flightArc: 2,
    },
  };
  assert.deepEqual(parseProject(JSON.stringify(updated)), updated);
  assert.throws(() =>
    parseProject(JSON.stringify({ ...updated, settings: { ...updated.settings, flightTail: -1 } })),
  );
});
