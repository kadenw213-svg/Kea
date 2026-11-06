import type { Doc, Layer, RasterLayer } from './types';
import type { Engine } from './engine';
import { makeCanvas, filledCanvas, canvasToBytes } from './canvas';
import { readPsdDoc, writePsdDoc } from './psd';
import { extOf } from '../../lib/fileTypes';
import { mimeFor } from '../../lib/pdfTools';
import { loadImage, uid } from '../../lib/util';

/** Opening and saving image files. */

export const OPENABLE = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'ico', 'psd'];

export function rasterLayer(name: string, canvas: HTMLCanvasElement): RasterLayer {
  return { kind: 'raster', id: uid(), name, visible: true, locked: false, opacity: 1, fill: 1, blend: 'normal', clip: false, mask: null, canvas, x: 0, y: 0 };
}

export type Background = 'white' | 'black' | 'transparent' | string;
export function blankDoc(w: number, h: number, bg: Background = 'white'): Doc {
  const c = bg === 'transparent' ? makeCanvas(w, h) : filledCanvas(w, h, bg === 'white' ? '#ffffff' : bg === 'black' ? '#000000' : bg);
  return { w: c.width, h: c.height, layers: [rasterLayer(bg === 'transparent' ? 'Layer 1' : 'Background', c)] };
}

/** Decode any supported file into a document (PSD keeps its layers; GIFs open their first frame). */
export async function decodeFile(name: string, bytes: Uint8Array): Promise<Doc> {
  const ext = extOf(name);
  const isPsd = ext === 'psd' || (bytes[0] === 0x38 && bytes[1] === 0x42 && bytes[2] === 0x50 && bytes[3] === 0x53);
  if (isPsd) return readPsdDoc(bytes);
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeFor(name) }));
  try {
    const img = await loadImage(url);
    let w = img.naturalWidth,
      h = img.naturalHeight;
    // SVGs without a size get a sensible one.
    if (!w || !h) {
      w = 1024;
      h = 1024;
    }
    const c = makeCanvas(w, h);
    c.getContext('2d')!.drawImage(img, 0, 0, w, h);
    return { w, h, layers: [rasterLayer('Background', c)] };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Load a file (or clipboard image) as a canvas, for "Place image". */
export async function decodeToCanvas(name: string, bytes: Uint8Array): Promise<HTMLCanvasElement> {
  const doc = await decodeFile(name, bytes);
  if (doc.layers.length === 1 && doc.layers[0].kind === 'raster' && !doc.layers[0].x && !doc.layers[0].y) return doc.layers[0].canvas;
  const { renderDoc } = await import('./render');
  const c = makeCanvas(doc.w, doc.h);
  renderDoc(doc, { w: doc.w, h: doc.h, source: (l) => l }, c);
  return c;
}

/** True when saving to PNG/JPEG would lose something (layers, masks, text, adjustments, blending). */
export function isLayered(doc: Doc): boolean {
  if (doc.layers.length > 1) return true;
  const l: Layer | undefined = doc.layers[0];
  if (!l) return false;
  return l.kind !== 'raster' || !!l.mask || l.opacity < 1 || l.fill < 1 || l.blend !== 'normal' || !l.visible;
}

export async function encode(e: Engine, ext: string, quality = 0.92): Promise<Uint8Array> {
  const comp = e.flush();
  if (ext === 'psd') return writePsdDoc(e.doc, comp);
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
  let c = comp;
  if (mime === 'image/jpeg') {
    // JPEG has no transparency: put the picture on white.
    c = filledCanvas(comp.width, comp.height, '#ffffff');
    c.getContext('2d')!.drawImage(comp, 0, 0);
  }
  return canvasToBytes(c, mime, quality);
}
