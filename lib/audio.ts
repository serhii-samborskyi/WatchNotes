import type * as ToneType from 'tone';
import type { Song, Note } from './project';
let tonePromise: Promise<typeof ToneType> | undefined;
const getTone = () => (tonePromise ??= import('tone'));
import { SOFT_KEYS } from './offline-audio';
import { audibleTracks } from './orchestra';
import type { OrchestraPlayer } from './orchestra-player';
const voiceOptions = SOFT_KEYS;
function sortedNotes(song: Song) {
  return audibleTracks(song)
    .filter((t) => (t.volume ?? 1) > 0)
    .flatMap((t) => t.notes.map((n) => ({ ...n, velocity: n.velocity * (t.volume ?? 1) })))
    .sort((a, b) => a.time - b.time);
}
class SoftKeysPlayer {
  private tone?: typeof ToneType;
  private synth?: ToneType.PolySynth;
  private output?: ToneType.Gain;
  private timer?: ReturnType<typeof setInterval>;
  private startClock = 0;
  private offset = 0;
  private rate = 1;
  private notes: Note[] = [];
  private next = 0;
  private songDuration = 0;
  async prepare() {
    this.tone = await getTone();
    await this.tone.start();
  }
  play(song: Song, offset: number, rate: number, volume: number) {
    if (!this.tone) throw new Error('Audio is not ready.');
    this.stop();
    const tone = this.tone!;
    this.output = new tone.Gain(volume).toDestination();
    this.synth = new tone.PolySynth(tone.Synth, voiceOptions).connect(this.output);
    this.synth.maxPolyphony = 96;
    this.notes = sortedNotes(song);
    this.offset = offset;
    this.rate = rate;
    this.songDuration = song.duration;
    this.startClock = tone.now() + 0.04;
    this.next = this.notes.findIndex((n) => n.time >= offset);
    if (this.next < 0) this.next = this.notes.length;
    for (const n of this.notes)
      if (n.time < offset && n.time + n.duration > offset)
        this.trigger(n, this.startClock, (n.time + n.duration - offset) / rate);
    this.schedule();
    this.timer = setInterval(() => this.schedule(), 25);
  }
  private trigger(n: Note, when: number, duration: number) {
    this.synth?.triggerAttackRelease(
      this.tone!.Frequency(n.midi, 'midi').toFrequency(),
      Math.max(0.015, duration),
      when,
      Math.max(0.01, n.velocity) * 0.75,
    );
  }
  private schedule() {
    if (!this.tone || !this.synth) return;
    const ahead = this.currentTime + 0.18 * this.rate;
    while (this.next < this.notes.length && this.notes[this.next].time <= ahead) {
      const n = this.notes[this.next++];
      this.trigger(
        n,
        Math.max(this.tone.now() + 0.005, this.startClock + (n.time - this.offset) / this.rate),
        n.duration / this.rate,
      );
    }
  }
  get currentTime() {
    return this.tone && this.synth
      ? Math.min(
          this.songDuration,
          Math.max(
            this.offset,
            this.offset + (this.tone.immediate() - this.startClock) * this.rate,
          ),
        )
      : this.offset;
  }
  setVolume(volume: number) {
    this.output?.gain.rampTo(volume, 0.06);
  }
  get isPlaying() {
    return Boolean(this.synth);
  }
  stop() {
    this.offset = this.currentTime;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.synth?.dispose();
    this.output?.dispose();
    this.synth = undefined;
    this.output = undefined;
  }
}
export { renderAudio } from './render-audio';
export class AudioPlayer {
  private soft = new SoftKeysPlayer();
  private orchestra?: OrchestraPlayer;
  private mode: 'soft-keys' | 'orchestra' = 'soft-keys';
  async prepare(song?: Song) {
    const mode = song?.audioMode ?? 'soft-keys';
    if (mode !== this.mode) this.stop();
    this.mode = mode;
    if (mode === 'orchestra') {
      if (!this.orchestra) {
        const { OrchestraPlayer } = await import('./orchestra-player');
        this.orchestra = new OrchestraPlayer();
      }
      await this.orchestra.prepare();
    } else await this.soft.prepare();
  }
  async play(song: Song, offset: number, rate: number, volume: number) {
    if (this.mode === 'orchestra') await this.orchestra!.play(song, offset, rate, volume);
    else this.soft.play(song, offset, rate, volume);
  }
  get currentTime() {
    return this.mode === 'orchestra' ? (this.orchestra?.currentTime ?? 0) : this.soft.currentTime;
  }
  get isPlaying() {
    return this.mode === 'orchestra' ? (this.orchestra?.isPlaying ?? false) : this.soft.isPlaying;
  }
  get error() {
    return this.mode === 'orchestra' ? (this.orchestra?.error ?? '') : '';
  }
  setVolume(v: number) {
    this.soft.setVolume(v);
    this.orchestra?.setVolume(v);
  }
  stop() {
    this.soft.stop();
    this.orchestra?.stop();
  }
  dispose() {
    this.stop();
    this.orchestra?.dispose();
  }
}
