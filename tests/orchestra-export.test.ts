import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import ffmpeg from 'ffmpeg-static';
import { registerServerExport } from '../server/server-export';
import { createOrchestraDemo } from '../lib/orchestra-demo';
import { DEFAULT_SETTINGS } from '../lib/project';

for (const cameraMode of ['static', 'cinematic'] as const)
  test(
    `exports ${cameraMode === 'cinematic' ? 'a 29-part cinematic orchestra' : 'all six musician models'} with sampled audio into a decodable MP4`,
    { timeout: 120000 },
    async () => {
      const app = express(),
        http = createServer(app);
      http.listen(0, '127.0.0.1');
      await once(http, 'listening');
      const port = (http.address() as { port: number }).port;
      const service = registerServerExport(app, { port, encoder: ffmpeg!, otherBusy: () => false });
      const api = `http://127.0.0.1:${port}/api/export/server-jobs`;
      const dir = await mkdtemp(path.join(tmpdir(), 'watch-notes-orchestra-export-'));
      let job: { id: string; token: string } | undefined;
      try {
        const song = createOrchestraDemo();
        for (const [id, program] of [
          ['cello', 42],
          ['trumpet', 56],
        ] as const)
          song.tracks.push({
            ...song.tracks[1],
            id,
            name: id,
            program,
            notes: song.tracks[1].notes.map((note) => ({ ...note, id: `${id}-${note.id}` })),
          });
        if (cameraMode === 'cinematic') {
          for (let i = song.tracks.length; i < 29; i++) {
            const source = song.tracks[i % 6];
            song.tracks.push({
              ...source,
              id: `extra-${i}`,
              name: `Section ${i}`,
              notes: source.notes.map((note) => ({ ...note, id: `extra-${i}-${note.id}` })),
            });
          }
        }
        const response = await fetch(api, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            project: {
              version: 1,
              song,
              settings: { ...DEFAULT_SETTINGS, cameraMode, cameraPacing: 'energetic' },
            },
            options: {
              width: 1280,
              height: 720,
              fps: 24,
              start: 2,
              end: 6,
              rate: 1.5,
              audio: true,
              workers: 2,
              resourcePercent: 65,
            },
          }),
        });
        assert.equal(response.status, 201, await response.clone().text());
        job = await response.json();
        const headers = { 'x-export-token': job!.token };
        let status:
          { state: string; error?: string; received: number; audioProgress: number } | undefined;
        for (let i = 0; i < 200; i++) {
          status = await (await fetch(`${api}/${job!.id}`, { headers })).json();
          if (status!.state === 'complete' || status!.state === 'error') break;
          await new Promise((r) => setTimeout(r, 300));
        }
        assert.equal(status?.state, 'complete', status?.error);
        assert.equal(status.audioProgress, 1);
        assert.equal(status.received, 64);
        const file = path.join(dir, 'quartet.mp4');
        await writeFile(
          file,
          Buffer.from(await (await fetch(`${api}/${job!.id}/download`, { headers })).arrayBuffer()),
        );
        const child = spawn(ffmpeg!, [
          '-hide_banner',
          '-xerror',
          '-err_detect',
          'explode',
          '-i',
          file,
          '-map',
          '0:v:0',
          '-map',
          '0:a:0',
          '-f',
          'null',
          '-',
        ]);
        let log = '';
        child.stderr.on('data', (c) => (log += String(c)));
        const [code] = await once(child, 'close');
        assert.equal(code, 0, log);
        assert.match(log, /frame=\s*64\b/);
        assert.match(log, /Audio: aac/);
      } finally {
        if (job)
          await fetch(`${api}/${job.id}`, {
            method: 'DELETE',
            headers: { 'x-export-token': job.token },
          });
        await service.close();
        await new Promise<void>((r) => http.close(() => r()));
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
