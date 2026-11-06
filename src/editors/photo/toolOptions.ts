import type { ShapeType } from './types';
import type { SelMode } from './selection';

/** Tool ids, the tool strip's groups and shortcuts, and each tool's settings. */

export type ToolId =
  | 'move'
  | 'marquee-rect'
  | 'marquee-ellipse'
  | 'lasso'
  | 'lasso-poly'
  | 'wand'
  | 'quick'
  | 'crop'
  | 'eyedropper'
  | 'brush'
  | 'pencil'
  | 'eraser'
  | 'bucket'
  | 'gradient'
  | 'clone'
  | 'heal'
  | 'dodge'
  | 'burn'
  | 'blur'
  | 'sharpen'
  | 'smudge'
  | 'text'
  | 'shape'
  | 'hand'
  | 'zoom';

export const TOOL_NAMES: Record<ToolId, string> = {
  move: 'Move',
  'marquee-rect': 'Rectangular marquee',
  'marquee-ellipse': 'Elliptical marquee',
  lasso: 'Lasso',
  'lasso-poly': 'Polygonal lasso',
  wand: 'Magic wand',
  quick: 'Quick selection',
  crop: 'Crop',
  eyedropper: 'Eyedropper',
  brush: 'Brush',
  pencil: 'Pencil',
  eraser: 'Eraser',
  bucket: 'Paint bucket',
  gradient: 'Gradient',
  clone: 'Clone stamp',
  heal: 'Spot healing brush',
  dodge: 'Dodge',
  burn: 'Burn',
  blur: 'Blur',
  sharpen: 'Sharpen',
  smudge: 'Smudge',
  text: 'Text',
  shape: 'Shape',
  hand: 'Hand',
  zoom: 'Zoom'
};

/** Tool strip slots, in order. The key picks the slot; Shift+key cycles within it (like Photoshop). */
export const TOOL_GROUPS: { key: string; tools: ToolId[] }[] = [
  { key: 'V', tools: ['move'] },
  { key: 'M', tools: ['marquee-rect', 'marquee-ellipse'] },
  { key: 'L', tools: ['lasso', 'lasso-poly'] },
  { key: 'W', tools: ['quick', 'wand'] },
  { key: 'C', tools: ['crop'] },
  { key: 'I', tools: ['eyedropper'] },
  { key: 'J', tools: ['heal'] },
  { key: 'B', tools: ['brush', 'pencil'] },
  { key: 'S', tools: ['clone'] },
  { key: 'E', tools: ['eraser'] },
  { key: 'G', tools: ['gradient', 'bucket'] },
  { key: 'R', tools: ['blur', 'sharpen', 'smudge'] },
  { key: 'O', tools: ['dodge', 'burn'] },
  { key: 'T', tools: ['text'] },
  { key: 'U', tools: ['shape'] },
  { key: 'H', tools: ['hand'] },
  { key: 'Z', tools: ['zoom'] }
];

export interface BrushOpts {
  size: number;
  hardness: number;
  opacity: number;
  flow: number;
  smoothing: number;
  pressureSize: boolean;
  pressureOpacity: boolean;
}

export type GradientPreset = 'fg-bg' | 'fg-transparent' | 'black-white' | 'rainbow' | 'sunset' | 'chrome';

export interface ToolOptions {
  selMode: SelMode;
  feather: number;
  antialias: boolean;
  /** Fixed aspect ratio for marquees and crop ("" = free, else "w:h"). */
  ratio: string;
  wandTolerance: number;
  wandContiguous: boolean;
  sampleAll: boolean;
  quickSize: number;
  brush: BrushOpts;
  pencil: BrushOpts;
  eraser: BrushOpts;
  clone: BrushOpts & { aligned: boolean; sampleAll: boolean };
  heal: BrushOpts;
  toning: BrushOpts & { range: 'shadows' | 'midtones' | 'highlights'; exposure: number };
  focus: BrushOpts & { strength: number };
  bucket: { tolerance: number; contiguous: boolean; sampleAll: boolean; opacity: number; antialias: boolean };
  gradient: { type: 'linear' | 'radial'; preset: GradientPreset; reverse: boolean; opacity: number };
  text: { font: string; size: number; bold: boolean; italic: boolean; align: 'left' | 'center' | 'right'; leading: number };
  shape: { type: ShapeType; fillOn: boolean; strokeOn: boolean; stroke: string; strokeWidth: number; sides: number; radius: number };
  move: { autoSelect: boolean };
  eyedropper: { size: 1 | 3 | 5; sampleAll: boolean };
}

const brush = (size: number, hardness: number): BrushOpts => ({ size, hardness, opacity: 1, flow: 1, smoothing: 0.2, pressureSize: true, pressureOpacity: false });

export function defaultToolOptions(): ToolOptions {
  return {
    selMode: 'new',
    feather: 0,
    antialias: true,
    ratio: '',
    wandTolerance: 32,
    wandContiguous: true,
    sampleAll: true,
    quickSize: 30,
    brush: brush(20, 0.8),
    pencil: { ...brush(1, 1), smoothing: 0 },
    eraser: brush(30, 0.8),
    clone: { ...brush(40, 0.5), aligned: true, sampleAll: false },
    heal: { ...brush(24, 0.6), smoothing: 0 },
    toning: { ...brush(50, 0.3), range: 'midtones', exposure: 0.5, pressureSize: false },
    focus: { ...brush(40, 0.4), strength: 0.5, pressureSize: false },
    bucket: { tolerance: 32, contiguous: true, sampleAll: false, opacity: 1, antialias: true },
    gradient: { type: 'linear', preset: 'fg-bg', reverse: false, opacity: 1 },
    text: { font: 'Inter', size: 48, bold: false, italic: false, align: 'left', leading: 1.2 },
    shape: { type: 'rect', fillOn: true, strokeOn: false, stroke: '#000000', strokeWidth: 4, sides: 6, radius: 0 },
    move: { autoSelect: false },
    eyedropper: { size: 1, sampleAll: true }
  };
}

/** Which brush settings a painting tool uses (null for tools without a brush). */
export function brushKey(t: ToolId): 'brush' | 'pencil' | 'eraser' | 'clone' | 'heal' | 'toning' | 'focus' | null {
  switch (t) {
    case 'brush':
    case 'pencil':
    case 'eraser':
    case 'clone':
    case 'heal':
      return t;
    case 'dodge':
    case 'burn':
      return 'toning';
    case 'blur':
    case 'sharpen':
    case 'smudge':
      return 'focus';
  }
  return null;
}
