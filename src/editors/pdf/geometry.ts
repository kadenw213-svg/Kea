import type { Annotation, Box } from './types';

export function normBox(x1: number, y1: number, x2: number, y2: number): Box {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

export function annBox(a: Annotation): Box {
  switch (a.type) {
    case 'ink': {
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (let i = 0; i < a.points.length; i += 2) {
        minX = Math.min(minX, a.points[i]);
        maxX = Math.max(maxX, a.points[i]);
        minY = Math.min(minY, a.points[i + 1]);
        maxY = Math.max(maxY, a.points[i + 1]);
      }
      const pad = a.width / 2;
      return { x: minX - pad, y: minY - pad, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad };
    }
    case 'line':
    case 'arrow':
      return normBox(a.x1, a.y1, a.x2, a.y2);
    case 'highlight':
    case 'underline':
    case 'strike': {
      const xs = a.rects.flatMap((r) => [r.x, r.x + r.w]);
      const ys = a.rects.flatMap((r) => [r.y, r.y + r.h]);
      return normBox(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
    }
    case 'note':
      return { x: a.x, y: a.y, w: 22, h: 22 };
    default:
      return { x: a.x, y: a.y, w: a.w, h: a.h };
  }
}

export function translateAnn<T extends Annotation>(a: T, dx: number, dy: number): T {
  switch (a.type) {
    case 'ink':
      return { ...a, points: a.points.map((v, i) => v + (i % 2 ? dy : dx)) };
    case 'line':
    case 'arrow':
      return { ...a, x1: a.x1 + dx, y1: a.y1 + dy, x2: a.x2 + dx, y2: a.y2 + dy };
    case 'highlight':
    case 'underline':
    case 'strike':
      return { ...a, rects: a.rects.map((r) => ({ ...r, x: r.x + dx, y: r.y + dy })) };
    default:
      return { ...a, x: (a as any).x + dx, y: (a as any).y + dy };
  }
}

/** Fit an annotation into a new bounding box (used by resize handles). */
export function resizeAnn<T extends Annotation>(a: T, from: Box, to: Box): T {
  const sx = from.w ? to.w / from.w : 1;
  const sy = from.h ? to.h / from.h : 1;
  const mx = (x: number) => to.x + (x - from.x) * sx;
  const my = (y: number) => to.y + (y - from.y) * sy;
  switch (a.type) {
    case 'ink':
      return { ...a, points: a.points.map((v, i) => (i % 2 ? my(v) : mx(v))) };
    case 'line':
    case 'arrow':
      return { ...a, x1: mx(a.x1), y1: my(a.y1), x2: mx(a.x2), y2: my(a.y2) };
    case 'highlight':
    case 'underline':
    case 'strike':
    case 'note':
      return a;
    default:
      return { ...a, ...to };
  }
}

/** Rotate geometry 90° steps clockwise inside a page of (oldW × oldH) viewport size. */
export function rotateAnn<T extends Annotation>(a: T, steps: number, oldW: number, oldH: number): T {
  let out: any = a;
  let w = oldW,
    h = oldH;
  for (let s = 0; s < ((steps % 4) + 4) % 4; s++) {
    const pt = (x: number, y: number) => [h - y, x];
    const bx = (b: Box): Box => ({ x: h - (b.y + b.h), y: b.x, w: b.h, h: b.w });
    switch (out.type) {
      case 'ink': {
        const p: number[] = [];
        for (let i = 0; i < out.points.length; i += 2) p.push(...pt(out.points[i], out.points[i + 1]));
        out = { ...out, points: p };
        break;
      }
      case 'line':
      case 'arrow': {
        const [x1, y1] = pt(out.x1, out.y1);
        const [x2, y2] = pt(out.x2, out.y2);
        out = { ...out, x1, y1, x2, y2 };
        break;
      }
      case 'highlight':
      case 'underline':
      case 'strike':
        out = { ...out, rects: out.rects.map(bx) };
        break;
      case 'note': {
        const [x, y] = pt(out.x + 11, out.y + 11);
        out = { ...out, x: x - 11, y: y - 11 };
        break;
      }
      case 'text':
      case 'image': {
        // Keep text and images upright: move their centre, keep their size.
        const [cx, cy] = pt(out.x + out.w / 2, out.y + out.h / 2);
        out = { ...out, x: cx - out.w / 2, y: cy - out.h / 2 };
        break;
      }
      default:
        out = { ...out, ...bx(out) };
    }
    [w, h] = [h, w];
  }
  return out;
}

export function hexToRgb01(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16) || 0;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export const FONT_CSS: Record<string, string> = {
  Helvetica: 'Arial, Helvetica, "Liberation Sans", sans-serif',
  Times: '"Times New Roman", Times, "Liberation Serif", serif',
  Courier: '"Courier New", Courier, "Liberation Mono", monospace'
};

/** Baseline offset (in em) of the first line for line-height 1.2, matching the CSS fonts above. */
export const BASELINE_EM: Record<string, number> = {
  Helvetica: 0.9465,
  Times: 0.9375,
  Courier: 0.8665
};

export const LINE_HEIGHT = 1.2;
