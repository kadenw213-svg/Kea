// Leftover placeholders Claude must never leave in a paper.
// Run: node --test test/assistant/placeholders.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPlaceholders, newPlaceholders, placeholderComment } from '../../src/lib/placeholders.ts';

const quotes = (t) => findPlaceholders(t).map((p) => p.quote);

test('fill-in brackets, TODOs and "add … here" are found', () => {
  assert.deepEqual(quotes('By [Your name]\n[Instructor Name]\nEnglish 101'), ['[Your name]', '[Instructor Name]']);
  assert.deepEqual(quotes('This shows growth [insert source].'), ['[insert source]']);
  assert.deepEqual(quotes('TODO: finish the conclusion'), ['TODO: finish the conclusion']);
  assert.deepEqual(quotes('The war changed everything. Add an example here.'), ['Add an example here']);
  assert.deepEqual(quotes('Dear {{name}},'), ['{{name}}']);
  assert.deepEqual(quotes('The total was XXX dollars.'), ['XXX']);
});

test('real brackets in academic writing are left alone', () => {
  assert.deepEqual(quotes('He wrote "their [sic] house" and "[the city] fell" [1].'), []);
  assert.deepEqual(quotes('“We shall fight […] on the beaches.”'), []);
  assert.deepEqual(quotes('See Table 2 [emphasis added].'), []);
});

test('only placeholders Claude added count, not the student’s own', () => {
  const before = 'Intro. [Your name] TODO: cite';
  const after = 'Intro. [Your name] TODO: cite\nBody [insert statistic].';
  assert.deepEqual(newPlaceholders(before, after).map((p) => p.quote), ['[insert statistic]']);
  assert.deepEqual(newPlaceholders('[Your name]', '[Your name] and [Your name]').length, 1);
});

test('the comment says what is still needed', () => {
  assert.equal(placeholderComment({ quote: '[insert source]', index: 0 }), 'Still to do: insert source. Fill this in yourself, or delete it.');
});
