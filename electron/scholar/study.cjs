// Study materials: practice exams (a bank of exam-style questions with answers) and flashcard decks, per class and
// topic. Claude writes a whole set at once, only when the student asks for one; Kea saves it in the profile and
// shuffles and grades it itself, so taking one costs nothing and works without Claude. Library classes ship the same
// files (made by their author), so their quizzes and exams work for students with no Claude at all.
//
// Every question ever made is kept: together, a class's sets are a growing catalog. A new set (a final review, say)
// reuses saved questions on its chapters, favouring ones the student missed or hasn't seen in a while, and Claude only
// writes what's new; a set from saved questions alone is ready at once with no Claude at all.
//
// Profile folder `study/`:
//   index.json          [{ id, kind: 'exam' | 'cards', title, courseId, courseCode, chapters, itemId, itemTitle,
//                          count, reused, createdAt, status: 'making' | 'ready' | 'failed', source: 'claude' | 'saved' |
//                          'library', error }]
//   sets/<id>.json      { questions: [...] } or { cards: [...] }   (the shapes are in kea-practice's SKILL.md; each
//                        item also has `k`, its key: the same question in two sets has the same key)
//   attempts.json       { [id]: [{ at, score, total, n, items: [[k, right]] }] }   (practice exams; `items` says how
//                        each question went, which is each question's history across every set)
//   cards.json          { [id]: { known: [card index] } }            (flashcards)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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

/** A question's or card's key: its wording, ignoring case, spacing and punctuation. */
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const keyOf = (it) => crypto.createHash('sha1').update(norm(it.q ?? it.front)).digest('hex').slice(0, 12);
const keyed = (items) => (items || []).map((it) => (it.k ? it : { ...it, k: keyOf(it) }));

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

/** How each question has gone, across every set and device: { [k]: { seen, right, last, lastRight } }. */
function history() {
  const out = {};
  for (const list of Object.values(readJson(file('attempts.json'), {})))
    for (const a of list || [])
      for (const [k, ok] of a.items || []) {
        const h = (out[k] = out[k] || { seen: 0, right: 0, last: '', lastRight: null });
        h.seen++;
        if (ok) h.right++;
        if (String(a.at) >= h.last) (h.last = String(a.at)), (h.lastRight = ok == null ? null : !!ok);
      }
  return out;
}

/** A set with its items keyed, and (for exams) each question's history, so the player can favour the ones to practise. */
function get(id) {
  const e = index().find((x) => x.id === id);
  if (!e) return null;
  // (A set made from saved questions on a device that isn't the primary waits in `local/` until the primary's copy comes.)
  const s = readJson(file('sets', `${id}.json`), null) || readJson(file('local', `${id}.json`), {});
  const out = { ...e, known: readJson(file('cards.json'), {})[id]?.known || [] };
  if (s.questions) {
    out.questions = keyed(s.questions);
    const h = history();
    out.history = Object.fromEntries(out.questions.filter((q) => h[q.k]).map((q) => [q.k, h[q.k]]));
  }
  if (s.cards) out.cards = keyed(s.cards);
  return out;
}

function remove(id) {
  saveIndex(index().filter((x) => x.id !== id));
  fs.rmSync(file('sets', `${id}.json`), { force: true });
  fs.rmSync(file('local', `${id}.json`), { force: true });
  const attempts = readJson(file('attempts.json'), {});
  delete attempts[id];
  writeJson(file('attempts.json'), attempts);
  return true;
}

/** An attempt: its score, and how each question went ([key, right], right null for an unmarked written answer). */
function saveAttempt(id, a) {
  const attempts = readJson(file('attempts.json'), {});
  const items = Array.isArray(a.items) ? a.items.filter((x) => Array.isArray(x) && typeof x[0] === 'string').map(([k, ok]) => [k, ok == null ? null : !!ok]) : undefined;
  (attempts[id] = attempts[id] || []).push({ at: new Date().toISOString(), score: a.score, total: a.total, n: a.n, ...(items ? { items } : {}) });
  writeJson(file('attempts.json'), attempts);
  return true;
}

function setKnown(id, known) {
  const cards = readJson(file('cards.json'), {});
  cards[id] = { known: [...new Set(known)].sort((a, b) => a - b), at: new Date().toISOString() };
  writeJson(file('cards.json'), cards);
  return true;
}

// ---------- The catalog: every saved question or card for a class's chapters ----------
/** Saved questions (or cards) for these chapters of a class, one per key, from every finished set. */
function catalog(kind, courseId, chapters) {
  const want = new Set(chapters);
  const seen = new Map();
  for (const e of index()) {
    if (e.kind !== kind || e.courseId !== courseId || e.status !== 'ready') continue;
    const s = readJson(file('sets', `${e.id}.json`), {});
    // An item with no chapter counts when its whole set is on these chapters.
    const setInside = (e.chapters || []).length > 0 && e.chapters.every((c) => want.has(c));
    for (const it of keyed(kind === 'cards' ? s.cards : s.questions))
      if (!seen.has(it.k) && (it.chapter ? want.has(it.chapter) : setInside)) seen.set(it.k, it);
  }
  return [...seen.values()];
}

/**
 * Pick `n` saved items to reuse: missed ones first, then ones never tried, then the longest since last seen; right
 * every time and seen lately last. Spread across the chapters, so a review isn't all one chapter.
 */
function pick(items, n, h = history()) {
  const now = Date.now();
  const score = (it) => {
    const x = h[it.k];
    if (!x) return 3 + Math.random();
    const days = (now - Date.parse(x.last)) / 864e5;
    return (x.lastRight === false ? 4 : 1 - x.right / Math.max(1, x.seen)) + Math.min(2, days / 7) + Math.random() * 0.5;
  };
  const by = new Map();
  for (const it of items.map((it) => ({ it, s: score(it) })).sort((a, b) => b.s - a.s)) {
    const c = it.it.chapter || '';
    if (!by.has(c)) by.set(c, []);
    by.get(c).push(it.it);
  }
  const out = [];
  const lists = [...by.values()];
  while (out.length < n && lists.some((l) => l.length)) for (const l of lists) if (l.length && out.length < n) out.push(l.shift());
  return out;
}

/** How many saved questions (or cards) a new set on these chapters, or for this test, could reuse. */
async function saved({ kind, courseId, chapters = [], itemId = null }) {
  const p = profiles.paths();
  const src = await db.practiceSources(p.db, p.textbooks, { courseId, chapters, itemId });
  if (!src) return { count: 0 };
  return { count: catalog(kind, src.course.id, src.chapters.map((c) => c.label)).length };
}

/** A class's downloaded files: text copies of handouts, review sheets, FunSheets, study guides (workspace-relative). */
function classFiles(code) {
  const ws = profiles.paths().workspace;
  const files = [];
  const walk = (d, depth = 0) => {
    if (depth > 3 || !fs.existsSync(d)) return;
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, f.name);
      if (f.isDirectory()) walk(full, depth + 1);
      else if (/\.(txt|md|html?)$/i.test(f.name)) files.push({ path: path.relative(ws, full).replace(/\\/g, '/'), bytes: fs.statSync(full).size });
      // A PDF or Word file with no text copy yet: Kea converts it before Claude starts.
      else if (/\.(pdf|docx)$/i.test(f.name) && !fs.existsSync(`${full}.txt`)) files.push({ path: path.relative(ws, full).replace(/\\/g, '/'), bytes: fs.statSync(full).size, needs_text: true });
    }
  };
  walk(path.join(ws, 'data', 'downloads', code));
  return files;
}

// ---------- Asking for a set ----------
const SIZES = { exam: [10, 200, 50], cards: [10, 200, 60] };
const clamp = (kind, n) => Math.max(SIZES[kind][0], Math.min(SIZES[kind][1], Math.round(Number(n) || SIZES[kind][2])));
// In a mixed set, at most this share is reused, so every review still brings new questions.
const REUSE = 0.6;

/**
 * Start a set: reuse saved questions on its chapters (mode 'mix', the default: up to 60%; 'saved': only saved ones,
 * ready at once; 'new': none), and for the rest write the request Claude works from (the chapters, the tests, the class
 * files, and the questions that already exist so it writes different ones). Adds the set to the index and returns
 * { id, ready }: ready when no Claude run is needed. `pick` (keys) repeats another device's choice of saved items.
 */
async function request({ id: given, kind, courseId, chapters = [], itemId = null, count, mode = 'mix', pick: picked = null, bank = false }) {
  if (!['exam', 'cards'].includes(kind)) throw new Error('Unknown kind of study set.');
  const p = profiles.paths();
  const src = await db.practiceSources(p.db, p.textbooks, { courseId, chapters, itemId });
  if (!src) throw new Error('Kea couldn’t find that class.');
  if (!src.chapters.length && !src.item) throw new Error('Pick at least one chapter.');
  // (Asked for on another computer: it named the set, so both list the same one.)
  const id = typeof given === 'string' && /^(exam|cards)-[a-z0-9]+$/.test(given) ? given : `${kind}-${Date.now().toString(36)}`;
  const labels = src.chapters.map((c) => c.label);
  const all = catalog(kind, src.course.id, labels);
  const n = mode === 'saved' ? Math.max(1, Math.min(Number(count) || all.length, all.length)) : clamp(kind, count);
  const byKey = new Map(all.map((it) => [it.k, it]));
  const reuse = Array.isArray(picked) && picked.every((k) => byKey.has(k)) ? picked.map((k) => byKey.get(k)) : mode === 'new' ? [] : pick(all, mode === 'saved' ? n : Math.floor(n * REUSE));
  if (mode === 'saved' && !reuse.length) throw new Error('There are no saved questions on these chapters yet.');
  const fresh = mode === 'saved' ? 0 : n - reuse.length;
  const topic = src.item ? src.item.title : src.chapters.map((c) => (c.title ? `${c.label}: ${c.title}` : c.label)).join(', ');
  const title = `${bank ? 'Question bank' : kind === 'exam' ? 'Practice exam' : 'Flashcards'}: ${topic}`;
  const entry = { id, kind, title, ...(bank ? { bank: true } : {}), courseId: src.course.id, courseCode: src.course.code, chapters: labels, itemId: src.item?.id || null, itemTitle: src.item?.title || null, count: reuse.length + fresh, reused: reuse.length, createdAt: new Date().toISOString() };
  const list = index().filter((e) => e.id !== id);
  if (!fresh) {
    writeJson(file('sets', `${id}.json`), kind === 'cards' ? { cards: reuse } : { questions: reuse });
    writeJson(file('local', `${id}.json`), kind === 'cards' ? { cards: reuse } : { questions: reuse });
    list.push({ ...entry, status: 'ready', source: 'saved', readyAt: entry.createdAt });
    saveIndex(list);
    return { id, ready: true, pick: reuse.map((it) => it.k) };
  }
  const files = classFiles(src.course.code);
  const req = {
    id,
    kind,
    count: fresh,
    title,
    course: src.course,
    item: src.item,
    chapters: src.chapters,
    tests: src.tests || [],
    class_files: files,
    // What already exists on these chapters: Claude writes different questions (they're shown in the brief).
    existing: all.map((it) => ({ k: it.k, chapter: it.chapter || null, topic: it.topic || null, text: String(it.q ?? it.front).slice(0, 140) })),
    reuse,
    bank,
    output: `data/study/out/${id}.json`
  };
  writeJson(path.join(p.workspace, 'data', 'study', 'requests', `${id}.json`), req);
  list.push({ ...entry, status: 'making', source: 'claude' });
  saveIndex(list);
  return { id, ready: false, pick: reuse.map((it) => it.k) };
}

// ---------- Question banks: every chapter with a textbook keeps saved questions ready ----------
// Each chapter with a textbook gets a bank of saved questions (50 by default) so practice is ready without asking, and
// when the student is running out (fewer than BANK_LOW they haven't seen or last got wrong), Kea adds BANK_MORE new
// ones. Banks are ordinary sets (bank: true), written one at a time by the primary. Library classes can't make more,
// so their authors ship 100 per chapter instead.
const BANK_LOW = 10;
const BANK_MORE = 25;

/**
 * The next chapter whose bank needs questions, as a request for request(), or null. `size` is the bank's target;
 * `chapters` lists { courseId, label } for every chapter with a textbook. Nothing while a bank is being made.
 */
function bankNeed(chapters, size = 50) {
  const all = index();
  if (all.some((e) => e.bank && e.status === 'making')) return null;
  const h = history();
  for (const { courseId, label } of chapters) {
    const have = catalog('exam', courseId, [label]);
    // (A chapter whose last bank failed waits a day before trying again.)
    const failed = all.find((e) => e.bank && e.courseId === courseId && e.chapters?.[0] === label && e.status === 'failed' && Date.now() - Date.parse(e.createdAt) < 864e5);
    if (failed) continue;
    if (have.length < size) return { kind: 'exam', courseId, chapters: [label], count: Math.max(SIZES.exam[0], size - have.length), mode: 'new', bank: true };
    const left = have.filter((it) => !h[it.k] || h[it.k].lastRight === false).length;
    if (left < BANK_LOW) return { kind: 'exam', courseId, chapters: [label], count: BANK_MORE, mode: 'new', bank: true };
  }
  return null;
}

// ---------- Kea's brief: everything Claude needs, in one short file ----------
// Kea does all the reading in plain code (no Claude usage) and hands Claude one brief, so a set is a single pass:
//   1. What the real tests cover, as scraped from the class site (the instructor's study focus, the format), first.
//   2. The tests' review sheets (FunSheets, study guides, answer keys), downloaded once by Kea and kept as text.
//   3. Per-chapter notes, kept as plain text in `data/study/notes/<CODE>/<Chapter N>.md` and rebuilt only when
//      what they're made from changes: objectives, vocabulary, sections, and that chapter's review material.
const BRIEF_BUDGET = 40000; // characters of review-material text in a brief (about 10k tokens; it stays one Read)
const REVIEWISH = /review|fun ?sheet|guided reading|study guide|practice|objective|worksheet|exam|quiz|key/i;
const SKIP = /syllabus|calendar|schedule|announcement|consolidated_events|content_modules|dropbox|discussion|lab_handout/i;
// Review links worth fetching for a test (not reference sheets like the periodic table, which every exam allows).
const SHEET = /fun ?sheet|study guide|review|practice (exam|test|problems)|answer key|\bkey\b|worksheet/i;
const NOT_SHEET = /periodic table|conversion|formula sheet|quiz(zes)?$|discussion|dropbox|syllabus/i;

/** A text file squeezed for reading: page markers and runs of blank space gone, short broken lines rejoined. */
function squeeze(text) {
  return String(text)
    .replace(/^--- page \d+ ---$/gm, '')
    .replace(/_{3,}/g, '___')
    .replace(/[ \t]+/g, ' ')
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .reduce((out, l) => {
      const last = out[out.length - 1];
      if (last != null && last.length < 60 && !/[.:?!]$/.test(last) && !/^[-•▪*]|^\d+[.)]/.test(l)) out[out.length - 1] = `${last} ${l}`;
      else out.push(l);
      return out;
    }, [])
    .join('\n');
}
const htmlText = (s) => String(s).replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
const chapterNum = (s) => (/(?:ch(?:apter)?\.?\s*)(\d+)/i.exec(s) || [])[1];
const safeName = (s) => s.replace(/[<>:"/\\|?*]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
const mtime = (f) => {
  try {
    return fs.statSync(f).mtimeMs;
  } catch {
    return 0;
  }
};

/** A D2L content link as its file: the viewer page `/viewContent/<topic>/View` → the topic's direct download. */
const directUrl = (url) => url.replace(/\/le\/content\/(\d+)\/viewContent\/(\d+)\/View.*$/, '/le/content/$1/topics/files/download/$2/DirectFileTopicDownload');

/**
 * Download the tests' review sheets and keys that aren't here yet (Kea's own signed-in browser, no Claude), saved as
 * `data/downloads/<CODE>/review/<label>.<pdf|docx|html>` with a text copy. Returns the paths of every sheet's text
 * for these chapters, cached or new.
 */
async function fetchSheets(req, nums, docText, step) {
  const ws = profiles.paths().workspace;
  const dir = path.join(ws, 'data', 'downloads', req.course.code, 'review');
  const seen = new Map();
  for (const t of req.tests || [])
    for (const l of t.review_links || []) {
      if (!SHEET.test(l.label) || NOT_SHEET.test(l.label) || !/^https?:/.test(l.url)) continue;
      const n = chapterNum(l.label);
      if (n && !nums.has(n)) continue;
      seen.set(safeName(l.label), l.url);
    }
  const have = (name) => ['pdf', 'docx', 'html'].map((x) => path.join(dir, `${name}.${x}`)).find((f) => fs.existsSync(f));
  const missing = [...seen].filter(([name]) => !have(name)).slice(0, 16);
  if (missing.length) {
    const browser = require('./browser.cjs');
    const signedIn = await browser
      .status()
      .then((s) => s.signedIn)
      .catch(() => false);
    let i = 0;
    for (const [name, url] of signedIn ? missing : []) {
      step(`Downloading ${name} from your class site (${++i} of ${missing.length})…`, 2 + Math.round((i / missing.length) * 5));
      try {
        const r = await browser.download(directUrl(url), `${req.course.code}/review/${name}.download`);
        const full = path.join(ws, r.saved);
        const head = fs.readFileSync(full).subarray(0, 5).toString('latin1');
        // (An HTML answer is a D2L page topic, unless it's the sign-in page.)
        const page = /html/i.test(r.contentType) && !/type=["']?password|sign in|log in/i.test(fs.readFileSync(full, 'utf8'));
        const ext = head.startsWith('%PDF') ? 'pdf' : head.startsWith('PK') ? 'docx' : page ? 'html' : null;
        if (!ext) {
          fs.rmSync(full, { force: true });
          continue;
        }
        const dest = path.join(dir, `${name}.${ext}`);
        fs.renameSync(full, dest);
        if (ext !== 'html') await docText(dest).catch(() => null);
      } catch {}
    }
  }
  return [...seen.keys()]
    .map(have)
    .filter(Boolean)
    .map((f) => (/\.html$/.test(f) ? f : `${f}.txt`))
    .filter((f) => fs.existsSync(f));
}

/** A text file's readable content (HTML stripped), squeezed. */
const readText = (f) => {
  const body = fs.readFileSync(f, 'utf8');
  return squeeze(/\.html?$/i.test(f) ? htmlText(body) : body);
};

/** Trim each text to a fair share of `budget`: small ones whole, big ones cut to an equal share of what's left. */
function share(texts, budget) {
  let left = budget;
  [...texts]
    .sort((a, b) => a.text.length - b.text.length)
    .forEach((t, k, all) => {
      const cap = Math.floor(left / (all.length - k));
      if (t.text.length > cap) t.text = `${t.text.slice(0, cap)}\n[… trimmed; the full text is in ${t.path}]`;
      left -= t.text.length;
    });
  return texts;
}

/**
 * Each chapter's notes as plain text in `data/study/notes/<CODE>/<Chapter N>.md`, rebuilt only when the database or
 * the chapter's review material is newer: summary, sections, objectives, vocabulary, the review material's text, and
 * what the tests on the chapter cover. Converts and downloads what's missing first. `req` is a set's request (or the
 * same fields: course, chapters, tests, class_files). Returns { notes, general (class-wide files), sources }.
 */
async function chapterNotes(req, docText, step = () => {}) {
  const ws = profiles.paths().workspace;
  const rel = (f) => path.relative(ws, f).replace(/\\/g, '/');
  const nums = new Set(req.chapters.map((c) => chapterNum(c.label)).filter(Boolean));

  // The class's own files for these chapters (or no chapter in particular) that look like review material.
  const wanted = (req.class_files || []).filter((f) => {
    if (SKIP.test(f.path) || !REVIEWISH.test(f.path) || /\/review\//.test(f.path)) return false;
    const n = chapterNum(path.basename(f.path));
    return !n || nums.has(n);
  });
  let i = 0;
  for (const f of wanted) {
    const full = path.join(ws, f.path);
    i++;
    if (/\.(pdf|docx)$/i.test(full) && !fs.existsSync(`${full}.txt`)) {
      step(`Reading ${path.basename(full)} (${i} of ${wanted.length})…`, Math.round((i / wanted.length) * 2));
      await docText(full).catch(() => null);
    }
  }
  const classTexts = wanted.map((f) => path.join(ws, /\.(pdf|docx)$/i.test(f.path) ? `${f.path}.txt` : f.path)).filter((f) => fs.existsSync(f));
  const sheets = await fetchSheets(req, nums, docText, step);
  step('Putting the chapters’ notes together…', 8);

  // Per-chapter notes: one plain text file each, rebuilt when the database or that chapter's material is newer.
  const sources = [...classTexts, ...sheets];
  const general = sources.filter((f) => !chapterNum(path.basename(f)));
  const notesDir = path.join(ws, 'data', 'study', 'notes', req.course.code);
  fs.mkdirSync(notesDir, { recursive: true });
  const dbTime = mtime(profiles.paths().db);
  const notes = req.chapters.map((c) => {
    const file = path.join(notesDir, `${safeName(c.label)}.md`);
    const mine = sources.filter((f) => chapterNum(path.basename(f)) === chapterNum(c.label));
    if (mtime(file) < Math.max(dbTime, ...mine.map(mtime))) {
      const lines = [`# ${c.label}${c.title ? `: ${c.title}` : ''}`, ''];
      if (c.summary) lines.push(c.summary, '');
      if (c.sections?.length) lines.push(`Sections: ${c.sections.map((s) => (typeof s === 'string' ? s : s.title || s.label || JSON.stringify(s))).join('; ')}`, '');
      if (c.objectives?.length) lines.push('## Objectives', ...c.objectives.map((o) => `- ${typeof o === 'string' ? o : o.text || JSON.stringify(o)}`), '');
      if (c.vocabulary) lines.push('## Vocabulary', c.vocabulary, '');
      for (const f of mine) lines.push(`## Review material: ${path.basename(f).replace(/\.txt$/, '')}`, readText(f), '');
      const tests = (req.tests || []).filter((t) => (t.chapters || []).includes(c.label) && t.study_focus?.length);
      if (tests.length) {
        lines.push('## Tests on this chapter');
        for (const t of tests) lines.push(`### ${t.title}${t.date ? ` (${t.date})` : ''}`, ...t.study_focus.map((f) => `- ${f}`), '');
      }
      fs.writeFileSync(file, lines.join('\n'));
    }
    const text = fs.readFileSync(file, 'utf8');
    const at = text.indexOf('\n## Review material: ');
    const end = text.indexOf('\n## Tests on this chapter');
    const head = text.slice(0, [at, end].filter((x) => x >= 0).sort((a, b) => a - b)[0] ?? text.length);
    return { label: c.label, path: rel(file), head, review: at < 0 ? '' : text.slice(at + 1, end > at ? end : undefined), source: c.textbook_source };
  });
  return { notes, general, sources };
}

/** Every chapter's notes for a class (before writing its textbook): the same files practice sets use. */
async function notesFor(courseCode, docText, step) {
  const p = profiles.paths();
  const src = await db.practiceSources(p.db, p.textbooks, { courseId: courseCode, allChapters: true });
  if (!src) return null;
  return chapterNotes({ course: src.course, chapters: src.chapters, tests: src.tests || [], class_files: classFiles(src.course.code) }, docText, step);
}

/**
 * Write `data/study/requests/<id>.md`, Kea's brief for one set, and return its workspace-relative path.
 * docText(file) converts one PDF or Word file to text; step(message, percent) reports progress.
 */
async function prepare(id, docText, step = () => {}) {
  const ws = profiles.paths().workspace;
  const rel = (f) => path.relative(ws, f).replace(/\\/g, '/');
  const req = readJson(path.join(ws, 'data', 'study', 'requests', `${id}.json`), null);
  if (!req) throw new Error('The request for this set is missing.');
  const { notes, general, sources } = await chapterNotes(req, docText, step);

  // The brief: the tests first, then each chapter (objectives and vocabulary whole; review text shares the budget).
  const lines = [`# Write ${req.count} new ${req.kind === 'exam' ? 'practice exam questions' : 'flashcards'}${req.bank ? ' for the chapter’s Question bank' : ''}: ${req.course.code} ${req.course.name}`, '', `Output file: ${req.output}`, ''];
  const tests = (req.tests || []).filter((t) => t.study_focus?.length || t.description);
  if (tests.length) {
    lines.push('## What the real tests cover (scraped from the class site: the top priority)', '');
    for (const t of tests) {
      lines.push(`### ${t.title}${t.date ? ` (${t.date})` : ''}${req.item?.id === t.id ? ': the test this set is for' : ''}`);
      if (t.chapters?.length) lines.push(`Covers: ${t.chapters.join(', ')}`);
      lines.push(...(t.study_focus || []).map((f) => `- ${f}`));
      if (t.description) lines.push(squeeze(htmlText(t.description)).slice(0, 2000));
      lines.push('');
    }
  }
  const texts = share([...notes.filter((n) => n.review).map((n) => ({ key: n.label, path: n.path, text: n.review })), ...general.map((f) => ({ key: f, path: rel(f), text: readText(f) }))], BRIEF_BUDGET);
  const textOf = (k) => texts.find((t) => t.key === k)?.text || '';
  for (const n of notes) {
    lines.push(n.head.replace(/^# /, '## ').replace(/^## (Objectives|Vocabulary)$/gm, '**$1**').trim());
    if (n.source) lines.push(`(Kea's textbook chapter, only to check a fact: ${n.source})`);
    const r = textOf(n.label);
    if (r) lines.push('', r.replace(/^## /gm, '### ').trim());
    lines.push('');
  }
  const wide = general.map((f) => ({ name: path.basename(f).replace(/\.txt$/, ''), text: textOf(f) })).filter((t) => t.text);
  if (wide.length) {
    lines.push('## Class-wide review material', '');
    for (const t of wide) lines.push(`### ${t.name}`, t.text, '');
  }
  if (!sources.length) lines.push('(No review material has been downloaded for these chapters: write from the tests, objectives and vocabulary.)', '');
  // What the student already has: new items must be different (other problems, other angles, gaps in coverage).
  const existing = req.existing || [];
  if (existing.length) {
    lines.push(`## Already saved for these chapters (${existing.length}; don't repeat these)`, '');
    if (req.reuse?.length) lines.push(`This set also reuses ${req.reuse.length} of them. Write only the ${req.count} new ones.`, '');
    let room = 14000;
    const by = new Map();
    for (const x of existing) by.set(x.chapter || 'Other', [...(by.get(x.chapter || 'Other') || []), x]);
    for (const [ch, xs] of by) {
      lines.push(`### ${ch} (${xs.length})`);
      for (const x of xs) {
        const line = `- ${x.topic ? `[${x.topic}] ` : ''}${x.text}`;
        if ((room -= line.length) < 0) break;
        lines.push(line);
      }
      lines.push('');
    }
    if (room < 0) lines.push('(More are saved; aim for topics and problem types missing above.)', '');
  }
  const out = `data/study/requests/${id}.md`;
  fs.writeFileSync(path.join(ws, out), lines.join('\n'));
  return out;
}

/** The runner's prompt for a set (a resumed run says so). */
const prompt = (arg) => {
  const id = String(arg || '').split(/\s+/)[0];
  return `/kea-practice data/study/requests/${id}.md${/\bresume\b/.test(arg) ? ' resume' : ''}`;
};

// ---------- Checking what Claude wrote ----------
const str = (v) => (typeof v === 'string' ? v.trim() : '');

/** One question, cleaned, or null when it can't be used. */
function cleanQuestion(q) {
  if (!q || typeof q !== 'object') return null;
  const base = { type: q.type, q: str(q.q), explain: str(q.explain), chapter: str(q.chapter) || null, section: str(q.section) || null, topic: str(q.topic) || null, source: str(q.source) || null };
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
  if (q.type === 'blank') {
    const accept = Array.isArray(q.accept) ? q.accept.map(str).filter(Boolean) : [];
    return str(q.answer) && /_{2,}/.test(base.q) ? { ...base, answer: str(q.answer), ...(accept.length ? { accept } : {}) } : null;
  }
  return null;
}

function cleanCard(c) {
  if (!c || !str(c.front) || !str(c.back)) return null;
  return { front: str(c.front), back: str(c.back), chapter: str(c.chapter) || null, section: str(c.section) || null, topic: str(c.topic) || null };
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
  const made = keyed(kind === 'cards' ? (raw.cards || []).map(cleanCard).filter(Boolean) : (raw.questions || []).map(cleanQuestion).filter(Boolean));
  // The saved questions this set reuses, then the new ones (any that repeat a saved question are left out).
  const req = readJson(path.join(profiles.paths().workspace, 'data', 'study', 'requests', `${id}.json`), {});
  const reuse = keyed(req.reuse || []);
  const old = new Set((req.existing || []).map((x) => x.k).concat(reuse.map((x) => x.k)));
  const fresh = made.filter((x, i) => !old.has(x.k) && made.findIndex((y) => y.k === x.k) === i);
  const items = [...reuse, ...fresh];
  if (!fresh.length) {
    update(id, { status: 'failed', error: 'Nothing usable came back.' });
    return null;
  }
  writeJson(file('sets', `${id}.json`), kind === 'cards' ? { cards: items } : { questions: items });
  fs.rmSync(out, { force: true });
  return update(id, { status: 'ready', count: items.length, reused: reuse.length, error: undefined, readyAt: new Date().toISOString() });
}

/** A set Kea was making when it closed (or whose run failed to start) shouldn't spin forever: fail it once no run is making it. */
function settle(isRunning) {
  const list = index();
  let changed = false;
  for (const e of list) {
    if (e.status === 'making' && !isRunning(e.id) && Date.now() - new Date(e.createdAt).getTime() > 2 * 60e3) {
      e.status = 'failed';
      e.error = 'It never finished. Try again.';
      changed = true;
    }
  }
  if (changed) saveIndex(list);
}

module.exports = { list, get, remove, saveAttempt, setKnown, catalog, saved, history, request, bankNeed, notesFor, prepare, prompt, ingest, settle, cleanQuestion, cleanCard };
