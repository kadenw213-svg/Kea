// Precompute per-frame foreground masks for a clip (AI background removal, no green screen). Running segmentation
// live in the draw loop would stall preview, so masks are built once as a job and cached; the compositor looks up the
// nearest cached mask and the ClipFx shader multiplies the frame's alpha by it — exactly like the chroma key.
// Reuses the Phase-3 segmentation worker (src/lib/segment.ts) and the video decode path (media.ts).
import { CanvasSink } from 'mediabunny';
import type { MediaItem, Project } from './model';
import { mediaKey, videoTrackOf } from './media';
import { segment } from '../../lib/segment';

const MASK_H = 256; // decode + segment + store masks at this height; the shader samples by uv so size doesn't matter
const MAX_FRAMES = 900;

interface MaskSet {
  times: number[]; // source times (seconds from the clip's first timestamp), ascending
  masks: HTMLCanvasElement[];
}
const cache = new Map<string, MaskSet>();

/** A foreground mask canvas (R=G=B=matte, opaque) the shader reads via texture2D(u_mask, uv).r. */
function maskCanvas(alpha: Uint8Array, w: number, h: number): HTMLCanvasElement {
  const d = new ImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const v = alpha[i];
    d.data[i * 4] = v;
    d.data[i * 4 + 1] = v;
    d.data[i * 4 + 2] = v;
    d.data[i * 4 + 3] = 255;
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d')!.putImageData(d, 0, 0);
  return c;
}

export const hasMasks = (key: string) => cache.has(key);

/** The nearest precomputed mask for a source time, or null (clip then shows whole until the job finishes). */
export function maskAt(key: string, srcTime: number): HTMLCanvasElement | null {
  const set = cache.get(key);
  if (!set || !set.times.length) return null;
  // Binary search for the closest time.
  let lo = 0;
  let hi = set.times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (set.times[mid] < srcTime) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(set.times[lo - 1] - srcTime) <= Math.abs(set.times[lo] - srcTime)) lo--;
  return set.masks[lo] || null;
}

/** Build and cache foreground masks for a clip's frames. Sampled at ~min(fps,12). Throws the segment() model error. */
export async function buildMasks(media: MediaItem, onProgress: (p: number, note?: string) => void, signal?: AbortSignal): Promise<{ frames: number }> {
  const key = mediaKey(media);
  const vt = await videoTrackOf(key);
  if (!vt) throw new Error('This clip has no video to segment.');
  const first = await vt.getFirstTimestamp();
  const rate = Math.min(12, Math.max(1, media.fps || 12));
  const n = Math.min(MAX_FRAMES, Math.max(1, Math.ceil(media.duration * rate)));
  const times = Array.from({ length: n }, (_, i) => first + (i / n) * media.duration);
  const sink = new CanvasSink(vt, { height: MASK_H });
  const tmp = document.createElement('canvas');
  const ctx = tmp.getContext('2d', { willReadFrequently: true })!;
  const set: MaskSet = { times: [], masks: [] };
  let i = 0;
  for await (const f of sink.canvasesAtTimestamps(times)) {
    if (signal?.aborted) throw new DOMException('Canceled', 'AbortError');
    if (f) {
      const c = f.canvas;
      tmp.width = c.width;
      tmp.height = c.height;
      ctx.drawImage(c as any, 0, 0);
      const img = ctx.getImageData(0, 0, c.width, c.height);
      const { alpha, width, height } = await segment({ data: img.data, width: c.width, height: c.height }, signal);
      set.times.push(times[i] - first);
      set.masks.push(maskCanvas(alpha, width, height));
    }
    onProgress((i + 1) / n, `Masking frame ${i + 1} of ${n}`);
    i++;
  }
  if (!set.masks.length) throw new Error('No frames could be segmented.');
  cache.set(key, set);
  return { frames: set.masks.length };
}

/** Media whose clips have background removal on but no masks yet (after reopening a project, say). */
export function missingMasks(p: Project): MediaItem[] {
  const out: MediaItem[] = [];
  for (const c of p.clips) {
    if (!c.removeBg?.enabled) continue;
    const m = p.media.find((x) => x.id === c.mediaId);
    if (m && m.kind === 'video' && !hasMasks(mediaKey(m)) && !out.includes(m)) out.push(m);
  }
  return out;
}

/** Build any masks the project needs but doesn't have (masks live in memory, so they're rebuilt after a reopen). */
export async function ensureMasks(p: Project, onProgress: (f: number, note?: string) => void = () => {}, signal?: AbortSignal) {
  const need = missingMasks(p);
  for (let k = 0; k < need.length; k++) await buildMasks(need[k], (f, note) => onProgress((k + f) / need.length, note), signal);
}

/** Drop a clip's cached masks (e.g. when its source changes). */
export const clearMasks = (key: string) => cache.delete(key);
