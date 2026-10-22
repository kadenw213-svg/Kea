import type { Rect, Selection } from './types';
import { makeCanvas, ctx2d, getPixels, alphaBounds, borrow, release } from './canvas';

/**
 * Selections are document-sized canvases where alpha = how selected a pixel is.
 * Every operation returns a new canvas (never edits one in place) so undo can share them.
 */

export type SelMode = 'new' | 'add' | 'subtract' | 'intersect';

export function selectionFrom(c: HTMLCanvasElement): Selection | null {
  const b = alphaBounds(c, 3);
  return b ? { canvas: c, bounds: b } : null;
}

/** A white shape on a transparent document-sized canvas. */
export function shapeMask(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, antialias = true): HTMLCanvasElement {
  const c = makeCanvas(w, h);
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  g.strokeStyle = '#fff';
  draw(g);
  if (!antialias) {
    const d = getPixels(c);
    for (let i = 3; i < d.data.length; i += 4) d.data[i] = d.data[i] >= 128 ? 255 : 0;
    ctx2d(c).putImageData(d, 0, 0);
  }
  return c;
}

export function rectMask(w: number, h: number, r: Rect) {
  return shapeMask(w, h, (g) => g.fillRect(Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h)));
}
export function ellipseMask(w: number, h: number, r: Rect) {
  return shapeMask(w, h, (g) => {
    g.beginPath();
    g.ellipse(r.x + r.w / 2, r.y + r.h / 2, Math.max(0.5, r.w / 2), Math.max(0.5, r.h / 2), 0, 0, Math.PI * 2);
    g.fill();
  });
}
export function polyMask(w: number, h: number, pts: { x: number; y: number }[]) {
  return shapeMask(w, h, (g) => {
    g.beginPath();
    pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
    g.closePath();
    g.fill();
  });
}

/**
 * Anti-alias a hard-edged mask: a slight blur only outside the shape, so pixels
 * inside (including along the canvas border) stay fully selected.
 */
export function softenEdges(c: HTMLCanvasElement, radius = 0.6): HTMLCanvasElement {
  const out = makeCanvas(c.width, c.height);
  const g = out.getContext('2d')!;
  g.filter = `blur(${radius}px)`;
  g.drawImage(c, 0, 0);
  g.filter = 'none';
  g.drawImage(c, 0, 0);
  return out;
}

/** Merge a new shape into the current selection. */
export function combine(cur: Selection | null, shape: HTMLCanvasElement, mode: SelMode): Selection | null {
  if (mode === 'new' || (!cur && mode !== 'subtract' && mode !== 'intersect')) return selectionFrom(shape);
  if (!cur) return null;
  const c = makeCanvas(shape.width, shape.height);
  const g = c.getContext('2d')!;
  g.drawImage(cur.canvas, 0, 0);
  g.globalCompositeOperation = mode === 'add' ? 'source-over' : mode === 'subtract' ? 'destination-out' : 'destination-in';
  g.drawImage(shape, 0, 0);
  return selectionFrom(c);
}

export function selectAll(w: number, h: number): Selection {
  return { canvas: rectMask(w, h, { x: 0, y: 0, w, h }), bounds: { x: 0, y: 0, w, h } };
}

export function invert(cur: Selection | null, w: number, h: number): Selection | null {
  if (!cur) return selectAll(w, h);
  const c = makeCanvas(w, h);
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, w, h);
  g.globalCompositeOperation = 'destination-out';
  g.drawImage(cur.canvas, 0, 0);
  return selectionFrom(c);
}

/** Soften the edge (radius ≈ Photoshop's feather radius). */
export function feather(cur: Selection, radius: number): Selection | null {
  const c = makeCanvas(cur.canvas.width, cur.canvas.height);
  const g = c.getContext('2d')!;
  g.filter = `blur(${Math.max(0.1, radius / 2)}px)`;
  g.drawImage(cur.canvas, 0, 0);
  g.filter = 'none';
  return selectionFrom(c);
}

/** Squared Euclidean distance transform (Felzenszwalb & Huttenlocher), in place. */
function edt(f: Float32Array, w: number, h: number) {
  const n = Math.max(w, h);
  const d = new Float32Array(n),
    v = new Int32Array(n),
    z = new Float32Array(n + 1),
    tmp = new Float32Array(n);
  const pass = (get: (i: number) => number, set: (i: number, x: number) => void, len: number) => {
    for (let i = 0; i < len; i++) tmp[i] = get(i);
    let k = 0;
    v[0] = 0;
    z[0] = -Infinity;
    z[1] = Infinity;
    for (let q = 1; q < len; q++) {
      let s = (tmp[q] + q * q - (tmp[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = (tmp[q] + q * q - (tmp[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) + tmp[v[k]];
    }
    for (let i = 0; i < len; i++) set(i, d[i]);
  };
  for (let x = 0; x < w; x++)
    pass(
      (i) => f[i * w + x],
      (i, val) => (f[i * w + x] = val),
      h
    );
  for (let y = 0; y < h; y++)
    pass(
      (i) => f[y * w + i],
      (i, val) => (f[y * w + i] = val),
      w
    );
}

/** Grow (positive) or shrink (negative) the selection by `r` pixels, with round corners. */
export function expand(cur: Selection, r: number): Selection | null {
  const { width: w, height: h } = cur.canvas;
  const src = getPixels(cur.canvas).data;
  const f = new Float32Array(w * h);
  const grow = r > 0;
  const BIG = 1e10;
  for (let p = 0; p < w * h; p++) {
    const on = src[p * 4 + 3] >= 128;
    // Distance to the nearest selected pixel (grow) or the nearest unselected one (shrink).
    f[p] = (grow ? on : !on) ? 0 : BIG;
  }
  edt(f, w, h);
  const r2 = r * r;
  const out = makeCanvas(w, h);
  const od = new ImageData(w, h);
  for (let p = 0; p < w * h; p++) {
    const on = grow ? f[p] <= r2 : f[p] > r2;
    if (on) {
      od.data[p * 4] = od.data[p * 4 + 1] = od.data[p * 4 + 2] = 255;
      od.data[p * 4 + 3] = 255;
    }
  }
  ctx2d(out).putImageData(od, 0, 0);
  return selectionFrom(out);
}

/** A band `width` pixels wide around the selection edge. */
export function border(cur: Selection, width: number): Selection | null {
  const outer = expand(cur, Math.max(1, width / 2));
  const inner = expand(cur, -Math.max(1, width / 2));
  if (!outer) return null;
  return inner ? combine(outer, inner.canvas, 'subtract') : outer;
}

/** Selection weight (0–255) for each pixel of `r` (document coordinates). Null when nothing is selected. */
export function weights(sel: Selection | null, r: Rect): Uint8Array | null {
  if (!sel) return null;
  const c = borrow(r.w, r.h);
  c.getContext('2d')!.drawImage(sel.canvas, -r.x, -r.y);
  const d = getPixels(c).data;
  release(c);
  const out = new Uint8Array(r.w * r.h);
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4 + 3];
  return out;
}

function colorDist(d: Uint8ClampedArray, i: number, r: number, g: number, b: number, a: number) {
  return Math.max(Math.abs(d[i] - r), Math.abs(d[i + 1] - g), Math.abs(d[i + 2] - b), Math.abs(d[i + 3] - a));
}

/**
 * Magic wand: pixels close in colour to the one clicked (within `tol`, 0–255),
 * either connected to it or anywhere. `px` is document-sized RGBA.
 */
export function wandMask(px: ImageData, x: number, y: number, tol: number, contiguous: boolean, limit?: Rect): HTMLCanvasElement {
  const { width: w, height: h, data } = px;
  const out = new ImageData(w, h);
  const o = out.data;
  x = Math.floor(x);
  y = Math.floor(y);
  if (x < 0 || y < 0 || x >= w || y >= h) return makeCanvas(w, h);
  const s = (y * w + x) * 4;
  const r = data[s],
    g = data[s + 1],
    b = data[s + 2],
    a = data[s + 3];
  const lx0 = limit ? Math.max(0, limit.x) : 0,
    ly0 = limit ? Math.max(0, limit.y) : 0;
  const lx1 = limit ? Math.min(w, limit.x + limit.w) : w,
    ly1 = limit ? Math.min(h, limit.y + limit.h) : h;
  const mark = (p: number) => {
    o[p * 4] = o[p * 4 + 1] = o[p * 4 + 2] = o[p * 4 + 3] = 255;
  };
  if (!contiguous) {
    for (let yy = ly0; yy < ly1; yy++) for (let xx = lx0; xx < lx1; xx++) if (colorDist(data, (yy * w + xx) * 4, r, g, b, a) <= tol) mark(yy * w + xx);
  } else {
    // Scanline flood fill.
    const seen = new Uint8Array(w * h);
    const fits = (p: number) => !seen[p] && colorDist(data, p * 4, r, g, b, a) <= tol;
    const stack = [x, y];
    // Push one seed per run of fillable pixels on a neighbouring row.
    const scan = (ny: number, lx: number, rx: number) => {
      let inRun = false;
      for (let xx = lx; xx <= rx; xx++) {
        const ok = fits(ny * w + xx);
        if (ok && !inRun) stack.push(xx, ny);
        inRun = ok;
      }
    };
    while (stack.length) {
      const sy = stack.pop()!,
        sx = stack.pop()!;
      if (!fits(sy * w + sx)) continue;
      let lx = sx;
      while (lx > lx0 && fits(sy * w + lx - 1)) lx--;
      let rx = sx;
      while (rx < lx1 - 1 && fits(sy * w + rx + 1)) rx++;
      for (let xx = lx; xx <= rx; xx++) {
        seen[sy * w + xx] = 1;
        mark(sy * w + xx);
      }
      if (sy > ly0) scan(sy - 1, lx, rx);
      if (sy < ly1 - 1) scan(sy + 1, lx, rx);
    }
  }
  const c = makeCanvas(w, h);
  ctx2d(c).putImageData(out, 0, 0);
  return c;
}

/** Select by colour range: every pixel within `fuzz` of the colour, with a soft falloff. */
export function colorRangeMask(px: ImageData, rgb: { r: number; g: number; b: number }, fuzz: number): HTMLCanvasElement {
  const { width: w, height: h, data } = px;
  const out = new ImageData(w, h);
  const f = Math.max(1, fuzz);
  for (let i = 0; i < data.length; i += 4) {
    const d = Math.sqrt(((data[i] - rgb.r) ** 2 + (data[i + 1] - rgb.g) ** 2 + (data[i + 2] - rgb.b) ** 2) / 3);
    const v = d <= f * 0.5 ? 255 : d >= f ? 0 : 255 * (1 - (d - f * 0.5) / (f * 0.5));
    out.data[i] = out.data[i + 1] = out.data[i + 2] = 255;
    out.data[i + 3] = v * (data[i + 3] / 255);
  }
  const c = makeCanvas(w, h);
  ctx2d(c).putImageData(out, 0, 0);
  return c;
}

// ---------- Marching ants ----------
const antsCache = new WeakMap<HTMLCanvasElement, Path2D>();
/** Outline of the selection (pixels at least half selected) as a path in document pixels. */
export function antsPath(sel: Selection): Path2D {
  const hit = antsCache.get(sel.canvas);
  if (hit) return hit;
  const { width: w } = sel.canvas;
  const b = sel.bounds;
  const x0 = Math.max(0, b.x - 1),
    y0 = Math.max(0, b.y - 1);
  const bw = Math.min(w, b.x + b.w + 1) - x0,
    bh = Math.min(sel.canvas.height, b.y + b.h + 1) - y0;
  const d = getPixels(sel.canvas, { x: x0, y: y0, w: bw, h: bh }).data;
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < bw && y < bh && d[(y * bw + x) * 4 + 3] >= 128;
  const path = new Path2D();
  // Horizontal edges, merged into runs.
  for (let y = 0; y <= bh; y++) {
    let start = -1;
    for (let x = 0; x <= bw; x++) {
      const edge = x < bw && on(x, y) !== on(x, y - 1);
      if (edge && start < 0) start = x;
      if (!edge && start >= 0) {
        path.moveTo(x0 + start, y0 + y);
        path.lineTo(x0 + x, y0 + y);
        start = -1;
      }
    }
  }
  for (let x = 0; x <= bw; x++) {
    let start = -1;
    for (let y = 0; y <= bh; y++) {
      const edge = y < bh && on(x, y) !== on(x - 1, y);
      if (edge && start < 0) start = y;
      if (!edge && start >= 0) {
        path.moveTo(x0 + x, y0 + start);
        path.lineTo(x0 + x, y0 + y);
        start = -1;
      }
    }
  }
  antsCache.set(sel.canvas, path);
  return path;
}

export function selectionArea(sel: Selection | null): string {
  if (!sel) return 'none';
  const b = sel.bounds;
  return `${b.w} × ${b.h} px at (${b.x}, ${b.y})`;
}
