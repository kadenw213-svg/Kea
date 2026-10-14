import type { Editor } from '@tiptap/react';
import type { AiHooks, DocSection } from '../../store';
import { markdownToHtml } from '../../lib/ai';
import { reviewKey } from './review';

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
        const raw = child.isText ? child.text! : ' ';
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

export function docAiHooks(get: () => Editor | null): AiHooks {
  return {
    noun: 'document',
    insertLabel: 'Insert below',
    async getDocument() {
      const ed = get();
      if (!ed) return { full: '', sections: [] };
      const sections: DocSection[] = [];
      ed.state.doc.forEach((node, _off, i) => {
        const text = node.textBetween(0, node.content.size, '\n', ' ').trim();
        if (text) sections.push({ id: `b${i}`, label: node.type.name === 'heading' ? text.slice(0, 60) : `Paragraph ${i + 1}`, text });
      });
      return { full: sections.map((s) => s.text).join('\n\n'), sections };
    },
    replaceSelection(text) {
      const ed = get();
      if (!ed) return false;
      const { from, to } = ed.state.selection;
      if (from === to) return false;
      if (!text.includes('\n')) return ed.chain().focus().insertContentAt({ from, to }, text).run();
      return ed.chain().focus().insertContentAt({ from, to }, markdownToHtml(text)).run();
    },
    insertText(md) {
      const ed = get();
      if (!ed) return false;
      const $to = ed.state.selection.$to;
      const pos = $to.depth >= 1 ? $to.after(1) : ed.state.doc.content.size;
      return ed.chain().focus().insertContentAt(pos, markdownToHtml(md)).run();
    },
    reveal(quote) {
      const ed = get();
      if (!ed) return false;
      const r = findQuote(ed, quote);
      if (!r) return false;
      ed.chain().focus().setTextSelection(r).scrollIntoView().run();
      return true;
    },
    track(fn) {
      const ed = get();
      if (!ed) return fn();
      // Turn on Suggesting just for these edits, credited to "Slate AI", then put things back.
      const store = (ed.storage as any).review as { author: () => string };
      const prevAuthor = store.author;
      const was = !!reviewKey.getState(ed.state)?.suggesting;
      store.author = () => 'Slate AI';
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
      return ed.chain().focus().insertContentAt(r, replacement.trim()).run();
    }
  };
}
