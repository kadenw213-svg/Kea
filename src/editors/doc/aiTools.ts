// Claude's layout and formatting tools for documents, beyond reading and rewriting text: insert fully formatted
// content (colours, sizes, fonts, alignment, tables, images), place an attached picture, restyle an existing passage,
// and set up the page. Enough to lay out a flier, a poster-style handout or a formatted paper from a concept.
import type { Editor } from '@tiptap/react';
import type { AssistantTool } from '../../store';
import { attachment, imageSource, resolveImage } from '../../lib/attachments';
import { findQuote } from './aiHooks';
import { PAGE_SIZES, type DocMeta } from './docMeta';

const hex = { type: 'string', description: 'CSS hex colour like "#1a73e8"' };
const where = {
  where: { type: 'string', enum: ['cursor', 'start', 'end', 'after'], description: 'Where it goes (default: after the paragraph with the cursor). "after" needs `quote`.' },
  quote: { type: 'string', description: 'With where "after": text copied from the paragraph it goes after' }
};

export function docTools(get: () => Editor | null, meta?: { get(): DocMeta; set(m: DocMeta): void }): AssistantTool[] {
  const ed = () => {
    const e = get();
    if (!e) throw new Error('The document isn’t ready.');
    return e;
  };
  /** The position content is inserted at. */
  const posFor = (e: Editor, w = 'cursor', quote?: string) => {
    if (w === 'start') return 0;
    if (w === 'end') return e.state.doc.content.size;
    if (w === 'after') {
      if (!quote) throw new Error('where "after" needs `quote`.');
      const r = findQuote(e, quote);
      if (!r) throw new Error('That text wasn’t found. Copy it exactly from read_document.');
      const $p = e.state.doc.resolve(r.to);
      return $p.depth >= 1 ? $p.after(1) : r.to;
    }
    const $to = e.state.selection.$to;
    return $to.depth >= 1 ? $to.after(1) : e.state.doc.content.size;
  };

  const tools: AssistantTool[] = [
    {
      name: 'insert_formatted',
      description:
        'Insert formatted content as HTML: <h1>–<h3>, <p style="text-align:center">, <span style="color:#…; font-size:28pt; font-family:Georgia">, <mark data-color="#fde68a">, <b>/<i>/<u>/<s>, <ul>/<ol>, <table> (good for multi-column layouts), <hr>, and images as <img src="attachment:a1" style="width:60%" data-align="center"> for attached pictures. Use it to lay out designed pages (fliers, title pages, handouts) in one go.',
      input_schema: { type: 'object', properties: { html: { type: 'string' }, ...where }, required: ['html'] },
      run: ({ html, where: w, quote }) => {
        const e = ed();
        const missing: string[] = [];
        // Attached pictures by id become the pictures themselves.
        const full = String(html).replace(/src=(["']?)attachment:([\w-]+)\1/g, (_m, q, id) => {
          q = q || '"';
          const a = attachment(id);
          if (!a || !a.mime.startsWith('image/')) {
            missing.push(id);
            return `src=${q}${q}`;
          }
          return `src=${q}${a.dataUrl}${q}`;
        });
        if (missing.length) throw new Error(`No attached image ${missing.join(', ')}.`);
        if (!e.chain().focus().insertContentAt(posFor(e, w, quote), full).run()) throw new Error('The editor couldn’t insert that there.');
        return 'Inserted.';
      }
    },
    {
      name: 'insert_image',
      description: 'Put a picture in the document as its own block: an attached image, a file path, or vector artwork you write (svg) such as a banner, divider, badge or illustration. width is a percentage of the text column.',
      input_schema: {
        type: 'object',
        properties: { ...imageSource, width: { type: 'number', description: 'Percent of the column width (default 100, or the picture’s own size if smaller)' }, align: { type: 'string', enum: ['left', 'center', 'right'] }, ...where }
      },
      run: async ({ attachment: a, path, svg, width, align = 'center', where: w, quote }) => {
        const img = await resolveImage({ attachment: a, path, svg });
        const e = ed();
        const pct = Math.max(5, Math.min(100, width ?? 100));
        const ok = e
          .chain()
          .focus()
          .insertContentAt(posFor(e, w, quote), { type: 'image', attrs: { src: img.dataUrl, alt: img.name, width: `${pct}%`, align } })
          .run();
        if (!ok) throw new Error('The editor couldn’t insert the picture there.');
        return `Inserted “${img.name}” at ${pct}% width.`;
      }
    },
    {
      name: 'format_text',
      description: 'Restyle a passage without changing its words: bold/italic/underline/strike (true/false), colour, highlight, font, size in points, paragraph alignment, or turn its paragraph into a heading (1–3) or back to normal text (0). `quote` is copied from read_document.',
      input_schema: {
        type: 'object',
        properties: {
          quote: { type: 'string' },
          bold: { type: 'boolean' },
          italic: { type: 'boolean' },
          underline: { type: 'boolean' },
          strike: { type: 'boolean' },
          color: { ...hex, description: 'Text colour ("" for automatic)' },
          highlight: { ...hex, description: 'Highlight colour ("" removes it)' },
          font: { type: 'string' },
          size: { type: 'number', description: 'Points' },
          align: { type: 'string', enum: ['left', 'center', 'right', 'justify'] },
          heading: { type: 'integer', enum: [0, 1, 2, 3] }
        },
        required: ['quote']
      },
      run: ({ quote, bold, italic, underline, strike, color, highlight, font, size, align, heading }) => {
        const e = ed();
        const r = findQuote(e, quote);
        if (!r) throw new Error('That text wasn’t found. Copy it exactly from read_document.');
        let ch = e.chain().setTextSelection(r) as any;
        const mark = (name: string, on: boolean | undefined) => {
          if (on === true) ch = ch.setMark(name);
          else if (on === false) ch = ch.unsetMark(name);
        };
        mark('bold', bold);
        mark('italic', italic);
        mark('underline', underline);
        mark('strike', strike);
        if (color !== undefined) ch = color ? ch.setColor(color) : ch.unsetColor();
        if (highlight !== undefined) ch = highlight ? ch.setHighlight({ color: highlight }) : ch.unsetHighlight();
        if (font !== undefined) ch = font ? ch.setFontFamily(font) : ch.unsetFontFamily();
        if (size !== undefined) ch = ch.setFontSize(`${size}pt`);
        if (heading !== undefined) ch = heading ? ch.setNode('heading', { level: heading }) : ch.setParagraph();
        if (align !== undefined) ch = ch.setTextAlign(align);
        if (!ch.run()) throw new Error('The editor couldn’t apply that formatting.');
        return 'Formatted.';
      }
    }
  ];
  if (meta)
    tools.push({
      name: 'page_setup',
      description: 'Set up the pages: size (letter, a4, legal, a5), orientation, margins in inches, and the default font, size (pt) and line spacing for body text. Only what you give changes.',
      input_schema: {
        type: 'object',
        properties: {
          size: { type: 'string', enum: ['letter', 'a4', 'legal', 'a5'] },
          landscape: { type: 'boolean' },
          margins: { type: 'number', description: 'All four margins, inches' },
          margin_top: { type: 'number' },
          margin_bottom: { type: 'number' },
          margin_left: { type: 'number' },
          margin_right: { type: 'number' },
          font: { type: 'string' },
          font_size: { type: 'number' },
          line_spacing: { type: 'number', description: '1 single, 1.5, 2 double' }
        }
      },
      run: (p) => {
        const m = meta.get();
        const page = { ...m.page, margins: { ...m.page.margins } };
        if (p.size) {
          const s = PAGE_SIZES[p.size];
          if (!s) throw new Error('Unknown page size.');
          Object.assign(page, { size: p.size, width: s.w, height: s.h });
        }
        if (p.landscape !== undefined) page.landscape = p.landscape;
        const clampIn = (v: number) => Math.max(0, Math.min(3, v));
        if (p.margins !== undefined) page.margins = { top: clampIn(p.margins), right: clampIn(p.margins), bottom: clampIn(p.margins), left: clampIn(p.margins) };
        for (const k of ['top', 'bottom', 'left', 'right'] as const) if (p[`margin_${k}`] !== undefined) page.margins[k] = clampIn(p[`margin_${k}`]);
        const defaults = { ...m.defaults };
        if (p.font) defaults.font = p.font;
        if (p.font_size) defaults.sizePt = p.font_size;
        if (p.line_spacing) defaults.lineHeight = p.line_spacing;
        meta.set({ ...m, page, defaults });
        return `Page: ${page.size}${page.landscape ? ' landscape' : ''}, margins ${page.margins.top}/${page.margins.right}/${page.margins.bottom}/${page.margins.left} in; body ${defaults.font} ${defaults.sizePt}pt, line spacing ${defaults.lineHeight}.`;
      }
    });
  return tools;
}
