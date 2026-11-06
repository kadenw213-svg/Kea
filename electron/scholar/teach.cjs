// Teach: after a practice question is answered, Claude (on the student's own Claude plan, through Claude Code) teaches
// the concept behind it, step by step, written for that question and the student's answer: math one operation at a
// time, a structure as the whole and then each part, a process in order. Then two new check questions on the same idea.
// The student can ask follow-ups in the same conversation. Lessons are saved per question (study.cjs teach.json), so
// they open again at no cost and reach the phone, which asks the PC to write one (devices.cjs, task 'teach').
//
// Lean on purpose: no tools, no MCP, no project settings, a short system prompt, and only the one question's words.
// The check questions are practice inside the lesson: their answers are never saved, so they don't count as learned.
const { spawn } = require('child_process');
const settings = require('../settings.cjs');
const plan = require('../assistantPlan.cjs');
const study = require('./study.cjs');

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

/** Run one turn: streams the text as it comes (onText), resolves { text, session } or { error }. */
async function turn(id, message, session, onText) {
  const claude = await plan.findClaude();
  if (!claude) return { error: 'Teach uses Claude Code on this PC, which isn’t installed. Sign in to Claude in Settings → Claude Assistant.' };
  const model = settings.get('study.teach.model', 'claude-sonnet-5-5');
  const effort = settings.get('study.teach.effort', 'medium');
  const checks = Math.max(0, Math.min(5, Number(settings.get('study.teach.checks', 2)) || 0));
  const system = SYSTEM.replace('CHECKS', String(checks || 2)) + (checks ? '' : '\nWrite no check block.');
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--strict-mcp-config', '--tools', '', '--permission-mode', 'dontAsk', '--setting-sources', 'project', '--system-prompt', system, '--model', model, '--effort', effort];
  if (session) args.push('--resume', session);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(claude, args, { cwd: plan.workDir(), windowsHide: true, env: plan.planEnv() });
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
      if (child.killedByUser) return resolve({ text, session: sess, stopped: true });
      if (result?.is_error) return resolve({ error: plan.explain(result.result || errText), session: sess });
      if (!text && code !== 0) return resolve({ error: plan.explain(errText || `Claude Code exited (${code}).`), session: sess });
      resolve({ text, session: sess });
    });
    child.stdin.end(`${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: message }] } })}\n`);
  });
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
  if (req.lessonId) {
    const lesson = study.lessons(k).find((l) => l.id === req.lessonId);
    if (!lesson) return { error: 'That lesson isn’t saved any more. Ask for a new one.' };
    const ask = String(req.ask || '').trim().slice(0, 2000);
    if (!ask) return { error: 'Type a question first.' };
    const r = await turn(id, ask, lesson.session, onText);
    if (r.error || r.stopped) return r;
    const next = { ...lesson, session: r.session || lesson.session, followups: [...(lesson.followups || []), { ask, text: bodyOf(r.text), checks: checksOf(r.text), at: new Date().toISOString() }] };
    study.saveLesson(k, next);
    return { lesson: next };
  }
  const w = study.questionOf(k) || (req.question ? { item: req.question, courseCode: req.courseCode || '', chapter: req.question.chapter || null } : null);
  if (!w) return { error: 'Kea couldn’t find this question.' };
  const r = await turn(id, lessonPrompt(w, req), null, onText);
  if (r.error || r.stopped) return r;
  const lesson = { id: `t${Date.now().toString(36)}`, focus: req.focus ? String(req.focus).slice(0, 300) : '', model: settings.get('study.teach.model', 'claude-sonnet-5-5'), at: new Date().toISOString(), session: r.session, text: bodyOf(r.text), checks: checksOf(r.text), followups: [] };
  study.saveLesson(k, lesson);
  return { lesson };
}

function stop(id) {
  const c = running.get(id);
  if (c) (c.killedByUser = true), c.kill();
  return true;
}

module.exports = { teach, stop, _test: { SYSTEM, checksOf, bodyOf, lessonPrompt, given, correct } };
