// When Kea interrupts the student: every alert worth reading.
// Run: node --test test/scholar/alertRules.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const R = require('../../electron/scholar/alertRules.cjs');

test('a grade of 95% or more with no comment is quiet; under 95% pops up', () => {
  assert.equal(R.gradeAlert({ kind: 'grade', percent: 95 }), 'quiet');
  assert.equal(R.gradeAlert({ kind: 'grade', percent: 100 }), 'quiet');
  assert.equal(R.gradeAlert({ kind: 'grade', percent: 94.9 }), 'notify');
  assert.equal(R.gradeAlert({ kind: 'grade', percent: 40 }), 'notify');
});

test('a grade with no percentage pops up (Kea can’t tell it’s high)', () => {
  assert.equal(R.gradeAlert({ kind: 'grade', percent: null }), 'notify');
});

test('instructor comments always pop up, once, as the feedback message', () => {
  assert.equal(R.gradeAlert({ kind: 'feedback', percent: 100, comment: 'Great work' }), 'notify');
  assert.equal(R.gradeAlert({ kind: 'grade', percent: 100, comment: 'Great work' }), 'quiet');
});

test('the threshold can be changed', () => {
  assert.equal(R.gradeAlert({ kind: 'grade', percent: 92 }, 90), 'quiet');
});

test('dropped and finished classes are inactive', () => {
  const s = R.inactiveCodes({
    courses: [
      { code: 'BIO 101', end: '2026-11-01' },
      { code: 'ENG 102', end: '2026-12-15' }
    ],
    withdrawnLog: { c3: { on: true, code: 'MATH 120' }, c4: { on: false, code: 'HIST 110' } },
    today: '2026-11-21'
  });
  assert.deepEqual([...s].sort(), ['BIO 101', 'MATH 120']);
});

test('the same problem is one alert, updated in place; numbers changing don’t make it new', () => {
  const now = new Date('2026-11-21T10:00:00Z');
  let r = R.mergeNews([], { course: 'BIO 101', kind: 'needs_you', title: "Kea couldn't read 3 of BIO 101's documents", body: 'a' }, now);
  assert.equal(r.isNew, true);
  r = R.mergeNews(r.list, { course: 'BIO 101', kind: 'needs_you', title: "Kea couldn't read 4 of BIO 101's documents", body: 'b' }, new Date('2026-11-22T10:00:00Z'));
  assert.equal(r.isNew, false);
  assert.equal(r.list.length, 1);
  assert.equal(r.list[0].count, 2);
  assert.equal(r.list[0].body, 'b');
  assert.equal(r.list[0].at, now.toISOString());
});

test('a resolved problem, or one quiet for a fortnight, comes back as a new alert', () => {
  const n = { course: 'X', kind: 'needs_you', title: 'Sign in to ALEKS' };
  let r = R.mergeNews([], n, new Date('2026-11-01T00:00:00Z'));
  const key = r.item.key;
  const resolved = R.resolveNews(r.list, key);
  assert.equal(R.mergeNews(resolved, n, new Date('2026-11-02T00:00:00Z')).isNew, true);
  assert.equal(R.mergeNews(r.list, n, new Date('2026-11-20T00:00:00Z')).isNew, true);
  assert.equal(R.mergeNews(r.list, n, new Date('2026-11-05T00:00:00Z')).isNew, false);
});

test('missing work: past due, not done, not graded with a score, told once, never for an inactive class', () => {
  const now = new Date(2026, 10, 21, 12, 0);
  const items = [
    { id: 1, type: 'assignment', date: '2026-11-19', courseCode: 'ENG 102' },
    { id: 2, type: 'assignment', date: '2026-11-19', courseCode: 'ENG 102', done: true },
    { id: 3, type: 'assignment', date: '2026-11-19', courseCode: 'ENG 102', handIn: 'graded', handScore: '8/10' },
    { id: 4, type: 'exam', date: '2026-11-19', courseCode: 'ENG 102' },
    { id: 5, type: 'assignment', date: '2026-11-19', courseCode: 'BIO 101' },
    { id: 6, type: 'quiz', date: '2026-11-21', due: '09:00', courseCode: 'ENG 102' },
    { id: 7, type: 'quiz', date: '2026-11-21', due: '23:00', courseCode: 'ENG 102' },
    { id: 8, type: 'assignment', date: '2026-10-01', courseCode: 'ENG 102' },
    { id: 9, type: 'reading', date: '2026-11-18', courseCode: 'ENG 102' }
  ];
  const got = R.missingToTell(items, { told: ['6'], inactive: new Set(['BIO 101']), now });
  assert.deepEqual(got.map((i) => i.id), [1]);
});
