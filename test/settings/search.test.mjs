// Finding settings by what people type (src/lib/settingsSearch.ts): the everyday phrasings land on the right setting,
// and a suggested change goes the way the words say. Bundled for Node the way the app bundles it.
//   node --test test/settings/
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
let S, SET;
before(async () => {
  globalThis.window = { api: { settings: { set() {}, get: async () => ({}), onChange() {} } } };
  globalThis.document = { documentElement: { style: { setProperty() {} }, dataset: {}, classList: { toggle() {} } } };
  const out = path.join(os.tmpdir(), `kea-settings-search-${process.pid}.cjs`);
  await require('esbuild').build({ entryPoints: [path.resolve(here, '../../src/lib/settingsSearch.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
  S = require(out);
  fs.rmSync(out, { force: true });
  const out2 = path.join(os.tmpdir(), `kea-settings-${process.pid}.cjs`);
  await require('esbuild').build({ entryPoints: [path.resolve(here, '../../src/lib/settings.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out2, logLevel: 'silent' });
  SET = require(out2);
  fs.rmSync(out2, { force: true });
});

const top = (q, n = 3) => S.searchSettings(q).slice(0, n).map((h) => h.key);

test('everyday phrasings find the right setting', () => {
  assert.ok(top('dark mode').includes('appearance.theme'), 'dark mode');
  assert.ok(top('make text bigger').includes('appearance.scale'), 'make text bigger');
  assert.ok(top('the words on screen are too small').includes('appearance.scale'), 'too small');
  assert.ok(top('stop notifications', 6).some((k) => /notify/i.test(k)), 'notifications');
  assert.ok(top('storage', 6).some((k) => k === 'p-cloud' || k === 'p-history'), 'storage');
  assert.ok(top('sync', 6).some((k) => /cloud|sync/i.test(k)), 'sync');
  assert.ok(top('autosave').includes('files.autosave'), 'autosave');
  assert.ok(top('spellcheck').includes('general.spellcheck'), 'one word');
  assert.ok(top('notfications', 6).some((k) => /notify/i.test(k)), 'a typo still matches');
  assert.deepEqual(S.searchSettings('the and of'), [], 'only filler words: nothing');
});

test('every setting and category is still reachable', () => {
  const inCats = new Set(S.CATEGORIES.flatMap((c) => c.sections));
  for (const s of SET.SECTIONS) assert.ok(inCats.has(s.id), `section ${s.id} is in a category`);
  for (const s of SET.SECTIONS) for (const f of s.fields) assert.ok(S.searchSettings(f.label, { loose: true, limit: 400 }).some((h) => h.key === f.key), `${f.key} found by its own label`);
  for (const k of S.POPULAR) assert.ok(SET.DEFAULTS[k] !== undefined, `popular ${k} exists`);
});

test('a suggested change goes the way the words say, and only when they say it', () => {
  const field = (k) => SET.SECTIONS.flatMap((s) => s.fields).find((f) => f.key === k);
  const scale = field('appearance.scale');
  assert.match(S.suggestChange('the words are too small', scale, 1).label, /Set to 1[1-9]\d%/);
  assert.match(S.suggestChange('make everything smaller', scale, 1).label, /Set to [5-9]\d%/);
  assert.equal(S.suggestChange('dark mode', field('appearance.theme'), 'light').value, 'dark');
  assert.equal(S.suggestChange('dark mode', field('appearance.theme'), 'dark'), null, 'already dark');
  assert.equal(S.suggestChange('stop the message notifications', field('scholar.notifyMessages'), true).value, false);
  assert.equal(S.suggestChange('notifications', field('scholar.notifyMessages'), true), null, 'no direction, no suggestion');
  assert.equal(S.suggestChange('turn on autosave', field('files.autosave'), false).value, true);
});

test('help text folds to one line', () => {
  assert.deepEqual(S.hintOf('Short help.'), { hint: 'Short help.', more: false });
  const long = 'Once a day, Claude reads everything Kea has on each assignment. It writes each step in order, with any supplies to get, and how it is graded.';
  const h = S.hintOf(long);
  assert.equal(h.more, true);
  assert.ok(h.hint.length < long.length && h.hint.endsWith('.'));
});
