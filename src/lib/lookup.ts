import { api, WikiCandidate, WikiPage, DictEntry, AiEvent } from './api';
import { setting } from './settings';

/**
 * Encyclopedia: explains terms with Wikipedia's own words and defines words with an offline dictionary.
 *
 * Nothing shown is written by a model. Code finds the article and shows its text word for word. The local model
 * (when it's downloaded and allowed) only acts as a librarian: when a term has several meanings it picks the article
 * that fits what you're reading, and when the term is only part of a bigger article ("saturated solution" in
 * "Solubility") which of the article's passages about it fits best, by answering with an option number.
 */

export interface ExplainResult {
  term: string;
  page: WikiPage;
  /** The article's opening paragraph: Wikipedia's own definition. */
  definition: string;
  /** The rest of the introduction. */
  more: string;
  /**
   * When the term is a part of the article's topic ("saturated solution" in "Solubility"): the article's own
   * paragraphs about it, best first. `mark` is the term as the paragraph writes it (shown in bold).
   */
  focus: { section: string; text: string; mark: string }[];
  /** The sections that fit what you're reading, in article order. */
  sections: { title: string; text: string }[];
  /** What was highlighted, when it was mended into `term` ("polar dissolves pol"). */
  asked?: string;
  /** Other articles the term could mean (click to switch). */
  others: WikiCandidate[];
  lang: string;
}

export const lookupLang = () => String(setting('lookup.lang') || 'en');

// ---------- Text helpers ----------
export const STOP = new Set(
  'a an the and or but if of to in on at for with by from as is are was were be been being it its this that these those which who whom what how why when where can could should would will shall may might must do does did not no than then so such into onto about also more most some any each every many much while because often like well made make makes take takes used use uses other there their they them he she his her we our you your i me my one two all very just only over under between through during before after above below up down out off again further once here both few own same too s t around until unless without within since though although against toward towards among upon along behind beyond despite whether yet still even ever never always quite rather almost perhaps instead whose whatever whenever wherever'.split(
    ' '
  )
);
/**
 * A word's rough stem, so "organisms" matches "organism" and "producing" matches "produce" (a final "e" goes too,
 * so "molecule" and "molecules" meet at "molecul").
 */
export const stem = (w: string) => (w.length > 4 ? w.replace(/ies$/, 'y').replace(/(ing|ed|es|s)$/, '').replace(/(?<=..[^aeiou])e$/, '') : w);
/** Everyday words that appear in articles on any subject, so they say nothing about which meaning is meant (stemmed). */
const COMMON = new Set(
  'add year day time week month people person thing way place part number world life small large big little new old good great high low long short first last next different same important general main early late certain common usual whole half full open close real true kind sort type form area side end point line case fact group man woman child home house hand work place left right best better least less several various known called named found given include including become became begin began show shown seen look find give get got keep let put set say said tell think know want need come came go went ten hundred thousand million billion three four five six seven eight nine'
    .split(' ')
    .map(stem)
);
export const words = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((w) => w.length > 2 && !STOP.has(w)).map(stem);
/** The most frequent content words of a text (what it's about). */
export function keywords(text: string, n = 40) {
  const f = new Map<string, number>();
  for (const w of words(text)) f.set(w, (f.get(w) || 0) + 1);
  return new Set([...f.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([w]) => w));
}
export const overlap = (text: string, keys: Set<string>) => new Set(words(text).filter((w) => keys.has(w))).size;
export const bare = (t: string) => t.toLowerCase().replace(/\s*\([^)]*\)\s*$/, '').trim();
/** Two names for the same thing, give or take word endings: "supersaturated" / "Supersaturation", "light-dependent reaction(s)". */
export function sameTerm(a: string, b: string) {
  const x = bare(a).split(/[\s-]+/);
  const y = bare(b).split(/[\s-]+/);
  // Only the endings may differ ("saturat-ed/-ion"), not whole syllables ("cell" isn't "cellular").
  const sameWord = (p: string, q: string) => {
    let k = 0;
    while (k < p.length && p[k] === q[k]) k++;
    return p === q || (k >= 4 && p.length - k <= 3 && q.length - k <= 3);
  };
  return x.length === y.length && x.every((w, i) => sameWord(w, y[i]));
}

/** Wikipedia's plain text keeps some markup leftovers (maths, empty brackets); tidy them without changing words. */
/**
 * An equation kept as LaTeX inside text (`keepTex`), so the panel can typeset it: latex.
 * `untex` turns them into readable text for matching, copying and inserting.
 */
export const TEX = /([\s\S]*?)/g;
export const untex = (s: string) => s.replace(TEX, (_, tex) => latexToText(tex));

export function tidy(text: string, keepTex = false) {
  // Invisible word joiners Wikipedia puts around inline maths.
  let t = text.replace(/\u2060/g, '');
  // Equations: Wikipedia's plain text spells each symbol out on its own indented line, followed by the LaTeX source
  // ({\displaystyle …}). Replace the whole block with one readable line made from the LaTeX, inside its sentence.
  for (let i = t.indexOf('{\\displaystyle'); i >= 0; i = t.indexOf('{\\displaystyle')) {
    let depth = 0;
    let j = i;
    for (; j < t.length; j++) {
      if (t[j] === '{') depth++;
      else if (t[j] === '}' && --depth === 0) break;
    }
    const latex = t.slice(i + '{\\displaystyle'.length, j);
    // Back over the spelled-out symbol lines (indented or blank) to the end of the sentence before it…
    let start = i;
    for (let p = t.lastIndexOf('\n', start - 1); p >= 0; p = t.lastIndexOf('\n', start - 1)) {
      const line = t.slice(p + 1, start);
      if (line.trim() && !/^\s/.test(line)) break;
      start = p;
    }
    // …and forward over blank lines to where the text goes on.
    let end = j + 1;
    for (let m = t.indexOf('\n', end); m >= 0 && !t.slice(end, m).trim(); m = t.indexOf('\n', end)) end = m + 1;
    // No space where the formula touches a bracket, hyphen or apostrophe ("(x)", "x-axis", "x's").
    const before = /[(\[\s]$/.test(t.slice(0, start)) ? '' : ' ';
    const after = /^[-–)\]'’,.;:]/.test(t.slice(end)) ? '' : ' ';
    t = `${t.slice(0, start)}${before}${keepTex ? `${latex.trim()}` : latexToText(latex)}${after}${t.slice(end)}`;
  }
  return t
    .replace(/\(\s*[;,]?\s*\)/g, '')
    .replace(/\(\s*;\s*/g, '(')
    .replace(/\([ \t]+/g, '(')
    .replace(/[ \t]+\)/g, ')')
    .replace(/[ \t]+([,.;:])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
// ---------- Equations: LaTeX → readable text ("E=mc^{2}" → "E = mc²", "\frac{n}{V}" → "n/V") ----------
const GREEK: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν',
  xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ',
  Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω'
};
const SYMBOLS: Record<string, string> = {
  cdot: '·', times: '×', div: '÷', pm: '±', mp: '∓', leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', approx: '≈', sim: '∼', simeq: '≃', equiv: '≡', propto: '∝', to: '→',
  rightarrow: '→', longrightarrow: '→', leftarrow: '←', Rightarrow: '⇒', leftrightarrow: '↔', rightleftharpoons: '⇌', infty: '∞', sum: 'Σ', prod: '∏', int: '∫', oint: '∮',
  partial: '∂', nabla: '∇', circ: '°', degree: '°', ldots: '…', cdots: '⋯', dots: '…', in: '∈', notin: '∉', subset: '⊂', cup: '∪', cap: '∩', forall: '∀', exists: '∃', hbar: 'ħ',
  ell: 'ℓ', angle: '∠', perp: '⊥', parallel: '∥', prime: '′', langle: '⟨', rangle: '⟩', vert: '|', lvert: '|', rvert: '|', mid: '|', thickapprox: '≈', thicksim: '∼', cong: '≅', ll: '≪', gg: '≫', iff: '⇔', implies: '⇒', mapsto: '↦', uparrow: '↑', downarrow: '↓', star: '⋆', ast: '∗', bullet: '•', emptyset: '∅', varnothing: '∅', triangle: '△', square: '□',
  lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉', percent: '%'
};
const SUP: Record<string, string> = Object.fromEntries([...'0123456789+-=()ni'].map((c, k) => [c, '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱ'[k]]));
const SUB: Record<string, string> = Object.fromEntries([...'0123456789+-=()aeoxhklmnpst'].map((c, k) => [c, '₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₒₓₕₖₗₘₙₚₛₜ'[k]]));
const KEEP_CONTENT = new Set(['text', 'textrm', 'textit', 'textbf', 'mathrm', 'mathbf', 'mathit', 'mathsf', 'mathcal', 'mathbb', 'boldsymbol', 'operatorname', 'mbox', 'ce', 'rm', 'vec', 'hat', 'bar', 'overline', 'underline', 'tilde', 'dot']);
const FUNCTIONS = new Set(['log', 'ln', 'lg', 'sin', 'cos', 'tan', 'sec', 'csc', 'cot', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'exp', 'lim', 'max', 'min', 'det', 'sup', 'inf', 'arg', 'deg', 'gcd', 'Pr']);
const DROP = new Set(['left', 'right', 'big', 'Big', 'bigg', 'Bigg', 'bigl', 'bigr', 'Bigl', 'Bigr', 'displaystyle', 'textstyle', 'scriptstyle', 'limits', 'nolimits']);

export function latexToText(src: string): string {
  let i = 0;
  const wrap = (raw: string, a = raw.trim()) => (/^[\p{L}\p{N}.′·_⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻ⁿⁱ₀₁₂₃₄₅₆₇₈₉ₐₑₒₓₕₖₗₘₙₚₛₜ]+$/u.test(a) ? a : `(${a})`);
  const script = (g: string, sup: boolean) => {
    const map = sup ? SUP : SUB;
    // No Unicode version (like a subscript B): "_B", with a thin space so "k_B N_A" doesn't run together.
    return [...g].every((c) => map[c]) ? [...g].map((c) => map[c]).join('') : `${sup ? '^' : '_'}${wrap(g)} `;
  };
  const arg = (): string => {
    while (src[i] === ' ') i++;
    if (src[i] === '{') {
      i++;
      const out = seq('}');
      i++;
      return out;
    }
    if (src[i] === '\\') return command();
    return src[i++] ?? '';
  };
  const command = (): string => {
    i++;
    let name = '';
    if (/[a-zA-Z]/.test(src[i] || '')) {
      while (i < src.length && /[a-zA-Z]/.test(src[i])) name += src[i++];
      // LaTeX ignores spaces after a command word ("\Delta G" is ΔG).
      while (src[i] === ' ') i++;
    } else name = src[i++] ?? '';
    if (name === '\\') return '; ';
    if ([',', ';', ':', ' ', 'quad', 'qquad'].includes(name)) return ' ';
    if (name === '!') return '';
    if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
      const a = arg();
      const b = arg();
      return `${wrap(a)}/${wrap(b)}`;
    }
    if (name === 'sqrt') {
      let n = '';
      if (src[i] === '[') {
        const close = src.indexOf(']', i);
        n = src.slice(i + 1, close);
        i = close + 1;
      }
      return `${n ? script(n, true) : ''}√${wrap(arg())}`;
    }
    if (name === 'begin' || name === 'end') {
      arg();
      return '';
    }
    if (KEEP_CONTENT.has(name)) return arg();
    if (DROP.has(name)) {
      if (src[i] === '.') i++;
      return '';
    }
    // Function names keep a space before their argument ("sin x", "log x"), but not before a sub/superscript.
    if (FUNCTIONS.has(name)) return name + (src[i] === '_' || src[i] === '^' || src[i] === '(' ? '' : ' ');
    return GREEK[name] ?? SYMBOLS[name] ?? name;
  };
  const seq = (end?: string): string => {
    let out = '';
    while (i < src.length && src[i] !== end) {
      const c = src[i];
      if (c === '^' || c === '_') {
        i++;
        out += script(arg(), c === '^');
      } else if (c === '{') {
        i++;
        out += seq('}');
        i++;
      } else if (c === '\\') out += command();
      else if (c === '&') i++;
      else if (c === '~') (i++, (out += ' '));
      else (i++, (out += c));
    }
    return out;
  };
  return seq()
    .replace(/\s*([=<>≤≥≈≠→⇌⇒±≡∝])\s*/g, ' $1 ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;)])/g, '$1')
    .replace(/\(\s+/g, '(')
    .trim();
}

export const paragraphs = (t: string, keepTex = false) => tidy(t, keepTex).split(/\n+/).map((p) => p.trim()).filter(Boolean);

export const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isWordChar = (c?: string) => !!c && /[\p{L}\p{N}]/u.test(c);

/**
 * A highlight that cut a word off at either end ("polar dissolves pol", "ar molecules"): the whole words, as the
 * document has them. A highlight that appears somewhere as whole words is taken as it is.
 */
export function wholeWords(full: string, selection: string) {
  const s = selection.replace(/\s+/g, ' ').trim();
  if (!full || !s) return s;
  const re = new RegExp(s.split(' ').map(esc).join('\\s+'), 'gi');
  let fixed: string | null = null;
  for (const m of full.matchAll(re)) {
    let a = m.index!;
    let b = a + m[0].length;
    if (!isWordChar(full[a - 1]) && !isWordChar(full[b])) return s;
    if (fixed !== null) continue;
    // Out to the word's ends, through hyphens inside it ("light-dep" → "light-dependent").
    const inWord = (i: number) => isWordChar(full[i]) || (full[i] === '-' && isWordChar(full[i - 1]) && isWordChar(full[i + 1]));
    for (const stop = a - 40; a > stop && inWord(a - 1); ) a--;
    for (const stop = b + 40; b < stop && inWord(b); ) b++;
    fixed = full.slice(a, b).replace(/\s+/g, ' ').trim();
  }
  return fixed ?? s;
}

/** The words around the highlight in the document, so the right meaning can be picked ("cell" in biology). */
export function contextAround(full: string, selection: string, chars = 1500) {
  if (!full) return selection;
  const i = selection ? full.indexOf(selection.slice(0, 80)) : -1;
  if (i < 0) return full.slice(0, chars * 2);
  return full.slice(Math.max(0, i - chars), i + selection.length + chars);
}

// ---------- The librarian (optional local model) ----------
let readyCache: { at: number; ok: boolean } | null = null;
export async function modelReady() {
  if (setting('lookup.useModel') === false) return false;
  if (readyCache && Date.now() - readyCache.at < 30000) return readyCache.ok;
  const st = await api.ai.state().catch(() => null);
  const ok = !!st?.models.find((m) => m.tier === st.settings.tier)?.installed;
  readyCache = { at: Date.now(), ok };
  return ok;
}

/** Ask the model to choose among numbered options. It can only answer with option numbers (JSON schema). */
export async function choose(prompt: string, schema: any, maxTokens: number, system = 'You are a careful librarian. You only choose from the numbered options you are given. Reply only with the JSON.'): Promise<any | null> {
  if (!(await modelReady())) return null;
  try {
    const id = await api.ai.generate({
      system,
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
/** The sentences around the term in the reading (they say most about which meaning it has). */
function nearText(term: string, context: string, span = 350) {
  const i = context.search(termPattern(term));
  return i < 0 ? '' : context.slice(Math.max(0, i - span), i + term.length + span);
}
const nearWords = (term: string, context: string, skip: Set<string>) => new Set(words(nearText(term, context)).filter((w) => !skip.has(w)));
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
  const termWords = new Set(words(term));
  const near = nearWords(term, context, termWords);
  // "Term (word from the reading)": Wikipedia names meanings that way, or redirects them into the right section
  // ("Cell (spreadsheet)" → "Spreadsheet#Cells", "Nucleus (cell)" → "Cell nucleus").
  const qualifiers = [...new Set((nearText(term, context).toLowerCase().match(/[\p{L}]{4,}/gu) || []).filter((w) => !STOP.has(w) && !termWords.has(stem(w))).flatMap((w) => (w.endsWith('s') ? [w.slice(0, -1), w] : [w])))].slice(0, 20);
  const head = term.trim().charAt(0).toUpperCase() + term.trim().slice(1);
  // A disambiguation page lists every meaning; keep the ones whose descriptions share words with the reading.
  const disamb = searched.find((c) => c.rank === -1 && c.disambiguation);
  const [fromText, qualified, listed] = await Promise.all([
    phrases.length ? api.lookup.titles(phrases.map((p) => p.phrase), lang).catch(() => [] as WikiCandidate[]) : Promise.resolve([] as WikiCandidate[]),
    qualifiers.length ? api.lookup.titles(qualifiers.map((q) => `${head} (${q})`), lang).catch(() => [] as WikiCandidate[]) : Promise.resolve([] as WikiCandidate[]),
    disamb && context.trim() ? api.lookup.meanings(disamb.title, lang).catch(() => [] as WikiCandidate[]) : Promise.resolve([] as WikiCandidate[])
  ]);
  const readingWords = new Set([...keywords(context, 60), ...near]);
  const fromList = listed
    .map((c) => ({ c, n: overlap(`${c.title} ${c.description}`, readingWords) }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, 5)
    .map((x) => x.c);
  const isQualified = new Set(qualified.map((c) => c.title));
  // Which phrases name the concept: for a noun the ones it ends ("cell membrane" for "membrane"); for an adjective
  // the ones it starts ("polar molecules" for "polar"). The offline dictionary tells which the term is.
  const adjective = (await api.lookup.define(term, 1).catch(() => null))?.entries[0]?.pos === 'adjective';
  const strong = new Set(phrases.filter((p) => p.head !== adjective).map((p) => p.phrase));
  const headTitle = new Set(fromText.filter((c) => strong.has(c.phrase || bare(c.title))).map((c) => c.title));
  const inText = new Set(fromText.map((c) => c.title));
  const cands: WikiCandidate[] = [];
  for (const c of [...searched, ...fromText, ...qualified, ...fromList]) {
    const had = cands.find((x) => x.title === c.title);
    if (!had) cands.push(c);
    else if (!had.fragment && c.fragment) had.fragment = c.fragment;
  }
  const usable = cands.filter((c) => !c.disambiguation && !/^(list|lists|index|outline|glossary) of /i.test(c.title));
  if (!usable.length) return null;
  const t = bare(term);
  // What the reading is about, minus the term itself (every candidate shares that).
  const keys = new Set([...keywords(context, 60)].filter((w) => !termWords.has(w)));
  const onlyRedirect = cands.some((c) => c.rank === -1 && c.redirectFrom && !c.fragment && !sameTerm(c.title, term));
  const score = (c: WikiCandidate, i: number) => {
    const title = bare(c.title);
    const qualifier = c.title.match(/\(([^)]*)\)\s*$/)?.[1] || '';
    // rank −1: Wikipedia's own page for exactly this term (directly or by redirect, like "ATP").
    // An article that opens "Adenosine triphosphate (ATP) is…" is the one for "ATP".
    const abbrev = c.intro.toLowerCase().startsWith(title) && new RegExp(`^.{0,${title.length + 12}}\\(${term.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[),;]`, 'i').test(c.intro);
    const exact = c.rank === -1 || abbrev || title === t || title === t.replace(/s$/, '') || `${title}s` === t;
    const fits = words(title).every((w) => termWords.has(w));
    // "Nucleus (neuroanatomy)" is one meaning of several: an exact title counts fully only without a qualifier.
    // A section titled with the term ("Light-dependent reactions" in "Photosynthesis") nearly matches the article the
    // term redirects to, when it only redirects (the reading decides between them); otherwise it's a hint.
    const section = c.section && sameTerm(c.section, term) ? (onlyRedirect ? 3 : 1) : 0;
    // "Cell (spreadsheet)" found from "spreadsheet" in the reading: named for this term in this sense.
    const base = Math.max(section, isQualified.has(c.title) ? 4 : 0, exact ? (qualifier ? 2.5 : 4) : fits ? 2 : 0);
    const titleFit = Math.min(2, words(title).filter((w) => !termWords.has(w) && keys.has(w)).length) + Math.min(1.5, overlap(qualifier, keys) * 1.5);
    // Books, films, bands, companies… rarely what a reader means, unless the reading is about them.
    const work = /\b(book|novel|film|movie|album|song|single|band|television|series|video game|magazine|newspaper|company|brand|footballer|politician|actor|actress|singer|rapper|character)\b/i.test(c.description) && !overlap(c.description, keys) ? -2 : 0;
    const searchedWithReading = c.contextRank !== undefined ? Math.max(0, 2 - c.contextRank * 0.5) : 0;
    return searchedWithReading + work + base + titleFit +(headTitle.has(c.title) ? 4.5 : inText.has(c.title) ? 1 : 0) + Math.min(3, overlap(`${c.description} ${c.description} ${c.intro}`, keys) * 0.5) + 1 / (2 + i);
  };
  const ranked: { c: WikiCandidate; s: number; cats?: string[] }[] = usable.map((c, i) => ({ c, s: score(c, i) })).sort((a, b) => b.s - a.s);
  // Read more of the leading articles: their whole introduction and categories, compared with the reading. Words
  // from the sentences around the highlight count twice (in a chemistry passage that says "mitochondria" next to
  // "cell", "Cell (biology)" shares those words and "Cell (processor)" doesn't).
  if (context.trim() && ranked.length > 1) {
    const top = ranked.slice(0, 10);
    const more = await api.lookup.about(top.map((r) => r.c.title), lang).catch(() => ({}) as Record<string, { intro: string; categories: string[] }>);
    // Each article's words, and how many of the articles use each one: a word most of them share ("small", or
    // "anode" among kinds of battery) says little about which is meant; one only a few use ("prisoner") says a lot.
    const bags = top.map((r) => {
      const m = more[r.c.title];
      return m ? new Set(words(`${r.c.description} ${m.intro} ${m.categories.join(' ')}`)) : null;
    });
    const df = new Map<string, number>();
    for (const b of bags) for (const w of b || []) if (readingWords.has(w)) df.set(w, (df.get(w) || 0) + 1);
    const read = bags.filter(Boolean).length;
    const weight = (w: string) => Math.log((read + 1) / ((df.get(w) || 0) + 0.5));
    top.forEach((r, i) => {
      const theirs = bags[i];
      if (!theirs) return;
      // Words from the sentences around the highlight count twice. A long introduction shares more words by chance,
      // so the total is scaled by its length.
      let fit = 0;
      for (const w of readingWords) if (theirs.has(w) && !COMMON.has(w) && !termWords.has(w)) fit += weight(w) * (near.has(w) ? 2 : 1);
      fit /= Math.max(1, Math.sqrt(theirs.size / 80));
      // The short description sums up the meaning ("Small room in a prison… where a prisoner is held").
      let described = 0;
      for (const w of new Set(words(r.c.description))) if (readingWords.has(w)) described += weight(w);
      r.s += Math.min(6, fit * 0.9) + Math.min(2.5, described * 0.8);
      // The reading's own phrase naming an article ("a galvanic cell") settles it when the article fits the reading at
      // all; one that only happens to be a title ("a small cell" → "Small cell") doesn't count.
      if (headTitle.has(r.c.title)) r.s += fit > 0.3 ? 3 : -3;
      r.cats = more[r.c.title]?.categories;
    });
    ranked.sort((a, b) => b.s - a.s);
  }
  let best = ranked[0].c;
  // A near-tie (word matching can't tell the meanings apart): let the librarian break it, if it's available.
  const close = ranked.length > 1 && ranked[1].s > ranked[0].s - 1.5;
  if (close && context.trim()) {
    const opts = ranked.slice(0, 6);
    const j = await choose(
      `Someone reading this text highlighted "${term}" and wants it explained.
Text around it:
"""
${context.slice(0, 1200)}
"""
Which Wikipedia article is about the meaning of "${term}" used in that text?
${opts.map((o, i) => `${i + 1}. ${o.c.title}${o.c.section && sameTerm(o.c.section, term) ? ` (its section "${o.c.section}")` : ''}: ${o.c.description || o.c.intro.slice(0, 140)}${o.cats?.length ? ` [categories: ${o.cats.slice(0, 5).join('; ')}]` : ''}`).join('\n')}`,
      { type: 'object', properties: { article: { enum: opts.map((_, i) => i + 1) } } },
      20
    );
    const n = Number(j?.article);
    if (n >= 1 && n <= opts.length) best = opts[n - 1].c;
  }
  const others = ranked.map((r) => r.c).filter((c) => c !== best).slice(0, 5);
  // Chosen for its section about the term: open the article there.
  if (best.section && !best.fragment && sameTerm(best.section, term)) best = { ...best, fragment: best.section };
  return { best, others };
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

// ---------- Mending clipped or broken input ----------
/**
 * What the reader probably meant when a word at either end of the term looks cut off ("polar dissolves pol",
 * "cellular respir"). Code makes the options: words from the reading that it's the start of, Wikipedia titles that
 * start with the whole input, or the input without the broken word. The librarian picks one; without it, the first.
 * A word counts as cut off only when it never appears whole in the reading but starts longer words there, or when
 * Wikipedia has titles that finish it.
 */
async function mendTerm(term: string, context: string, lang: string, onStatus: (s: string) => void): Promise<string> {
  const ws = term.split(' ');
  const freq = new Map<string, number>();
  for (const w of context.match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu) || []) freq.set(w.toLowerCase(), (freq.get(w.toLowerCase()) || 0) + 1);
  const options: string[] = [];
  const add = (o: string) => o && o.toLowerCase() !== term.toLowerCase() && !options.some((x) => x.toLowerCase() === o.toLowerCase()) && options.push(o);
  // A dictionary word of four letters or more is meant as written ("cell", not "cellular"); shorter ones ("pol") may be cut.
  const whole = async (w: string) => freq.has(w.toLowerCase()) || (w.length >= 4 && !!(await api.lookup.define(w, 1).catch(() => null)));
  const broken = new Map<number, boolean>();
  for (let i = 0; i < ws.length; i++) broken.set(i, ws[i].length >= 2 && !(await whole(ws[i])));
  let clipped = false;
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i].toLowerCase();
    if (!broken.get(i)) continue;
    // From the reading: longer words this one is the start of ("satur" → "saturated"), or for the first word also
    // the end of (a highlight that began mid-word: "ar molecules" → "polar molecules").
    const fits = [...freq.entries()]
      .filter(([c]) => c.length > w.length && (c.startsWith(w) || (i === 0 && c.endsWith(w))))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
    for (const [c] of fits) add(ws.map((x, k) => (k === i ? c : x)).join(' '));
    if (fits.length) clipped = true;
  }
  // From Wikipedia: titles that carry on from the last word ("cellular respir" → "Cellular respiration").
  const last = ws[ws.length - 1];
  // (Not for a lone short fragment with nothing around it: "pol" could start hundreds of titles.)
  const titles = broken.get(ws.length - 1) && (ws.length > 1 || last.length >= 5) ?await api.lookup.complete(term, lang).catch(() => [] as string[]) : [];
  for (const t of titles) {
    if (t.toLowerCase().startsWith(term.toLowerCase()) && isWordChar(t[term.length])) {
      add(t);
      clipped = true;
    }
  }
  // A short broken word at an end of a longer phrase: the phrase without it ("polar dissolves pol" → "polar dissolves").
  if (ws.length >= 3 && last.length <= 4 && broken.get(ws.length - 1) && !clipped) add(ws.slice(0, -1).join(' '));
  if (!options.length) return term;
  if (options.length === 1) return options[0];
  onStatus('Working out what you meant…');
  const j = await choose(
    `Someone highlighted "${term}" in a text to look it up, but a word at the start or end may have been cut off.
${context.trim() ? `Text around it:\n"""\n${context.slice(0, 900)}\n"""\n` : ''}What did they mean to look up?
${options.slice(0, 6).map((o, i) => `${i + 1}. ${o}`).join('\n')}`,
    { type: 'object', properties: { meant: { enum: options.slice(0, 6).map((_, i) => i + 1) } } },
    20
  );
  const n = Number(j?.meant);
  return n >= 1 && n <= Math.min(6, options.length) ? options[n - 1] : options[0];
}

// ---------- Finding the passage about the term ----------
/** The term as a paragraph may write it: "saturated solution", "saturated solutions", "Saturated Solution". */
export function termPattern(term: string) {
  const parts = term
    .trim()
    .split(/\s+/)
    .map((w) => {
      const st = stem(w.toLowerCase());
      return st.length < w.length ? `${esc(st)}\\p{L}{0,4}` : `${esc(w)}(?:s|es)?`;
    });
  return new RegExp(`(?<![\\p{L}\\p{N}])${parts.join('[\\s-]+')}(?![\\p{L}\\p{N}])`, 'giu');
}

/**
 * The paragraphs of an article that are about the term itself, when the term isn't the article's subject
 * ("saturated solution" → "Solubility"). Paragraphs that use the term are ranked by whether they define it
 * ("…a saturated solution, one in which…", "…is called a saturated solution"), by the section a redirect points at,
 * and by how well they fit what you're reading. When two are close, the librarian picks between them.
 */
async function findPassages(page: WikiPage, term: string, context: string, fragment = ''): Promise<ExplainResult['focus']> {
  if (setting('lookup.findPassage') === false) return [];
  // The article is about the term itself ("supersaturated" → "Supersaturation"): its definition is already the answer.
  if (!fragment && sameTerm(term, page.title)) return [];
  // So is one whose opening paragraph names it ("Adenosine triphosphate (ATP) is…", "Freddie Mercury was…").
  if (!fragment && termPattern(term).test(paragraphs(page.lead)[0] || '')) return [];
  const n = Math.max(1, Math.min(5, Number(setting('lookup.passages') ?? 2)));
  const frag = fragment.replace(/_/g, ' ').toLowerCase();
  const termWords = new Set(words(term));
  const keys = new Set([...keywords(context, 40)].filter((w) => !termWords.has(w)));
  const blocks = [{ title: '', text: paragraphs(page.lead) }, ...page.sections.map((s) => ({ title: s.title, text: paragraphs(s.text) }))];
  const cands: { section: string; text: string; mark: string; score: number; order: number }[] = [];
  blocks.forEach((b, bi) => {
    const inFragment = !!frag && b.title.toLowerCase() === frag;
    b.text.forEach((para, pi) => {
      const hits = [...para.matchAll(termPattern(term))];
      if ((!hits.length && !inFragment) || para.length < 60) return;
      // "…the net reaction is:" goes on in the next paragraph (the equation or list it introduces).
      if (/:$/.test(para) && b.text[pi + 1]) para = `${para}\n\n${b.text[pi + 1]}`;
      const mark = hits[0]?.[0] || '';
      const m = esc(mark);
      // "a saturated solution, one in which…", "a saturated solution is…", "…is called a saturated solution".
      const defines =
        !!mark &&
        (new RegExp(`${m}\\)?,?\\s+(?:is|are|refers to|means|describes|denotes)\\b`, 'i').test(para) ||
          new RegExp(`${m},\\s+(?:one|which|that|i\\.e\\.|meaning)\\b`, 'i').test(para) ||
          new RegExp(`\\b(?:called|known as|termed|referred to as|defined as)\\s+(?:an?\\s+|the\\s+)?${m}`, 'i').test(para));
      const score =
        (mark ? 3 : 0) +
        (defines ? 4 : 0) +
        (inFragment ? (pi === 0 ? 6 : 3) : 0) +
        Math.min(2, (hits.length - 1) * 0.5) +
        Math.min(3, overlap(para, keys) * 0.3) +
        (/\b(definition|overview|description|terminology)\b/i.test(b.title) ? 1 : 0) -
        bi * 0.05;
      cands.push({ section: b.title, text: para, mark, score, order: bi * 1000 + pi });
    });
  });
  if (!cands.length) return [];
  const ranked = cands.sort((a, b) => b.score - a.score);
  // A near-tie between passages: the librarian says which one explains the term as it's used in the reading.
  if (ranked.length > 1 && ranked[1].score > ranked[0].score - 1 && context.trim()) {
    const opts = ranked.slice(0, 5);
    const j = await choose(
      `Someone reading this text highlighted "${term}" and wants it explained.
Text around it:
"""
${context.slice(0, 900)}
"""
Which passage from the Wikipedia article "${page.title}" best explains "${term}" as it is used in that text?
${opts.map((o, i) => `${i + 1}. ${o.section ? `[${o.section}] ` : ''}${o.text.slice(0, 320)}`).join('\n')}`,
      { type: 'object', properties: { passage: { enum: opts.map((_, i) => i + 1) } } },
      20
    );
    const k = Number(j?.passage);
    if (k >= 1 && k <= opts.length) ranked.unshift(...ranked.splice(k - 1, 1));
  }
  // The best passage, then other ones that use the term, in article order.
  const [top, ...rest] = ranked;
  const more = rest
    .filter((c) => c.mark && c.score >= 3.5)
    .slice(0, n - 1)
    .sort((a, b) => a.order - b.order);
  return [top, ...more].map(({ section, text, mark }) => ({ section, text, mark }));
}

function shape(term: string, page: WikiPage, sections: ExplainResult['sections'], others: WikiCandidate[], lang: string, focus: ExplainResult['focus'] = []): ExplainResult {
  const lead = paragraphs(page.lead);
  // The opening paragraph is Wikipedia's definition; a very short first line (a note or coordinates) joins the next.
  const first = lead[0] && lead[0].length < 60 && lead[1] ? 2 : 1;
  const definition = lead.slice(0, first).join('\n\n');
  // Never show a paragraph twice: one picked as a passage is left out of the introduction and the sections below.
  const shown = new Set(focus.flatMap((f) => f.text.split(/\n\n+/)));
  const secs = sections.map((s) => ({ ...s, text: s.text.split(/\n\n+/).filter((p) => !shown.has(p)).join('\n\n') })).filter((s) => s.text);
  return { term, page, definition, more: lead.slice(first).filter((p) => !shown.has(p)).join('\n\n'), focus, sections: secs, others, lang };
}

/** Explain a term from Wikipedia: the right article for what you're reading, its definition and its most useful sections. */
export async function explainTerm(asked: string, context: string, onStatus: (s: string) => void, forceTitle?: string): Promise<ExplainResult | null> {
  const lang = lookupLang();
  // Mend a clipped highlight first ("polar dissolves pol" → "polar dissolves polar").
  const term = forceTitle || setting('lookup.mendInput') === false ? asked : await mendTerm(asked.replace(/\s+/g, ' ').trim(), context, lang, onStatus);
  onStatus(term === asked ? 'Searching Wikipedia…' : `Searching Wikipedia for “${term}”…`);
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
  // (Or a longer form of it: "polar" → "Chemical polarity", "python" → "Pythonidae".)
  const named = (c: WikiCandidate) => words(c.title).some((w) => termStems.has(w) || [...termStems].some((s) => s.length >= 4 && w.startsWith(s))) || (!!c.section && sameTerm(c.section, term));
  // Wikipedia's own ranking for the term with the reading's words ("polar water molecules" → "Chemical polarity" first).
  const ctxRank = new Map(withContext.filter(named).map((c, i) => [c.title, i]));
  const cands = [...plain, ...withContext.filter((c) => named(c) && !plain.some((p) => p.title === c.title))].map((c) => (ctxRank.has(c.title) ? { ...c, contextRank: ctxRank.get(c.title) } : c));
  const pick = forceTitle ? { best: cands.find((c) => c.title === forceTitle) || cands[0], others: cands.filter((c) => c.title !== forceTitle && !c.disambiguation).slice(0, 5) } : await pickArticle(term, cands, context, lang);
  if (!pick?.best) return null;
  onStatus(`Reading “${pick.best.title}”…`);
  const page = await api.lookup.article(pick.best.title, lang);
  if (!page) return null;
  onStatus(`Finding “${term}” in “${page.title}”…`);
  const focus = await findPassages(page, term, context, pick.best.fragment);
  const sections = pickSections(page, term, context);
  return { ...shape(term, page, sections, pick.others, lang, focus), asked };
}

/** The same topic from Simple English Wikipedia (shorter sentences, everyday words), when it has an article. */
export async function explainSimpler(r: ExplainResult, context: string, onStatus: (s: string) => void): Promise<ExplainResult | null> {
  onStatus('Looking in Simple English Wikipedia…');
  const cands = await api.lookup.search(r.page.title, 'simple');
  const hit = cands.find((c) => bare(c.title) === bare(r.page.title)) || cands.find((c) => bare(c.title) === bare(r.term));
  if (!hit || hit.disambiguation) return null;
  const page = await api.lookup.article(hit.title, 'simple');
  if (!page) return null;
  return shape(r.term, page, pickSections(page, r.term, context), [], 'simple', await findPassages(page, r.term, context));
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

/**
 * The Dictionary: Wiktionary's entry word for word when online (every sense, with its examples), with synonyms and
 * opposites from the offline dictionary (WordNet). Offline, or when Wiktionary has no entry, WordNet alone.
 */
export async function defineWord(word: string): Promise<DictEntry | null> {
  const w = word.replace(/\s+/g, ' ').trim().replace(/^[“"'(]+|[”"').,;:!?]+$/g, '');
  const maxSenses = Math.max(1, Math.min(30, Number(setting('lookup.dictSenses')) || 12));
  const maxExamples = Math.max(0, Math.min(10, Number(setting('lookup.dictExamples') ?? 4)));
  const offline = api.lookup.define(w, maxSenses).catch(() => null);
  const online = setting('lookup.dictSource') !== 'wordnet' && navigator.onLine ? await api.lookup.wiktionary(w).catch(() => null) : null;
  const wn = await offline;
  if (!online) return wn ? { ...wn, source: 'wordnet' } : null;
  const subs = setting('lookup.dictSubsenses') !== false;
  return {
    ...online,
    entries: online.entries.map((e) => ({ ...e, senses: e.senses.slice(0, maxSenses).map((s) => ({ ...s, examples: s.examples.slice(0, maxExamples), sub: subs ? s.sub : [] })) })),
    synonyms: wn?.synonyms || [],
    antonyms: wn?.antonyms || []
  };
}
