// Text on highlights (src/lib/highlightInk.ts): the ink comes from the highlight's lightness, the document's own text
// colour stays on a white page, and the default highlight is a soft yellow that reads on white and dark pages alike.
//   node --test test/office/highlightInk.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { highlightInk, inkOnHighlight, parseCssColour, luminance, DEFAULT_HIGHLIGHT, HIGHLIGHT_SWATCHES } from '../../src/lib/highlightInk.ts';

const ratio = (a, b) => {
  const [x, y] = [luminance(parseCssColour(a)), luminance(parseCssColour(b))];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

test('light highlights get dark text, dark highlights light text', () => {
  for (const c of ['#ffff00', 'yellow', '#00ff00', '#00ffff', '#fde68a', '#f2e2a0', 'rgb(255, 242, 204)', '#fff']) assert.equal(highlightInk(c), 'dark', c);
  for (const c of ['#000000', '#0000ff', 'navy', '#980000', 'rgb(40, 40, 40)', '#674ea7']) assert.equal(highlightInk(c), 'light', c);
});

test('the yellow highlight on a dark page draws dark text (the bug: it stayed white)', () => {
  assert.equal(inkOnHighlight('#ffff00', 'dark'), '#202124');
  assert.ok(ratio('#ffff00', '#202124') > 7);
});

test('on a white page the document’s own text colour stays on light highlights', () => {
  assert.equal(inkOnHighlight('#ffff00', 'light'), null);
  assert.equal(inkOnHighlight(DEFAULT_HIGHLIGHT, 'light'), null);
  // A dark highlight still gets readable (white) text.
  assert.equal(inkOnHighlight('#000080', 'light'), '#ffffff');
  // On a dark page, a dark highlight keeps the page's light text.
  assert.equal(inkOnHighlight('#000080', 'dark'), null);
});

test('see-through highlights are judged over the page behind them', () => {
  assert.equal(highlightInk('rgba(0, 0, 0, 0.1)', '#ffffff'), 'dark');
  assert.equal(highlightInk('rgba(0, 0, 0, 0.9)', '#ffffff'), 'light');
});

test('colours are read in every form saved files use; unknown ones count as light', () => {
  assert.deepEqual(parseCssColour('#abc'), [170, 187, 204, 1]);
  assert.deepEqual(parseCssColour('#FFFF00'), [255, 255, 0, 1]);
  assert.deepEqual(parseCssColour('rgb(1 2 3 / 50%)'), [1, 2, 3, 0.5]);
  assert.equal(parseCssColour('not a colour'), null);
  assert.equal(highlightInk('var(--x)'), 'dark');
});

test('the default highlight is a soft, muted yellow that reads with dark text', () => {
  const [r, g, b] = parseCssColour(DEFAULT_HIGHLIGHT);
  assert.ok(r > g && g > b, 'yellow: red ≥ green > blue');
  assert.ok(b > 120, 'muted: not the pure #ffff00');
  assert.ok(luminance([r, g, b]) < luminance([255, 255, 0]), 'softer than the browser yellow');
  assert.ok(ratio(DEFAULT_HIGHLIGHT, '#202124') >= 7, 'dark text on it is easy to read');
  // It still stands out from a white page and a dark one.
  assert.ok(ratio(DEFAULT_HIGHLIGHT, '#ffffff') > 1.2);
  assert.ok(ratio(DEFAULT_HIGHLIGHT, '#2d2e30') > 7);
  assert.equal(HIGHLIGHT_SWATCHES[0], DEFAULT_HIGHLIGHT);
});
