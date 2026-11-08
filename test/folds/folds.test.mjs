// Folding sections (src/lib/folds.ts): on a screen with several, the first starts open and the rest closed; what the
// person opens or closes is kept per screen and section, survives a restart, and nothing else changes it; a closed
// section with something urgent in it still shows its count; a guide's older choices carry over.
//   node --test test/folds/folds.test.mjs
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
let F;
const mem = () => {
  const m = new Map();
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
};
let disk;
before(async () => {
  const out = path.join(os.tmpdir(), `kea-folds-${process.pid}.cjs`);
  await require('esbuild').build({ entryPoints: [path.resolve(here, '../../src/lib/folds.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
  F = require(out);
  fs.rmSync(out, { force: true });
});
beforeEach(() => {
  disk = mem();
  F.setFoldStorage(disk);
});

const open = (screen, id, order) => F.isFoldOpen(F.useFolds.getState().choices, screen, id, F.openByDefault(order, id));

test('only the first section showing starts open', () => {
  const order = ['coming-up', 'classes', 'work'];
  assert.deepEqual(order.map((id) => open('home', id, order)), [true, false, false]);
  // When the first one isn't there, the next one is the first.
  assert.deepEqual(['classes', 'work'].map((id) => open('home', id, ['classes', 'work'])), [true, false]);
  assert.equal(F.openByDefault([], 'x'), false);
});

test('what the person opens or closes is kept, per screen and section, and comes back after a restart', () => {
  const order = ['a', 'b', 'c'];
  F.setFold('home', 'a', false);
  F.setFold('home', 'c', true);
  assert.deepEqual(order.map((id) => open('home', id, order)), [false, false, true]);
  // Another screen with the same section names keeps its own.
  assert.deepEqual(order.map((id) => open('work:certs', id, order)), [true, false, false]);
  // Saved to storage: a fresh read (Kea started again) has the same choices.
  F.setFoldStorage(disk);
  assert.deepEqual(order.map((id) => open('home', id, order)), [false, false, true]);
  assert.equal(JSON.parse(disk.getItem(F.FOLDS_KEY))['home|c'], true);
});

test('a choice wins over a default that changes later (a section appearing above it)', () => {
  F.setFold('item', 'readings', true);
  assert.equal(open('item', 'readings', ['steps', 'readings']), true);
  F.setFold('item', 'steps', false);
  assert.equal(open('item', 'steps', ['steps', 'readings']), false);
});

test('choices stay small: the oldest go first, and changing one makes it the newest', () => {
  let all = {};
  for (let i = 0; i < 5; i++) all = F.withChoices(all, 's', [[`k${i}`, true]], 3);
  assert.deepEqual(Object.keys(all), ['s|k2', 's|k3', 's|k4']);
  all = F.withChoices(all, 's', [['k2', false]], 3);
  all = F.withChoices(all, 's', [['k5', true]], 3);
  assert.deepEqual(Object.keys(all), ['s|k4', 's|k2', 's|k5']);
  assert.equal(all['s|k2'], false);
});

test('a closed section with something overdue or an error still shows it on its header; an open one doesn’t need to', () => {
  assert.equal(F.foldAlert(false, 3), '3');
  assert.equal(F.foldAlert(false, true), '!');
  assert.equal(F.foldAlert(false, 0), null);
  assert.equal(F.foldAlert(false, undefined), null);
  assert.equal(F.foldAlert(true, 3), null);
});

test('a guide’s steps folded before keep their choice, moved into the shared place', () => {
  const d = mem();
  d.setItem('kea.guideFolds', JSON.stringify({ 'item1|Read the handout': false, 'item1|Write it': true }));
  F.setFoldStorage(d);
  const c = F.useFolds.getState().choices;
  assert.equal(F.foldChoice(c, 'guide:item1', 'Read the handout'), false);
  assert.equal(F.foldChoice(c, 'guide:item1', 'Write it'), true);
  assert.equal(d.getItem('kea.guideFolds'), null, 'the old key is gone once moved');
  assert.equal(JSON.parse(d.getItem(F.FOLDS_KEY))['guide:item1|Write it'], true);
});

test('broken or missing storage never stops a screen: everything follows its default', () => {
  const bad = { getItem: () => '{not json', setItem: () => { throw new Error('full'); } };
  F.setFoldStorage(bad);
  assert.equal(open('home', 'a', ['a', 'b']), true);
  F.setFold('home', 'b', true);
  assert.equal(open('home', 'b', ['a', 'b']), true, 'kept for this session even if it can’t be saved');
});
