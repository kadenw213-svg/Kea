// Adding files straight from Google Drive to a context folder (Kea 0.108.1): the Drive searches behind each view, what
// each kind of Drive file becomes, safe file names, and the plain message when Kea's Google project has Drive off.
// Run: node --test test/office/driveBrowser.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('../worker/electronStub.cjs');
const g = require('../../electron/google.cjs')._drive;

test('each view of the Drive browser asks Drive the right thing', () => {
  assert.deepEqual(g.listQuery({}), { q: "'root' in parents and trashed = false", orderBy: 'folder,name_natural' });
  assert.match(g.listQuery({ view: 'shared' }).q, /sharedWithMe = true/);
  assert.match(g.listQuery({ view: 'recent' }).orderBy, /viewedByMeTime desc/);
  assert.equal(g.listQuery({ folderId: "abc'; drop" }).q, "'abcdrop' in parents and trashed = false", 'a folder id is only letters, digits, - and _');
  const s = g.listQuery({ view: 'shared', folderId: 'x', query: "Bio lab's guide" });
  assert.equal(s.q, String.raw`(name contains 'Bio lab\'s guide' or fullText contains 'Bio lab\'s guide') and trashed = false`, 'a search wins, quotes escaped');
  assert.equal(s.orderBy, '', 'Drive can’t sort a full-text search');
});

test('Docs, Sheets and Slides are read live; folders open; other Google types are refused; anything else is a file', () => {
  assert.equal(g.kindOfMime('application/vnd.google-apps.document'), 'doc');
  assert.equal(g.kindOfMime('application/vnd.google-apps.spreadsheet'), 'sheet');
  assert.equal(g.kindOfMime('application/vnd.google-apps.presentation'), 'slides');
  assert.equal(g.kindOfMime('application/vnd.google-apps.folder'), 'folder');
  assert.equal(g.kindOfMime('application/vnd.google-apps.form'), 'other-google');
  assert.equal(g.kindOfMime('application/pdf'), 'file');
});

test('Drive names become safe Windows file names', () => {
  assert.equal(g.safeName('Unit 3: Cells / Review?.pdf'), 'Unit 3_ Cells _ Review_.pdf');
  assert.equal(g.safeName('notes. '), 'notes');
  assert.equal(g.safeName(''), 'Google file');
});

test('“Drive API not enabled” is recognized, so it is said plainly instead of Google’s console text', () => {
  assert.ok(g.API_OFF.test('Google Drive API has not been used in project 1081543013838 before or it is disabled. Enable it by visiting …'));
  assert.ok(!g.API_OFF.test('File not found: 1abc'));
});
