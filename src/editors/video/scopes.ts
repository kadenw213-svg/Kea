// Video scopes: waveform, RGB parade, vectorscope and histogram from a frame, plus the same picture measured as
// numbers (levels, clipping, colour casts by tonal zone, saturation) so Claude can grade by measurement, not by eye.
// All on display values (Rec.709 / sRGB code values), the way an editor's scopes read the output.

export type ScopeMode = 'waveform' | 'parade' | 'vectorscope' | 'histogram';
export const SCOPE_MODES: { id: ScopeMode; label: string }[] = [
  { id: 'waveform', label: 'Waveform' },
  { id: 'parade', label: 'RGB parade' },
  { id: 'vectorscope', label: 'Vectorscope' },
  { id: 'histogram', label: 'Histogram' }
];

const KR = 0.2126;
const KB = 0.0722;
const KG = 1 - KR - KB;
const luma = (r: number, g: number, b: number) => KR * r + KG * g + KB * b;
/** Cb / Cr (−0.5 … 0.5) of display RGB (0 … 1). */
const cbOf = (r: number, g: number, b: number) => (b - luma(r, g, b)) / (2 * (1 - KB));
const crOf = (r: number, g: number, b: number) => (r - luma(r, g, b)) / (2 * (1 - KR));

/** Draw one scope of the frame into ctx (its whole canvas). */
export function drawScope(ctx: CanvasRenderingContext2D, img: ImageData, mode: ScopeMode) {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const out = ctx.createImageData(W, H);
  const o = out.data;
  const d = img.data;
  const n = img.width * img.height;
  // Accumulate hits per scope pixel, then map counts to brightness (log-ish, like a phosphor trace).
  const acc = new Float32Array(W * H * 3);
  // Each sample is spread over the two nearest columns, so a scope wider than the sample has no gaps.
  const hit = (x: number, y: number, r: number, g: number, b: number) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const x0 = Math.floor(x);
    const f = x - x0;
    const row = (y | 0) * W;
    for (const [xx, w] of [[x0, 1 - f], [Math.min(W - 1, x0 + 1), f]] as const) {
      const i = (row + xx) * 3;
      acc[i] += r * w;
      acc[i + 1] += g * w;
      acc[i + 2] += b * w;
    }
  };
  if (mode === 'waveform' || mode === 'parade') {
    const cols = mode === 'parade' ? 3 : 1;
    const cw = W / cols;
    for (let p = 0; p < n; p++) {
      const x = p % img.width;
      const r = d[p * 4] / 255;
      const g = d[p * 4 + 1] / 255;
      const b = d[p * 4 + 2] / 255;
      const sx = (x / img.width) * cw;
      if (mode === 'waveform') hit(sx, (1 - luma(r, g, b)) * (H - 1), 1, 1, 1);
      else {
        hit(sx, (1 - r) * (H - 1), 1, 0.25, 0.25);
        hit(cw + sx, (1 - g) * (H - 1), 0.25, 1, 0.25);
        hit(2 * cw + sx, (1 - b) * (H - 1), 0.3, 0.45, 1);
      }
    }
  } else if (mode === 'vectorscope') {
    const R = Math.min(W, H) / 2 - 4;
    for (let p = 0; p < n; p++) {
      const r = d[p * 4] / 255;
      const g = d[p * 4 + 1] / 255;
      const b = d[p * 4 + 2] / 255;
      // Plotted in the pixel's own colour, like a modern vectorscope.
      hit(W / 2 + cbOf(r, g, b) * 2 * R, H / 2 - crOf(r, g, b) * 2 * R, 0.4 + r, 0.4 + g, 0.4 + b);
    }
  } else {
    const bins = [new Float32Array(256), new Float32Array(256), new Float32Array(256)];
    for (let p = 0; p < n; p++) for (let c = 0; c < 3; c++) bins[c][d[p * 4 + c]]++;
    const max = Math.max(1, ...bins.map((b) => Math.max(...b.slice(1, 255))));
    const cols: [number, number, number][] = [[1, 0.3, 0.3], [0.3, 1, 0.3], [0.35, 0.5, 1]];
    for (let x = 0; x < W; x++) {
      const v = Math.floor((x / W) * 256);
      for (let c = 0; c < 3; c++) {
        const top = H - Math.min(1, bins[c][v] / max) * (H - 2);
        for (let y = Math.floor(top); y < H; y++) {
          const i = (y * W + x) * 3;
          acc[i] += cols[c][0] * 40;
          acc[i + 1] += cols[c][1] * 40;
          acc[i + 2] += cols[c][2] * 40;
        }
      }
    }
  }
  // Trace brightness like a scope's phosphor: dense areas glow, single samples stay faint but visible.
  // (Scaled by how many samples land on an average scope pixel, so it reads the same at any sample size.)
  const traces = mode === 'parade' ? 3 : 1;
  const dens = mode === 'histogram' ? 40 : Math.max(1e-3, (n * traces) / (W * H)) * (mode === 'vectorscope' ? 0.6 : 2.5);
  for (let i = 0, j = 0; i < acc.length; i += 3, j += 4) {
    o[j] = 255 * (1 - Math.exp(-acc[i] / dens));
    o[j + 1] = 255 * (1 - Math.exp(-acc[i + 1] / dens));
    o[j + 2] = 255 * (1 - Math.exp(-acc[i + 2] / dens));
    o[j + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
  // Graticule
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.lineWidth = 1;
  ctx.font = '9px Inter, sans-serif';
  if (mode === 'waveform' || mode === 'parade') {
    for (const ire of [0, 25, 50, 75, 100]) {
      const y = Math.round((1 - ire / 100) * (H - 1)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
      ctx.fillText(String(ire), 2, Math.max(9, y - 2));
    }
  } else if (mode === 'vectorscope') {
    const R = Math.min(W, H) / 2 - 4;
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, R, 0, Math.PI * 2);
    ctx.stroke();
    // Primary / secondary targets (75 % colour bars) and the skin tone line.
    const targets: [string, [number, number, number]][] = [['R', [0.75, 0, 0]], ['Mg', [0.75, 0, 0.75]], ['B', [0, 0, 0.75]], ['Cy', [0, 0.75, 0.75]], ['G', [0, 0.75, 0]], ['Yl', [0.75, 0.75, 0]]];
    for (const [label, [r, g, b]] of targets) {
      const x = W / 2 + cbOf(r, g, b) * 2 * R;
      const y = H / 2 - crOf(r, g, b) * 2 * R;
      ctx.strokeRect(x - 4, y - 4, 8, 8);
      ctx.fillText(label, x + 6, y + 3);
    }
    const skin = Math.atan2(crOf(0.8, 0.6, 0.48), cbOf(0.8, 0.6, 0.48));
    ctx.strokeStyle = 'rgba(255,200,150,0.35)';
    ctx.beginPath();
    ctx.moveTo(W / 2, H / 2);
    ctx.lineTo(W / 2 + Math.cos(skin) * R, H / 2 - Math.sin(skin) * R);
    ctx.stroke();
  }
  ctx.restore();
}

export interface PictureStats {
  /** Luma percentiles, in % (0 = black, 100 = white): black point, shadows, median, highlights, white point. */
  levels: { black: number; shadows: number; median: number; highlights: number; white: number };
  /** Share of the picture at pure black / pure white (% of pixels). */
  clipped: { blacks: number; whites: number; anyChannelWhite: number };
  /** Average colour in each tonal zone, % per channel; a cast shows as one channel above the others. */
  zones: { shadows: Zone; midtones: Zone; highlights: Zone };
  /** Saturation: average and the strongest 5 % (% of full saturation). */
  saturation: { average: number; p95: number };
  /** The picture's dominant hue (degrees on the vectorscope, 0 = red, 120 = green, 240 = blue) and how strong it is. */
  dominantHue: { degrees: number; strength: number } | null;
  /** Plain-English reading of the numbers. */
  notes: string[];
}
interface Zone {
  share: number;
  r: number;
  g: number;
  b: number;
  cast: string;
}

/** Measure a frame like a colourist reads scopes. */
export function measurePicture(img: ImageData): PictureStats {
  const d = img.data;
  const n = img.width * img.height;
  const hist = new Uint32Array(256);
  let crushed = 0;
  let blown = 0;
  let anyBlown = 0;
  const zone = () => ({ n: 0, r: 0, g: 0, b: 0 });
  const zs = { shadows: zone(), midtones: zone(), highlights: zone() };
  const sats: number[] = [];
  let hx = 0;
  let hy = 0;
  for (let p = 0; p < n; p++) {
    const R = d[p * 4];
    const G = d[p * 4 + 1];
    const B = d[p * 4 + 2];
    const r = R / 255;
    const g = G / 255;
    const b = B / 255;
    const y = luma(r, g, b);
    hist[Math.min(255, Math.round(y * 255))]++;
    if (R <= 2 && G <= 2 && B <= 2) crushed++;
    if (R >= 253 && G >= 253 && B >= 253) blown++;
    if (R >= 254 || G >= 254 || B >= 254) anyBlown++;
    const z = y < 0.25 ? zs.shadows : y > 0.75 ? zs.highlights : zs.midtones;
    z.n++;
    z.r += r;
    z.g += g;
    z.b += b;
    const cb = cbOf(r, g, b);
    const cr = crOf(r, g, b);
    const s = Math.hypot(cb, cr) / 0.5;
    if (p % 4 === 0) sats.push(s);
    hx += cb;
    hy += cr;
  }
  const pct = (q: number) => {
    let acc = 0;
    for (let i = 0; i < 256; i++) {
      acc += hist[i];
      if (acc >= q * n) return Math.round((i / 255) * 1000) / 10;
    }
    return 100;
  };
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const zoneOut = (z: { n: number; r: number; g: number; b: number }): Zone => {
    if (!z.n) return { share: 0, r: 0, g: 0, b: 0, cast: 'none' };
    const r = (z.r / z.n) * 100;
    const g = (z.g / z.n) * 100;
    const b = (z.b / z.n) * 100;
    const avg = (r + g + b) / 3;
    const dev = { red: r - avg, green: g - avg, blue: b - avg };
    // Name the cast by the strongest deviation (yellow = blue below average, magenta = green below, cyan = red below).
    const [name, v] = Object.entries(dev).sort((a, c) => Math.abs(c[1]) - Math.abs(a[1]))[0];
    const opposite: Record<string, string> = { red: 'cyan', green: 'magenta', blue: 'yellow' };
    const cast = Math.abs(v) < 1.5 ? 'neutral' : v > 0 ? `${name} +${r1(v)}%` : `${opposite[name]} +${r1(-v)}%`;
    return { share: r1((z.n / n) * 100), r: r1(r), g: r1(g), b: r1(b), cast };
  };
  sats.sort((a, b) => a - b);
  const satAvg = sats.reduce((a, b) => a + b, 0) / Math.max(1, sats.length);
  const hueStrength = Math.hypot(hx / n, hy / n) / 0.5;
  // Hue in the familiar colour-wheel sense (red 0, green 120, blue 240): the average chroma turned back into RGB at
  // mid grey, then the usual HSV hue.
  const toHue = (cb: number, cr: number) => {
    const Y = 0.5;
    const R = Y + 2 * (1 - KR) * cr;
    const B = Y + 2 * (1 - KB) * cb;
    const G = (Y - KR * R - KB * B) / KG;
    const mx = Math.max(R, G, B);
    const mn = Math.min(R, G, B);
    if (mx - mn < 1e-6) return 0;
    const h = mx === R ? ((G - B) / (mx - mn)) % 6 : mx === G ? (B - R) / (mx - mn) + 2 : (R - G) / (mx - mn) + 4;
    return Math.round(((h * 60) % 360 + 360) % 360);
  };
  const levels = { black: pct(0.005), shadows: pct(0.1), median: pct(0.5), highlights: pct(0.9), white: pct(0.995) };
  const clipped = { blacks: r1((crushed / n) * 100), whites: r1((blown / n) * 100), anyChannelWhite: r1((anyBlown / n) * 100) };
  const zones = { shadows: zoneOut(zs.shadows), midtones: zoneOut(zs.midtones), highlights: zoneOut(zs.highlights) };
  const saturation = { average: r1(satAvg * 100), p95: r1((sats[Math.floor(sats.length * 0.95)] || 0) * 100) };
  const notes: string[] = [];
  if (levels.white < 80) notes.push(`Highlights stop at ${levels.white}%: the picture never reaches white (raise exposure or highlights, or contrast).`);
  if (levels.black > 12) notes.push(`Blacks sit at ${levels.black}%: lifted / milky (lower shadows or raise contrast).`);
  if (clipped.whites > 2) notes.push(`${clipped.whites}% of the picture is clipped to pure white (detail lost: lower exposure or highlights).`);
  if (clipped.blacks > 5) notes.push(`${clipped.blacks}% is crushed to pure black.`);
  if (levels.median < 25) notes.push(`Median brightness ${levels.median}%: underexposed.`);
  if (levels.median > 70) notes.push(`Median brightness ${levels.median}%: very bright / overexposed.`);
  for (const [k, z] of Object.entries(zones)) if (z.share > 5 && z.cast !== 'neutral' && z.cast !== 'none') notes.push(`${k[0].toUpperCase()}${k.slice(1)} lean ${z.cast} (temperature / tint corrects it).`);
  if (saturation.average < 8) notes.push('Very low saturation (nearly black and white).');
  if (saturation.p95 > 85) notes.push(`The most saturated 5% reach ${saturation.p95}%: close to clipping colour.`);
  if (!notes.length) notes.push('Levels and colour balance look healthy.');
  return { levels, clipped, zones, saturation, dominantHue: hueStrength > 0.03 ? { degrees: toHue(hx / n, hy / n), strength: r1(hueStrength * 100) } : null, notes };
}
