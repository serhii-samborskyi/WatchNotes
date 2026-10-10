import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Midi } from '@tonejs/midi/dist/Midi.js';
import * as THREE from 'three';
import { parseMidi as readRaw, writeMidi } from 'midi-file';
import { createOrchestraDemo } from '../lib/orchestra-demo';
import { createDemo, DEFAULT_SETTINGS } from '../lib/project';
import {
  audibleTracks,
  musicianKind,
  scoreLanes,
  lanePosition,
  Performance,
  usesGrandStaff,
  noteLane,
  scorePosition,
  partLanes,
  DEFAULT_MUSICIAN_SCALE,
  MAX_MUSICIAN_SCALE,
  MUSICIAN_X,
} from '../lib/orchestra';
import { OrchestraSynth, performanceEvents } from '../lib/orchestra-synth';
import { parseProject } from '../lib/validation';
import { parseMidi } from '../lib/midi';
import { buildNoteFlights } from '../lib/note-flights';
import {
  Musicians,
  STAGE_SURFACE_HEIGHT,
  STAGE_WHEEL_RADIUS,
  STAGE_GROUND_CLEARANCE,
} from '../lib/musicians';

test('orchestra imports preserve instruments, channels, percussion and expression', () => {
  const midi = new Midi();
  for (const [channel, program] of [
    [0, 0],
    [1, 40],
    [2, 73],
    [9, 0],
  ]) {
    const t = midi.addTrack();
    t.channel = channel;
    t.instrument.number = program;
    t.addNote({ midi: channel === 9 ? 38 : 72, time: 0, duration: 1, velocity: 0.7 });
    t.addCC({ number: 64, time: 0.2, value: 1 });
    t.addCC({ number: 11, time: 0.3, value: 0.5 });
    t.addPitchBend({ time: 0.4, value: 0.5 });
  }
  // Tone's encoder writes a normalized bend directly as an integer; use a real MIDI bend fixture.
  const raw = readRaw(midi.toArray());
  for (const track of raw.tracks)
    for (const event of track) if (event.type === 'pitchBend') event.value = 4096;
  const song = parseMidi(Uint8Array.from(writeMidi(raw)).buffer, 'orchestra.mid');
  assert.equal(song.audioMode, 'orchestra');
  assert.equal(song.tracks.length, 4);
  assert.deepEqual(
    song.tracks.map((t) => t.program),
    [0, 40, 73, 0],
  );
  assert.deepEqual(
    song.tracks.map((t) => t.channel),
    [0, 1, 2, 9],
  );
  assert.equal(song.tracks[3].percussion, true);
  assert.equal(song.tracks[1].controls?.[0].number, 64);
  assert.equal(song.tracks[1].pitchBends?.[0].value, 0.5);
});
test('separate staves, focus, solo and flights agree on track placement', () => {
  const song = createOrchestraDemo(),
    lanes = scoreLanes(song, DEFAULT_SETTINGS);
  assert.equal(lanes.length, 5);
  assert.equal(new Set(lanes.map((l) => l.center)).size, 5);
  assert.equal(new Set(lanes.map((l) => l.id)).size, 5);
  assert.equal(partLanes(lanes).length, 4);
  const note = song.tracks[1].notes[0];
  const flights = buildNoteFlights(song, DEFAULT_SETTINGS);
  const flight = flights.find((f) => f.from.id === note.id)!;
  assert.equal(
    flight.fromY,
    lanePosition(note.midi, noteLane(note.midi, song.tracks[1].id, lanes)!).y,
  );
  const focused = scoreLanes(song, { ...DEFAULT_SETTINGS, focusTrack: 'flute' });
  assert.equal(focused.length, 1);
  assert.equal(focused[0].center, 0);
  assert.equal(audibleTracks(song).length, 4, 'Visual focus must not mute other parts');
  song.tracks[1].solo = true;
  assert.deepEqual(
    audibleTracks(song).map((t) => t.id),
    ['violin'],
  );
  assert.equal(scoreLanes(song, DEFAULT_SETTINGS).length, 1);
});
test('musician gestures are seekable, anticipate strikes, follow their own notes and rest', () => {
  const song = createOrchestraDemo();
  const n = { ...song.tracks[1].notes[0], time: 1, duration: 0.5 };
  const violin = new Performance([n]),
    silent = new Performance([]);
  const pose = violin.at(1.2);
  assert.ok(pose.energy > 0);
  assert.equal(pose.pitch, n.midi);
  assert.equal(silent.at(1.2).energy, 0);
  assert.ok(violin.at(0.95).strike > 0);
  assert.equal(violin.at(0.95).active, false);
  assert.equal(violin.at(2).energy, 0);
  assert.equal(violin.at(0.5).energy, 0);
  violin.at(15);
  violin.at(0);
  assert.deepEqual(violin.at(1.2), pose);
  assert.deepEqual(song.tracks.map(musicianKind), ['piano', 'violin', 'flute', 'drums']);
});
test('orchestra projects round-trip performer edits and older projects retain their sound and layout', () => {
  const song = createOrchestraDemo();
  song.tracks[1].musician = { kind: 'violin', scale: 1.4, x: 2, y: -1, visible: true };
  song.tracks[0].volume = 0.6;
  const project = { version: 1, song, settings: DEFAULT_SETTINGS };
  assert.deepEqual(parseProject(JSON.stringify(project)), project);
  const oldSettings = Object.fromEntries(
    Object.entries(DEFAULT_SETTINGS).filter(
      ([key]) => !['layout', 'musicians', 'staffGap', 'focusTrack'].includes(key),
    ),
  );
  const old = parseProject(
    JSON.stringify({ version: 1, song: createDemo(), settings: oldSettings }),
  );
  assert.equal(old.settings.layout, 'piano');
  assert.equal(old.settings.musicians, false);
  assert.equal(old.song.audioMode, undefined);
});
test('clip scheduling restores sustain and controllers, scales time without transposing', () => {
  const t = createOrchestraDemo().tracks[0];
  t.notes = [{ ...t.notes[0], time: 0.2, duration: 0.2 }];
  t.controls = [
    { time: 0.1, number: 64, value: 1 },
    { time: 1.5, number: 64, value: 0 },
    { time: 0, number: 11, value: 0.5 },
    { time: 1, number: 11, value: 0.8 },
  ];
  const e = performanceEvents([t], 1, 2, 2, 44100);
  assert.ok(e.some((e) => e.type === 'on' && e.sample === 0 && e.a === t.notes[0].midi));
  assert.ok(e.some((e) => e.type === 'cc' && e.a === 64 && e.b === 0 && e.sample === 11025));
  const atStart = e.filter((e) => e.sample === 0 && e.type === 'cc' && e.a === 11);
  assert.equal(atStart.at(-1)?.b, Math.round(0.8 * 127));
});
test('sampled voices are distinct, muted tracks silent, and rendering is independent of chunk boundaries', async () => {
  const bytes = await readFile('public/sounds/GeneralUser-GS.sf2');
  const bank = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const render = async (program: number, chunk: number, volume = 1) => {
    const song = createOrchestraDemo();
    song.tracks = [
      {
        ...song.tracks[0],
        program,
        volume,
        notes: [{ ...song.tracks[0].notes[0], midi: 69, time: 0.1, duration: 0.5, velocity: 0.75 }],
      },
    ];
    const s = await OrchestraSynth.create(song, bank, 0, 1, 1);
    const samples: number[] = [];
    try {
      for (;;) {
        const b = s.read(chunk);
        samples.push(...b.left);
        if (b.done) break;
      }
    } finally {
      s.dispose();
    }
    return samples;
  };
  const piano = await render(0, 128),
    flute = await render(73, 128),
    violin = await render(40, 128);
  const rms = (a: number[]) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
  assert.ok(rms(piano) > 0.001);
  assert.ok(rms(flute) > 0.001);
  assert.ok(rms(violin) > 0.001);
  assert.ok(rms(piano.map((v, i) => v - flute[i])) > 0.001);
  assert.ok(rms(violin.map((v, i) => v - flute[i])) > 0.001);
  assert.equal(rms(await render(0, 128, 0)), 0);
  const large = await render(0, 16384);
  assert.equal(large.length, 44100);
  // Engine envelope quanta are the same regardless of requested output batching.
  const error = rms(large.map((v, i) => v - piano[i]));
  assert.ok(error < 1e-7, `Chunk boundaries changed the sound: ${error}`);
});

test('miniature meshes seek deterministically, share performers and follow the playhead', () => {
  const song = createOrchestraDemo(),
    players = new Musicians();
  for (const [id, program] of [
    ['cello', 42],
    ['trumpet', 56],
  ] as const)
    song.tracks.push({ ...song.tracks[1], id, name: id, program });
  const snapshot = () => {
    const out: number[] = [];
    players.group.updateMatrixWorld(true);
    players.group.traverse((o) => out.push(...o.matrixWorld.elements));
    return out;
  };
  try {
    players.setLanes(scoreLanes(song, DEFAULT_SETTINGS));
    assert.equal(
      players.group.children.filter((child) => child.name.startsWith('musician:')).length,
      6,
    );
    players.render(0.4, 10, DEFAULT_SETTINGS);
    const pose = snapshot();
    assert.ok(pose.every(Number.isFinite), 'All six instrument poses must have finite transforms');
    players.render(3, 30, DEFAULT_SETTINGS);
    assert.notDeepEqual(snapshot(), pose);
    players.render(0.4, 10, DEFAULT_SETTINGS);
    assert.deepEqual(snapshot(), pose);
    assert.equal(players.group.children[0].position.x, 10 + MUSICIAN_X);
    assert.equal(players.group.children[0].scale.x, DEFAULT_MUSICIAN_SCALE);
    assert.equal(
      players.group.children[0].position.y,
      scoreLanes(song, DEFAULT_SETTINGS)[0].partCenter,
    );
    players.render(0.4, 10, { ...DEFAULT_SETTINGS, musicians: false });
    assert.equal(players.group.visible, false);
    song.tracks[1].musician = { groupWith: 'piano' };
    players.setLanes(scoreLanes(song, DEFAULT_SETTINGS));
    assert.equal(
      players.group.children.filter((child) => child.name.startsWith('musician:')).length,
      5,
    );
  } finally {
    players.dispose();
  }
});

test('keyboard parts have a linked grand staff without duplicating notes or crossing flight paths', () => {
  const song = createOrchestraDemo(),
    piano = song.tracks[0];
  piano.notes = [48, 72, 50, 74].map((midi, i) => ({
    ...piano.notes[0],
    id: `pair-${i}`,
    midi,
    time: Math.floor(i / 2),
    duration: 0.6,
  }));
  const lanes = scoreLanes(song, DEFAULT_SETTINGS),
    staves = lanes.filter((l) => l.track.id === piano.id);
  assert.deepEqual(
    staves.map((l) => l.clef),
    ['treble', 'bass'],
  );
  assert.equal(staves[0].partCenter, staves[1].partCenter);
  for (const n of piano.notes) {
    const lane = noteLane(n.midi, piano.id, lanes)!;
    assert.equal(lane.clef, n.midi >= 60 ? 'treble' : 'bass');
    assert.equal(
      scorePosition(n.midi, piano.id, lanes, 'orchestra').y,
      lanePosition(n.midi, lane).y,
    );
  }
  assert.equal(noteLane(60, piano.id, lanes)?.clef, 'treble');
  assert.equal(noteLane(59, piano.id, lanes)?.clef, 'bass');
  const flights = buildNoteFlights(song, DEFAULT_SETTINGS).filter((f) => f.trackId === piano.id);
  assert.equal(flights.length, 2);
  for (const f of flights) assert.equal(f.from.midi < 60, f.to.midi < 60);
  const focused = scoreLanes(song, { ...DEFAULT_SETTINGS, focusTrack: piano.id });
  assert.equal(focused.length, 2);
  assert.equal(focused[0].partCenter, 0);
  assert.equal(focused[0].center, -focused[1].center);
  const violin = lanes.find((l) => l.track.id === 'violin')!;
  assert.ok(Math.abs(staves[1].center - violin.center - DEFAULT_SETTINGS.staffGap) < 1e-9);
  piano.enabled = false;
  assert.equal(scoreLanes(song, DEFAULT_SETTINGS).length, 3);
});
test('one level platform carries every performer and rolls deterministically with traveled distance', () => {
  const song = createOrchestraDemo();
  for (const [id, program] of [
    ['cello', 42],
    ['trumpet', 56],
  ] as const)
    song.tracks.push({ ...song.tracks[1], id, name: id, program });
  const players = new Musicians();
  const sheet = new THREE.Group();
  sheet.rotation.x = -Math.PI / 2;
  sheet.add(players.group);
  const near = (actual: number, expected: number) =>
    assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
  try {
    for (const scale of [0.4, DEFAULT_MUSICIAN_SCALE, MAX_MUSICIAN_SCALE]) {
      song.tracks.forEach((track, i) => {
        track.musician = {
          scale: i % 2 ? DEFAULT_MUSICIAN_SCALE : scale,
          x: i === 1 ? -1.5 : 0,
          y: i === 2 ? 0.75 : 0,
        };
      });
      players.setLanes(scoreLanes(song, DEFAULT_SETTINGS));
      const travel = 1.25;
      players.render(0.4, travel, DEFAULT_SETTINGS);
      sheet.updateMatrixWorld(true);
      const stages = players.group.children.filter((child) => child.name === 'rolling-stage');
      assert.equal(stages.length, 1);
      const stage = stages[0];
      const bounds = new THREE.Box3().setFromObject(stage);
      const roots = players.group.children.filter((child) => child.name.startsWith('musician:'));
      for (const root of roots) {
        assert.equal(root.getObjectByName('rolling-stage'), undefined);
        const performer = root.getObjectByName('performer')!;
        const origin = performer.getWorldPosition(new THREE.Vector3());
        const forward = new THREE.Vector3(0, 0, 1).transformDirection(performer.matrixWorld);
        near(forward.x, 1);
        near(forward.y, 0);
        near(forward.z, 0);
        near(origin.y, STAGE_SURFACE_HEIGHT);
        const head = root.getObjectByName('head')!;
        assert.ok(new THREE.Vector3(0, 0, 1).transformDirection(head.matrixWorld).x > 0.95);
        const footprint = new THREE.Box3().setFromObject(performer);
        assert.ok(
          bounds.min.x <= footprint.min.x && bounds.max.x >= footprint.max.x,
          `${root.name}: platform must support the full instrument front to back`,
        );
        assert.ok(
          bounds.min.z <= footprint.min.z && bounds.max.z >= footprint.max.z,
          `${root.name}: platform must support the full instrument across the staves`,
        );
      }
      const wheels = stage.children.filter((child) => child.name.startsWith('stage-wheel:'));
      assert.ok(wheels.length >= 4);
      for (const wheel of wheels) {
        near(
          wheel.getWorldPosition(new THREE.Vector3()).y -
            STAGE_WHEEL_RADIUS * DEFAULT_MUSICIAN_SCALE,
          STAGE_GROUND_CLEARANCE,
        );
        near(wheel.rotation.x * STAGE_WHEEL_RADIUS * DEFAULT_MUSICIAN_SCALE, travel);
      }
      const root = roots[0];
      const wheel = wheels[0];
      const angle = wheel.rotation.x;
      const frame = root.matrixWorld.clone();
      const stageFrame = stage.matrixWorld.clone();
      players.render(1, travel + 1, DEFAULT_SETTINGS);
      assert.ok(wheel.rotation.x > angle);
      players.render(0.4, travel, DEFAULT_SETTINGS);
      sheet.updateMatrixWorld(true);
      near(wheel.rotation.x, angle);
      assert.deepEqual(stage.matrixWorld.elements, stageFrame.elements);
      assert.deepEqual(
        root.matrixWorld.elements,
        frame.elements,
        'Seeking must restore the stage pose',
      );
      players.render(2, travel, DEFAULT_SETTINGS);
      near(wheel.rotation.x, angle);
    }
  } finally {
    players.dispose();
  }
});
test('the shared platform resizes for focus and disappears when no performers are visible', () => {
  const song = createOrchestraDemo(),
    players = new Musicians();
  const sheet = new THREE.Group();
  sheet.rotation.x = -Math.PI / 2;
  sheet.add(players.group);
  const size = () => {
    players.render(0.4, 0, DEFAULT_SETTINGS);
    sheet.updateMatrixWorld(true);
    return new THREE.Box3()
      .setFromObject(players.group.getObjectByName('rolling-stage')!)
      .getSize(new THREE.Vector3());
  };
  try {
    players.setLanes(scoreLanes(song, DEFAULT_SETTINGS));
    const full = size();
    players.setLanes(scoreLanes(song, { ...DEFAULT_SETTINGS, focusTrack: 'violin' }));
    assert.ok(size().z < full.z / 2);
    song.tracks.forEach((track) => {
      track.musician = { visible: false };
    });
    players.setLanes(scoreLanes(song, DEFAULT_SETTINGS));
    assert.equal(players.group.children.length, 0);
    players.setLanes([]);
    assert.equal(players.group.children.length, 0);
  } finally {
    players.dispose();
  }
});
test('keyboard detection uses sound assignment; larger musician sizes survive project saving', () => {
  const song = createOrchestraDemo(),
    track = song.tracks[0];
  for (const program of [0, 4, 7, 8, 16, 20, 23, 80, 96])
    assert.equal(usesGrandStaff({ ...track, program }), true);
  for (const program of [11, 24, 40, 46, 73])
    assert.equal(usesGrandStaff({ ...track, program }), false);
  assert.equal(usesGrandStaff({ ...track, program: 0, percussion: true }), false);
  assert.equal(usesGrandStaff({ ...track, program: undefined, instrument: 'Electric keys' }), true);
  assert.equal(usesGrandStaff({ ...track, program: undefined, instrument: 'Guitar' }), false);
  track.musician = { scale: MAX_MUSICIAN_SCALE };
  const saved = parseProject(JSON.stringify({ version: 1, song, settings: DEFAULT_SETTINGS }));
  assert.equal(saved.song.tracks[0].musician?.scale, MAX_MUSICIAN_SCALE);
  const players = new Musicians();
  try {
    players.setLanes(scoreLanes(saved.song, DEFAULT_SETTINGS));
    players.render(0, 0, DEFAULT_SETTINGS);
    assert.equal(players.group.children[0].scale.x, MAX_MUSICIAN_SCALE);
  } finally {
    players.dispose();
  }
});
