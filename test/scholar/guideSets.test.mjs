// A new study guide for a test makes practice for it.
// Run: node --test test/scholar/guideSets.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const G = require('../../electron/scholar/guideSets.cjs');

const NOW = Date.parse('2026-11-24T12:00:00Z');
const day = (n) => new Date(NOW + n * 864e5).toISOString().slice(0, 10);
const mid = { id: 'm1', title: 'Midterm Exam', type: 'midterm', date: day(10), chapters: ['Chapter 1', 'Chapter 2', 'Chapter 3'], review_links: [], study_focus: [] };
const fin = { id: 'f1', title: 'Final Exam', type: 'final_exam', date: day(18), chapters: [], review_links: [], study_focus: [] };
const files = (...n) => n.map((p) => ({ path: `data/downloads/BIO111/${p}` }));

test('a midterm study guide with no chapter number makes a set for the midterm only', () => {
  const r = G.plan({ tests: [mid, fin], files: files('Midterm Study Guide.pdf.txt'), now: NOW });
  assert.deepEqual(r.make.map((m) => m.test.id), ['m1']);
  assert.deepEqual(r.make[0].fresh, ['file|data/downloads/BIO111/Midterm Study Guide.pdf']);
});

test('a final review sheet makes a set for the final, even with no chapters known', () => {
  const r = G.plan({ tests: [mid, fin], files: files('Final Review.docx'), now: NOW });
  assert.deepEqual(r.make.map((m) => m.test.id), ['f1']);
});

test('a chapter review sheet goes to the test that covers that chapter', () => {
  assert.deepEqual(G.plan({ tests: [mid, fin], files: files('Ch 2 Review.pdf'), now: NOW }).make.map((m) => m.test.id), ['m1']);
  assert.equal(G.plan({ tests: [mid], files: files('Ch 9 Review.pdf'), now: NOW }).make.length, 0);
});

test('links and a study focus posted on the test count', () => {
  const t = { ...mid, review_links: [{ label: 'Study guide', url: 'https://x/sg' }], study_focus: ['Know mitosis'] };
  assert.equal(G.plan({ tests: [t], files: [], now: NOW }).make[0].fresh.length, 2);
});

test('a quiz’s results page and tool links on a test are not review material', () => {
  const t = { ...mid, review_links: [{ label: 'View', url: 'https://d2l.x/d2l/lms/quizzing/user/quiz_summary.d2l?qi=1&ou=2' }, { label: 'Tool', url: 'https://d2l.x/d2l/common/dialogs/quickLink/quickLink.d2l?ou=2&type=lti&rcode=X' }] };
  assert.equal(G.plan({ tests: [t], files: [], now: NOW }).make.length, 0);
  const v = { ...mid, review_links: [{ label: 'View', url: 'https://d2l.x/d2l/le/content/2/viewContent/9/View' }] };
  assert.equal(G.plan({ tests: [v], files: [], now: NOW }).make.length, 1, 'a content page still counts');
});

test('handouts that are not review material, and exams named for another test, do not count', () => {
  assert.equal(G.plan({ tests: [mid], files: files('Syllabus.pdf', 'Lab 3 handout.pdf', 'Exam 3 Review.pdf', 'Periodic table review.pdf'), now: NOW }).make.length, 0);
});

test('material already seen never makes another set; new material does, after two days', () => {
  const first = G.plan({ tests: [mid], files: files('Midterm Study Guide.pdf'), now: NOW });
  assert.equal(first.make.length, 1);
  assert.equal(G.plan({ tests: [mid], files: files('Midterm Study Guide.pdf'), seen: first.seen, now: NOW + 5 * 864e5 }).make.length, 0);
  const more = files('Midterm Study Guide.pdf', 'Midterm answer key.pdf');
  assert.equal(G.plan({ tests: [mid], files: more, seen: first.seen, now: NOW + 864e5 }).make.length, 0, 'waits two days');
  assert.equal(G.plan({ tests: [mid], files: more, seen: first.seen, now: NOW + 3 * 864e5 }).make.length, 1);
});

test('a set just made for the test (depth review, hint, the student) counts: the material is marked seen', () => {
  const r = G.plan({ tests: [mid], files: files('Midterm Study Guide.pdf'), sets: [{ itemId: 'm1', createdAt: new Date(NOW - 3600e3).toISOString() }], now: NOW });
  assert.equal(r.make.length, 0);
  assert.ok(r.seen.m1.keys.length);
});

test('tests over three weeks away or already past wait', () => {
  assert.equal(G.plan({ tests: [{ ...mid, date: day(30) }, { ...mid, id: 'old', date: day(-1) }], files: files('Midterm Study Guide.pdf'), now: NOW }).make.length, 0);
});
