// Build a cheap, local "understanding" of a clip so an AI agent can edit it without ingesting the video: a timed
// transcript (bundled Whisper), scene-cut list (frame differences), silence spans (audio peaks), and a keyframe
// contact sheet. Exposed to agents as MCP resources (see the video editor's resources()). Cached on disk by
// path+size+mtime so re-opening never re-transcribes. Heavy decode reuses media.ts; transcription reuses transcribe.ts.
import { CanvasSink, AudioBufferSink } from 'mediabunny';
import type { MediaItem } from './model';
import { mediaKey, videoTrackOf, audioTrackOf, peaksFor } from './media';
import { transcribe, to16kMono, type TranscriptSegment } from '../../lib/transcribe';
import { api } from '../../lib/api';

export interface MediaIndex {
  mediaId: string;
  name: string;
  duration: number;
  /** Scene ranges from shot-change detection. */
  scenes: { start: number; end: number }[];
  /** Quiet spans (candidate cuts / pauses). */
  silences: { start: number; end: number }[];
  transcript: { text: string; segments: TranscriptSegment[]; model: string } | null;
  /** Why there's no transcript (no speech model installed, no audio…). */
  transcriptNote?: string;
  /** A grid of keyframes as a JPEG data URL. */
  contactSheet?: string;
  builtAt: number;
}

type Progress = (p: number, note?: string) => void;
const ck = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new DOMException('Canceled', 'AbortError');
};
const mem = new Map<string, MediaIndex>();
/** The built index for a media key, if we have it this session. */
export const getIndex = (key: string) => mem.get(key);

export function tc(s: number): string {
  s = Math.max(0, s);
  const m = Math.floor(s / 60);
  const sec = (s % 60).toFixed(1).padStart(4, '0');
  return `${String(m).padStart(2, '0')}:${sec}`;
}

// ---------- Audio → 16 kHz mono (for Whisper) ----------
async function decodeMono16k(key: string, signal?: AbortSignal): Promise<Float32Array | null> {
  const at = await audioTrackOf(key);
  if (!at) return null;
  const sink = new AudioBufferSink(at);
  const chunks: Float32Array[] = [];
  let sr = 0;
  let total = 0;
  for await (const { buffer } of sink.buffers()) {
    ck(signal);
    sr = buffer.sampleRate;
    const n = buffer.length;
    const chs = buffer.numberOfChannels;
    const mono = new Float32Array(n);
    for (let c = 0; c < chs; c++) {
      const d = buffer.getChannelData(c);
      for (let i = 0; i < n; i++) mono[i] += d[i] / chs;
    }
    chunks.push(mono);
    total += n;
  }
  if (!total || !sr) return null;
  const full = new Float32Array(total);
  let off = 0;
  for (const c of chunks) {
    full.set(c, off);
    off += c.length;
  }
  const ab = new AudioBuffer({ numberOfChannels: 1, length: total, sampleRate: sr });
  ab.copyToChannel(full, 0);
  return to16kMono(ab);
}

// ---------- Scene-change detection ----------
async function detectScenes(key: string, duration: number, onProgress: Progress, signal?: AbortSignal): Promise<{ start: number; end: number }[]> {
  const vt = await videoTrackOf(key);
  if (!vt) return [];
  const fps = 2;
  const n = Math.min(1800, Math.max(2, Math.ceil(duration * fps)));
  const first = await vt.getFirstTimestamp();
  const times = Array.from({ length: n }, (_, i) => first + i / fps);
  const sink = new CanvasSink(vt, { height: 72 });
  const tmp = document.createElement('canvas');
  const ctx = tmp.getContext('2d', { willReadFrequently: true })!;
  let prev: Uint8ClampedArray | null = null;
  const cuts = [0];
  let i = 0;
  for await (const f of sink.canvasesAtTimestamps(times)) {
    ck(signal);
    if (f) {
      const c = f.canvas;
      tmp.width = c.width;
      tmp.height = c.height;
      ctx.drawImage(c as any, 0, 0);
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      if (prev && prev.length === data.length) {
        let diff = 0;
        for (let p = 0; p < data.length; p += 4) diff += Math.abs(data[p] - prev[p]) + Math.abs(data[p + 1] - prev[p + 1]) + Math.abs(data[p + 2] - prev[p + 2]);
        const norm = diff / ((data.length / 4) * 3 * 255);
        if (norm > 0.18 && times[i] - cuts[cuts.length - 1] > 0.6) cuts.push(times[i] - first);
      }
      prev = data;
    }
    onProgress(i / n);
    i++;
  }
  return cuts.map((t, k) => ({ start: t, end: k + 1 < cuts.length ? cuts[k + 1] : duration }));
}

// ---------- Silence detection (from audio peaks) ----------
function detectSilences(peaks: { rate: number; data: Float32Array } | null, duration: number): { start: number; end: number }[] {
  if (!peaks) return [];
  const { rate, data } = peaks;
  const thresh = 0.02;
  const minLen = 0.35;
  const out: { start: number; end: number }[] = [];
  let runStart = -1;
  for (let b = 0; b < data.length; b++) {
    const t = b / rate;
    const quiet = data[b] < thresh;
    if (quiet && runStart < 0) runStart = t;
    else if (!quiet && runStart >= 0) {
      if (t - runStart >= minLen) out.push({ start: runStart, end: t });
      runStart = -1;
    }
  }
  if (runStart >= 0 && duration - runStart >= minLen) out.push({ start: runStart, end: duration });
  return out;
}

// ---------- Contact sheet ----------
async function contactSheet(key: string, scenes: { start: number; end: number }[], duration: number, signal?: AbortSignal): Promise<string | undefined> {
  const vt = await videoTrackOf(key);
  if (!vt) return undefined;
  const first = await vt.getFirstTimestamp();
  const picks = (scenes.length ? scenes.slice(0, 16) : [{ start: duration * 0.1, end: duration }]).map((s) => first + s.start + Math.min(0.5, (s.end - s.start) / 2));
  const sink = new CanvasSink(vt, { height: 120 });
  const frames: { t: number; c: HTMLCanvasElement | OffscreenCanvas }[] = [];
  let i = 0;
  for await (const f of sink.canvasesAtTimestamps(picks)) {
    ck(signal);
    if (f) frames.push({ t: picks[i] - first, c: f.canvas });
    i++;
  }
  if (!frames.length) return undefined;
  const cols = Math.min(4, frames.length);
  const rows = Math.ceil(frames.length / cols);
  const tw = frames[0].c.width;
  const th = frames[0].c.height;
  const pad = 4;
  const out = document.createElement('canvas');
  out.width = cols * (tw + pad) + pad;
  out.height = rows * (th + pad) + pad;
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.font = '11px sans-serif';
  frames.forEach((fr, idx) => {
    const r = Math.floor(idx / cols);
    const c = idx % cols;
    const x = pad + c * (tw + pad);
    const y = pad + r * (th + pad);
    ctx.drawImage(fr.c as any, x, y, tw, th);
    const label = tc(fr.t);
    const wLabel = ctx.measureText(label).width + 6;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(x, y + th - 15, wLabel, 15);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, x + 3, y + th - 4);
  });
  return out.toDataURL('image/jpeg', 0.72);
}

// ---------- Disk cache key ----------
async function cacheKey(media: MediaItem): Promise<string | null> {
  if (!media.path) return null; // in-memory media can't be cached by path
  const [st] = await api.statMany([media.path]).catch(() => [] as any[]);
  if (!st || !st.exists) return null;
  return `${media.path}|${st.size}|${st.mtime}`;
}

/** Build (or load from cache) the index for one media item. */
export async function buildIndex(media: MediaItem, onProgress: Progress, signal?: AbortSignal): Promise<MediaIndex> {
  const key = mediaKey(media);
  const have = mem.get(key);
  if (have) return have;
  const ckey = await cacheKey(media);
  if (ckey) {
    const cached = await api.video.indexGet(ckey).catch(() => null);
    if (cached) {
      const idx = JSON.parse(cached) as MediaIndex;
      mem.set(key, idx);
      return idx;
    }
  }

  // Transcript (the slow part): decode audio → 16 kHz mono → Whisper. Missing model/audio is a note, not a failure.
  onProgress(0.02, 'Listening to the audio…');
  let transcript: MediaIndex['transcript'] = null;
  let transcriptNote: string | undefined;
  try {
    const audio = media.hasAudio ? await decodeMono16k(key, signal) : null;
    if (!audio) transcriptNote = 'No audio to transcribe.';
    else {
      onProgress(0.08, 'Transcribing…');
      transcript = await transcribe(audio, { timestamps: true }, signal);
    }
  } catch (err: any) {
    if (err?.name === 'AbortError') throw err;
    transcriptNote = String(err?.message || err);
  }

  onProgress(0.6, 'Finding scene changes…');
  const scenes = await detectScenes(key, media.duration, (p) => onProgress(0.6 + p * 0.25), signal);
  onProgress(0.85, 'Finding quiet spans…');
  const silences = detectSilences(await peaksFor(media).catch(() => null), media.duration);
  onProgress(0.9, 'Making a contact sheet…');
  const sheet = await contactSheet(key, scenes, media.duration, signal).catch(() => undefined);

  const index: MediaIndex = { mediaId: media.id, name: media.name, duration: media.duration, scenes, silences, transcript, transcriptNote, contactSheet: sheet, builtAt: Date.now() };
  mem.set(key, index);
  if (ckey) api.video.indexSet(ckey, JSON.stringify(index)).catch(() => {});
  onProgress(1, 'Done.');
  return index;
}

/** A small summary for a job result (the full index goes to resources, not the job result). */
export const indexSummary = (i: MediaIndex) => ({ mediaId: i.mediaId, name: i.name, duration: Math.round(i.duration * 100) / 100, scenes: i.scenes.length, silences: i.silences.length, transcript: i.transcript ? `${i.transcript.segments.length} segments` : i.transcriptNote || 'none', contactSheet: !!i.contactSheet });
