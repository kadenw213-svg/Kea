// Teach: after a practice question is answered, Claude (on the student's own Claude plan, through Claude Code) teaches
// the concept behind it, step by step, written for that question and the student's answer: math one operation at a
// time, a structure as the whole and then each part, a process in order. Then two new check questions on the same idea.
// The student can ask follow-ups in the same conversation. Lessons are saved per question (study.cjs teach.json), so
// they open again at no cost and reach the phone, which asks the PC to write one (devices.cjs, task 'teach').
//
// Lean on purpose: no tools, no MCP, no project settings, a short system prompt, and only the one question's words.
// The check questions are practice inside the lesson: their answers are never saved, so they don't count as learned.
//
// Without a Claude of its own (Claude Code not on this PC), Kea asks Kea's shared Claude instead (the Kea owner's
// plan, through the Kea account: hub.cjs requestTeach), when the account server offers it (features: sharedTeach).
// Settings → Teach → Where lessons are written (study.teach.via): auto (own Claude first), own, or shared. Through
// the shared Claude a lesson always runs on Sonnet with effort medium and no tools, within the account's daily limits;
// a follow-up sends the lesson it follows (there's no conversation to continue on someone else's PC).
// On the Kea owner's PC, writeShared() is the other end: it writes those lessons for others (hub.cjs teachLoop), on the
// backend the account server sent (backend.cjs): the owner's API credits (turnApi: one streamed Messages API call with
// the owner's key, the same system prompt and lesson format, no tools) or the owner's plan (turn: Claude Code).
const { spawn } = require('child_process');
const settings = require('../settings.cjs');
const plan = require('../assistantPlan.cjs');
const study = require('./study.cjs');
const { usageOf, checkJob, lockedFor } = require('./usage.cjs');
const { fallbackOn, fallbackReason, noteFor } = require('./claudeRoute.cjs');
const B = require('./backend.cjs');

const SYSTEM = `You are Kea's tutor. A college student has just answered one practice question and wants to understand the concept behind it. Teach it so they could answer any question on it, not only this one.

Write Markdown for a narrow side pane:
- Start with "## " and the concept's name, then one or two sentences: the big idea in plain words.
- If their answer was wrong (or they didn't know), add "### Where it went wrong": name the exact misunderstanding behind their answer, kindly, in two or three sentences.
- Teach it step by step, each step under "### Step N: " and a short heading. Calculations: one operation per step, the equation written out at each step, and why that step is next. Structures and systems: the whole first, then each part and sub-part, what it does and how it connects to the others. Processes: the stages in order with what goes in and comes out of each. Definitions and ideas: what it means, how it works, a concrete example, and the usual confusion.
- End the lesson with "### Remember" and one or two sentences.
- Math in LaTeX: $...$ inline, $$...$$ on its own line. Short paragraphs, lists where they help, **bold** for key terms. No emoji, no tables, no headings other than these.
- About 250 to 600 words: complete, without padding.

Be accurate at college level and use the course's terms. If the question's stored answer looks wrong, say so plainly and explain the right one.

After the lesson, write exactly one fenced code block with the language "check" holding a JSON array of CHECKS new multiple-choice questions on the same concept from a different angle (not the original question, and not answerable by matching words from the lesson): [{"q":"...","choices":["...","...","...","..."],"answer":0,"why":"one sentence"}]. Wrong choices are the real mistakes students make.

For a follow-up from the student, answer it in the same style, shorter, with no "## " title; add a check block only when they ask for practice.`;

const running = new Map(); // request id -> child process

const letter = (i) => String.fromCharCode(65 + i);
/** What the student answered, in words. */
function given(q, a) {
  if (a == null || a === '') return '';
  if (q.type === 'mc' && typeof a === 'number') return q.choices[a] != null ? `${letter(a)}. ${q.choices[a]}` : '';
  if (q.type === 'multi' && Array.isArray(a)) return a.map((i) => `${letter(i)}. ${q.choices[i]}`).join('; ');
  if (q.type === 'tf') return a ? 'True' : 'False';
  if (q.type === 'match' && Array.isArray(a)) return a.map((r, i) => (q.pairs[i] && q.pairs[r] ? `${q.pairs[i][0]} → ${q.pairs[r][1]}` : '')).filter(Boolean).join('; ');
  return String(a).slice(0, 500);
}
/** The right answer, in words. */
function correct(q) {
  if (q.type === 'mc') return `${letter(q.answer)}. ${q.choices[q.answer]}`;
  if (q.type === 'multi') return q.answer.map((i) => `${letter(i)}. ${q.choices[i]}`).join('; ');
  if (q.type === 'tf') return q.answer ? 'True' : 'False';
  if (q.type === 'num') return `${q.answer}${q.unit ? ` ${q.unit}` : ''}`;
  if (q.type === 'match') return q.pairs.map(([l, r]) => `${l} → ${r}`).join('; ');
  return String(q.answer ?? '');
}

/** The one message for a new lesson: the class, the question, both answers, its explanation, and what to focus on. */
function lessonPrompt(w, req) {
  const q = w.item;
  const lines = [`Course: ${w.courseCode || 'unknown'}${w.chapter ? ` · ${w.chapter}` : ''}${q.section ? ` · ${q.section}` : ''}${q.topic ? ` · topic: ${q.topic}` : ''}`, '', `Question: ${q.q}`];
  if (Array.isArray(q.choices)) lines.push(...q.choices.map((c, i) => `${letter(i)}. ${c}`));
  if (q.type === 'match') lines.push('Match:', ...q.pairs.map(([l]) => `- ${l}`));
  lines.push('', `Correct answer: ${correct(q)}`);
  const mine = req.dunno ? '(they chose "I don\'t know")' : given(q, req.answer);
  lines.push(`Student's answer: ${mine || '(none)'}${req.dunno ? '' : req.right === true ? ' (right)' : req.right === false ? ' (wrong)' : ''}`);
  if (q.explain) lines.push('', `The explanation they were shown: ${String(q.explain).slice(0, 1500)}`);
  if (req.focus) lines.push('', `They highlighted this and want it taught: "${String(req.focus).slice(0, 300)}". Teach that, in the context of this question.`);
  if (req.again) lines.push('', 'They already had a lesson on this and asked for it a different way: use another angle, other examples, and simpler steps.');
  return lines.join('\n');
}

/** The system prompt for a lesson with `checks` check questions (0: none). */
const systemFor = (checks) => SYSTEM.replace('CHECKS', String(checks || 2)) + (checks ? '' : '\nWrite no check block.');

/**
 * Run one turn: streams the text as it comes (onText), resolves { text, session, usage } or { error }. `lock` (a lesson
 * for someone else through the shared Claude) fixes the model, effort and check count instead of this Kea's settings.
 */
async function turn(id, message, session, onText, lock = null) {
  const claude = lock?.claude || (await plan.findClaude());
  if (!claude) return { error: 'Teach uses Claude Code on this PC, which isn’t installed. Sign in to Claude in Settings → Claude Assistant.' };
  const model = lock ? lock.model : settings.get('study.teach.model', 'claude-sonnet-5-5');
  const effort = lock ? lock.effort : settings.get('study.teach.effort', 'medium');
  const checks = Math.max(0, Math.min(5, Number(lock ? lock.checks : settings.get('study.teach.checks', 2)) || 0));
  const system = systemFor(checks);
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--strict-mcp-config', '--tools', '', '--permission-mode', 'dontAsk', '--setting-sources', 'project', '--system-prompt', system, '--model', model, '--effort', effort];
  if (session) args.push('--resume', session);
  return new Promise((resolve) => {
    let child;
    try {
      // (claude may be [program, ...its own arguments]: a stand-in under test.)
      const [cmd, ...pre] = Array.isArray(claude) ? claude : [claude];
      child = spawn(cmd, [...pre, ...args], { cwd: lock?.cwd || plan.workDir(), windowsHide: true, env: lock?.env || plan.planEnv() });
    } catch (err) {
      return resolve({ error: `Claude Code couldn’t start: ${err.message}` });
    }
    running.set(id, child);
    child.stdin.on('error', () => {});
    let buf = '';
    let errText = '';
    let text = '';
    let result = null;
    let sess = session || null;
    let streamed = false;
    const line = (l) => {
      let ev;
      try {
        ev = JSON.parse(l);
      } catch {
        return;
      }
      if (ev.session_id) sess = ev.session_id;
      if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta' && ev.event.delta?.type === 'text_delta') {
        streamed = true;
        text += ev.event.delta.text;
        onText(ev.event.delta.text);
      } else if (ev.type === 'assistant' && !streamed) {
        // (An older Claude Code that doesn't stream: the finished text at once.)
        const t = (ev.message?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
        if (t) (text += t), onText(t);
      } else if (ev.type === 'result') result = ev;
    };
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        line(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr.on('data', (d) => (errText += d));
    child.on('error', (err) => (errText += err.message));
    child.on('close', (code) => {
      if (buf.trim()) line(buf);
      running.delete(id);
      const usage = usageOf(result, model);
      if (child.killedByUser) return resolve({ text, session: sess, stopped: true, usage });
      // (raw: Claude Code's own words, to tell a usage limit or a signed-out Claude from other failures.)
      if (result?.is_error) return resolve({ error: plan.explain(result.result || errText), raw: `${result.result || ''}\n${errText}`, session: sess, usage });
      if (!text && code !== 0) return resolve({ error: plan.explain(errText || `Claude Code exited (${code}).`), raw: errText, session: sess, usage });
      resolve({ text, session: sess, usage });
    });
    child.stdin.end(`${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: message }] } })}\n`);
  });
}

/**
 * One lesson for someone else on the owner's API credits: a streamed Messages API call with the owner's key (`apiKey`),
 * on the locked model and effort, with the same system prompt and lesson format as turn(), no tools and nothing else.
 * Resolves { text, usage } or { error, ownerNote, billing?, usage } or { text, stopped }. `fetch`: a stand-in for tests.
 * The key goes only to the Anthropic API; errors are described without it.
 */
async function turnApi(id, message, onText, lock, { apiKey, fetch: fetchImpl = null } = {}) {
  const Anthropic = require('@anthropic-ai/sdk');
  const checks = Math.max(0, Math.min(5, Number(lock.checks) || 0));
  const client = new Anthropic({ apiKey, maxRetries: 2, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  const params = {
    model: lock.model,
    max_tokens: 64000,
    system: systemFor(checks),
    messages: [{ role: 'user', content: message }],
    ...(lock.effort ? { output_config: { effort: lock.effort } } : {}),
    // A refusal is re-run on another model inside the same request (the API's own routing), instead of no lesson.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
  };
  let text = '';
  let stream = null;
  const handle = { killedByUser: false, kill: () => stream?.abort() };
  running.set(id, handle);
  try {
    stream = client.beta.messages.stream(params);
    if (handle.killedByUser) stream.abort();
    for await (const ev of stream) {
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        text += ev.delta.text;
        onText(ev.delta.text);
      }
    }
    const msg = await stream.finalMessage();
    const usage = B.usageOfMessage(msg, lock.model);
    if (msg.stop_reason === 'refusal') return { error: 'Claude declined to write this lesson.', ownerNote: `The API declined the lesson (refusal${msg.stop_details?.category ? `: ${msg.stop_details.category}` : ''}).`, usage };
    return { text, usage };
  } catch (err) {
    if (handle.killedByUser || err instanceof Anthropic.APIUserAbortError) return { text, stopped: true, usage: null };
    if (B.isBillingError(err)) return { error: B.BILLING_REASON, ownerNote: B.BILLING_REASON, billing: true, usage: null };
    const what = err instanceof Anthropic.APIError ? `The Claude API answered ${err.status ?? 'with an error'}${err.type ? ` (${err.type})` : ''}: ${String(err.message || '').slice(0, 300)}` : `Couldn’t reach the Claude API: ${String(err?.message || err).slice(0, 300)}`;
    return { error: 'Kea’s shared Claude couldn’t write this lesson. Ask again.', ownerNote: B.redact(what, apiKey), usage: null };
  } finally {
    running.delete(id);
  }
}

/** The lesson's check block, as questions (bad ones dropped). */
function checksOf(text) {
  const m = String(text).match(/```check\s*([\s\S]*?)```/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[1]);
    return (Array.isArray(arr) ? arr : [])
      .filter((c) => c && typeof c.q === 'string' && Array.isArray(c.choices) && c.choices.length >= 2 && Number.isInteger(c.answer) && c.answer >= 0 && c.answer < c.choices.length)
      .slice(0, 5)
      .map((c) => ({ q: c.q, choices: c.choices.map(String), answer: c.answer, why: String(c.why || '') }));
  } catch {
    return [];
  }
}
const bodyOf = (text) => String(text).replace(/```check[\s\S]*?(```|$)/, '').trim();

/**
 * A new lesson ({ k, focus?, answer?, right?, dunno?, question? }) or a follow-up ({ k, lessonId, ask }). `question` is
 * the question itself, used when it isn't in a saved set. Resolves { lesson } or { error }.
 */
async function teach(id, req, onText = () => {}) {
  const k = String(req?.k || '');
  if (!k) return { error: 'Kea doesn’t know which question this is.' };
  const way = await route();
  if (way.via === 'shared') return teachShared(id, k, req, onText);
  if (way.via === 'none' && way.error) return { error: way.error };
  // Their own Claude couldn't (signed out, or at its plan's limit): Kea's shared Claude instead, with a note saying so.
  // Never after an ordinary failure or a lesson they stopped.
  const fallback = async (r) => {
    const why = r.error ? fallbackReason(r.raw || r.error, { stopped: r.stopped }) : null;
    if (!why || !way.sharedOk || !(await sharedAvailable())) return r;
    const s = await teachShared(id, k, req, onText);
    return s.error ? { error: `${r.error} ${s.error}` } : { ...s, note: noteFor(why) };
  };
  if (req.lessonId) {
    const lesson = study.lessons(k).find((l) => l.id === req.lessonId);
    if (!lesson) return { error: 'That lesson isn’t saved any more. Ask for a new one.' };
    const ask = String(req.ask || '').trim().slice(0, 2000);
    if (!ask) return { error: 'Type a question first.' };
    const r = await turn(id, ask, lesson.session, onText);
    if (r.error || r.stopped) return fallback(r);
    const next = { ...lesson, session: r.session || lesson.session, followups: [...(lesson.followups || []), { ask, text: bodyOf(r.text), checks: checksOf(r.text), at: new Date().toISOString() }] };
    study.saveLesson(k, next);
    return { lesson: next };
  }
  const w = study.questionOf(k) || (req.question ? { item: req.question, courseCode: req.courseCode || '', chapter: req.question.chapter || null } : null);
  if (!w) return { error: 'Kea couldn’t find this question.' };
  const r = await turn(id, lessonPrompt(w, req), null, onText);
  if (r.error || r.stopped) return fallback(r);
  const lesson = { id: `t${Date.now().toString(36)}`, focus: req.focus ? String(req.focus).slice(0, 300) : '', model: settings.get('study.teach.model', 'claude-sonnet-5-5'), at: new Date().toISOString(), session: r.session, text: bodyOf(r.text), checks: checksOf(r.text), followups: [] };
  study.saveLesson(k, lesson);
  return { lesson };
}

function stop(id) {
  const c = running.get(id);
  if (c) (c.killedByUser = true), c.kill();
  else stopped.add(id); // (a lesson being written through the shared Claude: its request loop sees this)
  return true;
}

// ---------- Through Kea's shared Claude ----------
const stopped = new Set(); // request ids stopped while a shared lesson was being written
const hub = () => require('../hub.cjs');
/**
 * Where a lesson is written now: { via: 'own' | 'shared' | 'none', model, error? }. auto (the default) is this PC's
 * Claude Code when it's here, else Kea's shared Claude when the Kea account is online and its server offers it.
 */
async function route() {
  // (auto: Kea's shared Claude only as the fallback; own: never; shared: always. "Use my own Claude" makes it own.)
  const want = fallbackOn() ? String(settings.get('study.teach.via', 'auto')) : 'own';
  const sharedOk = want === 'shared' || want === 'auto';
  const own = want !== 'shared' && !!(await plan.findClaude().catch(() => null));
  if (own) return { via: 'own', model: settings.get('study.teach.model', 'claude-sonnet-5-5'), sharedOk };
  const shared = sharedOk && (await sharedAvailable());
  if (shared) return { via: 'shared', model: lockedFor('explain').model };
  if (want === 'own') return { via: 'none', error: 'Teach uses Claude Code on this PC, which isn’t installed. Sign in to Claude in Settings → Claude Assistant.' };
  if (want === 'shared') return { via: 'none', error: hub().signedIn() ? 'Kea’s shared Claude doesn’t write lessons through your Kea account server. Use your own Claude: Settings → Claude Assistant.' : 'Sign in to your Kea account to use Kea’s shared Claude, or use your own Claude: Settings → Claude Assistant.' };
  // (auto with neither: the usual message about installing Claude Code.)
  return { via: 'none', error: null };
}

/** Whether Kea's shared Claude can write lessons now: signed in online, and the account server offers it. */
async function sharedAvailable() {
  try {
    return hub().signedIn() && (await require('../hubOrg.cjs').accountFeatures()).includes('sharedTeach');
  } catch {
    return false;
  }
}

/** What the shared Claude needs for this lesson: the question, the answers, and for a follow-up the lesson it follows. */
function sharedRequest(k, req) {
  const w = study.questionOf(k) || (req.question ? { item: req.question, courseCode: req.courseCode || '', chapter: req.question.chapter || null } : null);
  if (!w) return { error: 'Kea couldn’t find this question.' };
  const base = { question: w.item, courseCode: w.courseCode || '', chapter: w.chapter || null, answer: req.answer ?? null, right: typeof req.right === 'boolean' ? req.right : null, dunno: !!req.dunno };
  if (!req.lessonId) return { body: { ...base, focus: req.focus ? String(req.focus).slice(0, 300) : '', again: !!req.again } };
  const lesson = study.lessons(k).find((l) => l.id === req.lessonId);
  if (!lesson) return { error: 'That lesson isn’t saved any more. Ask for a new one.' };
  const ask = String(req.ask || '').trim().slice(0, 2000);
  if (!ask) return { error: 'Type a question first.' };
  return { lesson, ask, body: { ...base, followup: { ask, lesson: String(lesson.text || '').slice(0, 8000), earlier: (lesson.followups || []).slice(-4).map((f) => ({ ask: f.ask, text: String(f.text || '').slice(0, 3000) })) } } };
}

async function teachShared(id, k, req, onText) {
  const r = sharedRequest(k, req);
  if (r.error) return { error: r.error };
  stopped.delete(id);
  let out;
  try {
    out = await hub().requestTeach(r.body, onText, { stopped: () => stopped.has(id) });
  } catch (e) {
    return { error: hub().sharedClaudeMessage(e), limit: e.data?.limit || null };
  } finally {
    stopped.delete(id);
  }
  if (out.stopped) return { text: out.text, stopped: true };
  const model = out.model || lockedFor('explain').model;
  if (r.lesson) {
    const next = { ...r.lesson, followups: [...(r.lesson.followups || []), { ask: r.ask, text: bodyOf(out.text), checks: checksOf(out.text), at: new Date().toISOString(), via: 'shared' }] };
    study.saveLesson(k, next);
    return { lesson: next };
  }
  const lesson = { id: `t${Date.now().toString(36)}`, focus: req.focus ? String(req.focus).slice(0, 300) : '', model, via: 'shared', at: new Date().toISOString(), session: null, text: bodyOf(out.text), checks: checksOf(out.text), followups: [] };
  study.saveLesson(k, lesson);
  return { lesson };
}

/** The message for a follow-up written for someone else: the lesson and earlier follow-ups, then the new question. */
function followupPrompt(f) {
  const lines = ['Here is the lesson you wrote for this student earlier:', '', String(f.lesson || '').slice(0, 8000)];
  for (const e of f.earlier || []) lines.push('', `The student asked: ${e.ask}`, '', `You answered: ${e.text}`);
  lines.push('', `The student's follow-up: ${f.ask}`);
  return lines.join('\n');
}

/**
 * On the Kea owner's PC: write one lesson for someone else (a job from /owner/teach/next). Locked to Sonnet, effort
 * medium, no tools (usage.cjs); a job naming another model is refused. progress(piece) posts text as it comes (a few
 * times a second at most) and answers { cancelled } when the person stopped it. Resolves { ok, text, error, usage } and
 * where it ran (`run`: { backend, fallback, refused, ownerNote, usageByBackend }, only when the job came with a backend).
 * apiKey(): the owner's key for this job (asked for only when the job may use it). fetch: a stand-in for tests.
 */
async function writeShared(job, opts = {}) {
  const told = job?.backend != null;
  let key = null;
  if (B.wantsKey(job) && opts.apiKey) key = await Promise.resolve(opts.apiKey()).catch(() => null);
  const choice = B.choose(job, { hasKey: !!key });
  if (choice.refuse) return { ok: false, error: choice.refuse, usage: null, run: { refused: 'backend' } };
  if (choice.run === 'plan') {
    const r = await writeWith(job, opts, null);
    return told ? { ...r, run: { backend: 'plan' } } : r;
  }
  const a = await writeWith(job, opts, { apiKey: key, fetch: opts.fetch || null });
  // The API said the credit balance is too low: an auto lesson is written on the owner's plan instead (and the account
  // server hears it, for the rest of the billing cycle). Never for any other error.
  if (a.billing && choice.auto) {
    const p = await writeWith(job, opts, null);
    return { ...p, run: { backend: 'plan', fallback: { reason: B.BILLING_REASON }, usageByBackend: { ...(p.usage ? { plan: p.usage } : {}) } } };
  }
  const { billing, ownerNote, ...rest } = a;
  return { ...rest, run: { backend: 'api', ...(ownerNote ? { ownerNote } : {}) } };
}
async function writeWith(job, { progress = async () => ({}), claude = null, cwd = null, env = null, flushMs = 400 } = {}, api = null) {
  let lock;
  try {
    if (job?.kind !== 'explain') throw new Error(`Not a lesson: ${job?.kind}`);
    lock = checkJob(job);
  } catch (e) {
    return { ok: false, error: e.message, usage: null };
  }
  const rq = job.request || {};
  const q = rq.question;
  if (!q || typeof q.q !== 'string') return { ok: false, error: 'The lesson request had no question.', usage: null };
  const message = rq.followup ? followupPrompt(rq.followup) : lessonPrompt({ item: q, courseCode: rq.courseCode || '', chapter: rq.chapter || null }, rq);
  const id = `shared-${job.id}`;
  let buf = '';
  let timer = null;
  let cancelled = false;
  let posting = Promise.resolve();
  const flush = () => {
    timer = null;
    if (!buf) return posting;
    const piece = buf;
    buf = '';
    posting = posting.then(() => progress(piece)).then((a) => {
      if (a?.cancelled && !cancelled) (cancelled = true), stop(id);
    }, () => {});
    return posting;
  };
  const onText = (t) => {
    buf += t;
    if (!timer) timer = setTimeout(flush, flushMs);
  };
  const turnLock = { model: lock.model, effort: lock.effort, checks: Math.max(0, Math.min(5, Number(job.checks ?? 2))), claude, cwd, env };
  const r = api ? await turnApi(id, message, onText, turnLock, api) : await turn(id, message, null, onText, turnLock);
  clearTimeout(timer);
  await flush();
  stopped.delete(id);
  if (cancelled || r.stopped) return { ok: false, error: 'Stopped.', text: r.text || '', usage: r.usage || null, cancelled: true };
  if (r.error) return { ok: false, error: r.error, usage: r.usage || null, ...(r.billing ? { billing: true } : {}), ...(r.ownerNote ? { ownerNote: r.ownerNote } : {}) };
  return { ok: true, text: r.text, usage: r.usage || null };
}

module.exports = { teach, stop, route, writeShared, _test: { SYSTEM, systemFor, checksOf, bodyOf, lessonPrompt, given, correct, sharedRequest, followupPrompt, turnApi } };
