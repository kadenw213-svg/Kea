import type { Adjustment, AdjType } from './types';

/**
 * Colour adjustments. Pure functions over RGBA bytes with no DOM access, so they run
 * both in the compositor (adjustment layers) and in the pixel worker (destructive edits).
 * Parameter shapes follow Photoshop's (and ag-psd's) so PSD adjustment layers map 1:1.
 */

export interface LevelsChannel {
  shadowInput: number;
  highlightInput: number;
  /** Gamma: 1 is neutral, above 1 brightens midtones. */
  midtoneInput: number;
  shadowOutput: number;
  highlightOutput: number;
}
export type CurvePoints = { input: number; output: number }[];
export interface BalanceValues {
  cyanRed: number;
  magentaGreen: number;
  yellowBlue: number;
}
export interface MixerChannel {
  red: number;
  green: number;
  blue: number;
  constant: number;
}
export interface Cmyk {
  c: number;
  m: number;
  y: number;
  k: number;
}
export interface GradientStop {
  pos: number;
  color: string;
}

const lvl = (): LevelsChannel => ({ shadowInput: 0, highlightInput: 255, midtoneInput: 1, shadowOutput: 0, highlightOutput: 255 });
const line = (): CurvePoints => [
  { input: 0, output: 0 },
  { input: 255, output: 255 }
];
const bal = (): BalanceValues => ({ cyanRed: 0, magentaGreen: 0, yellowBlue: 0 });
const cmyk = (): Cmyk => ({ c: 0, m: 0, y: 0, k: 0 });
export const SELECTIVE_RANGES = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas', 'whites', 'neutrals', 'blacks'] as const;

export const ADJ_LABELS: Record<AdjType, string> = {
  brightness: 'Brightness/Contrast',
  levels: 'Levels',
  curves: 'Curves',
  exposure: 'Exposure',
  vibrance: 'Vibrance',
  hueSat: 'Hue/Saturation',
  colorBalance: 'Color balance',
  bw: 'Black & white',
  photoFilter: 'Photo filter',
  channelMixer: 'Channel mixer',
  invert: 'Invert',
  posterize: 'Posterize',
  threshold: 'Threshold',
  gradientMap: 'Gradient map',
  selectiveColor: 'Selective color'
};
export const ADJ_ORDER: AdjType[] = ['brightness', 'levels', 'curves', 'exposure', 'vibrance', 'hueSat', 'colorBalance', 'bw', 'photoFilter', 'channelMixer', 'invert', 'posterize', 'threshold', 'gradientMap', 'selectiveColor'];

/** Fresh settings for each adjustment (all neutral except the ones that are effects by nature). */
export function adjDefaults(type: AdjType): Adjustment {
  switch (type) {
    case 'brightness':
      return { type, brightness: 0, contrast: 0 };
    case 'levels':
      return { type, rgb: lvl(), red: lvl(), green: lvl(), blue: lvl() };
    case 'curves':
      return { type, rgb: line(), red: line(), green: line(), blue: line() };
    case 'exposure':
      return { type, exposure: 0, offset: 0, gamma: 1 };
    case 'vibrance':
      return { type, vibrance: 0, saturation: 0 };
    case 'hueSat':
      return { type, hue: 0, saturation: 0, lightness: 0, colorize: false, colorHue: 30, colorSat: 25 };
    case 'colorBalance':
      return { type, shadows: bal(), midtones: bal(), highlights: bal(), preserveLuminosity: true };
    case 'bw':
      return { type, reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80, useTint: false, tintColor: '#e1d3b3' };
    case 'photoFilter':
      return { type, color: '#ec8a00', density: 25, preserveLuminosity: true };
    case 'channelMixer':
      return {
        type,
        monochrome: false,
        red: { red: 100, green: 0, blue: 0, constant: 0 },
        green: { red: 0, green: 100, blue: 0, constant: 0 },
        blue: { red: 0, green: 0, blue: 100, constant: 0 },
        gray: { red: 40, green: 40, blue: 20, constant: 0 }
      };
    case 'invert':
      return { type };
    case 'posterize':
      return { type, levels: 4 };
    case 'threshold':
      return { type, level: 128 };
    case 'gradientMap':
      return {
        type,
        reverse: false,
        stops: [
          { pos: 0, color: '#000000' },
          { pos: 1, color: '#ffffff' }
        ] as GradientStop[]
      };
    case 'selectiveColor':
      return { type, mode: 'relative', ...Object.fromEntries(SELECTIVE_RANGES.map((r) => [r, cmyk()])) };
  }
}

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
function hex(h: string): [number, number, number] {
  let s = (h || '#000').replace('#', '');
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  const n = parseInt(s.slice(0, 6), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// ---------- HSL ----------
export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}
function hue2(p: number, q: number, t: number) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = (((h % 360) + 360) % 360) / 360;
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2(p, q, h + 1 / 3) * 255, hue2(p, q, h) * 255, hue2(p, q, h - 1 / 3) * 255];
}

// ---------- Lookup tables ----------
function levelsLut(c: LevelsChannel): Uint8Array {
  const lut = new Uint8Array(256);
  const lo = c.shadowInput,
    hi = Math.max(lo + 1, c.highlightInput);
  const g = 1 / Math.max(0.01, c.midtoneInput);
  for (let v = 0; v < 256; v++) {
    const t = Math.pow(clamp01((v - lo) / (hi - lo)), g);
    lut[v] = Math.round(clamp255(c.shadowOutput + t * (c.highlightOutput - c.shadowOutput)));
  }
  return lut;
}

/** Smooth monotone curve through the points (Fritsch–Carlson), sampled to 256 values. */
export function curveLut(points: CurvePoints): Uint8Array {
  const pts = [...points].sort((a, b) => a.input - b.input).filter((p, i, a) => i === 0 || p.input !== a[i - 1].input);
  const lut = new Uint8Array(256);
  if (pts.length === 0) {
    for (let i = 0; i < 256; i++) lut[i] = i;
    return lut;
  }
  if (pts.length === 1) return lut.fill(clamp255(Math.round(pts[0].output)));
  const n = pts.length;
  const xs = pts.map((p) => p.input),
    ys = pts.map((p) => p.output);
  const d: number[] = [],
    m: number[] = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i],
      b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  let k = 0;
  for (let v = 0; v < 256; v++) {
    let y: number;
    if (v <= xs[0]) y = ys[0];
    else if (v >= xs[n - 1]) y = ys[n - 1];
    else {
      while (k < n - 2 && v > xs[k + 1]) k++;
      const h = xs[k + 1] - xs[k];
      const t = (v - xs[k]) / h;
      const t2 = t * t,
        t3 = t2 * t;
      y = (2 * t3 - 3 * t2 + 1) * ys[k] + (t3 - 2 * t2 + t) * h * m[k] + (-2 * t3 + 3 * t2) * ys[k + 1] + (t3 - t2) * h * m[k + 1];
    }
    lut[v] = Math.round(clamp255(y));
  }
  return lut;
}

const toLin = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const toSrgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

function balanceLut(a: Adjustment, key: keyof BalanceValues): Uint8Array {
  const lut = new Uint8Array(256);
  const s = (a.shadows as BalanceValues)[key] / 100,
    m = (a.midtones as BalanceValues)[key] / 100,
    h = (a.highlights as BalanceValues)[key] / 100;
  // GIMP-style transfer weights for shadows, midtones and highlights.
  const A = 0.25,
    B = 0.333,
    S = 0.7;
  for (let v = 0; v < 256; v++) {
    const l = v / 255;
    const low = clamp01((l - B) / -A + 0.5) * S;
    const mid = clamp01((l - B) / A + 0.5) * clamp01((l + B - 1) / -A + 0.5) * S;
    const high = clamp01((l + B - 1) / A + 0.5) * S;
    lut[v] = Math.round(clamp255((l + s * low + m * mid + h * high) * 255));
  }
  return lut;
}

function gradientLut(stops: GradientStop[], reverse: boolean): Uint8Array {
  const out = new Uint8Array(256 * 3);
  const st = [...stops].sort((a, b) => a.pos - b.pos).map((s) => ({ pos: s.pos, c: hex(s.color) }));
  for (let v = 0; v < 256; v++) {
    const t = reverse ? 1 - v / 255 : v / 255;
    let c: number[];
    if (!st.length) c = [v, v, v];
    else if (t <= st[0].pos) c = st[0].c;
    else if (t >= st[st.length - 1].pos) c = st[st.length - 1].c;
    else {
      let i = 0;
      while (i < st.length - 2 && t > st[i + 1].pos) i++;
      const a = st[i],
        b = st[i + 1];
      const f = (t - a.pos) / Math.max(1e-6, b.pos - a.pos);
      c = [0, 1, 2].map((k) => a.c[k] + (b.c[k] - a.c[k]) * f);
    }
    out[v * 3] = c[0];
    out[v * 3 + 1] = c[1];
    out[v * 3 + 2] = c[2];
  }
  return out;
}

/** Per-channel tables for adjustments that only depend on each channel's own value. */
function channelLuts(a: Adjustment): [Uint8Array, Uint8Array, Uint8Array] | null {
  const mk = (f: (v: number) => number) => {
    const t = new Uint8Array(256);
    for (let v = 0; v < 256; v++) t[v] = Math.round(clamp255(f(v)));
    return t;
  };
  switch (a.type) {
    case 'brightness': {
      const b = a.brightness / 100;
      const gamma = Math.pow(2, -b * 0.9);
      const c = a.contrast;
      const f = c >= 0 ? 1 + c / 50 : 1 + c / 100;
      const t = mk((v) => {
        const g = 255 * Math.pow(v / 255, gamma);
        return (g - 128) * f + 128;
      });
      return [t, t, t];
    }
    case 'levels': {
      const m = levelsLut(a.rgb);
      const r = levelsLut(a.red),
        g = levelsLut(a.green),
        b = levelsLut(a.blue);
      return [mk((v) => m[r[v]]), mk((v) => m[g[v]]), mk((v) => m[b[v]])];
    }
    case 'curves': {
      const m = curveLut(a.rgb);
      const r = curveLut(a.red),
        g = curveLut(a.green),
        b = curveLut(a.blue);
      return [mk((v) => m[r[v]]), mk((v) => m[g[v]]), mk((v) => m[b[v]])];
    }
    case 'exposure': {
      const mul = Math.pow(2, a.exposure);
      const ig = 1 / Math.max(0.01, a.gamma);
      const t = mk((v) => toSrgb(Math.pow(clamp01(toLin(v / 255) * mul + a.offset), ig)) * 255);
      return [t, t, t];
    }
    case 'invert': {
      const t = mk((v) => 255 - v);
      return [t, t, t];
    }
    case 'posterize': {
      const n = Math.max(2, Math.min(255, Math.round(a.levels)));
      const t = mk((v) => (Math.round((v / 255) * (n - 1)) * 255) / (n - 1));
      return [t, t, t];
    }
    case 'colorBalance':
      if (a.preserveLuminosity) return null;
      return [balanceLut(a, 'cyanRed'), balanceLut(a, 'magentaGreen'), balanceLut(a, 'yellowBlue')];
  }
  return null;
}

/** Apply an adjustment to RGBA bytes in place. Fully transparent pixels are skipped. */
export function applyAdjustment(data: Uint8ClampedArray | Uint8Array, a: Adjustment) {
  const n = data.length;
  const luts = channelLuts(a);
  if (luts) {
    const [lr, lg, lb] = luts;
    for (let i = 0; i < n; i += 4) {
      if (!data[i + 3]) continue;
      data[i] = lr[data[i]];
      data[i + 1] = lg[data[i + 1]];
      data[i + 2] = lb[data[i + 2]];
    }
    return;
  }
  switch (a.type) {
    case 'vibrance': {
      const vib = a.vibrance / 100,
        sat = a.saturation / 100;
      for (let i = 0; i < n; i += 4) {
        if (!data[i + 3]) continue;
        const r = data[i],
          g = data[i + 1],
          b = data[i + 2];
        const max = Math.max(r, g, b),
          min = Math.min(r, g, b);
        const cur = (max - min) / 255;
        const gray = 0.299 * r + 0.587 * g + 0.114 * b;
        // Vibrance boosts dull colours more than already-saturated ones.
        const f = (1 + sat) * (1 + (vib > 0 ? vib * (1 - cur) * (1 - cur) : vib));
        data[i] = clamp255(gray + (r - gray) * f);
        data[i + 1] = clamp255(gray + (g - gray) * f);
        data[i + 2] = clamp255(gray + (b - gray) * f);
      }
      return;
    }
    case 'hueSat': {
      const dh = a.hue,
        ds = a.saturation / 100,
        dl = a.lightness / 100;
      const ch = a.colorHue,
        cs = a.colorSat / 100;
      for (let i = 0; i < n; i += 4) {
        if (!data[i + 3]) continue;
        let [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
        if (a.colorize) {
          h = ch;
          s = cs;
        } else {
          h += dh;
          s = clamp01(ds > 0 ? s + (1 - s) * ds * s * 2 + s * ds : s * (1 + ds));
        }
        l = dl > 0 ? l + (1 - l) * dl : l * (1 + dl);
        const [r, g, b] = hslToRgb(h, s, l);
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
      }
      return;
    }
    case 'colorBalance': {
      const lr = balanceLut(a, 'cyanRed'),
        lg = balanceLut(a, 'magentaGreen'),
        lb = balanceLut(a, 'yellowBlue');
      for (let i = 0; i < n; i += 4) {
        if (!data[i + 3]) continue;
        const r = data[i],
          g = data[i + 1],
          b = data[i + 2];
        const [, , l0] = rgbToHsl(r, g, b);
        const [h, s] = rgbToHsl(lr[r], lg[g], lb[b]);
        const [nr, ng, nb] = hslToRgb(h, s, l0);
        data[i] = nr;
        data[i + 1] = ng;
        data[i + 2] = nb;
      }
      return;
    }
    case 'bw': {
      const w = { r: a.reds / 100, y: a.yellows / 100, g: a.greens / 100, c: a.cyans / 100, b: a.blues / 100, m: a.magentas / 100 };
      const [th, ts] = a.useTint ? rgbToHsl(...hex(a.tintColor)) : [0, 0];
      for (let i = 0; i < n; i += 4) {
        if (!data[i + 3]) continue;
        const r = data[i],
          g = data[i + 1],
          b = data[i + 2];
        // Photoshop's method: the strongest channel picks a primary weight, the top two a secondary one.
        let max: number, mid: number, min: number, wp: number, ws: number;
        if (r >= g && r >= b) {
          max = r;
          if (g >= b) ((mid = g), (min = b), (wp = w.r), (ws = w.y));
          else ((mid = b), (min = g), (wp = w.r), (ws = w.m));
        } else if (g >= r && g >= b) {
          max = g;
          if (r >= b) ((mid = r), (min = b), (wp = w.g), (ws = w.y));
          else ((mid = b), (min = r), (wp = w.g), (ws = w.c));
        } else {
          max = b;
          if (r >= g) ((mid = r), (min = g), (wp = w.b), (ws = w.m));
          else ((mid = g), (min = r), (wp = w.b), (ws = w.c));
        }
        const gray = clamp255(min + (max - mid) * wp + (mid - min) * ws);
        if (a.useTint) {
          const [tr, tg, tb] = hslToRgb(th, ts, gray / 255);
          data[i] = tr;
          data[i + 1] = tg;
          data[i + 2] = tb;
        } else data[i] = data[i + 1] = data[i + 2] = gray;
      }
      return;
    }
    case 'photoFilter': {
      const [fr, fg, fb] = hex(a.color);
      const d = a.density / 100;
      for (let i = 0; i < n; i += 4) {
        if (!data[i + 3]) continue;
        const r = data[i],
          g = data[i + 1],
          b = data[i + 2];
        let nr = r + ((r * fr) / 255 - r) * d * 1.6 + (fr - r) * d * 0.25;
        let ng = g + ((g * fg) / 255 - g) * d * 1.6 + (fg - g) * d * 0.25;
        let nb = b + ((b * fb) / 255 - b) * d * 1.6 + (fb - b) * d * 0.25;
        if (a.preserveLuminosity) {
          const l0 = 0.299 * r + 0.587 * g + 0.114 * b;
          const l1 = 0.299 * nr + 0.587 * ng + 0.114 * nb;
          const k = l1 > 0.5 ? l0 / l1 : 1;
          nr *= k;
          ng *= k;
          nb *= k;
        }
        data[i] = clamp255(nr);
        data[i + 1] = clamp255(ng);
        data[i + 2] = clamp255(nb);
      }
      return;
    }
    case 'channelMixer': {
      const mix = (c: MixerChannel, r: number, g: number, b: number) => (r * c.red + g * c.green + b * c.blue) / 100 + (c.constant / 100) * 255;
      for (let i = 0; i < n; i += 4) {
        if (!data[i + 3]) continue;
        const r = data[i],
          g = data[i + 1],
          b = data[i + 2];
        if (a.monochrome) data[i] = data[i + 1] = data[i + 2] = clamp255(mix(a.gray, r, g, b));
        else {
          data[i] = clamp255(mix(a.red, r, g, b));
          data[i + 1] = clamp255(mix(a.green, r, g, b));
          data[i + 2] = clamp255(mix(a.blue, r, g, b));
        }
      }
      return;
    }
    case 'threshold': {
      const t = a.level;
      for (let i = 0; i < n; i += 4) {
        if (!data[i + 3]) continue;
        const v = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] >= t ? 255 : 0;
        data[i] = data[i + 1] = data[i + 2] = v;
      }
      return;
    }
    case 'gradientMap': {
      const lut = gradientLut(a.stops, a.reverse);
      for (let i = 0; i < n; i += 4) {
        if (!data[i + 3]) continue;
        const v = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) * 3;
        data[i] = lut[v];
        data[i + 1] = lut[v + 1];
        data[i + 2] = lut[v + 2];
      }
      return;
    }
    case 'selectiveColor': {
      const rel = a.mode !== 'absolute';
      const R = SELECTIVE_RANGES.map((k) => a[k] as Cmyk);
      for (let i = 0; i < n; i += 4) {
        if (!data[i + 3]) continue;
        const ch = [data[i] / 255, data[i + 1] / 255, data[i + 2] / 255];
        const [r, g, b] = ch;
        const max = Math.max(r, g, b),
          min = Math.min(r, g, b);
        const mid = r + g + b - max - min;
        // How much each colour range applies to this pixel.
        const wt = [
          r === max ? max - mid : 0,
          b === min ? mid - min : 0,
          g === max ? max - mid : 0,
          r === min ? mid - min : 0,
          b === max ? max - mid : 0,
          g === min ? mid - min : 0,
          min > 0.5 ? (min - 0.5) * 2 : 0,
          Math.max(0, 1 - (Math.abs(max - 0.5) + Math.abs(min - 0.5))),
          max < 0.5 ? (0.5 - max) * 2 : 0
        ];
        for (let c = 0; c < 3; c++) {
          const cmy = 1 - ch[c];
          let delta = 0;
          for (let k = 0; k < 9; k++) {
            if (!wt[k]) continue;
            const adj = [R[k].c, R[k].m, R[k].y][c] / 100;
            const kAdj = R[k].k / 100;
            const base = rel ? cmy : 1;
            delta += wt[k] * (adj * base + kAdj * (rel ? cmy : 1));
          }
          ch[c] = clamp01(ch[c] - delta);
        }
        data[i] = ch[0] * 255;
        data[i + 1] = ch[1] * 255;
        data[i + 2] = ch[2] * 255;
      }
      return;
    }
  }
}

// ---------- Fast path for live compositing ----------
const N3 = 33;
const lut3Cache = new Map<string, Uint8Array>();
/** Sample a non-separable adjustment on a 33×33×33 colour grid (built once per setting). */
function lut3d(a: Adjustment): Uint8Array {
  const key = JSON.stringify(a);
  let lut = lut3Cache.get(key);
  if (lut) return lut;
  const n = N3 * N3 * N3;
  const grid = new Uint8ClampedArray(n * 4);
  let i = 0;
  for (let b = 0; b < N3; b++)
    for (let g = 0; g < N3; g++)
      for (let r = 0; r < N3; r++, i += 4) {
        grid[i] = Math.round((r * 255) / (N3 - 1));
        grid[i + 1] = Math.round((g * 255) / (N3 - 1));
        grid[i + 2] = Math.round((b * 255) / (N3 - 1));
        grid[i + 3] = 255;
      }
  applyAdjustment(grid, a);
  lut = new Uint8Array(n * 3);
  for (let k = 0; k < n; k++) {
    lut[k * 3] = grid[k * 4];
    lut[k * 3 + 1] = grid[k * 4 + 1];
    lut[k * 3 + 2] = grid[k * 4 + 2];
  }
  if (lut3Cache.size > 12) lut3Cache.clear();
  lut3Cache.set(key, lut);
  return lut;
}

/**
 * Same result as `applyAdjustment` (within a level or two) but much faster on big
 * images: per-pixel adjustments go through a 3D lookup table with trilinear blending.
 * Used by the compositor so adjustment layers stay interactive.
 */
export function applyAdjustmentFast(data: Uint8ClampedArray | Uint8Array, a: Adjustment) {
  if (data.length < 4 * 250000 || channelLuts(a) || a.type === 'gradientMap' || a.type === 'threshold') return applyAdjustment(data, a);
  const lut = lut3d(a);
  const S = (N3 - 1) / 255;
  const s1 = N3,
    s2 = N3 * N3;
  for (let i = 0; i < data.length; i += 4) {
    if (!data[i + 3]) continue;
    const fr = data[i] * S,
      fg = data[i + 1] * S,
      fb = data[i + 2] * S;
    const r0 = fr | 0,
      g0 = fg | 0,
      b0 = fb | 0;
    const r1 = r0 < N3 - 1 ? 1 : 0,
      g1 = g0 < N3 - 1 ? s1 : 0,
      b1 = b0 < N3 - 1 ? s2 : 0;
    const dr = fr - r0,
      dg = fg - g0,
      db = fb - b0;
    const base = r0 + g0 * s1 + b0 * s2;
    for (let c = 0; c < 3; c++) {
      const c000 = lut[base * 3 + c],
        c100 = lut[(base + r1) * 3 + c],
        c010 = lut[(base + g1) * 3 + c],
        c110 = lut[(base + r1 + g1) * 3 + c],
        c001 = lut[(base + b1) * 3 + c],
        c101 = lut[(base + r1 + b1) * 3 + c],
        c011 = lut[(base + g1 + b1) * 3 + c],
        c111 = lut[(base + r1 + g1 + b1) * 3 + c];
      const x0 = c000 + (c100 - c000) * dr,
        x1 = c010 + (c110 - c010) * dr,
        x2 = c001 + (c101 - c001) * dr,
        x3 = c011 + (c111 - c011) * dr;
      const y0 = x0 + (x1 - x0) * dg,
        y1 = x2 + (x3 - x2) * dg;
      data[i + c] = y0 + (y1 - y0) * db;
    }
  }
}

export interface Histogram {
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  l: Uint32Array;
}
/** Counts per value for each channel and luminosity (ignores transparent pixels). */
export function histogram(data: Uint8ClampedArray | Uint8Array, step = 1): Histogram {
  const h = { r: new Uint32Array(256), g: new Uint32Array(256), b: new Uint32Array(256), l: new Uint32Array(256) };
  for (let i = 0; i < data.length; i += 4 * step) {
    if (data[i + 3] < 8) continue;
    h.r[data[i]]++;
    h.g[data[i + 1]]++;
    h.b[data[i + 2]]++;
    h.l[Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2])]++;
  }
  return h;
}
