// "Check Wikipedia" for the local AI: when the user turns it on, look up the topic on Wikipedia and return
// the article text so the on-device model can use current facts. Only the search words are sent.
const { ipcMain, net } = require('electron');

const UA = 'SlateOffice/1.0 (https://github.com/kadenw213-svg/slate-office)';

async function getJson(url) {
  // A slow connection must never hold up an answer: give up after 4 s and answer locally.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 4000);
  const res = await net.fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctl.signal }).finally(() => clearTimeout(timer));
  if (!res.ok) throw new Error(`Wikipedia lookup failed (${res.status}).`);
  return res.json();
}

/** Search, then fetch the plain text of the best `max` articles (trimmed to `chars` each). */
async function lookup(query, opts = {}) {
  const lang = /^[a-z-]{2,12}$/.test(opts.lang || '') ? opts.lang : 'en';
  const max = Math.max(1, Math.min(3, Number(opts.max) || 1));
  const chars = Math.max(500, Math.min(20000, Number(opts.chars) || 4000));
  const api = `https://${lang}.wikipedia.org/w/api.php?format=json&formatversion=2&origin=*`;
  const q = String(query || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!q) return [];
  const search = await getJson(`${api}&action=query&list=search&srlimit=${Math.max(6, max)}&srprop=&srsearch=${encodeURIComponent(q)}`);
  // Rank: 1) the exact topic ("Archaea", ignoring "(biology)"-style suffixes), 2) titles made only of the searched
  // words ("Industrial Revolution" over "Second Industrial Revolution"), 3) the rest; Wikipedia's order within each.
  const norm = (t) => t.toLowerCase().replace(/\s*\([^)]*\)\s*$/, '').trim();
  const words = new Set(q.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
  const fits = (t) => (norm(t).match(/[\p{L}\p{N}]+/gu) || []).every((w) => words.has(w));
  const rank = (t) => (norm(t) === q.toLowerCase() ? 0 : fits(t) ? 1 : 2);
  const found = (search.query?.search || []).map((s, i) => ({ title: s.title, i, r: rank(s.title) }));
  found.sort((a, b) => a.r - b.r || a.i - b.i);
  const titles = found.slice(0, max).map((f) => f.title);
  const out = [];
  for (const title of titles) {
    const j = await getJson(
      `${api}&action=query&prop=extracts|info|revisions&explaintext=1${opts.intro ? '&exintro=1' : ''}&exsectionformat=plain&inprop=url&rvprop=timestamp&redirects=1&titles=${encodeURIComponent(title)}`
    );
    const p = j.query?.pages?.[0];
    if (!p || p.missing || !p.extract) continue;
    // Drop reference-only sections at the end.
    let text = p.extract.split(/\n(?:See also|References|Notes|Further reading|External links|Bibliography)\n/)[0].trim();
    if (text.length > chars) text = text.slice(0, chars).replace(/\s+\S*$/, '') + ' …';
    out.push({ title: p.title, url: p.fullurl || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, '_'))}`, text, edited: p.revisions?.[0]?.timestamp || p.touched || null });
  }
  return out;
}

function register() {
  ipcMain.handle('wiki:lookup', (_e, query, opts) => lookup(query, opts));
}

module.exports = { register };
