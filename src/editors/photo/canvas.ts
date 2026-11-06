import type { Rect, Pt } from './types';

/** Small canvas, colour and geometry helpers shared by the photo editor modules. */

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/**
 * A canvas kept in main memory (willReadFrequently). Used for the composite and scratch
 * canvases: adjustment layers read pixels back every frame, and reading from a GPU canvas
 * stalls for tens of milliseconds while reading a memory canvas costs almost nothing.
 */
export function memCanvas(w: number, h: number): HTMLCanvasElement {
  const c = makeCanvas(w, h);
  c.getContext('2d', { willReadFrequently: true });
  return c;
}

/** 2D context tuned for frequent pixel reads. */
export function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  return c.getContext('2d', { willReadFrequently: true })!;
}

export function cloneCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = makeCanvas(src.width, src.height);
  c.getContext('2d')!.drawImage(src, 0, 0);
  return c;
}

export function filledCanvas(w: number, h: number, color: string): HTMLCanvasElement {
  const c = makeCanvas(w, h);
  const g = c.getContext('2d')!;
  g.fillStyle = color;
  g.fillRect(0, 0, c.width, c.height);
  return c;
}

export function getPixels(c: HTMLCanvasElement, r?: Rect): ImageData {
  const x = r ? r.x : 0;
  const y = r ? r.y : 0;
  return ctx2d(c).getImageData(x, y, r ? r.w : c.width, r ? r.h : c.height);
}

export function putPixels(c: HTMLCanvasElement, d: ImageData, x = 0, y = 0) {
  ctx2d(c).putImageData(d, x, y);
}

/** Canvas from raw RGBA pixels. */
export function canvasFromPixels(d: ImageData): HTMLCanvasElement {
  const c = makeCanvas(d.width, d.height);
  ctx2d(c).putImageData(d, 0, 0);
  return c;
}

// ---------- Temp canvases ----------
const pool: HTMLCanvasElement[] = [];
/** Borrow a cleared scratch canvas of this size; give it back with `release`. */
export function borrow(w: number, h: number): HTMLCanvasElement {
  const i = pool.findIndex((c) => c.width === w && c.height === h);
  const c = i >= 0 ? pool.splice(i, 1)[0] : memCanvas(w, h);
  const g = c.getContext('2d')!;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  g.filter = 'none';
  g.clearRect(0, 0, w, h);
  return c;
}
export function release(c: HTMLCanvasElement) {
  if (pool.length > 12) pool.shift();
  pool.push(c);
}

// ---------- Geometry ----------
export const rectOf = (a: Pt, b: Pt): Rect => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) });
export function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w);
  const btm = Math.min(a.y + a.h, b.y + b.h);
  return r > x && btm > y ? { x, y, w: r - x, h: btm - y } : null;
}
export function union(a: Rect | null, b: Rect): Rect {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}
export const roundRect = (r: Rect): Rect => {
  const x = Math.floor(r.x);
  const y = Math.floor(r.y);
  return { x, y, w: Math.ceil(r.x + r.w) - x, h: Math.ceil(r.y + r.h) - y };
};

/** Bounding box of pixels with alpha above `min`, or null when the canvas is empty. */
export function alphaBounds(c: HTMLCanvasElement, min = 0): Rect | null {
  const { data, width: w, height: h } = getPixels(c);
  let x0 = w,
    y0 = h,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (data[row + x * 4 + 3] > min) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// ---------- Colour ----------
export interface RGB {
  r: number;
  g: number;
  b: number;
}
export function hexToRgb(hex: string): RGB {
  let h = (hex || '#000').replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16) || 0;
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
export const rgbToHex = (r: number, g: number, b: number) => '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
export const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;
/** Gray hex for a colour (used when painting on masks). */
export function grayOf(hex: string): string {
  const { r, g, b } = hexToRgb(hex);
  const v = Math.round(luma(r, g, b));
  return rgbToHex(v, v, v);
}

export async function canvasToBytes(c: HTMLCanvasElement, mime: string, quality = 0.92): Promise<Uint8Array> {
  const blob: Blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Could not encode the image'))), mime, quality));
  return new Uint8Array(await blob.arrayBuffer());
}

/** A copy that fits in `max` pixels on its long side. */
export function downscale(c: HTMLCanvasElement, max: number): HTMLCanvasElement {
  const s = Math.min(1, max / Math.max(c.width, c.height));
  if (s >= 1) return c;
  const out = makeCanvas(c.width * s, c.height * s);
  const g = out.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(c, 0, 0, out.width, out.height);
  return out;
}
