/**
 * All annotation geometry is stored in "viewport points": PDF points at
 * scale 1, top-left origin, in the page's *current* displayed rotation.
 * save.ts maps these back to PDF user space.
 */

export type Tool =
  | 'select'
  | 'edittext'
  | 'text'
  | 'highlight'
  | 'underline'
  | 'strike'
  | 'ink'
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'whiteout'
  | 'redact'
  | 'note';

export type FontFamily = 'Helvetica' | 'Times' | 'Courier';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Base {
  id: string;
  pageId: string;
}

export interface TextAnn extends Base, Box {
  type: 'text';
  text: string;
  fontSize: number;
  font: FontFamily;
  bold: boolean;
  italic: boolean;
  color: string;
  align: 'left' | 'center' | 'right';
  /** Optional solid background. */
  bg?: string | null;
  /** Width follows the text until the user resizes the box. */
  auto?: boolean;
}

export interface ShapeAnn extends Base, Box {
  /** 'redact' boxes permanently remove everything underneath when the PDF is saved. */
  type: 'rect' | 'ellipse' | 'whiteout' | 'redact';
  stroke: string | null;
  fill: string | null;
  strokeWidth: number;
  opacity: number;
}

export interface MarkupAnn extends Base {
  type: 'highlight' | 'underline' | 'strike';
  rects: Box[];
  color: string;
  opacity: number;
}

export interface InkAnn extends Base {
  type: 'ink';
  points: number[]; // flat [x0, y0, x1, y1, ...]
  color: string;
  width: number;
  opacity: number;
}

export interface LineAnn extends Base {
  type: 'line' | 'arrow';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  width: number;
  opacity: number;
}

export interface ImageAnn extends Base, Box {
  type: 'image';
  dataUrl: string;
  signature?: boolean;
}

export interface NoteAnn extends Base {
  type: 'note';
  x: number;
  y: number;
  text: string;
  color: string;
}

export type Annotation = TextAnn | ShapeAnn | MarkupAnn | InkAnn | LineAnn | ImageAnn | NoteAnn;

export interface PageRef {
  id: string;
  /** Index into the editor's sources; -1 = blank page. */
  src: number;
  index: number;
  /** Rotation the user added on top of the page's own /Rotate. */
  rotation: number;
  /** For blank pages. */
  width?: number;
  height?: number;
}

export interface DocState {
  pages: PageRef[];
  annots: Annotation[];
}

export interface PageInfo {
  /** Size at scale 1 including the page's own /Rotate. */
  width: number;
  height: number;
  baseRotation: number;
}

export const DEFAULTS = {
  text: { fontSize: 14, font: 'Helvetica' as FontFamily, color: '#000000' },
  highlight: '#ffd400',
  underline: '#1a73e8',
  strike: '#d93025',
  ink: '#1a73e8',
  shape: '#d93025',
  note: '#fbbc04'
};
