// Claude's edits to a document happen in the background, the way a collaborator's do: the person keeps their cursor,
// selection, scroll position and focus, and can keep typing while Claude works.
//
// - Every transaction made while Claude's tool code runs (`active()`) is Claude's. After it, the person's selection is
//   put back where it was, mapped through Claude's steps (a cursor right where Claude inserts stays before the new
//   text, so what they type next lands where they were typing).
// - Claude's change is closed off in the undo history on both sides: one Ctrl+Z undoes one Claude change, and typing
//   right after it never merges into it.
// - What Claude changed gets a brief highlight (a decoration, never saved), mapped through later edits.
// - The anchor: where the person was when they asked (their selection at that moment), mapped through every change
//   since, so "insert here" and "rewrite this" act there even if they've moved on.
//
// Pure ProseMirror (no Tiptap, no app imports), so tests drive it with a plain schema.
import { Plugin, PluginKey, TextSelection, Selection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { closeHistory } from '@tiptap/pm/history';
import { AddMarkStep, RemoveMarkStep, type Mapping, type Step } from '@tiptap/pm/transform';

export interface ClaudeEditsState {
  deco: DecorationSet;
  /** Where the person was when they asked Claude (mapped through every change since), or null. */
  anchor: { from: number; to: number } | null;
  /** When the person last typed or moved the cursor themselves (ms). */
  lastUser: number;
}

export interface ClaudeEditsOptions {
  /** True while Claude's tool code is running (its transactions are Claude's). */
  active(): boolean;
  /** How long a change stays highlighted, in ms (0: not highlighted). */
  flashMs?(): number;
  now?(): number;
  /** Called with the changed range after each of Claude's changes (to scroll to it when wanted). */
  onChange?(range: { from: number; to: number }): void;
}

export const claudeEditsKey = new PluginKey<ClaudeEditsState>('claudeEdits');
const FLASH = 'claude-flash';

/** The person's selection after Claude's steps: mapped, with a cursor at an insertion point staying before it. */
export function keepSelection(sel: Selection, doc: EditorState['doc'], mapping: Mapping): Selection {
  if (sel instanceof TextSelection) {
    if (sel.empty) {
      const p = mapping.map(sel.head, -1);
      return TextSelection.create(doc, p);
    }
    // A range doesn't grow to take in text inserted at its edges.
    const fwd = sel.anchor <= sel.head;
    const from = mapping.map(sel.from, 1);
    const to = Math.max(from, mapping.map(sel.to, -1));
    try {
      return fwd ? TextSelection.create(doc, from, to) : TextSelection.create(doc, to, from);
    } catch {
      return TextSelection.create(doc, from);
    }
  }
  try {
    return sel.map(doc, mapping);
  } catch {
    return Selection.near(doc.resolve(Math.min(mapping.map(sel.head), doc.content.size)));
  }
}

/** The ranges (in the final document) a list of transactions changed: text replaced or inserted, marks changed. */
export function changedRanges(trs: readonly Transaction[]): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  trs.forEach((tr, ti) => {
    tr.steps.forEach((step: Step, si) => {
      const after: Mapping = tr.mapping.slice(si + 1);
      const later = (pos: number, assoc: number) => {
        let p = after.map(pos, assoc);
        for (let j = ti + 1; j < trs.length; j++) p = trs[j].mapping.map(p, assoc);
        return p;
      };
      if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) {
        out.push({ from: later((step as any).from, 1), to: later((step as any).to, -1) });
        return;
      }
      step.getMap().forEach((_oldStart, _oldEnd, newStart, newEnd) => {
        out.push({ from: later(newStart, -1), to: later(newEnd, 1) });
      });
    });
  });
  const size = trs.length ? trs[trs.length - 1].doc.content.size : 0;
  const clean = out
    .map((r) => ({ from: Math.max(0, Math.min(r.from, size)), to: Math.max(0, Math.min(r.to, size)) }))
    .filter((r) => r.to > r.from)
    .sort((a, b) => a.from - b.from);
  const merged: { from: number; to: number }[] = [];
  for (const r of clean) {
    const last = merged[merged.length - 1];
    if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
    else merged.push({ ...r });
  }
  return merged;
}

let flashSeq = 0;

export function claudeEditsPlugin(opts: ClaudeEditsOptions): Plugin<ClaudeEditsState> {
  const now = opts.now || (() => Date.now());
  const flashMs = opts.flashMs || (() => 2400);
  return new Plugin<ClaudeEditsState>({
    key: claudeEditsKey,
    state: {
      init: () => ({ deco: DecorationSet.empty, anchor: null, lastUser: 0 }),
      apply(tr, prev) {
        let deco = prev.deco.map(tr.mapping, tr.doc);
        let anchor = prev.anchor ? { from: tr.mapping.map(prev.anchor.from, 1), to: tr.mapping.map(prev.anchor.to, -1) } : null;
        if (anchor && anchor.to < anchor.from) anchor = { from: anchor.from, to: anchor.from };
        const meta = tr.getMeta(claudeEditsKey) as { flash?: { from: number; to: number }[]; id?: string; clear?: string; anchor?: { from: number; to: number } | null } | undefined;
        if (meta?.flash?.length) {
          const id = meta.id || `f${++flashSeq}`;
          deco = deco.add(tr.doc, meta.flash.map((r) => Decoration.inline(r.from, r.to, { class: FLASH }, { flash: id })));
        }
        if (meta?.clear) deco = deco.remove(deco.find(undefined, undefined, (spec) => spec.flash === meta.clear));
        if (meta && 'anchor' in meta) anchor = meta.anchor ? { ...meta.anchor } : null;
        const own = opts.active() || !!tr.getMeta('appendedTransaction') || tr.getMeta('addToHistory') === false;
        const lastUser = !own && (tr.docChanged || tr.selectionSet) ? now() : prev.lastUser;
        return { deco, anchor, lastUser };
      }
    },
    props: {
      decorations: (state) => claudeEditsKey.getState(state)?.deco
    },
    appendTransaction(trs, oldState, newState) {
      if (!opts.active()) return null;
      const changed = trs.some((t) => t.docChanged);
      if (!changed && !trs.some((t) => t.selectionSet)) return null;
      // The person's selection, as if Claude had never touched it.
      let mapping = trs[0].mapping;
      if (trs.length > 1) {
        mapping = trs[0].mapping.slice(0);
        for (let i = 1; i < trs.length; i++) mapping.appendMapping(trs[i].mapping);
      }
      const keep = keepSelection(oldState.selection, newState.doc, mapping);
      const tr = newState.tr;
      if (!keep.eq(newState.selection)) tr.setSelection(keep);
      if (changed) {
        const ranges = changedRanges(trs);
        if (ranges.length && flashMs() > 0) tr.setMeta(claudeEditsKey, { flash: ranges, id: `f${++flashSeq}` });
        if (ranges.length) opts.onChange?.({ from: ranges[0].from, to: ranges[ranges.length - 1].to });
        // What the person types next starts its own undo step.
        closeHistory(tr);
      }
      tr.setMeta('addToHistory', false);
      return tr;
    },
    view() {
      const timers = new Set<ReturnType<typeof setTimeout>>();
      return {
        update(view, prevState) {
          const cur = claudeEditsKey.getState(view.state);
          const before = claudeEditsKey.getState(prevState);
          if (!cur || cur.deco === before?.deco) return;
          // New highlights fade away on their own.
          const ids = new Set(cur.deco.find().map((d) => d.spec.flash as string));
          const old = new Set(before?.deco.find().map((d) => d.spec.flash as string) || []);
          for (const id of ids) {
            if (old.has(id)) continue;
            const t = setTimeout(() => {
              timers.delete(t);
              if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(claudeEditsKey, { clear: id }).setMeta('addToHistory', false));
            }, flashMs());
            timers.add(t);
          }
        },
        destroy() {
          for (const t of timers) clearTimeout(t);
        }
      };
    }
  });
}

/** Set (or clear, with null) where the person is now: Claude's "here" for this request. */
export const setAnchorTr = (state: EditorState, range: { from: number; to: number } | null) => state.tr.setMeta(claudeEditsKey, { anchor: range }).setMeta('addToHistory', false);

/** Highlight a range briefly (show_in_document), without moving anything. */
export const flashTr = (state: EditorState, range: { from: number; to: number }) => state.tr.setMeta(claudeEditsKey, { flash: [range], id: `f${++flashSeq}` }).setMeta('addToHistory', false);

/** The anchor, if one is set. */
export const anchorOf = (state: EditorState) => claudeEditsKey.getState(state)?.anchor ?? null;

/** True when the person typed or moved the cursor in the last `ms` milliseconds. */
export const userBusy = (state: EditorState, ms = 4000, now = Date.now()) => now - (claudeEditsKey.getState(state)?.lastUser || 0) < ms;
