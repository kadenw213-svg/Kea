// Reads a profile's scan-engine database (SQLite, written by the engine's `academic-sync` CLI) for Kea Scholar.
// Kea only reads it: what's checked off and other Kea state live in the profile's kea.json.
// sql.js (SQLite compiled to WebAssembly) is used because this Electron has no built-in SQLite.
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

let SQL = null;
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
  const titles = new Map(rows(db, 'SELECT chapter_label, title FROM chapter_topics WHERE course_id = ?', [courseId]).map((t) => [t.chapter_label, t.title]));
  return { pdfs, titles };
}

/** Classes in the profile, with what's coming up. */
async function courses(file, textbooks, done) {
  const db = await open(file);
  if (!db) return [];
  const today = new Date().toISOString().slice(0, 10);
  const week = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
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

function itemOut(r, course, banner, readings, done) {
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
    // Only the class's own chapters ("Inner Fish CH 6" is a side book, not the course's Chapter 6).
    readings: chapters
      .filter((ch) => !readings.titles.size || readings.titles.has(ch) || readings.pdfs.has(ch))
      .sort((a, b) => chapterNumber(a) - chapterNumber(b))
      .map((ch) => ({ chapter: ch, title: readings.titles.get(ch) || null, pdf: readings.pdfs.get(ch) || null }))
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
  return list.map((r) => {
    const c = byId.get(r.course_id);
    const banner = banners.find((b) => b.course_id === r.course_id && b.date <= r.date && (b.date_range_end || b.date) >= r.date);
    return itemOut(r, c, banner, reads(c), done);
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
  return { id: c.id, code: c.course_code, name: c.name, term: c.term, instructor: c.instructor, url: c.d2l_url, start: c.start_date, end: c.end_date, chapters, weeks, portal };
}

module.exports = { courses, items, course, chaptersIn };
