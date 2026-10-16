import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  ExternalHyperlink,
  Table,
  TableRow,
  TableCell,
  WidthType,
  ShadingType,
  BorderStyle,
  PageBreak,
  ImageRun,
  Tab,
  LevelFormat,
  convertInchesToTwip,
  Header,
  Footer,
  PageNumber,
  PageOrientation,
  TabStopType,
  FootnoteReferenceRun,
  LeaderType,
  CommentRangeStart,
  CommentRangeEnd,
  CommentReference,
  InsertedTextRun,
  DeletedTextRun,
  type IRunOptions,
  type ParagraphChild
} from 'docx';
import JSZip from 'jszip';
import { dataUrlToBytes } from '../../lib/util';
import { DocMeta, defaultMeta, HeaderFooter, metaExtras, expandFields } from './docMeta';
import { texToPng } from './math';

/** Default look when a document has no settings of its own. */
export const DOC_DEFAULTS = defaultMeta().defaults;
const IN = 1440; // twips per inch

type JSONNode = { type: string; attrs?: any; content?: JSONNode[]; marks?: { type: string; attrs?: any }[]; text?: string };

const HEADING: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
  5: HeadingLevel.HEADING_5,
  6: HeadingLevel.HEADING_6
};

const ALIGN: Record<string, (typeof AlignmentType)[keyof typeof AlignmentType]> = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
  justify: AlignmentType.JUSTIFIED
};

const hex = (c?: string | null) => {
  if (!c) return undefined;
  if (c.startsWith('#')) {
    const h = c.slice(1);
    return (h.length === 3 ? h.split('').map((x) => x + x).join('') : h.slice(0, 6)).toUpperCase();
  }
  const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (m) return [m[1], m[2], m[3]].map((n) => (+n).toString(16).padStart(2, '0')).join('').toUpperCase();
  return undefined;
};

async function imageSize(src: string): Promise<{ w: number; h: number }> {
  const img = new Image();
  img.src = src;
  try {
    await img.decode();
    return { w: img.naturalWidth, h: img.naturalHeight };
  } catch {
    return { w: 400, h: 300 };
  }
}

function runsFrom(nodes: JSONNode[] | undefined, ctx?: Ctx): ParagraphChild[] {
  const out: ParagraphChild[] = [];
  for (const n of nodes || []) {
    if (n.type === 'math') {
      const k = `${n.attrs?.display ? 'D' : 'I'}:${n.attrs?.latex || ''}`;
      const png = ctx?.math.get(k);
      if (png) {
        out.push(
          new ImageRun({
            type: 'png',
            data: png.data,
            transformation: { width: png.w, height: png.h },
            altText: { title: 'Equation', name: 'Equation', description: `slate-math:${k}` }
          })
        );
      } else out.push(new TextRun({ text: String(n.attrs?.latex || ''), italics: true }));
      continue;
    }
    if (n.type === 'citation') {
      const text = String(n.attrs?.text || '');
      ctx?.citeOrder.push({ ids: n.attrs?.ids || [], page: n.attrs?.page || '', text });
      out.push(new TextRun({ text, style: 'SlateCitation' }));
      continue;
    }
    if (n.type === 'footnote' && ctx) {
      const id = ++ctx.footnoteId;
      ctx.footnotes[id] = { children: [new Paragraph({ children: [new TextRun(String(n.attrs?.text || ''))] })] };
      out.push(new FootnoteReferenceRun(id));
      continue;
    }
    if (n.type === 'hardBreak') {
      out.push(new TextRun({ text: '', break: 1 }));
      continue;
    }
    if (n.type !== 'text' || !n.text) continue;
    const textIdx = ctx ? ctx.textIndex++ : 0;
    // Comments: open a range where one starts, close it after the last text it covers.
    const cmtIds = (n.marks || []).filter((m) => m.type === 'comment' && m.attrs?.id).map((m) => m.attrs.id as string);
    if (ctx) {
      for (const id of cmtIds) {
        if (!ctx.openComments.has(id) && ctx.commentNum.has(id)) {
          ctx.openComments.add(id);
          out.push(new CommentRangeStart(ctx.commentNum.get(id)!));
        }
      }
    }
    const opts: any = {};
    let link: string | null = null;
    for (const m of n.marks || []) {
      switch (m.type) {
        case 'bold':
          opts.bold = true;
          break;
        case 'italic':
          opts.italics = true;
          break;
        case 'underline':
          opts.underline = {};
          break;
        case 'strike':
          opts.strike = true;
          break;
        case 'code':
          opts.font = 'Courier New';
          opts.shading = { type: ShadingType.CLEAR, fill: 'F1F3F4', color: 'auto' };
          break;
        case 'superscript':
          opts.superScript = true;
          break;
        case 'subscript':
          opts.subScript = true;
          break;
        case 'highlight': {
          const fill = hex(m.attrs?.color) || 'FFFF00';
          opts.shading = { type: ShadingType.CLEAR, fill, color: 'auto' };
          break;
        }
        case 'textStyle': {
          const a = m.attrs || {};
          if (a.color) opts.color = hex(a.color);
          if (a.fontSize) opts.size = Math.round(parseFloat(a.fontSize) * 2);
          if (a.fontFamily) opts.font = String(a.fontFamily).split(',')[0].replace(/["']/g, '').trim();
          break;
        }
        case 'link':
          link = m.attrs?.href || null;
          break;
      }
    }
    // Tabs need their own element in Word.
    const parts = n.text.split('\t');
    const children: (string | Tab)[] = [];
    parts.forEach((p, i) => {
      if (i) children.push(new Tab());
      if (p) children.push(p);
    });
    const ins = (n.marks || []).find((m) => m.type === 'insertion');
    const del = (n.marks || []).find((m) => m.type === 'deletion');
    let run: any;
    if (ins || del) {
      // Suggestions become Word tracked changes.
      const rev = { id: ctx ? ctx.revId++ : 1, author: String((ins || del)!.attrs?.author || 'Kea'), date: new Date(Number((ins || del)!.attrs?.at) || Date.now()).toISOString() };
      run = del ? new DeletedTextRun({ ...(opts as IRunOptions), ...rev, text: n.text.replace(/\t/g, ' ') }) : new InsertedTextRun({ ...(opts as IRunOptions), ...rev, text: n.text.replace(/\t/g, ' ') });
    } else run = new TextRun({ ...(opts as IRunOptions), children, ...(link ? { style: 'Hyperlink' } : {}) });
    out.push(link && !ins && !del ? new ExternalHyperlink({ link, children: [run] }) : run);
    if (ctx) {
      for (const id of cmtIds) {
        if (ctx.commentEnd.get(id) === textIdx && ctx.openComments.has(id)) {
          const num = ctx.commentNum.get(id)!;
          out.push(new CommentRangeEnd(num), new TextRun({ children: [new CommentReference(num)] }));
          ctx.openComments.delete(id);
        }
      }
    }
  }
  return out;
}

interface Ctx {
  listInstance: number;
  footnoteId: number;
  footnotes: Record<number, { children: Paragraph[] }>;
  meta: DocMeta;
  citeOrder: { ids: string[]; page: string; text: string }[];
  /** Comment id → Word's numeric id, the text-node index where each comment ends, and a running index. */
  commentNum: Map<string, number>;
  commentEnd: Map<string, number>;
  openComments: Set<string>;
  textIndex: number;
  revId: number;
  math: Map<string, { data: Uint8Array; w: number; h: number } | null>;
}

/** Number every comment and find the last piece of text it covers (document order). */
function scanComments(json: JSONNode, ctx: Ctx) {
  let i = 0;
  const walk = (n: JSONNode) => {
    if (n.type === 'text') {
      for (const m of n.marks || []) {
        if (m.type !== 'comment' || !m.attrs?.id) continue;
        if (!ctx.commentNum.has(m.attrs.id)) ctx.commentNum.set(m.attrs.id, ctx.commentNum.size);
        ctx.commentEnd.set(m.attrs.id, i);
      }
      i++;
    }
    for (const c of n.content || []) walk(c);
  };
  walk(json);
}

/** Simple inline HTML (<i>, <b>) from a bibliography entry → Word runs. */
function htmlRuns(html: string): TextRun[] {
  const out: TextRun[] = [];
  let italic = false;
  let bold = false;
  for (const part of html.split(/(<\/?[ib]>)/i)) {
    const tag = part.toLowerCase();
    if (tag === '<i>') italic = true;
    else if (tag === '</i>') italic = false;
    else if (tag === '<b>') bold = true;
    else if (tag === '</b>') bold = false;
    else if (part) {
      const text = part.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
      if (text) out.push(new TextRun({ text, italics: italic, bold }));
    }
  }
  return out;
}

async function blocksFrom(nodes: JSONNode[] | undefined, ctx: Ctx, opts: { indent?: number; inCell?: boolean; list?: { ref: string; level: number; instance: number } } = {}): Promise<(Paragraph | Table)[]> {
  const out: (Paragraph | Table)[] = [];
  for (const n of nodes || []) {
    const a = n.attrs || {};
    const paraBase = () => {
      const ti = a.textIndent == null ? null : Number(a.textIndent);
      const left = (a.indent || opts.indent) && !opts.list ? ((a.indent || 0) + (opts.indent || 0)) * 720 : 0;
      const indent: any = {};
      if (left) indent.left = left;
      if (ti != null && !opts.list) {
        if (ti < 0) {
          indent.left = (indent.left || 0) + Math.round(-ti * IN);
          indent.hanging = Math.round(-ti * IN);
        } else indent.firstLine = Math.round(ti * IN);
      } else if (opts.inCell && ctx.meta.defaults.firstLineIn) indent.firstLine = 0;
      return {
        alignment: a.textAlign && a.textAlign !== 'left' ? ALIGN[a.textAlign] : undefined,
        spacing: a.lineHeight ? { line: Math.round(parseFloat(a.lineHeight) * 240) } : undefined,
        indent: Object.keys(indent).length ? indent : undefined
      };
    };
    switch (n.type) {
      case 'paragraph':
        out.push(
          new Paragraph({
            ...paraBase(),
            children: runsFrom(n.content, ctx),
            ...(opts.list ? { numbering: { reference: opts.list.ref, level: opts.list.level, instance: opts.list.instance } } : {})
          })
        );
        break;
      case 'heading':
        out.push(new Paragraph({ ...paraBase(), heading: HEADING[a.level || 1], children: runsFrom(n.content, ctx) }));
        break;
      case 'blockquote': {
        const inner = await blocksFrom(n.content, ctx, { indent: (opts.indent || 0) + 1 });
        for (const p of inner) out.push(p);
        break;
      }
      case 'codeBlock': {
        const lines = (n.content?.map((c) => c.text || '').join('') || '').split('\n');
        lines.forEach((line) =>
          out.push(
            new Paragraph({
              shading: { type: ShadingType.CLEAR, fill: 'F1F3F4', color: 'auto' },
              spacing: { after: 0, line: 240 },
              children: [new TextRun({ text: line, font: 'Courier New', size: 20 })]
            })
          )
        );
        break;
      }
      case 'bulletList':
      case 'orderedList': {
        const ref = n.type === 'bulletList' ? 'bullets' : 'numbers';
        const level = opts.list ? opts.list.level + 1 : 0;
        const instance = opts.list && n.type === 'bulletList' ? opts.list.instance : ++ctx.listInstance;
        for (const li of n.content || []) {
          let first = true;
          for (const child of li.content || []) {
            if (child.type === 'paragraph' && first) {
              out.push(...(await blocksFrom([child], ctx, { list: { ref, level, instance } })));
              first = false;
            } else if (child.type === 'bulletList' || child.type === 'orderedList') {
              out.push(...(await blocksFrom([child], ctx, { list: { ref, level, instance } })));
            } else {
              out.push(...(await blocksFrom([child], ctx, { indent: level + 1 })));
            }
          }
        }
        break;
      }
      case 'taskList':
        for (const item of n.content || []) {
          const checked = !!item.attrs?.checked;
          const [firstPara, ...rest] = item.content || [];
          out.push(
            new Paragraph({
              indent: opts.indent ? { left: opts.indent * 720 } : undefined,
              children: [new TextRun({ text: checked ? '☑ ' : '☐ ', font: 'Segoe UI Symbol' }), ...runsFrom(firstPara?.content, ctx)]
            })
          );
          out.push(...(await blocksFrom(rest, ctx, { indent: (opts.indent || 0) + 1 })));
        }
        break;
      case 'horizontalRule':
        out.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'BDBDBD', space: 1 } }, children: [] }));
        break;
      case 'pageBreak':
        out.push(new Paragraph({ children: [new PageBreak()] }));
        break;
      case 'bibliography': {
        const title = String(a.title || 'Works Cited');
        out.push(new Paragraph({ style: 'SlateBibliographyTitle', alignment: AlignmentType.CENTER, children: [new TextRun({ text: title, bold: ctx.meta.citationStyle === 'apa' })] }));
        for (const e of (a.entries || []) as string[]) out.push(new Paragraph({ style: 'SlateBibliography', children: htmlRuns(e) }));
        break;
      }
      case 'toc': {
        const contentTwips = ((ctx.meta.page.landscape ? ctx.meta.page.height : ctx.meta.page.width) - ctx.meta.page.margins.left - ctx.meta.page.margins.right) * IN;
        out.push(new Paragraph({ style: 'SlateTOCTitle', children: [new TextRun({ text: String(a.title || 'Contents'), bold: true })] }));
        for (const e of (a.entries || []) as { level: number; text: string; page: number }[]) {
          out.push(
            new Paragraph({
              style: 'SlateTOC',
              indent: { left: Math.round((e.level - 1) * 0.3 * IN), firstLine: 0 },
              tabStops: [{ type: TabStopType.RIGHT, position: Math.round(contentTwips), leader: LeaderType.DOT }],
              children: [new TextRun(e.text), new TextRun({ children: [new Tab(), String(e.page)] })]
            })
          );
        }
        break;
      }
      case 'image': {
        if (!a.src || !String(a.src).startsWith('data:')) break;
        const mime = String(a.src).slice(5, String(a.src).indexOf(';'));
        const type = mime.includes('png') ? 'png' : mime.includes('gif') ? 'gif' : mime.includes('bmp') ? 'bmp' : mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : null;
        if (!type) break;
        const { w, h } = await imageSize(a.src);
        const maxW = 624; // 6.5in at 96 dpi
        const pct = a.width ? parseFloat(a.width) / 100 : Math.min(1, w / maxW);
        const width = Math.round(maxW * Math.min(1, pct || 1));
        out.push(
          new Paragraph({
            alignment: a.align ? ALIGN[a.align] : undefined,
            children: [new ImageRun({ type, data: dataUrlToBytes(a.src), transformation: { width, height: Math.round((width * h) / w) } })]
          })
        );
        break;
      }
      case 'table': {
        const rows: TableRow[] = [];
        for (const row of n.content || []) {
          const cells: TableCell[] = [];
          let header = false;
          for (const cell of row.content || []) {
            const isHeader = cell.type === 'tableHeader';
            header = header || isHeader;
            const children = (await blocksFrom(cell.content, ctx, { inCell: true })).filter((x) => x instanceof Paragraph || x instanceof Table) as Paragraph[];
            cells.push(
              new TableCell({
                children: children.length ? children : [new Paragraph('')],
                columnSpan: cell.attrs?.colspan > 1 ? cell.attrs.colspan : undefined,
                rowSpan: cell.attrs?.rowspan > 1 ? cell.attrs.rowspan : undefined,
                shading: isHeader ? { type: ShadingType.CLEAR, fill: 'F1F3F4', color: 'auto' } : undefined,
                width: cell.attrs?.colwidth?.[0] ? { size: cell.attrs.colwidth[0] * 15, type: WidthType.DXA } : undefined,
                margins: { top: 60, bottom: 60, left: 100, right: 100 }
              })
            );
          }
          rows.push(new TableRow({ children: cells, ...(header ? { tableHeader: true } : {}) }));
        }
        if (rows.length) out.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
        break;
      }
    }
  }
  return out;
}

/** A header/footer as one paragraph: left text, centred text and right text on tab stops. */
function hfParagraph(hf: HeaderFooter, contentTwips: number, title: string): Paragraph {
  const runs = (text: string): ParagraphChild[] => {
    const out: ParagraphChild[] = [];
    // Page fields become live Word fields; the others ({TITLE}, {DATE}) are filled in now.
    for (const part of text.split(/(\{PAGES?\})/i)) {
      if (!part) continue;
      if (/^\{PAGE\}$/i.test(part)) out.push(new TextRun({ children: [PageNumber.CURRENT] }));
      else if (/^\{PAGES\}$/i.test(part)) out.push(new TextRun({ children: [PageNumber.TOTAL_PAGES] }));
      else out.push(new TextRun(expandFields(part, { page: 0, pages: 0, title })));
    }
    return out;
  };
  const used = [hf.left, hf.center, hf.right].filter(Boolean).length;
  if (used === 1 && hf.right) return new Paragraph({ alignment: AlignmentType.RIGHT, children: runs(hf.right), indent: { firstLine: 0 } });
  if (used === 1 && hf.center) return new Paragraph({ alignment: AlignmentType.CENTER, children: runs(hf.center), indent: { firstLine: 0 } });
  return new Paragraph({
    indent: { firstLine: 0 },
    tabStops: [
      { type: TabStopType.CENTER, position: Math.round(contentTwips / 2) },
      { type: TabStopType.RIGHT, position: Math.round(contentTwips) }
    ],
    children: [...runs(hf.left), new TextRun({ children: [new Tab()] }), ...runs(hf.center), new TextRun({ children: [new Tab()] }), ...runs(hf.right)]
  });
}

const hasText = (hf?: HeaderFooter | null) => !!hf && !!(hf.left || hf.center || hf.right);

/** Store Kea-only settings (citations, comments, goal…) in a custom XML part, which Word preserves. */
async function addSlatePart(bytes: Uint8Array, meta: DocMeta, extra: Record<string, any> = {}): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes);
  const json = JSON.stringify({ ...metaExtras(meta), ...extra });
  const b64 = btoa(unescape(encodeURIComponent(json)));
  zip.file('customXml/slateData.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><slate xmlns="urn:slate-office:data">${b64}</slate>`);
  const relPath = 'word/_rels/document.xml.rels';
  const rels = (await zip.file(relPath)?.async('string')) || '';
  if (rels && !rels.includes('slateData.xml')) {
    zip.file(relPath, rels.replace('</Relationships>', '<Relationship Id="rIdSlateData" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml" Target="../customXml/slateData.xml"/></Relationships>'));
  }
  const ctPath = '[Content_Types].xml';
  const ct = (await zip.file(ctPath)?.async('string')) || '';
  if (ct && !ct.includes('/customXml/slateData.xml')) {
    zip.file(ctPath, ct.replace('</Types>', '<Override PartName="/customXml/slateData.xml" ContentType="application/xml"/></Types>'));
  }
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

export async function jsonToDocx(json: JSONNode, metaIn?: DocMeta | null, title = ''): Promise<Uint8Array> {
  const meta = metaIn || defaultMeta();
  const D = meta.defaults;
  const ctx: Ctx = { listInstance: 0, footnoteId: 0, footnotes: {}, meta, citeOrder: [], commentNum: new Map(), commentEnd: new Map(), openComments: new Set(), textIndex: 0, revId: 1, math: new Map() };
  // Draw every equation first (Word gets crisp images; the LaTeX rides along as alt text).
  const fontPx = (meta.defaults.sizePt * 96) / 72;
  const mathJobs: Promise<void>[] = [];
  const findMath = (n: JSONNode) => {
    if (n.type === 'math') {
      const k = `${n.attrs?.display ? 'D' : 'I'}:${n.attrs?.latex || ''}`;
      if (!ctx.math.has(k)) {
        ctx.math.set(k, null);
        mathJobs.push(texToPng(n.attrs?.latex || '', !!n.attrs?.display, fontPx).then((png) => void ctx.math.set(k, png)).catch(() => {}));
      }
    }
    (n.content || []).forEach(findMath);
  };
  findMath(json);
  await Promise.all(mathJobs);
  scanComments(json, ctx);
  const children = await blocksFrom(json.content, ctx);
  const commentDefs = meta.comments
    .filter((t) => ctx.commentNum.has(t.id))
    .map((t) => ({
      id: ctx.commentNum.get(t.id)!,
      author: t.author,
      initials: t.author
        .split(/\s+/)
        .map((w) => w[0] || '')
        .join('')
        .slice(0, 3)
        .toUpperCase(),
      date: new Date(t.at || Date.now()),
      children: [new Paragraph(t.text), ...t.replies.map((r) => new Paragraph(`${r.author}: ${r.text}`))]
    }));
  const bulletChars = ['●', '○', '■'];
  const numberFormats = [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN];
  const levels = (kind: 'bullet' | 'number') =>
    Array.from({ length: 9 }, (_, i) => ({
      level: i,
      format: kind === 'bullet' ? LevelFormat.BULLET : numberFormats[i % 3],
      text: kind === 'bullet' ? bulletChars[i % 3] : `%${i + 1}.`,
      alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: convertInchesToTwip(0.375 * (i + 1)), hanging: convertInchesToTwip(0.25) } } }
    }));

  const pg = meta.page;
  const mg = pg.margins;
  const contentTwips = ((pg.landscape ? pg.height : pg.width) - mg.left - mg.right) * IN;
  const noIndent = D.firstLineIn ? { indent: { firstLine: 0 } } : {};
  const firstDiffers = hasText(meta.firstHeader) || hasText(meta.firstFooter) || !!meta.firstHeader || !!meta.firstFooter;
  const header = (hf?: HeaderFooter | null) => new Header({ children: [hasText(hf) ? hfParagraph(hf!, contentTwips, title) : new Paragraph('')] });
  const footer = (hf?: HeaderFooter | null) => new Footer({ children: [hasText(hf) ? hfParagraph(hf!, contentTwips, title) : new Paragraph('')] });

  const doc = new Document({
    creator: 'Kea',
    title: title || undefined,
    footnotes: ctx.footnotes,
    ...(commentDefs.length ? { comments: { children: commentDefs } } : {}),
    styles: {
      default: {
        document: {
          run: { font: D.font, size: Math.round(D.sizePt * 2) },
          paragraph: { spacing: { after: Math.round(D.spaceAfterPt * 20), line: Math.round(D.lineHeight * 240) }, ...(D.firstLineIn ? { indent: { firstLine: Math.round(D.firstLineIn * IN) } } : {}) }
        },
        heading1: { run: { font: D.font, size: 40, bold: false, color: '202124' }, paragraph: { spacing: { before: 360, after: 120 }, ...noIndent } },
        heading2: { run: { font: D.font, size: 32, bold: false, color: '202124' }, paragraph: { spacing: { before: 320, after: 120 }, ...noIndent } },
        heading3: { run: { font: D.font, size: 28, bold: false, color: '434343' }, paragraph: { spacing: { before: 280, after: 80 }, ...noIndent } },
        heading4: { run: { font: D.font, size: 24, bold: true, color: '434343' }, paragraph: { spacing: { before: 240, after: 80 }, ...noIndent } },
        hyperlink: { run: { color: '1155CC', underline: {} } }
      },
      // Named styles let Kea recognise its citations, bibliography and contents when the file is reopened.
      paragraphStyles: [
        { id: 'SlateBibliographyTitle', name: 'Bibliography Title', basedOn: 'Normal', next: 'SlateBibliography', paragraph: { alignment: AlignmentType.CENTER, indent: { firstLine: 0 } } },
        { id: 'SlateBibliography', name: 'Bibliography Entry', basedOn: 'Normal', paragraph: { indent: { left: 720, hanging: 720 } } },
        { id: 'SlateTOCTitle', name: 'Contents Title', basedOn: 'Normal', paragraph: { indent: { firstLine: 0 }, spacing: { after: 120 } } },
        { id: 'SlateTOC', name: 'Contents Entry', basedOn: 'Normal', paragraph: { indent: { firstLine: 0 } } }
      ],
      characterStyles: [{ id: 'SlateCitation', name: 'Citation', basedOn: 'DefaultParagraphFont', run: {} }]
    },
    numbering: {
      config: [
        { reference: 'bullets', levels: levels('bullet') },
        { reference: 'numbers', levels: levels('number') }
      ]
    },
    sections: [
      {
        properties: {
          titlePage: firstDiffers,
          page: {
            size: { width: Math.round(pg.width * IN), height: Math.round(pg.height * IN), orientation: pg.landscape ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT },
            margin: {
              top: Math.round(mg.top * IN),
              bottom: Math.round(mg.bottom * IN),
              left: Math.round(mg.left * IN),
              right: Math.round(mg.right * IN),
              header: Math.round(pg.headerDistance * IN),
              footer: Math.round(pg.footerDistance * IN)
            },
            pageNumbers: meta.pageNumberStart && meta.pageNumberStart !== 1 ? { start: meta.pageNumberStart } : undefined
          }
        },
        headers: { default: header(meta.header), ...(firstDiffers ? { first: header(meta.firstHeader) } : {}) },
        footers: { default: footer(meta.footer), ...(firstDiffers ? { first: footer(meta.firstFooter) } : {}) },
        children: children.length ? children : [new Paragraph('')]
      }
    ]
  });
  const blob = await Packer.toBlob(doc);
  return addSlatePart(new Uint8Array(await blob.arrayBuffer()), meta, { citations: ctx.citeOrder, commentIds: Object.fromEntries([...ctx.commentNum].map(([id, n]) => [n, id])) });
}
