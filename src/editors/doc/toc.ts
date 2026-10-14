import { Node, mergeAttributes } from '@tiptap/core';
import type { Editor } from '@tiptap/core';
import { paginationKey } from './pagination';

/**
 * Table of contents: lists the document's headings with the page each one is on. It's rebuilt
 * automatically after every page layout, so numbers stay right as you write.
 */

export interface TocEntry {
  level: number;
  text: string;
  page: number;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    toc: {
      insertToc: () => ReturnType;
    };
  }
}

export const TableOfContents = Node.create({
  name: 'toc',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      title: { default: 'Contents', parseHTML: (el) => el.getAttribute('data-title') || 'Contents', renderHTML: (a) => ({ 'data-title': a.title }) },
      entries: {
        default: [],
        parseHTML: (el) =>
          Array.from(el.querySelectorAll('.toc-entry')).map((e) => ({
            level: Number(e.getAttribute('data-level')) || 1,
            text: e.querySelector('.toc-text')?.textContent || '',
            page: Number(e.querySelector('.toc-page')?.textContent) || 1
          })),
        renderHTML: () => ({})
      }
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-toc]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const dom = document.createElement('div');
    for (const [k, v] of Object.entries(mergeAttributes(HTMLAttributes, { 'data-toc': '', class: 'toc' }))) dom.setAttribute(k, String(v));
    const h = document.createElement('p');
    h.className = 'toc-title';
    h.textContent = node.attrs.title;
    dom.appendChild(h);
    const entries: TocEntry[] = node.attrs.entries || [];
    for (const e of entries) {
      const row = document.createElement('p');
      row.className = 'toc-entry';
      row.setAttribute('data-level', String(e.level));
      row.style.paddingLeft = `${(e.level - 1) * 0.3}in`;
      const t = document.createElement('span');
      t.className = 'toc-text';
      t.textContent = e.text;
      const dots = document.createElement('span');
      dots.className = 'toc-dots';
      const pg = document.createElement('span');
      pg.className = 'toc-page';
      pg.textContent = String(e.page);
      row.append(t, dots, pg);
      dom.appendChild(row);
    }
    if (!entries.length) {
      const p = document.createElement('p');
      p.className = 'toc-empty';
      p.textContent = 'Headings you add (Heading 1–3) will be listed here.';
      dom.appendChild(p);
    }
    return dom;
  },
  addCommands() {
    return {
      insertToc:
        () =>
        ({ chain }) =>
          chain().insertContent({ type: 'toc' }).run()
    };
  }
});

/** Update every table of contents from the headings and the current page breaks. */
export function refreshToc(editor: Editor, pageStart = 1) {
  const doc = editor.state.doc;
  let hasToc = false;
  doc.forEach((n) => {
    if (n.type.name === 'toc') hasToc = true;
  });
  if (!hasToc) return;
  const breaks = (paginationKey.getState(editor.state)?.breaks || []).map((b) => b.pos);
  const entries: TocEntry[] = [];
  doc.forEach((node, offset) => {
    if (node.type.name === 'heading' && node.attrs.level <= 3 && node.textContent.trim()) {
      const page = breaks.filter((p) => p <= offset).length + pageStart;
      entries.push({ level: node.attrs.level, text: node.textContent.trim(), page });
    }
  });
  const tr = editor.state.tr;
  let changed = false;
  doc.forEach((node, offset) => {
    if (node.type.name === 'toc' && JSON.stringify(node.attrs.entries) !== JSON.stringify(entries)) {
      tr.setNodeMarkup(offset, undefined, { ...node.attrs, entries });
      changed = true;
    }
  });
  if (changed) editor.view.dispatch(tr.setMeta('addToHistory', false));
}
