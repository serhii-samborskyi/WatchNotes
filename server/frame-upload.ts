import type { Readable, Writable } from 'node:stream';

/** Stream into the encoder with backpressure instead of allocating a 16MB
 * request buffer (and its copies) for every two-frame upload in every worker. */
export async function streamFrameUpload(
  input: Readable,
  output: Writable,
  frame: { capture: 'rgba' | 'png'; width: number; height: number; count: number },
  assertActive: () => void,
) {
  const raw = frame.capture === 'rgba';
  const limit = raw ? frame.width * frame.height * 4 * frame.count : 16 * 1024 ** 2;
  const prefix = Buffer.alloc(24);
  let prefixBytes = 0,
    bytes = 0;
  const write = (chunk: Buffer) =>
    new Promise<void>((resolve, reject) => {
      output.write(chunk, (error) => (error ? reject(error) : resolve()));
    });
  for await (const value of input) {
    assertActive();
    let chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    bytes += chunk.length;
    if (bytes > limit) throw new Error('Incorrect frame dimensions or batch size.');
    if (!raw && prefixBytes < 24) {
      const count = Math.min(24 - prefixBytes, chunk.length);
      chunk.copy(prefix, prefixBytes, 0, count);
      prefixBytes += count;
      chunk = chunk.subarray(count);
      if (prefixBytes < 24) continue;
      if (
        prefix.toString('hex', 0, 8) !== '89504e470d0a1a0a' ||
        prefix.readUInt32BE(16) !== frame.width ||
        prefix.readUInt32BE(20) !== frame.height
      )
        throw new Error('Incorrect frame dimensions or batch size.');
      await write(prefix);
    }
    if (chunk.length) await write(chunk);
  }
  assertActive();
  if (raw ? bytes !== limit : prefixBytes !== 24)
    throw new Error('Incorrect frame dimensions or batch size.');
}
