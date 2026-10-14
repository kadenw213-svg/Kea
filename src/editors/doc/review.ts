import { Mark, Extension, mergeAttributes } from '@tiptap/core';
import type { Editor } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection, Transaction, EditorState } from '@tiptap/pm/state';
import { ReplaceStep } from '@tiptap/pm/transform';
import { Slice, Fragment, Node as PMNode, Mark as PMMark } from '@tiptap/pm/model';
import { uid } from '../../lib/util';

/**
 * Comments and suggestions (tracked changes).
 *
 * Comments are a mark (`comment`, with the thread id) over the text they're about; the conversation
 * itself lives in the document settings. Several comments can overlap.
 *
 * In Suggesting mode, typing is recorded instead of applied: new text gets an `insertion` mark and
 * deleted text is kept with a `deletion` mark (shown struck through) until someone accepts or rejects it.
 */

export const reviewKey = new PluginKey<{ suggesting: boolean }>('review');

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    review: {
      setSuggesting: (on: boolean) => ReturnType;
      addComment: (id: string) => ReturnType;
      removeComment: (id: string) => ReturnType;
    };
  }
}

export const CommentMark = Mark.create({
  name: 'comment',
  excludes: '',
  inclusive: false,
  spanning: true,
  addAttributes() {
    return { id: { default: null, parseHTML: (el) => el.getAttribute('data-comment'), renderHTML: (a) => ({ 'data-comment': a.id }) } };
  },
  parseHTML() {
    return [{ tag: 'span[data-comment]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { class: 'cmt' }), 0];
  }
});

const changeAttrs = () => ({
  id: { default: null, parseHTML: (el: HTMLElement) => el.getAttribute('data-change'), renderHTML: (a: any) => ({ 'data-change': a.id }) },
  author: { default: '', parseHTML: (el: HTMLElement) => el.getAttribute('data-author') || '', renderHTML: (a: any) => ({ 'data-author': a.author }) },
  at: { default: 0, parseHTML: (el: HTMLElement) => Number(el.getAttribute('data-at')) || 0, renderHTML: (a: any) => ({ 'data-at': a.at }) }
});

export const Insertion = Mark.create({
  name: 'insertion',
  inclusive: true,
  excludes: 'deletion',
  addAttributes: changeAttrs,
  parseHTML() {
    return [{ tag: 'ins[data-change]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['ins', mergeAttributes(HTMLAttributes, { class: 'sg-ins' }), 0];
  }
});

export const Deletion = Mark.create({
  name: 'deletion',
  inclusive: false,
  excludes: 'insertion',
  addAttributes: changeAttrs,
  parseHTML() {
    return [{ tag: 'del[data-change]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['del', mergeAttributes(HTMLAttributes, { class: 'sg-del' }), 0];
  }
});

/** Copy of a slice with `mark` added to its inline content, dropping text the author themselves suggested. */
function markSlice(slice: Slice, mark: PMMark, dropOwn: (n: PMNode) => boolean): Slice {
  const mapFrag = (frag: Fragment): Fragment => {
    const nodes: PMNode[] = [];
    frag.forEach((n) => {
      if (n.isInline) {
        if (dropOwn(n)) return;
        nodes.push(n.mark(mark.addToSet(n.marks.filter((m) => m.type.name !== 'insertion'))));
      } else nodes.push(n.copy(mapFrag(n.content)));
    });
    return Fragment.fromArray(nodes);
  };
  return new Slice(mapFrag(slice.content), slice.openStart, slice.openEnd);
}

/**
 * After an edit lands in Suggesting mode, turn it into a suggestion: mark what was typed as an
 * insertion and put back what was deleted, marked as a deletion. Runs synchronously as part of the
 * same edit, so fast typing and undo behave normally.
 */
/** Id of a suggestion by the same author right next to `pos`, so consecutive edits form one suggestion. */
function neighbourId(doc: PMNode, pos: number, author: string, kinds: string[]): string | null {
  const $p = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  for (const n of [$p.nodeBefore, $p.nodeAfter]) {
    const m = n?.marks.find((x) => kinds.includes(x.type.name) && x.attrs.author === author);
    if (m) return m.attrs.id;
  }
  return null;
}

function toSuggestion(tr0: Transaction, oldState: EditorState, newState: EditorState, author: string): Transaction | null {
  const schema = newState.schema;
  const at = Date.now();
  const fresh = uid();
  const out = newState.tr.setMeta('suggest', true);
  const sel = oldState.selection;
  let cursor: number | null = null;
  tr0.steps.forEach((step, i) => {
    const st = step as any;
    const before = tr0.docs[i];
    const after = tr0.mapping.slice(i + 1);
    const insSize = st.slice.size as number;
    const pos = out.mapping.map(after.map(st.from, -1), -1);
    // Join a neighbouring suggestion (typing on, or deleting a run of characters) instead of starting a new one.
    const groupId = neighbourId(oldState.doc, st.from, author, ['insertion', 'deletion']) || neighbourId(oldState.doc, st.to, author, ['deletion']) || fresh;
    if (insSize) {
      const end = out.mapping.map(after.map(st.from + insSize, 1), 1);
      if (end > pos) {
        out.removeMark(pos, end, schema.marks.deletion);
        out.addMark(pos, end, schema.marks.insertion.create({ id: groupId, author, at }));
      }
    }
    if (st.to > st.from) {
      const deleted = before.slice(st.from, st.to);
      const own = (n: PMNode) => n.marks.some((m) => m.type.name === 'insertion' && m.attrs.author === author);
      const kept = markSlice(deleted, schema.marks.deletion.create({ id: groupId, author, at }), own);
      let keptSize = 0;
      if (kept.content.size) {
        const beforeSize = out.doc.content.size;
        out.replace(pos, pos, kept);
        keptSize = out.doc.content.size - beforeSize;
      }
      const backspace = sel.empty && sel.from === st.to && !insSize;
      cursor = backspace ? pos : pos + keptSize + insSize;
    }
  });
  if (!out.docChanged) return null;
  if (cursor != null) out.setSelection(TextSelection.create(out.doc, Math.max(0, Math.min(cursor, out.doc.content.size))));
  return out;
}

export const Review = Extension.create<{}, { author: () => string; onChange: () => void }>({
  name: 'review',
  addStorage() {
    return { author: () => 'Me', onChange: () => {} };
  },
  addCommands() {
    return {
      setSuggesting:
        (on) =>
        ({ tr, dispatch }) => {
          if (dispatch) tr.setMeta(reviewKey, { suggesting: on });
          return true;
        },
      addComment:
        (id) =>
        ({ tr, state, dispatch }) => {
          const { from, to } = state.selection;
          if (from === to) return false;
          if (dispatch) tr.addMark(from, to, state.schema.marks.comment.create({ id }));
          return true;
        },
      removeComment:
        (id) =>
        ({ tr, state, dispatch }) => {
          let found = false;
          state.doc.descendants((node, pos) => {
            const m = node.marks.find((x) => x.type.name === 'comment' && x.attrs.id === id);
            if (m) {
              tr.removeMark(pos, pos + node.nodeSize, m);
              found = true;
            }
          });
          if (found && dispatch) dispatch(tr);
          return found;
        }
    };
  },
  addProseMirrorPlugins() {
    const storage = this.storage;
    return [
      new Plugin<{ suggesting: boolean }>({
        key: reviewKey,
        state: {
          init: () => ({ suggesting: false }),
          apply: (tr, v) => tr.getMeta(reviewKey) || v
        },
        appendTransaction(trs, oldState, newState) {
          if (!reviewKey.getState(newState)?.suggesting || trs.length !== 1) return null;
          const tr0 = trs[0];
          if (!tr0.docChanged || tr0.getMeta('suggest') || tr0.getMeta('history$') || tr0.getMeta('addToHistory') === false) return null;
          if (!tr0.steps.every((s) => s instanceof ReplaceStep)) return null;
          return toSuggestion(tr0, oldState, newState, storage.author());
        },
        view() {
          return {
            update(v, prev) {
              if (v.state.doc !== prev.doc) storage.onChange();
            }
          };
        }
      })
    ];
  }
});

// ---------- Queries & actions ----------
export interface Change {
  id: string;
  kind: 'insertion' | 'deletion';
  author: string;
  at: number;
  text: string;
  from: number;
  to: number;
}

/** Group suggestion marks into changes (consecutive text with the same id and kind). */
export function listChanges(state: EditorState): Change[] {
  const out: Change[] = [];
  state.doc.descendants((node, pos) => {
    if (!node.isInline) return true;
    for (const m of node.marks) {
      if (m.type.name !== 'insertion' && m.type.name !== 'deletion') continue;
      const last = out[out.length - 1];
      const text = node.isText ? node.text || '' : '◻';
      if (last && last.id === m.attrs.id && last.kind === m.type.name && last.to === pos) {
        last.to = pos + node.nodeSize;
        last.text += text;
      } else out.push({ id: m.attrs.id, kind: m.type.name as Change['kind'], author: m.attrs.author, at: m.attrs.at, text, from: pos, to: pos + node.nodeSize });
    }
    return false;
  });
  return out;
}

/** Accept or reject one change group (by id), or all of them. */
export function resolveChanges(editor: Editor, accept: boolean, id?: string) {
  const { state } = editor;
  const tr = state.tr.setMeta('suggest', true);
  const changes = listChanges(state).filter((c) => !id || c.id === id);
  // Work from the end so positions stay valid.
  for (const c of [...changes].sort((a, b) => b.from - a.from)) {
    const keepText = (c.kind === 'insertion') === accept;
    if (keepText) tr.removeMark(c.from, c.to, state.schema.marks[c.kind]);
    else tr.delete(c.from, c.to);
  }
  if (changes.length) editor.view.dispatch(tr);
  return changes.length;
}

/** Text each comment is attached to, keyed by comment id, plus the first position of each. */
export function commentAnchors(state: EditorState) {
  const map = new Map<string, { from: number; text: string }>();
  state.doc.descendants((node, pos) => {
    if (!node.isInline) return true;
    for (const m of node.marks) {
      if (m.type.name !== 'comment') continue;
      const cur = map.get(m.attrs.id);
      if (cur) cur.text += node.text || '';
      else map.set(m.attrs.id, { from: pos, text: node.text || '' });
    }
    return false;
  });
  return map;
}

export const newCommentId = () => 'c' + uid();
