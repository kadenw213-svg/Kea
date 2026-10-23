// Noise reduction by spectral gating (the technique behind noisereduce / Audacity's Noise Reduction): learn the noise's
// spectrum from the quietest stretches, then turn down every time-frequency cell that isn't clearly above it, with the
// gain mask smoothed over time and frequency so there's no "musical noise". Removes steady noise — hum, hiss, fans,
// air conditioning, room tone — and leaves speech alone. Runs off the main thread.
//
// In:  { type: 'denoise', id, channels: Float32Array[], rate, amount (0..1) }   (channels transferred)
// Out: { type: 'progress', id, p } … { type: 'result', id, channels } | { type: 'error', id, message }

const N = 2048; // ~43 ms at 48 kHz
const HOP = N / 4;
const BINS = N / 2 + 1;
const MAX_REDUCTION_DB = 30;

// Radix-2 complex FFT (in place), precomputed for N.
const LOG = Math.log2(N);
const rev = new Uint32Array(N);
for (let i = 0; i < N; i++) {
  let r = 0;
  for (let b = 0; b < LOG; b++) r |= ((i >> b) & 1) << (LOG - 1 - b);
  rev[i] = r;
}
const cosT = new Float64Array(N / 2);
const sinT = new Float64Array(N / 2);
for (let i = 0; i < N / 2; i++) {
  cosT[i] = Math.cos((2 * Math.PI * i) / N);
  sinT[i] = Math.sin((2 * Math.PI * i) / N);
}
function fft(re: Float64Array, im: Float64Array, inverse: boolean) {
  for (let i = 0; i < N; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1;
    const step = N / size;
    for (let start = 0; start < N; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cosT[k * step];
        const wi = inverse ? sinT[k * step] : -sinT[k * step];
        const a = start + k;
        const b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
}

const win = new Float64Array(N);
for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);

/** Magnitude (dB) spectrum of one frame starting at `pos` (zero-padded at the ends). */
function frameDb(x: Float32Array, pos: number, re: Float64Array, im: Float64Array, out: Float32Array) {
  for (let i = 0; i < N; i++) {
    const k = pos + i;
    re[i] = k >= 0 && k < x.length ? x[k] * win[i] : 0;
    im[i] = 0;
  }
  fft(re, im, false);
  for (let b = 0; b < BINS; b++) out[b] = 10 * Math.log10(re[b] * re[b] + im[b] * im[b] + 1e-12);
}

function denoise(channels: Float32Array[], amount: number, progress: (p: number) => void): Float32Array[] {
  const len = channels[0].length;
  const frames = Math.ceil((len + N) / HOP);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const db = new Float32Array(BINS);
  // 1. Noise profile from the quietest 10 % of frames (mono mix).
  const mono = new Float32Array(len);
  for (const ch of channels) for (let i = 0; i < len; i++) mono[i] += ch[i] / channels.length;
  const energy: { f: number; e: number }[] = [];
  const stride = Math.max(1, Math.floor(frames / 4000)); // sample frames on long files
  for (let f = 0; f < frames; f += stride) {
    let e = 0;
    const pos = f * HOP - N;
    for (let i = 0; i < N; i += 4) {
      const k = pos + i;
      if (k >= 0 && k < len) e += mono[k] * mono[k];
    }
    energy.push({ f, e });
  }
  energy.sort((a, b) => a.e - b.e);
  const quiet = energy.slice(0, Math.max(8, Math.floor(energy.length * 0.1)));
  const mean = new Float64Array(BINS);
  const sq = new Float64Array(BINS);
  for (const q of quiet) {
    frameDb(mono, q.f * HOP - N, re, im, db);
    for (let b = 0; b < BINS; b++) {
      mean[b] += db[b];
      sq[b] += db[b] * db[b];
    }
  }
  const thresh = new Float32Array(BINS);
  for (let b = 0; b < BINS; b++) {
    const m = mean[b] / quiet.length;
    const sd = Math.sqrt(Math.max(0, sq[b] / quiet.length - m * m));
    thresh[b] = m + 1.5 * sd + 3;
  }
  const floor = Math.pow(10, (-MAX_REDUCTION_DB * amount) / 20);
  // 2. Gate each channel: mask smoothed over ±3 bins and over 5 frames (2 frames of delay).
  const out = channels.map(() => new Float32Array(len));
  const norm = new Float32Array(len + 2 * N);
  for (let f = 0; f < frames; f++) {
    const pos = f * HOP - N;
    for (let i = 0; i < N; i++) {
      const k = pos + i;
      if (k >= 0 && k < len) norm[k] += win[i] * win[i];
    }
  }
  const T = 5;
  channels.forEach((x, ci) => {
    const masks: Float32Array[] = Array.from({ length: T }, () => new Float32Array(BINS));
    const specs: { re: Float64Array; im: Float64Array; pos: number }[] = [];
    const raw = new Float32Array(BINS);
    for (let f = 0; f < frames + 2; f++) {
      if (f < frames) {
        const pos = f * HOP - N;
        const fr = new Float64Array(N);
        const fi = new Float64Array(N);
        for (let i = 0; i < N; i++) {
          const k = pos + i;
          fr[i] = k >= 0 && k < len ? x[k] * win[i] : 0;
        }
        fft(fr, fi, false);
        for (let b = 0; b < BINS; b++) raw[b] = 10 * Math.log10(fr[b] * fr[b] + fi[b] * fi[b] + 1e-12) > thresh[b] ? 1 : 0;
        const m = masks[f % T];
        for (let b = 0; b < BINS; b++) {
          let s = 0;
          let n = 0;
          for (let d = -3; d <= 3; d++) {
            const bb = b + d;
            if (bb >= 0 && bb < BINS) {
              s += raw[bb];
              n++;
            }
          }
          m[b] = s / n;
        }
        specs.push({ re: fr, im: fi, pos });
      } else masks[f % T].fill(0);
      // Output the frame from 2 steps ago with its mask averaged over the 5 frames around it.
      const o = f - 2;
      if (o < 0 || o >= frames) continue;
      const sp = specs.shift()!;
      for (let b = 0; b < BINS; b++) {
        let s = 0;
        for (let t = 0; t < T; t++) s += masks[t][b];
        const g = floor + (1 - floor) * Math.min(1, (s / T) * 1.5);
        sp.re[b] *= g;
        sp.im[b] *= g;
        if (b > 0 && b < N / 2) {
          sp.re[N - b] *= g;
          sp.im[N - b] *= g;
        }
      }
      fft(sp.re, sp.im, true);
      const y = out[ci];
      for (let i = 0; i < N; i++) {
        const k = sp.pos + i;
        if (k >= 0 && k < len) y[k] += (sp.re[i] / N) * win[i];
      }
      if (o % 200 === 0) progress((ci + o / frames) / channels.length);
    }
    const y = out[ci];
    for (let i = 0; i < len; i++) y[i] = norm[i] > 1e-6 ? y[i] / norm[i] : 0;
  });
  return out;
}

self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m.type !== 'denoise') return;
  try {
    const out = denoise(m.channels, Math.max(0, Math.min(1, m.amount)), (p) => (self as any).postMessage({ type: 'progress', id: m.id, p }));
    (self as any).postMessage({ type: 'result', id: m.id, channels: out }, out.map((c) => c.buffer));
  } catch (err) {
    (self as any).postMessage({ type: 'error', id: m.id, message: String((err as Error)?.message || err) });
  }
};
