// Claude's design tools for slides: see every element of a slide, and place, change, layer and remove text boxes,
// shapes and images anywhere, so a flier, poster or concept can be built (or a plain slide redesigned) from scratch.
// Slide coordinates are points: a 16:9 slide is 960 × 540. Each tool is one undo step.
import type { AssistantTool } from '../../store';
import { uid, escapeHtml } from '../../lib/util';
import { imageSource, resolveImage } from '../../lib/attachments';
import { safeFormatHtml } from '../../lib/safeHtml';
import type { Deck, El, ShapeKind } from './model';
import { contrast, formatIssues, missingFonts, parseColour, sampleImage, type Issue } from '../../lib/design/check';

export interface SlidesAiCtx {
  h: { get(): Deck; commit(d: Deck): void };
  idx: number;
  setIdx(i: number): void;
  select(id: string | null): void;
  markDirty(): void;
}

const SHAPES: ShapeKind[] = ['rect', 'roundRect', 'ellipse', 'triangle', 'line', 'arrow'];
const hex = { type: 'string', description: 'CSS hex colour like "#1a73e8"' };
const slideNo = { type: 'integer', description: 'Slide number from 1 (default: the slide shown)' };
const box = {
  x: { type: 'number' },
  y: { type: 'number' },
  w: { type: 'number' },
  h: { type: 'number' },
  rotation: { type: 'number', description: 'Degrees clockwise' }
};
const textProps = {
  text: { type: 'string', description: 'Plain text; each line becomes a paragraph' },
  html: { type: 'string', description: 'Or formatted text: <p>, <b>, <i>, <u>, <ul>/<ol>/<li>, <br>, <span style="color:…;font-size:…px;font-weight:…;letter-spacing:…">. Overrides text.' },
  size: { type: 'number', description: 'Font size in points' },
  color: hex,
  font: { type: 'string', description: 'Font family, e.g. "Segoe UI", "Georgia", "Arial Black", "Calibri"' },
  bold: { type: 'boolean' },
  italic: { type: 'boolean' },
  align: { type: 'string', enum: ['left', 'center', 'right'] },
  valign: { type: 'string', enum: ['top', 'middle', 'bottom'] }
};

const plain = (html: string) => {
  const d = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  d.querySelectorAll('p, li, br, div').forEach((n) => n.append('\n'));
  return (d.body.textContent || '').replace(/\n{2,}/g, '\n').trim();
};

/** The HTML for a text box from the tool's text options. */
function textHtml(p: { text?: string; html?: string; bold?: boolean; italic?: boolean; align?: string }): string | undefined {
  if (p.html === undefined && p.text === undefined) return undefined;
  let inner = p.html !== undefined ? safeFormatHtml(p.html) : String(p.text).split('\n').map((l) => `<p>${escapeHtml(l) || '<br>'}</p>`).join('');
  if (p.bold) inner = inner.replace(/<p([^>]*)>/g, '<p$1><b>').replace(/<\/p>/g, '</b></p>');
  if (p.italic) inner = inner.replace(/<p([^>]*)>/g, '<p$1><i>').replace(/<\/p>/g, '</i></p>');
  if (p.align && p.align !== 'left') inner = inner.replace(/<(p|li)(?: style="([^"]*)")?>/g, (_m, tag, st) => `<${tag} style="${st ? `${st};` : ''}text-align:${p.align}">`);
  if (!/^\s*<(p|ul|ol|div)/i.test(inner)) inner = `<p${p.align && p.align !== 'left' ? ` style="text-align:${p.align}"` : ''}>${inner}</p>`;
  return inner;
}

/** An image fitted to a box: "contain" keeps it whole (the box shrinks to its shape), "cover" crops it to fill. */
async function fitImage(src: { dataUrl: string; width: number; height: number; img: HTMLImageElement }, w: number, h: number, fit: string) {
  if (fit !== 'cover') return { src: src.dataUrl, w, h };
  const target = w / h;
  const ratio = src.width / src.height;
  const cw = ratio > target ? src.height * target : src.width;
  const ch = ratio > target ? src.height : src.width / target;
  const c = document.createElement('canvas');
  c.width = Math.round(cw);
  c.height = Math.round(ch);
  c.getContext('2d')!.drawImage(src.img, (src.width - cw) / 2, (src.height - ch) / 2, cw, ch, 0, 0, c.width, c.height);
  return { src: c.toDataURL(/png|gif|webp/.test(src.dataUrl.slice(5, 20)) ? 'image/png' : 'image/jpeg', 0.92), w, h };
}

export function slidesDesignTools(c: SlidesAiCtx): AssistantTool[] {
  const at = (n?: number) => {
    const d = c.h.get();
    const i = n === undefined ? Math.min(c.idx, d.slides.length - 1) : n - 1;
    if (!Number.isInteger(i) || i < 0 || i >= d.slides.length) throw new Error(`There's no slide ${n}; the deck has ${d.slides.length}.`);
    return i;
  };
  const change = (i: number, fn: (els: El[]) => El[], select?: string | null) => {
    const d = c.h.get();
    c.h.commit({ ...d, slides: d.slides.map((s, j) => (j === i ? { ...s, els: fn(s.els) } : s)) });
    c.markDirty();
    c.setIdx(i);
    if (select !== undefined) c.select(select);
  };
  const find = (i: number, id: string) => {
    const el = c.h.get().slides[i].els.find((e) => e.id === id);
    if (!el) throw new Error(`No element ${id} on slide ${i + 1}. describe_slide lists them.`);
    if (el.locked) throw new Error(`${id} is background art from the layout; it can't be changed here.`);
    return el;
  };
  const offSlide = (el: El) => {
    const d = c.h.get();
    return el.x < -1 || el.y < -1 || el.x + el.w > d.w + 1 || el.y + el.h > d.h + 1 ? ` Note: it extends past the slide (${d.w} × ${d.h}).` : '';
  };

  return [
    {
      name: 'check_design',
      description:
        'Measure the slide as it is actually rendered and list objective problems: text overflowing its box, text overlapping other text, things partly off the page, text contrast against what is really behind it (artwork pixels included), near-miss alignment, fonts that aren’t installed, too many type sizes, text too small to read. Run it after each pass and before you finish; it is cheaper and more exact than look for these.',
      input_schema: { type: 'object', properties: { slide: slideNo } },
      run: async ({ slide }) => {
        const i = at(slide);
        c.setIdx(i);
        await new Promise((r) => setTimeout(r, 250));
        const d = c.h.get();
        const sl = d.slides[i];
        const W = d.w,
          H = d.h;
        const issues: Issue[] = [];
        const r1 = (v: number) => Math.round(v);
        const name = (e: El) => `${e.id} (${e.type === 'text' || e.html ? `“${plain(e.html || '').slice(0, 28).replace(/\n/g, ' ')}”` : e.type === 'image' ? 'image' : e.shape})`;
        const dom = (e: El) => document.querySelector(`[data-el="${CSS.escape(e.id)}"]`) as HTMLElement | null;
        const view = [...document.querySelectorAll<HTMLElement>('.slide-view')].filter((v) => v.querySelector('[data-el]')).sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
        const scale = view ? view.getBoundingClientRect().width / W : 1;
        const texts: { e: El; box: { x: number; y: number; w: number; h: number }; size: number; bold: boolean; colours: Set<string>; fonts: Set<string>; sizes: number[] }[] = [];
        for (const e of sl.els) {
          if (e.locked) continue;
          const node = dom(e);
          const isText = e.html !== undefined && plain(e.html).trim().length > 0;
          const past = { l: -e.x, t: -e.y, r: e.x + e.w - W, b: e.y + e.h - H };
          const worst = Math.max(past.l, past.t, past.r, past.b);
          if (isText && worst > 1) issues.push({ severity: 'fix', text: `${name(e)} runs ${r1(worst)} pt off the page.` });
          else if (!isText && worst > 0.5 && worst < 8 && Math.min(e.w / W, e.h / H) < 0.9) issues.push({ severity: 'consider', text: `${name(e)} pokes ${worst.toFixed(1)} pt past the edge: either keep it inside or bleed it clearly (8+ pt).` });
          if (!isText || !node) continue;
          const inner = node.querySelector('.sv-text-inner') as HTMLElement | null;
          if (!inner) continue;
          const nb = node.getBoundingClientRect();
          const ib = inner.getBoundingClientRect();
          // Layout sizes (scrollHeight etc.) are in slide points; on-screen rects are zoomed, so divide those by scale.
          const need = Math.max(ib.height / scale, inner.scrollHeight) + 7.2;
          if (need > e.h + 2) issues.push({ severity: 'fix', text: `${name(e)}: the text needs about ${r1(need)} pt of height but the box is ${r1(e.h)} pt, so it spills out. Make the box taller, the text smaller, or the copy shorter.` });
          if (inner.scrollWidth > inner.clientWidth + 2) issues.push({ severity: 'fix', text: `${name(e)}: a word is wider than the box (${r1(inner.scrollWidth)} pt vs ${r1(inner.clientWidth)} pt).` });
          const colours = new Set<string>(),
            fonts = new Set<string>(),
            sizes: number[] = [];
          let bold = false;
          const walk = (n: Element) => {
            const hasText = [...n.childNodes].some((x) => x.nodeType === 3 && (x.textContent || '').trim());
            if (hasText) {
              const cs = getComputedStyle(n);
              colours.add(cs.color);
              fonts.add(cs.fontFamily);
              sizes.push(parseFloat(cs.fontSize));
              if (Number(cs.fontWeight) >= 600) bold = true;
            }
            for (const ch of n.children) walk(ch);
          };
          walk(inner);
          texts.push({ e, box: { x: e.x + (ib.left - nb.left) / scale, y: e.y + (ib.top - nb.top) / scale, w: ib.width / scale, h: Math.max(ib.height / scale, inner.scrollHeight) }, size: Math.min(...(sizes.length ? sizes : [e.size || 18])), bold, colours, fonts, sizes });
        }
        // Text on text.
        for (let a = 0; a < texts.length; a++)
          for (let b = a + 1; b < texts.length; b++) {
            const A = texts[a].box,
              B = texts[b].box;
            const ox = Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x);
            const oy = Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y);
            if (ox > 2 && oy > 2 && ox * oy > 0.12 * Math.min(A.w * A.h, B.w * B.h)) issues.push({ severity: 'fix', text: `The text of ${name(texts[a].e)} and ${name(texts[b].e)} overlap (${r1(ox)} × ${r1(oy)} pt).` });
          }
        // Contrast against what is really behind each text block.
        for (const t of texts) {
          const cx = t.box.x + t.box.w / 2,
            cy = t.box.y + t.box.h / 2;
          let bg: [number, number, number] | null = t.e.fill ? parseColour(t.e.fill) : null;
          if (!bg) {
            const idx = sl.els.indexOf(t.e);
            for (let k = idx - 1; k >= 0 && !bg; k--) {
              const u = sl.els[k];
              if (cx < u.x || cx > u.x + u.w || cy < u.y || cy > u.y + u.h) continue;
              if (u.type === 'image' && u.src) bg = await sampleImage(u.src, { x: (t.box.x - u.x) / u.w, y: (t.box.y - u.y) / u.h, w: t.box.w / u.w, h: t.box.h / u.h });
              else if (u.fill && u.shape !== 'line' && u.shape !== 'arrow') bg = parseColour(u.fill);
            }
          }
          bg ||= parseColour(sl.bg) || [255, 255, 255];
          const need = t.size >= 18 || (t.bold && t.size >= 14) ? 3 : 4.5;
          for (const col of t.colours) {
            const fg = parseColour(col);
            if (!fg) continue;
            const ratio = contrast(fg, bg);
            if (ratio < need) issues.push({ severity: 'fix', text: `${name(t.e)}: contrast ${ratio.toFixed(1)}:1 against what’s behind it (needs ${need}:1 at ${r1(t.size)} pt). Darken/lighten the text or add a panel or scrim behind it.` });
          }
        }
        // Readability, sizes, fonts.
        const minSize = W >= 900 ? 14 : W >= 700 ? 11 : 7.5;
        for (const t of texts) if (t.size < minSize - 0.1) issues.push({ severity: 'fix', text: `${name(t.e)} is ${t.size.toFixed(1)} pt, too small to read on this format (keep text ≥ ${minSize} pt).` });
        const sizes = new Set(texts.flatMap((t) => t.sizes.map((x) => Math.round(x))));
        if (sizes.size > 5) issues.push({ severity: 'consider', text: `${sizes.size} different type sizes (${[...sizes].sort((a, b) => b - a).join(', ')} pt): 3–4 reads as more deliberate.` });
        const missing = missingFonts([...new Set(texts.flatMap((t) => [...t.fonts]))]);
        if (missing.length) issues.push({ severity: 'fix', text: `Not installed here, so it falls back to a default: ${missing.join(', ')}. Use an installed font (design_guide "start").` });
        // Near-miss alignment of left edges.
        const lefts = sl.els.filter((e) => !e.locked && e.x > 1 && e.w < W * 0.95);
        let near = 0;
        for (let a = 0; a < lefts.length && near < 4; a++)
          for (let b = a + 1; b < lefts.length && near < 4; b++) {
            const dx = Math.abs(lefts[a].x - lefts[b].x);
            if (dx > 0.6 && dx < 6) {
              near++;
              issues.push({ severity: 'consider', text: `${name(lefts[a])} and ${name(lefts[b])} almost line up (left edges ${lefts[a].x.toFixed(1)} vs ${lefts[b].x.toFixed(1)} pt): align them exactly or offset them clearly.` });
            }
          }
        return formatIssues(issues, `slide ${i + 1}`);
      }
    },
    {
      name: 'describe_slide',
      description: 'See a slide as data: its size, background and every element back to front, with ids, positions (points), sizes, colours, fonts and text. Use it before rearranging or restyling, together with look.',
      input_schema: { type: 'object', properties: { slide: slideNo } },
      run: ({ slide }) => {
        const d = c.h.get();
        const i = at(slide);
        const s = d.slides[i];
        const r = Math.round;
        const lines = [`Slide ${i + 1} of ${d.slides.length}: ${d.w} × ${d.h} pt, background ${s.bg}, deck font ${d.font}. Elements back to front:`];
        for (const e of s.els) {
          const bits = [`${e.id}: ${e.type}${e.type === 'shape' ? ` ${e.shape}` : ''}${e.role ? ` (${e.role} placeholder)` : ''}${e.locked ? ' (layout art, locked)' : ''}`, `box (${r(e.x)}, ${r(e.y)}) ${r(e.w)}×${r(e.h)}`];
          if (e.rot) bits.push(`rotated ${r(e.rot)}°`);
          if (e.fill) bits.push(`fill ${e.fill}`);
          if (e.stroke && e.strokeW) bits.push(`outline ${e.stroke} ${e.strokeW}pt`);
          if (e.html !== undefined) bits.push(`text ${e.size || 18}pt ${e.color || '#000000'}${e.font ? ` ${e.font}` : ''} “${plain(e.html).slice(0, 120).replace(/\n/g, ' / ')}”`);
          lines.push(`- ${bits.join(', ')}`);
        }
        if (s.notes) lines.push(`Speaker notes: ${s.notes.slice(0, 300)}`);
        return lines.join('\n');
      }
    },
    {
      name: 'add_text_box',
      description: 'Put a text box anywhere on a slide. Text wraps inside the box width. For designs, give each piece of type its own box (headline, subhead, details) so each can be sized and placed precisely.',
      input_schema: { type: 'object', properties: { slide: slideNo, ...box, ...textProps, fill: { ...hex, description: 'Box background (leave out for none)' } }, required: ['x', 'y', 'w', 'h'] },
      run: ({ slide, x, y, w, h, rotation, size = 24, color, font, valign = 'top', fill, ...t }) => {
        const i = at(slide);
        const el: El = { id: uid(), type: 'text', shape: fill ? 'rect' : 'none', x, y, w, h, rot: rotation || undefined, fill: fill || null, stroke: null, strokeW: 0, valign, size, color: color || '#202124', font, html: textHtml(t) ?? '<p></p>' };
        change(i, (els) => [...els, el], el.id);
        return `Added text box ${el.id} on slide ${i + 1}.${offSlide(el)}`;
      }
    },
    {
      name: 'add_shape',
      description: 'Draw a shape on a slide: rect, roundRect, ellipse, triangle, line or arrow (lines run from the box’s top-left to bottom-right corner; give h ≈ 0 for a horizontal line). Shapes can hold centred text. Use filled rects as colour panels, bands and backgrounds.',
      input_schema: {
        type: 'object',
        properties: { slide: slideNo, shape: { type: 'string', enum: SHAPES }, ...box, fill: hex, stroke: hex, stroke_width: { type: 'number' }, ...textProps },
        required: ['shape', 'x', 'y', 'w', 'h']
      },
      run: ({ slide, shape, x, y, w, h, rotation, fill, stroke, stroke_width, size = 20, color, font, valign = 'middle', ...t }) => {
        const i = at(slide);
        const line = shape === 'line' || shape === 'arrow';
        const html = textHtml({ align: 'center', ...t });
        const el: El = {
          id: uid(),
          type: 'shape',
          shape,
          x,
          y,
          w: Math.max(w, 0.1),
          h: Math.max(h, 0.1),
          rot: rotation || undefined,
          fill: line ? null : fill ?? '#1a73e8',
          stroke: stroke ?? (line ? '#202124' : null),
          strokeW: stroke_width ?? (line || stroke ? 2 : 0),
          ...(html !== undefined ? { html, size, color: color || '#ffffff', font, valign } : {})
        };
        change(i, (els) => [...els, el], el.id);
        return `Added ${shape} ${el.id} on slide ${i + 1}.${offSlide(el)}`;
      }
    },
    {
      name: 'add_image',
      description: 'Place an image on a slide: an attached picture, a photo from a path, or vector artwork you write (svg): rich backgrounds (mesh gradients, grain, patterns), illustrations, badges, ornaments. Prefer svg art over plain add_shape boxes for anything decorative. fit "contain" (default) keeps the whole picture inside the box; "cover" crops it to fill the box exactly (good for full-bleed backgrounds: x 0, y 0, the slide size, then arrange_element "back").',
      input_schema: { type: 'object', properties: { slide: slideNo, ...imageSource, ...box, fit: { type: 'string', enum: ['contain', 'cover', 'stretch'] } } },
      run: async ({ slide, attachment, path, svg, x, y, w, h, rotation, fit = 'contain' }) => {
        const img = await resolveImage({ attachment, path, svg });
        const d = c.h.get();
        const i = at(slide);
        const ratio = img.height / img.width;
        // The box asked for (or one sized from the picture), then the picture inside it.
        const boxW = w ?? (h ? h / ratio : Math.min(d.w * 0.6, img.width));
        const boxH = h ?? boxW * ratio;
        let bw = boxW,
          bh = boxH;
        if (fit === 'contain' && w && h) {
          const s = Math.min(w / img.width, h / img.height);
          bw = img.width * s;
          bh = img.height * s;
        }
        const placed = await fitImage(img, bw, bh, fit);
        const left = (x ?? (d.w - boxW) / 2) + (boxW - bw) / 2;
        const top = (y ?? (d.h - boxH) / 2) + (boxH - bh) / 2;
        const el: El = { id: uid(), type: 'image', src: placed.src, x: left, y: top, w: bw, h: bh, rot: rotation || undefined };
        change(i, (els) => [...els, el], el.id);
        return `Placed “${img.name}” as ${el.id} on slide ${i + 1} at (${Math.round(el.x)}, ${Math.round(el.y)}), ${Math.round(bw)} × ${Math.round(bh)} pt.${offSlide(el)}`;
      }
    },
    {
      name: 'update_element',
      description: 'Change an element (ids from describe_slide): move, resize, rotate, recolour, or replace its text and type styling. Only what you give changes. Works on title/body placeholders too.',
      input_schema: { type: 'object', properties: { slide: slideNo, id: { type: 'string' }, ...box, fill: hex, stroke: hex, stroke_width: { type: 'number' }, ...textProps }, required: ['id'] },
      run: ({ slide, id, x, y, w, h, rotation, fill, stroke, stroke_width, size, color, font, valign, ...t }) => {
        const i = at(slide);
        const el = { ...find(i, id) };
        if (x !== undefined) el.x = x;
        if (y !== undefined) el.y = y;
        if (w !== undefined) el.w = w;
        if (h !== undefined) el.h = h;
        if (rotation !== undefined) el.rot = rotation || undefined;
        if (fill !== undefined) el.fill = fill || null;
        if (stroke !== undefined) el.stroke = stroke || null;
        if (stroke_width !== undefined) el.strokeW = stroke_width;
        if (size !== undefined) el.size = size;
        if (color !== undefined) el.color = color;
        if (font !== undefined) el.font = font;
        if (valign !== undefined) el.valign = valign;
        const html = textHtml(t);
        if (html !== undefined) el.html = html;
        else if (el.html !== undefined && (t.align || t.bold || t.italic)) el.html = textHtml({ html: el.html, ...t });
        change(i, (els) => els.map((e) => (e.id === id ? el : e)), id);
        return `Updated ${id}.${offSlide(el)}`;
      }
    },
    {
      name: 'arrange_element',
      description: 'Change the stacking order: "front", "back", "forward" (up one) or "backward" (down one).',
      input_schema: { type: 'object', properties: { slide: slideNo, id: { type: 'string' }, to: { type: 'string', enum: ['front', 'back', 'forward', 'backward'] } }, required: ['id', 'to'] },
      run: ({ slide, id, to }) => {
        const i = at(slide);
        find(i, id);
        change(i, (els) => {
          const list = els.filter((e) => e.id !== id);
          const el = els.find((e) => e.id === id)!;
          const cur = els.indexOf(el);
          // "Back" stays in front of the layout's own locked art.
          const floor = list.filter((e) => e.locked).length;
          const pos = to === 'front' ? list.length : to === 'back' ? floor : to === 'forward' ? Math.min(list.length, cur + 1) : Math.max(floor, cur - 1);
          list.splice(pos, 0, el);
          return list;
        });
        return `Moved ${id} ${to === 'front' || to === 'back' ? `to the ${to}` : to}.`;
      }
    },
    {
      name: 'delete_element',
      description: 'Remove an element from a slide.',
      input_schema: { type: 'object', properties: { slide: slideNo, id: { type: 'string' } }, required: ['id'] },
      run: ({ slide, id }) => {
        const i = at(slide);
        find(i, id);
        change(i, (els) => els.filter((e) => e.id !== id), null);
        return `Deleted ${id}.`;
      }
    },
    {
      name: 'set_background',
      description: 'Set a slide’s background colour (or every slide’s, with all). For a picture background, add_image with fit "cover" over the whole slide and send it to the back.',
      input_schema: { type: 'object', properties: { slide: slideNo, color: hex, all: { type: 'boolean' } }, required: ['color'] },
      run: ({ slide, color, all }) => {
        if (!/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(color)) throw new Error('Give a hex colour like "#0b1d3a".');
        const d = c.h.get();
        const i = at(slide);
        c.h.commit({ ...d, slides: d.slides.map((s, j) => (all || j === i ? { ...s, bg: color } : s)) });
        c.markDirty();
        return all ? `Every slide’s background is now ${color}.` : `Slide ${i + 1}’s background is now ${color}.`;
      }
    },
    {
      name: 'set_page_size',
      description: 'Change the size of every slide, in points (16:9 960 × 540, 4:3 720 × 540, portrait Letter flier 612 × 792, A4 595 × 842, square post 720 × 720). Existing elements are scaled to the new size.',
      input_schema: { type: 'object', properties: { w: { type: 'number' }, h: { type: 'number' } }, required: ['w', 'h'] },
      run: ({ w, h }) => {
        if (!(w >= 100 && h >= 100 && w <= 5000 && h <= 5000)) throw new Error('Sizes must be 100–5000 points.');
        const d = c.h.get();
        const sx = w / d.w,
          sy = h / d.h,
          sf = Math.min(sx, sy);
        const slides = d.slides.map((s) => ({ ...s, els: s.els.map((e) => ({ ...e, x: e.x * sx, y: e.y * sy, w: e.w * sx, h: e.h * sy, ...(e.size ? { size: Math.round(e.size * sf * 10) / 10 } : {}) })) }));
        c.h.commit({ ...d, w, h, slides });
        c.markDirty();
        return `Slides are now ${w} × ${h} pt (elements scaled ${sx.toFixed(2)} × ${sy.toFixed(2)}).`;
      }
    }
  ];
}
