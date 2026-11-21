// Personal events on the Kea calendar: repeating, reminding, shown beside classes.
// Run: node --test test/calendar/personalEvents.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { _test: P } = require('../../electron/personalEvents.cjs');

test('an event needs a name and a date; times are kept only when it isn’t all day', () => {
  assert.throws(() => P.clean({ date: '2026-12-01' }), /name/);
  assert.throws(() => P.clean({ title: 'Dentist' }), /date/);
  const e = P.clean({ title: 'Dentist', date: '2026-12-01', allDay: false, start: '14:30', end: '15:00', remind: [60] });
  assert.equal(e.allDay, false);
  assert.equal(e.start, '14:30');
  assert.deepEqual(e.remind, [60]);
  assert.equal(P.clean({ title: 'Mom’s birthday', date: '1970-03-04' }).allDay, true);
});

test('a birthday repeats every year, found quickly however long ago it started', () => {
  const e = P.clean({ title: 'Mom’s birthday', date: '1970-03-04', repeat: 'yearly' });
  assert.deepEqual(P.occurrences(e, '2026-01-01', '2027-12-31'), ['2026-03-04', '2027-03-04']);
});

test('monthly on the 31st falls on the last day of short months; Feb 29 yearly on Feb 28', () => {
  const bill = P.clean({ title: 'Rent', date: '2026-01-31', repeat: 'monthly' });
  assert.deepEqual(P.occurrences(bill, '2026-01-01', '2026-04-30'), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  const leap = P.clean({ title: 'Leap', date: '2024-02-29', repeat: 'yearly' });
  assert.deepEqual(P.occurrences(leap, '2025-01-01', '2025-12-31'), ['2025-02-28']);
});

test('every few years (a recertification), weekly, until a date, and one-off', () => {
  const cert = P.clean({ title: 'CPR recertification', date: '2025-06-10', repeat: 'years', every: 2 });
  assert.deepEqual(P.occurrences(cert, '2026-01-01', '2031-12-31'), ['2027-06-10', '2029-06-10', '2031-06-10']);
  const gym = P.clean({ title: 'Gym', date: '2026-11-02', repeat: 'weekly', until: '2026-11-20' });
  assert.deepEqual(P.occurrences(gym, '2026-11-01', '2026-12-31'), ['2026-11-02', '2026-11-09', '2026-11-16']);
  const once = P.clean({ title: 'Party', date: '2026-11-28' });
  assert.deepEqual(P.occurrences(once, '2026-11-01', '2026-11-30'), ['2026-11-28']);
  assert.deepEqual(P.occurrences(once, '2026-12-01', '2026-12-31'), []);
});

test('each occurrence is a calendar item of its own', () => {
  const items = P.toItems([P.clean({ id: 'b1', title: 'Birthday', date: '2000-11-25', repeat: 'yearly' })], '2026-11-01', '2026-11-30');
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'personal:b1:2026-11-25');
  assert.equal(items[0].type, 'personal');
});

test('reminders fire once, ahead of time', () => {
  const e = P.clean({ id: 'd1', title: 'Dentist', date: '2026-12-01', allDay: false, start: '14:30', remind: [60 * 24] });
  const before = new Date(2026, 10, 30, 14, 0);
  const at = new Date(2026, 10, 30, 14, 31);
  assert.equal(P.dueReminders([e], new Set(), before).length, 0);
  const due = P.dueReminders([e], new Set(), at);
  assert.equal(due.length, 1);
  assert.equal(P.dueReminders([e], new Set([due[0].key]), at).length, 0);
});
