// Per-clip sound processing: a voice chain (high-pass, 3-band EQ, compressor) that runs live in the preview and in the
// export mix, presets for common jobs, and noise reduction — a job that writes a cleaned copy of the clip's audio next
// to the source ("name (cleaned).wav", like Premiere's Enhance Speech) and moves the sound clips onto it, so preview
// and export both use the clean audio and the original file is never touched.
import { AudioBufferSink } from 'mediabunny';
import type { AudioFx, MediaItem } from './model';
import { audioTrackOf, mediaKey } from './media';
import { wavBytes } from './audio';
import { api } from '../../lib/api';

export const AUDIO_PRESETS: { id: string; label: string; hint: string; fx: AudioFx }[] = [
  { id: 'voice', label: 'Voice', hint: 'Clear, present speech: rumble cut, a little presence, gentle compression.', fx: { highpass: 80, low: -2, mid: 2.5, midFreq: 3000, high: 2, compress: 40 } },
  { id: 'podcast', label: 'Podcast', hint: 'Close, warm and even, like a broadcast mic.', fx: { highpass: 70, low: 1.5, mid: 2, midFreq: 2500, high: 1.5, compress: 60 } },
  { id: 'warm', label: 'Warm', hint: 'Fuller low end, softer top.', fx: { highpass: 50, low: 3, mid: -1, midFreq: 2000, high: -2, compress: 20 } },
  { id: 'bright', label: 'Bright', hint: 'More air and detail.', fx: { highpass: 90, low: -1, mid: 1, midFreq: 4000, high: 4, compress: 25 } },
  { id: 'phone', label: 'Phone', hint: 'Telephone / radio effect.', fx: { highpass: 400, low: -12, mid: 6, midFreq: 1800, high: -14, compress: 50 } }
];

export const hasFx = (fx?: AudioFx) => !!fx && !!(fx.highpass || fx.low || fx.mid || fx.high || fx.compress);

/** Build the processing chain for a clip's sound in any audio context. Returns its input and output nodes. */
export function buildChain(ctx: BaseAudioContext, fx: AudioFx) {
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.Q.value = 0.707;
  const low = ctx.createBiquadFilter();
  low.type = 'lowshelf';
  low.frequency.value = 150;
  const mid = ctx.createBiquadFilter();
  mid.type = 'peaking';
  mid.Q.value = 1;
  const high = ctx.createBiquadFilter();
  high.type = 'highshelf';
  high.frequency.value = 8000;
  const comp = ctx.createDynamicsCompressor();
  hp.connect(low).connect(mid).connect(high).connect(comp);
  const chain = { input: hp as AudioNode, output: comp as AudioNode, set: (f: AudioFx) => {} };
  chain.set = (f: AudioFx) => {
    hp.frequency.value = f.highpass && f.highpass > 0 ? f.highpass : 10;
    low.gain.value = f.low || 0;
    mid.frequency.value = f.midFreq || 3000;
    mid.gain.value = f.mid || 0;
    high.gain.value = f.high || 0;
    const a = Math.max(0, Math.min(100, f.compress || 0));
    comp.threshold.value = a ? -10 - a * 0.3 : 0;
    comp.ratio.value = a ? 1 + a / 20 : 1;
    comp.knee.value = 6;
    comp.attack.value = 0.005;
    comp.release.value = 0.15;
  };
  chain.set(fx);
  return chain;
}

/* ---------- Noise reduction ---------- */

let worker: Worker | null = null;
let seq = 1;
const pending = new Map<number, { resolve: (c: Float32Array[]) => void; reject: (e: Error) => void; progress: (p: number) => void }>();
function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('../../lib/denoiseWorker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const m = e.data;
    const p = pending.get(m.id);
    if (!p) return;
    if (m.type === 'progress') p.progress(m.p);
    else {
      pending.delete(m.id);
      m.type === 'result' ? p.resolve(m.channels) : p.reject(new Error(m.message));
    }
  };
  return worker;
}

/** Decode a media item's whole sound track at its own rate and channel count. */
async function decodeAll(media: MediaItem, signal?: AbortSignal) {
  const at = await audioTrackOf(mediaKey(media));
  if (!at) throw new Error(`${media.name} has no sound.`);
  const parts: Float32Array[][] = [];
  let rate = 0;
  let chs = 0;
  for await (const { buffer } of new AudioBufferSink(at).buffers()) {
    if (signal?.aborted) throw new DOMException('Canceled', 'AbortError');
    rate = buffer.sampleRate;
    chs = Math.min(2, buffer.numberOfChannels);
    parts.push(Array.from({ length: chs }, (_, c) => buffer.getChannelData(c).slice()));
  }
  if (!parts.length) throw new Error(`${media.name} has no sound.`);
  const total = parts.reduce((n, p) => n + p[0].length, 0);
  const channels = Array.from({ length: chs }, () => new Float32Array(total));
  let off = 0;
  for (const p of parts) {
    for (let c = 0; c < chs; c++) channels[c].set(p[c] || p[0], off);
    off += p[0].length;
  }
  return { channels, rate };
}

/** Write "<name> (cleaned).wav" next to the source and return its path. amount 0..100. */
export async function reduceNoise(media: MediaItem, amount: number, onProgress: (p: number, note?: string) => void, signal?: AbortSignal): Promise<string> {
  if (!media.path) throw new Error('Save the clip to disk first — noise reduction writes a cleaned copy next to it.');
  onProgress(0.02, 'Reading the sound…');
  const { channels, rate } = await decodeAll(media, signal);
  onProgress(0.15, 'Learning the noise and cleaning…');
  const id = seq++;
  const clean = await new Promise<Float32Array[]>((resolve, reject) => {
    pending.set(id, { resolve, reject, progress: (p) => onProgress(0.15 + p * 0.75, 'Cleaning…') });
    signal?.addEventListener('abort', () => pending.delete(id) && reject(new DOMException('Canceled', 'AbortError')), { once: true });
    getWorker().postMessage({ type: 'denoise', id, channels, rate, amount: Math.max(0, Math.min(100, amount)) / 100 }, channels.map((c) => c.buffer));
  });
  onProgress(0.92, 'Saving the cleaned sound…');
  const buf = new AudioBuffer({ numberOfChannels: clean.length, length: clean[0].length, sampleRate: rate });
  clean.forEach((c, i) => buf.copyToChannel(c as Float32Array<ArrayBuffer>, i));
  const out = media.path.replace(/(\.[^./\\]+)?$/, '') + ' (cleaned).wav';
  await api.writeFile(out, wavBytes(buf));
  onProgress(1, 'Done.');
  return out;
}
