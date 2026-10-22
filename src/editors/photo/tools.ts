import type { Engine, TransformState } from './engine';
import { transformCorners, transformedBounds } from './engine';
import type { Pt, Rect, Mask, RasterLayer, TextData, ShapeData, Layer } from './types';
import { isPixelLayer } from './types';
import type { BrushOpts, ToolId } from './toolOptions';
import { brushKey } from './toolOptions';
import { makeCanvas, cloneCanvas, borrow, release, getPixels, grayOf, hexToRgb, union, rectOf, ctx2d } from './canvas';
import { invalidateMask } from './render';
import { textBox, renderText } from './vector';
import { healRegion } from './heal';
import * as S from './selection';
import * as ops from './ops';
import { toast } from '../../store';

/**
 * Pointer handling for every tool. One drag at a time; state lives in `drag`.
 * Coordinates are document pixels (fractional); `sx/sy` are screen pixels in the viewport.
 */

export interface PtrInfo {
  x: number;
  y: number;
  sx: number;
  sy: number;
  pressure: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  button: number;
  dbl: boolean;
}

interface Drag {
  tool: ToolId | 'transform' | 'crop' | 'pan';
  start: PtrInfo;
  last: PtrInfo;
  moved: boolean;
  data: any;
}
let drag: Drag | null = null;
/** The text layer being typed into: its settings before editing (null = a new layer). */
export let textSession: { id: string; orig: TextData | null } | null = null;

const fail = (err: unknown) => toast((err as Error)?.message || String(err), 'error');

export function isDragging() {
  return !!drag;
}

// ---------- Brush stamps ----------
const stamps = new Map<string, HTMLCanvasElement>();
/** A round brush tip: solid to `hard`×radius, then fading out. Pencil tips are aliased. */
function stamp(d: number, hard: number, color: string, aliased: boolean): HTMLCanvasElement {
  d = Math.max(1, aliased ? Math.round(d) : Math.round(d * 4) / 4);
  const key = `${d}|${hard}|${color}|${aliased}`;
  let c = stamps.get(key);
  if (c) return c;
  if (stamps.size > 80) stamps.clear();
  const size = Math.ceil(d) + 2;
  c = makeCanvas(size, size);
  const g = c.getContext('2d')!;
  const r = d / 2;
  const cx = size / 2;
  if (aliased) {
    const img = g.createImageData(size, size);
    const { r: R, g: G, b: B } = hexToRgb(color);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const dx = x + 0.5 - cx,
          dy = y + 0.5 - cx;
        if (dx * dx + dy * dy <= r * r + 0.25 || d <= 1.5) {
          if (d <= 1.5 && (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5)) continue;
          const i = (y * size + x) * 4;
          img.data[i] = R;
          img.data[i + 1] = G;
          img.data[i + 2] = B;
          img.data[i + 3] = 255;
        }
      }
    g.putImageData(img, 0, 0);
  } else if (hard >= 0.99) {
    g.fillStyle = color;
    g.beginPath();
    g.arc(cx, cx, r, 0, Math.PI * 2);
    g.fill();
  } else {
    const { r: R, g: G, b: B } = hexToRgb(color);
    const grad = g.createRadialGradient(cx, cx, 0, cx, cx, r);
    const h = Math.max(0, Math.min(0.98, hard));
    grad.addColorStop(0, `rgba(${R},${G},${B},1)`);
    grad.addColorStop(h, `rgba(${R},${G},${B},1)`);
    // Smooth falloff (a few stops approximating a cosine curve).
    for (let k = 1; k <= 4; k++) {
      const t = k / 5;
      grad.addColorStop(h + (1 - h) * t, `rgba(${R},${G},${B},${(0.5 + 0.5 * Math.cos(Math.PI * t)).toFixed(3)})`);
    }
    grad.addColorStop(1, `rgba(${R},${G},${B},0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
  }
  stamps.set(key, c);
  return c;
}

/** Weight of a soft brush at distance `dist` from its centre (pixel tools). */
function falloff(dist: number, r: number, hard: number) {
  if (dist >= r) return 0;
  const h = r * Math.min(0.98, hard);
  if (dist <= h) return 1;
  const t = (dist - h) / (r - h);
  return 0.5 + 0.5 * Math.cos(Math.PI * t);
}

// ---------- Painting ----------
interface Paint {
  kind: 'buffer' | 'mask' | 'pixels' | 'clone' | 'heal';
  o: BrushOpts;
  color: string;
  aliased: boolean;
  sm: Pt;
  last: Pt & { p: number };
  carry: number;
  mask?: Mask;
  layer?: RasterLayer;
  img?: ImageData;
  sel?: Uint8Array | null;
  src?: HTMLCanvasElement;
  off?: Pt;
  smudge?: Float32Array | null;
  dirty?: Rect | null;
}

let cloneOffset: Pt | null = null;

function startPaint(e: Engine, p: PtrInfo): Paint | null {
  const key = brushKey(e.tool)!;
  const o = e.opts[key] as BrushOpts;
  const t = e.tool;
  const pr = p.pressure;
  const base = { o, sm: { x: p.x, y: p.y }, last: { x: p.x, y: p.y, p: pr }, carry: 0, aliased: t === 'pencil' };
  if (t === 'clone' && p.alt) {
    e.cloneSource = { x: p.x, y: p.y };
    cloneOffset = null;
    toast('Clone source set. Now paint where you want the copy');
    e.requestFrame();
    return null;
  }
  const surf = ops.paintSurface(e);
  if (surf.mask) {
    if (t !== 'brush' && t !== 'pencil' && t !== 'eraser') throw new Error('This tool works on pixels. Click the layer thumbnail to paint pixels instead of the mask');
    e.ownMask(surf.mask);
    const color = grayOf(t === 'eraser' ? e.bg : e.fg);
    return { ...base, kind: 'mask', color, mask: surf.mask };
  }
  const l = surf.layer as RasterLayer;
  e.growToDoc(l);
  if (t === 'brush' || t === 'pencil' || t === 'eraser') {
    e.beginLive(l.id, t === 'eraser' ? 'erase' : 'over', o.opacity);
    return { ...base, kind: 'buffer', color: t === 'eraser' ? '#000000' : e.fg };
  }
  if (t === 'clone') {
    if (!e.cloneSource) throw new Error('Alt-click a spot first to choose where to copy from');
    const src = makeCanvas(e.doc.w, e.doc.h);
    const sg = src.getContext('2d')!;
    if (e.opts.clone.sampleAll) sg.drawImage(e.flush(), 0, 0);
    else sg.drawImage(l.canvas, l.x, l.y);
    if (!e.opts.clone.aligned || !cloneOffset) cloneOffset = { x: e.cloneSource.x - p.x, y: e.cloneSource.y - p.y };
    e.beginLive(l.id, 'over', o.opacity);
    return { ...base, kind: 'clone', color: '#ffffff', src, off: { ...cloneOffset } };
  }
  if (t === 'heal') {
    e.beginLive(l.id, 'over', 0.35);
    return { ...base, kind: 'heal', color: '#ff2d55', layer: l };
  }
  // Toning / focus tools edit the layer's pixels directly.
  l.canvas = cloneCanvas(l.canvas);
  const img = getPixels(l.canvas);
  return { ...base, kind: 'pixels', color: '', layer: l, img, sel: S.weights(e.selection, ops.layerRect(l)), smudge: null, dirty: null };
}

function paintTo(e: Engine, d: Paint, p: PtrInfo, final = false) {
  // Smoothing: follow the pointer with some lag, like a string being pulled.
  const k = final ? 1 : 1 - Math.min(0.95, d.o.smoothing * 0.9);
  const tx = d.sm.x + (p.x - d.sm.x) * k,
    ty = d.sm.y + (p.y - d.sm.y) * k;
  d.sm = { x: tx, y: ty };
  const size = (pr: number) => Math.max(1, d.o.size * (d.o.pressureSize ? Math.max(0.05, pr) : 1));
  const from = d.last;
  const dist = Math.hypot(tx - from.x, ty - from.y);
  const spacing = d.aliased ? 1 : Math.max(0.5, size(p.pressure) * (d.kind === 'pixels' ? 0.2 : 0.1));
  let pos = spacing - d.carry;
  while (pos <= dist) {
    const f = dist ? pos / dist : 1;
    const pr = from.p + (p.pressure - from.p) * f;
    dab(e, d, from.x + (tx - from.x) * f, from.y + (ty - from.y) * f, size(pr), pr);
    pos += spacing;
  }
  d.carry = dist - (pos - spacing);
  d.last = { x: tx, y: ty, p: p.pressure };
  // Only the stretch of canvas this segment touched needs recompositing.
  const r = d.o.size / 2 + 4;
  e.invalidate({ x: Math.min(from.x, tx) - r, y: Math.min(from.y, ty) - r, w: Math.abs(tx - from.x) + r * 2, h: Math.abs(ty - from.y) + r * 2 });
}

function dab(e: Engine, d: Paint, x: number, y: number, size: number, pr: number) {
  const o = d.o;
  const alpha = o.flow * (o.pressureOpacity ? Math.max(0.05, pr) : 1);
  if (d.aliased) {
    x = Math.floor(x) + 0.5;
    y = Math.floor(y) + 0.5;
  }
  const r = size / 2;
  if (d.kind === 'buffer' || d.kind === 'heal') {
    const s = stamp(size, o.hardness, d.color, d.aliased);
    const live = e.live!;
    const g = live.buffer.getContext('2d')!;
    g.globalAlpha = d.kind === 'heal' ? 1 : alpha;
    const sx = x - s.width / 2,
      sy = y - s.height / 2;
    g.drawImage(s, d.aliased ? Math.round(sx) : sx, d.aliased ? Math.round(sy) : sy);
    live.bounds = union(live.bounds, { x: sx, y: sy, w: s.width, h: s.height });
  } else if (d.kind === 'clone') {
    const s = stamp(size, o.hardness, '#ffffff', false);
    const t = borrow(s.width, s.height);
    const tg = t.getContext('2d')!;
    const sx = x - s.width / 2,
      sy = y - s.height / 2;
    tg.drawImage(d.src!, -(sx + d.off!.x), -(sy + d.off!.y));
    tg.globalCompositeOperation = 'destination-in';
    tg.drawImage(s, 0, 0);
    const live = e.live!;
    const g = live.buffer.getContext('2d')!;
    g.globalAlpha = alpha;
    g.drawImage(t, sx, sy);
    release(t);
    live.bounds = union(live.bounds, { x: sx, y: sy, w: s.width, h: s.height });
  } else if (d.kind === 'mask') {
    const m = d.mask!;
    const s = stamp(size, e.tool === 'pencil' ? 1 : o.hardness, d.color, d.aliased);
    const sx = x - s.width / 2,
      sy = y - s.height / 2;
    let src: HTMLCanvasElement = s;
    let t: HTMLCanvasElement | null = null;
    if (e.selection) {
      t = borrow(s.width, s.height);
      const tg = t.getContext('2d')!;
      tg.drawImage(s, 0, 0);
      tg.globalCompositeOperation = 'destination-in';
      tg.drawImage(e.selection.canvas, -sx, -sy);
      src = t;
    }
    const g = m.canvas.getContext('2d')!;
    g.globalAlpha = alpha * o.opacity;
    g.drawImage(src, sx - m.x, sy - m.y);
    g.globalAlpha = 1;
    if (t) release(t);
    invalidateMask(m, { x: sx - m.x - 1, y: sy - m.y - 1, w: s.width + 2, h: s.height + 2 });
  } else if (d.kind === 'pixels') pixelDab(e, d, x, y, r, alpha);
}

/** Dodge, burn, blur, sharpen and smudge: change the layer's pixels under the brush. */
function pixelDab(e: Engine, d: Paint, x: number, y: number, r: number, alpha: number) {
  const l = d.layer!;
  const img = d.img!;
  const W = img.width,
    H = img.height;
  const lx = x - l.x,
    ly = y - l.y;
  const x0 = Math.max(1, Math.floor(lx - r)),
    y0 = Math.max(1, Math.floor(ly - r));
  const x1 = Math.min(W - 2, Math.ceil(lx + r)),
    y1 = Math.min(H - 2, Math.ceil(ly + r));
  if (x1 < x0 || y1 < y0) return;
  const p = img.data;
  const tool = e.tool;
  const hard = d.o.hardness;
  const tone = e.opts.toning;
  const strength = e.opts.focus.strength * alpha;
  // Read-only copy of the area (blur/sharpen read neighbours).
  const bw = x1 - x0 + 3,
    bh = y1 - y0 + 3;
  const copy = new Uint8ClampedArray(bw * bh * 4);
  for (let yy = 0; yy < bh; yy++) copy.set(p.subarray(((y0 - 1 + yy) * W + x0 - 1) * 4, ((y0 - 1 + yy) * W + x0 - 1 + bw) * 4), yy * bw * 4);
  const at = (xx: number, yy: number, c: number) => copy[((yy - y0 + 1) * bw + (xx - x0 + 1)) * 4 + c];
  const dw = Math.ceil(r * 2) + 2;
  if (tool === 'smudge' && !d.smudge) {
    // Pick up paint where the stroke starts.
    d.smudge = new Float32Array(dw * dw * 4);
    for (let yy = 0; yy < dw; yy++)
      for (let xx = 0; xx < dw; xx++) {
        const px = Math.min(W - 1, Math.max(0, Math.round(lx - dw / 2 + xx))),
          py = Math.min(H - 1, Math.max(0, Math.round(ly - dw / 2 + yy)));
        for (let c = 0; c < 4; c++) d.smudge[(yy * dw + xx) * 4 + c] = p[(py * W + px) * 4 + c];
      }
  }
  for (let yy = y0; yy <= y1; yy++)
    for (let xx = x0; xx <= x1; xx++) {
      let w = falloff(Math.hypot(xx + 0.5 - lx, yy + 0.5 - ly), r, hard);
      if (!w) continue;
      if (d.sel) w *= d.sel[yy * W + xx] / 255;
      if (!w) continue;
      const i = (yy * W + xx) * 4;
      if (tool === 'dodge' || tool === 'burn') {
        const ex = tone.exposure * alpha * w * 0.35;
        for (let c = 0; c < 3; c++) {
          const v = p[i + c] / 255;
          const k = tone.range === 'shadows' ? (1 - v) * (1 - v) : tone.range === 'highlights' ? v * v : 4 * v * (1 - v);
          p[i + c] = tool === 'dodge' ? p[i + c] + (255 - p[i + c]) * ex * k * 2 : p[i + c] - p[i + c] * ex * k * 2;
        }
      } else if (tool === 'blur' || tool === 'sharpen') {
        for (let c = 0; c < 4; c++) {
          let s = 0;
          for (let ky = -1; ky <= 1; ky++) for (let kx = -1; kx <= 1; kx++) s += at(xx + kx, yy + ky, c);
          const avg = s / 9;
          const v = at(xx, yy, c);
          if (tool === 'blur') p[i + c] = v + (avg - v) * strength * w;
          else if (c < 3) p[i + c] = v + (v - avg) * strength * w * 1.5;
        }
      } else if (tool === 'smudge') {
        const sxp = Math.round(xx - (lx - dw / 2)),
          syp = Math.round(yy - (ly - dw / 2));
        if (sxp < 0 || syp < 0 || sxp >= dw || syp >= dw) continue;
        const j = (syp * dw + sxp) * 4;
        const k = Math.min(1, w * (0.4 + strength));
        for (let c = 0; c < 4; c++) {
          const cur = p[i + c];
          const nv = cur + (d.smudge![j + c] - cur) * k;
          p[i + c] = nv;
          d.smudge![j + c] = d.smudge![j + c] * (0.5 + strength * 0.5) + cur * (0.5 - strength * 0.5);
        }
      }
    }
  ctx2d(l.canvas).putImageData(img, 0, 0, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
}

function endPaint(e: Engine, d: Paint) {
  if (d.kind === 'buffer' || d.kind === 'clone') {
    if (e.endLive()) e.commit(d.kind === 'clone' ? 'Clone stamp' : e.tool === 'eraser' ? 'Eraser' : e.tool === 'pencil' ? 'Pencil' : 'Brush');
    return;
  }
  if (d.kind === 'mask') {
    e.commit(e.tool === 'eraser' ? 'Erase on mask' : 'Paint on mask');
    return;
  }
  if (d.kind === 'pixels') {
    const names: Record<string, string> = { dodge: 'Dodge', burn: 'Burn', blur: 'Blur tool', sharpen: 'Sharpen tool', smudge: 'Smudge' };
    e.commit(names[e.tool] || 'Paint');
    return;
  }
  if (d.kind === 'heal') {
    const live = e.live;
    e.live = null;
    if (!live?.bounds) return e.invalidate();
    heal(e, d.layer!, live.buffer, live.bounds);
  }
}

function heal(e: Engine, l: RasterLayer, buffer: HTMLCanvasElement, b: Rect) {
  const bw = Math.ceil(b.w),
    bh = Math.ceil(b.h);
  const pad = Math.max(bw, bh) + 12;
  // Region in layer coordinates, padded so the patch search has room.
  const rx = Math.max(0, Math.floor(b.x - l.x) - pad),
    ry = Math.max(0, Math.floor(b.y - l.y) - pad);
  const rw = Math.min(l.canvas.width, Math.ceil(b.x - l.x + b.w) + pad) - rx,
    rh = Math.min(l.canvas.height, Math.ceil(b.y - l.y + b.h) + pad) - ry;
  if (rw <= 2 || rh <= 2) return;
  const c = cloneCanvas(l.canvas);
  const g = ctx2d(c);
  const img = g.getImageData(rx, ry, rw, rh);
  const mc = borrow(rw, rh);
  mc.getContext('2d')!.drawImage(buffer, -(rx + l.x), -(ry + l.y));
  const md = getPixels(mc).data;
  release(mc);
  const sel = S.weights(e.selection, { x: rx + l.x, y: ry + l.y, w: rw, h: rh });
  const mask = new Uint8Array(rw * rh);
  for (let i = 0; i < mask.length; i++) mask[i] = sel ? (md[i * 4 + 3] * sel[i]) / 255 : md[i * 4 + 3];
  healRegion(img.data, mask, rw, rh);
  g.putImageData(img, rx, ry);
  l.canvas = c;
  e.commit('Spot healing');
}

// ---------- Gradient ----------
const PRESETS: Record<string, string[]> = {
  'black-white': ['#000000', '#ffffff'],
  rainbow: ['#ff0000', '#ff9900', '#ffff00', '#00cc44', '#0099ff', '#6633ff', '#cc00cc'],
  sunset: ['#2b1055', '#d53369', '#f3a953', '#fff1c1'],
  chrome: ['#2b2b2b', '#e8e8e8', '#5a5a5a', '#ffffff', '#3a3a3a']
};

function gradientStops(e: Engine): { pos: number; color: string }[] {
  const o = e.opts.gradient;
  let cols: string[];
  if (o.preset === 'fg-bg') cols = [e.fg, e.bg];
  else if (o.preset === 'fg-transparent') {
    const { r, g, b } = hexToRgb(e.fg);
    cols = [e.fg, `rgba(${r},${g},${b},0)`];
  } else cols = PRESETS[o.preset];
  if (o.reverse) cols = [...cols].reverse();
  return cols.map((c, i) => ({ pos: i / (cols.length - 1), color: c }));
}

export function drawGradient(e: Engine, a: Pt, b: Pt) {
  const o = e.opts.gradient;
  const t = ops.paintSurface(e);
  if (!t.mask) e.growToDoc(t.layer as RasterLayer);
  const paint = makeCanvas(e.doc.w, e.doc.h);
  const pg = paint.getContext('2d')!;
  const grad = o.type === 'radial' ? pg.createRadialGradient(a.x, a.y, 0, a.x, a.y, Math.max(1, Math.hypot(b.x - a.x, b.y - a.y))) : pg.createLinearGradient(a.x, a.y, b.x, b.y);
  for (const s of gradientStops(e)) grad.addColorStop(s.pos, t.mask && !s.color.startsWith('rgba') ? grayOf(s.color) : s.color);
  pg.fillStyle = grad;
  pg.fillRect(0, 0, paint.width, paint.height);
  if (e.selection) {
    pg.globalCompositeOperation = 'destination-in';
    pg.drawImage(e.selection.canvas, 0, 0);
  }
  const src = t.mask ? t.mask.canvas : (t.layer as RasterLayer).canvas;
  const c = cloneCanvas(src);
  const g = c.getContext('2d')!;
  g.globalAlpha = o.opacity;
  g.drawImage(paint, -t.x, -t.y);
  if (t.mask) t.mask.canvas = c;
  else (t.layer as RasterLayer).canvas = c;
  e.commit('Gradient');
}

// ---------- Selection tools ----------
function selMode(e: Engine, p: PtrInfo): S.SelMode {
  if (p.shift && p.alt) return 'intersect';
  if (p.shift) return 'add';
  if (p.alt) return 'subtract';
  return e.opts.selMode;
}

/** Marquee rectangle from the drag: Shift keeps it square, Alt draws from the centre, plus the fixed ratio option. */
function marqueeRect(e: Engine, a: Pt, b: Pt, square: boolean, center: boolean): Rect {
  let dx = b.x - a.x,
    dy = b.y - a.y;
  const ratio = parseRatio(e.opts.ratio);
  if (square || ratio) {
    const k = ratio || 1;
    const m = Math.max(Math.abs(dx), Math.abs(dy) * k);
    dx = Math.sign(dx || 1) * m;
    dy = (Math.sign(dy || 1) * m) / k;
  }
  if (center) return { x: a.x - Math.abs(dx), y: a.y - Math.abs(dy), w: Math.abs(dx) * 2, h: Math.abs(dy) * 2 };
  return rectOf(a, { x: a.x + dx, y: a.y + dy });
}
export function parseRatio(s: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*[:x×/]\s*(\d+(?:\.\d+)?)\s*$/.exec(s || '');
  if (!m) return null;
  const r = parseFloat(m[1]) / parseFloat(m[2]);
  return r > 0 && isFinite(r) ? r : null;
}

function commitShapeSelection(e: Engine, shape: HTMLCanvasElement, mode: S.SelMode, label: string) {
  let sel = S.combine(e.selection, shape, mode);
  if (sel && e.opts.feather > 0) {
    // Feather only the new shape's edge, like Photoshop's tool option.
    const feathered = S.feather({ canvas: shape, bounds: { x: 0, y: 0, w: shape.width, h: shape.height } }, e.opts.feather);
    sel = feathered ? S.combine(e.selection, feathered.canvas, mode) : sel;
  }
  e.setSelection(sel, label);
}

// ---------- Transform & crop handles ----------
type Handle = { kind: 'move' } | { kind: 'rotate' } | { kind: 'scale'; ux: number; uy: number };

/** Which part of the transform box is under the screen point. */
export function transformHit(e: Engine, t: TransformState, sx: number, sy: number): Handle | null {
  const cs = transformCorners(t).map((p) => e.toScreen(p));
  const mids = cs.map((p, i) => ({ x: (p.x + cs[(i + 1) % 4].x) / 2, y: (p.y + cs[(i + 1) % 4].y) / 2 }));
  const cornerU = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1]
  ];
  const midU = [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0]
  ];
  for (let i = 0; i < 4; i++) if (Math.hypot(cs[i].x - sx, cs[i].y - sy) < 9) return { kind: 'scale', ux: cornerU[i][0], uy: cornerU[i][1] };
  for (let i = 0; i < 4; i++) if (Math.hypot(mids[i].x - sx, mids[i].y - sy) < 9) return { kind: 'scale', ux: midU[i][0], uy: midU[i][1] };
  if (pointInPoly({ x: sx, y: sy }, cs)) return { kind: 'move' };
  for (let i = 0; i < 4; i++) if (Math.hypot(cs[i].x - sx, cs[i].y - sy) < 28) return { kind: 'rotate' };
  return null;
}
function pointInPoly(p: Pt, poly: Pt[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i],
      b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function cropHit(e: Engine, r: Rect, sx: number, sy: number): Handle | null {
  const a = e.toScreen({ x: r.x, y: r.y }),
    b = e.toScreen({ x: r.x + r.w, y: r.y + r.h });
  const xs = [a.x, (a.x + b.x) / 2, b.x],
    ys = [a.y, (a.y + b.y) / 2, b.y];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      if (i === 1 && j === 1) continue;
      if (Math.abs(xs[i] - sx) < 9 && Math.abs(ys[j] - sy) < 9) return { kind: 'scale', ux: i - 1, uy: j - 1 };
    }
  if (sx > a.x && sx < b.x && sy > a.y && sy < b.y) return { kind: 'move' };
  return null;
}

export function cursorFor(e: Engine, sx: number, sy: number): string {
  const resize = (h: Handle | null, angle = 0) => {
    if (!h) return null;
    if (h.kind === 'move') return 'move';
    if (h.kind === 'rotate') return 'alias';
    const a = ((Math.atan2(h.uy, h.ux) + angle) * 180) / Math.PI;
    const n = ((Math.round(a / 45) % 4) + 4) % 4;
    return ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][n];
  };
  if (e.transform && !e.transform.moveOnly) return resize(transformHit(e, e.transform, sx, sy), e.transform.angle) || 'default';
  if (e.tool === 'crop' && e.crop) return resize(cropHit(e, e.crop, sx, sy)) || 'crosshair';
  switch (e.tool) {
    case 'move':
      return 'move';
    case 'hand':
      return drag ? 'grabbing' : 'grab';
    case 'zoom':
      return 'zoom-in';
    case 'text':
      return 'text';
    case 'eyedropper':
      return 'copy';
    case 'brush':
    case 'pencil':
    case 'eraser':
    case 'clone':
    case 'heal':
    case 'dodge':
    case 'burn':
    case 'blur':
    case 'sharpen':
    case 'smudge':
      return 'none';
  }
  return 'crosshair';
}

// ---------- Text ----------
function textAt(e: Engine, p: Pt): Layer | null {
  for (const { layer } of e.flat()) if (layer.kind === 'text' && layer.visible && !layer.locked) {
    const b = textBox(layer.text);
    const pad = layer.text.size * 0.2;
    if (p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad) return layer;
  }
  return null;
}

export function startText(e: Engine, p: Pt) {
  const hit = textAt(e, p);
  if (hit && hit.kind === 'text') {
    e.state.activeId = hit.id;
    textSession = { id: hit.id, orig: { ...hit.text } };
  } else {
    const o = e.opts.text;
    const t: TextData = { text: '', font: o.font, size: o.size, color: e.fg, bold: o.bold, italic: o.italic, align: o.align, leading: o.leading, x: Math.round(p.x), y: Math.round(p.y - o.size * 0.6) };
    const l = ops.addTextLayer(e, t, 'Text');
    textSession = { id: l.id, orig: null };
  }
  e.textEditing = textSession.id;
  e.invalidate();
  e.emit();
}

/** Finish typing: keep it as one undo step, or drop an empty new layer. */
export function endText(e: Engine, cancel = false) {
  const s = textSession;
  textSession = null;
  e.textEditing = null;
  if (!s) return;
  const f = e.find(s.id);
  if (!f || f.layer.kind !== 'text') return e.emit();
  const l = f.layer;
  if (cancel && s.orig) {
    l.text = s.orig;
    renderText(l);
    e.invalidate();
  }
  if ((cancel && !s.orig) || !l.text.text.trim()) {
    f.list.splice(f.index, 1);
    if (s.orig) e.commit('Delete layer');
    else {
      e.state.activeId = f.list[Math.min(f.index, f.list.length - 1)]?.id || f.parent?.id || null;
      e.invalidate();
      e.emit();
    }
    return;
  }
  if (cancel) return e.emit();
  l.name = s.orig && l.name !== s.orig.text.split('\n')[0].slice(0, 30) ? l.name : l.text.text.split('\n')[0].slice(0, 30) || 'Text';
  e.commit(s.orig ? 'Edit text' : 'New text');
}

// ---------- Pointer events ----------
export function pointerDown(e: Engine, p: PtrInfo) {
  try {
    down(e, p);
  } catch (err) {
    drag = null;
    e.live = null;
    e.overlay = null;
    e.invalidate();
    fail(err);
  }
}

function down(e: Engine, p: PtrInfo) {
  if (e.textEditing) {
    endText(e);
    // With the Text tool, clicking away just finishes the text (like Photoshop).
    if (e.tool === 'text') return;
  }
  const start = (tool: Drag['tool'], data: any = null) => (drag = { tool, start: p, last: p, moved: false, data });

  // Middle button, or space held: pan.
  if (p.button === 1) return void start('pan', { panX: e.view.panX, panY: e.view.panY });

  if (e.transform && !e.transform.moveOnly) {
    const h = transformHit(e, e.transform, p.sx, p.sy);
    if (!h) {
      ops.commitTransform(e);
      return;
    }
    return void start('transform', { h, t0: { ...e.transform } });
  }

  const tool = e.tool;
  switch (tool) {
    case 'hand':
      return void start('pan', { panX: e.view.panX, panY: e.view.panY });
    case 'zoom':
      e.zoomStep(p.alt ? -1 : 1, p.sx, p.sy);
      return;
    case 'eyedropper': {
      start(tool);
      return sample(e, p);
    }
    case 'move': {
      const auto = e.opts.move.autoSelect !== p.ctrl;
      if (auto) {
        const hit = layerAt(e, p);
        if (hit) e.setActive(hit.id);
      }
      const l = e.active;
      if (!l) return;
      if (l.locked) throw new Error(`"${l.name}" is locked`);
      if (e.selection && isPixelLayer(l)) {
        ops.beginTransform(e, true);
        return void start(tool, { mode: 'float', cx: e.transform!.cx, cy: e.transform!.cy });
      }
      return void start(tool, { mode: 'layer', dx: 0, dy: 0 });
    }
    case 'marquee-rect':
    case 'marquee-ellipse':
      start(tool, { mode: selMode(e, p) });
      e.overlay = { kind: tool === 'marquee-rect' ? 'rect' : 'ellipse', pts: [p, p] };
      return;
    case 'lasso':
      start(tool, { mode: selMode(e, p) });
      e.overlay = { kind: 'lasso', pts: [{ x: p.x, y: p.y }] };
      return;
    case 'lasso-poly': {
      const ov = e.overlay;
      if (!ov || ov.kind !== 'poly') {
        e.overlay = { kind: 'poly', pts: [{ x: p.x, y: p.y }, { x: p.x, y: p.y }] };
        polyMode = selMode(e, p);
        e.requestFrame();
        return;
      }
      const first = e.toScreen(ov.pts[0]);
      if (p.dbl || (ov.pts.length > 3 && Math.hypot(first.x - p.sx, first.y - p.sy) < 10)) return finishPoly(e);
      ov.pts.splice(ov.pts.length - 1, 0, { x: p.x, y: p.y });
      e.requestFrame();
      return;
    }
    case 'wand': {
      const px = ops.samplePixels(e, e.opts.sampleAll);
      let shape = S.wandMask(px, p.x, p.y, e.opts.wandTolerance, e.opts.wandContiguous);
      if (e.opts.antialias) shape = S.softenEdges(shape);
      commitShapeSelection(e, shape, selMode(e, p), 'Magic wand');
      return;
    }
    case 'quick': {
      const mode = p.alt ? 'subtract' : e.selection && e.opts.selMode !== 'new' ? e.opts.selMode : e.selection ? 'add' : 'new';
      start(tool, { mode, px: ops.samplePixels(e, e.opts.sampleAll), sel: mode === 'new' ? null : e.selection, last: null });
      quickDab(e, p);
      return;
    }
    case 'crop': {
      // The first drag draws a new box; later drags move or resize it.
      const fresh = !e.crop;
      if (!e.crop) e.crop = { x: 0, y: 0, w: e.doc.w, h: e.doc.h };
      if (p.dbl && cropHit(e, e.crop, p.sx, p.sy)?.kind === 'move') {
        ops.cropTo(e, e.crop);
        return;
      }
      const h = fresh ? null : cropHit(e, e.crop, p.sx, p.sy);
      start('crop', { h: h || { kind: 'new' }, r0: { ...e.crop } });
      e.emit();
      return;
    }
    case 'bucket':
      ops.bucketFill(e, p.x, p.y, e.fg);
      return;
    case 'gradient':
      ops.paintSurface(e);
      start(tool);
      e.overlay = { kind: 'line', pts: [p, p] };
      return;
    case 'text':
      startText(e, p);
      return;
    case 'shape':
      start(tool);
      e.overlay = { kind: 'shape', pts: [p, p] };
      return;
  }
  // Painting tools.
  const d = startPaint(e, p);
  if (!d) return;
  start(tool, d);
  // Shift-click: straight line from the last stroke's end.
  if (p.shift && lastPaintEnd) {
    d.sm = { ...lastPaintEnd };
    d.last = { ...lastPaintEnd, p: p.pressure };
    paintTo(e, d, p, true);
  } else {
    dab(e, d, p.x, p.y, Math.max(1, d.o.size * (d.o.pressureSize ? Math.max(0.05, p.pressure) : 1)), p.pressure);
    const r = d.o.size / 2 + 4;
    e.invalidate({ x: p.x - r, y: p.y - r, w: r * 2, h: r * 2 });
  }
}

let polyMode: S.SelMode = 'new';
let lastPaintEnd: Pt | null = null;

function finishPoly(e: Engine) {
  const ov = e.overlay;
  e.overlay = null;
  if (!ov || ov.pts.length < 4) return e.requestFrame();
  commitShapeSelection(e, S.polyMask(e.doc.w, e.doc.h, ov.pts.slice(0, -1)), polyMode, 'Polygonal lasso');
}

function sample(e: Engine, p: PtrInfo) {
  const c = ops.pickColor(e, p.x, p.y, e.opts.eyedropper.size, e.opts.eyedropper.sampleAll);
  if (!c) return;
  if (p.alt) e.bg = c;
  else e.fg = c;
  e.emit();
}

/** Topmost visible pixel layer with a visible pixel under the point. */
function layerAt(e: Engine, p: Pt): Layer | null {
  for (const { layer, hiddenByParent } of e.flat()) {
    if (!layer.visible || hiddenByParent || !isPixelLayer(layer)) continue;
    const x = Math.floor(p.x - layer.x),
      y = Math.floor(p.y - layer.y);
    if (x < 0 || y < 0 || x >= layer.canvas.width || y >= layer.canvas.height) continue;
    if (ctx2d(layer.canvas).getImageData(x, y, 1, 1).data[3] > 10) return layer;
  }
  return null;
}

function quickDab(e: Engine, p: PtrInfo) {
  const d = drag!.data;
  const r = e.opts.quickSize;
  const region = S.wandMask(d.px, p.x, p.y, e.opts.wandTolerance, true, { x: p.x - r * 2, y: p.y - r * 2, w: r * 4, h: r * 4 });
  // Always include the brush footprint itself.
  const g = region.getContext('2d')!;
  g.fillStyle = '#fff';
  g.beginPath();
  g.arc(p.x, p.y, r / 3, 0, Math.PI * 2);
  g.fill();
  const next = S.combine(e.selection, region, d.mode === 'subtract' ? 'subtract' : e.selection ? 'add' : 'new');
  e.state.selection = next;
  if (d.mode === 'new') d.mode = 'add';
  e.requestFrame();
}

export function pointerMove(e: Engine, p: PtrInfo) {
  if (!drag) {
    if (e.overlay?.kind === 'poly') {
      e.overlay.pts[e.overlay.pts.length - 1] = { x: p.x, y: p.y };
      e.requestFrame();
    }
    return;
  }
  try {
    move(e, p);
  } catch (err) {
    fail(err);
  }
}

function move(e: Engine, p: PtrInfo) {
  const d = drag!;
  if (Math.hypot(p.sx - d.start.sx, p.sy - d.start.sy) > 2) d.moved = true;
  d.last = p;
  switch (d.tool) {
    case 'pan':
      e.view = { ...e.view, panX: d.data.panX + p.sx - d.start.sx, panY: d.data.panY + p.sy - d.start.sy, fit: false };
      e.requestFrame();
      return;
    case 'transform':
      return dragTransform(e, d, p);
    case 'crop':
      return dragCrop(e, d, p);
    case 'eyedropper':
      return sample(e, p);
    case 'move': {
      if (d.data.mode === 'float') {
        let dx = p.x - d.start.x,
          dy = p.y - d.start.y;
        if (p.shift) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
        const before = transformedBounds(e.transform!);
        e.transform!.cx = d.data.cx + Math.round(dx);
        e.transform!.cy = d.data.cy + Math.round(dy);
        return e.invalidate(union(before, transformedBounds(e.transform!)));
      }
      let tx = Math.round(p.x - d.start.x),
        ty = Math.round(p.y - d.start.y);
      if (p.shift) Math.abs(tx) > Math.abs(ty) ? (ty = 0) : (tx = 0);
      const l = e.active;
      if (!l) return;
      const before = isPixelLayer(l) && !l.mask ? ops.layerRect(l) : null;
      ops.offsetLayer(l, tx - d.data.dx, ty - d.data.dy);
      d.data.dx = tx;
      d.data.dy = ty;
      // Redraw just where the layer was and where it is now.
      return e.invalidate(before && isPixelLayer(l) ? union(before, ops.layerRect(l)) : undefined);
    }
    case 'marquee-rect':
    case 'marquee-ellipse': {
      const r = marqueeRect(e, d.start, p, p.shift && !d.start.shift, p.alt && !d.start.alt);
      e.overlay = { kind: d.tool === 'marquee-rect' ? 'rect' : 'ellipse', pts: [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y + r.h }] };
      return e.requestFrame();
    }
    case 'lasso':
      e.overlay?.pts.push({ x: p.x, y: p.y });
      return e.requestFrame();
    case 'quick': {
      const last = d.data.last || d.start;
      if (Math.hypot(p.x - last.x, p.y - last.y) >= e.opts.quickSize / 2) {
        d.data.last = p;
        quickDab(e, p);
      }
      return;
    }
    case 'gradient':
    case 'shape': {
      let b: Pt = { x: p.x, y: p.y };
      const a = d.start;
      if (p.shift) {
        if (d.tool === 'gradient' || e.opts.shape.type === 'line') {
          const ang = Math.round(Math.atan2(b.y - a.y, b.x - a.x) / (Math.PI / 4)) * (Math.PI / 4);
          const len = Math.hypot(b.x - a.x, b.y - a.y);
          b = { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len };
        } else {
          const m = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
          b = { x: a.x + Math.sign(b.x - a.x || 1) * m, y: a.y + Math.sign(b.y - a.y || 1) * m };
        }
      }
      let a2: Pt = a;
      if (p.alt && d.tool === 'shape' && e.opts.shape.type !== 'line') a2 = { x: a.x - (b.x - a.x), y: a.y - (b.y - a.y) };
      e.overlay = { kind: d.tool === 'gradient' ? 'line' : 'shape', pts: [a2, b] };
      return e.requestFrame();
    }
  }
  if (d.data && typeof d.data === 'object' && 'kind' in d.data) {
    // Coalesced events give smoother strokes with a pen.
    paintTo(e, d.data as Paint, p);
  }
}

export function pointerUp(e: Engine, p: PtrInfo) {
  const d = drag;
  drag = null;
  if (!d) return;
  try {
    up(e, d, p);
  } catch (err) {
    e.live = null;
    e.overlay = null;
    e.invalidate();
    fail(err);
  }
}

function up(e: Engine, d: Drag, p: PtrInfo) {
  switch (d.tool) {
    case 'pan':
    case 'eyedropper':
      e.emit();
      return;
    case 'transform':
      e.emit();
      return;
    case 'crop':
      // A click without a drag (or a tiny box) shows the whole picture to adjust from.
      if (e.crop && (!d.moved || e.crop.w < 2 || e.crop.h < 2)) e.crop = d.data.h.kind === 'new' ? { x: 0, y: 0, w: e.doc.w, h: e.doc.h } : d.data.r0;
      e.emit();
      return;
    case 'move':
      if (d.data.mode === 'float') {
        if (d.moved) ops.commitTransform(e);
        else e.cancelTransform();
        return;
      }
      if (d.data.dx || d.data.dy) e.commit('Move');
      return;
    case 'marquee-rect':
    case 'marquee-ellipse': {
      const ov = e.overlay;
      e.overlay = null;
      if (!d.moved || !ov) {
        // A click without dragging drops the selection.
        if (d.data.mode === 'new' && e.selection) ops.deselect(e);
        else e.requestFrame();
        return;
      }
      const r = rectOf(ov.pts[0], ov.pts[1]);
      const shape = d.tool === 'marquee-rect' ? S.rectMask(e.doc.w, e.doc.h, r) : S.ellipseMask(e.doc.w, e.doc.h, r);
      commitShapeSelection(e, shape, d.data.mode, d.tool === 'marquee-rect' ? 'Rectangular marquee' : 'Elliptical marquee');
      return;
    }
    case 'lasso': {
      const ov = e.overlay;
      e.overlay = null;
      if (!ov || ov.pts.length < 3) {
        if (d.data.mode === 'new' && e.selection) ops.deselect(e);
        else e.requestFrame();
        return;
      }
      commitShapeSelection(e, S.polyMask(e.doc.w, e.doc.h, ov.pts), d.data.mode, 'Lasso');
      return;
    }
    case 'quick':
      e.commit('Quick selection');
      return;
    case 'gradient': {
      const ov = e.overlay;
      e.overlay = null;
      if (!ov || !d.moved) return e.requestFrame();
      drawGradient(e, ov.pts[0], ov.pts[1]);
      return;
    }
    case 'shape': {
      const ov = e.overlay;
      e.overlay = null;
      if (!ov || !d.moved) return e.requestFrame();
      const o = e.opts.shape;
      const [a, b] = ov.pts;
      const s: ShapeData = { type: o.type, x1: a.x, y1: a.y, x2: b.x, y2: b.y, sides: o.sides, radius: o.radius, fill: o.fillOn ? e.fg : null, stroke: o.strokeOn || o.type === 'line' ? (o.type === 'line' && !o.strokeOn ? e.fg : o.stroke) : null, strokeWidth: o.strokeWidth };
      ops.addShapeLayer(e, s);
      e.commit('New shape');
      return;
    }
  }
  if (d.data && typeof d.data === 'object' && 'kind' in d.data) {
    const pd = d.data as Paint;
    paintTo(e, pd, p, true);
    lastPaintEnd = { x: p.x, y: p.y };
    endPaint(e, pd);
  }
}

function dragTransform(e: Engine, d: Drag, p: PtrInfo) {
  const t = e.transform!;
  const t0: TransformState = d.data.t0;
  const h: Handle = d.data.h;
  const before = transformedBounds(t);
  if (h.kind === 'move') {
    t.cx = t0.cx + p.x - d.start.x;
    t.cy = t0.cy + p.y - d.start.y;
  } else if (h.kind === 'rotate') {
    const a0 = Math.atan2(d.start.y - t0.cy, d.start.x - t0.cx);
    const a1 = Math.atan2(p.y - t0.cy, p.x - t0.cx);
    let a = t0.angle + a1 - a0;
    if (p.shift) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12);
    t.angle = a;
  } else {
    const cos = Math.cos(t0.angle),
      sin = Math.sin(t0.angle);
    // Work in the box's own (unrotated) frame, centred on its starting centre.
    const lx = (p.x - t0.cx) * cos + (p.y - t0.cy) * sin;
    const ly = -(p.x - t0.cx) * sin + (p.y - t0.cy) * cos;
    const hw = (t0.float.width * t0.sx) / 2,
      hh = (t0.float.height * t0.sy) / 2;
    const ax = -h.ux * hw,
      ay = -h.uy * hh;
    let w = h.ux ? (lx - ax) * h.ux : hw * 2;
    let hgt = h.uy ? (ly - ay) * h.uy : hh * 2;
    if (Math.abs(w) < 1) w = w < 0 ? -1 : 1;
    if (Math.abs(hgt) < 1) hgt = hgt < 0 ? -1 : 1;
    let nsx = (w / (hw * 2)) * t0.sx,
      nsy = (hgt / (hh * 2)) * t0.sy;
    if (p.shift && h.ux && h.uy) {
      const k = Math.max(Math.abs(nsx / t0.sx), Math.abs(nsy / t0.sy));
      nsx = Math.sign(nsx) * Math.abs(t0.sx) * k;
      nsy = Math.sign(nsy) * Math.abs(t0.sy) * k;
      w = (nsx / t0.sx) * hw * 2;
      hgt = (nsy / t0.sy) * hh * 2;
    }
    const ncx = h.ux ? ax + (h.ux * w) / 2 : 0;
    const ncy = h.uy ? ay + (h.uy * hgt) / 2 : 0;
    t.sx = nsx;
    t.sy = nsy;
    t.cx = t0.cx + ncx * cos - ncy * sin;
    t.cy = t0.cy + ncx * sin + ncy * cos;
  }
  e.invalidate(union(before, transformedBounds(t)));
  e.emit();
}

function dragCrop(e: Engine, d: Drag, p: PtrInfo) {
  const r0: Rect = d.data.r0;
  const h = d.data.h;
  const ratio = parseRatio(e.opts.ratio);
  let r: Rect;
  if (h.kind === 'new') r = marqueeRect(e, d.start, p, p.shift, p.alt);
  else if (h.kind === 'move') r = { ...r0, x: Math.round(r0.x + p.x - d.start.x), y: Math.round(r0.y + p.y - d.start.y) };
  else {
    let x0 = r0.x,
      y0 = r0.y,
      x1 = r0.x + r0.w,
      y1 = r0.y + r0.h;
    if (h.ux < 0) x0 = p.x;
    if (h.ux > 0) x1 = p.x;
    if (h.uy < 0) y0 = p.y;
    if (h.uy > 0) y1 = p.y;
    r = rectOf({ x: x0, y: y0 }, { x: x1, y: y1 });
    const keep = ratio || (p.shift ? r0.w / Math.max(1, r0.h) : null);
    if (keep && h.ux && h.uy) {
      r.h = r.w / keep;
      if (h.uy < 0) r.y = y1 - r.h;
    }
  }
  e.crop = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) };
  e.requestFrame();
}

/** Enter / Escape / Backspace for tools that are mid-way through something. Returns true if handled. */
export function toolKey(e: Engine, k: KeyboardEvent): boolean {
  const key = k.key;
  if (e.transform && !e.transform.moveOnly) {
    if (key === 'Enter') return (ops.commitTransform(e), true);
    if (key === 'Escape') return (e.cancelTransform(), true);
  }
  if (e.crop && e.tool === 'crop') {
    if (key === 'Enter') return (ops.cropTo(e, e.crop), true);
    if (key === 'Escape') {
      e.crop = null;
      e.requestFrame();
      e.emit();
      return true;
    }
  }
  if (e.overlay?.kind === 'poly') {
    if (key === 'Enter') return (finishPoly(e), true);
    if (key === 'Escape') {
      e.overlay = null;
      e.requestFrame();
      return true;
    }
    if (key === 'Backspace' || key === 'Delete') {
      if (e.overlay.pts.length > 2) e.overlay.pts.splice(e.overlay.pts.length - 2, 1);
      else e.overlay = null;
      e.requestFrame();
      return true;
    }
  }
  return false;
}

export function brushSizeOf(e: Engine): number | null {
  const k = brushKey(e.tool);
  if (k) return e.opts[k].size;
  if (e.tool === 'quick') return e.opts.quickSize;
  return null;
}
export function setBrushSize(e: Engine, size: number) {
  const k = brushKey(e.tool);
  size = Math.max(1, Math.min(2500, Math.round(size)));
  if (k) e.opts[k] = { ...e.opts[k], size } as any;
  else if (e.tool === 'quick') e.opts.quickSize = size;
  e.requestFrame();
  e.emit();
}

