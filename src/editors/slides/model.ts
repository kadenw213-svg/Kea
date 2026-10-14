import { uid } from '../../lib/util';

/**
 * Slide coordinates are points (1/72 in). A 16:9 slide is 960 × 540.
 * Text HTML inside elements uses px values that equal points in slide space.
 */
export type ShapeKind = 'none' | 'rect' | 'roundRect' | 'ellipse' | 'triangle' | 'line' | 'arrow';

export interface El {
  id: string;
  type: 'text' | 'shape' | 'image';
  x: number;
  y: number;
  w: number;
  h: number;
  rot?: number;
  shape?: ShapeKind;
  fill?: string | null;
  stroke?: string | null;
  strokeW?: number;
  html?: string;
  valign?: 'top' | 'middle' | 'bottom';
  size?: number; // default font size (pt)
  color?: string; // default text colour
  font?: string;
  src?: string; // image data URL
  locked?: boolean; // background art inherited from layouts/masters
  role?: 'title' | 'body' | 'subtitle';
  flipH?: boolean;
  flipV?: boolean;
}

export type TransitionType = 'none' | 'fade' | 'push' | 'wipe' | 'zoom' | 'cover';
export interface Transition {
  type: TransitionType;
  /** Seconds. */
  duration: number;
}

export interface Slide {
  id: string;
  bg: string;
  els: El[];
  notes: string;
  transition?: Transition;
}

export interface Deck {
  w: number;
  h: number;
  slides: Slide[];
  font: string;
}

export interface Theme {
  name: string;
  bg: string;
  title: string;
  text: string;
  accent: string;
  font: string;
}

export const THEMES: Theme[] = [
  { name: 'Slate', bg: '#1b1c1d', title: '#e3e3e3', text: '#c4c7c5', accent: '#a8c7fa', font: 'Segoe UI' },
  { name: 'Paper', bg: '#ffffff', title: '#202124', text: '#3c4043', accent: '#1a73e8', font: 'Arial' },
  { name: 'Midnight', bg: '#0b1d3a', title: '#ffffff', text: '#c9d7f2', accent: '#7cacf8', font: 'Segoe UI' },
  { name: 'Ember', bg: '#2b1b17', title: '#ffe7d6', text: '#f1cdb8', accent: '#f6b26b', font: 'Georgia' },
  { name: 'Mint', bg: '#f1faf5', title: '#0d3b2e', text: '#2d5a4b', accent: '#1e8e3e', font: 'Calibri' }
];

export const textEl = (p: Partial<El> & { x: number; y: number; w: number; h: number }): El => ({
  id: uid(),
  type: 'text',
  shape: 'none',
  fill: null,
  stroke: null,
  strokeW: 0,
  valign: 'top',
  html: '<p></p>',
  ...p
});

export function layoutSlide(kind: 'title' | 'content' | 'section' | 'blank' | 'two', theme: Theme, w = 960, h = 540): Slide {
  const m = w * 0.075;
  const els: El[] = [];
  if (kind === 'title') {
    els.push(textEl({ x: m, y: h * 0.32, w: w - 2 * m, h: h * 0.2, role: 'title', size: 48, color: theme.title, font: theme.font, valign: 'bottom', html: '<p style="text-align:center"><b>Click to add title</b></p>' }));
    els.push(textEl({ x: m, y: h * 0.55, w: w - 2 * m, h: h * 0.12, role: 'subtitle', size: 24, color: theme.text, font: theme.font, html: '<p style="text-align:center">Click to add subtitle</p>' }));
  } else if (kind === 'section') {
    els.push(textEl({ x: m, y: h * 0.38, w: w - 2 * m, h: h * 0.2, role: 'title', size: 44, color: theme.title, font: theme.font, valign: 'middle', html: '<p><b>Section title</b></p>' }));
    els.push({ id: uid(), type: 'shape', shape: 'rect', x: m, y: h * 0.6, w: 96, h: 5, fill: theme.accent, stroke: null, strokeW: 0 });
  } else if (kind === 'content' || kind === 'two') {
    els.push(textEl({ x: m, y: h * 0.07, w: w - 2 * m, h: h * 0.16, role: 'title', size: 36, color: theme.title, font: theme.font, valign: 'middle', html: '<p><b>Click to add title</b></p>' }));
    if (kind === 'content') {
      els.push(textEl({ x: m, y: h * 0.27, w: w - 2 * m, h: h * 0.63, role: 'body', size: 24, color: theme.text, font: theme.font, html: '<ul><li>Click to add text</li></ul>' }));
    } else {
      const cw = (w - 2 * m - 32) / 2;
      els.push(textEl({ x: m, y: h * 0.27, w: cw, h: h * 0.63, role: 'body', size: 22, color: theme.text, font: theme.font, html: '<ul><li>Left column</li></ul>' }));
      els.push(textEl({ x: m + cw + 32, y: h * 0.27, w: cw, h: h * 0.63, role: 'body', size: 22, color: theme.text, font: theme.font, html: '<ul><li>Right column</li></ul>' }));
    }
  }
  return { id: uid(), bg: theme.bg, els, notes: '' };
}

export function newDeck(theme = THEMES[0]): Deck {
  return { w: 960, h: 540, font: theme.font, slides: [layoutSlide('title', theme)] };
}

export function cloneSlide(s: Slide): Slide {
  return { ...s, id: uid(), els: s.els.map((e) => ({ ...e, id: uid() })) };
}
