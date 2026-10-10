import * as THREE from 'three';
import { THEMES, type SceneSettings, type Song } from './project';
import {
  activeNoteFlights,
  buildNoteFlights,
  flightFade,
  flightPoint,
  type NoteFlight,
} from './note-flights';

const SEGMENTS = 32;
const SIDES = 6;
const MAX_LIGHTS = 48;
const WHITE = new THREE.Color('#fffaf0');
type LightVisual = {
  group: THREE.Group;
  head: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  halo: THREE.Sprite;
  tail: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  guide: THREE.Line;
  guideKey: string;
};

/** A bounded pool of comets, all evaluated from absolute song time. */
export class FlyingLights {
  readonly group = new THREE.Group();
  private flights: NoteFlight[] = [];
  private pool: LightVisual[] = [];
  private spills: THREE.PointLight[] = [];
  private sphere = new THREE.SphereGeometry(1, 12, 8);
  private guideMaterial = new THREE.LineBasicMaterial({
    transparent: true,
    opacity: 0.11,
    depthWrite: false,
  });
  private glowTexture: THREE.DataTexture;
  private point = new THREE.Vector3();
  private tangent = new THREE.Vector3();
  private normal = new THREE.Vector3();
  private binormal = new THREE.Vector3();
  private accent = new THREE.Color();
  private core = new THREE.Color();
  private vertexColor = new THREE.Color();
  private headAxis = new THREE.Vector3(0, 0, 1);

  constructor() {
    const size = 64;
    const pixels = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const radius = Math.hypot(((x + 0.5) / size) * 2 - 1, ((y + 0.5) / size) * 2 - 1);
        const offset = (y * size + x) * 4;
        pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 255;
        pixels[offset + 3] = radius >= 1 ? 0 : Math.round(Math.exp(-7 * radius * radius) * 255);
      }
    }
    this.glowTexture = new THREE.DataTexture(pixels, size, size);
    this.glowTexture.magFilter = THREE.LinearFilter;
    this.glowTexture.minFilter = THREE.LinearFilter;
    this.glowTexture.needsUpdate = true;
    // A fixed light count avoids shader recompilation as chord sizes change.
    for (let i = 0; i < 4; i++) {
      const light = new THREE.PointLight('#ffd391', 0, 6, 2);
      this.spills.push(light);
      this.group.add(light);
    }
  }

  setSong(song: Song, settings?: SceneSettings) {
    this.flights = buildNoteFlights(song, settings);
    for (const visual of this.pool) {
      visual.group.visible = false;
      visual.guideKey = '';
    }
  }

  private createVisual(): LightVisual {
    const group = new THREE.Group();
    const head = new THREE.Mesh(
      this.sphere,
      new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false }),
    );
    const halo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.glowTexture,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      }),
    );
    const geometry = new THREE.BufferGeometry();
    const positions = new THREE.BufferAttribute(new Float32Array((SEGMENTS + 1) * SIDES * 3), 3);
    const colors = new THREE.BufferAttribute(new Float32Array((SEGMENTS + 1) * SIDES * 3), 3);
    positions.setUsage(THREE.DynamicDrawUsage);
    colors.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', positions);
    geometry.setAttribute('color', colors);
    const indices: number[] = [];
    for (let segment = 0; segment < SEGMENTS; segment++) {
      for (let side = 0; side < SIDES; side++) {
        const a = segment * SIDES + side;
        const b = segment * SIDES + ((side + 1) % SIDES);
        indices.push(a, b, a + SIDES, b, b + SIDES, a + SIDES);
      }
    }
    geometry.setIndex(indices);
    const tail = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    );
    tail.frustumCulled = false;
    const guideGeometry = new THREE.BufferGeometry();
    guideGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(33 * 3), 3));
    const guide = new THREE.Line(guideGeometry, this.guideMaterial);
    guide.frustumCulled = false;
    group.add(guide, tail, head, halo);
    this.group.add(group);
    const visual = { group, head, halo, tail, guide, guideKey: '' };
    this.pool.push(visual);
    return visual;
  }

  render(time: number, settings: SceneSettings, featured?: ReadonlySet<string>) {
    this.group.visible = settings.flyingLights;
    this.spills.forEach((light) => {
      light.intensity = 0;
    });
    if (!settings.flyingLights) return;
    const active = activeNoteFlights(this.flights, time, MAX_LIGHTS, featured);
    const theme = THEMES[settings.theme];
    this.accent.set(theme.accent);
    this.core.copy(this.accent).lerp(WHITE, 0.72);
    this.guideMaterial.color.set(theme.trail);
    for (let i = active.length; i < this.pool.length; i++) this.pool[i].group.visible = false;
    let spill = 0;
    for (let i = 0; i < active.length; i++) {
      const flight = active[i];
      const visual = this.pool[i] ?? this.createVisual();
      visual.group.visible = true;
      const duration = flight.end - flight.start;
      const progress = Math.min(1, (time - flight.start) / duration);
      const fade = flightFade(flight, time);
      const strength = settings.flightIntensity * (0.8 + flight.to.velocity * 0.4);
      flightPoint(flight, progress, settings.spacing, settings.flightArc, this.point);
      visual.head.position.copy(this.point);
      visual.halo.position.copy(this.point);
      this.setTangent(flight, progress, settings);
      visual.head.quaternion.setFromUnitVectors(this.headAxis, this.tangent);
      const radius = 0.066 * settings.noteScale;
      visual.head.scale.set(radius, radius, radius * 1.8);
      visual.head.material.color.copy(this.core).multiplyScalar(4.8 * strength);
      visual.head.material.opacity = fade;
      visual.halo.scale.setScalar((0.85 + strength * 0.35) * settings.noteScale);
      visual.halo.material.color.copy(this.accent).multiplyScalar(1.8 * strength);
      visual.halo.material.opacity = fade * 0.65;

      const key = `${flight.id}:${settings.spacing}:${settings.flightArc}`;
      if (visual.guideKey !== key) {
        visual.guideKey = key;
        const positions = visual.guide.geometry.getAttribute('position') as THREE.BufferAttribute;
        for (let j = 0; j <= 32; j++) {
          flightPoint(flight, j / 32, settings.spacing, settings.flightArc, this.point);
          positions.setXYZ(j, this.point.x, this.point.y, this.point.z);
        }
        positions.needsUpdate = true;
      }
      visual.guide.visible = time < flight.end;
      this.updateTail(visual, flight, time, strength, fade, settings);
      if (spill < this.spills.length && fade > 0.1) {
        const light = this.spills[spill++];
        light.position.copy(visual.head.position);
        light.position.z += 0.25;
        light.color.copy(this.accent);
        light.intensity = 4.5 * strength * fade;
      }
    }
  }

  private setTangent(flight: NoteFlight, progress: number, settings: SceneSettings) {
    const span = (flight.end - flight.start) * settings.spacing;
    const slope = 4 - 8 * progress;
    this.tangent
      .set(
        span,
        flight.toY - flight.fromY + slope * settings.flightArc * 0.22,
        slope * settings.flightArc * Math.min(1.8, 0.5 + span * 0.13),
      )
      .normalize();
  }

  private updateTail(
    visual: LightVisual,
    flight: NoteFlight,
    time: number,
    strength: number,
    fade: number,
    settings: SceneSettings,
  ) {
    const duration = flight.end - flight.start;
    const headTime = Math.min(time, flight.end);
    const startTime = Math.min(
      headTime,
      Math.max(flight.start, time - Math.min(settings.flightTail, duration * 0.9)),
    );
    const positions = visual.tail.geometry.getAttribute('position') as THREE.BufferAttribute;
    const colors = visual.tail.geometry.getAttribute('color') as THREE.BufferAttribute;
    const reveal = Math.min(1, Math.max(0, (time - flight.start) / 0.045));
    for (let segment = 0; segment <= SEGMENTS; segment++) {
      const u = segment / SEGMENTS;
      const progress = (startTime + (headTime - startTime) * u - flight.start) / duration;
      flightPoint(flight, progress, settings.spacing, settings.flightArc, this.point);
      this.setTangent(flight, progress, settings);
      this.normal.set(-this.tangent.y, this.tangent.x, 0).normalize();
      this.binormal.crossVectors(this.tangent, this.normal).normalize();
      const radius = (0.003 + 0.052 * Math.pow(u, 1.6)) * settings.noteScale * reveal;
      this.vertexColor
        .copy(this.accent)
        .lerp(this.core, u * u)
        .multiplyScalar((0.08 + 3.2 * Math.pow(u, 1.7)) * strength * fade);
      for (let side = 0; side < SIDES; side++) {
        const angle = (side / SIDES) * Math.PI * 2;
        const a = Math.cos(angle) * radius;
        const b = Math.sin(angle) * radius;
        const vertex = segment * SIDES + side;
        positions.setXYZ(
          vertex,
          this.point.x + this.normal.x * a + this.binormal.x * b,
          this.point.y + this.normal.y * a + this.binormal.y * b,
          this.point.z + this.normal.z * a + this.binormal.z * b,
        );
        colors.setXYZ(vertex, this.vertexColor.r, this.vertexColor.g, this.vertexColor.b);
      }
    }
    positions.needsUpdate = colors.needsUpdate = true;
  }

  dispose() {
    for (const visual of this.pool) {
      visual.head.material.dispose();
      visual.halo.material.dispose();
      visual.tail.geometry.dispose();
      visual.tail.material.dispose();
      visual.guide.geometry.dispose();
    }
    this.sphere.dispose();
    this.guideMaterial.dispose();
    this.glowTexture.dispose();
    this.spills.forEach((light) => light.dispose());
    this.pool = [];
    this.flights = [];
    this.group.clear();
  }
}
