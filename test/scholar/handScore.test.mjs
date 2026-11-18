// The class site's score next to "graded" work (electron/scholar/db.cjs handScore, src/components/scholar/itemRules.ts
// classSiteTag): a real grade reads "Class Site: Graded 8/10" and a zero "Class Site: Graded 0/10", so the two can be
// told apart at a glance on Missing work. The score only labels work the class site already calls graded: it never
// makes something graded, and it never guesses between two different scores.
// Run: node --test test/scholar/handScore.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { classSiteTag } from '../../src/components/scholar/itemRules.ts';

const require = createRequire(import.meta.url);
require('../worker/electronStub.cjs');
const initSqlJs = require('sql.js');
const db = require('../../electron/scholar/db.cjs');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-hand-score-test-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const day = (n) => {
  const d = new Date(Date.now() + n * 864e5);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const SCHEMA = `
CREATE TABLE courses (id TEXT PRIMARY KEY, course_code TEXT, name TEXT, term TEXT, instructor TEXT, instructor_contact TEXT, campus TEXT, delivery_format TEXT, d2l_url TEXT, start_date TEXT, end_date TEXT, status TEXT, is_synthetic INTEGER, d2l_identifier TEXT);
CREATE TABLE chapter_topics (course_id TEXT, chapter_label TEXT, title TEXT, summary TEXT, sections_json TEXT, objectives_json TEXT, added_objectives_json TEXT, vocabulary TEXT, added_vocabulary TEXT, reading_url TEXT, reading_label TEXT, depth_verdict TEXT, depth_note TEXT);
CREATE TABLE study_pdfs (course_id TEXT, chapters_json TEXT, source_path TEXT, file_path TEXT, page_count INTEGER, week_start TEXT);
CREATE TABLE academic_items (id TEXT PRIMARY KEY, course_id TEXT, item_type TEXT, title TEXT, date TEXT, date_range_end TEXT, start_time TEXT, end_time TEXT, due_time TEXT, status TEXT, description TEXT, source_wording TEXT, platform_location TEXT, location TEXT, instructor TEXT, points REAL, optional INTEGER, tentative INTEGER, module TEXT, covered_chapters_json TEXT, study_focus_json TEXT, weekly_links_json TEXT, submission_url TEXT, submission_url_label TEXT, reference_url TEXT, reference_url_label TEXT, resource_url TEXT, resource_url_label TEXT);
CREATE TABLE course_portal_links (course_id TEXT, kind TEXT, label TEXT, url TEXT);
CREATE TABLE digest_entries (course_id TEXT, kind TEXT, external_id TEXT, payload_json TEXT, first_seen TEXT);
CREATE TABLE course_grade_snapshots (course_id TEXT, overall_percent REAL, letter_grade TEXT, captured_at TEXT);
CREATE TABLE grade_snapshots (course_id TEXT, title TEXT, is_missing INTEGER);
`;

// Laid out as in a profile (electron/scholar/profiles.cjs): the database is <profile>/scholar/data/academic_sync.db, and
// grades.json and submissions.json are kept in <profile>.
const file = path.join(base, 'profile', 'scholar', 'data', 'academic_sync.db');
fs.mkdirSync(path.dirname(file), { recursive: true });
const S = await initSqlJs();
const d = new S.Database();
d.run(SCHEMA);
const ins = (table, row) => d.run(`INSERT INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`, Object.values(row));
ins('courses', { id: 'c1', course_code: 'BIO111', name: 'Biology', term: 'Fall 2026', status: 'active', is_synthetic: 0 });
const work = (id, title, type = 'assignment') => ins('academic_items', { id, course_id: 'c1', item_type: type, title, date: day(-3), due_time: '23:59', status: 'active' });
// What the class site calls graded (the daily check's grade entries); grades.json below holds the scores.
const graded = (title) => ins('digest_entries', { course_id: 'c1', kind: 'grade', external_id: title, payload_json: JSON.stringify({ title }), first_seen: day(-2) });

work('real', 'Lab 4 Report');
graded('Lab 4 Report');
work('zero', 'Quiz 2');
graded('Quiz 2');
work('letter', 'Essay 1');
graded('Essay 1');
work('plain', 'Problem Set 3'); // a score exists, but nothing says it is graded
work('clash', 'Lab 6 Writeup');
graded('Lab 6 Writeup');
work('none', 'Reading Response'); // nothing at all
fs.writeFileSync(file, Buffer.from(d.export()));
d.close();
fs.writeFileSync(
  path.join(base, 'profile', 'grades.json'),
  JSON.stringify({
    seeded: true,
    byCourse: {
      BIO111: {
        items: [
          { id: '1', title: 'Lab 4 Report', score: '8 / 10', percent: 80, shown: '' },
          { id: '2', title: 'Quiz 2', score: '0 / 5', percent: 0, shown: '' },
          { id: '3', title: 'Essay 1', score: '', percent: null, shown: 'A' },
          { id: '4', title: 'Problem Set 3', score: '9 / 10', percent: 90, shown: '' },
          { id: '5', title: 'Lab 6 Writeup', score: '3 / 5', percent: 60, shown: '' },
          { id: '6', title: 'Lab 6 Writeup', score: '5 / 5', percent: 100, shown: '' },
          // A category's total is never one assignment's score.
          { id: '7', title: 'Module 1', score: '40 / 50', percent: 80, shown: '' }
        ]
      }
    }
  })
);

const got = Object.fromEntries((await db.items(file, path.join(base, 'textbooks'), {}, { from: day(-10), to: day(1) })).map((i) => [i.id, i]));

test('graded work shows the score the class site gives, in the form 8/10', () => {
  assert.equal(got.real.handIn, 'graded');
  assert.equal(got.real.handScore, '8/10');
});

test('a zero is kept and shown, so it can be told from a real grade', () => {
  assert.equal(got.zero.handIn, 'graded');
  assert.equal(got.zero.handScore, '0/5');
  assert.equal(classSiteTag(got.zero), 'Class Site: Graded 0/5');
});

test('a grade with no points (a letter) has no score; the tag falls back to the plain wording', () => {
  assert.equal(got.letter.handIn, 'graded');
  assert.equal(got.letter.handScore, null);
  assert.equal(classSiteTag(got.letter), 'Class site: graded');
});

test('a score never makes work graded: only work the class site calls graded gets one', () => {
  assert.equal(got.plain.handIn, null, 'a title match in grades.json is not evidence of grading');
  assert.equal(got.plain.handScore, null);
  assert.equal(got.none.handIn, null);
  assert.equal(got.none.handScore, null);
});

test('two different scores for the same title: no score is shown rather than a guess', () => {
  assert.equal(got.clash.handIn, 'graded');
  assert.equal(got.clash.handScore, null);
});

test('classSiteTag: the wording on a row, and nothing for work that is checked off', () => {
  assert.equal(classSiteTag({ done: null, handIn: 'graded', handScore: '8/10' }), 'Class Site: Graded 8/10');
  assert.equal(classSiteTag({ done: null, handIn: 'graded', handScore: null }), 'Class site: graded');
  assert.equal(classSiteTag({ done: null, handIn: 'submitted', handScore: null }), 'Class site: handed in');
  assert.equal(classSiteTag({ done: null, handIn: 'not_submitted', handScore: null }), null);
  assert.equal(classSiteTag({ done: null, handIn: null }), null);
  assert.equal(classSiteTag({ done: '2026-11-01T10:00:00Z', handIn: 'graded', handScore: '8/10' }), null);
});
