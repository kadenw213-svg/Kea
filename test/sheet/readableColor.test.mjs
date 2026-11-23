// Readable cell colours: fills and text made for white paper stay readable in dark mode (display only).
// Run: node --test test/sheet/readableColor.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cellColors, lineColor, contrast } from '../../src/lib/readableColor.ts';

const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const GRID_DARK = '#26292d';
const TEXT_DARK = '#e6e7e8';

test('a pale header fill with no text colour becomes a dark tint, and the light text reads on it', () => {
  const r = cellColors('#e8f0fe', undefined, true);
  assert.notEqual(r.bg, '#e8f0fe');
  assert.ok(contrast(rgb(TEXT_DARK), rgb(r.bg)) >= 4.5, r.bg);
  assert.equal(r.color, undefined);
});

test('dark text with no fill is lightened on the dark grid, keeping its hue', () => {
  const r = cellColors(undefined, '#1f3864', true);
  assert.ok(contrast(rgb(r.color), rgb(GRID_DARK)) >= 4.5, r.color);
  const [R, G, B] = rgb(r.color);
  assert.ok(B > R, 'still blue');
});

test('dark text on a pale fill stays readable in dark mode', () => {
  const r = cellColors('#fde68a', '#333333', true);
  assert.ok(contrast(rgb(r.color), rgb(r.bg)) >= 4.5, `${r.color} on ${r.bg}`);
});

test('a strong mid fill gets whichever text reads on it', () => {
  const r = cellColors('#f8696b', undefined, true);
  assert.ok(contrast(rgb(r.color || TEXT_DARK), rgb(r.bg)) >= 4.5, `${r.color} on ${r.bg}`);
});

test('light mode leaves good colours alone and fixes white text on white', () => {
  assert.deepEqual(cellColors('#e8f0fe', '#1f3864', false), { bg: '#e8f0fe', color: '#1f3864' });
  const r = cellColors(undefined, '#ffffff', false);
  assert.ok(contrast(rgb(r.color), [255, 255, 255]) >= 4.5, r.color);
});

test('unknown colour formats are left as they are', () => {
  assert.deepEqual(cellColors('var(--x)', undefined, true), { bg: 'var(--x)', color: undefined });
});

test('black borders show on the dark grid', () => {
  assert.ok(contrast(rgb(lineColor('#000000', true)), rgb(GRID_DARK)) >= 3);
  assert.equal(lineColor('#000000', false), '#000000');
});
