import { Extension, Node, mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey, EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet, EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { DocMeta, pageBox, hfFor, expandFields, HeaderFooter } from './docMeta';

/**
 * Print-layout view. The document stays one continuous editor, but after every change Slate measures
 * the top-level blocks and inserts "page gap" widgets where pages end. Each gap draws the bottom margin
 * (footnotes + footer) of one page, the grey space between pages, and the top margin (header) of the
 * next. The same page breaks drive printing and PDF export, so what you see is what prints.
 *
 * Blocks are never split across pages (a paragraph taller than the space left moves to the next page),
 * which keeps editing simple and predictable.
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
  const pageEnd = (pageIndex: number, fill: number, fnH: number, notes: PageBreak['notes'], withNext: boolean) => {
    const wrap = document.createElement('div');
    wrap.className = 'pg-break';
    wrap.contentEditable = 'false';
    wrap.style.margin = `0 -${b.mr}px 0 -${b.ml}px`;
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
    const key = `pb${i}:${br.fill}:${br.fnH}:${total}:${JSON.stringify(br.notes)}:${hfStamp(meta)}`;
    decos.push(Decoration.widget(br.pos, () => pageEnd(i, br.fill, br.fnH, br.notes, true), { side: -1, key, ignoreSelection: true, stopEvent: () => true }));
  });
  const endKey = `pend:${s.lastFill}:${s.lastFnH}:${total}:${JSON.stringify(s.lastNotes)}:${hfStamp(meta)}`;
  decos.push(Decoration.widget(state.doc.content.size, () => pageEnd(s.breaks.length, s.lastFill, s.lastFnH, s.lastNotes, false), { side: 1, key: endKey, ignoreSelection: true, stopEvent: () => true }));
  return DecorationSet.create(state.doc, decos);
}

const hfStamp = (m: DocMeta) => JSON.stringify([m.header, m.footer, m.firstHeader, m.firstFooter, m.pageNumberStart, m.page, m.defaults.font]);

/** Height of a widget in the editor flow (so natural block positions can be recovered). */
const widgetHeight = (br: { fill: number; fnH: number }, b: ReturnType<typeof pageBox>, withNext: boolean) => Math.max(0, br.fill) + br.fnH + b.mb + (withNext ? GAP + b.mt : 0);

function measure(view: EditorView, input: LayoutInput): Omit<PagState, 'decos' | 'stamp'> | null {
  const { meta } = input;
  const b = pageBox(meta);
  const doc = view.state.doc;
  const notes = footnotesOf(doc);
  const cur = paginationKey.getState(view.state);
  const known = new Map<number, number>();
  cur?.breaks.forEach((br) => known.set(br.pos, widgetHeight(br, b, true)));

  const breaks: PageBreak[] = [];
  let pageStart = 0; // natural y where the current page's content starts
  let shift = 0;
  let pageNotes: { n: number; text: string }[] = [];
  let forceBreak = false;
  let lastBottom = 0;
  let ok = true;

  doc.forEach((node, offset) => {
    if (!ok) return;
    const dom = view.nodeDOM(offset) as HTMLElement | null;
    if (!dom || !(dom instanceof HTMLElement)) return;
    shift += known.get(offset) || 0;
    const top = dom.offsetTop - shift;
    const bottom = top + dom.offsetHeight;
    if (!Number.isFinite(top)) {
      ok = false;
      return;
    }
    const mine = notes.filter((n) => n.pos >= offset && n.pos < offset + node.nodeSize).map(({ n, text }) => ({ n, text }));
    const fits = () => bottom - pageStart + notesHeight([...pageNotes, ...mine], meta, b.contentW) <= b.contentH + 0.5;
    const first = top - pageStart < 1;
    if (forceBreak || (!first && !fits())) {
      const fnH = notesHeight(pageNotes, meta, b.contentW);
      breaks.push({ pos: offset, fill: Math.round(Math.max(0, b.contentH - fnH - (lastBottom - pageStart))), fnH, notes: pageNotes });
      pageStart = top;
      pageNotes = [];
      forceBreak = false;
    }
    pageNotes.push(...mine);
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
            const stamp = JSON.stringify([layout.breaks.map((x) => [x.pos, x.fill, x.fnH, x.notes]), layout.lastFill, layout.lastFnH, layout.lastNotes, hfStamp(input.meta), input.title]);
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

/** Pages as groups of top-level node indexes, for printing and PDF export. */
export function pageGroups(state: EditorState) {
  const st = paginationKey.getState(state);
  const starts = new Set((st?.breaks || []).map((b) => b.pos));
  const groups: { nodes: number[]; notes: { n: number; text: string }[] }[] = [{ nodes: [], notes: [] }];
  let i = 0;
  state.doc.forEach((_node, offset) => {
    if (starts.has(offset) && groups[groups.length - 1].nodes.length) groups.push({ nodes: [], notes: [] });
    groups[groups.length - 1].nodes.push(i++);
  });
  (st?.breaks || []).forEach((b, k) => groups[k] && (groups[k].notes = b.notes));
  if (st) groups[groups.length - 1].notes = st.lastNotes;
  return groups;
}

export { hfHtml };
