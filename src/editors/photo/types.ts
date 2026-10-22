/**
 * Photo editor document model. Layers are plain objects that point at canvases;
 * canvases are treated as copy-on-write (see history.ts), so history snapshots can
 * share them with the live document instead of copying pixels.
 */

export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'color-dodge'
  | 'color-burn'
  | 'hard-light'
  | 'soft-light'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity';
/** Groups can also pass through: their contents blend straight onto what is below. */
export type LayerBlend = BlendMode | 'pass-through';

export const BLEND_MODES: { id: BlendMode; label: string }[] = [
  { id: 'normal', label: 'Normal' },
  { id: 'darken', label: 'Darken' },
  { id: 'multiply', label: 'Multiply' },
  { id: 'color-burn', label: 'Color burn' },
  { id: 'lighten', label: 'Lighten' },
  { id: 'screen', label: 'Screen' },
  { id: 'color-dodge', label: 'Color dodge' },
  { id: 'overlay', label: 'Overlay' },
  { id: 'soft-light', label: 'Soft light' },
  { id: 'hard-light', label: 'Hard light' },
  { id: 'difference', label: 'Difference' },
  { id: 'exclusion', label: 'Exclusion' },
  { id: 'hue', label: 'Hue' },
  { id: 'saturation', label: 'Saturation' },
  { id: 'color', label: 'Color' },
  { id: 'luminosity', label: 'Luminosity' }
];

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Pt {
  x: number;
  y: number;
}

/**
 * A layer mask: an opaque grayscale canvas (white shows the layer, black hides it)
 * placed at x/y in document pixels. Outside the canvas the mask is `outside` (0 or 255).
 */
export interface Mask {
  canvas: HTMLCanvasElement;
  x: number;
  y: number;
  enabled: boolean;
  /** Moves with the layer. */
  linked: boolean;
  outside: number;
}

interface LayerBase {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  /** 0–1, applies to the whole layer. */
  opacity: number;
  /** 0–1, applies to the layer's own pixels (same as opacity here, since there are no layer styles). */
  fill: number;
  blend: LayerBlend;
  /** Clipped to the nearest unclipped layer below it. */
  clip: boolean;
  mask: Mask | null;
}

export interface RasterLayer extends LayerBase {
  kind: 'raster';
  canvas: HTMLCanvasElement;
  x: number;
  y: number;
}

export interface TextData {
  text: string;
  font: string;
  size: number;
  color: string;
  bold: boolean;
  italic: boolean;
  align: 'left' | 'center' | 'right';
  /** Line height as a multiple of the font size. */
  leading: number;
  /** Anchor point: the top of the first line, at the left / centre / right edge depending on `align`. */
  x: number;
  y: number;
}

export interface TextLayer extends LayerBase {
  kind: 'text';
  text: TextData;
  /** Rendered pixels (rebuilt whenever `text` changes). */
  canvas: HTMLCanvasElement;
  x: number;
  y: number;
}

export type ShapeType = 'rect' | 'ellipse' | 'line' | 'polygon';
export interface ShapeData {
  type: ShapeType;
  /** Bounding box corners (or the line's two ends). */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  sides: number;
  radius: number;
  fill: string | null;
  stroke: string | null;
  strokeWidth: number;
}

export interface ShapeLayer extends LayerBase {
  kind: 'shape';
  shape: ShapeData;
  canvas: HTMLCanvasElement;
  x: number;
  y: number;
}

export type AdjType =
  | 'brightness'
  | 'levels'
  | 'curves'
  | 'exposure'
  | 'vibrance'
  | 'hueSat'
  | 'colorBalance'
  | 'bw'
  | 'photoFilter'
  | 'channelMixer'
  | 'invert'
  | 'posterize'
  | 'threshold'
  | 'gradientMap'
  | 'selectiveColor';

/** Adjustment settings: `type` plus that adjustment's own fields (see ADJ_DEFAULTS in adjustments.ts). */
export interface Adjustment {
  type: AdjType;
  [key: string]: any;
}

export interface AdjustLayer extends LayerBase {
  kind: 'adjust';
  adj: Adjustment;
}

export interface GroupLayer extends LayerBase {
  kind: 'group';
  /** Bottom to top. */
  children: Layer[];
  open: boolean;
}

export type Layer = RasterLayer | TextLayer | ShapeLayer | AdjustLayer | GroupLayer;
/** Layers that hold pixels on a canvas. */
export type PixelLayer = RasterLayer | TextLayer | ShapeLayer;

export type FilterType =
  | 'gaussian'
  | 'box'
  | 'motion'
  | 'radial'
  | 'unsharp'
  | 'sharpen'
  | 'noise'
  | 'median'
  | 'pixelate'
  | 'emboss'
  | 'edges'
  | 'oil'
  | 'vignette'
  | 'offset';
export interface Filter {
  type: FilterType;
  [key: string]: any;
}

/** A selection: a document-sized canvas whose alpha is how selected each pixel is. */
export interface Selection {
  canvas: HTMLCanvasElement;
  bounds: Rect;
}

export interface Doc {
  w: number;
  h: number;
  /** Bottom to top. */
  layers: Layer[];
}

/** Everything that undo/redo restores. */
export interface DocState {
  doc: Doc;
  activeId: string | null;
  selection: Selection | null;
}

export const isPixelLayer = (l: Layer | null | undefined): l is PixelLayer => !!l && (l.kind === 'raster' || l.kind === 'text' || l.kind === 'shape');
