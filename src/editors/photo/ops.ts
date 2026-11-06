import type { Engine, TransformState } from './engine';
import { transformMatrix, transformedBounds } from './engine';
import type { Layer, PixelLayer, RasterLayer, AdjustLayer, GroupLayer, Adjustment, Filter, Rect, LayerBlend, Mask, TextLayer, ShapeLayer, TextData, ShapeData } from './types';
import { isPixelLayer } from './types';
import { makeCanvas, cloneCanvas, filledCanvas, getPixels, canvasFromPixels, alphaBounds, intersect, borrow, release, ctx2d, grayOf, canvasToBytes, hexToRgb } from './canvas';
import { renderStack, applyMask } from './render';
import { renderText, renderShape } from './vector';
import { ADJ_LABELS } from './adjustments';
import { FILTER_LABELS } from './filters';
import * as S from './selection';
import { runPixels } from './pixelJobs';
import { uid } from '../../lib/util';
import { toast } from '../../store';

/**
 * Document operations: layers, image size/rotation, selections, fill/stroke, clipboard,
 * filters and adjustments. Each public operation records one undo step and returns a
 * short plain-English result (the assistant tools pass that back to Claude).
 * Problems are thrown as Errors with a message fit to show the user.
 */

const DEG = Math.PI / 180;

// ---------- Helpers ----------
export function layerRect(l: PixelLayer): Rect {
  return { x: l.x, y: l.y, w: l.canvas.width, h: l.canvas.height };
}

function replaceLayer(e: Engine, old: Layer, next: Layer) {
  const f = e.find(old.id);
  if (f) f.list[f.index] = next;
}

/** Turn a text or shape layer into plain pixels (keeps its name, opacity, mask…). */
export function rasterize(e: Engine, l: Layer): RasterLayer {
  if (l.kind === 'raster') return l;
  if (l.kind !== 'text' && l.kind !== 'shape') throw new Error('Only text and shape layers can be rasterized');
  const { text: _t, shape: _s, ...rest } = l as any;
  const r: RasterLayer = { ...rest, kind: 'raster', canvas: l.canvas, x: l.x, y: l.y };
  replaceLayer(e, l, r);
  return r;
}

/** The active layer as pixels to edit (text and shape layers are rasterized, with a note). */
export function pixelTarget(e: Engine, verb = 'edit'): RasterLayer {
  const l = e.active;
  if (!l) throw new Error('There are no layers to ' + verb);
  if (l.kind === 'group') throw new Error(`Pick a layer inside the group to ${verb}`);
  if (l.kind === 'adjust') throw new Error(`Pick a pixel layer to ${verb} (adjustment layers have no pixels)`);
  if (l.locked) throw new Error(`"${l.name}" is locked`);
  if (l.kind !== 'raster') {
    const r = rasterize(e, l);
    toast(`Rasterized "${l.name}" so it can be edited as pixels`);
    return r;
  }
  return l;
}

/** Visible pixels to sample from: the whole picture or just the active layer, document-sized. */
export function samplePixels(e: Engine, all: boolean): ImageData {
  if (all || !isPixelLayer(e.active)) return getPixels(e.flush());
  const l = e.active;
  const c = borrow(e.doc.w, e.doc.h);
  c.getContext('2d')!.drawImage(l.canvas, l.x, l.y);
  const d = getPixels(c);
  release(c);
  return d;
}

/** A layer-sized copy of `src` with the selection outside cleared. */
function maskedBySelection(e: Engine, src: HTMLCanvasElement, x: number, y: number) {
  const c = cloneCanvas(src);
  if (e.selection) {
    const g = c.getContext('2d')!;
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(e.selection.canvas, -x, -y);
  }
  return c;
}

const baseProps = (name: string) => ({ id: uid(), name, visible: true, locked: false, opacity: 1, fill: 1, blend: 'normal' as LayerBlend, clip: false, mask: null });

// ---------- Layers ----------
export function addLayer(e: Engine, name?: string): string {
  const l = e.newRaster(name || e.uniqueName('Layer'));
  e.insert(l);
  e.commit('New layer');
  return `Added layer "${l.name}"`;
}

export function addGroup(e: Engine): string {
  const g: GroupLayer = { ...baseProps(e.uniqueName('Group')), kind: 'group', blend: 'pass-through', children: [], open: true };
  e.insert(g);
  e.commit('New group');
  return `Added group "${g.name}"`;
}

export function addTextLayer(e: Engine, t: TextData, name?: string): TextLayer {
  const l: TextLayer = { ...baseProps(name || t.text.split('\n')[0].slice(0, 30) || 'Text'), kind: 'text', text: t, canvas: makeCanvas(1, 1), x: 0, y: 0 };
  renderText(l);
  e.insert(l);
  return l;
}

export function addShapeLayer(e: Engine, s: ShapeData): ShapeLayer {
  const names: Record<string, string> = { rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line', polygon: 'Polygon' };
  const l: ShapeLayer = { ...baseProps(e.uniqueName(names[s.type])), kind: 'shape', shape: s, canvas: makeCanvas(1, 1), x: 0, y: 0 };
  renderShape(l);
  e.insert(l);
  return l;
}

export function deleteLayer(e: Engine, id = e.state.activeId): string {
  const f = e.find(id);
  if (!f) throw new Error('No layer is selected');
  f.list.splice(f.index, 1);
  const next = f.list[Math.min(f.index, f.list.length - 1)] || f.parent || e.doc.layers[e.doc.layers.length - 1] || null;
  e.state.activeId = next ? next.id : null;
  e.commit('Delete layer');
  return `Deleted "${f.layer.name}"`;
}

function deepCopy(l: Layer): Layer {
  const c: any = { ...l, id: uid(), mask: l.mask ? { ...l.mask } : null };
  if (l.kind === 'group') c.children = l.children.map(deepCopy);
  if (l.kind === 'adjust') c.adj = JSON.parse(JSON.stringify(l.adj));
  if (l.kind === 'text') c.text = { ...l.text };
  if (l.kind === 'shape') c.shape = { ...l.shape };
  return c;
}

export function duplicateLayer(e: Engine): string {
  const f = e.find(e.state.activeId);
  if (!f) throw new Error('No layer is selected');
  const c = deepCopy(f.layer);
  c.name = `${f.layer.name} copy`;
  f.list.splice(f.index + 1, 0, c);
  e.state.activeId = c.id;
  e.commit('Duplicate layer');
  return `Duplicated "${f.layer.name}"`;
}

/** Change layer settings (name, opacity, blend, visibility…) as one step. */
export function setLayer(e: Engine, id: string, patch: Partial<Pick<Layer, 'name' | 'opacity' | 'fill' | 'blend' | 'visible' | 'locked' | 'clip'>>, label = 'Layer settings'): string {
  const f = e.find(id);
  if (!f) throw new Error('That layer no longer exists');
  if (patch.blend === 'pass-through' && f.layer.kind !== 'group') delete patch.blend;
  Object.assign(f.layer, patch);
  e.commit(label);
  return `Updated "${f.layer.name}"`;
}

/** Move a layer above/below another, or into a group (drag and drop in the Layers panel). */
export function moveLayer(e: Engine, id: string, targetId: string, where: 'above' | 'below' | 'into'): void {
  if (id === targetId) return;
  const src = e.find(id);
  if (!src) return;
  // Don't drop a group into itself.
  if (src.layer.kind === 'group') {
    const inside = (g: GroupLayer): boolean => g.children.some((c) => c.id === targetId || (c.kind === 'group' && inside(c)));
    if (inside(src.layer)) return;
  }
  src.list.splice(src.index, 1);
  const t = e.find(targetId);
  if (!t) {
    src.list.splice(src.index, 0, src.layer);
    return;
  }
  if (where === 'into' && t.layer.kind === 'group') {
    t.layer.children.push(src.layer);
    t.layer.open = true;
  } else t.list.splice(where === 'above' ? t.index + 1 : t.index, 0, src.layer);
  e.commit('Move layer');
}

export function shiftOrder(e: Engine, dir: 1 | -1): string {
  const f = e.find(e.state.activeId);
  if (!f) throw new Error('No layer is selected');
  const j = f.index + dir;
  if (j < 0 || j >= f.list.length) return 'Already at the ' + (dir > 0 ? 'top' : 'bottom');
  [f.list[f.index], f.list[j]] = [f.list[j], f.list[f.index]];
  e.commit(dir > 0 ? 'Bring forward' : 'Send backward');
  return 'Moved ' + (dir > 0 ? 'up' : 'down');
}

export function groupActive(e: Engine): string {
  const f = e.find(e.state.activeId);
  if (!f) throw new Error('No layer is selected');
  const g: GroupLayer = { ...baseProps(e.uniqueName('Group')), kind: 'group', blend: 'pass-through', children: [f.layer], open: true };
  f.list[f.index] = g;
  e.state.activeId = g.id;
  e.commit('Group layers');
  return `Put "${f.layer.name}" in a new group`;
}

export function ungroup(e: Engine): string {
  const f = e.find(e.state.activeId);
  if (!f || f.layer.kind !== 'group') throw new Error('Select a group to ungroup');
  f.list.splice(f.index, 1, ...f.layer.children);
  e.state.activeId = f.layer.children[f.layer.children.length - 1]?.id || null;
  e.commit('Ungroup layers');
  return 'Ungrouped';
}

// ---------- Masks ----------
export function addMask(e: Engine, mode: 'reveal' | 'hide' | 'selection'): string {
  const l = e.active;
  if (!l) throw new Error('No layer is selected');
  if (l.mask) throw new Error('This layer already has a mask');
  const { w, h } = e.doc;
  let c: HTMLCanvasElement;
  if (mode === 'selection' && e.selection) {
    c = filledCanvas(w, h, '#000');
    c.getContext('2d')!.drawImage(e.selection.canvas, 0, 0);
  } else c = filledCanvas(w, h, mode === 'hide' ? '#000' : '#fff');
  const outside = mode === 'reveal' ? 255 : 0;
  l.mask = { canvas: c, x: 0, y: 0, enabled: true, linked: true, outside };
  e.editTarget = 'mask';
  e.commit('Add layer mask');
  return `Added a mask to "${l.name}"`;
}

export function deleteMask(e: Engine, apply: boolean): string {
  const l = e.active;
  if (!l?.mask) throw new Error('This layer has no mask');
  if (apply) {
    if (!isPixelLayer(l)) throw new Error('Only pixel layers can have their mask applied');
    const r = pixelTarget(e, 'apply the mask to');
    const c = cloneCanvas(r.canvas);
    const m = r.mask!;
    applyMask(c.getContext('2d')!, { ...m, x: m.x - r.x, y: m.y - r.y });
    r.canvas = c;
    r.mask = null;
  } else l.mask = null;
  e.editTarget = 'pixels';
  e.commit(apply ? 'Apply layer mask' : 'Delete layer mask');
  return apply ? 'Applied the mask' : 'Deleted the mask';
}

export function toggleMask(e: Engine): string {
  const l = e.active;
  if (!l?.mask) throw new Error('This layer has no mask');
  l.mask.enabled = !l.mask.enabled;
  e.commit(l.mask.enabled ? 'Enable layer mask' : 'Disable layer mask');
  return l.mask.enabled ? 'Mask on' : 'Mask off';
}

export function toggleClip(e: Engine): string {
  const f = e.find(e.state.activeId);
  if (!f) throw new Error('No layer is selected');
  if (f.index === 0 && !f.layer.clip) throw new Error('There is no layer below to clip to');
  f.layer.clip = !f.layer.clip;
  e.commit(f.layer.clip ? 'Create clipping mask' : 'Release clipping mask');
  return f.layer.clip ? 'Clipped to the layer below' : 'Released the clipping mask';
}

// ---------- Merging ----------
function renderLayers(e: Engine, layers: Layer[]): HTMLCanvasElement {
  const c = makeCanvas(e.doc.w, e.doc.h);
  renderStack(c.getContext('2d')!, layers, e.env());
  return c;
}

export function mergeDown(e: Engine): string {
  const f = e.find(e.state.activeId);
  if (!f) throw new Error('No layer is selected');
  if (f.index === 0) throw new Error('There is no layer below to merge into');
  const below = f.list[f.index - 1];
  if (!isPixelLayer(below)) throw new Error('Merge down needs a pixel layer below');
  const top = f.layer;
  const base: Layer = { ...below, opacity: 1, blend: 'normal', clip: false };
  const c = renderLayers(e, top.visible ? [base, { ...top, clip: false } as Layer] : [base]);
  const r: RasterLayer = { ...baseProps(below.name), id: below.id, opacity: below.opacity, blend: below.blend, clip: below.clip, kind: 'raster', canvas: c, x: 0, y: 0 };
  f.list.splice(f.index - 1, 2, r);
  e.state.activeId = r.id;
  e.commit('Merge down');
  return `Merged "${top.name}" into "${below.name}"`;
}

export function mergeVisible(e: Engine): string {
  const vis = e.doc.layers.filter((l) => l.visible);
  if (vis.length < 2) throw new Error('There need to be at least two visible layers');
  const c = renderLayers(e, e.doc.layers);
  const at = e.doc.layers.indexOf(vis[0]);
  const r = e.newRaster('Merged', c);
  e.doc.layers = e.doc.layers.filter((l) => !l.visible);
  e.doc.layers.splice(Math.min(at, e.doc.layers.length), 0, r);
  e.state.activeId = r.id;
  e.commit('Merge visible');
  return `Merged ${vis.length} visible layers`;
}

export function flatten(e: Engine): string {
  const c = filledCanvas(e.doc.w, e.doc.h, '#fff');
  c.getContext('2d')!.drawImage(renderLayers(e, e.doc.layers), 0, 0);
  const r = e.newRaster('Background', c);
  e.doc.layers = [r];
  e.state.activeId = r.id;
  e.editTarget = 'pixels';
  e.commit('Flatten image');
  return 'Flattened the image into one layer';
}

export function rasterizeActive(e: Engine): string {
  const l = e.active;
  if (!l || (l.kind !== 'text' && l.kind !== 'shape')) throw new Error('Select a text or shape layer to rasterize');
  rasterize(e, l);
  e.commit('Rasterize layer');
  return `Rasterized "${l.name}"`;
}

// ---------- Moving layers ----------
/** Shift a layer (and its linked mask) by whole pixels without touching its pixels. */
export function offsetLayer(l: Layer, dx: number, dy: number) {
  if (l.mask && l.mask.linked) {
    l.mask.x += dx;
    l.mask.y += dy;
  }
  if (l.kind === 'group') l.children.forEach((c) => offsetLayer(c, dx, dy));
  else if (l.kind === 'text') {
    l.text = { ...l.text, x: l.text.x + dx, y: l.text.y + dy };
    l.x += dx;
    l.y += dy;
  } else if (l.kind === 'shape') {
    l.shape = { ...l.shape, x1: l.shape.x1 + dx, x2: l.shape.x2 + dx, y1: l.shape.y1 + dy, y2: l.shape.y2 + dy };
    l.x += dx;
    l.y += dy;
  } else if (l.kind === 'raster') {
    l.x += dx;
    l.y += dy;
  }
}

// ---------- Adjustments & filters ----------
export function addAdjustmentLayer(e: Engine, adj: Adjustment): AdjustLayer {
  const l: AdjustLayer = { ...baseProps(ADJ_LABELS[adj.type]), kind: 'adjust', adj: JSON.parse(JSON.stringify(adj)) };
  if (e.selection) {
    const c = filledCanvas(e.doc.w, e.doc.h, '#000');
    c.getContext('2d')!.drawImage(e.selection.canvas, 0, 0);
    l.mask = { canvas: c, x: 0, y: 0, enabled: true, linked: true, outside: 0 };
  }
  e.insert(l);
  e.commit(`New ${ADJ_LABELS[adj.type]} layer`);
  return l;
}

/** Run a filter or adjustment on the active layer's pixels (limited to the selection) and record it. */
async function processActive(e: Engine, op: 'filter' | 'adjust', params: Filter | Adjustment, label: string): Promise<string> {
  const l = pixelTarget(e, 'change');
  if (op === 'filter') e.growToDoc(l);
  const before = l.canvas;
  const r = layerRect(l);
  const sel = e.selection ? S.weights(e.selection, r) : null;
  e.busy = label;
  e.emit();
  try {
    const out = await runPixels(op, getPixels(before), params, { sel, place: { x: l.x, y: l.y, w: e.doc.w, h: e.doc.h } });
    const after = canvasFromPixels(out);
    l.canvas = after;
    e.commit(label);
    e.lastFilter = { index: e.history.index, layerId: l.id, before, after, x: l.x, y: l.y, label };
    return `${label} applied to "${l.name}"${e.selection ? ' (selection only)' : ''}`;
  } finally {
    e.busy = null;
    e.preview = null;
    e.emit();
  }
}

export function applyFilter(e: Engine, f: Filter) {
  return processActive(e, 'filter', f, FILTER_LABELS[f.type]);
}
export function applyAdjustmentPixels(e: Engine, a: Adjustment) {
  return processActive(e, 'adjust', a, ADJ_LABELS[a.type]);
}

/** Live preview of a filter/adjustment on the active layer (resolves when shown; cancelled by newer calls). */
export async function previewPixels(e: Engine, op: 'filter' | 'adjust', params: Filter | Adjustment) {
  const l = e.active;
  if (!isPixelLayer(l)) return;
  // Preview on a grown copy so blurs can spread past the layer's edge like the real thing.
  let src = l.canvas,
    x = l.x,
    y = l.y;
  if (op === 'filter' && l.kind === 'raster') {
    const tmp: RasterLayer = { ...l };
    e.growToDoc(tmp);
    src = tmp.canvas;
    x = tmp.x;
    y = tmp.y;
  }
  const r = { x, y, w: src.width, h: src.height };
  const sel = e.selection ? S.weights(e.selection, r) : null;
  const out = await runPixels(op, getPixels(src), params, { sel, place: { x, y, w: e.doc.w, h: e.doc.h }, key: 'preview' });
  e.preview = { layerId: l.id, canvas: canvasFromPixels(out), x, y };
  e.invalidate();
}

export function canFade(e: Engine) {
  return !!e.lastFilter && e.lastFilter.index === e.history.index && !!e.find(e.lastFilter.layerId);
}

/** Fade the last filter/adjustment: mix it with what was there before. */
export function fade(e: Engine, opacity: number, blend: LayerBlend, commit: boolean): string {
  const lf = e.lastFilter;
  if (!lf || !canFade(e)) throw new Error('There is nothing to fade');
  const c = cloneCanvas(lf.before);
  const g = c.getContext('2d')!;
  g.globalAlpha = opacity;
  g.globalCompositeOperation = blend === 'normal' || blend === 'pass-through' ? 'source-over' : (blend as GlobalCompositeOperation);
  g.drawImage(lf.after, 0, 0);
  if (!commit) {
    e.preview = { layerId: lf.layerId, canvas: c, x: lf.x, y: lf.y };
    e.invalidate();
    return '';
  }
  e.preview = null;
  const l = e.find(lf.layerId)!.layer as RasterLayer;
  l.canvas = c;
  l.x = lf.x;
  l.y = lf.y;
  e.lastFilter = null;
  e.commit(`Fade ${lf.label}`);
  return `Faded ${lf.label} to ${Math.round(opacity * 100)}%`;
}

// ---------- Whole-image changes ----------
/** Redraw a canvas through matrix `m` (document → document), sized to fit. */
function xfCanvas(src: HTMLCanvasElement, x: number, y: number, m: DOMMatrix, smooth: boolean, background?: string) {
  const pts = [
    [x, y],
    [x + src.width, y],
    [x + src.width, y + src.height],
    [x, y + src.height]
  ].map(([px, py]) => m.transformPoint(new DOMPoint(px, py)));
  const x0 = Math.floor(Math.min(...pts.map((p) => p.x)) + 1e-6),
    y0 = Math.floor(Math.min(...pts.map((p) => p.y)) + 1e-6);
  const x1 = Math.ceil(Math.max(...pts.map((p) => p.x)) - 1e-6),
    y1 = Math.ceil(Math.max(...pts.map((p) => p.y)) - 1e-6);
  const c = makeCanvas(Math.max(1, x1 - x0), Math.max(1, y1 - y0));
  const g = c.getContext('2d')!;
  if (background) {
    g.fillStyle = background;
    g.fillRect(0, 0, c.width, c.height);
  }
  g.imageSmoothingEnabled = smooth;
  g.imageSmoothingQuality = 'high';
  g.setTransform(new DOMMatrix().translate(-x0, -y0).multiply(m));
  g.drawImage(src, x, y);
  return { canvas: c, x: x0, y: y0 };
}

/**
 * Apply a geometric change to every layer, mask and the selection. `vector` keeps
 * text and shape layers editable (scaling and moving); otherwise they're rasterized.
 */
function transformAll(e: Engine, m: DOMMatrix, w: number, h: number, smooth: boolean, vector: { sx: number; sy: number } | null) {
  let rasterized = 0;
  const walk = (list: Layer[]) => {
    for (let i = 0; i < list.length; i++) {
      let l = list[i];
      if (l.mask) {
        // Corners the old mask didn't cover (after rotating) take the mask's outside value.
        const r = xfCanvas(l.mask.canvas, l.mask.x, l.mask.y, m, smooth, l.mask.outside >= 128 ? '#fff' : '#000');
        l.mask = { ...l.mask, canvas: r.canvas, x: r.x, y: r.y };
      }
      if (l.kind === 'group') walk(l.children);
      else if (l.kind === 'adjust') continue;
      else if (vector && l.kind === 'text') {
        const p = m.transformPoint(new DOMPoint(l.text.x, l.text.y));
        l.text = { ...l.text, x: p.x, y: p.y, size: Math.max(1, l.text.size * Math.sqrt(vector.sx * vector.sy)) };
        renderText(l);
      } else if (vector && l.kind === 'shape') {
        const a = m.transformPoint(new DOMPoint(l.shape.x1, l.shape.y1));
        const b = m.transformPoint(new DOMPoint(l.shape.x2, l.shape.y2));
        l.shape = { ...l.shape, x1: a.x, y1: a.y, x2: b.x, y2: b.y, strokeWidth: l.shape.strokeWidth * Math.sqrt(vector.sx * vector.sy), radius: l.shape.radius * Math.sqrt(vector.sx * vector.sy) };
        renderShape(l);
      } else {
        if (l.kind !== 'raster') {
          l = rasterize(e, l);
          rasterized++;
        }
        const r = xfCanvas(l.canvas, l.x, l.y, m, smooth);
        l.canvas = r.canvas;
        l.x = r.x;
        l.y = r.y;
      }
    }
  };
  walk(e.doc.layers);
  if (e.selection) {
    const c = makeCanvas(w, h);
    const g = c.getContext('2d')!;
    g.setTransform(m);
    g.imageSmoothingEnabled = smooth;
    g.drawImage(e.selection.canvas, 0, 0);
    e.state.selection = S.selectionFrom(c);
  }
  e.doc.w = Math.round(w);
  e.doc.h = Math.round(h);
  if (rasterized) toast(`${rasterized} text or shape layer${rasterized > 1 ? 's were' : ' was'} rasterized`);
}

export function resizeImage(e: Engine, w: number, h: number, method: 'smooth' | 'nearest' = 'smooth'): string {
  w = Math.round(w);
  h = Math.round(h);
  if (!(w >= 1 && h >= 1 && w <= 30000 && h <= 30000)) throw new Error('Width and height must be between 1 and 30000 pixels');
  const sx = w / e.doc.w,
    sy = h / e.doc.h;
  transformAll(e, new DOMMatrix().scale(sx, sy), w, h, method === 'smooth', { sx, sy });
  e.commit('Image size');
  e.fitView();
  return `Resized the image to ${w} × ${h} px`;
}

/** Shift everything by (dx, dy) and set a new document size. */
function shiftAll(e: Engine, dx: number, dy: number, w: number, h: number) {
  e.doc.layers.forEach((l) => offsetLayer(l, dx, dy));
  // Masks that aren't linked still need moving with the canvas.
  const fixUnlinked = (ls: Layer[]) =>
    ls.forEach((l) => {
      if (l.mask && !l.mask.linked) {
        l.mask.x += dx;
        l.mask.y += dy;
      }
      if (l.kind === 'group') fixUnlinked(l.children);
    });
  fixUnlinked(e.doc.layers);
  if (e.selection) {
    const c = makeCanvas(w, h);
    c.getContext('2d')!.drawImage(e.selection.canvas, dx, dy);
    e.state.selection = S.selectionFrom(c);
  }
  e.doc.w = w;
  e.doc.h = h;
}

/** Cut raster layers (and masks) down to the document, freeing what's outside. */
function trimToDoc(e: Engine) {
  const doc = { x: 0, y: 0, w: e.doc.w, h: e.doc.h };
  const cut = (c: HTMLCanvasElement, x: number, y: number, fillOutside?: string) => {
    const r = intersect({ x, y, w: c.width, h: c.height }, doc);
    if (!r) return { canvas: fillOutside ? filledCanvas(1, 1, fillOutside) : makeCanvas(1, 1), x: 0, y: 0 };
    if (r.x === x && r.y === y && r.w === c.width && r.h === c.height) return { canvas: c, x, y };
    const n = makeCanvas(r.w, r.h);
    n.getContext('2d')!.drawImage(c, x - r.x, y - r.y);
    return { canvas: n, x: r.x, y: r.y };
  };
  const walk = (ls: Layer[]) =>
    ls.forEach((l) => {
      if (l.kind === 'raster') Object.assign(l, cut(l.canvas, l.x, l.y));
      if (l.mask) Object.assign(l.mask, cut(l.mask.canvas, l.mask.x, l.mask.y, l.mask.outside >= 128 ? '#fff' : '#000'));
      if (l.kind === 'group') walk(l.children);
    });
  walk(e.doc.layers);
}

export type Anchor = { ax: 0 | 0.5 | 1; ay: 0 | 0.5 | 1 };
export function canvasSize(e: Engine, w: number, h: number, anchor: Anchor, fillColor: string | null): string {
  w = Math.round(w);
  h = Math.round(h);
  if (!(w >= 1 && h >= 1 && w <= 30000 && h <= 30000)) throw new Error('Width and height must be between 1 and 30000 pixels');
  const dx = Math.round((w - e.doc.w) * anchor.ax),
    dy = Math.round((h - e.doc.h) * anchor.ay);
  const ow = e.doc.w,
    oh = e.doc.h;
  shiftAll(e, dx, dy, w, h);
  const bottom = e.doc.layers[0];
  if (fillColor && bottom?.kind === 'raster') {
    // Fill the new area on the bottom layer (like Photoshop's canvas extension colour).
    const c = filledCanvas(w, h, fillColor);
    const g = c.getContext('2d')!;
    g.clearRect(dx, dy, ow, oh);
    g.drawImage(bottom.canvas, bottom.x, bottom.y);
    bottom.canvas = c;
    bottom.x = 0;
    bottom.y = 0;
  }
  trimToDoc(e);
  e.commit('Canvas size');
  e.fitView();
  return `Canvas is now ${w} × ${h} px`;
}

export function cropTo(e: Engine, r: Rect): string {
  const x = Math.round(r.x),
    y = Math.round(r.y);
  const w = Math.round(r.w),
    h = Math.round(r.h);
  if (w < 1 || h < 1) throw new Error('The crop area is empty');
  shiftAll(e, -x, -y, w, h);
  trimToDoc(e);
  e.crop = null;
  e.commit('Crop');
  e.fitView();
  return `Cropped to ${w} × ${h} px`;
}

export function rotateImage(e: Engine, deg: number): string {
  deg = ((deg % 360) + 360) % 360;
  if (deg === 0) return 'No rotation needed';
  const { w, h } = e.doc;
  const a = deg * DEG;
  const right = deg % 90 === 0;
  const nw = right ? (deg % 180 ? h : w) : Math.ceil(Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a)) - 1e-6);
  const nh = right ? (deg % 180 ? w : h) : Math.ceil(Math.abs(w * Math.sin(a)) + Math.abs(h * Math.cos(a)) - 1e-6);
  const m = new DOMMatrix().translate(nw / 2, nh / 2).rotate(deg).translate(-w / 2, -h / 2);
  transformAll(e, m, nw, nh, !right, null);
  if (!right) trimToDoc(e);
  e.commit(`Rotate ${deg}°`);
  e.fitView();
  return `Rotated the image ${deg}° clockwise`;
}

export function flipImage(e: Engine, dir: 'h' | 'v'): string {
  const { w, h } = e.doc;
  const m = dir === 'h' ? new DOMMatrix().translate(w, 0).scale(-1, 1) : new DOMMatrix().translate(0, h).scale(1, -1);
  transformAll(e, m, w, h, false, null);
  e.commit(dir === 'h' ? 'Flip horizontal' : 'Flip vertical');
  return dir === 'h' ? 'Flipped the image horizontally' : 'Flipped the image vertically';
}

/** Flip just the active layer. */
export function flipLayer(e: Engine, dir: 'h' | 'v'): string {
  const l = pixelTarget(e, 'flip');
  const c = makeCanvas(l.canvas.width, l.canvas.height);
  const g = c.getContext('2d')!;
  g.translate(dir === 'h' ? c.width : 0, dir === 'v' ? c.height : 0);
  g.scale(dir === 'h' ? -1 : 1, dir === 'v' ? -1 : 1);
  g.drawImage(l.canvas, 0, 0);
  l.canvas = c;
  e.commit(dir === 'h' ? 'Flip layer horizontal' : 'Flip layer vertical');
  return `Flipped "${l.name}"`;
}

/** Crop away transparent edges, or edges the colour of the top-left pixel. */
export function trim(e: Engine, by: 'transparent' | 'topleft'): string {
  const d = getPixels(e.flush());
  const { width: w, height: h, data } = d;
  const [r0, g0, b0, a0] = [data[0], data[1], data[2], data[3]];
  const keep = (i: number) => (by === 'transparent' ? data[i + 3] > 0 : Math.abs(data[i] - r0) + Math.abs(data[i + 1] - g0) + Math.abs(data[i + 2] - b0) + Math.abs(data[i + 3] - a0) > 6);
  let x0 = w,
    y0 = h,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (keep((y * w + x) * 4)) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
  if (x1 < 0) throw new Error('The image is empty, nothing to trim to');
  if (x0 === 0 && y0 === 0 && x1 === w - 1 && y1 === h - 1) return 'Nothing to trim';
  shiftAll(e, -x0, -y0, x1 - x0 + 1, y1 - y0 + 1);
  trimToDoc(e);
  e.commit('Trim');
  e.fitView();
  return `Trimmed to ${x1 - x0 + 1} × ${y1 - y0 + 1} px`;
}

// ---------- Selection ----------
export function selectAll(e: Engine): string {
  e.setSelection(S.selectAll(e.doc.w, e.doc.h), 'Select all');
  return 'Selected the whole image';
}
export function deselect(e: Engine): string {
  if (!e.selection) return 'Nothing was selected';
  e.setSelection(null, 'Deselect');
  return 'Deselected';
}
export function invertSelection(e: Engine): string {
  e.setSelection(S.invert(e.selection, e.doc.w, e.doc.h), 'Select inverse');
  return e.selection ? `Selection is now ${S.selectionArea(e.selection)}` : 'Nothing is selected';
}
export function selectRect(e: Engine, r: Rect, mode: S.SelMode = 'new', ellipse = false): string {
  const shape = ellipse ? S.ellipseMask(e.doc.w, e.doc.h, r) : S.rectMask(e.doc.w, e.doc.h, r);
  e.setSelection(S.combine(e.selection, shape, mode), ellipse ? 'Elliptical marquee' : 'Rectangular marquee');
  return e.selection ? `Selected ${S.selectionArea(e.selection)}` : 'Nothing is selected';
}
export function modifySelection(e: Engine, kind: 'feather' | 'expand' | 'contract' | 'border', px: number): string {
  if (!e.selection) throw new Error('Select an area first');
  const s = e.selection;
  const next = kind === 'feather' ? S.feather(s, px) : kind === 'expand' ? S.expand(s, px) : kind === 'contract' ? S.expand(s, -px) : S.border(s, px);
  const names = { feather: 'Feather', expand: 'Expand selection', contract: 'Contract selection', border: 'Border selection' };
  e.setSelection(next, names[kind]);
  return next ? `${names[kind]} by ${px} px` : 'The selection disappeared';
}
export function colorRange(e: Engine, color: string, fuzz: number, mode: S.SelMode = 'new'): string {
  const px = samplePixels(e, true);
  e.setSelection(S.combine(e.selection, S.colorRangeMask(px, hexToRgb(color), fuzz), mode), 'Color range');
  return e.selection ? `Selected ${S.selectionArea(e.selection)}` : 'No pixels matched that colour';
}
/** Select the active layer's opaque pixels (Ctrl+click a thumbnail). */
export function selectLayerPixels(e: Engine, id: string): string {
  const f = e.find(id);
  if (!f || !isPixelLayer(f.layer)) throw new Error('Pick a pixel layer');
  const l = f.layer;
  const c = makeCanvas(e.doc.w, e.doc.h);
  c.getContext('2d')!.drawImage(l.canvas, l.x, l.y);
  e.setSelection(S.selectionFrom(c), 'Select layer pixels');
  return 'Selected the layer’s pixels';
}

// ---------- Editing ----------
/** The thing to paint on: the active layer's pixels or its mask (colours become grays). */
export function paintSurface(e: Engine) {
  const l = e.active;
  if (e.editTarget === 'mask' && l?.mask) {
    const m = l.mask;
    if (l.locked) throw new Error(`"${l.name}" is locked`);
    return { layer: l, mask: m as Mask, x: m.x, y: m.y };
  }
  const r = pixelTarget(e, 'paint on');
  return { layer: r as Layer, mask: null, x: r.x, y: r.y };
}

export function fill(e: Engine, color: string, opacity = 1, blend: LayerBlend = 'normal'): string {
  const t = paintSurface(e);
  if (!t.mask) e.growToDoc(t.layer as RasterLayer);
  const src = t.mask ? t.mask.canvas : (t.layer as RasterLayer).canvas;
  const x = t.mask ? t.mask.x : (t.layer as RasterLayer).x,
    y = t.mask ? t.mask.y : (t.layer as RasterLayer).y;
  const paint = maskedBySelection(e, filledCanvas(src.width, src.height, t.mask ? grayOf(color) : color), x, y);
  const c = cloneCanvas(src);
  const g = c.getContext('2d')!;
  g.globalAlpha = opacity;
  g.globalCompositeOperation = blend === 'normal' || blend === 'pass-through' ? 'source-over' : (blend as GlobalCompositeOperation);
  g.drawImage(paint, 0, 0);
  if (t.mask) t.mask.canvas = c;
  else (t.layer as RasterLayer).canvas = c;
  e.commit('Fill');
  return `Filled ${e.selection ? 'the selection' : 'the layer'} with ${color}`;
}

export function strokeSelection(e: Engine, width: number, color: string, where: 'inside' | 'center' | 'outside'): string {
  const s = e.selection;
  if (!s) throw new Error('Select an area first');
  const l = pixelTarget(e, 'stroke');
  e.growToDoc(l);
  let ring: ReturnType<typeof S.combine>;
  if (where === 'inside') ring = S.combine(s, S.expand(s, -width)?.canvas || makeCanvas(1, 1), 'subtract');
  else if (where === 'outside') ring = S.combine(S.expand(s, width), s.canvas, 'subtract');
  else ring = S.border(s, width);
  if (!ring) throw new Error('The stroke would be empty');
  const paint = filledCanvas(e.doc.w, e.doc.h, color);
  const pg = paint.getContext('2d')!;
  pg.globalCompositeOperation = 'destination-in';
  pg.drawImage(ring.canvas, 0, 0);
  const c = cloneCanvas(l.canvas);
  c.getContext('2d')!.drawImage(paint, -l.x, -l.y);
  l.canvas = c;
  e.commit('Stroke');
  return `Stroked the selection ${width} px ${where}`;
}

/** Delete: clear the selected pixels, or delete the layer when nothing is selected. */
export function clearSelected(e: Engine): string {
  if (!e.selection) return deleteLayer(e);
  const t = paintSurface(e);
  if (t.mask) {
    // On a mask, Delete paints the selection black (hides it).
    return fill(e, '#000000');
  }
  const l = t.layer as RasterLayer;
  const c = cloneCanvas(l.canvas);
  const g = c.getContext('2d')!;
  g.globalCompositeOperation = 'destination-out';
  g.drawImage(e.selection.canvas, -l.x, -l.y);
  l.canvas = c;
  e.commit('Clear');
  return 'Cleared the selected pixels';
}

/** Copy the selected part of the active layer (or of the whole picture when `merged`). */
export function copy(e: Engine, merged = false): boolean {
  let src: HTMLCanvasElement, x: number, y: number;
  if (merged) {
    src = e.flush();
    x = 0;
    y = 0;
  } else {
    const l = e.active;
    if (!isPixelLayer(l)) throw new Error('Pick a pixel layer to copy from');
    src = l.canvas;
    x = l.x;
    y = l.y;
  }
  const area = e.selection ? intersect(e.selection.bounds, { x, y, w: src.width, h: src.height }) : intersect({ x, y, w: src.width, h: src.height }, { x: 0, y: 0, w: e.doc.w, h: e.doc.h });
  if (!area) throw new Error('Nothing to copy there');
  const c = makeCanvas(area.w, area.h);
  const g = c.getContext('2d')!;
  g.drawImage(src, x - area.x, y - area.y);
  if (e.selection) {
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(e.selection.canvas, -area.x, -area.y);
  }
  e.clipboard = { canvas: c, x: area.x, y: area.y };
  // Also put it on the system clipboard so other apps can paste it.
  canvasToBytes(c, 'image/png')
    .then((b) => navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([b as BlobPart], { type: 'image/png' }) })]))
    .catch(() => {});
  return true;
}

export function cut(e: Engine) {
  copy(e);
  if (e.selection) clearSelected(e);
  else {
    const l = pixelTarget(e, 'cut');
    l.canvas = makeCanvas(l.canvas.width, l.canvas.height);
    e.commit('Cut');
  }
}

/** Paste as a new layer: our own copy goes back where it came from; images from other apps are centred. */
export async function paste(e: Engine): Promise<string> {
  let img: HTMLCanvasElement | null = null;
  let pos: { x: number; y: number } | null = null;
  try {
    const items = await navigator.clipboard.read();
    for (const it of items) {
      const type = it.types.find((t) => t.startsWith('image/'));
      if (!type) continue;
      const bmp = await createImageBitmap(await it.getType(type));
      // Skip it if it's just our own copy (keep the original position then).
      const own = e.clipboard && e.clipboard.canvas.width === bmp.width && e.clipboard.canvas.height === bmp.height;
      if (!own) {
        img = makeCanvas(bmp.width, bmp.height);
        img.getContext('2d')!.drawImage(bmp, 0, 0);
      }
      break;
    }
  } catch {
    /* no access to the system clipboard: use our own */
  }
  if (!img && e.clipboard) {
    img = e.clipboard.canvas;
    pos = { x: e.clipboard.x, y: e.clipboard.y };
  }
  if (!img) throw new Error('There is no image to paste');
  if (!pos) pos = { x: Math.round((e.doc.w - img.width) / 2), y: Math.round((e.doc.h - img.height) / 2) };
  const l = e.newRaster(e.uniqueName('Pasted'), cloneCanvas(img), pos.x, pos.y);
  e.insert(l);
  e.editTarget = 'pixels';
  e.commit('Paste');
  return `Pasted as "${l.name}"`;
}

/** Add an image (from a file or the assistant) as a new layer, centred and scaled to fit. */
export function placeImage(e: Engine, img: CanvasImageSource & { width: number; height: number }, name: string): string {
  const s = Math.min(1, e.doc.w / img.width, e.doc.h / img.height);
  const c = makeCanvas(img.width * s, img.height * s);
  const g = c.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, 0, 0, c.width, c.height);
  const l = e.newRaster(name, c, Math.round((e.doc.w - c.width) / 2), Math.round((e.doc.h - c.height) / 2));
  e.insert(l);
  e.commit('Place image');
  return `Placed "${name}"`;
}

// ---------- Free transform ----------
export function beginTransform(e: Engine, moveOnly = false): boolean {
  if (e.transform) return true;
  const l = pixelTarget(e, 'transform');
  const lr = layerRect(l);
  let float: HTMLCanvasElement, fx: number, fy: number, selFloat: HTMLCanvasElement | null = null;
  const base = cloneCanvas(l.canvas);
  if (e.selection) {
    const area = intersect(e.selection.bounds, lr);
    if (!area) throw new Error('The selection is outside this layer');
    float = makeCanvas(area.w, area.h);
    const g = float.getContext('2d')!;
    g.drawImage(l.canvas, l.x - area.x, l.y - area.y);
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(e.selection.canvas, -area.x, -area.y);
    const bg = base.getContext('2d')!;
    bg.globalCompositeOperation = 'destination-out';
    bg.drawImage(e.selection.canvas, -l.x, -l.y);
    selFloat = makeCanvas(area.w, area.h);
    selFloat.getContext('2d')!.drawImage(e.selection.canvas, -area.x, -area.y);
    fx = area.x;
    fy = area.y;
  } else {
    const b = alphaBounds(l.canvas);
    if (!b) throw new Error('The layer is empty');
    float = makeCanvas(b.w, b.h);
    float.getContext('2d')!.drawImage(l.canvas, -b.x, -b.y);
    base.getContext('2d')!.clearRect(b.x, b.y, b.w, b.h);
    fx = l.x + b.x;
    fy = l.y + b.y;
  }
  const t: TransformState = { layerId: l.id, base, baseX: l.x, baseY: l.y, float, cx: fx + float.width / 2, cy: fy + float.height / 2, sx: 1, sy: 1, angle: 0, selFloat, moveOnly };
  e.transform = t;
  e.invalidate();
  e.emit();
  return true;
}

export function commitTransform(e: Engine): string {
  const t = e.transform;
  if (!t) return '';
  const f = e.find(t.layerId);
  e.transform = null;
  if (!f || f.layer.kind !== 'raster') {
    e.emit();
    return '';
  }
  const l = f.layer;
  const m = transformMatrix(t);
  const fb = transformedBounds(t);
  const x0 = Math.min(t.baseX, fb.x),
    y0 = Math.min(t.baseY, fb.y);
  const x1 = Math.max(t.baseX + t.base.width, fb.x + fb.w),
    y1 = Math.max(t.baseY + t.base.height, fb.y + fb.h);
  const c = makeCanvas(x1 - x0, y1 - y0);
  const g = c.getContext('2d')!;
  g.drawImage(t.base, t.baseX - x0, t.baseY - y0);
  g.setTransform(new DOMMatrix().translate(-x0, -y0).multiply(m));
  g.imageSmoothingQuality = 'high';
  g.drawImage(t.float, 0, 0);
  l.canvas = c;
  l.x = x0;
  l.y = y0;
  if (t.selFloat) {
    const sc = makeCanvas(e.doc.w, e.doc.h);
    const sg = sc.getContext('2d')!;
    sg.setTransform(m);
    sg.drawImage(t.selFloat, 0, 0);
    e.state.selection = S.selectionFrom(sc);
  }
  const moved = t.sx === 1 && t.sy === 1 && t.angle === 0;
  e.commit(moved ? 'Move' : 'Free transform');
  return moved ? 'Moved' : 'Transformed';
}

// ---------- Painting helpers used by tools ----------
/** Paint-bucket fill from a point. */
export function bucketFill(e: Engine, x: number, y: number, color: string) {
  const o = e.opts.bucket;
  const t = paintSurface(e);
  if (!t.mask) e.growToDoc(t.layer as RasterLayer);
  let px: ImageData;
  if (t.mask) {
    const c = borrow(e.doc.w, e.doc.h);
    c.getContext('2d')!.drawImage(t.mask.canvas, t.mask.x, t.mask.y);
    px = getPixels(c);
    release(c);
  } else px = samplePixels(e, o.sampleAll);
  let region = S.wandMask(px, x, y, o.tolerance, o.contiguous);
  if (o.antialias) region = S.softenEdges(region, 0.5);
  const g0 = region.getContext('2d')!;
  if (e.selection) {
    g0.globalCompositeOperation = 'destination-in';
    g0.drawImage(e.selection.canvas, 0, 0);
  }
  const paint = filledCanvas(e.doc.w, e.doc.h, t.mask ? grayOf(color) : color);
  const pg = paint.getContext('2d')!;
  pg.globalCompositeOperation = 'destination-in';
  pg.drawImage(region, 0, 0);
  const src = t.mask ? t.mask.canvas : (t.layer as RasterLayer).canvas;
  const c = cloneCanvas(src);
  const g = c.getContext('2d')!;
  g.globalAlpha = o.opacity;
  g.drawImage(paint, -t.x, -t.y);
  if (t.mask) t.mask.canvas = c;
  else (t.layer as RasterLayer).canvas = c;
  e.commit('Paint bucket');
}

/** Read the colour at a document point from the composite (or the active layer). */
export function pickColor(e: Engine, x: number, y: number, size = 1, all = true): string | null {
  const half = Math.floor(size / 2);
  const x0 = Math.floor(x) - half,
    y0 = Math.floor(y) - half;
  if (x0 + size <= 0 || y0 + size <= 0 || x0 >= e.doc.w || y0 >= e.doc.h) return null;
  let src: HTMLCanvasElement = e.flush(),
    ox = 0,
    oy = 0;
  if (!all && isPixelLayer(e.active)) {
    src = e.active.canvas;
    ox = e.active.x;
    oy = e.active.y;
  }
  const d = ctx2d(src).getImageData(x0 - ox, y0 - oy, size, size).data;
  let r = 0,
    g = 0,
    b = 0,
    a = 0;
  for (let i = 0; i < d.length; i += 4) {
    r += d[i] * d[i + 3];
    g += d[i + 1] * d[i + 3];
    b += d[i + 2] * d[i + 3];
    a += d[i + 3];
  }
  if (!a) return null;
  const hx = (v: number) => Math.round(v / a).toString(16).padStart(2, '0');
  return `#${hx(r)}${hx(g)}${hx(b)}`;
}

