// The Tiptap side of claudeEdits.ts: the extension, and `asClaude` to run Claude's tool code as Claude's edits.
import { Extension, type Editor } from '@tiptap/core';
import { setting } from '../../lib/settings';
import { claudeEditsPlugin, setAnchorTr, flashTr, anchorOf, userBusy } from './claudeEdits';

interface Store {
  depth: number;
}

const store = (editor: Editor) => (editor.storage as any).claudeEdits as Store;

export const ClaudeEdits = Extension.create<{}, Store>({
  name: 'claudeEdits',
  addStorage: () => ({ depth: 0 }),
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      claudeEditsPlugin({
        active: () => store(editor).depth > 0,
        flashMs: () => (setting('assistant.flashEdits') === false ? 0 : Math.max(0, Number(setting('assistant.flashSeconds')) || 2.4) * 1000),
        onChange: (range) => {
          // Off by default: Claude's changes don't move the page. On: follow them while the person isn't busy.
          if (!setting('assistant.followEdits')) return;
          requestAnimationFrame(() => {
            if (editor.isDestroyed || userBusy(editor.state)) return;
            scrollToRange(editor, range.from);
          });
        }
      })
    ];
  }
});

/** Run `fn` as Claude's edit: whatever it dispatches leaves the person's selection, focus and scroll alone. */
export function asClaude<T>(editor: Editor | null | undefined, fn: () => T): T {
  if (!editor || editor.isDestroyed || !store(editor)) return fn();
  const s = store(editor);
  s.depth++;
  try {
    const out = fn();
    // An async tool: only its synchronous part counts here; its later dispatches wrap themselves.
    return out;
  } finally {
    s.depth--;
  }
}

/** Remember where the person is right now: Claude's "here" for the request they just sent. */
export function setClaudeAnchor(editor: Editor | null | undefined, on: boolean) {
  if (!editor || editor.isDestroyed) return;
  const { from, to } = editor.state.selection;
  editor.view.dispatch(setAnchorTr(editor.state, on ? { from, to } : null));
}

export const claudeAnchor = (editor: Editor) => anchorOf(editor.state);

/** Show a passage: a brief highlight, and the page scrolls to it unless the person is typing or reading elsewhere. */
export function showRange(editor: Editor, range: { from: number; to: number }) {
  editor.view.dispatch(flashTr(editor.state, range));
  if (!userBusy(editor.state)) scrollToRange(editor, range.from);
}

function scrollToRange(editor: Editor, pos: number) {
  try {
    const at = editor.view.domAtPos(Math.min(pos, editor.state.doc.content.size));
    const el = (at.node.nodeType === 1 ? (at.node as HTMLElement) : at.node.parentElement) as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } catch {}
}
