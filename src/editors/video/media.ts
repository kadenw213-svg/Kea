import { create } from 'zustand';
import { Input, ALL_FORMATS, BlobSource, UrlSource, CanvasSink, AudioBufferSink, InputVideoTrack, InputAudioTrack } from 'mediabunny';
import { uid } from '../../lib/util';
import { extOf } from '../../lib/fileTypes';
import type { MediaItem } from './model';
import { getBlob, host, IMAGE_EXTS } from './host';
import { loadImage } from '../../lib/util';

/* Reading media: inspecting files, thumbnails, film strips, waveforms and decoded images. */

export const mediaKey = (m: Pick<MediaItem, 'id' | 'path'>) => m.path || `mem:${m.id}`;

const inputs = new Map<string, Promise<Input>>();

/** A mediabunny Input for a file (cached). Streams through the host's media URL when there is one. */
export function inputFor(key: string): Promise<Input> {
  let p = inputs.get(key);
  if (!p) {
    p = (async () => {
      const h = host();
      const source = h.mediaUrl && !key.startsWith('mem:') ? new UrlSource(h.mediaUrl(key)) : new BlobSource(await getBlob(key));
      return new Input({ formats: ALL_FORMATS, source });
    })();
    inputs.set(key, p);
    p.catch(() => inputs.delete(key));
  }
  return p;
}

export function forgetInput(key: string) {
  const p = inputs.get(key);
  inputs.delete(key);
  p?.then((i) => i.dispose()).catch(() => {});
}

export async function videoTrackOf(key: string): Promise<InputVideoTrack | null> {
  const input = await inputFor(key);
  const t = await input.getPrimaryVideoTrack();
  return t && (await t.canDecode()) ? t : null;
}
export async function audioTrackOf(key: string): Promise<InputAudioTrack | null> {
  const input = await inputFor(key);
  const t = await input.getPrimaryAudioTrack();
  return t && (await t.canDecode()) ? t : null;
}

/** Look inside a file: what it is, how long, how big. Throws a plain-English error for files we can't use. */
export async function probe(path: string, name: string, key = path): Promise<MediaItem> {
  const ext = extOf(name);
  const base: MediaItem = { id: uid(), path, name, kind: 'video', duration: 0, width: 0, height: 0, fps: 30, hasAudio: false, hasVideo: false };
  if (IMAGE_EXTS.includes(ext)) {
    const img = await imageFor(key);
    return { ...base, kind: 'image', width: img.width, height: img.height, hasVideo: false };
  }
  const input = await inputFor(key);
  if (!(await input.canRead())) throw new Error(`${name} isn't a video or audio format Kea can read.`);
  const vt = await input.getPrimaryVideoTrack();
  const at = await input.getPrimaryAudioTrack();
  const canV = !!vt && (await vt.canDecode());
  const canA = !!at && (await at.canDecode());
  if (!canV && !canA) throw new Error(`${name} uses a codec this computer can't decode${vt ? ` (${(await vt.getCodec()) || 'unknown'})` : ''}.`);
  const duration = await input.computeDuration();
  let fps = 30;
  let width = 0;
  let height = 0;
  if (canV) {
    width = await vt!.getDisplayWidth();
    height = await vt!.getDisplayHeight();
    try {
      const stats = await vt!.computePacketStats(120);
      // (Recordings with uneven timestamps, like a browser's screen or webcam capture, can give a nonsense rate: keep 30.)
      if (stats.averagePacketRate >= 10 && stats.averagePacketRate <= 121) fps = Math.round(stats.averagePacketRate * 1000) / 1000;
    } catch {
      /* keep 30 */
    }
  }
  return { ...base, kind: canV ? 'video' : 'audio', duration, width, height, fps, hasVideo: canV, hasAudio: canA };
}

/* ---------- Thumbnails, film strips and waveforms (kept in memory, shared by every editor) ---------- */

export interface Peaks {
  /** Buckets per second. */
  rate: number;
  data: Float32Array;
}

interface MediaCache {
  thumbs: Record<string, string>;
  strips: Record<string, { t: number; url: string }[]>;
  peaks: Record<string, Peaks>;
  missing: Record<string, boolean>;
  set(patch: Partial<Omit<MediaCache, 'set'>>): void;
}

export const useMediaCache = create<MediaCache>((set) => ({
  thumbs: {},
  strips: {},
  peaks: {},
  missing: {},
  set: (patch) => set((s) => ({ thumbs: { ...s.thumbs, ...patch.thumbs }, strips: { ...s.strips, ...patch.strips }, peaks: { ...s.peaks, ...patch.peaks }, missing: { ...s.missing, ...patch.missing } }))
}));

const started = new Set<string>();
function once(tag: string, key: string, fn: () => Promise<void>) {
  const k = `${tag}:${key}`;
  if (started.has(k)) return;
  started.add(k);
  fn().catch((err) => {
    console.warn(`video ${tag} failed`, key, err);
    started.delete(k);
  });
}

function canvasToUrl(c: HTMLCanvasElement | OffscreenCanvas, w: number, h: number) {
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  out.getContext('2d')!.drawImage(c as CanvasImageSource, 0, 0, w, h);
  return out.toDataURL('image/jpeg', 0.72);
}

/** Start making the bin thumbnail, film strip and waveform for a piece of media. */
export function warmMedia(m: MediaItem) {
  const key = mediaKey(m);
  if (m.kind === 'image') {
    once('thumb', key, async () => {
      const img = await imageFor(key);
      const h = 108;
      const w = Math.max(1, Math.round((img.width / img.height) * h));
      const url = canvasToUrl(img as any, w, h);
      useMediaCache.getState().set({ thumbs: { [key]: url }, strips: { [key]: [{ t: 0, url }] } });
    });
    return;
  }
  if (m.hasVideo) {
    once('thumb', key, async () => {
      const vt = await videoTrackOf(key);
      if (!vt) return;
      const sink = new CanvasSink(vt, { height: 108 });
      const first = await vt.getFirstTimestamp();
      const frame = await sink.getCanvas(first + Math.min(1, m.duration * 0.1));
      if (frame) useMediaCache.getState().set({ thumbs: { [key]: canvasToUrl(frame.canvas, frame.canvas.width, frame.canvas.height) } });
      // Film strip: a frame every few seconds (up to 40) for the timeline.
      const n = Math.max(2, Math.min(40, Math.ceil(m.duration / 2)));
      const stripSink = new CanvasSink(vt, { height: 56 });
      const times = Array.from({ length: n }, (_, i) => first + (i / n) * m.duration);
      const strip: { t: number; url: string }[] = [];
      let i = 0;
      for await (const f of stripSink.canvasesAtTimestamps(times)) {
        if (f) strip.push({ t: times[i], url: canvasToUrl(f.canvas, f.canvas.width, f.canvas.height) });
        i++;
      }
      useMediaCache.getState().set({ strips: { [key]: strip } });
    });
  }
  if (m.hasAudio) once('peaks', key, async () => void (await peaksFor(m)));
}

const peakJobs = new Map<string, Promise<Peaks | null>>();

/** Loudest sample in each small slice of the file (used for waveforms and Normalize). */
export function peaksFor(m: MediaItem): Promise<Peaks | null> {
  const key = mediaKey(m);
  const have = useMediaCache.getState().peaks[key];
  if (have) return Promise.resolve(have);
  let job = peakJobs.get(key);
  if (!job) {
    job = (async () => {
      const at = await audioTrackOf(key);
      if (!at) return null;
      const rate = m.duration > 1200 ? 25 : m.duration > 300 ? 60 : 120;
      const data = new Float32Array(Math.ceil(m.duration * rate) + 1);
      const sink = new AudioBufferSink(at);
      let lastPush = performance.now();
      for await (const { buffer, timestamp } of sink.buffers()) {
        const sr = buffer.sampleRate;
        const chans = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
        const step = Math.max(1, Math.floor(sr / rate / 8));
        for (let i = 0; i < buffer.length; i += step) {
          let v = 0;
          for (const ch of chans) v = Math.max(v, Math.abs(ch[i]));
          const b = Math.floor((timestamp + i / sr) * rate);
          if (b >= 0 && b < data.length && v > data[b]) data[b] = v;
        }
        if (performance.now() - lastPush > 1500) {
          lastPush = performance.now();
          useMediaCache.getState().set({ peaks: { [key]: { rate, data: data.slice() } } });
        }
      }
      const p = { rate, data };
      useMediaCache.getState().set({ peaks: { [key]: p } });
      return p;
    })();
    peakJobs.set(key, job);
    job.catch(() => peakJobs.delete(key));
  }
  return job;
}

/* ---------- Still images ---------- */

const images = new Map<string, Promise<ImageBitmap>>();
const readyImages = new Map<string, ImageBitmap>();

export function imageFor(key: string): Promise<ImageBitmap> {
  let p = images.get(key);
  if (!p) {
    p = getBlob(key).then(async (b) => {
      if (b.type !== 'image/svg+xml') return createImageBitmap(b);
      // SVGs have to go through an <img> first.
      const url = URL.createObjectURL(b);
      try {
        return await createImageBitmap(await loadImage(url));
      } finally {
        URL.revokeObjectURL(url);
      }
    });
    images.set(key, p);
    p.then((img) => readyImages.set(key, img)).catch(() => images.delete(key));
  }
  return p;
}
/** The decoded image if it's ready, else starts decoding and returns undefined. */
export function imageNow(key: string, onReady?: () => void): ImageBitmap | undefined {
  const img = readyImages.get(key);
  if (img) return img;
  imageFor(key).then(() => onReady?.(), () => {});
  return undefined;
}
