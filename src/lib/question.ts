import { api, WikiCandidate, WikiPage } from './api';
import { setting } from './settings';
import { words, STOP, keywords, overlap, paragraphs, sameTerm, choose, termPattern, lookupLang, untex } from './lookup';

/**
 * Questions, fill-in-the-blanks and maths: the whole Wikipedia passages that explain what a highlight asks.
 *
 * Nothing shown is written by a model. The local model is small, so it's only given small, closed jobs:
 *  - for one part of a question at a time, a couple of likely answers and article names, used only as search words
 *    (never shown; a passage counts only when Wikipedia's own sentences confirm it);
 *  - choosing among numbered options code has already checked (which rule applies, which passages fit best).
 * Code does the rest: finding articles, cutting them into whole passages (never mid-paragraph) and checking them.
 * Maths gets the rules and formulas that apply (typeset), with Wikipedia's explanation, never a worked answer.
 */

export interface AnswerPassage {
  title: string;
  url: string;
  section: string;
  /** Whole paragraphs, word for word (separated by blank lines); equations kept as LaTeX between  and . */
  text: string;
  /** Words from the question to show in bold. */
  marks: string[];
  /** The sentence that holds the answer, when Wikipedia's text confirms it (underlined). */
  answer: string;
  edited: string | null;
}
export interface AnswerPart {
  /** The part as the question writes it (empty when the question has one part); parts answered by the same passage share one. */
  label: string;
  passages: AnswerPassage[];
  /** Answered by an earlier part's passage, which already names it: not shown again. */
  hidden?: boolean;
  /** Nothing answers it: the closest article, to open in full. */
  closest?: string;
  done: boolean;
}
export interface AnswerResult {
  question: string;
  parts: AnswerPart[];
  lang: string;
}

// ---------- What kind of highlight ----------
const BLANK = /_{2,}|…{2,}|\.{5,}/;
const ASKS = /^(what|why|how|which|when|where|who|whom|whose|explain|describe|compare|contrast|calculate|determine|identify|state|list|name|predict|discuss|outline|define|justify|evaluate|suggest|give|is|are|does|do|can)\b/i;
const TASK = /^(explain|describe|compare|contrast|calculate|determine|identify|state|list|name|predict|discuss|outline|define|justify|evaluate|suggest|give|solve|simplify|find|compute|show|prove)\b/i;
/** Words that ask rather than say what the question is about. */
const ASKING = new Set(
  'what why how which when where who explain describe compare contrast calculate determine identify state list name predict discuss outline define justify evaluate suggest give following question answer briefly role function involved involve keeps keep maintenance maintain maintains helps help plays play responsible important allows provides called known process solve simplify find compute show prove value'
    .split(' ')
    .flatMap((w) => words(w))
);
const marker = /(?:^|\s)\(?([a-h]|[1-9])[).]\s+/g;
const partMarkers = (t: string) => [...t.matchAll(marker)];

/** Maths: an expression or equation, or a calculation to do. */
export function isMath(t: string) {
  if (/∫|∑|∏|√|∂|\bd\/d[a-z]\b|\blim\b|\bdy\/dx\b/.test(t)) return true;
  const symbols = (t.match(/[=+*/^√±×÷²³<>≤≥≠]|(?<=[\w)\s])-(?=[\s\w(])/g) || []).length;
  const longWords = (t.match(/\p{L}{4,}/gu) || []).length;
  if (symbols >= 2 && /\d|\b[a-z]\b/i.test(t) && longWords <= 8) return true;
  return /\b(solve|simplify|factori[sz]e|factor|differentiate|integrate|evaluate|expand|derivative|integral|calculate|compute)\b/i.test(t) && /\d|[=^]/.test(t);
}

export type Highlight = { kind: 'term'; term: string } | { kind: 'question' } | { kind: 'math' } | { kind: 'passage' };

/** A term, a question (or fill-in-the-blank), maths, or a passage of reading. */
export function classify(text: string): Highlight {
  const t = text.replace(/\s+/g, ' ').trim();
  const blank = BLANK.test(t);
  if (t.length <= 600 && !blank && isMath(t)) return { kind: 'math' };
  // "What is osmosis?", "Define molality": the term itself, explained in full.
  if (!blank && setting('lookup.qBroad') !== false) {
    const m = t.match(/^(?:what\s+(?:is|are|was|were|does)|define|explain|describe)\s+(?:an?\s+|the\s+)?(.+?)(?:\s+mean)?\s*[?.!]?$/i);
    const x = m?.[1].trim();
    if (x && x.split(' ').length <= 4 && x.split(' ').every((w) => !STOP.has(w.toLowerCase()) && !ASKS.test(w))) return { kind: 'term', term: x };
  }
  if (t.length > 1500) return { kind: 'passage' };
  const ms = partMarkers(t);
  const lettered = ms.length >= 2 && /^[a1]$/i.test(ms[0][1]);
  // (A sentence of reading can start with "When" or "How"; only an instruction counts without a question mark.)
  if (blank || /\?/.test(t) || (TASK.test(t) && t.split(' ').length > 3) || lettered) return { kind: 'question' };
  return t.split(' ').length <= 6 ? { kind: 'term', term: t } : { kind: 'passage' };
}

// ---------- Its parts ----------
interface Part {
  label: string;
  /** The words this part asks about (with the shared subject and stem). */
  text: string;
  /** Its own words, without the subject. */
  clause: string;
}

/**
 * "Chloride (Cl⁻) – keeps acid-____ balance, maintenance of ____ pressure, …": one part per blank, each with the
 * subject before the dash. "… a. … b. …": one part per letter, each with the question's opening.
 */
function splitParts(q: string): Part[] {
  const t = q.replace(/\s+/g, ' ').trim();
  const ms = partMarkers(t);
  if (ms.length >= 2 && /^[a1]$/i.test(ms[0][1])) {
    const stem = t.slice(0, ms[0].index).trim();
    return ms.map((m, i) => {
      const clause = t.slice(m.index! + m[0].length, ms[i + 1]?.index ?? t.length).trim();
      return { label: clause, text: `${stem} ${clause}`, clause };
    });
  }
  if (BLANK.test(t)) {
    // The subject: what comes before a dash or colon, when it has no blank of its own.
    const d = t.match(/^(.{2,80}?)\s*(?:\s[–—-]\s|:\s)/);
    let subject = d && !BLANK.test(d[1]) && d[1].split(' ').length <= 8 ? d[1] : '';
    const rest = subject ? t.slice(d![0].length) : t;
    const parts: Part[] = [];
    for (const seg of rest.split(/\s*[;,•]\s*|\s+[–—]\s+/)) {
      const s = seg.trim();
      if (!s) continue;
      // Words before the first blank ("During glycolysis, …") are part of every blank's subject.
      if (!parts.length && !BLANK.test(s)) subject = `${subject} ${s}`.trim();
      else if (BLANK.test(s) || !parts.length) parts.push({ label: s, text: `${subject} ${s}`, clause: s });
      else Object.assign(parts[parts.length - 1], { label: `${parts[parts.length - 1].label}, ${s}`, clause: `${parts[parts.length - 1].clause} ${s}`, text: `${parts[parts.length - 1].text} ${s}` });
    }
    if (parts.length > 1) return parts.slice(0, 8);
  }
  return [{ label: '', text: t, clause: t }];
}

// ---------- Matching words ----------
/** A word's stem, with British and American spellings meeting ("vapour"/"vapor", "haemoglobin"/"hemoglobin"). */
const norm = (w: string) => w.replace(/ae|oe/g, 'e').replace(/our$/, 'or');
/** "CO₂" and "CO2" alike. */
const plainDigits = (s: string) => s.replace(/[₀-₉]/g, (c) => String(c.charCodeAt(0) - 0x2080)).replace(/[⁰¹²³⁴-⁹]/g, (c) => String('⁰¹²³⁴⁵⁶⁷⁸⁹'.indexOf(c)));
const keys = (s: string) => words(plainDigits(s)).map(norm);
/** The words a part asks about. */
const asks = (s: string) => new Set(keys(s.replace(BLANK, ' ')).filter((w) => !ASKING.has(w)));
const sentences = (p: string) => p.split(/(?<=[.!?])\s+(?=[\p{Lu}\p{N}“"(])/u);

// ---------- Searching ----------
interface Plan {
  guesses: string[];
  searches: string[];
}

/** The part's own words as a search ("Chloride acid balance"). */
function ownSearch(text: string) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of text.replace(BLANK, ' ').match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) || []) {
    const k = norm(words(w)[0] || '');
    if (!k || STOP.has(w.toLowerCase()) || ASKING.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(w);
  }
  return out.slice(0, 6).join(' ');
}

const cleanList = (a: any, maxWords: number) =>
  (Array.isArray(a) ? a : [])
    .map((s) => String(s).replace(/[^\p{L}\p{N}' ()+-]/gu, ' ').replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 1 && s.split(' ').length <= maxWords);

/**
 * What to search for one part. A small model does this best with one short question and a flat answer, so each part
 * is asked on its own: two likely answers and two article names at most. These are only search words, never shown.
 */
async function planPart(part: Part, whole: string, many: boolean): Promise<Plan> {
  const own = ownSearch(part.text);
  const plan: Plan = { guesses: [], searches: own ? [own] : [] };
  if (setting('lookup.qGuesses') === false) return plan;
  const j = await choose(
    `${many ? `From this question: "${whole.slice(0, 400)}"\nThis part: "${part.text.slice(0, 300)}"` : `Question: "${whole.slice(0, 700)}"`}
Give up to 2 short guesses at the answer (1-4 words each), and up to 2 Wikipedia article titles that would explain it, such as the name of the process, law or rule involved (1-5 words each).`,
    {
      type: 'object',
      properties: {
        guesses: { type: 'array', maxItems: 2, items: { type: 'string', maxLength: 40 } },
        articles: { type: 'array', maxItems: 2, items: { type: 'string', maxLength: 50 } }
      },
      required: ['guesses', 'articles']
    },
    90,
    'You are a careful research librarian. You suggest search keywords only. Reply only with the JSON.'
  );
  return { guesses: cleanList(j?.guesses, 4).slice(0, 2), searches: [...new Set([...cleanList(j?.articles, 5).slice(0, 2), ...plan.searches])] };
}

// ---------- Passages ----------
interface Unit {
  page: WikiPage;
  section: string;
  /** As shown (equations kept as LaTeX). */
  paras: string[];
  /** As read (equations as text), for matching. */
  plain: string;
  order: number;
  /** Has an equation. */
  formula: boolean;
}

/** Starts by carrying on from the paragraph before ("This…", "As a result…"). */
const continues = (p: string) => /^(This|These|It|Its|Such|The resulting|In this|In turn|As a result|Thus|Therefore|Hence|Here)\b/.test(p);
/** A line of a list (short, no full stop). */
const listLine = (p: string) => p.length < 140 && !/[.!?]["”)]?$/.test(p);

/**
 * An article's passages: whole paragraphs, with the paragraphs that carry them on and the list they introduce, or a
 * whole section when its title names what's asked (or passages are set to whole sections).
 */
function passageUnits(page: WikiPage, titleKeys: Set<string>, dedicated: boolean): Unit[] {
  const whole = setting('lookup.qUnit') === 'section';
  const cont = setting('lookup.qContinue') !== false;
  const blocks = [{ title: '', paras: paragraphs(page.lead, true) }, ...page.sections.map((s) => ({ title: s.title, paras: paragraphs(s.text, true) }))];
  const pageWords = new Set(keys(page.title));
  const out: Unit[] = [];
  const make = (section: string, paras: string[], order: number): Unit => ({ page, section, paras, plain: untex(paras.join(' ')), order, formula: paras.some((p) => p.includes('')) });
  blocks.forEach((b, bi) => {
    if (!b.paras.length) return;
    const plain = b.paras.map(untex);
    const len = plain.join(' ').length;
    // A section titled with what's asked ("Relative lowering of vapour pressure"): most of its title's own words
    // (beyond the article's name, which every section of "Phases of ice" shares) are the question's.
    const own = keys(b.title).filter((w) => !pageWords.has(w));
    const named = own.length > 0 && own.filter((w) => titleKeys.has(w)).length / own.length >= 0.5;
    if (len <= 4000 && (whole || named || (dedicated && bi === 0 && len <= 2500))) {
      out.push(make(b.title, b.paras, bi * 1000));
      return;
    }
    for (let i = 0; i < b.paras.length; i++) {
      const start = i;
      let size = plain[i].length;
      while (i + 1 < b.paras.length && size < 2500) {
        const last = plain[i];
        const next = plain[i + 1];
        // (After "…the following list:", every short line is an item of it, even one that ends "etc.".)
        const item = listLine(next) || (/:$/.test(plain[start]) && next.length < 200);
        if (/:$/.test(last) || (item && (listLine(last) || /:$/.test(plain[start]))) || (cont && continues(next))) size += plain[++i].length;
        else break;
      }
      if (size >= 80) out.push(make(b.title, b.paras.slice(start, i + 1), bi * 1000 + start));
    }
  });
  return out;
}

/** The sentence as shown (with its equations as LaTeX) for one found in the passage's plain text. */
function shownSentence(u: Unit, plainSentence: string) {
  if (!plainSentence) return '';
  const shown = sentences(u.paras.join(' '));
  return shown.find((s) => untex(s) === plainSentence) || shown.find((s) => untex(s).startsWith(plainSentence.slice(0, 60))) || '';
}

interface Scored {
  u: Unit;
  score: number;
  answer: string;
  /** Has a sentence that confirms it (a guess with the question's words, or all of the question's words). */
  sure: boolean;
}

/**
 * Which passages answer the part. Code decides what may be shown: a passage must use the part's own words (most of
 * them, weighted by how rare each is in the article, and the subject), or have a sentence where a guess and the
 * part's words meet, which is Wikipedia confirming the guess.
 */
function scoreUnits(units: Unit[], part: Part, subject: Set<string>, plan: Plan, dedicated: Set<string>, subjectPage: string, reading: Set<string>): Scored[] {
  const hint = new Set(plan.guesses.concat(plan.searches).flatMap(keys));
  // A long question: its six key words (ones the searches share first, then the longest).
  const clause = [...asks(part.clause)]
    .filter((w) => !subject.has(w))
    .sort((a, b) => Number(hint.has(b)) - Number(hint.has(a)) || b.length - a.length)
    .slice(0, 6);
  const all = asks(part.text);
  const unitKeys = units.map((u) => new Set(keys(u.plain)));
  const df = (w: string) => unitKeys.filter((k) => k.has(w)).length;
  const idf = new Map(clause.map((w) => [w, Math.log(1 + units.length / (1 + df(w)))]));
  const total = clause.reduce((s, w) => s + idf.get(w)!, 0) || 1;
  const guessRes = plan.guesses.map((g) => termPattern(plainDigits(g)));
  const guessIn = (s: string) => guessRes.some((re) => ((re.lastIndex = 0), re.test(plainDigits(s))));
  // An article named exactly like a search ("Chloride shift") that has all of the part's words and a guess somewhere:
  // Wikipedia confirms it's the right article even when no single sentence has them together.
  const pageOk = new Map<string, boolean>();
  for (const p of new Set(units.map((u) => u.page))) {
    const text = [p.lead, ...p.sections.map((s) => s.text)].join(' ');
    const pk = new Set(keys(text));
    pageOk.set(p.title, dedicated.has(p.title) && clause.every((w) => pk.has(w)) && guessIn(text));
  }
  const out: Scored[] = [];
  units.forEach((u, i) => {
    const k = unitKeys[i];
    const text = u.plain;
    const has = clause.filter((w) => k.has(w));
    const cover = clause.length ? has.reduce((s, w) => s + idf.get(w)!, 0) / total : 1;
    // The subject ("Chloride") has to be what the article is about: in its title or introduction.
    const aboutSubject = !subject.size || [...subject].some((w) => keys(u.page.title).includes(w) || keys(u.page.lead).includes(w));
    // A guess in the same sentence as most of the part's own words.
    const need = Math.max(1, Math.ceil(clause.length / 2));
    let proof = '';
    for (const s of sentences(text)) {
      const sk = new Set(keys(s));
      const hits = clause.filter((w) => sk.has(w)).length;
      if (hits >= need && guessIn(s)) {
        proof = s;
        break;
      }
    }
    // Otherwise the sentence that holds all of the part's own words (two or more), if one does.
    const answer = proof || (clause.length >= 2 ? sentences(text).find((s) => clause.every((w) => keys(s).includes(w))) || '' : '');
    const inPage = !!pageOk.get(u.page.title) && has.length >= 1 && guessIn(text);
    const ok = aboutSubject && (proof || (cover >= 0.6 && has.length >= Math.min(2, clause.length)) || inPage);
    if (!ok) return;
    const words100 = text.split(/\s+/).length / 100;
    const hits = keys(text).filter((w) => all.has(w) || hint.has(w)).length;
    const score =
      cover * 6 +
      (proof ? 4 : answer ? 1.5 : inPage ? 1 : 0) +
      (u.section && keys(u.section).some((w) => all.has(w) || hint.has(w)) ? 1.5 : 0) +
      (dedicated.has(u.page.title) ? 2 + (u.order === 0 ? 1 : 0) : 0) +
      (u.page.title === subjectPage ? 1.5 : 0) +
      // What the document is about ("blood", "plasma"): the passage on chloride in the body, not in drilling mud.
      Math.min(1.5, overlap(text, reading) * 0.15) +
      // A formula that goes with the explanation (a calculation question).
      (u.formula && /\b(calculat|comput|formula|equation|how (much|many))/i.test(part.text) ? 1.5 : 0) +
      Math.min(2, (hits / Math.max(1, words100)) * 0.25) -
      u.order * 0.00002;
    out.push({ u, score, answer: shownSentence(u, answer), sure: !!proof || !!answer });
  });
  const sorted = out.sort((a, b) => b.score - a.score);
  // When the best passage is confirmed by its own words, the others have to be too.
  return sorted[0]?.sure ? sorted.filter((s) => s.sure) : sorted;
}

/** The librarian chooses among passages that already passed: which explain the answer, best first. */
async function pickPassages(scored: Scored[], n: number, asked: string, what: string): Promise<Scored[]> {
  // More than one passage only when the others fit nearly as well.
  const top = scored.slice(0, n).filter((s, k) => k === 0 || s.score >= scored[0].score - 2.5);
  if (scored.length < 2 || (scored.length <= n && scored[1].score <= scored[0].score - 1.5)) return top;
  const opts = scored.slice(0, 5);
  const j = await choose(
    `${asked}
Which of these Wikipedia passages ${what}? Choose the best ones, best first (up to ${n}).
${opts.map((o, k) => `${k + 1}. [${o.u.page.title}${o.u.section ? ` › ${o.u.section}` : ''}] ${o.u.plain.slice(0, 350)}`).join('\n')}`,
    { type: 'object', properties: { passages: { type: 'array', minItems: 1, maxItems: n, items: { enum: opts.map((_, k) => k + 1) } } }, required: ['passages'] },
    30
  );
  const ks = [...new Set((Array.isArray(j?.passages) ? j.passages : []).map(Number).filter((k: number) => k >= 1 && k <= opts.length))] as number[];
  return ks.length ? ks.map((k) => opts[k - 1]) : top;
}

/** In the order you'd read them: article by article (the best one first), then as each article has them. */
function readingOrder(list: Scored[]) {
  const byPage = [...new Set(list.map((s) => s.u.page.title))];
  return [...list].sort((a, b) => byPage.indexOf(a.u.page.title) - byPage.indexOf(b.u.page.title) || a.u.order - b.u.order);
}
const toPassage = (s: Scored, marks: string[]): AnswerPassage => ({ title: s.u.page.title, url: s.u.page.url, section: s.u.section, text: s.u.paras.join('\n\n'), marks, answer: s.answer, edited: s.u.page.edited });

function reader(lang: string) {
  const pages = new Map<string, Promise<WikiPage | null>>();
  return (t: string) => {
    if (!pages.has(t)) pages.set(t, api.lookup.article(t, lang).catch(() => null));
    return pages.get(t)!;
  };
}

// ---------- Answering a question ----------
/**
 * Find the passages that answer each part of a highlighted question. `onUpdate` gets the result so far whenever a
 * part is ready, so the panel can show it straight away.
 */
export async function answerQuestion(question: string, context: string, onStatus: (s: string) => void, onUpdate: (r: AnswerResult) => void): Promise<AnswerResult> {
  const lang = lookupLang();
  const q = question.replace(/\s+/g, ' ').trim();
  const parts = splitParts(q);
  const many = parts.length > 1;
  const result: AnswerResult = { question: q, parts: parts.map((p) => ({ label: many ? p.label : '', passages: [], done: false })), lang };
  const update = () => onUpdate({ ...result, parts: result.parts.map((p) => ({ ...p })) });
  update();
  const subjectText = many && parts[0].text !== parts[0].clause ? parts[0].text.slice(0, parts[0].text.length - parts[0].clause.length) : '';
  const subject = asks(subjectText);
  // The article on the shared subject ("Chloride"), which every part is about.
  const subjectTitle = (subjectText.replace(/\([^)]*\)/g, ' ').match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) || []).filter((w) => !STOP.has(w.toLowerCase()) && !ASKING.has(norm(words(w)[0] || ''))).join(' ');
  const subjectPage = subjectTitle ? (await api.lookup.titles([subjectTitle], lang).catch(() => [] as WikiCandidate[]))[0]?.title || '' : '';
  const readingKeys = new Set([...keywords(plainDigits(context), 20)].map(norm));
  const read = reader(lang);
  const found = new Map<string, Promise<WikiCandidate[]>>();
  const find = (s: string) => {
    if (!found.has(s)) found.set(s, api.lookup.find(s, lang, 5).catch(() => []));
    return found.get(s)!;
  };
  const n = Math.max(1, Math.min(4, Number(setting('lookup.qPassages') ?? 2)));
  // Which part first showed each paragraph.
  const shown = new Map<string, number>();

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    onStatus(many ? `Working out part ${i + 1} of ${parts.length}…` : 'Working out what to look for…');
    const plan = await planPart(part, q, many);
    onStatus(many ? `Searching Wikipedia for part ${i + 1} of ${parts.length}…` : 'Searching Wikipedia…');
    const searches = plan.searches.slice(0, 3);
    // Articles named exactly like a search or a longer guess ("Chloride shift"): the most focused source.
    const tries = setting('lookup.qDedicated') !== false ? [...new Set([...searches, ...plan.guesses.filter((g) => g.split(' ').length > 1)])] : [];
    const [results, exact] = await Promise.all([Promise.all(searches.map(find)), tries.length ? api.lookup.titles(tries, lang).catch(() => [] as WikiCandidate[]) : Promise.resolve([] as WikiCandidate[])]);
    const dedicated = new Set(exact.filter((c) => c.title !== subjectPage).map((c) => c.title));
    // This part's candidate articles, best fit first.
    const want = new Set([...asks(part.text), ...plan.guesses.flatMap(keys), ...searches.flatMap(keys)]);
    const cands = new Map<string, number>();
    results.forEach((list) => list.forEach((c, r) => cands.set(c.title, Math.max(cands.get(c.title) ?? -99, overlap(`${c.title} ${c.description} ${c.intro}`, want) + (5 - r) * 0.3 + overlap(c.intro, readingKeys) * 0.2))));
    exact.forEach((c) => cands.set(c.title, (cands.get(c.title) ?? 0) + overlap(`${c.title} ${c.intro}`, want) + 2));
    const titles = [...cands.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t).filter((t) => t !== subjectPage).slice(0, 3);
    if (subjectPage) titles.push(subjectPage);
    onStatus(many ? `Reading for part ${i + 1} of ${parts.length}…` : 'Finding the passages that answer it…');
    const fetched = (await Promise.all(titles.map(read))).filter((p): p is WikiPage => !!p);
    const titleKeys = new Set([...plan.guesses, ...searches].flatMap(keys).concat([...asks(part.clause)]));
    const units = fetched.flatMap((p) => passageUnits(p, titleKeys, dedicated.has(p.title)));
    const scored = scoreUnits(units, part, subject, plan, dedicated, subjectPage, readingKeys);
    const picked = await pickPassages(scored, n, `A student is answering this question with Wikipedia:\n"${(many ? part.text : q).slice(0, 500)}"`, 'explain the answer');
    const res = result.parts[i];
    const fresh = picked.filter((s) => !s.u.paras.some((p) => shown.has(p)));
    const earlier = picked[0] && shown.get(picked[0].u.paras[0]);
    if (!fresh.length && earlier !== undefined) {
      // Answered by a passage already shown: that part's heading names this one too, and it isn't repeated.
      result.parts[earlier].label = `${result.parts[earlier].label} · ${res.label}`;
      res.hidden = true;
    } else {
      const marks = [...new Set((part.clause.replace(BLANK, ' ').match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu) || []).filter((w) => w.length > 3 && !STOP.has(w.toLowerCase()) && !ASKING.has(norm(words(w)[0] || ''))))].sort((a, b) => b.length - a.length).slice(0, 4);
      res.passages = readingOrder(fresh).map((s) => toPassage(s, marks));
      fresh.forEach((s) => s.u.paras.forEach((p) => shown.set(p, i)));
      if (!res.passages.length) res.closest = titles[0] || fetched[0]?.title;
    }
    res.done = true;
    update();
  }
  return result;
}

// ---------- Maths ----------
/**
 * The topics a piece of maths needs, most useful first, recognised by code from its symbols and words. The general
 * article comes first (the one to fall back on without the model), then the specific rules the librarian can choose.
 */
/**
 * A polynomial of one of these degrees: a variable raised to the power ("x^2", "x²", or "x2" from a PDF) that also
 * appears on its own ("5x"), so "x^2 + 5x + 6" counts but a named formula like "E = mc^2" doesn't.
 */
function polynomialOf(t: string, degrees: number[]) {
  const sup = '⁰¹²³⁴⁵⁶⁷⁸⁹';
  for (const m of t.matchAll(/(?<![\p{L}])([a-z])\s*(?:\^\s*\(?(\d)|([²³⁴⁵⁶])|(\d)(?=\s*[+-]))/giu)) {
    const power = Number(m[2] ?? m[4] ?? sup.indexOf(m[3]));
    if (!degrees.includes(power)) continue;
    const rest = t.slice(0, m.index) + ' ' + t.slice(m.index! + m[0].length);
    if (new RegExp(`(?<![\\p{L}^])\\d*${m[1]}(?![\\p{L}²³⁴⁵⁶^]|\\d)`, 'iu').test(rest)) return true;
  }
  return false;
}

const MATH_TOPICS: [RegExp | ((t: string) => boolean), string[]][] = [
  [/∫|\bintegra(l|te|tion)\b|\bantiderivative/i, ['Integral', 'Lists of integrals', 'Integration by parts', 'Integration by substitution']],
  [/\bd\/d[a-z]\b|\bdy\/dx\b|\bderivative|\bdifferentiat|\b[fgh]'\s*\(/i, ['Differentiation rules', 'Derivative', 'Power rule', 'Chain rule', 'Product rule', 'Quotient rule']],
  [/\blim\b|\blimit\b/i, ['Limit of a function', "L'Hôpital's rule"]],
  [/\b(sin|cos|tan|sec|csc|cot|arcsin|arccos|arctan)\b|θ|\btrig/i, ['List of trigonometric identities', 'Trigonometric functions', 'Inverse trigonometric functions']],
  [/\b(log|ln)\b|logarithm/i, ['List of logarithmic identities', 'Logarithm']],
  [(t) => /\bquadratic/i.test(t) || polynomialOf(t, [2]), ['Quadratic formula', 'Quadratic equation', 'Factorization', 'Completing the square']],
  [(t) => /\bpolynomial|\bcubic/i.test(t) || polynomialOf(t, [3, 4, 5, 6]), ['Polynomial', 'Polynomial long division', 'Rational root theorem', 'Factorization']],
  [/∑|Σ|\bseries\b|\bsequence\b|\bprogression\b/i, ['Series (mathematics)', 'Arithmetic progression', 'Geometric series', 'Summation']],
  [/\b\d+\s*[cp]\s*\d+\b|\bchoose\b|\bpermutation|\bcombination|\d!|\bfactorial/i, ['Combination', 'Permutation', 'Binomial coefficient', 'Factorial']],
  [/\bprobabilit|\bdice\b|\bcoin\b|\bodds\b/i, ['Probability', 'Conditional probability', 'Independence (probability theory)']],
  [/\bmean\b|\bmedian\b|\bstandard deviation|\bvariance\b/i, ['Standard deviation', 'Arithmetic mean', 'Median', 'Variance']],
  [/\bmatri(x|ces)|\bdeterminant/i, ['Matrix multiplication', 'Determinant', 'Matrix (mathematics)', 'Invertible matrix']],
  [/\bvector|\bdot product|\bcross product/i, ['Dot product', 'Cross product', 'Euclidean vector']],
  [/\bhypotenuse|\bright triangle|\bpythag/i, ['Pythagorean theorem']],
  [/\blaw of (sines|cosines)|\btriangle\b/i, ['Law of sines', 'Law of cosines', 'Triangle']],
  [/\bsystem of equations|\bsimultaneous/i, ['System of linear equations', 'Gaussian elimination']],
  [/\bslope\b|\bgradient\b|\by\s*=\s*-?[\d.]*\s*[a-z]\s*[+-]/i, ['Slope', 'Linear equation']],
  [/[<>≤≥]|\binequalit/i, ['Inequality (mathematics)']],
  [/√|\bsqrt\b|\bsquare root|\bradical/i, ['Square root', 'Nth root']],
  [/\bexponent|\b[a-z0-9)]\s*\^\s*[-a-z0-9(]|[⁰¹²³⁴⁵⁶⁷⁸⁹]/i, ['Exponentiation']],
  [/%|\bpercent/i, ['Percentage']],
  [/\bfraction|\b\d+\s*\/\s*\d+\b/i, ['Fraction']],
  [/\bcircle\b|\bradius\b|\bdiameter\b|\bcircumference/i, ['Circle', 'Area of a circle']],
  [/\barea\b|\bperimeter\b|\bvolume\b|\bsurface area/i, ['Area', 'Perimeter', 'Volume', 'Surface area']],
  [/=/, ['Linear equation', 'Equation solving']]
];

/** Topics that fit almost any maths ("^", "=", "/"): only worth listing when nothing more specific matched. */
const GENERIC = new Set(['Exponentiation', 'Fraction', 'Linear equation', 'Equation solving']);
function mathTopics(t: string) {
  const out: string[] = [];
  for (const [test, titles] of MATH_TOPICS) if (typeof test === 'function' ? test(t) : test.test(t)) for (const x of titles) if (!out.includes(x)) out.push(x);
  const specific = out.filter((x) => !GENERIC.has(x));
  return (specific.length >= 2 ? specific : out).slice(0, 8);
}
/** An expression as a formula reads, whatever its spacing or notation ("E = mc^2", "E = mc²"). */
const formulaKey = (s: string) => plainDigits(s).toLowerCase().replace(/[\s^*{}\\]/g, '');

const RULE_TITLE = /\b(formula|formulas|rule|rules|statement|definition|identit|propert|method|solution|solving|example|theorem|law|basic|elementary|computation|calculation|product|quotient|power|sum|difference|inverse)/i;

/**
 * Maths: the rules and formulas it needs, typeset, with Wikipedia's explanation of them. Code recognises the kind of
 * maths and lists the articles that fit; the librarian only picks which of them apply. Never a worked answer.
 */
export async function answerMath(text: string, context: string, onStatus: (s: string) => void, onUpdate: (r: AnswerResult) => void): Promise<AnswerResult> {
  const lang = lookupLang();
  const q = text.replace(/\s+/g, ' ').trim();
  const result: AnswerResult = { question: q, parts: [{ label: '', passages: [], done: false }], lang };
  onUpdate({ ...result });
  onStatus('Recognising the maths…');
  const topics = mathTopics(q);
  // The expression itself, searched: a named formula ("E = mc^2", "PV = nRT") has its own article.
  const [known, direct] = await Promise.all([topics.length ? api.lookup.titles(topics, lang).catch(() => [] as WikiCandidate[]) : Promise.resolve([] as WikiCandidate[]), /=/.test(q) && q.length <= 60 ? api.lookup.find(q, lang, 3).catch(() => [] as WikiCandidate[]) : Promise.resolve([] as WikiCandidate[])]);
  // In the order code ranked them (Wikipedia returns them in its own order).
  const at = (c: WikiCandidate) => topics.findIndex((t) => t.toLowerCase() === (c.phrase || c.title).toLowerCase());
  const cands: WikiCandidate[] = known.filter((c) => at(c) >= 0).sort((a, b) => at(a) - at(b));
  const named = direct.find((c) => formulaKey(c.intro).includes(formulaKey(q.replace(/\s*=\s*0\s*$/, ''))));
  if (named) cands.unshift(...[named].filter((c) => !cands.some((x) => x.title === c.title)));
  // Not recognised (a calculation in words, a named formula): search its words, the expression, and the librarian's ideas.
  if (cands.length < 2) {
    onStatus('Searching Wikipedia…');
    const plan = await planPart({ label: '', text: q, clause: q }, q, false);
    const searches = [...new Set([...plan.searches, q.slice(0, 80)])].slice(0, 3);
    for (const list of await Promise.all(searches.map((s) => api.lookup.find(s, lang, 4).catch(() => [] as WikiCandidate[])))) for (const c of list) if (!cands.some((x) => x.title === c.title)) cands.push(c);
  }
  if (!cands.length) {
    result.parts[0].done = true;
    onUpdate({ ...result });
    return result;
  }
  // The librarian picks which of these articles explain the rule or method needed (a short numbered list).
  onStatus('Choosing the rules that apply…');
  const opts = cands.slice(0, 8);
  const j = opts.length > 1 ? await choose(`A student needs to solve or understand this maths:\n"${q.slice(0, 400)}"\nWhich of these Wikipedia articles explain the rule, formula or method needed? Choose up to 2, best first.\n${opts.map((c, k) => `${k + 1}. ${c.title}${c.description ? ` (${c.description})` : ''}`).join('\n')}`, { type: 'object', properties: { articles: { type: 'array', minItems: 1, maxItems: 2, items: { enum: opts.map((_, k) => k + 1) } } }, required: ['articles'] }, 20) : null;
  const ks = [...new Set((Array.isArray(j?.articles) ? j.articles : []).map(Number).filter((k: number) => k >= 1 && k <= opts.length))] as number[];
  // (Without the librarian, the first: the named formula, or the general article for this kind of maths.)
  const chosen = (ks.length ? ks.map((k) => opts[k - 1]) : opts.slice(0, 1)).map((c) => c.title);
  onStatus('Finding the rules and formulas…');
  const read = reader(lang);
  const fetched = (await Promise.all(chosen.map(read))).filter((p): p is WikiPage => !!p);
  const qKeys = new Set(keys(q.replace(/[^\p{L}\s]/gu, ' ')).filter((w) => !ASKING.has(w)));
  const n = Math.max(1, Math.min(4, Number(setting('lookup.qPassages') ?? 2)));
  const passages: AnswerPassage[] = [];
  for (const page of fetched) {
    // What the topic is: the article's opening, up to and including its first formula (the quadratic formula itself
    // is in the second paragraph of "Quadratic formula"), at most three paragraphs.
    const leadParas = paragraphs(page.lead, true);
    let upTo = leadParas.findIndex((p) => p.includes(''));
    if (upTo < 0 || upTo > 2 || leadParas.slice(0, upTo + 1).join(' ').length > 1800) upTo = leadParas[0]?.length < 60 ? 1 : 0;
    const lead = leadParas.slice(0, upTo + 1);
    const units = passageUnits(page, qKeys, false).filter((u) => !(u.order < 1000 && u.paras.every((p) => lead.includes(p))));
    // The rules and formulas: passages with equations, early in the article (where the main statement is), in sections
    // about rules, formulas, definitions or examples, and full of formulas (a list of identities); not proofs or history.
    const scored: Scored[] = units
      .filter((u) => u.formula || /=/.test(u.plain))
      .map((u) => {
        const section = Math.floor(u.order / 1000);
        const density = (u.paras.join(' ').match(//g) || []).length / Math.max(1, u.plain.length / 300);
        return {
          u,
          answer: '',
          sure: true,
          score:
            (u.formula ? 3 : 0) +
            (RULE_TITLE.test(u.section) ? 2 : 0) -
            (/\b(proof|proofs|derivation|history|historical|generali[sz]ation|etymology|multicomponent|ternary)\b/i.test(u.section) ? 3 : 0) +
            (u.section && keys(u.section).some((w) => qKeys.has(w)) ? 2 : 0) +
            Math.max(0, 2 - section * 0.25) +
            Math.min(2, density) +
            Math.min(3, overlap(u.plain, qKeys) * 0.6) -
            Math.max(0, u.plain.length - 1500) / 1500
        };
      })
      .sort((a, b) => b.score - a.score);
    // A second article adds less (its opening and one formula passage), so the answer stays focused.
    const picked = await pickPassages(scored, passages.length ? Math.max(1, n - 1) : n, `A student needs to solve or understand this maths:\n"${q.slice(0, 300)}"`, 'give the rule or formula needed and explain it');
    if (lead.length) passages.push({ title: page.title, url: page.url, section: '', text: lead.join('\n\n'), marks: [], answer: '', edited: page.edited });
    passages.push(...readingOrder(picked).map((s) => toPassage(s, [])));
    result.parts[0].passages = [...passages];
    onUpdate({ ...result, parts: [{ ...result.parts[0] }] });
  }
  if (!passages.length) result.parts[0].closest = chosen[0];
  result.parts[0].done = true;
  onUpdate({ ...result, parts: [{ ...result.parts[0] }] });
  return result;
}
