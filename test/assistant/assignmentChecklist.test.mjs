// The assignment checklist reads length, sources and format from an assignment's text and checks the file live.
// Run: node --test test/assistant/assignmentChecklist.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requirementsFrom, check, wordCount, sourceCount } from '../../src/lib/assignmentChecklist.ts';

const kinds = (list) => list.map((r) => `${r.kind}:${r.n ?? r.text}`);

test('a word range gives a minimum and a maximum', () => {
  const r = requirementsFrom('Write an essay of 500-750 words in MLA format.');
  assert.deepEqual(kinds(r).slice(0, 2), ['min-words:500', 'max-words:750']);
  assert.ok(r.some((x) => x.kind === 'manual' && /MLA/.test(x.text)));
});

test('"at least" and "no more than" are read in words, with commas', () => {
  assert.deepEqual(kinds(requirementsFrom('Use at least 1,200 words.')), ['min-words:1200']);
  assert.deepEqual(kinds(requirementsFrom('Keep it to no more than 800 words.')), ['max-words:800']);
});

test('pages become about 275 words each', () => {
  const r = requirementsFrom('Your paper should be 3-5 pages.');
  assert.equal(r[0].kind, 'min-words');
  assert.ok(r[0].n > 600 && r[0].n < 800);
  assert.ok(r[1].n > 1300 && r[1].n < 1600);
});

test('sources are counted in numbers and in words', () => {
  assert.deepEqual(kinds(requirementsFrom('Cite at least three scholarly sources.')), ['min-sources:3']);
  assert.deepEqual(kinds(requirementsFrom('Use 5 peer-reviewed sources.')), ['min-sources:5']);
  assert.deepEqual(kinds(requirementsFrom('Discuss the reading.')), []);
});

test('the file is checked live: words leave out the Works Cited list, sources are its entries', () => {
  const parts = [
    { label: 'Paragraph 1', text: 'one two three four five six seven eight nine ten' },
    { label: 'Works Cited', text: 'Works Cited' },
    { label: 'Paragraph 3', text: 'Smith, John. A Long Book Title. Press, 2020.' },
    { label: 'Paragraph 4', text: 'Lee, Ann. Another Fine Book. Press, 2021.' }
  ];
  assert.equal(wordCount(parts), 10);
  assert.equal(sourceCount(parts), 2);
  const [min] = requirementsFrom('at least 8 words');
  assert.equal(check(min, parts).done, true);
  const [src] = requirementsFrom('at least 3 sources');
  assert.deepEqual(check(src, parts), { done: false, detail: '2 listed' });
  assert.equal(check({ id: 'x', kind: 'manual', text: 'x' }, parts), null);
});
