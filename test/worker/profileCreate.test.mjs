// Adding a class site (an old "profile") never switches anything: every site is read together, and what Kea works on
// outside a site's own run is always the first site (electron/scholar/profiles.cjs).
// Run: node --test test/worker/profileCreate.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electron = require('./electronStub.cjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-profile-create-test-'));
electron._paths.userData = dir;
electron._paths.appData = dir;
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('making a site adds it after the others and changes what Kea works on nowhere', () => {
  const profiles = require('../../electron/scholar/profiles.cjs');
  assert.equal(profiles.active(), 'school');
  profiles.create('Personal');
  profiles.create('Another', { select: true });
  assert.deepEqual(profiles.ids(), ['school', 'personal', 'another']);
  assert.equal(profiles.home(), 'school');
  assert.equal(profiles.active(), 'school');
});

test('inside a site’s own work, paths are that site’s, through everything it awaits', async () => {
  const profiles = require('../../electron/scholar/profiles.cjs');
  const seen = await profiles.within('another', async () => {
    await new Promise((r) => setTimeout(r, 5));
    return profiles.paths().dir;
  });
  assert.equal(path.basename(seen), 'another');
  assert.equal(path.basename(profiles.paths().dir), 'school');
  // (A site that isn't there: the first one.)
  assert.equal(profiles.within('nope', () => profiles.active()), 'school');
});

test('the window has no profile to switch to', () => {
  const src = fs.readFileSync(new URL('../../electron/scholar/index.cjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /profiles\.select\(/);
});
