import type { Filter, FilterType } from './types';

/**
 * Filters. Pure functions (no DOM) over RGBA bytes so they run in the pixel worker.
 * Each returns a new buffer the same size as the input.
 */

export const FILTER_LABELS: Record<FilterType, string> = {
  gaussian: 'Gaussian blur',
  box: 'Box blur',
  motion: 'Motion blur',
  radial: 'Radial blur',
  unsharp: 'Unsharp mask',
  sharpen: 'Sharpen',
  noise: 'Add noise',
  median: 'Reduce noise (median)',
  pixelate: 'Pixelate',
  emboss: 'Emboss',
  edges: 'Find edges',
  oil: 'Oil paint',
  vignette: 'Vignette',
  offset: 'Offset'
};

export const FILTER_GROUPS: { label: string; items: FilterType[] }[] = [
  { label: 'Blur', items: ['gaussian', 'box', 'motion', 'radial'] },
  { label: 'Sharpen', items: ['unsharp', 'sharpen'] },
  { label: 'Noise', items: ['noise', 'median'] },
  { label: 'Stylize', items: ['pixelate', 'emboss', 'edges', 'oil', 'vignette'] },
  { label: 'Other', items: ['offset'] }
];

export function filterDefaults(type: FilterType): Filter {
  switch (type) {
    case 'gaussian':
      return { type, radius: 4 };
    case 'box':
      return { type, radius: 4 };
    case 'motion':
      return { type, angle: 0, distance: 20 };
    case 'radial':
      return { type, mode: 'zoom', amount: 20, cx: 0.5, cy: 0.5 };
    case 'unsharp':
      return { type, amount: 100, radius: 2, threshold: 0 };
    case 'sharpen':
      return { type, amount: 50 };
    case 'noise':
      return { type, amount: 10, gaussian: true, mono: false };
    case 'median':
      return { type, radius: 2 };
    case 'pixelate':
      return { type, size: 10 };
    case 'emboss':
      return { type, angle: 135, height: 3, amount: 100 };
    case 'edges':
      return { type };
    case 'oil':
      return { type, radius: 4 };
    case 'vignette':
      return { type, amount: -50, midpoint: 50, feather: 50, roundness: 0 };
    case 'offset':
      return { type, dx: 0, dy: 0, edge: 'wrap' };
  }
}

type Px = Uint8ClampedArray;

// ---------- Premultiplied float buffers (so blurs don't pull in dark fringes from transparent areas) ----------
function toPremul(d: Px): Float32Array {
  const f = new Float32Array(d.length);
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    f[i] = d[i] * a;
    f[i + 1] = d[i + 1] * a;
    f[i + 2] = d[i + 2] * a;
    f[i + 3] = d[i + 3];
  }
  return f;
}
function fromPremul(f: Float32Array): Px {
  const d = new Uint8ClampedArray(f.length);
  for (let i = 0; i < f.length; i += 4) {
    const a = f[i + 3];
    d[i + 3] = a;
    if (a > 0.01) {
      const k = 255 / a;
      d[i] = f[i] * k;
      d[i + 1] = f[i + 1] * k;
      d[i + 2] = f[i + 2] * k;
    }
  }
  return d;
}

/** One running-sum box pass along rows (or columns), edges clamped. */
function boxPass(src: Float32Array, dst: Float32Array, w: number, h: number, r: number, horiz: boolean) {
  if (r < 1) {
    dst.set(src);
    return;
  }
  const len = horiz ? w : h;
  const lines = horiz ? h : w;
  const stride = horiz ? 4 : w * 4;
  const inv = 1 / (2 * r + 1);
  for (let l = 0; l < lines; l++) {
    const base = horiz ? l * w * 4 : l * 4;
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += src[base + Math.min(len - 1, Math.max(0, k)) * stride + c];
      for (let i = 0; i < len; i++) {
        dst[base + i * stride + c] = sum * inv;
        const add = Math.min(len - 1, i + r + 1);
        const sub = Math.max(0, i - r);
        sum += src[base + add * stride + c] - src[base + sub * stride + c];
      }
    }
  }
}

function boxBlurF(f: Float32Array, w: number, h: number, r: number): Float32Array {
  const b = new Float32Array(f.length);
  const out = new Float32Array(f.length);
  boxPass(f, b, w, h, r, true);
  boxPass(b, out, w, h, r, false);
  return out;
}

/** Gaussian approximated by three box blurs (accurate to a few percent). */
function gaussF(f: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma < 0.3) return f.slice();
  const n = 3;
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  let a = f.slice(),
    b = new Float32Array(f.length);
  for (let i = 0; i < n; i++) {
    const r = ((i < m ? wl : wu) - 1) / 2;
    boxPass(a, b, w, h, r, true);
    boxPass(b, a, w, h, r, false);
  }
  return a;
}

export function gaussianBlur(d: Px, w: number, h: number, sigma: number): Px {
  return fromPremul(gaussF(toPremul(d), w, h, sigma));
}

function sampleClamp(d: Px | Float32Array, w: number, h: number, x: number, y: number, c: number) {
  const xi = x < 0 ? 0 : x >= w ? w - 1 : x | 0;
  const yi = y < 0 ? 0 : y >= h ? h - 1 : y | 0;
  return d[(yi * w + xi) * 4 + c];
}

function motionBlur(d: Px, w: number, h: number, angle: number, dist: number): Px {
  const f = toPremul(d);
  const out = new Float32Array(f.length);
  const a = (angle * Math.PI) / 180;
  const n = Math.max(2, Math.min(48, Math.round(dist)));
  const dx = (Math.cos(a) * dist) / (n - 1),
    dy = (-Math.sin(a) * dist) / (n - 1);
  const off = (n - 1) / 2;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let r = 0,
        g = 0,
        b = 0,
        al = 0;
      for (let k = 0; k < n; k++) {
        const sx = Math.round(x + (k - off) * dx),
          sy = Math.round(y + (k - off) * dy);
        const xi = sx < 0 ? 0 : sx >= w ? w - 1 : sx;
        const yi = sy < 0 ? 0 : sy >= h ? h - 1 : sy;
        const j = (yi * w + xi) * 4;
        r += f[j];
        g += f[j + 1];
        b += f[j + 2];
        al += f[j + 3];
      }
      const i = (y * w + x) * 4;
      out[i] = r / n;
      out[i + 1] = g / n;
      out[i + 2] = b / n;
      out[i + 3] = al / n;
    }
  return fromPremul(out);
}

function radialBlur(d: Px, w: number, h: number, p: Filter): Px {
  const f = toPremul(d);
  const out = new Float32Array(f.length);
  const cx = p.cx * w,
    cy = p.cy * h;
  const amt = p.amount / 100;
  const n = 24;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let r = 0,
        g = 0,
        b = 0,
        al = 0;
      const vx = x - cx,
        vy = y - cy;
      for (let k = 0; k < n; k++) {
        const t = (k / (n - 1) - 0.5) * amt;
        let sx: number, sy: number;
        if (p.mode === 'spin') {
          const ang = t * 0.6;
          const cs = Math.cos(ang),
            sn = Math.sin(ang);
          sx = cx + vx * cs - vy * sn;
          sy = cy + vx * sn + vy * cs;
        } else {
          sx = cx + vx * (1 + t * 0.5);
          sy = cy + vy * (1 + t * 0.5);
        }
        const xi = sx < 0 ? 0 : sx >= w ? w - 1 : sx | 0;
        const yi = sy < 0 ? 0 : sy >= h ? h - 1 : sy | 0;
        const j = (yi * w + xi) * 4;
        r += f[j];
        g += f[j + 1];
        b += f[j + 2];
        al += f[j + 3];
      }
      const i = (y * w + x) * 4;
      out[i] = r / n;
      out[i + 1] = g / n;
      out[i + 2] = b / n;
      out[i + 3] = al / n;
    }
  return fromPremul(out);
}

function unsharp(d: Px, w: number, h: number, p: Filter): Px {
  const blur = gaussianBlur(d, w, h, p.radius);
  const out = new Uint8ClampedArray(d.length);
  const amt = p.amount / 100,
    th = p.threshold;
  for (let i = 0; i < d.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const diff = d[i + c] - blur[i + c];
      out[i + c] = Math.abs(diff) >= th ? d[i + c] + diff * amt : d[i + c];
    }
    out[i + 3] = d[i + 3];
  }
  return out;
}

function convolve3(d: Px, w: number, h: number, k: number[], mix: number): Px {
  const out = new Uint8ClampedArray(d.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        let s = 0;
        for (let ky = -1; ky <= 1; ky++) for (let kx = -1; kx <= 1; kx++) s += k[(ky + 1) * 3 + kx + 1] * sampleClamp(d, w, h, x + kx, y + ky, c);
        out[i + c] = d[i + c] + (s - d[i + c]) * mix;
      }
      out[i + 3] = d[i + 3];
    }
  return out;
}

function addNoise(d: Px, p: Filter): Px {
  const out = new Uint8ClampedArray(d);
  const amt = (p.amount / 100) * 255;
  const rnd = () => (p.gaussian ? (Math.random() + Math.random() + Math.random() + Math.random() - 2) * 0.85 : Math.random() * 2 - 1);
  for (let i = 0; i < d.length; i += 4) {
    if (p.mono) {
      const n = rnd() * amt;
      out[i] = d[i] + n;
      out[i + 1] = d[i + 1] + n;
      out[i + 2] = d[i + 2] + n;
    } else {
      out[i] = d[i] + rnd() * amt;
      out[i + 1] = d[i + 1] + rnd() * amt;
      out[i + 2] = d[i + 2] + rnd() * amt;
    }
  }
  return out;
}

/** Median per channel with a sliding histogram (Huang's method). */
function median(d: Px, w: number, h: number, r: number): Px {
  const out = new Uint8ClampedArray(d);
  const area = (2 * r + 1) * (2 * r + 1);
  const half = area >> 1;
  const hist = new Int32Array(256);
  for (let c = 0; c < 3; c++) {
    for (let y = 0; y < h; y++) {
      hist.fill(0);
      for (let ky = -r; ky <= r; ky++) for (let kx = -r; kx <= r; kx++) hist[sampleClamp(d, w, h, kx, y + ky, c)]++;
      let med = 0,
        below = 0;
      // Find the starting median.
      let acc = 0;
      for (let v = 0; v < 256; v++) {
        if (acc + hist[v] > half) {
          med = v;
          below = acc;
          break;
        }
        acc += hist[v];
      }
      for (let x = 0; x < w; x++) {
        out[(y * w + x) * 4 + c] = med;
        if (x === w - 1) break;
        for (let ky = -r; ky <= r; ky++) {
          const o = sampleClamp(d, w, h, x - r, y + ky, c);
          const nv = sampleClamp(d, w, h, x + r + 1, y + ky, c);
          hist[o]--;
          if (o < med) below--;
          hist[nv]++;
          if (nv < med) below++;
        }
        while (below > half) {
          med--;
          below -= hist[med];
        }
        while (below + hist[med] <= half) {
          below += hist[med];
          med++;
        }
      }
    }
  }
  return out;
}

function pixelate(d: Px, w: number, h: number, size: number): Px {
  const s = Math.max(1, Math.round(size));
  const out = new Uint8ClampedArray(d.length);
  for (let by = 0; by < h; by += s)
    for (let bx = 0; bx < w; bx += s) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0,
        n = 0;
      const ex = Math.min(w, bx + s),
        ey = Math.min(h, by + s);
      for (let y = by; y < ey; y++)
        for (let x = bx; x < ex; x++) {
          const i = (y * w + x) * 4;
          const al = d[i + 3];
          r += d[i] * al;
          g += d[i + 1] * al;
          b += d[i + 2] * al;
          a += al;
          n++;
        }
      const k = a ? 1 / a : 0;
      for (let y = by; y < ey; y++)
        for (let x = bx; x < ex; x++) {
          const i = (y * w + x) * 4;
          out[i] = r * k;
          out[i + 1] = g * k;
          out[i + 2] = b * k;
          out[i + 3] = a / n;
        }
    }
  return out;
}

function emboss(d: Px, w: number, h: number, p: Filter): Px {
  const out = new Uint8ClampedArray(d.length);
  const a = (p.angle * Math.PI) / 180;
  const dx = Math.cos(a) * p.height,
    dy = -Math.sin(a) * p.height;
  const amt = p.amount / 100;
  const lum = (x: number, y: number) => 0.299 * sampleClamp(d, w, h, x, y, 0) + 0.587 * sampleClamp(d, w, h, x, y, 1) + 0.114 * sampleClamp(d, w, h, x, y, 2);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const v = 128 + (lum(x + dx, y + dy) - lum(x - dx, y - dy)) * amt;
      out[i] = out[i + 1] = out[i + 2] = v;
      out[i + 3] = d[i + 3];
    }
  return out;
}

function findEdges(d: Px, w: number, h: number): Px {
  const out = new Uint8ClampedArray(d.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const s = (xx: number, yy: number) => sampleClamp(d, w, h, x + xx, y + yy, c);
        const gx = s(1, -1) + 2 * s(1, 0) + s(1, 1) - s(-1, -1) - 2 * s(-1, 0) - s(-1, 1);
        const gy = s(-1, 1) + 2 * s(0, 1) + s(1, 1) - s(-1, -1) - 2 * s(0, -1) - s(1, -1);
        out[i + c] = 255 - Math.min(255, Math.sqrt(gx * gx + gy * gy) * 0.5);
      }
      out[i + 3] = d[i + 3];
    }
  return out;
}

/** Kuwahara: each pixel takes the mean of whichever neighbouring quadrant is most uniform (painterly look). */
function kuwahara(d: Px, w: number, h: number, r: number): Px {
  r = Math.max(1, Math.round(r));
  const W = w + 1;
  const sat = [0, 1, 2, 3, 4].map(() => new Float64Array(W * (h + 1)));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const vals = [d[i], d[i + 1], d[i + 2], l, l * l];
      const j = (y + 1) * W + x + 1;
      for (let k = 0; k < 5; k++) sat[k][j] = vals[k] + sat[k][j - 1] + sat[k][j - W] - sat[k][j - W - 1];
    }
  const sum = (k: number, x0: number, y0: number, x1: number, y1: number) => {
    x0 = Math.max(0, x0);
    y0 = Math.max(0, y0);
    x1 = Math.min(w - 1, x1);
    y1 = Math.min(h - 1, y1);
    const s = sat[k];
    return s[(y1 + 1) * W + x1 + 1] - s[y0 * W + x1 + 1] - s[(y1 + 1) * W + x0] + s[y0 * W + x0];
  };
  const out = new Uint8ClampedArray(d.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const quads = [
        [x - r, y - r, x, y],
        [x, y - r, x + r, y],
        [x - r, y, x, y + r],
        [x, y, x + r, y + r]
      ];
      let best = Infinity,
        bi = 0,
        bn = 1;
      for (let q = 0; q < 4; q++) {
        const [x0, y0, x1, y1] = quads[q];
        const n = (Math.min(w - 1, x1) - Math.max(0, x0) + 1) * (Math.min(h - 1, y1) - Math.max(0, y0) + 1);
        const m = sum(3, x0, y0, x1, y1) / n;
        const v = sum(4, x0, y0, x1, y1) / n - m * m;
        if (v < best) {
          best = v;
          bi = q;
          bn = n;
        }
      }
      const [x0, y0, x1, y1] = quads[bi];
      const i = (y * w + x) * 4;
      out[i] = sum(0, x0, y0, x1, y1) / bn;
      out[i + 1] = sum(1, x0, y0, x1, y1) / bn;
      out[i + 2] = sum(2, x0, y0, x1, y1) / bn;
      out[i + 3] = d[i + 3];
    }
  return out;
}

function vignette(d: Px, w: number, h: number, p: Filter, full: { w: number; h: number; x: number; y: number }): Px {
  const out = new Uint8ClampedArray(d);
  const amt = p.amount / 100;
  const mid = p.midpoint / 100;
  const feather = Math.max(0.02, p.feather / 100);
  // Measured against the document (not the layer) so the vignette centres on the picture.
  const cx = full.w / 2,
    cy = full.h / 2;
  const round = p.roundness / 100;
  const sx = 1 / (round > 0 ? Math.max(cx, cy) * (1 - round) + Math.min(cx, cy) * round : cx);
  const sy = 1 / (round > 0 ? Math.max(cx, cy) * (1 - round) + Math.min(cx, cy) * round : cy);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const dx = (x + full.x - cx) * sx,
        dy = (y + full.y - cy) * sy;
      const dist = Math.sqrt(dx * dx + dy * dy) / Math.SQRT2;
      let t = (dist - mid * 0.9) / feather;
      t = t < 0 ? 0 : t > 1 ? 1 : t * t * (3 - 2 * t);
      if (!t) continue;
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const v = d[i + c];
        out[i + c] = amt < 0 ? v * (1 + amt * t) : v + (255 - v) * amt * t;
      }
    }
  return out;
}

function offset(d: Px, w: number, h: number, p: Filter): Px {
  const out = new Uint8ClampedArray(d.length);
  const dx = Math.round(p.dx),
    dy = Math.round(p.dy);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let sx = x - dx,
        sy = y - dy;
      if (p.edge === 'wrap') {
        sx = ((sx % w) + w) % w;
        sy = ((sy % h) + h) % h;
      } else if (p.edge === 'repeat') {
        sx = Math.max(0, Math.min(w - 1, sx));
        sy = Math.max(0, Math.min(h - 1, sy));
      } else if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
      const i = (y * w + x) * 4,
        j = (sy * w + sx) * 4;
      out[i] = d[j];
      out[i + 1] = d[j + 1];
      out[i + 2] = d[j + 2];
      out[i + 3] = d[j + 3];
    }
  return out;
}

/**
 * Run a filter. `place` tells where these pixels sit in the document (for filters
 * that are measured against the whole picture, like the vignette and radial blur centre).
 */
export function applyFilter(d: Px, w: number, h: number, f: Filter, place = { x: 0, y: 0, w, h }): Px {
  switch (f.type) {
    case 'gaussian':
      return gaussianBlur(d, w, h, f.radius);
    case 'box':
      return fromPremul(boxBlurF(toPremul(d), w, h, Math.round(f.radius)));
    case 'motion':
      return motionBlur(d, w, h, f.angle, f.distance);
    case 'radial':
      return radialBlur(d, w, h, { ...f, cx: (f.cx * place.w - place.x) / w, cy: (f.cy * place.h - place.y) / h });
    case 'unsharp':
      return unsharp(d, w, h, f);
    case 'sharpen':
      return convolve3(d, w, h, [0, -1, 0, -1, 5, -1, 0, -1, 0], f.amount / 50);
    case 'noise':
      return addNoise(d, f);
    case 'median':
      return median(d, w, h, Math.max(1, Math.round(f.radius)));
    case 'pixelate':
      return pixelate(d, w, h, f.size);
    case 'emboss':
      return emboss(d, w, h, f);
    case 'edges':
      return findEdges(d, w, h);
    case 'oil':
      return kuwahara(d, w, h, f.radius);
    case 'vignette':
      return vignette(d, w, h, f, place);
    case 'offset':
      return offset(d, w, h, f);
  }
}

/** Blend `result` back over `orig` by a 0–255 weight per pixel (selection), in place on `result`. */
export function mixBySelection(orig: Px, result: Px, sel: Uint8Array | Uint8ClampedArray) {
  for (let p = 0, i = 0; p < sel.length; p++, i += 4) {
    const s = sel[p];
    if (s === 255) continue;
    if (s === 0) {
      result[i] = orig[i];
      result[i + 1] = orig[i + 1];
      result[i + 2] = orig[i + 2];
      result[i + 3] = orig[i + 3];
      continue;
    }
    const k = s / 255;
    for (let c = 0; c < 4; c++) result[i + c] = orig[i + c] + (result[i + c] - orig[i + c]) * k;
  }
}

