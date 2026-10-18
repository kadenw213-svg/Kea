// Markdown files in the document editor: read into HTML with markdown-it, written back from the editor's JSON. What
// Markdown can hold (headings, bold, italic, strike, code, links, lists and checklists, quotes, code blocks, rules,
// images, tables) round-trips; what it can't (colors, fonts, alignment) is dropped on save, like any Markdown editor.
import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

export function markdownToHtml(text: string): string {
  // GitHub checklists ("- [ ] task") become the editor's task list.
  return md
    .render(text)
    .replace(/<ul>\s*(?=<li>\s*(?:<p>)?\[[ xX]\])/g, '<ul data-type="taskList">')
    .replace(/<li>(\s*(?:<p>)?)\[([ xX])\]\s*/g, (_m, p, x) => `<li data-type="taskItem" data-checked="${x.trim() ? 'true' : 'false'}">${p}`);
}

type Node = { type: string; attrs?: Record<string, any>; content?: Node[]; text?: string; marks?: { type: string; attrs?: Record<string, any> }[] };

const escape = (s: string) => s.replace(/([\\`*_[\]#<>]|^[-+]|^\d+\.)/gm, '\\$1');

function inline(nodes: Node[] = []): string {
  return nodes
    .map((n) => {
      if (n.type === 'hardBreak') return '  \n';
      if (n.type === 'image') return `![${n.attrs?.alt || ''}](${n.attrs?.src || ''})`;
      if (n.type !== 'text') return inline(n.content);
      const marks = n.marks || [];
      const has = (t: string) => marks.some((m) => m.type === t);
      if (has('code')) return `\`${n.text}\``;
      let t = escape(n.text || '');
      // Markers hug the words: spaces at the edges go outside them.
      const lead = t.match(/^\s*/)![0];
      const trail = t.match(/\s*$/)![0];
      t = t.trim();
      if (!t) return lead + trail;
      if (has('strike')) t = `~~${t}~~`;
      if (has('italic')) t = `*${t}*`;
      if (has('bold')) t = `**${t}**`;
      const link = marks.find((m) => m.type === 'link');
      if (link) t = `[${t}](${link.attrs?.href || ''})`;
      return lead + t + trail;
    })
    .join('');
}

function block(n: Node, indent = ''): string {
  const kids = n.content || [];
  switch (n.type) {
    case 'heading':
      return `${'#'.repeat(Math.min(6, n.attrs?.level || 1))} ${inline(kids)}`;
    case 'paragraph':
      return indent + inline(kids);
    case 'blockquote':
      return blocks(kids)
        .split('\n')
        .map((l) => (l ? `> ${l}` : '>'))
        .join('\n');
    case 'codeBlock':
      return `\`\`\`${n.attrs?.language || ''}\n${kids.map((k) => k.text || '').join('')}\n\`\`\``;
    case 'horizontalRule':
      return '---';
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return kids
        .map((li, i) => {
          const mark = n.type === 'orderedList' ? `${(n.attrs?.start || 1) + i}.` : '-';
          const box = n.type === 'taskList' ? (li.attrs?.checked ? '[x] ' : '[ ] ') : '';
          const pad = ' '.repeat(mark.length + 1);
          const inner = (li.content || []).map((c) => block(c)).join('\n');
          return inner
            .split('\n')
            .map((l, k) => (k === 0 ? `${mark} ${box}${l}` : l ? pad + l : l))
            .join('\n');
        })
        .join('\n');
    case 'table': {
      const rows = kids.map((r) => (r.content || []).map((c) => (c.content || []).map((p) => inline(p.content)).join(' ').replace(/\|/g, '\\|')));
      if (!rows.length) return '';
      const width = Math.max(...rows.map((r) => r.length));
      const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] || '').join(' | ')} |`;
      return [line(rows[0]), `| ${Array(width).fill('---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n');
    }
    case 'image':
      return inline([n]);
    default:
      return kids.length ? blocks(kids) : inline([n]);
  }
}

const blocks = (nodes: Node[]) => nodes.map((n) => block(n)).join('\n\n');

export function jsonToMarkdown(doc: Node): string {
  return blocks(doc.content || []).replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
