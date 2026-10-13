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
  type IRunOptions,
  type ParagraphChild
} from 'docx';
import { dataUrlToBytes } from '../../lib/util';

/** The editor's look, mirrored in Word so a round trip keeps the same spacing. */
export const DOC_DEFAULTS = {
  font: 'Arial',
  sizePt: 11,
  spaceAfterPt: 6,
  lineHeight: 1.3
};

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

function runsFrom(nodes: JSONNode[] | undefined): ParagraphChild[] {
  const out: ParagraphChild[] = [];
  for (const n of nodes || []) {
    if (n.type === 'hardBreak') {
      out.push(new TextRun({ text: '', break: 1 }));
      continue;
    }
    if (n.type !== 'text' || !n.text) continue;
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
    const run = new TextRun({ ...(opts as IRunOptions), children, ...(link ? { style: 'Hyperlink' } : {}) });
    out.push(link ? new ExternalHyperlink({ link, children: [run] }) : run);
  }
  return out;
}

interface Ctx {
  listInstance: number;
}

async function blocksFrom(nodes: JSONNode[] | undefined, ctx: Ctx, opts: { indent?: number; list?: { ref: string; level: number; instance: number } } = {}): Promise<(Paragraph | Table)[]> {
  const out: (Paragraph | Table)[] = [];
  for (const n of nodes || []) {
    const a = n.attrs || {};
    const paraBase = () => ({
      alignment: a.textAlign && a.textAlign !== 'left' ? ALIGN[a.textAlign] : undefined,
      spacing: a.lineHeight ? { line: Math.round(parseFloat(a.lineHeight) * 240), after: DOC_DEFAULTS.spaceAfterPt * 20 } : undefined,
      indent: (a.indent || opts.indent) && !opts.list ? { left: ((a.indent || 0) + (opts.indent || 0)) * 720 } : undefined
    });
    switch (n.type) {
      case 'paragraph':
        out.push(
          new Paragraph({
            ...paraBase(),
            children: runsFrom(n.content),
            ...(opts.list ? { numbering: { reference: opts.list.ref, level: opts.list.level, instance: opts.list.instance } } : {})
          })
        );
        break;
      case 'heading':
        out.push(new Paragraph({ ...paraBase(), heading: HEADING[a.level || 1], children: runsFrom(n.content) }));
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
              children: [new TextRun({ text: checked ? '☑ ' : '☐ ', font: 'Segoe UI Symbol' }), ...runsFrom(firstPara?.content)]
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
            const children = (await blocksFrom(cell.content, ctx)).filter((x) => x instanceof Paragraph || x instanceof Table) as Paragraph[];
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

export async function jsonToDocx(json: JSONNode): Promise<Uint8Array> {
  const ctx: Ctx = { listInstance: 0 };
  const children = await blocksFrom(json.content, ctx);
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

  const doc = new Document({
    creator: 'Slate Office',
    styles: {
      default: {
        document: {
          run: { font: DOC_DEFAULTS.font, size: DOC_DEFAULTS.sizePt * 2 },
          paragraph: { spacing: { after: DOC_DEFAULTS.spaceAfterPt * 20, line: Math.round(DOC_DEFAULTS.lineHeight * 240) } }
        },
        heading1: { run: { font: DOC_DEFAULTS.font, size: 40, bold: false, color: '202124' }, paragraph: { spacing: { before: 360, after: 120 } } },
        heading2: { run: { font: DOC_DEFAULTS.font, size: 32, bold: false, color: '202124' }, paragraph: { spacing: { before: 320, after: 120 } } },
        heading3: { run: { font: DOC_DEFAULTS.font, size: 28, bold: false, color: '434343' }, paragraph: { spacing: { before: 280, after: 80 } } },
        heading4: { run: { font: DOC_DEFAULTS.font, size: 24, bold: true, color: '434343' }, paragraph: { spacing: { before: 240, after: 80 } } },
        hyperlink: { run: { color: '1155CC', underline: {} } }
      }
    },
    numbering: {
      config: [
        { reference: 'bullets', levels: levels('bullet') },
        { reference: 'numbers', levels: levels('number') }
      ]
    },
    sections: [
      {
        properties: { page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } },
        children: children.length ? children : [new Paragraph('')]
      }
    ]
  });
  const blob = await Packer.toBlob(doc);
  return new Uint8Array(await blob.arrayBuffer());
}
