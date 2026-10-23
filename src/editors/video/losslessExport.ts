// Export that keeps the original quality where it can. When the timeline is a single, unmodified trim of one source
// file (the common "trim my raw recording" case), we stream-copy the packets with mediabunny's Conversion — no
// re-encode, no quality loss. Anything with effects, transitions, speed, overlays, or multiple cuts falls back to the
// existing frame-accurate re-encoder (exporter.ts). (General multi-cut stream-copy is a later step.)
import { Conversion, Output, Mp4OutputFormat, BufferTarget, StreamTarget } from 'mediabunny';
import type { Project, Clip } from './model';
import { mediaOf, projectDuration, clipEnd, DEFAULT_PROPS, NEUTRAL_COLOUR } from './model';
import { inputFor, mediaKey } from './media';
import { openFileSink } from './host';
import { exportProject, Canceled, type ExportOptions } from './exporter';

export interface ExportResult {
  mode: 'copied' | 'reencoded';
  path: string;
  note: string;
  /** Re-encodes: true if the graphics card's encoder was requested, false for software, absent when the computer chose. */
  hardware?: boolean;
}

export type VideoExportRequest = { path: string; lossless?: boolean; format?: ExportOptions['format']; quality?: ExportOptions['quality']; bitrate?: number; range?: [number, number]; audio?: boolean; width?: number; height?: number; fps?: number; codec?: ExportOptions['codec']; hardware?: ExportOptions['hardware']; audioQuality?: ExportOptions['audioQuality'] };

const CHANGED = (a: Record<string, unknown>, b: Record<string, unknown>) => Object.keys(b).some((k) => a[k] !== b[k]);

/**
 * Is the export exactly one unmodified media clip (optionally with its untouched linked sound), starting at 0 and
 * exported whole at its own size — i.e. would copying the source packets give the same result as rendering?
 */
function eligible(p: Project, o: Partial<VideoExportRequest> = {}): { ok: true; clip: Clip; audio: boolean } | { ok: false; reason: string } {
  const vTracks = new Set(p.tracks.filter((t) => t.kind === 'video').map((t) => t.id));
  const videoClips = p.clips.filter((c) => c.kind === 'media' && vTracks.has(c.trackId));
  const overlays = p.clips.filter((c) => c.kind !== 'media');
  if (overlays.length) return { ok: false, reason: 'the timeline has text/shape overlays' };
  if (videoClips.length !== 1) return { ok: false, reason: videoClips.length === 0 ? 'no video clip' : 'more than one video cut (multi-cut lossless isn’t supported yet)' };
  const c = videoClips[0];
  const m = mediaOf(p, c);
  if (!m?.path) return { ok: false, reason: 'the clip isn’t a file on disk' };
  if (m.kind === 'image') return { ok: false, reason: 'it’s a still image' };
  if (c.speed !== 1 || c.reverse || c.ramp?.length) return { ok: false, reason: 'the clip’s speed is changed' };
  if (c.trIn || c.trOut) return { ok: false, reason: 'the clip has a transition' };
  if (c.blend && c.blend !== 'normal') return { ok: false, reason: 'the clip uses a blend mode' };
  if (c.key?.enabled) return { ok: false, reason: 'chroma key is on' };
  if (c.crop && (c.crop.left || c.crop.right || c.crop.top || c.crop.bottom)) return { ok: false, reason: 'the clip is cropped' };
  if (Object.values(c.kf || {}).some((ks) => ks && (ks as unknown[]).length)) return { ok: false, reason: 'the clip has keyframes' };
  if (CHANGED(c.props as any, DEFAULT_PROPS as any)) return { ok: false, reason: 'the clip’s transform/opacity/volume is changed' };
  if (c.colour && CHANGED(c.colour as any, NEUTRAL_COLOUR as any)) return { ok: false, reason: 'the clip is colour-graded' };
  if (c.lut) return { ok: false, reason: 'the clip has a LUT' };
  if (c.removeBg?.enabled) return { ok: false, reason: 'background removal is on' };
  if (c.freeze !== undefined) return { ok: false, reason: 'it’s a freeze frame' };
  if (c.start > 1e-3) return { ok: false, reason: 'the clip doesn’t start at the beginning of the timeline' };
  if (o.range && (Math.abs(o.range[0]) > 1e-3 || Math.abs(o.range[1] - clipEnd(c)) > 1e-3)) return { ok: false, reason: 'only part of the timeline is being exported' };
  if (o.width || o.height || o.fps) return { ok: false, reason: 'a different size or frame rate was asked for' };
  if (p.settings.master && (p.settings.master.gain || p.settings.master.limiter)) return { ok: false, reason: 'loudness normalisation is on' };
  // Sound: only the clip's own linked sound, untouched and in step with the picture.
  const aTracks = new Set(p.tracks.filter((t) => t.kind === 'audio').map((t) => t.id));
  const sound = p.clips.filter((x) => aTracks.has(x.trackId));
  for (const a of sound) {
    if (!c.linkId || a.linkId !== c.linkId) return { ok: false, reason: 'there’s other sound on the timeline (music, effects…)' };
    if (a.mediaId !== c.mediaId || Math.abs(a.start - c.start) > 1e-3 || Math.abs(a.in - c.in) > 1e-3 || Math.abs(a.out - c.out) > 1e-3) return { ok: false, reason: 'the sound has been moved or replaced' };
    if (a.audioFx || a.trIn || a.trOut || Object.values(a.kf || {}).some((ks) => ks && (ks as unknown[]).length) || CHANGED(a.props as any, DEFAULT_PROPS as any)) return { ok: false, reason: 'the sound is processed or its level changed' };
    const tr = p.tracks.find((t) => t.id === a.trackId);
    if (tr && (tr.volume || tr.muted)) return { ok: false, reason: 'the sound track’s level is changed' };
  }
  // No sound on the timeline (deleted, or export without audio) → the copy must be silent too.
  return { ok: true, clip: c, audio: sound.length > 0 && o.audio !== false };
}

async function streamCopyTrim(p: Project, clip: Clip, audio: boolean, path: string, onProgress: (f: number, note: string) => void, signal: AbortSignal): Promise<void> {
  const m = mediaOf(p, clip)!;
  const input = await inputFor(mediaKey(m));
  const sink = await openFileSink(path);
  const buffer = sink.write ? null : new BufferTarget();
  const target = sink.write ? new StreamTarget(new WritableStream({ write: (chunk) => sink.write!(chunk.position, chunk.data) }), { chunked: true }) : buffer!;
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: sink.write ? false : 'in-memory' }), target });
  try {
    const conv = await Conversion.init({ input, output, trim: { start: clip.in, end: clip.out }, ...(audio ? {} : { audio: { discard: true } }) });
    conv.onProgress = (pr) => onProgress(Math.min(0.98, pr), 'Copying (no re-encode)…');
    if (!conv.isValid) throw new Error('these tracks can’t be copied as-is');
    signal.addEventListener('abort', () => conv.cancel().catch(() => {}), { once: true });
    await conv.execute();
    if (signal.aborted) throw new Canceled();
    await sink.finish(buffer ? buffer.buffer : null);
    onProgress(1, 'Done');
  } catch (err) {
    if (output.state !== 'finalized' && output.state !== 'canceled') await output.cancel().catch(() => {});
    await sink.abort().catch(() => {});
    throw err;
  }
}

/** Build full re-encode options from the project + overrides. */
function reencodeOptions(p: Project, o: VideoExportRequest): ExportOptions {
  return {
    format: o.format || 'mp4',
    width: o.width || (o.height ? Math.round((o.height * p.settings.width) / p.settings.height) : p.settings.width),
    height: o.height || (o.width ? Math.round((o.width * p.settings.height) / p.settings.width) : p.settings.height),
    fps: o.fps || p.settings.fps,
    codec: o.codec,
    hardware: o.hardware,
    audioQuality: o.audioQuality,
    quality: o.quality || 'high',
    bitrate: o.bitrate || 0,
    range: o.range || [0, projectDuration(p)],
    audio: o.audio !== false,
    path: o.path
  };
}

/** Export the project. With `lossless`, stream-copies when the timeline is a single unmodified trim, else re-encodes. */
export async function exportVideo(
  p: Project,
  o: VideoExportRequest,
  onProgress: (f: number, note: string) => void,
  signal: AbortSignal
): Promise<ExportResult> {
  if (o.lossless && (!o.format || o.format === 'mp4')) {
    const el = eligible(p, o);
    if (el.ok) {
      try {
        await streamCopyTrim(p, el.clip, el.audio, o.path, onProgress, signal);
        return { mode: 'copied', path: o.path, note: 'Stream-copied the trimmed clip — no re-encode, no quality loss.' };
      } catch (err: any) {
        // A cancel surfaces as mediabunny's ConversionCanceledError: never fall back to a re-encode then.
        if (signal.aborted) throw err instanceof Canceled ? err : new Canceled();
        if (err instanceof Canceled || err?.name === 'AbortError') throw err;
        console.warn('lossless copy failed, re-encoding instead', err);
        const r = await exportProject(p, reencodeOptions(p, o), onProgress, signal);
        return { mode: 'reencoded', path: o.path, hardware: r.hardware, note: `Re-encoded at high quality (couldn’t stream-copy: ${String(err?.message || err)}).` };
      }
    }
    const r = await exportProject(p, reencodeOptions(p, o), onProgress, signal);
    return { mode: 'reencoded', path: o.path, hardware: r.hardware, note: `Re-encoded at high quality (lossless needs a single unmodified clip; ${el.reason}).` };
  }
  const r = await exportProject(p, reencodeOptions(p, o), onProgress, signal);
  return { mode: 'reencoded', path: o.path, hardware: r.hardware, note: r.hardware ? 'Re-encoded, preferring the graphics card.' : 'Re-encoded.' };
}

export { eligible as _losslessEligible };
