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
  'native soundtrack preserves the voice, timing, release, mixing and WAV format',
  { timeout: 60000 },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'watch-notes-audio-test-'));
    const compiled = await build({
      stdin: {
        resolveDir: process.cwd(),
        contents: `
    import * as Tone from 'tone';
    import { renderAudio } from './lib/audio';
    import { SOFT_KEYS } from './lib/offline-audio';
    import { createDemo } from './lib/project';
    async function pcm(song, start, end, volume = 0.7, rate = 1) {
      const progress = [];
      const wav = await renderAudio(song, start, end, volume, rate, value => progress.push(value));
      const view = new DataView(await wav.arrayBuffer());
      const samples = (view.byteLength - 44) / 4;
      const left = Float32Array.from({length:samples}, (_,i) => view.getInt16(44 + i*4,true) / 32768);
      const right = Float32Array.from({length:samples}, (_,i) => view.getInt16(46 + i*4,true) / 32768);
      return {left, right, view, progress};
    }
    function song(notes) {
      const s = createDemo();
      s.tracks = [{...s.tracks[0], notes: notes.map((n,i) => ({...s.tracks[0].notes[0], id:String(i), midi:69, velocity:0.8, time:0, duration:1, ...n}))}];
      return s;
    }
    const rms = a => Math.sqrt(a.reduce((sum,v)=>sum+v*v,0) / a.length);
    window.checkAudio = async () => {
      const reference = await Tone.Offline(() => {
        const out = new Tone.Gain(0.7).toDestination();
        const synth = new Tone.PolySynth(Tone.Synth, SOFT_KEYS).connect(out);
        synth.triggerAttackRelease(440, 1, 0, 0.8*0.75);
      }, 2, 2, 44100);
      const native = await pcm(song([{}]), 0, 2);
      const original = reference.getChannelData(0);
      const error = Float32Array.from(native.left, (value,i)=>value-original[i]);
      const relativeError = rms(error) / rms(original);
      reference.dispose();
      const mute = await pcm(song([{}]), 0, 2, 0);
      const disabledSong = song([{}]); disabledSong.tracks[0].enabled = false;
      const disabled = await pcm(disabledSong,0,2);
      const half = await pcm(song([{}]),0,2,0.35);
      const short = await pcm(song([{duration:0.003}]),0,1);
      const timed = await pcm(song([{time:2.5,duration:0.5}]),2,4,0.7,2);
      const first = timed.left.findIndex(v=>Math.abs(v)>0.00003);
      const window = timed.left.subarray(Math.ceil(0.26*44100),Math.ceil(0.36*44100));
      let crossings = 0; for(let i=1;i<window.length;i++) if(window[i-1]<0 && window[i]>=0)crossings++;
      const held = await pcm(song([{time:0.1,duration:1}]),0.5,1.5);
      const sumSong = song([{}]); sumSong.tracks.push({...sumSong.tracks[0],id:'second'});
      const chord = await pcm(sumSong,0,2);
      const repeated = await pcm(song([{time:0,duration:0.1},{time:1,duration:0.1}]),0,2);
      return {
        relativeError,
        bytes: native.view.byteLength, sampleRate:native.view.getUint32(24,true), channels:native.view.getUint16(22,true), bits:native.view.getUint16(34,true),
        stereoError:rms(Float32Array.from(native.left,(v,i)=>v-native.right[i])),
        mute:rms(mute.left), disabled:rms(disabled.left), volumeRatio:rms(half.left)/rms(native.left),
        chordRatio:rms(chord.left)/rms(native.left),
        shortEnergy:rms(short.left), shortTail:rms(short.left.subarray(Math.ceil(0.66*44100))),
        onset:first/44100, frequency:crossings/0.1, timedSamples:timed.left.length,
        heldStart:rms(held.left.subarray(0,1000)),
        repeatedGap:rms(repeated.left.subarray(Math.ceil(0.76*44100),Math.floor(44100))),
        repeatedSecond:rms(repeated.left.subarray(44100,Math.floor(1.1*44100))),
        progress:native.progress,
      };
    };`,
      },
      bundle: true,
      format: 'iife',
      platform: 'browser',
      write: false,
    });
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
        args: ['--disable-gpu', '--autoplay-policy=no-user-gesture-required'],
      });
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${(http.address() as { port: number }).port}/`);
      const result = await page.evaluate(() =>
        (
          window as unknown as {
            checkAudio: () => Promise<Record<string, number> & { progress: number[] }>;
          }
        ).checkAudio(),
      );
      assert.ok(result.relativeError < 0.005, `Soft-key voice differs: ${result.relativeError}`);
      assert.equal(result.bytes, 44 + 2 * 44100 * 4);
      assert.equal(result.sampleRate, 44100);
      assert.equal(result.channels, 2);
      assert.equal(result.bits, 16);
      assert.equal(result.stereoError, 0);
      assert.equal(result.mute, 0);
      assert.equal(result.disabled, 0);
      assert.ok(Math.abs(result.volumeRatio - 0.5) < 0.003);
      assert.ok(Math.abs(result.chordRatio - 2) < 0.003);
      assert.ok(result.shortEnergy > 0);
      assert.equal(result.shortTail, 0);
      assert.ok(Math.abs(result.onset - 0.25) < 0.001);
      assert.ok(Math.abs(result.frequency - 440) <= 10);
      assert.equal(result.timedSamples, 44100);
      assert.ok(result.heldStart > 0.001);
      assert.equal(result.repeatedGap, 0);
      assert.ok(result.repeatedSecond > 0.001);
      assert.equal(result.progress[0], 0);
      assert.equal(result.progress.at(-1), 1);
      assert.ok(
        result.progress.every((v, i) => v >= 0 && v <= 1 && (!i || v >= result.progress[i - 1])),
      );
    } finally {
      await browser?.close();
      await group.stop();
      await new Promise<void>((r) => http.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    }
  },
);
