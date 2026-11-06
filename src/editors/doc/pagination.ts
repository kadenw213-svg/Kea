import { Extension, Node, mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey, EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet, EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { DocMeta, pageBox, hfFor, expandFields, HeaderFooter } from './docMeta';

/**
 * Print-layout view. The document stays one continuous editor, but after every change Kea measures
 * the top-level blocks and inserts "page gap" widgets where pages end. Each gap draws the bottom margin
 * (footnotes + footer) of one page, the grey space between pages, and the top margin (header) of the
 * next. The same page breaks drive printing and PDF export, so what you see is what prints.
 *
 * A paragraph (or list, quote, code block) that doesn't fit at the bottom of a page is split at a line, like Word and
 * Google Docs do: the page gap is drawn inside it, between two lines, and the rest carries on at the top of the next
 * page. At least two lines stay on each side (widow and orphan control). Headings, tables, pictures and other blocks
 * that can't be split move to the next page whole, and a heading never ends a page.
 */

export const GAP = 18; // px of grey between pages

export interface LayoutInput {
  meta: DocMeta;
  title: string;
  author?: string;
}

export interface PageBreak {
  /** Document position of the first block on the new page. */
  pos: number;
  /** Empty space left at the bottom of the previous page (px). */
  fill: number;
  /** Height of the footnote area on the previous page (px). */
  fnH: number;
  /** Footnotes that belong to the previous page. */
  notes: { n: number; text: string }[];
  /**
   * For a break inside a paragraph: how far (px) the paragraph's text sits in from the page's text column on the left
   * and right, so the gap drawn inside it still spans the whole page.
   */
  inset?: [number, number];
}

interface PagState {
  breaks: PageBreak[];
  /** Footnotes on the last page. */
  lastNotes: { n: number; text: string }[];
  lastFill: number;
  lastFnH: number;
  pages: number;
  decos: DecorationSet;
  stamp: string;
}

export const paginationKey = new PluginKey<PagState>('pagination');

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    footnote: {
      insertFootnote: (text?: string) => ReturnType;
    };
    pagination: {
      relayout: () => ReturnType;
    };
  }
}

/** Inline footnote: a superscript number in the text; the note itself prints at the bottom of the page. */
export const Footnote = Node.create({
  name: 'footnote',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      text: { default: '', parseHTML: (el) => el.getAttribute('data-footnote') || '', renderHTML: (a) => ({ 'data-footnote': a.text }) }
    };
  },
  parseHTML() {
    return [{ tag: 'sup[data-footnote]' }, { tag: 'span[data-footnote]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['sup', mergeAttributes(HTMLAttributes, { class: 'fn-ref' })];
  },
  addStorage() {
    return { onEdit: null as null | ((pos: number, text: string) => void) };
  },
  addNodeView() {
    return ({ node, getPos, editor }) => {
      const dom = document.createElement('sup');
      dom.className = 'fn-ref';
      dom.setAttribute('data-footnote', node.attrs.text);
      dom.title = node.attrs.text || 'Empty footnote';
      dom.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const pos = typeof getPos === 'function' ? getPos() : null;
        if (pos != null) (editor.storage as any).footnote.onEdit?.(pos, node.attrs.text);
      });
      return {
        dom,
        update: (n) => {
          if (n.type.name !== 'footnote') return false;
          dom.setAttribute('data-footnote', n.attrs.text);
          dom.title = n.attrs.text || 'Empty footnote';
          return true;
        }
      };
    };
  },
  addCommands() {
    return {
      insertFootnote:
        (text = '') =>
        ({ chain }) =>
          chain().insertContent({ type: this.name, attrs: { text } }).run()
    };
  },
  addKeyboardShortcuts() {
    return {
      'Mod-Alt-f': () => {
        const pos = this.editor.state.selection.from;
        const ok = this.editor.commands.insertFootnote('');
        if (ok) setTimeout(() => (this.editor.storage as any).footnote.onEdit?.(pos, ''), 0);
        return ok;
      }
    };
  }
});

/** All footnotes in document order with their numbers. */
export function footnotesOf(doc: PMNode) {
  const out: { pos: number; n: number; text: string }[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'footnote') out.push({ pos, n: out.length + 1, text: node.attrs.text || '' });
  });
  return out;
}

let measureCanvas: CanvasRenderingContext2D | null = null;
function textWidth(s: string, font: string) {
  if (!measureCanvas) measureCanvas = document.createElement('canvas').getContext('2d');
  measureCanvas!.font = font;
  return measureCanvas!.measureText(s).width;
}

/** Height of a footnote block, estimated from line wrapping (10pt text). */
function notesHeight(notes: { n: number; text: string }[], meta: DocMeta, contentW: number) {
  if (!notes.length) return 0;
  const sizePx = (10 * 96) / 72;
  const lh = sizePx * 1.25;
  const font = `${sizePx}px ${meta.defaults.font}`;
  let lines = 0;
  for (const n of notes) {
    // Wrap word by word, like the browser will.
    let line = 0;
    let count = 1;
    for (const word of `${n.n} ${n.text || ' '}`.split(/(\s+)/)) {
      const w = textWidth(word, font);
      if (line + w > contentW - 4 && line > 0 && word.trim()) {
        count++;
        line = w;
      } else line += w;
    }
    lines += count;
  }
  return Math.ceil(14 + lines * lh + 4);
}

function hfHtml(hf: HeaderFooter | null, page: number, pages: number, input: LayoutInput) {
  if (!hf) return '';
  const ctx = { page, pages, title: input.title, author: input.author };
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<span class="hf-l">${esc(expandFields(hf.left, ctx))}</span><span class="hf-c">${esc(expandFields(hf.center, ctx))}</span><span class="hf-r">${esc(expandFields(hf.right, ctx))}</span>`;
}

function notesHtml(notes: { n: number; text: string }[]) {
  if (!notes.length) return '';
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<div class="pg-notes"><div class="pg-notes-rule"></div>${notes.map((n) => `<div class="pg-note"><sup>${n.n}</sup> ${esc(n.text)}</div>`).join('')}</div>`;
}

function buildDecos(state: EditorState, s: Omit<PagState, 'decos' | 'stamp'>, input: LayoutInput, onHF: (which: 'header' | 'footer') => void): DecorationSet {
  const { meta } = input;
  if (meta.pageless) return DecorationSet.empty;
  const b = pageBox(meta);
  const start = meta.pageNumberStart || 1;
  const total = s.pages + start - 1;
  const decos: Decoration[] = [];
  const area = (which: 'header' | 'footer', html: string, height: number, dist: number) => {
    const el = document.createElement('div');
    el.className = `pg-${which}-area`;
    el.style.height = `${height}px`;
    const hf = document.createElement('div');
    hf.className = `pg-hf pg-${which}`;
    hf.style[which === 'header' ? 'top' : 'bottom'] = `${dist}px`;
    hf.style.left = `${b.ml}px`;
    hf.style.right = `${b.mr}px`;
    hf.innerHTML = html || `<span class="hf-empty">${which === 'header' ? 'Header' : 'Footer'}</span>`;
    hf.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onHF(which);
    });
    el.appendChild(hf);
    return el;
  };
  const pageEnd = (pageIndex: number, fill: number, fnH: number, notes: PageBreak['notes'], withNext: boolean, inset: [number, number] = [0, 0]) => {
    const wrap = document.createElement('div');
    wrap.className = inset[0] || inset[1] ? 'pg-break inner' : 'pg-break';
    wrap.contentEditable = 'false';
    wrap.style.margin = `0 -${b.mr + inset[1]}px 0 -${b.ml + inset[0]}px`;
    const filler = document.createElement('div');
    filler.style.height = `${Math.max(0, fill)}px`;
    wrap.appendChild(filler);
    if (notes.length) {
      const nb = document.createElement('div');
      nb.style.height = `${fnH}px`;
      nb.style.padding = `0 ${b.mr}px 0 ${b.ml}px`;
      nb.innerHTML = notesHtml(notes);
      wrap.appendChild(nb);
    }
    wrap.appendChild(area('footer', hfHtml(hfFor(meta, 'footer', pageIndex), pageIndex + start, total, input), b.mb, b.fd));
    if (withNext) {
      const gap = document.createElement('div');
      gap.className = 'pg-gap';
      gap.style.height = `${GAP}px`;
      wrap.appendChild(gap);
      wrap.appendChild(area('header', hfHtml(hfFor(meta, 'header', pageIndex + 1), pageIndex + 1 + start, total, input), b.mt, b.hd));
    }
    return wrap;
  };
  s.breaks.forEach((br, i) => {
    const key = `pb${i}:${br.fill}:${br.fnH}:${total}:${JSON.stringify(br.notes)}:${br.inset || ''}:${hfStamp(meta)}`;
    // (marks: [] keeps a gap inside a paragraph out of the bold, link or comment around it.)
    decos.push(Decoration.widget(br.pos, () => pageEnd(i, br.fill, br.fnH, br.notes, true, br.inset), { side: -1, key, marks: [], ignoreSelection: true, stopEvent: () => true }));
  });
  const endKey = `pend:${s.lastFill}:${s.lastFnH}:${total}:${JSON.stringify(s.lastNotes)}:${hfStamp(meta)}`;
  decos.push(Decoration.widget(state.doc.content.size, () => pageEnd(s.breaks.length, s.lastFill, s.lastFnH, s.lastNotes, false), { side: 1, key: endKey, ignoreSelection: true, stopEvent: () => true }));
  return DecorationSet.create(state.doc, decos);
}

const hfStamp = (m: DocMeta) => JSON.stringify([m.header, m.footer, m.firstHeader, m.firstFooter, m.pageNumberStart, m.page, m.defaults.font]);

/** Height of a widget in the editor flow (so natural block positions can be recovered). */
const widgetHeight = (br: { fill: number; fnH: number }, b: ReturnType<typeof pageBox>, withNext: boolean) => Math.max(0, br.fill) + br.fnH + b.mb + (withNext ? GAP + b.mt : 0);

/** Blocks that are never split across pages: they move to the next page whole. */
const UNSPLITTABLE = new Set(['heading', 'table', 'image', 'horizontalRule', 'pageBreak', 'bibliography', 'toc', 'mathBlock']);

/** Inline positions inside `node` (at `offset`) where a page could start: each character and inline object. */
function inlinePositions(node: PMNode, offset: number) {
  const out: number[] = [];
  const add = (n: PMNode, base: number) => {
    n.forEach((child, off) => {
      const at = base + off;
      if (child.isText) for (let i = 0; i < child.text!.length; i++) out.push(at + i);
      else if (child.isInline) out.push(at);
      else add(child, at + 1);
    });
  };
  add(node, offset + 1);
  return out;
}

function measure(view: EditorView, input: LayoutInput): Omit<PagState, 'decos' | 'stamp'> | null {
  const { meta } = input;
  const b = pageBox(meta);
  const doc = view.state.doc;
  const notes = footnotesOf(doc);
  const cur = paginationKey.getState(view.state);
  // The gaps drawn now push the text down; subtract them to get where everything sits without any gaps.
  const known = (cur?.breaks || []).map((br) => ({ pos: br.pos, h: widgetHeight(br, b, true) }));
  const shiftAt = (p: number) => known.reduce((s, k) => (k.pos <= p ? s + k.h : s), 0);
  const root = view.dom as HTMLElement;
  const rr = root.getBoundingClientRect();
  // (The page may be zoomed: measurements come back zoomed, the layout works in page pixels.)
  const scale = root.offsetHeight ? rr.height / root.offsetHeight : 1;
  if (!scale || !Number.isFinite(scale)) return null;
  const y = (clientY: number) => (clientY - rr.top) / scale;
  const charBox = (p: number) => {
    const c = view.coordsAtPos(p, 1);
    const s = shiftAt(p);
    return { top: y(c.top) - s, bottom: y(c.bottom) - s };
  };
  /** How far the paragraph holding `pos` sits in from the text column, so a gap drawn inside it spans the page. */
  const insetAt = (pos: number): [number, number] => {
    const $p = doc.resolve(pos);
    const el = $p.depth >= 1 ? (view.nodeDOM($p.before($p.depth)) as HTMLElement | null) : null;
    if (!el || !(el instanceof HTMLElement)) return [0, 0];
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const l = (r.left - rr.left) / scale + parseFloat(cs.paddingLeft || '0') + parseFloat(cs.borderLeftWidth || '0');
    const rt = (rr.right - r.right) / scale + parseFloat(cs.paddingRight || '0') + parseFloat(cs.borderRightWidth || '0');
    return [Math.max(0, Math.round(l)), Math.max(0, Math.round(rt))];
  };

  /**
   * Where to split a block that runs past `limit` (the bottom of the page's text area): the start of the first line
   * that doesn't fit, after `from`. With `keep` (the block doesn't start the page), at least two lines stay on this page
   * and at least two go to the next; otherwise anything goes, so a block taller than a page still breaks somewhere.
   */
  const splitAt = (node: PMNode, offset: number, from: number, limit: number, partTop: number, blockBottom: number, keep: boolean) => {
    if (node.isAtom || UNSPLITTABLE.has(node.type.name)) return null;
    const all = inlinePositions(node, offset);
    const ps = all.filter((p) => p > from && p !== all[0]);
    if (!ps.length) return null;
    // The first position whose character runs past the page (binary search: positions run down the page in order).
    let lo = 0;
    let hi = ps.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (charBox(ps[mid]).bottom > limit + 0.5) hi = mid;
      else lo = mid + 1;
    }
    if (lo >= ps.length) return null;
    /** Back to the first character on the line of ps[i]. */
    const lineStart = (i: number) => {
      const t = charBox(ps[i]).top;
      while (i > 0 && charBox(ps[i - 1]).bottom - t > 2) i--;
      return i;
    };
    let i = lineStart(lo);
    if (i <= 0 && from === offset) return null;
    let box = charBox(ps[i]);
    const lineH = Math.max(1, box.bottom - box.top);
    if (keep) {
      // Orphan: a single line left alone at the bottom of the page.
      if (box.top - partTop < lineH * 1.5) return null;
      // Widow: a single line carried over alone; carry the line before it too, if that still leaves two.
      if (blockBottom - box.top < lineH * 1.5 && i > 0) {
        const j = lineStart(i - 1);
        const jb = charBox(ps[j]);
        if (j > 0 && jb.top - partTop >= lineH * 1.5) {
          i = j;
          box = jb;
        }
      }
    }
    if (i <= 0) return null;
    return { pos: ps[i], top: box.top, prevBottom: charBox(ps[i - 1]).bottom, inset: insetAt(ps[i]) };
  };

  const breaks: PageBreak[] = [];
  let pageStart = 0; // natural y where the current page's content starts
  let pageNotes: { n: number; text: string }[] = [];
  let forceBreak = false;
  let lastBottom = 0;
  let lastNode: { node: PMNode; offset: number; top: number; before: number } | null = null;
  let ok = true;
  const room = (extra: { n: number; text: string }[]) => b.contentH - notesHeight([...pageNotes, ...extra], meta, b.contentW);
  const newPage = (pos: number, nextStart: number, inset?: [number, number]) => {
    const fnH = notesHeight(pageNotes, meta, b.contentW);
    breaks.push({ pos, fill: Math.round(Math.max(0, b.contentH - fnH - (lastBottom - pageStart))), fnH, notes: pageNotes, ...(inset && (inset[0] || inset[1]) ? { inset } : {}) });
    pageStart = nextStart;
    pageNotes = [];
  };

  doc.forEach((node, offset) => {
    if (!ok) return;
    const dom = view.nodeDOM(offset) as HTMLElement | null;
    if (!dom || !(dom instanceof HTMLElement)) return;
    const end = offset + node.nodeSize;
    const r = dom.getBoundingClientRect();
    const top = y(r.top) - shiftAt(offset);
    const bottom = y(r.bottom) - shiftAt(end - 1);
    if (!Number.isFinite(top) || !Number.isFinite(bottom)) {
      ok = false;
      return;
    }
    let rest = notes.filter((n) => n.pos >= offset && n.pos < end).map(({ n, text, pos }) => ({ n, text, pos }));
    const plain = (l: typeof rest) => l.map(({ n, text }) => ({ n, text }));
    if (forceBreak) {
      newPage(offset, top);
      forceBreak = false;
    }
    let from = offset; // where the part of this block still to place starts
    let partTop = top;
    for (let guard = 0; guard < 200; guard++) {
      if (bottom - pageStart <= room(plain(rest)) + 0.5) break;
      const first = partTop - pageStart < 1;
      const sp = splitAt(node, offset, from, pageStart + room(plain(rest)), partTop, bottom, !first);
      if (sp) {
        pageNotes.push(...plain(rest.filter((n) => n.pos < sp.pos)));
        rest = rest.filter((n) => n.pos >= sp.pos);
        lastBottom = sp.prevBottom;
        newPage(sp.pos, sp.top, sp.inset);
        from = sp.pos;
        partTop = sp.top;
        continue;
      }
      if (first || from !== offset) break; // taller than a page and can't be split: it runs over
      // A heading left at the bottom of the page goes over with the block after it.
      if (lastNode && lastNode.node.type.name === 'heading' && lastNode.top - pageStart >= 1 && !breaks.some((x) => x.pos === lastNode!.offset)) {
        const h = lastNode;
        lastBottom = h.before;
        newPage(h.offset, h.top);
        partTop = top;
        continue;
      }
      newPage(offset, top);
      partTop = top;
    }
    pageNotes.push(...plain(rest));
    lastNode = { node, offset, top, before: lastBottom };
    lastBottom = bottom;
    if (node.type.name === 'pageBreak') forceBreak = true;
  });
  if (!ok) return null;
  const lastFnH = notesHeight(pageNotes, meta, b.contentW);
  return { breaks, pages: breaks.length + 1, lastNotes: pageNotes, lastFnH, lastFill: Math.round(Math.max(0, b.contentH - lastFnH - (lastBottom - pageStart))) };
}

export const Pagination = Extension.create<{}, { input: () => LayoutInput; onHF: (which: 'header' | 'footer') => void; onPages: (n: number) => void }>({
  name: 'pagination',
  addStorage() {
    return { input: () => ({ meta: null as any, title: '' }), onHF: () => {}, onPages: () => {} };
  },
  addCommands() {
    return {
      relayout:
        () =>
        ({ tr, dispatch }) => {
          if (dispatch) tr.setMeta(paginationKey, { relayout: true }).setMeta('addToHistory', false);
          return true;
        }
    };
  },
  addProseMirrorPlugins() {
    const storage = this.storage;
    return [
      new Plugin<PagState>({
        key: paginationKey,
        state: {
          init: () => ({ breaks: [], lastNotes: [], lastFill: 0, lastFnH: 0, pages: 1, decos: DecorationSet.empty, stamp: '' }),
          apply(tr, value, _old, state) {
            const m = tr.getMeta(paginationKey);
            if (m && m.layout) {
              const decos = buildDecos(state, m.layout, storage.input(), storage.onHF);
              return { ...m.layout, decos, stamp: m.stamp };
            }
            if (m && m.relayout) return { ...value, stamp: '' };
            if (!tr.docChanged) return value;
            return {
              ...value,
              breaks: value.breaks.map((br) => ({ ...br, pos: tr.mapping.map(br.pos, -1) })),
              decos: value.decos.map(tr.mapping, tr.doc)
            };
          }
        },
        props: {
          decorations(state) {
            return paginationKey.getState(state)?.decos;
          }
        },
        view(view) {
          let raf = 0;
          let rounds = 0;
          const run = () => {
            raf = 0;
            const input = storage.input();
            if (!input.meta || view.isDestroyed) return;
            if (input.meta.pageless) {
              const st = paginationKey.getState(view.state);
              if (st && (st.breaks.length || st.decos !== DecorationSet.empty)) {
                view.dispatch(view.state.tr.setMeta(paginationKey, { layout: { breaks: [], lastNotes: [], lastFill: 0, lastFnH: 0, pages: 1 }, stamp: 'pageless' }).setMeta('addToHistory', false));
              }
              storage.onPages(1);
              return;
            }
            const layout = measure(view, input);
            if (!layout) return;
            const stamp = JSON.stringify([layout.breaks.map((x) => [x.pos, x.fill, x.fnH, x.notes, x.inset]), layout.lastFill, layout.lastFnH, layout.lastNotes, hfStamp(input.meta), input.title]);
            const cur = paginationKey.getState(view.state);
            if (cur && cur.stamp === stamp) {
              rounds = 0;
              return;
            }
            // Re-measure once more after the new gaps are drawn; stop if it doesn't settle.
            if (++rounds > 4) {
              rounds = 0;
              return;
            }
            view.dispatch(view.state.tr.setMeta(paginationKey, { layout, stamp }).setMeta('addToHistory', false));
            storage.onPages(layout.pages);
          };
          const schedule = () => {
            if (!raf) raf = requestAnimationFrame(run);
          };
          const onLoad = () => schedule();
          view.dom.addEventListener('load', onLoad, true);
          document.fonts?.ready.then(schedule);
          schedule();
          return {
            update(v, prev) {
              const st = paginationKey.getState(v.state);
              if (v.state.doc !== prev.doc || !st?.stamp) schedule();
              else if (st && paginationKey.getState(prev) !== st) schedule();
            },
            destroy() {
              if (raf) cancelAnimationFrame(raf);
              view.dom.removeEventListener('load', onLoad, true);
            }
          };
        }
      })
    ];
  }
});

/**
 * Pages as document ranges, for printing and PDF export. A page that starts or ends inside a paragraph (a paragraph
 * split across pages) has a `from` or `to` inside that paragraph.
 */
export function pageGroups(state: EditorState) {
  const st = paginationKey.getState(state);
  const size = state.doc.content.size;
  const cuts = [...new Set((st?.breaks || []).map((b) => b.pos).filter((p) => p > 0 && p < size))].sort((a, b) => a - b);
  const bounds = [0, ...cuts, size];
  const groups: { from: number; to: number; notes: { n: number; text: string }[] }[] = [];
  for (let k = 0; k < bounds.length - 1; k++) groups.push({ from: bounds[k], to: bounds[k + 1], notes: st?.breaks[k]?.notes || [] });
  if (st && groups.length) groups[groups.length - 1].notes = st.lastNotes;
  return groups;
}

export { hfHtml };
