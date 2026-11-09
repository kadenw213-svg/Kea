// Claude's slide edits in the background (src/editors/slides/slideTrack.ts): the person stays on their slide when
// Claude adds, moves or deletes others, the box they're typing in is never changed under them, and what Claude
// changed is known so it can glow briefly.
//   node --test test/office/slideTrack.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexOfView, keepSelected, touchesElement, changedParts } from '../../src/editors/slides/slideTrack.ts';

const el = (id, html = '') => ({ id, html });
const slide = (id, els = [], notes = '') => ({ id, els, notes, bg: '#fff' });

test('the person stays on their slide when Claude adds one before it', () => {
  const a = slide('a'), b = slide('b'), c = slide('c');
  const before = [a, b, c];
  assert.equal(indexOfView(before, 'b', 1), 1);
  const after = [a, slide('new'), b, c];
  assert.equal(indexOfView(after, 'b', 1), 2);
});

test('… and when Claude moves slides around it', () => {
  const s = ['a', 'b', 'c', 'd'].map((x) => slide(x));
  const moved = [s[3], s[0], s[1], s[2]];
  assert.equal(indexOfView(moved, 'c', 2), 3);
});

test('if their slide is deleted they land where it was', () => {
  const s = ['a', 'b', 'c'].map((x) => slide(x));
  assert.equal(indexOfView([s[0], s[2]], 'b', 1), 1);
  assert.equal(indexOfView([s[0]], 'c', 2), 0);
});

test('their selection stays while the element is still on their slide', () => {
  const s = [slide('a', [el('t1'), el('t2')])];
  assert.equal(keepSelected(s, 0, 't2'), 't2');
  assert.equal(keepSelected([slide('a', [el('t1')])], 0, 't2'), null);
});

test('a change to the box being typed in is caught (so Claude leaves it alone)', () => {
  const typing = el('t1', '<p>Hel</p>');
  const other = el('t2', '<p>Other</p>');
  const before = [slide('a', [typing, other])];
  // Claude changes another box on the same slide: fine.
  const ok = [slide('a', [typing, { ...other, html: '<p>Changed</p>' }])];
  assert.equal(touchesElement(before, ok, 't1'), false);
  // Claude rewrites the one they're typing in, or deletes it: caught.
  assert.equal(touchesElement(before, [slide('a', [{ ...typing, html: '<p>X</p>' }, other])], 't1'), true);
  assert.equal(touchesElement(before, [slide('a', [other])], 't1'), true);
  // Nobody typing: nothing to protect.
  assert.equal(touchesElement(before, ok, null), false);
});

test('what changed: new slides, changed slides and the changed boxes', () => {
  const t1 = el('t1'), t2 = el('t2');
  const a = slide('a', [t1, t2]), b = slide('b', [el('t3')]);
  const before = [a, b];
  const t2b = { ...t2, html: '<p>new</p>' };
  const after = [{ ...a, els: [t1, t2b] }, b, slide('c', [el('t4')])];
  assert.deepEqual(changedParts(before, after), { slides: ['a', 'c'], els: ['t2'] });
  // Notes alone count as a change to the slide.
  assert.deepEqual(changedParts(before, [a, { ...b, notes: 'Say this' }]), { slides: ['b'], els: [] });
  assert.deepEqual(changedParts(before, before), { slides: [], els: [] });
});
