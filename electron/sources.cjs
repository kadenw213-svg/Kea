// Real sources only. Finding sources for a paper, and checking one the assistant (or the student) names, always goes
// through a registry that actually holds the record: Crossref for articles, chapters and books with a DOI, Open Library
// for books by ISBN or title. Whatever the registries don't confirm is never shown, so a made-up source can't reach a
// Works Cited list. A link is then checked to be alive; a site that only refuses robots (403) still counts, because the
// record is real, but a link that is gone (404/410) is dropped.
// Runs only when the student asks (Citations → Look up, or the assistant's find_sources / verify_source tools).
const { ipcMain, net } = require('electron');
const { handleApp } = require('./ipcGuard.cjs');
const settings = require('./settings.cjs');

const UA = 'Kea/1.0 (https://github.com/kadenw213-svg/kea)';
const TIMEOUT = 9000;

async function fetchJson(url) {
  const res = await net.fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok) throw new Error(`The source lookup failed (${res.status}).`);
  return res.json();
}

const names = (list) => (list || []).map((a) => [a.given, a.family || a.name].filter(Boolean).join(' ')).filter(Boolean);
const year = (m) => ((m.issued || m['published-print'] || m['published-online'] || {})['date-parts'] || [[]])[0][0] || '';

/** A Crossref record as a source. */
function fromCrossref(m) {
  const doi = String(m.DOI || '').toLowerCase();
  return {
    kind: m.type === 'book' || m.type === 'monograph' ? 'book' : m.type === 'journal-article' ? 'journal' : m.type === 'book-chapter' ? 'chapter' : 'article',
    title: (m.title || [''])[0],
    authors: names(m.author),
    container: (m['container-title'] || [''])[0] || '',
    publisher: m.publisher || '',
    year: year(m) ? String(year(m)) : '',
    doi,
    url: doi ? `https://doi.org/${doi}` : '',
    verifiedBy: 'Crossref'
  };
}

/** Whether a link still leads somewhere: true, false (gone), or null (couldn't tell: offline, or a site that blocks robots). */
async function alive(url) {
  if (!/^https:\/\//i.test(url)) return null;
  try {
    let res = await net.fetch(url, { method: 'HEAD', redirect: 'follow', headers: { 'User-Agent': UA + ' Mozilla/5.0' }, signal: AbortSignal.timeout(TIMEOUT) });
    if (res.status === 405 || res.status === 501) res = await net.fetch(url, { method: 'GET', redirect: 'follow', headers: { 'User-Agent': UA + ' Mozilla/5.0' }, signal: AbortSignal.timeout(TIMEOUT) });
    if (res.status === 404 || res.status === 410) return false;
    return res.status < 400 ? true : null;
  } catch {
    return null;
  }
}

/** Articles and books that match a topic, each confirmed by a registry. Never a source from anywhere else. */
async function search(query, { rows = 6 } = {}) {
  const q = String(query || '').trim().slice(0, 300);
  if (q.length < 3) throw new Error('Say what the source should be about.');
  const out = [];
  try {
    const j = await fetchJson(`https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(q)}&rows=${Math.min(10, rows * 2)}&select=DOI,title,author,issued,container-title,publisher,type&filter=type:journal-article,type:book,type:book-chapter,type:monograph`);
    for (const m of j.message?.items || []) {
      const s = fromCrossref(m);
      if (s.title && s.doi && s.authors.length) out.push(s);
    }
  } catch {}
  try {
    const j = await fetchJson(`https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=4&fields=title,author_name,first_publish_year,publisher,isbn,key`);
    for (const d of j.docs || []) {
      if (!d.title || !d.author_name?.length || !d.isbn?.length) continue;
      out.push({ kind: 'book', title: d.title, authors: d.author_name.slice(0, 4), container: '', publisher: (d.publisher || [])[0] || '', year: d.first_publish_year ? String(d.first_publish_year) : '', isbn: d.isbn[0], url: `https://openlibrary.org${d.key}`, verifiedBy: 'Open Library' });
    }
  } catch {}
  // Each link is checked; one that is gone is dropped.
  const checked = await Promise.all(out.slice(0, rows + 4).map(async (s) => ({ s, ok: await alive(s.url) })));
  return checked.filter((x) => x.ok !== false).map((x) => ({ ...x.s, linkChecked: x.ok === true })).slice(0, rows);
}

/** One DOI, ISBN or link: the record behind it when a registry (or the page's own citation data) confirms it, else null. */
async function verify(input) {
  const q = String(input || '').trim();
  const doi = /10\.\d{4,9}\/[^\s"<>]+/.exec(q)?.[0];
  if (doi) {
    try {
      const j = await fetchJson(`https://api.crossref.org/works/${encodeURIComponent(doi.replace(/[.,;)]+$/, ''))}`);
      const s = fromCrossref(j.message || {});
      if (s.title) return { ...s, linkChecked: (await alive(s.url)) === true };
    } catch {}
    return null;
  }
  const isbn = q.replace(/^isbn:?\s*/i, '').replace(/[\s-]/g, '');
  if (/^(\d{9}[\dXx]|\d{13})$/.test(isbn)) {
    try {
      const j = await fetchJson(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`);
      const b = j[`ISBN:${isbn}`];
      if (b?.title) return { kind: 'book', title: b.title, authors: (b.authors || []).map((a) => a.name), container: '', publisher: (b.publishers || [])[0]?.name || '', year: (/\d{4}/.exec(b.publish_date || '') || [''])[0], isbn, url: b.url || '', verifiedBy: 'Open Library', linkChecked: true };
    } catch {}
    return null;
  }
  if (/^https:\/\//i.test(q)) {
    const ok = await alive(q);
    if (ok === false) return null;
    try {
      const cite = await require('./cite.cjs').lookupUrl(q);
      if (cite?.title) return { kind: cite.type || 'website', title: cite.title, authors: (cite.authors || []).map((a) => [a.first, a.last].filter(Boolean).join(' ')), container: cite.container || '', publisher: cite.publisher || '', year: cite.year || '', url: q, verifiedBy: 'the page itself', linkChecked: ok === true };
    } catch {}
  }
  return null;
}

function register() {
  const allowed = () => settings.get('privacy.citeLookup', true) !== false;
  handleApp(ipcMain, 'sources:search', async (_e, query) => {
    if (!allowed()) throw new Error('Citation look-ups are turned off (Settings → Privacy).');
    return search(query);
  });
  handleApp(ipcMain, 'sources:verify', async (_e, input) => {
    if (!allowed()) throw new Error('Citation look-ups are turned off (Settings → Privacy).');
    return verify(input);
  });
}

module.exports = { register, search, verify, _test: { fromCrossref } };
