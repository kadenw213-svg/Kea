// Citation lookups: turn a DOI, ISBN or web address into a filled-in source. Runs only when the user
// clicks "Look up" (Crossref for DOIs, Open Library for ISBNs, or the web page's own metadata).
const { ipcMain, net } = require('electron');

const UA = 'SlateOffice/1.0 (https://github.com/kadenw213-svg/slate-office)';

async function getJson(url) {
  const res = await net.fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(res.status === 404 ? 'Nothing was found for that.' : `Lookup failed (${res.status}).`);
  return res.json();
}

const splitName = (full) => {
  const s = String(full || '').trim();
  if (!s) return null;
  if (s.includes(',')) {
    const [last, first] = s.split(',').map((x) => x.trim());
    return { first: first || '', last };
  }
  const parts = s.split(/\s+/);
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
};

async function byDoi(doi) {
  const id = doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').trim();
  const { message: m } = await getJson(`https://api.crossref.org/works/${encodeURIComponent(id)}`);
  const parts = (m.published || m['published-print'] || m['published-online'] || m.issued || {})['date-parts']?.[0] || [];
  const type = m.type === 'journal-article' ? 'journal' : m.type === 'book' || m.type === 'monograph' ? 'book' : m.type === 'book-chapter' ? 'chapter' : m.type === 'report' ? 'report' : 'article';
  return {
    type,
    authors: (m.author || []).map((a) => ({ first: a.given || '', last: a.family || a.name || '' })),
    title: (m.title || [''])[0],
    container: (m['container-title'] || [''])[0] || '',
    publisher: m.publisher || '',
    year: parts[0] ? String(parts[0]) : '',
    month: parts[1] ? String(parts[1]) : '',
    day: parts[2] ? String(parts[2]) : '',
    volume: m.volume || '',
    issue: m.issue || '',
    pages: (m.page || '').replace('-', '–'),
    doi: id,
    url: ''
  };
}

async function byIsbn(isbn) {
  const id = isbn.replace(/[^0-9Xx]/g, '');
  const j = await getJson(`https://openlibrary.org/api/books?bibkeys=ISBN:${id}&format=json&jscmd=data`);
  const b = j[`ISBN:${id}`];
  if (!b) throw new Error('No book was found for that ISBN.');
  const year = (/\d{4}/.exec(b.publish_date || '') || [''])[0];
  return {
    type: 'book',
    authors: (b.authors || []).map((a) => splitName(a.name)).filter(Boolean),
    title: b.title + (b.subtitle ? `: ${b.subtitle}` : ''),
    publisher: (b.publishers || [])[0]?.name || '',
    city: (b.publish_places || [])[0]?.name || '',
    year,
    url: ''
  };
}

const decode = (s) =>
  String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();

async function byUrl(url) {
  const res = await net.fetch(url, { headers: { 'User-Agent': UA + ' Mozilla/5.0', Accept: 'text/html' } });
  if (!res.ok) throw new Error(`The page couldn't be loaded (${res.status}).`);
  const html = (await res.text()).slice(0, 1_500_000);
  const metas = [];
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const key = (/(?:name|property|itemprop)\s*=\s*["']([^"']+)["']/i.exec(tag) || [])[1];
    const val = (/content\s*=\s*["']([^"']*)["']/i.exec(tag) || [])[1];
    if (key && val != null) metas.push([key.toLowerCase(), decode(val)]);
  }
  const get = (...keys) => {
    for (const k of keys) {
      const hit = metas.find(([kk]) => kk === k);
      if (hit && hit[1]) return hit[1];
    }
    return '';
  };
  const all = (k) => metas.filter(([kk]) => kk === k).map(([, v]) => v);
  const doi = get('citation_doi', 'dc.identifier', 'prism.doi');
  if (/^10\.\d{4,}\//.test(doi.replace(/^doi:\s*/i, ''))) {
    try {
      return { ...(await byDoi(doi)), url };
    } catch {}
  }
  const title = get('citation_title', 'og:title', 'twitter:title', 'dc.title') || decode((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1]);
  const authorsRaw = all('citation_author').length ? all('citation_author') : all('author').length ? all('author') : all('article:author').filter((a) => !/^https?:/.test(a));
  const date = get('citation_publication_date', 'citation_date', 'article:published_time', 'date', 'dc.date', 'pubdate', 'og:published_time');
  const dm = /(\d{4})[-/](\d{1,2})?[-/]?(\d{1,2})?/.exec(date) || [];
  const journal = get('citation_journal_title');
  const site = get('og:site_name', 'application-name') || new URL(url).hostname.replace(/^www\./, '');
  const t = new Date();
  return {
    type: journal ? 'journal' : get('og:type') === 'video' || /youtube\.com|youtu\.be|vimeo\.com/.test(url) ? 'video' : get('og:type') === 'article' ? 'article' : 'website',
    authors: authorsRaw.map(splitName).filter(Boolean).slice(0, 25),
    title: title.replace(new RegExp(`\\s*[|\\-–—]\\s*${site.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i'), ''),
    container: journal || site,
    publisher: get('citation_publisher', 'dc.publisher'),
    year: dm[1] || '',
    month: dm[2] ? String(Number(dm[2])) : '',
    day: dm[3] ? String(Number(dm[3])) : '',
    volume: get('citation_volume'),
    issue: get('citation_issue'),
    pages: [get('citation_firstpage'), get('citation_lastpage')].filter(Boolean).join('–'),
    url,
    accessed: `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
  };
}

function register({ log }) {
  ipcMain.handle('cite:lookup', async (_e, query) => {
    const q = String(query || '').trim();
    try {
      if (/^(https?:\/\/(dx\.)?doi\.org\/|doi:\s*)?10\.\d{4,9}\/\S+$/i.test(q)) return await byDoi(q);
      if (/^(97[89])?[\d\s-]{9,}[\dXx]$/.test(q.replace(/^isbn:?\s*/i, '')) && q.replace(/[^0-9Xx]/g, '').length >= 10) return await byIsbn(q.replace(/^isbn:?\s*/i, ''));
      if (/^https?:\/\//i.test(q)) return await byUrl(q);
      if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(q)) return await byUrl('https://' + q);
      throw new Error('Paste a DOI (10.xxxx/…), an ISBN, or a web address.');
    } catch (err) {
      log('cite lookup', q, err?.message);
      throw err;
    }
  });
}

module.exports = { register };
