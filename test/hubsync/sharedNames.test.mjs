// Shared class material (electron/scholar/sharedMaterial.cjs): a textbook file named by a classmate or a Hub is written
// under a safe name: never a path, a Windows device name, a name Windows would change, or an endless one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { safeFileName } = require('../../electron/scholar/safePaths.cjs');
const material = require('../../electron/scholar/sharedMaterial.cjs');

test('a shared file name is made safe to write', () => {
  assert.equal(safeFileName('Chapter 5 - Gases.pdf'), 'Chapter 5 - Gases.pdf');
  for (const bad of ['', '.', '..', '...', ' . ', '\u0000', '<>|']) assert.equal(safeFileName(bad), null, JSON.stringify(bad));
  assert.equal(safeFileName('a/b\\c.pdf'), 'a b c.pdf');
  assert.equal(safeFileName('ch5.pdf.'), 'ch5.pdf');
  assert.equal(safeFileName('ch5.pdf   '), 'ch5.pdf');
  assert.equal(safeFileName('bad\u0007name?.pdf'), 'bad name .pdf');
  for (const dev of ['CON', 'nul.txt', 'com1.pdf', 'LPT9', 'aux .pdf']) assert.match(safeFileName(dev), /^_/, dev);
  const long = safeFileName(`${'x'.repeat(300)}.pdf`);
  assert.equal(long.length, 120);
  assert.ok(long.endsWith('.pdf'));
});

test('the plan takes in textbook files under their safe name and skips ones with no usable name', () => {
  const files = [
    { rel: 'Textbooks/BIO1010/CON.pdf', size: 1, mtime: 1 },
    { rel: `Textbooks/BIO1010/${'y'.repeat(200)}.pdf`, size: 1, mtime: 1 },
    { rel: 'Textbooks/BIO1010/...', size: 1, mtime: 1 },
    { rel: 'Textbooks/BIO1010/notes.pdf:stream', size: 1, mtime: 1 },
    { rel: 'Textbooks/BIO1010/Chapter 1.pdf', size: 1, mtime: 1 }
  ];
  const steps = material.plan(files, {}, [{ id: 'c1', code: 'BIO1010' }]);
  const by = Object.fromEntries(steps.map((s) => [s.rel, s]));
  assert.equal(by['Textbooks/BIO1010/CON.pdf'].name, '_CON.pdf');
  assert.equal(by[`Textbooks/BIO1010/${'y'.repeat(200)}.pdf`].name.length, 120);
  assert.equal(by['Textbooks/BIO1010/...'].action, 'skip');
  assert.equal(by['Textbooks/BIO1010/notes.pdf:stream'].action, 'skip');
  assert.equal(by['Textbooks/BIO1010/Chapter 1.pdf'].name, 'Chapter 1.pdf');
});
