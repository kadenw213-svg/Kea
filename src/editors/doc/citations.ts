import { Node, mergeAttributes } from '@tiptap/core';
import type { Editor } from '@tiptap/core';
import type { Source, DocMeta } from './docMeta';

/**
 * Citations and bibliographies in MLA 9, APA 7 and Chicago (author-date). Sources live in the
 * document's settings; citation and bibliography nodes keep a rendered copy of their text in their
 * attributes so printing, PDF and Word export work without knowing about sources at all. Whenever the
 * sources or the style change, `refreshCitations` re-renders every citation in one step.
 */

export type Style = DocMeta['citationStyle'];
export const STYLE_LABEL: Record<Style, string> = { mla: 'MLA 9', apa: 'APA 7', chicago: 'Chicago (author-date)' };
export const BIB_TITLE: Record<Style, string> = { mla: 'Works Cited', apa: 'References', chicago: 'References' };

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MLA_MONTHS = ['Jan.', 'Feb.', 'Mar.', 'Apr.', 'May', 'June', 'July', 'Aug.', 'Sept.', 'Oct.', 'Nov.', 'Dec.'];
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const it = (s?: string) => (s ? `<i>${esc(s)}</i>` : '');
const clean = (s?: string) => (s || '').trim();
const endPunct = (s: string) => (/[.?!]$/.test(s) ? s : s + '.');
const monthIdx = (m?: string) => {
  if (!m) return -1;
  const n = Number(m);
  if (n >= 1 && n <= 12) return n - 1;
  return MONTHS.findIndex((x) => x.toLowerCase().startsWith(m.toLowerCase().slice(0, 3)));
};
const initials = (first: string) =>
  first
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + '.')
    .join(' ');
const accessedMla = (d?: string) => {
  if (!d) return '';
  const [y, m, day] = d.split('-').map(Number);
  return y && m ? `${day ? day + ' ' : ''}${MLA_MONTHS[m - 1]} ${y}` : '';
};
const doiUrl = (s: Source) => (s.doi ? (s.doi.startsWith('http') ? s.doi : `https://doi.org/${s.doi.replace(/^doi:\s*/i, '')}`) : clean(s.url));

function people(s: Source) {
  return s.authors.filter((a) => clean(a.last) || clean(a.first));
}

// ---------- In-text ----------
function authorShort(s: Source, style: Style): string {
  const ps = people(s);
  const and = style === 'apa' ? '&' : 'and';
  if (!ps.length) return s.org ? s.org : style === 'mla' ? `“${shortTitle(s.title)}”` : `“${shortTitle(s.title)}”`;
  if (ps.length === 1) return ps[0].last || ps[0].first;
  if (ps.length === 2) return `${ps[0].last} ${and} ${ps[1].last}`;
  return `${ps[0].last} et al.`;
}
const shortTitle = (t: string) => t.split(/[:.?!]/)[0].split(/\s+/).slice(0, 4).join(' ');

export function inText(sources: Source[], page: string, style: Style): string {
  if (!sources.length) return '(Source missing)';
  const parts = sources.map((s, i) => {
    const who = authorShort(s, style);
    const year = clean(s.year) || 'n.d.';
    const pg = i === sources.length - 1 && page ? page.trim() : '';
    if (style === 'mla') return pg ? `${who} ${pg}` : who;
    if (style === 'apa') return `${who}, ${year}${pg ? `, ${/[-–,]/.test(pg) ? 'pp.' : 'p.'} ${pg}` : ''}`;
    return `${who} ${year}${pg ? `, ${pg}` : ''}`;
  });
  return `(${parts.join('; ')})`;
}

// ---------- Reference entries ----------
function mlaAuthors(s: Source) {
  const ps = people(s);
  if (!ps.length) return s.org ? endPunct(s.org) + ' ' : '';
  const first = `${ps[0].last}${ps[0].first ? ', ' + ps[0].first : ''}`;
  if (ps.length === 1) return endPunct(first) + ' ';
  if (ps.length === 2) return endPunct(`${first}, and ${[ps[1].first, ps[1].last].filter(Boolean).join(' ')}`) + ' ';
  return `${first}, et al. `;
}
function apaAuthors(s: Source) {
  const ps = people(s);
  if (!ps.length) return s.org ? endPunct(s.org) + ' ' : '';
  const fmt = (a: { first: string; last: string }) => `${a.last}${a.first ? ', ' + initials(a.first) : ''}`;
  if (ps.length === 1) return endPunct(fmt(ps[0])) + ' ';
  if (ps.length <= 20) return endPunct(ps.slice(0, -1).map(fmt).join(', ') + ', & ' + fmt(ps[ps.length - 1])) + ' ';
  return endPunct(ps.slice(0, 19).map(fmt).join(', ') + ', . . . ' + fmt(ps[ps.length - 1])) + ' ';
}
function chicagoAuthors(s: Source) {
  const ps = people(s);
  if (!ps.length) return s.org ? endPunct(s.org) + ' ' : '';
  const first = `${ps[0].last}${ps[0].first ? ', ' + ps[0].first : ''}`;
  const rest = ps.slice(1).map((a) => [a.first, a.last].filter(Boolean).join(' '));
  if (!rest.length) return endPunct(first) + ' ';
  if (ps.length > 10) return `${first}, et al. `;
  return endPunct(`${first}, ${rest.length > 1 ? rest.slice(0, -1).join(', ') + ', ' : ''}and ${rest[rest.length - 1]}`) + ' ';
}

function mlaDate(s: Source) {
  const m = monthIdx(s.month);
  return [s.day, m >= 0 ? MLA_MONTHS[m] : '', s.year].filter(Boolean).join(' ');
}
function apaDate(s: Source, full: boolean) {
  const m = monthIdx(s.month);
  if (!s.year) return '(n.d.).';
  return full && m >= 0 ? `(${s.year}, ${MONTHS[m]}${s.day ? ' ' + s.day : ''}).` : `(${s.year}).`;
}

export function reference(s: Source, style: Style): string {
  const t = clean(s.title);
  const url = doiUrl(s);
  const pages = clean(s.pages);
  if (style === 'mla') {
    const a = mlaAuthors(s);
    const date = mlaDate(s);
    const acc = accessedMla(s.accessed);
    switch (s.type) {
      case 'book':
        return `${a}${it(t)}. ${[s.edition ? `${s.edition} ed.` : '', esc(clean(s.publisher)), s.year].filter(Boolean).join(', ')}.`;
      case 'chapter':
        return `${a}“${esc(endPunct(t))}” ${it(s.container)}, ${[esc(clean(s.publisher)), s.year, pages ? `pp. ${pages}` : ''].filter(Boolean).join(', ')}.`;
      case 'journal':
        return `${a}“${esc(endPunct(t))}” ${it(s.container)}, ${[s.volume ? `vol. ${s.volume}` : '', s.issue ? `no. ${s.issue}` : '', date, pages ? `pp. ${pages}` : '', url].filter(Boolean).map(esc).join(', ')}.`;
      case 'video':
        return `${a}“${esc(endPunct(t))}” ${it(s.container || 'YouTube')}, ${[date, url].filter(Boolean).map(esc).join(', ')}.${acc ? ` Accessed ${acc}.` : ''}`;
      case 'website':
      case 'article':
        return `${a}“${esc(endPunct(t))}” ${s.container ? it(s.container) + ', ' : ''}${[s.publisher && s.publisher !== s.container ? clean(s.publisher) : '', date, pages ? `pp. ${pages}` : '', url].filter(Boolean).map(esc).join(', ')}.${acc ? ` Accessed ${acc}.` : ''}`;
      default:
        return `${a}${it(t)}. ${[esc(clean(s.publisher)), s.year, esc(url)].filter(Boolean).join(', ')}.`;
    }
  }
  if (style === 'apa') {
    const a = apaAuthors(s);
    const pub = clean(s.publisher);
    switch (s.type) {
      case 'book':
        return `${a}${apaDate(s, false)} ${it(t)}${s.edition ? ` (${esc(s.edition)} ed.)` : ''}. ${pub ? esc(endPunct(pub)) + ' ' : ''}${esc(url)}`.trim();
      case 'chapter':
        return `${a}${apaDate(s, false)} ${esc(endPunct(t))} In ${it(s.container)}${pages ? ` (pp. ${esc(pages)})` : ''}. ${pub ? esc(endPunct(pub)) : ''} ${esc(url)}`.trim();
      case 'journal':
        return `${a}${apaDate(s, false)} ${esc(endPunct(t))} ${it(s.container)}${s.volume ? `, ${it(s.volume)}` : ''}${s.issue ? `(${esc(s.issue)})` : ''}${pages ? `, ${esc(pages)}` : ''}. ${esc(url)}`.trim();
      case 'video':
        return `${a}${apaDate(s, true)} ${it(t)} [Video]. ${s.container ? esc(endPunct(s.container)) + ' ' : ''}${esc(url)}`.trim();
      case 'website':
        return `${a}${apaDate(s, true)} ${it(t)}. ${s.container && s.container !== (s.org || '') ? esc(endPunct(s.container)) + ' ' : ''}${esc(url)}`.trim();
      case 'article':
        return `${a}${apaDate(s, true)} ${esc(endPunct(t))} ${it(s.container)}. ${esc(url)}`.trim();
      default:
        return `${a}${apaDate(s, false)} ${it(t)}. ${pub ? esc(endPunct(pub)) + ' ' : ''}${esc(url)}`.trim();
    }
  }
  // Chicago author-date
  const a = chicagoAuthors(s);
  const year = s.year || 'n.d.';
  const m = monthIdx(s.month);
  const full = m >= 0 ? `${MONTHS[m]}${s.day ? ' ' + s.day : ''}, ${year}` : '';
  switch (s.type) {
    case 'book':
      return `${a}${year}. ${it(t)}. ${[esc(clean(s.city)), esc(clean(s.publisher))].filter(Boolean).join(': ')}${s.city || s.publisher ? '.' : ''}`.trim();
    case 'chapter':
      return `${a}${year}. “${esc(endPunct(t))}” In ${it(s.container)}${pages ? `, ${esc(pages)}` : ''}. ${[esc(clean(s.city)), esc(clean(s.publisher))].filter(Boolean).join(': ')}.`.trim();
    case 'journal':
      return `${a}${year}. “${esc(endPunct(t))}” ${it(s.container)}${s.volume ? ` ${esc(s.volume)}` : ''}${s.issue ? ` (${esc(s.issue)})` : ''}${pages ? `: ${esc(pages)}` : ''}. ${esc(url)}`.trim();
    case 'website':
    case 'article':
    case 'video':
      return `${a}${year}. “${esc(endPunct(t))}” ${s.container ? it(s.container) + '. ' : ''}${full ? full + '. ' : ''}${esc(url)}${url ? '.' : ''}`.trim();
    default:
      return `${a}${year}. ${it(t)}. ${esc(clean(s.publisher))}${s.publisher ? '.' : ''} ${esc(url)}`.trim();
  }
}

const sortKey = (s: Source) => (people(s)[0]?.last || s.org || s.title || '').replace(/^(the|a|an)\s+/i, '').toLowerCase();

export function bibliography(sources: Source[], style: Style): string[] {
  return [...sources].sort((a, b) => sortKey(a).localeCompare(sortKey(b)) || (a.year || '').localeCompare(b.year || '')).map((s) => reference(s, style));
}

// ---------- Nodes ----------
declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    citation: {
      insertCitation: (ids: string[], page?: string) => ReturnType;
      insertBibliography: () => ReturnType;
    };
  }
}

/** In-text citation like (Smith 45). */
export const Citation = Node.create({
  name: 'citation',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      ids: { default: [], parseHTML: (el) => (el.getAttribute('data-cite') || '').split(',').filter(Boolean), renderHTML: (a) => ({ 'data-cite': (a.ids || []).join(',') }) },
      page: { default: '', parseHTML: (el) => el.getAttribute('data-page') || '', renderHTML: (a) => (a.page ? { 'data-page': a.page } : {}) },
      text: { default: '', parseHTML: (el) => el.textContent || '', renderHTML: () => ({}) }
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-cite]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { class: 'cite' }), node.attrs.text || '(citation)'];
  },
  addStorage() {
    return { onEdit: null as null | ((pos: number) => void) };
  },
  addNodeView() {
    return ({ node, getPos, editor }) => {
      const dom = document.createElement('span');
      dom.className = 'cite';
      dom.textContent = node.attrs.text || '(citation)';
      dom.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const pos = typeof getPos === 'function' ? getPos() : null;
        if (pos != null) (editor.storage as any).citation.onEdit?.(pos);
      });
      return {
        dom,
        update: (n) => {
          if (n.type.name !== 'citation') return false;
          dom.textContent = n.attrs.text || '(citation)';
          return true;
        }
      };
    };
  },
  addCommands() {
    return {
      insertCitation:
        (ids, page = '') =>
        ({ chain }) =>
          chain().insertContent({ type: 'citation', attrs: { ids, page } }).run(),
      insertBibliography:
        () =>
        ({ chain }) =>
          chain().insertContent({ type: 'bibliography' }).run()
    };
  }
});

/** Works Cited / References list, rebuilt from the document's sources. */
export const Bibliography = Node.create({
  name: 'bibliography',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      title: { default: 'Works Cited', parseHTML: (el) => el.getAttribute('data-title') || 'Works Cited', renderHTML: (a) => ({ 'data-title': a.title }) },
      entries: {
        default: [],
        parseHTML: (el) => Array.from(el.querySelectorAll('p.bib-entry')).map((p) => p.innerHTML),
        renderHTML: () => ({})
      }
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-bibliography]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const entries: string[] = node.attrs.entries || [];
    const dom = document.createElement('div');
    for (const [k, v] of Object.entries(mergeAttributes(HTMLAttributes, { 'data-bibliography': '', class: 'bibliography' }))) dom.setAttribute(k, String(v));
    const h = document.createElement('p');
    h.className = 'bib-title';
    h.textContent = node.attrs.title;
    dom.appendChild(h);
    for (const e of entries) {
      const p = document.createElement('p');
      p.className = 'bib-entry';
      p.innerHTML = e;
      dom.appendChild(p);
    }
    if (!entries.length) {
      const p = document.createElement('p');
      p.className = 'bib-empty';
      p.textContent = 'Add sources with Insert → Citation and they appear here.';
      dom.appendChild(p);
    }
    return dom;
  }
});

/** Re-render every citation and bibliography from the document's sources and style. */
export function refreshCitations(editor: Editor, meta: DocMeta) {
  const byId = new Map(meta.sources.map((s) => [s.id, s]));
  const tr = editor.state.tr;
  let changed = false;
  const usedIds: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'citation') for (const id of node.attrs.ids || []) if (!usedIds.includes(id)) usedIds.push(id);
  });
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'citation') {
      const text = inText((node.attrs.ids || []).map((id: string) => byId.get(id)).filter(Boolean) as Source[], node.attrs.page, meta.citationStyle);
      if (text !== node.attrs.text) {
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, text });
        changed = true;
      }
    } else if (node.type.name === 'bibliography') {
      // Every source in the document is listed (MLA/APA list what you cite; unused sources are still useful while drafting).
      const entries = bibliography(meta.sources, meta.citationStyle);
      const title = BIB_TITLE[meta.citationStyle];
      if (JSON.stringify(entries) !== JSON.stringify(node.attrs.entries) || title !== node.attrs.title) {
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, entries, title });
        changed = true;
      }
    }
  });
  if (changed) editor.view.dispatch(tr.setMeta('addToHistory', false));
}
