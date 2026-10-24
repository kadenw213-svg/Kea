// What Claude can do in a PDF: find a passage and highlight, comment, replace or redact it; add text, shapes and
// images anywhere (designing a page from a flier or a concept); rotate, delete, move and insert pages; fill in forms.
// Every tool is one history step, so one Ctrl+Z undoes it. Coordinates are PDF points from the page's top-left corner
// (72 points = 1 inch), in the page as shown.
import type { AiHooks, AssistantTool } from '../../store';
import { uid } from '../../lib/util';
import { imageSource, resolveImage } from '../../lib/attachments';
import { measureTextAnn } from './PageView';
import { BASELINE_EM } from './geometry';
import type { Annotation, Box, DocState, FontFamily, PageRef, TextAnn } from './types';
import { DEFAULTS } from './types';
import type { TextItemRect } from './pdfjs';
import type { FormFieldInfo, FormValues } from './save';

export interface PdfAiCtx {
  history: { get(): DocState; commit(s: DocState): void };
  sizeOf(ref: PageRef): { width: number; height: number; rotation: number };
  textRectsFor(ref: PageRef): Promise<TextItemRect[]>;
  sampleColors(pageId: string, b: Box): { fg: string; bg: string };
  markDirty(): void;
  select(id: string | null): void;
  scrollToPage(i: number): void;
  currentIndex: number;
  rotatePages(delta: number, ids: string[]): void;
  deletePages(ids: string[]): Promise<void> | void;
  duplicatePages(ids: string[]): void;
  reorderPages(ids: string[], toIndex: number): void;
  formFields: FormFieldInfo[];
  formValues: FormValues;
  setFormValues(v: FormValues): void;
}

const norm = (ch: string) => (/\s/.test(ch) ? ' ' : ch.replace(/[‘’]/, "'").replace(/[“”]/, '"').replace(/[‐‑–—]/, '-').toLowerCase());

interface Found {
  page: number;
  pageId: string;
  /** One box per line of the passage. */
  lines: Box[];
  fontSize: number;
  family: TextItemRect['family'];
  baseY: number;
  /** What follows the passage on its last line, and where that line ends (so a rewrite can reflow it). */
  rest: string;
  lineEnd: number;
}

// Where a character sits inside a run: measured in a matching font, not assumed equal widths.
const measure = document.createElement('canvas').getContext('2d')!;
function xAt(p: TextItemRect, i: number) {
  if (i <= 0) return p.x;
  if (i >= p.str.length) return p.x + p.w;
  measure.font = `${p.fontSize}px ${p.family}`;
  const full = measure.measureText(p.str).width;
  return full > 0 ? p.x + (p.w * measure.measureText(p.str.slice(0, i)).width) / full : p.x + (p.w * i) / p.str.length;
}

/** The text items of a page grouped into lines, top to bottom (the same reading order read_document gives). */
function linesOf(rects: TextItemRect[]) {
  const sorted = rects.slice().sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: { y: number; h: number; parts: TextItemRect[] }[] = [];
  for (const r of sorted) {
    const line = lines.find((l) => Math.abs(l.y - r.y) < Math.max(2, Math.min(l.h, r.h) * 0.5));
    if (line) line.parts.push(r);
    else lines.push({ y: r.y, h: r.h, parts: [r] });
  }
  lines.sort((a, b) => a.y - b.y);
  for (const l of lines) l.parts.sort((a, b) => a.x - b.x);
  return lines;
}

/** Find every occurrence of a quote on a page; each comes back as one box per line it covers. */
function findOnPage(rects: TextItemRect[], quote: string): Omit<Found, 'page' | 'pageId'>[] {
  const needle = Array.from(quote.trim().replace(/^["'“”]+|["'“”…]+$/g, '')).map(norm).join('').replace(/ +/g, ' ');
  if (needle.length < 2) return [];
  // The page as one string, each character remembering which run (and which line) it came from.
  let text = '';
  const map: { line: number; part: TextItemRect; at: number }[] = [];
  const push = (ch: string, m: { line: number; part: TextItemRect; at: number } | null) => {
    const n = norm(ch);
    if (n === ' ' && (text.endsWith(' ') || !text)) return;
    text += n;
    map.push(m as any);
  };
  const lines = linesOf(rects);
  lines.forEach((l, li) => {
    l.parts.forEach((p) => {
      if (!text.endsWith(' ') && text) push(' ', null);
      for (let i = 0; i < p.str.length; i++) push(p.str[i], { line: li, part: p, at: i });
    });
    push(' ', null);
  });
  const out: Omit<Found, 'page' | 'pageId'>[] = [];
  for (let idx = text.indexOf(needle); idx >= 0; idx = text.indexOf(needle, idx + needle.length)) {
    // Character spans per run → x extents, merged per line.
    const spans = new Map<TextItemRect, { line: number; lo: number; hi: number }>();
    for (let k = idx; k < idx + needle.length; k++) {
      const m = map[k];
      if (!m) continue;
      const s = spans.get(m.part);
      if (s) (s.lo = Math.min(s.lo, m.at)), (s.hi = Math.max(s.hi, m.at));
      else spans.set(m.part, { line: m.line, lo: m.at, hi: m.at });
    }
    const perLine = new Map<number, Box>();
    let first: TextItemRect | null = null;
    spans.forEach((s, p) => {
      first ||= p;
      const x0 = xAt(p, s.lo);
      const box = p.horizontal ? { x: x0, y: p.y, w: xAt(p, s.hi + 1) - x0, h: p.h } : { x: p.x, y: p.y, w: p.w, h: p.h };
      const b = perLine.get(s.line);
      if (!b) perLine.set(s.line, box);
      else {
        const r = Math.max(b.x + b.w, box.x + box.w),
          bot = Math.max(b.y + b.h, box.y + box.h);
        b.x = Math.min(b.x, box.x);
        b.y = Math.min(b.y, box.y);
        b.w = r - b.x;
        b.h = bot - b.y;
      }
    });
    if (!first) continue;
    const f: TextItemRect = first;
    // The rest of the last line after the passage.
    let rest = '';
    const lastLine = map[idx + needle.length - 1]?.line ?? -1;
    for (let k = idx + needle.length; k < map.length; k++) {
      const m = map[k];
      if (m && m.line !== lastLine) break;
      if (!m && k + 1 < map.length && map[k + 1] && map[k + 1]!.line !== lastLine) break;
      rest += m ? m.part.str[m.at] : ' ';
    }
    const ll = lines[lastLine];
    const lineEnd = ll ? Math.max(...ll.parts.map((q) => q.x + q.w)) : 0;
    out.push({ lines: [...perLine.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]), fontSize: f.fontSize, family: f.family, baseY: f.baseY, rest: rest.replace(/\s+$/, ''), lineEnd });
  }
  return out;
}

/** Break text into lines that fit `width` points in the given font (keeping the student's own line breaks). */
export function wrapText(t: Pick<TextAnn, 'fontSize' | 'font' | 'bold' | 'italic'>, text: string, width: number): string {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/ +/)) {
      const next = line ? `${line} ${word}` : word;
      if (line && measureTextAnn({ ...t, text: next }).width > width) {
        out.push(line);
        line = word;
      } else line = next;
    }
    out.push(line);
  }
  return out.join('\n');
}

const FONTS: FontFamily[] = ['Helvetica', 'Times', 'Courier'];
const fontOf = (family: TextItemRect['family']): FontFamily => (family === 'serif' ? 'Times' : family === 'monospace' ? 'Courier' : 'Helvetica');
const hex = { type: 'string', description: 'CSS hex colour like "#1a73e8"' };
const pageNo = { type: 'integer', description: 'Page number, from 1' };

export function pdfAi(c: PdfAiCtx): Pick<AiHooks, 'tools'> {
  const pages = () => c.history.get().pages;
  const pageAt = (n: number | undefined) => {
    const ps = pages();
    const i = n === undefined ? c.currentIndex : n - 1;
    if (!Number.isInteger(i) || i < 0 || i >= ps.length) throw new Error(`There's no page ${n}; the PDF has ${ps.length}.`);
    return { ref: ps[i], i };
  };
  const commit = (fn: (s: DocState) => DocState, show?: { id?: string; page?: number }) => {
    c.history.commit(fn(c.history.get()));
    c.markDirty();
    if (show?.id) c.select(show.id);
    if (show?.page !== undefined) c.scrollToPage(show.page);
  };
  const add = (a: Annotation[], page: number) => commit((s) => ({ ...s, annots: [...s.annots, ...a] }), { id: a[a.length - 1]?.id, page });

  /** Find a quote (on one page, or the first page that has it). */
  async function find(quote: string, page?: number, all = false): Promise<Found[]> {
    const ps = pages();
    const order = page !== undefined ? [pageAt(page).i] : ps.map((_, i) => i);
    const hits: Found[] = [];
    for (const i of order) {
      const found = findOnPage(await c.textRectsFor(ps[i]), quote);
      for (const f of found) {
        hits.push({ ...f, page: i, pageId: ps[i].id });
        if (!all) return hits;
      }
    }
    return hits;
  }
  const notFound = (quote: string) =>
    new Error(`“${quote.slice(0, 60)}” wasn’t found in the PDF’s text. Copy it exactly from read_document (scanned pages without a text layer can’t be searched; place marks with coordinates instead).`);

  const describe = () => {
    const s = c.history.get();
    const lines = [`${s.pages.length} page${s.pages.length > 1 ? 's' : ''}. Coordinates are points from each page's top-left corner (72 points = 1 inch).`];
    s.pages.forEach((p, i) => {
      const z = c.sizeOf(p);
      lines.push(`Page ${i + 1}: ${Math.round(z.width)} × ${Math.round(z.height)} pt${p.src < 0 ? ' (blank page)' : ''}${z.rotation ? `, rotated ${z.rotation}°` : ''}${i === c.currentIndex ? ' (shown)' : ''}`);
      for (const a of s.annots.filter((x) => x.pageId === p.id)) {
        const r = (v: number) => Math.round(v);
        const at =
          'rects' in a
            ? `${a.rects.length} line${a.rects.length > 1 ? 's' : ''} from (${r(a.rects[0].x)}, ${r(a.rects[0].y)})`
            : 'x1' in a
              ? `(${r(a.x1)}, ${r(a.y1)})→(${r(a.x2)}, ${r(a.y2)})`
              : 'w' in a
                ? `box (${r(a.x)}, ${r(a.y)}) ${r(a.w)}×${r(a.h)}`
                : 'x' in a
                  ? `at (${r(a.x)}, ${r(a.y)})`
                  : '';
        const what = a.type === 'text' ? ` “${a.text.slice(0, 60)}” ${a.fontSize}pt ${a.font}${a.bold ? ' bold' : ''} ${a.color}` : a.type === 'note' ? ` “${a.text.slice(0, 60)}”` : a.type === 'image' && a.signature ? ' (signature)' : '';
        lines.push(`  - mark ${a.id}: ${a.type}${what} ${at}`);
      }
    });
    if (c.formFields.length) {
      lines.push(`Form fields (${c.formFields.length}):`);
      for (const f of c.formFields) lines.push(`  - “${f.name}” ${f.type} = ${JSON.stringify(c.formValues[f.name] ?? f.value)}${f.options ? ` options ${JSON.stringify(f.options)}` : ''}`);
    }
    return lines.join('\n');
  };

  const tools: AssistantTool[] = [
    {
      name: 'describe_pages',
      description: 'List the pages (size in points, rotation), every mark already added (text boxes, highlights, shapes, images, notes, with ids for edit_mark / delete_mark) and the form fields. read_document gives the text itself.',
      input_schema: { type: 'object', properties: {} },
      run: describe
    },
    {
      name: 'mark_text',
      description: 'Highlight, underline or strike through a passage of the PDF’s own text. `quote` is copied from read_document.',
      input_schema: {
        type: 'object',
        properties: {
          quote: { type: 'string' },
          style: { type: 'string', enum: ['highlight', 'underline', 'strike'], description: 'Default highlight' },
          color: hex,
          page: { ...pageNo, description: 'Only look on this page' },
          all: { type: 'boolean', description: 'Every occurrence, not just the first' }
        },
        required: ['quote']
      },
      run: async ({ quote, style = 'highlight', color, page, all }) => {
        const hits = await find(quote, page, all);
        if (!hits.length) throw notFound(quote);
        const made: Annotation[] = hits.map((h) => ({ id: uid(), pageId: h.pageId, type: style, rects: h.lines, color: color || (DEFAULTS as any)[style], opacity: style === 'highlight' ? 0.4 : 1 }));
        add(made, hits[0].page);
        return `Marked ${hits.length} place${hits.length > 1 ? 's' : ''} (${style}) on page${new Set(hits.map((h) => h.page)).size > 1 ? 's' : ''} ${[...new Set(hits.map((h) => h.page + 1))].join(', ')}.`;
      }
    },
    {
      name: 'replace_text',
      description:
        'Rewrite a passage of the PDF’s own text: it is covered in its background colour and the new words are set over it in a matching font and size (wrapped to the passage’s width). `quote` is copied exactly from read_document; best within one paragraph.',
      input_schema: { type: 'object', properties: { quote: { type: 'string' }, replacement: { type: 'string' }, page: pageNo }, required: ['quote', 'replacement'] },
      run: async ({ quote, replacement, page }) => {
        const [h] = await find(quote, page);
        if (!h) throw notFound(quote);
        const font = fontOf(h.family);
        const size = Math.round(h.fontSize * 10) / 10;
        const left = Math.min(...h.lines.map((b) => b.x));
        const right = Math.max(...h.lines.map((b) => b.x + b.w));
        const colors = c.sampleColors(h.pageId, h.lines[0]);
        // The words after the passage on its line move along with it, so a longer (or shorter) rewrite never runs
        // into them or leaves a gap: cover to the end of that line and set the rest after the new words.
        const lines = h.lines.map((b, k) => (k === h.lines.length - 1 && h.rest ? { ...b, w: Math.max(b.w, h.lineEnd - b.x) } : b));
        const covers: Annotation[] = lines.map((b) => ({ id: uid(), pageId: h.pageId, type: 'whiteout', x: b.x - 1, y: b.y - 1, w: b.w + 2, h: b.h + 2, stroke: null, fill: colors.bg, strokeWidth: 0, opacity: 1 }));
        const words = h.rest ? `${replacement}${/^[\s.,;:!?)]/.test(h.rest) ? '' : ' '}${h.rest}` : replacement;
        const multi = h.lines.length > 1;
        const t: TextAnn = { id: uid(), pageId: h.pageId, type: 'text', x: multi ? left : h.lines[0].x, y: h.baseY - size * BASELINE_EM[font], w: 10, h: 10, text: words, fontSize: size, font, bold: false, italic: false, color: colors.fg, align: 'left', auto: !multi };
        if (multi) (t.text = wrapText(t, words, Math.max(right, h.lineEnd) - left)), (t.unwrapped = words);
        const m = measureTextAnn(t);
        t.w = multi ? Math.max(right, h.lineEnd) - left : m.width + 2;
        t.h = m.height;
        add([...covers, t], h.page);
        const z = c.sizeOf(pages()[h.page]);
        const grew = m.height > h.lines.length * size * 1.3 + 1 || (!multi && t.x + m.width > z.width - 36);
        return `Replaced on page ${h.page + 1} (text box ${t.id}).${grew ? ' The new text is longer than the old: look to check it doesn’t run into what follows, and shorten it or move/resize it with edit_mark if it does.' : ''}`;
      }
    },
    {
      name: 'add_comment',
      description: 'Leave a reviewer’s note beside a passage (a PDF sticky note), without changing the text. `quote` is copied exactly from read_document.',
      input_schema: { type: 'object', properties: { quote: { type: 'string' }, comment: { type: 'string' }, page: pageNo }, required: ['quote', 'comment'] },
      run: async ({ quote, comment, page }) => {
        const [h] = await find(quote, page);
        if (!h) throw notFound(quote);
        const z = c.sizeOf(pages()[h.page]);
        const b = h.lines[0];
        const a: Annotation = { id: uid(), pageId: h.pageId, type: 'note', x: Math.min(z.width - 24, b.x + b.w + 4), y: Math.max(0, b.y - 4), text: comment, color: DEFAULTS.note };
        add([a], h.page);
        return `Note ${a.id} added on page ${h.page + 1}.`;
      }
    },
    {
      name: 'redact_text',
      description: 'Black out a passage so it is permanently removed from the PDF when it is saved (names, numbers, private details). Shown as a box until then.',
      input_schema: { type: 'object', properties: { quote: { type: 'string' }, page: pageNo, all: { type: 'boolean', description: 'Every occurrence' } }, required: ['quote'] },
      run: async ({ quote, page, all }) => {
        const hits = await find(quote, page, all);
        if (!hits.length) throw notFound(quote);
        const made: Annotation[] = hits.flatMap((h) => h.lines.map((b) => ({ id: uid(), pageId: h.pageId, type: 'redact' as const, x: b.x - 1, y: b.y - 1, w: b.w + 2, h: b.h + 2, stroke: null, fill: '#000000', strokeWidth: 0, opacity: 1 })));
        add(made, hits[0].page);
        return `Redaction boxes over ${hits.length} place${hits.length > 1 ? 's' : ''}; the text underneath is removed when the PDF is saved.`;
      }
    },
    {
      name: 'add_text',
      description:
        'Put text on a page: labels, answers in a worksheet, a heading, or the type of a page you are designing. Fonts: Helvetica (sans), Times (serif), Courier (mono). With `width`, long text wraps to that width. Measure positions from describe_pages (page size) and check with look.',
      input_schema: {
        type: 'object',
        properties: {
          page: pageNo,
          x: { type: 'number' },
          y: { type: 'number', description: 'Top of the text box' },
          text: { type: 'string', description: 'Line breaks with \\n' },
          size: { type: 'number', description: 'Font size in points (default 14)' },
          font: { type: 'string', enum: FONTS },
          bold: { type: 'boolean' },
          italic: { type: 'boolean' },
          color: hex,
          align: { type: 'string', enum: ['left', 'center', 'right'] },
          width: { type: 'number', description: 'Box width in points; text wraps to it' },
          background: { ...hex, description: 'Solid colour behind the text (covers what is under it)' }
        },
        required: ['x', 'y', 'text']
      },
      run: ({ page, x, y, text, size = 14, font = 'Helvetica', bold = false, italic = false, color = '#000000', align = 'left', width, background }) => {
        const { ref, i } = pageAt(page);
        const t: TextAnn = { id: uid(), pageId: ref.id, type: 'text', x, y, w: 10, h: 10, text, fontSize: size, font, bold, italic, color, align, bg: background || null, auto: !width };
        if (width) (t.text = wrapText(t, text, width)), (t.unwrapped = text);
        const m = measureTextAnn(t);
        t.w = width || m.width + 2;
        t.h = m.height;
        add([t], i);
        const z = c.sizeOf(ref);
        const off = x + t.w > z.width + 1 || y + t.h > z.height + 1 ? ` Warning: it runs past the page edge (${Math.round(z.width)} × ${Math.round(z.height)}).` : '';
        return `Added text ${t.id} on page ${i + 1}, ${Math.round(t.w)} × ${Math.round(t.h)} pt.${off}`;
      }
    },
    {
      name: 'add_shape',
      description:
        'Draw on a page: rect, ellipse, line, arrow, or whiteout (a box in the background colour that hides what is under it). Boxes take x, y, w, h; lines and arrows take x1, y1, x2, y2. Use filled rects as colour bands and panels when designing a page.',
      input_schema: {
        type: 'object',
        properties: {
          page: pageNo,
          type: { type: 'string', enum: ['rect', 'ellipse', 'line', 'arrow', 'whiteout'] },
          x: { type: 'number' },
          y: { type: 'number' },
          w: { type: 'number' },
          h: { type: 'number' },
          x1: { type: 'number' },
          y1: { type: 'number' },
          x2: { type: 'number' },
          y2: { type: 'number' },
          stroke: { ...hex, description: 'Outline / line colour; "none" for no outline' },
          fill: { ...hex, description: 'Fill colour (boxes); leave out for none' },
          stroke_width: { type: 'number', description: 'Points (default 2)' },
          opacity: { type: 'number', description: '0–1' }
        },
        required: ['type']
      },
      run: ({ page, type, x, y, w, h, x1, y1, x2, y2, stroke, fill, stroke_width = 2, opacity = 1 }) => {
        const { ref, i } = pageAt(page);
        let a: Annotation;
        if (type === 'line' || type === 'arrow') {
          if ([x1, y1, x2, y2].some((v) => typeof v !== 'number')) throw new Error('Lines and arrows need x1, y1, x2, y2.');
          a = { id: uid(), pageId: ref.id, type, x1, y1, x2, y2, color: stroke && stroke !== 'none' ? stroke : DEFAULTS.shape, width: stroke_width, opacity };
        } else {
          if ([x, y, w, h].some((v) => typeof v !== 'number')) throw new Error('Boxes need x, y, w and h.');
          const bg = type === 'whiteout' ? fill || c.sampleColors(ref.id, { x, y, w, h }).bg : fill || null;
          a = { id: uid(), pageId: ref.id, type, x, y, w, h, stroke: type === 'whiteout' || stroke === 'none' ? null : stroke || (fill ? null : DEFAULTS.shape), fill: bg, strokeWidth: type === 'whiteout' ? 0 : stroke_width, opacity };
        }
        add([a], i);
        return `Added ${type} ${a.id} on page ${i + 1}.`;
      }
    },
    {
      name: 'add_image',
      description: 'Place an image on a page: an attached picture, a logo, a signature image, or vector artwork you write (svg) for backgrounds, bands, badges and illustrations when designing a page. Without a size it is fitted to half the page width; give width or height to size it (the other keeps the proportions).',
      input_schema: {
        type: 'object',
        properties: { page: pageNo, ...imageSource, x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } }
      },
      run: async ({ page, attachment, path, svg, x, y, width, height }) => {
        const img = await resolveImage({ attachment, path, svg });
        const { ref, i } = pageAt(page);
        const z = c.sizeOf(ref);
        const ratio = img.height / img.width;
        let w = width ?? (height ? height / ratio : Math.min(z.width * 0.5, img.width));
        let h = height ?? w * ratio;
        if (width && height) (w = width), (h = height);
        const a: Annotation = { id: uid(), pageId: ref.id, type: 'image', x: x ?? (z.width - w) / 2, y: y ?? (z.height - h) / 2, w, h, dataUrl: img.dataUrl };
        add([a], i);
        return `Placed “${img.name}” as ${a.id} on page ${i + 1} at (${Math.round(a.x)}, ${Math.round(a.y)}), ${Math.round(w)} × ${Math.round(h)} pt.`;
      }
    },
    {
      name: 'edit_mark',
      description: 'Change a mark added earlier (ids from describe_pages): move or resize it, or change its text, colours or font. Only the fields you give change.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          x: { type: 'number' },
          y: { type: 'number' },
          w: { type: 'number' },
          h: { type: 'number' },
          text: { type: 'string' },
          color: hex,
          fill: hex,
          stroke: hex,
          size: { type: 'number', description: 'Font size (text)' },
          font: { type: 'string', enum: FONTS },
          bold: { type: 'boolean' },
          italic: { type: 'boolean' },
          align: { type: 'string', enum: ['left', 'center', 'right'] },
          background: hex,
          opacity: { type: 'number' }
        },
        required: ['id']
      },
      run: ({ id, ...p }) => {
        const s = c.history.get();
        const a = s.annots.find((x) => x.id === id);
        if (!a) throw new Error(`No mark ${id}. describe_pages lists them.`);
        const n: any = { ...a };
        for (const k of ['x', 'y', 'w', 'h', 'opacity', 'bold', 'italic', 'align', 'font', 'text'] as const) if (p[k] !== undefined && k in a) n[k] = p[k];
        if (p.size !== undefined && a.type === 'text') n.fontSize = p.size;
        if (p.background !== undefined && a.type === 'text') n.bg = p.background;
        if (p.color !== undefined && 'color' in a) n.color = p.color;
        if (p.fill !== undefined && 'fill' in a) n.fill = p.fill;
        if (p.stroke !== undefined && 'stroke' in a) n.stroke = p.stroke;
        if (a.type === 'text' && p.w !== undefined) n.auto = false; // a set width means the text wraps to it
        if (a.type === 'text' && ['text', 'size', 'font', 'bold', 'italic', 'w'].some((k) => p[k] !== undefined)) {
          if (!n.auto) {
            // Wrap the words afresh (from before the last wrap, unless the student has since edited the text by hand).
            const words = p.text ?? (a.unwrapped !== undefined && wrapText(a, a.unwrapped, a.w) === a.text ? a.unwrapped : a.text);
            n.text = wrapText(n, words, n.w);
            n.unwrapped = words;
          }
          const m = measureTextAnn(n);
          if (n.auto) n.w = m.width + 2;
          n.h = m.height;
        }
        const page = s.pages.findIndex((x) => x.id === a.pageId);
        commit((st) => ({ ...st, annots: st.annots.map((x) => (x.id === id ? n : x)) }), { id, page });
        return `Updated ${id}.`;
      }
    },
    {
      name: 'delete_mark',
      description: 'Remove a mark added earlier (text box, highlight, shape, image, note). It can’t remove the PDF’s own content: cover that with a whiteout or redact it.',
      input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      run: ({ id }) => {
        if (!c.history.get().annots.some((a) => a.id === id)) throw new Error(`No mark ${id}.`);
        commit((s) => ({ ...s, annots: s.annots.filter((a) => a.id !== id) }));
        c.select(null);
        return `Deleted ${id}.`;
      }
    },
    {
      name: 'rotate_pages',
      description: 'Rotate pages clockwise by 90, 180 or 270 degrees.',
      input_schema: { type: 'object', properties: { pages: { type: 'array', items: { type: 'integer' } }, degrees: { type: 'integer', enum: [90, 180, 270] } }, required: ['pages', 'degrees'] },
      run: ({ pages: ns, degrees }) => {
        const ids = (ns as number[]).map((n) => pageAt(n).ref.id);
        for (let k = 0; k < degrees / 90; k++) c.rotatePages(90, ids);
        return `Rotated page${ids.length > 1 ? 's' : ''} ${ns.join(', ')} by ${degrees}°.`;
      }
    },
    {
      name: 'delete_pages',
      description: 'Delete pages (at least one page must stay).',
      input_schema: { type: 'object', properties: { pages: { type: 'array', items: { type: 'integer' } } }, required: ['pages'] },
      run: async ({ pages: ns }) => {
        const ids = (ns as number[]).map((n) => pageAt(n).ref.id);
        if (ids.length >= pages().length) throw new Error('A PDF needs at least one page.');
        await c.deletePages(ids);
        return `Deleted page${ids.length > 1 ? 's' : ''} ${ns.join(', ')}.`;
      }
    },
    {
      name: 'move_page',
      description: 'Move a page to a new position (page numbers from 1).',
      input_schema: { type: 'object', properties: { page: pageNo, to: { type: 'integer' } }, required: ['page', 'to'] },
      run: ({ page, to }) => {
        const { ref } = pageAt(page);
        pageAt(to);
        // reorderPages inserts before an index of the current list: moving down needs one past the target.
        c.reorderPages([ref.id], to > page ? to : to - 1);
        c.scrollToPage(to - 1);
        return `Moved page ${page} to ${to}.`;
      }
    },
    {
      name: 'insert_blank_page',
      description: 'Insert a blank page (to design on, or for notes) after page `after` (0 = at the start). Size defaults to the neighbouring page; Letter is 612 × 792, A4 595 × 842.',
      input_schema: { type: 'object', properties: { after: { type: 'integer' }, width: { type: 'number' }, height: { type: 'number' } }, required: ['after'] },
      run: ({ after, width, height }) => {
        const ps = pages();
        if (!Number.isInteger(after) || after < 0 || after > ps.length) throw new Error(`after must be 0–${ps.length}.`);
        const near = ps[Math.max(0, after - 1)];
        const size = near ? c.sizeOf(near) : { width: 612, height: 792 };
        const blank: PageRef = { id: uid(), src: -1, index: 0, rotation: 0, width: width || size.width, height: height || size.height };
        commit((s) => {
          const next = [...s.pages];
          next.splice(after, 0, blank);
          return { ...s, pages: next };
        });
        setTimeout(() => c.scrollToPage(after), 50);
        return `Inserted a blank ${Math.round(blank.width!)} × ${Math.round(blank.height!)} pt page as page ${after + 1}.`;
      }
    },
    {
      name: 'duplicate_page',
      description: 'Copy a page (with its marks) right after itself.',
      input_schema: { type: 'object', properties: { page: pageNo }, required: ['page'] },
      run: ({ page }) => {
        c.duplicatePages([pageAt(page).ref.id]);
        return `Duplicated page ${page} as page ${page + 1}.`;
      }
    },
    {
      name: 'fill_form',
      description: 'Fill in the PDF’s form fields by name (describe_pages lists them): text as strings, checkboxes as true/false, dropdowns and radio buttons as one of their options.',
      input_schema: { type: 'object', properties: { values: { type: 'object', description: '{ "field name": value }' } }, required: ['values'] },
      run: ({ values }) => {
        if (!c.formFields.length) throw new Error('This PDF has no form fields. Use add_text to write on it instead.');
        const next = { ...c.formValues };
        const bad: string[] = [];
        for (const [name, v] of Object.entries(values as Record<string, any>)) {
          const f = c.formFields.find((x) => x.name === name) || c.formFields.find((x) => x.name.toLowerCase() === name.toLowerCase());
          if (!f) {
            bad.push(`no field “${name}”`);
            continue;
          }
          if ((f.type === 'dropdown' || f.type === 'radio') && f.options && !f.options.includes(String(v))) {
            bad.push(`“${f.name}” must be one of ${JSON.stringify(f.options)}`);
            continue;
          }
          next[f.name] = f.type === 'checkbox' ? !!v : f.type === 'list' ? (Array.isArray(v) ? v.map(String) : [String(v)]) : String(v);
        }
        c.setFormValues(next);
        c.markDirty();
        const done = Object.keys(values).length - bad.length;
        if (!done) throw new Error(bad.join('; '));
        return `Filled ${done} field${done === 1 ? '' : 's'}.${bad.length ? ` Skipped: ${bad.join('; ')}.` : ''}`;
      }
    },
    {
      name: 'go_to_page',
      description: 'Show a page (to the student, and to yourself with look).',
      input_schema: { type: 'object', properties: { page: pageNo }, required: ['page'] },
      run: ({ page }) => {
        c.scrollToPage(pageAt(page).i);
        return `Showing page ${page}.`;
      }
    }
  ];

  return { tools };
}
