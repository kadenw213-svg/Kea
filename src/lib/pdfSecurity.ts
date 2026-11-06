/**
 * PDF passwords, compression, OCR and PDF → Word. Everything runs on this computer.
 * Passwords use @cantoo/pdf-lib (a pdf-lib fork that can read and write encrypted files, AES-256).
 */
import { loadImage } from './util';
import { setting } from './settings';

export interface Protection {
  userPassword: string;
  ownerPassword?: string;
  allowPrint: boolean;
  allowCopy: boolean;
  allowEdit: boolean;
}

/** Remove encryption (needs the password unless the file opens without one). */
export async function decryptPdf(bytes: Uint8Array, password?: string): Promise<Uint8Array> {
  const { PDFDocument } = await import('@cantoo/pdf-lib');
  const doc = await PDFDocument.load(bytes, { password, updateMetadata: false } as any);
  return doc.save();
}

/** Add a password (AES-256). */
export async function encryptPdf(bytes: Uint8Array, p: Protection): Promise<Uint8Array> {
  const { PDFDocument } = await import('@cantoo/pdf-lib');
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  doc.encrypt({
    userPassword: p.userPassword,
    ownerPassword: p.ownerPassword || p.userPassword + '\u0000owner',
    permissions: {
      printing: p.allowPrint ? 'highResolution' : false,
      copying: p.allowCopy,
      modifying: p.allowEdit,
      annotating: p.allowEdit,
      fillingForms: true,
      contentAccessibility: true,
      documentAssembly: p.allowEdit
    }
  });
  return doc.save();
}

/**
 * Make a PDF smaller: re-compress photos (JPEG images) at a lower resolution and quality, and pack
 * the file's structure more tightly. Text and vector graphics are untouched.
 */
export async function compressPdf(bytes: Uint8Array, level: 'light' | 'strong', onProgress?: (msg: string) => void): Promise<Uint8Array> {
  const { PDFDocument, PDFName, PDFRawStream, PDFNumber } = await import('pdf-lib');
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const strong = level === 'strong';
  const maxSide = Number(setting(strong ? 'pdf.compressStrongSize' : 'pdf.compressLightSize')) || (strong ? 1200 : 2000);
  const quality = (Number(setting(strong ? 'pdf.compressStrongQuality' : 'pdf.compressLightQuality')) || (strong ? 60 : 78)) / 100;
  const objects = doc.context.enumerateIndirectObjects();
  let done = 0;
  for (const [ref, obj] of objects) {
    if (!(obj instanceof PDFRawStream)) continue;
    const dict = obj.dict;
    if (dict.get(PDFName.of('Subtype')) !== PDFName.of('Image')) continue;
    const filter = dict.get(PDFName.of('Filter'));
    if (filter !== PDFName.of('DCTDecode')) continue; // only JPEG photos are re-encoded
    if (dict.get(PDFName.of('SMask')) || dict.get(PDFName.of('Mask'))) continue;
    const cs = dict.get(PDFName.of('ColorSpace'));
    if (cs !== PDFName.of('DeviceRGB') && cs !== PDFName.of('DeviceGray')) continue;
    const orig = obj.contents;
    try {
      const url = URL.createObjectURL(new Blob([orig as BlobPart], { type: 'image/jpeg' }));
      const img = await loadImage(url);
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      if (cs === PDFName.of('DeviceGray')) {
        const d = ctx.getImageData(0, 0, w, h);
        for (let i = 0; i < d.data.length; i += 4) d.data[i] = d.data[i + 1] = d.data[i + 2] = Math.round(0.299 * d.data[i] + 0.587 * d.data[i + 1] + 0.114 * d.data[i + 2]);
        ctx.putImageData(d, 0, 0);
      }
      const blob: Blob = await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('encode'))), 'image/jpeg', quality));
      const smaller = new Uint8Array(await blob.arrayBuffer());
      if (smaller.length >= orig.length * 0.95) continue;
      dict.set(PDFName.of('Width'), PDFNumber.of(w));
      dict.set(PDFName.of('Height'), PDFNumber.of(h));
      dict.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB'));
      dict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
      dict.delete(PDFName.of('DecodeParms'));
      doc.context.assign(ref, PDFRawStream.of(dict, smaller));
      done++;
      onProgress?.(`Compressed ${done} image${done > 1 ? 's' : ''}…`);
    } catch {
      /* leave images that can't be decoded as they are */
    }
  }
  return doc.save({ useObjectStreams: true });
}

// ---------- OCR ----------
let ocrWorker: Promise<any> | null = null;
async function getOcrWorker(onProgress?: (p: number) => void) {
  if (!ocrWorker) {
    ocrWorker = (async () => {
      const { createWorker } = await import('tesseract.js');
      const base = new URL('./tesseract/', window.location.href).href;
      return createWorker('eng', 1, {
        workerPath: base + 'worker.min.js',
        corePath: base,
        langPath: base + 'lang',
        gzip: true,
        cacheMethod: 'none',
        workerBlobURL: false,
        logger: (m: any) => m.status === 'recognizing text' && onProgress?.(m.progress)
      });
    })().catch((err) => {
      ocrWorker = null;
      throw err;
    });
  }
  return ocrWorker;
}

/**
 * Make a scanned PDF searchable: read each page with OCR and lay invisible text over it, so the words
 * can be found, selected and copied (the page looks exactly the same).
 */
export async function ocrPdf(bytes: Uint8Array, onProgress?: (msg: string) => void): Promise<{ bytes: Uint8Array; words: number }> {
  const { loadPdf } = await import('../editors/pdf/pdfjs');
  const { PDFDocument, StandardFonts, degrees } = await import('pdf-lib');
  const worker = await getOcrWorker();
  const src = await loadPdf(bytes);
  const out = await PDFDocument.load(bytes, { updateMetadata: false });
  const font = await out.embedFont(StandardFonts.Helvetica);
  let total = 0;
  const minConf = Number(setting('pdf.ocrConfidence') ?? 30);
  try {
    for (let i = 1; i <= src.numPages; i++) {
      onProgress?.(`Reading page ${i} of ${src.numPages}…`);
      const page = await src.getPage(i);
      const base = page.getViewport({ scale: 1 });
      // Scan resolution from Settings → PDF, capped for very large pages.
      const dpi = Number(setting('pdf.ocrDpi')) || 225;
      // Pages bigger than letter are scanned as if they were 11 inches tall, to keep memory in check.
      const scale = Math.min(dpi / 72, (dpi * 11) / Math.max(base.width, base.height));
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const { data } = await worker.recognize(canvas, {}, { blocks: true });
      const target = out.getPage(i - 1);
      const crop = target.getCropBox();
      const rot = (((target.getRotation().angle % 360) + 360) % 360) as number;
      const words: any[] = (data.blocks || []).flatMap((b: any) => b.paragraphs.flatMap((p: any) => p.lines.flatMap((l: any) => l.words)));
      for (const w of words) {
        const text = String(w.text || '').trim();
        if (!text || w.confidence < minConf) continue;
        // Canvas pixels → PDF points (y up). Only unrotated pages get positioned text.
        if (rot !== 0) continue;
        const x = crop.x + w.bbox.x0 / scale;
        const hPt = (w.bbox.y1 - w.bbox.y0) / scale;
        const y = crop.y + crop.height - w.bbox.y1 / scale + hPt * 0.2;
        const size = Math.max(4, hPt * 0.9);
        const safe = text.replace(/[^\x20-\x7e]/g, '?');
        const natural = font.widthOfTextAtSize(safe, size) || 1;
        const widthPt = (w.bbox.x1 - w.bbox.x0) / scale;
        // Invisible text (opacity 0) sized to cover the word, so selection matches the picture.
        target.drawText(safe, { x, y, size: size * Math.min(3, Math.max(0.3, widthPt / natural)), font, opacity: 0, rotate: degrees(0) });
        total++;
      }
    }
  } finally {
    src.destroy();
  }
  return { bytes: await out.save(), words: total };
}

// ---------- PDF → Word ----------
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Turn a PDF's text into document HTML: paragraphs, headings (by size), bold and italic. */
export async function pdfToDocHtml(bytes: Uint8Array): Promise<string> {
  const { loadPdf } = await import('../editors/pdf/pdfjs');
  const pdf = await loadPdf(bytes);
  const parts: string[] = [];
  try {
    // Most common text size = body text.
    const sizes = new Map<number, number>();
    const pages: { items: any[]; styles: any }[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      pages.push({ items: tc.items as any[], styles: tc.styles });
      for (const it of tc.items as any[]) {
        const s = Math.round(Math.hypot(it.transform[2], it.transform[3]));
        if (it.str.trim()) sizes.set(s, (sizes.get(s) || 0) + it.str.length);
      }
    }
    const body = [...sizes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 11;
    for (const [pi, { items, styles }] of pages.entries()) {
      // Group into lines by baseline.
      const lines: { y: number; x: number; size: number; text: string; bold: boolean; italic: boolean }[] = [];
      for (const it of items) {
        if (!it.str) continue;
        const y = it.transform[5];
        const x = it.transform[4];
        const size = Math.round(Math.hypot(it.transform[2], it.transform[3]));
        const fam = String(styles[it.fontName]?.fontFamily || '') + ' ' + String(it.fontName || '');
        const last = lines[lines.length - 1];
        if (last && Math.abs(last.y - y) < size * 0.5) {
          last.text += (last.text.endsWith(' ') || it.str.startsWith(' ') ? '' : x - last.x > size * 0.25 ? ' ' : '') + it.str;
          last.x = x + (it.width || 0);
        } else lines.push({ y, x: x + (it.width || 0), size, text: it.str, bold: /bold|black|heavy/i.test(fam), italic: /italic|oblique/i.test(fam) });
      }
      // Group lines into paragraphs by vertical gaps.
      let para: typeof lines = [];
      const flush = () => {
        if (!para.length) return;
        const text = para.map((l) => l.text.trim()).join(' ').replace(/\s+/g, ' ').replace(/- (\w)/g, '$1').trim();
        if (text) {
          const size = Math.max(...para.map((l) => l.size));
          const bold = para.every((l) => l.bold);
          const italic = para.every((l) => l.italic);
          let inner = esc(text);
          if (italic) inner = `<em>${inner}</em>`;
          if (size >= body * 1.6) parts.push(`<h1>${inner}</h1>`);
          else if (size >= body * 1.25 || (bold && text.length < 90)) parts.push(`<h2>${inner}</h2>`);
          else parts.push(`<p>${bold ? `<strong>${inner}</strong>` : inner}</p>`);
        }
        para = [];
      };
      for (let k = 0; k < lines.length; k++) {
        const l = lines[k];
        const prev = lines[k - 1];
        if (prev && (prev.y - l.y > Math.max(prev.size, l.size) * 1.6 || Math.abs(prev.size - l.size) > 1.5 || l.y > prev.y)) flush();
        para.push(l);
      }
      flush();
      if (pi < pages.length - 1) parts.push('<div data-type="page-break"></div>');
    }
  } finally {
    pdf.destroy();
  }
  return parts.join('') || '<p></p>';
}
