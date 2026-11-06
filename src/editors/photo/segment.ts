// On-device background removal / subject selection for the image editor. Runs a local segmentation model
// (src/lib/segment.ts) on the active layer and turns the resulting matte into either erased pixels, a layer mask, or a
// selection — all one undo step, reusing the editor's existing helpers. No model installed → a clear error (Settings).
import type { Engine } from './engine';
import { getPixels, canvasFromPixels, cloneCanvas, makeCanvas } from './canvas';
import { pixelTarget } from './ops';
import { selectionFrom } from './selection';
import { segment } from '../../lib/segment';

export type BgOutput = 'erase' | 'mask' | 'selection';

/** RGBA canvas, white with the matte as its alpha (for destination-in erase and for a selection). */
function alphaCanvas(alpha: Uint8Array, w: number, h: number): HTMLCanvasElement {
  const d = new ImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    d.data[i * 4] = 255;
    d.data[i * 4 + 1] = 255;
    d.data[i * 4 + 2] = 255;
    d.data[i * 4 + 3] = alpha[i];
  }
  return canvasFromPixels(d);
}
/** Opaque grayscale canvas (white = show), for a layer mask. */
function grayCanvas(alpha: Uint8Array, w: number, h: number): HTMLCanvasElement {
  const d = new ImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const v = alpha[i];
    d.data[i * 4] = v;
    d.data[i * 4 + 1] = v;
    d.data[i * 4 + 2] = v;
    d.data[i * 4 + 3] = 255;
  }
  return canvasFromPixels(d);
}

/** Remove the background from the active layer. `output`: erase the pixels, add a layer mask, or make a selection. */
export async function removeBackground(e: Engine, output: BgOutput = 'erase'): Promise<string> {
  const l = pixelTarget(e, 'remove the background from');
  const img = getPixels(l.canvas);
  e.busy = output === 'selection' ? 'Finding the subject' : 'Removing the background';
  e.emit();
  try {
    const { alpha, width, height } = await segment({ data: img.data, width: img.width, height: img.height });

    if (output === 'selection') {
      // Selection is document-sized; place the layer-space matte at the layer's offset.
      const docC = makeCanvas(e.doc.w, e.doc.h);
      docC.getContext('2d')!.drawImage(alphaCanvas(alpha, width, height), l.x, l.y);
      const sel = selectionFrom(docC);
      if (!sel) throw new Error('No subject was found.');
      e.setSelection(sel, 'Select subject');
      return 'Selected the subject.';
    }

    if (output === 'mask') {
      const maskC = makeCanvas(e.doc.w, e.doc.h);
      const g = maskC.getContext('2d')!;
      g.fillStyle = '#000';
      g.fillRect(0, 0, e.doc.w, e.doc.h);
      g.drawImage(grayCanvas(alpha, width, height), l.x, l.y);
      l.mask = { canvas: maskC, x: 0, y: 0, enabled: true, linked: true, outside: 0 };
      e.commit('Remove background (mask)');
      return 'Masked out the background — non-destructive; edit the mask to refine.';
    }

    // erase: multiply the layer's alpha by the matte.
    const c = cloneCanvas(l.canvas);
    const g = c.getContext('2d')!;
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(alphaCanvas(alpha, width, height), 0, 0);
    l.canvas = c;
    e.commit('Remove background');
    return 'Removed the background.';
  } finally {
    e.busy = null;
    e.emit();
  }
}

export const selectSubject = (e: Engine) => removeBackground(e, 'selection');
