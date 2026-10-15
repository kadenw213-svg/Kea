// Look up: reads Wikipedia for the Look up panel. Only the search words are sent, never the user's file.
const { ipcMain, net } = require('electron');

const UA = 'SlateOffice/1.0 (https://github.com/kadenw213-svg/slate-office)';
const SKIP_SECTIONS = /^(see also|references|notes|footnotes|citations|sources|bibliography|further reading|external links|gallery|works cited|notes and references|explanatory notes)$/i;

async function getJson(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  const res = await net.fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctl.signal }).finally(() => clearTimeout(timer));
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
  const [exact, found] = await Promise.all([
    getJson(`${api}&action=query&${props}&titles=${encodeURIComponent(q)}`).catch(() => null),
    getJson(`${api}&action=query&${props}&generator=search&gsrlimit=8&gsrsearch=${encodeURIComponent(q)}`)
  ]);
  const pages = [];
  const add = (p, rank) => {
    if (!p || p.missing || p.invalid || pages.some((x) => x.title === p.title)) return;
    pages.push({ title: p.title, description: p.description || '', intro: (p.extract || '').trim(), disambiguation: !!p.pageprops && 'disambiguation' in p.pageprops, rank });
  };
  add(exact?.query?.pages?.[0], -1);
  for (const p of (found?.query?.pages || []).sort((a, b) => (a.index || 0) - (b.index || 0))) add(p, p.index || 0);
  return pages;
}

/** Which of these exact titles (or redirects, like "polar molecule" → "Chemical polarity") have an article. */
async function titles(list, lang) {
  const want = [...new Set((list || []).map((t) => String(t).trim()).filter(Boolean))].slice(0, 20);
  if (!want.length) return [];
  const j = await getJson(`${apiBase(lang)}&action=query&prop=description|pageprops|extracts&ppprop=disambiguation&exintro=1&explaintext=1&exsentences=3&exlimit=max&redirects=1&titles=${encodeURIComponent(want.join('|'))}`);
  // Follow Wikipedia's renames back to the phrase that was asked for ("polar molecule" → "Chemical polarity").
  const back = new Map();
  for (const n of j.query?.normalized || []) back.set(n.to, n.from);
  for (const r of j.query?.redirects || []) back.set(r.to, back.get(r.from) || r.from);
  return (j.query?.pages || [])
    .filter((p) => !p.missing && !p.invalid && !(p.pageprops && 'disambiguation' in p.pageprops))
    .map((p) => ({ title: p.title, description: p.description || '', intro: (p.extract || '').trim(), disambiguation: false, rank: 0, phrase: String(back.get(p.title) || p.title).toLowerCase() }));
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

function register() {
  ipcMain.handle('lookup:search', (_e, query, lang) => search(query, lang));
  ipcMain.handle('lookup:article', (_e, title, lang) => article(title, lang));
  ipcMain.handle('lookup:titles', (_e, list, lang) => titles(list, lang));
}

module.exports = { register };
