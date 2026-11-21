// The Claude tab's "Due in N days" under the selected assignment.
// Run: node --test test/assistant/dueDate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daysUntil, dueText } from '../../src/lib/dueDate.ts';

const now = new Date(2026, 10, 21, 23, 30); // Nov 21, late evening

test('counts whole calendar days, whatever the time of day', () => {
  assert.equal(daysUntil('2026-11-21', now), 0);
  assert.equal(daysUntil('2026-11-22', now), 1);
  assert.equal(daysUntil('2026-11-28', now), 7);
  assert.equal(daysUntil('2026-11-19', now), -2);
});

test('crosses months and years', () => {
  assert.equal(daysUntil('2026-12-01', now), 10);
  assert.equal(daysUntil('2027-01-01', now), 41);
});

test('plain wording', () => {
  assert.equal(dueText(0), 'Due today');
  assert.equal(dueText(1), 'Due tomorrow');
  assert.equal(dueText(5), 'Due in 5 days');
  assert.equal(dueText(-1), 'Was due yesterday');
  assert.equal(dueText(-3), 'Was due 3 days ago');
});
