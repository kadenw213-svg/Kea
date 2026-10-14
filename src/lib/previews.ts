import { api, FilePreview } from './api';
import { extOf, kindFor } from './fileTypes';
import { bytesToText } from './util';
import { setting } from './settings';

/**
 * Home screen previews. Each file gets a small description of its first page (an image for PDFs and
 * pictures, trimmed HTML for documents, a grid for spreadsheets, the first slide for decks). They're
 * cached on disk next to the app settings and refreshed when the file's modified time changes.
 */

const maxBytes = () => (Number(setting('home.previewMaxMb')) || 80) * 1024 * 1024;
const THUMB_W = 420;
const memory = new Map<string, FilePreview>();
const pending = new Map<string, Promise<FilePreview>>();
const queue: (() => Promise<void>)[] = [];
let running = 0;

function schedule<T>(job: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    queue.push(() => job().then(resolve, reject));
    pump();
  });
}
function pump() {
  while (running < 2 && queue.length) {
    const job = queue.shift()!;
    running++;
    job().finally(() => {
      running--;
      pump();
    });
  }
}

/** Cached preview if there is one (no file reads). */
export function cachedPreview(path: string, mtime?: number): FilePreview | undefined {
  return memory.get(path + '|' + (mtime ?? ''));
}

export function getPreview(path: string, mtime?: number): Promise<FilePreview> {
  const key = path + '|' + (mtime ?? '');
  const hit = memory.get(key);
  if (hit) return Promise.resolve(hit);
  let p = pending.get(key);
  if (!p) {
    p = (async () => {
      const stored = await api.getPreview(path).catch(() => null);
      if (stored) return stored;
      const made = await schedule(() => makePreview(path)).catch((e) => {
        console.warn('preview failed', path, e);
        return { type: 'none' } as FilePreview;
      });
      api.setPreview(path, made);
      return made;
    })();
    pending.set(key, p);
    p.then((v) => {
      memory.set(key, v);
      pending.delete(key);
    });
  }
  return p;
}

async function makePreview(path: string): Promise<FilePreview> {
  const name = path.split(/[\\/]/).pop() || path;
  const ext = extOf(name);
  if (ext === 'gdoc' || ext === 'gsheet' || ext === 'gslides') return { type: 'none' };
  const [st] = await api.statMany([path]);
  if (!st?.exists || (st.size || 0) > maxBytes()) return { type: 'none' };
  const { data } = await api.readFile(path);
  const kind = kindFor(name, data);
  switch (kind) {
    case 'pdf':
      return pdfPreview(data);
    case 'image':
      return imagePreview(data, ext);
    case 'doc':
      return docPreview(data, ext);
    case 'sheet':
      return sheetPreview(name, data);
    case 'slides':
      return slidePreview(data);
    case 'code':
      return { type: 'text', text: bytesToText(data.subarray(0, 4000)).slice(0, 2500) };
    default:
      return { type: 'none' };
  }
}

function canvasToPreview(canvas: HTMLCanvasElement): FilePreview {
  return { type: 'image', src: canvas.toDataURL('image/webp', 0.82), w: canvas.width, h: canvas.height };
}

async function pdfPreview(data: Uint8Array): Promise<FilePreview> {
  const { loadPdf } = await import('../editors/pdf/pdfjs');
  const doc = await loadPdf(data);
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: THUMB_W / base.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return canvasToPreview(canvas);
  } finally {
    doc.destroy();
  }
}

async function loadImage(src: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = src;
  await img.decode();
  return img;
}

async function shrinkImage(src: string, maxW: number): Promise<HTMLCanvasElement> {
  const img = await loadImage(src);
  const w = img.naturalWidth || maxW;
  const h = img.naturalHeight || maxW;
  const scale = Math.min(1, maxW / w);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function imagePreview(data: Uint8Array, ext: string): Promise<FilePreview> {
  const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type: mime }));
  try {
    return canvasToPreview(await shrinkImage(url, THUMB_W));
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function docPreview(data: Uint8Array, ext: string): Promise<FilePreview> {
  const head = bytesToText(data.subarray(0, 8));
  let html: string;
  if (ext === 'docx' || ext === 'docm' || ext === 'dotx') html = await (await import('../editors/doc/docxImport')).docxToHtml(data);
  else if (ext === 'odt') html = await (await import('../editors/doc/otherFormats')).odtToHtml(data);
  else if (ext === 'rtf' || head.startsWith('{\\rtf')) html = (await import('../editors/doc/otherFormats')).rtfToHtml(bytesToText(data));
  else if (ext === 'doc' && data[0] === 0xd0 && data[1] === 0xcf) html = (await import('../editors/doc/otherFormats')).docToHtml(data);
  else html = bytesToText(data);
  return { type: 'doc', html: await trimHtml(html) };
}

/** Keep roughly the first page of content, without scripts or huge embedded images. */
async function trimHtml(html: string): Promise<string> {
  const body = new DOMParser().parseFromString(html, 'text/html').body;
  body.querySelectorAll('script, style, iframe, object, embed, link, meta').forEach((n) => n.remove());
  body.querySelectorAll('*').forEach((el) => {
    for (const a of Array.from(el.attributes)) if (/^on/i.test(a.name)) el.removeAttribute(a.name);
  });
  const out = document.createElement('div');
  let chars = 0;
  for (const child of Array.from(body.childNodes)) {
    if (chars > 1800 || out.childNodes.length > 40) break;
    chars += (child.textContent || '').length;
    out.appendChild(child);
  }
  for (const img of Array.from(out.querySelectorAll('img'))) {
    const src = img.getAttribute('src') || '';
    if (!src.startsWith('data:')) {
      img.remove();
      continue;
    }
    if (src.length > 60_000) {
      try {
        img.setAttribute('src', (await shrinkImage(src, 240)).toDataURL('image/webp', 0.7));
      } catch {
        img.remove();
      }
    }
  }
  return out.innerHTML;
}

async function sheetPreview(name: string, data: Uint8Array): Promise<FilePreview> {
  const { readWorkbook } = await import('../editors/sheet/io');
  const { Calc, usedRange, formatValue } = await import('../editors/sheet/model');
  const wb = await readWorkbook(name, data);
  const sheet = wb.sheets[0];
  if (!sheet) return { type: 'grid', rows: [] };
  const calc = new Calc(wb);
  const used = usedRange(sheet);
  const rows: string[][] = [];
  for (let r = 0; r < Math.min(used.rows, 22); r++) {
    const row: string[] = [];
    for (let c = 0; c < Math.min(used.cols, 9); c++) {
      const cell = sheet.cells[`${r},${c}`];
      let text = '';
      if (cell) {
        try {
          text = formatValue(calc.value(sheet, r, c), cell.s);
        } catch {
          text = String(cell.v ?? '');
        }
      }
      row.push(text.slice(0, 40));
    }
    rows.push(row);
  }
  return { type: 'grid', rows };
}

async function slidePreview(data: Uint8Array): Promise<FilePreview> {
  const { readPptx } = await import('../editors/slides/pptxImport');
  const deck = await readPptx(data);
  const slide = deck.slides[0];
  if (!slide) return { type: 'none' };
  const els: typeof slide.els = [];
  for (const el of slide.els) {
    if (el.type === 'image' && el.src && el.src.length > 80_000) {
      try {
        els.push({ ...el, src: (await shrinkImage(el.src, 480)).toDataURL('image/webp', 0.75) });
      } catch {
        /* drop images that can't be decoded */
      }
    } else els.push(el);
  }
  return { type: 'slide', slide: { ...slide, els, notes: '' }, w: deck.w, h: deck.h, font: deck.font };
}
