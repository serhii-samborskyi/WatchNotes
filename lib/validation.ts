import { z } from 'zod';
import { DEFAULT_SETTINGS, MAX_NOTE_SPACING, type Project } from './project';
import { MAX_MUSICIAN_SCALE } from './orchestra';
import {
  AUTO_RENDER_WORKERS,
  MAX_RENDER_WORKERS,
  DEFAULT_EXPORT_MEMORY_GIB,
  MIN_EXPORT_MEMORY_GIB,
  MAX_EXPORT_MEMORY_GIB,
  MIN_EXPORT_RESOURCE_PERCENT,
  MAX_EXPORT_RESOURCE_PERCENT,
} from './export-settings';
const finite = (min: number, max: number) => z.number().finite().min(min).max(max);
const noteSchema = z.object({
  id: z.string().min(1).max(100),
  midi: finite(0, 127).int(),
  time: finite(0, 3600),
  duration: finite(0.001, 3600),
  velocity: finite(0, 1),
  ticks: finite(0, 1e9),
  durationTicks: finite(0, 1e9),
});
const songSchema = z.object({
  name: z.string().min(1).max(256),
  source: z.string().max(512),
  duration: finite(0.01, 3600),
  ppq: finite(1, 32767).int(),
  tempos: z
    .array(z.object({ ticks: finite(0, 1e9), bpm: finite(1, 1000), time: finite(0, 3600) }))
    .min(1)
    .max(20000),
  signatures: z
    .array(
      z.object({
        ticks: finite(0, 1e9),
        numerator: finite(1, 64).int(),
        denominator: z.union([
          z.literal(1),
          z.literal(2),
          z.literal(4),
          z.literal(8),
          z.literal(16),
          z.literal(32),
          z.literal(64),
        ]),
      }),
    )
    .min(1)
    .max(1000),
  tracks: z
    .array(
      z.object({
        id: z.string().min(1).max(100),
        name: z.string().max(256),
        instrument: z.string().max(256),
        color: z.string().regex(/^#[\da-f]{6}$/i),
        enabled: z.boolean(),
        percussion: z.boolean(),
        notes: z.array(noteSchema).max(60000),
        program: finite(0, 127).int().optional(),
        channel: finite(0, 15).int().optional(),
        volume: finite(0, 1).optional(),
        solo: z.boolean().optional(),
        controls: z
          .array(
            z.object({ time: finite(0, 3600), number: finite(0, 127).int(), value: finite(0, 1) }),
          )
          .max(100000)
          .optional(),
        pitchBends: z
          .array(z.object({ time: finite(0, 3600), value: finite(-1, 1) }))
          .max(100000)
          .optional(),
        musician: z
          .object({
            kind: z
              .enum(['auto', 'piano', 'violin', 'cello', 'flute', 'trumpet', 'drums'])
              .optional(),
            visible: z.boolean().optional(),
            scale: finite(0.4, MAX_MUSICIAN_SCALE).optional(),
            x: finite(-10, 10).optional(),
            y: finite(-5, 5).optional(),
            groupWith: z.string().max(100).optional(),
          })
          .optional(),
      }),
    )
    .min(1)
    .max(64),
  audioMode: z.enum(['soft-keys', 'orchestra']).optional(),
});
const settingsSchema = z.object({
  theme: z.enum(['ember', 'moonlight', 'sage']),
  angle: finite(18, 88),
  azimuth: finite(-65, 65),
  zoom: finite(0.6, 1.8),
  spacing: finite(1.2, MAX_NOTE_SPACING),
  glow: finite(0, 2.5),
  trails: z.boolean(),
  // Additive defaults keep existing version-1 project files usable.
  flyingLights: z.boolean().default(DEFAULT_SETTINGS.flyingLights),
  flightIntensity: finite(0.2, 2.5).default(DEFAULT_SETTINGS.flightIntensity),
  flightTail: finite(0.15, 1.5).default(DEFAULT_SETTINGS.flightTail),
  flightArc: finite(0.2, 2.5).default(DEFAULT_SETTINGS.flightArc),
  grid: z.boolean(),
  follow: z.boolean(),
  noteScale: finite(0.7, 1.4),
  volume: finite(0, 1),
  layout: z.enum(['piano', 'orchestra']).default('piano'),
  musicians: z.boolean().default(false),
  staffGap: finite(4, 12).default(DEFAULT_SETTINGS.staffGap),
  focusTrack: z.string().max(100).default(''),
  cameraMode: z.enum(['static', 'cinematic']).default('static'),
  cameraPacing: z.enum(['calm', 'balanced', 'energetic']).default('balanced'),
  cameraTrack: z.string().max(100).default(''),
});
export const projectSchema = z
  .object({ version: z.literal(1), song: songSchema, settings: settingsSchema })
  .superRefine((project, ctx) => {
    const song = project.song,
      ids = new Set<string>(),
      trackIds = new Set<string>();
    let total = 0;
    for (const track of song.tracks) {
      const group = track.musician?.groupWith;
      if (group) {
        const target = song.tracks.find((t) => t.id === group);
        if (!target || target.id === track.id || target.musician?.groupWith)
          ctx.addIssue({
            code: 'custom',
            message: 'A shared performer must belong to another ungrouped track.',
          });
      }
      if (trackIds.has(track.id))
        ctx.addIssue({ code: 'custom', message: 'Track IDs must be unique.' });
      trackIds.add(track.id);
      for (const n of track.notes) {
        total++;
        if (ids.has(n.id)) ctx.addIssue({ code: 'custom', message: 'Note IDs must be unique.' });
        ids.add(n.id);
        if (n.time + n.duration > song.duration + 0.05)
          ctx.addIssue({ code: 'custom', message: 'Notes extend beyond the song duration.' });
      }
    }
    if (total === 0 || total > 60000)
      ctx.addIssue({ code: 'custom', message: 'Projects must contain 1–60,000 notes.' });
    if (song.tempos[0].ticks !== 0 || song.tempos[0].time !== 0)
      ctx.addIssue({ code: 'custom', message: 'Tempo map must start at zero.' });
    for (let i = 1; i < song.tempos.length; i++) {
      const prev = song.tempos[i - 1],
        cur = song.tempos[i];
      if (
        cur.ticks < prev.ticks ||
        cur.time < prev.time ||
        Math.abs(cur.time - (prev.time + (((cur.ticks - prev.ticks) / song.ppq) * 60) / prev.bpm)) >
          0.01
      )
        ctx.addIssue({ code: 'custom', message: 'Invalid tempo map.' });
    }
    if (
      song.signatures[0].ticks !== 0 ||
      song.signatures.some((s, i) => i > 0 && s.ticks < song.signatures[i - 1].ticks)
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid time signature map.' });
  });
export function parseProject(text: string): Project {
  if (text.length > 30 * 1024 * 1024) throw new Error('Project is too large (30 MB maximum).');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('This file does not contain valid project JSON.');
  }
  const parsed = projectSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error(`Invalid Watch Notes project: ${parsed.error.issues[0].message}`);
  return parsed.data;
}
export const exportRequestSchema = z
  .object({
    width: z.union([z.literal(1280), z.literal(1920)]),
    height: z.union([z.literal(720), z.literal(1080)]),
    fps: z.union([z.literal(24), z.literal(30), z.literal(60)]),
    frames: finite(1, 36000).int(),
    name: z.string().min(1).max(256),
    audio: z.boolean(),
  })
  .refine(
    (v) => (v.width === 1280 && v.height === 720) || (v.width === 1920 && v.height === 1080),
    'Resolution must be 720p or 1080p.',
  )
  .refine((v) => v.frames / v.fps <= 600, 'Export duration must be 10 minutes or less.');
export type ExportRequest = z.infer<typeof exportRequestSchema>;
export const serverExportSchema = z
  .object({
    project: projectSchema,
    options: z.object({
      width: z.union([z.literal(1280), z.literal(1920)]),
      height: z.union([z.literal(720), z.literal(1080)]),
      fps: z.union([z.literal(24), z.literal(30), z.literal(60)]),
      start: finite(0, 3600),
      end: finite(0, 3600),
      rate: finite(0.25, 2),
      audio: z.boolean(),
      workers: z.number().int().min(0).max(MAX_RENDER_WORKERS).default(AUTO_RENDER_WORKERS),
      resourcePercent: z
        .number()
        .int()
        .min(MIN_EXPORT_RESOURCE_PERCENT)
        .max(MAX_EXPORT_RESOURCE_PERCENT)
        .optional(),
      memoryLimitGiB: z
        .number()
        .int()
        .min(MIN_EXPORT_MEMORY_GIB)
        .max(MAX_EXPORT_MEMORY_GIB)
        .default(DEFAULT_EXPORT_MEMORY_GIB),
    }),
  })
  .superRefine(({ project, options: o }, ctx) => {
    const duration = (o.end - o.start) / o.rate;
    if (duration <= 0 || duration > 600 || o.end > project.song.duration)
      ctx.addIssue({ code: 'custom', message: 'Choose a valid song range of up to 10 minutes.' });
    if (!((o.width === 1280 && o.height === 720) || (o.width === 1920 && o.height === 1080)))
      ctx.addIssue({ code: 'custom', message: 'Resolution must be 720p or 1080p.' });
    if (!project.song.tracks.some((track) => track.enabled))
      ctx.addIssue({ code: 'custom', message: 'Enable a track before exporting.' });
  });
export type ServerExportRequest = z.infer<typeof serverExportSchema>;
