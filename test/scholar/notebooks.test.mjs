// Study notebooks (electron/scholar/notebooks.cjs): plain .md files in one folder, listed newest first, saved and read
// back exactly, renamed, and never anywhere outside that folder whatever name is asked for.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const N = require('../../electron/scholar/notebooks.cjs');
const made = [];
const tmp = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-notebooks-'));
  made.push(root);
  return path.join(root, 'study', 'Notebooks');
};
after(() => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

test('an empty or missing folder lists nothing', () => {
  assert.deepEqual(N.list(tmp()), []);
});

test('create makes an empty <name>.md, and a second with the same name is refused', () => {
  const dir = tmp();
  const r = N.create(dir, '  Biology ch 4 (cells)  ');
  assert.equal(r.name, 'Biology ch 4 (cells)');
  assert.equal(r.file, path.join(path.resolve(dir), 'Biology ch 4 (cells).md'));
  assert.equal(fs.readFileSync(r.file, 'utf8'), '');
  assert.throws(() => N.create(dir, 'Biology ch 4 (cells)'), /already a notebook/);
});

test('write then read gives back exactly the text, and the file on disk matches', () => {
  const dir = tmp();
  N.create(dir, 'Notes');
  const text = '# Chapter 4\n\n- mitochondria: ATP\n- ask: why is the Krebs cycle a cycle?\n\u00e9\u00e8 \u2713\n';
  const w = N.write(dir, 'Notes', text);
  assert.equal(N.read(dir, 'Notes'), text);
  assert.equal(fs.readFileSync(w.file, 'utf8'), text);
  // (No temporary file left behind.)
  assert.deepEqual(fs.readdirSync(dir), ['Notes.md']);
});

test('write makes the notebook (and its folder) when it is not there; read of a missing one is empty', () => {
  const dir = tmp();
  assert.equal(N.read(dir, 'Nothing yet'), '');
  N.write(dir, 'Fresh', 'hello');
  assert.equal(N.read(dir, 'Fresh'), 'hello');
});

test('list is newest change first and only .md files', () => {
  const dir = tmp();
  N.create(dir, 'Old');
  N.create(dir, 'Newer');
  fs.writeFileSync(path.join(dir, 'other.txt'), 'x');
  fs.mkdirSync(path.join(dir, 'sub.md'));
  const t = Date.now() / 1000;
  fs.utimesSync(path.join(dir, 'Old.md'), t - 100, t - 100);
  fs.utimesSync(path.join(dir, 'Newer.md'), t - 50, t - 50);
  assert.deepEqual(N.list(dir).map((x) => x.name), ['Newer', 'Old']);
  N.write(dir, 'Old', 'changed');
  assert.deepEqual(N.list(dir).map((x) => x.name), ['Old', 'Newer']);
});

test('rename moves the file and keeps the text; a taken name or a missing notebook is refused', () => {
  const dir = tmp();
  N.write(dir, 'First', 'one');
  N.write(dir, 'Second', 'two');
  const r = N.rename(dir, 'First', 'Renamed (exam 2)');
  assert.equal(r.name, 'Renamed (exam 2)');
  assert.equal(N.read(dir, 'Renamed (exam 2)'), 'one');
  assert.equal(fs.existsSync(path.join(dir, 'First.md')), false);
  assert.throws(() => N.rename(dir, 'Renamed (exam 2)', 'Second'), /already a notebook/);
  assert.throws(() => N.rename(dir, 'Gone', 'Whatever'), /no notebook called/);
  assert.equal(N.read(dir, 'Second'), 'two');
  // (Only the capitals changing is fine.)
  N.rename(dir, 'Second', 'SECOND');
  assert.equal(N.read(dir, 'SECOND'), 'two');
});

test('bad names are refused everywhere and nothing is written outside the folder', () => {
  const dir = tmp();
  const bad = ['', '   ', '../escape', '..', 'a/b', 'a\\b', 'C:\\x', 'name.', '.hidden', 'two..dots', 'what?', 'star*', 'tab\there', 'line\nbreak', 'x'.repeat(81), 'CON', 'nul.txt', 'com1', 'émoji'];
  for (const name of bad) {
    assert.throws(() => N.create(dir, name), Error, `create ${JSON.stringify(name)}`);
    assert.throws(() => N.write(dir, name, 'x'), Error, `write ${JSON.stringify(name)}`);
    assert.throws(() => N.read(dir, name), Error, `read ${JSON.stringify(name)}`);
    assert.throws(() => N.fileOf(dir, name), Error, `fileOf ${JSON.stringify(name)}`);
  }
  N.write(dir, 'Good', 'x');
  for (const name of bad) assert.throws(() => N.rename(dir, 'Good', name), Error, `rename to ${JSON.stringify(name)}`);
  assert.throws(() => N.rename(dir, '../Good', 'Fine'), Error);
  // Only Good.md was ever made, and nothing next to the folder.
  assert.deepEqual(fs.readdirSync(dir), ['Good.md']);
  assert.deepEqual(fs.readdirSync(path.dirname(dir)), ['Notebooks']);
  // 80 characters is still fine.
  assert.equal(N.create(dir, 'y'.repeat(80)).name.length, 80);
});

test('a notebook too big to save is refused and the old text kept', () => {
  const dir = tmp();
  N.write(dir, 'Big', 'small');
  assert.throws(() => N.write(dir, 'Big', 'x'.repeat(5 * 1024 * 1024 + 1)), /too big/);
  assert.equal(N.read(dir, 'Big'), 'small');
});
