// Printing is always on white paper: light text left over from dark mode is dropped, deliberate colors stay.
// Run: node --test test/print/printShell.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brightness, dropLightText } from '../../src/lib/printShell.ts';

test('brightness reads hex, rgb and white, and nothing else', () => {
  assert.ok(Math.abs(brightness('#fff') - 1) < 1e-9);
  assert.equal(brightness('#000000'), 0);
  assert.ok(brightness('rgb(232, 234, 237)') > 0.9);
  assert.equal(brightness('white'), 1);
  assert.equal(brightness('var(--text)'), null);
});

test('near-white text is dropped; dark and colored text stays', () => {
  const html = '<p style="color:#e8eaed">a</p><p style="color: #202124">b</p><span style="color:rgb(200,30,30)">c</span>';
  const out = dropLightText(html);
  assert.ok(!out.includes('e8eaed'));
  assert.ok(out.includes('#202124'));
  assert.ok(out.includes('rgb(200,30,30)'));
});

test('light text on its own background is kept (a highlighted word)', () => {
  const html = '<span style="color:#fff;background-color:#1a73e8">x</span>';
  assert.equal(dropLightText(html), html);
});

test('other style declarations survive when the color goes', () => {
  assert.equal(dropLightText('<p style="text-align:center;color:#fff">x</p>'), '<p style="text-align:center">x</p>');
  assert.equal(dropLightText('<p style="color:#fff">x</p>'), '<p >x</p>');
});

test('every print page starts from white paper (set in the main process)', () => {
  const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const main = fs.readFileSync(path.join(root, 'electron/main.cjs'), 'utf8');
  assert.match(main, /PRINT_BASE = '<style>:root\{color-scheme:light\}html,body\{background:#fff;color:#202124\}<\/style>'/);
  assert.match(main, /PRINT_CSP\}">\$\{PRINT_BASE\}/);
});

test('every editor prints through the preview', () => {
  const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const dir = path.join(root, 'src/editors');
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && /api\.printHtml\(/.test(fs.readFileSync(p, 'utf8'))) hits.push(p);
    }
  };
  walk(dir);
  assert.deepEqual(hits, []);
});
