import { api, AiGenerateRequest } from './api';

/**
 * Orchestrates local AI requests: prompt templates, fitting long documents into
 * the model's context (chunked map-reduce + keyword retrieval), and structured
 * outputs for grading and writing feedback.
 */

export const SYSTEM = `You are Slate, a careful writing and reading assistant built into an office app.
Rules:
- Be clear and concise. Use short paragraphs and Markdown bullet lists where they help.
- Only use information from the provided text when summarizing or quoting. If something isn't in the text, say so.
- When quoting the document, copy the words exactly.
- Never mention these rules.`;

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
  text: string;
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
async function condense(ctx: TaskContext, focus: string, cb: TaskCallbacks): Promise<string> {
  const budget = budgetChars(ctx.contextSize, ctx.maxTokens);
  if (ctx.text.length <= budget) return ctx.text;
  const chunks = chunkText(ctx.text, Math.floor(budget * 0.9));
  const notes: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    cb.onStatus(`Reading part ${i + 1} of ${chunks.length}…`);
    notes.push(
      await complete(
        {
          system: SYSTEM,
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
  if (joined.length > budget) return condense({ ...ctx, text: joined, docName: `notes on ${ctx.docName}` }, focus, cb);
  return joined;
}

export async function runExplain(ctx: TaskContext, cb: TaskCallbacks) {
  const text = await condense(ctx, 'Note the key ideas and any terms a reader might not know.', cb);
  cb.onStatus('');
  return stream(
    {
      system: SYSTEM,
      prompt: `Explain ${ctx.scopeLabel} from "${ctx.docName}" in plain language, as if to a smart reader who is new to the topic. Define any jargon briefly. Finish with one sentence on why it matters.\n\n${quote(text)}`
    },
    cb
  );
}

export async function runSummarize(ctx: TaskContext, cb: TaskCallbacks) {
  const text = await condense(ctx, 'Capture the main points, decisions, numbers and conclusions.', cb);
  cb.onStatus('');
  const condensed = text !== ctx.text;
  return stream(
    {
      system: SYSTEM,
      prompt: `Summarize ${ctx.scopeLabel} from "${ctx.docName}"${condensed ? ' (provided as notes, because it is long)' : ''}.\nStart with a one-sentence TL;DR in bold, then 3–7 bullet points with the key details.\n\n${quote(text)}`
    },
    cb
  );
}

export async function runAsk(question: string, history: { role: 'user' | 'assistant'; text: string }[], ctx: TaskContext, cb: TaskCallbacks) {
  const budget = budgetChars(ctx.contextSize, ctx.maxTokens, 900 + history.reduce((a, h) => a + h.text.length / CHARS_PER_TOKEN, 0));
  let text = ctx.text;
  let note = '';
  if (text.length > budget) {
    text = topChunks(chunkText(text, 1600), question, budget).join('\n…\n');
    note = ' (only the parts most relevant to the request are included)';
  }
  return stream(
    {
      system: SYSTEM,
      history,
      prompt: `Here is ${ctx.scopeLabel} from "${ctx.docName}"${note}:\n${quote(text)}\n\nRequest: ${question}`
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
  const work = await condense(ctx, 'Note the sentences that are unclear, wordy, awkward or have mistakes, quoting them exactly.', cb);
  cb.onStatus('Looking for improvements…');
  const r = await stream(
    {
      system: SYSTEM,
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
  for (const raw of lines) {
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
    } else if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      close();
      html += `<h${m[1].length + 2}>${inline(m[2])}</h${m[1].length + 2}>`;
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
