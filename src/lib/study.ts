/**
 * Quizzes for readings. The loaded document is the curriculum:
 *  1. the local AI lists the reading's sections and key concepts once (cached per file),
 *  2. each quiz picks concepts across all sections (missed ones first) and a mix of exam-style formats,
 *  3. one AI call writes one question for one concept in one format, and it is checked before it's shown,
 *  4. missed concepts come back later in a different format, and first in the next quiz on that file.
 * Only the concept list and which concepts were missed are stored (in <userData>/study), never transcripts.
 */
import { api } from './api';
import { generate, systemPrompt, chunkText, budgetChars } from './ai';
import { setting } from './settings';

// ---------- Types ----------
export type QFormat = 'mc' | 'multi' | 'tf' | 'fill' | 'short';
export type QKind = 'recall' | 'applied' | 'twist';
export const FORMAT_LABEL: Record<QFormat, string> = {
  mc: 'Multiple choice',
  multi: 'Select all that apply',
  tf: 'True or false',
  fill: 'Fill in the blank',
  short: 'Short answer'
};

export interface Concept {
  id: string;
  section: string;
  name: string;
  /** The sentence in the reading this concept comes from ("Show in document"). */
  source: string;
}
export interface ConceptState {
  missed: boolean;
  confidence: number; // −1…+1
  attempts: number;
  last?: boolean;
  lastFormat?: QFormat;
  lastAt?: string;
  /** The last question asked about it, so the next quiz asks something new. */
  lastQ?: string;
}
export interface StudyRecord {
  v: 1;
  docName: string;
  fingerprint: string;
  level: string;
  concepts: Concept[];
  state: Record<string, ConceptState>;
}

export interface PlanItem {
  concept: Concept;
  format: QFormat;
  kind: QKind;
  /** Another concept to combine with, for "twist" questions. */
  partner?: Concept;
  retest?: boolean;
}

export interface Question {
  item: PlanItem;
  format: QFormat;
  prompt: string;
  /** Choice formats: the options shown, in display order. */
  choices: string[];
  /** Indexes of correct choices (mc/tf: one; multi: two or more). */
  correct: number[];
  /** Fill in the blank: accepted answers. */
  accepted: string[];
  /** True/false: the corrected statement when it's false. Short answer: the key points. */
  fix?: string;
  keyPoints: string[];
  modelAnswer?: string;
  explanation: string;
}

// ---------- Helpers ----------
const STOP = new Set('a an the and or but if of to in on at for with by from as is are was were be been it this that these those which who what how why when where can could should would do does did not no than then so such into its their there here about also more most some any each other'.split(' '));
const words = (s: string) => (s.toLowerCase().match(/[a-z0-9À-ɏ]+/g) || []).filter((w) => w.length > 2 && !STOP.has(w));
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9À-ɏ ]+/g, ' ').replace(/\s+/g, ' ').trim();
const uid = () => 'c' + Math.random().toString(36).slice(2, 10);
function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
export function shuffle<T>(a: T[]): T[] {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}
function parseJson(t: string): any {
  try {
    return JSON.parse(t);
  } catch {
    const m = t.match(/\{[\s\S]*\}/);
    try {
      return m ? JSON.parse(m[0]) : null;
    } catch {
      return null;
    }
  }
}
async function ask(prompt: string, schema: any, maxTokens: number, temperature: number, cancelled: () => boolean, system = systemPrompt()) {
  if (cancelled()) throw new Error('CANCELLED');
  const r = await generate({ system, prompt, jsonSchema: schema, maxTokens, temperature });
  const out = await r.done;
  if (out.aborted || cancelled()) throw new Error('CANCELLED');
  return parseJson(out.text) || {};
}
function sentences(text: string) {
  return (text.replace(/\s+/g, ' ').match(/[^.!?]+[.!?]+/g) || []).map((s) => s.trim()).filter((s) => s.length > 20);
}
/** The reading's sentence that best matches a concept (for "Show in document" and as the question's source). */
function sourceFor(name: string, hint: string, sents: string[]) {
  const want = new Set([...words(name), ...words(hint)]);
  let best = '';
  let bestScore = 0;
  for (const s of sents) {
    const w = words(s);
    const score = w.filter((x) => want.has(x)).length / Math.sqrt(w.length + 1);
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best;
}

// ---------- Storage ----------
export const studyKey = (docKey: string) => `quiz:${docKey}`;
export async function loadRecord(docKey: string): Promise<StudyRecord | null> {
  const r = await api.study.get(studyKey(docKey)).catch(() => null);
  return r && r.v === 1 ? r : null;
}
export async function saveRecord(docKey: string, rec: StudyRecord) {
  if (setting('ai.quizMemory') === false) return;
  await api.study.save(studyKey(docKey), rec).catch(() => {});
}
export async function resetRecord(docKey: string) {
  await api.study.reset(studyKey(docKey)).catch(() => {});
}
export const missedCount = (rec: StudyRecord | null) => (rec ? rec.concepts.filter((c) => rec.state[c.id]?.missed).length : 0);

// ---------- 1. Concept list ----------
/**
 * Split the reading into its own sections: paragraphs (or heading + paragraphs), merged when tiny and split when
 * huge. Slate does this itself so every part of the reading is guaranteed a place in the concept list.
 */
export function readingBlocks(text: string): { title: string; body: string }[] {
  const paras = text.replace(/\r/g, '').split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean);
  const blocks: { title: string; body: string }[] = [];
  let pendingTitle = '';
  for (const p of paras) {
    const oneLine = !p.includes('\n') && p.length < 90 && !/[.!?]$/.test(p);
    if (oneLine) {
      pendingTitle = p; // a heading: title for the next block
      continue;
    }
    const last = blocks[blocks.length - 1];
    if (last && !pendingTitle && last.body.length < 350) last.body += '\n' + p;
    else blocks.push({ title: pendingTitle, body: p });
    pendingTitle = '';
  }
  // Split very long blocks so each gets its own concepts.
  return blocks.flatMap((b) => (b.body.length > 2600 ? chunkText(b.body, 2200).map((body, i) => ({ title: b.title ? `${b.title} (${i + 1})` : '', body })) : [b]));
}

/** Find the key concepts of every section of the reading (a few short AI calls; one per group of sections). */
export async function buildConcepts(text: string, docName: string, contextSize: number, cancelled: () => boolean, onStatus: (s: string) => void) {
  const budget = Math.min(budgetChars(contextSize, 900), 9000);
  const blocks = readingBlocks(text).slice(0, 40);
  const groups: { title: string; body: string }[][] = [];
  for (const b of blocks) {
    const g = groups[groups.length - 1];
    if (g && g.reduce((a, x) => a + x.body.length, 0) + b.body.length < budget && g.length < 6) g.push(b);
    else groups.push([b]);
  }
  const sents = sentences(text);
  const concepts: Concept[] = [];
  let level = 'college';
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    onStatus(groups.length > 1 ? `Reading the material (part ${gi + 1} of ${groups.length})…` : 'Reading the material…');
    const schema = {
      type: 'object',
      properties: {
        level: { enum: ['high school', 'college', 'graduate'] },
        sections: {
          type: 'array',
          minItems: g.length,
          maxItems: g.length,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', maxLength: 60 },
              concepts: { type: 'array', minItems: 2, maxItems: 3, items: { type: 'object', properties: { name: { type: 'string', maxLength: 50 }, key: { type: 'string', maxLength: 50 } } } }
            }
          }
        }
      }
    };
    const j = await ask(
      `Below are ${g.length} section${g.length > 1 ? 's' : ''} of a reading from "${docName}". For EACH section, in order, give a short "title" and its 2–3 most important testable concepts.
Each concept: "name" = 2–5 words; "key" = 3–6 words naming its key fact. Use only this section's content for its concepts. Also give the reading's academic "level".

${g.map((b, i) => `[Section ${i + 1}]${b.title ? ` ${b.title}` : ''}\n${b.body}`).join('\n\n')}`,
      schema,
      150 * g.length + 80,
      0.2,
      cancelled
    );
    if (j.level) level = j.level;
    (j.sections || []).forEach((sec: any, i: number) => {
      const block = g[i];
      if (!block) return;
      const blockSents = sentences(block.body);
      const title = (block.title || String(sec?.title || '')).trim() || `Part ${concepts.length + 1}`;
      for (const c of sec?.concepts || []) {
        const name = String(c?.name || '').trim();
        if (!name || concepts.some((x) => norm(x.name) === norm(name))) continue;
        const source = sourceFor(name, String(c?.key || ''), blockSents.length ? blockSents : sents);
        if (source) concepts.push({ id: uid(), section: title, name, source });
      }
    });
  }
  return { concepts: concepts.slice(0, 60), level };
}

/** The file's record, building (or refreshing) the concept list when the reading changed. */
export async function ensureRecord(docKey: string, text: string, docName: string, contextSize: number, cancelled: () => boolean, onStatus: (s: string) => void): Promise<StudyRecord> {
  const fp = hash(`${text.length}|${text.slice(0, 2000)}|${text.slice(-1000)}`);
  const old = await loadRecord(docKey);
  if (old && old.fingerprint === fp && old.concepts.length) return old;
  const { concepts, level } = await buildConcepts(text, docName, contextSize, cancelled, onStatus);
  // Keep progress for concepts that are still there (matched by name).
  const state: Record<string, ConceptState> = {};
  for (const c of concepts) {
    const prev = old?.concepts.find((o) => norm(o.name) === norm(c.name));
    if (prev && old!.state[prev.id]) state[c.id] = old!.state[prev.id];
  }
  const rec: StudyRecord = { v: 1, docName, fingerprint: fp, level, concepts, state };
  await saveRecord(docKey, rec);
  return rec;
}

/** Concepts in a highlighted part of the reading (its sentences overlap the highlight). */
export function conceptsIn(rec: StudyRecord, selection: string) {
  const sel = norm(selection);
  return rec.concepts.filter((c) => sel.includes(norm(c.source).slice(0, 60)) || words(c.name).every((w) => sel.includes(w)));
}

// ---------- 2. Planning a quiz ----------
export function enabledFormats(): QFormat[] {
  const f = (setting('ai.quizFormats') as Record<string, boolean>) || {};
  const all: QFormat[] = ['mc', 'multi', 'tf', 'fill', 'short'];
  const on = all.filter((x) => f[x] !== false);
  return on.length ? on : ['mc'];
}

/**
 * Pick concepts (missed first, then untested, then the least recently tested), spread round-robin over the
 * sections, and give each a format and a kind (recall / applied / twist) so every quiz is a real mix.
 */
export function planQuiz(rec: StudyRecord, count: number, pool: Concept[], difficulty: 'easy' | 'medium' | 'hard', onlyMissed = false): PlanItem[] {
  const st = (c: Concept) => rec.state[c.id];
  let cands = onlyMissed ? pool.filter((c) => st(c)?.missed || (st(c)?.confidence ?? 0) < 0) : pool;
  if (!cands.length) cands = pool;
  const score = (c: Concept) => {
    const s = st(c);
    if (s?.missed) return 0;
    if (!s || !s.attempts) return 1 + Math.random();
    return 3 + s.confidence + (s.lastAt ? new Date(s.lastAt).getTime() / 1e13 : 0) + Math.random() * 0.5;
  };
  // Round-robin over sections, each section's concepts in priority order.
  const bySection = new Map<string, Concept[]>();
  for (const c of [...cands].sort((a, b) => score(a) - score(b))) {
    if (!bySection.has(c.section)) bySection.set(c.section, []);
    bySection.get(c.section)!.push(c);
  }
  // Sections holding missed concepts go first.
  const sections = [...bySection.keys()].sort((a, b) => score(bySection.get(a)![0]) - score(bySection.get(b)![0]));
  const picked: Concept[] = [];
  while (picked.length < count && sections.some((s) => bySection.get(s)!.length)) {
    for (const s of sections) {
      const next = bySection.get(s)!.shift();
      if (next && picked.length < count) picked.push(next);
    }
  }
  // Too few concepts for the count: reuse them (they'll get different formats).
  for (let i = 0; picked.length < count && picked.length; i++) picked.push(picked[i % picked.length]);

  const formats = enabledFormats();
  const fmts = shuffle(formats);
  const applied = difficulty === 'easy' ? Math.round(count * 0.15) : difficulty === 'hard' ? Math.round(count * 0.5) : Math.round(count / 3);
  // Twists (NOT/EXCEPT, two concepts at once) are where small models slip most, so only Hard uses them.
  const twists = difficulty === 'hard' && count >= 4 ? 1 : 0;
  const kinds: QKind[] = shuffle([...Array(count)].map((_, i) => (i < twists ? 'twist' : i < twists + applied ? 'applied' : 'recall')));
  return picked.map((concept, i) => {
    const s = st(concept);
    // Rotate formats; avoid repeating the format last used for this concept.
    let format = fmts[i % fmts.length];
    if (s?.lastFormat === format && formats.length > 1) format = fmts[(i + 1) % fmts.length];
    const kind: QKind = kinds[i] === 'twist' && format !== 'mc' && format !== 'multi' ? 'applied' : kinds[i];
    const partner = kind === 'twist' ? pool.find((c) => c.id !== concept.id && c.section === concept.section) || pool.find((c) => c.id !== concept.id) : undefined;
    return { concept, format, kind, partner };
  });
}

/** A missed concept comes back in a different format. */
export function retestItem(item: PlanItem): PlanItem {
  const formats = enabledFormats().filter((f) => f !== item.format);
  return { concept: item.concept, format: formats.length ? shuffle(formats)[0] : item.format, kind: 'recall', retest: true };
}

// ---------- 3. Writing one question ----------
const LEVEL_TEXT = (lvl: string) => (lvl === 'graduate' ? 'graduate' : lvl === 'high school' ? 'high-school' : 'college');
const KIND_TEXT: Record<QKind, string> = {
  recall: 'It checks that the student knows this concept precisely (a real, discriminating detail, not trivia).',
  applied: 'It asks WHY or HOW, or applies the concept to a new example or short scenario, instead of recalling a definition.',
  twist: 'It has an exam twist: use NOT/EXCEPT phrasing, or make the student connect this concept with the second concept given.'
};

const SCHEMAS: Record<QFormat, any> = {
  mc: { type: 'object', properties: { question: { type: 'string', maxLength: 320 }, correct: { type: 'string', maxLength: 180 }, wrong: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'string', maxLength: 180 } }, explanation: { type: 'string', maxLength: 360 } } },
  multi: { type: 'object', properties: { question: { type: 'string', maxLength: 320 }, correct: { type: 'array', minItems: 2, maxItems: 3, items: { type: 'string', maxLength: 160 } }, wrong: { type: 'array', minItems: 2, maxItems: 3, items: { type: 'string', maxLength: 160 } }, explanation: { type: 'string', maxLength: 360 } } },
  tf: { type: 'object', properties: { trueStatement: { type: 'string', maxLength: 260 }, changedDetail: { type: 'string', maxLength: 120 }, falseStatement: { type: 'string', maxLength: 260 }, explanation: { type: 'string', maxLength: 300 } } },
  fill: { type: 'object', properties: { sentence: { type: 'string', maxLength: 300 }, answer: { type: 'string', maxLength: 60 }, alternatives: { type: 'array', maxItems: 3, items: { type: 'string', maxLength: 60 } }, explanation: { type: 'string', maxLength: 300 } } },
  short: { type: 'object', properties: { question: { type: 'string', maxLength: 320 }, keyPoints: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string', maxLength: 160 } }, modelAnswer: { type: 'string', maxLength: 400 }, explanation: { type: 'string', maxLength: 300 } } }
};

const FORMAT_RULES: Record<QFormat, string> = {
  mc: '"correct" = the right answer (at most 20 words); "wrong" = 3 believable but clearly WRONG answers built from common misconceptions. Each wrong answer must be false as an answer to this question (not merely a different true fact), must not say the same thing as the right answer, and must read as a complete answer on its own (no "they" or "it" without a subject). All four options about the same length and style.',
  multi: '"question" = "Which of the following are true about …?" (plural). "correct" = 2–3 short, complete statements that are definitely true; "wrong" = 2 short, complete statements that are definitely false (common misconceptions). No two statements may say the same thing. Each at most 20 words.',
  tf: '"trueStatement" = one precise, correct claim about this concept, staying close to the reading. "changedDetail" = one important detail you change (to a common misconception). "falseStatement" = the same claim with only that detail changed, so it is clearly false. "explanation" says what the correct detail is.',
  fill: '"sentence" = a sentence with the key term replaced by "____" (exactly one blank). "answer" = the missing term (1–3 words); "alternatives" = other acceptable spellings or synonyms.',
  short: 'An open question answerable in 1–3 sentences. "keyPoints" = what a full answer must include; "modelAnswer" = a model answer.'
};

/** One question, for one concept, in one format. Checked before it's returned; null if it can't be made valid. */
export async function writeQuestion(item: PlanItem, rec: StudyRecord, context: string, cancelled: () => boolean, avoid: string[] = []): Promise<Question | null> {
  const last = rec.state[item.concept.id]?.lastQ;
  if (last) avoid = [...avoid, last];
  // Fill in the blank comes straight from the reading's own sentence: instant, and always accurate.
  if (item.format === 'fill') {
    const b = blankFromSource(item, avoid, context);
    if (b) return b;
  }
  const level = setting('ai.quizLevel') && setting('ai.quizLevel') !== 'auto' ? String(setting('ai.quizLevel')) : rec.level;
  const docOnly = setting('ai.quizScope') === 'document';
  const scope = docOnly
    ? 'Use ONLY what the reading says; every fact in the question and answers must be stated in the reading.'
    : `Write it like a real ${LEVEL_TEXT(level)} exam question. You may use standard ${LEVEL_TEXT(level)}-level knowledge to make it realistic, but it must test THIS concept from the reading, and must not bring in topics the reading doesn't cover.`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const format: QFormat = attempt === 0 ? item.format : 'mc';
    const prompt = `Write ONE ${FORMAT_LABEL[format].toLowerCase()} exam question.
Concept: "${item.concept.name}" (section: ${item.concept.section})
From the reading: "${item.concept.source}"${item.partner ? `\nSecond concept (for the twist): "${item.partner.name}": "${item.partner.source}"` : ''}
${KIND_TEXT[item.kind]}
${scope}
${FORMAT_RULES[format]}
"explanation" = 1–2 sentences: why the right answer is right${format === 'mc' || format === 'multi' || format === 'tf' ? ', and why the tempting wrong answer is a trap' : ''}.
Don't put the answer in the question. Don't mention "the reading" or "the text" in the question.

Reading context:
"""
${context}
"""`;
    const j = await ask(prompt, SCHEMAS[format], 520, 0.6, cancelled);
    const q = toQuestion(item, format, j);
    if (!q) {
      quizLog.push({ concept: item.concept.name, format, stage: 'invalid', raw: JSON.stringify(j).slice(0, 400) });
      continue;
    }
    if (avoid.some((a) => similar(a, q.prompt))) {
      quizLog.push({ concept: item.concept.name, format, stage: 'repeat', raw: q.prompt });
      continue;
    }
    const v = setting('ai.quizVerify') === false ? { ok: true, why: '' } : await verifyQuestion(q, context, cancelled);
    if (v.ok) return q;
    quizLog.push({ concept: item.concept.name, format, stage: 'verify', raw: `${v.why} | ${q.prompt} | ${q.choices.join(' / ')} | key ${q.correct.join(',')} ${q.accepted.join(',')}` });
  }
  // Last resort that never fails: a fill-in-the-blank built from the concept's own sentence in the reading.
  return blankFromSource(item, avoid, context);
}

/** Why questions were rejected (for testing and tuning). */
export const quizLog: { concept: string; format: string; stage: string; raw: string }[] = [];
(globalThis as any).__slateQuizLog = quizLog;

/** A fill-in-the-blank made directly from the reading: blank out the concept's key word in its source sentence. */
export function blankFromSource(item: PlanItem, avoid: string[] = [], context = ''): Question | null {
  const esc = (p: string) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The concept's sentence first, then the sentences around it; the concept's name first, then other key words.
  const cands = [item.concept.source, ...sentences(context).filter((x) => x !== item.concept.source)];
  const terms = [item.concept.name, ...words(item.concept.name).sort((a, b) => b.length - a.length)];
  let src = '';
  let answer = '';
  for (const sentence of cands) {
    const pool = [...terms, ...words(sentence).filter((w) => w.length > 6).sort((a, b) => b.length - a.length)];
    for (const p of pool) {
      if (p.length <= 3) continue;
      const m = sentence.match(new RegExp(`\\b${esc(p)}\\b`, 'i'));
      if (!m) continue;
      const prompt = sentence.replace(m[0], '_____');
      if (avoid.some((x) => similar(x, prompt) || x === prompt)) continue;
      src = sentence;
      answer = m[0];
      break;
    }
    if (src) break;
  }
  if (!src) return null;
  const re = new RegExp(`\\b${esc(answer)}\\b`, 'i');
  return {
    item: { ...item, format: 'fill' },
    format: 'fill',
    prompt: src.replace(re, '_____'),
    choices: [],
    correct: [],
    accepted: [answer],
    keyPoints: [],
    explanation: `From the reading: “${src}”`
  };
}

/**
 * Check a finished question by having the AI answer it WITHOUT seeing the key: keep it only if its answer matches.
 * A question with one clear right answer passes; ambiguous options or a wrong key fail. Fill-in and short answer are
 * written from the reading's own sentence and checked by format rules instead.
 */
export async function verifyQuestion(q: Question, context: string, cancelled: () => boolean): Promise<{ ok: boolean; why: string }> {
  if (q.format === 'fill' || q.format === 'short') return { ok: true, why: '' };
  const letters = q.choices.map((_, i) => String.fromCharCode(65 + i));
  const multi = q.format === 'multi';
  const schema = multi
    ? { type: 'object', properties: { trueOptions: { type: 'array', minItems: 1, maxItems: letters.length, items: { enum: letters } } } }
    : q.format === 'tf'
      ? { type: 'object', properties: { answer: { enum: ['True', 'False'] } } }
      : { type: 'object', properties: { answer: { enum: letters }, alsoAcceptable: { type: 'array', maxItems: letters.length, items: { enum: letters } } } };
  const body = q.format === 'tf' ? `Statement: ${q.prompt}\nIs it True or False?` : `${q.prompt}\n${q.choices.map((c, i) => `${letters[i]}. ${c}`).join('\n')}\n${multi ? 'List the letters of ALL the true options.' : 'Which one option is correct? Then list in "alsoAcceptable" any OTHER option that a fair examiner would also have to accept as correct (usually none).'}`;
  const j = await ask(`Answer this exam question using the reading and general knowledge.\n\n${body}\n\nReading:\n"""\n${context}\n"""`, schema, 60, 0, cancelled, 'You are a careful student taking an exam. Reply only with the JSON.');
  let got: number[] = [];
  if (multi) got = (Array.isArray(j.trueOptions) ? j.trueOptions : []).map((l: string) => letters.indexOf(l)).filter((i: number) => i >= 0);
  else if (q.format === 'tf') got = j.answer === 'True' ? [0] : j.answer === 'False' ? [1] : [];
  else got = letters.indexOf(j.answer) >= 0 ? [letters.indexOf(j.answer)] : [];
  const extra = q.format === 'mc' ? (Array.isArray(j.alsoAcceptable) ? j.alsoAcceptable : []).map((l: string) => letters.indexOf(l)).filter((i: number) => i >= 0 && !q.correct.includes(i)) : [];
  const ok = got.length === q.correct.length && got.every((i) => q.correct.includes(i)) && !extra.length;
  return { ok, why: `solved ${got.map((i) => letters[i] || i).join(',')} vs key ${q.correct.map((i) => letters[i]).join(',')}${extra.length ? ` also ${extra.map((i: number) => letters[i]).join(',')}` : ''}` };
}

/** Text that ends mid-sentence (the model ran out of room). */
const cutOff = (t: string) => t.length > 60 && !/[.!?)"'”\]0-9a-z%]$/i.test(t.trim());

/** Wrong options must differ from the right one (ignoring the words every option shares), and the right one mustn't stand out by length. */
function optionsOk(correct: string, wrong: string[]) {
  if ([correct, ...wrong].some(cutOff)) return false;
  const shared = [correct, ...wrong].map((o) => new Set(words(o))).reduce((acc, set) => new Set([...acc].filter((w) => set.has(w))));
  const core = (o: string) => words(o).filter((w) => !shared.has(w)).join(' ');
  if (wrong.some((w) => !core(w) || core(w) === core(correct) || similar(core(w), core(correct)))) return false;
  const avg = wrong.reduce((a, w) => a + w.length, 0) / wrong.length;
  return correct.length <= Math.max(60, avg * 1.8);
}

function similar(a: string, b: string) {
  const x = new Set(words(a));
  const y = new Set(words(b));
  if (!x.size || !y.size) return false;
  let both = 0;
  x.forEach((w) => y.has(w) && both++);
  return both / Math.min(x.size, y.size) >= 0.75;
}

/** Turn the model's JSON into a checked question (or null when it isn't valid). */
export function toQuestion(item: PlanItem, format: QFormat, j: any): Question | null {
  const s = (v: any) => String(v ?? '').trim();
  const stem = s(j.question || j.trueStatement || j.sentence);
  if (stem.length < 20 || norm(stem) === norm(item.concept.name) || stem.split(/\s+/).length < 4) return null;
  const base = { item, format, accepted: [] as string[], keyPoints: [] as string[], explanation: s(j.explanation) };
  if (format === 'mc') {
    const correct = s(j.correct);
    const wrong = (Array.isArray(j.wrong) ? j.wrong : []).map(s).filter((w: string) => w && norm(w) !== norm(correct));
    if (!s(j.question) || !correct || wrong.length < 2 || new Set(wrong.map(norm)).size !== wrong.length) return null;
    if (!optionsOk(correct, wrong)) return null;
    const choices = shuffle([correct, ...wrong.slice(0, 3)]);
    return { ...base, prompt: s(j.question), choices, correct: [choices.indexOf(correct)] };
  }
  if (format === 'multi') {
    const correct = (Array.isArray(j.correct) ? j.correct : []).map(s).filter(Boolean);
    const wrong = (Array.isArray(j.wrong) ? j.wrong : []).map(s).filter((w: string) => w && !correct.some((c: string) => norm(c) === norm(w)));
    if (!s(j.question) || correct.length < 2 || wrong.length < 1) return null;
    const all = [...correct, ...wrong];
    if (all.some((x, i) => all.some((y, k) => k !== i && similar(x, y))) || all.some(cutOff)) return null;
    const choices = shuffle([...correct, ...wrong]);
    return { ...base, prompt: /select all/i.test(j.question) ? s(j.question) : `${s(j.question)} (Select all that apply.)`, choices, correct: correct.map((c: string) => choices.indexOf(c)) };
  }
  if (format === 'tf') {
    const t = s(j.trueStatement);
    const f = s(j.falseStatement);
    // The false version must really differ from the true one (not a copy or a superset).
    if (!t || !f || norm(t) === norm(f) || norm(f).includes(norm(t)) || norm(t).includes(norm(f))) return null;
    const showTrue = Math.random() < 0.5;
    return { ...base, prompt: showTrue ? t : f, choices: ['True', 'False'], correct: [showTrue ? 0 : 1], fix: showTrue ? undefined : t };
  }
  if (format === 'fill') {
    const sentence = s(j.sentence);
    const answer = s(j.answer);
    if (!answer || (sentence.match(/_{2,}/g) || []).length !== 1 || norm(sentence).includes(norm(answer))) return null;
    return { ...base, prompt: sentence.replace(/_{2,}/, '_____'), choices: [], correct: [], accepted: [answer, ...(Array.isArray(j.alternatives) ? j.alternatives.map(s) : [])].filter(Boolean) };
  }
  // short answer
  const kp = (Array.isArray(j.keyPoints) ? j.keyPoints : []).map(s).filter(Boolean);
  if (!s(j.question) || !kp.length) return null;
  return { ...base, prompt: s(j.question), choices: [], correct: [], keyPoints: kp, modelAnswer: s(j.modelAnswer) };
}

/** Surrounding sentences of the concept's source, so the model has context without the whole reading. */
export function contextFor(text: string, c: Concept, partner?: Concept) {
  const sents = sentences(text);
  const around = (src: string) => {
    const i = sents.findIndex((x) => x === src || x.includes(src.slice(0, 50)));
    return i < 0 ? src : sents.slice(Math.max(0, i - 2), i + 3).join(' ');
  };
  return [around(c.source), partner ? around(partner.source) : ''].filter(Boolean).join('\n…\n').slice(0, 2400);
}

// ---------- 4. Grading ----------
function edits(a: string, b: string) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
/** Fill in the blank: exact term, a listed synonym, or a small typo in a longer word. */
export function gradeFill(q: Question, answer: string) {
  const a = norm(answer).replace(/^(the|a|an) /, '');
  return q.accepted.some((x) => {
    const k = norm(x).replace(/^(the|a|an) /, '');
    return a === k || (k.length > 5 && edits(a, k) <= 1) || (k.endsWith('s') && a === k.slice(0, -1)) || a === k + 's';
  });
}

const GRADE_SCHEMA = { type: 'object', properties: { correct: { type: 'boolean' }, feedback: { type: 'string', maxLength: 300 } } };
/** Short answers and true/false corrections: strict but fair, graded by the local AI against the key points. */
export async function gradeWritten(question: string, keyPoints: string[], answer: string, cancelled: () => boolean) {
  if (!answer.trim()) return { correct: false, feedback: '' };
  const j = await ask(
    `Grade this answer strictly but fairly.
Question: ${question}
A full answer must include: ${keyPoints.map((k) => `\n- ${k}`).join('')}
Their answer: "${answer}"
"correct" = true only if the central idea is right, the key points are covered (in any wording), and nothing important is wrong. Don't require exact wording or extra detail.
"feedback" = one or two sentences speaking to them as "you": what you got right, and what was missing or wrong.`,
    GRADE_SCHEMA,
    200,
    0,
    cancelled,
    'You are a fair, strict examiner. Reply only with the JSON.'
  );
  return { correct: !!j.correct, feedback: String(j.feedback || '') };
}

/** Record one result on the concept (confidence moves 25% toward +1 or −1; a miss stays "missed" until a later correct answer). */
export function recordResult(rec: StudyRecord, item: PlanItem, ok: boolean, prompt?: string) {
  const s = rec.state[item.concept.id] || { missed: false, confidence: 0, attempts: 0 };
  s.confidence = Math.max(-1, Math.min(1, 0.75 * s.confidence + 0.25 * (ok ? 1 : -1)));
  s.attempts++;
  s.last = ok;
  s.lastFormat = item.format;
  s.lastAt = new Date().toISOString();
  if (prompt) s.lastQ = prompt.slice(0, 300);
  // The quick retest a few questions later doesn't clear a miss; getting it right in a later quiz does.
  if (!ok) s.missed = true;
  else if (!item.retest) s.missed = false;
  rec.state[item.concept.id] = s;
}
