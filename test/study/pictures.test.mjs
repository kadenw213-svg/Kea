// Picture questions in every chapter (Kea 0.108): the share each chapter's saved questions keep (study.cjs
// picturesShort), and which alerts pop up (alertRules.cjs popsUp). Run: node --test test/study/pictures.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const study = require('../../electron/scholar/study.cjs');
const R = require('../../electron/scholar/alertRules.cjs');

const shareAfter = (total, pictured, identifying) => {
  const add = study.picturesShort(total, pictured, identifying);
  return (pictured + add) / (total + add);
};

test('every chapter reaches at least 15% picture questions (25% where tests identify things); none asked for once it has them', () => {
  for (const total of [10, 25, 50, 100, 300])
    for (const pictured of [0, 1, 5, 12]) {
      if (pictured > total) continue;
      assert.ok(shareAfter(total, pictured, false) >= 0.15 - 1e-9, `${pictured}/${total}`);
      assert.ok(shareAfter(total, pictured, true) >= 0.25 - 1e-9, `${pictured}/${total} identifying`);
    }
  assert.equal(study.picturesShort(50, 0, false), 9, '9 more pictures make 9 of 59 (15.3%)');
  assert.equal(study.picturesShort(100, 15, false), 0);
  assert.equal(study.picturesShort(100, 30, true), 0);
  assert.equal(study.picturesShort(6, 0, false), 0, 'a chapter with almost no questions waits for its bank first');
});

test('only messages, missing work, grades and real problems pop up; Kea’s own work is filed quietly', () => {
  for (const kind of ['message', 'missed', 'grade', 'feedback']) assert.equal(R.popsUp({ kind }), true, kind);
  for (const kind of ['study', 'update', 'needs_you', 'attention', 'announcement', 'news']) assert.equal(R.popsUp({ kind }), false, kind);
  assert.equal(R.popsUp({ kind: 'update', urgent: true }), true);
  assert.equal(R.isFiled({ kind: 'study' }), true);
  // A filed alert arrives read, and a repeat keeps it read.
  const a = R.mergeNews([], { course: 'BIO1112', kind: 'study', title: 'new practice for Midterm 2', read: true });
  assert.equal(a.item.read, true);
  const b = R.mergeNews(a.list, { course: 'BIO1112', kind: 'study', title: 'new practice for Midterm 2', body: 'changed', read: true });
  assert.equal(b.item.read, true);
  assert.equal(b.isNew, false);
});
