import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FlyingLights } from './flying-lights';
import { Musicians } from './musicians';
import { MusicianLabels } from './musician-labels';
import { CinematicDirector } from './cinematic-director';
import {
  audibleTracks,
  scoreLanes,
  scorePosition,
  partLanes,
  noteLane,
  type StaffLane,
} from './orchestra';
import {
  DEFAULT_SETTINGS,
  getBars,
  THEMES,
  type Song,
  type SceneSettings,
  type Note,
} from './project';

type NoteVisual = {
  group: THREE.Group;
  material: THREE.MeshStandardMaterial;
  trail?: THREE.Mesh;
  note: Note;
  trackId: string;
};
const UP = new THREE.Vector3(0, 1, 0);
export class ScoreRenderer {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(36, 16 / 9, 0.1, 700);
  private music = new THREE.Group();
  private score = new THREE.Group();
  private flyingLights = new FlyingLights();
  private musicians = new Musicians();
  private musicianLabels = new MusicianLabels();
  private partLabels = new THREE.Group();
  private lanes: StaffLane[] = [];
  private director?: CinematicDirector;
  private shotKey = '';
  private staffMaterials = new Map<string, THREE.MeshBasicMaterial>();
  private span = 13;
  private notes = new Map<string, NoteVisual>();
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private grid: THREE.GridHelper;
  private playhead: THREE.Mesh;
  private textures: THREE.Texture[] = [];
  private song: Song;
  private settings: SceneSettings;
  private width = 1280;
  private height = 720;
  private disposed = false;
  private readback: WebGLBuffer | null = null;
  private readbackBytes = 0;
  private nextWindow = -Infinity;
  private activeNotes: { note: Note; trackId: string }[] = [];
  private noteHead: THREE.ExtrudeGeometry;
  private hollowHead: THREE.ExtrudeGeometry;
  private stemGeo = new THREE.BoxGeometry(0.055, 1.18, 0.065);

  constructor(canvas: HTMLCanvasElement, song: Song, settings: SceneSettings, pixelRatio = 1) {
    this.song = song;
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(pixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.scene.add(new THREE.HemisphereLight('#e4ebe3', '#1b2528', 2.2));
    const key = new THREE.DirectionalLight('#fff1d4', 3);
    key.position.set(-5, 12, 8);
    this.scene.add(key);
    this.music.rotation.x = -Math.PI / 2;
    this.music.add(this.score);
    this.music.add(this.flyingLights.group);
    this.music.add(this.musicians.group);
    this.music.add(this.partLabels);
    this.scene.add(this.music);
    this.grid = new THREE.GridHelper(400, 200, '#263330', '#1c2725');
    this.grid.position.y = -0.065;
    this.scene.add(this.grid);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(1200, 500),
      new THREE.MeshStandardMaterial({ color: '#101615', roughness: 0.9, metalness: 0.08 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.09;
    this.scene.add(floor);
    this.playhead = new THREE.Mesh(
      new THREE.BoxGeometry(0.014, 13, 0.018),
      new THREE.MeshBasicMaterial({ color: '#e9c48d', transparent: true, opacity: 0.23 }),
    );
    this.playhead.position.z = 0.035;
    this.music.add(this.playhead);
    const shape = new THREE.Shape();
    shape.absellipse(0, 0, 0.24, 0.145, -0.1, Math.PI * 2 - 0.1, false, 0.32);
    this.noteHead = new THREE.ExtrudeGeometry(shape, {
      depth: 0.09,
      bevelEnabled: true,
      bevelThickness: 0.022,
      bevelSize: 0.015,
      bevelSegments: 2,
      steps: 1,
      curveSegments: 12,
    });
    const hollowShape = shape.clone();
    const hole = new THREE.Path();
    hole.absellipse(0, 0, 0.14, 0.075, 0, Math.PI * 2, true, 0.32);
    hollowShape.holes.push(hole);
    this.hollowHead = new THREE.ExtrudeGeometry(hollowShape, {
      depth: 0.09,
      bevelEnabled: true,
      bevelThickness: 0.016,
      bevelSize: 0.01,
      bevelSegments: 2,
      curveSegments: 12,
    });
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1280, 720), 1.05, 0.55, 0.9);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.buildScore();
    this.resize(1280, 720);
    this.render(0);
  }
  private label(text: string, size: number, color: string): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 128;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = color;
    ctx.font = /[𝄞𝄢]/u.test(text)
      ? '58px "Noto Music", serif'
      : text.length > 5
        ? '22px Georgia, serif'
        : '40px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 128, 64);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    this.textures.push(texture);
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        opacity: 0.58,
        depthWrite: false,
      }),
    );
    sprite.scale.set(size * 2, size, 1);
    return sprite;
  }
  private buildScore() {
    this.clearGroup(this.score);
    this.textures.forEach((t) => t.dispose());
    this.textures = [];
    this.clearGroup(this.partLabels);
    this.staffMaterials.clear();
    this.lanes = scoreLanes(this.song, this.settings);
    const orchestra = this.settings.layout === 'orchestra';
    const centers = orchestra ? this.lanes.map((l) => l.center) : [3.3, -3.3];
    this.span = orchestra ? Math.max(10, (centers[0] ?? 0) - (centers.at(-1) ?? 0) + 5) : 13;
    this.playhead.scale.y = this.span / 13;
    this.musicians.setLanes(orchestra ? this.lanes : []);
    this.musicianLabels.setLanes(orchestra ? this.lanes : []);
    this.planCamera();
    this.flyingLights.setSong(this.song, this.settings);
    const end = this.song.duration * this.settings.spacing + 55;
    const bars = getBars(this.song);
    for (const [index, center] of centers.entries()) {
      const id = orchestra ? this.lanes[index].track.id : '';
      let lineMat = this.staffMaterials.get(id);
      if (!lineMat) {
        lineMat = new THREE.MeshBasicMaterial({
          color: '#718079',
          transparent: true,
          opacity: 0.34,
        });
        this.staffMaterials.set(id, lineMat);
      }
      for (let i = -2; i <= 2; i++) {
        const line = new THREE.Mesh(new THREE.BoxGeometry(end + 35, 0.016, 0.014), lineMat);
        line.position.set((end - 35) / 2, center + i * 0.52, 0);
        this.score.add(line);
      }
      const barLines = new THREE.InstancedMesh(
        new THREE.BoxGeometry(0.023, 2.08, 0.018),
        lineMat,
        bars.length,
      );
      const matrix = new THREE.Matrix4();
      bars.forEach((bar, i) =>
        barLines.setMatrixAt(
          i,
          matrix.makeTranslation(bar.time * this.settings.spacing, center, 0.01),
        ),
      );
      barLines.instanceMatrix.needsUpdate = true;
      this.score.add(barLines);
    }
    for (const bar of bars) {
      const x = bar.time * this.settings.spacing;
      const text = this.label(String(bar.number).padStart(2, '0'), 0.55, '#7a8c81');
      text.position.set(x, (centers[0] ?? 3.3) + 2, 0.05);
      this.score.add(text);
    }
    if (orchestra) {
      partLanes(this.lanes).forEach((lane) => {
        if (lane.grandStaff) {
          const staves = this.lanes.filter((l) => l.track.id === lane.track.id);
          const top = staves[0].center + 1.04,
            bottom = staves[1].center - 1.04;
          const material = new THREE.MeshBasicMaterial({
            color: lane.track.color,
            transparent: true,
            opacity: 0.65,
          });
          const bracket = new THREE.Mesh(new THREE.BoxGeometry(0.05, top - bottom, 0.04), material);
          bracket.position.set(-2.8, (top + bottom) / 2, 0.1);
          bracket.userData.trackId = lane.track.id;
          this.partLabels.add(bracket);
          for (const y of [top, bottom]) {
            const tip = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.05, 0.04), material);
            tip.position.set(-2.65, y, 0.1);
            tip.userData.trackId = lane.track.id;
            this.partLabels.add(tip);
          }
        }
      });
      this.lanes.forEach((lane) => {
        const clef = this.label(
          lane.clef === 'bass' ? '𝄢' : lane.clef === 'percussion' ? 'Ⅱ' : '𝄞',
          2.2,
          lane.track.color,
        );
        clef.position.set(-1.8, lane.center, 0.15);
        clef.userData.trackId = lane.track.id;
        this.partLabels.add(clef);
      });
    } else {
      for (const [i, center] of centers.entries()) {
        const clef = this.label(i ? '𝄢' : '𝄞', 2.5, '#b3bdb6');
        clef.position.set(-2, center, 0.2);
        this.score.add(clef);
      }
    }
    const ids = new Set(this.lanes.map((l) => l.track.id));
    this.activeNotes = audibleTracks(this.song)
      .filter((t) => !orchestra || ids.has(t.id))
      .flatMap((t) => t.notes.map((note) => ({ note, trackId: t.id })))
      .sort((a, b) => a.note.time - b.note.time);
    this.clearNotes();
    this.nextWindow = -Infinity;
  }
  private clearGroup(group: THREE.Group) {
    group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        if (obj instanceof THREE.InstancedMesh) obj.dispose();
        if (
          obj.geometry !== this.noteHead &&
          obj.geometry !== this.hollowHead &&
          obj.geometry !== this.stemGeo
        )
          obj.geometry.dispose();
        const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
        materials.forEach((m) => m.dispose());
      } else if (obj instanceof THREE.Sprite) obj.material.dispose();
    });
    group.clear();
  }
  private clearNotes() {
    for (const n of this.notes.values()) {
      this.music.remove(n.group);
      this.clearGroup(n.group);
    }
    this.notes.clear();
  }
  private makeNote(note: Note, trackId: string): NoteVisual {
    const position = scorePosition(note.midi, trackId, this.lanes, this.settings.layout),
      center =
        this.settings.layout === 'orchestra'
          ? noteLane(note.midi, trackId, this.lanes)!.center
          : position.staff === 0
            ? 3.3
            : -3.3;
    const group = new THREE.Group();
    group.position.set(note.time * this.settings.spacing, position.y, 0.05);
    const material = new THREE.MeshStandardMaterial({
      color: THEMES[this.settings.theme].note,
      roughness: 0.32,
      metalness: 0.3,
      emissive: THEMES[this.settings.theme].accent,
      emissiveIntensity: 0,
    });
    const beats = note.durationTicks / this.song.ppq;
    const head = new THREE.Mesh(beats >= 1.7 ? this.hollowHead : this.noteHead, material);
    if (beats >= 3.6) head.scale.x = 1.18;
    group.add(head);
    const down = position.y > center + 0.3,
      sign = down ? -1 : 1;
    if (beats < 3.6) {
      const stem = new THREE.Mesh(this.stemGeo, material);
      stem.position.set(sign * 0.2, sign * 0.55, 0.025);
      group.add(stem);
      const flags = beats < 0.36 ? 2 : beats < 0.8 ? 1 : 0;
      for (let i = 0; i < flags; i++) {
        const curve = new THREE.CubicBezierCurve3(
          new THREE.Vector3(sign * 0.2, sign * (1.1 - i * 0.23), 0.05),
          new THREE.Vector3(sign * 0.7, sign * (0.88 - i * 0.23), 0.05),
          new THREE.Vector3(sign * 0.78, sign * (0.72 - i * 0.23), 0.05),
          new THREE.Vector3(sign * 0.5, sign * (0.49 - i * 0.23), 0.05),
        );
        group.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 12, 0.045, 4, false), material));
      }
    }
    // Ledger lines use diatonic staff steps, not chromatic semitone positions.
    for (let y = center - 1.56; y >= position.y - 0.03; y -= 0.52) {
      const line = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.018, 0.015), material);
      line.position.y = y - position.y;
      group.add(line);
    }
    for (let y = center + 1.56; y <= position.y + 0.03; y += 0.52) {
      const line = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.018, 0.015), material);
      line.position.y = y - position.y;
      group.add(line);
    }
    if (position.accidental) {
      for (const offset of [-0.09, 0.09]) {
        const sharp = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.48, 0.04), material);
        sharp.position.set(-0.48 + offset, 0, 0.02);
        group.add(sharp);
        const bar = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.045, 0.04), material);
        bar.rotation.z = 0.18;
        bar.position.set(-0.48, offset, 0.02);
        group.add(bar);
      }
    }
    let trail: THREE.Mesh | undefined;
    if (this.settings.trails && note.duration > 0.35) {
      const length = Math.max(0.35, note.duration * this.settings.spacing);
      const curve = new THREE.CubicBezierCurve3(
        new THREE.Vector3(0.15, 0.04, 0.04),
        new THREE.Vector3(length * 0.28, 0.45, 0.32),
        new THREE.Vector3(length * 0.8, 0.38, 0.18),
        new THREE.Vector3(length, 0, 0.02),
      );
      trail = new THREE.Mesh(
        new THREE.TubeGeometry(curve, 24, 0.016, 4, false),
        new THREE.MeshBasicMaterial({
          color: THEMES[this.settings.theme].trail,
          transparent: true,
          opacity: 0.12,
        }),
      );
      group.add(trail);
    }
    group.scale.setScalar(this.settings.noteScale);
    this.music.add(group);
    return { group, material, trail, note, trackId };
  }
  setSong(song: Song) {
    this.song = song;
    this.buildScore();
  }
  private planCamera() {
    this.director =
      this.settings.layout === 'orchestra' && this.settings.cameraMode === 'cinematic'
        ? new CinematicDirector(this.song, this.settings, this.lanes)
        : undefined;
    this.shotKey = '';
    this.nextWindow = -Infinity;
  }
  setSettings(settings: SceneSettings) {
    settings = { ...DEFAULT_SETTINGS, ...settings };
    const rebuild =
      settings.spacing !== this.settings.spacing ||
      settings.trails !== this.settings.trails ||
      settings.noteScale !== this.settings.noteScale ||
      settings.theme !== this.settings.theme ||
      settings.layout !== this.settings.layout ||
      settings.staffGap !== this.settings.staffGap ||
      settings.focusTrack !== this.settings.focusTrack;
    const replan =
      settings.cameraMode !== this.settings.cameraMode ||
      settings.cameraPacing !== this.settings.cameraPacing ||
      settings.cameraTrack !== this.settings.cameraTrack ||
      settings.musicians !== this.settings.musicians;
    this.settings = settings;
    this.nextWindow = -Infinity;
    if (rebuild) this.buildScore();
    else if (replan) this.planCamera();
  }
  resize(width: number, height: number) {
    if (!width || !height) return;
    this.width = width;
    this.height = height;
    this.renderer.setSize(width, height, false);
    this.composer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }
  render(time: number) {
    if (this.disposed) return;
    const settings = this.settings,
      theme = THEMES[settings.theme],
      cursor = time * settings.spacing;
    const directed = this.director?.at(time, this.camera.aspect);
    const featured = directed?.featured;
    const shotKey = directed ? `${directed.index}:${[...(featured ?? [])].join(',')}` : '';
    if (shotKey !== this.shotKey) {
      this.shotKey = shotKey;
      this.nextWindow = -Infinity;
    }
    this.scene.background = new THREE.Color(theme.background);
    this.scene.fog = new THREE.FogExp2(theme.background, 0.012);
    this.grid.visible = settings.grid;
    this.grid.position.x = Math.floor(cursor / 2) * 2;
    if (Math.abs(time - this.nextWindow) > 0.3) {
      this.nextWindow = time;
      const min = directed
          ? time - 22 / settings.spacing
          : settings.follow
            ? time - 14 / settings.zoom
            : -10,
        max = directed
          ? time + 16 / settings.spacing
          : settings.follow
            ? time + 22 / settings.zoom
            : 35 / settings.zoom;
      const perPart = new Map<string, number>();
      const allowance = Math.max(24, Math.floor(1800 / Math.max(1, partLanes(this.lanes).length)));
      const candidates = this.activeNotes.filter(
        ({ note }) => note.time + note.duration > min && note.time < max,
      );
      if (featured)
        candidates.sort(
          (a, b) => Number(featured.has(b.trackId)) - Number(featured.has(a.trackId)),
        );
      const visible = candidates
        .filter(({ note, trackId }) => {
          if (note.time + note.duration <= min || note.time >= max) return false;
          const count = perPart.get(trackId) ?? 0;
          const budget = featured
            ? featured.has(trackId)
              ? Math.floor(1500 / featured.size)
              : 8
            : allowance;
          if (count >= budget) return false;
          perPart.set(trackId, count + 1);
          return true;
        })
        .slice(0, 1800);
      const ids = new Set(visible.map((n) => n.note.id));
      for (const [id, visual] of this.notes)
        if (!ids.has(id)) {
          this.music.remove(visual.group);
          this.clearGroup(visual.group);
          this.notes.delete(id);
        }
      for (const { note, trackId } of visible)
        if (!this.notes.has(note.id)) this.notes.set(note.id, this.makeNote(note, trackId));
    }
    for (const v of this.notes.values()) {
      const emphasis = !featured || featured.has(v.trackId) ? 1 : 0.12;
      const elapsed = time - v.note.time,
        active = elapsed >= 0 && elapsed < v.note.duration;
      const fade =
        elapsed >= v.note.duration ? Math.max(0, 1 - (elapsed - v.note.duration) / 0.6) : 0;
      const intensity = active ? 2.9 + Math.exp(-elapsed * 10) * 1.3 : fade * 1.2;
      const accent =
        settings.layout === 'orchestra'
          ? (this.lanes.find((l) => l.track.id === v.trackId)?.track.color ?? theme.accent)
          : theme.accent;
      v.material.emissive.set(accent);
      v.material.emissiveIntensity = intensity * emphasis;
      v.material.color.set(active ? accent : elapsed > 0 ? '#6d756e' : theme.note);
      v.material.color.multiplyScalar(emphasis);
      if (v.trail) {
        const m = v.trail.material as THREE.MeshBasicMaterial;
        m.opacity = (active ? 0.7 : elapsed > 0 ? 0.1 : 0.15) * emphasis;
        m.color.set(active ? accent : theme.trail);
      }
    }
    for (const [id, material] of this.staffMaterials)
      material.opacity = !featured || featured.has(id) ? 0.34 : 0.045;
    for (const child of this.partLabels.children) {
      if (child instanceof THREE.Sprite)
        child.material.opacity = !featured || featured.has(child.userData.trackId) ? 0.58 : 0.08;
      else if (child instanceof THREE.Mesh)
        (child.material as THREE.MeshBasicMaterial).opacity =
          !featured || featured.has(child.userData.trackId) ? 0.65 : 0.08;
    }
    if (directed) {
      this.camera.position.copy(directed.position);
      this.camera.up.copy(UP);
      this.camera.lookAt(directed.target);
      const distance = directed.position.distanceTo(directed.target);
      this.camera.far = Math.max(700, distance * 3);
      this.camera.updateProjectionMatrix();
      (this.scene.fog as THREE.FogExp2).density = 0.28 / Math.max(20, distance);
    } else {
      const targetX = (settings.follow ? cursor : 0) + 5 / settings.zoom;
      const elevation = THREE.MathUtils.degToRad(settings.angle),
        azimuth = THREE.MathUtils.degToRad(settings.azimuth),
        distance = Math.max(28, this.span * 1.4 + 12) / settings.zoom;
      this.camera.position.set(
        targetX + Math.sin(azimuth) * Math.cos(elevation) * distance,
        Math.sin(elevation) * distance,
        Math.cos(azimuth) * Math.cos(elevation) * distance,
      );
      this.camera.up.copy(UP);
      this.camera.lookAt(targetX, 0, 0);
    }
    this.playhead.position.x = cursor;
    this.partLabels.position.x = directed || settings.follow ? cursor : 0;
    this.musicians.render(time, cursor, settings, featured);
    this.flyingLights.render(time, settings, featured);
    this.bloom.strength = settings.glow;
    this.composer.render(0);
    this.musicianLabels.update(this.camera, this.height, cursor, directed?.labels);
    // Composite nameplates last so bloom and fog cannot wash out the text.
    const autoClear = this.renderer.autoClear;
    this.renderer.autoClear = false;
    try {
      this.renderer.clearDepth();
      this.renderer.render(this.musicianLabels.scene, this.camera);
    } finally {
      this.renderer.autoClear = autoClear;
    }
  }
  async frame(): Promise<Blob> {
    const gl = this.renderer.getContext();
    if (gl.isContextLost()) throw new Error('The video renderer lost its graphics context.');
    return new Promise((resolve, reject) =>
      this.renderer.domElement.toBlob((blob) => {
        if (gl.isContextLost()) reject(new Error('The video renderer lost its graphics context.'));
        else if (blob) resolve(blob);
        else reject(new Error('Could not capture a video frame.'));
      }, 'image/png'),
    );
  }
  /** Lossless bottom-up RGBA, for the local encoder without PNG compression. */
  async readFrame(target: Uint8Array) {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    if (gl.isContextLost()) throw new Error('The video renderer lost its graphics context.');
    if (target.length !== gl.drawingBufferWidth * gl.drawingBufferHeight * 4)
      throw new Error('Incorrect raw frame buffer size.');
    // A pixel-pack buffer lets GPU work finish without a synchronous readPixels
    // stall in Chrome's renderer process. Reuse its allocation for the entire clip.
    this.readback ??= gl.createBuffer();
    if (!this.readback) throw new Error('Could not allocate the video frame buffer.');
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.readback);
    if (this.readbackBytes !== target.byteLength) {
      gl.bufferData(gl.PIXEL_PACK_BUFFER, target.byteLength, gl.STREAM_READ);
      this.readbackBytes = target.byteLength;
    }
    gl.readPixels(
      0,
      0,
      gl.drawingBufferWidth,
      gl.drawingBufferHeight,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      0,
    );
    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.flush();
    if (!fence) throw new Error('Could not read the rendered video frame.');
    const started = performance.now();
    try {
      for (;;) {
        const status = gl.clientWaitSync(fence, 0, 0);
        if (status === gl.WAIT_FAILED || gl.isContextLost())
          throw new Error('The video renderer lost its graphics context.');
        if (status !== gl.TIMEOUT_EXPIRED) break;
        if (performance.now() - started > 15000)
          throw new Error('The GPU stopped responding while reading a video frame.');
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.readback);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, target);
      if (gl.isContextLost()) throw new Error('The video renderer lost its graphics context.');
    } finally {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.deleteSync(fence);
    }
  }
  graphicsDevice() {
    const gl = this.renderer.getContext();
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    return String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  }
  dispose() {
    this.disposed = true;
    if (this.readback) this.renderer.getContext().deleteBuffer(this.readback);
    this.music.remove(this.musicians.group);
    this.musicians.dispose();
    this.musicianLabels.dispose();
    this.clearGroup(this.partLabels);
    this.music.remove(this.flyingLights.group);
    this.flyingLights.dispose();
    this.clearNotes();
    this.clearGroup(this.score);
    this.scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        const ms = Array.isArray(obj.material) ? obj.material : [obj.material];
        ms.forEach((m) => m.dispose());
      }
    });
    this.textures.forEach((t) => t.dispose());
    this.noteHead.dispose();
    this.hollowHead.dispose();
    this.stemGeo.dispose();
    for (const pass of this.composer.passes) pass.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
