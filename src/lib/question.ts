import { api, WikiCandidate, WikiPage } from './api';
import { setting } from './settings';
import { words, STOP, keywords, overlap, paragraphs, sameTerm, choose, termPattern, lookupLang } from './lookup';

/**
 * Questions and fill-in-the-blanks: the whole Wikipedia passages that explain what a highlighted question asks.
 *
 * Nothing shown is written by a model. The local model (when it's downloaded and allowed) may guess what a blank or
 * question is about, but only to know what to search for: its guesses are never shown, and a passage is shown only
 * when code finds the question's own words in it (or a guess in the same sentence as them, so Wikipedia confirms it).
 * The model may then choose among those passages by number. Passages are whole paragraphs, or a whole section when
 * its title names what's asked, so nothing is cut out of context.
 */

export interface AnswerPassage {
  title: string;
  url: string;
  section: string;
  /** Whole paragraphs, word for word (separated by blank lines). */
  text: string;
  /** Words from the question to show in bold. */
  marks: string[];
  /** The sentence that holds the answer, when Wikipedia's text confirms it (underlined). */
  answer: string;
  edited: string | null;
}
export interface AnswerPart {
  /** The part as the question writes it (empty when the question has one part). */
  label: string;
  passages: AnswerPassage[];
  /** The best passage was already shown for an earlier part (its number). */
  sameAs?: number;
  /** Nothing answers it: the closest article, to open in full. */
  closest?: string;
  done: boolean;
}
export interface AnswerResult {
  question: string;
  parts: AnswerPart[];
  lang: string;
}

// ---------- Is it a question? ----------
const BLANK = /_{2,}|…{2,}|\.{5,}/;
const ASKS = /^(what|why|how|which|when|where|who|whom|whose|explain|describe|compare|contrast|calculate|determine|identify|state|list|name|predict|discuss|outline|define|justify|evaluate|suggest|give|is|are|does|do|can)\b/i;
const TASK = /^(explain|describe|compare|contrast|calculate|determine|identify|state|list|name|predict|discuss|outline|define|justify|evaluate|suggest|give)\b/i;
/** Words that ask rather than say what the question is about. */
const ASKING = new Set(
  'what why how which when where who explain describe compare contrast calculate determine identify state list name predict discuss outline define justify evaluate suggest give following question answer briefly role function involved involve keeps keep maintenance maintain maintains helps help plays play responsible important allows provides called known process'
    .split(' ')
    .flatMap((w) => words(w))
);
const marker = /(?:^|\s)\(?([a-h]|[1-9])[).]\s+/g;
const partMarkers = (t: string) => [...t.matchAll(marker)];

export type Highlight = { kind: 'term'; term: string } | { kind: 'question' } | { kind: 'passage' };

/** A term, a question (or fill-in-the-blank), or a passage of reading. */
export function classify(text: string): Highlight {
  const t = text.replace(/\s+/g, ' ').trim();
  const blank = BLANK.test(t);
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
const sentences = (p: string) => p.split(/(?<=[.!?])\s+(?=[\p{Lu}\p{N}“"(])/u);

// ---------- Searching ----------
interface Plan {
  guesses: string[];
  searches: string[];
}

/** The part's own words as a search ("Chloride acid balance"). */
function ownSearch(p: Part) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of p.text.replace(BLANK, ' ').match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) || []) {
    const k = norm(words(w)[0] || '');
    if (!k || STOP.has(w.toLowerCase()) || ASKING.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(w);
  }
  return out.slice(0, 6).join(' ');
}

/**
 * What to search for each part. The librarian may suggest likely answers and the names of the processes involved
 * ("chloride shift"); these are only search words, never shown. The part's own words are always searched as well.
 */
async function planSearches(question: string, parts: Part[]): Promise<Plan[]> {
  const own = parts.map((p) => ({ guesses: [] as string[], searches: [ownSearch(p)].filter(Boolean) }));
  if (setting('lookup.qGuesses') === false) return own;
  const n = parts.length;
  const j = await choose(
    `A student highlighted this question to look it up in Wikipedia:
"""
${question.slice(0, 1200)}
"""
${n > 1 ? `Its parts:\n${parts.map((p, i) => `${i + 1}. ${p.label}`).join('\n')}\n` : ''}For ${n > 1 ? 'each part' : 'the question'}, give:
- guesses: the word or short phrase most likely to fill the blank or answer it (1-4 words, up to 3)
- searches: Wikipedia searches most likely to find the article that explains it, such as the name of the process, mechanism or law involved (2-5 words, up to 3)
These are only search keywords; they are never shown to the student.`,
    {
      type: 'object',
      properties: {
        parts: {
          type: 'array',
          minItems: n,
          maxItems: n,
          items: {
            type: 'object',
            properties: {
              guesses: { type: 'array', maxItems: 3, items: { type: 'string', maxLength: 40 } },
              searches: { type: 'array', maxItems: 3, items: { type: 'string', maxLength: 60 } }
            },
            required: ['guesses', 'searches']
          }
        }
      },
      required: ['parts']
    },
    50 + 70 * n,
    'You are a careful research librarian. You suggest search keywords only. Reply only with the JSON.'
  );
  const clean = (a: any, max: number) =>
    (Array.isArray(a) ? a : [])
      .map((s) => String(s).replace(/[^\p{L}\p{N}' ()-]/gu, ' ').replace(/\s+/g, ' ').trim())
      .filter((s) => s.length > 1 && s.split(' ').length <= max);
  return own.map((o, i) => {
    const g = j?.parts?.[i];
    return { guesses: clean(g?.guesses, 4).slice(0, 3), searches: [...new Set([...clean(g?.searches, 6).slice(0, 2), ...o.searches])] };
  });
}

// ---------- Passages ----------
interface Unit {
  page: WikiPage;
  section: string;
  paras: string[];
  order: number;
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
  const blocks = [{ title: '', paras: paragraphs(page.lead) }, ...page.sections.map((s) => ({ title: s.title, paras: paragraphs(s.text) }))];
  const pageWords = new Set(keys(page.title));
  const out: Unit[] = [];
  blocks.forEach((b, bi) => {
    if (!b.paras.length) return;
    const len = b.paras.join(' ').length;
    // A section titled with what's asked ("Relative lowering of vapour pressure"): most of its title's own words
    // (beyond the article's name, which every section of "Phases of ice" shares) are the question's.
    const own = keys(b.title).filter((w) => !pageWords.has(w));
    const named = own.length > 0 && own.filter((w) => titleKeys.has(w)).length / own.length >= 0.5;
    if (len <= 4000 && (whole || named || (dedicated && bi === 0 && len <= 2500))) {
      out.push({ page, section: b.title, paras: b.paras, order: bi * 1000 });
      return;
    }
    for (let i = 0; i < b.paras.length; i++) {
      const unit = [b.paras[i]];
      while (i + 1 < b.paras.length && unit.join(' ').length < 2500) {
        const last = unit[unit.length - 1];
        const next = b.paras[i + 1];
        if (/:$/.test(last) || (listLine(next) && (listLine(last) || /:$/.test(unit[0]))) || (cont && continues(next))) unit.push(b.paras[++i]);
        else break;
      }
      if (unit.join(' ').length >= 80) out.push({ page, section: b.title, paras: unit, order: bi * 1000 + i });
    }
  });
  return out;
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
  const unitKeys = units.map((u) => new Set(keys(u.paras.join(' '))));
  const df = (w: string) => unitKeys.filter((k) => k.has(w)).length;
  const idf = new Map(clause.map((w) => [w, Math.log(1 + units.length / (1 + df(w)))]));
  const total = clause.reduce((s, w) => s + idf.get(w)!, 0) || 1;
  const guessRes = plan.guesses.map((g) => termPattern(plainDigits(g)));
  const guessIn = (s: string) => guessRes.some((re) => ((re.lastIndex = 0), re.test(plainDigits(s))));
  // An article named exactly like a search ("Chloride shift") that has all of the part's words and a guess somewhere:
  // Wikipedia confirms it's the right article even when no single sentence has them together.
  const pageOk = new Map<string, boolean>();
  for (const p of new Set(units.map((u) => u.page))) {
    const all = [p.lead, ...p.sections.map((s) => s.text)].join(' ');
    const pk = new Set(keys(all));
    pageOk.set(p.title, dedicated.has(p.title) && clause.every((w) => pk.has(w)) && guessIn(all));
  }
  const out: Scored[] = [];
  units.forEach((u, i) => {
    const k = unitKeys[i];
    const text = u.paras.join(' ');
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
      Math.min(2, (hits / Math.max(1, words100)) * 0.25) -
      u.order * 0.00002;
    out.push({ u, score, answer, sure: !!proof || !!answer });
  });
  const sorted = out.sort((a, b) => b.score - a.score);
  // When the best passage is confirmed by its own words, the others have to be too.
  return sorted[0]?.sure ? sorted.filter((s) => s.sure) : sorted;
}

// ---------- Answering ----------
/**
 * Find the passages that answer each part of a highlighted question. `onUpdate` gets the result so far whenever a
 * part is ready, so the panel can show it straight away.
 */
export async function answerQuestion(question: string, context: string, onStatus: (s: string) => void, onUpdate: (r: AnswerResult) => void): Promise<AnswerResult> {
  const lang = lookupLang();
  const q = question.replace(/\s+/g, ' ').trim();
  const parts = splitParts(q);
  const result: AnswerResult = { question: q, parts: parts.map((p) => ({ label: parts.length > 1 ? p.label : '', passages: [], done: false })), lang };
  const subjectText = parts.length > 1 && parts[0].text !== parts[0].clause ? parts[0].text.slice(0, parts[0].text.length - parts[0].clause.length) : '';
  const subject = asks(subjectText);
  onUpdate(result);

  onStatus('Working out what to look for…');
  const plans = await planSearches(q, parts);

  // Search: every part's own words, and the librarian's searches, at most six searches in all.
  const queries: string[] = [];
  for (let round = 0; round < 3; round++) for (const p of plans) if (p.searches[round] && !queries.includes(p.searches[round]) && queries.length < 6) queries.push(p.searches[round]);
  onStatus('Searching Wikipedia…');
  const found = new Map<string, WikiCandidate[]>();
  await Promise.all(queries.map(async (s) => found.set(s, await api.lookup.find(s, lang, 5).catch(() => []))));
  // Articles named exactly like a search or a guess ("Chloride shift", "Osmotic pressure"): the most focused source.
  // And the article on the shared subject ("Chloride"), which every part is about.
  const subjectTitle = (subjectText.replace(/\([^)]*\)/g, ' ').match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) || []).filter((w) => !STOP.has(w.toLowerCase()) && !ASKING.has(norm(words(w)[0] || ''))).join(' ');
  const dedicated = new Set<string>();
  const exact: WikiCandidate[] = [];
  let subjectPage = '';
  const tries = [...new Set([...(setting('lookup.qDedicated') !== false ? plans.flatMap((p) => [...p.searches, ...p.guesses.filter((g) => g.split(' ').length > 1)]) : []), subjectTitle].filter(Boolean))].slice(0, 20);
  for (const c of tries.length ? await api.lookup.titles(tries, lang).catch(() => [] as WikiCandidate[]) : []) {
    if (subjectTitle && (c.phrase || '').toLowerCase() === subjectTitle.toLowerCase()) subjectPage = c.title;
    else {
      exact.push(c);
      dedicated.add(c.title);
    }
  }
  const readingKeys = new Set([...keywords(plainDigits(context), 20)].map(norm));
  const pages = new Map<string, Promise<WikiPage | null>>();
  const read = (t: string) => {
    if (!pages.has(t)) pages.set(t, api.lookup.article(t, lang).catch(() => null));
    return pages.get(t)!;
  };
  const shown = new Map<string, number>();

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const plan = plans[i];
    onStatus(parts.length > 1 ? `Finding part ${i + 1} of ${parts.length}…` : 'Finding the passages that answer it…');
    // This part's candidate articles: from its searches, and exact titles, best fit first.
    const want = new Set([...asks(part.text), ...plan.guesses.flatMap(keys), ...plan.searches.flatMap(keys)]);
    const cands = new Map<string, number>();
    plan.searches.forEach((s) => (found.get(s) || []).forEach((c, r) => cands.set(c.title, Math.max(cands.get(c.title) ?? -99, overlap(`${c.title} ${c.description} ${c.intro}`, want) + (5 - r) * 0.3 + overlap(c.intro, readingKeys) * 0.2))));
    exact.filter((c) => plan.searches.concat(plan.guesses).some((s) => sameTerm(s, c.phrase || c.title) || (c.phrase || '').toLowerCase() === s.toLowerCase())).forEach((c) => cands.set(c.title, (cands.get(c.title) ?? 0) + overlap(`${c.title} ${c.intro}`, want) + 2));
    const titles = [...cands.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t).filter((t) => t !== subjectPage).slice(0, 3);
    if (subjectPage) titles.push(subjectPage);
    const fetched = (await Promise.all(titles.map(read))).filter((p): p is WikiPage => !!p);
    const titleKeys = new Set([...plan.guesses, ...plan.searches].flatMap(keys).concat([...asks(part.clause)]));
    const units = fetched.flatMap((p) => passageUnits(p, titleKeys, dedicated.has(p.title)));
    const scored = scoreUnits(units, part, subject, plan, dedicated, subjectPage, readingKeys);
    const n = Math.max(1, Math.min(4, Number(setting('lookup.qPassages') ?? 2)));
    // More than one passage only when the others answer nearly as well.
    let picked = scored.slice(0, n).filter((s, k) => k === 0 || s.score >= scored[0].score - 2.5);
    // A close call: the librarian chooses which of the passages that passed explain the answer.
    if (scored.length > 1 && (scored.length > n || scored[1].score > scored[0].score - 1.5)) {
      const opts = scored.slice(0, 6);
      const j = await choose(
        `A student is answering this question with Wikipedia:
"${(parts.length > 1 ? part.text : q).slice(0, 500)}"
Which of these Wikipedia passages explain the answer? Choose the best ones, best first (up to ${n}).
${opts.map((o, k) => `${k + 1}. [${o.u.page.title}${o.u.section ? ` › ${o.u.section}` : ''}] ${o.u.paras.join(' ').slice(0, 400)}`).join('\n')}`,
        { type: 'object', properties: { passages: { type: 'array', minItems: 1, maxItems: n, items: { enum: opts.map((_, k) => k + 1) } } }, required: ['passages'] },
        30
      );
      const ks = [...new Set((Array.isArray(j?.passages) ? j.passages : []).map(Number).filter((k: number) => k >= 1 && k <= opts.length))] as number[];
      if (ks.length) picked = ks.map((k) => opts[k - 1]);
    }
    const res = result.parts[i];
    // Already shown for an earlier part: say so instead of showing it twice.
    const first = picked[0] && shown.get(picked[0].u.paras[0]);
    if (first !== undefined) res.sameAs = first;
    const fresh = picked.filter((s) => !s.u.paras.some((p) => shown.has(p)));
    // In the order you'd read them: article by article (the best one first), then as each article has them.
    const byPage = [...new Set(fresh.map((s) => s.u.page.title))];
    fresh.sort((a, b) => byPage.indexOf(a.u.page.title) - byPage.indexOf(b.u.page.title) || a.u.order - b.u.order);
    const marks = [...new Set((part.clause.replace(BLANK, ' ').match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu) || []).filter((w) => w.length > 3 && !STOP.has(w.toLowerCase()) && !ASKING.has(norm(words(w)[0] || ''))))].sort((a, b) => b.length - a.length).slice(0, 4);
    res.passages = fresh.map((s) => ({ title: s.u.page.title, url: s.u.page.url, section: s.u.section, text: s.u.paras.join('\n\n'), marks, answer: s.answer, edited: s.u.page.edited }));
    fresh.forEach((s) => s.u.paras.forEach((p) => shown.set(p, i + 1)));
    if (!res.passages.length && res.sameAs === undefined) res.closest = titles[0] || fetched[0]?.title;
    res.done = true;
    onUpdate({ ...result, parts: [...result.parts] });
  }
  return result;
}
