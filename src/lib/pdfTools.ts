import { PDFDocument } from 'pdf-lib';
import { extOf } from './fileTypes';
import type { FileEntry } from './api';

export async function mergePdfs(files: Uint8Array[]): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  for (const bytes of files) {
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }
  return out.save();
}

/** Convert any browser-decodable image to PNG bytes (for formats pdf-lib can't embed directly). */
export async function imageToPng(bytes: Uint8Array, mime: string): Promise<{ png: Uint8Array; width: number; height: number }> {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth || 800;
    c.height = img.naturalHeight || 600;
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), 'image/png'));
    return { png: new Uint8Array(await blob.arrayBuffer()), width: c.width, height: c.height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function mimeFor(name: string): string {
  const e = extOf(name);
  return (
    {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      bmp: 'image/bmp',
      svg: 'image/svg+xml',
      ico: 'image/x-icon'
    }[e] || 'application/octet-stream'
  );
}

/** Each image becomes one page sized to fit Letter, preserving aspect ratio. */
export async function imagesToPdf(files: FileEntry[]): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  const PW = 612,
    PH = 792,
    M = 36;
  for (const f of files) {
    const ext = extOf(f.name);
    const img =
      ext === 'png'
        ? await out.embedPng(f.data)
        : ext === 'jpg' || ext === 'jpeg'
          ? await out.embedJpg(f.data)
          : await out.embedPng((await imageToPng(f.data, mimeFor(f.name))).png);
    const landscape = img.width > img.height;
    const pw = landscape ? PH : PW;
    const ph = landscape ? PW : PH;
    const s = Math.min((pw - 2 * M) / img.width, (ph - 2 * M) / img.height, 1);
    const w = img.width * s,
      h = img.height * s;
    const page = out.addPage([pw, ph]);
    page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
  }
  return out.save();
}
