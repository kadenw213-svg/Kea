// A school template's heading is filled from the class once the document is linked to an assignment, and a saved file
// with a name Kea gave it is renamed after the assignment.
// Run: node --test test/office/templateFields.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classFieldReplacements, GENERIC_NAME } from '../../src/lib/fileNames.ts';

test('the course and instructor lines are filled; nothing for what Kea doesn’t know', () => {
  assert.deepEqual(classFieldReplacements({ course: 'ENG 102', courseName: 'Composition II', instructor: 'Dr. Rivera' }), [
    ['Course Number: Course Name', 'ENG 102: Composition II'],
    ['Course Name', 'Composition II'],
    ['Instructor Name', 'Dr. Rivera']
  ]);
  assert.deepEqual(classFieldReplacements({ course: 'ENG 102', courseName: '', instructor: '' }), [
    ['Course Number: Course Name', 'ENG 102'],
    ['Course Name', 'ENG 102']
  ]);
});

test('only names Kea or a template gave are generic', () => {
  for (const n of ['Untitled', 'Untitled document', 'Document 3', 'MLA essay', 'APA paper (2)', 'document']) assert.ok(GENERIC_NAME.test(n), n);
  for (const n of ['My Gatsby essay', 'Essay on Hamlet', 'Lab 4 notes']) assert.ok(!GENERIC_NAME.test(n), n);
});
