// Face-tracked reframing: turn a landscape clip into vertical (9:16), square or 4:5 that keeps the speaker in frame.
// Sample frames, find faces (on-device YuNet in the Kea engine), follow the main face (largest, preferring whoever was
// followed a moment ago), smooth the path like a camera operator would (outlier removal + zero-phase smoothing, so it
// pans calmly instead of twitching), then cover-scale the clip and keyframe its position — simplified to a few keys.
import { CanvasSink } from 'mediabunny';
import type { Project, Clip, Keyframe, Aspect } from './model';
import { mediaOf, timelineAt, clipDuration } from './model';
import { mediaKey, videoTrackOf, imageFor } from './media';
import { detectFaces, type Face } from '../../lib/faces';

export type ReframeAspect = '9:16' | '1:1' | '4:5' | '16:9';
export const REFRAME_ASPECTS: ReframeAspect[] = ['9:16', '1:1', '4:5', '16:9'];

/** Project size for an aspect, keeping the short side (so 1920×1080 → 1080×1920 for 9:16). */
export function sizeFor(p: Project, aspect: ReframeAspect): { width: number; height: number } {
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  const short = Math.min(p.settings.width, p.settings.height);
  const long = Math.max(p.settings.width, p.settings.height);
  if (aspect === '9:16') return { width: even(short), height: even((short * 16) / 9) };
  if (aspect === '1:1') return { width: even(short), height: even(short) };
  if (aspect === '4:5') return { width: even(short), height: even((short * 5) / 4) };
  return { width: even(long), height: even((long * 9) / 16) };
}

export interface FaceSample {
  /** Source seconds. */
  t: number;
  /** Face centre and width as fractions of the frame, or null if no face. */
  face: { x: number; y: number; w: number } | null;
}

const pixels = (c: CanvasImageSource, w: number, h: number) => {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(c, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
};

/** Pick the face to follow: the biggest, but stick with the one near the last position unless another is much bigger. */
function pick(faces: Face[], prev: { x: number; y: number } | null) {
  if (!faces.length) return null;
  const score = (f: Face) => {
    const cx = f.x + f.w / 2;
    const cy = f.y + f.h / 2;
    const near = prev ? Math.hypot(cx - prev.x, cy - prev.y) : 0;
    return f.w * f.h * (1 + f.score) - near * 0.02;
  };
  const f = faces.reduce((a, b) => (score(b) > score(a) ? b : a));
  return { x: f.x + f.w / 2, y: f.y + f.h / 2, w: f.w };
}

/** Find the main face through a clip's source range (≈ `rate` samples a second). */
export async function trackFaces(p: Project, c: Clip, onProgress: (f: number, note?: string) => void, signal?: AbortSignal, rate = 5): Promise<FaceSample[]> {
  const m = mediaOf(p, c);
  if (!m || m.kind === 'audio') throw new Error(`${c.name} has no picture to reframe.`);
  if (m.kind === 'image') {
    const bmp = await imageFor(mediaKey(m));
    const k = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
    const img = pixels(bmp, Math.round(bmp.width * k), Math.round(bmp.height * k));
    return [{ t: 0, face: pick(await detectFaces(img), null) }];
  }
  const vt = await videoTrackOf(mediaKey(m));
  if (!vt) throw new Error(`${c.name} has no picture to reframe.`);
  const first = await vt.getFirstTimestamp();
  const lo = Math.min(c.in, c.out);
  const hi = Math.max(c.in, c.out);
  const n = Math.max(1, Math.min(900, Math.ceil((hi - lo) * rate)));
  const times = Array.from({ length: n }, (_, i) => lo + ((i + 0.5) / n) * (hi - lo));
  const sink = new CanvasSink(vt, { height: 360 });
  const out: FaceSample[] = [];
  let prev: { x: number; y: number } | null = null;
  let i = 0;
  for await (const f of sink.canvasesAtTimestamps(times.map((t) => first + t))) {
    if (signal?.aborted) throw new DOMException('Canceled', 'AbortError');
    let face: FaceSample['face'] = null;
    if (f) {
      face = pick(await detectFaces(pixels(f.canvas as any, f.canvas.width, f.canvas.height)), prev);
      if (face) prev = face;
    }
    out.push({ t: times[i], face });
    onProgress((i + 1) / n, `Finding faces ${i + 1}/${n}`);
    i++;
  }
  return out;
}

/** Fill gaps, drop outliers (median of 5) and smooth with a zero-phase Gaussian (sigma in samples). */
export function smoothPath(v: (number | null)[], sigma: number): number[] {
  const n = v.length;
  if (!n) return [];
  const known = v.map((x, i) => (x === null ? -1 : i)).filter((i) => i >= 0);
  if (!known.length) return v.map(() => 0.5);
  const filled = v.map((x, i) => {
    if (x !== null) return x;
    const a = [...known].reverse().find((k) => k < i);
    const b = known.find((k) => k > i);
    if (a === undefined) return v[b!]!;
    if (b === undefined) return v[a]!;
    return v[a]! + ((v[b]! - v[a]!) * (i - a)) / (b - a);
  });
  const med = filled.map((_, i) => {
    const w = filled.slice(Math.max(0, i - 2), i + 3).sort((x, y) => x - y);
    return w[Math.floor(w.length / 2)];
  });
  if (sigma <= 0) return med;
  const R = Math.ceil(sigma * 3);
  const kern = Array.from({ length: 2 * R + 1 }, (_, k) => Math.exp(-((k - R) ** 2) / (2 * sigma * sigma)));
  return med.map((_, i) => {
    let s = 0;
    let wsum = 0;
    for (let k = -R; k <= R; k++) {
      const j = Math.min(n - 1, Math.max(0, i + k));
      s += med[j] * kern[k + R];
      wsum += kern[k + R];
    }
    return s / wsum;
  });
}

/** Ramer–Douglas–Peucker on (t, v) keys: keep the shape within `tol`. */
function simplify(keys: Keyframe[], tol: number): Keyframe[] {
  if (keys.length <= 2) return keys;
  const a = keys[0];
  const b = keys[keys.length - 1];
  let worst = 0;
  let at = -1;
  for (let i = 1; i < keys.length - 1; i++) {
    const k = keys[i];
    const v = a.v + ((b.v - a.v) * (k.t - a.t)) / Math.max(1e-9, b.t - a.t);
    const d = Math.abs(k.v - v);
    if (d > worst) (worst = d), (at = i);
  }
  if (worst <= tol) return [a, b];
  return [...simplify(keys.slice(0, at + 1), tol).slice(0, -1), ...simplify(keys.slice(at), tol)];
}

/**
 * Frame a clip on its face path for the project's current size: cover-scale (fills the frame), then keyframe x/y so
 * the face sits centred horizontally and at ~40 % from the top, never showing an edge. Returns faces found / samples.
 */
export function applyReframe(p: Project, c: Clip, samples: FaceSample[], smoothSeconds = 0.6, rate = 5) {
  const m = mediaOf(p, c)!;
  const W = p.settings.width;
  const H = p.settings.height;
  const mw = m.width || W;
  const mh = m.height || H;
  const fit = Math.min(W / mw, H / mh);
  const dw = mw * fit;
  const dh = mh * fit;
  const s = Math.max(W / dw, H / dh);
  const dispW = dw * s;
  const dispH = dh * s;
  const maxX = Math.max(0, (dispW - W) / 2);
  const maxY = Math.max(0, (dispH - H) / 2);
  const sigma = smoothSeconds * rate;
  const xs = smoothPath(samples.map((q) => q.face?.x ?? null), sigma);
  const ys = smoothPath(samples.map((q) => q.face?.y ?? null), sigma);
  const toX = (fx: number) => Math.max(-maxX, Math.min(maxX, -(fx - 0.5) * dispW));
  const toY = (fy: number) => Math.max(-maxY, Math.min(maxY, -0.1 * H - (fy - 0.5) * dispH));
  c.props.scale = Math.round(s * 1000) / 10;
  delete c.kf.scale;
  const found = samples.filter((q) => q.face).length;
  if (samples.length === 1 || m.kind === 'image') {
    c.props.x = Math.round(toX(xs[0]));
    c.props.y = Math.round(toY(ys[0]));
    delete c.kf.x;
    delete c.kf.y;
    return { found, samples: samples.length };
  }
  const len = clipDuration(c);
  const keysFor = (vals: number[], f: (v: number) => number) =>
    simplify(
      samples.map((q, i) => ({ t: Math.max(0, Math.min(len, timelineAt(c, q.t) - c.start)), v: Math.round(f(vals[i]) * 10) / 10, ease: 'linear' as const })).sort((a, b) => a.t - b.t),
      Math.max(2, W * 0.004)
    );
  const kx = keysFor(xs, toX);
  const ky = keysFor(ys, toY);
  if (kx.every((k) => Math.abs(k.v - kx[0].v) < 1)) {
    c.props.x = kx[0].v;
    delete c.kf.x;
  } else c.kf.x = kx;
  if (ky.every((k) => Math.abs(k.v - ky[0].v) < 1)) {
    c.props.y = ky[0].v;
    delete c.kf.y;
  } else c.kf.y = ky;
  return { found, samples: samples.length };
}

export const aspectOfReframe = (a: ReframeAspect): Aspect => a as Aspect;
