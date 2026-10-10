# Watch Notes

A local web app that turns MIDI files into animated 3D scores and MP4 videos.

## Run

Requires Node.js 22.13 or newer and a modern browser with WebGL 2. Server rendering also needs Chrome or Chromium installed on the server (`CHROME_PATH` can specify its executable).

```sh
git clone https://github.com/serhii-samborskyi/WatchNotes.git
cd WatchNotes
npm install
npm run dev
```

Open **http://localhost:3002**. The command starts the React app and the local Node export service together. FFmpeg is installed through `ffmpeg-static`; no separate desktop app or cloud account is needed. The export service listens only on `127.0.0.1:4311`.

The web app also listens on the local network. From another device on the same network, open **http://10.0.0.138:3002** (or this computer's current LAN IP). Video exports use the same address through the app's proxy; port 4311 stays private to the server computer.

To run an optimized build:

```sh
npm run build
npm start
```

Both services must be running for video export. If port 3002 is already occupied, stop the other service or change the web port in `package.json` and set `APP_PORT` to the same port so LAN exports remain authorized. `APP_ORIGIN` can allow a specific custom app origin. When changing the export port, update `EXPORT_PORT`, the proxy in `vite.config.ts`, and `app/api/export/[...path]/route.ts` together. `FFMPEG_PATH` can point to an existing FFmpeg executable instead of the bundled one.

## Use

- Press Play to hear **The little orchestra**, an original quartet for piano, violin, flute and percussion. **Piano demo** loads the original First light study.
- Import or drop a `.mid` / `.midi` file. Each part gets its own staves and performer. Piano and keyboard sounds get a linked treble-and-bass pair with a single pianist. Performers default to 2.2× size and can be adjusted up to 4×. Expand a track to choose an instrument or musician, mute/solo, adjust volume/color/size/position, share another part’s performer, or reorder staves. Muted tracks are hidden and excluded from audio/export; Solo includes only enabled solo parts.
- Musicians use adult proportions, concert suits, articulated hands and detailed instruments. Track names appear in bright, camera-facing nameplates above the performers. Their text stays the same size when zooming and is drawn after glow and fog, including in exported videos.
- Performers face right toward upcoming notes and ride together on one raised wooden platform with a metal frame and small wheels. Its continuous deck fits the visible orchestra, including instrument sizes and performer position edits, and keeps everyone at one height. Wheels turn with score distance and stay synchronized when seeking or exporting. Turning camera follow off lets the platform travel across the fixed view.
- Choose **Camera → Cinematic Orchestra** for large scores. The automatic director combines solo close-ups, small sections and occasional wide shots, using note entrances, velocity, sustained activity and recent camera attention. **Calm / Balanced / Energetic** controls shot length (approximately 6–10 / 4–8 / 3–5 seconds of song time). Changes prefer bar boundaries; nearby subjects use eased moves and distant sections use cuts. The opening shot is close enough to see a performer immediately.
- **Feature this track** holds the cinematic camera on one part without changing audio. **Automatic director** restores shot selection. Close shots frame the performer alongside upcoming notes, preserve both piano staves, dim the other score parts and prioritize the featured note lights. Only featured performers and their non-overlapping labels are shown in close shots; wide shots show the whole orchestra with labels hidden. Static mode restores manual orbit, elevation, zoom and follow controls.
- Scrub the timeline; use Space to play/pause, arrow keys to seek five seconds, and Home to return to the start. Change playback speed with the speed menu.
- Drag the scene to orbit the camera. Adjust the scene preset, elevation, zoom, glow, note spacing, camera following, duration trails, and grid in the right panel.
- **Note spacing** ranges from **1.2× to 20×** to spread out fast, dense passages. The chosen spacing is saved with the project and used in video exports.
- **Note lights** adds glowing comets that travel between successive notes, with separate paths for chord tones. Adjust light brightness, trail length, and arc height, or switch the effect off. Lights arrive at the next note's onset, follow scrubbing and playback speed, and appear in exported videos. Old project files receive the new defaults automatically.
- **Save** downloads a `.watchnotes.json` project containing all notes and scene settings. **Open project** restores it. Save before refreshing; projects are not automatically stored in the browser.
- **Export video** supports 720p / 1080p, 24 / 30 / 60 fps, a selected time range, and optional synthesized audio. The video contains the 3D scene without editor overlays. Keep the tab open while it renders. Exports follow the selected playback speed.

MIDI import happens locally in the browser. Server exports send the normalized notes and scene settings once to the computer running the app. All frame rendering, synthesized audio, and video encoding then happen there; individual frames never cross your LAN. The **This device** fallback sends PNG frames and WAV audio to that same server. Temporary exports are deleted after download, cancellation, or 30 minutes without activity. There is no cloud upload service.

## Faster exports and GPU setup

**Export video → Render with → Server** uses the same Three.js scene and selected audio engine as the preview. It captures uncompressed RGBA through asynchronous GPU readback, double-buffers local frame uploads, and overlaps audio generation with rendering and H.264 encoding. The API streams frame chunks directly into FFmpeg with backpressure instead of buffering a multi-megabyte HTTP body for every batch. Contiguous segments can render in separate Chrome pages and FFmpeg processes, then join without re-encoding. Frames use their absolute song time, including across segment boundaries and at different playback speeds.

The export dialog offers **Server resource target**, from **20–95%**, default **80%**, and **Render workers → Automatic or 1–8**. Automatic ramps concurrency up as CPU, RAM, and GPU capacity permit; a manual count is a maximum. This is a capacity target, not a promise that every component will reach that utilization. GPU-heavy scenes, capture latency, encoding, and short clips can limit throughput.

The target sets a kernel CPU ceiling across all renderer/encoder processes (80% on 24 logical CPUs is 19.2 CPU equivalents), with lower CPU/IO scheduling weight and nice priority so other apps can take precedence. For RAM it targets **total server use**, leaving the larger of 2 GiB or the unselected percentage available, plus 512 MiB for API overhead. The render allowance accounts for currently available host/container RAM and the export's own working set, and can grow when other apps release memory. Progress shows the actual enforced render cap. On NVIDIA servers, sampled GPU utilization and free VRAM also guide concurrency; GPU percentage is approximate, not a hardware quota. Other adapters retain CPU/RAM controls.

Exports run as short two-second segments, rendered at absolute song times and joined in order without re-encoding. Every 500 ms the scheduler checks host headroom and renderer RAM. It adds workers gradually, drains them under pressure, and waits for memory without discarding finished segments. At more severe pressure it retires unfinished segments and requeues only those segments. Reclaimable file cache is excluded from the working-set reading. Waiting is shown in the dialog, is cancellable, and does not trigger the stalled-renderer watchdog. Closed worker streams are released after each segment.

**Server exports require Linux, cgroup v2, and a working systemd user session.** Chrome and FFmpeg share a verified kernel `MemoryMax`, with reclaim/throttling at `MemoryHigh` and `MemorySwapMax=0`. The API/editor and other applications remain outside the render unit. The new percentage mode **does not abort at the old 80% RAM cutoff** or reject a scene based on the previous 2–3 GiB-per-worker estimate. Kernel OOM or critically low host RAM can still stop an export as a final backstop; no application can guarantee immunity from another process exhausting the host or from driver failures. Older API clients that omit `resourcePercent` retain the explicit `memoryLimitGiB` protocol and its previous protection. See the [Linux resource controls](https://docs.kernel.org/admin-guide/cgroup-v2.html).

Software capture uses lossless PNG; `EXPORT_CAPTURE=rgba` or `png` remains available for benchmarking. CPU encoding shares up to eight threads per worker. Compare a short section before choosing more workers: higher utilization does not by itself imply a faster export.

Headless render workers disable Puppeteer's network-event monitoring: leaving it on mirrors and decodes large binary frame uploads through DevTools, causing long stalls even when the CPU/GPU are mostly idle. The worker's content security policy continues to restrict network access to its own server. Every new export also warms up its fresh graphics process before starting workers. Headless Chrome gets an isolated session-bus address so desktop integration cannot move it into an unlimited application scope. The server checks its cgroup before rendering; an integration test also verifies that Chrome's browser, renderer, and GPU processes share the selected kernel memory cap. Set `EXPORT_PROFILE=1` to log each worker's drawing, capture, and upload timings (these stages overlap).

If a graphics context is lost, the browser crashes, or video rendering makes no progress for 60 seconds, the renderer retries with fewer workers. A second graphics failure switches to one software-rendering worker and CPU H.264 encoding. There are at most three attempts. **Completed video segments and completed audio are preserved across these attempts.** A segment is saved only after FFmpeg closes it successfully, by atomically moving it outside the attempt directory. The original frame boundaries and timestamps stay fixed; subsequent attempts render only missing segments. H.264 profile, level, pixel format, and timebase are consistent across hardware/CPU encoders. Failed uploads cannot change the next attempt: worker credentials rotate before cleanup. Only unfinished segments are discarded, and progress never falls below the saved frame count. Cancellation or deleting the job still removes all its temporary files; checkpoints are for recovery within the current job, not resuming after a server restart.

Audio renders concurrently in its own protected browser page. In **Soft keys** mode it uses native Web Audio automation. The triangle oscillator, pitch, velocity, volume, attack, decay, sustain, and release use the same parameters as the Tone-based live preview. A bounded pool of up to 96 gain envelopes avoids the large Tone offline control-signal graph that previously occupied one CPU core long after video finished. Native sample scheduling may differ from Tone’s block-scheduled waveform phase; voice amplitude and envelope, timing, speed changes, note tails, muting, stereo output, and WAV format are tested. WAV packing yields in small batches so progress and cancellation remain responsive. The dialog displays soundtrack progress separately from overall export progress and hides completed video-worker statistics during audio synthesis. After video frames are saved, the dialog shows **Rendering audio…** if the soundtrack still needs time. The video watchdog is stopped at that boundary, so a slow soundtrack cannot be misclassified as a graphics stall and restart the video. Audio has a separate two-minute no-progress timeout. Final assembly uses the ordered saved segments and the saved WAV; frame counts and decoding across an NVENC-to-CPU fallback are tested. Both raw and PNG capture reject lost contexts; asynchronous readback has a 15-second GPU wait limit and reuses its pixel-buffer allocation. Detailed errors stay in server logs.

The service checks system FFmpeg, the optional app-local build, and the bundled CPU build. It selects NVIDIA H.264 only after a real NVENC test succeeds. `FFMPEG_PATH` overrides detection. To add the distribution FFmpeg without changing system packages on Ubuntu x86_64:

```sh
sh scripts/install-local-ffmpeg.sh
```

This downloads Ubuntu packages and extracts them under `.cache/ffmpeg`; the service discovers that build automatically. Alternatively, install FFmpeg normally with `sudo apt install ffmpeg`. Restart the export service after changing drivers or encoders so it probes the hardware again. GPU rendering and NVENC encoding are separate capabilities; either can fall back to the CPU.

After the server reboot on October 9, 2026, the RTX 3060's loaded module and installed libraries both report **595.91.07**. NVIDIA H.264 encoding and hardware WebGL rendering pass their live checks. Linux render workers explicitly select ANGLE's Vulkan backend; Chrome's default headless configuration was still choosing software graphics. The NVENC probe uses 720p because a 128-pixel frame is below this encoder's supported minimum. See [Chrome's headless GPU guidance](https://developer.chrome.com/blog/supercharge-web-ai-testing) and [Ubuntu's driver mismatch guidance](https://ubuntu.com/server/docs/nvidia-drivers-installation/).

Compare the two actual export paths using an isolated headless renderer (no editor UI):

```sh
npm run benchmark:export
# Optional: EXPORT_BENCH_SECONDS=10 npm run benchmark:export
# Compare counts: EXPORT_BENCH_SECONDS=10 EXPORT_BENCH_WORKERS=4 npm run benchmark:export
```

The benchmark includes audio and server startup, runs over loopback, and removes its jobs. It reports measured times rather than assuming more workers are always faster. A remote client additionally avoids per-frame network uploads in server mode.

## Scene editing

The project deliberately separates the music from its appearance so new scene styles can be developed without replacing imported MIDI data.

- `lib/project.ts` — versioned song/project types, demo, presets, staff mapping, tempo and bar calculations.
- `lib/score-renderer.ts` — Three.js geometry, materials, lights, glow, camera, and duration trails. `render(time)` is deterministic: preview and export use the same renderer and exact song time.
- `lib/note-flights.ts` — deterministic note-to-note connections, timing, and curved paths. Connections stay within a track and staff and skip gaps longer than eight seconds.
- `lib/flying-lights.ts` — pooled glowing heads, tapered trails, and light cast on the sheet. Up to 48 comets and four point lights keep rendering bounded; no motion depends on the preceding frame.
- `components/ScorePreview.tsx` — canvas lifecycle, sizing, camera dragging.
- `lib/midi.ts` — MIDI import and normalized note data.
- `lib/audio.ts`, `lib/render-audio.ts` — live player and export audio engine selection.
- `lib/orchestra.ts`, `lib/musicians.ts`, `lib/musician-labels.ts` — per-part layout, indexed gestures, original concert performer models and readable nameplates.
- `lib/cinematic-director.ts` — bounded MIDI activity analysis, deterministic shot planning, aspect-aware framing and seekable camera motion.
- `lib/orchestra-synth.ts`, `lib/orchestra-audio-worker.ts`, `lib/orchestra-player.ts` — shared sampled synthesis, bounded playback worker and PCM scheduling.
- `lib/orchestra-demo.ts`, `components/TrackEditor.tsx` — original quartet and saved part/performer controls.
- `lib/export.ts` — server job submission, progress, download, cancellation, and the browser rendering fallback.
- `server/index.ts` — ordered frame ingestion, FFmpeg encoding, audio muxing, job isolation, and cleanup.
- `server/server-export.ts` — isolated headless render workers, raw frame streaming, parallel segment encoding, joining, and cleanup.
- `server/render-page.ts` — browser worker using the shared scene and audio renderer.
- `lib/offline-audio.ts` — native offline soft-key synthesis and bounded WAV packing; shared voice parameters with the live preview.
- `server/render-resources.ts` — CPU/RAM budgets, Chrome discovery, and tested NVENC detection.
- `lib/validation.ts` — validation for saved projects and export jobs.
- `app/page.tsx`, `components/`, `app/globals.css` — editor interface.

For a new visual effect, add its configurable values to `SceneSettings`, defaults, and project validation, expose controls if useful, and derive animation from `time` in `ScoreRenderer.render`. Avoid accumulating frame deltas or unseeded randomness; both make seeking and exported frames diverge. Breaking project-schema changes require a version bump and a migration.

## Current limits

This is a music visualizer, not a complete notation engraver. Orchestra mode uses separate concert-pitch staves. Piano, electric keys, organs and synth keyboard sounds use a grand staff, splitting at middle C; other parts have an automatically chosen treble/bass clef or a simplified percussion lane. Both keyboard staves retain the same source track, audio voice and performer, and their note flights stay within each staff. Combined piano mode keeps the original two staves. Sharps, stems, flags and durations are approximations. It does not infer full voicing, rests, beams, key signatures, transposed notation, expressive markings, fingering or articulation switches. Duration trails are visual guides, not musical ties. Six miniature performer styles (piano, violin, cello, flute, trumpet and percussion) stand in for related instrument families; every GM sound does not yet have a unique model. Gestures use note timing, duration, pitch and velocity, rather than motion capture or exact instrumental technique. Preview pauses when the tab is hidden.

**Orchestra audio** uses SpessaSynth Core 4.3.22 (Apache-2.0) and the locally bundled, unmodified **GeneralUser GS 2.0.3** SoundFont by S. Christian Collins. See `public/sounds/SOURCE.txt` and `LICENSE-GeneralUser-GS.txt`. The ~32 MB bank loads on first sampled playback and is browser-cacheable. There are no runtime CDN requests. MIDI instrument/channel metadata, channel controllers (including sustain, volume, expression and pan), and pitch bends are preserved. Track/program splits use the existing MIDI parser. Unsupported proprietary SysEx, articulation/key-switch interpretation and custom banks are outside this version. The track picker offers common orchestra instruments; other imported GM programs keep their original sound.

Live sampled audio is generated in a Web Worker with a bounded approximately two-second queue of stereo buffers. This works on the existing HTTP LAN address without requiring AudioWorklet or cross-origin isolation. Preview and export share the same synthesis engine, fixed rendering quanta and event ordering; playback speed changes event timing without shifting pitch. Seeking/clip starts restore controllers and retrigger notes still held by their duration or sustain pedal; pre-clip waveform phase/reverb tails are not reconstructed. The sampled engine caps voices at 192, stealing voices in exceptionally dense sections. Offline audio packs PCM into a WAV incrementally with progress, loading the bank only in the audio page (not every video worker). The protected render page permits WebAssembly compilation for the synth’s decoder while keeping scripts and network requests restricted to its own server.

**Orchestra controls** in the right panel switch score layout and audio mode, toggle musicians, adjust staff spacing and focus on one part without muting the rest. Performer poses are computed from absolute song time, so parallel chunks, arbitrary seeks and exported frames use the same motion. Hands, fingers, bows, piano keys and wind/brass valves respond to each part's notes. Static model details are batched by material; shared source geometry and instanced bar lines keep the scene lighter. Nameplates have a dark background, white text and a track-color marker, with size derived from the camera projection instead of camera distance. Save/Open includes all assignments and edits; old projects without orchestra fields retain their original piano layout and soft-key sound.

The cinematic shot timeline is generated from the complete song, independently of playback history or export chunk boundaries. Tempo-aware bar times anchor shot changes; short final shots and unusually long bars may use time boundaries. Camera framing adapts to the preview/export aspect ratio. Pacing and manual featuring are saved in version-1 projects, with static camera defaults for older files. Selection is a musical-activity heuristic, not melody recognition or exact phrase analysis. It does not yet expose a shot-by-shot timeline editor.

MIDI imports support up to 10 MB, 64 tracks, 60,000 notes, and one hour. Exports support up to 10 minutes per clip and one export job at a time across both rendering modes. Dense sections display at most 1,800 nearby notes to bound GPU usage. Export speed depends on graphics hardware, available CPU/RAM, scene density, and selected resolution. Software graphics can be much slower than a working GPU. The scene requires WebGL 2; the app reports an explanatory message when it is unavailable.

The frontend uses the Sites/Vinext React scaffold with Vite; the FFmpeg service is a separate Node process. This version is designed for local use. Hosting it later requires a Node/FFmpeg worker and appropriate private storage and access controls; deploying only the frontend to an edge worker will not provide video export.

## Checks

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

The tests cover MIDI tempo changes, bar placement, diatonic staff mapping, project round trips and invalid input, export limits, actual H.264/AAC MP4 encoding in both modes, exact decoded frame counts, segment partitioning, job authorization, the shared job limit, and cancellation. Export tests require Chrome and start an isolated service on port 14311, then remove temporary files.

## Assets

The built-in piano study is original demo material. The bundled Noto Music font is licensed under the SIL Open Font License; see `public/fonts/OFL.txt`. The social-preview artwork was generated for this project. Runtime visuals are rendered as Three.js geometry.
