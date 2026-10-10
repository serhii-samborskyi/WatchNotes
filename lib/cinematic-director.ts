import * as THREE from 'three';
import { getBars, type Song, type Track, type SceneSettings } from './project';
import { DEFAULT_MUSICIAN_SCALE, MUSICIAN_X, partLanes, type StaffLane } from './orchestra';
import { musicianHeight, STAGE_SURFACE_HEIGHT } from './musicians';

export type CameraShot = {
  start: number;
  end: number;
  type: 'solo' | 'section' | 'wide';
  trackIds: string[];
  leadId?: string;
  transition: 'cut' | 'glide';
};
export type CameraFrame = {
  index: number;
  shot: CameraShot;
  position: THREE.Vector3;
  target: THREE.Vector3;
  featured: Set<string> | undefined;
  labels: string[];
};
const PACING = {
  calm: { min: 6, target: 8, max: 10, glide: 1.4 },
  balanced: { min: 4, target: 6, max: 8, glide: 1.1 },
  energetic: { min: 3, target: 4, max: 5.5, glide: 0.8 },
};
const BIN = 0.25;

/** Capped activity and onset envelopes avoid favoring dense chords or percussion indefinitely. */
class Activity {
  private energy: Float64Array;
  private attacks: Float64Array;
  private entrances: Float64Array;
  constructor(track: Track, duration: number) {
    const count = Math.ceil(duration / BIN) + 2;
    const changes = new Float64Array(count),
      attacks = new Float64Array(count),
      entrances = new Float64Array(count);
    let previousEnd = -Infinity;
    for (const note of [...track.notes].sort((a, b) => a.time - b.time)) {
      const start = Math.min(count - 2, Math.floor(note.time / BIN));
      const end = Math.min(
        count - 1,
        Math.max(start + 1, Math.ceil((note.time + note.duration) / BIN)),
      );
      const velocity = note.velocity * (track.volume ?? 1);
      changes[start] += velocity;
      changes[end] -= velocity;
      attacks[start] += velocity;
      if (note.time - previousEnd >= 0.75) entrances[start] += velocity;
      previousEnd = Math.max(previousEnd, note.time + note.duration);
    }
    this.energy = new Float64Array(count + 1);
    this.attacks = new Float64Array(count + 1);
    this.entrances = new Float64Array(count + 1);
    let sounding = 0;
    for (let i = 0; i < count; i++) {
      sounding += changes[i];
      this.energy[i + 1] = this.energy[i] + Math.min(1, Math.max(0, sounding));
      this.attacks[i + 1] = this.attacks[i] + Math.min(2, attacks[i]);
      this.entrances[i + 1] = this.entrances[i] + Math.min(1, entrances[i]);
    }
  }
  between(start: number, end: number) {
    const lo = Math.max(0, Math.min(this.energy.length - 2, Math.floor(start / BIN)));
    const hi = Math.max(lo + 1, Math.min(this.energy.length - 1, Math.ceil(end / BIN)));
    return {
      energy: (this.energy[hi] - this.energy[lo]) / (hi - lo),
      attacks: (this.attacks[hi] - this.attacks[lo]) / (hi - lo),
      entrance: this.entrances[hi] - this.entrances[lo],
    };
  }
}

/** A complete, reproducible edit. No camera state depends on previously rendered frames. */
export class CinematicDirector {
  readonly shots: CameraShot[] = [];
  private parts: StaffLane[];
  constructor(
    private song: Song,
    private settings: SceneSettings,
    private lanes: StaffLane[],
  ) {
    this.parts = partLanes(lanes);
    const pace = PACING[settings.cameraPacing];
    const bars = getBars(song).map((bar) => bar.time);
    const activity = new Map(
      this.parts.map((part) => [part.track.id, new Activity(part.track, song.duration)]),
    );
    const lastShown = new Map<string, number>();
    const pinned = this.parts.find((part) => part.track.id === settings.cameraTrack);
    let start = 0,
      lastWide = -3,
      previousActive = 0;
    while (start < song.duration) {
      const candidates = bars.filter(
        (time) => time >= start + pace.min && time <= start + pace.max,
      );
      const desired = start + pace.target;
      const boundary = candidates.reduce(
        (best, time) => (Math.abs(time - desired) < Math.abs(best - desired) ? time : best),
        candidates[0] ?? desired,
      );
      const end = Math.min(song.duration, boundary);
      const ranked = this.parts
        .map((part) => {
          const envelope = activity.get(part.track.id)!;
          const window = envelope.between(start, end);
          const entry = envelope.between(start, Math.min(end, start + 1.25));
          const last = lastShown.get(part.track.id) ?? -100;
          const novelty = Math.min(1.8, 0.7 + (start - last) / (pace.target * 3));
          const immediate = entry.energy > 0.015 ? 1 : 0.15;
          const score =
            (window.energy * 2 +
              Math.log1p(window.attacks) * 0.45 +
              Math.min(1, entry.entrance) * 0.9) *
            novelty *
            immediate *
            (part.track.percussion ? 0.65 : 1);
          return { part, score, active: window.energy > 0.015 };
        })
        .filter((candidate) => candidate.active)
        .sort((a, b) => b.score - a.score || a.part.track.id.localeCompare(b.part.track.id));
      const index = this.shots.length;
      const ensemble = ranked.length >= Math.max(4, Math.ceil(this.parts.length * 0.6));
      const wide =
        !pinned &&
        (ranked.length === 0 ||
          (index > 0 &&
            ensemble &&
            index - lastWide >= 3 &&
            (index % 5 === 4 || ranked.length > previousActive * 1.5)));
      const lead = pinned ?? ranked[0]?.part;
      let type: CameraShot['type'] = wide || !lead ? 'wide' : 'solo';
      let selected = type === 'wide' ? this.parts : [lead!];
      if (!pinned && type !== 'wide' && index % 3 === 1) {
        const neighbors = ranked.filter(
          ({ part }) =>
            part !== lead &&
            Math.abs(part.partCenter - lead!.partCenter) <= settings.staffGap * 1.15,
        );
        selected = [lead!, ...neighbors.slice(0, 2).map(({ part }) => part)];
        if (selected.length > 1) type = 'section';
      }
      const trackIds = selected.map((part) => part.track.id);
      // Shared articulation tracks still need their actual performer in the shot.
      for (const part of selected) {
        const owner = this.parts.find((p) => p.track.id === part.track.musician?.groupWith);
        if (owner && !trackIds.includes(owner.track.id)) trackIds.push(owner.track.id);
      }
      const previous = this.shots.at(-1);
      const previousLead = this.parts.find((part) => part.track.id === previous?.leadId);
      const transition =
        previous &&
        previous.type !== 'wide' &&
        type !== 'wide' &&
        lead &&
        previousLead &&
        Math.abs(lead.partCenter - previousLead.partCenter) <= settings.staffGap * 1.6
          ? 'glide'
          : 'cut';
      this.shots.push({
        start,
        end,
        type,
        trackIds,
        leadId: type === 'wide' ? undefined : lead?.track.id,
        transition,
      });
      if (type === 'wide') lastWide = index;
      else for (const id of trackIds) lastShown.set(id, start);
      previousActive = ranked.length;
      start = end;
    }
  }
  private bounds(shot: CameraShot) {
    const selected = this.parts.filter((part) => shot.trackIds.includes(part.track.id));
    const box = new THREE.Box3();
    const future = Math.max(6, Math.min(12, this.settings.spacing * 1.8));
    for (const part of selected) {
      for (const lane of this.lanes.filter((lane) => lane.track.id === part.track.id)) {
        box.expandByPoint(new THREE.Vector3(-2, 0, -lane.center - 2.6));
        box.expandByPoint(new THREE.Vector3(future, 1.5, -lane.center + 2.6));
      }
      if (this.settings.musicians && part.track.musician?.visible !== false) {
        const scale = part.track.musician?.scale ?? DEFAULT_MUSICIAN_SCALE;
        const x = MUSICIAN_X + (part.track.musician?.x ?? 0);
        const z = -part.partCenter - (part.track.musician?.y ?? 0);
        box.expandByPoint(new THREE.Vector3(x - 0.8 * scale, 0, z - 1.35 * scale));
        box.expandByPoint(
          new THREE.Vector3(
            x + 2.1 * scale,
            STAGE_SURFACE_HEIGHT + musicianHeight(part.track) * scale + 1.5,
            z + 1.35 * scale,
          ),
        );
      }
    }
    if (box.isEmpty()) box.set(new THREE.Vector3(-14, 0, -5), new THREE.Vector3(10, 7, 5));
    return box;
  }
  private pose(index: number, time: number, aspect: number) {
    const shot = this.shots[index];
    const box = this.bounds(shot),
      target = box.getCenter(new THREE.Vector3());
    const progress = THREE.MathUtils.clamp(
      (time - shot.start) / Math.max(0.01, shot.end - shot.start),
      0,
      1,
    );
    const elevation = THREE.MathUtils.degToRad(
      shot.type === 'wide' ? 62 : shot.type === 'section' ? 52 : 44,
    );
    const azimuth = THREE.MathUtils.degToRad([-8, 4, -3][index % 3] + (progress - 0.5) * 3);
    const direction = new THREE.Vector3(
      Math.sin(azimuth) * Math.cos(elevation),
      Math.sin(elevation),
      Math.cos(azimuth) * Math.cos(elevation),
    );
    const right = new THREE.Vector3(Math.cos(azimuth), 0, -Math.sin(azimuth));
    const up = new THREE.Vector3().crossVectors(direction, right);
    const tanY = Math.tan(THREE.MathUtils.degToRad(18)),
      tanX = tanY * Math.max(0.25, aspect);
    let distance = 12;
    for (const x of [box.min.x, box.max.x])
      for (const y of [box.min.y, box.max.y])
        for (const z of [box.min.z, box.max.z]) {
          const offset = new THREE.Vector3(x, y, z).sub(target);
          distance = Math.max(
            distance,
            offset.dot(direction) + (Math.abs(offset.dot(right)) / tanX) * 1.15,
            offset.dot(direction) + (Math.abs(offset.dot(up)) / tanY) * 1.15,
          );
        }
    return {
      target,
      position: target.clone().addScaledVector(direction, distance * (1.035 - progress * 0.025)),
    };
  }
  at(time: number, aspect = 16 / 9): CameraFrame {
    const t = THREE.MathUtils.clamp(time, 0, this.song.duration);
    let lo = 0,
      hi = this.shots.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.shots[mid].start <= t) lo = mid + 1;
      else hi = mid;
    }
    const index = Math.max(0, lo - 1),
      shot = this.shots[index];
    const pose = this.pose(index, t, aspect);
    let visible = shot.trackIds;
    if (index > 0 && shot.transition === 'glide') {
      const duration = Math.min(
        PACING[this.settings.cameraPacing].glide,
        (shot.end - shot.start) / 3,
      );
      const u = THREE.MathUtils.clamp((t - shot.start) / duration, 0, 1);
      if (u < 1) {
        const previous = this.pose(index - 1, shot.start, aspect);
        const blend = u * u * u * (u * (u * 6 - 15) + 10);
        pose.position.lerpVectors(previous.position, pose.position, blend);
        pose.target.lerpVectors(previous.target, pose.target, blend);
        visible = [...new Set([...this.shots[index - 1].trackIds, ...shot.trackIds])];
      }
    }
    pose.position.x += t * this.settings.spacing;
    pose.target.x += t * this.settings.spacing;
    return {
      index,
      shot,
      ...pose,
      featured: shot.type === 'wide' ? undefined : new Set(visible),
      labels: shot.type === 'wide' ? [] : shot.trackIds,
    };
  }
}
