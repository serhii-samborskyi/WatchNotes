import { OrchestraSynth, loadOrchestraBank } from './orchestra-synth';
import type { Song } from './project';
let engine: OrchestraSynth | undefined;
let generation = 0;
self.onmessage = async ({
  data,
}: {
  data: {
    type: 'start' | 'read' | 'stop';
    id: number;
    song: Song;
    offset: number;
    rate: number;
    sampleRate: number;
  };
}) => {
  const { type, id } = data;
  try {
    if (type === 'stop') {
      generation = id;
      engine?.dispose();
      engine = undefined;
      return;
    }
    if (type === 'start') {
      generation = id;
      engine?.dispose();
      engine = undefined;
      const bank = await loadOrchestraBank();
      if (generation !== id) return;
      const next = await OrchestraSynth.create(
        data.song,
        bank,
        data.offset,
        data.song.duration,
        data.rate,
        data.sampleRate,
      );
      if (generation !== id) {
        next.dispose();
        return;
      }
      engine = next;
    }
    if (!engine || id !== generation) return;
    const chunk = engine.read(Math.round(data.sampleRate * 0.5));
    self.postMessage({ id, ...chunk }, { transfer: [chunk.left.buffer, chunk.right.buffer] });
  } catch (e) {
    self.postMessage({ id, error: e instanceof Error ? e.message : 'Orchestra audio failed.' });
  }
};
