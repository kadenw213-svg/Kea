// Study is written from the scanned curriculum (course_outcomes): each chapter gets the outcomes tied to it, the
// course-wide ones come once at the class level, not-tested ones never, and a database from before the table still
// works. A class with no chapters is studied as a whole, from its outcomes, tests and work (electron/scholar/db.cjs
// practiceSources, study.cjs request and prepare).
// Run: node --test test/study/
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electron = require('../worker/electronStub.cjs');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-outcomes-test-'));
electron._paths.userData = path.join(base, 'user');
electron._paths.appData = path.join(base, 'user');
fs.mkdirSync(electron._paths.userData, { recursive: true });
after(() => fs.rmSync(base, { recursive: true, force: true }));

const initSqlJs = require('sql.js');
const profiles = require('../../electron/scholar/profiles.cjs');
const db = require('../../electron/scholar/db.cjs');
const study = require('../../electron/scholar/study.cjs');

const SCHEMA = `
CREATE TABLE courses (id TEXT PRIMARY KEY, course_code TEXT, name TEXT, term TEXT, instructor TEXT, instructor_contact TEXT, campus TEXT, delivery_format TEXT, d2l_url TEXT, start_date TEXT, end_date TEXT, status TEXT, is_synthetic INTEGER, d2l_identifier TEXT);
CREATE TABLE chapter_topics (course_id TEXT, chapter_label TEXT, title TEXT, summary TEXT, sections_json TEXT, objectives_json TEXT, added_objectives_json TEXT, vocabulary TEXT, added_vocabulary TEXT, reading_url TEXT, reading_label TEXT, depth_verdict TEXT, depth_note TEXT);
CREATE TABLE study_pdfs (course_id TEXT, chapters_json TEXT, source_path TEXT, file_path TEXT, page_count INTEGER, week_start TEXT);
CREATE TABLE academic_items (id TEXT PRIMARY KEY, course_id TEXT, item_type TEXT, title TEXT, date TEXT, date_range_end TEXT, status TEXT, description TEXT, covered_chapters_json TEXT, study_focus_json TEXT, weekly_links_json TEXT, reference_url TEXT, reference_url_label TEXT, resource_url TEXT, resource_url_label TEXT);
CREATE TABLE course_portal_links (course_id TEXT, kind TEXT, label TEXT, url TEXT);
`;
const OUTCOMES = 'CREATE TABLE course_outcomes (id TEXT PRIMARY KEY, course_id TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL, text TEXT NOT NULL, chapters_json TEXT NOT NULL, not_tested TEXT, source TEXT, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL);';

/** A class database: BIO111 with chapters (one saved under its bare number), ENG122 with modules, EMS101 with none. */
async function makeDb(file, { withOutcomes = true } = {}) {
  const S = await initSqlJs();
  const d = new S.Database();
  d.run(SCHEMA);
  if (withOutcomes) d.run(OUTCOMES);
  const ins = (table, row) => d.run(`INSERT INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`, Object.values(row));
  for (const [id, code, name] of [
    ['bio', 'BIO111', 'Biology'],
    ['eng', 'ENG122', 'Composition'],
    ['ems', 'EMS101', 'First Responder']
  ])
    ins('courses', { id, course_code: code, name, term: 'Fall 2026', status: 'active', is_synthetic: 0 });
  const ch = (course_id, chapter_label, title, objectives = []) => ins('chapter_topics', { course_id, chapter_label, title, sections_json: '[]', objectives_json: JSON.stringify(objectives), added_objectives_json: '[]', vocabulary: '' });
  ch('bio', 'Chapter 22', 'Evolution', ['Explain natural selection']);
  ch('bio', '33', 'Invertebrates');
  ch('eng', 'Module 1', 'Research');
  ch('eng', 'Module 2', 'Argument');
  if (withOutcomes) {
    let n = 0;
    const out = (course_id, kind, ref, text, chapters, not_tested = null) => ins('course_outcomes', { id: `o${++n}`, course_id, kind, ref, text, chapters_json: JSON.stringify(chapters), not_tested, source: 'syllabus.pdf', first_seen: '2026-09-01', last_seen: '2026-11-01' });
    out('bio', 'course', '1', 'Use biological terminology', ['all']);
    out('bio', 'course', '3', 'Perform lab procedures', [], 'A lab skill: assessed on the lab practicals, not by study sets.');
    out('bio', 'outline', 'I.A', 'Darwin and natural selection', ['Chapter 22']);
    out('bio', 'outline', 'VI.B', 'Kingdom animalia: invertebrates', ['Chapter 32', 'Chapter 33']);
    out('bio', 'outline', 'IX', 'Ecology: populations', ['Chapter 53']);
    out('bio', 'recommended', 'R1', 'Read the news on biology', []);
    out('eng', 'module', 'M1.1', 'Use MLA citations', ['Module 1']);
    out('eng', 'module', 'M2.1', 'Build an argument', ['Module 2'], '0');
    out('eng', 'module', 'M2.2', 'Never tested', ['Module 2'], '1');
    out('ems', 'course', '1', 'Assess a patient’s airway', []);
    out('ems', 'module', '2.1', 'Splint a fracture', ['Module 2']);
  }
  const item = (id, course_id, item_type, title, extra = {}) => ins('academic_items', { id, course_id, item_type, title, date: '2026-12-01', status: 'active', ...extra });
  item('bio-ex', 'bio', 'exam', 'Exam 4', { covered_chapters_json: '["Chapter 22"]', study_focus_json: '["Natural selection"]' });
  item('ems-q1', 'ems', 'quiz', 'Quiz 1', { study_focus_json: '["Airway"]', description: 'Twenty questions on the airway.' });
  item('ems-ex', 'ems', 'exam', 'Final exam', {});
  item('ems-hw', 'ems', 'assignment', 'Patient care report', { description: '<p>Write a <b>patient care report</b> for the scenario.</p>' });
  item('ems-x', 'ems', 'assignment', 'Empty one', { description: '' });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(d.export()));
  d.close();
}

const dbFile = () => profiles.paths().db;
const tb = () => profiles.paths().textbooks;

test('each chapter gets its own outcomes; course-wide ones come once; not-tested ones never', async () => {
  await makeDb(dbFile());
  const src = await db.practiceSources(dbFile(), tb(), { courseId: 'bio', chapters: ['Chapter 22', '33'] });
  const by = Object.fromEntries(src.chapters.map((c) => [c.label, c.outcomes.map((o) => o.ref)]));
  assert.deepEqual(by, { 'Chapter 22': ['I.A'], 33: ['VI.B'] }, 'a chapter saved as "33" matches "Chapter 33"');
  assert.deepEqual(
    src.course_outcomes.map((o) => o.ref),
    ['1', 'R1'],
    'course outcomes and ones with no chapter, once; the lab skill marked not tested is left out'
  );
  assert.equal(src.whole, undefined);
  const eng = await db.practiceSources(dbFile(), tb(), { courseId: 'ENG122', chapters: ['Module 1', 'Module 2'] });
  assert.deepEqual(
    eng.chapters.map((c) => [c.label, c.outcomes.map((o) => o.ref)]),
    [
      ['Module 1', ['M1.1']],
      ['Module 2', ['M2.1']]
    ]
  );
});

test('chapter labels match across spellings, but a module is not a chapter', () => {
  const { sameChapter } = db._test;
  assert.ok(sameChapter('Chapter 33', '33'));
  assert.ok(sameChapter('Ch. 5', 'Chapter 5'));
  assert.ok(sameChapter('module 1', 'Module 1'));
  assert.ok(!sameChapter('Module 1', 'Chapter 1'));
  assert.ok(!sameChapter('Chapter 3', 'Chapter 33'));
});

test('a database from before course_outcomes still gives practice sources and the class', async () => {
  const file = path.join(base, 'old', 'academic_sync.db');
  await makeDb(file, { withOutcomes: false });
  const src = await db.practiceSources(file, tb(), { courseId: 'bio', chapters: ['Chapter 22'] });
  assert.deepEqual(src.chapters[0].outcomes, []);
  assert.deepEqual(src.course_outcomes, []);
  const c = await db.course(file, tb(), {}, 'bio');
  assert.equal(c.outcomes, 0);
  assert.equal(c.tests, 1);
});

test('a class with no chapters is studied as a whole: every outcome, every test and its work', async () => {
  await makeDb(dbFile());
  const src = await db.practiceSources(dbFile(), tb(), { courseId: 'ems', chapters: [] });
  assert.equal(src.whole, true);
  assert.deepEqual(src.chapters, []);
  assert.deepEqual(src.tests.map((t) => t.id).sort(), ['ems-ex', 'ems-q1']);
  assert.deepEqual(src.course_outcomes.map((o) => o.ref), ['1', '2.1']);
  assert.deepEqual(src.work.map((w) => w.id), ['ems-hw'], 'only work with a description');
  const c = await db.course(dbFile(), tb(), {}, 'ems');
  assert.deepEqual([c.chapters.length, c.outcomes, c.tests], [0, 2, 2]);
  // (A class with chapters and none picked is still asked to pick one.)
  const bio = await db.practiceSources(dbFile(), tb(), { courseId: 'bio', chapters: [] });
  assert.equal(bio.whole, undefined);
  await assert.rejects(study.request({ kind: 'exam', courseId: 'bio', chapters: [], count: 10, mode: 'new' }), /Pick at least one chapter/);
});

const brief = (id) => fs.readFileSync(path.join(profiles.paths().workspace, 'data', 'study', 'requests', `${id}.md`), 'utf8');

test('the brief for a class with no chapters has its outcomes, tests and work', async () => {
  await makeDb(dbFile());
  const { id, ready } = await study.request({ kind: 'exam', courseId: 'ems', chapters: [], count: 20, mode: 'new' });
  assert.equal(ready, false);
  const set = study.list().find((e) => e.id === id);
  assert.match(set.title, /EMS101, whole class/);
  await study.prepare(id, async () => null);
  const b = brief(id);
  assert.match(b, /\*\*Syllabus outcomes for the whole class \(each needs questions\)\*\*/);
  assert.match(b, /- Course outcome 1: Assess a patient’s airway/);
  assert.match(b, /- Module outcome 2\.1: Splint a fracture \(Module 2\)/);
  assert.match(b, /### Quiz 1[\s\S]*- Airway/);
  assert.match(b, /Twenty questions on the airway\./);
  assert.match(b, /## What the class’s work asks for[\s\S]*### Patient care report[\s\S]*Write a patient care report for the scenario\./);
  assert.match(b, /This class has no chapters/);
});

test('the brief for chapters has each chapter’s outcomes beside its objectives and the course ones once', async () => {
  await makeDb(dbFile());
  const { id } = await study.request({ kind: 'exam', courseId: 'bio', chapters: ['Chapter 22', '33'], count: 20, mode: 'new' });
  await study.prepare(id, async () => null);
  const b = brief(id);
  assert.match(b, /## Chapter 22: Evolution[\s\S]*\*\*Objectives\*\*\n- Explain natural selection\n\n\*\*Syllabus outcomes this chapter teaches \(each needs questions\)\*\*\n- Topical outline I\.A: Darwin and natural selection/);
  assert.match(b, /## 33: Invertebrates[\s\S]*- Topical outline VI\.B: Kingdom animalia: invertebrates/);
  assert.equal(b.match(/Course outcome 1: Use biological terminology/g).length, 1);
  assert.doesNotMatch(b, /Perform lab procedures/);
  assert.doesNotMatch(b, /Ecology: populations/, 'an outcome for a chapter not in the set stays out');
});

test('chapter notes written before the outcomes are rebuilt even when nothing is newer', async () => {
  await makeDb(dbFile());
  const notes = path.join(profiles.paths().workspace, 'data', 'study', 'notes', 'BIO111', 'Chapter 22.md');
  fs.mkdirSync(path.dirname(notes), { recursive: true });
  fs.writeFileSync(notes, '# Chapter 22: Evolution\n\n## Objectives\n- Explain natural selection\n');
  const later = new Date(Date.now() + 60000);
  fs.utimesSync(notes, later, later);
  const { id } = await study.request({ kind: 'exam', courseId: 'bio', chapters: ['Chapter 22'], count: 20, mode: 'new' });
  await study.prepare(id, async () => null);
  const text = fs.readFileSync(notes, 'utf8');
  assert.match(text, /^<!-- kea-notes [0-9a-f]{16} -->\n# Chapter 22/);
  assert.match(text, /## Syllabus outcomes\n- Topical outline I\.A/);
  assert.doesNotMatch(brief(id), /kea-notes/, 'the fingerprint never reaches the brief');
  // Unchanged: kept as written (same fingerprint).
  const mark = text.split('\n')[0];
  fs.utimesSync(notes, later, later);
  await study.prepare(id, async () => null);
  assert.equal(fs.readFileSync(notes, 'utf8').split('\n')[0], mark);
});
