import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  musicianKind,
  partLanes,
  DEFAULT_MUSICIAN_SCALE,
  MUSICIAN_X,
  Performance,
  type MusicianKind,
  type StaffLane,
} from './orchestra';
import type { SceneSettings, Track } from './project';

export const MUSICIAN_HEIGHT = 2.18;
export const STAGE_HEIGHT = 0.46;
export const STAGE_WHEEL_RADIUS = 0.14;
export const STAGE_GROUND_CLEARANCE = 0.025;
export const STAGE_SURFACE_HEIGHT = STAGE_HEIGHT * DEFAULT_MUSICIAN_SCALE + STAGE_GROUND_CLEARANCE;
const SEATED_OFFSET = 0.31;
const sits = (kind: MusicianKind) => ['piano', 'cello', 'drums'].includes(kind);
export function musicianHeight(track: Track) {
  return MUSICIAN_HEIGHT - (sits(musicianKind(track)) ? SEATED_OFFSET : 0);
}
type V3 = [number, number, number];
type Hand = { group: THREE.Group; fingers: THREE.Group[] };
type Key = { mesh: THREE.Mesh; midi: number; height: number };
type Figure = {
  root: THREE.Group;
  performer: THREE.Group;
  body: THREE.Group;
  head: THREE.Group;
  arms: THREE.Mesh[];
  hands: Hand[];
  instrument?: THREE.Group;
  bow?: THREE.Group;
  keys: Key[];
  sticks: THREE.Mesh[];
  valves: THREE.Mesh[];
  kind: MusicianKind;
  track: Track;
  center: number;
  performance: Performance;
};
const UP = new THREE.Vector3(0, 1, 0);
function violinShape() {
  const s = new THREE.Shape();
  s.moveTo(0, -0.39);
  s.bezierCurveTo(-0.35, -0.4, -0.36, -0.13, -0.18, -0.05);
  s.bezierCurveTo(-0.11, 0, -0.12, 0.06, -0.22, 0.1);
  s.bezierCurveTo(-0.32, 0.26, -0.18, 0.39, 0, 0.35);
  s.bezierCurveTo(0.18, 0.39, 0.32, 0.26, 0.22, 0.1);
  s.bezierCurveTo(0.12, 0.06, 0.11, 0, 0.18, -0.05);
  s.bezierCurveTo(0.36, -0.13, 0.35, -0.4, 0, -0.39);
  return s;
}
function grandShape() {
  const s = new THREE.Shape();
  s.moveTo(-0.97, 0);
  s.lineTo(0.97, 0);
  s.lineTo(0.97, 0.7);
  s.bezierCurveTo(0.95, 1.45, 0.35, 1.62, -0.05, 1.15);
  s.bezierCurveTo(-0.35, 0.78, -0.65, 0.87, -0.97, 0.82);
  s.closePath();
  return s;
}
function flatShape(points: number[][]) {
  const shape = new THREE.Shape();
  points.forEach(([x, y], i) => (i ? shape.lineTo(x, y) : shape.moveTo(x, y)));
  shape.closePath();
  return new THREE.ShapeGeometry(shape);
}
function geometries() {
  const outline = violinShape();
  const edge = new THREE.CatmullRomCurve3(
    outline.getPoints(64).map((p) => new THREE.Vector3(p.x, p.y, 0.072)),
    true,
  );
  return {
    sphere: new THREE.SphereGeometry(1, 16, 12),
    box: new THREE.BoxGeometry(1, 1, 1),
    cylinder: new THREE.CylinderGeometry(1, 1, 1, 12),
    limb: new THREE.CylinderGeometry(0.82, 1, 1, 12),
    cone: new THREE.CylinderGeometry(1, 0.28, 1, 18),
    hair: new THREE.SphereGeometry(1, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.55),
    torso: new THREE.LatheGeometry(
      [
        [0.68, 0],
        [0.73, 0.06],
        [0.63, 0.38],
        [0.78, 0.76],
        [0.92, 0.91],
        [0.63, 1],
        [0.4, 1.02],
      ].map(([x, y]) => new THREE.Vector2(x, y)),
      20,
    ),
    lapelLeft: flatShape([
      [-0.25, 1.68],
      [-0.075, 1.3],
      [-0.025, 1.66],
      [-0.1, 1.74],
    ]),
    lapelRight: flatShape([
      [0.25, 1.68],
      [0.075, 1.3],
      [0.025, 1.66],
      [0.1, 1.74],
    ]),
    violin: new THREE.ExtrudeGeometry(outline, {
      depth: 0.055,
      bevelEnabled: true,
      bevelSize: 0.015,
      bevelThickness: 0.013,
      bevelSegments: 2,
      curveSegments: 12,
      steps: 1,
    }),
    purfling: new THREE.TubeGeometry(edge, 100, 0.004, 4, true),
    scroll: new THREE.TorusGeometry(0.042, 0.014, 8, 16),
    rim: new THREE.TorusGeometry(1, 0.025, 8, 24),
    cymbal: new THREE.LatheGeometry(
      [
        [0, 0.075],
        [0.06, 0.07],
        [0.12, 0.025],
        [0.35, 0],
        [0.4, -0.007],
        [0.4, -0.014],
        [0.12, 0.017],
        [0.06, 0.06],
        [0, 0.064],
      ].map(([x, y]) => new THREE.Vector2(x, y)),
      24,
    ),
    piano: new THREE.ExtrudeGeometry(grandShape(), {
      depth: 0.16,
      bevelEnabled: true,
      bevelSize: 0.025,
      bevelThickness: 0.018,
      bevelSegments: 2,
      curveSegments: 16,
      steps: 1,
    }),
  };
}
/** Adult proportions and articulated concert poses, with static detail batched by material. */
export class Musicians {
  readonly group = new THREE.Group();
  private figures: Figure[] = [];
  private platform?: { group: THREE.Group; wheels: THREE.Group[]; x: number };
  private geometries = geometries();
  private materials: THREE.MeshStandardMaterial[] = [];
  private baked: THREE.BufferGeometry[] = [];
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();
  private direction = new THREE.Vector3();
  private pole = new THREE.Vector3();
  private material(color: string, metalness = 0, roughness = 0.65) {
    const material = new THREE.MeshStandardMaterial({ color, metalness, roughness });
    this.materials.push(material);
    return material;
  }
  private mesh(
    parent: THREE.Object3D,
    shape: keyof Musicians['geometries'],
    material: THREE.Material,
    position: V3,
    scale: V3,
    dynamic = false,
  ) {
    const mesh = new THREE.Mesh(this.geometries[shape], material);
    mesh.position.set(...position);
    mesh.scale.set(...scale);
    mesh.userData.dynamic = dynamic;
    parent.add(mesh);
    return mesh;
  }
  private rod(mesh: THREE.Mesh, from: V3, to: V3, radius = 0.06) {
    this.a.set(...from);
    this.b.set(...to);
    mesh.position.copy(this.a).add(this.b).multiplyScalar(0.5);
    this.direction.copy(this.b).sub(this.a);
    mesh.scale.set(radius, this.direction.length(), radius);
    mesh.quaternion.setFromUnitVectors(UP, this.direction.normalize());
  }
  private bone(parent: THREE.Object3D, material: THREE.Material, from: V3, to: V3, radius: number) {
    const mesh = this.mesh(parent, 'limb', material, [0, 0, 0], [1, 1, 1]);
    this.rod(mesh, from, to, radius);
    return mesh;
  }
  private hand(
    parent: THREE.Object3D,
    skin: THREE.Material,
    shirt: THREE.Material,
    side: number,
  ): Hand {
    const group = new THREE.Group();
    group.name = side < 0 ? 'left-hand' : 'right-hand';
    parent.add(group);
    this.mesh(group, 'sphere', skin, [0, 0, 0], [0.049, 0.026, 0.075]);
    this.mesh(group, 'cylinder', shirt, [0, 0, -0.075], [0.034, 0.035, 0.034]).rotation.x =
      Math.PI / 2;
    this.bone(group, skin, [side * 0.035, 0, -0.01], [side * 0.067, -0.012, 0.038], 0.015);
    const fingers: THREE.Group[] = [];
    for (let i = 0; i < 4; i++) {
      const finger = new THREE.Group();
      finger.position.set((i - 1.5) * 0.024, 0, 0.048);
      group.add(finger);
      const length = i === 0 || i === 3 ? 0.06 : 0.08;
      this.bone(finger, skin, [0, 0, 0], [0, -0.005, length * 0.6], 0.011);
      this.bone(finger, skin, [0, -0.005, length * 0.6], [0, -0.018, length], 0.009);
      fingers.push(finger);
    }
    return { group, fingers };
  }
  private batch(group: THREE.Group) {
    for (const child of [...group.children]) if (child instanceof THREE.Group) this.batch(child);
    const buckets = new Map<THREE.Material, THREE.Mesh[]>();
    for (const child of group.children)
      if (
        child instanceof THREE.Mesh &&
        !child.userData.dynamic &&
        !Array.isArray(child.material)
      ) {
        const list = buckets.get(child.material) ?? [];
        list.push(child);
        buckets.set(child.material, list);
      }
    for (const [material, meshes] of buckets) {
      if (meshes.length < 2) continue;
      const parts = meshes.map((mesh) => {
        mesh.updateMatrix();
        const geo = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
        geo.applyMatrix4(mesh.matrix);
        return geo;
      });
      const geometry = mergeGeometries(parts);
      parts.forEach((g) => g.dispose());
      if (!geometry) throw new Error('Could not build the musician model.');
      this.baked.push(geometry);
      group.remove(...meshes);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = 'concert-detail';
      group.add(mesh);
    }
  }
  private stage(
    width: number,
    depth: number,
    deck: THREE.Material,
    frame: THREE.Material,
    tire: THREE.Material,
    metal: THREE.Material,
    accent: THREE.Material,
  ) {
    const stage = new THREE.Group();
    stage.name = 'rolling-stage';
    const center = 0;
    this.mesh(stage, 'box', frame, [0, STAGE_HEIGHT - 0.105, center], [width, 0.17, depth]);
    this.mesh(
      stage,
      'box',
      deck,
      [0, STAGE_HEIGHT - 0.025, center],
      [width - 0.08, 0.05, depth - 0.08],
    );
    // One continuous deck, with bounded plank detail even for a large orchestra.
    const boards = Math.min(100, Math.max(6, Math.ceil(width / 0.32)));
    for (let i = 1; i < boards; i++)
      this.mesh(
        stage,
        'box',
        frame,
        [-width / 2 + 0.04 + (i * (width - 0.08)) / boards, STAGE_HEIGHT + 0.001, center],
        [0.009, 0.003, depth - 0.08],
      );
    for (const side of [-1, 1]) {
      this.mesh(
        stage,
        'box',
        accent,
        [side * (width / 2 + 0.001), STAGE_HEIGHT - 0.08, center],
        [0.012, 0.035, depth - 0.1],
      );
      for (const end of [-1, 1])
        this.mesh(
          stage,
          'box',
          metal,
          [side * (width / 2 - 0.035), STAGE_HEIGHT - 0.105, center + end * (depth / 2 - 0.035)],
          [0.07, 0.17, 0.07],
        );
    }
    const wheels: THREE.Group[] = [];
    const supports = Math.max(2, Math.min(24, Math.ceil(width / 3.5) + 1));
    for (const end of [-1, 1]) {
      const z = center + end * (depth / 2 - 0.23);
      const axle = this.mesh(
        stage,
        'cylinder',
        metal,
        [0, STAGE_WHEEL_RADIUS, z],
        [0.023, width - 0.14, 0.023],
      );
      axle.rotation.z = Math.PI / 2;
      for (let i = 0; i < supports; i++) {
        const x = -width / 2 + 0.1 + (i * (width - 0.2)) / (supports - 1);
        const side = i < supports / 2 ? -1 : 1;
        this.mesh(stage, 'box', metal, [x - side * 0.065, 0.255, z], [0.032, 0.22, 0.12]);
        const wheel = new THREE.Group();
        wheel.name = `stage-wheel:${wheels.length}`;
        wheel.position.set(x, STAGE_WHEEL_RADIUS, z);
        stage.add(wheel);
        this.mesh(
          wheel,
          'cylinder',
          tire,
          [0, 0, 0],
          [STAGE_WHEEL_RADIUS, 0.1, STAGE_WHEEL_RADIUS],
        ).rotation.z = Math.PI / 2;
        this.mesh(
          wheel,
          'cylinder',
          metal,
          [side * 0.053, 0, 0],
          [0.079, 0.012, 0.079],
        ).rotation.z = Math.PI / 2;
        this.mesh(wheel, 'box', frame, [side * 0.061, 0, 0], [0.009, 0.12, 0.018]);
        this.mesh(wheel, 'box', frame, [side * 0.061, 0, 0], [0.009, 0.018, 0.12]);
        this.mesh(wheel, 'sphere', metal, [side * 0.069, 0, 0], [0.012, 0.025, 0.025]);
        wheels.push(wheel);
      }
    }
    return { group: stage, wheels };
  }
  setLanes(lanes: StaffLane[]) {
    this.group.clear();
    this.materials.forEach((m) => m.dispose());
    this.baked.forEach((g) => g.dispose());
    this.materials = [];
    this.baked = [];
    this.figures = [];
    this.platform = undefined;
    const suit = this.material('#243039'),
      lapel = this.material('#121b22', 0.08, 0.35),
      trousers = this.material('#283039'),
      shoe = this.material('#141819', 0.12, 0.28),
      shirt = this.material('#e5e2d8'),
      wood = this.material('#9b4e24', 0.08, 0.3),
      edge = this.material('#e0b270', 0.06, 0.35),
      ebony = this.material('#241b18', 0.06, 0.38),
      gold = this.material('#c7a457', 0.72, 0.25),
      silver = this.material('#afbec5', 0.8, 0.23),
      stageDeck = this.material('#78523a', 0, 0.75),
      stageFrame = this.material('#343e43', 0.6, 0.42),
      stageTire = this.material('#15191c', 0, 0.9),
      hairColors = ['#30231e', '#43382c', '#191d22', '#665448'];
    const parts = partLanes(lanes);
    for (const lane of parts) {
      const t = lane.track;
      if (
        t.musician?.visible === false ||
        (t.musician?.groupWith && parts.some((l) => l.track.id === t.musician!.groupWith))
      )
        continue;
      const seed = [...t.id].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 0),
        kind = musicianKind(t),
        seated = sits(kind);
      const skin = this.material(['#c99872', '#ae7654', '#d7ad8d', '#80543e'][seed % 4], 0, 0.72),
        hair = this.material(hairColors[seed % 4]),
        accent = this.material(t.color);
      const root = new THREE.Group(),
        performer = new THREE.Group(),
        body = new THREE.Group(),
        head = new THREE.Group();
      root.name = `musician:${t.id}`;
      body.name = 'upper-body';
      head.name = 'head';
      // Undo the sheet's tilt, then point the performer's local +Z toward future notes (+X).
      root.rotation.set(Math.PI / 2, Math.PI / 2, 0);
      root.add(body);
      this.group.add(root);
      body.position.y = seated ? -SEATED_OFFSET : 0;
      this.mesh(body, 'torso', suit, [0, 1.01, 0], [0.32, 0.73, 0.19]);
      this.mesh(body, 'sphere', trousers, [0, 1.01, 0], [0.23, 0.12, 0.16]);
      this.mesh(body, 'box', shirt, [0, 1.5, 0.16], [0.15, 0.45, 0.035]);
      this.mesh(body, 'lapelLeft', lapel, [0, 0, 0.172], [1, 1, 1]);
      this.mesh(body, 'lapelRight', lapel, [0, 0, 0.172], [1, 1, 1]);
      this.mesh(body, 'sphere', lapel, [-0.038, 1.7, 0.195], [0.04, 0.027, 0.018]);
      this.mesh(body, 'sphere', lapel, [0.038, 1.7, 0.195], [0.04, 0.027, 0.018]);
      this.mesh(body, 'box', accent, [-0.16, 1.57, 0.18], [0.065, 0.036, 0.012]);
      for (const y of [1.37, 1.26])
        this.mesh(body, 'sphere', ebony, [0.055, y, 0.184], [0.013, 0.013, 0.007]);
      this.mesh(body, 'cylinder', skin, [0, 1.79, 0], [0.067, 0.13, 0.064]);
      head.position.set(0, 2.005, 0.005);
      body.add(head);
      this.mesh(head, 'sphere', skin, [0, 0, 0], [0.135, 0.165, 0.125]);
      this.mesh(head, 'sphere', skin, [0, -0.087, 0.026], [0.095, 0.07, 0.095]);
      this.mesh(head, 'hair', hair, [0, 0.025, -0.012], [0.143, 0.157, 0.132]);
      for (const x of [-0.137, 0.137])
        this.mesh(head, 'sphere', skin, [x, -0.013, 0], [0.026, 0.042, 0.025]);
      for (const x of [-0.048, 0.048]) {
        this.mesh(head, 'sphere', shirt, [x, 0.016, 0.114], [0.028, 0.012, 0.009]);
        this.mesh(head, 'sphere', hair, [x, 0.014, 0.122], [0.008, 0.009, 0.004]);
        const brow = this.mesh(head, 'box', hair, [x, 0.044, 0.12], [0.052, 0.008, 0.008]);
        brow.rotation.z = x < 0 ? 0.06 : -0.06;
      }
      this.mesh(head, 'sphere', skin, [0, -0.015, 0.135], [0.022, 0.039, 0.035]);
      this.mesh(
        head,
        'sphere',
        this.material('#8e6051'),
        [0, -0.071, 0.118],
        [0.034, 0.006, 0.006],
      );
      const legWidth = kind === 'cello' ? 0.31 : 0.18;
      for (const side of [-1, 1]) {
        const hip: V3 = [side * 0.13, seated ? 0.74 : 1.03, -0.01],
          knee: V3 = [side * legWidth, 0.53, seated ? 0.37 : 0.025],
          ankle: V3 = [side * legWidth, 0.12, seated ? 0.4 : 0.06];
        this.bone(root, trousers, hip, knee, 0.1);
        this.bone(root, trousers, knee, ankle, 0.072);
        this.mesh(root, 'sphere', shoe, [ankle[0], 0.075, ankle[2] + 0.06], [0.078, 0.061, 0.16]);
        this.mesh(root, 'box', shoe, [ankle[0], 0.032, ankle[2] + 0.055], [0.15, 0.026, 0.27]);
      }
      if (seated) {
        this.mesh(root, 'box', lapel, [0, 0.7, -0.06], [0.59, 0.085, 0.44]);
        for (const x of [-0.23, 0.23])
          for (const z of [-0.23, 0.1])
            this.bone(root, silver, [x, 0.67, z], [x, 0.02, z + 0.04], 0.016);
        if (kind !== 'piano') {
          this.mesh(root, 'box', lapel, [0, 1.09, -0.27], [0.55, 0.3, 0.065]);
          for (const x of [-0.23, 0.23])
            this.bone(root, silver, [x, 0.66, -0.23], [x, 1.2, -0.27], 0.016);
        }
      }
      const arms = Array.from({ length: 4 }, () =>
        this.mesh(body, 'limb', suit, [0, 0, 0], [1, 1, 1], true),
      );
      const hands = [this.hand(body, skin, shirt, -1), this.hand(body, skin, shirt, 1)];
      const f: Figure = {
        root,
        performer,
        body,
        head,
        arms,
        hands,
        keys: [],
        sticks: [],
        valves: [],
        kind,
        track: t,
        center: lane.partCenter,
        performance: new Performance(
          parts
            .filter((l) => l.track.id === t.id || l.track.musician?.groupWith === t.id)
            .flatMap((l) => l.track.notes),
        ),
      };
      if (kind === 'violin' || kind === 'cello') {
        const instrument = new THREE.Group();
        instrument.name = kind;
        body.add(instrument);
        f.instrument = instrument;
        instrument.position.set(
          kind === 'violin' ? -0.13 : 0,
          kind === 'violin' ? 1.65 : 1.16,
          kind === 'violin' ? 0.28 : 0.44,
        );
        instrument.rotation.set(
          kind === 'violin' ? -0.7 : 0.09,
          0,
          kind === 'violin' ? 1.14 : -0.06,
        );
        instrument.scale.setScalar(kind === 'violin' ? 0.62 : 1.13);
        this.mesh(instrument, 'violin', wood, [0, 0, 0], [1, 1, 1]);
        this.mesh(instrument, 'purfling', edge, [0, 0, 0], [0.97, 0.97, 1]);
        this.mesh(instrument, 'box', wood, [0, 0.54, 0.005], [0.077, 0.4, 0.043]);
        this.mesh(instrument, 'box', ebony, [0, 0.31, 0.077], [0.075, 0.72, 0.018]);
        this.mesh(instrument, 'sphere', ebony, [0, -0.26, 0.08], [0.055, 0.12, 0.014]);
        this.mesh(instrument, 'box', edge, [0, -0.035, 0.1], [0.12, 0.025, 0.045]);
        this.mesh(instrument, 'scroll', wood, [0, 0.825, 0.015], [1, 1, 1]);
        for (let i = 0; i < 4; i++) {
          this.bone(
            instrument,
            silver,
            [(i - 1.5) * 0.013, -0.34, 0.128],
            [(i - 1.5) * 0.013, 0.78, 0.084],
            0.0025,
          );
          const peg = this.mesh(
            instrument,
            'cylinder',
            ebony,
            [(i % 2 ? 1 : -1) * 0.055, 0.68 + i * 0.031, 0],
            [0.017, 0.12, 0.017],
          );
          peg.rotation.z = Math.PI / 2;
        }
        for (const side of [-1, 1]) {
          this.bone(
            instrument,
            ebony,
            [side * 0.145, -0.14, 0.079],
            [side * 0.11, 0.085, 0.079],
            0.007,
          );
          this.mesh(instrument, 'sphere', ebony, [side * 0.11, 0.09, 0.079], [0.013, 0.02, 0.003]);
          this.mesh(
            instrument,
            'sphere',
            ebony,
            [side * 0.145, -0.15, 0.079],
            [0.013, 0.02, 0.003],
          );
        }
        if (kind === 'violin')
          this.mesh(instrument, 'sphere', ebony, [0.12, -0.3, 0.09], [0.075, 0.055, 0.021]);
        else this.bone(root, silver, [0.02, 0.01, 0.48], [0.02, 0.47, 0.48], 0.009);
        f.bow = new THREE.Group();
        f.bow.name = 'bow';
        body.add(f.bow);
        this.mesh(f.bow, 'box', wood, [0, 0, 0], [kind === 'cello' ? 1.05 : 0.86, 0.012, 0.014]);
        this.mesh(
          f.bow,
          'box',
          shirt,
          [0, -0.023, 0],
          [kind === 'cello' ? 0.93 : 0.74, 0.005, 0.017],
        );
        this.mesh(
          f.bow,
          'box',
          ebony,
          [kind === 'cello' ? 0.43 : 0.34, -0.01, 0],
          [0.062, 0.036, 0.03],
        );
      } else if (kind === 'piano') {
        const casework = this.mesh(root, 'piano', lapel, [0, 0.97, 0.82], [1, 0.75, 1]);
        casework.rotation.x = Math.PI / 2;
        const lid = this.mesh(root, 'piano', shoe, [0, 1.08, 0.86], [1, 0.75, 0.12]);
        lid.rotation.x = 1.43;
        this.mesh(root, 'box', lapel, [0, 1.0, 0.66], [2.02, 0.16, 0.47]);
        for (const [x, z] of [
          [-0.84, 0.8],
          [0.84, 0.8],
          [0.2, 1.82],
        ])
          this.bone(root, lapel, [x, 0.91, z], [x, 0.08, z], 0.05);
        const pitches = Array.from({ length: 36 }, (_, i) => 48 + i),
          whitePitches = pitches.filter((n) => ![1, 3, 6, 8, 10].includes(n % 12));
        for (const [i, midi] of whitePitches.entries()) {
          const key = this.mesh(
            root,
            'box',
            shirt,
            [(i - 10) * 0.087, 1.1, 0.62],
            [0.082, 0.047, 0.39],
            true,
          );
          f.keys.push({ mesh: key, midi, height: 1.1 });
          if ([0, 2, 5, 7, 9].includes(midi % 12) && midi < 83) {
            const black = this.mesh(
              root,
              'box',
              ebony,
              [(i - 9.5) * 0.087, 1.14, 0.7],
              [0.051, 0.037, 0.23],
              true,
            );
            f.keys.push({ mesh: black, midi: midi + 1, height: 1.14 });
          }
        }
        for (const x of [-0.1, 0, 0.1])
          this.mesh(root, 'box', gold, [x, 0.13, 0.95], [0.052, 0.024, 0.2]);
      } else if (kind === 'flute') {
        const pipe = this.mesh(body, 'cylinder', silver, [0.33, 1.95, 0.24], [0.021, 1.05, 0.021]);
        pipe.rotation.z = Math.PI / 2;
        this.mesh(body, 'sphere', silver, [0, 1.95, 0.26], [0.057, 0.016, 0.025]);
        for (let i = 0; i < 7; i++) {
          const ring = this.mesh(
            body,
            'rim',
            silver,
            [0.04 + i * 0.11, 1.95, 0.24],
            [0.024, 0.024, 0.024],
          );
          ring.rotation.y = Math.PI / 2;
          f.valves.push(
            this.mesh(
              body,
              'sphere',
              silver,
              [0.12 + i * 0.085, 1.973, 0.247],
              [0.022, 0.008, 0.025],
              true,
            ),
          );
        }
      } else if (kind === 'trumpet') {
        const pipe = this.mesh(body, 'cylinder', gold, [0, 1.94, 0.54], [0.031, 0.63, 0.031]);
        pipe.rotation.x = Math.PI / 2;
        const bell = this.mesh(body, 'cone', gold, [0, 1.94, 0.91], [0.16, 0.25, 0.16]);
        bell.rotation.x = Math.PI / 2;
        this.mesh(body, 'cylinder', ebony, [0, 1.94, 1.038], [0.145, 0.004, 0.145]).rotation.x =
          Math.PI / 2;
        const tubing = this.mesh(body, 'rim', gold, [0.05, 1.8, 0.58], [0.14, 0.085, 0.16]);
        tubing.rotation.y = Math.PI / 2;
        for (let i = 0; i < 3; i++) {
          this.mesh(body, 'cylinder', gold, [0.045, 1.85, 0.47 + i * 0.105], [0.026, 0.2, 0.026]);
          f.valves.push(
            this.mesh(
              body,
              'cylinder',
              silver,
              [0.045, 1.98, 0.47 + i * 0.105],
              [0.02, 0.06, 0.02],
              true,
            ),
          );
        }
      } else {
        const bass = this.mesh(root, 'cylinder', wood, [0, 0.42, 0.97], [0.39, 0.43, 0.39]);
        bass.rotation.x = Math.PI / 2;
        this.mesh(root, 'cylinder', shirt, [0, 0.42, 1.19], [0.377, 0.008, 0.377]).rotation.x =
          Math.PI / 2;
        this.mesh(root, 'rim', silver, [0, 0.42, 1.197], [0.389, 0.389, 0.389]);
        for (const x of [-0.42, 0.42]) {
          this.mesh(root, 'cylinder', wood, [x, 0.86, 0.61], [0.25, 0.22, 0.25]);
          this.mesh(root, 'cylinder', shirt, [x, 0.977, 0.61], [0.245, 0.012, 0.245]);
          const rim = this.mesh(root, 'rim', silver, [x, 0.984, 0.61], [0.248, 0.248, 0.248]);
          rim.rotation.x = Math.PI / 2;
          for (let i = 0; i < 6; i++) {
            const angle = (i * Math.PI) / 3;
            this.mesh(
              root,
              'box',
              silver,
              [x + Math.cos(angle) * 0.25, 0.85, 0.61 + Math.sin(angle) * 0.25],
              [0.025, 0.15, 0.025],
            );
          }
        }
        this.bone(root, silver, [0.81, 0.02, 0.85], [0.81, 1.24, 0.85], 0.013);
        for (let i = 0; i < 3; i++) {
          const angle = (i * Math.PI * 2) / 3;
          this.bone(
            root,
            silver,
            [0.81, 0.2, 0.85],
            [0.81 + Math.cos(angle) * 0.25, 0.02, 0.85 + Math.sin(angle) * 0.25],
            0.012,
          );
        }
        this.mesh(root, 'cymbal', gold, [0.81, 1.26, 0.85], [1, 1, 1]);
        for (let i = 0; i < 2; i++)
          f.sticks.push(this.mesh(body, 'cylinder', edge, [0, 0, 0], [0.011, 0.45, 0.011], true));
      }
      performer.name = 'performer';
      performer.add(...root.children);
      root.add(performer);
      this.batch(root);
      this.figures.push(f);
    }
    if (this.figures.length) {
      let left = Infinity,
        right = -Infinity,
        back = Infinity,
        front = -Infinity;
      for (const { kind, track, center } of this.figures) {
        // Footprints include the seat, instruments and the reach of playing hands/bows.
        const scale = track.musician?.scale ?? DEFAULT_MUSICIAN_SCALE;
        const width = (kind === 'piano' ? 2.26 : kind === 'drums' ? 2.6 : 1.9) * scale;
        const depth = (kind === 'piano' ? 2.6 : kind === 'drums' ? 2 : 1.65) * scale;
        const along =
          MUSICIAN_X +
          (track.musician?.x ?? 0) +
          (kind === 'piano' ? 0.75 : kind === 'drums' ? 0.48 : 0.28) * scale;
        const across = center + (track.musician?.y ?? 0);
        left = Math.min(left, across - width / 2);
        right = Math.max(right, across + width / 2);
        back = Math.min(back, along - depth / 2);
        front = Math.max(front, along + depth / 2);
      }
      // Fixed height and wheel size: changing one performer's scale must not tilt the shared deck.
      const platform = this.stage(
        Math.max(1.5, (right - left) / DEFAULT_MUSICIAN_SCALE),
        Math.max(1.3, (front - back) / DEFAULT_MUSICIAN_SCALE),
        stageDeck,
        stageFrame,
        stageTire,
        silver,
        gold,
      );
      platform.group.rotation.set(Math.PI / 2, Math.PI / 2, 0);
      platform.group.scale.setScalar(DEFAULT_MUSICIAN_SCALE);
      platform.group.position.set((front + back) / 2, (right + left) / 2, STAGE_GROUND_CLEARANCE);
      this.platform = { ...platform, x: platform.group.position.x };
      this.group.add(platform.group);
      this.batch(platform.group);
    }
  }
  private elbow(shoulder: V3, wrist: V3, side: number): V3 {
    this.a.set(...shoulder);
    this.b.set(...wrist);
    this.direction.copy(this.b).sub(this.a);
    const distance = Math.max(0.01, this.direction.length()),
      d = Math.min(0.679, distance);
    this.direction.normalize();
    const along = (0.35 * 0.35 - 0.33 * 0.33 + d * d) / (2 * d),
      height = Math.sqrt(Math.max(0, 0.35 * 0.35 - along * along));
    this.pole.set(side * 0.6, 1.15, -0.03).sub(this.a);
    this.pole.addScaledVector(this.direction, -this.pole.dot(this.direction)).normalize();
    this.a.addScaledVector(this.direction, along).addScaledVector(this.pole, height);
    return [this.a.x, this.a.y, this.a.z];
  }
  render(time: number, cursor: number, settings: SceneSettings, featured?: ReadonlySet<string>) {
    this.group.visible = settings.musicians && settings.layout === 'orchestra';
    if (!this.group.visible) return;
    if (this.platform) {
      this.platform.group.position.x = this.platform.x + cursor;
      // Absolute distance keeps rolling deterministic across pauses, seeks and export workers.
      for (const wheel of this.platform.wheels)
        wheel.rotation.x = cursor / (STAGE_WHEEL_RADIUS * DEFAULT_MUSICIAN_SCALE);
    }
    for (const f of this.figures) {
      f.root.visible = !featured || featured.has(f.track.id);
      if (!f.root.visible) continue;
      const pose = f.performance.at(time),
        m = f.track.musician;
      const scale = m?.scale ?? DEFAULT_MUSICIAN_SCALE;
      f.root.position.set(
        cursor + MUSICIAN_X + (m?.x ?? 0),
        f.center + (m?.y ?? 0),
        STAGE_GROUND_CLEARANCE,
      );
      f.root.scale.setScalar(scale);
      f.performer.position.y = (STAGE_SURFACE_HEIGHT - STAGE_GROUND_CLEARANCE) / scale;
      f.body.rotation.z = Math.sin(time * 1.6) * pose.energy * 0.018;
      f.body.rotation.x = pose.energy * 0.035;
      f.head.rotation.set(
        0.1 + pose.energy * 0.06,
        f.kind === 'violin' ? -0.16 : Math.sin(time * 0.8) * pose.energy * 0.035,
        f.kind === 'violin' ? -0.12 : 0,
      );
      const range = Math.max(-0.4, Math.min(0.4, (pose.pitch - 65) / 35));
      let left: V3 = [-0.28, 1.3, 0.28],
        right: V3 = [0.28, 1.3, 0.28];
      if (f.kind === 'piano') {
        const low = pose.keys.length ? Math.min(...pose.keys) : 55,
          high = pose.keys.length ? Math.max(...pose.keys) : 67;
        left = [
          Math.max(-0.75, Math.min(0.1, (low - 60) * 0.05)),
          1.48 - pose.strike * 0.035,
          0.46,
        ];
        right = [
          Math.max(-0.1, Math.min(0.75, (high - 60) * 0.05)),
          1.48 - pose.strike * 0.035,
          0.46,
        ];
        f.keys.forEach((key) => {
          key.mesh.position.y = key.height - (pose.keys.includes(key.midi) ? 0.022 : 0);
        });
      } else if (f.instrument) {
        const instrument = f.instrument;
        instrument.updateMatrix();
        this.a.set(0, 0.57 + range * 0.18, 0.115).applyMatrix4(instrument.matrix);
        left = [this.a.x, this.a.y, this.a.z];
        this.a.set(0, -0.035, 0.145).applyMatrix4(instrument.matrix);
        const contact: V3 = [this.a.x, this.a.y, this.a.z],
          travel = pose.stroke * pose.energy * (f.kind === 'violin' ? 0.19 : 0.29);
        f.bow!.position.set(contact[0] + travel, contact[1] + 0.025, contact[2]);
        f.bow!.rotation.set(0, f.kind === 'violin' ? -0.28 : 0, f.kind === 'violin' ? 0.26 : 0.055);
        f.bow!.updateMatrix();
        this.a.set(f.kind === 'violin' ? 0.34 : 0.43, -0.01, 0).applyMatrix4(f.bow!.matrix);
        right = [this.a.x, this.a.y, this.a.z];
      } else if (f.kind === 'flute') {
        left = [0.15, 1.98, 0.255];
        right = [0.61, 1.96, 0.255];
      } else if (f.kind === 'trumpet') {
        left = [-0.065, 1.82, 0.57];
        right = [0.09, 1.96, 0.57];
      } else {
        const lift = (1 - pose.strike) * (0.18 + pose.energy * 0.08);
        left = [-0.36, 1.41 + lift, 0.47];
        right = [0.36, 1.41 + lift, 0.47];
        f.sticks.forEach((stick, i) => {
          const hand = i ? right : left;
          this.rod(stick, hand, [hand[0] + 0.025, 1.3 + lift * 1.8, 0.78], 0.011);
        });
      }
      for (let i = 0; i < 2; i++) {
        const side = i ? 1 : -1,
          hand = i ? right : left,
          shoulder: V3 = [side * 0.25, 1.65, 0],
          elbow = this.elbow(shoulder, hand, side);
        this.rod(f.arms[i * 2], shoulder, elbow, 0.072);
        this.rod(f.arms[i * 2 + 1], elbow, hand, 0.051);
        const h = f.hands[i];
        h.group.position.set(...hand);
        h.group.rotation.set(
          f.kind === 'piano' ? 0.07 : f.instrument ? 0.35 : 0.7,
          f.kind === 'violin' && i === 0 ? -0.65 : 0,
          side * 0.08,
        );
        h.fingers.forEach((finger, j) => {
          finger.rotation.x =
            (f.kind === 'piano' ? 0.12 : 0.5) +
            (pose.active && (pose.pitch + j + i) % 4 === 0 ? 0.24 : 0);
        });
      }
      f.valves.forEach((valve, i) => {
        const down = pose.active && (pose.pitch + i) % 3 === 0;
        valve.position.y =
          f.kind === 'flute' ? 1.973 - (down ? 0.009 : 0) : 1.98 - (down ? 0.025 : 0);
      });
    }
  }
  dispose() {
    this.group.clear();
    this.materials.forEach((m) => m.dispose());
    this.baked.forEach((g) => g.dispose());
    Object.values(this.geometries).forEach((g) => g.dispose());
    this.figures = [];
    this.platform = undefined;
  }
}
