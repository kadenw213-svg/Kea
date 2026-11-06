import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { escapeHtml } from '../../lib/util';

// ---------------------------------------------------------------------------
// OpenDocument Text (.odt)
// ---------------------------------------------------------------------------
const TEXT = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0';
const STYLE = 'urn:oasis:names:tc:opendocument:xmlns:style:1.0';
const FO = 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0';
const TABLE = 'urn:oasis:names:tc:opendocument:xmlns:table:1.0';
const DRAW = 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0';
const XLINK = 'http://www.w3.org/1999/xlink';

interface OdtStyle {
  css: string[];
  b?: boolean;
  i?: boolean;
  u?: boolean;
  s?: boolean;
  align?: string;
  parent?: string;
  heading?: number;
}

export async function odtToHtml(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const content = await zip.file('content.xml')?.async('string');
  if (!content) throw new Error('This file is not a valid OpenDocument text file.');
  const doc = new DOMParser().parseFromString(content, 'application/xml');
  const stylesXml = await zip.file('styles.xml')?.async('string');
  const styles = new Map<string, OdtStyle>();

  const readStyles = (d: Document) => {
    for (const st of Array.from(d.getElementsByTagNameNS(STYLE, 'style'))) {
      const name = st.getAttributeNS(STYLE, 'name')!;
      const s: OdtStyle = { css: [], parent: st.getAttributeNS(STYLE, 'parent-style-name') || undefined };
      const tp = st.getElementsByTagNameNS(STYLE, 'text-properties')[0];
      if (tp) {
        if (tp.getAttributeNS(FO, 'font-weight') === 'bold') s.b = true;
        if (tp.getAttributeNS(FO, 'font-style') === 'italic') s.i = true;
        const u = tp.getAttributeNS(STYLE, 'text-underline-style');
        if (u && u !== 'none') s.u = true;
        const lt = tp.getAttributeNS(STYLE, 'text-line-through-style');
        if (lt && lt !== 'none') s.s = true;
        const color = tp.getAttributeNS(FO, 'color');
        if (color && color !== '#000000') s.css.push(`color: ${color}`);
        const size = tp.getAttributeNS(FO, 'font-size');
        if (size && size.endsWith('pt')) s.css.push(`font-size: ${size}`);
        const bg = tp.getAttributeNS(FO, 'background-color');
        if (bg && bg !== 'transparent') s.css.push(`background-color: ${bg}`);
        const font = tp.getAttributeNS(STYLE, 'font-name');
        if (font) s.css.push(`font-family: '${font}'`);
      }
      const pp = st.getElementsByTagNameNS(STYLE, 'paragraph-properties')[0];
      const align = pp?.getAttributeNS(FO, 'text-align');
      if (align) s.align = align === 'end' ? 'right' : align === 'start' ? 'left' : align;
      const lvl = st.getAttributeNS(STYLE, 'default-outline-level');
      if (lvl) s.heading = +lvl;
      styles.set(name, s);
    }
  };
  if (stylesXml) readStyles(new DOMParser().parseFromString(stylesXml, 'application/xml'));
  readStyles(doc);

  const resolve = (name: string | null): OdtStyle => {
    const out: OdtStyle = { css: [] };
    let cur = name ? styles.get(name) : undefined;
    const chain: OdtStyle[] = [];
    let guard = 0;
    while (cur && guard++ < 8) {
      chain.unshift(cur);
      cur = cur.parent ? styles.get(cur.parent) : undefined;
    }
    for (const s of chain) {
      out.css.push(...s.css);
      out.b = s.b ?? out.b;
      out.i = s.i ?? out.i;
      out.u = s.u ?? out.u;
      out.s = s.s ?? out.s;
      out.align = s.align ?? out.align;
      out.heading = s.heading ?? out.heading;
    }
    return out;
  };

  const images = new Map<string, string>();
  const imageUrl = async (href: string) => {
    if (images.has(href)) return images.get(href)!;
    const f = zip.file(href);
    if (!f) return '';
    const ext = href.split('.').pop()!.toLowerCase();
    const url = `data:${ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'svg' ? 'image/svg+xml' : 'image/jpeg'};base64,${await f.async('base64')}`;
    images.set(href, url);
    return url;
  };

  const inline = async (node: Element): Promise<string> => {
    let html = '';
    for (const c of Array.from(node.childNodes)) {
      if (c.nodeType === Node.TEXT_NODE) {
        html += escapeHtml(c.textContent || '');
        continue;
      }
      if (c.nodeType !== Node.ELEMENT_NODE) continue;
      const e = c as Element;
      switch (e.localName) {
        case 's':
          html += ' '.repeat(+(e.getAttributeNS(TEXT, 'c') || 1));
          break;
        case 'tab':
          html += '\t';
          break;
        case 'line-break':
          html += '<br>';
          break;
        case 'span': {
          const st = resolve(e.getAttributeNS(TEXT, 'style-name'));
          let inner = await inline(e);
          if (st.css.length) inner = `<span style="${st.css.join('; ')}">${inner}</span>`;
          if (st.b) inner = `<strong>${inner}</strong>`;
          if (st.i) inner = `<em>${inner}</em>`;
          if (st.u) inner = `<u>${inner}</u>`;
          if (st.s) inner = `<s>${inner}</s>`;
          html += inner;
          break;
        }
        case 'a':
          html += `<a href="${escapeHtml(e.getAttributeNS(XLINK, 'href') || '')}">${await inline(e)}</a>`;
          break;
        case 'frame': {
          const img = e.getElementsByTagNameNS(DRAW, 'image')[0];
          const href = img?.getAttributeNS(XLINK, 'href');
          if (href) {
            const src = await imageUrl(href);
            if (src) html += `\u0000<img src="${src}">\u0000`;
          }
          break;
        }
        case 'note':
        case 'bookmark':
        case 'bookmark-start':
        case 'bookmark-end':
        case 'soft-page-break':
          break;
        default:
          html += await inline(e);
      }
    }
    return html;
  };

  const para = async (e: Element, tag?: string): Promise<string> => {
    const st = resolve(e.getAttributeNS(TEXT, 'style-name'));
    const level = e.localName === 'h' ? +(e.getAttributeNS(TEXT, 'outline-level') || st.heading || 1) : 0;
    const t = tag || (level ? `h${Math.min(4, level)}` : 'p');
    const style = st.align && st.align !== 'left' ? ` style="text-align: ${st.align}"` : '';
    let inner = await inline(e);
    if (t === 'p' && st.b && !inner.includes('<strong>')) inner = `<strong>${inner}</strong>`;
    // Images were marked so they can be lifted out of the paragraph.
    return inner
      .split('\u0000')
      .map((part) => (part.startsWith('<img') ? part : `<${t}${style}>${part}</${t}>`))
      .join('');
  };

  const block = async (e: Element, listDepth = 0): Promise<string> => {
    switch (e.localName) {
      case 'p':
      case 'h':
        return para(e);
      case 'list': {
        const styleName = e.getAttributeNS(TEXT, 'style-name') || '';
        const numbered = Array.from(doc.getElementsByTagNameNS(TEXT, 'list-style')).some(
          (ls) => ls.getAttributeNS(STYLE, 'name') === styleName && ls.getElementsByTagNameNS(TEXT, 'list-level-style-number').length > 0 && ls.getElementsByTagNameNS(TEXT, 'list-level-style-bullet').length === 0
        );
        let items = '';
        for (const li of Array.from(e.children)) {
          if (li.localName !== 'list-item' && li.localName !== 'list-header') continue;
          let inner = '';
          for (const c of Array.from(li.children)) inner += await block(c, listDepth + 1);
          items += `<li>${inner}</li>`;
        }
        return `<${numbered ? 'ol' : 'ul'}>${items}</${numbered ? 'ol' : 'ul'}>`;
      }
      case 'table': {
        let rows = '';
        for (const row of Array.from(e.getElementsByTagNameNS(TABLE, 'table-row'))) {
          let cells = '';
          for (const cell of Array.from(row.children)) {
            if (cell.localName !== 'table-cell') continue;
            const span = +(cell.getAttributeNS(TABLE, 'number-columns-spanned') || 1);
            let inner = '';
            for (const c of Array.from(cell.children)) inner += await block(c, listDepth);
            cells += `<td${span > 1 ? ` colspan="${span}"` : ''}>${inner || '<p></p>'}</td>`;
          }
          rows += `<tr>${cells}</tr>`;
        }
        return `<table><tbody>${rows}</tbody></table>`;
      }
      case 'section':
      case 'index-body':
      case 'table-of-content': {
        let out = '';
        for (const c of Array.from(e.children)) out += await block(c, listDepth);
        return out;
      }
      default:
        return '';
    }
  };

  const body = doc.getElementsByTagNameNS('urn:oasis:names:tc:opendocument:xmlns:office:1.0', 'text')[0];
  let html = '';
  for (const c of Array.from(body?.children || [])) html += await block(c);
  return html || '<p></p>';
}

// ---------------------------------------------------------------------------
// Rich Text Format (.rtf)
// ---------------------------------------------------------------------------
export function rtfToHtml(rtf: string): string {
  interface State {
    b: boolean;
    i: boolean;
    u: boolean;
    s: boolean;
    fs: number;
    cf: number;
    skip: boolean;
    uc: number;
  }
  const colors: string[] = ['inherit'];
  let state: State = { b: false, i: false, u: false, s: false, fs: 24, cf: 0, skip: false, uc: 1 };
  const stack: State[] = [];
  const paragraphs: string[] = [];
  let cur = '';
  let align = 'left';
  let run = '';
  let runState: State | null = null;
  let skipChars = 0;

  const flushRun = () => {
    if (!run) return;
    const st = runState!;
    let html = escapeHtml(run);
    const css: string[] = [];
    if (st.fs !== 24) css.push(`font-size: ${st.fs / 2}pt`);
    if (st.cf && colors[st.cf] && colors[st.cf] !== 'inherit') css.push(`color: ${colors[st.cf]}`);
    if (css.length) html = `<span style="${css.join('; ')}">${html}</span>`;
    if (st.b) html = `<strong>${html}</strong>`;
    if (st.i) html = `<em>${html}</em>`;
    if (st.u) html = `<u>${html}</u>`;
    if (st.s) html = `<s>${html}</s>`;
    cur += html;
    run = '';
  };
  const emit = (text: string) => {
    if (state.skip) return;
    if (skipChars > 0) {
      skipChars--;
      return;
    }
    if (runState && (runState.b !== state.b || runState.i !== state.i || runState.u !== state.u || runState.s !== state.s || runState.fs !== state.fs || runState.cf !== state.cf)) flushRun();
    runState = { ...state };
    run += text;
  };
  const endPara = () => {
    flushRun();
    paragraphs.push(`<p${align !== 'left' ? ` style="text-align: ${align}"` : ''}>${cur}</p>`);
    cur = '';
  };

  // Colour table
  const ct = rtf.match(/\{\\colortbl\s*;?([^}]*)\}/);
  if (ct) {
    for (const entry of ct[1].split(';')) {
      const r = entry.match(/\\red(\d+)/),
        g = entry.match(/\\green(\d+)/),
        b = entry.match(/\\blue(\d+)/);
      if (r && g && b) colors.push('#' + [r[1], g[1], b[1]].map((v) => (+v).toString(16).padStart(2, '0')).join(''));
    }
  }

  const SKIP_DEST = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'header', 'footer', 'headerl', 'headerr', 'footerl', 'footerr', 'footnote', 'listtable', 'listoverridetable', 'rsidtbl', 'generator', 'xmlnstbl', 'themedata', 'colorschememapping', 'latentstyles', 'datastore', 'mmathPr', 'object', 'fldinst', 'bkmkstart', 'bkmkend', 'pnseclvl', 'pntext']);
  let i = 0;
  while (i < rtf.length) {
    const ch = rtf[i];
    if (ch === '{') {
      stack.push({ ...state });
      i++;
      if (rtf.startsWith('\\*', i)) {
        state.skip = true;
        i += 2;
      }
      continue;
    }
    if (ch === '}') {
      flushRun();
      state = stack.pop() || state;
      i++;
      continue;
    }
    if (ch === '\\') {
      const next = rtf[i + 1];
      if (next === '\\' || next === '{' || next === '}') {
        emit(next);
        i += 2;
        continue;
      }
      if (next === "'") {
        const code = parseInt(rtf.substr(i + 2, 2), 16);
        emit(new TextDecoder('windows-1252').decode(new Uint8Array([code])));
        i += 4;
        continue;
      }
      if (next === '~') {
        emit(' ');
        i += 2;
        continue;
      }
      if (next === '\n' || next === '\r') {
        if (!state.skip) endPara();
        i += 2;
        continue;
      }
      const m = rtf.slice(i).match(/^\\([a-zA-Z]+)(-?\d+)? ?/);
      if (!m) {
        i += 2;
        continue;
      }
      i += m[0].length;
      const word = m[1];
      const arg = m[2] !== undefined ? +m[2] : undefined;
      if (SKIP_DEST.has(word)) {
        state.skip = true;
        continue;
      }
      if (state.skip) continue;
      switch (word) {
        case 'par':
        case 'sect':
          endPara();
          break;
        case 'line':
          flushRun();
          cur += '<br>';
          break;
        case 'tab':
          emit('\t');
          break;
        case 'pard':
          align = 'left';
          break;
        case 'qc':
          align = 'center';
          break;
        case 'qr':
          align = 'right';
          break;
        case 'qj':
          align = 'justify';
          break;
        case 'ql':
          align = 'left';
          break;
        case 'plain':
          state = { ...state, b: false, i: false, u: false, s: false, fs: 24, cf: 0 };
          break;
        case 'b':
          state.b = arg !== 0;
          break;
        case 'i':
          state.i = arg !== 0;
          break;
        case 'ul':
          state.u = arg !== 0;
          break;
        case 'ulnone':
          state.u = false;
          break;
        case 'strike':
          state.s = arg !== 0;
          break;
        case 'fs':
          state.fs = arg ?? 24;
          break;
        case 'cf':
          state.cf = arg ?? 0;
          break;
        case 'uc':
          state.uc = arg ?? 1;
          break;
        case 'u':
          if (arg !== undefined) {
            emit(String.fromCharCode(arg < 0 ? arg + 65536 : arg));
            skipChars = state.uc;
          }
          break;
        case 'emdash':
          emit('—');
          break;
        case 'endash':
          emit('–');
          break;
        case 'bullet':
          emit('•');
          break;
        case 'lquote':
          emit('‘');
          break;
        case 'rquote':
          emit('’');
          break;
        case 'ldblquote':
          emit('“');
          break;
        case 'rdblquote':
          emit('”');
          break;
      }
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      i++;
      continue;
    }
    emit(ch);
    i++;
  }
  flushRun();
  if (cur) endPara();
  return paragraphs.join('') || '<p></p>';
}

// ---------------------------------------------------------------------------
// Word 97-2003 (.doc): text extraction from the piece table
// ---------------------------------------------------------------------------
export function docToHtml(bytes: Uint8Array): string {
  const cfb = XLSX.CFB.read(bytes, { type: 'array' });
  const find = (name: string) => XLSX.CFB.find(cfb, name);
  const word = find('WordDocument');
  if (!word) throw new Error('This file is not a Word 97-2003 document.');
  const wd = toBytes(word.content);
  const view = new DataView(wd.buffer, wd.byteOffset, wd.byteLength);
  const flags = view.getUint16(0x0a, true);
  if (flags & 0x0100) throw new Error('This Word document is password protected.');
  const table = find(flags & 0x0200 ? '1Table' : '0Table');
  if (!table) throw new Error("Couldn't read this Word document.");
  const tb = toBytes(table.content);
  const tview = new DataView(tb.buffer, tb.byteOffset, tb.byteLength);
  const fcClx = view.getUint32(0x01a2, true);
  const lcbClx = view.getUint32(0x01a6, true);

  let pos = fcClx;
  const end = fcClx + lcbClx;
  let text = '';
  while (pos < end) {
    const type = tb[pos];
    if (type === 0x01) {
      pos += 3 + tview.getUint16(pos + 1, true);
    } else if (type === 0x02) {
      const lcb = tview.getUint32(pos + 1, true);
      const start = pos + 5;
      const n = (lcb - 4) / 12;
      for (let k = 0; k < n; k++) {
        const cpStart = tview.getUint32(start + k * 4, true);
        const cpEnd = tview.getUint32(start + (k + 1) * 4, true);
        const pcd = start + (n + 1) * 4 + k * 8;
        let fc = tview.getUint32(pcd + 2, true);
        const compressed = (fc & 0x40000000) !== 0;
        const len = cpEnd - cpStart;
        if (compressed) {
          fc = (fc & ~0x40000000) / 2;
          text += new TextDecoder('windows-1252').decode(wd.subarray(fc, fc + len));
        } else {
          text += new TextDecoder('utf-16le').decode(wd.subarray(fc, fc + len * 2));
        }
      }
      break;
    } else break;
  }
  if (!text) {
    // Very old files without a piece table store text right after the header.
    const fcMin = view.getUint32(0x18, true),
      fcMac = view.getUint32(0x1c, true);
    text = new TextDecoder('windows-1252').decode(wd.subarray(fcMin, fcMac));
  }
  // Drop field instructions (between 0x13 and 0x14), keep their results.
  text = text.replace(/\x13[^\x14\x15]*\x14?/g, '').replace(/\x15/g, '');
  const paras = text.split(/\r|\x07/).map((p) => p.replace(/[\x00-\x08\x0e-\x1f]/g, '').replace(/\x0b/g, '\n'));
  const out: string[] = [];
  let blank = 0;
  for (const p of paras) {
    if (p.includes('\x0c')) {
      out.push('<div data-type="page-break"></div>');
      continue;
    }
    if (!p.trim()) {
      if (++blank > 1) continue;
      out.push('<p></p>');
      continue;
    }
    blank = 0;
    out.push(`<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`);
  }
  return out.join('') || '<p></p>';
}

function toBytes(c: any): Uint8Array {
  if (c instanceof Uint8Array) return c;
  if (Array.isArray(c)) return Uint8Array.from(c);
  return new Uint8Array(c);
}
