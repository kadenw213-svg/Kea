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

// The open database, re-read when the file changes (after a scan).
let cache = { file: '', mtime: 0, db: null };
async function open(file) {
  if (!fs.existsSync(file)) return null;
  const mtime = fs.statSync(file).mtimeMs;
  if (cache.db && cache.file === file && cache.mtime === mtime) return cache.db;
  const S = await engine();
  cache.db?.close();
  cache = { file, mtime, db: new S.Database(fs.readFileSync(file)) };
  return cache.db;
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
function chaptersIn(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/\b(chapter|ch\.?|module|unit)\s*(\d+[a-z]?)\b/gi)) {
    const kind = /^ch/i.test(m[1]) ? 'Chapter' : m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
    const label = `${kind} ${m[2].toUpperCase()}`;
    if (!out.includes(label)) out.push(label);
  }
  return out;
}
const chapterNumber = (label) => parseFloat(String(label).replace(/[^\d.]/g, '')) || 0;

const ACTIVE = "status NOT IN ('superseded', 'cancelled')";

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
  return { pdfs, titles, summaries };
}

/** Classes in the profile, with what's coming up. */
async function courses(file, textbooks, done) {
  const db = await open(file);
  if (!db) return [];
  const today = localDay();
  const week = localDay(new Date(Date.now() + 7 * 864e5));
  return rows(db, "SELECT * FROM courses WHERE status = 'active' AND course_code != 'MESSAGES' ORDER BY course_code").map((c) => {
    const due = rows(
      db,
      `SELECT id, title, item_type, date, due_time FROM academic_items WHERE course_id = ? AND ${ACTIVE} AND item_type NOT IN ('weekly_reading', 'reading', 'lecture', 'break', 'no_class') AND date >= ? ORDER BY date, due_time LIMIT 40`,
      [c.id, today]
    );
    const open = due.filter((i) => !done[i.id]);
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
      chapters: pdfs.size
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
  for (const c of rows(db, "SELECT * FROM courses WHERE status = 'active' AND course_code != 'MESSAGES' ORDER BY course_code")) {
    if (c.end_date && String(c.end_date).slice(0, 10) < today) continue;
    const { pdfs } = readingsFor(db, c.id, c.course_code, textbooks);
    for (const label of [...pdfs.keys()].sort((a, b) => chapterNumber(a) - chapterNumber(b))) out.push({ courseId: c.id, label });
    for (const t of rows(db, `SELECT date, covered_chapters_json FROM academic_items WHERE course_id = ? AND item_type IN ('exam', 'final_exam', 'midterm', 'lab_practical', 'quiz') AND ${ACTIVE} AND date >= ? ORDER BY date`, [c.id, today]))
      for (const label of json(t.covered_chapters_json, [])) if (!soon.has(`${c.id}|${label}`)) soon.set(`${c.id}|${label}`, t.date);
  }
  const when = (x) => soon.get(`${x.courseId}|${x.label}`) || '9999';
  return out.map((x, i) => ({ x, i })).sort((a, b) => when(a.x).localeCompare(when(b.x)) || a.i - b.i).map(({ x }) => x);
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
  for (const t of rows(db, `SELECT course_id, title, date, covered_chapters_json FROM academic_items WHERE item_type IN ('exam', 'final_exam', 'midterm', 'lab_practical', 'quiz') AND ${ACTIVE} AND date >= ? ORDER BY date`, [today]))
    for (const label of json(t.covered_chapters_json, [])) {
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
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Evidence per class of what the student handed in: grades the daily checks recorded, and what Kea's pre-check
 * learned from D2L (graded items, assignment folders with or without a submission). Map course id → [{t, state}].
 */
function evidence(db, file) {
  const out = new Map();
  const add = (courseId, title, state) => {
    const t = norm(title);
    if (!t) return;
    if (!out.has(courseId)) out.set(courseId, []);
    out.get(courseId).push({ t, state });
  };
  for (const r of rows(db, "SELECT course_id, payload_json FROM digest_entries WHERE kind = 'grade'")) add(r.course_id, json(r.payload_json, {}).title, 'graded');
  // Grades read from outside platforms (ALEKS and the like) during weekly checks.
  for (const r of rows(db, 'SELECT course_id, title, is_missing FROM grade_snapshots')) add(r.course_id, r.title, r.is_missing ? 'not_submitted' : 'graded');
  try {
    const sub = JSON.parse(fs.readFileSync(path.join(path.dirname(file), '..', '..', 'submissions.json'), 'utf8'));
    const ids = new Map(rows(db, 'SELECT id, course_code FROM courses').map((c) => [c.course_code, c.id]));
    for (const [code, list] of Object.entries(sub.byCourse || {})) for (const x of list) if (ids.has(code)) add(ids.get(code), x.title, x.state);
  } catch {}
  return out;
}

/** An item's hand-in state from the evidence: 'graded', 'submitted', 'not_submitted' or null (unknown). */
function handIn(r, ev) {
  const list = ev.get(r.course_id);
  if (!list) return null;
  const t = norm(r.title);
  if (t.length < 3) return null;
  const exact = list.filter((x) => x.t === t);
  const close = exact.length ? exact : list.filter((x) => Math.min(x.t.length, t.length) >= 6 && (x.t.includes(t) || t.includes(x.t)));
  if (!close.length) return null;
  return close.find((x) => x.state === 'graded')?.state || close.find((x) => x.state === 'submitted')?.state || 'not_submitted';
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

function itemOut(r, course, banner, readings, done, rooms, ev) {
  const covered = json(r.covered_chapters_json, []);
  let chapters = [...new Set([...covered, ...chaptersIn(`${r.title} ${r.module_label || ''}`)])];
  // An assignment with no chapter of its own reads that week's chapters.
  if (!chapters.length && banner && !['administrative_deadline', 'break', 'no_class'].includes(r.item_type)) chapters = chaptersIn(banner.title);
  return {
    id: r.id,
    courseId: r.course_id,
    courseCode: course?.course_code || '',
    type: r.item_type,
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
      r.submission_url && { label: r.submission_url_label || 'Submit', url: r.submission_url, kind: 'submit' },
      r.reference_url && { label: r.reference_url_label || 'Instructions', url: r.reference_url, kind: 'reference' },
      r.resource_url && { label: r.resource_url_label || 'Resource', url: r.resource_url, kind: 'resource' },
      r.video_url && { label: r.video_url_label || 'Video', url: r.video_url, kind: 'video' }
    ].filter(Boolean),
    weeklyLinks: json(r.weekly_links_json, []),
    covered,
    studyFocus: json(r.study_focus_json, []),
    points: r.points,
    optional: !!r.is_optional,
    tentative: !!r.is_tentative || !!r.is_inferred_date,
    done: done[r.id] || null,
    handIn: ev ? handIn(r, ev) : null,
    // Only the class's own chapters ("Inner Fish CH 6" is a side book, not the course's Chapter 6).
    readings: chapters
      .filter((ch) => !readings.titles.size || readings.titles.has(ch) || readings.pdfs.has(ch))
      .sort((a, b) => chapterNumber(a) - chapterNumber(b))
      .map((ch) => ({ chapter: ch, title: readings.titles.get(ch) || null, summary: readings.summaries?.get(ch) || null, pdf: readings.pdfs.get(ch) || null }))
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
  return list.map((r) => {
    const c = byId.get(r.course_id);
    const banner = banners.find((b) => b.course_id === r.course_id && b.date <= r.date && (b.date_range_end || b.date) >= r.date);
    return itemOut(r, c, banner, reads(c), done, rooms, ev);
  });
}

/** One class: its chapters (titles, sections, objectives, study PDF) and its weeks. */
async function course(file, textbooks, done, id) {
  const db = await open(file);
  if (!db) return null;
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
  const weeks = rows(db, `SELECT * FROM academic_items WHERE course_id = ? AND item_type = 'weekly_reading' AND ${ACTIVE} ORDER BY date`, [id]).map((r) => itemOut(r, c, null, readings, done));
  const portal = rows(db, 'SELECT kind, label, url FROM course_portal_links WHERE course_id = ? ORDER BY kind, label', [id]);
  return { id: c.id, code: c.course_code, name: c.name, term: c.term, instructor: c.instructor, contact: c.instructor_contact, campus: c.campus, delivery: c.delivery_format, url: c.d2l_url, start: c.start_date, end: c.end_date, chapters, weeks, portal };
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
  return rows(db, "SELECT course_code AS code, d2l_identifier AS ou FROM courses WHERE status = 'active' AND COALESCE(is_synthetic, 0) = 0 AND d2l_identifier IS NOT NULL AND d2l_identifier != '' ORDER BY course_code");
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
  const want = new Set(labels);
  const out = rows(db, 'SELECT * FROM chapter_topics WHERE course_id = ?', [courseId])
    .filter((t) => allChapters || want.has(t.chapter_label))
    .sort((a, b) => chapterNumber(a.chapter_label) - chapterNumber(b.chapter_label))
    .map((t) => ({
      label: t.chapter_label,
      title: t.title,
      summary: t.summary || null,
      sections: json(t.sections_json, []),
      objectives: [...json(t.objectives_json, []), ...json(t.added_objectives_json, [])],
      vocabulary: [t.vocabulary, t.added_vocabulary].filter(Boolean).join('; '),
      reading_url: t.reading_url || null,
      textbook_source: sources.get(t.chapter_label) || null
    }));
  // Every test that covers these chapters, with what the instructor said it covers (scraped from the class site) and
  // its review sheets: the questions should look like these tests.
  const tests = rows(db, `SELECT * FROM academic_items WHERE course_id = ? AND item_type IN ('exam', 'final_exam', 'midterm', 'lab_practical', 'quiz') AND ${ACTIVE} ORDER BY date`, [courseId])
    .map((r) => ({ r, covered: json(r.covered_chapters_json, []), focus: json(r.study_focus_json, []) }))
    .filter(({ r, covered, focus }) => (item && r.id === item.id) || ((focus.length || r.description) && covered.some((ch) => want.has(ch))))
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
    .sort((a, b) => (b.id === item?.id) - (a.id === item?.id) || b.chapters.filter((ch) => want.has(ch)).length / b.chapters.length - a.chapters.filter((ch) => want.has(ch)).length / a.chapters.length);
  return { course: { id: c.id, code: c.course_code, name: c.name }, item, chapters: out, tests };
}

module.exports = { practiceSources, courses, items, course, watchList, gradesFromChecks, chaptersIn, textbookChapters, textbookOf, nextTests };
