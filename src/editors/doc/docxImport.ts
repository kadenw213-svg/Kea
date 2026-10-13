import JSZip from 'jszip';
import { escapeHtml } from '../../lib/util';

/**
 * Converts a .docx file to HTML that the editor understands. Covers paragraphs,
 * headings, lists, tables, images, links, page breaks and character formatting
 * (bold/italic/underline/strike, colour, highlight, size, font, super/subscript).
 */

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';

const HIGHLIGHT: Record<string, string> = {
  yellow: '#ffff00',
  green: '#00ff00',
  cyan: '#00ffff',
  magenta: '#ff00ff',
  blue: '#0000ff',
  red: '#ff0000',
  darkBlue: '#000080',
  darkCyan: '#008080',
  darkGreen: '#008000',
  darkMagenta: '#800080',
  darkRed: '#800000',
  darkYellow: '#808000',
  darkGray: '#808080',
  lightGray: '#c0c0c0',
  black: '#000000',
  white: '#ffffff'
};

interface RunProps {
  b?: boolean;
  i?: boolean;
  u?: boolean;
  s?: boolean;
  color?: string;
  size?: number; // pt
  font?: string;
  highlight?: string;
  vert?: 'sup' | 'sub';
}

interface StyleDef {
  name: string;
  basedOn?: string;
  rPr: RunProps;
  jc?: string;
  numId?: string;
  ilvl?: number;
  outline?: number;
}

const kids = (el: Element | null | undefined, local: string) =>
  el ? Array.from(el.children).filter((c) => c.localName === local) : [];
const kid = (el: Element | null | undefined, local: string) => kids(el, local)[0] || null;
const attr = (el: Element | null | undefined, name: string) => (el ? el.getAttributeNS(W, name) ?? el.getAttribute(`w:${name}`) : null);
const onOff = (el: Element | null) => {
  if (!el) return undefined;
  const v = attr(el, 'val');
  return !(v === '0' || v === 'false' || v === 'off' || v === 'none');
};

function parseRPr(rPr: Element | null): RunProps {
  const p: RunProps = {};
  if (!rPr) return p;
  const b = onOff(kid(rPr, 'b'));
  if (b !== undefined) p.b = b;
  const i = onOff(kid(rPr, 'i'));
  if (i !== undefined) p.i = i;
  const u = kid(rPr, 'u');
  if (u) p.u = attr(u, 'val') !== 'none';
  const s = onOff(kid(rPr, 'strike')) ?? onOff(kid(rPr, 'dstrike'));
  if (s !== undefined) p.s = s;
  const c = attr(kid(rPr, 'color'), 'val');
  if (c && c !== 'auto') p.color = '#' + c.toLowerCase();
  const sz = attr(kid(rPr, 'sz'), 'val');
  if (sz) p.size = parseInt(sz, 10) / 2;
  const fonts = kid(rPr, 'rFonts');
  const font = attr(fonts, 'ascii') || attr(fonts, 'hAnsi');
  if (font) p.font = font;
  const hl = attr(kid(rPr, 'highlight'), 'val');
  if (hl && hl !== 'none' && HIGHLIGHT[hl]) p.highlight = HIGHLIGHT[hl];
  const shd = attr(kid(rPr, 'shd'), 'fill');
  if (!p.highlight && shd && shd !== 'auto' && shd.toLowerCase() !== 'ffffff') p.highlight = '#' + shd.toLowerCase();
  const va = attr(kid(rPr, 'vertAlign'), 'val');
  if (va === 'superscript') p.vert = 'sup';
  if (va === 'subscript') p.vert = 'sub';
  return p;
}

export async function docxToHtml(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const read = async (path: string) => {
    const f = zip.file(path);
    return f ? f.async('string') : null;
  };
  const parse = (xml: string) => new DOMParser().parseFromString(xml, 'application/xml');

  const docXml = await read('word/document.xml');
  if (!docXml) throw new Error('This file is not a valid Word document.');
  const doc = parse(docXml);

  // Relationships (links + images)
  const rels: Record<string, { target: string; external: boolean }> = {};
  const relXml = await read('word/_rels/document.xml.rels');
  if (relXml) {
    for (const r of Array.from(parse(relXml).getElementsByTagName('Relationship'))) {
      rels[r.getAttribute('Id')!] = { target: r.getAttribute('Target')!, external: r.getAttribute('TargetMode') === 'External' };
    }
  }

  // Styles
  const styles: Record<string, StyleDef> = {};
  let defaultRun: RunProps = {};
  let defaultParaStyle = 'Normal';
  const stylesXml = await read('word/styles.xml');
  if (stylesXml) {
    const sd = parse(stylesXml);
    const rDef = sd.getElementsByTagNameNS(W, 'rPrDefault')[0];
    if (rDef) defaultRun = parseRPr(kid(rDef, 'rPr'));
    for (const st of Array.from(sd.getElementsByTagNameNS(W, 'style'))) {
      const id = attr(st, 'styleId')!;
      const pPr = kid(st, 'pPr');
      const numPr = kid(pPr, 'numPr');
      const outline = attr(kid(pPr, 'outlineLvl'), 'val');
      styles[id] = {
        name: (attr(kid(st, 'name'), 'val') || id).toLowerCase(),
        basedOn: attr(kid(st, 'basedOn'), 'val') || undefined,
        rPr: parseRPr(kid(st, 'rPr')),
        jc: attr(kid(pPr, 'jc'), 'val') || undefined,
        numId: attr(kid(numPr, 'numId'), 'val') || undefined,
        ilvl: numPr ? parseInt(attr(kid(numPr, 'ilvl'), 'val') || '0', 10) : undefined,
        outline: outline != null ? parseInt(outline, 10) : undefined
      };
      if (attr(st, 'type') === 'paragraph' && attr(st, 'default') === '1') defaultParaStyle = id;
    }
  }
  const resolveStyle = (id: string | null | undefined): StyleDef | null => {
    if (!id || !styles[id]) return null;
    const chain: StyleDef[] = [];
    let cur: StyleDef | undefined = styles[id];
    let guard = 0;
    while (cur && guard++ < 10) {
      chain.unshift(cur);
      cur = cur.basedOn ? styles[cur.basedOn] : undefined;
    }
    return chain.reduce(
      (acc, s) => ({ ...acc, ...s, rPr: { ...acc.rPr, ...s.rPr } }),
      { name: '', rPr: {} } as StyleDef
    );
  };
  const baseSize = defaultRun.size || resolveStyle(defaultParaStyle)?.rPr.size || 11;
  const baseFont = defaultRun.font || resolveStyle(defaultParaStyle)?.rPr.font;

  // Numbering: numId -> level -> ordered?
  const numFmt: Record<string, Record<number, string>> = {};
  const numXml = await read('word/numbering.xml');
  if (numXml) {
    const nd = parse(numXml);
    const abstract: Record<string, Record<number, string>> = {};
    for (const an of Array.from(nd.getElementsByTagNameNS(W, 'abstractNum'))) {
      const levels: Record<number, string> = {};
      for (const lvl of kids(an, 'lvl')) levels[parseInt(attr(lvl, 'ilvl') || '0', 10)] = attr(kid(lvl, 'numFmt'), 'val') || 'bullet';
      abstract[attr(an, 'abstractNumId')!] = levels;
    }
    for (const n of Array.from(nd.getElementsByTagNameNS(W, 'num'))) {
      const aid = attr(kid(n, 'abstractNumId'), 'val');
      if (aid && abstract[aid]) numFmt[attr(n, 'numId')!] = abstract[aid];
    }
  }

  const images: Record<string, string> = {};
  const imageData = async (rid: string) => {
    if (images[rid]) return images[rid];
    const rel = rels[rid];
    if (!rel) return '';
    const path = rel.target.startsWith('/') ? rel.target.slice(1) : 'word/' + rel.target.replace(/^\.\//, '');
    const f = zip.file(path);
    if (!f) return '';
    const ext = path.split('.').pop()!.toLowerCase();
    const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'bmp' ? 'image/bmp' : ext === 'svg' ? 'image/svg+xml' : 'image/jpeg';
    if (ext === 'emf' || ext === 'wmf') return '';
    images[rid] = `data:${mime};base64,${await f.async('base64')}`;
    return images[rid];
  };

  // ---------- Runs ----------
  const runHtml = async (r: Element, paraRun: RunProps): Promise<string> => {
    const rPr = kid(r, 'rPr');
    const charStyle = resolveStyle(attr(kid(rPr, 'rStyle'), 'val'));
    const p: RunProps = { ...paraRun, ...(charStyle?.rPr || {}), ...parseRPr(rPr) };
    let inner = '';
    for (const c of Array.from(r.children)) {
      switch (c.localName) {
        case 't':
          inner += escapeHtml(c.textContent || '');
          break;
        case 'tab':
          inner += '\t';
          break;
        case 'br':
          if (attr(c, 'type') === 'page') inner += '\u0000PAGEBREAK\u0000';
          else inner += '<br>';
          break;
        case 'cr':
          inner += '<br>';
          break;
        case 'noBreakHyphen':
          inner += '‑';
          break;
        case 'sym': {
          const ch = attr(c, 'char');
          if (ch) {
            // Symbol-font characters live in the private-use range F0xx.
            const code = parseInt(ch, 16);
            inner += escapeHtml(String.fromCharCode(code >= 0xf000 ? code - 0xf000 : code));
          }
          break;
        }
        case 'drawing':
        case 'pict': {
          const blip = c.getElementsByTagNameNS(A, 'blip')[0];
          const rid = blip?.getAttributeNS(R, 'embed') || (c.getElementsByTagName('v:imagedata')[0]?.getAttributeNS(R, 'id') ?? null);
          if (rid) {
            const src = await imageData(rid);
            const ext = c.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing', 'extent')[0];
            const wpx = ext ? Math.round(parseInt(ext.getAttribute('cx') || '0', 10) / 9525) : 0;
            const pct = wpx ? Math.min(100, Math.round((wpx / 624) * 100)) : null;
            if (src) inner += `\u0000IMG${pct ? `|${pct}` : ''}|${src}\u0000`;
          }
          break;
        }
      }
    }
    if (!inner) return '';
    // Images are lifted out as blocks later, so keep them unformatted.
    if (inner.includes('\u0000IMG') || inner.includes('PAGEBREAK')) return inner;
    const css: string[] = [];
    if (p.color && p.color !== '#000000') css.push(`color: ${p.color}`);
    if (p.size && Math.abs(p.size - baseSize) > 0.01) css.push(`font-size: ${p.size}pt`);
    if (p.font && p.font !== baseFont) css.push(`font-family: ${/\s/.test(p.font) ? `"${p.font}"` : p.font}`);
    let out = css.length ? `<span style="${css.join('; ')}">${inner}</span>` : inner;
    if (p.b) out = `<strong>${out}</strong>`;
    if (p.i) out = `<em>${out}</em>`;
    if (p.u) out = `<u>${out}</u>`;
    if (p.s) out = `<s>${out}</s>`;
    if (p.vert) out = `<${p.vert}>${out}</${p.vert}>`;
    if (p.highlight) out = `<mark data-color="${p.highlight}" style="background-color: ${p.highlight}">${out}</mark>`;
    return out;
  };

  const inlineHtml = async (container: Element, paraRun: RunProps): Promise<string> => {
    let html = '';
    for (const c of Array.from(container.children)) {
      switch (c.localName) {
        case 'r':
          html += await runHtml(c, paraRun);
          break;
        case 'hyperlink': {
          const rid = c.getAttributeNS(R, 'id');
          const anchor = attr(c, 'anchor');
          const href = rid && rels[rid] ? rels[rid].target : anchor ? `#${anchor}` : '';
          const inner = await inlineHtml(c, paraRun);
          html += href ? `<a href="${escapeHtml(href)}">${inner}</a>` : inner;
          break;
        }
        case 'smartTag':
        case 'customXml':
        case 'ins':
        case 'fldSimple':
          html += await inlineHtml(c, paraRun);
          break;
        case 'sdt':
          html += await inlineHtml(kid(c, 'sdtContent')!, paraRun);
          break;
        // w:del (tracked deletions) and w:instrText are intentionally skipped.
      }
    }
    return html;
  };

  // ---------- Blocks ----------
  interface Block {
    kind: 'p' | 'list' | 'raw';
    html: string;
    empty?: boolean;
    list?: { ordered: boolean; level: number; numId: string };
  }

  const paraBlocks = async (p: Element): Promise<Block[]> => {
    const pPr = kid(p, 'pPr');
    const styleId = attr(kid(pPr, 'pStyle'), 'val') || defaultParaStyle;
    const st = resolveStyle(styleId);
    const name = st?.name || '';
    let tag = 'p';
    const hm = name.match(/^heading (\d)$/);
    if (hm) tag = `h${Math.min(6, parseInt(hm[1], 10))}`;
    else if (name === 'title') tag = 'h1';
    else if (name === 'subtitle') tag = 'h2';
    else if (st?.outline !== undefined && st.outline < 6 && name !== 'normal') tag = `h${st.outline + 1}`;

    const attrs: string[] = [];
    const css: string[] = [];
    const jc = attr(kid(pPr, 'jc'), 'val') || st?.jc;
    const align = jc === 'center' ? 'center' : jc === 'right' || jc === 'end' ? 'right' : jc === 'both' || jc === 'distribute' ? 'justify' : null;
    if (align) css.push(`text-align: ${align}`);
    const spacing = kid(pPr, 'spacing');
    const line = attr(spacing, 'line');
    const rule = attr(spacing, 'lineRule');
    if (line && (!rule || rule === 'auto')) {
      const lh = Math.round((parseInt(line, 10) / 240) * 100) / 100;
      if (lh >= 1.4) css.push(`line-height: ${lh >= 1.9 ? 2 : lh >= 1.65 ? 1.75 : 1.5}`);
    }
    const ind = kid(pPr, 'ind');
    const left = parseInt(attr(ind, 'left') || attr(ind, 'start') || '0', 10);

    const numPr = kid(pPr, 'numPr');
    const numId = attr(kid(numPr, 'numId'), 'val') || st?.numId;
    const ilvl = numPr ? parseInt(attr(kid(numPr, 'ilvl'), 'val') || '0', 10) : st?.ilvl || 0;
    const isList = !!numId && numId !== '0' && tag === 'p';
    if (!isList && left >= 360) attrs.push(`data-indent="${Math.min(8, Math.round(left / 720))}"`);

    const paraRun: RunProps = tag === 'p' ? { ...(st?.rPr || {}) } : {};
    // Headings take their look from the editor's heading styles; keep only colour.
    if (tag !== 'p' && st?.rPr.color && st.rPr.color !== '#000000') paraRun.color = undefined;
    let inner = await inlineHtml(p, paraRun);

    const blocks: Block[] = [];
    if (attr(kid(pPr, 'pageBreakBefore'), 'val') !== '0' && kid(pPr, 'pageBreakBefore')) blocks.push({ kind: 'raw', html: '<div data-type="page-break"></div>' });

    const styleAttr = css.length ? ` style="${css.join('; ')}"` : '';
    const attrStr = (attrs.length ? ' ' + attrs.join(' ') : '') + styleAttr;
    // Split around page breaks and images, which must be block-level.
    const parts = inner.split('\u0000');
    let buf = '';
    const flush = (force = false) => {
      const text = buf.replace(/<[^>]+>/g, '').replace(/\s/g, '');
      const empty = !text && !buf.includes('<br');
      if (!empty || force) {
        const html = `<${tag}${attrStr}>${buf}</${tag}>`;
        if (isList) blocks.push({ kind: 'list', html: buf, empty, list: { ordered: (numFmt[numId!]?.[ilvl] || 'bullet') !== 'bullet', level: ilvl, numId: numId! } });
        else blocks.push({ kind: 'p', html, empty });
      }
      buf = '';
    };
    let emitted = false;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (i % 2 === 1) {
        if (part === 'PAGEBREAK') {
          flush();
          blocks.push({ kind: 'raw', html: '<div data-type="page-break"></div>' });
        } else if (part.startsWith('IMG')) {
          flush();
          const [, a, b] = part.split('|');
          const pct = b ? a : null;
          const src = b || a;
          blocks.push({ kind: 'raw', html: `<img src="${src}"${pct ? ` width="${pct}%"` : ''}${align ? ` data-align="${align}"` : ''}>` });
        }
        emitted = true;
      } else buf += part;
    }
    flush(!emitted || blocks.length === 0);
    return blocks;
  };

  const tableHtml = async (tbl: Element): Promise<string> => {
    const rows = kids(tbl, 'tr');
    // Grid of cells to resolve vertical merges into rowspans.
    type Cell = { html: string; colspan: number; rowspan: number; header: boolean; skip: boolean; col: number };
    const grid: Cell[][] = [];
    for (let ri = 0; ri < rows.length; ri++) {
      const tr = rows[ri];
      const header = !!onOff(kid(kid(tr, 'trPr'), 'tblHeader'));
      const cells: Cell[] = [];
      let col = 0;
      for (const tc of kids(tr, 'tc')) {
        const tcPr = kid(tc, 'tcPr');
        const span = parseInt(attr(kid(tcPr, 'gridSpan'), 'val') || '1', 10);
        const vm = kid(tcPr, 'vMerge');
        const vmVal = vm ? attr(vm, 'val') || 'continue' : null;
        let inner = '';
        for (const child of Array.from(tc.children)) {
          if (child.localName === 'p') inner += blocksToHtml(await paraBlocks(child), true);
          else if (child.localName === 'tbl') inner += await tableHtml(child);
        }
        const cell: Cell = { html: inner || '<p></p>', colspan: span, rowspan: 1, header, skip: false, col };
        if (vmVal === 'continue') {
          cell.skip = true;
          for (let up = ri - 1; up >= 0; up--) {
            const above = grid[up].find((c) => c.col === col && !c.skip);
            if (above) {
              above.rowspan++;
              break;
            }
          }
        }
        cells.push(cell);
        col += span;
      }
      grid.push(cells);
    }
    let html = '<table><tbody>';
    for (const row of grid) {
      html += '<tr>';
      for (const c of row) {
        if (c.skip) continue;
        const t = c.header ? 'th' : 'td';
        html += `<${t}${c.colspan > 1 ? ` colspan="${c.colspan}"` : ''}${c.rowspan > 1 ? ` rowspan="${c.rowspan}"` : ''}>${c.html}</${t}>`;
      }
      html += '</tr>';
    }
    return html + '</tbody></table>';
  };

  /** Group list paragraphs into nested <ul>/<ol>, and drop repeated blank lines. */
  function blocksToHtml(blocks: Block[], inCell = false): string {
    let html = '';
    const stack: { tag: string; level: number }[] = [];
    let openLi = false;
    let lastEmpty = false;
    const closeTo = (level: number) => {
      while (stack.length && stack[stack.length - 1].level > level) {
        html += '</li>' + `</${stack.pop()!.tag}>`;
      }
    };
    for (const b of blocks) {
      if (b.kind === 'list') {
        const tag = b.list!.ordered ? 'ol' : 'ul';
        const lvl = b.list!.level;
        const top = stack[stack.length - 1];
        if (!top || lvl > top.level) {
          html += `<${tag}>`;
          stack.push({ tag, level: lvl });
          openLi = false;
        } else {
          closeTo(lvl);
          const cur = stack[stack.length - 1];
          if (cur && cur.tag !== tag) {
            html += `</li></${stack.pop()!.tag}><${tag}>`;
            stack.push({ tag, level: lvl });
            openLi = false;
          }
        }
        if (openLi) html += '</li>';
        html += `<li><p>${b.html}</p>`;
        openLi = true;
        lastEmpty = false;
        continue;
      }
      if (stack.length) {
        closeTo(-1);
        openLi = false;
      }
      if (b.empty) {
        if (lastEmpty) continue;
        lastEmpty = true;
      } else lastEmpty = false;
      html += b.html;
    }
    closeTo(-1);
    if (!inCell) html = html.replace(/^(<p[^>]*><\/p>)+/, '').replace(/(<p[^>]*><\/p>)+$/, '');
    return html;
  }

  const body = doc.getElementsByTagNameNS(W, 'body')[0];
  const collect = async (container: Element, out: Block[]) => {
    for (const el of Array.from(container.children)) {
      if (el.localName === 'p') out.push(...(await paraBlocks(el)));
      else if (el.localName === 'tbl') out.push({ kind: 'raw', html: await tableHtml(el) });
      else if (el.localName === 'sdt') await collect(kid(el, 'sdtContent')!, out);
      else if (el.localName === 'customXml') await collect(el, out);
    }
  };
  const blocks: Block[] = [];
  await collect(body, blocks);
  return blocksToHtml(blocks) || '<p></p>';
}
