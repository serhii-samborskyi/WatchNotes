import { SoundBankLoader, SpessaSynthProcessor, SpessaLog } from 'spessasynth_core';
import { audibleTracks, trackProgram } from './orchestra';
import type { Song, Track } from './project';
SpessaLog.setLogLevel(false, false, false);
export const SOUNDFONT_URL = '/sounds/GeneralUser-GS.sf2';
export const ORCHESTRA_SAMPLE_RATE = 44100;
type Event = {
  sample: number;
  channel: number;
  type: 'on' | 'off' | 'cc' | 'bend';
  a: number;
  b: number;
};
const priority = { cc: 0, bend: 1, off: 2, on: 3 };
/** Keep channel state and pedal-held notes when playback/export begins in the middle. */
export function performanceEvents(
  tracks: Track[],
  start: number,
  end: number,
  rate: number,
  sampleRate: number,
): Event[] {
  const events: Event[] = [];
  tracks.forEach((track, channel) => {
    const add = (time: number, type: Event['type'], a: number, b = 0) => {
      events.push({
        sample: Math.max(0, Math.round(((time - start) / rate) * sampleRate)),
        channel,
        type,
        a,
        b,
      });
    };
    const controls = [...(track.controls || [])].sort((a, b) => a.time - b.time);
    const state = new Map<number, { time: number; number: number; value: number }>();
    for (const c of controls) {
      if (c.time < start) state.set(c.number, c);
    }
    // Preserve controller ordering, including bank and RPN selection.
    for (const c of [...state.values()].sort((a, b) => a.time - b.time))
      add(start, 'cc', c.number, Math.round(c.value * 127));
    for (const c of controls)
      if (c.time >= start && c.time < end) add(c.time, 'cc', c.number, Math.round(c.value * 127));
    let bend = 0;
    for (const b of [...(track.pitchBends || [])].sort((a, b) => a.time - b.time)) {
      if (b.time < start) bend = b.value;
      else if (b.time < end)
        add(b.time, 'bend', Math.max(0, Math.min(16383, Math.round(8192 + b.value * 8192))));
    }
    // Initial state must precede events at the start boundary.
    events.unshift({
      sample: 0,
      channel,
      type: 'bend',
      a: Math.max(0, Math.min(16383, Math.round(8192 + bend * 8192))),
      b: 0,
    });
    const pedal = controls.filter((c) => c.number === 64);
    for (const n of track.notes) {
      if (n.time >= end) continue;
      const off = n.time + n.duration;
      let sustained = false;
      if (off <= start) {
        const down = pedal.filter((c) => c.time <= off).at(-1);
        const up = pedal.find((c) => c.time > off && c.value < 0.5);
        sustained = !!down && down.value >= 0.5 && (!up || up.time > start);
        if (!sustained) continue;
      }
      add(Math.max(n.time, start), 'on', n.midi, Math.max(1, Math.round(n.velocity * 127)));
      // At a clipped start, note-on then note-off while the pedal remains down.
      add(sustained ? start + rate / sampleRate : Math.min(off, end), 'off', n.midi);
    }
  });
  return events.sort((a, b) => a.sample - b.sample || priority[a.type] - priority[b.type]);
}
export class OrchestraSynth {
  readonly synth: SpessaSynthProcessor;
  private events: Event[];
  private next = 0;
  private sample = 0;
  private delivered = 0;
  private quantumLeft = new Float32Array(128);
  private quantumRight = new Float32Array(128);
  private quantumSize = 0;
  private quantumOffset = 0;
  readonly samples: number;
  private constructor(
    song: Song,
    bank: ArrayBuffer,
    start: number,
    end: number,
    rate: number,
    readonly sampleRate: number,
  ) {
    this.samples = Math.max(1, Math.floor(((end - start) / rate) * sampleRate));
    this.synth = new SpessaSynthProcessor(sampleRate, { eventsEnabled: false });
    this.synth.soundBankManager.addSoundBank(SoundBankLoader.fromArrayBuffer(bank), 'orchestra');
    this.synth.setSystemParameter('voiceCap', 192);
    this.synth.setSystemParameter('autoAllocateVoices', false);
    const tracks = audibleTracks(song);
    while (this.synth.midiChannels.length < tracks.length) this.synth.createMIDIChannel();
    tracks.forEach((track, i) => {
      this.synth.midiChannels[i].setDrums(track.percussion);
      this.synth.programChange(i, trackProgram(track));
      this.synth.midiChannels[i].setSystemParameter('gain', track.volume ?? 1);
    });
    this.events = performanceEvents(tracks, start, end, rate, sampleRate);
  }
  static async create(
    song: Song,
    bank: ArrayBuffer,
    start: number,
    end: number,
    rate: number,
    sampleRate = ORCHESTRA_SAMPLE_RATE,
  ) {
    if (!Number.isFinite((end - start) / rate) || end <= start || rate <= 0)
      throw new Error('Invalid audio range.');
    const engine = new OrchestraSynth(song, bank, start, end, rate, sampleRate);
    await engine.synth.processorInitialized;
    return engine;
  }
  read(count: number) {
    count = Math.max(0, Math.min(count, this.samples - this.delivered));
    const left = new Float32Array(count),
      right = new Float32Array(count);
    let offset = 0;
    while (offset < count) {
      if (this.quantumOffset === this.quantumSize) {
        while (this.next < this.events.length && this.events[this.next].sample <= this.sample) {
          const e = this.events[this.next++];
          if (e.type === 'on') this.synth.noteOn(e.channel, e.a, e.b);
          else if (e.type === 'off') this.synth.noteOff(e.channel, e.a);
          else if (e.type === 'cc')
            this.synth.controllerChange(
              e.channel,
              e.a as Parameters<SpessaSynthProcessor['controllerChange']>[1],
              e.b,
            );
          else this.synth.pitchWheel(e.channel, e.a);
        }
        this.quantumSize = Math.min(
          128,
          this.samples - this.sample,
          (this.events[this.next]?.sample ?? Infinity) - this.sample,
        );
        this.quantumOffset = 0;
        this.quantumLeft.fill(0);
        this.quantumRight.fill(0);
        this.synth.process(this.quantumLeft, this.quantumRight, 0, this.quantumSize);
        this.sample += this.quantumSize;
      }
      const size = Math.min(count - offset, this.quantumSize - this.quantumOffset);
      left.set(this.quantumLeft.subarray(this.quantumOffset, this.quantumOffset + size), offset);
      right.set(this.quantumRight.subarray(this.quantumOffset, this.quantumOffset + size), offset);
      this.quantumOffset += size;
      offset += size;
    }
    this.delivered += count;
    return { left, right, done: this.delivered >= this.samples };
  }
  dispose() {
    this.synth.destroySynthProcessor();
  }
}
let bankPromise: Promise<ArrayBuffer> | undefined;
export function loadOrchestraBank() {
  return (bankPromise ??= fetch(SOUNDFONT_URL)
    .then((r) => {
      if (!r.ok) throw new Error('The orchestra sound bank could not be loaded. Try again.');
      return r.arrayBuffer();
    })
    .catch((e) => {
      bankPromise = undefined;
      throw e;
    }));
}
export async function renderOrchestraAudio(
  song: Song,
  start: number,
  end: number,
  volume: number,
  rate: number,
  onProgress?: (n: number) => void,
) {
  if ((end - start) / rate > 600) throw new Error('Audio export is limited to ten minutes.');
  onProgress?.(0);
  const engine = await OrchestraSynth.create(song, await loadOrchestraBank(), start, end, rate);
  const bytes = new ArrayBuffer(44 + engine.samples * 4),
    view = new DataView(bytes);
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + engine.samples * 4, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, engine.sampleRate, true);
  view.setUint32(28, engine.sampleRate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, engine.samples * 4, true);
  try {
    let offset = 0;
    while (offset < engine.samples) {
      const { left, right } = engine.read(16384);
      for (let i = 0; i < left.length; i++) {
        const l = Math.max(-1, Math.min(1, left[i] * volume)),
          r = Math.max(-1, Math.min(1, right[i] * volume));
        view.setInt16(44 + (offset + i) * 4, l * (l < 0 ? 32768 : 32767), true);
        view.setInt16(46 + (offset + i) * 4, r * (r < 0 ? 32768 : 32767), true);
      }
      offset += left.length;
      onProgress?.(offset / engine.samples);
      await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    engine.dispose();
  }
  return new Blob([bytes], { type: 'audio/wav' });
}
