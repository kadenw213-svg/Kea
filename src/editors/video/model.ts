import { uid, clamp } from '../../lib/util';

/* ---------- Project file (.keavideo) ---------- */

export type Aspect = '16:9' | '9:16' | '1:1' | '4:5' | 'custom';

export const ASPECTS: { id: Exclude<Aspect, 'custom'>; label: string; w: number; h: number }[] = [
  { id: '16:9', label: 'Widescreen 16:9', w: 1920, h: 1080 },
  { id: '9:16', label: 'Vertical 9:16 (Shorts, Reels, TikTok)', w: 1080, h: 1920 },
  { id: '1:1', label: 'Square 1:1', w: 1080, h: 1080 },
  { id: '4:5', label: 'Portrait 4:5', w: 1080, h: 1350 }
];
export const FPS_CHOICES = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];

export interface Settings {
  width: number;
  height: number;
  fps: number;
  aspect: Aspect;
  /** Shown where no clip covers the frame. */
  background: string;
  /** Master bus: overall gain (dB, set by loudness normalisation) and a peak limiter on the final mix. */
  master?: { gain: number; limiter: boolean };
}

export type MediaKind = 'video' | 'audio' | 'image';

export interface MediaItem {
  id: string;
  /** Absolute path on disk ('' for media that only lives in memory, e.g. an unsaved tab). */
  path: string;
  name: string;
  kind: MediaKind;
  /** Seconds (images: 0). */
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  hasVideo: boolean;
}

export type TrackKind = 'video' | 'audio';

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  muted: boolean;
  solo: boolean;
  locked: boolean;
  /** Video tracks only: left out of the picture. */
  hidden: boolean;
  /** Track volume in dB (audio tracks). */
  volume: number;
}

export type Ease = 'linear' | 'in' | 'out' | 'inOut' | 'hold';
export const EASES: { id: Ease; label: string }[] = [
  { id: 'linear', label: 'Linear' },
  { id: 'in', label: 'Ease in' },
  { id: 'out', label: 'Ease out' },
  { id: 'inOut', label: 'Ease in and out' },
  { id: 'hold', label: 'Hold' }
];

export interface Keyframe {
  /** Seconds from the clip's start on the timeline. */
  t: number;
  v: number;
  /** How the value moves from this keyframe to the next one. */
  ease: Ease;
}

/** Number properties that can be keyframed. */
export const ANIMATABLE = ['x', 'y', 'scale', 'rotation', 'opacity', 'volume', 'blur'] as const;
export type AnimProp = (typeof ANIMATABLE)[number];

export type BlendMode = 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten' | 'color-dodge' | 'color-burn' | 'hard-light' | 'soft-light' | 'difference' | 'exclusion' | 'hue' | 'saturation' | 'color' | 'luminosity';
export const BLEND_MODES: BlendMode[] = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'];

export interface Colour {
  /** Stops, -3..3. */
  exposure: number;
  /** -100..100 for the rest. */
  contrast: number;
  saturation: number;
  temperature: number;
  tint: number;
  highlights: number;
  shadows: number;
  /** 0..100 */
  vignette: number;
}
export const NEUTRAL_COLOUR: Colour = { exposure: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0, highlights: 0, shadows: 0, vignette: 0 };

export const COLOUR_PRESETS: { id: string; label: string; c: Partial<Colour> }[] = [
  { id: 'none', label: 'None', c: {} },
  { id: 'warm', label: 'Warm', c: { temperature: 35, saturation: 10, tint: 4 } },
  { id: 'cool', label: 'Cool', c: { temperature: -35, saturation: 5 } },
  { id: 'vivid', label: 'Vivid', c: { saturation: 40, contrast: 18 } },
  { id: 'film', label: 'Film', c: { contrast: 14, saturation: -18, temperature: 12, shadows: 18, highlights: -12, vignette: 30 } },
  { id: 'bw', label: 'Black and white', c: { saturation: -100, contrast: 20 } },
  { id: 'fade', label: 'Faded', c: { contrast: -30, saturation: -20, shadows: 30 } },
  { id: 'punch', label: 'Punchy', c: { contrast: 35, saturation: 25, highlights: -15, shadows: 10 } },
  { id: 'teal', label: 'Teal and orange', c: { temperature: 18, tint: -10, saturation: 20, contrast: 15, shadows: -10 } },
  { id: 'night', label: 'Moonlight', c: { exposure: -0.6, temperature: -45, saturation: -30, contrast: 10 } }
];

export interface ChromaKey {
  enabled: boolean;
  /** Hex colour to remove. */
  color: string;
  /** 0..100 */
  tolerance: number;
  softness: number;
  /** Removes the key colour's tint from edges. */
  spill: number;
}

export interface Crop {
  /** Percent of the source cut from each side. */
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export type TransitionType = 'dissolve' | 'dipBlack' | 'dipWhite' | 'wipe' | 'slide' | 'zoom' | 'cover' | 'blur' | 'whip' | 'iris';
/** Which way a directional transition (wipe, slide, cover, whip) moves. */
export type TransitionDir = 'left' | 'right' | 'up' | 'down';
export const TRANSITION_DIRS: TransitionDir[] = ['left', 'right', 'up', 'down'];
/** Transitions that take a direction, and the direction each one uses by default. */
export const DIRECTIONAL: Partial<Record<TransitionType, TransitionDir>> = { wipe: 'right', slide: 'left', cover: 'left', whip: 'left' };
export const TRANSITIONS: { id: TransitionType; label: string; hint: string }[] = [
  { id: 'dissolve', label: 'Cross dissolve', hint: 'Fade one shot into the next. On audio clips: a crossfade.' },
  { id: 'dipBlack', label: 'Dip to black', hint: 'Fade out to black, then in.' },
  { id: 'dipWhite', label: 'Dip to white', hint: 'Fade out to white, then in.' },
  { id: 'wipe', label: 'Wipe', hint: 'The next shot wipes across from the left.' },
  { id: 'slide', label: 'Slide', hint: 'The next shot slides in and pushes the old one out.' },
  { id: 'zoom', label: 'Zoom', hint: 'The next shot zooms in from the centre.' },
  { id: 'cover', label: 'Cover', hint: 'The next shot slides in over the old one.' },
  { id: 'blur', label: 'Cross blur', hint: 'The old shot blurs away as the next one comes into focus.' },
  { id: 'whip', label: 'Whip pan', hint: 'A fast, motion-blurred push to the next shot.' },
  { id: 'iris', label: 'Iris', hint: 'The next shot opens out of a growing circle.' }
];

export interface Transition {
  type: TransitionType;
  /** Seconds. */
  duration: number;
  /** Direction of movement for wipe / slide / cover / whip (each has a default). */
  dir?: TransitionDir;
}

export type TextAnim = 'none' | 'fade' | 'slideUp' | 'slideLeft' | 'typewriter' | 'pop';
export const TEXT_ANIMS: { id: TextAnim; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'fade', label: 'Fade' },
  { id: 'slideUp', label: 'Slide up' },
  { id: 'slideLeft', label: 'Slide from the side' },
  { id: 'typewriter', label: 'Typewriter' },
  { id: 'pop', label: 'Pop' }
];

export interface TextStyle {
  text: string;
  font: string;
  /** Pixels at the project's resolution. */
  size: number;
  color: string;
  bold: boolean;
  italic: boolean;
  align: 'left' | 'center' | 'right';
  lineHeight: number;
  /** Background box behind the text ('' = none). */
  box: string;
  boxOpacity: number;
  boxPadding: number;
  boxRadius: number;
  outline: string;
  outlineWidth: number;
  shadow: string;
  shadowBlur: number;
  shadowY: number;
  animIn: TextAnim;
  animOut: TextAnim;
  /** Seconds each animation lasts. */
  animDuration: number;
}

export const FONTS = ['Inter', 'Segoe UI', 'Arial', 'Georgia', 'Times New Roman', 'Impact', 'Courier New', 'Verdana', 'Trebuchet MS', 'Comic Sans MS'];

export type ShapeKind = 'matte' | 'rect' | 'ellipse';
export interface ShapeStyle {
  shape: ShapeKind;
  fill: string;
  /** Size in project pixels (ignored for a full-frame matte). */
  w: number;
  h: number;
  radius: number;
  stroke: string;
  strokeWidth: number;
}

export interface ClipProps {
  /** Offset of the clip's centre from the frame centre, in project pixels. */
  x: number;
  y: number;
  /** Percent; 100 = fit the frame. */
  scale: number;
  rotation: number;
  /** 0..100 */
  opacity: number;
  blur: number;
  flipH: boolean;
  flipV: boolean;
  /** Clip volume, dB (-60 = silent). */
  volume: number;
  /** Extra gain in dB applied before volume (set by "Normalize"). */
  gain: number;
  /** Seconds. */
  fadeIn: number;
  fadeOut: number;
  /** -100..100 */
  pan: number;
}

export type ClipKind = 'media' | 'text' | 'shape';

export interface Clip {
  id: string;
  trackId: string;
  kind: ClipKind;
  mediaId?: string;
  name: string;
  /** Timeline position, seconds. */
  start: number;
  /** Source in/out, seconds (stills, text and shapes: 0..duration). */
  in: number;
  out: number;
  speed: number;
  reverse: boolean;
  /** Keep the voice pitch when the speed changes. */
  keepPitch: boolean;
  /** Clips sharing a link id move, trim and delete together (video and its audio). */
  linkId?: string;
  props: ClipProps;
  kf: Partial<Record<AnimProp, Keyframe[]>>;
  colour: Colour;
  key: ChromaKey;
  crop: Crop;
  blend: BlendMode;
  /** AI background removal (no green screen): masks are precomputed per frame and composited like the chroma key. */
  removeBg?: { enabled: boolean };
  /** Freeze frame: the clip shows this one source frame (seconds) for its whole length. */
  freeze?: number;
  trIn?: Transition;
  trOut?: Transition;
  text?: TextStyle;
  shape?: ShapeStyle;
  /** Label colour on the timeline. */
  label?: string;
}

export interface Marker {
  id: string;
  t: number;
  name: string;
  color: string;
}

export interface Project {
  version: 1;
  settings: Settings;
  media: MediaItem[];
  /** Video tracks first (V1 = bottom of the picture), then audio tracks. */
  tracks: Track[];
  clips: Clip[];
  markers: Marker[];
  /** Timeline in/out range (seconds) for "play range" and export. */
  inPoint: number | null;
  outPoint: number | null;
  /** Restored when the project reopens. */
  view?: { playhead: number; zoom: number };
}

/* ---------- Defaults ---------- */

export const DEFAULT_PROPS: ClipProps = { x: 0, y: 0, scale: 100, rotation: 0, opacity: 100, blur: 0, flipH: false, flipV: false, volume: 0, gain: 0, fadeIn: 0, fadeOut: 0, pan: 0 };
export const DEFAULT_KEY: ChromaKey = { enabled: false, color: '#00b140', tolerance: 30, softness: 15, spill: 50 };
export const DEFAULT_CROP: Crop = { left: 0, right: 0, top: 0, bottom: 0 };
export const DEFAULT_TEXT: TextStyle = {
  text: 'Your text',
  font: 'Inter',
  size: 96,
  color: '#ffffff',
  bold: true,
  italic: false,
  align: 'center',
  lineHeight: 1.2,
  box: '',
  boxOpacity: 70,
  boxPadding: 24,
  boxRadius: 12,
  outline: '',
  outlineWidth: 0,
  shadow: '#000000',
  shadowBlur: 12,
  shadowY: 4,
  animIn: 'fade',
  animOut: 'fade',
  animDuration: 0.5
};
export const DEFAULT_SHAPE: ShapeStyle = { shape: 'rect', fill: '#a8c7fa', w: 600, h: 340, radius: 0, stroke: '', strokeWidth: 0 };

export function newTrack(kind: TrackKind, name: string): Track {
  return { id: uid(), kind, name, muted: false, solo: false, locked: false, hidden: false, volume: 0 };
}

export function newProject(width = 1920, height = 1080, fps = 30): Project {
  return {
    version: 1,
    settings: { width, height, fps, aspect: aspectOf(width, height), background: '#000000' },
    media: [],
    tracks: [newTrack('video', 'V1'), newTrack('video', 'V2'), newTrack('audio', 'A1'), newTrack('audio', 'A2')],
    clips: [],
    markers: [],
    inPoint: null,
    outPoint: null
  };
}

export function aspectOf(w: number, h: number): Aspect {
  const a = ASPECTS.find((x) => Math.abs(x.w / x.h - w / h) < 0.01);
  return a ? a.id : 'custom';
}

export function baseClip(trackId: string, kind: ClipKind, name: string, start: number, duration: number): Clip {
  return {
    id: uid(),
    trackId,
    kind,
    name,
    start,
    in: 0,
    out: duration,
    speed: 1,
    reverse: false,
    keepPitch: true,
    props: { ...DEFAULT_PROPS },
    kf: {},
    colour: { ...NEUTRAL_COLOUR },
    key: { ...DEFAULT_KEY },
    crop: { ...DEFAULT_CROP },
    blend: 'normal'
  };
}

/** Read a .keavideo file, filling in anything older files lack. */
export function parseProject(json: string): Project {
  const raw = JSON.parse(json);
  if (!raw || !Array.isArray(raw.tracks) || !Array.isArray(raw.clips)) throw new Error('This is not a Kea video project.');
  const p = newProject();
  p.settings = { ...p.settings, ...raw.settings };
  p.media = (raw.media || []).map((m: Partial<MediaItem>): MediaItem => (({ hasAudio: false, hasVideo: false, fps: 30, ...m }) as MediaItem));
  p.tracks = raw.tracks.map((t: Track) => ({ ...newTrack(t.kind, t.name), ...t }));
  p.clips = raw.clips.map((c: Clip) => {
    const b = baseClip(c.trackId, c.kind, c.name, c.start, c.out - c.in);
    return {
      ...b,
      ...c,
      props: { ...b.props, ...c.props },
      colour: { ...b.colour, ...c.colour },
      key: { ...b.key, ...c.key },
      crop: { ...b.crop, ...c.crop },
      removeBg: c.removeBg,
      freeze: typeof c.freeze === 'number' ? c.freeze : undefined,
      kf: c.kf || {},
      text: c.text ? { ...DEFAULT_TEXT, ...c.text } : undefined,
      shape: c.shape ? { ...DEFAULT_SHAPE, ...c.shape } : undefined
    };
  });
  p.markers = raw.markers || [];
  p.inPoint = raw.inPoint ?? null;
  p.outPoint = raw.outPoint ?? null;
  p.view = raw.view;
  return p;
}

export function serializeProject(p: Project): string {
  return JSON.stringify(p, null, 1);
}

/* ---------- Time helpers ---------- */

export const EPS = 1e-6;

export function clipDuration(c: Clip) {
  return (c.out - c.in) / c.speed;
}
export function clipEnd(c: Clip) {
  return c.start + clipDuration(c);
}

/** Where in the source a timeline time falls. */
export function sourceTime(c: Clip, t: number) {
  if (c.freeze !== undefined) return c.freeze;
  const d = (t - c.start) * c.speed;
  return c.reverse ? c.out - d : c.in + d;
}

export function projectDuration(p: Project) {
  let end = 0;
  for (const c of p.clips) end = Math.max(end, clipEnd(c));
  return end;
}

export function snapToFrame(t: number, fps: number) {
  return Math.round(t * fps) / fps;
}

/** 00:00:12:05 style timecode. */
export function timecode(t: number, fps: number) {
  const neg = t < 0;
  t = Math.abs(t);
  const f = Math.round(t * fps);
  const rate = Math.round(fps);
  const fr = f % rate;
  const s = Math.floor(f / rate);
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${neg ? '-' : ''}${p2(Math.floor(s / 3600))}:${p2(Math.floor(s / 60) % 60)}:${p2(s % 60)}:${p2(fr)}`;
}

/** Short "1:05.2" style time for labels and Claude. */
export function shortTime(t: number) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

/** Parse "12.5", "1:05.2" or "00:00:12:05" into seconds. */
export function parseTime(s: string, fps: number): number | null {
  s = s.trim();
  if (!s) return null;
  const parts = s.split(':').map(Number);
  if (parts.some((n) => Number.isNaN(n))) return null;
  if (parts.length === 4) return parts[0] * 3600 + parts[1] * 60 + parts[2] + parts[3] / fps;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
}

/* ---------- Keyframes ---------- */

function ease(e: Ease, x: number) {
  switch (e) {
    case 'in':
      return x * x * x;
    case 'out':
      return 1 - Math.pow(1 - x, 3);
    case 'inOut':
      return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
    case 'hold':
      return 0;
    default:
      return x;
  }
}

/** Value of a keyframed track at `t` seconds into the clip. */
export function evalKeys(keys: Keyframe[], t: number): number {
  if (t <= keys[0].t) return keys[0].v;
  const last = keys[keys.length - 1];
  if (t >= last.t) return last.v;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (t >= a.t && t <= b.t) {
      const x = b.t - a.t < EPS ? 1 : (t - a.t) / (b.t - a.t);
      return a.v + (b.v - a.v) * ease(a.ease, x);
    }
  }
  return last.v;
}

/** A clip's (possibly animated) number property at timeline time `t`. */
export function propAt(c: Clip, prop: AnimProp, t: number): number {
  const keys = c.kf[prop];
  if (keys && keys.length) return evalKeys(keys, t - c.start);
  return c.props[prop];
}

/** Add or replace the keyframe at `rel` seconds into the clip. */
export function setKey(c: Clip, prop: AnimProp, rel: number, v: number) {
  const keys = (c.kf[prop] = [...(c.kf[prop] || [])]);
  const i = keys.findIndex((k) => Math.abs(k.t - rel) < 1 / 240);
  if (i >= 0) keys[i] = { ...keys[i], v };
  else {
    keys.push({ t: rel, v, ease: 'linear' });
    keys.sort((a, b) => a.t - b.t);
  }
}

/** Move keyframes when a clip's start moves by `d` but its content stays put (left trim, split). */
export function shiftKeys(c: Clip, d: number) {
  for (const p of ANIMATABLE) {
    const keys = c.kf[p];
    if (!keys) continue;
    c.kf[p] = keys.map((k) => ({ ...k, t: k.t - d }));
  }
}

/* ---------- Audio level helpers ---------- */

export const dbToGain = (db: number) => (db <= -60 ? 0 : Math.pow(10, db / 20));
export const gainToDb = (g: number) => (g <= 0.001 ? -60 : 20 * Math.log10(g));

/** Track lookup that tolerates missing ids. */
export function trackOf(p: Project, c: Clip) {
  return p.tracks.find((t) => t.id === c.trackId);
}
export function mediaOf(p: Project, c: Clip) {
  return c.mediaId ? p.media.find((m) => m.id === c.mediaId) : undefined;
}
export function videoTracks(p: Project) {
  return p.tracks.filter((t) => t.kind === 'video');
}
export function audioTracks(p: Project) {
  return p.tracks.filter((t) => t.kind === 'audio');
}

/** Clips on one track sorted by start. */
export function trackClips(p: Project, trackId: string) {
  return p.clips.filter((c) => c.trackId === trackId).sort((a, b) => a.start - b.start);
}

/** The clip right before / after `c` on its track if they touch (a cut). */
export function neighbours(p: Project, c: Clip) {
  const list = trackClips(p, c.trackId);
  const i = list.findIndex((x) => x.id === c.id);
  const prev = list[i - 1] && Math.abs(clipEnd(list[i - 1]) - c.start) < 1e-3 ? list[i - 1] : undefined;
  const next = list[i + 1] && Math.abs(clipEnd(c) - list[i + 1].start) < 1e-3 ? list[i + 1] : undefined;
  return { prev, next };
}

/** Audio clips live on audio tracks; everything else is picture. */
export function isAudioClip(p: Project, c: Clip) {
  return trackOf(p, c)?.kind === 'audio';
}

export function labelColour(p: Project, c: Clip) {
  if (c.label) return c.label;
  if (c.kind === 'text') return '#c58af9';
  if (c.kind === 'shape') return '#f6aea9';
  const m = mediaOf(p, c);
  if (isAudioClip(p, c)) return '#81c995';
  if (m?.kind === 'image') return '#fdd663';
  return '#7cacf8';
}

export const clampVol = (v: number) => clamp(v, -60, 12);
