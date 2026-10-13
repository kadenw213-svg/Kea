import JSZip from 'jszip';
import { Deck, El, Slide, ShapeKind } from './model';
import { uid, escapeHtml } from '../../lib/util';

/**
 * Reads .pptx files: slide size, theme colours, backgrounds, text boxes and
 * placeholders (with layout/master inheritance), shapes, pictures, groups,
 * simple tables, and speaker notes.
 */

const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const EMU = 12700; // per point

const kids = (el: Element | null | undefined, name: string) => (el ? Array.from(el.children).filter((c) => c.localName === name) : []);
const kid = (el: Element | null | undefined, name: string) => kids(el, name)[0] || null;
const desc = (el: Element | null | undefined, name: string) => (el ? (el.getElementsByTagNameNS(A, name)[0] as Element | undefined) || null : null);

interface Part {
  path: string;
  doc: Document;
  rels: Record<string, string>;
}

interface Ctx {
  zip: JSZip;
  theme: Record<string, string>;
  majorFont: string;
  minorFont: string;
  cache: Map<string, Part>;
  media: Map<string, string>;
}

function resolvePath(base: string, target: string) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/');
  parts.pop();
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

async function loadPart(ctx: Ctx, path: string): Promise<Part | null> {
  if (ctx.cache.has(path)) return ctx.cache.get(path)!;
  const f = ctx.zip.file(path);
  if (!f) return null;
  const doc = new DOMParser().parseFromString(await f.async('string'), 'application/xml');
  const rels: Record<string, string> = {};
  const relPath = path.replace(/([^/]+)$/, '_rels/$1.rels');
  const rf = ctx.zip.file(relPath);
  if (rf) {
    const rd = new DOMParser().parseFromString(await rf.async('string'), 'application/xml');
    for (const r of Array.from(rd.getElementsByTagName('Relationship'))) {
      const mode = r.getAttribute('TargetMode');
      rels[r.getAttribute('Id')!] = mode === 'External' ? r.getAttribute('Target')! : resolvePath(path, r.getAttribute('Target')!);
    }
  }
  const part = { path, doc, rels };
  ctx.cache.set(path, part);
  return part;
}

const relOfType = async (ctx: Ctx, part: Part, type: string) => {
  const relPath = part.path.replace(/([^/]+)$/, '_rels/$1.rels');
  const rf = ctx.zip.file(relPath);
  if (!rf) return null;
  const rd = new DOMParser().parseFromString(await rf.async('string'), 'application/xml');
  const r = Array.from(rd.getElementsByTagName('Relationship')).find((x) => (x.getAttribute('Type') || '').endsWith('/' + type));
  return r ? resolvePath(part.path, r.getAttribute('Target')!) : null;
};

// ---------- Colours ----------
function hexToRgb(h: string) {
  const n = parseInt(h.replace('#', '').slice(0, 6), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex([r, g, b]: number[]) {
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}
function rgbToHsl([r, g, b]: number[]) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  let h = 0,
    s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}
function hslToRgb([h, s, l]: number[]) {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

function colorFrom(el: Element | null, ctx: Ctx, phClr?: string): string | null {
  if (!el) return null;
  const c = Array.from(el.children).find((x) => ['srgbClr', 'schemeClr', 'sysClr', 'prstClr', 'scrgbClr'].includes(x.localName));
  if (!c) return null;
  let hex: string | null = null;
  const val = c.getAttribute('val') || '';
  if (c.localName === 'srgbClr') hex = '#' + val;
  else if (c.localName === 'sysClr') hex = '#' + (c.getAttribute('lastClr') || (val === 'window' ? 'FFFFFF' : '000000'));
  else if (c.localName === 'schemeClr') {
    const map: Record<string, string> = { tx1: 'dk1', bg1: 'lt1', tx2: 'dk2', bg2: 'lt2' };
    hex = val === 'phClr' ? phClr || null : ctx.theme[map[val] || val] || null;
  } else if (c.localName === 'prstClr') hex = ({ black: '#000000', white: '#ffffff', red: '#ff0000', blue: '#0000ff', green: '#008000', yellow: '#ffff00' } as any)[val] || '#000000';
  if (!hex) return null;
  let rgb = hexToRgb(hex);
  for (const m of Array.from(c.children)) {
    const v = parseInt(m.getAttribute('val') || '0', 10) / 100000;
    if (m.localName === 'lumMod' || m.localName === 'lumOff') {
      const hsl = rgbToHsl(rgb);
      hsl[2] = m.localName === 'lumMod' ? hsl[2] * v : Math.min(1, hsl[2] + v);
      rgb = hslToRgb(hsl);
    } else if (m.localName === 'tint') rgb = rgb.map((x) => x + (255 - x) * (1 - v));
    else if (m.localName === 'shade') rgb = rgb.map((x) => x * v);
  }
  return rgbToHex(rgb);
}

function fillOf(spPr: Element | null, ctx: Ctx): string | null | undefined {
  if (!spPr) return undefined;
  if (kid(spPr, 'noFill')) return null;
  const solid = kid(spPr, 'solidFill');
  if (solid) return colorFrom(solid, ctx);
  const grad = kid(spPr, 'gradFill');
  if (grad) return colorFrom(desc(grad, 'gs'), ctx);
  return undefined;
}

// ---------- Placeholders & text styles ----------
interface PhInfo {
  type: string;
  idx: string;
}
function phOf(sp: Element): PhInfo | null {
  const nv = kid(sp, 'nvSpPr') || kid(sp, 'nvPicPr') || kid(sp, 'nvGraphicFramePr');
  const ph = desc(kid(nv, 'nvPr'), 'ph') || (kid(nv, 'nvPr') ? Array.from(kid(nv, 'nvPr')!.children).find((c) => c.localName === 'ph') || null : null);
  if (!ph) return null;
  return { type: ph.getAttribute('type') || 'body', idx: ph.getAttribute('idx') || '' };
}

function findPh(tree: Element | null, ph: PhInfo): Element | null {
  if (!tree) return null;
  const shapes = Array.from(tree.getElementsByTagNameNS(P, 'sp'));
  const norm = (t: string) => (t === 'ctrTitle' ? 'title' : t === 'subTitle' ? 'body' : t);
  return (
    shapes.find((s) => {
      const p = phOf(s);
      return p && ph.idx && p.idx === ph.idx;
    }) ||
    shapes.find((s) => {
      const p = phOf(s);
      return p && norm(p.type) === norm(ph.type);
    }) ||
    null
  );
}

function xfrmOf(sp: Element | null) {
  const x = desc(kid(sp, 'spPr') || kid(sp, 'grpSpPr'), 'xfrm') || (sp ? kid(sp, 'xfrm') : null);
  if (!x) return null;
  const off = kid(x, 'off'),
    ext = kid(x, 'ext');
  if (!off || !ext) return null;
  return {
    x: +off.getAttribute('x')! / EMU,
    y: +off.getAttribute('y')! / EMU,
    w: +ext.getAttribute('cx')! / EMU,
    h: +ext.getAttribute('cy')! / EMU,
    rot: +(x.getAttribute('rot') || 0) / 60000,
    flipH: x.getAttribute('flipH') === '1',
    flipV: x.getAttribute('flipV') === '1'
  };
}

interface Defaults {
  size?: number;
  color?: string;
  font?: string;
  bold?: boolean;
  align?: string;
  bullet?: boolean;
}

function lvlDefaults(lstStyle: Element | null, lvl: number, ctx: Ctx): Defaults {
  const lp = kid(lstStyle, `lvl${lvl + 1}pPr`);
  if (!lp) return {};
  const d: Defaults = {};
  const r = kid(lp, 'defRPr');
  if (r?.getAttribute('sz')) d.size = +r.getAttribute('sz')! / 100;
  if (r?.getAttribute('b')) d.bold = r.getAttribute('b') === '1';
  const c = colorFrom(kid(r, 'solidFill'), ctx);
  if (c) d.color = c;
  const latin = kid(r, 'latin')?.getAttribute('typeface');
  if (latin) d.font = fontName(latin, ctx);
  if (lp.getAttribute('algn')) d.align = lp.getAttribute('algn')!;
  if (kid(lp, 'buNone')) d.bullet = false;
  else if (kid(lp, 'buChar') || kid(lp, 'buAutoNum')) d.bullet = true;
  return d;
}

const fontName = (tf: string, ctx: Ctx) => (tf === '+mj-lt' ? ctx.majorFont : tf === '+mn-lt' ? ctx.minorFont : tf);

const ALIGN: Record<string, string> = { l: 'left', ctr: 'center', r: 'right', just: 'justify', dist: 'justify' };

/** Convert a txBody to HTML. `chain` lists default sources, most specific first. */
function textHtml(txBody: Element, chain: (Element | null)[], ctx: Ctx, base: Defaults, over: Defaults = {}): { html: string; size?: number } {
  // Priority (low → high): base, master styles, inherited placeholders, the shape's style (over), its own list style.
  const lst = (lvl: number): Defaults => {
    const out: Defaults = { ...base };
    const merge = (d: Defaults) => Object.assign(out, Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined)));
    for (const src of chain.slice(1).reverse()) merge(lvlDefaults(src, lvl, ctx));
    merge(over);
    merge(lvlDefaults(chain[0], lvl, ctx));
    return out;
  };
  const autofit = kid(kid(txBody, 'bodyPr'), 'normAutofit');
  const scale = autofit?.getAttribute('fontScale') ? +autofit.getAttribute('fontScale')! / 100000 : 1;
  let html = '';
  let listOpen: 'ul' | 'ol' | null = null;
  let firstSize: number | undefined;
  for (const p of kids(txBody, 'p')) {
    const pPr = kid(p, 'pPr');
    const lvl = +(pPr?.getAttribute('lvl') || 0);
    const d = lst(lvl);
    const align = ALIGN[pPr?.getAttribute('algn') || d.align || 'l'] || 'left';
    let bullet = d.bullet ?? false;
    let ordered = false;
    if (kid(pPr, 'buNone')) bullet = false;
    if (kid(pPr, 'buChar')) bullet = true;
    if (kid(pPr, 'buAutoNum')) {
      bullet = true;
      ordered = true;
    }
    let runs = '';
    for (const r of Array.from(p.children)) {
      if (r.localName === 'br') {
        runs += '<br>';
        continue;
      }
      if (r.localName !== 'r' && r.localName !== 'fld') continue;
      const rPr = kid(r, 'rPr');
      const t = escapeHtml(kid(r, 't')?.textContent || '');
      if (!t) continue;
      const size = (rPr?.getAttribute('sz') ? +rPr.getAttribute('sz')! / 100 : d.size) || 18;
      if (firstSize === undefined) firstSize = size * scale;
      const color = colorFrom(kid(rPr, 'solidFill'), ctx) || d.color;
      const latin = kid(rPr, 'latin')?.getAttribute('typeface');
      const font = latin ? fontName(latin, ctx) : d.font;
      const css = [`font-size:${Math.round(size * scale * 10) / 10}px`];
      if (color) css.push(`color:${color}`);
      if (font) css.push(`font-family:'${font}'`);
      let out = `<span style="${css.join(';')}">${t}</span>`;
      const b = rPr?.getAttribute('b') ? rPr.getAttribute('b') === '1' : d.bold;
      if (b) out = `<b>${out}</b>`;
      if (rPr?.getAttribute('i') === '1') out = `<i>${out}</i>`;
      if (rPr?.getAttribute('u') && rPr.getAttribute('u') !== 'none') out = `<u>${out}</u>`;
      runs += out;
    }
    const empty = !runs;
    if (bullet && !empty) {
      const tag = ordered ? 'ol' : 'ul';
      if (listOpen !== tag) {
        if (listOpen) html += `</${listOpen}>`;
        html += `<${tag}>`;
        listOpen = tag;
      }
      html += `<li style="text-align:${align};margin-left:${lvl * 24}px">${runs}</li>`;
    } else {
      if (listOpen) {
        html += `</${listOpen}>`;
        listOpen = null;
      }
      const endSize = kid(p, 'endParaRPr')?.getAttribute('sz');
      const sz = endSize ? (+endSize / 100) * scale : (d.size || 18) * scale;
      html += `<p style="text-align:${align}">${empty ? `<span style="font-size:${sz}px"><br></span>` : runs}</p>`;
    }
  }
  if (listOpen) html += `</${listOpen}>`;
  return { html, size: firstSize };
}

const PRST: Record<string, ShapeKind> = {
  rect: 'rect',
  roundRect: 'roundRect',
  ellipse: 'ellipse',
  triangle: 'triangle',
  line: 'line',
  straightConnector1: 'line',
  rightArrow: 'arrow'
};

async function imageData(ctx: Ctx, part: Part, rid: string | null): Promise<string> {
  if (!rid || !part.rels[rid]) return '';
  const path = part.rels[rid];
  if (ctx.media.has(path)) return ctx.media.get(path)!;
  const f = ctx.zip.file(path);
  if (!f) return '';
  const ext = path.split('.').pop()!.toLowerCase();
  if (ext === 'emf' || ext === 'wmf' || ext === 'tif' || ext === 'tiff') return '';
  const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'svg' ? 'image/svg+xml' : ext === 'bmp' ? 'image/bmp' : 'image/jpeg';
  const url = `data:${mime};base64,${await f.async('base64')}`;
  ctx.media.set(path, url);
  return url;
}

interface Inherit {
  layout: Part | null;
  master: Part | null;
  masterTx: { title: Element | null; body: Element | null; other: Element | null };
}

async function shapesFrom(tree: Element, part: Part, ctx: Ctx, inh: Inherit, opts: { locked: boolean; skipPh: boolean }, group?: { ox: number; oy: number; sx: number; sy: number }): Promise<El[]> {
  const out: El[] = [];
  const map = (x: { x: number; y: number; w: number; h: number }) =>
    group ? { x: group.ox + x.x * group.sx, y: group.oy + x.y * group.sy, w: x.w * group.sx, h: x.h * group.sy } : x;

  for (const node of Array.from(tree.children)) {
    const name = node.localName;
    if (name === 'grpSp') {
      const gx = desc(kid(node, 'grpSpPr'), 'xfrm');
      if (!gx) continue;
      const off = kid(gx, 'off'),
        ext = kid(gx, 'ext'),
        chOff = kid(gx, 'chOff'),
        chExt = kid(gx, 'chExt');
      if (!off || !ext || !chOff || !chExt) continue;
      const o = map({ x: +off.getAttribute('x')! / EMU, y: +off.getAttribute('y')! / EMU, w: +ext.getAttribute('cx')! / EMU, h: +ext.getAttribute('cy')! / EMU });
      const cw = +chExt.getAttribute('cx')! / EMU || 1,
        ch = +chExt.getAttribute('cy')! / EMU || 1;
      const sx = o.w / cw,
        sy = o.h / ch;
      out.push(...(await shapesFrom(node, part, ctx, inh, opts, { ox: o.x - (+chOff.getAttribute('x')! / EMU) * sx, oy: o.y - (+chOff.getAttribute('y')! / EMU) * sy, sx, sy })));
      continue;
    }
    if (name !== 'sp' && name !== 'pic' && name !== 'cxnSp' && name !== 'graphicFrame') continue;
    const ph = phOf(node);
    if (opts.skipPh && ph) continue;
    const layoutPh = ph ? findPh(desc(inh.layout?.doc.documentElement, 'spTree') || inh.layout?.doc.getElementsByTagNameNS(P, 'spTree')[0] || null, ph) : null;
    const masterPh = ph ? findPh(inh.master?.doc.getElementsByTagNameNS(P, 'spTree')[0] || null, ph) : null;
    let xf = xfrmOf(node) || xfrmOf(layoutPh) || xfrmOf(masterPh);
    if (name === 'graphicFrame' && !xf) {
      const gx = kid(node, 'xfrm');
      if (gx) xf = xfrmOf(node);
    }
    if (!xf) continue;
    const box = map(xf);
    const spPr = kid(node, 'spPr');
    const base: Partial<El> = { id: uid(), x: box.x, y: box.y, w: Math.max(1, box.w), h: Math.max(1, box.h), rot: xf.rot || undefined, flipH: xf.flipH || undefined, flipV: xf.flipV || undefined, locked: opts.locked || undefined };

    if (name === 'pic') {
      const blip = desc(kid(node, 'blipFill'), 'blip');
      const src = await imageData(ctx, part, blip?.getAttributeNS(R, 'embed') || null);
      if (src) out.push({ ...base, type: 'image', src } as El);
      continue;
    }

    if (name === 'graphicFrame') {
      // Tables become a text box with one paragraph per row.
      const tbl = desc(node, 'tbl');
      if (!tbl) continue;
      const rows = Array.from(tbl.getElementsByTagNameNS(A, 'tr')).map((tr) =>
        Array.from(tr.getElementsByTagNameNS(A, 'tc'))
          .map((tc) => escapeHtml(Array.from(tc.getElementsByTagNameNS(A, 't')).map((t) => t.textContent).join(' ')))
          .join(' &nbsp;·&nbsp; ')
      );
      out.push({ ...base, type: 'text', shape: 'rect', fill: null, stroke: '#9aa0a6', strokeW: 0.75, size: 14, color: ctx.theme.dk1 || '#000000', font: ctx.minorFont, html: rows.map((r) => `<p>${r}</p>`).join('') } as El);
      continue;
    }

    const prst = desc(spPr, 'prstGeom')?.getAttribute('prst') || (name === 'cxnSp' ? 'line' : 'rect');
    const shape: ShapeKind = PRST[prst] || (desc(spPr, 'custGeom') ? 'rect' : 'rect');
    const styleEl = kid(node, 'style');
    const styleFill = colorFrom(kid(styleEl, 'fillRef'), ctx);
    const styleLine = colorFrom(kid(styleEl, 'lnRef'), ctx);
    let fill = fillOf(spPr, ctx);
    if (fill === undefined) fill = fillOf(kid(layoutPh, 'spPr'), ctx);
    if (fill === undefined) fill = styleEl && kid(styleEl, 'fillRef')?.getAttribute('idx') !== '0' ? styleFill : null;
    const ln = kid(spPr, 'ln');
    let stroke: string | null = null;
    let strokeW = 0;
    if (ln && !kid(ln, 'noFill')) {
      stroke = colorFrom(kid(ln, 'solidFill'), ctx) || styleLine;
      strokeW = ln.getAttribute('w') ? +ln.getAttribute('w')! / EMU : 0.75;
    } else if (!ln && styleEl && kid(styleEl, 'lnRef')?.getAttribute('idx') !== '0' && styleLine) {
      stroke = styleLine;
      strokeW = 0.75;
    }
    if (name === 'cxnSp' && !stroke) {
      stroke = styleLine || '#000000';
      strokeW = strokeW || 1;
    }

    const tx = kid(node, 'txBody');
    let html = '';
    let size: number | undefined;
    let valign: El['valign'] = 'top';
    let role: El['role'];
    if (tx) {
      const phType = ph?.type || '';
      const isTitle = phType === 'title' || phType === 'ctrTitle';
      role = isTitle ? 'title' : phType === 'subTitle' ? 'subtitle' : ph ? 'body' : undefined;
      const masterStyle = isTitle ? inh.masterTx.title : ph && phType !== 'dt' && phType !== 'ftr' && phType !== 'sldNum' ? inh.masterTx.body : inh.masterTx.other;
      const chain = [kid(tx, 'lstStyle'), kid(kid(layoutPh, 'txBody'), 'lstStyle'), kid(kid(masterPh, 'txBody'), 'lstStyle'), masterStyle];
      const fontRef = colorFrom(kid(styleEl, 'fontRef'), ctx);
      const baseDefaults: Defaults = { size: 18, color: ctx.theme.dk1, font: isTitle ? ctx.majorFont : ctx.minorFont };
      const over: Defaults = fontRef ? { color: fontRef } : {};
      if (phType === 'subTitle') over.bullet = false;
      if (!ph) over.bullet = false;
      // Filled or non-rectangular autoshapes centre their text unless told otherwise; plain text boxes don't.
      if (!ph && name === 'sp' && (shape !== 'rect' || !!fill)) over.align = 'ctr';
      const r = textHtml(tx, chain, ctx, baseDefaults, over);
      html = r.html;
      size = r.size;
      const anchor = kid(tx, 'bodyPr')?.getAttribute('anchor') || kid(kid(layoutPh, 'txBody'), 'bodyPr')?.getAttribute('anchor') || kid(kid(masterPh, 'txBody'), 'bodyPr')?.getAttribute('anchor');
      valign = anchor === 'ctr' ? 'middle' : anchor === 'b' ? 'bottom' : 'top';
      // Skip empty placeholders: they are prompts like "Click to add title" in PowerPoint.
      if (ph && !html.replace(/<[^>]+>/g, '').trim() && !fill && !stroke) continue;
    }
    const hasText = !!html.replace(/<[^>]+>/g, '').trim();
    if (!hasText && !fill && !stroke) continue;
    out.push({
      ...base,
      type: hasText ? 'text' : 'shape',
      shape: hasText && shape === 'rect' && !fill && !stroke ? 'none' : shape,
      fill: fill ?? null,
      stroke,
      strokeW,
      html: hasText ? html : undefined,
      size,
      valign,
      role
    } as El);
  }
  return out;
}

async function background(part: Part | null, ctx: Ctx): Promise<string | null> {
  const bg = part?.doc.getElementsByTagNameNS(P, 'bg')[0];
  if (!bg) return null;
  const bgPr = kid(bg, 'bgPr');
  if (bgPr) return fillOf(bgPr, ctx) || colorFrom(desc(kid(bgPr, 'gradFill'), 'gs'), ctx) || null;
  const ref = kid(bg, 'bgRef');
  if (ref) return colorFrom(ref, ctx);
  return null;
}

export async function readPptx(bytes: Uint8Array): Promise<Deck> {
  const zip = await JSZip.loadAsync(bytes);
  const ctx: Ctx = { zip, theme: {}, majorFont: 'Calibri Light', minorFont: 'Calibri', cache: new Map(), media: new Map() };
  const pres = await loadPart(ctx, 'ppt/presentation.xml');
  if (!pres) throw new Error('This file is not a valid PowerPoint presentation.');
  const sz = pres.doc.getElementsByTagNameNS(P, 'sldSz')[0];
  const w = sz ? +sz.getAttribute('cx')! / EMU : 960;
  const h = sz ? +sz.getAttribute('cy')! / EMU : 540;

  const themePath = await relOfType(ctx, pres, 'theme');
  const theme = themePath ? await loadPart(ctx, themePath) : null;
  if (theme) {
    const scheme = theme.doc.getElementsByTagNameNS(A, 'clrScheme')[0];
    for (const c of Array.from(scheme?.children || [])) {
      const v = c.firstElementChild;
      if (!v) continue;
      ctx.theme[c.localName] = '#' + (v.getAttribute('lastClr') || v.getAttribute('val') || '000000');
    }
    const major = theme.doc.getElementsByTagNameNS(A, 'majorFont')[0];
    const minor = theme.doc.getElementsByTagNameNS(A, 'minorFont')[0];
    ctx.majorFont = kid(major, 'latin')?.getAttribute('typeface') || ctx.majorFont;
    ctx.minorFont = kid(minor, 'latin')?.getAttribute('typeface') || ctx.minorFont;
  }

  const slides: Slide[] = [];
  const ids = Array.from(pres.doc.getElementsByTagNameNS(P, 'sldId'));
  for (const sid of ids) {
    const rid = sid.getAttributeNS(R, 'id');
    const path = rid && pres.rels[rid];
    if (!path) continue;
    const slide = await loadPart(ctx, path);
    if (!slide) continue;
    if (slide.doc.documentElement.getAttribute('show') === '0') continue;
    const layoutPath = await relOfType(ctx, slide, 'slideLayout');
    const layout = layoutPath ? await loadPart(ctx, layoutPath) : null;
    const masterPath = layout ? await relOfType(ctx, layout, 'slideMaster') : null;
    const master = masterPath ? await loadPart(ctx, masterPath) : null;
    const txStyles = master?.doc.getElementsByTagNameNS(P, 'txStyles')[0] || null;
    const inh: Inherit = { layout, master, masterTx: { title: kid(txStyles, 'titleStyle'), body: kid(txStyles, 'bodyStyle'), other: kid(txStyles, 'otherStyle') } };

    const bg = (await background(slide, ctx)) || (await background(layout, ctx)) || (await background(master, ctx)) || ctx.theme.lt1 || '#ffffff';
    const els: El[] = [];
    const showMaster = (d: Document | undefined) => d?.documentElement.getAttribute('showMasterSp') !== '0';
    if (master && showMaster(slide.doc) && showMaster(layout?.doc)) {
      const tree = master.doc.getElementsByTagNameNS(P, 'spTree')[0];
      if (tree) els.push(...(await shapesFrom(tree, master, ctx, inh, { locked: true, skipPh: true })));
    }
    if (layout && showMaster(slide.doc)) {
      const tree = layout.doc.getElementsByTagNameNS(P, 'spTree')[0];
      if (tree) els.push(...(await shapesFrom(tree, layout, ctx, inh, { locked: true, skipPh: true })));
    }
    const tree = slide.doc.getElementsByTagNameNS(P, 'spTree')[0];
    if (tree) els.push(...(await shapesFrom(tree, slide, ctx, inh, { locked: false, skipPh: false })));

    let notes = '';
    const notesPath = await relOfType(ctx, slide, 'notesSlide');
    if (notesPath) {
      const np = await loadPart(ctx, notesPath);
      const body = Array.from(np?.doc.getElementsByTagNameNS(P, 'sp') || []).find((s) => phOf(s)?.type === 'body');
      if (body) notes = Array.from(body.getElementsByTagNameNS(A, 'p')).map((p) => Array.from(p.getElementsByTagNameNS(A, 't')).map((t) => t.textContent).join('')).join('\n').trim();
    }
    slides.push({ id: uid(), bg, els, notes });
  }
  if (!slides.length) slides.push({ id: uid(), bg: '#ffffff', els: [], notes: '' });
  return { w, h, slides, font: ctx.minorFont };
}
