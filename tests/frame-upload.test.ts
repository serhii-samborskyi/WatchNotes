import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { PNG } from 'pngjs';
import { streamFrameUpload } from '../server/frame-upload';

test('frame uploads preserve raw pixels across small chunks and reject truncated batches', async () => {
  const pixels = Buffer.from(Array.from({ length: 128 }, (_, i) => i));
  const chunks = Array.from({ length: 128 }, (_, i) => pixels.subarray(i, i + 1));
  const received: Buffer[] = [];
  const sink = new Writable({
    write(chunk, _encoding, done) {
      received.push(Buffer.from(chunk));
      setImmediate(done);
    },
  });
  const frame = { capture: 'rgba' as const, width: 4, height: 4, count: 2 };
  await streamFrameUpload(Readable.from(chunks), sink, frame, () => {});
  assert.deepEqual(Buffer.concat(received), pixels);
  await assert.rejects(
    streamFrameUpload(Readable.from([pixels.subarray(0, 64)]), sink, frame, () => {}),
    /batch size/,
  );
});

test('PNG headers split across chunks are validated before any bytes reach the encoder', async () => {
  const data = PNG.sync.write(new PNG({ width: 4, height: 4 }));
  const received: Buffer[] = [];
  const sink = new Writable({
    write(chunk, _encoding, done) {
      received.push(Buffer.from(chunk));
      done();
    },
  });
  const frame = { capture: 'png' as const, width: 4, height: 4, count: 1 };
  await streamFrameUpload(
    Readable.from([data.subarray(0, 5), data.subarray(5, 18), data.subarray(18)]),
    sink,
    frame,
    () => {},
  );
  assert.deepEqual(Buffer.concat(received), data);
  received.length = 0;
  await assert.rejects(
    streamFrameUpload(Readable.from([data]), sink, { ...frame, width: 8 }, () => {}),
    /dimensions/,
  );
  assert.equal(received.length, 0);
  await assert.rejects(
    streamFrameUpload(Readable.from([data]), sink, frame, () => {
      throw new Error('Attempt ended');
    }),
    /Attempt ended/,
  );
});
