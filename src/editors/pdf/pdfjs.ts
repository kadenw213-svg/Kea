import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjsLib };
export type { PDFDocumentProxy, PDFPageProxy };

const assetBase = () => new URL('./pdfjs/', window.location.href).href;

export class PasswordError extends Error {
  constructor(public incorrect: boolean) {
    super(incorrect ? 'Incorrect password' : 'Password required');
  }
}

export async function loadPdf(bytes: Uint8Array, password?: string): Promise<PDFDocumentProxy> {
  const task = pdfjsLib.getDocument({
    // pdf.js transfers the buffer to its worker, so hand it a copy.
    data: bytes.slice(),
    password,
    isEvalSupported: false,
    cMapUrl: assetBase() + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: assetBase() + 'standard_fonts/'
  });
  try {
    return await task.promise;
  } catch (err: any) {
    if (err?.name === 'PasswordException') throw new PasswordError(err.code === 2);
    throw err;
  }
}

export interface TextItemRect {
  str: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
  family: 'sans-serif' | 'serif' | 'monospace';
  fontName: string;
  horizontal: boolean;
  /** Baseline origin of the run. */
  baseX: number;
  baseY: number;
}

/** Text items with axis-aligned boxes in viewport points (scale 1, given rotation). */
export async function getTextRects(page: PDFPageProxy, rotation: number): Promise<TextItemRect[]> {
  const vp = page.getViewport({ scale: 1, rotation });
  const tc = await page.getTextContent();
  const out: TextItemRect[] = [];
  for (const item of tc.items as any[]) {
    if (!item.str || !item.str.trim()) continue;
    const tx = pdfjsLib.Util.transform(vp.transform, item.transform);
    const fh = Math.hypot(tx[2], tx[3]);
    const style = tc.styles[item.fontName] || {};
    const asc = style.ascent ? fh * style.ascent : style.descent ? fh * (1 + style.descent) : fh * 0.8;
    const len = Math.hypot(tx[0], tx[1]) || 1;
    const d = [tx[0] / len, tx[1] / len];
    const up = [d[1], -d[0]];
    const w = item.width * vp.scale * (item.dir === 'ttb' ? 0 : 1);
    const ox = tx[4],
      oy = tx[5];
    const desc = fh - asc;
    const pts = [
      [ox + up[0] * asc, oy + up[1] * asc],
      [ox + d[0] * w + up[0] * asc, oy + d[1] * w + up[1] * asc],
      [ox - up[0] * desc, oy - up[1] * desc],
      [ox + d[0] * w - up[0] * desc, oy + d[1] * w - up[1] * desc]
    ];
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const fam = String(style.fontFamily || 'sans-serif');
    out.push({
      str: item.str,
      x: Math.min(...xs),
      y: Math.min(...ys),
      w: Math.max(...xs) - Math.min(...xs),
      h: Math.max(...ys) - Math.min(...ys),
      fontSize: fh,
      family: fam.includes('mono') ? 'monospace' : fam.includes('serif') && !fam.includes('sans') ? 'serif' : 'sans-serif',
      fontName: item.fontName,
      horizontal: Math.abs(d[1]) < 0.01 && d[0] > 0,
      baseX: ox,
      baseY: oy
    });
  }
  return out;
}
