// Study materials: practice exams (a bank of exam-style questions with answers) and flashcard decks, per class and
// topic. Claude writes a whole set at once, only when the student asks for one; Kea saves it in the profile and
// shuffles and grades it itself, so taking one costs nothing and works without Claude. Library classes ship the same
// files (made by their author), so their quizzes and exams work for students with no Claude at all.
//
// Profile folder `study/`:
//   index.json          [{ id, kind: 'exam' | 'cards', title, courseId, courseCode, chapters, itemId, itemTitle,
//                          count, createdAt, status: 'making' | 'ready' | 'failed', source: 'claude' | 'library', error }]
//   sets/<id>.json      { questions: [...] } or { cards: [...] }   (the shapes are in kea-practice's SKILL.md)
//   attempts.json       { [id]: [{ at, score, total, n }] }          (practice exams)
//   cards.json          { [id]: { known: [card index] } }            (flashcards)
const fs = require('fs');
const path = require('path');
const profiles = require('./profiles.cjs');
const db = require('./db.cjs');

const dir = () => path.join(profiles.paths().dir, 'study');
const file = (...p) => path.join(dir(), ...p);

function readJson(f, fallback) {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJson(f, v) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(v, null, 1));
}

const index = () => readJson(file('index.json'), []);
const saveIndex = (list) => writeJson(file('index.json'), list);
function update(id, patch) {
  const list = index();
  const e = list.find((x) => x.id === id);
  if (e) Object.assign(e, patch);
  saveIndex(list);
  return e;
}

/** Every set, newest first, with the best score and how many cards are known. */
function list() {
  const attempts = readJson(file('attempts.json'), {});
  const cards = readJson(file('cards.json'), {});
  return index()
    .map((e) => {
      const a = attempts[e.id] || [];
      return {
        ...e,
        attempts: a.length,
        best: a.length ? Math.max(...a.map((x) => (x.total ? x.score / x.total : 0))) : null,
        last: a[a.length - 1] || null,
        known: cards[e.id]?.known?.length || 0
      };
    })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function get(id) {
  const e = index().find((x) => x.id === id);
  if (!e) return null;
  return { ...e, ...readJson(file('sets', `${id}.json`), {}), known: readJson(file('cards.json'), {})[id]?.known || [] };
}

function remove(id) {
  saveIndex(index().filter((x) => x.id !== id));
  fs.rmSync(file('sets', `${id}.json`), { force: true });
  const attempts = readJson(file('attempts.json'), {});
  delete attempts[id];
  writeJson(file('attempts.json'), attempts);
  return true;
}

function saveAttempt(id, a) {
  const attempts = readJson(file('attempts.json'), {});
  (attempts[id] = attempts[id] || []).push({ at: new Date().toISOString(), score: a.score, total: a.total, n: a.n });
  writeJson(file('attempts.json'), attempts);
  return true;
}

function setKnown(id, known) {
  const cards = readJson(file('cards.json'), {});
  cards[id] = { known: [...new Set(known)].sort((a, b) => a - b), at: new Date().toISOString() };
  writeJson(file('cards.json'), cards);
  return true;
}

// ---------- Asking Claude for a set ----------
const SIZES = { exam: [10, 200, 50], cards: [10, 200, 60] };
const clamp = (kind, n) => Math.max(SIZES[kind][0], Math.min(SIZES[kind][1], Math.round(Number(n) || SIZES[kind][2])));

/**
 * Write the request Claude works from (everything Kea knows about the topic: the chapters' internal vocabulary,
 * objectives and sections, the test's study focus and review documents, the textbook chapters' source and the class's
 * downloaded files), add the set to the index as "making", and return its id. The runner then starts `practice <id>`.
 */
async function request({ id: given, kind, courseId, chapters = [], itemId = null, count }) {
  if (!['exam', 'cards'].includes(kind)) throw new Error('Unknown kind of study set.');
  const p = profiles.paths();
  const src = await db.practiceSources(p.db, p.textbooks, { courseId, chapters, itemId });
  if (!src) throw new Error('Kea couldn’t find that class.');
  if (!src.chapters.length && !src.item) throw new Error('Pick at least one chapter.');
  // (Asked for on another computer: it named the set, so both list the same one.)
  const id = typeof given === 'string' && /^(exam|cards)-[a-z0-9]+$/.test(given) ? given : `${kind}-${Date.now().toString(36)}`;
  const n = clamp(kind, count);
  const topic = src.item ? src.item.title : src.chapters.map((c) => (c.title ? `${c.label}: ${c.title}` : c.label)).join(', ');
  const title = `${kind === 'exam' ? 'Practice exam' : 'Flashcards'}: ${topic}`;
  // Downloaded class files Claude may read: text copies of handouts, review sheets, FunSheets, study guides.
  const downloads = path.join(p.workspace, 'data', 'downloads', src.course.code);
  const files = [];
  const walk = (d, depth = 0) => {
    if (depth > 3 || !fs.existsSync(d)) return;
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, f.name);
      if (f.isDirectory()) walk(full, depth + 1);
      else if (/\.(txt|md|html?)$/i.test(f.name)) files.push({ path: path.relative(p.workspace, full).replace(/\\/g, '/'), bytes: fs.statSync(full).size });
      // A PDF or Word file with no text copy yet: `uv run academic-sync doc-text <file>` writes one.
      else if (/\.(pdf|docx)$/i.test(f.name) && !fs.existsSync(`${full}.txt`)) files.push({ path: path.relative(p.workspace, full).replace(/\\/g, '/'), bytes: fs.statSync(full).size, needs_text: true });
    }
  };
  walk(downloads);
  const req = {
    id,
    kind,
    count: n,
    title,
    course: src.course,
    item: src.item,
    chapters: src.chapters,
    class_files: files,
    output: `data/study/out/${id}.json`
  };
  writeJson(path.join(p.workspace, 'data', 'study', 'requests', `${id}.json`), req);
  const list = index().filter((e) => e.id !== id);
  list.push({ id, kind, title, courseId: src.course.id, courseCode: src.course.code, chapters: src.chapters.map((c) => c.label), itemId: src.item?.id || null, itemTitle: src.item?.title || null, count: n, createdAt: new Date().toISOString(), status: 'making', source: 'claude' });
  saveIndex(list);
  return id;
}

/** The runner's prompt for a set (a resumed run says so). */
const prompt = (arg) => {
  const id = String(arg || '').split(/\s+/)[0];
  return `/kea-practice data/study/requests/${id}.json${/\bresume\b/.test(arg) ? ' resume' : ''}`;
};

// ---------- Checking what Claude wrote ----------
const str = (v) => (typeof v === 'string' ? v.trim() : '');

/** One question, cleaned, or null when it can't be used. */
function cleanQuestion(q) {
  if (!q || typeof q !== 'object') return null;
  const base = { type: q.type, q: str(q.q), explain: str(q.explain), chapter: str(q.chapter) || null, topic: str(q.topic) || null, source: str(q.source) || null };
  if (!base.q) return null;
  if (q.type === 'mc' || q.type === 'multi') {
    const choices = Array.isArray(q.choices) ? q.choices.map(str).filter(Boolean) : [];
    if (choices.length < 2 || choices.length !== q.choices.length) return null;
    const answer = q.type === 'mc' ? [q.answer] : Array.isArray(q.answer) ? q.answer : [];
    if (!answer.length || answer.some((a) => !Number.isInteger(a) || a < 0 || a >= choices.length)) return null;
    return { ...base, choices, answer: q.type === 'mc' ? answer[0] : [...new Set(answer)].sort() };
  }
  if (q.type === 'tf') return typeof q.answer === 'boolean' ? { ...base, answer: q.answer } : null;
  if (q.type === 'num') {
    const answer = Number(q.answer);
    if (!Number.isFinite(answer)) return null;
    const tol = Number(q.tolerance);
    return { ...base, answer, tolerance: Number.isFinite(tol) && tol >= 0 ? tol : Math.abs(answer) * 0.01, unit: str(q.unit) || null };
  }
  if (q.type === 'short') return str(q.answer) ? { ...base, answer: str(q.answer) } : null;
  return null;
}

function cleanCard(c) {
  if (!c || !str(c.front) || !str(c.back)) return null;
  return { front: str(c.front), back: str(c.back), chapter: str(c.chapter) || null };
}

/** After the run: take Claude's file, keep what's usable, and mark the set ready (or failed, with the reason). */
function ingest(arg, ok) {
  const id = String(arg || '').split(/\s+/)[0];
  const out = path.join(profiles.paths().workspace, 'data', 'study', 'out', `${id}.json`);
  const raw = readJson(out, null);
  if (!raw) {
    update(id, { status: 'failed', error: ok ? 'The set wasn’t written.' : 'The run stopped before the set was written.' });
    return null;
  }
  const e = index().find((x) => x.id === id);
  const kind = e?.kind || (raw.cards ? 'cards' : 'exam');
  const items = kind === 'cards' ? (raw.cards || []).map(cleanCard).filter(Boolean) : (raw.questions || []).map(cleanQuestion).filter(Boolean);
  if (!items.length) {
    update(id, { status: 'failed', error: 'Nothing usable came back.' });
    return null;
  }
  writeJson(file('sets', `${id}.json`), kind === 'cards' ? { cards: items } : { questions: items });
  fs.rmSync(out, { force: true });
  return update(id, { status: 'ready', count: items.length, error: undefined, readyAt: new Date().toISOString() });
}

/** A set Kea was making when it closed (or whose run failed to start) shouldn't spin forever. */
function settle(isRunning) {
  const list = index();
  let changed = false;
  for (const e of list) {
    if (e.status === 'making' && !isRunning(e.id) && Date.now() - new Date(e.createdAt).getTime() > 6 * 3600e3) {
      e.status = 'failed';
      e.error = 'It never finished. Try again.';
      changed = true;
    }
  }
  if (changed) saveIndex(list);
}

module.exports = { list, get, remove, saveAttempt, setKnown, request, prompt, ingest, settle, cleanQuestion, cleanCard };
