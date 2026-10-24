// Professional editing operations and the tools Claude uses to drive them: J/L cuts, music ducking under speech,
// freeze frames, punch-in zooms, Ken Burns moves, title presets, captions, dialogue levelling, loudness normalisation
// (BS.1770, e.g. -14 LUFS for YouTube/TikTok) — and `edit_plan`, one high-level plan in editor language (storyline,
// B-roll, titles, captions, music, SFX, transitions, fades, J/L cuts, looks, zooms) applied as ONE undo step.
// Ops mutate a draft project (inside store.commit); tools wrap them. Loudness work renders audio, so it runs as a job.
import type { AssistantTool } from '../../store';
import type { AssistantEnv } from './assistant';
import type { Project, Clip, Track, MediaItem, TransitionType, TransitionDir, TextStyle, TextAnim, Keyframe, Ease, Colour, AudioFx } from './model';
import { clipEnd, clipDuration, mediaOf, propAt, snapToFrame, projectDuration, neighbours, sourceTime, timelineAt, speedAt, RAMP_MIN, RAMP_MAX, TRANSITIONS, TRANSITION_DIRS, COLOUR_PRESETS, NEUTRAL_COLOUR, TEXT_ANIMS, EPS } from './model';
import { addTrack, clipsForMedia, overwrite, textClip, setTransition, defaultTransition, splitAt, trimStart, trimEnd, trimRange, partners, isLocked } from './ops';
import { mediaKey } from './media';
import { getIndex } from './mediaIndex';
import { decodeRange, mixdown } from './audio';
import { measureBuffer } from './loudness';
import { buildMasks } from './segmentMask';
import { loadLut, getLut } from './lut';
import { AUDIO_PRESETS, reduceNoise } from './audioFx';
import { REFRAME_ASPECTS, sizeFor, trackFaces, applyReframe, type ReframeAspect, type FaceSample } from './reframe';
import { buildIndex } from './mediaIndex';
import { alignScript, alignmentSummary, roughCut, takeSegments, setAlignment, getAlignment, wordsOf, type Word } from './scriptAlign';
import { startJob } from '../../lib/jobs';
import { uid } from '../../lib/util';
import { measurePicture } from './scopes';
import { renderStill } from './exporter';

/* ---------- Lanes: named tracks the plan writes to ---------- */

export type Lane = 'main' | 'broll' | 'overlay' | 'titles' | 'captions' | 'dialogue' | 'music' | 'sfx';
const LANES: Record<Lane, { name: string; kind: 'video' | 'audio' }> = {
  main: { name: 'Main', kind: 'video' },
  broll: { name: 'B-roll', kind: 'video' },
  overlay: { name: 'Overlay', kind: 'video' },
  titles: { name: 'Titles', kind: 'video' },
  captions: { name: 'Captions', kind: 'video' },
  dialogue: { name: 'Dialogue', kind: 'audio' },
  music: { name: 'Music', kind: 'audio' },
  sfx: { name: 'SFX', kind: 'audio' }
};

/**
 * The track for a lane: one with the lane's name, else (main/dialogue) the first track of that kind, else an empty
 * default-named track (V2, A2…) above the main one, renamed, else a new track on top.
 */
export function laneTrack(p: Project, lane: Lane): Track {
  const { name, kind } = LANES[lane];
  const named = p.tracks.find((t) => t.kind === kind && t.name.toLowerCase() === name.toLowerCase());
  if (named) return named;
  if (lane === 'main' || lane === 'dialogue') {
    const first = p.tracks.find((t) => t.kind === kind);
    if (first) return first;
  }
  const base = laneTrack(p, kind === 'video' ? 'main' : 'dialogue');
  const from = p.tracks.indexOf(base);
  const spare = p.tracks.find((t, i) => i > from && t.kind === kind && /^[VA]\d+$/.test(t.name) && !p.clips.some((c) => c.trackId === t.id));
  const t = spare || addTrack(p, kind);
  t.name = name;
  return t;
}

const findTrackByName = (p: Project, name: string) => p.tracks.find((t) => t.name.toLowerCase() === String(name).toLowerCase());

/* ---------- J / L cuts ---------- */

const audioPartner = (p: Project, c: Clip) =>
  p.tracks.find((t) => t.id === c.trackId)?.kind === 'audio' ? c : partners(p, c).find((x) => p.tracks.find((t) => t.id === x.trackId)?.kind === 'audio');

/**
 * Split edit at the cut where `incoming` starts. J: its sound starts `secs` early, under the end of the previous shot.
 * L: the previous shot's sound carries on `secs` into this one. Returns the seconds actually applied (limited by spare
 * source media and clip lengths); adds a short audio crossfade so the edit point is seamless.
 */
export function jlCut(p: Project, incoming: Clip, kind: 'J' | 'L', secs: number): number {
  const prev = neighbours(p, incoming).prev;
  if (!prev) throw new Error(`${incoming.name} doesn't start at a cut (nothing touches its start on that track).`);
  const ba = audioPartner(p, incoming);
  const aa = audioPartner(p, prev);
  if (!ba || !aa) throw new Error('Both shots need their linked sound for a J/L cut.');
  if (ba.trackId !== aa.trackId || Math.abs(clipEnd(aa) - ba.start) > 0.02) throw new Error('The two shots’ sound clips must touch on the same audio track.');
  let d: number;
  if (kind === 'J') {
    const [lo] = trimRange(p, ba, 'start');
    d = Math.max(0, Math.min(secs, -lo, clipDuration(aa) - 0.1));
    trimEnd(p, aa, -d);
    trimStart(p, ba, -d);
  } else {
    const [, hi] = trimRange(p, aa, 'end');
    d = Math.max(0, Math.min(secs, hi, clipDuration(ba) - 0.1));
    trimStart(p, ba, d);
    trimEnd(p, aa, d);
  }
  if (d > 0.01) setTransition(p, ba.id, 'in', { type: 'dissolve', duration: 0.08 });
  return d;
}

/* ---------- Ducking ---------- */

/** Timeline spans where speech plays on the given audio tracks (clip spans minus indexed silences ≥ minGap). */
export function speechRanges(p: Project, tracks: Track[], minGap = 0.8): [number, number][] {
  const ids = new Set(tracks.map((t) => t.id));
  const spans: [number, number][] = [];
  for (const c of p.clips) {
    if (!ids.has(c.trackId) || c.kind !== 'media') continue;
    const m = mediaOf(p, c);
    let parts: [number, number][] = [[c.start, clipEnd(c)]];
    const sil = m ? getIndex(mediaKey(m))?.silences : undefined;
    if (sil && !c.reverse) {
      for (const s of sil) {
        if (s.end - s.start < minGap) continue;
        const a = timelineAt(c, s.start);
        const b = timelineAt(c, s.end);
        parts = parts.flatMap(([x, y]): [number, number][] => (b <= x || a >= y ? [[x, y]] : ([[x, a], [b, y]] as [number, number][]).filter(([u, v]) => v - u > 0.05)));
      }
    }
    spans.push(...parts);
  }
  spans.sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && s[0] - last[1] < minGap) last[1] = Math.max(last[1], s[1]);
    else out.push([...s]);
  }
  return out;
}

/** Volume keyframes on a music clip that dip it by `depth` dB under each speech range. Replaces its volume animation. */
export function duckClip(c: Clip, ranges: [number, number][], depth = 14, attack = 0.25, release = 0.6) {
  const base = c.props.volume;
  const low = Math.max(-60, base - depth);
  const len = clipDuration(c);
  // Merge ranges closer than attack+release so the music doesn't bob up between sentences.
  const rs: [number, number][] = [];
  for (const [a0, b0] of ranges) {
    const a = a0 - c.start;
    const b = b0 - c.start;
    if (b <= 0 || a >= len) continue;
    const last = rs[rs.length - 1];
    if (last && a - last[1] < attack + release) last[1] = Math.max(last[1], b);
    else rs.push([a, b]);
  }
  if (!rs.length) {
    delete c.kf.volume;
    return 0;
  }
  const keys: Keyframe[] = [];
  const push = (t: number, v: number, ease: Ease = 'inOut') => {
    t = Math.max(0, Math.min(len, t));
    const last = keys[keys.length - 1];
    if (last && t <= last.t + 1e-3) last.v = v;
    else keys.push({ t, v, ease });
  };
  for (const [a, b] of rs) {
    push(a - attack, base);
    push(a, low);
    push(b, low);
    push(b + release, base);
  }
  c.kf.volume = keys;
  return rs.length;
}

/* ---------- Freeze frames, zooms, moves ---------- */

/** Hold the frame at timeline time `at` for `duration` s. ripple: push everything after it later (sync kept). */
export function freezeFrame(p: Project, c: Clip, at: number, duration: number, ripple = true): Clip {
  if (c.kind !== 'media' || mediaOf(p, c)?.kind !== 'video') throw new Error('Freeze frames need a video clip.');
  if (at < c.start - EPS || at > clipEnd(c) + EPS) throw new Error(`${at.toFixed(2)} s isn't inside ${c.name}.`);
  const fz: Clip = structuredClone(c);
  const src = sourceTime(c, at);
  for (const k of ['x', 'y', 'scale', 'rotation', 'opacity', 'blur'] as const) fz.props[k] = propAt(c, k, at);
  Object.assign(fz, { id: uid(), start: at, in: src, out: src + duration, speed: 1, reverse: false, freeze: src, ramp: undefined, linkId: undefined, trIn: undefined, trOut: undefined, kf: {}, name: `${c.name} (freeze)` });
  if (ripple) {
    splitAt(p, at);
    for (const x of p.clips) if (x.start >= at - EPS && !isLocked(p, x)) x.start += duration;
    for (const m of p.markers) if (m.t >= at - EPS) m.t += duration;
    p.clips.push(fz);
  } else overwrite(p, [fz]);
  return fz;
}

const keysWithout = (keys: Keyframe[] | undefined, a: number, b: number) => (keys || []).filter((k) => k.t < a - 1e-3 || k.t > b + 1e-3);
function placeKeys(c: Clip, prop: 'scale' | 'x' | 'y', add: Keyframe[]) {
  if (!add.length) return;
  const a = add[0].t;
  const b = add[add.length - 1].t;
  const keys = [...keysWithout(c.kf[prop], a, b), ...add].sort((u, v) => u.t - v.t);
  c.kf[prop] = keys;
}

/** Punch-in: zoom to `scale` % (optionally re-centred on x/y) at `at` (timeline s) for `duration` s (default: to the end). */
export function punchIn(c: Clip, at: number, opts: { scale?: number; duration?: number; x?: number; y?: number; style?: 'cut' | 'smooth' } = {}) {
  const len = clipDuration(c);
  const rel = Math.max(0, Math.min(len, at - c.start));
  const end = Math.min(len, opts.duration ? rel + opts.duration : len);
  const smooth = opts.style === 'smooth';
  const ramp = smooth ? Math.min(0.35, (end - rel) / 3) : 0;
  const props: ['scale' | 'x' | 'y', number | undefined][] = [
    ['scale', opts.scale ?? 115],
    ['x', opts.x],
    ['y', opts.y]
  ];
  for (const [prop, v] of props) {
    if (v === undefined) continue;
    const before = propAt(c, prop, c.start + rel - 1e-3);
    const after = propAt(c, prop, c.start + end + 1e-3);
    const ks: Keyframe[] = smooth
      ? [
          { t: rel, v: before, ease: 'inOut' },
          { t: rel + ramp, v, ease: 'hold' },
          { t: Math.max(rel + ramp, end - ramp), v, ease: 'inOut' },
          { t: end, v: after, ease: 'linear' }
        ]
      : [
          { t: Math.max(0, rel - 1e-3), v: before, ease: 'hold' },
          { t: rel, v, ease: 'hold' },
          ...(end < len - 1e-3 ? [{ t: end, v: after, ease: 'hold' as Ease }] : [])
        ];
    placeKeys(c, prop, ks);
  }
}

/* ---------- Sound processing ---------- */

export function resolveFx(fx: string | AudioFx): AudioFx {
  if (typeof fx === 'string') {
    const pr = AUDIO_PRESETS.find((x) => x.id === fx || x.label.toLowerCase() === fx.toLowerCase());
    if (!pr) throw new Error(`Sound preset must be one of: ${AUDIO_PRESETS.map((x) => x.id).join(', ')}.`);
    return { ...pr.fx };
  }
  const out: AudioFx = {};
  for (const k of ['highpass', 'low', 'mid', 'midFreq', 'high', 'compress'] as const) if (typeof fx[k] === 'number') out[k] = fx[k];
  return out;
}

/**
 * Noise reduction as a job: write the cleaned copy, import it, and move the sound clips (all of this media's, or just
 * `clip`'s linked group) onto it in one undo step. Returns the job id.
 */
export function startNoiseJob(store: AssistantEnv['store'], importPaths: (paths: string[]) => Promise<MediaItem[]>, media: MediaItem, amount: number, clip?: Clip) {
  return startJob('denoise', async (onProgress, signal) => {
    const out = await reduceNoise(media, amount, onProgress, signal);
    const [clean] = await importPaths([out]);
    let n = 0;
    store.getState().commit('Reduce noise', (d) => {
      if (!d.media.some((m) => m.id === clean.id)) d.media.push(clean);
      for (const c of d.clips) {
        if (c.mediaId !== media.id || d.tracks.find((t) => t.id === c.trackId)?.kind !== 'audio') continue;
        if (clip && c.id !== clip.id && (!clip.linkId || c.linkId !== clip.linkId)) continue;
        c.mediaId = clean.id;
        n++;
      }
    });
    return { cleanedFile: out, clipsMoved: n, amount };
  });
}

/* ---------- Speed ramps ---------- */

/**
 * Give a clip (and its linked sound, so they stay in sync) a speed ramp. keys: t = seconds from the clip's start,
 * v = speed. ripple: everything after the clip moves by the change in length. Returns that change (s).
 */
export function speedRamp(p: Project, c: Clip, keys: { t: number; v: number }[] | null, ripple = true): number {
  if (c.kind !== 'media' || mediaOf(p, c)?.kind === 'image') throw new Error('Speed ramps need a video or audio clip.');
  const group = [c, ...partners(p, c)];
  const oldEnd = clipEnd(c);
  const ks = keys?.length ? [...keys].map((k) => ({ t: Math.max(0, k.t), v: Math.max(RAMP_MIN, Math.min(RAMP_MAX, k.v)) })).sort((a, b) => a.t - b.t) : undefined;
  for (const g of group) g.ramp = ks ? ks.map((k) => ({ ...k })) : undefined;
  const delta = clipEnd(c) - oldEnd;
  if (ripple && Math.abs(delta) > 1e-6) {
    const ids = new Set(group.map((g) => g.id));
    for (const x of p.clips) if (!ids.has(x.id) && x.start >= oldEnd - EPS && !isLocked(p, x)) x.start += delta;
    for (const m of p.markers) if (m.t >= oldEnd - EPS) m.t += delta;
  }
  return delta;
}

/**
 * Ramp presets anchored on a moment in the SOURCE (so the moment itself is what gets the slow motion, wherever it
 * lands after the ramp): 'hero' = fast → slow-mo through the moment → fast; 'slow_down' / 'speed_up' from the moment on.
 */
export function rampPreset(c: Clip, kind: 'hero' | 'slow_down' | 'speed_up', atSource: number, o: { slow?: number; fast?: number; hold?: number; ease?: number } = {}) {
  const slow = Math.max(RAMP_MIN, Math.min(1, o.slow ?? 0.3));
  const fast = Math.max(1, Math.min(RAMP_MAX, o.fast ?? 1.8));
  const ease = Math.max(0.05, o.ease ?? 0.35);
  const hold = Math.max(0, o.hold ?? 0.6);
  const S = Math.max(0, c.reverse ? c.out - atSource : atSource - c.in); // source seconds into the clip
  if (kind === 'hero') {
    // Speed is `fast` until r-ease, then eases to `slow` at r: F(r) = fast·(r−ease) + (fast+slow)/2·ease = S.
    const r = Math.max(ease, (S - ((fast + slow) / 2) * ease) / fast + ease);
    return [
      { t: 0, v: fast },
      { t: r - ease, v: fast },
      { t: r, v: slow },
      { t: r + hold, v: slow },
      { t: r + hold + ease, v: fast }
    ];
  }
  const target = kind === 'slow_down' ? slow : fast;
  return [
    { t: S, v: 1 },
    { t: S + ease, v: target }
  ];
}

/** Ken Burns: a slow push/pan from one framing to another over the whole clip. */
export function kenBurns(c: Clip, from: { scale?: number; x?: number; y?: number }, to: { scale?: number; x?: number; y?: number }, ease: Ease = 'inOut') {
  const len = clipDuration(c);
  for (const prop of ['scale', 'x', 'y'] as const) {
    const a = from[prop] ?? (prop === 'scale' ? c.props.scale : c.props[prop]);
    const b = to[prop] ?? a;
    if (a === b && from[prop] === undefined) continue;
    c.kf[prop] = [
      { t: 0, v: a, ease },
      { t: len, v: b, ease: 'linear' }
    ];
  }
}

/* ---------- Titles and captions ---------- */

export type TitlePreset = 'title' | 'lower_third' | 'caption' | 'callout' | 'subtitle';
export const TITLE_PRESETS: TitlePreset[] = ['title', 'lower_third', 'caption', 'callout', 'subtitle'];

/** Style + position for a title preset, scaled to the frame. */
function titlePreset(p: Project, preset: TitlePreset): { style: Partial<TextStyle>; x: number; y: number } {
  const W = p.settings.width;
  const H = p.settings.height;
  const k = Math.min(W, H) / 1080;
  const tall = H > W;
  switch (preset) {
    case 'lower_third':
      return { style: { size: Math.round(52 * k), bold: true, align: 'left', box: '#000000', boxOpacity: 65, animIn: 'slideLeft', animOut: 'fade' }, x: tall ? 0 : -Math.round(W * 0.22), y: Math.round(H * (tall ? 0.28 : 0.3)) };
    case 'caption':
      return { style: { size: Math.round(54 * k), bold: true, align: 'center', box: '#000000', boxOpacity: 70, animIn: 'none', animOut: 'none' }, x: 0, y: Math.round(H * 0.33) };
    case 'callout':
      return { style: { size: Math.round(72 * k), bold: true, align: 'center', color: '#FFD400', outline: '#000000', outlineWidth: Math.max(2, Math.round(6 * k)), animIn: 'pop', animOut: 'fade' }, x: 0, y: -Math.round(H * 0.2) };
    case 'subtitle':
      return { style: { size: Math.round(44 * k), align: 'center', animIn: 'fade', animOut: 'fade' }, x: 0, y: Math.round(H * 0.12) };
    default:
      return { style: { size: Math.round((tall ? 96 : 110) * k), bold: true, align: 'center', animIn: 'pop', animOut: 'fade' }, x: 0, y: 0 };
  }
}

const TEXT_KEYS = ['font', 'size', 'color', 'bold', 'italic', 'align', 'box', 'boxOpacity', 'outline', 'outlineWidth', 'shadow', 'animIn', 'animOut', 'animDuration', 'lineHeight'] as const;
const pickStyle = (s: any): Partial<TextStyle> => {
  const out: any = {};
  if (s && typeof s === 'object') for (const k of TEXT_KEYS) if (s[k] !== undefined) out[k] = s[k];
  for (const k of ['animIn', 'animOut'] as const) if (out[k] && !TEXT_ANIMS.some((a) => a.id === out[k])) delete out[k];
  return out;
};

export function addTitle(p: Project, t: { text: string; at: number; duration?: number; preset?: TitlePreset; style?: any; x?: number; y?: number }, trackId?: string): Clip {
  const pr = titlePreset(p, t.preset && TITLE_PRESETS.includes(t.preset) ? t.preset : 'title');
  const c = textClip(p, Math.max(0, t.at), Math.max(0.2, t.duration ?? 3), { text: String(t.text), ...pr.style, ...pickStyle(t.style) }, trackId);
  c.props.x = t.x ?? pr.x;
  c.props.y = t.y ?? pr.y;
  overwrite(p, [c]);
  return c;
}

const wrapWords = (text: string, n: number) => {
  const w = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  for (let i = 0; i < w.length; i += n) lines.push(w.slice(i, i + n).join(' '));
  return lines.join('\n');
};

/** Caption groups from timed words: up to maxWords, breaking after punctuation or at a pause over 0.5 s. */
function wordGroups(words: Word[], maxWords: number) {
  const groups: Word[][] = [];
  let cur: Word[] = [];
  words.forEach((w, i) => {
    cur.push(w);
    const next = words[i + 1];
    const stop = /[.?!]["”’)]*$/.test(w.raw) || (cur.length >= 2 && /[,;:]$/.test(w.raw));
    if (cur.length >= maxWords || stop || (next && next.t0 - w.t1 > 0.5)) {
      groups.push(cur);
      cur = [];
    }
  });
  if (cur.length) groups.push(cur);
  return groups;
}

/**
 * Burned-in captions for a clip's speech, at the timeline times where its picture actually plays. With timed words
 * (any indexed clip — exact with a "+ word timing" speech model, estimated from the audio otherwise) each caption
 * appears as it's said; karaoke highlights the word being spoken.
 */
export function addCaptions(p: Project, media: MediaItem, trackId: string, opts: { maxWords?: number; style?: any; karaoke?: boolean | string; mode?: 'current' | 'progress' } = {}): number {
  const idx = getIndex(mediaKey(media));
  if (!idx) throw new Error(`Index ${media.name} first (index_media) so there's a transcript to caption.`);
  if (!idx.transcript || !idx.transcript.segments.length) throw new Error(idx.transcriptNote || `No speech was found in ${media.name}.`);
  const karaoke = opts.karaoke ? (typeof opts.karaoke === 'string' ? opts.karaoke : '#FFD400') : '';
  const maxWords = Math.max(1, Math.min(12, opts.maxWords || (karaoke ? 3 : 5)));
  const pr = titlePreset(p, 'caption');
  const style = { ...pr.style, ...(karaoke ? { box: '', outline: '#000000', outlineWidth: Math.max(3, Math.round(6 * Math.min(p.settings.width, p.settings.height) / 1080)), size: Math.round((pr.style.size || 54) * 1.25) } : {}), ...pickStyle(opts.style) };
  const fps = p.settings.fps;
  const clips = p.clips.filter((c) => c.kind === 'media' && c.mediaId === media.id && c.freeze === undefined && p.tracks.find((t) => t.id === c.trackId)?.kind === 'video');
  let n = 0;
  const emit = (a: number, b: number, text: string, starts?: number[]) => {
    const at = Math.max(0, snapToFrame(a, fps));
    const c = textClip(p, at, Math.max(0.3, b - a), { ...style, text, ...(karaoke && starts ? { karaoke: { words: starts.map((t) => Math.max(0, t - at)), color: karaoke, mode: opts.mode || 'current' } } : {}) }, trackId);
    c.props.y = pr.y;
    overwrite(p, [c]);
    n++;
  };
  const words = wordsOf(idx);
  if (words.length && (idx.transcript.words?.length || idx.envelope)) {
    // Map source times to the timeline through each clip that shows this media (trims, speed and cuts followed).
    const views = clips.length ? clips.filter((c) => !c.reverse) : [null];
    for (const g of wordGroups(words, maxWords)) {
      for (const clip of views) {
        const inside = clip ? g.filter((w) => w.t0 >= clip.in - 0.02 && w.t1 <= clip.out + 0.02) : g;
        if (!inside.length) continue;
        const tl = (t: number) => (clip ? timelineAt(clip, Math.max(clip.in, Math.min(clip.out, t))) : t);
        emit(tl(inside[0].t0), tl(inside[inside.length - 1].t1), inside.map((w) => w.raw).join(' '), inside.map((w) => tl(w.t0)));
      }
    }
    return n;
  }
  for (const seg of idx.transcript.segments) {
    if (!clips.length) emit(seg.start, seg.end, wrapWords(seg.text, maxWords));
    for (const clip of clips) {
      if (clip.reverse) continue;
      const s0 = Math.max(seg.start, clip.in);
      const e0 = Math.min(seg.end, clip.out);
      if (e0 > s0) emit(timelineAt(clip, s0), timelineAt(clip, e0), wrapWords(seg.text, maxWords));
    }
  }
  return n;
}

/* ---------- Looks ---------- */

function applyLook(c: Clip, look?: string, colour?: Partial<Colour>) {
  if (look) {
    const pr = COLOUR_PRESETS.find((x) => x.id === look || x.label.toLowerCase() === String(look).toLowerCase());
    if (!pr) throw new Error(`Look must be one of: ${COLOUR_PRESETS.map((x) => x.id).join(', ')}.`);
    c.colour = { ...NEUTRAL_COLOUR, ...pr.c };
  }
  if (colour && typeof colour === 'object') for (const k of Object.keys(NEUTRAL_COLOUR) as (keyof Colour)[]) if (typeof colour[k] === 'number') c.colour[k] = colour[k]!;
}

/* ---------- Loudness (renders audio → jobs) ---------- */

/** Integrated loudness of the mix (in/out range if set), before the master gain/limiter. */
export async function measureMix(p: Project, onProgress: (f: number) => void, signal?: AbortSignal) {
  const tmp: Project = structuredClone(p);
  tmp.settings.master = undefined;
  const a = p.inPoint ?? 0;
  const b = p.outPoint ?? projectDuration(p);
  if (b - a < 0.5) throw new Error('The timeline is too short to measure.');
  const mix = await mixdown(tmp, a, b, onProgress, signal);
  return measureBuffer(mix);
}

/** Loudness of each clip's own audio (its source range, before clip gain), for levelling dialogue. */
export async function measureClips(p: Project, clips: Clip[], onProgress: (f: number) => void, signal?: AbortSignal) {
  const out: { id: string; lufs: number }[] = [];
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const buf = await decodeRange(p, c, Math.min(c.in, c.out), Math.max(c.in, c.out), signal);
    out.push({ id: c.id, lufs: buf ? measureBuffer(buf).lufs : -Infinity });
    onProgress((i + 1) / clips.length);
  }
  return out;
}

const r1 = (v: number) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : v);

/* ---------- The plan ---------- */

interface Zoom {
  at: number;
  duration?: number;
  scale?: number;
  x?: number;
  y?: number;
  style?: 'cut' | 'smooth';
}
interface Move {
  scale?: number;
  x?: number;
  y?: number;
}
interface Tr {
  type: TransitionType;
  duration?: number;
  direction?: TransitionDir;
}
interface PlanMain {
  /** A script line (after align_script): plays its best take, or `take`. */
  line?: number;
  take?: number;
  /** Cut the long pauses out of the take (jump cuts). */
  tighten?: boolean;
  media_id?: string;
  in?: number;
  out?: number;
  gap?: number;
  transition?: Tr;
  j_cut?: number;
  l_cut?: number;
  speed?: number;
  volume_db?: number;
  look?: string;
  colour?: Partial<Colour>;
  zoom?: Zoom[];
  ken_burns?: { from: Move; to: Move };
  freeze_end?: number;
  remove_background?: boolean;
  /** Speed ramp keys {t: s from the shot's start, speed}, or a preset anchored on a source moment. */
  ramp?: { t: number; speed: number }[];
  hero?: { at_source: number; slow?: number; fast?: number; hold?: number };
  /** A .cube LUT (path) for this shot, or {path, amount}. */
  lut?: string | { path: string; amount?: number };
  /** Sound preset (voice, podcast, warm, bright, phone) or {highpass, low, mid, midFreq, high, compress}. */
  audio_fx?: string | AudioFx;
}
interface PlanBroll {
  media_id: string;
  in?: number;
  out?: number;
  at?: number;
  over?: number;
  offset?: number;
  duration?: number;
  transition_in?: Tr;
  transition_out?: Tr;
  keep_audio?: boolean;
  volume_db?: number;
  look?: string;
  colour?: Partial<Colour>;
  zoom?: Zoom[];
  ken_burns?: { from: Move; to: Move };
  position?: Move;
}
interface PlanTitle {
  text: string;
  at?: number;
  over?: number;
  offset?: number;
  duration?: number;
  preset?: TitlePreset;
  style?: any;
  x?: number;
  y?: number;
}
interface PlanAudio {
  media_id: string;
  at?: number;
  over?: number;
  offset?: number;
  in?: number;
  out?: number;
  duration?: number;
  volume_db?: number;
  fade_in?: number;
  fade_out?: number;
}
export interface EditPlan {
  replace?: boolean;
  settings?: { width?: number; height?: number; fps?: number; background?: string };
  main?: PlanMain[];
  broll?: PlanBroll[];
  titles?: PlanTitle[];
  captions?: { media_id?: string; max_words?: number; style?: any; karaoke?: boolean | string } | boolean;
  music?: PlanAudio[];
  duck?: { depth_db?: number; attack?: number; release?: number } | boolean;
  sfx?: PlanAudio[];
  fade_in?: number;
  fade_out?: number;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const validTr = (t?: Tr) => {
  if (!t) return null;
  const type = TRANSITIONS.find((x) => x.id === t.type)?.id;
  if (!type) throw new Error(`Transition type must be one of: ${TRANSITIONS.map((x) => x.id).join(', ')}.`);
  const tr = defaultTransition(type);
  if (typeof t.duration === 'number') tr.duration = Math.max(1 / 30, t.duration);
  if (t.direction && TRANSITION_DIRS.includes(t.direction)) tr.dir = t.direction;
  return tr;
};

/** Apply a plan to a draft project. Returns a summary + a map of where each storyline entry landed. */
type LineResolver = (line: number, take: number | undefined, tighten: boolean) => { media_id: string; in: number; out: number }[];

export function applyPlan(p: Project, plan: EditPlan, resolveLine?: LineResolver): { summary: string; main: { index: number; start: number; end: number; clip?: string; audio?: string }[]; needsMasks: MediaItem[] } {
  const media = (id?: string) => {
    const m = p.media.find((x) => x.id === id);
    if (!m) throw new Error(`No media with id ${id} in the bin. Import it first.`);
    return m;
  };
  if (plan.settings) {
    if (plan.settings.width) p.settings.width = even(plan.settings.width);
    if (plan.settings.height) p.settings.height = even(plan.settings.height);
    if (plan.settings.fps) p.settings.fps = Math.max(1, Math.round(plan.settings.fps));
    if (plan.settings.background) p.settings.background = plan.settings.background;
  }
  const fps = p.settings.fps;
  const snap = (t: number) => Math.max(0, snapToFrame(t, fps));
  // Storyline shots start on the next frame boundary: a ramped shot's length isn't a whole number of frames, and
  // rounding down would trim its end.
  const nextFrame = (t: number) => Math.max(0, Math.ceil(t * fps - 1e-6) / fps);
  if (plan.replace !== false) {
    p.clips = [];
    p.settings.master = undefined;
  }
  const notes: string[] = [];
  const needsMasks: MediaItem[] = [];
  const vMain = laneTrack(p, 'main');
  const aDia = laneTrack(p, 'dialogue');

  // 1. Storyline, back to back.
  const placed: { index: number; start: number; end: number; clip?: string; audio?: string }[] = [];
  let at = plan.replace === false ? Math.max(0, ...p.clips.filter((c) => c.trackId === vMain.id || c.trackId === aDia.id).map(clipEnd)) : 0;
  const mainEntries = plan.main || [];
  mainEntries.forEach((e, index) => {
    if (e.gap !== undefined && !e.media_id) {
      placed.push({ index, start: at, end: at + Math.max(0, e.gap) });
      at += Math.max(0, e.gap);
      return;
    }
    let segs: { media_id?: string; in?: number; out?: number }[] = [{ media_id: e.media_id, in: e.in, out: e.out }];
    if (typeof e.line === 'number') {
      if (!resolveLine) throw new Error('Run align_script first so storyline entries can use script lines.');
      segs = resolveLine(e.line, e.take, !!e.tighten);
    }
    const entryStart = nextFrame(at);
    const vs: Clip[] = [];
    let firstA: Clip | undefined;
    for (const sg of segs) {
      const m = media(sg.media_id);
      const clips = clipsForMedia(p, m, nextFrame(at), { vTrack: vMain.id, aTrack: aDia.id, in: sg.in, out: sg.out, findFree: false });
      const speed = typeof e.speed === 'number' ? Math.max(0.25, Math.min(4, e.speed)) : 1;
      for (const c of clips) {
        if (speed !== 1) {
          c.speed = speed;
          c.keepPitch = true;
        }
        if (typeof e.volume_db === 'number' && p.tracks.find((t) => t.id === c.trackId)?.kind === 'audio') c.props.volume = Math.max(-60, Math.min(12, e.volume_db));
      }
      // Ramps change the length, so they go on before the clips are placed.
      const rampKeys = e.hero ? rampPreset(clips[0], 'hero', e.hero.at_source, e.hero) : e.ramp?.length ? e.ramp.map((k) => ({ t: k.t, v: k.speed })) : null;
      if (rampKeys && segs.length === 1)
        for (const c of clips) c.ramp = rampKeys.map((k) => ({ t: Math.max(0, k.t), v: Math.max(RAMP_MIN, Math.min(RAMP_MAX, k.v)) })).sort((x, y) => x.t - y.t);
      overwrite(p, clips);
      const v = clips.find((c) => c.trackId === vMain.id);
      firstA = firstA || clips.find((c) => c.trackId === aDia.id);
      if (e.audio_fx) for (const c of clips) if (c.trackId === aDia.id) c.audioFx = resolveFx(e.audio_fx);
      if (v) {
        vs.push(v);
        applyLook(v, e.look, e.colour);
        if (e.lut) v.lut = typeof e.lut === 'string' ? { path: e.lut, amount: 100 } : { path: e.lut.path, amount: e.lut.amount ?? 100 };
        if (e.remove_background) {
          v.removeBg = { enabled: true };
          if (!needsMasks.includes(m)) needsMasks.push(m);
        }
      }
      at = Math.max(...clips.map(clipEnd));
    }
    // Moves apply to the first piece; each zoom goes on the piece playing at that moment.
    if (vs[0] && e.ken_burns) kenBurns(vs[0], e.ken_burns.from || {}, e.ken_burns.to || {});
    for (const z of e.zoom || []) {
      const t = entryStart + (z.at || 0);
      const v = vs.find((c) => t >= c.start - EPS && t < clipEnd(c)) || vs[0];
      if (v) punchIn(v, t, z);
    }
    let end = at;
    const lastV = vs[vs.length - 1];
    if (lastV && e.freeze_end && e.freeze_end > 0) {
      freezeFrame(p, lastV, clipEnd(lastV) - 1 / fps, e.freeze_end, false);
      end += e.freeze_end;
    }
    placed.push({ index, start: entryStart, end, clip: vs[0]?.id, audio: firstA?.id });
    at = end;
  });
  // Transitions and split edits need the neighbours in place, so they go second.
  mainEntries.forEach((e, k) => {
    const pl = placed[k];
    const v = pl.clip ? p.clips.find((c) => c.id === pl.clip) : undefined;
    if (!v) return;
    const tr = validTr(e.transition);
    if (tr) setTransition(p, v.id, 'in', tr);
    if (e.j_cut) {
      try {
        const d = jlCut(p, v, 'J', e.j_cut);
        if (d < e.j_cut - 0.05) notes.push(`J-cut on entry ${k} limited to ${r1(d)} s (not enough spare media).`);
      } catch (err) {
        notes.push(`J-cut on entry ${k} skipped: ${(err as Error).message}`);
      }
    }
    if (e.l_cut) {
      const next = placed[k + 1]?.clip ? p.clips.find((c) => c.id === placed[k + 1].clip) : undefined;
      if (!next) notes.push(`L-cut on entry ${k} skipped: nothing follows it.`);
      else
        try {
          const d = jlCut(p, next, 'L', e.l_cut);
          if (d < e.l_cut - 0.05) notes.push(`L-cut on entry ${k} limited to ${r1(d)} s (not enough spare media).`);
        } catch (err) {
          notes.push(`L-cut on entry ${k} skipped: ${(err as Error).message}`);
        }
    }
  });
  const anchor = (x: { at?: number; over?: number; offset?: number }) => {
    if (typeof x.over === 'number') {
      const pl = placed[x.over];
      if (!pl) throw new Error(`"over": ${x.over} doesn't match a storyline entry (0-${placed.length - 1}).`);
      return snap(pl.start + (x.offset || 0));
    }
    return snap(x.at || 0);
  };

  // 2. B-roll over the storyline.
  let nb = 0;
  if (plan.broll?.length) {
    const vB = laneTrack(p, 'broll');
    for (const b of plan.broll) {
      const m = media(b.media_id);
      const start = anchor(b);
      const inn = b.in ?? 0;
      const out = b.out ?? (b.duration !== undefined ? inn + b.duration : m.kind === 'image' ? inn + 4 : m.duration);
      const sfx = b.keep_audio ? laneTrack(p, 'sfx') : undefined;
      let clips = clipsForMedia(p, m, start, { vTrack: vB.id, aTrack: sfx?.id, in: m.kind === 'image' ? undefined : inn, out: m.kind === 'image' ? undefined : out, findFree: false });
      if (!b.keep_audio) clips = clips.filter((c) => c.trackId === vB.id);
      const v = clips.find((c) => c.trackId === vB.id);
      if (v && m.kind === 'image') v.out = Math.max(0.2, b.duration ?? out - inn);
      for (const c of clips) {
        c.linkId = b.keep_audio ? c.linkId : undefined;
        if (typeof b.volume_db === 'number' && c.trackId !== vB.id) c.props.volume = b.volume_db;
      }
      overwrite(p, clips);
      if (v) {
        applyLook(v, b.look, b.colour);
        if (b.position) {
          if (typeof b.position.scale === 'number') v.props.scale = b.position.scale;
          if (typeof b.position.x === 'number') v.props.x = b.position.x;
          if (typeof b.position.y === 'number') v.props.y = b.position.y;
        }
        if (b.ken_burns) kenBurns(v, b.ken_burns.from || {}, b.ken_burns.to || {});
        for (const z of b.zoom || []) punchIn(v, v.start + (z.at || 0), z);
        const ti = validTr(b.transition_in);
        const to = validTr(b.transition_out);
        if (ti) setTransition(p, v.id, 'in', ti);
        if (to) setTransition(p, v.id, 'out', to);
      }
      nb++;
    }
  }

  // 3. Titles.
  let nt = 0;
  if (plan.titles?.length) {
    const tT = laneTrack(p, 'titles');
    for (const t of plan.titles) {
      if (!t.text) continue;
      addTitle(p, { ...t, at: anchor(t) }, tT.id);
      nt++;
    }
  }

  // 4. Captions from the transcript of the storyline's media.
  let nc = 0;
  if (plan.captions) {
    const cap = typeof plan.captions === 'object' ? plan.captions : {};
    const tC = laneTrack(p, 'captions');
    const ids = cap.media_id ? [cap.media_id] : [...new Set(mainEntries.map((e) => e.media_id).filter(Boolean) as string[])];
    for (const id of ids) {
      try {
        nc += addCaptions(p, media(id), tC.id, { maxWords: cap.max_words, style: cap.style, karaoke: cap.karaoke });
      } catch (err) {
        notes.push(`Captions: ${(err as Error).message}`);
      }
    }
  }

  // 5. Music and SFX.
  const placeAudio = (list: PlanAudio[], lane: Lane) => {
    let n = 0;
    const tr = laneTrack(p, lane);
    for (const x of list) {
      const m = media(x.media_id);
      if (!m.hasAudio) throw new Error(`${m.name} has no sound.`);
      const start = anchor(x);
      const inn = x.in ?? 0;
      const total = projectDuration(p);
      const out = x.out ?? Math.min(m.duration, inn + (x.duration ?? (lane === 'music' ? Math.max(1, total - start) : m.duration - inn)));
      const clips = clipsForMedia(p, m, start, { aTrack: tr.id, in: inn, out, findFree: false }).filter((c) => c.trackId === tr.id);
      for (const c of clips) {
        c.linkId = undefined;
        c.props.volume = Math.max(-60, Math.min(12, x.volume_db ?? (lane === 'music' ? -18 : -6)));
        c.props.fadeIn = Math.max(0, x.fade_in ?? (lane === 'music' ? 1 : 0));
        c.props.fadeOut = Math.max(0, x.fade_out ?? (lane === 'music' ? 2 : 0));
      }
      overwrite(p, clips);
      n += clips.length;
    }
    return n;
  };
  const nm = plan.music?.length ? placeAudio(plan.music, 'music') : 0;
  const ns = plan.sfx?.length ? placeAudio(plan.sfx, 'sfx') : 0;

  // 6. Ducking: music dips under the storyline's speech.
  let nd = 0;
  if (nm && plan.duck !== false) {
    const d = typeof plan.duck === 'object' ? plan.duck : {};
    const ranges = speechRanges(p, [aDia]);
    const music = laneTrack(p, 'music');
    for (const c of p.clips.filter((x) => x.trackId === music.id)) nd += duckClip(c, ranges, d.depth_db ?? 14, d.attack ?? 0.25, d.release ?? 0.6);
  }

  // 7. Open from / close to black.
  const first = placed.find((x) => x.clip);
  const last = [...placed].reverse().find((x) => x.clip);
  if (plan.fade_in && first) {
    setTransition(p, first.clip!, 'in', { type: 'dipBlack', duration: plan.fade_in });
    const a = first.audio && p.clips.find((c) => c.id === first.audio);
    if (a) a.props.fadeIn = Math.max(a.props.fadeIn, Math.min(plan.fade_in, 1));
  }
  if (plan.fade_out && last) {
    setTransition(p, last.clip!, 'out', { type: 'dipBlack', duration: plan.fade_out });
    const end = projectDuration(p);
    for (const c of p.clips) if (p.tracks.find((t) => t.id === c.trackId)?.kind === 'audio' && clipEnd(c) > end - 0.05) c.props.fadeOut = Math.max(c.props.fadeOut, plan.fade_out);
  }

  const parts = [`${placed.filter((x) => x.clip).length} storyline shot${placed.length === 1 ? '' : 's'}`];
  if (nb) parts.push(`${nb} B-roll`);
  if (nt) parts.push(`${nt} title${nt === 1 ? '' : 's'}`);
  if (nc) parts.push(`${nc} caption${nc === 1 ? '' : 's'}`);
  if (nm) parts.push(`music${nd ? ` ducked under ${nd} speech passage${nd === 1 ? '' : 's'}` : ''}`);
  if (ns) parts.push(`${ns} sound effect${ns === 1 ? '' : 's'}`);
  const summary = `Applied the edit plan: ${parts.join(', ')}. Timeline is ${projectDuration(p).toFixed(2)} s.${notes.length ? ' Notes: ' + notes.join(' ') : ''}`;
  // Millisecond precision: agents anchor B-roll and titles on these times.
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  return { summary, main: placed.map((x) => ({ ...x, start: r3(x.start), end: r3(x.end) })), needsMasks };
}

/* ---------- Tools ---------- */

const TR_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: TRANSITIONS.map((t) => t.id) },
    duration: { type: 'number' },
    direction: { type: 'string', enum: TRANSITION_DIRS }
  },
  required: ['type']
};
const MOVE_SCHEMA = { type: 'object', properties: { scale: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' } } };
const ZOOM_SCHEMA = {
  type: 'array',
  items: { type: 'object', properties: { at: { type: 'number', description: 'Seconds from the clip’s start.' }, duration: { type: 'number' }, scale: { type: 'number', description: '% (115 = a 15% punch-in).' }, x: { type: 'number' }, y: { type: 'number' }, style: { type: 'string', enum: ['cut', 'smooth'] } }, required: ['at'] }
};
const ANCHOR_PROPS = {
  at: { type: 'number', description: 'Timeline seconds.' },
  over: { type: 'number', description: 'Index of a main storyline entry to anchor to (instead of at).' },
  offset: { type: 'number', description: 'Seconds after that entry starts.' }
};

export function proVideoTools(env: AssistantEnv): AssistantTool[] {
  const { store } = env;
  const edit = (label: string, fn: (p: Project) => string) => {
    let msg = '';
    store.getState().commit(label, (p) => {
      msg = fn(p);
    });
    return msg;
  };
  const clipIn = (p: Project, id: string) => {
    const c = p.clips.find((x) => x.id === id);
    if (!c) throw new Error(`No clip with id ${id}.`);
    if (isLocked(p, c)) throw new Error(`${c.name} is on a locked track.`);
    return c;
  };
  const startMasks = (items: MediaItem[]) => items.map((m) => startJob('segment', (onProgress, signal) => buildMasks(m, onProgress, signal)));
  const lineResolver = (): LineResolver | undefined => {
    const a = getAlignment(store);
    if (!a) return undefined;
    return (line, take, tighten) => {
      const L = a.lines.find((x) => x.index === line);
      if (!L) throw new Error(`No script line ${line} (0-${a.lines.length - 1}).`);
      const k = take ?? L.best;
      const t = L.takes[k];
      if (!t) throw new Error(L.takes.length ? `Line ${line} has takes 0-${L.takes.length - 1}.` : `Line ${line} ("${L.text.slice(0, 40)}") wasn't found in the footage.`);
      return takeSegments(t, tighten);
    };
  };

  return [
    {
      name: 'edit_plan',
      description: [
        'Build or extend a professional edit in ONE undo step, in editor language. Read the media index/transcript first (index_media), then describe the whole cut:',
        '• main: the storyline, back to back on the Main track with sound on Dialogue — [{line, take, tighten} (a script line after align_script) or {media_id, in, out}, plus transition:{type,duration,direction} (into this shot), j_cut:s (its sound starts early), l_cut:s (its sound runs into the next shot), speed, volume_db, look, colour:{exposure,contrast,saturation,temperature,tint,highlights,shadows,vignette}, zoom:[{at,duration,scale,x,y,style:"cut"|"smooth"}] (punch-ins, at = s from the shot start), ken_burns:{from:{scale,x,y},to:{…}}, freeze_end:s, ramp:[{t,speed}] or hero:{at_source,slow,fast,hold} (speed ramps), remove_background}] or {gap:s}.',
        '• broll: cutaways on the B-roll track — [{media_id, in, out | duration, at | over:entryIndex+offset, transition_in, transition_out, keep_audio, volume_db, look, zoom, ken_burns, position:{scale,x,y} (picture-in-picture)}].',
        `• titles: [{text, at | over+offset, duration, preset: ${TITLE_PRESETS.join('|')}, style, x, y}].`,
        '• captions: true or {media_id, max_words, style, karaoke: true | "#color"} — burned in as each phrase is said; karaoke highlights the word being spoken (TikTok style).',
        '• music: [{media_id, at, in, out, duration, volume_db (default -18), fade_in, fade_out}] — automatically ducked under speech (duck:{depth_db,attack,release} or false).',
        '• sfx: [{media_id, at | over+offset, volume_db}]. fade_in / fade_out: open from / close to black (picture + sound).',
        `Transitions: ${TRANSITIONS.map((t) => t.id).join(', ')} (wipe/slide/cover/whip take direction left|right|up|down). Looks: ${COLOUR_PRESETS.map((c) => c.id).join(', ')}.`,
        'replace (default true) clears the timeline first. Returns where every storyline entry landed. Then call normalize_loudness (e.g. -14 LUFS) and check frames with look.'
      ].join('\n'),
      input_schema: {
        type: 'object',
        properties: {
          replace: { type: 'boolean' },
          settings: { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' }, fps: { type: 'number' }, background: { type: 'string' } } },
          main: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                line: { type: 'number', description: 'Script line index (after align_script) — plays its best take.' },
                take: { type: 'number', description: 'Pick a specific take of that line.' },
                tighten: { type: 'boolean', description: 'Cut long pauses out of the take (jump cuts).' },
                media_id: { type: 'string' },
                in: { type: 'number' },
                out: { type: 'number' },
                gap: { type: 'number' },
                transition: TR_SCHEMA,
                j_cut: { type: 'number' },
                l_cut: { type: 'number' },
                speed: { type: 'number' },
                volume_db: { type: 'number' },
                look: { type: 'string' },
                colour: { type: 'object' },
                zoom: ZOOM_SCHEMA,
                ken_burns: { type: 'object', properties: { from: MOVE_SCHEMA, to: MOVE_SCHEMA } },
                freeze_end: { type: 'number' },
                remove_background: { type: 'boolean' },
                lut: { description: 'A .cube LUT path for this shot, or {path, amount 0-100}.' },
                audio_fx: { description: `Sound preset (${AUDIO_PRESETS.map((x) => x.id).join(', ')}) or {highpass, low, mid, midFreq, high, compress}.` },
                ramp: { type: 'array', items: { type: 'object', properties: { t: { type: 'number' }, speed: { type: 'number' } } }, description: 'Speed ramp keys (t = s from the shot start).' },
                hero: { type: 'object', properties: { at_source: { type: 'number' }, slow: { type: 'number' }, fast: { type: 'number' }, hold: { type: 'number' } }, description: 'Fast → slow-mo through the moment at source time at_source → fast.' }
              }
            }
          },
          broll: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                media_id: { type: 'string' },
                in: { type: 'number' },
                out: { type: 'number' },
                duration: { type: 'number' },
                ...ANCHOR_PROPS,
                transition_in: TR_SCHEMA,
                transition_out: TR_SCHEMA,
                keep_audio: { type: 'boolean' },
                volume_db: { type: 'number' },
                look: { type: 'string' },
                colour: { type: 'object' },
                zoom: ZOOM_SCHEMA,
                ken_burns: { type: 'object', properties: { from: MOVE_SCHEMA, to: MOVE_SCHEMA } },
                position: MOVE_SCHEMA
              },
              required: ['media_id']
            }
          },
          titles: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, ...ANCHOR_PROPS, duration: { type: 'number' }, preset: { type: 'string', enum: TITLE_PRESETS }, style: { type: 'object' }, x: { type: 'number' }, y: { type: 'number' } }, required: ['text'] } },
          captions: { description: 'true, or {media_id, max_words, style, karaoke: true | "#FFD400"}.' },
          music: { type: 'array', items: { type: 'object', properties: { media_id: { type: 'string' }, ...ANCHOR_PROPS, in: { type: 'number' }, out: { type: 'number' }, duration: { type: 'number' }, volume_db: { type: 'number' }, fade_in: { type: 'number' }, fade_out: { type: 'number' } }, required: ['media_id'] } },
          duck: { description: 'false, or {depth_db (default 14), attack, release}.' },
          sfx: { type: 'array', items: { type: 'object', properties: { media_id: { type: 'string' }, ...ANCHOR_PROPS, in: { type: 'number' }, out: { type: 'number' }, volume_db: { type: 'number' } }, required: ['media_id'] } },
          fade_in: { type: 'number' },
          fade_out: { type: 'number' }
        }
      },
      async run(i) {
        const plan = i as EditPlan;
        if (!plan || typeof plan !== 'object') throw new Error('Give an edit plan.');
        // LUTs load (and are checked) before anything changes.
        for (const e of plan.main || []) if (e.lut) await loadLut(typeof e.lut === 'string' ? e.lut : e.lut.path);
        let res: ReturnType<typeof applyPlan> | null = null;
        store.getState().commit('Apply edit plan', (p) => {
          res = applyPlan(p, plan, lineResolver());
        });
        const r = res as unknown as ReturnType<typeof applyPlan>;
        const jobs = startMasks(r.needsMasks);
        return JSON.stringify({ result: r.summary, storyline: r.main, ...(jobs.length ? { maskJobs: jobs } : {}) });
      }
    },
    {
      name: 'split_edit',
      description: 'J-cut or L-cut at the cut where a video clip starts. J: that shot’s sound starts `seconds` early under the previous shot (lead into a new speaker or scene). L: the previous shot’s sound carries on into this one. Needs linked sound on both sides; uses spare source media.',
      input_schema: { type: 'object', properties: { clip_id: { type: 'string', description: 'The incoming (right-hand) video clip.' }, type: { type: 'string', enum: ['J', 'L'] }, seconds: { type: 'number' } }, required: ['clip_id', 'type', 'seconds'] },
      run(i) {
        return edit(`${i.type}-cut`, (p) => {
          const d = jlCut(p, clipIn(p, i.clip_id), i.type === 'L' ? 'L' : 'J', Math.max(0, Number(i.seconds) || 0));
          return d > 0.01 ? `Made a ${r1(d)} s ${i.type}-cut.` : 'No spare media to make that cut — trim the clips first.';
        });
      }
    },
    {
      name: 'duck_music',
      description: 'Dip music under speech automatically: writes volume keyframes on the music clips so they drop by depth_db wherever the speech tracks have dialogue (uses the transcript index’s silences when available) and come back up in pauses.',
      input_schema: {
        type: 'object',
        properties: {
          music_track: { type: 'string', description: 'Default: the track named Music.' },
          speech_tracks: { type: 'array', items: { type: 'string' }, description: 'Default: Dialogue (or the first audio track).' },
          depth_db: { type: 'number' },
          attack: { type: 'number' },
          release: { type: 'number' },
          min_gap: { type: 'number', description: 'Pauses shorter than this (s) don’t let the music back up. Default 0.8.' }
        }
      },
      run(i) {
        return edit('Duck music', (p) => {
          const music = i.music_track ? findTrackByName(p, i.music_track) : p.tracks.find((t) => t.kind === 'audio' && t.name.toLowerCase() === 'music');
          if (!music) throw new Error('No music track. Name it Music or pass music_track.');
          const speech = i.speech_tracks?.length ? (i.speech_tracks as string[]).map((n) => findTrackByName(p, n)).filter(Boolean) as Track[] : [laneTrack(p, 'dialogue')];
          const ranges = speechRanges(p, speech, i.min_gap ?? 0.8);
          let n = 0;
          for (const c of p.clips.filter((x) => x.trackId === music.id)) n += duckClip(c, ranges, i.depth_db ?? 14, i.attack ?? 0.25, i.release ?? 0.6);
          return `Ducked ${music.name} under ${n} speech passage${n === 1 ? '' : 's'}.`;
        });
      }
    },
    {
      name: 'freeze_frame',
      description: 'Hold the frame of a video clip at a timeline time for some seconds (for emphasis, a title, or a punchline). ripple (default true) pushes everything after it later so sound stays in sync.',
      input_schema: { type: 'object', properties: { clip_id: { type: 'string' }, at: { type: 'number' }, duration: { type: 'number' }, ripple: { type: 'boolean' } }, required: ['clip_id', 'at'] },
      run(i) {
        return edit('Freeze frame', (p) => {
          const fz = freezeFrame(p, clipIn(p, i.clip_id), Number(i.at), Math.max(0.1, i.duration ?? 2), i.ripple !== false);
          return `Froze the frame at ${r1(i.at)} s for ${r1(clipDuration(fz))} s (clip ${fz.id}).`;
        });
      }
    },
    {
      name: 'punch_in',
      description: 'Punch-in zoom on a clip: at a timeline time, zoom to scale % (115 = 15% in) and optionally re-centre (x/y px from centre), for duration s (default to the clip end). style "cut" is an instant jump (jump-cut feel), "smooth" eases in and out.',
      input_schema: { type: 'object', properties: { clip_id: { type: 'string' }, at: { type: 'number' }, duration: { type: 'number' }, scale: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' }, style: { type: 'string', enum: ['cut', 'smooth'] } }, required: ['clip_id', 'at'] },
      run(i) {
        return edit('Punch in', (p) => {
          const c = clipIn(p, i.clip_id);
          punchIn(c, Number(i.at), i);
          return `Punched in to ${i.scale ?? 115}% at ${r1(i.at)} s on ${c.name}.`;
        });
      }
    },
    {
      name: 'reframe',
      description: `Reframe for vertical / square / 4:5 (or back to 16:9) keeping the speaker in frame: finds faces through each clip on-device, follows the main face with smooth camera-operator moves, and cover-scales + keyframes each clip. Also resizes the project (keeps the short side: 1920×1080 → 1080×1920). aspect: ${REFRAME_ASPECTS.join(' | ')}. clip_ids default to every video clip; smooth = seconds of smoothing (default 0.6; higher = calmer). Needs the face finder from Settings → AI image tools. Runs as a job; one undo step.`,
      input_schema: { type: 'object', properties: { aspect: { type: 'string', enum: REFRAME_ASPECTS }, clip_ids: { type: 'array', items: { type: 'string' } }, smooth: { type: 'number' } }, required: ['aspect'] },
      run(i) {
        const aspect = i.aspect as ReframeAspect;
        if (!REFRAME_ASPECTS.includes(aspect)) throw new Error(`aspect must be one of ${REFRAME_ASPECTS.join(', ')}.`);
        const proj = store.getState().project;
        const vids = proj.clips.filter((c) => c.kind === 'media' && proj.tracks.find((t) => t.id === c.trackId)?.kind === 'video' && mediaOf(proj, c)?.kind !== 'audio');
        const targets = i.clip_ids?.length ? vids.filter((c) => (i.clip_ids as string[]).includes(c.id)) : vids;
        if (!targets.length) throw new Error('No video clips to reframe.');
        const smooth = typeof i.smooth === 'number' ? Math.max(0, Math.min(5, i.smooth)) : 0.6;
        const jobId = startJob('reframe', async (onProgress, signal) => {
          const paths = new Map<string, FaceSample[]>();
          for (let k = 0; k < targets.length; k++) paths.set(targets[k].id, await trackFaces(proj, targets[k], (f, note) => onProgress((k + f) / targets.length, `${targets[k].name}: ${note || ''}`), signal));
          const report: { clip: string; facesFound: number; samples: number }[] = [];
          store.getState().commit(`Reframe ${aspect}`, (d) => {
            const size = sizeFor(d, aspect);
            d.settings.width = size.width;
            d.settings.height = size.height;
            d.settings.aspect = aspect;
            for (const [id, samples] of paths) {
              const c = d.clips.find((x) => x.id === id);
              if (!c) continue;
              const r = applyReframe(d, c, samples, smooth);
              report.push({ clip: c.name, facesFound: r.found, samples: r.samples });
            }
          });
          const noFace = report.filter((r) => !r.facesFound).map((r) => r.clip);
          return { aspect, size: sizeFor(proj, aspect), clips: report, ...(noFace.length ? { note: `No face found in ${noFace.join(', ')} — centred instead.` } : {}) };
        });
        return `Reframing ${targets.length} clip${targets.length === 1 ? '' : 's'} to ${aspect} (job ${jobId}). Poll kea_jobs_status {jobId:"${jobId}"}.`;
      }
    },
    {
      name: 'audio_fx',
      description: `Process sound clips: a preset (${AUDIO_PRESETS.map((x) => `${x.id} = ${x.hint}`).join(' ')}) and/or settings {highpass Hz, low/mid/high dB (mid centred on midFreq Hz), compress 0-100}. Heard live in the preview and in the export. Target clip_ids, a track by name, or the Dialogue track by default; clear:true removes it.`,
      input_schema: { type: 'object', properties: { preset: { type: 'string', enum: AUDIO_PRESETS.map((x) => x.id) }, highpass: { type: 'number' }, low: { type: 'number' }, mid: { type: 'number' }, midFreq: { type: 'number' }, high: { type: 'number' }, compress: { type: 'number' }, clip_ids: { type: 'array', items: { type: 'string' } }, track: { type: 'string' }, clear: { type: 'boolean' } } },
      run(i) {
        return edit(i.clear ? 'Remove sound processing' : 'Sound processing', (p) => {
          const tr = i.track ? findTrackByName(p, i.track) : laneTrack(p, 'dialogue');
          const targets = i.clip_ids?.length ? p.clips.filter((c) => (i.clip_ids as string[]).includes(c.id)) : p.clips.filter((c) => c.trackId === tr?.id && c.kind === 'media');
          if (!targets.length) throw new Error('No sound clips to process.');
          const fx = i.clear ? undefined : { ...(i.preset ? resolveFx(i.preset) : {}), ...resolveFx(i) };
          for (const c of targets) c.audioFx = fx;
          return i.clear ? `Removed sound processing from ${targets.length} clip${targets.length === 1 ? '' : 's'}.` : `Processed ${targets.length} clip${targets.length === 1 ? '' : 's'}: ${JSON.stringify(fx)}.`;
        });
      }
    },
    {
      name: 'reduce_noise',
      description: 'Remove steady background noise (hum, hiss, fans, air conditioning, room tone) from a clip’s sound: learns the noise from the quiet parts and gates it out. Writes a cleaned copy next to the source ("name (cleaned).wav") and moves the clip’s sound onto it (one undo step; the original file is untouched). amount 0-100 (default 70). Runs as a job.',
      input_schema: { type: 'object', properties: { clip_id: { type: 'string' }, media_id: { type: 'string' }, amount: { type: 'number' } } },
      run(i) {
        const proj = store.getState().project;
        const clip = i.clip_id ? proj.clips.find((c) => c.id === i.clip_id) : undefined;
        const media = clip ? mediaOf(proj, clip) : proj.media.find((m) => m.id === i.media_id);
        if (!media || !media.hasAudio) throw new Error('Give a clip_id or media_id with sound.');
        const jobId = startNoiseJob(store, env.importPaths, media, typeof i.amount === 'number' ? i.amount : 70, clip);
        return `Cleaning the sound (job ${jobId}). Poll kea_jobs_status {jobId:"${jobId}"}.`;
      }
    },
    {
      name: 'apply_lut',
      description: 'Grade clips with a 3D LUT (.cube file — film looks, camera log-to-Rec.709 conversions, LUT packs). Applied after the clip’s colour correction, blended by amount (0-100, default 100). Give clip_ids, or all:true for every video clip; remove:true takes it off.',
      input_schema: { type: 'object', properties: { path: { type: 'string', description: 'Absolute path to a .cube file.' }, clip_ids: { type: 'array', items: { type: 'string' } }, all: { type: 'boolean' }, amount: { type: 'number' }, remove: { type: 'boolean' } } },
      async run(i) {
        if (i.remove) i.path = '';
        else if (!i.path) throw new Error('Give the path of a .cube LUT (or remove:true).');
        if (i.path) await loadLut(String(i.path)); // validates the file before anything changes
        return edit(i.path ? 'Apply LUT' : 'Remove LUT', (p) => {
          const vids = p.clips.filter((c) => c.kind === 'media' && p.tracks.find((t) => t.id === c.trackId)?.kind === 'video' && mediaOf(p, c)?.kind !== 'audio');
          const targets = i.all ? vids : vids.filter((c) => (i.clip_ids || []).includes(c.id));
          if (!targets.length) throw new Error('Give clip_ids of video clips, or all:true.');
          for (const c of targets) c.lut = i.path ? { path: String(i.path), amount: Math.max(0, Math.min(100, i.amount ?? 100)) } : undefined;
          const title = i.path ? getLut(String(i.path))?.title : '';
          return i.path ? `Applied the ${title} LUT to ${targets.length} clip${targets.length === 1 ? '' : 's'}.` : `Removed the LUT from ${targets.length} clip${targets.length === 1 ? '' : 's'}.`;
        });
      }
    },
    {
      name: 'speed_ramp',
      description: `Speed ramp (time remapping) on a video clip and its sound. preset "hero" = fast → slow motion through a moment → fast (the moment is given in SOURCE seconds, at_source, e.g. from the transcript or scenes); "slow_down"/"speed_up" change speed from that moment on; or give keys [{t: seconds from the clip start, speed}] (${RAMP_MIN}-${RAMP_MAX}×, linear between keys). clear:true removes the ramp. Later clips move so everything stays in sync (ripple, default true).`,
      input_schema: {
        type: 'object',
        properties: {
          clip_id: { type: 'string' },
          preset: { type: 'string', enum: ['hero', 'slow_down', 'speed_up'] },
          at_source: { type: 'number' },
          slow: { type: 'number' },
          fast: { type: 'number' },
          hold: { type: 'number', description: 'Seconds of slow motion (hero).' },
          keys: { type: 'array', items: { type: 'object', properties: { t: { type: 'number' }, speed: { type: 'number' } }, required: ['t', 'speed'] } },
          clear: { type: 'boolean' },
          ripple: { type: 'boolean' }
        },
        required: ['clip_id']
      },
      run(i) {
        return edit('Speed ramp', (p) => {
          const c = clipIn(p, i.clip_id);
          let keys: { t: number; v: number }[] | null = null;
          if (!i.clear) {
            if (i.preset) {
              if (typeof i.at_source !== 'number') throw new Error('Give at_source: the source time of the moment.');
              keys = rampPreset(c, i.preset, i.at_source, i);
            } else if (Array.isArray(i.keys) && i.keys.length) keys = i.keys.map((k: any) => ({ t: Number(k.t), v: Number(k.speed) }));
            else throw new Error('Give a preset with at_source, or keys, or clear:true.');
          }
          const before = clipDuration(c);
          const d = speedRamp(p, c, keys, i.ripple !== false);
          return keys ? `Ramped ${c.name}: ${r1(before)} s → ${r1(clipDuration(c))} s (${d >= 0 ? '+' : ''}${r1(d)} s${i.ripple !== false ? ', later clips moved' : ''}).` : `Removed the speed ramp from ${c.name}.`;
        });
      }
    },
    {
      name: 'ken_burns',
      description: 'Slow push/pan over a whole clip (stills or video): from {scale,x,y} to {scale,x,y}.',
      input_schema: { type: 'object', properties: { clip_id: { type: 'string' }, from: MOVE_SCHEMA, to: MOVE_SCHEMA, ease: { type: 'string', enum: ['linear', 'in', 'out', 'inOut'] } }, required: ['clip_id', 'to'] },
      run(i) {
        return edit('Ken Burns', (p) => {
          const c = clipIn(p, i.clip_id);
          kenBurns(c, i.from || {}, i.to || {}, i.ease || 'inOut');
          return `Added a Ken Burns move to ${c.name}.`;
        });
      }
    },
    {
      name: 'add_title',
      description: `Add a styled title from a preset: ${TITLE_PRESETS.join(', ')} (lower_third = name/role strap, callout = bold yellow emphasis). style overrides any TextStyle field (font, size, color, bold, box, outline, animIn, animOut…).`,
      input_schema: { type: 'object', properties: { text: { type: 'string' }, at: { type: 'number' }, duration: { type: 'number' }, preset: { type: 'string', enum: TITLE_PRESETS }, style: { type: 'object' }, x: { type: 'number' }, y: { type: 'number' } }, required: ['text', 'at'] },
      run(i) {
        return edit('Add title', (p) => {
          const c = addTitle(p, i, laneTrack(p, 'titles').id);
          return `Added "${String(i.text).slice(0, 40)}" (${i.preset || 'title'}) at ${r1(c.start)} s (clip ${c.id}).`;
        });
      }
    },
    {
      name: 'align_script',
      description:
        'Match a script to raw footage: finds every take of every line in the clips (indexes them first if needed — transcription needs a speech model in Settings → Voice typing), scores each take (completeness, stumbles, fillers, pauses; later complete takes win ties) and picks the best, with cut points snapped into the pauses. Runs as a job; the result (and the resource kea://video/<tab>/script) lists lines → takes {take, media_id, in, out, score, said}. Then cut_to_script for the automatic rough cut, or edit_plan with main:[{line, take?, tighten?}, …] to choose yourself. [Bracketed] directions in the script come back as notes.',
      input_schema: { type: 'object', properties: { script: { type: 'string' }, media_ids: { type: 'array', items: { type: 'string' }, description: 'Default: every video/audio clip in the bin.' }, min_coverage: { type: 'number', description: 'How much of a line must be said to count as a take (default 0.5).' }, max_pause: { type: 'number', description: 'Pauses longer than this (s) inside a take are what tighten removes. Default 0.6.' } }, required: ['script'] },
      run(i) {
        const script = String(i.script || '');
        if (!script.trim()) throw new Error('Give the script text.');
        const proj = store.getState().project;
        const items = (i.media_ids?.length ? proj.media.filter((m) => (i.media_ids as string[]).includes(m.id)) : proj.media.filter((m) => m.kind !== 'image' && m.hasAudio));
        if (!items.length) throw new Error('No clips with sound in the bin to match the script against.');
        const jobId = startJob('align', async (onProgress, signal) => {
          const media: { item: MediaItem; idx: Awaited<ReturnType<typeof buildIndex>> }[] = [];
          for (let k = 0; k < items.length; k++) {
            const idx = await buildIndex(items[k], (f, note) => onProgress((k + f) / items.length * 0.95, note ? `${items[k].name}: ${note}` : undefined), signal);
            if (!idx.transcript) throw new Error(`${items[k].name}: ${idx.transcriptNote || 'no transcript'}.`);
            media.push({ item: items[k], idx });
          }
          onProgress(0.97, 'Matching the script…');
          const a = alignScript(script, media, { minCoverage: i.min_coverage, maxPause: i.max_pause });
          setAlignment(store, a);
          const sum = alignmentSummary(a);
          return { lineCount: a.lines.length, found: a.lines.length - sum.missing.length, takeCount: a.lines.reduce((n, L) => n + L.takes.length, 0), ...sum };
        });
        return `Matching the script to ${items.length} clip${items.length === 1 ? '' : 's'} (job ${jobId}). Poll kea_jobs_status {jobId:"${jobId}"}.`;
      }
    },
    {
      name: 'cut_to_script',
      description: 'Build the rough cut from align_script: the best take of every line in script order (or your picks via overrides {"<line>": take}), lines said in one go kept as one continuous clip, optional tighten (long pauses cut out — jump-cut style). Replaces the storyline in one undo step and returns where each line landed; then add B-roll, titles, music with edit_plan {replace:false, …}.',
      input_schema: { type: 'object', properties: { overrides: { type: 'object', description: '{"3": 1} = use take 1 for line 3.' }, tighten: { type: 'boolean' }, transition: TR_SCHEMA, captions: { type: 'boolean' } } },
      run(i) {
        const a = getAlignment(store);
        if (!a) throw new Error('Run align_script first.');
        const overrides: Record<number, number> = {};
        for (const [k, v] of Object.entries(i.overrides || {})) overrides[Number(k)] = Number(v);
        const runs = roughCut(a, { overrides, tighten: !!i.tighten });
        if (!runs.length) throw new Error('None of the script lines were found in the footage.');
        const main = runs.flatMap((r, k) => r.segments.map((s, j) => ({ ...s, ...(k > 0 && j === 0 && i.transition ? { transition: i.transition } : {}) })));
        let res: ReturnType<typeof applyPlan> | null = null;
        store.getState().commit('Cut to script', (p) => {
          res = applyPlan(p, { replace: true, main, captions: !!i.captions });
        });
        const r = res as unknown as ReturnType<typeof applyPlan>;
        // Map storyline pieces back to script lines.
        let n = 0;
        const lines = runs.map((run) => {
          const first = r.main[n];
          n += run.segments.length;
          const last = r.main[n - 1];
          return { lines: run.lines, start: first.start, end: last.end, pieces: run.segments.length };
        });
        const missing = a.lines.filter((L) => L.best < 0).map((L) => L.index);
        return JSON.stringify({ result: r.summary, lines, ...(missing.length ? { missingLines: missing } : {}) });
      }
    },
    {
      name: 'measure_picture',
      description:
        'Read the picture like a colourist reads scopes, as numbers: luma levels (black point, shadows, median, highlights, white point in %), clipping, the average colour of shadows / midtones / highlights with any cast named ("highlights blue +4%"), saturation and the dominant hue, plus plain-English notes. Use it before and after a grade, and to match shots (measure both, then set colour so the numbers agree). time: timeline seconds (default: the playhead); clip_id: measure that clip (at time, or its middle); solo: measure only that clip, without anything layered over it.',
      input_schema: { type: 'object', properties: { time: { type: 'number' }, clip_id: { type: 'string' }, solo: { type: 'boolean' } } },
      async run(i) {
        const proj = store.getState().project;
        const clip = i.clip_id ? proj.clips.find((c) => c.id === i.clip_id) : null;
        if (i.clip_id && !clip) throw new Error(`No clip with id ${i.clip_id}.`);
        const t = typeof i.time === 'number' ? i.time : clip ? clip.start + Math.min(1, clipDuration(clip) / 2) : store.getState().playhead;
        const p = clip && i.solo ? { ...proj, clips: [clip] } : proj;
        const w = 640;
        const h = Math.max(2, Math.round((w * proj.settings.height) / proj.settings.width));
        const cv = await renderStill(p, t, w, h);
        const img = cv.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h);
        return JSON.stringify({ time: Math.round(t * 1000) / 1000, ...(clip ? { clip: clip.name } : {}), ...measurePicture(img) });
      }
    },
    {
      name: 'measure_loudness',
      description: 'Measure the mix the way YouTube/TikTok/Spotify do: integrated loudness (LUFS, BS.1770) and peak, before the master gain. Runs as a job (poll kea_jobs_status).',
      input_schema: { type: 'object', properties: {} },
      run() {
        const p = store.getState().project;
        const jobId = startJob('loudness', async (onProgress, signal) => {
          const r = await measureMix(p, onProgress, signal);
          return { lufs: r1(r.lufs), peakDb: r1(r.peakDb), masterGainDb: p.settings.master?.gain ?? 0 };
        });
        return `Measuring (job ${jobId}). Poll kea_jobs_status {jobId:"${jobId}"}.`;
      }
    },
    {
      name: 'normalize_loudness',
      description: 'Set the whole mix to a loudness target (default -14 LUFS — YouTube, TikTok, Instagram, Spotify; -16 for podcasts) with a -1 dBFS peak limiter, as one undo step. Measures the mix first (job — poll kea_jobs_status). Run it last, after the edit.',
      input_schema: { type: 'object', properties: { target_lufs: { type: 'number' }, limiter: { type: 'boolean', description: 'Default true.' } } },
      run(i) {
        const target = typeof i.target_lufs === 'number' ? Math.max(-36, Math.min(-6, i.target_lufs)) : -14;
        const p = store.getState().project;
        const jobId = startJob('loudness', async (onProgress, signal) => {
          const r = await measureMix(p, onProgress, signal);
          if (!Number.isFinite(r.lufs)) throw new Error('The mix is silent — there is nothing to normalise.');
          const gain = Math.max(-30, Math.min(30, target - r.lufs));
          store.getState().commit('Normalize loudness', (d) => {
            d.settings.master = { gain: Math.round(gain * 10) / 10, limiter: i.limiter !== false };
          });
          return { measuredLufs: r1(r.lufs), targetLufs: target, masterGainDb: r1(gain), limiter: i.limiter !== false, peakBeforeDb: r1(r.peakDb) };
        });
        return `Normalising to ${target} LUFS (job ${jobId}). Poll kea_jobs_status {jobId:"${jobId}"}.`;
      }
    },
    {
      name: 'level_dialogue',
      description: 'Make every dialogue clip the same loudness (so takes and speakers match) by setting each clip’s gain: measures each clip (BS.1770) and sets gain to reach target_lufs (default -20, leaving headroom for normalize_loudness). One undo step; runs as a job.',
      input_schema: { type: 'object', properties: { track: { type: 'string', description: 'Default: Dialogue (or the first audio track).' }, clip_ids: { type: 'array', items: { type: 'string' } }, target_lufs: { type: 'number' } } },
      run(i) {
        const target = typeof i.target_lufs === 'number' ? i.target_lufs : -20;
        const p = store.getState().project;
        const tr = i.track ? findTrackByName(p, i.track) : p.tracks.find((t) => t.kind === 'audio' && t.name.toLowerCase() === 'dialogue') || p.tracks.find((t) => t.kind === 'audio');
        const clips = i.clip_ids?.length ? p.clips.filter((c) => (i.clip_ids as string[]).includes(c.id)) : p.clips.filter((c) => c.trackId === tr?.id && c.kind === 'media');
        if (!clips.length) throw new Error('No dialogue clips to level.');
        const jobId = startJob('loudness', async (onProgress, signal) => {
          const res = await measureClips(p, clips, onProgress, signal);
          const set = res.filter((r) => Number.isFinite(r.lufs)).map((r) => ({ id: r.id, lufs: r1(r.lufs), gain: r1(Math.max(-24, Math.min(24, target - r.lufs))) }));
          store.getState().commit('Level dialogue', (d) => {
            for (const s of set) {
              const c = d.clips.find((x) => x.id === s.id);
              if (c) c.props.gain = s.gain;
            }
          });
          return { targetLufs: target, clips: set, skippedSilent: res.length - set.length };
        });
        return `Levelling ${clips.length} clip${clips.length === 1 ? '' : 's'} to ${target} LUFS (job ${jobId}). Poll kea_jobs_status {jobId:"${jobId}"}.`;
      }
    }
  ];
}

