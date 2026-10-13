import { Extension, Node, mergeAttributes } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    fontSize: {
      setFontSize: (size: string) => ReturnType;
      unsetFontSize: () => ReturnType;
    };
    lineHeight: {
      setLineHeight: (lh: string | null) => ReturnType;
    };
    indent: {
      indent: () => ReturnType;
      outdent: () => ReturnType;
    };
    pageBreak: {
      setPageBreak: () => ReturnType;
    };
    search: {
      setSearch: (query: string, caseSensitive?: boolean) => ReturnType;
      setSearchIndex: (i: number) => ReturnType;
    };
  }
}

/** font-size as a textStyle attribute (pt). */
export const FontSize = Extension.create({
  name: 'fontSize',
  addGlobalAttributes() {
    return [
      {
        types: ['textStyle'],
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (el) => normalizeSize(el.style.fontSize),
            renderHTML: (attrs) => (attrs.fontSize ? { style: `font-size: ${attrs.fontSize}` } : {})
          }
        }
      }
    ];
  },
  addCommands() {
    return {
      setFontSize:
        (size) =>
        ({ chain }) =>
          chain().setMark('textStyle', { fontSize: size }).run(),
      unsetFontSize:
        () =>
        ({ chain }) =>
          chain().setMark('textStyle', { fontSize: null }).removeEmptyTextStyle().run()
    };
  }
});

function normalizeSize(v: string): string | null {
  if (!v) return null;
  const n = parseFloat(v);
  if (isNaN(n)) return null;
  if (v.endsWith('px')) return `${Math.round(n * 0.75 * 2) / 2}pt`;
  if (v.endsWith('pt')) return `${n}pt`;
  return null;
}

const BLOCKS = ['paragraph', 'heading'];

/** Paragraph-level line height and indentation. */
export const ParagraphFormat = Extension.create({
  name: 'paragraphFormat',
  addGlobalAttributes() {
    return [
      {
        types: BLOCKS,
        attributes: {
          lineHeight: {
            default: null,
            parseHTML: (el) => {
              const lh = el.style.lineHeight;
              return lh && /^[\d.]+$/.test(lh) ? lh : null;
            },
            renderHTML: (a) => (a.lineHeight ? { style: `line-height: ${a.lineHeight}` } : {})
          },
          indent: {
            default: 0,
            parseHTML: (el) => {
              const ml = parseFloat(el.style.marginLeft || el.getAttribute('data-indent') || '0');
              if (!ml) return 0;
              // Stored as 0.5in steps.
              return el.getAttribute('data-indent') ? Number(el.getAttribute('data-indent')) : Math.min(8, Math.round(ml / 48));
            },
            renderHTML: (a) => (a.indent ? { 'data-indent': a.indent, style: `margin-left: ${a.indent * 48}px` } : {})
          }
        }
      }
    ];
  },
  addCommands() {
    const change =
      (delta: number) =>
      ({ tr, state, dispatch }: any) => {
        const { from, to } = state.selection;
        let changed = false;
        state.doc.nodesBetween(from, to, (node: PMNode, pos: number) => {
          if (BLOCKS.includes(node.type.name)) {
            const next = Math.max(0, Math.min(8, (node.attrs.indent || 0) + delta));
            if (next !== node.attrs.indent) {
              tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: next });
              changed = true;
            }
            return false;
          }
          return true;
        });
        if (changed && dispatch) dispatch(tr);
        return changed;
      };
    return {
      setLineHeight:
        (lh) =>
        ({ commands }) =>
          BLOCKS.map((t) => commands.updateAttributes(t, { lineHeight: lh })).some(Boolean),
      indent: () => change(1),
      outdent: () => change(-1)
    };
  },
  addKeyboardShortcuts() {
    return {
      Tab: ({ editor }) => {
        if (editor.isActive('listItem') || editor.isActive('taskItem')) {
          return editor.commands.sinkListItem(editor.isActive('taskItem') ? 'taskItem' : 'listItem');
        }
        if (editor.isActive('table')) return false;
        const { $from, empty } = editor.state.selection;
        // Tab at the start of a paragraph indents it; elsewhere it inserts a tab character.
        if (empty && $from.parentOffset === 0) return editor.commands.indent();
        return editor.commands.insertContent('\t');
      },
      'Shift-Tab': ({ editor }) => {
        if (editor.isActive('listItem') || editor.isActive('taskItem')) {
          return editor.commands.liftListItem(editor.isActive('taskItem') ? 'taskItem' : 'listItem');
        }
        if (editor.isActive('table')) return false;
        return editor.commands.outdent();
      },
      // Backspace at the very start of an indented paragraph removes the indent first.
      Backspace: ({ editor }) => {
        const { $from, empty } = editor.state.selection;
        if (!empty || $from.parentOffset !== 0) return false;
        const node = $from.parent;
        if (BLOCKS.includes(node.type.name) && node.attrs.indent > 0) return editor.commands.outdent();
        return false;
      }
    };
  }
});

export const PageBreak = Node.create({
  name: 'pageBreak',
  group: 'block',
  atom: true,
  selectable: true,
  parseHTML() {
    return [{ tag: 'div[data-type="page-break"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'page-break', class: 'page-break' })];
  },
  addCommands() {
    return {
      setPageBreak:
        () =>
        ({ chain }) =>
          chain().insertContent({ type: this.name }).insertContent({ type: 'paragraph' }).run()
    };
  },
  addKeyboardShortcuts() {
    return { 'Mod-Enter': () => this.editor.commands.setPageBreak() };
  }
});

/** Image with an adjustable width (percentage of the text column). */
export const ResizableImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (el) => el.getAttribute('width') || el.style.width || null,
        renderHTML: (a) => (a.width ? { style: `width: ${a.width}` } : {})
      },
      align: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-align'),
        renderHTML: (a) => (a.align ? { 'data-align': a.align } : {})
      }
    };
  }
}).configure({ inline: false, allowBase64: true });

// ---------- Find & replace ----------
export interface SearchState {
  query: string;
  caseSensitive: boolean;
  matches: { from: number; to: number }[];
  index: number;
  decos: DecorationSet;
}
export const searchKey = new PluginKey<SearchState>('search');

function findMatches(doc: PMNode, query: string, cs: boolean) {
  const out: { from: number; to: number }[] = [];
  if (!query) return out;
  const q = cs ? query : query.toLowerCase();
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    // Concatenate the block's text with a position map so matches can cross marks.
    let text = '';
    const map: number[] = [];
    node.forEach((child, offset) => {
      if (child.isText) {
        for (let i = 0; i < child.text!.length; i++) {
          map.push(pos + 1 + offset + i);
        }
        text += child.text;
      } else {
        map.push(-1);
        text += '￼';
      }
    });
    const hay = cs ? text : text.toLowerCase();
    let i = 0;
    while ((i = hay.indexOf(q, i)) >= 0) {
      const from = map[i];
      const to = map[i + q.length - 1] + 1;
      if (from >= 0 && to > 0) out.push({ from, to });
      i += q.length;
    }
    return false;
  });
  return out;
}

function build(doc: PMNode, query: string, cs: boolean, index: number): SearchState {
  const matches = findMatches(doc, query, cs);
  const idx = matches.length ? Math.min(index, matches.length - 1) : 0;
  const decos = DecorationSet.create(
    doc,
    matches.map((m, i) => Decoration.inline(m.from, m.to, { class: i === idx ? 'search-match current' : 'search-match' }))
  );
  return { query, caseSensitive: cs, matches, index: idx, decos };
}

export const Search = Extension.create({
  name: 'search',
  addCommands() {
    return {
      setSearch:
        (query, cs = false) =>
        ({ tr, dispatch }) => {
          if (dispatch) dispatch(tr.setMeta(searchKey, { query, cs, index: 0 }));
          return true;
        },
      setSearchIndex:
        (i) =>
        ({ tr, dispatch }) => {
          if (dispatch) dispatch(tr.setMeta(searchKey, { index: i }));
          return true;
        }
    };
  },
  addProseMirrorPlugins() {
    return [
      new Plugin<SearchState>({
        key: searchKey,
        state: {
          init: (_, state) => build(state.doc, '', false, 0),
          apply(tr, prev, _old, state) {
            const meta = tr.getMeta(searchKey);
            if (meta) return build(state.doc, meta.query ?? prev.query, meta.cs ?? prev.caseSensitive, meta.index ?? prev.index);
            if (tr.docChanged && prev.query) return build(state.doc, prev.query, prev.caseSensitive, prev.index);
            return prev;
          }
        },
        props: {
          decorations(state) {
            return searchKey.getState(state)?.decos;
          }
        }
      })
    ];
  }
});

/** Clean up HTML pasted from Word/Google Docs/web pages so spacing stays sane. */
export function cleanPastedHtml(html: string): string {
  let h = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<o:p>[\s\S]*?<\/o:p>/gi, '')
    .replace(/<\/?(meta|link|xml|style|script)[^>]*>/gi, '')
    .replace(/\sclass="?Mso[a-zA-Z]+"?/g, '')
    .replace(/<b style="font-weight:\s*normal;?"[^>]*>([\s\S]*?)<\/b>/gi, '$1'); // Google Docs wrapper
  // Collapse runs of empty paragraphs to a single one.
  h = h.replace(/(<p[^>]*>(\s|&nbsp;|<br\s*\/?>)*<\/p>\s*){2,}/gi, '<p></p>');
  return h;
}
