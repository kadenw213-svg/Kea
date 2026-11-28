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

// (Every test now gets a review even with no material: `test|<id>`. A test that already has a set counts it seen.)
const has = (id) => [{ id: `s-${id}`, itemId: id, status: 'ready', createdAt: new Date(NOW - 5 * 864e5).toISOString() }];
const material = (r, id) => r.make.find((m) => m.test.id === id)?.fresh.filter((k) => !k.startsWith('test|'));

test('a midterm study guide with no chapter number makes a set for the midterm only', () => {
  const r = G.plan({ tests: [mid, fin], files: files('Midterm Study Guide.pdf.txt'), sets: [...has('m1'), ...has('f1')], now: NOW });
  assert.deepEqual(r.make.map((m) => m.test.id), ['m1']);
  assert.deepEqual(r.make[0].fresh, ['file|data/downloads/BIO111/Midterm Study Guide.pdf']);
});

test('a final review sheet makes a set for the final, even with no chapters known', () => {
  const r = G.plan({ tests: [mid, fin], files: files('Final Review.docx'), sets: [...has('m1'), ...has('f1')], now: NOW });
  assert.deepEqual(r.make.map((m) => m.test.id), ['f1']);
});

test('a chapter review sheet goes to the test that covers that chapter', () => {
  assert.deepEqual(G.plan({ tests: [mid, fin], files: files('Ch 2 Review.pdf'), sets: [...has('m1'), ...has('f1')], now: NOW }).make.map((m) => m.test.id), ['m1']);
  assert.equal(G.plan({ tests: [mid], files: files('Ch 9 Review.pdf'), sets: has('m1'), now: NOW }).make.length, 0);
});

test('links and a study focus posted on the test count', () => {
  const t = { ...mid, review_links: [{ label: 'Study guide', url: 'https://x/sg' }], study_focus: ['Know mitosis'] };
  assert.equal(material(G.plan({ tests: [t], files: [], sets: has('m1'), now: NOW }), 'm1').length, 2);
});

test('tests named every way schools name them', () => {
  const fits = G._test.fileFits;
  const t = (title, type = 'exam') => ({ title, type, chapters: [] });
  assert.ok(fits('Exam II Study Guide.pdf', t('Exam 2')));
  assert.ok(fits('exam_2_review.docx', t('Exam II: Cells')));
  assert.ok(!fits('Exam 3 Review.pdf', t('Exam 2')));
  assert.ok(fits('Test #4 practice problems.pdf', t('Test 4')));
  assert.ok(fits('Unit 3 Review.pdf', t('Unit 3 Test')));
  assert.ok(fits('Module 4 Study Guide.pdf', t('Module 4 Exam')));
  assert.ok(fits('Lab Practical II Study Guide.pdf', t('Lab Practical 2', 'lab_practical')));
  assert.ok(fits('Midterm Study Guide.pdf', t('Midterm 1', 'midterm')));
  assert.ok(!fits('Midterm 2 Review.pdf', t('Midterm 1', 'midterm')));
  assert.ok(fits('Final Exam Review.pptx', t('Cumulative Final', 'final_exam')));
  assert.ok(fits('Final Review.pdf', t('Exam 5', 'final_exam')), 'the final, by its type');
});

test('a quiz’s results page and tool links on a test are not review material', () => {
  const t = { ...mid, review_links: [{ label: 'View', url: 'https://d2l.x/d2l/lms/quizzing/user/quiz_summary.d2l?qi=1&ou=2' }, { label: 'Tool', url: 'https://d2l.x/d2l/common/dialogs/quickLink/quickLink.d2l?ou=2&type=lti&rcode=X' }] };
  assert.equal(G.plan({ tests: [t], files: [], sets: has('m1'), now: NOW }).make.length, 0);
  const v = { ...mid, review_links: [{ label: 'View', url: 'https://d2l.x/d2l/le/content/2/viewContent/9/View' }] };
  assert.equal(G.plan({ tests: [v], files: [], sets: has('m1'), now: NOW }).make.length, 1, 'a content page still counts');
});

test('handouts that are not review material, and exams named for another test, do not count', () => {
  assert.equal(G.plan({ tests: [mid], files: files('Syllabus.pdf', 'Lab 3 handout.pdf', 'Exam 3 Review.pdf', 'Periodic table review.pdf'), sets: has('m1'), now: NOW }).make.length, 0);
});

test('material already seen never makes another set; new material does, once the last set is 12 hours old', () => {
  const f1 = files('Midterm Study Guide.pdf');
  const first = G.plan({ tests: [mid], files: f1, now: NOW });
  assert.equal(first.make.length, 1);
  assert.deepEqual(first.seen, {}, 'nothing is seen until the set is asked for');
  const seen = G.record(first.seen, 'm1', first.make[0].record, 's1');
  const made = [{ id: 's1', itemId: 'm1', status: 'ready', createdAt: new Date(NOW).toISOString() }];
  assert.equal(G.plan({ tests: [mid], files: f1, seen, sets: made, now: NOW + 5 * 864e5 }).make.length, 0);
  const more = files('Midterm Study Guide.pdf', 'Midterm answer key.pdf');
  assert.equal(G.plan({ tests: [mid], files: more, seen, sets: made, now: NOW + 3600e3 }).make.length, 0, 'waits after a set');
  assert.equal(G.plan({ tests: [mid], files: more, seen, sets: made, now: NOW + 13 * 3600e3 }).make.length, 1);
});

test('a set just made for the test (depth review, hint, the student) holds new material back until later, still new', () => {
  const sets = [{ id: 'x', itemId: 'm1', status: 'ready', createdAt: new Date(NOW - 3600e3).toISOString() }];
  const r = G.plan({ tests: [mid], files: files('Midterm Study Guide.pdf'), sets, now: NOW });
  assert.equal(r.make.length, 0);
  assert.equal(G.plan({ tests: [mid], files: files('Midterm Study Guide.pdf'), seen: r.seen, sets, now: NOW + 864e5 }).make.length, 1, 'made later');
});

test('nothing while a set for the test is being made', () => {
  const sets = [{ id: 'x', itemId: 'm1', status: 'making', createdAt: new Date(NOW - 5 * 864e5).toISOString() }];
  assert.equal(G.plan({ tests: [mid], files: files('Midterm Study Guide.pdf'), sets, now: NOW }).make.length, 0);
});

test('tests over 30 days away or already past wait', () => {
  assert.equal(G.plan({ tests: [{ ...mid, date: day(31) }, { ...mid, id: 'old', date: day(-1) }], files: files('Midterm Study Guide.pdf'), now: NOW }).make.length, 0);
  assert.equal(G.plan({ tests: [{ ...mid, date: day(29) }], files: [], now: NOW }).make.length, 1);
});

test('every quiz and exam gets a review, even with no study guide; one with a set already does not', () => {
  const quiz = { id: 'q1', title: 'Quiz 4', type: 'quiz', date: day(3), chapters: ['Chapter 4'], review_links: [], study_focus: [] };
  const r = G.plan({ tests: [mid, quiz], files: [], now: NOW });
  assert.deepEqual(r.make.map((m) => m.test.id), ['q1', 'm1'], 'soonest first');
  assert.deepEqual(r.make[0].fresh, ['test|q1']);
  assert.equal(G.plan({ tests: [mid], files: [], sets: has('m1'), now: NOW }).make.length, 0);
  assert.match(G.newsFor('BIO111', quiz, ['test|q1']).title, /a review for Quiz 4/);
  assert.ok(G.countFor(quiz) < G.countFor(mid), 'a quiz gets a shorter review');
});

test('at most two new sets per class per pass', () => {
  const many = [1, 2, 3, 4].map((n) => ({ id: `q${n}`, title: `Quiz ${n}`, type: 'quiz', date: day(n), chapters: [], review_links: [], study_focus: [] }));
  assert.equal(G.plan({ tests: many, files: [], now: NOW }).make.length, 2);
});

test('a set that failed gives its material back, tried again after six hours', () => {
  const f1 = files('Midterm Study Guide.pdf');
  const first = G.plan({ tests: [mid], files: f1, now: NOW });
  const seen = G.record(first.seen, 'm1', first.make[0].record, 's1');
  const failed = [{ id: 's1', itemId: 'm1', status: 'failed', createdAt: new Date(NOW).toISOString() }];
  assert.equal(G.plan({ tests: [mid], files: f1, seen, sets: failed, now: NOW + 3600e3 }).make.length, 0, 'waits');
  const again = G.plan({ tests: [mid], files: f1, seen, sets: failed, now: NOW + 7 * 3600e3 });
  assert.equal(again.make.length, 1);
  assert.ok(again.make[0].fresh.includes('file|data/downloads/BIO111/Midterm Study Guide.pdf'));
});

test('a re-uploaded study guide with new content is new; one seen before Kea kept sizes is not', () => {
  const sized = (bytes) => [{ path: 'data/downloads/BIO111/Midterm Study Guide.pdf.txt', docBytes: bytes }];
  const first = G.plan({ tests: [mid], files: sized(1000), now: NOW });
  assert.deepEqual(first.make[0].fresh, ['test|m1', 'file|data/downloads/BIO111/Midterm Study Guide.pdf|1000']);
  const seen = G.record(first.seen, 'm1', first.make[0].record, 's1');
  const made = [{ id: 's1', itemId: 'm1', status: 'ready', createdAt: new Date(NOW).toISOString() }];
  assert.equal(G.plan({ tests: [mid], files: sized(1000), seen, sets: made, now: NOW + 864e5 }).make.length, 0);
  assert.equal(G.plan({ tests: [mid], files: sized(2400), seen, sets: made, now: NOW + 864e5 }).make.length, 1);
  const old = { m1: { keys: ['file|data/downloads/BIO111/Midterm Study Guide.pdf'], at: NOW - 864e5 } };
  assert.equal(G.plan({ tests: [mid], files: sized(1000), seen: old, sets: made, now: NOW + 864e5 }).make.length, 0);
});
