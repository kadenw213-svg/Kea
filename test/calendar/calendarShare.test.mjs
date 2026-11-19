// What Kea sends to the calendar link: each Calendar item as one feed event (docs/protocol.md, "Calendar link" in KeaC).
// Run: node --test test/calendar/calendarShare.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('../worker/electronStub.cjs');
const { toEvent, _test } = require('../../electron/calendarShare.cjs');

test('work due at a time is a point in time, on this computer\'s clock, sent as a UTC instant', () => {
  const e = toEvent({ id: 'a1', courseCode: 'BIO111', type: 'assignment', title: 'Lab 4 Report', date: '2026-11-20', due: '23:59', start: null, end: null, links: [{ url: 'https://school.example/dropbox/4' }] });
  assert.equal(e.title, 'BIO111: Lab 4 Report');
  assert.equal(e.kind, 'Assignment');
  assert.equal(e.url, 'https://school.example/dropbox/4');
  assert.equal(e.start, _test.instant('2026-11-20', '23:59'));
  assert.match(e.start, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(e.allDay, undefined);
  assert.equal(e.end, undefined);
});

test('a class meeting has its start and end', () => {
  const e = toEvent({ id: 'c1', courseCode: 'CHEM101', type: 'lecture', title: 'Lecture', date: '2026-11-19', start: '09:00', end: '09:50', location: 'Science 210' });
  assert.equal(e.start, _test.instant('2026-11-19', '09:00'));
  assert.equal(e.end, _test.instant('2026-11-19', '09:50'));
  assert.equal(e.location, 'Science 210');
});

test('an item with no time is an all-day event, with its last day when it runs several', () => {
  const day = toEvent({ id: 'b1', type: 'break', title: 'Fall break', date: '2026-11-25', dateEnd: '2026-11-27' });
  assert.deepEqual([day.allDay, day.start, day.end], [true, '2026-11-25', '2026-11-27']);
  assert.equal(toEvent({ id: 'b2', type: 'exam', title: 'Exam 1', date: '2026-12-02' }).allDay, true);
});

test('done work, other people\'s odd data and unreadable items are left out', () => {
  assert.equal(toEvent({ id: 'd', title: 'Done', date: '2026-11-20', done: true }), null);
  assert.equal(toEvent({ id: 'w', title: 'Dropped class', date: '2026-11-20', withdrawn: true }), null);
  assert.equal(toEvent({ id: 'n', title: '', date: '2026-11-20' }), null);
  assert.equal(toEvent({ id: 'x', title: 'No date' }), null);
  assert.equal(toEvent(null), null);
});

test('ids are made safe for the server and links must be https', () => {
  const e = toEvent({ id: 'work:org 1/shift#7', title: 'Shift', date: '2026-11-20', start: '08:00', end: '16:00', links: [{ url: 'http://insecure.example' }] });
  assert.match(e.id, /^[\w.:@+-]+$/);
  assert.equal(e.url, undefined);
  assert.equal(toEvent({ id: 'k', courseCode: 'BIO111', title: 'BIO111 Quiz 2', date: '2026-11-20' }).title, 'BIO111 Quiz 2', 'the code is not added twice');
});
