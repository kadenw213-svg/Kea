import { api, WikiCandidate, WikiPage, DictEntry, AiEvent } from './api';
import { setting } from './settings';

/**
 * Encyclopedia: explains terms with Wikipedia's own words and defines words with an offline dictionary.
 *
 * Nothing shown is written by a model. Code finds the article and shows its text word for word. The local model
 * (when it's downloaded and allowed) only acts as a librarian: when a term has several meanings it picks the article
 * that fits what you're reading, by answering with an option number. Sections are chosen by matching words.
 */

export interface ExplainResult {
  term: string;
  page: WikiPage;
  /** The article's opening paragraph: Wikipedia's own definition. */
  definition: string;
  /** The rest of the introduction. */
  more: string;
  /** The sections that fit what you're reading, in article order. */
  sections: { title: string; text: string }[];
  /** Other articles the term could mean (click to switch). */
  others: WikiCandidate[];
  lang: string;
}

export const lookupLang = () => String(setting('lookup.lang') || 'en');

// ---------- Text helpers ----------
const STOP = new Set(
  'a an the and or but if of to in on at for with by from as is are was were be been being it its this that these those which who whom what how why when where can could should would will shall may might must do does did not no than then so such into onto about also more most some any each every many much while because often like well made make makes take takes used use uses other there their they them he she his her we our you your i me my one two all very just only over under between through during before after above below up down out off again further once here both few own same too s t'.split(
    ' '
  )
);
/** A word's rough stem, so "organisms" matches "organism" and "producing" matches "produce". */
const stem = (w: string) => (w.length > 4 ? w.replace(/ies$/, 'y').replace(/(ing|ed|es|s)$/, '') : w);
const words = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((w) => w.length > 2 && !STOP.has(w)).map(stem);
/** The most frequent content words of a text (what it's about). */
function keywords(text: string, n = 40) {
  const f = new Map<string, number>();
  for (const w of words(text)) f.set(w, (f.get(w) || 0) + 1);
  return new Set([...f.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([w]) => w));
}
const overlap = (text: string, keys: Set<string>) => new Set(words(text).filter((w) => keys.has(w))).size;
const bare = (t: string) => t.toLowerCase().replace(/\s*\([^)]*\)\s*$/, '').trim();

/** Wikipedia's plain text keeps some markup leftovers (maths, empty brackets); tidy them without changing words. */
export function tidy(text: string) {
  let t = text;
  // {\displaystyle …} maths blocks (balanced braces).
  for (let i = t.indexOf('{\\displaystyle'); i >= 0; i = t.indexOf('{\\displaystyle')) {
    let depth = 0;
    let j = i;
    for (; j < t.length; j++) {
      if (t[j] === '{') depth++;
      else if (t[j] === '}' && --depth === 0) break;
    }
    t = t.slice(0, i) + t.slice(j + 1);
  }
  return t
    .replace(/\(\s*[;,]?\s*\)/g, '')
    .replace(/\(\s*;\s*/g, '(')
    .replace(/[ \t]+([,.;:])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
const paragraphs = (t: string) => tidy(t).split(/\n+/).map((p) => p.trim()).filter(Boolean);

/** The words around the highlight in the document, so the right meaning can be picked ("cell" in biology). */
export function contextAround(full: string, selection: string, chars = 1500) {
  if (!full) return selection;
  const i = selection ? full.indexOf(selection.slice(0, 80)) : -1;
  if (i < 0) return full.slice(0, chars * 2);
  return full.slice(Math.max(0, i - chars), i + selection.length + chars);
}

// ---------- The librarian (optional local model) ----------
let readyCache: { at: number; ok: boolean } | null = null;
async function modelReady() {
  if (setting('lookup.useModel') === false) return false;
  if (readyCache && Date.now() - readyCache.at < 30000) return readyCache.ok;
  const st = await api.ai.state().catch(() => null);
  const ok = !!st?.models.find((m) => m.tier === st.settings.tier)?.installed;
  readyCache = { at: Date.now(), ok };
  return ok;
}

/** Ask the model to choose among numbered options. It can only answer with option numbers (JSON schema). */
async function choose(prompt: string, schema: any, maxTokens: number): Promise<any | null> {
  if (!(await modelReady())) return null;
  try {
    const id = await api.ai.generate({
      system: 'You are a careful librarian. You only choose from the numbered options you are given. Reply only with the JSON.',
      prompt,
      jsonSchema: schema,
      temperature: 0,
      maxTokens
    });
    const text = await new Promise<string>((resolve, reject) => {
      // A slow model never holds up a lookup for long: after 25 s (time to load it) word matching decides instead.
      const timer = setTimeout(() => (off(), api.ai.stop(id), reject(new Error('slow'))), 25000);
      const off = api.ai.onEvent((e: AiEvent) => {
        if (e.id !== id || e.type === 'token') return;
        clearTimeout(timer);
        off();
        if (e.type === 'done') resolve(e.text);
        else reject(new Error(e.message));
      });
    });
    return JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || 'null');
  } catch {
    return null;
  }
}

/** Load the model in the background when the panel opens, so a close call doesn't wait for it to load. */
export async function warmUp() {
  if (await modelReady()) api.ai.count('warm up').catch(() => {});
}

// ---------- Picking the article ----------
/** Rank the search results for a term: exact title first, then fit with what you're reading, then Wikipedia's order. */
/**
 * The term as it's used in the reading: "polar" in "polar molecules", "respiration" in "cellular respiration".
 * These phrases often name the right article directly (Wikipedia's search for the bare word may not even list it).
 */
function phrasesInText(term: string, context: string): { phrase: string; head: boolean }[] {
  const esc = term.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const out = new Map<string, boolean>();
  const re = new RegExp(`(?:\\b([\\p{L}-]+)\\s+)?\\b${esc}\\b(?:\\s+([\\p{L}-]+))?`, 'giu');
  for (const m of context.matchAll(re)) {
    const [hit, prev, next] = m;
    const word = hit.replace(prev ? `${prev} ` : '', '').replace(next ? ` ${next}` : '', '').trim();
    const ok = (w?: string) => !!w && w.length > 2 && !STOP.has(w.toLowerCase());
    // "cell membrane" for "membrane": the term is the head word, so the phrase names a kind of it (strong).
    if (ok(prev)) out.set(`${prev} ${word}`.toLowerCase(), true);
    // "cell membrane" for "cell": the term only describes something else (weak).
    if (ok(next)) {
      const k = `${word} ${next}`.toLowerCase();
      if (!out.has(k)) out.set(k, false);
      if (/s$/i.test(next!) && !out.has(k.slice(0, -1))) out.set(k.slice(0, -1), false);
    }
    if (out.size >= 12) break;
  }
  return [...out].map(([phrase, head]) => ({ phrase, head }));
}

async function pickArticle(term: string, searched: WikiCandidate[], context: string, lang: string) {
  // Add articles named by the term's phrases in the reading.
  const phrases = phrasesInText(term, context);
  const fromText = phrases.length ? await api.lookup.titles(phrases.map((p) => p.phrase), lang).catch(() => [] as WikiCandidate[]) : [];
  // Which phrases name the concept: for a noun the ones it ends ("cell membrane" for "membrane"); for an adjective
  // the ones it starts ("polar molecules" for "polar"). The offline dictionary tells which the term is.
  const adjective = (await api.lookup.define(term, 1).catch(() => null))?.entries[0]?.pos === 'adjective';
  const strong = new Set(phrases.filter((p) => p.head !== adjective).map((p) => p.phrase));
  const headTitle = new Set(fromText.filter((c) => strong.has(c.phrase || bare(c.title))).map((c) => c.title));
  const inText = new Set(fromText.map((c) => c.title));
  const cands = [...searched, ...fromText.filter((c) => !searched.some((s) => s.title === c.title))];
  const usable = cands.filter((c) => !c.disambiguation && !/^(list|lists|index|outline|glossary) of /i.test(c.title));
  if (!usable.length) return null;
  const t = bare(term);
  const termWords = new Set(words(term));
  // What the reading is about, minus the term itself (every candidate shares that).
  const keys = new Set([...keywords(context, 60)].filter((w) => !termWords.has(w)));
  const score = (c: WikiCandidate, i: number) => {
    const title = bare(c.title);
    const qualifier = c.title.match(/\(([^)]*)\)\s*$/)?.[1] || '';
    // rank −1: Wikipedia's own page for exactly this term (directly or by redirect, like "ATP").
    // An article that opens "Adenosine triphosphate (ATP) is…" is the one for "ATP".
    const abbrev = c.intro.toLowerCase().startsWith(title) && new RegExp(`^.{0,${title.length + 12}}\\(${term.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[),;]`, 'i').test(c.intro);
    const exact = c.rank === -1 || abbrev || title === t || title === t.replace(/s$/, '') || `${title}s` === t;
    const fits = words(title).every((w) => termWords.has(w));
    // "Nucleus (neuroanatomy)" is one meaning of several: an exact title counts fully only without a qualifier.
    const base = exact ? (qualifier ? 2.5 : 4) : fits ? 2 : 0;
    const titleFit = Math.min(2, words(title).filter((w) => !termWords.has(w) && keys.has(w)).length) + Math.min(1.5, overlap(qualifier, keys) * 1.5);
    // Books, films, bands, companies… rarely what a reader means, unless the reading is about them.
    const work = /\b(book|novel|film|movie|album|song|single|band|television|series|video game|magazine|newspaper|company|brand|footballer|politician|actor|actress|singer|rapper|character)\b/i.test(c.description) && !overlap(c.description, keys) ? -2 : 0;
    return work + base + titleFit +(headTitle.has(c.title) ? 4.5 : inText.has(c.title) ? 1 : 0) + Math.min(3, overlap(`${c.description} ${c.description} ${c.intro}`, keys) * 0.5) + 1 / (2 + i);
  };
  const ranked = usable.map((c, i) => ({ c, s: score(c, i) })).sort((a, b) => b.s - a.s);
  let best = ranked[0].c;
  // A near-tie (word matching can't tell the meanings apart): let the librarian break it, if it's available.
  const close = ranked.length > 1 && ranked[1].s > ranked[0].s - 0.6;
  if (close && context.trim()) {
    const opts = ranked.slice(0, 6);
    const j = await choose(
      `Someone reading this text highlighted "${term}" and wants it explained.
Text around it:
"""
${context.slice(0, 1200)}
"""
Which Wikipedia article is about the meaning of "${term}" used in that text?
${opts.map((o, i) => `${i + 1}. ${o.c.title}: ${o.c.description || o.c.intro.slice(0, 140)}`).join('\n')}`,
      { type: 'object', properties: { article: { enum: opts.map((_, i) => i + 1) } } },
      20
    );
    const n = Number(j?.article);
    if (n >= 1 && n <= opts.length) best = opts[n - 1].c;
  }
  return { best, others: ranked.map((r) => r.c).filter((c) => c !== best).slice(0, 5) };
}

// ---------- Picking the sections ----------
function pickSections(page: WikiPage, term: string, context: string): { title: string; text: string }[] {
  const n = Math.max(0, Math.min(6, Number(setting('lookup.sections') ?? 2)));
  if (!n) return [];
  const all = page.sections.filter((s) => s.text.length > 120).slice(0, 40);
  if (!all.length) return [];
  const keys = new Set([...keywords(context, 30), ...words(term)]);
  // Sections that explain (structure, function, how it works) beat ones about culture, trivia or records.
  const explains = (t: string) => (/\b(structure|function|process|mechanism|overview|definition|properties|types|kinds|role|description|formation|characteristics|uses|applications|principle|theory|causes|effects|composition|stages|steps)\b/i.test(t) ? 1.5 : 0) - (/\b(culture|media|fiction|society|trivia|records?|tournaments?|in art|legacy|popular|economics|gallery|filmography|discography)\b/i.test(t) ? 1.5 : 0);
  const scored = all.map((s, i) => ({ s, i, score: overlap(`${s.title} ${s.title} ${s.text.slice(0, 900)}`, keys) * 0.6 + explains(s.title) - i * 0.08 }));
  // Matched by words (instant): the sections that talk most about what you're reading and the term itself.
  const chosen = [...scored].sort((a, b) => b.score - a.score).slice(0, n).map((x) => x.s);
  return all.filter((s) => chosen.includes(s)).map((s) => ({ title: s.title, text: paragraphs(s.text).join('\n\n') }));
}

function shape(term: string, page: WikiPage, sections: ExplainResult['sections'], others: WikiCandidate[], lang: string): ExplainResult {
  const lead = paragraphs(page.lead);
  // The opening paragraph is Wikipedia's definition; a very short first line (a note or coordinates) joins the next.
  const first = lead[0] && lead[0].length < 60 && lead[1] ? 2 : 1;
  return { term, page, definition: lead.slice(0, first).join('\n\n'), more: lead.slice(first).join('\n\n'), sections, others, lang };
}

/** Explain a term from Wikipedia: the right article for what you're reading, its definition and its most useful sections. */
export async function explainTerm(term: string, context: string, onStatus: (s: string) => void, forceTitle?: string): Promise<ExplainResult | null> {
  const lang = lookupLang();
  onStatus('Searching Wikipedia…');
  // Search the term, and the term with the reading's main words ("capital" + "trade machines"), which finds the
  // meaning used in the reading when the bare word's results are about something else.
  const termStems = new Set(words(term));
  const freq = new Map<string, number>();
  for (const w of (context.toLowerCase().match(/[\p{L}]+/gu) || []).filter((w) => w.length > 3 && !STOP.has(w) && !termStems.has(stem(w)))) freq.set(w, (freq.get(w) || 0) + 1);
  const about = [...freq.entries()].sort((x, y) => y[1] - x[1]).slice(0, 2).map(([w]) => w);
  const [plain, withContext] = await Promise.all([
    api.lookup.search(forceTitle || term, lang),
    !forceTitle && about.length ? api.lookup.search(`${term} ${about.join(' ')}`, lang).catch(() => [] as WikiCandidate[]) : Promise.resolve([] as WikiCandidate[])
  ]);
  // Only results that name the term itself: the rest are about the reading's topic, not the word.
  const named = (c: WikiCandidate) => words(c.title).some((w) => termStems.has(w));
  const cands = [...plain, ...withContext.filter((c) => named(c) && !plain.some((p) => p.title === c.title))];
  const pick = forceTitle ? { best: cands.find((c) => c.title === forceTitle) || cands[0], others: cands.filter((c) => c.title !== forceTitle && !c.disambiguation).slice(0, 5) } : await pickArticle(term, cands, context, lang);
  if (!pick?.best) return null;
  onStatus(`Reading “${pick.best.title}”…`);
  const page = await api.lookup.article(pick.best.title, lang);
  if (!page) return null;
  const sections = pickSections(page, term, context);
  return shape(term, page, sections, pick.others, lang);
}

/** The same topic from Simple English Wikipedia (shorter sentences, everyday words), when it has an article. */
export async function explainSimpler(r: ExplainResult, context: string, onStatus: (s: string) => void): Promise<ExplainResult | null> {
  onStatus('Looking in Simple English Wikipedia…');
  const cands = await api.lookup.search(r.page.title, 'simple');
  const hit = cands.find((c) => bare(c.title) === bare(r.page.title)) || cands.find((c) => bare(c.title) === bare(r.term));
  if (!hit || hit.disambiguation) return null;
  const page = await api.lookup.article(hit.title, 'simple');
  if (!page) return null;
  return shape(r.term, page, pickSections(page, r.term, context), [], 'simple');
}

/**
 * What to explain in a highlight: a short highlight is the term itself; for a longer passage the librarian picks up
 * to three key terms that appear in it word for word (or, without the model, its most distinctive words).
 */
export async function termsIn(selection: string): Promise<string[]> {
  const text = selection.replace(/\s+/g, ' ').trim().replace(/^[“"'(]+|[”"').,;:!?]+$/g, '');
  if (text.split(' ').length <= 6) return [text];
  const j = await choose(
    `Which terms or concepts in this passage would a student most likely need explained? Copy up to 3 of them exactly as written (1–4 words each).
"""
${text.slice(0, 1500)}
"""`,
    { type: 'object', properties: { terms: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', maxLength: 60 } } } },
    60
  );
  const lower = text.toLowerCase();
  const picked = (Array.isArray(j?.terms) ? j.terms : []).map((t: any) => String(t).trim()).filter((t: string) => t.length > 2 && lower.includes(t.toLowerCase()));
  if (picked.length) return [...new Set<string>(picked)];
  // Without the model: the passage's longest distinctive words.
  return [...new Set(words(text).filter((w) => w.length > 6))].sort((a, b) => b.length - a.length).slice(0, 2);
}

/** Offline dictionary (WordNet): definitions, examples, synonyms and antonyms. */
export async function defineWord(word: string): Promise<DictEntry | null> {
  const w = word.replace(/\s+/g, ' ').trim().replace(/^[“"'(]+|[”"').,;:!?]+$/g, '');
  return api.lookup.define(w, Number(setting('lookup.dictSenses')) || 5);
}
