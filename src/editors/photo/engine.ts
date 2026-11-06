import type { Doc, DocState, Layer, PixelLayer, RasterLayer, Rect, Selection, Adjustment, AdjustLayer, Pt, GroupLayer, Mask } from './types';
import { isPixelLayer } from './types';
import { History, frozen } from './history';
import { renderDoc, RenderEnv } from './render';
import { makeCanvas, memCanvas, cloneCanvas, borrow, release, union } from './canvas';
import { uid } from '../../lib/util';
import type { ToolId, ToolOptions } from './toolOptions';
import { defaultToolOptions } from './toolOptions';

/**
 * The photo editor's engine: the document, its history, the view, and the hooks
 * tools use to paint live. React components subscribe to it and re-render on `emit`.
 */

export interface ViewState {
  zoom: number;
  /** Screen position (CSS px inside the viewport) of the document's top-left corner. */
  panX: number;
  panY: number;
  /** Re-fit when the viewport resizes until the user zooms or pans. */
  fit: boolean;
}

/** A floating piece of pixels being moved/scaled/rotated (free transform). */
export interface TransformState {
  layerId: string;
  /** The layer without the floating pixels. */
  base: HTMLCanvasElement;
  baseX: number;
  baseY: number;
  float: HTMLCanvasElement;
  /** Centre of the float in the document, scale and rotation (radians). */
  cx: number;
  cy: number;
  sx: number;
  sy: number;
  angle: number;
  /** The selection's shape over the float (moved along with it), if there was a selection. */
  selFloat: HTMLCanvasElement | null;
  /** Moves only (move tool with a selection): commit on release. */
  moveOnly: boolean;
}

interface LiveStroke {
  layerId: string;
  /** Document-sized buffer the stroke is painted into. */
  buffer: HTMLCanvasElement;
  mode: 'over' | 'erase';
  alpha: number;
  /** Reused scratch canvas for the layer+stroke preview (kept up to date region by region). */
  scratch: HTMLCanvasElement | null;
  scratchReady: boolean;
  bounds: Rect | null;
}

export interface Preview {
  layerId: string;
  canvas: HTMLCanvasElement;
  x: number;
  y: number;
}

export interface CursorInfo {
  x: number;
  y: number;
  inside: boolean;
  color: string | null;
}

export class Engine {
  state: DocState;
  history = new History();
  /** History step id of the last save (to know if there are unsaved changes). */
  savedId = 0;
  composite: HTMLCanvasElement;
  view: ViewState = { zoom: 1, panX: 0, panY: 0, fit: true };
  viewport = { w: 800, h: 600 };

  tool: ToolId = 'brush';
  opts: ToolOptions = defaultToolOptions();
  fg = '#000000';
  bg = '#ffffff';
  /** Paint on the active layer's pixels or on its mask. */
  editTarget: 'pixels' | 'mask' = 'pixels';
  showGrid = false;
  gridSize = 50;
  showRulers = false;
  showSelection = true;

  live: LiveStroke | null = null;
  preview: Preview | null = null;
  adjPreview: { layerId: string; adj: Adjustment } | null = null;
  transform: TransformState | null = null;
  crop: Rect | null = null;
  /** Tool overlays: marquee/lasso in progress, gradient line, etc. (document coordinates). */
  overlay: { kind: 'rect' | 'ellipse' | 'lasso' | 'poly' | 'line' | 'shape'; pts: Pt[]; closed?: boolean } | null = null;
  textEditing: string | null = null;
  clipboard: { canvas: HTMLCanvasElement; x: number; y: number } | null = null;
  lastFilter: { index: number; layerId: string; before: HTMLCanvasElement; after: HTMLCanvasElement; x: number; y: number; label: string } | null = null;
  cloneSource: Pt | null = null;
  busy: string | null = null;
  cursor: CursorInfo = { x: 0, y: 0, inside: false, color: null };

  private docDirty = true;
  /** Part of the document that changed since the last composite (null = all of it). */
  private dirtyRect: Rect | null = null;
  /** The region being recomposited right now (null = everything). */
  private renderRegion: Rect | null = null;
  private frame = 0;
  private listeners = new Set<() => void>();
  private cursorListeners = new Set<() => void>();
  onRender: (() => void) | null = null;
  onChange: (() => void) | null = null;
  version = 0;

  constructor(doc: Doc, label = 'Open') {
    this.state = { doc, activeId: topLayerId(doc.layers), selection: null };
    this.composite = memCanvas(doc.w, doc.h);
    this.history.reset(label, this.state);
    this.savedId = this.history.currentId;
  }

  get doc() {
    return this.state.doc;
  }
  get selection() {
    return this.state.selection;
  }

  // ---------- Change notification ----------
  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
  subscribeCursor(fn: () => void) {
    this.cursorListeners.add(fn);
    return () => void this.cursorListeners.delete(fn);
  }
  /** Tell the UI something changed (panels, menus, options bar). */
  emit() {
    this.version++;
    this.listeners.forEach((f) => f());
  }
  emitCursor() {
    this.cursorListeners.forEach((f) => f());
  }
  /** The document's pixels changed: recomposite on the next frame. */
  invalidate(r?: Rect) {
    if (r && (!this.docDirty || this.dirtyRect)) this.dirtyRect = union(this.dirtyRect, r);
    else this.dirtyRect = null;
    this.docDirty = true;
    this.requestFrame();
  }
  /** Only the view (zoom, overlays) changed. */
  requestFrame() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.onRender?.();
    });
  }
  /** Recomposite if needed; returns the composite canvas. */
  flush(): HTMLCanvasElement {
    if (this.docDirty) {
      this.docDirty = false;
      let region: Rect | undefined;
      if (this.composite.width !== this.doc.w || this.composite.height !== this.doc.h) this.composite = memCanvas(this.doc.w, this.doc.h);
      else if (this.dirtyRect) {
        // Redraw only what changed (with a little margin for anti-aliasing).
        const r = this.dirtyRect;
        const x0 = Math.max(0, Math.floor(r.x) - 2),
          y0 = Math.max(0, Math.floor(r.y) - 2);
        const x1 = Math.min(this.doc.w, Math.ceil(r.x + r.w) + 2),
          y1 = Math.min(this.doc.h, Math.ceil(r.y + r.h) + 2);
        if (x1 <= x0 || y1 <= y0) {
          this.dirtyRect = null;
          return this.composite;
        }
        region = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      }
      this.dirtyRect = null;
      this.renderRegion = region || null;
      renderDoc(this.doc, this.env(region ? { region } : undefined), this.composite);
      this.renderRegion = null;
    }
    return this.composite;
  }

  // ---------- Rendering hooks ----------
  env(extra?: Partial<RenderEnv>): RenderEnv {
    return {
      w: this.doc.w,
      h: this.doc.h,
      source: (l) => this.sourceOf(l),
      adj: (l) => (this.adjPreview && this.adjPreview.layerId === l.id ? this.adjPreview.adj : l.adj),
      ...extra
    };
  }

  private sourceOf(l: PixelLayer): { canvas: HTMLCanvasElement; x: number; y: number } {
    if (this.preview && this.preview.layerId === l.id) return this.preview;
    if (this.transform && this.transform.layerId === l.id) return this.transformSource(this.transform);
    if (this.live && this.live.layerId === l.id && this.editTarget === 'pixels') return this.liveSource(l, this.live);
    return l;
  }

  /** Layer pixels with the stroke in progress drawn in (limited to the selection). */
  private liveSource(l: PixelLayer, s: LiveStroke) {
    const w = l.canvas.width,
      h = l.canvas.height;
    if (!s.scratch || s.scratch.width !== w || s.scratch.height !== h) {
      s.scratch = makeCanvas(w, h);
      s.scratchReady = false;
    }
    const g = s.scratch.getContext('2d')!;
    const r = this.renderRegion;
    if (r && s.scratchReady) {
      // Only the part being recomposited can have changed since the last frame.
      g.save();
      g.beginPath();
      g.rect(r.x - l.x, r.y - l.y, r.w, r.h);
      g.clip();
      g.clearRect(r.x - l.x, r.y - l.y, r.w, r.h);
      g.drawImage(l.canvas, 0, 0);
      this.drawStroke(g, s, l.x, l.y, r);
      g.restore();
    } else {
      g.globalCompositeOperation = 'copy';
      g.globalAlpha = 1;
      g.drawImage(l.canvas, 0, 0);
      g.globalCompositeOperation = 'source-over';
      this.drawStroke(g, s, l.x, l.y);
      s.scratchReady = true;
    }
    return { canvas: s.scratch, x: l.x, y: l.y };
  }

  /** Composite the stroke buffer onto a layer-space context. */
  drawStroke(g: CanvasRenderingContext2D, s: LiveStroke, lx: number, ly: number, region?: Rect) {
    let src = s.buffer;
    let tmp: HTMLCanvasElement | null = null;
    // Document-space area to transfer (just the region when given).
    const r = region || { x: 0, y: 0, w: s.buffer.width, h: s.buffer.height };
    if (this.selection || region) {
      tmp = borrow(r.w, r.h);
      const tg = tmp.getContext('2d')!;
      tg.drawImage(s.buffer, -r.x, -r.y);
      if (this.selection) {
        tg.globalCompositeOperation = 'destination-in';
        tg.drawImage(this.selection.canvas, -r.x, -r.y);
      }
      src = tmp;
    }
    g.globalCompositeOperation = s.mode === 'erase' ? 'destination-out' : 'source-over';
    g.globalAlpha = s.alpha;
    g.drawImage(src, r.x - lx, r.y - ly);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    if (tmp) release(tmp);
  }

  private transformSource(t: TransformState) {
    const m = transformMatrix(t);
    const fb = transformedBounds(t);
    const r = union({ x: t.baseX, y: t.baseY, w: t.base.width, h: t.base.height }, fb);
    const c = makeCanvas(r.w, r.h);
    const g = c.getContext('2d')!;
    g.drawImage(t.base, t.baseX - r.x, t.baseY - r.y);
    g.setTransform(m.translate(0, 0).preMultiplySelf(new DOMMatrix().translate(-r.x, -r.y)));
    g.imageSmoothingQuality = 'high';
    g.drawImage(t.float, 0, 0);
    return { canvas: c, x: r.x, y: r.y };
  }

  // ---------- Layers ----------
  find(id: string | null): { layer: Layer; list: Layer[]; index: number; parent: GroupLayer | null } | null {
    if (!id) return null;
    const walk = (list: Layer[], parent: GroupLayer | null): ReturnType<Engine['find']> => {
      for (let i = 0; i < list.length; i++) {
        const l = list[i];
        if (l.id === id) return { layer: l, list, index: i, parent };
        if (l.kind === 'group') {
          const hit = walk(l.children, l);
          if (hit) return hit;
        }
      }
      return null;
    };
    return walk(this.doc.layers, null);
  }
  get active(): Layer | null {
    return this.find(this.state.activeId)?.layer || null;
  }
  setActive(id: string | null) {
    this.state.activeId = id;
    const l = this.active;
    if (this.editTarget === 'mask' && !l?.mask) this.editTarget = 'pixels';
    this.emit();
  }
  /** Every layer, top to bottom, with its depth in groups (for the Layers panel). */
  flat(): { layer: Layer; depth: number; hiddenByParent: boolean }[] {
    const out: { layer: Layer; depth: number; hiddenByParent: boolean }[] = [];
    const walk = (list: Layer[], depth: number, hidden: boolean, collapsed: boolean) => {
      for (let i = list.length - 1; i >= 0; i--) {
        const l = list[i];
        if (!collapsed) out.push({ layer: l, depth, hiddenByParent: hidden });
        if (l.kind === 'group') walk(l.children, depth + 1, hidden || !l.visible, collapsed || !l.open);
      }
    };
    walk(this.doc.layers, 0, false, false);
    return out;
  }
  allLayers(): Layer[] {
    const out: Layer[] = [];
    const walk = (ls: Layer[]) => ls.forEach((l) => (out.push(l), l.kind === 'group' && walk(l.children)));
    walk(this.doc.layers);
    return out;
  }

  /** Make the layer's canvas safe to edit (copies it if a history step holds it). */
  own(l: PixelLayer) {
    if (frozen.has(l.canvas)) l.canvas = cloneCanvas(l.canvas);
    return l.canvas;
  }
  ownMask(m: Mask) {
    if (frozen.has(m.canvas)) m.canvas = cloneCanvas(m.canvas);
    return m.canvas;
  }

  /** Grow a raster layer's canvas so it covers the whole document (before painting). */
  growToDoc(l: RasterLayer) {
    const r = union({ x: l.x, y: l.y, w: l.canvas.width, h: l.canvas.height }, { x: 0, y: 0, w: this.doc.w, h: this.doc.h });
    if (r.x === l.x && r.y === l.y && r.w === l.canvas.width && r.h === l.canvas.height) return;
    const c = makeCanvas(r.w, r.h);
    c.getContext('2d')!.drawImage(l.canvas, l.x - r.x, l.y - r.y);
    l.canvas = c;
    l.x = r.x;
    l.y = r.y;
  }

  newRaster(name: string, canvas?: HTMLCanvasElement, x = 0, y = 0): RasterLayer {
    return { kind: 'raster', id: uid(), name, visible: true, locked: false, opacity: 1, fill: 1, blend: 'normal', clip: false, mask: null, canvas: canvas || makeCanvas(this.doc.w, this.doc.h), x, y };
  }

  /** Insert above the active layer (inside its group), make it active. */
  insert(l: Layer) {
    const at = this.find(this.state.activeId);
    if (at) at.list.splice(at.index + 1, 0, l);
    else this.doc.layers.push(l);
    this.state.activeId = l.id;
  }

  uniqueName(base: string) {
    const names = new Set(this.allLayers().map((l) => l.name));
    let i = 1;
    while (names.has(`${base} ${i}`)) i++;
    return `${base} ${i}`;
  }

  // ---------- History ----------
  /** Record the current state as one undo step. */
  commit(label: string) {
    this.history.push(label, this.state);
    this.lastFilterInvalidate();
    this.invalidate();
    this.emit();
    this.onChange?.();
  }
  private lastFilterInvalidate() {
    if (this.lastFilter && this.lastFilter.index !== this.history.index - 1) this.lastFilter = null;
  }
  jumpTo(i: number) {
    if (i < 0 || i >= this.history.entries.length || i === this.history.index) return;
    this.cancelTransient();
    this.history.index = i;
    this.state = this.history.stateAt(i);
    if (this.editTarget === 'mask' && !this.active?.mask) this.editTarget = 'pixels';
    this.lastFilter = null;
    this.invalidate();
    this.emit();
    this.onChange?.();
  }
  undo() {
    if (this.transform) return this.cancelTransform();
    this.jumpTo(this.history.index - 1);
  }
  redo() {
    this.jumpTo(this.history.index + 1);
  }
  get dirty() {
    return this.history.currentId !== this.savedId;
  }
  markSaved() {
    this.savedId = this.history.currentId;
    this.emit();
  }

  /** Drop anything half-done (previews, crop box, floating transform) without committing. */
  cancelTransient() {
    this.live = null;
    this.preview = null;
    this.adjPreview = null;
    this.overlay = null;
    this.crop = null;
    if (this.transform) this.cancelTransform();
  }

  // ---------- Live strokes ----------
  beginLive(layerId: string, mode: 'over' | 'erase', alpha: number) {
    this.live = { layerId, buffer: makeCanvas(this.doc.w, this.doc.h), mode, alpha, scratch: null, scratchReady: false, bounds: null };
    return this.live;
  }
  /** Bake the stroke into the layer (as a new canvas, so history keeps the old one). */
  endLive(): boolean {
    const s = this.live;
    this.live = null;
    if (!s || !s.bounds) return false;
    const f = this.find(s.layerId);
    if (!f || f.layer.kind !== 'raster') return false;
    const l = f.layer;
    const c = cloneCanvas(l.canvas);
    this.drawStroke(c.getContext('2d')!, s, l.x, l.y);
    l.canvas = c;
    return true;
  }

  // ---------- Transform ----------
  cancelTransform() {
    const t = this.transform;
    if (!t) return;
    this.transform = null;
    this.invalidate();
    this.emit();
  }

  // ---------- View ----------
  fitView() {
    const { w, h } = this.viewport;
    const z = Math.min(1, (w - 48) / this.doc.w, (h - 48) / this.doc.h);
    this.view = { zoom: Math.max(0.01, z), panX: (w - this.doc.w * z) / 2, panY: (h - this.doc.h * z) / 2, fit: true };
    this.requestFrame();
    this.emit();
  }
  /** Zoom keeping the screen point (sx, sy) fixed (defaults to the viewport centre). */
  zoomTo(z: number, sx = this.viewport.w / 2, sy = this.viewport.h / 2) {
    z = Math.max(0.01, Math.min(64, z));
    const v = this.view;
    const dx = (sx - v.panX) / v.zoom,
      dy = (sy - v.panY) / v.zoom;
    this.view = { zoom: z, panX: sx - dx * z, panY: sy - dy * z, fit: false };
    this.requestFrame();
    this.emit();
  }
  zoomStep(dir: 1 | -1, sx?: number, sy?: number) {
    const steps = [0.01, 0.02, 0.03, 0.05, 0.0833, 0.125, 0.1667, 0.25, 0.3333, 0.5, 0.6667, 1, 1.5, 2, 3, 4, 5, 6, 8, 12, 16, 24, 32, 48, 64];
    const z = this.view.zoom;
    const next = dir > 0 ? steps.find((s) => s > z * 1.01) || 64 : [...steps].reverse().find((s) => s < z / 1.01) || 0.01;
    this.zoomTo(next, sx, sy);
  }
  toDoc(sx: number, sy: number): Pt {
    return { x: (sx - this.view.panX) / this.view.zoom, y: (sy - this.view.panY) / this.view.zoom };
  }
  toScreen(p: Pt): Pt {
    return { x: p.x * this.view.zoom + this.view.panX, y: p.y * this.view.zoom + this.view.panY };
  }

  /** Swap in a whole new document (open, new image) and start history over. */
  replaceDoc(doc: Doc, label: string) {
    this.cancelTransient();
    this.state = { doc, activeId: topLayerId(doc.layers), selection: null };
    this.history.reset(label, this.state);
    this.savedId = -1;
    this.invalidate();
    this.fitView();
  }

  setSelection(sel: Selection | null, label?: string) {
    this.state.selection = sel;
    if (label) this.commit(label);
    else {
      this.requestFrame();
      this.emit();
    }
  }

  /** Adjustment settings shown/edited (preview overrides the stored ones). */
  adjOf(l: AdjustLayer) {
    return this.adjPreview && this.adjPreview.layerId === l.id ? this.adjPreview.adj : l.adj;
  }

  isPaintable(l: Layer | null): l is PixelLayer {
    return isPixelLayer(l);
  }
}

export function topLayerId(layers: Layer[]): string | null {
  return layers.length ? layers[layers.length - 1].id : null;
}

/** Document-space matrix for a floating transform. */
export function transformMatrix(t: TransformState): DOMMatrix {
  return new DOMMatrix().translate(t.cx, t.cy).rotate((t.angle * 180) / Math.PI).scale(t.sx, t.sy).translate(-t.float.width / 2, -t.float.height / 2);
}
export function transformCorners(t: TransformState): Pt[] {
  const m = transformMatrix(t);
  const w = t.float.width,
    h = t.float.height;
  return [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h]
  ].map(([x, y]) => {
    const p = m.transformPoint(new DOMPoint(x, y));
    return { x: p.x, y: p.y };
  });
}
export function transformedBounds(t: TransformState): Rect {
  const c = transformCorners(t);
  const x0 = Math.floor(Math.min(...c.map((p) => p.x))),
    y0 = Math.floor(Math.min(...c.map((p) => p.y)));
  const x1 = Math.ceil(Math.max(...c.map((p) => p.x))),
    y1 = Math.ceil(Math.max(...c.map((p) => p.y)));
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}
