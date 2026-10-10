import type { Song } from './project';
/** A bounded worker queue also works on HTTP LAN addresses without AudioWorklet. */
export class OrchestraPlayer {
  private context?: AudioContext;
  private worker?: Worker;
  private gain?: GainNode;
  private sources = new Set<AudioBufferSourceNode>();
  private generation = 0;
  private clock = 0;
  private offset = 0;
  private rate = 1;
  private duration = 0;
  private queued = 0;
  private requested = false;
  private done = false;
  private timer?: ReturnType<typeof setInterval>;
  private ready?: { resolve: () => void; reject: (e: Error) => void };
  private active = false;
  error = '';
  async prepare() {
    this.context ??= new AudioContext({ sampleRate: 44100 });
    this.gain ??= this.context.createGain();
    this.gain.disconnect();
    this.gain.connect(this.context.destination);
    await this.context.resume();
    if (!this.worker) {
      this.worker = new Worker(new URL('./orchestra-audio-worker.ts', import.meta.url), {
        type: 'module',
      });
      this.worker.onmessage = ({ data }) => {
        if (data.id !== this.generation) return;
        this.requested = false;
        if (data.error) {
          this.fail(data.error);
          return;
        }
        const ctx = this.context!,
          left = data.left as Float32Array,
          right = data.right as Float32Array;
        if (!left.length) {
          this.done = true;
          return;
        }
        if (!this.active) {
          this.clock = ctx.currentTime + 0.15;
          this.queued = this.clock;
          this.active = true;
        }
        if (this.queued < ctx.currentTime) {
          this.fail('Audio could not keep up. Press Play to resume.');
          return;
        }
        const buffer = ctx.createBuffer(2, left.length, ctx.sampleRate);
        buffer.getChannelData(0).set(left);
        buffer.getChannelData(1).set(right);
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(this.gain!);
        source.onended = () => {
          this.sources.delete(source);
          source.disconnect();
        };
        this.sources.add(source);
        source.start(this.queued);
        this.queued += buffer.duration;
        this.done = data.done;
        this.ready?.resolve();
        this.ready = undefined;
        this.request();
      };
      this.worker.onerror = () =>
        this.fail('The orchestra audio worker stopped. Reload the app to retry.');
    }
  }
  private fail(message: string) {
    this.error = message;
    this.ready?.reject(new Error(message));
    this.ready = undefined;
    this.stop();
  }
  async play(song: Song, offset: number, rate: number, volume: number) {
    this.stop();
    this.error = '';
    this.offset = offset;
    this.rate = rate;
    this.duration = song.duration;
    this.gain!.gain.value = volume;
    this.done = false;
    this.requested = true;
    const ready = new Promise<void>((resolve, reject) => {
      this.ready = { resolve, reject };
    });
    this.worker!.postMessage({
      type: 'start',
      id: this.generation,
      song,
      offset,
      rate,
      sampleRate: this.context!.sampleRate,
    });
    this.timer = setInterval(() => this.request(), 100);
    return ready;
  }
  private request() {
    if (
      !this.active ||
      this.requested ||
      this.done ||
      this.queued - this.context!.currentTime > 1.5
    )
      return;
    this.requested = true;
    this.worker!.postMessage({
      type: 'read',
      id: this.generation,
      sampleRate: this.context!.sampleRate,
    });
  }
  get currentTime() {
    return this.active
      ? Math.min(
          this.duration,
          this.offset + Math.max(0, this.context!.currentTime - this.clock) * this.rate,
        )
      : this.offset;
  }
  get isPlaying() {
    return this.active;
  }
  setVolume(volume: number) {
    if (this.gain) this.gain.gain.setTargetAtTime(volume, this.context!.currentTime, 0.02);
  }
  stop() {
    this.offset = this.currentTime;
    this.active = false;
    this.generation++;
    clearInterval(this.timer);
    this.timer = undefined;
    this.ready?.resolve();
    this.ready = undefined;
    for (const source of this.sources) {
      source.stop();
      source.disconnect();
    }
    this.sources.clear();
    this.worker?.postMessage({ type: 'stop', id: this.generation });
  }
  dispose() {
    this.stop();
    this.worker?.terminate();
    void this.context?.close();
  }
}
