// Loudness the way streaming platforms measure it (ITU-R BS.1770-4 / EBU R128: K-weighting, 400 ms blocks with 75 %
// overlap, absolute gate at -70 LUFS, relative gate at -10 LU), plus a look-ahead peak limiter for the final mix.
// Used by "Normalize loudness" (whole mix to a target such as -14 LUFS) and "Level dialogue" (clips to one level).

/** Biquad coefficients [b0, b1, b2, a1, a2] (a0 normalised to 1). */
type Biquad = [number, number, number, number, number];

/** The two K-weighting stages for a sample rate (pre-filter high shelf + RLB high-pass), as designed in libebur128. */
function kWeighting(fs: number): [Biquad, Biquad] {
  // Stage 1: high shelf, +4 dB above ~1.7 kHz (models the head).
  let K = Math.tan((Math.PI * 1681.974450955533) / fs);
  let Q = 0.7071752369554196;
  const Vh = Math.pow(10, 3.999843853973347 / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf: Biquad = [(Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0];
  // Stage 2: high-pass at ~38 Hz (RLB weighting).
  K = Math.tan((Math.PI * 38.13547087602444) / fs);
  Q = 0.5003270373238773;
  a0 = 1 + K / Q + K * K;
  const hp: Biquad = [1, -2, 1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0];
  return [shelf, hp];
}

function filter(x: Float32Array, [b0, b1, b2, a1, a2]: Biquad): Float32Array {
  const y = new Float32Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    const o = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = v;
    y2 = y1;
    y1 = o;
    y[i] = o;
  }
  return y;
}

export interface LoudnessResult {
  /** Integrated loudness, LUFS (-Infinity for silence). */
  lufs: number;
  /** Highest sample peak, dBFS. */
  peakDb: number;
}

/** Integrated loudness and sample peak of planar channels at a sample rate. */
export function measureLoudness(channels: Float32Array[], fs: number): LoudnessResult {
  let peak = 0;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
  const peakDb = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
  const n = channels[0]?.length || 0;
  const block = Math.round(0.4 * fs);
  const step = Math.round(0.1 * fs);
  if (!n || n < block) return { lufs: -Infinity, peakDb };
  const [shelf, hp] = kWeighting(fs);
  // Prefix sums of the K-weighted squares, summed over channels (L/R/C weight 1; 5.1 surrounds aren't used here).
  const cum = new Float64Array(n + 1);
  for (const ch of channels.slice(0, 3)) {
    const k = filter(filter(ch, shelf), hp);
    let acc = 0;
    for (let i = 0; i < n; i++) {
      acc += k[i] * k[i];
      cum[i + 1] += acc;
    }
  }
  const z: number[] = [];
  for (let s = 0; s + block <= n; s += step) z.push((cum[s + block] - cum[s]) / block);
  const lk = (ms: number) => -0.691 + 10 * Math.log10(ms);
  const abs = z.filter((v) => v > 0 && lk(v) > -70);
  if (!abs.length) return { lufs: -Infinity, peakDb };
  const rel = lk(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const gated = abs.filter((v) => lk(v) > rel);
  const lufs = gated.length ? lk(gated.reduce((a, b) => a + b, 0) / gated.length) : -Infinity;
  return { lufs, peakDb };
}

export const measureBuffer = (b: AudioBuffer) => measureLoudness(Array.from({ length: b.numberOfChannels }, (_, i) => b.getChannelData(i)), b.sampleRate);

/**
 * Look-ahead peak limiter, in place: no sample ends above `ceilingDb`. 5 ms look-ahead (the gain is already down when
 * a peak arrives), instant attack, smooth ~80 ms release. Linked across channels so the stereo image doesn't shift.
 */
export function limit(channels: Float32Array[], fs: number, ceilingDb = -1, releaseMs = 80) {
  const n = channels[0]?.length || 0;
  if (!n) return;
  const ceil = Math.pow(10, ceilingDb / 20);
  const look = Math.max(1, Math.round(0.005 * fs));
  // Gain each sample needs on its own.
  const need = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (const ch of channels) m = Math.max(m, Math.abs(ch[i]));
    need[i] = m > ceil ? ceil / m : 1;
  }
  // Sliding-window minimum over the next `look` samples (monotonic deque), so gain drops before the peak.
  const win = new Float32Array(n);
  const dq = new Int32Array(n);
  let h = 0;
  let t = 0;
  for (let i = n - 1; i >= 0; i--) {
    while (t > h && need[dq[t - 1]] >= need[i]) t--;
    dq[t++] = i;
    while (dq[h] > i + look) h++;
    win[i] = need[dq[h]];
  }
  const rel = 1 - Math.exp(-1 / ((releaseMs / 1000) * fs));
  let g = 1;
  for (let i = 0; i < n; i++) {
    const target = win[i];
    g = target < g ? target : g + (target - g) * rel;
    if (g < 1) for (const ch of channels) ch[i] *= g;
  }
}
