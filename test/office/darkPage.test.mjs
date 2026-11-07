// Dark page pictures (src/lib/darkPage.ts): a solid black box saved into a page (a redaction) is found, so it keeps its
// real colour on a dark page; text strokes, thin lines and light areas are not.
//   node --test test/office/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solidDarkMask, minSolid } from '../../src/lib/darkPage.ts';

/** A white w×h picture with black rectangles [x, y, w, h]. */
function page(w, h, boxes, colour = [0, 0, 0]) {
  const d = new Uint8ClampedArray(w * h * 4).fill(255);
  for (const [bx, by, bw, bh] of boxes)
    for (let y = by; y < by + bh; y++)
      for (let x = bx; x < bx + bw; x++) d.set([...colour, 255], (y * w + x) * 4);
  return d;
}
const count = (m) => m.reduce((n, v) => n + v, 0);

test('a black box bigger than text is kept; its pixels and only those', () => {
  const w = 100, h = 80;
  const m = solidDarkMask(page(w, h, [[10, 10, 30, 20]]), w, h, 8);
  assert.equal(count(m), 30 * 20);
  assert.equal(m[15 * w + 20], 1);
  assert.equal(m[5 * w + 5], 0);
});

test('text strokes, thin rules and light grey shading are darkened like the page', () => {
  const w = 100, h = 80;
  // Letter stems (3 px wide, tall), a long thin rule (2 px high), a small dot.
  assert.equal(count(solidDarkMask(page(w, h, [[10, 10, 3, 40], [20, 60, 70, 2], [50, 20, 5, 5]]), w, h, 8)), 0);
  // A large light grey table shading is paper, not a mark.
  assert.equal(count(solidDarkMask(page(w, h, [[10, 10, 60, 40]], [220, 220, 220]), w, h, 8)), 0);
});

test('the smallest kept area grows with the picture', () => {
  assert.equal(minSolid(100), 6);
  assert.equal(minSolid(420), 8);
  assert.equal(minSolid(1500), 30);
});
