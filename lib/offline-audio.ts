import type { Song } from './project';
import { audibleTracks } from './orchestra';

// These match the preview's Tone Synth. Native AudioParam automation avoids
// constructing a long-running graph of control-signal nodes for offline audio.
export const SOFT_KEYS = {
  oscillator: { type: 'triangle' as const },
  envelope: { attack: 0.006, decay: 0.65, sustain: 0.17, release: 0.65 },
  volume: -15,
};
const sampleRate = 44100;
const targetConstant = (seconds: number) => Math.log(seconds + 1) / Math.log(200);

function decayValue(peak: number, age: number) {
  const { attack, decay, sustain } = SOFT_KEYS.envelope;
  if (age < attack) return (peak * age) / attack;
  const elapsed = age - attack,
    target = peak * sustain;
  const tail = target + (peak - target) * Math.exp((-decay * 0.9) / targetConstant(decay));
  if (elapsed < decay * 0.9)
    return target + (peak - target) * Math.exp(-elapsed / targetConstant(decay));
  if (elapsed < decay) return tail + ((target - tail) * (elapsed / decay - 0.9)) / 0.1;
  return target;
}

function envelope(param: AudioParam, start: number, length: number, peak: number) {
  const { attack, decay, sustain, release } = SOFT_KEYS.envelope;
  const off = start + length;
  // Schedule only up to note-off. This also handles notes shorter than the
  // attack/decay without relying on cancelAndHoldAtTime browser differences.
  param.setValueAtTime(0, start);
  param.linearRampToValueAtTime(peak * Math.min(1, length / attack), Math.min(start + attack, off));
  if (length > attack) {
    param.setTargetAtTime(peak * sustain, start + attack, targetConstant(decay));
    if (length > attack + decay * 0.9) {
      param.setValueAtTime(decayValue(peak, attack + decay * 0.9), start + attack + decay * 0.9);
      param.linearRampToValueAtTime(
        decayValue(peak, Math.min(length, attack + decay)),
        Math.min(off, start + attack + decay),
      );
    }
  }
  const level = decayValue(peak, length);
  param.setValueAtTime(level, off);
  param.setTargetAtTime(0, off, targetConstant(release));
  param.setValueAtTime(
    level * Math.exp((-release * 0.9) / targetConstant(release)),
    off + release * 0.9,
  );
  param.linearRampToValueAtTime(0, off + release);
}

/** The same triangle/ADSR voice as the preview, using native offline automation. */
export async function renderNativeAudio(
  song: Song,
  start: number,
  end: number,
  volume: number,
  rate: number,
  onProgress?: (progress: number) => void,
): Promise<Blob> {
  const duration = (end - start) / rate;
  if (!Number.isFinite(duration) || duration <= 0 || duration > 600)
    throw new Error('Audio duration must be between zero and ten minutes.');
  const samples = Math.max(1, Math.floor(duration * sampleRate));
  const context = new OfflineAudioContext(2, samples, sampleRate);
  const output = context.createGain();
  output.gain.value = volume * 10 ** (SOFT_KEYS.volume / 20);
  output.connect(context.destination);
  const voices: { gain: GainNode; freeAt: number }[] = [];
  const notes = audibleTracks(song)
    .filter((t) => (t.volume ?? 1) > 0)
    .flatMap((t) => t.notes.map((n) => ({ ...n, velocity: n.velocity * (t.volume ?? 1) })))
    .sort((a, b) => a.time - b.time);
  let scheduled = 0;
  for (const note of notes) {
    if (note.time >= end || note.time + note.duration <= start) continue;
    const when = Math.max(0, (note.time - start) / rate);
    const length = Math.max(
      0.001,
      (Math.min(end, note.time + note.duration) - Math.max(start, note.time)) / rate,
    );
    let voice = voices.find((v) => v.freeAt <= when);
    if (!voice) {
      if (voices.length >= 96) continue;
      const gain = context.createGain();
      gain.gain.value = 0;
      gain.connect(output);
      voices.push((voice = { gain, freeAt: 0 }));
    }
    envelope(voice.gain.gain, when, length, Math.max(0.01, note.velocity) * 0.75);
    const oscillator = context.createOscillator();
    oscillator.type = SOFT_KEYS.oscillator.type;
    oscillator.frequency.value = 440 * 2 ** ((note.midi - 69) / 12);
    oscillator.connect(voice.gain);
    oscillator.start(when);
    voice.freeAt = when + length + SOFT_KEYS.envelope.release;
    oscillator.stop(voice.freeAt);
    // Let cancellation/page closure and progress messages run on dense scores.
    if (++scheduled % 500 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  onProgress?.(0);
  const timer = setInterval(
    () => onProgress?.(Math.min(0.9, (context.currentTime / duration) * 0.9)),
    250,
  );
  let buffer: AudioBuffer;
  try {
    buffer = await context.startRendering();
  } finally {
    clearInterval(timer);
  }
  onProgress?.(0.9);
  const bytes = new ArrayBuffer(44 + samples * 4),
    view = new DataView(bytes);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples * 4, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples * 4, true);
  const left = buffer.getChannelData(0),
    right = buffer.getChannelData(1);
  for (let offset = 0; offset < samples; offset += 65536) {
    const limit = Math.min(samples, offset + 65536);
    for (let i = offset; i < limit; i++) {
      const l = Math.max(-1, Math.min(1, left[i])),
        r = Math.max(-1, Math.min(1, right[i]));
      view.setInt16(44 + i * 4, l * (l < 0 ? 32768 : 32767), true);
      view.setInt16(46 + i * 4, r * (r < 0 ? 32768 : 32767), true);
    }
    onProgress?.(0.9 + (0.1 * limit) / samples);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return new Blob([bytes], { type: 'audio/wav' });
}
