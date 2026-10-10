import { ExportMemoryError } from './render-memory';

/** Only graphics/renderer failures merit restarting an otherwise valid export. */
export function isGraphicsFailure(error: unknown) {
  if (error instanceof ExportMemoryError) return false;
  const message = error instanceof Error ? error.message : String(error);
  return /graphics context|webgl|video frame buffer|rendered video frame|GPU|CUDA|NVENC|OpenEncodeSessionEx|Target closed|Session closed|Connection closed|Page crashed|renderer stopped responding/i.test(
    message,
  );
}

export function publicExportError(error: unknown) {
  if (error instanceof ExportMemoryError) return error.message;
  if (isGraphicsFailure(error))
    return 'The renderer could not finish, even after automatic recovery. Try 720p with one worker, or select This device.';
  const message = error instanceof Error ? error.message : String(error);
  if (
    /^(The server could not enable its memory protection|Protected server rendering|Export memory protection stopped)/.test(
      message,
    )
  )
    return message;
  if (message.startsWith('Server rendering needs Chrome or Chromium.')) return message;
  if (message === 'Audio rendering stopped responding.')
    return 'The soundtrack stopped making progress. Try exporting without audio.';
  if (/ENOSPC|No space left on device/i.test(message))
    return 'The server ran out of disk space. Free some space and try again.';
  return 'The server could not finish this export. Try again or select This device. Details are in the server log.';
}
