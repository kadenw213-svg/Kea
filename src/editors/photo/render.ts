import type { Doc, Layer, Mask, PixelLayer, AdjustLayer, GroupLayer, Adjustment, Rect } from './types';
import { borrow, release, makeCanvas, ctx2d } from './canvas';
import { applyAdjustmentFast } from './adjustments';

/**
 * Compositing: draws the layer tree onto a document-sized canvas using the canvas's
 * own blend modes. Masks, clipping groups and adjustment layers need scratch canvases;
 * plain layers are drawn straight onto the backdrop.
 */

export interface RenderEnv {
  w: number;
  h: number;
  /** Where a layer's pixels come from (the engine swaps in live strokes and previews). */
  source(l: PixelLayer): { canvas: HTMLCanvasElement; x: number; y: number };
  /** Settings to use for an adjustment layer (live preview while editing). */
  adj?(l: AdjustLayer): Adjustment;
  /** Stop before this layer (used to get "everything below"). */
  stopAt?: string;
  /** Only this part of the document needs to be right (live painting redraws just what changed). */
  region?: Rect;
}

// ---------- Masks ----------
interface AlphaCache {
  canvas: HTMLCanvasElement;
  inverse: boolean;
}
const maskCache = new WeakMap<HTMLCanvasElement, AlphaCache>();

function buildMaskAlpha(src: HTMLCanvasElement, inverse: boolean, into: HTMLCanvasElement, r: Rect) {
  const d = ctx2d(src).getImageData(r.x, r.y, r.w, r.h);
  const p = d.data;
  for (let i = 0; i < p.length; i += 4) {
    const v = p[i];
    p[i] = p[i + 1] = p[i + 2] = 0;
    p[i + 3] = inverse ? 255 - v : v;
  }
  ctx2d(into).putImageData(d, r.x, r.y);
}

/** Alpha version of a mask (cached per mask canvas). With a white outside, alpha = how much to hide. */
export function maskAlpha(m: Mask): AlphaCache {
  const inverse = m.outside >= 128;
  let hit = maskCache.get(m.canvas);
  if (!hit || hit.inverse !== inverse) {
    hit = { canvas: makeCanvas(m.canvas.width, m.canvas.height), inverse };
    buildMaskAlpha(m.canvas, inverse, hit.canvas, { x: 0, y: 0, w: m.canvas.width, h: m.canvas.height });
    maskCache.set(m.canvas, hit);
  }
  return hit;
}

/** Call after painting on a mask canvas in place (`r` limits the work to what changed). */
export function invalidateMask(m: Mask, r?: Rect) {
  const hit = maskCache.get(m.canvas);
  if (!hit) return;
  if (!r) return void maskCache.delete(m.canvas);
  const x = Math.max(0, Math.floor(r.x)),
    y = Math.max(0, Math.floor(r.y));
  const x2 = Math.min(m.canvas.width, Math.ceil(r.x + r.w)),
    y2 = Math.min(m.canvas.height, Math.ceil(r.y + r.h));
  if (x2 > x && y2 > y) buildMaskAlpha(m.canvas, hit.inverse, hit.canvas, { x, y, w: x2 - x, h: y2 - y });
}

/** Hide what the mask hides on a document-sized scratch canvas. */
export function applyMask(g: CanvasRenderingContext2D, m: Mask) {
  const a = maskAlpha(m);
  g.save();
  g.globalAlpha = 1;
  if (a.inverse) {
    g.globalCompositeOperation = 'destination-out';
    g.drawImage(a.canvas, m.x, m.y);
  } else {
    // Black outside the mask: clear around it, then keep only what the mask shows.
    const W = g.canvas.width,
      H = g.canvas.height;
    const x2 = m.x + m.canvas.width,
      y2 = m.y + m.canvas.height;
    g.clearRect(0, 0, W, Math.max(0, m.y));
    g.clearRect(0, y2, W, Math.max(0, H - y2));
    g.clearRect(0, 0, Math.max(0, m.x), H);
    g.clearRect(x2, 0, Math.max(0, W - x2), H);
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(a.canvas, m.x, m.y);
  }
  g.restore();
}

const active = (m: Mask | null): m is Mask => !!m && m.enabled;
const gco = (b: string): GlobalCompositeOperation => (b === 'normal' || b === 'pass-through' ? 'source-over' : (b as GlobalCompositeOperation));

// ---------- Layers ----------
/** Draw a pixel layer's content (with its mask and fill, no blend) onto a cleared scratch canvas. */
function pixelsInto(g: CanvasRenderingContext2D, l: PixelLayer, env: RenderEnv, withFill: boolean) {
  const s = env.source(l);
  g.globalAlpha = withFill ? l.fill : 1;
  g.globalCompositeOperation = 'source-over';
  g.drawImage(s.canvas, s.x, s.y);
  g.globalAlpha = 1;
  if (active(l.mask)) applyMask(g, l.mask);
}

function drawPixelLayer(g: CanvasRenderingContext2D, l: PixelLayer, env: RenderEnv) {
  g.save();
  if (!active(l.mask)) {
    const s = env.source(l);
    g.globalAlpha = l.opacity * l.fill;
    g.globalCompositeOperation = gco(l.blend);
    g.drawImage(s.canvas, s.x, s.y);
  } else {
    const t = borrow(env.w, env.h);
    pixelsInto(t.getContext('2d')!, l, env, true);
    g.globalAlpha = l.opacity;
    g.globalCompositeOperation = gco(l.blend);
    g.drawImage(t, 0, 0);
    release(t);
  }
  g.restore();
}

/** Adjustment layer: adjust a copy of what's below, then mix it back in (keeping the backdrop's alpha). */
function drawAdjust(g: CanvasRenderingContext2D, l: AdjustLayer, env: RenderEnv) {
  const W = env.w,
    H = env.h;
  const R = env.region || { x: 0, y: 0, w: W, h: H };
  const img = g.getImageData(R.x, R.y, R.w, R.h);
  applyAdjustmentFast(img.data, env.adj ? env.adj(l) : l.adj);
  const p = img.data;
  for (let i = 3; i < p.length; i += 4) if (p[i]) p[i] = 255;
  // Work in a scratch canvas the size of the region only.
  const t = borrow(R.w, R.h);
  const tg = ctx2d(t);
  tg.putImageData(img, 0, 0);
  if (active(l.mask)) applyMask(tg, { ...l.mask, x: l.mask.x - R.x, y: l.mask.y - R.y });
  g.save();
  g.globalAlpha = l.opacity * l.fill;
  g.globalCompositeOperation = l.blend === 'normal' || l.blend === 'pass-through' ? 'source-atop' : gco(l.blend);
  g.drawImage(t, R.x, R.y);
  g.restore();
  release(t);
}

function drawGroup(g: CanvasRenderingContext2D, l: GroupLayer, env: RenderEnv) {
  const W = env.w,
    H = env.h;
  if (l.blend === 'pass-through') {
    if (l.opacity >= 1 && !active(l.mask)) return void renderStack(g, l.children, env);
    // Render onto a copy of the backdrop, then fade/mask that result back in.
    const t = borrow(W, H);
    const tg = t.getContext('2d')!;
    tg.drawImage(g.canvas, 0, 0);
    renderStack(tg, l.children, env);
    if (active(l.mask)) applyMask(tg, l.mask);
    g.save();
    g.globalAlpha = l.opacity;
    g.drawImage(t, 0, 0);
    g.restore();
    release(t);
    return;
  }
  const t = borrow(W, H);
  const tg = t.getContext('2d')!;
  renderStack(tg, l.children, env);
  if (active(l.mask)) applyMask(tg, l.mask);
  g.save();
  g.globalAlpha = l.opacity;
  g.globalCompositeOperation = gco(l.blend);
  g.drawImage(t, 0, 0);
  g.restore();
  release(t);
}

/** A base layer with layers clipped to it: they only show where the base has pixels. */
function drawClipGroup(g: CanvasRenderingContext2D, base: Layer, clipped: Layer[], env: RenderEnv) {
  const W = env.w,
    H = env.h;
  const t = borrow(W, H);
  const tg = ctx2d(t);
  if (base.kind === 'group') {
    renderStack(tg, base.children, env);
    if (active(base.mask)) applyMask(tg, base.mask);
  } else if (base.kind !== 'adjust') pixelsInto(tg, base, env, true);
  for (const c of clipped) {
    if (c.kind === 'adjust') drawAdjust(tg, c, env);
    else {
      const ct = borrow(W, H);
      const cg = ct.getContext('2d')!;
      if (c.kind === 'group') {
        renderStack(cg, c.children, env);
        if (active(c.mask)) applyMask(cg, c.mask);
      } else pixelsInto(cg, c, env, true);
      tg.save();
      tg.globalAlpha = c.opacity;
      if (c.blend === 'normal' || c.blend === 'pass-through') tg.globalCompositeOperation = 'source-atop';
      else {
        // Limit to the base's pixels first, then blend.
        cg.globalCompositeOperation = 'destination-in';
        cg.drawImage(t, 0, 0);
        tg.globalCompositeOperation = gco(c.blend);
      }
      tg.drawImage(ct, 0, 0);
      tg.restore();
      release(ct);
    }
  }
  g.save();
  g.globalAlpha = base.opacity;
  g.globalCompositeOperation = gco(base.blend);
  g.drawImage(t, 0, 0);
  g.restore();
  release(t);
}

function drawLayer(g: CanvasRenderingContext2D, l: Layer, env: RenderEnv) {
  if (l.kind === 'adjust') drawAdjust(g, l, env);
  else if (l.kind === 'group') drawGroup(g, l, env);
  else drawPixelLayer(g, l, env);
}

let stopped = false;
/** Composite `layers` (bottom to top) onto `g`. */
export function renderStack(g: CanvasRenderingContext2D, layers: Layer[], env: RenderEnv) {
  let i = 0;
  while (i < layers.length && !stopped) {
    const base = layers[i];
    if (env.stopAt && base.id === env.stopAt) return void (stopped = true);
    let j = i + 1;
    const clipped: Layer[] = [];
    while (j < layers.length && layers[j].clip && !(env.stopAt && layers[j].id === env.stopAt)) clipped.push(layers[j++]);
    const vis = clipped.filter((c) => c.visible);
    if (base.visible) {
      if (vis.length && base.kind !== 'adjust') drawClipGroup(g, base, vis, env);
      else {
        drawLayer(g, base, env);
        for (const c of vis) drawLayer(g, c, env);
      }
    }
    i = j;
  }
}

/** Composite the document onto `target` (cleared first), or just `env.region` of it. */
export function renderDoc(doc: Doc, env: RenderEnv, target: HTMLCanvasElement) {
  const g = target.getContext('2d')!;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  const r = env.region;
  g.save();
  if (r) {
    g.beginPath();
    g.rect(r.x, r.y, r.w, r.h);
    g.clip();
    g.clearRect(r.x, r.y, r.w, r.h);
  } else g.clearRect(0, 0, target.width, target.height);
  stopped = false;
  renderStack(g, doc.layers, env);
  stopped = false;
  g.restore();
}
