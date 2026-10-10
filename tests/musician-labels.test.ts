import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import express from 'express';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findChrome } from '../server/render-resources';
import { createRenderMemoryGroup, GiB } from '../server/render-memory';

test(
  'nameplates keep their projected size, follow parts and release textures',
  { timeout: 30000 },
  async () => {
    const compiled = await build({
      stdin: {
        resolveDir: process.cwd(),
        contents: `
        import * as THREE from 'three';
        import { MusicianLabels } from './lib/musician-labels';
        import { Musicians } from './lib/musicians';
        import { CinematicDirector } from './lib/cinematic-director';
        import { createOrchestraDemo } from './lib/orchestra-demo';
        import { DEFAULT_SETTINGS } from './lib/project';
        import { scoreLanes } from './lib/orchestra';
        window.checkLabels = () => {
          const song = createOrchestraDemo();
          song.tracks[1].musician = {scale: 4, x: 2, y: -1};
          const labels = new MusicianLabels();
          const lanes = scoreLanes(song, DEFAULT_SETTINGS);
          labels.setLanes(lanes);
          const players = new Musicians();
          players.setLanes(lanes);
          const sheet = new THREE.Group();
          sheet.rotation.x = -Math.PI/2;
          sheet.add(players.group);
          players.render(.4, 20, DEFAULT_SETTINGS);
          sheet.updateMatrixWorld(true);
          const count = labels.scene.children.length;
          const samples = [];
          const camera = new THREE.PerspectiveCamera(36, 16/9, .1, 700);
          for (const height of [360, 720, 1080, 2160]) {
            for (const distance of [25, 100]) {
              camera.position.set(15, distance, distance);
              camera.lookAt(0, 0, 0);
              labels.update(camera, height, 20);
              const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
              for (const sprite of labels.scene.children) {
                const bottom = sprite.position.clone().project(camera);
                const top = sprite.position.clone().addScaledVector(up, sprite.scale.y).project(camera);
                samples.push({height, pixels: (top.y-bottom.y)*height/2, visible: sprite.visible});
              }
            }
          }
          const violin = labels.scene.getObjectByName('label:violin');
          const head = players.group.getObjectByName('musician:violin').getObjectByName('head');
          const headBounds = new THREE.Box3().setFromObject(head);
          const headClearance = violin.position.y-headBounds.max.y;
          players.dispose();
          const before = violin.position.x;
          labels.update(camera, 720, 35);
          const offset = violin.position.x-before;
          const material = violin.material;
          const settings = {...DEFAULT_SETTINGS, cameraMode: 'cinematic', cameraTrack: 'violin'};
          song.tracks[1].name = 'First violins and string ensemble';
          labels.setLanes(lanes);
          const shot = new CinematicDirector(song, settings, lanes).at(2);
          camera.position.copy(shot.position); camera.lookAt(shot.target);
          labels.update(camera, 720, 2 * settings.spacing, shot.labels);
          const featuredLabels = labels.scene.children.filter(sprite => sprite.visible).map(sprite => sprite.name);
          labels.update(camera, 720, 2 * settings.spacing, []);
          const wideLabels = labels.scene.children.filter(sprite => sprite.visible).length;
          const readable = [];
          for (const scale of [.4, 2.2, 4]) for (const aspect of [16/9, 1, 9/16]) {
            song.tracks[1].musician.scale = scale;
            labels.setLanes(lanes);
            camera.aspect = aspect; camera.updateProjectionMatrix();
            const frame = new CinematicDirector(song, settings, lanes).at(2, aspect);
            camera.position.copy(frame.position); camera.lookAt(frame.target);
            labels.update(camera, 720, 2 * settings.spacing, frame.labels);
            readable.push({scale, aspect, count: labels.scene.children.filter(sprite => sprite.visible).length});
          }
          labels.update(camera, 720, 2 * settings.spacing);
          let texturesDisposed = 0, materialsDisposed = 0;
          for (const sprite of labels.scene.children) {
            sprite.material.map.addEventListener('dispose', () => texturesDisposed++);
            sprite.material.addEventListener('dispose', () => materialsDisposed++);
          }
          labels.setLanes([]);
          labels.dispose();
          return { count, samples, offset, headClearance, featuredLabels, wideLabels, readable, fog: material.fog, toneMapped: material.toneMapped,
            opacity: material.opacity, texturesDisposed, materialsDisposed, remaining: labels.scene.children.length };
        };
      `,
      },
      bundle: true,
      format: 'iife',
      platform: 'browser',
      write: false,
    });
    const dir = await mkdtemp(path.join(tmpdir(), 'watch-notes-label-test-'));
    const app = express();
    app.get('/', (_req, res) => res.type('html').send('<script src="/test.js"></script>'));
    app.get('/test.js', (_req, res) => res.type('js').send(compiled.outputFiles[0].text));
    const http = createServer(app);
    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    const group = await createRenderMemoryGroup(dir, 2 * GiB, 400);
    let browser;
    try {
      browser = await puppeteer.launch({
        executablePath: await group.chromeLauncher(await findChrome()),
        headless: true,
        pipe: true,
        networkEnabled: false,
        env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/dev/null' },
        args: ['--disable-gpu'],
      });
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${(http.address() as { port: number }).port}/`);
      const result = await page.evaluate(() =>
        (
          window as unknown as {
            checkLabels: () => {
              count: number;
              offset: number;
              headClearance: number;
              featuredLabels: string[];
              wideLabels: number;
              readable: { scale: number; aspect: number; count: number }[];
              fog: boolean;
              toneMapped: boolean;
              opacity: number;
              texturesDisposed: number;
              materialsDisposed: number;
              remaining: number;
              samples: { height: number; pixels: number; visible: boolean }[];
            };
          }
        ).checkLabels(),
      );
      assert.equal(result.count, 4, 'A piano grand staff needs one label');
      for (const sample of result.samples) {
        assert.equal(sample.visible, true);
        assert.ok(
          Math.abs(sample.pixels - Math.max(34, sample.height * 0.05)) < 0.001,
          `Projected nameplate height drifted: ${JSON.stringify(sample)}`,
        );
      }
      assert.equal(result.offset, 15);
      assert.ok(result.headClearance > 0.2, 'Nameplates must clear the raised performers');
      assert.deepEqual(result.featuredLabels, ['label:violin']);
      assert.equal(result.wideLabels, 0);
      for (const sample of result.readable) assert.equal(sample.count, 1, JSON.stringify(sample));
      assert.equal(result.fog, false);
      assert.equal(result.toneMapped, false);
      assert.equal(result.opacity, 1);
      assert.equal(result.texturesDisposed, 4);
      assert.equal(result.materialsDisposed, 4);
      assert.equal(result.remaining, 0);
    } finally {
      await browser?.close();
      await group.stop();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  },
);
