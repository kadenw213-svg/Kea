import {
  PDFDocument,
  PDFPage,
  PDFFont,
  StandardFonts,
  rgb,
  degrees,
  BlendMode,
  LineCapStyle,
  PDFName,
  PDFHexString,
  PDFTextField,
  PDFCheckBox,
  PDFDropdown,
  PDFRadioGroup,
  PDFOptionList
} from 'pdf-lib';
import type { Annotation, PageRef, TextAnn } from './types';
import { hexToRgb01, BASELINE_EM, LINE_HEIGHT } from './geometry';
import { dataUrlToBytes } from '../../lib/util';

type Mapper = (vx: number, vy: number) => [number, number];

/** Map viewport points (top-left origin, rotation r applied) back to PDF user space. */
function makeMapper(x0: number, y0: number, W: number, H: number, r: number): Mapper {
  switch (r) {
    case 90:
      return (vx, vy) => [x0 + vy, y0 + vx];
    case 180:
      return (vx, vy) => [x0 + W - vx, y0 + vy];
    case 270:
      return (vx, vy) => [x0 + W - vy, y0 + H - vx];
    default:
      return (vx, vy) => [x0 + vx, y0 + H - vy];
  }
}

const color = (hex: string) => {
  const [r, g, b] = hexToRgb01(hex);
  return rgb(r, g, b);
};

const FONT_MAP: Record<string, StandardFonts[]> = {
  // [regular, bold, italic, boldItalic]
  Helvetica: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique],
  Times: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic],
  Courier: [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique]
};

class FontCache {
  private fonts = new Map<string, PDFFont>();
  private ok = new Map<string, Set<string>>();
  constructor(private doc: PDFDocument) {}
  async get(a: TextAnn) {
    const std = FONT_MAP[a.font][(a.bold ? 1 : 0) + (a.italic ? 2 : 0)];
    let f = this.fonts.get(std);
    if (!f) {
      f = await this.doc.embedFont(std);
      this.fonts.set(std, f);
      this.ok.set(std, new Set());
    }
    return f;
  }
  /** Standard PDF fonts only cover WinAnsi; swap anything else for a close match or '?'. */
  sanitize(font: PDFFont, text: string) {
    const okSet = this.ok.get(font.name) || new Set<string>();
    let out = '';
    for (const ch of text.normalize('NFC')) {
      if (ch === '\n') {
        out += ch;
        continue;
      }
      if (okSet.has(ch)) {
        out += ch;
        continue;
      }
      try {
        font.encodeText(ch);
        okSet.add(ch);
        out += ch;
      } catch {
        const ascii = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
        out += ascii && ascii !== ch && /^[\x20-\x7e]+$/.test(ascii) ? ascii : '?';
      }
    }
    return out;
  }
}

export function wrapText(text: string, measure: (s: string) => number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    if (para === '') {
      lines.push('');
      continue;
    }
    const tokens = para.split(/(\s+)/).filter((t) => t.length);
    let line = '';
    for (const tok of tokens) {
      const candidate = line + tok;
      if (measure(candidate.trimEnd()) <= maxWidth || line === '') {
        if (measure(candidate.trimEnd()) > maxWidth && line === '') {
          // A single word wider than the box: break it by characters.
          let chunk = '';
          for (const ch of tok) {
            if (measure(chunk + ch) > maxWidth && chunk) {
              lines.push(chunk);
              chunk = ch;
            } else chunk += ch;
          }
          line = chunk;
        } else line = candidate;
      } else {
        lines.push(line.trimEnd());
        line = /^\s+$/.test(tok) ? '' : tok;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

async function drawAnnotation(doc: PDFDocument, page: PDFPage, a: Annotation, map: Mapper, rot: number, fonts: FontCache, images: Map<string, any>) {
  const rectFromBox = (x: number, y: number, w: number, h: number) => {
    const [ax, ay] = map(x, y);
    const [bx, by] = map(x + w, y + h);
    return { x: Math.min(ax, bx), y: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay) };
  };
  // SVG paths are drawn with y flipped by pdf-lib, so feed it PDF coordinates with y negated.
  const pathFrom = (pts: [number, number][], close = false) =>
    pts.map(([vx, vy], i) => {
      const [px, py] = map(vx, vy);
      return `${i ? 'L' : 'M'}${px.toFixed(2)} ${(-py).toFixed(2)}`;
    }).join(' ') + (close ? ' Z' : '');

  switch (a.type) {
    case 'whiteout':
    case 'rect': {
      const r = rectFromBox(a.x, a.y, a.w, a.h);
      page.drawRectangle({
        ...r,
        color: a.fill ? color(a.fill) : undefined,
        borderColor: a.stroke ? color(a.stroke) : undefined,
        borderWidth: a.stroke ? a.strokeWidth : 0,
        opacity: a.opacity,
        borderOpacity: a.opacity
      });
      break;
    }
    case 'ellipse': {
      const r = rectFromBox(a.x, a.y, a.w, a.h);
      page.drawEllipse({
        x: r.x + r.width / 2,
        y: r.y + r.height / 2,
        xScale: r.width / 2,
        yScale: r.height / 2,
        color: a.fill ? color(a.fill) : undefined,
        borderColor: a.stroke ? color(a.stroke) : undefined,
        borderWidth: a.stroke ? a.strokeWidth : 0,
        opacity: a.opacity,
        borderOpacity: a.opacity
      });
      break;
    }
    case 'highlight':
      for (const b of a.rects) {
        page.drawRectangle({ ...rectFromBox(b.x, b.y, b.w, b.h), color: color(a.color), opacity: a.opacity, blendMode: BlendMode.Multiply });
      }
      break;
    case 'underline':
    case 'strike':
      for (const b of a.rects) {
        const t = Math.max(0.8, b.h * 0.07);
        const yy = a.type === 'underline' ? b.y + b.h - t / 2 : b.y + b.h * 0.55;
        const [sx, sy] = map(b.x, yy);
        const [ex, ey] = map(b.x + b.w, yy);
        page.drawLine({ start: { x: sx, y: sy }, end: { x: ex, y: ey }, thickness: t, color: color(a.color), opacity: a.opacity });
      }
      break;
    case 'ink': {
      if (a.points.length < 4) {
        const [px, py] = map(a.points[0], a.points[1]);
        page.drawCircle({ x: px, y: py, size: a.width / 2, color: color(a.color), opacity: a.opacity });
        break;
      }
      const pts: [number, number][] = [];
      for (let i = 0; i < a.points.length; i += 2) pts.push([a.points[i], a.points[i + 1]]);
      page.drawSvgPath(pathFrom(pts), {
        x: 0,
        y: 0,
        borderColor: color(a.color),
        borderWidth: a.width,
        borderOpacity: a.opacity,
        borderLineCap: LineCapStyle.Round
      });
      break;
    }
    case 'line':
    case 'arrow': {
      const [sx, sy] = map(a.x1, a.y1);
      const [ex, ey] = map(a.x2, a.y2);
      page.drawLine({ start: { x: sx, y: sy }, end: { x: ex, y: ey }, thickness: a.width, color: color(a.color), opacity: a.opacity, lineCap: LineCapStyle.Round });
      if (a.type === 'arrow') {
        const ang = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
        const len = Math.max(8, a.width * 4);
        const p1: [number, number] = [a.x2 - len * Math.cos(ang - 0.45), a.y2 - len * Math.sin(ang - 0.45)];
        const p2: [number, number] = [a.x2 - len * Math.cos(ang + 0.45), a.y2 - len * Math.sin(ang + 0.45)];
        page.drawSvgPath(pathFrom([[a.x2, a.y2], p1, p2], true), { x: 0, y: 0, color: color(a.color), opacity: a.opacity });
      }
      break;
    }
    case 'image': {
      let img = images.get(a.dataUrl);
      if (!img) {
        const bytes = dataUrlToBytes(a.dataUrl);
        img = a.dataUrl.startsWith('data:image/jpeg') ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
        images.set(a.dataUrl, img);
      }
      const [px, py] = map(a.x, a.y + a.h);
      page.drawImage(img, { x: px, y: py, width: a.w, height: a.h, rotate: degrees(rot) });
      break;
    }
    case 'text': {
      if (a.bg) {
        page.drawRectangle({ ...rectFromBox(a.x, a.y, a.w, a.h), color: color(a.bg) });
      }
      const font = await fonts.get(a);
      const text = fonts.sanitize(font, a.text);
      const size = a.fontSize;
      const lines = wrapText(text, (s) => font.widthOfTextAtSize(s, size), a.w + 0.5);
      const lh = size * LINE_HEIGHT;
      lines.forEach((line, i) => {
        if (!line) return;
        const lw = font.widthOfTextAtSize(line, size);
        const offX = a.align === 'center' ? (a.w - lw) / 2 : a.align === 'right' ? a.w - lw : 0;
        const [px, py] = map(a.x + offX, a.y + i * lh + size * BASELINE_EM[a.font]);
        page.drawText(line, { x: px, y: py, size, font, color: color(a.color), rotate: degrees(rot) });
      });
      break;
    }
    case 'note': {
      const [px, py] = map(a.x, a.y);
      const [r, g, b] = hexToRgb01(a.color);
      const annot = doc.context.obj({
        Type: 'Annot',
        Subtype: 'Text',
        Rect: [px, py - 20, px + 20, py],
        Contents: PDFHexString.fromText(a.text),
        Name: 'Comment',
        C: [r, g, b],
        F: 4,
        Open: false,
        M: PDFHexString.fromText(new Date().toISOString())
      });
      page.node.addAnnot(doc.context.register(annot));
      break;
    }
  }
}

export type FormValues = Record<string, string | boolean | string[]>;

function applyForm(doc: PDFDocument, values: FormValues) {
  const form = doc.getForm();
  for (const [name, v] of Object.entries(values)) {
    try {
      const field = form.getField(name);
      if (field instanceof PDFTextField) field.setText(String(v ?? ''));
      else if (field instanceof PDFCheckBox) v ? field.check() : field.uncheck();
      else if (field instanceof PDFDropdown) v ? field.select(String(v)) : field.clear();
      else if (field instanceof PDFRadioGroup) v && field.select(String(v));
      else if (field instanceof PDFOptionList) field.select(Array.isArray(v) ? v : [String(v)]);
    } catch (err) {
      console.warn('form field', name, err);
    }
  }
  try {
    const helv = form.doc.embedStandardFont(StandardFonts.Helvetica);
    form.updateFieldAppearances(helv as any);
  } catch {}
}

/**
 * Produce the final PDF. When the page list is untouched we edit the original
 * document in place, which keeps bookmarks, links, metadata and form fields intact.
 */
export async function buildPdf(sources: Uint8Array[], pages: PageRef[], annots: Annotation[], formValues: FormValues = {}): Promise<Uint8Array> {
  const libSrc: (PDFDocument | null)[] = [];
  for (const s of sources) libSrc.push(s.length ? await PDFDocument.load(s, { ignoreEncryption: true, updateMetadata: false }) : null);

  const first = libSrc[0];
  const inPlace = !!first && pages.length === first.getPageCount() && pages.every((p, i) => p.src === 0 && p.index === i);

  let out: PDFDocument;
  const outPages: PDFPage[] = [];

  if (inPlace) {
    out = first!;
    if (Object.keys(formValues).length) applyForm(out, formValues);
    out.getPages().forEach((p) => outPages.push(p));
  } else {
    if (first && Object.keys(formValues).length) {
      applyForm(first, formValues);
      try {
        first.getForm().flatten();
      } catch {}
    }
    out = await PDFDocument.create();
    if (first) {
      out.setTitle(first.getTitle() || '');
      out.setAuthor(first.getAuthor() || '');
    }
    for (const p of pages) {
      if (p.src < 0) {
        outPages.push(out.addPage([p.width || 612, p.height || 792]));
      } else {
        const [copied] = await out.copyPages(libSrc[p.src]!, [p.index]);
        outPages.push(out.addPage(copied));
      }
    }
  }

  const fonts = new FontCache(out);
  const images = new Map<string, any>();
  for (let i = 0; i < pages.length; i++) {
    const ref = pages[i];
    const page = outPages[i];
    const base = (((page.getRotation().angle % 360) + 360) % 360) as number;
    const eff = (((base + (ref.src < 0 ? 0 : ref.rotation)) % 360) + 360) % 360;
    if (eff !== base) page.setRotation(degrees(eff));
    const crop = page.getCropBox();
    const map = makeMapper(crop.x, crop.y, crop.width, crop.height, eff);
    for (const a of annots) {
      if (a.pageId === ref.id) await drawAnnotation(out, page, a, map, eff, fonts, images);
    }
  }
  out.setModificationDate(new Date());
  out.setProducer('Slate Office');
  return out.save();
}

export interface FormFieldInfo {
  name: string;
  type: 'text' | 'checkbox' | 'dropdown' | 'radio' | 'list' | 'other';
  value: string | boolean | string[];
  options?: string[];
  multiline?: boolean;
}

export async function readFormFields(bytes: Uint8Array): Promise<FormFieldInfo[]> {
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    const fields = doc.getForm().getFields();
    return fields.map((f): FormFieldInfo => {
      const name = f.getName();
      if (f instanceof PDFTextField) return { name, type: 'text', value: f.getText() || '', multiline: f.isMultiline() };
      if (f instanceof PDFCheckBox) return { name, type: 'checkbox', value: f.isChecked() };
      if (f instanceof PDFDropdown) return { name, type: 'dropdown', value: f.getSelected()[0] || '', options: f.getOptions() };
      if (f instanceof PDFRadioGroup) return { name, type: 'radio', value: f.getSelected() || '', options: f.getOptions() };
      if (f instanceof PDFOptionList) return { name, type: 'list', value: f.getSelected(), options: f.getOptions() };
      return { name, type: 'other', value: '' };
    });
  } catch {
    return [];
  }
}

export async function isEncrypted(bytes: Uint8Array): Promise<boolean> {
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    return doc.isEncrypted || !!doc.context.trailerInfo.Encrypt;
  } catch {
    return false;
  }
}

export { PDFName };
