// Making a profile while a class scan runs: it's added, but the open profile stays, so the classes never look gone.
// Run: node --test test/worker/
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

test('create switches to the new profile by default, and not with select: false', () => {
  const profiles = require('../../electron/scholar/profiles.cjs');
  const start = profiles.all().active;
  const kept = profiles.create('Personal', { select: false });
  assert.equal(kept.active, start);
  assert.ok(kept.list.some((p) => p.name === 'Personal'));
  const moved = profiles.create('Another');
  assert.equal(moved.active, moved.list.find((p) => p.name === 'Another').id);
});

test('the create handler keeps the open profile while a scan runs', () => {
  const src = fs.readFileSync(new URL('../../electron/scholar/index.cjs', import.meta.url), 'utf8');
  assert.match(src, /'scholar:createProfile'[^\n]*select: !runner\.status\(\)\.running/);
});
