// Claude's tools for the structure of a document and for reviewing it: paragraph formatting (indents, spacing,
// alignment, styles), removing and joining paragraphs, tidying stray blank lines and spaces, undo, comments in a fixed
// shape (criterion, kind, what to change, optional rewrite) that can be listed, answered, resolved and removed, and the
// citation manager (sources, in-text citations, the Works Cited / References list). Also the annotated reading of the
// document Claude works from, so it sees blank lines, headings, indents, citations and the citation list as they are.
import type { Editor } from '@tiptap/react';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { AssistantTool } from '../../store';
import { uid } from '../../lib/util';
import { findQuote } from './aiHooks';
import { newCommentId, commentAnchors } from './review';
import { refreshCitations, reference, STYLE_LABEL } from './citations';
import { AI_AUTHOR } from './ReviewRail';
import { COMMENT_KINDS, type CommentKind, type CommentThread, type DocMeta, type Source } from './docMeta';

type Meta = { get(): DocMeta; set(m: DocMeta): void };


/** What an inline object reads as: a citation as its text, a footnote with its note. Shared with findQuote. */
export function leafText(n: PMNode): string {
  switch (n.type.name) {
    case 'citation':
      return n.attrs.text || '(citation)';
    case 'footnote':
      return `[footnote: ${n.attrs.text || ''}]`;
    case 'hardBreak':
      return '\n';
    case 'image':
      return '[picture]';
    case 'mathInline':
    case 'math':
      return n.attrs.latex ? `$${n.attrs.latex}$` : '[maths]';
    default:
      return n.isText ? n.text || '' : ' ';
  }
}

const strip = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
const inches = (v: number) => `${Math.round(v * 100) / 100} in`;

/** Formatting worth telling Claude about for one paragraph or heading. */
function paraTags(n: PMNode): string[] {
  const t: string[] = [];
  const a = n.attrs || {};
  if (n.type.name === 'heading') t.push(`Heading ${a.level}`);
  if (a.textAlign && a.textAlign !== 'left') t.push(a.textAlign === 'justify' ? 'justified' : a.textAlign === 'center' ? 'centered' : 'right-aligned');
  if (a.textIndent != null) t.push(a.textIndent < 0 ? `hanging indent ${inches(-a.textIndent)}` : a.textIndent > 0 ? `first-line indent ${inches(a.textIndent)}` : 'no first-line indent');
  if (a.indent) t.push(`indented ${inches(a.indent * 0.5)}`);
  if (a.lineHeight) t.push(`line spacing ${a.lineHeight}`);
  return t;
}

/**
 * The document as Claude reads it: one numbered line per paragraph (¶), with anything other than plain body text noted
 * in brackets, so blank lines, page breaks, headings, indents, lists, citations and the citation list are all visible.
 */
export function annotatedText(doc: PMNode, meta?: DocMeta): string {
  const lines: string[] = [];
  if (meta) {
    const d = meta.defaults;
    const m = meta.page.margins;
    lines.push(
      `[Page: ${meta.page.size}${meta.page.landscape ? ' landscape' : ''}, margins ${m.top === m.bottom && m.left === m.right && m.top === m.left ? `${m.top} in` : `${m.top}/${m.right}/${m.bottom}/${m.left} in`}. Body text: ${d.font} ${d.sizePt} pt, line spacing ${d.lineHeight}, ${d.firstLineIn ? `first-line indent ${inches(d.firstLineIn)}` : 'no first-line indent'}, ${d.spaceAfterPt} pt after each paragraph. Citation style ${STYLE_LABEL[meta.citationStyle]}, ${meta.sources.length} source${meta.sources.length === 1 ? '' : 's'}. ${meta.comments.filter((c) => !c.resolved).length} open comment${meta.comments.filter((c) => !c.resolved).length === 1 ? '' : 's'}.]`,
      '[Each ¶ line is one paragraph; text in [brackets] describes it and is not part of the text, so quote only what follows.]',
      ''
    );
  }
  const text = (n: PMNode) => n.textBetween(0, n.content.size, '\n', leafText);
  let k = 0;
  const list = (n: PMNode, depth: number) => {
    let i = n.attrs?.start || 1;
    n.forEach((item) => {
      item.forEach((child) => {
        if (child.type.name === 'bulletList' || child.type.name === 'orderedList' || child.type.name === 'taskList') list(child, depth + 1);
        else {
          const bullet = n.type.name === 'orderedList' ? `${i}.` : n.type.name === 'taskList' ? (item.attrs.checked ? '[x]' : '[ ]') : '•';
          lines.push(`¶${++k} ${'  '.repeat(depth)}${bullet} ${text(child)}`);
        }
      });
      i++;
    });
  };
  doc.forEach((n) => {
    const name = n.type.name;
    if (name === 'paragraph' || name === 'heading') {
      const t = text(n);
      const tags = paraTags(n);
      if (!t.trim()) tags.unshift('empty line');
      lines.push(`¶${++k} ${tags.length ? `[${tags.join(', ')}] ` : ''}${t}`);
    } else if (name === 'bulletList' || name === 'orderedList' || name === 'taskList') list(n, 0);
    else if (name === 'pageBreak') lines.push(`¶${++k} [page break]`);
    else if (name === 'bibliography') {
      const entries: string[] = n.attrs.entries || [];
      lines.push(`¶${++k} [${n.attrs.title} list: built from the document's sources, with hanging indents. Change it with add_source / edit_source / remove_source, never by typing.] ${n.attrs.title}`);
      for (const e of entries) lines.push(`    ${strip(e)}`);
      if (!entries.length) lines.push('    (empty: no sources yet)');
    } else if (name === 'toc') lines.push(`¶${++k} [table of contents]`);
    else if (name === 'table') {
      lines.push(`¶${++k} [table]`);
      n.forEach((row) => {
        const cells: string[] = [];
        row.forEach((cell) => cells.push(text(cell).replace(/\n/g, ' ')));
        lines.push(`    | ${cells.join(' | ')} |`);
      });
    } else if (name === 'image') lines.push(`¶${++k} [picture${n.attrs.alt ? `: ${n.attrs.alt}` : ''}]`);
    else if (name === 'horizontalRule') lines.push(`¶${++k} [horizontal line]`);
    else if (name === 'blockquote') n.forEach((c) => lines.push(`¶${++k} [block quote] ${text(c)}`));
    else if (name === 'codeBlock') lines.push(`¶${++k} [code] ${text(n)}`);
    else lines.push(`¶${++k} [${name}] ${text(n)}`);
  });
  return lines.join('\n');
}

export function docReviewTools(get: () => Editor | null, meta?: Meta): AssistantTool[] {
  const ed = () => {
    const e = get();
    if (!e) throw new Error('The document isn’t ready.');
    return e;
  };
  const find = (e: Editor, quote: string) => {
    const r = findQuote(e, quote);
    if (!r) throw new Error(`“${quote.slice(0, 60)}” wasn’t found. Copy it exactly from read_document (the text after any [brackets]).`);
    return r;
  };
  /** The paragraphs and headings from the one holding `from` to the one holding `to`. */
  const blocksBetween = (e: Editor, from: number, to: number) => {
    const out: { pos: number; node: PMNode }[] = [];
    e.state.doc.nodesBetween(from, Math.max(from, to), (node, pos) => {
      if (node.isTextblock) {
        out.push({ pos, node });
        return false;
      }
      return true;
    });
    return out;
  };

  const tools: AssistantTool[] = [
    {
      name: 'format_paragraphs',
      description:
        'Set paragraph formatting without changing the words: first-line or hanging indent (inches; a hanging indent is what a Works Cited entry has), left indent (inches), line spacing (1, 1.15, 1.5, 2), alignment, and style (normal, heading1–3). Applies to the paragraph holding `quote`, through the one holding `through_quote` if given, or to every body paragraph with all_body. Use 0 to remove an indent.',
      input_schema: {
        type: 'object',
        properties: {
          quote: { type: 'string', description: 'Text from the (first) paragraph' },
          through_quote: { type: 'string', description: 'Text from the last paragraph of a run of paragraphs' },
          all_body: { type: 'boolean', description: 'Every normal paragraph (not headings, lists or the citation list)' },
          first_line_indent: { type: 'number' },
          hanging_indent: { type: 'number' },
          left_indent: { type: 'number' },
          line_spacing: { type: 'number' },
          align: { type: 'string', enum: ['left', 'center', 'right', 'justify'] },
          style: { type: 'string', enum: ['normal', 'heading1', 'heading2', 'heading3'] }
        }
      },
      run: (p) => {
        const e = ed();
        let blocks: { pos: number; node: PMNode }[] = [];
        if (p.all_body) {
          e.state.doc.forEach((node, pos) => {
            if (node.type.name === 'paragraph' && node.textContent.trim()) blocks.push({ pos, node });
          });
        } else {
          if (!p.quote) throw new Error('Give `quote` (or all_body).');
          const a = find(e, p.quote);
          const b = p.through_quote ? find(e, p.through_quote) : a;
          blocks = blocksBetween(e, Math.min(a.from, b.from), Math.max(a.to, b.to));
        }
        if (!blocks.length) throw new Error('No paragraphs there.');
        const tr = e.state.tr;
        const { heading, paragraph } = e.schema.nodes;
        for (const { pos, node } of blocks) {
          const attrs: Record<string, any> = { ...node.attrs };
          if (p.hanging_indent !== undefined) attrs.textIndent = p.hanging_indent ? -Math.abs(p.hanging_indent) : null;
          if (p.first_line_indent !== undefined) attrs.textIndent = p.first_line_indent;
          if (p.left_indent !== undefined) attrs.indent = Math.max(0, Math.min(8, Math.round(p.left_indent / 0.5)));
          if (p.line_spacing !== undefined) attrs.lineHeight = p.line_spacing ? String(p.line_spacing) : null;
          if (p.align !== undefined) attrs.textAlign = p.align;
          let type = node.type;
          if (p.style === 'normal') type = paragraph;
          else if (p.style) {
            type = heading;
            attrs.level = Number(p.style.slice(-1));
          }
          if (type === paragraph) delete attrs.level;
          tr.setNodeMarkup(pos, type, Object.fromEntries(Object.entries(attrs).filter(([k]) => k in type.spec.attrs! || ['textAlign', 'lineHeight', 'textIndent', 'indent'].includes(k))));
        }
        e.view.dispatch(tr);
        return `Formatted ${blocks.length} paragraph${blocks.length === 1 ? '' : 's'}.`;
      }
    },
    {
      name: 'delete_text',
      description:
        'Delete a passage. With whole_paragraphs, delete the entire paragraph(s) holding it, line and all (use this to remove a paragraph or a blank line: quote text from a neighbour is not needed; for an empty line use clean_up_spacing). through_quote extends it to the paragraph holding that text.',
      input_schema: {
        type: 'object',
        properties: { quote: { type: 'string' }, through_quote: { type: 'string' }, whole_paragraphs: { type: 'boolean' } },
        required: ['quote']
      },
      run: ({ quote, through_quote, whole_paragraphs }) => {
        const e = ed();
        const a = find(e, quote);
        const b = through_quote ? find(e, through_quote) : a;
        let from = Math.min(a.from, b.from);
        let to = Math.max(a.to, b.to);
        const tr = e.state.tr;
        if (whole_paragraphs) {
          const blocks = blocksBetween(e, from, to);
          from = blocks[0].pos;
          to = blocks[blocks.length - 1].pos + blocks[blocks.length - 1].node.nodeSize;
          tr.delete(from, to);
        } else {
          // No doubled or stray space left where the passage was.
          const doc = e.state.doc;
          const before = doc.textBetween(Math.max(0, from - 1), from);
          const after = doc.textBetween(to, Math.min(doc.content.size, to + 1));
          if (before === ' ' && (after === ' ' || /[.,;:!?)]/.test(after))) from -= 1;
          tr.delete(from, to);
        }
        e.view.dispatch(tr);
        return 'Deleted.';
      }
    },
    {
      name: 'join_paragraphs',
      description: 'Join the paragraph holding `quote` with the paragraph after it (a paragraph broken in two by mistake). A blank line after it is removed instead.',
      input_schema: { type: 'object', properties: { quote: { type: 'string' } }, required: ['quote'] },
      run: ({ quote }) => {
        const e = ed();
        const r = find(e, quote);
        const $p = e.state.doc.resolve(r.from);
        const d = $p.depth;
        const end = $p.after(d);
        const next = e.state.doc.resolve(end).nodeAfter;
        if (!next || !next.isTextblock) throw new Error('There’s no paragraph right after that one to join.');
        const tr = e.state.tr;
        if (!next.textContent.trim() && !next.childCount) {
          tr.delete(end, end + next.nodeSize);
          e.view.dispatch(tr);
          return 'Removed the blank line after it.';
        }
        const tail = $p.parent.textContent;
        const needsSpace = tail && !/\s$/.test(tail) && !/^\s/.test(next.textContent);
        tr.join(end);
        if (needsSpace) tr.insertText(' ', end - 1);
        e.view.dispatch(tr);
        return 'Joined.';
      }
    },
    {
      name: 'clean_up_spacing',
      description:
        'Tidy the spacing of the whole document in one step: remove empty paragraphs (stray blank lines), double spaces between words, spaces at the start or end of paragraphs, and tab characters used as indents where the paragraph already has a first-line indent. Paragraph spacing should come from page_setup / format_paragraphs, not blank lines. keep_blank_lines keeps empty paragraphs.',
      input_schema: { type: 'object', properties: { keep_blank_lines: { type: 'boolean' } } },
      run: ({ keep_blank_lines }) => {
        const e = ed();
        const doc = e.state.doc;
        const firstLine = meta?.get().defaults.firstLineIn || 0;
        const dels: [number, number][] = [];
        let blank = 0;
        let spaces = 0;
        let tabs = 0;
        // Top-level empty paragraphs (never the only paragraph left).
        if (!keep_blank_lines) {
          doc.forEach((n, pos) => {
            if (n.type.name === 'paragraph' && !n.childCount && doc.childCount > 1) {
              dels.push([pos, pos + n.nodeSize]);
              blank++;
            }
          });
        }
        doc.descendants((n, pos) => {
          if (!n.isTextblock || n.type.name === 'codeBlock' || !n.childCount) return n.type.name !== 'codeBlock';
          const start = pos + 1;
          const indented = (n.attrs.textIndent ?? firstLine) > 0;
          n.forEach((child, off) => {
            if (!child.isText) return;
            const t = child.text!;
            const at = start + off;
            for (const m of t.matchAll(/ {2,}/g)) {
              dels.push([at + m.index! + 1, at + m.index! + m[0].length]);
              spaces++;
            }
            if (off === 0) {
              const lead = t.match(indented ? /^[ \t]+/ : /^ +/);
              if (lead) {
                dels.push([at, at + lead[0].length]);
                if (lead[0].includes('\t')) tabs++;
                else spaces++;
              }
            }
            if (off + child.nodeSize === n.content.size) {
              const trail = t.match(/ +$/);
              if (trail && trail.index! > 0) {
                dels.push([at + trail.index!, at + t.length]);
                spaces++;
              }
            }
          });
          return false;
        });
        if (!dels.length) return 'The spacing is already clean.';
        // Overlaps can't happen between paragraphs and text inside them that's kept; delete from the end.
        const tr = e.state.tr;
        const sorted = dels.sort((x, y) => y[0] - x[0]);
        let lastFrom = Infinity;
        for (const [f, t] of sorted) {
          if (t > lastFrom) continue;
          tr.delete(f, t);
          lastFrom = f;
        }
        e.view.dispatch(tr);
        return `Removed ${[blank && `${blank} blank line${blank === 1 ? '' : 's'}`, spaces && `${spaces} stray space${spaces === 1 ? '' : 's'}`, tabs && `${tabs} tab indent${tabs === 1 ? '' : 's'}`].filter(Boolean).join(', ')}.`;
      }
    },
    {
      name: 'undo',
      description: 'Undo the last change(s) to the document text, like Ctrl+Z (each of your edit tools is one step; comments and page setup are not undone this way: use delete_comment or page_setup).',
      input_schema: { type: 'object', properties: { steps: { type: 'integer', description: 'How many steps (default 1)' } } },
      run: ({ steps = 1 }) => {
        const e = ed();
        let n = 0;
        for (let i = 0; i < Math.max(1, Math.min(50, steps)); i++) if (e.commands.undo()) n++;
        if (!n) throw new Error('There’s nothing to undo.');
        return `Undid ${n} step${n === 1 ? '' : 's'}.`;
      }
    }
  ];

  if (!meta) return tools;
  const threads = () => meta.get().comments;
  const setThreads = (fn: (l: CommentThread[]) => CommentThread[]) => meta.set({ ...meta.get(), comments: fn(meta.get().comments) });

  /** One comment in the fixed shape: marks the passage and adds the card. Returns its id. */
  const comment = (c: { quote: string; comment: string; criterion?: string; kind?: string; rewrite?: string }) => {
    const e = ed();
    const text = String(c.comment || '').trim();
    if (!text) throw new Error('The comment is empty.');
    const r = find(e, c.quote);
    const id = newCommentId();
    e.view.dispatch(e.state.tr.addMark(r.from, r.to, e.schema.marks.comment.create({ id })).setMeta('addToHistory', false));
    const kind = c.kind && c.kind in COMMENT_KINDS ? (c.kind as CommentKind) : undefined;
    const t: CommentThread = { id, author: AI_AUTHOR, text, at: Date.now(), replies: [], ...(c.criterion ? { tag: String(c.criterion).trim().replace(/^\[|\]$/g, '') } : {}), ...(kind ? { kind } : {}), ...(c.rewrite ? { rewrite: String(c.rewrite) } : {}) };
    setThreads((l) => [...l, t]);
    return id;
  };
  const commentShape = {
    quote: { type: 'string', description: 'The exact passage the comment is about (a phrase or sentence, copied from read_document): it gets highlighted' },
    comment: { type: 'string', description: 'What to change and why, then how: 1–3 plain sentences, no labels or brackets (those come from criterion and kind)' },
    criterion: { type: 'string', description: 'The rubric criterion or guideline it is about, named as the rubric names it (e.g. "Thesis", "Evidence", "MLA format")' },
    kind: { type: 'string', enum: Object.keys(COMMENT_KINDS), description: 'fix: must change; consider: would improve it; strength: works, keep it; question: unclear to a reader' },
    rewrite: { type: 'string', description: 'Optional: replacement wording for exactly the quoted passage, which the student can apply with one click' }
  };
  const findThread = (id: string) => {
    const t = threads().find((x) => x.id === id);
    if (!t) throw new Error(`No comment ${id}. list_comments shows the ids.`);
    return t;
  };

  tools.push(
    {
      name: 'add_comment',
      description: 'Leave one margin comment on a passage, in Kea’s review format (criterion, kind, comment, optional rewrite). For more than one, use add_comments.',
      input_schema: { type: 'object', properties: commentShape, required: ['quote', 'comment'] },
      run: (c) => `Commented (${comment(c as any)}).`
    },
    {
      name: 'add_comments',
      description:
        'Leave several margin comments at once, one per passage: the way to review against a rubric or guidelines. Every passage you flag gets its own comment, anchored to exactly that passage. Each failed one is listed so you can redo just those.',
      input_schema: { type: 'object', properties: { comments: { type: 'array', items: { type: 'object', properties: commentShape, required: ['quote', 'comment'] } } }, required: ['comments'] },
      run: ({ comments }) => {
        if (!Array.isArray(comments) || !comments.length) throw new Error('Give a list of comments.');
        const lines: string[] = [];
        let failed = 0;
        comments.forEach((c: any, i: number) => {
          try {
            lines.push(`${i + 1}. ${comment(c)}`);
          } catch (err: any) {
            failed++;
            lines.push(`${i + 1}. FAILED: ${String(err?.message || err)}`);
          }
        });
        const report = `${comments.length - failed} of ${comments.length} comments added.\n${lines.join('\n')}`;
        if (failed === comments.length) throw new Error(report);
        return report;
      }
    },
    {
      name: 'list_comments',
      description: 'List the document’s comments with their ids, who wrote them, the passage, the comment, replies, and whether they are resolved.',
      input_schema: { type: 'object', properties: { include_resolved: { type: 'boolean' } } },
      run: ({ include_resolved }) => {
        const anchors = commentAnchors(ed().state);
        const list = threads().filter((t) => include_resolved || !t.resolved);
        if (!list.length) return 'No comments.';
        return list
          .map((t) => {
            const head = [t.kind ? COMMENT_KINDS[t.kind as CommentKind] : '', t.tag || ''].filter(Boolean).join(' · ');
            const q = anchors.get(t.id)?.text || '(its passage was deleted)';
            return `${t.id} — ${t.author}${t.resolved ? ' (resolved)' : ''}${head ? ` [${head}]` : ''} on “${q.length > 80 ? `${q.slice(0, 80)}…` : q}”: ${t.text}${t.rewrite ? ` (rewrite: “${t.rewrite}”)` : ''}${t.replies.map((r) => `\n    ↳ ${r.author}: ${r.text}`).join('')}`;
          })
          .join('\n');
      }
    },
    {
      name: 'reply_to_comment',
      description: 'Reply in a comment’s thread (answer the student’s comment or question, or follow up on your own).',
      input_schema: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'] },
      run: ({ id, text }) => {
        findThread(id);
        setThreads((l) => l.map((t) => (t.id === id ? { ...t, replies: [...t.replies, { id: uid(), author: AI_AUTHOR, text: String(text).trim(), at: Date.now() }] } : t)));
        return 'Replied.';
      }
    },
    {
      name: 'resolve_comment',
      description: 'Mark a comment resolved (done), or re-open it with resolved: false.',
      input_schema: { type: 'object', properties: { id: { type: 'string' }, resolved: { type: 'boolean' } }, required: ['id'] },
      run: ({ id, resolved = true }) => {
        findThread(id);
        setThreads((l) => l.map((t) => (t.id === id ? { ...t, resolved } : t)));
        return resolved ? 'Resolved.' : 'Re-opened.';
      }
    },
    {
      name: 'delete_comment',
      description: 'Delete a comment and its highlight (the text stays). Give its id, or all_from_claude to remove every comment you left.',
      input_schema: { type: 'object', properties: { id: { type: 'string' }, all_from_claude: { type: 'boolean' } } },
      run: ({ id, all_from_claude }) => {
        const e = ed();
        const ids = all_from_claude ? threads().filter((t) => t.author === AI_AUTHOR).map((t) => t.id) : id ? [findThread(id).id] : [];
        if (!ids.length) throw new Error(all_from_claude ? 'You haven’t left any comments.' : 'Give the comment’s id.');
        for (const x of ids) e.commands.removeComment(x);
        setThreads((l) => l.filter((t) => !ids.includes(t.id)));
        return `Deleted ${ids.length} comment${ids.length === 1 ? '' : 's'}.`;
      }
    }
  );

  // ---------- Citations ----------
  const sources = () => meta.get().sources;
  const plainRef = (s: Source) => strip(reference(s, meta.get().citationStyle));
  const sourceFields = {
    type: { type: 'string', enum: ['book', 'website', 'journal', 'article', 'video', 'chapter', 'report', 'other'] },
    authors: { type: 'array', items: { type: 'object', properties: { first: { type: 'string' }, last: { type: 'string' } } }, description: 'People, in order: [{first, last}]' },
    org: { type: 'string', description: 'An organisation as the author, when there are no people' },
    title: { type: 'string' },
    container: { type: 'string', description: 'Journal, website, newspaper, or the book a chapter is in' },
    publisher: { type: 'string' },
    year: { type: 'string' },
    month: { type: 'string' },
    day: { type: 'string' },
    volume: { type: 'string' },
    issue: { type: 'string' },
    pages: { type: 'string', description: 'e.g. "45-67"' },
    url: { type: 'string' },
    doi: { type: 'string' },
    accessed: { type: 'string', description: 'YYYY-MM-DD, for web pages' },
    edition: { type: 'string' }
  };
  const toSource = (p: any, base?: Source): Source => {
    const s: any = { ...(base || { id: uid(), type: 'website', authors: [], title: '' }) };
    for (const k of Object.keys(sourceFields)) if (p[k] !== undefined) s[k] = k === 'authors' ? (p.authors || []).map((a: any) => ({ first: String(a.first || '').trim(), last: String(a.last || '').trim() })) : String(p[k]).trim();
    return s as Source;
  };
  const citeAt = (e: Editor, quote: string) => {
    // After the passage, before its closing punctuation: …the end (Smith 45).
    const r = find(e, quote);
    const doc = e.state.doc;
    let at = r.to;
    while (at > r.from && /[.!?]/.test(doc.textBetween(at - 1, at))) at--;
    return at;
  };

  tools.push(
    {
      name: 'list_sources',
      description: 'The document’s sources (its citation manager) with their ids and how each appears in the Works Cited / References list, and the citation style.',
      input_schema: { type: 'object', properties: {} },
      run: () => {
        const used = new Set<string>();
        ed().state.doc.descendants((n) => {
          if (n.type.name === 'citation') for (const id of n.attrs.ids || []) used.add(id);
        });
        const list = sources();
        return `Style: ${STYLE_LABEL[meta.get().citationStyle]}.\n${list.length ? list.map((s) => `${s.id}${used.has(s.id) ? '' : ' (not cited yet)'}: ${plainRef(s)}`).join('\n') : 'No sources yet.'}`;
      }
    },
    {
      name: 'add_source',
      description:
        'Add a source to the document’s citation manager. Kea formats it in the document’s style (MLA, APA, Chicago) and lists it in the Works Cited / References list automatically, with hanging indents. Only add real sources you know exist: verify with web search when you can; never invent details (leave a field out rather than guess). Returns its id for cite.',
      input_schema: { type: 'object', properties: sourceFields, required: ['title'] },
      run: (p) => {
        const dup = sources().find((s) => s.title.trim().toLowerCase() === String(p.title).trim().toLowerCase());
        if (dup) return `Already there as ${dup.id}: ${plainRef(dup)}`;
        const s = toSource(p);
        meta.set({ ...meta.get(), sources: [...sources(), s] });
        return `Added ${s.id}: ${plainRef(s)}`;
      }
    },
    {
      name: 'edit_source',
      description: 'Correct a source’s details (only the fields you give change). Its citations and list entry update everywhere.',
      input_schema: { type: 'object', properties: { id: { type: 'string' }, ...sourceFields }, required: ['id'] },
      run: (p) => {
        const s = sources().find((x) => x.id === p.id);
        if (!s) throw new Error(`No source ${p.id}. list_sources shows the ids.`);
        const next = toSource(p, s);
        meta.set({ ...meta.get(), sources: sources().map((x) => (x.id === s.id ? next : x)) });
        return `Updated: ${plainRef(next)}`;
      }
    },
    {
      name: 'remove_source',
      description: 'Remove a source from the citation manager and delete its in-text citations.',
      input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      run: ({ id }) => {
        if (!sources().some((s) => s.id === id)) throw new Error(`No source ${id}.`);
        const e = ed();
        const tr = e.state.tr;
        const hits: { pos: number; node: PMNode }[] = [];
        e.state.doc.descendants((n, pos) => {
          if (n.type.name === 'citation' && (n.attrs.ids || []).includes(id)) hits.push({ pos, node: n });
        });
        for (const { pos, node } of hits.reverse()) {
          const rest = (node.attrs.ids as string[]).filter((x) => x !== id);
          if (rest.length) tr.setNodeMarkup(pos, undefined, { ...node.attrs, ids: rest });
          else {
            const spaceBefore = e.state.doc.textBetween(Math.max(0, pos - 1), pos) === ' ';
            tr.delete(spaceBefore ? pos - 1 : pos, pos + 1);
          }
        }
        if (hits.length) e.view.dispatch(tr);
        meta.set({ ...meta.get(), sources: sources().filter((s) => s.id !== id) });
        return `Removed it${hits.length ? ` and ${hits.length} citation${hits.length === 1 ? '' : 's'}` : ''}.`;
      }
    },
    {
      name: 'cite',
      description:
        'Put an in-text citation, formatted by Kea in the document’s style, e.g. (Smith 45) or (Smith, 2020, p. 45), at the end of the passage `quote` (before its closing full stop). source_ids from add_source / list_sources; page is optional. Use this instead of typing citations by hand.',
      input_schema: {
        type: 'object',
        properties: { quote: { type: 'string' }, source_ids: { type: 'array', items: { type: 'string' } }, page: { type: 'string' } },
        required: ['quote', 'source_ids']
      },
      run: ({ quote, source_ids, page = '' }) => {
        const known = new Set(sources().map((s) => s.id));
        const ids = (source_ids as string[]).filter((x) => known.has(x));
        if (!ids.length) throw new Error('None of those sources are in the document. add_source first, or list_sources for the ids.');
        const e = ed();
        const at = citeAt(e, quote);
        const before = e.state.doc.textBetween(Math.max(0, at - 1), at);
        const content: any[] = [{ type: 'citation', attrs: { ids, page: String(page) } }];
        if (before && before !== ' ') content.unshift({ type: 'text', text: ' ' });
        if (!e.chain().insertContentAt(at, content).run()) throw new Error('The citation couldn’t go there.');
        refreshCitations(e, meta.get());
        let shown = '';
        e.state.doc.nodesBetween(at, Math.min(e.state.doc.content.size, at + 3), (n) => {
          if (n.type.name === 'citation') shown = n.attrs.text;
        });
        return `Cited ${shown}.`;
      }
    },
    {
      name: 'set_citation_style',
      description: 'Switch the document’s citation style; every citation and the list are re-formatted.',
      input_schema: { type: 'object', properties: { style: { type: 'string', enum: ['mla', 'apa', 'chicago'] } }, required: ['style'] },
      run: ({ style }) => {
        meta.set({ ...meta.get(), citationStyle: style });
        return `Citation style: ${STYLE_LABEL[style as DocMeta['citationStyle']]}.`;
      }
    },
    {
      name: 'insert_bibliography',
      description: 'Make sure the document ends with its Works Cited / References list (built from the sources, on a new page). If it already has one, it is only refreshed. Delete any hand-typed list with delete_text.',
      input_schema: { type: 'object', properties: {} },
      run: () => {
        const e = ed();
        let has = false;
        e.state.doc.descendants((n) => {
          if (n.type.name === 'bibliography') has = true;
          return !has;
        });
        if (!has) {
          const end = e.state.doc.content.size;
          e.chain().insertContentAt(end, [{ type: 'pageBreak' }, { type: 'bibliography' }]).run();
        }
        refreshCitations(e, meta.get());
        return has ? 'The list was already there; it’s up to date.' : 'Added the list on a new page at the end.';
      }
    }
  );
  return tools;
}
