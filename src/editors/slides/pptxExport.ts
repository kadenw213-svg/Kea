import PptxGenJS from 'pptxgenjs';
import type { Deck, El } from './model';

const hex = (c?: string | null) => {
  if (!c) return undefined;
  if (c.startsWith('#')) {
    const h = c.slice(1);
    return (h.length === 3 ? h.split('').map((x) => x + x).join('') : h.slice(0, 6)).toUpperCase();
  }
  const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  return m ? [m[1], m[2], m[3]].map((n) => (+n).toString(16).padStart(2, '0')).join('').toUpperCase() : undefined;
};

interface RunStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
  fontSize?: number;
  fontFace?: string;
}

/** Turn an element's HTML into pptxgenjs text runs, one paragraph at a time. */
export function htmlToRuns(html: string, el: El): any[] {
  const root = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html').body.firstElementChild!;
  const runs: any[] = [];
  const base: RunStyle = { fontSize: el.size || 18, color: hex(el.color) || '000000', fontFace: el.font };

  const blocks: { node: Element; bullet: false | 'bullet' | 'number'; indent: number }[] = [];
  const collect = (node: Element, bullet: false | 'bullet' | 'number', indent: number) => {
    for (const child of Array.from(node.children)) {
      const tag = child.tagName.toLowerCase();
      if (tag === 'ul' || tag === 'ol') collect(child, tag === 'ul' ? 'bullet' : 'number', indent + (bullet ? 1 : 0));
      else if (tag === 'p' || tag === 'div' || tag === 'li' || /^h\d$/.test(tag)) blocks.push({ node: child, bullet: tag === 'li' ? bullet || 'bullet' : false, indent });
      else blocks.push({ node: child, bullet: false, indent });
    }
  };
  collect(root, false, 0);
  if (!blocks.length) blocks.push({ node: root, bullet: false, indent: 0 });

  blocks.forEach((b, bi) => {
    const align = (b.node as HTMLElement).style?.textAlign || 'left';
    const paraOpts: any = {
      align: align === 'justify' ? 'justify' : align,
      ...(b.bullet ? { bullet: b.bullet === 'number' ? { type: 'number' } : true, indentLevel: b.indent } : {})
    };
    const start = runs.length;
    const walk = (n: Node, st: RunStyle) => {
      if (n.nodeType === Node.TEXT_NODE) {
        const text = n.textContent || '';
        if (text) runs.push({ text, options: { ...st } });
        return;
      }
      if (n.nodeType !== Node.ELEMENT_NODE) return;
      const e = n as HTMLElement;
      const tag = e.tagName.toLowerCase();
      if (tag === 'br') {
        runs.push({ text: '', options: { ...st, breakLine: true } });
        return;
      }
      const next: RunStyle = { ...st };
      if (tag === 'b' || tag === 'strong' || +e.style.fontWeight >= 600 || e.style.fontWeight === 'bold') next.bold = true;
      if (tag === 'i' || tag === 'em' || e.style.fontStyle === 'italic') next.italic = true;
      if (tag === 'u' || e.style.textDecoration.includes('underline')) next.underline = true;
      if (e.style.color) next.color = hex(e.style.color) || next.color;
      if (e.style.fontSize) {
        const v = parseFloat(e.style.fontSize);
        if (!isNaN(v)) next.fontSize = v;
      }
      if (e.style.fontFamily) next.fontFace = e.style.fontFamily.split(',')[0].replace(/["']/g, '').trim();
      e.childNodes.forEach((c) => walk(c, next));
    };
    b.node.childNodes.forEach((c) => walk(c, base));
    if (runs.length === start) runs.push({ text: '', options: { ...base } });
    // Paragraph options ride on the first run; the last run ends the paragraph.
    runs[start].options = { ...runs[start].options, ...paraOpts };
    if (bi < blocks.length - 1) runs[runs.length - 1].options.breakLine = true;
    for (const r of runs.slice(start)) {
      if (r.options.underline) r.options.underline = { style: 'sng' };
    }
  });
  return runs;
}

export async function writePptx(deck: Deck): Promise<Uint8Array> {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'SLATE', width: deck.w / 72, height: deck.h / 72 });
  pptx.layout = 'SLATE';
  pptx.author = 'Slate Office';
  const inch = (v: number) => v / 72;

  for (const s of deck.slides) {
    const slide = pptx.addSlide();
    slide.background = { color: hex(s.bg) || 'FFFFFF' };
    for (const el of s.els) {
      const pos = { x: inch(el.x), y: inch(el.y), w: inch(el.w), h: inch(el.h), rotate: el.rot || 0, flipH: el.flipH, flipV: el.flipV };
      if (el.type === 'image' && el.src) {
        if (/^data:image\/(png|jpe?g|gif|svg\+xml|bmp)/.test(el.src)) slide.addImage({ data: el.src, ...pos });
        continue;
      }
      const shapeType =
        el.shape === 'ellipse'
          ? pptx.ShapeType.ellipse
          : el.shape === 'roundRect'
            ? pptx.ShapeType.roundRect
            : el.shape === 'triangle'
              ? pptx.ShapeType.triangle
              : el.shape === 'line' || el.shape === 'arrow'
                ? pptx.ShapeType.line
                : pptx.ShapeType.rect;
      const fill = el.fill ? { color: hex(el.fill)! } : undefined;
      const line = el.stroke ? { color: hex(el.stroke)!, width: el.strokeW || 1, ...(el.shape === 'arrow' ? { endArrowType: 'triangle' as const } : {}) } : undefined;
      if (el.type === 'text' && el.html) {
        slide.addText(htmlToRuns(el.html, el), {
          ...pos,
          shape: el.shape && el.shape !== 'none' ? shapeType : undefined,
          fill,
          line,
          valign: el.valign === 'middle' ? 'middle' : el.valign === 'bottom' ? 'bottom' : 'top',
          margin: [3.6, 7.2, 3.6, 7.2],
          fit: 'none',
          fontFace: el.font || deck.font
        } as any);
      } else {
        slide.addShape(shapeType, { ...pos, fill, line: line || (el.shape === 'line' ? { color: '000000', width: 1 } : undefined) } as any);
      }
    }
    if (s.notes) slide.addNotes(s.notes);
  }
  const out = (await pptx.write({ outputType: 'arraybuffer' })) as ArrayBuffer;
  return new Uint8Array(out);
}
