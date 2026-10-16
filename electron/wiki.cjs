// Encyclopedia: reads Wikipedia for the Encyclopedia panel. Only the term, single words from around it and (for a
// highlighted question) short search phrases of a few words are sent, never whole sentences or the user's file.
const { ipcMain, net } = require('electron');

const UA = 'Kea/1.0 (https://github.com/kadenw213-svg/kea)';
const SKIP_SECTIONS = /^(see also|references|notes|footnotes|citations|sources|bibliography|further reading|external links|gallery|works cited|notes and references|explanatory notes)$/i;

async function getJson(url, retry = true) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  const res = await net.fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctl.signal }).finally(() => clearTimeout(timer));
  // Too many requests at once: wait a moment and try once more.
  if (res.status === 429 && retry) {
    await new Promise((r) => setTimeout(r, 1500));
    return getJson(url, false);
  }
  if (!res.ok) throw new Error(`Wikipedia didn't answer (${res.status}).`);
  return res.json();
}
const apiBase = (lang) => `https://${/^[a-z-]{2,12}$/.test(lang || '') ? lang : 'en'}.wikipedia.org/w/api.php?format=json&formatversion=2&origin=*`;

/**
 * Candidate articles for a term, in Wikipedia's search order: title, short description, the first three sentences,
 * and whether it's a disambiguation page. An exact title (or redirect) is always included first.
 */
async function search(query, lang) {
  const q = String(query || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!q) return [];
  const api = apiBase(lang);
  const props = 'prop=description|pageprops|extracts&ppprop=disambiguation&exintro=1&explaintext=1&exsentences=3&exlimit=max&redirects=1';
  const [exact, found, hits] = await Promise.all([
    getJson(`${api}&action=query&${props}&titles=${encodeURIComponent(q)}`).catch(() => null),
    getJson(`${api}&action=query&${props}&generator=search&gsrlimit=8&gsrsearch=${encodeURIComponent(q)}`),
    // The same search's section matches: "light-dependent reactions" is a section of "Photosynthesis".
    getJson(`${api}&action=query&list=search&srlimit=8&srprop=sectiontitle&srsearch=${encodeURIComponent(q)}`).catch(() => null)
  ]);
  const sectionOf = new Map((hits?.query?.search || []).filter((h) => h.sectiontitle).map((h) => [h.title, h.sectiontitle]));
  const pages = [];
  const add = (p, rank, extra) => {
    if (!p || p.missing || p.invalid || pages.some((x) => x.title === p.title)) return;
    pages.push({ title: p.title, description: p.description || '', intro: (p.extract || '').trim(), disambiguation: !!p.pageprops && 'disambiguation' in p.pageprops, rank, ...extra });
  };
  // A redirect can point at the section about the term ("Saturation (chemistry)" → "Saturation#Chemistry").
  const r = exact?.query?.redirects?.[0];
  add(exact?.query?.pages?.[0], -1, r ? { fragment: r.tofragment || '', redirectFrom: r.from } : undefined);
  for (const p of (found?.query?.pages || []).sort((a, b) => (a.index || 0) - (b.index || 0))) add(p, p.index || 0, sectionOf.has(p.title) ? { section: sectionOf.get(p.title) } : undefined);
  return pages;
}

/** A light search (one request) for a short phrase: the top articles with their descriptions and opening sentences. */
async function find(query, lang, limit = 5) {
  const q = String(query || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!q) return [];
  const n = Math.max(1, Math.min(10, Number(limit) || 5));
  const j = await getJson(`${apiBase(lang)}&action=query&prop=description|pageprops|extracts&ppprop=disambiguation&exintro=1&explaintext=1&exsentences=3&exlimit=max&redirects=1&generator=search&gsrlimit=${n}&gsrsearch=${encodeURIComponent(q)}`);
  return (j.query?.pages || [])
    .filter((p) => !p.missing && !p.invalid && !(p.pageprops && 'disambiguation' in p.pageprops))
    .sort((a, b) => (a.index || 0) - (b.index || 0))
    .map((p) => ({ title: p.title, description: p.description || '', intro: (p.extract || '').trim(), disambiguation: false, rank: p.index || 0 }));
}

/** The meanings a disambiguation page lists ("Cell" → "Cell (biology)", "Prison cell", …), with short descriptions. */
async function meanings(title, lang) {
  const j = await getJson(`${apiBase(lang)}&action=query&generator=links&gplnamespace=0&gpllimit=max&prop=description|pageprops&ppprop=disambiguation&redirects=1&titles=${encodeURIComponent(String(title).slice(0, 300))}`);
  const frag = new Map((j.query?.redirects || []).filter((r) => r.tofragment).map((r) => [r.to, r.tofragment]));
  return (j.query?.pages || [])
    .filter((p) => !p.missing && !p.invalid && !(p.pageprops && 'disambiguation' in p.pageprops))
    .map((p) => ({ title: p.title, description: p.description || '', intro: '', disambiguation: false, rank: 50, fragment: frag.get(p.title) || '' }));
}

/** More of each candidate to compare with the reading: its whole introduction and its (visible) categories. */
async function about(list, lang) {
  const want = [...new Set((list || []).map((t) => String(t).trim()).filter(Boolean))].slice(0, 10);
  if (!want.length) return {};
  const j = await getJson(`${apiBase(lang)}&action=query&prop=extracts|categories&exintro=1&explaintext=1&exlimit=max&cllimit=max&clshow=!hidden&titles=${encodeURIComponent(want.join('|'))}`);
  const out = {};
  for (const p of j.query?.pages || []) {
    if (p.missing || p.invalid) continue;
    out[p.title] = { intro: (p.extract || '').slice(0, 6000), categories: (p.categories || []).map((c) => c.title.replace(/^[^:]+:/, '')) };
  }
  return out;
}

/** Which of these exact titles (or redirects, like "polar molecule" → "Chemical polarity") have an article. */
async function titles(list, lang) {
  const want = [...new Set((list || []).map((t) => String(t).trim()).filter(Boolean))].slice(0, 20);
  if (!want.length) return [];
  const j = await getJson(`${apiBase(lang)}&action=query&prop=description|pageprops|extracts&ppprop=disambiguation&exintro=1&explaintext=1&exsentences=3&exlimit=max&redirects=1&titles=${encodeURIComponent(want.join('|'))}`);
  // Follow Wikipedia's renames back to the phrase that was asked for ("polar molecule" → "Chemical polarity").
  const back = new Map();
  const frag = new Map();
  for (const n of j.query?.normalized || []) back.set(n.to, n.from);
  for (const r of j.query?.redirects || []) {
    back.set(r.to, back.get(r.from) || r.from);
    if (r.tofragment) frag.set(r.to, r.tofragment);
  }
  return (j.query?.pages || [])
    .filter((p) => !p.missing && !p.invalid && !(p.pageprops && 'disambiguation' in p.pageprops))
    .map((p) => ({ title: p.title, description: p.description || '', intro: (p.extract || '').trim(), disambiguation: false, rank: 0, phrase: String(back.get(p.title) || p.title).toLowerCase(), fragment: frag.get(p.title) || '' }));
}

// Wikipedia's HTML → plain text that keeps what the plain-text format loses: superscripts and subscripts
// ("10²³ mol⁻¹", "H₃O⁺") and each equation's LaTeX (turned into readable text in the panel).
const SUP = Object.fromEntries([...'0123456789+-−=()ni'].map((c, k) => [c, '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁻⁼⁽⁾ⁿⁱ'[k]]));
const SUB = Object.fromEntries([...'0123456789+-−=()aeoxhklmnpst'].map((c, k) => [c, '₀₁₂₃₄₅₆₇₈₉₊₋₋₌₍₎ₐₑₒₓₕₖₗₘₙₚₛₜ'[k]]));
const decode = (s) =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
// A tag, even when an attribute holds a ">" (Wikipedia's data-mw JSON can).
const TAG = /<(?:[^>"']|"[^"]*"|'[^']*')*>/g;
const strip = (s) => decode(s.replace(TAG, ''));
function htmlToText(html) {
  return decode(
    html
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      // Attributes aren't needed (and can hide ">"): reduce every tag to its name.
      .replace(/<(\/?)([a-z0-9]+)(?:[^>"']|"[^"]*"|'[^']*')*?(\/?)>/gi, (m, close, name, self) => (name.toLowerCase() === 'math' || name.toLowerCase() === 'annotation' ? m : `<${close}${name}${self}>`))
      // Chemistry formulas stack an empty superscript over the subscript with a line break: H₂O, not "H\n₂O".
      .replace(/<sup>\s*<\/sup>\s*<br\/?>\s*/gi, '')
      .replace(/<\/sup>\s*<br\/?>\s*<sub>/gi, '</sup><sub>')
      // Equations with a label under each part: "CO₂ (carbon dioxide) + 2H₂A (electron donor) → …".
      .replace(/<span><span><span>((?:(?!<span)[\s\S])*?)<\/span><span><span>((?:(?!<span)[\s\S])*?)<\/span><\/span><\/span><\/span>/gi, (_, part, label) => `${part} (${label.replace(/<br\/?>/gi, ' ')})`)
      // Equations: keep only their LaTeX source.
      .replace(/<math[\s\S]*?<annotation[^>]*>([\s\S]*?)<\/annotation>[\s\S]*?<\/math>/gi, (_, tex) => decode(tex.replace(/<[^>]+>/g, '')))
      .replace(/<math[^>]*alttext="([^"]*)"[\s\S]*?<\/math>/gi, (_, tex) => decode(tex))
      .replace(/<sup[^>]*>([\s\S]*?)<\/sup>/gi, (_, x) => {
        const t = strip(x);
        return [...t].every((c) => SUP[c]) ? [...t].map((c) => SUP[c]).join('') : t;
      })
      .replace(/<sub[^>]*>([\s\S]*?)<\/sub>/gi, (_, x) => {
        const t = strip(x);
        return [...t].every((c) => SUB[c]) ? [...t].map((c) => SUB[c]).join('') : t;
      })
      .replace(/<h([2-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, x) => `\n${'='.repeat(+n)} ${strip(x).trim()} ${'='.repeat(+n)}\n`)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|li|dd|dt|tr|div|blockquote|ul|ol|dl|table)>/gi, '\n')
      .replace(TAG, '')
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

/** One article as plain text: its lead (the definition and overview) and its sections, without reference sections. */
async function article(title, lang) {
  const api = apiBase(lang);
  const j = await getJson(`${api}&action=query&prop=extracts|info|revisions|description&inprop=url&rvprop=timestamp&redirects=1&titles=${encodeURIComponent(String(title).slice(0, 300))}`);
  const p = j.query?.pages?.[0];
  if (!p || p.missing || !p.extract) return null;
  const sections = [];
  let cur = { title: '', level: 1, text: '' };
  for (const line of htmlToText(p.extract).split('\n')) {
    const h = line.match(/^(={2,6})\s*(.*?)\s*\1\s*$/);
    if (h) {
      sections.push(cur);
      cur = { title: h[2], level: h[1].length, text: '' };
    } else cur.text += line + '\n';
  }
  sections.push(cur);
  const clean = sections.map((s) => ({ ...s, text: s.text.replace(/\n{3,}/g, '\n\n').trim() }));
  // A reference section ends the article (its subsections too).
  const end = clean.findIndex((s, i) => i > 0 && SKIP_SECTIONS.test(s.title));
  const kept = (end > 0 ? clean.slice(0, end) : clean).filter((s, i) => i === 0 || s.text || clean[i + 1]?.level > s.level);
  return {
    title: p.title,
    url: p.fullurl || `https://${lang || 'en'}.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, '_'))}`,
    description: p.description || '',
    edited: p.revisions?.[0]?.timestamp || p.touched || null,
    lead: kept[0]?.text || '',
    sections: kept.slice(1)
  };
}

/** Article titles that start with what was typed ("cellular respir" → "Cellular respiration"), for clipped words. */
async function complete(prefix, lang) {
  const q = String(prefix || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (q.length < 3) return [];
  const j = await getJson(`${apiBase(lang)}&action=opensearch&namespace=0&limit=8&redirects=resolve&search=${encodeURIComponent(q)}`);
  return Array.isArray(j?.[1]) ? j[1].map(String) : [];
}

// ---------- Wiktionary (the Dictionary when online) ----------
const clean = (html) =>
  strip(
    String(html || '')
      .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, ' ')
  )
    .replace(/\s+/g, ' ')
    // Wiktionary's notes to its editors ("This term needs a definition. Please help out… {{rfdef}}") aren't definitions.
    .replace(/This (?:term|sense|entry|word) needs[^]*?(?:\{\{[^}]*\}\}\.?|$)/gi, '')
    .replace(/\{\{[^}]*\}\}/g, '')
    .replace(/\s+([,.;:)])/g, '$1')
    .trim();

/**
 * A word's English Wiktionary entry, word for word: every sense by part of speech, with its subject label
 * ("Chemistry"), sub-senses and example sentences. An inflected form ("dissolves") also brings its base word's entry.
 */
async function wiktionary(input, follow = true) {
  const word = String(input || '').replace(/\s+/g, ' ').trim().replace(/^[“"'(]+|[”"').,;:!?]+$/g, '').slice(0, 80);
  if (!word) return null;
  const get = async (w) => {
    const res = await net.fetch(`https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(w.replace(/ /g, '_'))}?redirect=true`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Wiktionary didn't answer (${res.status}).`);
    return res.json();
  };
  // Wiktionary is case-sensitive ("Python" the name, "python" the snake): try as typed, then in lower case.
  let found = word;
  let j = await get(word);
  if (!j?.en?.length && word !== word.toLowerCase()) j = await get((found = word.toLowerCase()));
  if (!j?.en?.length) return null;
  const entries = [];
  const bases = [];
  for (const e of j.en) {
    const senses = [];
    for (const d of e.definitions || []) {
      const html = String(d.definition || '');
      const [main, ...rest] = html.split(/<ol[^>]*>/i);
      const def = clean(main);
      const sub = rest.length ? [...rest.join('').matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => clean(m[1])).filter(Boolean) : [];
      if (!def && !sub.length) continue;
      const base = /class="form-of-definition/.test(html) ? html.match(/form-of-definition-link[\s\S]*?title="([^"#]+)/)?.[1] : null;
      if (base && !bases.includes(base) && base.toLowerCase() !== found.toLowerCase()) bases.push(base);
      const label = html.match(/class="template-anchor"[^>]*data-id="([^"]+)"/)?.[1]?.replace(/_/g, ' ') || '';
      senses.push({ def: def || sub.shift(), label, examples: (d.examples || []).map(clean).filter(Boolean), sub, formOf: base || undefined, synonyms: [], antonyms: [] });
    }
    // Narrower senses are listed both under their parent and on their own: keep them under the parent only.
    const nested = new Set(senses.flatMap((s) => s.sub));
    for (let i = senses.length - 1; i >= 0; i--) if (nested.has(senses[i].def) && !senses[i].examples.length) senses.splice(i, 1);
    if (senses.length) entries.push({ pos: String(e.partOfSpeech || '').toLowerCase(), lemma: found, senses });
  }
  // "dissolves" is "third-person singular … of dissolve": show dissolve's entry too.
  if (follow) {
    for (const b of bases.slice(0, 2)) {
      const more = await wiktionary(b, false).catch(() => null);
      if (more) entries.push(...more.entries);
    }
  }
  if (!entries.length) return null;
  return { word: found, url: `https://en.wiktionary.org/wiki/${encodeURIComponent(found.replace(/ /g, '_'))}`, source: 'wiktionary', entries, synonyms: [], antonyms: [] };
}

function register() {
  ipcMain.handle('lookup:wiktionary', (_e, word) => wiktionary(word));
  ipcMain.handle('lookup:about', (_e, list, lang) => about(list, lang));
  ipcMain.handle('lookup:meanings', (_e, title, lang) => meanings(title, lang));
  ipcMain.handle('lookup:complete',(_e, prefix, lang) => complete(prefix, lang));
  ipcMain.handle('lookup:search', (_e, query, lang) => search(query, lang));
  ipcMain.handle('lookup:find', (_e, query, lang, limit) => find(query, lang, limit));
  ipcMain.handle('lookup:article', (_e, title, lang) => article(title, lang));
  ipcMain.handle('lookup:titles', (_e, list, lang) => titles(list, lang));
}

module.exports = { register };
