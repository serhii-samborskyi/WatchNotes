import { renderNativeAudio } from './offline-audio';
export async function renderAudio(...args: Parameters<typeof renderNativeAudio>) {
  if (args[0].audioMode === 'orchestra') {
    const { renderOrchestraAudio } = await import('./orchestra-synth');
    return renderOrchestraAudio(...args);
  }
  return renderNativeAudio(...args);
}
