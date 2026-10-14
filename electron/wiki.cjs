// "Check Wikipedia" for the local AI: when the user turns it on, look up the topic on Wikipedia and return
// the article text so the on-device model can use current facts. Only the search words are sent.
const { ipcMain, net } = require('electron');

const UA = 'SlateOffice/1.0 (https://github.com/kadenw213-svg/slate-office)';

async function getJson(url) {
  const res = await net.fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
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
  const search = await getJson(`${api}&action=query&list=search&srlimit=${max}&srprop=&srsearch=${encodeURIComponent(q)}`);
  const titles = (search.query?.search || []).map((s) => s.title);
  const out = [];
  for (const title of titles) {
    const j = await getJson(
      `${api}&action=query&prop=extracts|info|revisions&explaintext=1&exsectionformat=plain&inprop=url&rvprop=timestamp&redirects=1&titles=${encodeURIComponent(title)}`
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
