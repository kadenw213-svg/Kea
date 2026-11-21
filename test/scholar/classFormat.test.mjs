// A class's paper format from its syllabus: only what the text says.
// Run: node --test test/scholar/classFormat.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const F = require('../../electron/scholar/classFormat.cjs');

test('a typical syllabus paragraph', () => {
  const f = F.formatFromText('All papers must be typed in Times New Roman, 12-point font, double-spaced with 1-inch margins, and follow MLA format (9th edition).');
  assert.deepEqual([f.style, f.font, f.sizePt, f.lineHeight, f.margins], ['mla', 'Times New Roman', 12, 2, 1]);
  assert.ok(f.quotes.length >= 3);
  assert.equal(F.describe(f), 'MLA, Times New Roman 12 pt, double-spaced, 1-inch margins');
});

test('APA and Chicago are recognised; a syllabus naming two styles decides nothing about style', () => {
  assert.equal(F.formatFromText('Cite your sources using APA style.').style, 'apa');
  assert.equal(F.formatFromText('Use the Chicago Manual of Style for notes.').style, 'chicago');
  const both = F.formatFromText('Papers may use MLA format or APA format, single-spaced.');
  assert.equal(both.style, undefined);
  assert.equal(both.lineHeight, 1);
});

test('nothing said, nothing taken', () => {
  assert.equal(F.formatFromText('Office hours are Tuesdays at 2 PM in room 104.'), null);
  assert.equal(F.formatFromText('We will read the APA chapter on statistics.'), null);
});

test('several documents: the first to say each thing wins', () => {
  const f = F.merge([
    { title: 'Syllabus', text: 'Use MLA format.' },
    { title: 'Essay guidelines', text: 'Arial 11 pt, 1.5 spacing is not allowed; use double spacing.' }
  ]);
  assert.deepEqual([f.style, f.font, f.sizePt, f.lineHeight], ['mla', 'Arial', 11, 2]);
});
