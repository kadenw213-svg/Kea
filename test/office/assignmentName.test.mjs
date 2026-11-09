// Naming a new file after its assignment (src/lib/fileNames.ts): only a new, empty, untitled document or
// presentation is named; the title is cleaned for file names; a name already taken is never reused.
//   node --test test/office/assignmentName.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nameForAssignment, isUntitledName, isEmptyContent, uniqueName, safeFileName, untitledName } from '../../src/lib/fileNames.ts';

const base = { kind: 'doc', name: 'Untitled document', hasPath: false, empty: true, title: 'Essay 2: Argument', taken: [] };

test('an empty, untitled document is named after the assignment, cleaned for file names', () => {
  assert.equal(nameForAssignment(base), 'Essay 2 Argument');
  assert.equal(nameForAssignment({ ...base, title: 'Lab 9 / Buffers? <final>' }), 'Lab 9 Buffers final');
  assert.equal(nameForAssignment({ ...base, title: '  Reflection.  ' }), 'Reflection');
  // Long titles stop at a word, about 60 characters.
  const long = nameForAssignment({ ...base, title: 'A very long assignment title that goes on and on well past what a file name should hold' });
  assert.ok(long.length <= 60 && !long.endsWith(' '));
});

test('a name an open file or a saved file already has isn’t reused', () => {
  assert.equal(nameForAssignment({ ...base, title: 'Essay 2', taken: ['Essay 2.docx'] }), 'Essay 2 2');
  assert.equal(nameForAssignment({ ...base, title: 'Essay 2', taken: ['essay 2', 'Essay 2 2.docx'] }), 'Essay 2 3');
  // A dot in the title isn't taken for an extension.
  assert.equal(uniqueName('Lab 2.1', ['Lab 2']), 'Lab 2.1');
});

test('presentations too (Slides parity), with only the starting slide’s prompts counting as empty', () => {
  const deck = { ...base, kind: 'slides', name: 'Untitled presentation 2' };
  assert.equal(nameForAssignment(deck), 'Essay 2 Argument');
  assert.equal(isEmptyContent('slides', [{ text: 'Slide 1:\nClick to add title\nClick to add subtitle' }]), true);
  assert.equal(isEmptyContent('slides', [{ text: 'Slide 1:\nMy talk\nClick to add subtitle' }]), false);
  assert.equal(isEmptyContent('slides', [{ text: 'Slide 1:\nClick to add title' }, { text: 'Slide 2:\n' }]), false);
});

test('no rename: a file with a name, a place on disk, or content keeps its name', () => {
  assert.equal(nameForAssignment({ ...base, name: 'My notes' }), null);
  assert.equal(nameForAssignment({ ...base, hasPath: true }), null);
  assert.equal(nameForAssignment({ ...base, empty: false }), null);
  assert.equal(nameForAssignment({ ...base, kind: 'sheet', name: 'Untitled spreadsheet' }), null);
  assert.equal(nameForAssignment({ ...base, title: '???' }), null);
  assert.equal(isEmptyContent('doc', [{ text: 'Hello' }]), false);
  assert.equal(isEmptyContent('doc', []), true);
});

test('untitled names are recognised the way new files are named', () => {
  assert.equal(isUntitledName('doc', untitledName('doc', [])), true);
  assert.equal(isUntitledName('doc', untitledName('doc', ['Untitled document'])), true);
  assert.equal(isUntitledName('slides', 'Untitled presentation 12'), true);
  assert.equal(isUntitledName('doc', 'Untitled document draft'), false);
  assert.equal(isUntitledName('doc', 'Untitled presentation'), false);
  assert.equal(safeFileName('a:b'), 'a b');
});
