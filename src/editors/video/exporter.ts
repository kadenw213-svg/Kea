import {
  Output,
  Mp4OutputFormat,
  WebMOutputFormat,
  BufferTarget,
  StreamTarget,
  CanvasSource,
  AudioBufferSource,
  CanvasSink,
  Quality,
  canEncodeVideo,
  getFirstEncodableAudioCodec,
  WrappedCanvas,
  QualityLevel,
  AudioCodec,
  VideoCodec
} from 'mediabunny';
import type { Project, Clip } from './model';
import { mediaOf } from './model';
import { renderFrame, visibleLayers, frameTime, Drawable, FrameGetter } from './compositor';
import { ClipFx } from './effects';
import { mixdown, mixdownChunks, wavBytes, wavHeader, pcm16, MIX_RATE } from './audio';
import { imageFor, mediaKey, videoTrackOf } from './media';
import { openFileSink } from './host';
import { preloadLuts } from './lut';
import { ensureMasks } from './segmentMask';

/* Offline, frame-accurate rendering through the same compositor as the preview. */

export type ExportFormat = 'mp4' | 'webm' | 'm4a' | 'wav';

export interface ExportOptions {
  format: ExportFormat;
  width: number;
  height: number;
  fps: number;
  quality: QualityLevel;
  /** Video bitrate in kbit/s; 0 = let the quality setting decide. */
  bitrate: number;
  range: [number, number];
  audio: boolean;
  path: string;
  /** Video codec; 'auto' = H.264 in MP4, VP9 in WebM. */
  codec?: ExportCodec;
  /** The graphics card's encoder: 'auto' (use it when it accepts the job — better quality per bit), 'on', or 'off' (software). */
  hardware?: 'auto' | 'on' | 'off';
  /** Sound quality (default very high — AAC/Opus at a high bitrate). */
  audioQuality?: QualityLevel;
}

export type ExportCodec = 'auto' | 'avc' | 'hevc' | 'av1' | 'vp9';
export const EXPORT_CODECS: { id: ExportCodec; label: string; formats: ExportFormat[] }[] = [
  { id: 'auto', label: 'Automatic', formats: ['mp4', 'webm'] },
  { id: 'avc', label: 'H.264 (plays everywhere)', formats: ['mp4'] },
  { id: 'hevc', label: 'HEVC / H.265 (smaller files)', formats: ['mp4'] },
  { id: 'av1', label: 'AV1 (smallest, newest)', formats: ['mp4', 'webm'] },
  { id: 'vp9', label: 'VP9', formats: ['webm'] }
];

export interface EncoderSupport {
  avc: boolean;
  vp9: boolean;
  hevc: boolean;
  av1: boolean;
  mp4Audio: AudioCodec | null;
  webmAudio: AudioCodec | null;
  aac: boolean;
}

/** What this computer can encode at a size. */
export async function encoderSupport(width: number, height: number): Promise<EncoderSupport> {
  const [avc, vp9, hevc, av1, mp4Audio, webmAudio] = await Promise.all([
    canEncodeVideo('avc', { width, height }).catch(() => false),
    canEncodeVideo('vp9', { width, height }).catch(() => false),
    canEncodeVideo('hevc', { width, height }).catch(() => false),
    canEncodeVideo('av1', { width, height }).catch(() => false),
    getFirstEncodableAudioCodec(['aac', 'opus'], { numberOfChannels: 2, sampleRate: MIX_RATE }).catch(() => null),
    getFirstEncodableAudioCodec(['opus', 'vorbis'], { numberOfChannels: 2, sampleRate: MIX_RATE }).catch(() => null)
  ]);
  return { avc, vp9, hevc, av1, mp4Audio, webmAudio, aac: mp4Audio === 'aac' };
}

/* ---------- Decoded frames for offline rendering ---------- */

/**
 * Feeds the compositor exact frames from mediabunny. For each clip it works out every source
 * time it will need up front, so frames are decoded in one forward pass per clip.
 */
class OfflineFrames {
  private p: Project;
  private times: number[];
  private height: number;
  private plans = new Map<string, { need: Map<number, number>; iter: AsyncGenerator<WrappedCanvas | null> | null; sink: CanvasSink | null; last: Drawable | null; monotonic: boolean }>();
  private current = new Map<string, Drawable | 'offline'>();
  private images = new Map<string, ImageBitmap>();

  constructor(p: Project, times: number[], outHeight: number) {
    this.p = p;
    this.times = times;
    this.height = outHeight;
  }

  async prepare() {
    const p = this.p;
    for (let i = 0; i < this.times.length; i++) {
      const t = this.times[i];
      for (const layers of visibleLayers(p, t))
        for (const { clip, mod } of layers) {
          if (clip.kind !== 'media' || mod.hidden) continue;
          const m = mediaOf(p, clip);
          if (!m) continue;
          if (m.kind === 'image') {
            const key = mediaKey(m);
            if (!this.images.has(key)) this.images.set(key, await imageFor(key).catch(() => null as any));
            continue;
          }
          let plan = this.plans.get(clip.id);
          if (!plan) {
            plan = { need: new Map(), iter: null, sink: null, last: null, monotonic: true };
            this.plans.set(clip.id, plan);
          }
          plan.need.set(i, frameTime(p, clip, t));
        }
    }
    for (const [id, plan] of this.plans) {
      const clip = p.clips.find((c) => c.id === id)!;
      const m = mediaOf(p, clip)!;
      const vt = await videoTrackOf(mediaKey(m)).catch(() => null);
      if (!vt) continue;
      // Decode at the output size or the source size, whichever is smaller (zoomed-in clips keep detail up to 2×).
      const h = Math.min(m.height || this.height, this.height * 2);
      plan.sink = new CanvasSink(vt, { height: Math.max(2, Math.round(h / 2) * 2) });
      const ts = [...plan.need.values()];
      plan.monotonic = ts.every((v, k) => k === 0 || v >= ts[k - 1]);
      if (plan.monotonic) plan.iter = plan.sink.canvasesAtTimestamps(ts);
    }
  }

  /** Decode everything frame `i` needs. */
  async load(i: number) {
    this.current.clear();
    for (const [id, plan] of this.plans) {
      const ts = plan.need.get(i);
      if (ts === undefined) continue;
      if (!plan.sink) {
        this.current.set(id, 'offline');
        continue;
      }
      let w: WrappedCanvas | null = null;
      if (plan.iter) {
        const r = await plan.iter.next();
        w = r.done ? null : r.value;
      } else w = await plan.sink.getCanvas(ts);
      if (!w && !plan.last) {
        // Files without a seek index and with few keyframes (browser/screen recordings) can't be jumped into;
        // decode forward from the start and keep the last frame at or before the time.
        for await (const c of plan.sink.canvases(0, ts + 1e-3)) w = c;
      }
      if (w) plan.last = w.canvas;
      if (plan.last) this.current.set(id, plan.last);
    }
  }

  readonly getFrame: FrameGetter = (clip: Clip) => {
    const m = mediaOf(this.p, clip);
    if (!m) return 'offline';
    if (m.kind === 'image') return this.images.get(mediaKey(m)) || 'offline';
    return this.current.get(clip.id) ?? null;
  };

  async close() {
    for (const plan of this.plans.values()) await plan.iter?.return(undefined);
  }
}

/** One frame of the project, exactly as the export would draw it. */
export async function renderStill(p: Project, t: number, width: number, height: number): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const frames = new OfflineFrames(p, [t], canvas.height);
  await frames.prepare();
  await frames.load(0);
  renderFrame(canvas.getContext('2d')!, { project: p, t, scale: canvas.width / p.settings.width, getFrame: frames.getFrame, fx: new ClipFx() });
  await frames.close();
  return canvas;
}

/* ---------- Export ---------- */

export class Canceled extends Error {
  constructor() {
    super('Export canceled');
  }
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

export async function exportProject(p: Project, o: ExportOptions, onProgress: (fraction: number, note: string) => void, signal: AbortSignal): Promise<{ hardware?: boolean }> {
  let usedHardware: boolean | undefined;
  const [a, b] = o.range;
  const check = () => {
    if (signal.aborted) throw new Canceled();
  };
  const sink = await openFileSink(o.path);
  let output: Output | null = null;
  try {
    if (o.format === 'wav') {
      onProgress(0, 'Mixing audio…');
      if (sink.write) {
        // Straight to the file, piece by piece: a header, then each mixed piece as 16-bit PCM.
        const total = Math.max(1, Math.ceil((b - a) * MIX_RATE));
        await sink.write(0, wavHeader(2, MIX_RATE, total));
        let at = 44;
        await mixdownChunks(
          p,
          a,
          b,
          async (mix, from, n, f) => {
            check();
            const bytes = pcm16(mix, from, n);
            await sink.write!(at, bytes);
            at += bytes.length;
            onProgress(f * 0.98, 'Mixing audio…');
          },
          signal
        );
        check();
        await sink.finish(null);
      } else {
        const mix = await mixdown(p, a, b, (f) => onProgress(f * 0.9, 'Mixing audio…'), signal);
        check();
        await sink.finish(wavBytes(mix).buffer as ArrayBuffer);
      }
      onProgress(1, 'Done');
      return { hardware: false };
    }

    await preloadLuts(p);
    // Background-removal masks live in memory; rebuild any that are missing so the cutout is in the file.
    await ensureMasks(p, (f, note) => onProgress(0, note || `Removing backgrounds… ${Math.round(f * 100)}%`), signal);
    const audioOnly = o.format === 'm4a';
    const support = await encoderSupport(even(o.width), even(o.height));
    const format = o.format === 'webm' ? new WebMOutputFormat() : new Mp4OutputFormat({ fastStart: sink.write ? false : 'in-memory' });
    const buffer = sink.write ? null : new BufferTarget();
    const target = sink.write
      ? new StreamTarget(new WritableStream({ write: (chunk) => sink.write!(chunk.position, chunk.data) }), { chunked: true })
      : buffer!;
    output = new Output({ format, target });

    let video: CanvasSource | null = null;
    let canvas: HTMLCanvasElement | null = null;
    const W = even(o.width);
    const H = even(o.height);
    if (!audioOnly) {
      const want = o.codec && o.codec !== 'auto' ? o.codec : o.format === 'webm' ? 'vp9' : 'avc';
      const fits = EXPORT_CODECS.find((c) => c.id === want)?.formats.includes(o.format);
      if (!fits) throw new Error(`${want.toUpperCase()} can't go in a ${o.format.toUpperCase()} file.`);
      const codec: VideoCodec | null = support[want as 'avc' | 'hevc' | 'av1' | 'vp9'] ? (want as VideoCodec) : null;
      if (!codec) throw new Error(`This computer can't encode ${EXPORT_CODECS.find((c) => c.id === want)!.label.split(' (')[0]} at ${W}×${H}. Try H.264 or a smaller size.`);
      canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      const quality = o.bitrate > 0 ? new Quality({ bitrate: o.bitrate * 1000 }) : new Quality(o.quality);
      // Measured on photographic 1080p (Ryzen 7 7735U / Radeon 680M) against an 80 Mbps reference: at the same 8 Mbps
      // the graphics card's H.264 scored 34.4 dB PSNR vs 31.6 dB for the browser's software encoder, and at the
      // default quality 38.6 vs 30.1 dB (software undershoots its bitrate). So 'auto' prefers the graphics card
      // whenever it accepts the job; speed is about the same either way (rendering dominates).
      let hardwareAcceleration: 'prefer-hardware' | 'prefer-software' | 'no-preference' = o.hardware === 'off' ? 'prefer-software' : o.hardware === 'on' ? 'prefer-hardware' : 'no-preference';
      if (hardwareAcceleration === 'no-preference' && (await canEncodeVideo(codec, { width: W, height: H, quality, hardwareAcceleration: 'prefer-hardware' }).catch(() => false))) hardwareAcceleration = 'prefer-hardware';
      usedHardware = hardwareAcceleration === 'prefer-hardware' ? true : hardwareAcceleration === 'prefer-software' ? false : undefined;
      video = new CanvasSource(canvas, { codec, quality, keyFrameInterval: 2, hardwareAcceleration, latencyMode: 'quality' });
      output.addVideoTrack(video, { frameRate: o.fps });
    }
    let audio: AudioBufferSource | null = null;
    const audioCodec = o.format === 'webm' ? support.webmAudio : support.mp4Audio;
    if (o.audio || audioOnly) {
      if (!audioCodec) {
        if (audioOnly) throw new Error("This computer can't encode AAC audio. Export as WAV instead.");
      } else {
        audio = new AudioBufferSource({ codec: audioCodec, quality: new Quality(o.audioQuality || 'very-high') });
        output.addAudioTrack(audio);
      }
    }
    await output.start();

    // Sound first (it's quick), then every frame.
    const audioShare = audioOnly ? 0.95 : audio ? 0.12 : 0;
    if (audio) {
      onProgress(0, 'Mixing audio…');
      // Mixed in 30-second pieces (flat memory on long recordings), handed over in 5-second pieces so the encoder keeps up.
      await mixdownChunks(
        p,
        a,
        b,
        async (mix, from, len, f) => {
          const step = MIX_RATE * 5;
          for (let i = 0; i < len; i += step) {
            check();
            const n = Math.min(step, len - i);
            const part = new AudioBuffer({ numberOfChannels: mix.numberOfChannels, length: n, sampleRate: MIX_RATE });
            for (let k = 0; k < mix.numberOfChannels; k++) part.copyToChannel(mix.getChannelData(k).subarray(from + i, from + i + n), k);
            await audio!.add(part);
          }
          onProgress(audioShare * f, 'Mixing and encoding audio…');
        },
        signal
      );
      check();
      audio.close();
    }

    if (video && canvas) {
      const ctx = canvas.getContext('2d')!;
      const total = Math.max(1, Math.round((b - a) * o.fps));
      const times = Array.from({ length: total }, (_, i) => a + i / o.fps);
      onProgress(audioShare, 'Preparing media…');
      const frames = new OfflineFrames(p, times, H);
      await frames.prepare();
      const fx = new ClipFx();
      const scale = W / p.settings.width;
      const started = performance.now();
      try {
        for (let i = 0; i < total; i++) {
          check();
          await frames.load(i);
          renderFrame(ctx, { project: p, t: times[i], scale, getFrame: frames.getFrame, fx });
          await video.add(i / o.fps, 1 / o.fps);
          if (i % 3 === 0 || i === total - 1) {
            const done = (i + 1) / total;
            const secs = ((performance.now() - started) / 1000 / done) * (1 - done);
            onProgress(audioShare + (1 - audioShare) * done * 0.98, `Frame ${i + 1} of ${total}${done > 0.03 ? ` · about ${fmtLeft(secs)} left` : ''}`);
          }
        }
      } finally {
        await frames.close();
      }
      video.close();
    }
    onProgress(0.99, 'Finishing…');
    await output.finalize();
    await sink.finish(buffer ? buffer.buffer : null);
    onProgress(1, 'Done');
    return { hardware: usedHardware };
  } catch (err) {
    if (output && output.state !== 'finalized' && output.state !== 'canceled') await output.cancel().catch(() => {});
    await sink.abort().catch(() => {});
    throw err;
  }
}

function fmtLeft(s: number) {
  if (s < 60) return `${Math.max(1, Math.round(s))} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
