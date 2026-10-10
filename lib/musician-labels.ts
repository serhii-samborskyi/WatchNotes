import * as THREE from 'three';
import { DEFAULT_MUSICIAN_SCALE, MUSICIAN_X, partLanes, type StaffLane } from './orchestra';
import { musicianHeight, STAGE_SURFACE_HEIGHT } from './musicians';

/** Rendered after bloom so text stays sharp, opaque and unaffected by scene fog. */
export class MusicianLabels {
  readonly scene = new THREE.Scene();
  private labels: {
    sprite: THREE.Sprite;
    aspect: number;
    anchor: THREE.Vector3;
    trackId: string;
  }[] = [];
  private point = new THREE.Vector3();
  private right = new THREE.Vector3();
  private up = new THREE.Vector3();
  setLanes(lanes: StaffLane[]) {
    this.clear();
    for (const lane of partLanes(lanes)) {
      const canvas = document.createElement('canvas'),
        ctx = canvas.getContext('2d')!;
      const full = lane.track.name.trim() || lane.track.instrument;
      let text = full;
      ctx.font = '600 44px Arial, sans-serif';
      while (ctx.measureText(text).width > 680 && text.length > 1) text = text.slice(0, -1);
      if (text !== full) text = text.slice(0, -1).trimEnd() + '…';
      canvas.width = Math.ceil(ctx.measureText(text).width) + 64;
      canvas.height = 88;
      ctx.fillStyle = '#10191e';
      ctx.beginPath();
      ctx.roundRect(1, 1, canvas.width - 2, 86, 15);
      ctx.fill();
      ctx.strokeStyle = '#627078';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = lane.track.color;
      ctx.fillRect(12, 21, 5, 46);
      ctx.font = '600 44px Arial, sans-serif';
      ctx.fillStyle = '#f6f4ee';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, 30, 45);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.generateMipmaps = false;
      texture.minFilter = THREE.LinearFilter;
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: texture,
          transparent: true,
          opacity: 1,
          depthTest: false,
          depthWrite: false,
          toneMapped: false,
          fog: false,
        }),
      );
      sprite.name = `label:${lane.track.id}`;
      sprite.center.set(0.5, 0);
      const m = lane.track.musician;
      sprite.position.set(
        MUSICIAN_X + (m?.x ?? 0),
        musicianHeight(lane.track) * (m?.scale ?? DEFAULT_MUSICIAN_SCALE) +
          STAGE_SURFACE_HEIGHT +
          0.42,
        -lane.partCenter - (m?.y ?? 0),
      );
      this.labels.push({
        sprite,
        aspect: canvas.width / canvas.height,
        anchor: sprite.position.clone(),
        trackId: lane.track.id,
      });
      this.scene.add(sprite);
    }
  }
  update(
    camera: THREE.PerspectiveCamera,
    height: number,
    cursor: number,
    featured?: readonly string[],
  ) {
    camera.updateMatrixWorld();
    const pixelHeight = Math.max(34, height * 0.05);
    const occupied: { left: number; right: number; bottom: number; top: number }[] = [];
    const labels = featured
      ? [...this.labels].sort((a, b) => featured.indexOf(a.trackId) - featured.indexOf(b.trackId))
      : this.labels;
    for (const { sprite, aspect, anchor, trackId } of labels) {
      sprite.position.copy(anchor);
      sprite.position.x += cursor;
      this.point.copy(sprite.position).applyMatrix4(camera.matrixWorldInverse);
      const depth = -this.point.z;
      sprite.visible = depth > camera.near && (!featured || featured.includes(trackId));
      const unitsPerPixel =
        (2 * depth * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / Math.max(1, height);
      sprite.scale.set(pixelHeight * unitsPerPixel * aspect, pixelHeight * unitsPerPixel, 1);
      if (featured && sprite.visible) {
        this.point.copy(sprite.position).project(camera);
        const width = height * camera.aspect;
        const cx = ((this.point.x + 1) * width) / 2,
          bottom = ((this.point.y + 1) * height) / 2;
        // Keep long names inside the frame without changing the performer's anchor.
        // Off-screen subjects remain hidden during a camera move.
        if (Math.abs(this.point.x) > 1.05 || Math.abs(this.point.y) > 1.05) {
          sprite.visible = false;
          continue;
        }
        const fit = Math.min(1, Math.max(1, width - 16) / (pixelHeight * aspect));
        sprite.scale.multiplyScalar(fit);
        const labelHeight = pixelHeight * fit,
          halfWidth = (labelHeight * aspect) / 2;
        const labelX = Math.max(8 + halfWidth, Math.min(width - 8 - halfWidth, cx));
        const labelY = Math.max(8, Math.min(height - 8 - labelHeight, bottom));
        this.right.setFromMatrixColumn(camera.matrixWorld, 0);
        this.up.setFromMatrixColumn(camera.matrixWorld, 1);
        sprite.position
          .addScaledVector(this.right, (labelX - cx) * unitsPerPixel)
          .addScaledVector(this.up, (labelY - bottom) * unitsPerPixel);
        const rect = {
          left: labelX - halfWidth,
          right: labelX + halfWidth,
          bottom: labelY,
          top: labelY + labelHeight,
        };
        sprite.visible =
          rect.left >= 0 &&
          rect.right <= width &&
          rect.bottom >= 0 &&
          rect.top <= height &&
          !occupied.some(
            (r) =>
              rect.left < r.right + 5 &&
              rect.right > r.left - 5 &&
              rect.bottom < r.top + 5 &&
              rect.top > r.bottom - 5,
          );
        if (sprite.visible) occupied.push(rect);
      }
    }
  }
  clear() {
    for (const { sprite } of this.labels) {
      sprite.material.map?.dispose();
      sprite.material.dispose();
    }
    this.labels = [];
    this.scene.clear();
  }
  dispose() {
    this.clear();
  }
}
