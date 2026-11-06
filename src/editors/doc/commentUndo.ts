// Undo for comments. A comment's card (its thread) lives in the document's settings, outside the text, so the text
// editor's own undo never brought back a deleted comment or re-opened a resolved one. Comment changes are kept here
// instead, each stamped with where the text's undo history stood; Undo (Ctrl+Z, the toolbar arrow) takes whichever
// came last, a comment change or a text edit, so both undo in the order they happened.
import { Extension, type Editor } from '@tiptap/core';
import { undoDepth, redoDepth } from '@tiptap/pm/history';
import type { CommentThread } from './docMeta';

type Range = { id: string; from: number; to: number };
interface Entry {
  ids: string[];
  before: CommentThread[];
  after: CommentThread[];
  marksBefore: Range[];
  marksAfter: Range[];
  /** The text history's depth when it happened (and, once undone, both depths then: redo only from exactly there). */
  depth: number;
  redoAt?: [number, number];
}
interface Slot {
  undo: Entry[];
  redo: Entry[];
  get(): CommentThread[];
  set(list: CommentThread[]): void;
}

const slots = new WeakMap<Editor, Slot>();

/** The document editor tells this where its comments are kept. */
export function bindComments(editor: Editor, get: () => CommentThread[], set: (list: CommentThread[]) => void) {
  const s = slots.get(editor);
  if (s) Object.assign(s, { get, set });
  else slots.set(editor, { undo: [], redo: [], get, set });
}

const marksOf = (editor: Editor, ids: Set<string>): Range[] => {
  const out: Range[] = [];
  editor.state.doc.descendants((node, pos) => {
    for (const m of node.marks) if (m.type.name === 'comment' && ids.has(m.attrs.id)) out.push({ id: m.attrs.id, from: pos, to: pos + node.nodeSize });
  });
  return out;
};

/** The comment highlights for these ids, set exactly to `ranges` (not an undo step of the text). */
function putMarks(editor: Editor, ids: string[], ranges: Range[]) {
  const type = editor.schema.marks.comment;
  if (!type) return;
  const tr = editor.state.tr;
  const want = new Set(ids);
  editor.state.doc.descendants((node, pos) => {
    for (const m of node.marks) if (m.type === type && want.has(m.attrs.id)) tr.removeMark(pos, pos + node.nodeSize, m);
  });
  const size = tr.doc.content.size;
  for (const r of ranges) if (r.from < r.to && r.to <= size) tr.addMark(r.from, r.to, type.create({ id: r.id }));
  editor.view.dispatch(tr.setMeta('addToHistory', false));
}

/** The current list with these threads as they were in `from` (put back where they were, changed back, or removed). */
function patch(current: CommentThread[], ids: string[], from: CommentThread[]) {
  let out = [...current];
  for (const id of ids) {
    const was = from.find((t) => t.id === id);
    const at = out.findIndex((t) => t.id === id);
    if (!was) {
      if (at >= 0) out.splice(at, 1);
    } else if (at >= 0) out[at] = was;
    else out.splice(Math.min(from.indexOf(was), out.length), 0, was);
  }
  return out;
}

/**
 * Make a change to these comments (delete, resolve, re-open) as one undo step. Their highlights change outside the
 * text's own history: the comment and its highlight undo together.
 */
export function commentChange(editor: Editor, ids: string[], fn: () => void) {
  const s = slots.get(editor);
  if (!s || !ids.length) return fn();
  const set = new Set(ids);
  const before = s.get();
  const marksBefore = marksOf(editor, set);
  fn();
  const after = s.get();
  const marksAfter = marksOf(editor, set);
  if (JSON.stringify([before, marksBefore]) === JSON.stringify([after, marksAfter])) return;
  s.undo.push({ ids, before, after, marksBefore, marksAfter, depth: undoDepth(editor.state) });
  if (s.undo.length > 200) s.undo.shift();
  s.redo = [];
  // (So the toolbar's Undo arrow wakes up even when only a card changed.)
  editor.view.dispatch(editor.state.tr.setMeta('addToHistory', false));
}

/** Remove a comment's highlight without making it a step of the text's undo (commentChange undoes it). */
export const removeCommentMark = (editor: Editor, id: string) =>
  editor
    .chain()
    .command(({ tr }) => (tr.setMeta('addToHistory', false), true))
    .removeComment(id)
    .run();

const nextUndo = (editor: Editor) => {
  const top = slots.get(editor)?.undo.at(-1);
  return top && top.depth === undoDepth(editor.state) ? top : null;
};
const nextRedo = (editor: Editor) => {
  const top = slots.get(editor)?.redo.at(-1);
  return top && top.redoAt && top.redoAt[0] === undoDepth(editor.state) && top.redoAt[1] === redoDepth(editor.state) ? top : null;
};

/** Undo the last change, a comment's or the text's. */
export function undo(editor: Editor): boolean {
  const s = slots.get(editor);
  const e = nextUndo(editor);
  if (!s || !e) return editor.commands.undo();
  s.undo.pop();
  putMarks(editor, e.ids, e.marksBefore);
  s.set(patch(s.get(), e.ids, e.before));
  s.redo.push({ ...e, redoAt: [undoDepth(editor.state), redoDepth(editor.state)] });
  return true;
}

/** Redo what was last undone, a comment's change or the text's. */
export function redo(editor: Editor): boolean {
  const s = slots.get(editor);
  const e = nextRedo(editor);
  if (!s || !e) return editor.commands.redo();
  s.redo.pop();
  putMarks(editor, e.ids, e.marksAfter);
  s.set(patch(s.get(), e.ids, e.after));
  s.undo.push({ ...e, depth: undoDepth(editor.state), redoAt: undefined });
  return true;
}

/** Ctrl+Z, Ctrl+Y and Ctrl+Shift+Z go through the shared undo above (before the text history's own keys). */
export const CommentUndo = Extension.create({
  name: 'commentUndo',
  priority: 1000,
  addKeyboardShortcuts() {
    return { 'Mod-z': () => undo(this.editor), 'Mod-y': () => redo(this.editor), 'Shift-Mod-z': () => redo(this.editor) };
  }
});

export const canUndo = (editor: Editor) => !!nextUndo(editor) || editor.can().undo();
export const canRedo = (editor: Editor) => !!nextRedo(editor) || editor.can().redo();
