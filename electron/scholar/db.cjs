// Reads a profile's scan-engine database (SQLite, written by the engine's `academic-sync` CLI) for Kea Scholar.
// Kea only reads it: what's checked off and other Kea state live in the profile's kea.json.
// sql.js (SQLite compiled to WebAssembly) is used because this Electron has no built-in SQLite.
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

let SQL = null;
// Dates in the student's own time zone (a UTC date turns into tomorrow every evening in the Americas).
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function engine() {
  if (!SQL) SQL = await initSqlJs({ locateFile: (f) => path.join(path.dirname(require.resolve('sql.js')), f) });
  return SQL;
}

// The open databases (one per class site), each re-read when its file changes (after a scan).
const cache = new Map();
async function open(file) {
  if (!fs.existsSync(file)) return null;
  const mtime = fs.statSync(file).mtimeMs;
  const hit = cache.get(file);
  if (hit && hit.mtime === mtime) return hit.db;
  const S = await engine();
  const db = guardCodes(new S.Database(fs.readFileSync(file)));
  // (A newer read may have finished first: keep the newest, and close only what nothing holds any more.)
  const now = cache.get(file);
  if (now && now.mtime > mtime) {
    db.close();
    return now.db;
  }
  cache.set(file, { mtime, db });
  if (now) setTimeout(() => now.db.close(), 30000);
  return db;
}

/**
 * Hide every class whose course code can't be a folder name ("BIO1010\..\..\x"): Kea builds paths from course codes
 * (downloads, notes, textbooks), and a class database can come from someone else's Kea folder. A temporary view named
 * `courses` shadows the table for every query on this (read-only, in-memory) copy; the file itself is never changed.
 */
function guardCodes(db) {
  const { validCode } = require('./safePaths.cjs');
  try {
    db.create_function('kea_valid_code', (c) => (validCode(c) ? 1 : 0));
    const has = rows(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'courses'").length;
    if (has) db.run('CREATE TEMP VIEW courses AS SELECT * FROM main.courses WHERE kea_valid_code(course_code) = 1');
  } catch (err) {
    console.error('Course code guard', err.message);
  }
  return db;
}

/** The course codes in a class database file that can't be folder names (empty when it's fine, or has no classes). */
async function badCourseCodes(file) {
  const { validCode } = require('./safePaths.cjs');
  const S = await engine();
  const db = new S.Database(fs.readFileSync(file));
  try {
    return rows(db, 'SELECT course_code FROM courses').map((r) => r.course_code).filter((c) => !validCode(c));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

function rows(db, sql, params = []) {
  const st = db.prepare(sql);
  st.bind(params);
  const out = [];
  while (st.step()) out.push(st.getAsObject());
  st.free();
  return out;
}

const json = (s, fallback) => {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
};
/** "14:30:00.000000" → "14:30". */
const hhmm = (t) => (t ? String(t).slice(0, 5) : null);

/** The chapters (or modules, units) a title names: "Chapter 22; Chapter 26", "Ch 4", "Module 1" → their labels. */
// Words that say what kind of thing an item is, not what it's about.
const ITEM_WORDS = new Set('lab labs handout handouts report reports quiz quizzes exam exams test tests assignment assignments homework hw discussion discussions practical practicals review reviews worksheet module unit chapter part online due submit submission upload uploaded work written notebook pdf post posts reply replies response responses introduction intro and the of for with from to in on a an week class lecture lectures activity activities pre prelab using use used basic principle principles overview general your you how what why which first second final new evaluat evaluation'.split(' '));
function topicWords(text) {
  return (
    String(text || '')
      .toLowerCase()
      .match(/[a-z]{3,}/g) || []
  )
    .filter((w) => !ITEM_WORDS.has(w))
    .map((w) => w.replace(/(ies|es|s)$/, (m) => (m === 'ies' ? 'y' : '')).slice(0, 7));
}
/** The chapters whose title or sections name an item's topic: the best match, when its words clearly overlap. */
function topicChapters(text, chapterWords) {
  if (!chapterWords?.size) return [];
  const want = [...new Set(topicWords(text))];
  if (!want.length) return [];
  // A word in the chapter's title or a section heading counts three times one in its vocabulary or objectives.
  const scored = [...chapterWords].map(([label, have]) => [label, want.reduce((n, w) => n + (have.strong.has(w) ? 3 : have.weak.has(w) ? 1 : 0), 0)]).filter(([, n]) => n > 0);
  const best = Math.max(0, ...scored.map(([, n]) => n));
  return best ? scored.filter(([, n]) => n === best).map(([l]) => l).slice(0, 2) : [];
}

/** What numbered lab or exam a title names ("Lab 8", "Exam 4", "the Final Exam"): its key, or null. */
function siblingKey(title) {
  const m = /\b(lab|exam|test|quiz)\s*#?\s*(\d+)\b/i.exec(title || '');
  if (m) return `${m[1].toLowerCase().replace('test', 'exam')}${m[2]}`;
  return /\bfinal exam\b/i.test(title || '') ? 'final' : null;
}

function chaptersIn(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/\b(chapter|ch\.?|module|unit)\s*(\d+[a-z]?)\b/gi)) {
    const kind = /^ch/i.test(m[1]) ? 'Chapter' : m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
    const label = `${kind} ${m[2].toUpperCase()}`;
    if (!out.includes(label)) out.push(label);
  }
  return out;
}
/**
 * The chapters a test covers: as saved, or, when nothing was saved, read from its title and study focus ("Practice
 * Exam Three (Ch5-Ch6)", "Online Quiz 2 (Ch 23-24, 27)", "Chapters 32–33"). A test with no chapters never shapes any
 * practice, so it's worked out rather than left empty. `known` limits it to chapters the class really has.
 */
function coveredOf(r, known) {
  const saved = json(r.covered_chapters_json, []);
  if (saved.length) return saved;
  const text = [r.title, ...json(r.study_focus_json, [])].join(' \n ');
  const out = [];
  for (const m of text.matchAll(/\b(?:chapters?|chs?\.?)\s*((?:\d+[a-z]?\s*(?:[-–]|to|through|,|&|and)?\s*(?:ch(?:apter)?s?\.?\s*)?)+)/gi)) {
    const parts = m[1].replace(/ch(?:apter)?s?\.?/gi, '').split(/\s*(?:,|&|\band\b)\s*/i);
    for (const part of parts) {
      const range = part.match(/(\d+)\s*(?:[-–]|to|through)\s*(\d+)/i);
      const nums = range ? Array.from({ length: Math.max(0, Math.min(40, +range[2] - +range[1])) + 1 }, (_, i) => +range[1] + i) : (part.match(/\d+/g) || []).map(Number);
      for (const n of nums) {
        const label = `Chapter ${n}`;
        if ((!known || known.has(label)) && !out.includes(label)) out.push(label);
      }
    }
  }
  return out;
}
const chapterNumber = (label) => parseFloat(String(label).replace(/[^\d.]/g, '')) || 0;

const ACTIVE = "status NOT IN ('superseded', 'cancelled')";
const TEST_TYPES = "('exam', 'final_exam', 'midterm', 'lab_practical', 'quiz')";
// Work whose description says what the class practices (for Study on a class with no chapters).
const WORK_TYPES = "('assignment', 'paper', 'lab', 'lab_handout', 'discussion', 'peer_review', 'project', 'presentation', 'homework', 'reading')";

/**
 * A chapter label as its kind and number: "Chapter 3", "Ch. 3", "Module 1", "Unit 2" or a bare "3". Labels that aren't
 * numbered compare as their lowercased text.
 */
function labelKey(label) {
  const s = String(label ?? '').trim();
  const m = /^(?:(chapter|chap\.?|ch\.?|module|mod\.?|unit)\s*)?(\d+[a-z]?)$/i.exec(s);
  if (!m) return { kind: null, n: s.toLowerCase() };
  return { kind: !m[1] ? null : /^ch/i.test(m[1]) ? 'chapter' : /^mod/i.test(m[1]) ? 'module' : 'unit', n: m[2].toLowerCase() };
}
/** Two labels name the same chapter: same number and kind, or one of them a bare number ("33" is "Chapter 33"). */
function sameChapter(a, b) {
  const x = labelKey(a);
  const y = labelKey(b);
  return x.n !== '' && x.n === y.n && (!x.kind || !y.kind || x.kind === y.kind);
}

const OUTCOME_ORDER = { course: 0, module: 1, outline: 2, recommended: 3 };
/**
 * A class's objectives from its syllabus and course pages, as the scan saved them (course_outcomes): each
 * { kind: 'course' | 'module' | 'outline' | 'recommended', ref, text, chapters }, "all" dropped from chapters. The ones
 * marked not tested (a lab or communication skill, with the reason) are left out. Empty for a database from before
 * the table.
 */
function outcomesOf(db, courseId) {
  try {
    if (!rows(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'course_outcomes'").length) return [];
    return rows(db, 'SELECT * FROM course_outcomes WHERE course_id = ?', [courseId])
      .filter((o) => String(o.text || '').trim() && (o.not_tested == null || /^\s*(0|false)?\s*$/i.test(String(o.not_tested))))
      .map((o) => ({
        kind: String(o.kind || 'course'),
        ref: String(o.ref ?? ''),
        text: String(o.text).trim(),
        chapters: json(o.chapters_json, []).filter((x) => typeof x === 'string' && x.trim() && x.trim().toLowerCase() !== 'all')
      }))
      .sort((a, b) => (OUTCOME_ORDER[a.kind] ?? 9) - (OUTCOME_ORDER[b.kind] ?? 9) || a.ref.localeCompare(b.ref, undefined, { numeric: true }));
  } catch (err) {
    console.error('Course outcomes', err.message);
    return [];
  }
}
/** An outcome for the whole class, given once: a course outcome, or one tied to no chapter. */
const courseWide = (o) => o.kind === 'course' || !o.chapters.length;
/** The outcomes tied to one chapter. */
const outcomesFor = (list, label) => list.filter((o) => !courseWide(o) && o.chapters.some((ch) => sameChapter(ch, label))).map(({ kind, ref, text }) => ({ kind, ref, text }));

/** A course's study PDFs by chapter, and its chapter titles. Missing files are looked for in the textbook folder. */
function readingsFor(db, courseId, code, textbooks) {
  const pdfs = new Map();
  for (const r of rows(db, 'SELECT chapters_json, file_path, page_count, week_start FROM study_pdfs WHERE course_id = ? AND file_path IS NOT NULL', [courseId])) {
    let file = r.file_path;
    if (!fs.existsSync(file)) {
      const moved = path.join(textbooks, code, path.basename(file.replace(/\\/g, '/')));
      file = fs.existsSync(moved) ? moved : null;
    }
    if (!file) continue;
    for (const ch of json(r.chapters_json, [])) pdfs.set(ch, { file, pages: r.page_count, title: path.basename(file, '.pdf') });
  }
  const topics = rows(db, 'SELECT * FROM chapter_topics WHERE course_id = ?', [courseId]);
  const titles = new Map(topics.map((t) => [t.chapter_label, t.title]));
  const summaries = new Map(topics.filter((t) => t.summary).map((t) => [t.chapter_label, t.summary]));
  // Each chapter's own words, for finding the chapter a lab or assignment is about: its title and section headings
  // (strong), and its vocabulary and objectives (weaker).
  const words = new Map(
    topics.map((t) => [
      t.chapter_label,
      {
        strong: new Set(topicWords(`${t.title || ''} ${json(t.sections_json, []).join(' ')}`)),
        weak: new Set(topicWords(`${t.vocabulary || ''} ${t.added_vocabulary || ''} ${json(t.objectives_json, []).join(' ')}`))
      }
    ])
  );
  // What "Lab 8" and "Exam 4" are, so "Lab 8 Handout" is about Lab 8's topic and "Exam 4 work" covers Exam 4's chapters.
  const siblings = new Map();
  for (const r of rows(db, `SELECT title, item_type, covered_chapters_json FROM academic_items WHERE course_id = ? AND ${ACTIVE}`, [courseId])) {
    const key = siblingKey(r.title);
    if (!key) continue;
    const chapters = [...new Set([...coveredOf({ title: r.title, covered_chapters_json: r.covered_chapters_json }), ...chaptersIn(r.title)])];
    const topic = (r.title || '').replace(/\b(lab|exam|test|quiz)\s*#?\s*\d+\b|\bfinal exam\b/i, '').trim();
    const have = siblings.get(key);
    // (The one that says the most: chapters first, then the longest topic.)
    if (!have || (chapters.length && !have.chapters.length) || (!have.chapters.length && topic.length > have.topic.length)) siblings.set(key, { chapters, topic });
  }
  return { pdfs, titles, summaries, words, siblings };
}

/** Classes the student withdrew from (withdrawn.cjs), read beside the class database: Map courseId → { at, by }. */
const withdrawnOf = (file) => {
  try {
    return require('./withdrawn.cjs').active(path.join(path.dirname(file), '..', '..'));
  } catch {
    return new Map();
  }
};
const dayOf = (iso) => String(iso || '').slice(0, 10);

/** The kinds of item counted as due (src/components/scholar/itemRules.ts COUNTS_AS_DUE: keep the two alike). */
const DUE_KINDS = ['exam', 'final_exam', 'lab_practical', 'quiz', 'assignment', 'discussion', 'project', 'presentation', 'paper', 'draft', 'peer_review', 'pre_lab_quiz', 'lab_handout'];
/** Classes in the profile, with what's coming up. */
async function courses(file, textbooks, done) {
  const db = await open(file);
  if (!db) return [];
  const today = localDay();
  const week = localDay(new Date(Date.now() + 7 * 864e5));
  const ev = evidence(db, file);
  const gone = withdrawnOf(file);
  return rows(db, "SELECT * FROM courses WHERE status = 'active' AND course_code != 'MESSAGES' ORDER BY course_code").map((c) => {
    // Work that's due, the same kinds the window counts (itemRules.ts COUNTS_AS_DUE): never a class meeting (a lab
    // session, a recitation), a reminder, a reading, or work that doesn't open on the class site yet.
    const due = rows(
      db,
      `SELECT id, course_id, title, item_type, date, due_time FROM academic_items WHERE course_id = ? AND ${ACTIVE} AND item_type IN (${DUE_KINDS.map(() => '?').join(', ')}) AND date >= ? ORDER BY date, due_time LIMIT 40`,
      [c.id, ...DUE_KINDS, today]
    ).filter((i) => !opensAt(i, ev));
    // (A class the student withdrew from has nothing coming and nothing due.)
    const w = gone.get(c.id) || null;
    const open = w ? [] : due.filter((i) => !done[i.id]);
    const { pdfs } = readingsFor(db, c.id, c.course_code, textbooks);
    return {
      id: c.id,
      code: c.course_code,
      name: c.name,
      term: c.term,
      instructor: c.instructor,
      url: c.d2l_url,
      synthetic: !!c.is_synthetic,
      start: c.start_date,
      end: c.end_date,
      next: open[0] ? { id: open[0].id, title: open[0].title, type: open[0].item_type, date: open[0].date, due: hhmm(open[0].due_time) } : null,
      dueThisWeek: open.filter((i) => i.date <= week).length,
      chapters: pdfs.size,
      withdrawn: w ? { at: w.at, by: w.by } : null
    };
  });
}

/**
 * Every chapter with a textbook in the classes still running: [{ courseId, label }]. Chapters on the soonest coming
 * tests come first (those are the ones to practise now), then the rest in class and chapter order.
 */
async function textbookChapters(file, textbooks) {
  const db = await open(file);
  if (!db) return [];
  const today = localDay();
  const out = [];
  const soon = new Map(); // "courseId|label" → date of the first coming test on it
  const gone = withdrawnOf(file);
  for (const c of rows(db, "SELECT * FROM courses WHERE status = 'active' AND course_code != 'MESSAGES' ORDER BY course_code")) {
    if (c.end_date && String(c.end_date).slice(0, 10) < today) continue;
    // (Nothing to practise for a class the student withdrew from.)
    if (gone.has(c.id)) continue;
    const { pdfs } = readingsFor(db, c.id, c.course_code, textbooks);
    for (const label of [...pdfs.keys()].sort((a, b) => chapterNumber(a) - chapterNumber(b))) out.push({ courseId: c.id, label });
    for (const t of rows(db, `SELECT title, date, covered_chapters_json, study_focus_json FROM academic_items WHERE course_id = ? AND item_type IN ('exam', 'final_exam', 'midterm', 'lab_practical', 'quiz') AND ${ACTIVE} AND date >= ? ORDER BY date`, [c.id, today]))
      for (const label of coveredOf(t)) if (!soon.has(`${c.id}|${label}`)) soon.set(`${c.id}|${label}`, t.date);
  }
  const when = (x) => soon.get(`${x.courseId}|${x.label}`) || '9999';
  return out
    .map((x, i) => ({ x, i }))
    .sort((a, b) => when(a.x).localeCompare(when(b.x)) || a.i - b.i)
    .map(({ x }) => ({ ...x, test: soon.get(`${x.courseId}|${x.label}`) || null }));
}

/**
 * The next test on each chapter: { "courseId|Chapter N": { date, title } } for tests from today on that list the
 * chapters they cover. Spaced review uses it to bring each card back before the test it's on.
 */
async function nextTests(file) {
  const db = await open(file);
  if (!db) return {};
  const today = localDay();
  const out = {};
  const gone = withdrawnOf(file);
  for (const t of rows(db, `SELECT course_id, title, date, covered_chapters_json, study_focus_json FROM academic_items WHERE item_type IN ('exam', 'final_exam', 'midterm', 'lab_practical', 'quiz') AND ${ACTIVE} AND date >= ? ORDER BY date`, [today]))
    for (const label of gone.has(t.course_id) ? [] : coveredOf(t)) {
      const key = `${t.course_id}|${label}`;
      if (!out[key]) out[key] = { date: String(t.date).slice(0, 10), title: t.title };
    }
  return out;
}

/** Which class and chapters a textbook PDF is (matched by its file name): { courseId, code, chapters } or null. */
async function textbookOf(file, textbooks, pdf) {
  const db = await open(file);
  if (!db) return null;
  const name = path.basename(String(pdf)).toLowerCase();
  for (const c of rows(db, "SELECT * FROM courses WHERE status = 'active' AND course_code != 'MESSAGES'")) {
    const { pdfs } = readingsFor(db, c.id, c.course_code, textbooks);
    const chapters = [...pdfs].filter(([, p]) => path.basename(p.file).toLowerCase() === name).map(([label]) => label);
    if (chapters.length) return { courseId: c.id, code: c.course_code, chapters: chapters.sort((a, b) => chapterNumber(a) - chapterNumber(b)) };
  }
  return null;
}

// ---------- What's been handed in ----------
const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|a|an)\b/g, ' ')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/\b(practical|exam|lab|part|unit|quiz|module|chapter|test|project|essay) (i|ii|iii|iv|v|vi|vii|viii|ix|x)\b/g, (_, w, r) => `${w} ${['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x'].indexOf(r) + 1}`)
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Evidence per class of what the student handed in: grades the daily checks recorded, and what Kea's pre-check
 * learned from D2L (graded items, assignment folders with or without a submission). Map course id → [{t, state}].
 */
function evidence(db, file) {
  const out = new Map();
  const add = (courseId, title, state, opens = null, x = null) => {
    const t = norm(title);
    // A bare group name ("Module 1", "Chapter 5", "Week 3", "Unit 2") is a gradebook category's total (or reads like
    // one): it says nothing about any one assignment in it.
    if (!t || (state === 'graded' && /^(module|chapter|ch|unit|week|part|section|lab|labs|homework|quizzes|exams|discussions?|assignments?)( \d+)?$/.test(t))) return;
    if (!out.has(courseId)) out.set(courseId, []);
    // Which class-site object it is (an assignment folder, quiz or discussion topic), and its due date when known:
    // the only evidence that can cross off work that isn't due yet (see handIn).
    const key = x?.folder != null ? `dropbox:${x.folder}` : typeof x?.ref === 'string' ? x.ref : null;
    out.get(courseId).push({ t, state, ...(opens ? { opens } : {}), ...(key ? { key } : {}), ...(x?.due ? { due: x.due } : {}) });
  };
  for (const r of rows(db, "SELECT course_id, payload_json FROM digest_entries WHERE kind = 'grade'")) {
    const p = json(r.payload_json, {});
    if (!p.category) add(r.course_id, p.title, 'graded');
  }
  // Grades read from outside platforms (ALEKS and the like) during weekly checks.
  for (const r of rows(db, 'SELECT course_id, title, is_missing FROM grade_snapshots')) add(r.course_id, r.title, r.is_missing ? 'not_submitted' : 'graded');
  try {
    const sub = JSON.parse(fs.readFileSync(path.join(path.dirname(file), '..', '..', 'submissions.json'), 'utf8'));
    const ids = new Map(rows(db, 'SELECT id, course_code FROM courses').map((c) => [c.course_code, c.id]));
    for (const [code, list] of Object.entries(sub.byCourse || {})) for (const x of list) if (ids.has(code)) add(ids.get(code), x.title, x.state, null, x);
    // Work not open yet on the class site, with the date it opens.
    for (const [code, list] of Object.entries(sub.opens || {})) for (const x of list) if (ids.has(code)) add(ids.get(code), x.title, 'opens', x.opens);
  } catch {}
  return out;
}

/**
 * Whether two titles name the same piece of work, not just similar ones: the shorter title's words all appear in the
 * longer one, in order ("inner fish ch 4" in "your inner fish assignment ch 4", "quiz 4" in "online quiz 4 chapters
 * 29 31"), and each number keeps the word before it ("discussion 1" never matches "discussion 2", nor "module 1"
 * "module 10"). A one-word title ("midterm") only matches a title of at most two words ("cumulative midterm").
 */
function sameWork(a, b) {
  if (a === b) return true;
  const wa = a.split(' ');
  const wb = b.split(' ');
  const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  if (short.length === 1 && (long.length > 2 || short[0].length < 5)) return false;
  // Long titles worded a little differently ("ionic rxns" / "ionic reactions"): the same numbers, and nearly every
  // word of the shorter in the longer.
  const nums = (w) => w.filter((x) => /^\d+$/.test(x)).join(' ');
  if (short.length >= 5 && nums(short) === nums(long) && nums(short) && short.filter((w) => long.includes(w)).length >= 0.8 * short.length) return true;
  let at = -1;
  for (let k = 0; k < short.length; k++) {
    const w = short[k];
    let i = long.indexOf(w, at + 1);
    // A number must follow the same word in both ("ch 4" ↔ "ch 4").
    if (/^\d/.test(w) && k > 0) while (i >= 0 && long[i - 1] !== short[k - 1]) i = long.indexOf(w, i + 1);
    if (i < 0) return false;
    at = i;
  }
  return true;
}

/** Kinds of item that are never handed in or graded (a lab is: its report is graded under its name). */
const NEVER_GRADED = new Set(['reading', 'weekly_reading', 'lecture', 'recitation', 'seminar', 'office_hours', 'break', 'no_class', 'administrative_deadline']);

/** The class-site objects an item's own links point at: dropbox:<id>, quiz:<id>, topic:<id> (D2L and Canvas). */
function itemKeys(r) {
  const out = new Set();
  for (const u of [r.submission_url, r.reference_url]) {
    const s = String(u || '');
    let m;
    if ((m = /[?&]db=(\d+)/.exec(s)) || (m = /\/dropbox\/folders\/(\d+)/.exec(s)) || (m = /\/assignments\/(\d+)/.exec(s))) out.add(`dropbox:${m[1]}`);
    if ((m = /[?&]qi=(\d+)/.exec(s)) || (m = /\/quizzes\/(\d+)/.exec(s))) out.add(`quiz:${m[1]}`);
    if ((m = /\/discussions\/topics\/(\d+)/.exec(s)) || (m = /\/discussion_topics\/(\d+)/.exec(s))) out.add(`topic:${m[1]}`);
  }
  return out;
}

/**
 * Evidence about work that isn't due yet: only what names the same class-site object (its folder, quiz or topic id,
 * from the item's own link) or has the same due date. A title alone isn't enough: a weekly title with no number
 * ("Weekly Reflection") would be crossed off by last week's grade. A discussion's initial and response posts are told
 * apart, and one item for the whole discussion needs both.
 */
function aheadEvidence(r, t, list) {
  const keys = itemKeys(r);
  const reply = /\b(repl(y|ies)|respon(se|ses|ding)|peer review)\b/.test(t);
  const initial = /\binitial\b/.test(t);
  const out = [];
  for (const k of keys) {
    if (k.startsWith('topic:')) {
      const want = reply ? [`${k}:reply`] : initial ? [k] : [k, `${k}:reply`];
      const got = want.map((w) => list.find((x) => x.key === w));
      if (got.every(Boolean)) {
        // The whole discussion counts only as far as its least-done part.
        const rank = { graded: 3, submitted: 2, not_submitted: 1, opens: 0 };
        out.push(got.reduce((a, b) => ((rank[b.state] ?? 0) < (rank[a.state] ?? 0) ? b : a)));
      }
    } else out.push(...list.filter((x) => x.key === k));
  }
  // The same work by name and due on the same day.
  for (const x of list) if (x.due && localDay(new Date(x.due)) === r.date && (x.t === t || sameWork(x.t, t))) out.push(x);
  return out;
}

/**
 * An item's hand-in state from the evidence: 'graded', 'submitted', 'not_submitted' or null (unknown). Work due more
 * than two days ahead is only matched by its class-site id or due date (aheadEvidence): a title match there could
 * cross off work not done yet, and leaving it showing is the safe side.
 */
function handIn(r, ev) {
  if (NEVER_GRADED.has(r.item_type)) return null;
  const list = ev.get(r.course_id);
  if (!list) return null;
  const t = norm(r.title);
  if (t.length < 3) return null;
  const ahead = r.date && Date.parse(`${r.date}T23:59`) > Date.now() + 2 * 864e5;
  const exact = ahead ? [] : list.filter((x) => x.t === t);
  let close = ahead ? aheadEvidence(r, t, list) : exact.length ? exact : list.filter((x) => sameWork(x.t, t));
  // What the gradebook calls it may lack the item's own qualifiers: a lab handout is graded as the lab ("Lab 4
  // Handout" → "Lab 4 Prokaryotes"). A discussion's initial and response posts are never matched to the discussion's
  // grade: it can come in after the initial post alone, and would then say the response posts were done.
  if (!close.length && !ahead) {
    const bare = t.replace(/ handout$/, '').trim();
    if (bare !== t && bare.split(' ').length >= 2) close = list.filter((x) => x.state === 'graded' && sameWork(x.t, bare));
  }
  if (!close.length) return null;
  const done = close.filter((x) => x.state !== 'opens');
  if (!done.length) return null;
  return done.find((x) => x.state === 'graded')?.state || done.find((x) => x.state === 'submitted')?.state || 'not_submitted';
}

/** When the item opens on the class site, if that's still ahead (an ISO time), else null. */
function opensAt(r, ev) {
  const list = ev?.get(r.course_id);
  if (!list || NEVER_GRADED.has(r.item_type)) return null;
  const t = norm(r.title);
  const hit = list.filter((x) => x.state === 'opens').find((x) => x.t === t || sameWork(x.t, t));
  return hit && Date.parse(hit.opens) > Date.now() ? hit.opens : null;
}

// ---------- Outside platforms (Science Interactive, ALEKS…) ----------
let platCache = { file: '', mtime: 0, data: {} };
/** The saved platform links of every class ({ CODE: [{ name, host, url, match, flags }] }), read when they change. */
function platformsSaved(file) {
  const f = path.join(path.dirname(file), '..', '..', 'platform-links.json');
  try {
    const st = fs.statSync(f);
    if (platCache.file !== f || platCache.mtime !== st.mtimeMs) platCache = { file: f, mtime: st.mtimeMs, data: JSON.parse(fs.readFileSync(f, 'utf8')).byCourse || {} };
  } catch {
    platCache = { file: f, mtime: 0, data: {} };
  }
  return platCache.data;
}
let platFile = '';
/**
 * The outside platforms an item is done on, as links ({ label: "Open Science Interactive", url, kind: 'platform' }): any
 * of its class's platforms its title, description, wording, links or place names.
 */
function platformLinksFor(r, course) {
  if (!platFile || !course?.course_code || r.item_type === 'weekly_reading') return [];
  const list = platformsSaved(platFile)[course.course_code] || [];
  if (!list.length) return [];
  const own = [r.submission_url, r.reference_url, r.resource_url].filter(Boolean);
  const text = [r.title, r.description, r.source_wording, r.platform_location, r.submission_url_label, r.reference_url_label, r.resource_url_label].filter(Boolean).join(' ');
  const out = [];
  for (const pl of list) {
    let re;
    try {
      re = new RegExp(pl.match, pl.flags || '');
    } catch {
      continue;
    }
    if (re.test(text) && !own.includes(pl.url)) out.push({ label: `Open ${pl.name}`, url: pl.url, kind: 'platform' });
  }
  return out;
}

// ---------- Each assignment's own D2L page (its folder, quiz or discussion topic) ----------
let placeCache = { file: '', mtime: 0, data: {} };
function placesSaved() {
  const f = path.join(path.dirname(platFile), '..', '..', 'd2l-places.json');
  try {
    const st = fs.statSync(f);
    if (placeCache.file !== f || placeCache.mtime !== st.mtimeMs) placeCache = { file: f, mtime: st.mtimeMs, data: JSON.parse(fs.readFileSync(f, 'utf8')).byCourse || {} };
  } catch {
    placeCache = { file: f, mtime: 0, data: {} };
  }
  return placeCache.data;
}
/** A class site's list page (every folder, every quiz, every discussion), not one piece of work's own page. */
const LIST_PAGE = /folders_list|\/dropbox\/dropbox\.d2l|discussions\/List|quizzing\.d2l\?ou|quizzing\/user\/quizzes_list|\/courses\/\d+\/(assignments|quizzes|discussion_topics|announcements|modules|grades)\/?([?#]|$)/i;
/** The numbered names in a title ("online quiz 5: chapters 32 33" → ["quiz 5", "chapters 32"]), its identity in D2L. */
function numbered(title) {
  return [...norm(title).matchAll(/([a-z]+) (\d+)\b/g)].map((m) => `${m[1]} ${m[2]}`);
}
/**
 * The item's own D2L page when it doesn't link one: the place (folder, quiz or discussion topic) whose name is the
 * same work. Names differ between a class schedule and D2L ("Lab 8 Handout" / "Lab 8 Fungi", "Online Quiz 5: Chapters
 * 32-33" / "Online Quiz 5"), so the match is by title first, then by the numbered name they share ("lab 8", "quiz 5",
 * "module 2 discussion 1"), only when exactly one place has it, in the area the item's kind belongs to.
 */
function placeLinksFor(r, course) {
  if (!platFile || !course?.course_code || NEVER_GRADED.has(r.item_type) || r.item_type === 'lab') return [];
  const places = placesSaved()[course.course_code] || [];
  if (!places.length) return [];
  const own = [r.submission_url, r.reference_url, r.resource_url].filter((u) => u && !LIST_PAGE.test(u));
  const area = r.item_type === 'discussion' || /\bdiscussion\b/i.test(r.title) ? 'discussion' : ['quiz', 'exam', 'final_exam', 'midterm'].includes(r.item_type) ? 'quiz' : 'dropbox';
  const t = norm(r.title.replace(POST_HALF, ''));
  const mine = numbered(r.title);
  const pick = (list) => {
    // (A discussion topic's name starts with its forum's, "Module 3 Discussions: …"; a folder's colon is part of its name.)
    const own = (p) => (p.area === 'discussion' ? p.name.replace(/^[^:]*:\s*/, '') : p.name);
    const exact = list.filter((p) => sameWork(norm(own(p)), t) || sameWork(norm(p.name), t));
    if (exact.length === 1) return exact[0];
    // The same name once notes are set aside: "Final Exam(1-9) - Requires Respondus…" is "Final Exam (Chapters 1-9)".
    const bare = (x) => norm(x.replace(/\([^)]*\)/g, ' ').replace(/\s+-\s+requires.*$/i, ''));
    const same = list.filter((p) => bare(p.name) && bare(p.name) === bare(r.title));
    if (same.length === 1) return same[0];
    if (!mine.length) return null;
    // The place's numbered names all in the item's, starting the same ("lab 8" in "lab 8 handout"), and no kind of work
    // in the place's name that the item's doesn't have ("Chapter 1 Exam Show Work" isn't "Review: Chapter 1").
    const words = new Set(t.split(' '));
    const KINDS = ['exam', 'quiz', 'show', 'work', 'review', 'practice', 'discussion', 'assignment', 'essay', 'report', 'final', 'midterm', 'peer', 'reflection'];
    const by = list.filter((p) => {
      const name = own(p);
      const theirs = numbered(name);
      return theirs.length && theirs[0] === mine[0] && theirs.every((x) => mine.includes(x)) && !norm(name).split(' ').some((w) => KINDS.includes(w) && !words.has(w));
    });
    return by.length === 1 ? by[0] : null;
  };
  // (Only in the item's own area: an ALEKS exam is never its "Exam Show Work" folder, a discussion never the essay's.)
  const hit = pick(places.filter((p) => p.area === area));
  if (!hit || own.some((u) => u.includes(String(hit.id)))) return [];
  const label = hit.area === 'quiz' ? 'Take the quiz' : hit.area === 'discussion' ? 'Post in the discussion' : 'Hand-in folder';
  return [{ label, url: hit.url, kind: 'submit' }];
}

/** Class meetings, where a room is worth showing. */
const MEETING = new Set(['lecture', 'lab', 'recitation', 'seminar', 'exam', 'final_exam', 'lab_practical']);

/**
 * Where each class usually meets, by kind of meeting: the room most of its lectures (or labs) name. A meeting with no
 * room of its own shows this one, marked as the usual room, never as if the class had said so.
 */
function usualRooms(db) {
  const out = new Map();
  for (const r of rows(db, `SELECT course_id, item_type, platform_location AS loc, COUNT(*) AS n FROM academic_items WHERE ${ACTIVE} AND platform_location IS NOT NULL AND platform_location NOT IN ('', 'Online') GROUP BY course_id, item_type, platform_location ORDER BY n DESC`)) {
    const key = `${r.course_id}|${r.item_type}`;
    if (!out.has(key)) out.set(key, r.loc);
  }
  return out;
}

/**
 * An item as the calendar shows it, with the places to do it in front: its own D2L page (folder, quiz, discussion
 * topic) before anything else, and D2L's list pages dropped once there's something better (its own page, or the outside
 * platform it's done on).
 */
function itemOut(r, course, banner, readings, done, rooms, ev) {
  const o = itemOutRaw(r, course, banner, readings, done, rooms, ev);
  const better = o.placeLinks.length || o.platformLinks.length || o.links.some((l) => l.kind === 'submit' && !LIST_PAGE.test(l.url));
  o.links = [...o.placeLinks, ...o.links.filter((l) => !(better && LIST_PAGE.test(l.url)))];
  delete o.placeLinks;
  return o;
}

function itemOutRaw(r, course, banner, readings, done, rooms, ev) {
  const covered = json(r.covered_chapters_json, []);
  // (Ranges and lists too: "Exam 1 (Chapters 1-2)", "Online Quiz 3: Chapters 25, 19, 27 & 28".)
  let chapters = [...new Set([...covered, ...coveredOf({ title: r.title }), ...chaptersIn(`${r.title} ${r.module_label || ''}`)])];
  const skip = ['administrative_deadline', 'break', 'no_class'].includes(r.item_type);
  // A lab (or anything else) named for its topic ("Lab 5: Protists") is that topic's chapter; labs often trail the
  // lectures, so for a lab this comes before the week's reading.
  const byTopic = () => (skip ? [] : topicChapters(`${r.title} ${r.module_label || ''}`, readings.words));
  // "Lab 8 Handout", "Upload written work for Exam 4": the chapters (or topic) of the lab or exam it belongs to.
  const of = siblingKey(r.title) && readings.siblings?.get(siblingKey(r.title));
  if (!chapters.length && of && !skip) chapters = of.chapters.length ? of.chapters : topicChapters(of.topic, readings.words);
  if (!chapters.length && /lab/.test(r.item_type)) chapters = byTopic();
  // Otherwise an item with no chapter of its own reads that week's chapters, then its topic. (Marked as a guess: the
  // panel says "This week's reading" and never offers to study it as if the item said so.)
  let inferred = false;
  if (!chapters.length && banner && !skip) (chapters = chaptersIn(banner.title)), (inferred = chapters.length > 0);
  if (!chapters.length) chapters = byTopic();
  // A class with no chapter list (no textbook in Kea yet): a chapter its title names has nothing to read or study.
  const unlisted = !readings.titles.size && !readings.pdfs.size;
  return {
    id: r.id,
    courseId: r.course_id,
    courseCode: course?.course_code || '',
    // (A "lab" with points and no meeting time is graded work read as a lab meeting: it needs its checkbox.)
    type: r.item_type === 'lab' && Number(r.points) > 0 && !r.start_time ? 'assignment' : r.item_type,
    title: r.title,
    date: r.date,
    dateEnd: r.date_range_end,
    start: hhmm(r.start_time),
    end: hhmm(r.end_time),
    due: hhmm(r.due_time),
    module: r.module_label,
    ...(() => {
      const own = r.platform_location && r.platform_location !== 'Online' ? r.platform_location : null;
      const usual = !own && MEETING.has(r.item_type) ? rooms?.get(`${r.course_id}|${r.item_type}`) || null : null;
      return { location: own || usual || (r.platform_location === 'Online' ? 'Online' : null), locationUsual: !!usual };
    })(),
    instructor: course?.instructor || null,
    contact: course?.instructor_contact || null,
    description: r.description,
    sourceWording: r.source_wording,
    links: [
      // (A discussion is posted in its topic: a quiz's link matched to it by mistake is never its button.)
      r.submission_url && !(r.item_type === 'discussion' && /quizzing|\/quizzes\//i.test(r.submission_url)) && { label: r.submission_url_label || 'Submit', url: r.submission_url, kind: 'submit' },
      r.reference_url && { label: r.reference_url_label || 'Instructions', url: r.reference_url, kind: 'reference' },
      r.resource_url && { label: r.resource_url_label || 'Resource', url: r.resource_url, kind: 'resource' },
      r.video_url && { label: r.video_url_label || 'Video', url: r.video_url, kind: 'video' }
    ].filter(Boolean),
    weeklyLinks: json(r.weekly_links_json, []),
    platformLinks: platformLinksFor(r, course),
    placeLinks: placeLinksFor(r, course),
    covered,
    studyFocus: json(r.study_focus_json, []),
    points: r.points,
    optional: !!r.is_optional,
    tentative: !!r.is_tentative || !!r.is_inferred_date,
    done: done[r.id] || null,
    handIn: ev ? handIn(r, ev) : null,
    opensAt: ev ? opensAt(r, ev) : null,
    // Only the class's own chapters ("Inner Fish CH 6" is a side book, not the course's Chapter 6).
    readings: chapters
      .filter((ch) => !readings.titles.size || readings.titles.has(ch) || readings.pdfs.has(ch))
      .sort((a, b) => chapterNumber(a) - chapterNumber(b))
      .map((ch) => ({ chapter: ch, title: readings.titles.get(ch) || null, summary: readings.summaries?.get(ch) || null, pdf: readings.pdfs.get(ch) || null, ...(inferred ? { inferred: true } : {}), ...(unlisted ? { unlisted: true } : {}) }))
  };
}

/** Everything on the calendar between two dates (inclusive), for one class or all of them. */
async function items(file, textbooks, done, { from, to, courseId }) {
  const db = await open(file);
  if (!db) return [];
  const courseRows = rows(db, "SELECT * FROM courses WHERE course_code != 'MESSAGES'");
  const byId = new Map(courseRows.map((c) => [c.id, c]));
  const list = rows(
    db,
    `SELECT * FROM academic_items WHERE ${ACTIVE} AND date IS NOT NULL AND date <= ? AND COALESCE(date_range_end, date) >= ?${courseId ? ' AND course_id = ?' : ''} ORDER BY date, COALESCE(start_time, due_time)`,
    courseId ? [to, from, courseId] : [to, from]
  ).filter((r) => byId.has(r.course_id));
  const readings = new Map();
  const reads = (c) => readings.get(c.id) || readings.set(c.id, readingsFor(db, c.id, c.course_code, textbooks)).get(c.id);
  const banners = list.filter((r) => r.item_type === 'weekly_reading');
  const rooms = usualRooms(db);
  const ev = evidence(db, file);
  platFile = file;
  const out = list.map((r) => {
    const c = byId.get(r.course_id);
    const banner = banners.find((b) => b.course_id === r.course_id && b.date <= r.date && (b.date_range_end || b.date) >= r.date);
    return itemOut(r, c, banner, reads(c), done, rooms, ev);
  });
  inheritPlatforms(out);
  // A class the student withdrew from: nothing from the day they withdrew on (no upcoming work, guides or reminders),
  // and its past work stays readable, marked, never Missing.
  const gone = withdrawnOf(file);
  if (gone.size) {
    for (let k = out.length - 1; k >= 0; k--) {
      const w = gone.get(out[k].courseId);
      if (!w) continue;
      if (out[k].date >= dayOf(w.at)) out.splice(k, 1);
      else out[k].withdrawn = true;
    }
  }
  relateItems(out);
  // On the student's own due date (an extension the pre-check read from their class-site lists, extensions.json).
  try {
    const ext = JSON.parse(fs.readFileSync(path.join(path.dirname(file), '..', '..', 'extensions.json'), 'utf8')) || {};
    for (const i of out) {
      const x = ext[i.id];
      if (x && x.to === i.date) i.extended = { from: x.from || null, later: x.later ?? null };
    }
  } catch {}
  return out;
}

/** Words that name a kind of work or a post, never what it's about. */
const NOT_TOPIC = new Set(['online', 'assignment', 'assignments', 'report', 'reports', 'initial', 'response', 'responses', 'replies', 'reply', 'notebook', 'handout', 'discussion', 'module', 'chapter', 'using', 'with', 'from', 'about', 'their', 'final', 'review', 'quiz', 'exam', 'post', 'posts', 'includes', 'science', 'interactive', 'digital', 'observations', 'principle', 'identification']);
const topicSet = (title) => new Set(String(title || '').replace(/\([^)]*\)/g, ' ').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 5 && !NOT_TOPIC.has(w)).map((w) => w.replace(/s$/, '')));
/** The half of a discussion a title names, in brackets or after a dash or colon: "(Initial Post)", "- Replies". */
const POST_HALF = /\s*(?:\((?:initial|response|replies|reply)[^)]*\)|[-–—:]\s*(?:initial\s+posts?|response\s+posts?|responses|replies|reply)\b[^]*)$/i;
/** A discussion's name without the half it is ("Discussion 6 - Initial Post" → "discussion 6"). */
const postBase = (t) => String(t || '').replace(POST_HALF, '').trim().toLowerCase();
/**
 * The lab an item is part of, by its number: "Lab 7: Enzyme Activity", "Lab 7 Handout", "Pre-lab Quiz 7", "Lab report
 * #9", "Lab 9 Discussion: Buffer capacity". Never a lab practical (it covers many labs) or "lab coat".
 */
function labNumber(title) {
  const t = String(title || '').toLowerCase();
  if (/\blab(oratory)?\s+(practical|final|exam)\b/.test(t)) return null;
  const m = /\b(?:pre-?\s*)?lab(?:oratory)?\b(?:\s+(?:report|quiz|handout|notebook|discussion|exercise|activity|assignment|worksheet|write-?up|session|results?|data))*\s*#?\s*(\d{1,2})\b/.exec(t);
  return m ? Number(m[1]) : null;
}
/** Where a part of a lab comes in the lab's order: pre-lab, handout (and what to bring), the session, report, discussion. */
function labRole(i) {
  if (i.type === 'pre_lab_quiz' || /\bpre-?\s*lab\b/i.test(i.title)) return 0;
  if (/\breport|notebook|write-?up\b/i.test(i.title)) return 3;
  if (i.type === 'discussion' || i.type === 'peer_review') return 4;
  if (i.type === 'lab_handout' || /\bhandout|manual|procedure\b/i.test(i.title)) return 1;
  if (i.type === 'other_deadline') return 1.5;
  if (i.type === 'lab') return 2;
  return 2.5;
}
/**
 * The work each item goes with, so its panel can point there (and a guide step can open it):
 *   - the parts of the same lab, by its number ("Lab 7" session, handout, pre-lab quiz, report, results discussion),
 *     with what to bring on the session's day ("Bring lab coat and goggles"), in the lab's order;
 *   - work built on a lab without its number ("Online Assignment 9: Buffers" on "Lab report #9: Using Buffers"): a topic
 *     word in both titles (not just "assignment" or a number), within ten days;
 *   - the other half of a discussion (its initial post and its replies), however the title names them.
 * Same class, within two weeks for a lab's parts.
 */
function relateItems(items) {
  const POSTS = new Set(['discussion', 'peer_review']);
  const NEVER = new Set(['weekly_reading', 'break', 'no_class', 'administrative_deadline', 'lecture', 'recitation', 'seminar', 'class_session', 'work_shift']);
  const day = (d) => Date.parse(`${d}T12:00`) / 864e5;
  const near = (a, b, n) => Math.abs(day(a.date) - day(b.date)) <= n;
  const entry = (b, why, group) => ({ id: b.id, title: b.title, type: b.type, date: b.date, why, done: !!b.done, ...(group ? { group } : {}) });
  const cand = items.filter((i) => !NEVER.has(i.type) && !i.hub);
  const num = new Map(cand.map((i) => [i, labNumber(i.title)]));
  // What to bring on a lab's day belongs to that lab.
  for (const i of cand) {
    if (num.get(i) != null || i.type !== 'other_deadline') continue;
    const session = cand.find((s) => s.type === 'lab' && s.courseId === i.courseId && s.date === i.date && num.get(s) != null);
    if (session && /\b(bring|goggles|coat|lab|safety|apron|gloves)\b/i.test(i.title)) num.set(i, num.get(session));
  }
  const isLabWork = (i) => num.get(i) != null || i.type === 'lab' || i.type === 'lab_handout' || i.type === 'pre_lab_quiz';
  for (const a of cand) {
    const rel = new Map();
    const n = num.get(a);
    const words = topicSet(a.title);
    for (const b of cand) {
      if (b === a || b.courseId !== a.courseId) continue;
      if (n != null && num.get(b) === n && near(a, b, 14)) rel.set(b.id, { e: entry(b, 'lab', `Lab ${n}`), order: labRole(b) });
      else if (POSTS.has(a.type) && POSTS.has(b.type) && near(a, b, 10) && postBase(b.title) === postBase(a.title) && (POST_HALF.test(a.title) || POST_HALF.test(b.title)))
        rel.set(b.id, { e: entry(b, 'post'), order: 10 });
      // (A topic word shared with a lab's work, when one of the two has no lab number: "Online Assignment 9: Buffers".)
      else if ((n == null || num.get(b) == null) && (isLabWork(a) || isLabWork(b)) && !(isLabWork(a) && isLabWork(b) && n != null && num.get(b) != null) && near(a, b, 10) && [...topicSet(b.title)].some((w) => words.has(w)))
        rel.set(b.id, { e: entry(b, n == null && isLabWork(b) ? 'lab' : 'topic', num.get(b) != null ? `Lab ${num.get(b)}` : undefined), order: num.get(b) != null ? labRole(b) : 5 });
    }
    if (!rel.size) continue;
    a.related = [...rel.values()].sort((x, y) => x.order - y.order || x.e.date.localeCompare(y.e.date)).slice(0, 8).map((x) => x.e);
    if (n != null) a.labGroup = `Lab ${n}`;
  }
}
/**
 * An item that doesn't name its platform ("HW: Final Review Ch1-Ch3") but whose siblings all do ("HW: 4.5", "HW: 4.6",
 * every one done in ALEKS) is done there too: same class, same name before the colon, at least three siblings, all on
 * the same platform.
 */
function inheritPlatforms(items) {
  // (Numbers left out: "Lab report #10" is a sibling of "Lab report #7".)
  const prefix = (i) => ((/^([^:]{2,24}):/.exec(i.title) || [])[1] || '').replace(/[#\d]+/g, '').trim().toLowerCase();
  const groups = new Map();
  for (const i of items) {
    const p = prefix(i);
    if (!p || i.type === 'weekly_reading') continue;
    const k = `${i.courseId}|${p}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(i);
  }
  for (const list of groups.values()) {
    const linked = list.filter((i) => i.platformLinks.length);
    const urls = new Set(linked.map((i) => i.platformLinks[0].url));
    if (linked.length < 3 || urls.size !== 1 || linked.length < list.length * 0.6) continue;
    for (const i of list) if (!i.platformLinks.length) i.platformLinks = [linked[0].platformLinks[0]];
  }
}

/** One class: its chapters (titles, sections, objectives, study PDF) and its weeks. */
async function course(file, textbooks, done, id) {
  const db = await open(file);
  if (!db) return null;
  platFile = file;
  const c = rows(db, 'SELECT * FROM courses WHERE id = ?', [id])[0];
  if (!c) return null;
  const readings = readingsFor(db, c.id, c.course_code, textbooks);
  const chapters = rows(db, 'SELECT * FROM chapter_topics WHERE course_id = ?', [id])
    .map((t) => ({
      label: t.chapter_label,
      title: t.title,
      summary: t.summary || null,
      sections: json(t.sections_json, []),
      objectives: [...json(t.objectives_json, []), ...json(t.added_objectives_json, [])],
      vocabulary: [t.vocabulary, t.added_vocabulary].filter(Boolean).join('; '),
      readingUrl: t.reading_url,
      readingLabel: t.reading_label,
      pdf: readings.pdfs.get(t.chapter_label) || null
    }))
    .sort((a, b) => chapterNumber(a.label) - chapterNumber(b.label));
  // (A chapter saved under its bare number, "33", next to "Chapter 33" is a copy of it: shown once.)
  const named = new Set(chapters.map((ch) => (/^(chapter|unit|module)\s+(\d+)$/i.exec(ch.label) || [])[2]).filter(Boolean));
  for (let i = chapters.length - 1; i >= 0; i--) if (/^\d+$/.test(chapters[i].label) && named.has(chapters[i].label)) chapters.splice(i, 1);
  const weeks = rows(db, `SELECT * FROM academic_items WHERE course_id = ? AND item_type = 'weekly_reading' AND ${ACTIVE} ORDER BY date`, [id]).map((r) => itemOut(r, c, null, readings, done));
  const portal = rows(db, 'SELECT kind, label, url FROM course_portal_links WHERE course_id = ? ORDER BY kind, label', [id]);
  const w = withdrawnOf(file).get(c.id) || null;
  // (What Study works from when the class has no chapters: its objectives and its tests.)
  const outcomes = outcomesOf(db, c.id).length;
  const tests = rows(db, `SELECT COUNT(*) AS n FROM academic_items WHERE course_id = ? AND item_type IN ${TEST_TYPES} AND ${ACTIVE}`, [id])[0]?.n || 0;
  return { outcomes, tests, id: c.id, code: c.course_code, name: c.name, term: c.term, instructor: c.instructor, contact: c.instructor_contact, campus: c.campus, delivery: c.delivery_format, url: c.d2l_url, start: c.start_date, end: c.end_date, chapters, weeks, portal, withdrawn: w ? { at: w.at, by: w.by } : null };
}

/**
 * A class's grades as the daily checks recorded them (until Kea's own grade check has run): the latest overall
 * percent and every graded item with its score and the instructor's comment.
 */
async function gradesFromChecks(file, courseId) {
  const db = await open(file);
  if (!db) return null;
  const overall = rows(db, 'SELECT overall_percent, letter_grade FROM course_grade_snapshots WHERE course_id = ? ORDER BY captured_at DESC LIMIT 1', [courseId])[0];
  const seen = new Map();
  for (const r of rows(db, "SELECT external_id, payload_json, first_seen FROM digest_entries WHERE course_id = ? AND kind = 'grade' ORDER BY first_seen", [courseId])) {
    const g = json(r.payload_json, {});
    seen.set(String(r.external_id), { id: String(r.external_id), title: g.title, score: g.score_text || '', percent: g.score_percent ?? null, shown: '', comment: g.comment || '', at: g.graded_on || r.first_seen });
  }
  if (!overall && !seen.size) return null;
  return { final: overall ? { shown: overall.letter_grade || '', percent: overall.overall_percent } : null, items: [...seen.values()].reverse(), url: '', checked: null };
}

/** The real classes Kea's pre-check watches on D2L: active, not self-study, with their org unit id. */
async function watchList(file) {
  const db = await open(file);
  if (!db) return [];
  // (Not a class the student withdrew from: its checks would only bring in work they no longer do.)
  const gone = withdrawnOf(file);
  return rows(db, "SELECT id, course_code AS code, d2l_identifier AS ou FROM courses WHERE status = 'active' AND COALESCE(is_synthetic, 0) = 0 AND d2l_identifier IS NOT NULL AND d2l_identifier != '' ORDER BY course_code")
    .filter((c) => !gone.has(c.id))
    .map(({ id, ...c }) => c);
}

/** Every class with its term and class-site id, for telling when the student withdrew (withdrawn.cjs assess). */
async function termCourses(file) {
  const db = await open(file);
  if (!db) return [];
  return rows(db, "SELECT id, course_code AS code, d2l_identifier AS ou, start_date AS start, end_date AS `end`, COALESCE(is_synthetic, 0) AS synthetic FROM courses WHERE status = 'active' AND course_code != 'MESSAGES'").map((c) => ({ ...c, start: c.start ? dayOf(c.start) : null, end: c.end ? dayOf(c.end) : null, synthetic: !!c.synthetic }));
}

/**
 * What a practice exam or flashcard deck is written from (Kea's request to Claude): the class, the test or assignment
 * it's for (its study focus and review documents), and each chapter's internal material: vocabulary, objectives,
 * sections and the textbook chapter's source. The student never sees the vocabulary and objective lists; Claude uses
 * them, with the review documents, to cover everything the course tests.
 */
async function practiceSources(file, textbooks, { courseId, chapters = [], itemId = null, allChapters = false }) {
  const db = await open(file);
  if (!db) return null;
  let item = null;
  let labels = [...chapters];
  if (itemId) {
    const r = rows(db, 'SELECT * FROM academic_items WHERE id = ?', [itemId])[0];
    if (r) {
      courseId = r.course_id;
      const c0 = rows(db, 'SELECT * FROM courses WHERE id = ?', [courseId])[0];
      const banner = rows(db, `SELECT * FROM academic_items WHERE course_id = ? AND item_type = 'weekly_reading' AND ${ACTIVE} AND date <= ? AND COALESCE(date_range_end, date) >= ?`, [courseId, r.date, r.date])[0];
      const o = itemOut(r, c0, banner, readingsFor(db, courseId, c0.course_code, textbooks), {}, null, null);
      item = { id: o.id, title: o.title, type: o.type, date: o.date, points: o.points, description: o.description, study_focus: o.studyFocus, review_links: [...o.links, ...o.weeklyLinks].map((l) => ({ label: l.label, url: l.url })) };
      if (!labels.length) labels = o.readings.map((x) => x.chapter);
      if (!labels.length) labels = json(r.covered_chapters_json, []);
    }
  }
  // (A class can be named by its code too.)
  const c = rows(db, 'SELECT * FROM courses WHERE id = ? OR course_code = ?', [courseId, courseId])[0];
  if (!c) return null;
  courseId = c.id;
  const sources = new Map();
  for (const s of rows(db, 'SELECT chapters_json, source_path, file_path FROM study_pdfs WHERE course_id = ? AND source_path IS NOT NULL', [courseId]))
    for (const ch of json(s.chapters_json, [])) if (fs.existsSync(s.source_path)) sources.set(ch, s.source_path);
  // (Every chapter, for the textbook run: then every test counts too; an empty set here dropped every test from the
  // textbook notes, so they were written without the tests' focus or review sheets.)
  const want = new Set(allChapters ? rows(db, 'SELECT chapter_label FROM chapter_topics WHERE course_id = ?', [courseId]).map((x) => x.chapter_label) : labels);
  const outcomes = outcomesOf(db, courseId);
  const knownLabels = new Set(rows(db, 'SELECT chapter_label FROM chapter_topics WHERE course_id = ?', [courseId]).map((x) => x.chapter_label));
  // A class with no chapters at all is studied as a whole: from its objectives, every test, and its work's descriptions.
  const whole = !knownLabels.size && !want.size;
  const out = rows(db, 'SELECT * FROM chapter_topics WHERE course_id = ?', [courseId])
    .filter((t) => allChapters || want.has(t.chapter_label))
    .sort((a, b) => chapterNumber(a.chapter_label) - chapterNumber(b.chapter_label))
    .map((t) => ({
      label: t.chapter_label,
      title: t.title,
      summary: t.summary || null,
      sections: json(t.sections_json, []),
      objectives: [...json(t.objectives_json, []), ...json(t.added_objectives_json, [])],
      // The syllabus's module outcomes and topical outline for this chapter (course_outcomes).
      outcomes: outcomesFor(outcomes, t.chapter_label),
      vocabulary: [t.vocabulary, t.added_vocabulary].filter(Boolean).join('; '),
      reading_url: t.reading_url || null,
      textbook_source: sources.get(t.chapter_label) || null,
      // What Claude's depth review found missing or too shallow (questions must cover it).
      depth_gaps: t.depth_verdict === 'gaps' ? t.depth_note || null : null,
      // Review sheets linked from the chapter's weekly reading (FunSheets, worksheets, study guides): downloaded with
      // the tests' own links, since many tests link none.
      review_links: rows(db, `SELECT title, weekly_links_json, reference_url, reference_url_label, resource_url, resource_url_label FROM academic_items WHERE course_id = ? AND item_type = 'weekly_reading' AND ${ACTIVE}`, [courseId])
        .filter((b) => chaptersIn(b.title).includes(t.chapter_label))
        .flatMap((b) => [...json(b.weekly_links_json, []), ...[b.reference_url && { label: b.reference_url_label, url: b.reference_url }, b.resource_url && { label: b.resource_url_label, url: b.resource_url }].filter(Boolean)])
        .map((l) => ({ label: l.label || '', url: l.url }))
    }));
  // Every test that covers these chapters, with what the instructor said it covers (scraped from the class site) and
  // its review sheets: the questions should look like these tests.
  const tests = rows(db, `SELECT * FROM academic_items WHERE course_id = ? AND item_type IN ${TEST_TYPES} AND ${ACTIVE} ORDER BY date`, [courseId])
    .map((r) => ({ r, covered: coveredOf(r, knownLabels), focus: json(r.study_focus_json, []) }))
    // (Every test on these chapters counts, even with no study focus posted yet: its format and date still matter. A
    // class with no chapters: every test.)
    .filter(({ r, covered }) => whole || (item && r.id === item.id) || covered.some((ch) => want.has(ch)))
    .map(({ r, covered, focus }) => ({
      id: r.id,
      title: r.title,
      type: r.item_type,
      date: r.date,
      chapters: covered,
      study_focus: focus,
      description: r.description || null,
      review_links: [...json(r.weekly_links_json, []), ...[r.reference_url && { label: r.reference_url_label, url: r.reference_url }, r.resource_url && { label: r.resource_url_label, url: r.resource_url }].filter(Boolean)].map((l) => ({ label: l.label || '', url: l.url }))
    }))
    // The test the set is for first, then the ones that cover the most of these chapters.
    .sort((a, b) => (b.id === item?.id) - (a.id === item?.id) || (whole ? 0 : b.chapters.filter((ch) => want.has(ch)).length / b.chapters.length - a.chapters.filter((ch) => want.has(ch)).length / a.chapters.length));
  // The class's outcomes that belong to no one chapter, once (with no chapters, every one, with what it names).
  const course_outcomes = outcomes.filter((o) => whole || courseWide(o));
  // With no chapters, what the class's work asks for says what it practices.
  const work = whole
    ? rows(db, `SELECT id, title, item_type, date, description FROM academic_items WHERE course_id = ? AND item_type IN ${WORK_TYPES} AND ${ACTIVE} AND description IS NOT NULL AND trim(description) != '' ORDER BY date`, [courseId])
        .slice(0, 40)
        .map((r) => ({ id: r.id, title: r.title, type: r.item_type, date: r.date, description: r.description }))
    : [];
  return { course: { id: c.id, code: c.course_code, name: c.name }, item, chapters: out, tests, course_outcomes, ...(whole ? { whole: true, work } : {}) };
}

/**
 * Chapters whose tests ask the student to recognize things from pictures: every chapter of a class with lab practicals,
 * and any chapter whose own notes are about identifying structures, shapes, anatomy or lab equipment. A Set of
 * "courseId|Chapter N".
 */
async function identifyingChapters(file) {
  const db = await open(file);
  if (!db) return new Set();
  const out = new Set();
  const practical = new Set(rows(db, `SELECT DISTINCT course_id FROM academic_items WHERE item_type = 'lab_practical' AND lower(title) NOT LIKE '%report%' AND ${ACTIVE}`).map((r) => r.course_id));
  const visual = /\b(identification|labele?d|anatom\w*|morpholog\w*|glassware|lab equipment|organelles?|tissues?|specimens?|vsepr|molecular geometr\w*|molecular shapes?|electron geometr\w*)\b/i;
  for (const t of rows(db, 'SELECT course_id, chapter_label, objectives_json, sections_json, vocabulary FROM chapter_topics')) {
    const text = `${json(t.objectives_json, []).join(' ')} ${json(t.sections_json, []).join(' ')} ${t.vocabulary || ''}`;
    if (practical.has(t.course_id) || visual.test(text)) out.add(`${t.course_id}|${t.chapter_label}`);
  }
  return out;
}

/**
 * The documents each item was read from (its syllabus, handout, assignment folder…), for the guides Claude writes:
 * { [itemId]: [{ type, title, url, path, text }] }, each text cut to `max` characters.
 */
async function itemSources(file, ids, max = 4000) {
  const db = await open(file);
  if (!db || !ids.length) return {};
  const out = {};
  const cache = new Map();
  for (const id of ids) {
    const r = rows(db, 'SELECT source_ids_json FROM academic_items WHERE id = ?', [id])[0];
    const list = [];
    for (const sid of json(r?.source_ids_json, [])) {
      if (!cache.has(sid)) cache.set(sid, rows(db, 'SELECT source_type, title, url, local_path, substr(raw_text, 1, ?) AS text FROM sources WHERE id = ?', [max, sid])[0] || null);
      const x = cache.get(sid);
      if (x) list.push({ type: x.source_type, title: x.title || '', url: x.url || '', path: x.local_path || '', text: x.text || '' });
    }
    out[id] = list;
  }
  return out;
}

/** The class site's documents Kea read whose text has every word: [{ id, type, title, url, course, text }]. */
async function searchSources(file, words) {
  const db = await open(file);
  if (!db || !words.length) return [];
  const where = words.map(() => "lower(COALESCE(s.raw_text, '') || ' ' || COALESCE(s.title, '')) LIKE ?").join(' AND ');
  return rows(db, `SELECT s.id, s.source_type AS type, s.title, s.url, c.course_code AS course, substr(s.raw_text, 1, 200000) AS text FROM sources s LEFT JOIN courses c ON c.id = s.course_id WHERE s.superseded_by_id IS NULL AND ${where} LIMIT 40`, words.map((w) => `%${w}%`));
}

/** One class-site document's whole text. */
async function sourceText(file, id) {
  const db = await open(file);
  if (!db) return null;
  const r = rows(db, 'SELECT source_type AS type, title, url, local_path, substr(raw_text, 1, 60000) AS text FROM sources WHERE id = ?', [id])[0];
  return r || null;
}

module.exports = { termCourses, searchSources, sourceText, itemSources, practiceSources, courses, items, course, watchList, gradesFromChecks, chaptersIn, textbookChapters, textbookOf, nextTests, identifyingChapters, sameWork, badCourseCodes, _test: { sameChapter, outcomesOf, handIn, norm, relateItems, labNumber, postBase, DUE_KINDS } };
