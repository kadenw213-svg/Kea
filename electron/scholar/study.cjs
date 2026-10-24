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
//                        (spaced review's answers are kept under the id `review`, one attempt per answer)
//   cards.json          { [id]: { known: [card key], at } }          (flashcards; older copies hold card indices)
//   stars.json          { [k]: true }                                (starred cards and questions)
//   review.json         { [k]: { box, due, last, lapses } }          (spaced review, see review())
//   learn.json          { [id]: { [k]: 0 | 1 | 2, _at } }            (Learn: new, familiar, mastered; _at: when saved)
//   match.json          { [id]: best time in ms }                     (Match)
// Sets the student makes or imports themselves are ordinary card sets with source 'mine' (courseId may be '').
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

// ---------- What the instructor said to practice ----------
// A message like "practice this; the practical will have more like it", kept word for word per class, and given to
// every practice set Kea writes for that class from then on (newest first).
const hintsFile = () => file('hints.json');
/** The class's instructor hints from the last 120 days: [{ at, from, subject, text }]. */
function hints(courseId) {
  const all = readJson(hintsFile(), {});
  return (all[courseId] || []).filter((h) => Date.now() - Date.parse(h.at) < 120 * 864e5);
}
/** Keep a hint (once per message). True when it's new. */
function addHint(courseId, h) {
  const all = readJson(hintsFile(), {});
  const list = all[courseId] || [];
  if (list.some((x) => x.id === h.id)) return false;
  all[courseId] = [{ ...h, text: String(h.text || '').slice(0, 3000) }, ...list].slice(0, 30);
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(hintsFile(), JSON.stringify(all, null, 1));
  return true;
}
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
        known: new Set(cards[e.id]?.known || []).size
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
        // (An answer left unmarked, or not graded, counts neither way.)
        if (ok == null) continue;
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
  const s = readJson(file('sets', `${id}.json`), null) || readJson(file('mine', `${id}.json`), null) || readJson(file('local', `${id}.json`), {});
  // (Known cards are kept by key; an older copy by position, read here against the cards as they are now.)
  const asCards = s.cards ? keyed(s.cards) : keyed(s.questions).filter((q) => q.type !== 'short');
  const out = { ...e, known: knownKeys(readJson(file('cards.json'), {})[id]?.known, asCards) };
  if (s.questions) {
    out.questions = keyed(s.questions);
    const h = history();
    out.history = Object.fromEntries(out.questions.filter((q) => h[q.k]).map((q) => [q.k, h[q.k]]));
  }
  if (s.cards) out.cards = keyed(s.cards);
  const stars = starred();
  out.starred = [...(out.cards || []), ...(out.questions || [])].filter((it) => stars[it.k]).map((it) => it.k);
  out.learn = learnGet(id);
  out.matchBest = readJson(file('match.json'), {})[id] || null;
  return out;
}

// A set's id: its kind, then letters, digits and hyphens ("exam-pick-hub…-1a2b3c4d" from the Study page, too).
const SET_ID = /^(exam|cards)-[a-z0-9-]+$/;
const validId = (id) => typeof id === 'string' && id.length <= 120 && SET_ID.test(id);

/** Known cards as keys: an older copy listed positions in the set (`cards` as the player shows them). */
function knownKeys(known, cards) {
  if (!Array.isArray(known)) return [];
  return [...new Set(known.map((x) => (typeof x === 'number' ? cards[x]?.k : x)).filter((x) => typeof x === 'string' && x))];
}

function remove(id) {
  // (Plus the older rule, so any set listed before can still be deleted.)
  if (!validId(String(id)) && !/^[a-z]+-[a-z0-9]+$/i.test(String(id))) return false;
  saveIndex(index().filter((x) => x.id !== id));
  fs.rmSync(file('sets', `${id}.json`), { force: true });
  fs.rmSync(file('local', `${id}.json`), { force: true });
  fs.rmSync(file('mine', `${id}.json`), { force: true });
  const attempts = readJson(file('attempts.json'), {});
  delete attempts[id];
  writeJson(file('attempts.json'), attempts);
  learnDrop(id);
  return true;
}

/** An attempt: its score, and how each question went ([key, right], right null for an unmarked written answer). */
function saveAttempt(id, a) {
  const attempts = readJson(file('attempts.json'), {});
  const items = Array.isArray(a.items) ? a.items.filter((x) => Array.isArray(x) && typeof x[0] === 'string').map(([k, ok]) => [k, ok == null ? null : !!ok]) : undefined;
  (attempts[id] = attempts[id] || []).push({ at: new Date().toISOString(), score: a.score, total: a.total, n: a.n, ...(items ? { items } : {}) });
  writeJson(file('attempts.json'), attempts);
  // Every miss comes back in spaced review: box 0, due today. Ones got right keep their place (no demotion).
  const missed = (items || []).filter(([k, ok]) => ok === false && REAL_KEY.test(k)).map(([k]) => k);
  if (missed.length) {
    const state = readJson(file('review.json'), {});
    const today = dayStr(new Date());
    const now = new Date().toISOString();
    for (const k of new Set(missed)) {
      const was = state[k];
      state[k] = { box: 0, due: today, last: now, lapses: (was?.lapses || 0) + (was ? 1 : 0), first: was?.first || today };
    }
    writeJson(file('review.json'), state);
  }
  return true;
}
// A saved item's own key (a deck's Test makes questions keyed "<card key>-c" and the like, which aren't reviewed).
const REAL_KEY = /^[0-9a-f]{12}$/;

/** Which cards are known, by key (positions, from an older Kea, are turned into keys with the set's cards). */
function setKnown(id, known) {
  const cards = readJson(file('cards.json'), {});
  const list = Array.isArray(known) ? known : [];
  let keys = list.filter((x) => typeof x === 'string' && x);
  if (list.some((x) => typeof x === 'number')) {
    const s = readJson(file('sets', `${id}.json`), null) || readJson(file('mine', `${id}.json`), null) || readJson(file('local', `${id}.json`), {});
    keys = knownKeys(list, s.cards ? keyed(s.cards) : keyed(s.questions).filter((q) => q.type !== 'short'));
  }
  cards[id] = { known: [...new Set(keys)], at: new Date().toISOString() };
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
 * every time and seen lately last. Spread across the chapters, so a review isn't all one chapter. On a topic the
 * student is doing well on, its multi-step questions (then apply) come before its recall ones; misses still come first.
 */
function pick(items, n, h = history()) {
  const now = Date.now();
  const strong = strongTopics(items, h);
  const score = (it) => {
    const x = h[it.k];
    if (x && x.lastRight === false) return 4 + Math.min(2, (now - Date.parse(x.last)) / 864e5 / 7) + Math.random() * 0.5;
    const lift = strong.has(topicOf(it)) ? LEVEL_LIFT[it.level] || 0 : 0;
    const base = !x ? 3 + Math.random() : 1 - x.right / Math.max(1, x.seen) + Math.min(2, (now - Date.parse(x.last)) / 864e5 / 7) + Math.random() * 0.5;
    // (Below every miss, however much it's lifted.)
    return Math.min(3.99, base + lift);
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

// Doing well on a topic: at least 4 of its questions tried and 80% of them right the last time. Its harder questions
// are then lifted (multi-step most), its recall ones lowered.
const LEVEL_LIFT = { multistep: 1.2, apply: 0.6, recall: -0.6 };
const topicOf = (it) => it.section || it.chapter || '';
function strongTopics(items, h) {
  const tally = new Map();
  for (const it of items) {
    const x = h[it.k];
    if (!x || x.lastRight == null) continue;
    const t = tally.get(topicOf(it)) || { tried: 0, right: 0 };
    t.tried++;
    if (x.lastRight) t.right++;
    tally.set(topicOf(it), t);
  }
  return new Set([...tally].filter(([, t]) => t.tried >= 4 && t.right / t.tried >= 0.8).map(([k]) => k));
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
      else if (/\.(pdf|docx|pptx)$/i.test(f.name) && !fs.existsSync(`${full}.txt`)) files.push({ path: path.relative(ws, full).replace(/\\/g, '/'), bytes: fs.statSync(full).size, needs_text: true });
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
async function request({ id: given, kind, courseId, chapters = [], itemId = null, count, mode = 'mix', pick: picked = null, bank = false, upgrade = false, pictures = false, fromHint = false }) {
  if (!['exam', 'cards'].includes(kind)) throw new Error('Unknown kind of study set.');
  const p = profiles.paths();
  const src = await db.practiceSources(p.db, p.textbooks, { courseId, chapters, itemId });
  if (!src) throw new Error('Kea couldn’t find that class.');
  if (!src.chapters.length && !src.item) throw new Error('Pick at least one chapter.');
  // (Asked for on another computer: it named the set, so both list the same one.)
  const id = validId(given) ? given : `${kind}-${Date.now().toString(36)}`;
  const labels = src.chapters.map((c) => c.label);
  const all = catalog(kind, src.course.id, labels);
  const n = mode === 'saved' ? Math.max(1, Math.min(Number(count) || all.length, all.length)) : clamp(kind, count);
  const byKey = new Map(all.map((it) => [it.k, it]));
  const reuse = Array.isArray(picked) && picked.every((k) => byKey.has(k)) ? picked.map((k) => byKey.get(k)) : mode === 'new' ? [] : pick(all, mode === 'saved' ? n : Math.floor(n * REUSE));
  if (mode === 'saved' && !reuse.length) throw new Error('There are no saved questions on these chapters yet.');
  const fresh = mode === 'saved' ? 0 : n - reuse.length;
  const topic = src.item ? src.item.title : src.chapters.map((c) => (c.title ? `${c.label}: ${c.title}` : c.label)).join(', ');
  const title = `${bank ? 'Question bank' : kind === 'exam' ? 'Practice exam' : 'Flashcards'}: ${topic}`;
  const entry = { id, kind, title: pictures ? title.replace(/^Question bank/, 'Picture questions') : title, ...(bank ? { bank: true } : {}), ...(upgrade ? { upgrade: true } : {}), ...(pictures ? { pictures: true } : {}), ...(fromHint ? { fromHint: true } : {}), courseId: src.course.id, courseCode: src.course.code, chapters: labels, itemId: src.item?.id || null, itemTitle: src.item?.title || null, count: reuse.length + fresh, reused: reuse.length, createdAt: new Date().toISOString() };
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
    upgrade,
    pictures: !!pictures,
    output: `data/study/out/${id}.json`
  };
  writeJson(path.join(p.workspace, 'data', 'study', 'requests', `${id}.json`), req);
  list.push({ ...entry, status: 'making', source: 'claude' });
  saveIndex(list);
  return { id, ready: false, pick: reuse.map((it) => it.k) };
}

// ---------- Question banks: every chapter with a textbook keeps saved questions ready ----------
// Each chapter with a textbook gets a bank of saved questions (25 by default) so practice is ready without asking, and
// when the student is running out (BANK_LOW or fewer they haven't seen or last got wrong), Kea adds BANK_MORE new
// ones. Small on purpose (the student's rule, 2026-10-21): every question costs Claude usage, so the bank grows only as
// it's used. Banks are ordinary sets (bank: true), written one at a time by the primary. Library classes can't make more,
// so their authors ship 100 per chapter instead.
const BANK_LOW = 5;
const BANK_MORE = 20;

/**
 * The next chapter (soonest test first) that tests identification and has few picture questions yet, as a request for
 * a picture set (25, saved with the chapter's bank), or null. Nothing while a set is being made, and a chapter whose
 * picture set failed waits a day.
 */
function pictureNeed(chapters, identifying) {
  const all = index();
  if (all.some((e) => e.status === 'making')) return null;
  for (const { courseId, label } of chapters) {
    if (!identifying.has(`${courseId}|${label}`)) continue;
    const pictured = catalog('exam', courseId, [label]).filter((q) => q.image).length;
    if (pictured >= 10) continue;
    const tried = all.find((e) => e.pictures && e.courseId === courseId && e.chapters?.[0] === label && Date.now() - Date.parse(e.createdAt) < 864e5);
    if (tried) continue;
    return { kind: 'exam', courseId, chapters: [label], count: 25, mode: 'new', bank: true, pictures: true };
  }
  return null;
}

/**
 * The next chapter whose bank needs questions, as a request for request(), or null. `size` is the bank's target;
 * `chapters` lists { courseId, label } for every chapter with a textbook. Nothing while a bank is being made.
 */
function bankNeed(chapters, size = 50) {
  const all = index();
  if (all.some((e) => e.bank && e.status === 'making')) return null;
  const h = history();
  for (const { courseId, label, test } of chapters) {
    const have = catalog('exam', courseId, [label]);
    // (A chapter whose last bank failed waits a day before trying again.)
    const failed = all.find((e) => e.bank && e.courseId === courseId && e.chapters?.[0] === label && e.status === 'failed' && Date.now() - Date.parse(e.createdAt) < 864e5);
    if (failed) continue;
    if (have.length < size) return { kind: 'exam', courseId, chapters: [label], count: Math.max(SIZES.exam[0], size - have.length), mode: 'new', bank: true };
    // A test coming within two weeks on a bank written before the difficulty rules (no levels, no worked arithmetic):
    // one top-up of harder questions aimed at what the old ones miss, once.
    const soon = test && (Date.parse(test) - Date.now()) / 864e5 <= 14;
    const old = have.length && !have.some((q) => q.level);
    const upgraded = all.some((e) => e.bank && e.upgrade && e.courseId === courseId && e.chapters?.[0] === label && e.status !== 'failed');
    if (soon && old && !upgraded) return { kind: 'exam', courseId, chapters: [label], count: 25, mode: 'new', bank: true, upgrade: true };
    const left = have.filter((it) => !h[it.k] || h[it.k].lastRight === false).length;
    if (left <= BANK_LOW) return { kind: 'exam', courseId, chapters: [label], count: BANK_MORE, mode: 'new', bank: true };
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

/**
 * A content link as its file: D2L's viewer page `/viewContent/<topic>/View` → the topic's direct download; a Canvas
 * file page `/courses/<id>/files/<file>` → its `/download`.
 */
const directUrl = (url) =>
  url
    .replace(/\/le\/content\/(\d+)\/viewContent\/(\d+)\/View.*$/, '/le/content/$1/topics/files/download/$2/DirectFileTopicDownload')
    .replace(/(\/courses\/\d+\/files\/\d+)(?:\/(?:preview|download))?(?:\?.*)?$/, '$1/download');

/**
 * Download the tests' review sheets and keys that aren't here yet (Kea's own signed-in browser, no Claude), saved as
 * `data/downloads/<CODE>/review/<label>.<pdf|docx|html>` with a text copy. Returns the paths of every sheet's text
 * for these chapters, cached or new.
 */
async function fetchSheets(req, nums, docText, step) {
  const ws = profiles.paths().workspace;
  const dir = path.join(ws, 'data', 'downloads', req.course.code, 'review');
  const seen = new Map();
  for (const t of [...(req.tests || []), ...(req.chapters || [])])
    for (const l of t.review_links || []) {
      if (!SHEET.test(l.label) || NOT_SHEET.test(l.label) || !/^https?:/.test(l.url)) continue;
      // Only files (a D2L content file, a Canvas file, a PDF or Word document), never a launch link into a platform like ALEKS.
      if (!/\/viewContent\/\d+|\/topics\/files\/download\/|\/courses\/\d+\/files\/\d+|\.(pdf|docx?)(\?|$)/i.test(l.url)) continue;
      const n = chapterNum(l.label);
      if (n && !nums.has(n)) continue;
      seen.set(safeName(l.label), l.url);
    }
  const have = (name) => ['pdf', 'docx', 'html'].map((x) => path.join(dir, `${name}.${x}`)).find((f) => fs.existsSync(f));
  const missing = [...seen].filter(([name]) => !have(name)).slice(0, 16);
  const failed = [];
  if (missing.length) {
    const browser = require('./browser.cjs');
    // Signed out: sign in first (the saved login, or Kea's window), the same as a class check does. Writing questions
    // without the review sheets is what left CHE1011's banks easier than its exams.
    let signedIn = await browser.status().then((s) => s.signedIn).catch(() => false);
    if (!signedIn) {
      step('Signing in to your class site for the review sheets…', 2);
      await browser.getJson(browser.platformOf() === 'canvas' ? '/api/v1/users/self' : '/d2l/api/lp/1.0/users/whoami').catch(() => null);
      signedIn = await browser.status().then((s) => s.signedIn).catch(() => false);
    }
    if (!signedIn) failed.push(...missing.map(([name]) => `${name} (not signed in to the class site)`));
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
          failed.push(`${name} (the class site sent ${r.contentType || 'something that isn’t a document'})`);
          continue;
        }
        const dest = path.join(dir, `${name}.${ext}`);
        fs.renameSync(full, dest);
        if (ext !== 'html') await docText(dest).catch(() => null);
      } catch (err) {
        failed.push(`${name} (${String(err?.message || err).slice(0, 80)})`);
      }
    }
    if (failed.length) console.error('Review sheets not downloaded:', failed.join('; '));
  }
  const files = [...seen.keys()]
    .map(have)
    .filter(Boolean)
    .map((f) => (/\.html$/.test(f) ? f : `${f}.txt`))
    .filter((f) => fs.existsSync(f));
  // (Which sheets the tests link to that Kea doesn't have: the brief says so plainly.)
  files.missing = failed;
  return files;
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
    if (/\.(pdf|docx|pptx)$/i.test(full) && !fs.existsSync(`${full}.txt`)) {
      step(`Reading ${path.basename(full)} (${i} of ${wanted.length})…`, Math.round((i / wanted.length) * 2));
      await docText(full).catch(() => null);
    }
  }
  const classTexts = wanted.map((f) => path.join(ws, /\.(pdf|docx|pptx)$/i.test(f.path) ? `${f.path}.txt` : f.path)).filter((f) => fs.existsSync(f));
  const sheets = await fetchSheets(req, nums, docText, step);
  step('Putting the chapters’ notes together…', 8);

  // Per-chapter notes: one plain text file each, rebuilt when the database or that chapter's material is newer.
  // Review sheets and answer keys first: when a chapter's review text is trimmed to fit, the end goes, and the sheets
  // are what the exams are built from.
  const sources = [...sheets, ...classTexts];
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
      if (c.depth_gaps) lines.push('## Kea’s depth review found these missing or too shallow (cover them first)', c.depth_gaps, '');
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
  return { notes, general, sources, missingSheets: sheets.missing || [] };
}

/** Every chapter's notes for a class (before writing its textbook): the same files practice sets use. */
async function notesFor(courseCode, docText, step) {
  const p = profiles.paths();
  const src = await db.practiceSources(p.db, p.textbooks, { courseId: courseCode, allChapters: true });
  if (!src) return null;
  return chapterNotes({ course: src.course, chapters: src.chapters, tests: src.tests || [], class_files: classFiles(src.course.code) }, docText, step);
}

/**
 * What the teacher has given for each chapter that has a test still to come: each upcoming test's study focus and
 * description, its review links, the chapter's own review sheets (from its weekly reading) and the class's review-like
 * files numbered for it. Links and files are compared by a hash; written text (`words` set: the study focus is
 * Claude's wording, re-saved by syncs) by how much of it is new, so a reworded line isn't new material.
 * Returns { course, chapters: Map(label -> { test: { id, title, date }, items: [{ h, text, words? }] }) }.
 */
async function teacherContext(courseCode) {
  const p = profiles.paths();
  const src = await db.practiceSources(p.db, p.textbooks, { courseId: courseCode, allChapters: true });
  if (!src) return null;
  const today = new Date().toISOString().slice(0, 10);
  const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
  const files = classFiles(src.course.code).filter((f) => !SKIP.test(f.path) && REVIEWISH.test(f.path) && !/\/review\//.test(f.path));
  const out = new Map();
  for (const c of src.chapters) {
    const tests = (src.tests || []).filter((t) => String(t.date || '').slice(0, 10) >= today && (t.chapters || []).includes(c.label));
    if (!tests.length) continue;
    const items = [];
    const add = (text, key, words) => items.push({ h: hash(key), text, ...(words ? { words } : {}), ...(key.startsWith('file|') ? { file: true } : {}) });
    const wordsOf = (x) => [...new Set(squeeze(htmlText(String(x))).toLowerCase().match(/[a-z0-9]{3,}/g) || [])].join(' ');
    for (const t of tests) {
      const when = `${t.title} (${String(t.date).slice(0, 10)})`;
      for (const f of t.study_focus || []) add(`${when} study focus: ${f}`, `focus|${t.id}|${f}`, wordsOf(f));
      if (t.description) add(`${when}: the instructor's description of the test`, `desc|${t.id}|${t.description}`, wordsOf(t.description));
      for (const l of t.review_links || []) add(`${when} review link: ${l.label || l.url}`, `link|${l.url}`);
    }
    for (const l of c.review_links || []) if (SHEET.test(l.label) && !NOT_SHEET.test(l.label)) add(`Review sheet: ${l.label}`, `link|${l.url}`);
    // Files count by name only: Kea's own text copy of a PDF (Review.pdf → Review.pdf.txt) or a re-synced page whose
    // size changed is not new teacher material. Unnumbered files and chapters never match each other.
    const num = chapterNum(c.label);
    if (num)
      for (const f of files)
        if (chapterNum(path.basename(f.path)) === num) {
          const name = f.path.replace(/\.(pdf|docx|pptx)\.txt$/i, '.$1');
          add(`Class file: ${path.basename(name)}`, `file|${name}`);
        }
    out.set(c.label, { test: { id: tests[0].id, title: tests[0].title, date: String(tests[0].date).slice(0, 10) }, items });
  }
  return { course: src.course, chapters: out };
}

/**
 * Write `data/study/requests/<id>.md`, Kea's brief for one set, and return its workspace-relative path.
 * docText(file) converts one PDF or Word file to text; step(message, percent) reports progress.
 */
async function prepare(id, docText, step = () => {}, engine = null) {
  const ws = profiles.paths().workspace;
  const rel = (f) => path.relative(ws, f).replace(/\\/g, '/');
  const req = readJson(path.join(ws, 'data', 'study', 'requests', `${id}.json`), null);
  if (!req) throw new Error('The request for this set is missing.');
  const { notes, general, sources, missingSheets } = await chapterNotes(req, docText, step);

  // The brief: the tests first, then each chapter (objectives and vocabulary whole; review text shares the budget).
  const lines = [`# Write ${req.count} new ${req.kind === 'exam' ? 'practice exam questions' : 'flashcards'}${req.bank ? ' for the chapter’s Question bank' : ''}: ${req.course.code} ${req.course.name}`, '', `Output file: ${req.output}`, ''];
  // Identification: lab practicals (and tests that ask to identify specimens or structures) are answered from pictures.
  const identifies = (req.tests || []).some((t) => t.type === 'lab_practical' || /\bidentif|\blabel(ed)?\b|specimen|structure/i.test(`${t.title} ${(t.study_focus || []).join(' ')}`));
  const told = hints(req.course.id).slice(0, 5);
  if (told.length)
    lines.push(
      '## What the instructor told the class to practice (follow this first)',
      'Word for word from the instructor’s messages. Where one says the test will have problems like something (a worksheet, an example, a kind of question), write more of exactly that kind, at that difficulty, for these chapters.',
      ...told.map((h) => `### ${h.subject || 'Message'} (${String(h.at).slice(0, 10)}${h.from ? `, from ${h.from}` : ''})\n${h.text}`),
      ''
    );
  if (req.pictures)
    lines.push(
      '## This is a picture set',
      'Most items show a picture and ask what it is or what a labeled part is: specimens, organisms, cell and tissue structures, anatomy, lab equipment, molecular shapes, whatever these chapters ask the student to recognize. Find each picture with `uv run academic-sync study-image search "<words>"`, save it with `study-image get "<File:...>" --course ' + req.course.code + ' --name <code>-id-<n>` (a name that never gives the answer away), and put its `image` and `image_credit` on the question or card.',
      ''
    );
  else if (identifies)
    lines.push(
      '## Picture questions',
      'This class tests identification (lab practicals or identify-the-structure questions). Make about 15 to 25% of the questions picture questions: show a specimen, structure or labeled diagram and ask what it is or what a label points to (see the skill, "Pictures").',
      ''
    );
  if (req.upgrade)
    lines.push(
      '## This is a harder top-up before the test',
      'The saved questions below were written before Kea checked difficulty, and many are recall or single-step. Write questions at and above exam level: mostly `multistep` and `apply`, with real calculations (each with `calc`), problems in the style of the review sheets and practice exams, and every objective, review-sheet problem type and study-focus line the saved questions miss or cover only once. No fill-in-the-blank definitions.',
      ''
    );
  // The syllabus: how the class tests (formats, what exams draw on) and what each chapter must teach. From Kea's
  // curriculum check, which holds the chapters to the syllabus.
  const cur = engine ? await engine(['curriculum', '--course', req.course.code, '--json']).catch(() => null) : null;
  const outcomesOf = (label) =>
    (cur?.outcomes || [])
      .filter((o) => !o.not_tested && (o.chapters || []).some((c) => String(c).toLowerCase() === String(label).toLowerCase()))
      .map((o) => `${{ course: 'Course outcome', module: 'Module outcome', outline: 'Topical outline', recommended: 'Recommended topic' }[o.kind] || o.kind} ${o.ref}: ${o.text}`);
  const everyChapter = outcomesOf('all');
  const guidelines = (cur?.guidelines || []).map((g) => g.text).filter(Boolean);
  if (guidelines.length || everyChapter.length) {
    lines.push('## How this class tests, and what every chapter serves (from the syllabus)', '');
    if (guidelines.length) lines.push('Write to these: the formats, question types and skills the real tests use.', ...guidelines.map((g) => `- ${g}`), '');
    if (everyChapter.length) lines.push('Outcomes every chapter serves (work them into questions on any chapter):', ...everyChapter.map((g) => `- ${g}`), '');
  }
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
    const ref = (cur?.chapters || []).find((c) => c.label === n.label)?.textbook_ref;
    if (ref) lines.push(`In the student's textbook: ${ref}`);
    const own = outcomesOf(n.label);
    if (own.length) lines.push('**Syllabus outcomes this chapter teaches (each needs questions)**', ...own.map((o) => `- ${o}`));
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
  if (missingSheets.length)
    lines.push(
      '## Review sheets Kea couldn’t download',
      'The tests link to these, and their problems are what the exams are built from, but Kea doesn’t have them: ' + missingSheets.join('; ') + '.',
      'Aim every calculation at the hardest version the chapter allows (several steps, unit conversions, combined concepts), never only the textbook’s simplest case, and say in your summary which sheets were missing.',
      ''
    );
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

/** A worked solution: 1 to 14 short steps, each one line of plain text. */
const cleanSteps = (steps) => (Array.isArray(steps) ? steps.map(str).filter(Boolean).map((x) => x.slice(0, 600)).slice(0, 14) : []);

/** One question, cleaned, or null when it can't be used. */
function cleanQuestion(q) {
  if (!q || typeof q !== 'object') return null;
  const base = { type: q.type, q: str(q.q), explain: str(q.explain), chapter: str(q.chapter) || null, section: str(q.section) || null, topic: str(q.topic) || null, source: str(q.source) || null, ...(['recall', 'apply', 'multistep'].includes(q.level) ? { level: q.level } : {}), ...(cleanSteps(q.steps).length ? { steps: cleanSteps(q.steps) } : {}), ...(q.answerDisputed ? { answerDisputed: true } : {}), ...picture(q) };
  if (!base.q) return null;
  if (q.type === 'mc' || q.type === 'multi') {
    const choices = Array.isArray(q.choices) ? q.choices.map(str).filter(Boolean) : [];
    if (choices.length < 2 || choices.length !== q.choices.length) return null;
    const answer = q.type === 'mc' ? [q.answer] : Array.isArray(q.answer) ? q.answer : [];
    if (!answer.length || answer.some((a) => !Number.isInteger(a) || a < 0 || a >= choices.length)) return null;
    // `wrong`: for each choice, the mistake it stands for ("" for a right one), shown when the student picks it.
    const wrong = Array.isArray(q.wrong) && q.wrong.length === choices.length ? q.wrong.map(str) : null;
    return { ...base, choices, answer: q.type === 'mc' ? answer[0] : [...new Set(answer)].sort(), ...(wrong && wrong.some(Boolean) ? { wrong } : {}) };
  }
  if (q.type === 'tf') return typeof q.answer === 'boolean' ? { ...base, answer: q.answer } : null;
  if (q.type === 'num') {
    const answer = Number(q.answer);
    if (!Number.isFinite(answer)) return null;
    const tol = Number(q.tolerance);
    return { ...base, answer, tolerance: Number.isFinite(tol) && tol >= 0 ? tol : Math.abs(answer) * 0.01, unit: str(q.unit) || null, ...(str(q.calc) ? { calc: str(q.calc) } : {}) };
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
  return { front: str(c.front), back: str(c.back), chapter: str(c.chapter) || null, section: str(c.section) || null, topic: str(c.topic) || null, ...picture(c) };
}

/**
 * A question's or card's picture (an identification question: a specimen, a structure, a labeled diagram), as
 * { image: 'images/<CODE>/<name>.jpg', image_credit }. The writer saves it in the workspace (study-image get); it's
 * copied into the student's study folder, where it's kept with the sets (and synced to their other devices).
 */
function picture(it) {
  const src = str(it.image);
  if (!src) return {};
  const m = /(?:^|\/)(?:data\/study\/)?images\/([A-Za-z0-9]+)\/([a-z0-9-]+\.(?:jpg|jpeg|png|webp|gif))$/i.exec(src.replace(/\\/g, '/'));
  if (!m) return {};
  const rel = `images/${m[1].toUpperCase()}/${m[2].toLowerCase()}`;
  const dest = file(rel);
  if (!fs.existsSync(dest)) {
    const from = path.join(profiles.paths().workspace, 'data', 'study', 'images', m[1].toUpperCase(), m[2]);
    if (!fs.existsSync(from)) return {};
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(from, dest);
  }
  return { image: rel, ...(str(it.image_credit) ? { image_credit: str(it.image_credit).slice(0, 200) } : {}) };
}

/** A saved picture as a data URL, for the study screens. */
function imageData(rel) {
  const m = /^images\/[A-Z0-9]+\/[a-z0-9-]+\.(jpg|jpeg|png|webp|gif)$/.exec(String(rel || ''));
  if (!m) return null;
  try {
    const type = m[1] === 'jpg' ? 'jpeg' : m[1];
    return `data:image/${type};base64,${fs.readFileSync(file(rel)).toString('base64')}`;
  } catch {
    return null;
  }
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
  const labels = e?.chapters || [];
  // Chapters named the way Kea names them ("Ch. 5" → "Chapter 5"), so every question counts toward its chapter: a
  // bank whose questions didn't count would be asked for again and again.
  const fixChapter = (it) => {
    if (labels.length === 1) return { ...it, chapter: labels[0] };
    const n = it.chapter ? chapterNum(String(it.chapter)) : null;
    const hit = n ? labels.find((l) => chapterNum(l) === n) : null;
    return hit ? { ...it, chapter: hit } : it;
  };
  const made = keyed((kind === 'cards' ? (raw.cards || []).map(cleanCard).filter(Boolean) : (raw.questions || []).map(cleanQuestion).filter(Boolean)).map(fixChapter));
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


// ---------- The student's own sets: made by hand or pasted in from Quizlet ----------
/** Save (create or replace) a set the student made: { id?, title, courseId, cards: [{ front, back }] }. Returns its id. */
async function saveMine({ id: given, title, courseId = '', cards }) {
  const clean = (Array.isArray(cards) ? cards : []).map(cleanCard).filter(Boolean).slice(0, 2000);
  if (!clean.length) throw new Error('Add at least one card with both sides filled in.');
  const name = String(title || '').trim().slice(0, 120) || 'My cards';
  let courseCode = '';
  if (courseId) {
    const p = profiles.paths();
    courseCode = (await db.courses(p.db, p.textbooks, {}).catch(() => [])).find((c) => c.id === courseId)?.code || '';
  }
  const old = given ? index().find((e) => e.id === given && e.source === 'mine') : null;
  const id = old ? old.id : `cards-${Date.now().toString(36)}`;
  // Chapters: whatever the cards name, so a class's chapter views find them.
  const chapters = [...new Set(clean.map((c) => c.chapter).filter(Boolean))];
  const entry = { id, kind: 'cards', title: name, courseId: courseId || '', courseCode, chapters, itemId: null, itemTitle: null, count: clean.length, reused: 0, createdAt: old?.createdAt || new Date().toISOString(), editedAt: new Date().toISOString(), status: 'ready', source: 'mine' };
  // (In study/mine, which device sync never overwrites or prunes.)
  writeJson(file('mine', `${id}.json`), { cards: clean });
  saveIndex([...index().filter((e) => e.id !== id), entry]);
  return id;
}

// ---------- Stars ----------
function star(k, on) {
  const stars = readJson(file('stars.json'), {});
  if (on) stars[k] = true;
  else delete stars[k];
  writeJson(file('stars.json'), stars);
  // (With the time, so un-starring on one device carries to the others: studyMerge.cjs.)
  const log = readJson(file('stars-log.json'), {});
  log[k] = { on: !!on, at: new Date().toISOString() };
  writeJson(file('stars-log.json'), log);
  return true;
}
const starred = () => readJson(file('stars.json'), {});

// ---------- Learn and Match progress ----------
// Each set's levels carry `_at`, when they were saved, so the newer copy wins between devices (studyMerge.cjs); a reset
// is kept as an empty set with its time, so it isn't undone by the other device's older progress.
function learnGet(id) {
  const { _at, ...levels } = readJson(file('learn.json'), {})[id] || {};
  return levels;
}
/** Save a set's Learn levels ({} or null: start over). */
function learnSet(id, levels) {
  const all = readJson(file('learn.json'), {});
  const clean = Object.fromEntries(Object.entries(levels && typeof levels === 'object' ? levels : {}).filter(([k, v]) => k !== '_at' && [0, 1, 2].includes(v)));
  all[id] = { ...clean, _at: new Date().toISOString() };
  writeJson(file('learn.json'), all);
  return true;
}
/** A deleted set's Learn progress, gone. */
function learnDrop(id) {
  const all = readJson(file('learn.json'), {});
  delete all[id];
  writeJson(file('learn.json'), all);
}
function matchBest(id, ms) {
  const all = readJson(file('match.json'), {});
  if (Number.isFinite(ms) && ms > 0 && (!all[id] || ms < all[id])) {
    all[id] = Math.round(ms);
    writeJson(file('match.json'), all);
  }
  return all[id] || null;
}

// ---------- Spaced review, timed to the tests ----------
// Every card and question the student has (from every ready set) can come back for review. Each has a box: right moves
// it up a box (Easy two), wrong sends it back two. A box is how many days until it's due again; but a card on a chapter
// with a test coming is always due again before that test (the day before, at the latest), so everything gets one
// last look in time. New items are introduced a few a day, the chapters with the soonest test first.
const BOX_DAYS = [0, 1, 2, 4, 8, 16, 32, 64];
// (In the student's own time zone: a UTC date rolls over every evening in the Americas.)
const dayStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (n) => dayStr(new Date(Date.now() + n * 864e5));

/** Every reviewable item of the ready sets (in this class, or all): [{ k, kind, item, setId, courseId, courseCode, chapter }]. */
// Kept between calls until a set or the list of sets changes (reading every set took most of half a second, during
// which Kea's window froze).
let reviewCache = { sig: '', items: null };
function reviewable(courseId) {
  const all = reviewableAll();
  return courseId ? all.filter((x) => x.courseId === courseId) : all;
}
function reviewableAll() {
  const sig = ['index.json', 'sets', 'mine', 'local']
    .map((n) => {
      try {
        const st = fs.statSync(file(n));
        // (A folder's time changes when a file is added or removed; each set's own time when it's rewritten.)
        const inner = st.isDirectory() ? fs.readdirSync(file(n)).map((f) => fs.statSync(file(n, f)).mtimeMs).join(',') : '';
        return `${st.mtimeMs}:${inner}`;
      } catch {
        return '-';
      }
    })
    .join('|');
  if (reviewCache.sig === sig && reviewCache.items) return reviewCache.items;
  const out = new Map();
  for (const e of index()) {
    if (e.status !== 'ready') continue;
    const s = readJson(file('sets', `${e.id}.json`), null) || readJson(file('mine', `${e.id}.json`), null) || readJson(file('local', `${e.id}.json`), {});
    const one = (it, kind) => {
      if (out.has(it.k)) return;
      // Written answers need the student to mark them: they stay in practice exams, not in quick review.
      if (kind === 'question' && it.type === 'short') return;
      // A question whose stored answer a review found may be wrong isn't drilled (it's still shown in practice exams).
      if (it.answerDisputed) return;
      out.set(it.k, { k: it.k, kind, item: it, setId: e.id, courseId: e.courseId, courseCode: e.courseCode, chapter: it.chapter || (e.chapters || [])[0] || null });
    };
    for (const c of keyed(s.cards)) one(c, 'card');
    for (const q of keyed(s.questions)) one(q, 'question');
  }
  reviewCache = { sig, items: [...out.values()] };
  return reviewCache.items;
}

/**
 * What's due: { due: [...], fresh: [...], counts: { [courseId]: { due, fresh, total, code, test } } }. `limit` caps the
 * session; `chapters` narrows it to some chapters of the class (studying one chapter or one exam).
 */
async function reviewQueue({ courseId = '', chapters = [], sections = [], limit = 40, newPerDay = 15 } = {}) {
  const p = profiles.paths();
  const tests = await db.nextTests(p.db).catch(() => ({}));
  const state = readJson(file('review.json'), {});
  const today = dayStr(new Date());
  const testOf = (x) => tests[`${x.courseId}|${x.chapter}`] || null;
  const stars = starred();
  const want = new Set(chapters || []);
  const topics = new Set(sections || []);
  const all = reviewable(courseId)
    .filter((x) => (!want.size || want.has(x.chapter)) && (!topics.size || topics.has(x.item.section)))
    .map((x) => ({ ...x, test: testOf(x), state: state[x.k] || null, starred: !!stars[x.k] }));
  const soon = (x) => (x.test ? x.test.date : '9999');
  // Due: oldest first, then the soonest test.
  const due = all.filter((x) => x.state && x.state.due <= today).sort((a, b) => a.state.due.localeCompare(b.state.due) || soon(a).localeCompare(soon(b)));
  // New ones today, a few a day, shared fairly between classes: each class gets turns (two for a class with a test in
  // the next week), and within a class the chapters with a test coming first, starred first. (Before, the class with
  // the soonest test took every new card.) Studying one chapter or one exam isn't limited to today's few.
  const introduced = Object.values(state).filter((s) => s.first === today).length;
  // (Studying what the student picked has no daily cap: every unseen one can come, a session at a time.)
  const room = want.size || topics.size ? limit : Math.max(0, newPerDay - introduced);
  const byClass = new Map();
  for (const x of all.filter((y) => !y.state).sort((a, b) => soon(a).localeCompare(soon(b)) || Number(b.starred) - Number(a.starred))) byClass.set(x.courseId, [...(byClass.get(x.courseId) || []), x]);
  const weekAway = addDays(7);
  const turns = [...byClass.values()].map((list) => ({ list, weight: list[0].test && list[0].test.date <= weekAway ? 2 : 1 }));
  const fresh = [];
  while (fresh.length < room && turns.some((t) => t.list.length))
    for (const t of turns) for (let n = 0; n < t.weight && t.list.length && fresh.length < room; n++) fresh.push(t.list.shift());
  const counts = {};
  for (const x of all) {
    const c = (counts[x.courseId] = counts[x.courseId] || { due: 0, fresh: 0, total: 0, learning: 0, mastered: 0, code: x.courseCode, test: null });
    // (Mastered: it has come back right enough times to wait 8 days or more.)
    if (x.state) x.state.box >= 4 ? c.mastered++ : c.learning++;
    if (x.test && (!c.test || x.test.date < c.test.date)) c.test = x.test;
    c.total++;
    if (x.state && x.state.due <= today) c.due++;
    if (!x.state) c.fresh++;
  }
  const strip = ({ state: _s, ...x }) => ({ ...x, box: _s?.box ?? null });
  return { due: due.slice(0, limit).map(strip), fresh: fresh.slice(0, Math.max(0, limit - due.length)).map(strip), counts, newToday: Math.max(0, newPerDay - introduced) };
}

/** How one went: grade 'again' | 'good' | 'easy'. Returns the item's new { box, due }. */
async function reviewMark(k, grade, { courseId = '', chapter = null } = {}) {
  const state = readJson(file('review.json'), {});
  const today = dayStr(new Date());
  const was = state[k] || { box: 0, lapses: 0, first: today };
  let box = grade === 'again' ? Math.max(0, was.box - 2) : Math.min(BOX_DAYS.length - 1, was.box + (grade === 'easy' ? 2 : 1));
  let due = addDays(BOX_DAYS[box]);
  // Back before its test: never due on or after the test day while there's still a day to look at it.
  if (courseId && chapter) {
    const t = (await db.nextTests(profiles.paths().db).catch(() => ({})))[`${courseId}|${chapter}`];
    if (t && t.date > today) {
      const eve = dayStr(new Date(Date.parse(`${t.date}T12:00:00`) - 864e5));
      if (due >= t.date) due = eve > today ? eve : addDays(Math.min(1, BOX_DAYS[box]));
    }
  }
  const at = new Date().toISOString();
  state[k] = { box, due, last: at, lapses: (was.lapses || 0) + (grade === 'again' ? 1 : 0), first: was.first || today };
  writeJson(file('review.json'), state);
  // The answer joins the question's history too, so mastery and which questions a practice exam favours reflect it.
  const attempts = readJson(file('attempts.json'), {});
  const right = grade !== 'again';
  (attempts.review = Array.isArray(attempts.review) ? attempts.review : []).push({ at, score: right ? 1 : 0, total: 1, n: 1, items: [[k, right]] });
  writeJson(file('attempts.json'), attempts);
  return state[k];
}

/**
 * Better explanations (and notation fixes) for saved questions, from a depth review: [{ k, explain, q? }]. Each
 * question keeps its key, so stars, Learn progress and spaced review carry on. Returns how many were changed.
 */
function applyFixes(courseId, fixes) {
  const byKey = new Map((Array.isArray(fixes) ? fixes : []).filter((f) => f && typeof f.k === 'string' && (str(f.explain).length >= 40 || cleanSteps(f.steps).length >= 2)).map((f) => [f.k, f]));
  if (!byKey.size) return 0;
  let changed = 0;
  for (const e of index()) {
    if (e.courseId !== courseId || e.kind !== 'exam' || e.status !== 'ready') continue;
    const f = file('sets', `${e.id}.json`);
    const s = readJson(f, null);
    if (!s?.questions) continue;
    let touched = false;
    s.questions = s.questions.map((q) => {
      const k = q.k || keyOf(q);
      const fix = byKey.get(k);
      if (!fix) return q;
      touched = true;
      changed++;
      // (The key stays the question's old one even when its wording is fixed.)
      return { ...q, k, ...(str(fix.explain).length >= 40 ? { explain: str(fix.explain) } : {}), ...(cleanSteps(fix.steps).length >= 2 ? { steps: cleanSteps(fix.steps) } : {}), ...(str(fix.q) ? { q: str(fix.q) } : {}), ...(fix.wrong_answer ? { answerDisputed: true } : {}) };
    });
    if (touched) writeJson(f, s);
  }
  return changed;
}

/**
 * The saved questions of some chapters, each with how it has gone: for choosing exactly what to study (by topic, and
 * new, missed or starred ones). [{ k, chapter, section, topic, type, level, seen, right, lastRight, box, starred, steps }]
 */
function pool(courseId, chapters) {
  const h = history();
  const review = readJson(file('review.json'), {});
  const stars = starred();
  return catalog('exam', courseId, chapters).map((q) => ({
    k: q.k,
    chapter: q.chapter,
    section: q.section || null,
    topic: q.topic || null,
    type: q.type,
    level: q.level || null,
    seen: h[q.k]?.seen || 0,
    right: h[q.k]?.right || 0,
    lastRight: h[q.k]?.lastRight ?? null,
    box: review[q.k]?.box ?? null,
    starred: !!stars[q.k],
    steps: Array.isArray(q.steps) && q.steps.length > 1
  }));
}

/** The first chapter (in the order given: soonest test first) with saved questions that have no worked steps yet. */
function stepsNeed(chapters) {
  for (const { courseId, label } of chapters) {
    const missing = catalog('exam', courseId, [label]).filter((q) => q.type !== 'short' && !(Array.isArray(q.steps) && q.steps.length > 1));
    if (missing.length) return { courseId, label, missing: missing.length };
  }
  return null;
}

/**
 * The brief for writing worked steps for a chapter's questions that have none: every such question with its answer and
 * explanation. Returns { brief, output, count } (workspace-relative paths).
 */
function stepsBrief(courseId, code, label) {
  const ws = profiles.paths().workspace;
  const dir = path.join(ws, 'data', 'study', 'steps', code);
  fs.mkdirSync(dir, { recursive: true });
  const qs = catalog('exam', courseId, [label]).filter((q) => q.type !== 'short' && !(Array.isArray(q.steps) && q.steps.length > 1));
  const ans = (q) => (q.type === 'mc' ? q.choices[q.answer] : q.type === 'multi' ? q.answer.map((i) => q.choices[i]).join('; ') : q.type === 'tf' ? (q.answer ? 'True' : 'False') : `${q.answer}${q.unit ? ` ${q.unit}` : ''}`);
  const lines = [`# ${code} ${label}: ${qs.length} questions that need worked steps`, ''];
  qs.forEach((q, i) =>
    lines.push(
      `${i + 1}. k=${q.k} [${q.type}${q.level ? `, ${q.level}` : ''}${q.section ? `, ${q.section}` : ''}]`,
      `   Q: ${String(q.q).replace(/\s+/g, ' ')}`,
      ...(q.choices ? [`   Choices: ${q.choices.join(' | ')}`] : []),
      `   Answer: ${ans(q)}`,
      `   Explanation: ${String(q.explain || '').replace(/\s+/g, ' ')}`,
      ''
    )
  );
  const brief = path.join(dir, `${label}.md`);
  fs.writeFileSync(brief, lines.join('\n'));
  const rel = (f) => path.relative(ws, f).replace(/\\/g, '/');
  return { brief: rel(brief), output: rel(path.join(dir, `${label}.steps.json`)), count: qs.length };
}

/** Which class and chapter a saved question is in (by its key): { courseId, courseCode, chapter } or null. */
function whereIs(k) {
  for (const e of index()) {
    if (e.kind !== 'exam' || e.status !== 'ready' || !e.courseId) continue;
    const q = keyed(readJson(file('sets', `${e.id}.json`), {}).questions).find((x) => x.k === k);
    if (q) return { courseId: e.courseId, courseCode: e.courseCode, chapter: q.chapter || (e.chapters || [])[0] || null };
  }
  return null;
}

module.exports = { addHint, hints, applyFixes, pictureNeed, pool, stepsNeed, stepsBrief, whereIs, imageData, list, get, remove, saveAttempt, setKnown, catalog, saved, history, request, bankNeed, notesFor, prepare, prompt, ingest, settle, cleanQuestion, cleanCard, saveMine, star, starred, learnGet, learnSet, matchBest, reviewQueue, reviewMark, teacherContext, _test: { pick } };
