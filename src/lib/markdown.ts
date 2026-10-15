/** Small Markdown helpers (used when inserting looked-up text into a document). */

/** Minimal Markdown → HTML (escaped first). */
export function markdownToHtml(md: string): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const inline = (s: string) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/__([^_]+)__/g, '<strong>$1</strong>');
  const lines = md.replace(/\r/g, '').split('\n');
  let html = '';
  let list: 'ul' | 'ol' | null = null;
  let inCode = false;
  const close = () => {
    if (list) html += `</${list}>`;
    list = null;
  };
  const isRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
  const isRule = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const cells = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    // Tables: a header row, a |---|---| rule, then body rows.
    if (!inCode && isRow(raw) && li + 1 < lines.length && isRule(lines[li + 1])) {
      close();
      const head = cells(raw);
      html += `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>`;
      li += 2;
      while (li < lines.length && isRow(lines[li])) {
        const row = cells(lines[li]);
        html += `<tr>${head.map((_, i) => `<td>${inline(row[i] || '')}</td>`).join('')}</tr>`;
        li++;
      }
      html += '</tbody></table>';
      li--;
      continue;
    }
    // "Heading" followed by ===== or ----- (setext headings).
    if (!inCode && raw.trim() && li + 1 < lines.length && /^\s*(=+|-{3,})\s*$/.test(lines[li + 1]) && !/^\s*[-*•|#]/.test(raw)) {
      close();
      const level = lines[li + 1].trim()[0] === '=' ? 3 : 4;
      html += `<h${level}>${inline(raw.trim())}</h${level}>`;
      li++;
      continue;
    }
    if (!inCode && /^\s*(-{3,}|\*{3,}|_{3,}|={3,})\s*$/.test(raw)) {
      close();
      html += '<hr>';
      continue;
    }
    if (raw.trim().startsWith('```')) {
      close();
      html += inCode ? '</code></pre>' : '<pre><code>';
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      html += esc(raw) + '\n';
      continue;
    }
    const line = raw.trimEnd();
    let m;
    if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) {
      if (list !== 'ul') {
        close();
        html += '<ul>';
        list = 'ul';
      }
      html += `<li>${inline(m[1])}</li>`;
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      if (list !== 'ol') {
        close();
        html += '<ol>';
        list = 'ol';
      }
      html += `<li>${inline(m[1])}</li>`;
    } else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      close();
      const h = Math.min(6, m[1].length + 2);
      html += `<h${h}>${inline(m[2].replace(/\s*#+\s*$/, ''))}</h${h}>`;
    } else if (!line.trim()) {
      close();
    } else {
      close();
      html += `<p>${inline(line)}</p>`;
    }
  }
  close();
  if (inCode) html += '</code></pre>';
  return html;
}

/** Plain text for inserting into editors that don't take rich text. */
export function markdownToPlain(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, ''))
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}
