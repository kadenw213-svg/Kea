// Dark pages for pictures of PDF pages (the Home previews, the PDF sidebar's thumbnails). A page is darkened by
// inverting it with its hues kept, but a mark saved into the page (a black redaction box, a filled black shape) would
// then show white. So solid dark areas, too big to be text, keep their real colour: a redaction stays black.

/** The page filter Kea's PDF viewer uses on dark pages. */
export const DARK_PAGE_FILTER = 'invert(0.9) hue-rotate(180deg)';

/**
 * Which pixels of an RGBA picture are in a solid dark area at least `minRun` pixels wide and tall (a 1 per pixel):
 * the same colour, near black, along a row and down a column. Text strokes are thinner than `minRun`, so they're not.
 */
export function solidDarkMask(data: Uint8ClampedArray, w: number, h: number, minRun: number): Uint8Array {
  const n = w * h;
  const dark = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    // (Near black and opaque: luminance under about a quarter.)
    const lum = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
    dark[i] = data[p + 3] > 200 && lum < 64 ? 1 : 0;
  }
  const same = (a: number, b: number) => Math.abs(data[a * 4] - data[b * 4]) + Math.abs(data[a * 4 + 1] - data[b * 4 + 1]) + Math.abs(data[a * 4 + 2] - data[b * 4 + 2]) < 24;
  // Along each row: runs of one dark colour at least minRun long.
  const row = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    let x = 0;
    while (x < w) {
      const i = y * w + x;
      if (!dark[i]) {
        x++;
        continue;
      }
      let e = x + 1;
      while (e < w && dark[y * w + e] && same(i, y * w + e)) e++;
      if (e - x >= minRun) row.fill(1, i, y * w + e);
      x = e;
    }
  }
  // Then down each column, among those.
  const out = new Uint8Array(n);
  for (let x = 0; x < w; x++) {
    let y = 0;
    while (y < h) {
      const i = y * w + x;
      if (!row[i]) {
        y++;
        continue;
      }
      let e = y + 1;
      while (e < h && row[e * w + x] && same(i, e * w + x)) e++;
      if (e - y >= minRun) for (let k = y; k < e; k++) out[k * w + x] = 1;
      y = e;
    }
  }
  return out;
}

/** The smallest solid area kept in its real colour: about 12 points on a letter-size page, whatever the scale. */
export const minSolid = (width: number) => Math.max(6, Math.round(width * 0.02));

/**
 * A dark copy of a rendered page: inverted with `filter`, its solid dark areas left as they are. Returns a new canvas
 * the same size (or the page darkened by the filter alone when its pixels can't be read).
 */
export function darkPageCanvas(page: HTMLCanvasElement, filter = DARK_PAGE_FILTER): HTMLCanvasElement {
  const { width: w, height: h } = page;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d')!;
  ctx.filter = filter;
  ctx.drawImage(page, 0, 0);
  ctx.filter = 'none';
  try {
    const src = page.getContext('2d')!.getImageData(0, 0, w, h);
    const mask = solidDarkMask(src.data, w, h, minSolid(w));
    if (!mask.some(Boolean)) return out;
    const dst = ctx.getImageData(0, 0, w, h);
    for (let i = 0; i < mask.length; i++)
      if (mask[i]) {
        const p = i * 4;
        dst.data[p] = src.data[p];
        dst.data[p + 1] = src.data[p + 1];
        dst.data[p + 2] = src.data[p + 2];
        dst.data[p + 3] = src.data[p + 3];
      }
    ctx.putImageData(dst, 0, 0);
  } catch {
    // (A canvas that can't be read back: the filter alone.)
  }
  return out;
}
