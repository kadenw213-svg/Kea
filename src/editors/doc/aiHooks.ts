import type { Editor } from '@tiptap/react';
import { closeHistory } from '@tiptap/pm/history';
import type { AiHooks, DocSection } from '../../store';
import { markdownToHtml } from '../../lib/markdown';
import { reviewKey, newCommentId } from './review';
import type { CommentThread, DocMeta } from './docMeta';
import { docTools } from './aiTools';
import { AI_AUTHOR } from './ReviewRail';
import { annotatedText, docReviewTools, leafText } from './aiReview';
import { asClaude, claudeAnchor, setClaudeAnchor, showRange } from './claudeEditsExt';
import type { AssistantTool } from '../../store';

const norm = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase();

/** Locate a quote in the document (tolerant of whitespace/quote-style differences and truncation). */
export function findQuote(editor: Editor, quote: string): { from: number; to: number } | null {
  const target = norm(quote).replace(/^["'“”]+|["'“”…]+$/g, '');
  if (!target) return null;
  const attempts = [target, target.slice(0, 80), target.slice(0, 40)].filter((t, i, a) => t.length >= 6 && a.indexOf(t) === i);
  for (const needle of attempts) {
    let hit: { from: number; to: number } | null = null;
    editor.state.doc.descendants((node, pos) => {
      if (hit) return false;
      if (!node.isTextblock) return true;
      // Map normalized characters back to document positions.
      let text = '';
      const map: number[] = [];
      node.forEach((child, offset) => {
        // (Citations and footnotes read as their text, as read_document shows them.)
        const raw = child.isText ? child.text! : leafText(child);
        for (let i = 0; i < raw.length; i++) {
          const ch = raw[i];
          const n = /\s/.test(ch) ? ' ' : ch.replace(/[‘’]/, "'").replace(/[“”]/, '"').toLowerCase();
          if (n === ' ' && text.endsWith(' ')) continue;
          text += n;
          map.push(pos + 1 + offset + i);
        }
      });
      const idx = text.indexOf(needle);
      if (idx >= 0) {
        const endIdx = needle === target ? idx + needle.length - 1 : idx + needle.length - 1;
        hit = { from: map[idx], to: map[Math.min(endIdx, map.length - 1)] + 1 };
        return false;
      }
      return false;
    });
    if (hit) return hit;
  }
  return null;
}

/**
 * Claude's tools run as Claude's edits (claudeEdits.ts): the person's cursor, selection, scroll and focus stay put. An
 * async tool's later part (after it loads a picture) wraps itself again when it settles.
 */
export function inBackground(get: () => Editor | null, tools: AssistantTool[]): AssistantTool[] {
  return tools.map((t) => ({ ...t, run: (input: any) => asClaude(get(), () => t.run(input)) }));
}

/** Claude's "here": where the person was when they asked (mapped through every edit since), else their selection now. */
function hereOf(ed: Editor): { from: number; to: number } {
  const a = claudeAnchor(ed);
  const size = ed.state.doc.content.size;
  if (a && a.from <= size && a.to <= size) return a;
  const { from, to } = ed.state.selection;
  return { from, to };
}

export function docAiHooks(get: () => Editor | null, addThread?: (t: CommentThread) => void, meta?: { get(): DocMeta; set(m: DocMeta): void }): AiHooks {
  return {
    noun: 'document',
    tools: inBackground(get, [...docTools(get, meta, hereOf), ...docReviewTools(get, meta)]),
    beginRun() {
      setClaudeAnchor(get(), true);
    },
    endRun() {
      setClaudeAnchor(get(), false);
    },
    insertLabel: 'Insert below',
    beginStep() {
      // Edits made moments apart would otherwise merge into one Ctrl+Z step.
      const ed = get();
      if (ed && !ed.isDestroyed) ed.view.dispatch(closeHistory(ed.state.tr).setMeta('addToHistory', false));
    },
    async getDocument() {
      const ed = get();
      if (!ed) return { full: '', sections: [] };
      const sections: DocSection[] = [];
      ed.state.doc.forEach((node, _off, i) => {
        const text = node.textBetween(0, node.content.size, '\n', ' ').trim();
        if (text) sections.push({ id: `b${i}`, label: node.type.name === 'heading' ? text.slice(0, 60) : `Paragraph ${i + 1}`, text });
      });
      return { full: sections.map((s) => s.text).join('\n\n'), sections, annotated: annotatedText(ed.state.doc, meta?.get()) };
    },
    replaceSelection(text) {
      const ed = get();
      if (!ed) return false;
      // The passage the person had selected when they asked, wherever it has moved to since.
      const { from, to } = hereOf(ed);
      if (from === to) return false;
      return asClaude(ed, () => ed.chain().insertContentAt({ from, to }, text.includes('\n') ? markdownToHtml(text) : text).run());
    },
    insertText(md) {
      const ed = get();
      if (!ed) return false;
      const $to = ed.state.doc.resolve(hereOf(ed).to);
      const pos = $to.depth >= 1 ? $to.after(1) : ed.state.doc.content.size;
      return asClaude(ed, () => ed.chain().insertContentAt(pos, markdownToHtml(md)).run());
    },
    reveal(quote) {
      const ed = get();
      if (!ed) return false;
      const r = findQuote(ed, quote);
      if (!r) return false;
      // A brief highlight; the cursor and focus stay with the person.
      showRange(ed, r);
      return true;
    },
    ...(addThread
      ? {
          addComment(quote: string, text: string) {
            const ed = get();
            if (!ed) return false;
            const r = findQuote(ed, quote);
            if (!r) return false;
            const id = newCommentId();
            // Mark the sentence without moving the user's cursor, then add the thread to the comment rail.
            ed.view.dispatch(ed.state.tr.addMark(r.from, r.to, ed.schema.marks.comment.create({ id })).setMeta('addToHistory', false));
            addThread({ id, author: AI_AUTHOR, text, at: Date.now(), replies: [] });
            return true;
          }
        }
      : {}),
    track(fn) {
      const ed = get();
      if (!ed) return fn();
      // Turn on Suggesting just for these edits, credited to Claude, then put things back.
      const store = (ed.storage as any).review as { author: () => string };
      const prevAuthor = store.author;
      const was = !!reviewKey.getState(ed.state)?.suggesting;
      store.author = () => AI_AUTHOR;
      ed.commands.setSuggesting(true);
      try {
        return fn();
      } finally {
        ed.commands.setSuggesting(was);
        store.author = prevAuthor;
      }
    },
    replaceQuote(quote, replacement) {
      const ed = get();
      if (!ed) return false;
      const r = findQuote(ed, quote);
      if (!r) return false;
      // If the rewrite ends with punctuation that already follows the match, replace that too.
      const last = replacement.trim().slice(-1);
      if (/[.!?;:,]/.test(last) && ed.state.doc.textBetween(r.to, Math.min(r.to + 1, ed.state.doc.content.size)) === last) r.to += 1;
      return asClaude(ed, () => ed.chain().insertContentAt(r, replacement.trim()).run());
    }
  };
}
