// Classes withdrawn from (electron/scholar/withdrawn.cjs): a check that failed never marks or suspects anything; a
// class gone from this term's list is only suspected, and asked about from its second day; a W grade marks it; the
// student's own say (and undo) always wins; next term's classes are untouched.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const W = require('../../electron/scholar/withdrawn.cjs');
const TODAY = '2026-11-07';
const courses = [
  { id: 'bio', code: 'BIO111', ou: '101', start: '2026-08-20', end: '2026-12-12' },
  { id: 'chm', code: 'CHM151', ou: '102', start: '2026-08-20', end: '2026-12-12' },
  { id: 'next', code: 'ENG122', ou: '201', start: '2027-01-15', end: '2027-05-10' },
  { id: 'old', code: 'MAT120', ou: '050', start: '2026-01-15', end: '2026-05-10' }
];
const enr = (...ous) => ous.map((ou) => ({ OrgUnit: { Id: Number(ou), Name: ou }, Access: { IsActive: true, CanAccess: true } }));
const made = [];
const tmp = () => (made.push(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-withdrawn-'))), made[made.length - 1]);
after(() => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

test('a check that failed decides nothing: unreadable, empty, or without any current class', () => {
  for (const enrollments of [null, undefined, [], enr('999')]) {
    const a = W.assess({ courses, enrollments, today: TODAY });
    assert.equal(a.failed, true, JSON.stringify(enrollments));
    assert.deepEqual(a.suspect, []);
    assert.deepEqual(a.withdraw, []);
    const dir = tmp();
    W.record(dir, a, TODAY);
    W.record(dir, a, '2026-11-08');
    const v = W.read(dir);
    assert.deepEqual(v.log, {});
    assert.deepEqual(v.suspects, {});
    assert.equal(W.active(dir).size, 0);
  }
});

test('a class gone from this term’s list is only suspected, asked about from its second day, never marked', () => {
  const dir = tmp();
  const a = W.assess({ courses, enrollments: enr('102'), today: TODAY });
  assert.deepEqual(a.suspect.map((s) => s.courseId), ['bio']);
  assert.equal(W.record(dir, a, TODAY).ask.length, 0, 'not on the first day');
  assert.equal(W.record(dir, a, TODAY).ask.length, 0, 'nor twice the same day');
  const r = W.record(dir, a, '2026-11-08');
  assert.deepEqual(r.ask.map((x) => x.courseId), ['bio']);
  assert.equal(W.active(dir).size, 0, 'a suspicion never marks a class');
  // A failed check in between changes nothing; the class listed again is no longer suspected.
  W.record(dir, W.assess({ courses, enrollments: null, today: TODAY }), '2026-11-09');
  assert.equal(W.asking(W.read(dir)).length, 1);
  W.record(dir, W.assess({ courses, enrollments: enr('101', '102'), today: TODAY }), '2026-11-10');
  assert.equal(W.asking(W.read(dir)).length, 0);
});

test('next term’s and last term’s classes are never suspected', () => {
  const a = W.assess({ courses, enrollments: enr('101', '102'), today: TODAY });
  assert.deepEqual(a.suspect, []);
  assert.ok(!a.listed.includes('next') && !a.listed.includes('old'));
});

test('a W grade marks the class; the student’s undo stays undone', () => {
  const dir = tmp();
  const grades = { BIO111: { final: { shown: 'W' } }, CHM151: { final: { shown: 'B (84 %)' } } };
  const a = W.assess({ courses, enrollments: null, grades, today: TODAY });
  assert.deepEqual(a.withdraw.map((w) => w.courseId), ['bio']);
  W.record(dir, a, TODAY);
  assert.equal(W.active(dir).get('bio').by, 'grade');
  assert.ok(!W.active(dir).has('chm'));
  W.set(dir, 'bio', false, 'BIO111');
  W.record(dir, a, '2026-11-08');
  assert.equal(W.active(dir).has('bio'), false);
});

test('the student marks and undoes it; "No, I’m still in it" isn’t asked again for the same reason', () => {
  const dir = tmp();
  W.set(dir, 'chm', true, 'CHM151');
  assert.ok(W.active(dir).has('chm'));
  W.set(dir, 'chm', false, 'CHM151');
  assert.ok(!W.active(dir).has('chm'));
  const a = W.assess({ courses, enrollments: enr('102'), today: TODAY });
  W.record(dir, a, TODAY);
  W.record(dir, a, '2026-11-08');
  W.dismiss(dir, 'bio');
  W.record(dir, a, '2026-11-09');
  W.record(dir, a, '2026-11-10');
  assert.equal(W.asking(W.read(dir)).length, 0);
});

test('another device’s or the phone’s change merges in, the newer one winning', () => {
  const dir = tmp();
  W.set(dir, 'bio', true, 'BIO111', new Date('2026-11-07T10:00:00Z'));
  assert.equal(W.merge(dir, { bio: { on: false, at: '2026-11-07T09:00:00Z' } }), false);
  assert.ok(W.active(dir).has('bio'));
  assert.equal(W.merge(dir, { bio: { on: false, at: '2026-11-07T11:00:00Z' } }), true);
  assert.ok(!W.active(dir).has('bio'));
  assert.equal(W.merge(dir, { '../x': { on: true, at: '2026-11-08T00:00:00Z' } }), false);
});
