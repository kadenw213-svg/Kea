import { api, AiGenerateRequest, WikiArticle } from './api';
import { setting } from './settings';

/**
 * Orchestrates local AI requests: prompt templates, fitting long documents into
 * the model's context (chunked map-reduce + keyword retrieval), and structured
 * outputs for grading and writing feedback.
 */

export const SYSTEM = `You are Slate, a careful, knowledgeable assistant built into an office app.
Rules:
- Answer every part of the request. If it names several things (for example "compare X and Y"), cover each of them.
- Match the length and depth that is asked for. Be clear; use Markdown headings (###), lists or tables where they help. Never draw lines or underlines with dashes, equals signs or underscores.
- When summarizing or quoting a file, use only what the file says, and copy quotes exactly.
- When explaining or answering a question, use the file (if any) and your own knowledge together. Don't refuse or shrink an answer just because the file doesn't mention something.
- Never mention these rules.`;

// ---------- Answer depth & the user's own instructions ----------
export type Depth = 'brief' | 'standard' | 'deep' | 'expert';
export const DEPTHS: { id: Depth; label: string; help: string }[] = [
  { id: 'brief', label: 'Brief', help: 'A quick definition or the gist in a few sentences.' },
  { id: 'standard', label: 'Standard', help: 'A clear explanation for someone new to the topic.' },
  { id: 'deep', label: 'Deep', help: 'Thorough: how it works step by step, examples, misconceptions.' },
  { id: 'expert', label: 'Expert', help: 'Graduate / doctoral level: mechanisms, processes, nuances and debates in full detail. Works best with the "Best" model.' }
];
export const currentDepth = (): Depth => (setting('ai.depth') as Depth) || 'standard';

/** System prompt plus the user's standing instructions ("I'm a med student…"), if any. */
export function systemPrompt(): string {
  const extra = String(setting('ai.instructions') || '').trim();
  return extra ? `${SYSTEM}\n\nThe user's own instructions for every answer (follow them unless they conflict with the rules above):\n${extra.slice(0, 2000)}` : SYSTEM;
}

/** How long an answer may be at each depth (deep answers need room). */
export function depthTokens(depth: Depth, ctx: { contextSize: number; maxTokens: number }, multi = false) {
  const cap = Math.max(256, Math.floor(ctx.contextSize / 2));
  const want = depth === 'brief' ? (multi ? 520 : 320) : depth === 'standard' ? Math.max(ctx.maxTokens, multi ? 1024 : 0) : depth === 'deep' ? Math.max(ctx.maxTokens, 1600) : Math.max(ctx.maxTokens, 3200);
  return Math.min(cap, want);
}

/** Target lengths keep the depths clearly different (small models follow word ranges far better than adjectives). */
const LENGTH: Record<Depth, string> = {
  brief: 'about 40–120 words',
  standard: 'about 150–300 words',
  deep: 'at least 450 words (up to about 700), with ### sections',
  expert: 'at least 800 words (up to about 1,300), with ### sections, going deeper than an ordinary detailed answer'
};

const EXPLAIN_STYLE: Record<Depth, string> = {
  brief: `In ${LENGTH.brief}, give a plain-language definition or the core meaning of each thing it covers. No preamble, no headings.`,
  standard: `Explain it in plain language (${LENGTH.standard}), as if to a smart reader who is new to the topic. Define any jargon briefly. Finish with one sentence on why it matters.`,
  deep: `Give a thorough explanation for someone who wants to really understand it:
- Start with a 2–3 sentence overview.
- Explain how it works step by step (the process or reasoning, in order).
- Define every key term.
- Give a concrete example.
- Point out common misconceptions.
- End with why it matters and how it connects to related ideas.
Use Markdown headings (###) and lists. Aim for ${LENGTH.deep}.`,
  expert: `Give an expert-level, graduate / doctoral-depth explanation for someone seeking real mastery:
- Overview: the precise, technical statement of the idea.
- Mechanism: walk through the underlying processes step by step, with the causal chain and the relevant detail (molecular, mathematical, physical, legal or theoretical, whichever applies). Include quantities, equations, pathways or structures where they matter.
- Key concepts and precise terminology, defined rigorously.
- Assumptions, conditions and limits: when it holds and when it breaks down; exceptions and edge cases.
- Connections: how it relates to neighbouring concepts and the wider field.
- Nuances, open questions or current debates.
- A worked example or application.
- Recap: 3–5 bullet points to remember.
Use precise technical language and Markdown headings (###). Be thorough (${LENGTH.expert}); do not oversimplify.`
};

const SUMMARY_STYLE: Record<Depth, string> = {
  brief: 'Give a one-sentence TL;DR in bold, then at most 3 short bullet points (under 80 words in all).',
  standard: 'Start with a one-sentence TL;DR in bold, then 3–7 bullet points with the key details (about 120–250 words).',
  deep: 'Start with a bold TL;DR, then a detailed summary organised under Markdown headings (###) that follow the structure of the text, covering every main point, argument, number and conclusion (about 300–600 words).',
  expert: 'Write a rigorous, detailed summary: a bold TL;DR, then sections (###) for the main argument or thesis, the methods / reasoning / evidence, key findings with numbers, assumptions and limitations, and implications. Keep technical terms. Be complete rather than short (about 500–900 words).'
};

const ANSWER_STYLE: Record<Depth, string> = {
  brief: `Be brief (${LENGTH.brief}; a small table is fine for a comparison), but still answer every part of the request.`,
  standard: `Answer clearly and completely (${LENGTH.standard}), for a smart reader who is new to the topic.`,
  deep: `Answer thoroughly (${LENGTH.deep}): explain the reasoning step by step, define key terms, and give examples.`,
  expert: `Answer at an expert, graduate level (${LENGTH.expert}): rigorous and detailed, with the underlying mechanisms, precise technical terminology, evidence, exceptions and nuances.`
};

/** Every depth may use general knowledge; the deeper ones label what comes from the text. */
const KNOWLEDGE = (depth: Depth) =>
  depth === 'deep' || depth === 'expert'
    ? '\nAdd general background knowledge beyond the text wherever it helps, and make clear which points come from the text and which are background.'
    : '\nUse your own knowledge as well as the text, so the answer is complete.';

// ---------- Questions about several things ----------
const COMPARE = /\b(compare|comparison|contrast|versus|vs\.?|differ|differs|differen(ce|ces|t)|similar(ity|ities)?|distinguish|alike|better|worse)\b/i;
export const isComparison = (q: string) => COMPARE.test(q);

/**
 * The separate topics a question asks about ("compare and contrast Bacteria and Archaea" → ["Bacteria", "Archaea"]),
 * so each can be looked up and covered. Single-topic questions return one topic.
 */
export function questionTopics(q: string): string[] {
  const single = () => {
    const one = q.replace(/[?!.,"]/g, ' ').replace(QUESTION_WORDS, ' ').replace(/\s+/g, ' ').trim();
    return one ? [one] : [];
  };
  // Only split when the question compares things or lists several ("A, B and C"); "supply and demand" is one idea.
  const listy = (q.match(/,/g) || []).length >= 1 && /\band\b|\bor\b/i.test(q);
  if (!isComparison(q) && !listy && !/\b(both|each of)\b/i.test(q)) return single();
  let s = ` ${q.replace(/[?!.;:"“”()]/g, ' ')} `;
  s = s.replace(/\b(pros and cons|advantages and disadvantages|strengths and weaknesses|similarities and differences|differences and similarities)\b/gi, ' ');
  // Drop the framing around the topics.
  s = s.replace(/\b(please|can you|could you|would you|tell me|explain|describe|define|discuss|outline|summari[sz]e|give me|list|what|whats|what's|how|why|when|where|who|which|is|are|was|were|do|does|did)\b/gi, ' ');
  s = s.replace(/\b(compare and contrast|compare|contrast|the differences? between|differences? between|similarit(y|ies) between|the similarit(y|ies) between|difference|differences|similarities|relationship between|between|distinguish between|distinguish|differ|alike|in terms of .*$)\b/gi, ' ');
  s = s.replace(/\b(the|a|an|of|about|for|to|me|you|your|both|each|better|worse|best|worst|more|less|healthier|stronger|faster)\b/gi, ' ');
  const parts = s
    .split(/\s*(?:,|\band\b|\bvs\.?\b|\bversus\b|\bor\b|\bwith\b|\bfrom\b|&)\s*/i)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length > 1 && /[a-z0-9]/i.test(p));
  const uniq = [...new Map(parts.map((p) => [p.toLowerCase(), p])).values()];
  if (uniq.length >= 2 && uniq.length <= 4) return uniq.slice(0, 3);
  return single();
}

/** Extra instructions for a request: cover every topic; a structure for comparisons. */
function coverage(question: string, depth: Depth) {
  const topics = questionTopics(question);
  let s = '';
  if (topics.length > 1) s += `\nThis request is about ${topics.length} things (${topics.join(', ')}): cover each of them.`;
  if (isComparison(question))
    s +=
      depth === 'brief'
        ? '\nFor the comparison, give one line on each and the key similarity and difference (a small table is fine).'
        : '\nStructure the comparison: a short overview of each, the key similarities, the key differences (use a Markdown table), and a one-line takeaway.';
  return s;
}

// ---------- Check Wikipedia ----------
/** Characters of article text to give the model, by depth (bounded by what fits in its memory). */
export const WIKI_AMOUNTS = { intro: 1500, medium: 4000, long: 8000 } as const;
export function wikiChars(depth: Depth, contextSize: number) {
  // Settings → AI → Wikipedia: how much to read at each depth (defaults favour speed for quick answers).
  const key = depth === 'deep' ? 'ai.wikiAmountDeep' : depth === 'expert' ? 'ai.wikiAmountExpert' : 'ai.wikiAmountQuick';
  const def = depth === 'deep' ? 'medium' : depth === 'expert' ? 'long' : 'intro';
  const want = WIKI_AMOUNTS[(setting(key) as keyof typeof WIKI_AMOUNTS) || def] || WIKI_AMOUNTS[def];
  return Math.max(800, Math.min(want, Math.floor(contextSize * CHARS_PER_TOKEN * 0.35)));
}

const QUESTION_WORDS = /\b(what|whats|what's|who|whom|whose|when|where|why|how|which|is|are|was|were|do|does|did|can|could|should|would|will|the|a|an|of|about|explain|tell|me|please|define|describe|mean|means|meaning)\b/gi;

/**
 * Words to search Wikipedia for. Fast (default): a short highlight or the question itself, minus question words.
 * Accurate (or a long highlight): the local AI names the best article first (about 2 s).
 */
export async function wikiQuery(text: string, question: string | null, cancelled: () => boolean, isSelection = false): Promise<string[]> {
  const accurate = setting('ai.wikiFind') === 'accurate';
  if (question) {
    // Questions about the user's own file are answered from the file, never from an encyclopedia
    // ("the main argument of my essay" must not turn into "An Essay Concerning Human Understanding").
    if (ABOUT_FILE.test(question)) return [];
    // "What does this mean?" about a highlight: the topic is the highlighted text, not the question's words.
    const content = words(question).filter((w) => !VAGUE.has(w));
    if (!content.length) {
      if (!isSelection) return [];
      question = null;
    }
  }
  if (!question) {
    // A highlighted term (1–3 words) is searched as-is; a longer phrase ("factories powered by water and steam") goes
    // through the AI topic step, because a raw search tends to land on a side topic ("Steam locomotive").
    const t = text.trim();
    const n = t.split(/\s+/).length;
    if (n <= 3 && !accurate) return [t];
    if (questionTopics(t).length > 1 && n <= 12) return questionTopics(t);
  }
  if (question) {
    const topics = questionTopics(question);
    // Several topics are always searched one by one; a single topic uses the chosen finding mode.
    if (topics.length > 1 || (!accurate && topics.length)) return topics;
  }
  const out = await complete(
    {
      system: 'You name encyclopedia topics. Reply with only a Wikipedia article title (1-6 words), nothing else.',
      prompt: `${question ? `Question: ${question}\n` : ''}Text:\n${text.slice(0, 1500)}\n\nWhich Wikipedia article would best help ${question ? 'answer the question' : 'explain this text'}?`,
      maxTokens: 24,
      temperature: 0
    },
    cancelled
  );
  return [out.replace(/["*_`]/g, '').split('\n')[0].trim().slice(0, 120) || (question || text).slice(0, 120)];
}

/** Characters left for the system prompt, including the user's own instructions. */
const systemTokens = () => Math.ceil(systemPrompt().length / CHARS_PER_TOKEN);
const refTokensOf = (refs?: WikiArticle[]) => Math.ceil((refs || []).reduce((a, r) => a + r.text.length + 40, 0) / CHARS_PER_TOKEN);

/** Question words that carry no topic ("what does this mean?"). */
const VAGUE = new Set('this that it its mean means meaning say says said word words term phrase sentence part passage explain simpler simple simply plain english example examples more detail'.split(' '));

/** Words that say the question is about the open file itself. */
const ABOUT_FILE = /\b(this|my|the|our|attached|above|below)\s+(document|doc|essay|file|text|paper|article|pdf|sheet|spreadsheet|table|slides?|presentation|deck|page|paragraph|section|chapter|report|story|letter|notes|data|chart|code)\b|\b(here|in it|this one)\b/i;
const GENERIC = new Set('compare contrast difference differences similar similarities explain describe define summarize summarise list give tell question answer'.split(' '));
/** Whether the open file is relevant to a typed question (a highlight always is). */
export function fileRelevant(question: string, text: string) {
  if (!text.trim()) return false;
  if (ABOUT_FILE.test(question)) return true;
  const terms = words(question).filter((w) => !GENERIC.has(w) && w.length > 2);
  if (!terms.length) return true;
  const doc = text.toLowerCase();
  return terms.some((t) => doc.includes(t.replace(/'s$/, '')));
}

function refsBlock(refs?: WikiArticle[]) {
  if (!refs?.length) return '';
  const today = new Date().toISOString().slice(0, 10);
  return (
    `\n\nREFERENCE from Wikipedia (retrieved ${today}). This is NOT part of the user's file or highlight; it is background material that was looked up. ` +
    `Use it only where it is relevant: for facts it states, prefer it over your memory (it is more up to date). If it is about a different topic than the request, ignore it. ` +
    `Don't limit your answer to it, and never describe the reference as if it were the user's text.\n` +
    refs.map((r) => `[Wikipedia article: ${r.title}]\n${r.text}`).join('\n\n') +
    '\n[End of reference]'
  );
}

// ---------- Streaming generation ----------
export interface Running {
  id: string;
  done: Promise<{ text: string; tokensPerSecond?: number; aborted?: boolean }>;
}

export async function generate(req: AiGenerateRequest, onToken?: (chunk: string, full: string) => void): Promise<Running> {
  const id = await api.ai.generate(req);
  let full = '';
  const done = new Promise<{ text: string; tokensPerSecond?: number; aborted?: boolean }>((resolve, reject) => {
    const off = api.ai.onEvent((e) => {
      if (e.id !== id) return;
      if (e.type === 'token') {
        full += e.text;
        onToken?.(e.text, full);
      } else if (e.type === 'done') {
        off();
        resolve({ text: e.text || full, tokensPerSecond: e.tokensPerSecond, aborted: e.aborted });
      } else {
        off();
        reject(new Error(e.message));
      }
    });
  });
  return { id, done };
}

/** Run to completion (used for intermediate map steps). */
async function complete(req: AiGenerateRequest, cancelled: () => boolean, onStart?: (id: string) => void): Promise<string> {
  if (cancelled()) throw new Error('CANCELLED');
  const r = await generate(req);
  onStart?.(r.id);
  const out = await r.done;
  if (out.aborted || cancelled()) throw new Error('CANCELLED');
  return out.text;
}

// ---------- Budgeting ----------
const CHARS_PER_TOKEN = 3.4;
export function budgetChars(contextSize: number, maxTokens: number, reserve = 700) {
  return Math.max(1500, Math.floor((contextSize - maxTokens - reserve) * CHARS_PER_TOKEN));
}

export function chunkText(text: string, maxChars: number): string[] {
  const paras = text.split(/\n{1,}/);
  const chunks: string[] = [];
  let cur = '';
  for (const p of paras) {
    if (p.length > maxChars) {
      if (cur) chunks.push(cur);
      cur = '';
      for (let i = 0; i < p.length; i += maxChars) chunks.push(p.slice(i, i + maxChars));
      continue;
    }
    if ((cur + '\n' + p).length > maxChars && cur) {
      chunks.push(cur);
      cur = p;
    } else cur = cur ? cur + '\n' + p : p;
  }
  if (cur.trim()) chunks.push(cur);
  return chunks;
}

// ---------- Keyword retrieval (BM25) ----------
const STOP = new Set('a an the and or but if of to in on at for with by from as is are was were be been it this that these those i you he she we they my your our their what which who whom how why when where can could should would do does did not no yes about into than then so such there here'.split(' '));
const words = (s: string) => (s.toLowerCase().match(/[a-z0-9À-ɏ']+/g) || []).filter((w) => w.length > 1 && !STOP.has(w));

export function topChunks(chunks: string[], query: string, maxChars: number): string[] {
  const q = words(query);
  if (!q.length) return chunks.slice(0, Math.max(1, Math.floor(maxChars / (chunks[0]?.length || maxChars))));
  const docs = chunks.map(words);
  const avg = docs.reduce((a, d) => a + d.length, 0) / Math.max(1, docs.length);
  const df = new Map<string, number>();
  docs.forEach((d) => new Set(d).forEach((w) => df.set(w, (df.get(w) || 0) + 1)));
  const k1 = 1.4,
    b = 0.75;
  const scores = docs.map((d, i) => {
    const tf = new Map<string, number>();
    d.forEach((w) => tf.set(w, (tf.get(w) || 0) + 1));
    let s = 0;
    for (const w of q) {
      const f = tf.get(w) || 0;
      if (!f) continue;
      const idf = Math.log(1 + (docs.length - (df.get(w) || 0) + 0.5) / ((df.get(w) || 0) + 0.5));
      s += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avg));
    }
    return { i, s };
  });
  scores.sort((a, z) => z.s - a.s);
  const picked: number[] = [];
  let used = 0;
  for (const { i } of scores) {
    if (used + chunks[i].length > maxChars) continue;
    picked.push(i);
    used += chunks[i].length;
  }
  return picked.sort((a, z) => a - z).map((i) => chunks[i]);
}

// ---------- Tasks ----------
export interface TaskContext {
  /** Wikipedia articles fetched for this request ("Check Wikipedia"), if any. */
  refs?: WikiArticle[];
  text: string;
  /** True when the text is the user's highlight (always relevant); false for a whole file. */
  isSelection?: boolean;
  scopeLabel: string; // "the selected text" | "the whole document"
  docName: string;
  noun: string;
  contextSize: number;
  maxTokens: number;
}

export interface TaskCallbacks {
  onToken(full: string): void;
  onStatus(status: string): void;
  onRequest(id: string): void;
  cancelled(): boolean;
}

const quote = (t: string) => `"""\n${t}\n"""`;

/** Shrink text that is too long for one request by summarizing chunks with a focus. */
async function condense(ctx: TaskContext, focus: string, cb: TaskCallbacks, extraReserve = 0): Promise<string> {
  const budget = budgetChars(ctx.contextSize, ctx.maxTokens, 700 + systemTokens() + extraReserve);
  if (ctx.text.length <= budget) return ctx.text;
  const chunks = chunkText(ctx.text, Math.floor(budget * 0.9));
  const notes: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    cb.onStatus(`Reading part ${i + 1} of ${chunks.length}…`);
    notes.push(
      await complete(
        {
          system: systemPrompt(),
          prompt: `This is part ${i + 1} of ${chunks.length} of ${ctx.docName}.\n${quote(chunks[i])}\n\n${focus}\nWrite compact notes (bullet points). Keep 1–3 short exact quotes that matter.`,
          maxTokens: 350,
          temperature: 0.2
        },
        cb.cancelled,
        cb.onRequest
      )
    );
  }
  const joined = notes.map((n, i) => `Part ${i + 1}:\n${n}`).join('\n\n');
  if (joined.length > budget) return condense({ ...ctx, text: joined, docName: `notes on ${ctx.docName}` }, focus, cb, extraReserve);
  return joined;
}

export async function runExplain(ctx: TaskContext, cb: TaskCallbacks, depth: Depth = currentDepth()) {
  const multi = questionTopics(ctx.text.length < 200 ? ctx.text : '').length > 1;
  const answerTokens = depthTokens(depth, ctx, multi);
  const text = await condense({ ...ctx, maxTokens: answerTokens }, 'Note the key ideas, processes and any terms a reader might not know.', cb, refTokensOf(ctx.refs));
  cb.onStatus('');
  return stream(
    {
      system: systemPrompt(),
      prompt: `Explain ${ctx.scopeLabel} from "${ctx.docName}".\n${EXPLAIN_STYLE[depth]}${KNOWLEDGE(depth)}${ctx.text.length < 200 ? coverage(ctx.text, depth) : ''}\n\n${quote(text)}${refsBlock(ctx.refs)}`,
      maxTokens: answerTokens
    },
    cb
  );
}

export async function runSummarize(ctx: TaskContext, cb: TaskCallbacks, depth: Depth = currentDepth()) {
  const maxTokens = depthTokens(depth, ctx);
  ctx = { ...ctx, maxTokens };
  const text = await condense(ctx, 'Capture the main points, decisions, numbers and conclusions.', cb, refTokensOf(ctx.refs));
  cb.onStatus('');
  const condensed = text !== ctx.text;
  return stream(
    {
      system: systemPrompt(),
      prompt: `Summarize ${ctx.scopeLabel} from "${ctx.docName}"${condensed ? ' (provided as notes, because it is long)' : ''}.\n${SUMMARY_STYLE[depth]}\n\n${quote(text)}${ctx.refs?.length ? refsBlock(ctx.refs) + '\n(Use the reference only for background; summarize the text itself.)' : ''}`,
      maxTokens
    },
    cb
  );
}

export async function runAsk(question: string, history: { role: 'user' | 'assistant'; text: string }[], ctx: TaskContext, cb: TaskCallbacks, depth: Depth = currentDepth()) {
  const maxTokens = depthTokens(depth, ctx, questionTopics(question).length > 1);
  ctx = { ...ctx, maxTokens };
  const budget = budgetChars(ctx.contextSize, ctx.maxTokens, 900 + systemTokens() + refTokensOf(ctx.refs) + history.reduce((a, h) => a + h.text.length / CHARS_PER_TOKEN, 0));
  // A general question shouldn't drag an unrelated open file along (it distracts the model and costs time).
  let text = ctx.isSelection || fileRelevant(question, ctx.text) ? ctx.text : '';
  let note = '';
  if (text.length > budget) {
    text = topChunks(chunkText(text, 1600), question, budget).join('\n…\n');
    note = ' (only the parts most relevant to the request are included)';
  }
  return stream(
    {
      system: systemPrompt(),
      history,
      prompt: `${text.trim() ? `Here is ${ctx.scopeLabel} from "${ctx.docName}"${note}:\n${quote(text)}\n(The request may be about this file or about anything else. If it isn't about the file, just answer it.)` : 'There is no file for this request; answer it from your knowledge.'}${refsBlock(ctx.refs)}\n\nRequest: ${question}\n\n(${ANSWER_STYLE[depth]}${KNOWLEDGE(depth)}${coverage(question, depth)})`,
      maxTokens
    },
    cb
  );
}

async function stream(req: AiGenerateRequest, cb: TaskCallbacks) {
  if (cb.cancelled()) throw new Error('CANCELLED');
  const r = await generate(req, (_c, full) => cb.onToken(full));
  cb.onRequest(r.id);
  return r.done;
}

// ---------- Structured feedback ----------
export interface Suggestion {
  quote: string;
  issue: string;
  suggestion: string;
}

const SUGGEST_SCHEMA = {
  type: 'object',
  properties: {
    suggestions: {
      type: 'array',
      minItems: 1,
      maxItems: 4,
      items: { type: 'object', properties: { quote: { type: 'string', maxLength: 240 }, issue: { type: 'string', maxLength: 160 }, suggestion: { type: 'string', maxLength: 320 } } }
    }
  }
};

/** A few concrete, ready-to-apply rewrites for the selected text (or the document). */
export async function runSuggest(ctx: TaskContext, cb: TaskCallbacks): Promise<Suggestion[]> {
  const work = await condense({ ...ctx, maxTokens: 800 }, 'Note the sentences that are unclear, wordy, awkward or have mistakes, quoting them exactly.', cb);
  cb.onStatus('Looking for improvements…');
  const r = await stream(
    {
      system: systemPrompt(),
      prompt: `Suggest up to 4 specific edits that would most improve ${ctx.scopeLabel} of "${ctx.docName}" (clarity, concision, flow, grammar).
For each: "quote" = an exact sentence or phrase copied word-for-word from the text, "issue" = what's wrong in a few words, "suggestion" = the improved version that can directly replace the quote.

TEXT:
${quote(work)}`,
      jsonSchema: SUGGEST_SCHEMA,
      temperature: 0.3,
      maxTokens: 800
    },
    { ...cb, onToken: (full) => cb.onStatus(`Looking for improvements… ${(full.match(/"suggestion"/g) || []).length} found`) }
  );
  const j = parseJson(r.text) || {};
  return (j.suggestions || [])
    .filter((x: any) => x && x.quote && x.suggestion && String(x.quote).trim() !== String(x.suggestion).trim())
    .map((x: any) => ({ quote: String(x.quote).trim(), issue: String(x.issue || '').trim(), suggestion: String(x.suggestion).trim() }));
}

// ---------- Study tools ----------
export interface Flashcard {
  front: string;
  back: string;
}
export interface QuizQuestion {
  question: string;
  choices: string[];
  answer: number;
  explanation: string;
}
export type Difficulty = 'easy' | 'medium' | 'hard';
const LEVEL: Record<Difficulty, string> = {
  easy: 'basic recall of the most important facts and definitions',
  medium: 'understanding: why and how, not just what',
  hard: 'application and analysis: compare ideas, apply them to new cases, spot misconceptions'
};

/** Flashcards (term/question → answer) from the text. */
export async function runFlashcards(ctx: TaskContext, cb: TaskCallbacks, count: number, difficulty: Difficulty): Promise<Flashcard[]> {
  const outTokens = Math.min(Math.floor(ctx.contextSize * 0.55), 120 * count + 200);
  const work = await condense({ ...ctx, maxTokens: outTokens }, 'Note the key facts, definitions, names, dates, formulas and concepts worth memorising.', cb);
  cb.onStatus('Making flashcards…');
  const r = await stream(
    {
      system: systemPrompt(),
      prompt: `Make ${count} study flashcards from ${ctx.scopeLabel} of "${ctx.docName}". Level: ${LEVEL[difficulty]}.
"front" = a short question or term; "back" = a concise, correct answer (one or two sentences). Use only information in the text. No duplicates.

TEXT:
${quote(work)}`,
      jsonSchema: {
        type: 'object',
        properties: {
          cards: { type: 'array', minItems: count, maxItems: count, items: { type: 'object', properties: { front: { type: 'string', maxLength: 200 }, back: { type: 'string', maxLength: 400 } } } }
        }
      },
      temperature: 0.3,
      maxTokens: outTokens
    },
    { ...cb, onToken: (full) => cb.onStatus(`Making flashcards… ${(full.match(/"back"/g) || []).length} of ${count}`) }
  );
  const j = parseJson(r.text) || {};
  const seen = new Set<string>();
  return (j.cards || [])
    .map((c: any) => ({ front: String(c?.front || '').trim(), back: String(c?.back || '').trim() }))
    .filter((c: Flashcard) => c.front && c.back && !seen.has(c.front.toLowerCase()) && seen.add(c.front.toLowerCase()));
}

/** Multiple-choice practice quiz from the text. */
export async function runQuiz(ctx: TaskContext, cb: TaskCallbacks, count: number, difficulty: Difficulty): Promise<QuizQuestion[]> {
  const outTokens = Math.min(Math.floor(ctx.contextSize * 0.55), 220 * count + 200);
  const work = await condense({ ...ctx, maxTokens: outTokens }, 'Note the key facts, ideas and relationships a test might ask about.', cb);
  cb.onStatus('Writing questions…');
  const r = await stream(
    {
      system: systemPrompt(),
      prompt: `Write a ${count}-question multiple-choice practice quiz (keep each answer short, under 20 words) on ${ctx.scopeLabel} of "${ctx.docName}". Level: ${LEVEL[difficulty]}.
For each question: "correct" = the right answer; "wrong" = 3 believable but clearly incorrect answers; "explanation" = one sentence on why the right answer is right, based on the text.

TEXT:
${quote(work)}`,
      jsonSchema: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            minItems: count,
            maxItems: count,
            items: {
              type: 'object',
              properties: {
                question: { type: 'string', maxLength: 300 },
                correct: { type: 'string', maxLength: 260 },
                wrong: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'string', maxLength: 260 } },
                explanation: { type: 'string', maxLength: 300 }
              }
            }
          }
        }
      },
      temperature: 0.4,
      maxTokens: outTokens
    },
    { ...cb, onToken: (full) => cb.onStatus(`Writing questions… ${(full.match(/"explanation"/g) || []).length} of ${count}`) }
  );
  const j = parseJson(r.text) || {};
  return (j.questions || [])
    .map((q: any) => {
      // The model names the right answer itself (small models often mix up answer letters); Slate shuffles.
      const correct = String(q?.correct || '').trim();
      const wrong: string[] = (Array.isArray(q?.wrong) ? q.wrong : []).map((c: any) => String(c).trim()).filter((c: string) => c && c.toLowerCase() !== correct.toLowerCase());
      const choices = [correct, ...wrong.slice(0, 3)];
      for (let i = choices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [choices[i], choices[j]] = [choices[j], choices[i]];
      }
      return { question: String(q?.question || '').trim(), choices, answer: correct ? choices.indexOf(correct) : -1, explanation: String(q?.explanation || '').trim() };
    })
    .filter((q: QuizQuestion) => q.question && q.choices.length >= 2 && Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.choices.length);
}

function parseJson(t: string): any {
  try {
    return JSON.parse(t);
  } catch {
    const m = t.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {}
    }
    return null;
  }
}
// ---------- Small helpers ----------
export function wordCount(t: string) {
  return (t.match(/\S+/g) || []).length;
}

/** Minimal Markdown → HTML for assistant replies (escaped first). */
export function markdownToHtml(md: string): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const inline = (s: string) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/__([^_]+)__/g, '<strong>$1</strong>');
  const lines = md.replace(/\r/g, '').split('\n');
  let html = '';
  let list: 'ul' | 'ol' | null = null;
  let inCode = false;
  const close = () => {
    if (list) html += `</${list}>`;
    list = null;
  };
  const isRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
  const isRule = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const cells = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    // Tables: a header row, a |---|---| rule, then body rows.
    if (!inCode && isRow(raw) && li + 1 < lines.length && isRule(lines[li + 1])) {
      close();
      const head = cells(raw);
      html += `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>`;
      li += 2;
      while (li < lines.length && isRow(lines[li])) {
        const row = cells(lines[li]);
        html += `<tr>${head.map((_, i) => `<td>${inline(row[i] || '')}</td>`).join('')}</tr>`;
        li++;
      }
      html += '</tbody></table>';
      li--;
      continue;
    }
    // "Heading" followed by ===== or ----- (setext headings).
    if (!inCode && raw.trim() && li + 1 < lines.length && /^\s*(=+|-{3,})\s*$/.test(lines[li + 1]) && !/^\s*[-*•|#]/.test(raw)) {
      close();
      const level = lines[li + 1].trim()[0] === '=' ? 3 : 4;
      html += `<h${level}>${inline(raw.trim())}</h${level}>`;
      li++;
      continue;
    }
    if (!inCode && /^\s*(-{3,}|\*{3,}|_{3,}|={3,})\s*$/.test(raw)) {
      close();
      html += '<hr>';
      continue;
    }
    if (raw.trim().startsWith('```')) {
      close();
      html += inCode ? '</code></pre>' : '<pre><code>';
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      html += esc(raw) + '\n';
      continue;
    }
    const line = raw.trimEnd();
    let m;
    if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) {
      if (list !== 'ul') {
        close();
        html += '<ul>';
        list = 'ul';
      }
      html += `<li>${inline(m[1])}</li>`;
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      if (list !== 'ol') {
        close();
        html += '<ol>';
        list = 'ol';
      }
      html += `<li>${inline(m[1])}</li>`;
    } else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      close();
      const h = Math.min(6, m[1].length + 2);
      html += `<h${h}>${inline(m[2].replace(/\s*#+\s*$/, ''))}</h${h}>`;
    } else if (!line.trim()) {
      close();
    } else {
      close();
      html += `<p>${inline(line)}</p>`;
    }
  }
  close();
  if (inCode) html += '</code></pre>';
  return html;
}

/** Plain text for inserting into editors that don't take rich text. */
export function markdownToPlain(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, ''))
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}
