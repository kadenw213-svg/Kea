// Google Calendar sync: Kea's events as Google events, and only what changed is sent.
// Run: node --test test/calendar/gcal.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { _test: G } = require('../../electron/gcal.cjs');

test('event ids are stable and use only the characters Google allows', () => {
  const a = G.gid('item:42');
  assert.equal(a, G.gid('item:42'));
  assert.notEqual(a, G.gid('item:43'));
  assert.match(a, /^[0-9a-v]{5,1024}$/);
});

test('all-day events end the next day (Google’s end is exclusive); a due time gets 30 minutes', () => {
  const d = G.toGoogle({ id: 'x', title: 'ENG 102: Essay 2', allDay: true, start: '2026-11-28' });
  assert.deepEqual([d.start.date, d.end.date], ['2026-11-28', '2026-11-29']);
  const t = G.toGoogle({ id: 'y', title: 'Quiz', start: '2026-11-28T06:59:00Z' }, 'America/Denver');
  assert.equal(t.start.dateTime, '2026-11-28T06:59:00Z');
  assert.equal(t.end.dateTime, '2026-11-28T07:29:00Z');
  assert.equal(t.start.timeZone, 'America/Denver');
});

test('notes and the link go in the description', () => {
  const g = G.toGoogle({ id: 'z', title: 'Lab 4', allDay: true, start: '2026-12-01', notes: 'Bring goggles', url: 'https://school.edu/lab4' });
  assert.equal(g.description, 'Bring goggles\n\nhttps://school.edu/lab4');
});

test('only new or changed events are sent, and removed ones are deleted', () => {
  const ev = [
    { id: 'a', title: 'A', allDay: true, start: '2026-12-01' },
    { id: 'b', title: 'B', allDay: true, start: '2026-12-02' }
  ];
  const first = G.diff({}, ev, 'UTC');
  assert.equal(first.upserts.length, 2);
  const same = G.diff(first.next, ev, 'UTC');
  assert.equal(same.upserts.length, 0);
  assert.equal(same.deletes.length, 0);
  const changed = G.diff(first.next, [{ ...ev[0], title: 'A moved' }], 'UTC');
  assert.equal(changed.upserts.length, 1);
  assert.deepEqual(changed.deletes, [G.gid('b')]);
});
