import { uid } from '../../lib/util';
import type { Project, Clip, MediaItem, Track, TrackKind, Transition, TransitionType } from './model';
import { baseClip, clipEnd, clipDuration, mediaOf, newTrack, shiftKeys, trackClips, neighbours, EPS, DEFAULT_TEXT, DEFAULT_SHAPE, TextStyle, ShapeStyle, speedAt, rampIntegral } from './model';

/* Editing operations. Each one changes the project passed in (a draft copy made by `commit`). */

const MIN_LEN = 1 / 60;

/** Stills, text and shapes can be stretched to any length; audio/video can't run past their source. */
export function isStill(p: Project, c: Clip) {
  // A freeze frame behaves like a still: any length, its source times are just bookkeeping.
  return c.kind !== 'media' || mediaOf(p, c)?.kind === 'image' || c.freeze !== undefined;
}
function srcMax(p: Project, c: Clip) {
  if (isStill(p, c)) return Infinity;
  return mediaOf(p, c)?.duration ?? c.out;
}

/** Ids plus every clip linked to them. */
export function withLinked(p: Project, ids: string[]) {
  const set = new Set(ids);
  const links = new Set(p.clips.filter((c) => set.has(c.id) && c.linkId).map((c) => c.linkId!));
  for (const c of p.clips) if (c.linkId && links.has(c.linkId)) set.add(c.id);
  return [...set];
}

export function isLocked(p: Project, c: Clip) {
  return p.tracks.find((t) => t.id === c.trackId)?.locked ?? false;
}

/* ---------- Trimming ---------- */

/** How far an edge can move: [most negative, most positive] seconds on the timeline. */
export function trimRange(p: Project, c: Clip, edge: 'start' | 'end'): [number, number] {
  const len = clipDuration(c);
  if (isStill(p, c)) return edge === 'start' ? [-c.start, len - MIN_LEN] : [-(len - MIN_LEN), Infinity];
  const max = srcMax(p, c);
  // Timeline seconds of spare source before the clip's head / after its tail.
  const headRoom = (c.reverse ? max - c.out : c.in) / speedAt(c, c.start);
  const tailRoom = (c.reverse ? c.in : max - c.out) / speedAt(c, clipEnd(c));
  if (edge === 'start') return [-Math.min(headRoom, c.start), len - MIN_LEN];
  return [-(len - MIN_LEN), tailRoom];
}

/** Move the clip's start by `d` (positive = shorter), keeping the content where it is. */
export function trimStart(p: Project, c: Clip, d: number) {
  const [lo, hi] = trimRange(p, c, 'start');
  d = Math.max(lo, Math.min(hi, d));
  if (c.ramp?.length && !isStill(p, c)) {
    // Time remapping: advance the source by what the ramp plays in those d seconds, then move the ramp with it.
    const adv = rampIntegral(c.ramp, d);
    if (c.reverse) c.out -= adv;
    else c.in += adv;
    const at0 = speedAt(c, c.start + d);
    const keys = c.ramp.map((k) => ({ t: k.t - d, v: k.v })).filter((k) => k.t > 1e-6);
    c.ramp = [{ t: 0, v: at0 }, ...keys];
    c.start += d;
    shiftKeys(c, d);
    return d;
  }
  c.start += d;
  if (isStill(p, c)) c.out -= d;
  else if (c.reverse) c.out -= d * c.speed;
  else c.in += d * c.speed;
  shiftKeys(c, d);
  return d;
}

/** Move the clip's end by `d` (positive = longer). */
export function trimEnd(p: Project, c: Clip, d: number) {
  const [lo, hi] = trimRange(p, c, 'end');
  d = Math.max(lo, Math.min(hi, d));
  if (c.ramp?.length && !isStill(p, c)) {
    const len = rampIntegral(c.ramp, clipDuration(c) + d);
    if (c.reverse) c.in = c.out - len;
    else c.out = c.in + len;
    return d;
  }
  if (isStill(p, c) || !c.reverse) c.out += d * (isStill(p, c) ? 1 : c.speed);
  else c.in -= d * c.speed;
  return d;
}

/** Set the clip's length on the timeline (stretching stills, trimming media). */
export function setDuration(p: Project, c: Clip, len: number) {
  trimEnd(p, c, len - clipDuration(c));
}

/** Slip: change which part of the source plays without moving the clip. */
export function slip(p: Project, c: Clip, dSource: number) {
  if (isStill(p, c)) return 0;
  const max = srcMax(p, c);
  dSource = Math.max(-c.in, Math.min(max - c.out, dSource));
  c.in += dSource;
  c.out += dSource;
  return dSource;
}

/** Rolling edit: move the cut between two touching clips. */
export function roll(p: Project, left: Clip, right: Clip, d: number) {
  const [l1, h1] = trimRange(p, left, 'end');
  const [l2, h2] = trimRange(p, right, 'start');
  d = Math.max(Math.max(l1, l2), Math.min(Math.min(h1, h2), d));
  trimEnd(p, left, d);
  trimStart(p, right, d);
  return d;
}

/** Shift every clip on `trackIds` that starts at or after `from` by `d`. */
function shiftAfter(p: Project, trackIds: Set<string>, from: number, d: number, except: Set<string> = new Set()) {
  for (const c of p.clips) if (trackIds.has(c.trackId) && !except.has(c.id) && c.start >= from - EPS) c.start = Math.max(0, c.start + d);
}

/** Ripple trim: trim an edge and slide everything after it on the same tracks to close / open the gap. */
export function rippleTrim(p: Project, c: Clip, edge: 'start' | 'end', d: number) {
  const group = withLinked(p, [c.id]).map((id) => p.clips.find((x) => x.id === id)!);
  const tracks = new Set(group.map((x) => x.trackId));
  const oldEnd = clipEnd(c);
  if (edge === 'end') {
    const real = trimEnd(p, c, d);
    for (const g of group) if (g !== c) trimEnd(p, g, real);
    shiftAfter(p, tracks, oldEnd, real, new Set(group.map((g) => g.id)));
    return real;
  }
  // Start: the content's head is trimmed, then the clip and everything after slides back to the old start.
  const real = trimStart(p, c, d);
  for (const g of group) if (g !== c) trimStart(p, g, real);
  for (const g of group) g.start -= real;
  shiftAfter(p, tracks, oldEnd, -real, new Set(group.map((g) => g.id)));
  return real;
}

/* ---------- Splitting and overwriting ---------- */

/** Split one clip at timeline time `t`; returns the new right-hand clip (or null if `t` isn't inside). */
export function splitClip(p: Project, c: Clip, t: number): Clip | null {
  if (t <= c.start + MIN_LEN || t >= clipEnd(c) - MIN_LEN) return null;
  const right: Clip = structuredClone(c);
  right.id = uid();
  const offset = t - c.start;
  trimStart(p, right, offset);
  trimEnd(p, c, -(clipEnd(c) - t));
  c.trOut = undefined;
  right.trIn = undefined;
  // Fades belong to the outer ends.
  right.props.fadeIn = 0;
  c.props.fadeOut = 0;
  p.clips.push(right);
  return right;
}

/** Split clips at `t`: the given ones (plus linked), or every clip on unlocked tracks. Returns the right-hand halves. */
export function splitAt(p: Project, t: number, ids?: string[]) {
  const targets = ids && ids.length ? withLinked(p, ids) : p.clips.map((c) => c.id);
  const relink = new Map<string, string>();
  const made: Clip[] = [];
  for (const id of targets) {
    const c = p.clips.find((x) => x.id === id)!;
    if (isLocked(p, c)) continue;
    const r = splitClip(p, c, t);
    if (!r) continue;
    if (c.linkId) {
      if (!relink.has(c.linkId)) relink.set(c.linkId, uid());
      r.linkId = relink.get(c.linkId);
    }
    made.push(r);
  }
  return made;
}

/** Make room on a track between a and b: trims, splits or removes whatever is there (except `keep`). */
export function clearRange(p: Project, trackId: string, a: number, b: number, keep: Set<string> = new Set(), relink = new Map<string, string>()) {
  for (const c of [...p.clips]) {
    if (c.trackId !== trackId || keep.has(c.id)) continue;
    const s = c.start;
    const e = clipEnd(c);
    if (e <= a + EPS || s >= b - EPS) continue;
    if (s >= a - EPS && e <= b + EPS) {
      p.clips.splice(p.clips.indexOf(c), 1);
    } else if (s < a && e > b) {
      // The right half is a new piece: it links only with its partners' right halves (cleared in the same call).
      const r = splitClip(p, c, b);
      if (r && c.linkId) {
        if (!relink.has(c.linkId)) relink.set(c.linkId, uid());
        r.linkId = relink.get(c.linkId);
      }
      setDuration(p, c, a - s);
      c.trOut = undefined;
    } else if (s < a) {
      setDuration(p, c, a - s);
      c.trOut = undefined;
    } else {
      trimStart(p, c, b - s);
      c.trIn = undefined;
    }
  }
}

/** Remove clips; with ripple, later clips on the same tracks slide left to close each gap. */
export function deleteClips(p: Project, ids: string[], ripple: boolean) {
  const all = withLinked(p, ids);
  const doomed = p.clips.filter((c) => all.includes(c.id) && !isLocked(p, c)).sort((a, b) => b.start - a.start);
  for (const c of doomed) {
    p.clips.splice(p.clips.indexOf(c), 1);
    if (ripple) {
      const len = clipDuration(c);
      const end = clipEnd(c);
      // Only close the gap if nothing else still covers it on that track.
      const blocked = p.clips.some((x) => x.trackId === c.trackId && x.start < end - EPS && clipEnd(x) > c.start + EPS);
      if (!blocked) shiftAfter(p, new Set([c.trackId]), end, -len);
    }
  }
  return doomed.length;
}

/** Close the empty space at `t` on a track. */
export function rippleDeleteGap(p: Project, trackId: string, t: number) {
  const list = trackClips(p, trackId);
  let gapStart = 0;
  for (const c of list) {
    if (c.start > t) {
      const len = c.start - gapStart;
      if (len > EPS) shiftAfter(p, new Set([trackId]), c.start, -len);
      return len;
    }
    gapStart = Math.max(gapStart, clipEnd(c));
  }
  return 0;
}

/** Place clips, overwriting what's under them (Premiere's default drop). */
export function overwrite(p: Project, clips: Clip[]) {
  const relink = new Map<string, string>();
  for (const c of clips) clearRange(p, c.trackId, c.start, clipEnd(c), new Set(), relink);
  p.clips.push(...clips);
}

/** Place clips at their start, pushing later clips on the same tracks to the right. */
export function insert(p: Project, clips: Clip[]) {
  if (!clips.length) return;
  const at = Math.min(...clips.map((c) => c.start));
  const len = Math.max(...clips.map(clipEnd)) - at;
  const tracks = new Set(clips.map((c) => c.trackId));
  // Linked partners (a video's own sound) are split and pushed too, so picture and sound stay in sync.
  for (const c of p.clips) if (tracks.has(c.trackId) && c.linkId && clipEnd(c) > at + EPS) for (const x of p.clips) if (x.linkId === c.linkId) tracks.add(x.trackId);
  const crossing = p.clips.filter((x) => tracks.has(x.trackId) && x.start < at - EPS && clipEnd(x) > at + EPS).map((x) => x.id);
  if (crossing.length) splitAt(p, at, crossing);
  shiftAfter(p, tracks, at, len);
  p.clips.push(...clips);
}

/* ---------- Tracks ---------- */

export function addTrack(p: Project, kind: TrackKind): Track {
  const same = p.tracks.filter((t) => t.kind === kind);
  const t = newTrack(kind, `${kind === 'video' ? 'V' : 'A'}${same.length + 1}`);
  if (kind === 'video') {
    const lastVideo = p.tracks.reduce((i, x, j) => (x.kind === 'video' ? j : i), -1);
    p.tracks.splice(lastVideo + 1, 0, t);
  } else p.tracks.push(t);
  return t;
}

export function removeTrack(p: Project, id: string) {
  const t = p.tracks.find((x) => x.id === id);
  if (!t || p.tracks.filter((x) => x.kind === t.kind).length <= 1) return false;
  p.clips = p.clips.filter((c) => c.trackId !== id);
  p.tracks = p.tracks.filter((x) => x.id !== id);
  let n = 1;
  for (const x of p.tracks) if (x.kind === t.kind && /^[VA]\d+$/.test(x.name)) x.name = `${t.kind === 'video' ? 'V' : 'A'}${n++}`;
  return true;
}

/** A track of `kind` with nothing between a and b (bottom-most first, `prefer` first), adding one if needed. */
export function freeTrack(p: Project, kind: TrackKind, a: number, b: number, prefer?: string, topFirst = false): Track {
  let list = p.tracks.filter((t) => t.kind === kind && !t.locked);
  if (topFirst) list = [...list].reverse();
  if (prefer) list.sort((x, y) => (x.id === prefer ? -1 : y.id === prefer ? 1 : 0));
  for (const t of list) if (!p.clips.some((c) => c.trackId === t.id && c.start < b - EPS && clipEnd(c) > a + EPS)) return t;
  return addTrack(p, kind);
}

/* ---------- Making clips ---------- */

export const STILL_LENGTH = 5;

/** Clips for a piece of media: picture and/or sound, linked together. */
export function clipsForMedia(p: Project, m: MediaItem, at: number, opts: { vTrack?: string; aTrack?: string; in?: number; out?: number; findFree?: boolean } = {}): Clip[] {
  const isImg = m.kind === 'image';
  const a = opts.in ?? 0;
  const b = opts.out ?? (isImg ? STILL_LENGTH : m.duration);
  const len = b - a;
  const out: Clip[] = [];
  const link = m.hasVideo && m.hasAudio ? uid() : undefined;
  if (m.hasVideo || isImg) {
    const t = opts.findFree ? freeTrack(p, 'video', at, at + len, opts.vTrack) : p.tracks.find((x) => x.id === opts.vTrack) || freeTrack(p, 'video', at, at + len);
    const c = baseClip(t.id, 'media', m.name, at, len);
    c.mediaId = m.id;
    c.in = isImg ? 0 : a;
    c.out = isImg ? len : b;
    c.linkId = link;
    out.push(c);
  }
  if (m.hasAudio && !isImg) {
    const t = opts.findFree ? freeTrack(p, 'audio', at, at + len, opts.aTrack) : p.tracks.find((x) => x.id === opts.aTrack) || freeTrack(p, 'audio', at, at + len);
    const c = baseClip(t.id, 'media', m.name, at, len);
    c.mediaId = m.id;
    c.in = a;
    c.out = b;
    c.linkId = link;
    out.push(c);
  }
  return out;
}

export function textClip(p: Project, at: number, duration: number, style: Partial<TextStyle> = {}, trackId?: string): Clip {
  const t = trackId ? p.tracks.find((x) => x.id === trackId)! : freeTrack(p, 'video', at, at + duration, undefined, true);
  // The default size suits 1080p; scale it to the project's frame.
  const k = Math.min(p.settings.width, p.settings.height) / 1080;
  const text = { ...DEFAULT_TEXT, size: Math.round(DEFAULT_TEXT.size * k), shadowBlur: Math.round(DEFAULT_TEXT.shadowBlur * k), ...style };
  const c = baseClip(t.id, 'text', text.text.split('\n')[0].slice(0, 40) || 'Text', at, duration);
  c.text = text;
  return c;
}

export function shapeClip(p: Project, at: number, duration: number, style: Partial<ShapeStyle> = {}): Clip {
  const shape = { ...DEFAULT_SHAPE, ...style };
  // A full-frame matte usually goes underneath; shapes go on top.
  const t = freeTrack(p, 'video', at, at + duration, undefined, shape.shape !== 'matte');
  const c = baseClip(t.id, 'shape', shape.shape === 'matte' ? 'Colour matte' : shape.shape === 'ellipse' ? 'Ellipse' : 'Rectangle', at, duration);
  c.shape = shape;
  return c;
}

/** Paste copied clips (relative positions kept) at `at`, onto the same tracks when they still exist. */
export function paste(p: Project, clips: Clip[], at: number) {
  if (!clips.length) return [];
  const base = Math.min(...clips.map((c) => c.start));
  const relink = new Map<string, string>();
  const made = clips.map((c) => {
    const n: Clip = structuredClone(c);
    n.id = uid();
    n.start = at + (c.start - base);
    if (c.linkId) {
      if (!relink.has(c.linkId)) relink.set(c.linkId, uid());
      n.linkId = relink.get(c.linkId);
    }
    if (!p.tracks.some((t) => t.id === n.trackId)) {
      const isAudio = clips.some((x) => x.id === c.id) && p.tracks.find((t) => t.id === c.trackId)?.kind === 'audio';
      n.trackId = freeTrack(p, isAudio ? 'audio' : 'video', n.start, clipEnd(n)).id;
    }
    return n;
  });
  overwrite(p, made);
  return made;
}

/* ---------- Transitions ---------- */

/** Longest a transition at this edge can be. */
export function maxTransition(p: Project, c: Clip, edge: 'in' | 'out') {
  const { prev, next } = neighbours(p, c);
  const other = edge === 'in' ? prev : next;
  const len = clipDuration(c);
  return other ? Math.min(len, clipDuration(other)) : len;
}

/** Add, change or remove a transition. A transition at a cut is stored on the incoming clip's `trIn`. */
export function setTransition(p: Project, clipId: string, edge: 'in' | 'out', tr: Transition | null) {
  let c = p.clips.find((x) => x.id === clipId);
  if (!c) return null;
  if (edge === 'out') {
    const { next } = neighbours(p, c);
    if (next) {
      c.trOut = undefined;
      c = next;
      edge = 'in';
    }
  }
  if (tr) tr = { ...tr, duration: Math.max(1 / 30, Math.min(tr.duration, maxTransition(p, c, edge))) };
  if (edge === 'in') c.trIn = tr || undefined;
  else c.trOut = tr || undefined;
  return { clipId: c.id, edge };
}

export function defaultTransition(type: TransitionType): Transition {
  return { type, duration: type === 'dissolve' ? 1 : 0.6 };
}

/** Linked partners on the other kind of track (picture ↔ sound). */
export function partners(p: Project, c: Clip) {
  return c.linkId ? p.clips.filter((x) => x.linkId === c.linkId && x.id !== c.id) : [];
}
