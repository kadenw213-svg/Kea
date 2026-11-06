import type { ShapeData, TextData, TextLayer, ShapeLayer, Rect } from './types';
import { makeCanvas } from './canvas';

/** Text and shape layers: rebuilt into pixels from their settings whenever those change. */

export const FONTS = ['Inter', 'Arial', 'Helvetica', 'Segoe UI', 'Georgia', 'Times New Roman', 'Courier New', 'Verdana', 'Trebuchet MS', 'Impact', 'Comic Sans MS', 'Consolas', 'Tahoma', 'Garamond', 'Palatino Linotype'];

export function cssFont(t: Pick<TextData, 'font' | 'size' | 'bold' | 'italic'>, scale = 1) {
  return `${t.italic ? 'italic ' : ''}${t.bold ? '700 ' : '400 '}${t.size * scale}px "${t.font}", sans-serif`;
}

let measureCtx: CanvasRenderingContext2D | null = null;
/** Box the text occupies in document pixels. */
export function textBox(t: TextData): Rect {
  measureCtx ||= makeCanvas(1, 1).getContext('2d')!;
  measureCtx.font = cssFont(t);
  const lines = t.text.split('\n');
  const w = Math.max(1, ...lines.map((l) => measureCtx!.measureText(l).width));
  const h = Math.max(1, lines.length) * t.size * t.leading;
  const x = t.align === 'center' ? t.x - w / 2 : t.align === 'right' ? t.x - w : t.x;
  return { x, y: t.y, w, h };
}

export function renderText(layer: TextLayer) {
  const t = layer.text;
  const box = textBox(t);
  const pad = Math.ceil(t.size * 0.35) + 2;
  const c = makeCanvas(box.w + pad * 2, box.h + pad * 2);
  const g = c.getContext('2d')!;
  g.font = cssFont(t);
  g.fillStyle = t.color;
  g.textBaseline = 'middle';
  g.textAlign = t.align;
  const lh = t.size * t.leading;
  const ax = t.align === 'center' ? pad + box.w / 2 : t.align === 'right' ? pad + box.w : pad;
  t.text.split('\n').forEach((line, i) => g.fillText(line, ax, pad + i * lh + lh / 2));
  layer.canvas = c;
  layer.x = Math.round(box.x) - pad;
  layer.y = Math.round(box.y) - pad;
  // Keep the text exactly where the box says even after rounding the canvas position.
  if (box.x - Math.round(box.x) !== 0) {
    const shifted = makeCanvas(c.width, c.height);
    shifted.getContext('2d')!.drawImage(c, box.x - Math.round(box.x), 0);
    layer.canvas = shifted;
  }
}

export function shapeBounds(s: ShapeData): Rect {
  return { x: Math.min(s.x1, s.x2), y: Math.min(s.y1, s.y2), w: Math.abs(s.x2 - s.x1), h: Math.abs(s.y2 - s.y1) };
}

/** Trace the shape's outline into `g` (document coordinates shifted by -ox, -oy). */
export function traceShape(g: CanvasRenderingContext2D | Path2D, s: ShapeData, ox = 0, oy = 0) {
  const b = shapeBounds(s);
  const x = b.x - ox,
    y = b.y - oy;
  if (s.type === 'rect') {
    const r = Math.min(s.radius, b.w / 2, b.h / 2);
    if (r > 0) (g as any).roundRect(x, y, b.w, b.h, r);
    else g.rect(x, y, b.w, b.h);
  } else if (s.type === 'ellipse') {
    g.ellipse(x + b.w / 2, y + b.h / 2, Math.max(0.5, b.w / 2), Math.max(0.5, b.h / 2), 0, 0, Math.PI * 2);
  } else if (s.type === 'polygon') {
    const n = Math.max(3, Math.round(s.sides));
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (i * Math.PI * 2) / n;
      const px = x + b.w / 2 + (Math.cos(a) * b.w) / 2,
        py = y + b.h / 2 + (Math.sin(a) * b.h) / 2;
      if (i) g.lineTo(px, py);
      else g.moveTo(px, py);
    }
    g.closePath();
  } else {
    g.moveTo(s.x1 - ox, s.y1 - oy);
    g.lineTo(s.x2 - ox, s.y2 - oy);
  }
}

export function renderShape(layer: ShapeLayer) {
  const s = layer.shape;
  const b = shapeBounds(s);
  const pad = Math.ceil((s.stroke || s.type === 'line' ? s.strokeWidth : 0) / 2) + 2;
  const x0 = Math.floor(b.x) - pad,
    y0 = Math.floor(b.y) - pad;
  const c = makeCanvas(Math.ceil(b.w) + pad * 2 + 1, Math.ceil(b.h) + pad * 2 + 1);
  const g = c.getContext('2d')!;
  g.beginPath();
  traceShape(g, s, x0, y0);
  if (s.type === 'line') {
    g.lineCap = 'round';
    g.lineWidth = Math.max(1, s.strokeWidth);
    g.strokeStyle = s.stroke || s.fill || '#000';
    g.stroke();
  } else {
    if (s.fill) {
      g.fillStyle = s.fill;
      g.fill();
    }
    if (s.stroke && s.strokeWidth > 0) {
      g.lineJoin = 'round';
      g.lineWidth = s.strokeWidth;
      g.strokeStyle = s.stroke;
      g.stroke();
    }
  }
  layer.canvas = c;
  layer.x = x0;
  layer.y = y0;
}
