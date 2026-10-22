import { AudioBufferSink } from 'mediabunny';
import type { Project, Clip, Track } from './model';
import { clipDuration, dbToGain, mediaOf, propAt, sourceTime } from './model';
import { clipWindow, transitionAt, transitionGain } from './transitions';
import { audioTrackOf, mediaKey } from './media';

/* ---------- Levels ---------- */

/** Audio tracks that can be heard (solo wins over mute). */
export function audibleTracks(p: Project): Track[] {
  const audio = p.tracks.filter((t) => t.kind === 'audio');
  const solo = audio.filter((t) => t.solo);
  return (solo.length ? solo : audio).filter((t) => !t.muted);
}

/** Linear gain of a clip at timeline time `t`: volume keyframes, gain, fades, transitions and its track. */
export function clipGainAt(p: Project, c: Clip, t: number, track?: Track) {
  const rel = t - c.start;
  const len = clipDuration(c);
  let g = dbToGain(propAt(c, 'volume', t) + c.props.gain);
  if (c.props.fadeIn > 0 && rel < c.props.fadeIn) g *= Math.max(0, rel / c.props.fadeIn);
  if (c.props.fadeOut > 0 && len - rel < c.props.fadeOut) g *= Math.max(0, (len - rel) / c.props.fadeOut);
  g *= transitionGain(transitionAt(p, c, t));
  if (track) g *= dbToGain(track.volume);
  return g;
}

/* ---------- Decoding ---------- */

/** Decode the audio between two source times into one AudioBuffer. */
export async function decodeRange(p: Project, c: Clip, s0: number, s1: number, signal?: AbortSignal): Promise<AudioBuffer | null> {
  const m = mediaOf(p, c);
  if (!m || !m.hasAudio) return null;
  const track = await audioTrackOf(mediaKey(m));
  if (!track) return null;
  const sink = new AudioBufferSink(track);
  const parts: AudioBuffer[] = [];
  let first = -1;
  for await (const { buffer, timestamp } of sink.buffers(s0, s1)) {
    if (signal?.aborted) throw new DOMException('Canceled', 'AbortError');
    if (first < 0) first = timestamp;
    parts.push(buffer);
  }
  if (!parts.length) return null;
  const sr = parts[0].sampleRate;
  const ch = Math.max(...parts.map((b) => b.numberOfChannels));
  const total = parts.reduce((n, b) => n + b.length, 0);
  // Trim the head of the first packet so the buffer starts exactly at s0.
  const skip = Math.max(0, Math.round((s0 - first) * sr));
  const len = Math.max(1, Math.min(total - skip, Math.round((s1 - s0) * sr)));
  const out = new AudioBuffer({ numberOfChannels: ch, length: len, sampleRate: sr });
  for (let k = 0; k < ch; k++) {
    const dst = out.getChannelData(k);
    let pos = -skip;
    for (const b of parts) {
      const src = b.getChannelData(Math.min(k, b.numberOfChannels - 1));
      const from = Math.max(0, -pos);
      const to = Math.min(src.length, len - pos);
      if (to > from) dst.set(src.subarray(from, to), pos + from);
      pos += src.length;
      if (pos >= len) break;
    }
  }
  return out;
}

export function reverseBuffer(b: AudioBuffer) {
  for (let k = 0; k < b.numberOfChannels; k++) b.getChannelData(k).reverse();
  return b;
}

/**
 * Change an audio buffer's length without changing its pitch (WSOLA: overlap-add of short
 * windows, each nudged to line up with the previous one so voices stay smooth).
 */
export function timeStretch(b: AudioBuffer, speed: number): AudioBuffer {
  if (Math.abs(speed - 1) < 1e-3) return b;
  const sr = b.sampleRate;
  const N = Math.round(sr * 0.046) & ~1;
  const Hs = N / 2;
  const Ha = Hs * speed;
  const tol = Math.round(sr * 0.008);
  const outLen = Math.max(1, Math.floor(b.length / speed));
  const out = new AudioBuffer({ numberOfChannels: b.numberOfChannels, length: outLen, sampleRate: sr });
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const chans = Array.from({ length: b.numberOfChannels }, (_, k) => b.getChannelData(k));
  const outs = Array.from({ length: b.numberOfChannels }, (_, k) => out.getChannelData(k));
  const mono = new Float32Array(b.length);
  for (const c of chans) for (let i = 0; i < mono.length; i++) mono[i] += c[i] / chans.length;
  let prev = 0;
  for (let k = 0; k * Hs < outLen; k++) {
    const nominal = Math.round(k * Ha);
    let best = nominal;
    if (k > 0) {
      // Find the offset whose start best continues where the previous window was heading.
      const target = prev + Hs;
      let bestScore = -Infinity;
      for (let d = -tol; d <= tol; d += 2) {
        const pos = nominal + d;
        if (pos < 0 || pos + Hs >= mono.length) continue;
        let score = 0;
        for (let i = 0; i < Hs; i += 8) score += mono[pos + i] * (mono[target + i] || 0);
        if (score > bestScore) {
          bestScore = score;
          best = pos;
        }
      }
    }
    best = Math.max(0, Math.min(best, b.length - 1));
    prev = best;
    const o = k * Hs;
    for (let ch = 0; ch < chans.length; ch++) {
      const src = chans[ch];
      const dst = outs[ch];
      for (let i = 0; i < N && o + i < outLen; i++) {
        const v = src[best + i];
        if (v !== undefined) dst[o + i] += v * win[i];
      }
    }
  }
  return out;
}

/* ---------- Offline mixdown (export) ---------- */

export const MIX_RATE = 48000;

/** Mix every audible clip between a and b into a stereo buffer. */
export async function mixdown(p: Project, a: number, b: number, onProgress: (f: number) => void, signal?: AbortSignal): Promise<AudioBuffer> {
  const len = Math.max(1, Math.ceil((b - a) * MIX_RATE));
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: len, sampleRate: MIX_RATE });
  const tracks = audibleTracks(p);
  const clips = p.clips.filter((c) => tracks.some((t) => t.id === c.trackId)).filter((c) => {
    const [w0, w1] = clipWindow(p, c);
    return w1 > a && w0 < b;
  });
  let done = 0;
  for (const c of clips) {
    if (signal?.aborted) throw new DOMException('Canceled', 'AbortError');
    const m = mediaOf(p, c)!;
    const track = tracks.find((t) => t.id === c.trackId)!;
    const [w0, w1] = clipWindow(p, c);
    const t0 = Math.max(w0, a);
    const t1 = Math.min(w1, b);
    // Source range for that stretch of timeline, held inside the file.
    let s0 = sourceTime(c, t0);
    let s1 = sourceTime(c, t1);
    if (s0 > s1) [s0, s1] = [s1, s0];
    s0 = Math.max(0, s0);
    s1 = Math.min(m?.duration ?? s1, s1);
    if (s1 - s0 < 0.001) continue;
    let buf = await decodeRange(p, c, s0, s1, signal);
    if (!buf) continue;
    if (c.reverse) reverseBuffer(buf);
    const node = ctx.createBufferSource();
    if (c.speed !== 1 && c.keepPitch) buf = timeStretch(buf, c.speed);
    else node.playbackRate.value = c.speed;
    node.buffer = buf;
    // When the decoded audio starts on the timeline.
    const startsAt = c.reverse ? c.start + (c.out - s1) / c.speed : c.start + (s0 - c.in) / c.speed;
    const playLen = (s1 - s0) / c.speed;
    const gain = ctx.createGain();
    const steps = Math.max(2, Math.ceil(playLen * 50));
    const curve = new Float32Array(steps);
    for (let i = 0; i < steps; i++) curve[i] = clipGainAt(p, c, startsAt + (i / (steps - 1)) * playLen, track);
    const when = Math.max(0, startsAt - a);
    gain.gain.setValueCurveAtTime(curve, when, Math.max(0.001, playLen));
    const pan = ctx.createStereoPanner();
    pan.pan.value = c.props.pan / 100;
    node.connect(gain).connect(pan).connect(ctx.destination);
    node.start(when);
    done++;
    onProgress(done / clips.length);
  }
  return ctx.startRendering();
}

/* ---------- WAV writing (for "Export audio as WAV") ---------- */

export function wavBytes(b: AudioBuffer): Uint8Array {
  const ch = b.numberOfChannels;
  const n = b.length;
  const out = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const str = (o: number, s: string) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  out.setUint32(4, 36 + n * ch * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, ch, true);
  out.setUint32(24, b.sampleRate, true);
  out.setUint32(28, b.sampleRate * ch * 2, true);
  out.setUint16(32, ch * 2, true);
  out.setUint16(34, 16, true);
  str(36, 'data');
  out.setUint32(40, n * ch * 2, true);
  const data = Array.from({ length: ch }, (_, k) => b.getChannelData(k));
  let o = 44;
  for (let i = 0; i < n; i++)
    for (let k = 0; k < ch; k++) {
      const v = Math.max(-1, Math.min(1, data[k][i]));
      out.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      o += 2;
    }
  return new Uint8Array(out.buffer);
}

/* ---------- Live preview ---------- */

/** Routes <audio>/<video> elements through Web Audio so each clip gets its own gain and pan. */
export class AudioEngine {
  ctx: AudioContext | null = null;
  master: GainNode | null = null;
  private nodes = new WeakMap<HTMLMediaElement, { gain: GainNode; pan: StereoPannerNode }>();

  private ensure() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  attach(el: HTMLMediaElement) {
    let n = this.nodes.get(el);
    if (n) return n;
    const ctx = this.ensure();
    const src = ctx.createMediaElementSource(el);
    const gain = ctx.createGain();
    const pan = ctx.createStereoPanner();
    src.connect(gain).connect(pan).connect(this.master!);
    n = { gain, pan };
    this.nodes.set(el, n);
    return n;
  }

  set(el: HTMLMediaElement, gain: number, pan: number) {
    const n = this.attach(el);
    const now = this.ctx!.currentTime;
    n.gain.gain.setTargetAtTime(gain, now, 0.015);
    n.pan.pan.setTargetAtTime(pan, now, 0.015);
  }

  resume() {
    this.ensure();
  }

  close() {
    this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}

