// What Kea shows about updates (src/lib/updateState.ts): a check Kea runs by itself stays quiet unless it finds
// something, a downloaded update keeps saying "Restart to update", and a check the person asked for always answers.
//   node --test test/updates/updates.test.mjs
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
let U;
before(async () => {
  const out = path.join(os.tmpdir(), `kea-update-state-${process.pid}.cjs`);
  await require('esbuild').build({ entryPoints: [path.resolve(here, '../../src/lib/updateState.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
  U = require(out);
  fs.rmSync(out, { force: true });
});

const idle = { status: 'idle' };

test('a check Kea runs by itself shows nothing when there is nothing new, or when GitHub can’t be reached', () => {
  for (const s of [{ status: 'checking' }, { status: 'latest' }, { status: 'error', message: 'offline' }]) {
    const r = U.nextUpdateState(idle, s, false);
    assert.equal(r.state, idle);
    assert.equal(U.updateIndicator(r.state), null);
  }
});

test('a check the person asked for answers: "Kea is up to date", or the error', () => {
  let r = U.nextUpdateState(idle, { status: 'checking' }, true);
  assert.equal(r.state.status, 'checking');
  assert.equal(r.asked, true, 'still waiting for the answer');
  r = U.nextUpdateState(r.state, { status: 'latest' }, r.asked);
  assert.equal(r.state.status, 'latest');
  assert.equal(r.asked, false);
  assert.equal(U.updateHeadline(r.state), 'Kea is up to date');
  const e = U.nextUpdateState({ status: 'checking' }, { status: 'error', message: 'No connection' }, true);
  assert.equal(e.state.status, 'error');
  assert.equal(U.updateHeadline(e.state), 'Couldn’t check for updates');
});

test('something to install always shows, whoever started the check', () => {
  for (const asked of [true, false]) {
    const r = U.nextUpdateState(idle, { status: 'available', version: '0.82.0' }, asked);
    assert.equal(r.state.status, 'available');
    assert.deepEqual(U.updateIndicator(r.state).kind, 'available');
  }
  const d = U.nextUpdateState({ status: 'available', version: '0.82.0' }, { status: 'downloading', percent: 41.6 }, false);
  assert.equal(U.updateIndicator(d.state).label, 'Updating 42%');
});

test('a downloaded update says "Restart to update" and stays that way until Kea restarts', () => {
  const ready = U.nextUpdateState({ status: 'downloading', percent: 99 }, { status: 'ready', version: '0.82.0' }, false).state;
  const ind = U.updateIndicator(ready);
  assert.equal(ind.kind, 'ready');
  assert.equal(ind.label, 'Restart to update');
  // A later check that finds the same version again, or says nothing new, doesn't take it away.
  for (const s of [{ status: 'checking' }, { status: 'available', version: '0.82.0' }, { status: 'downloading', percent: 3 }, { status: 'latest' }, { status: 'error', message: 'x' }])
    assert.equal(U.nextUpdateState(ready, s, false).state, ready, s.status);
  // A newer version than the one downloaded does show.
  assert.equal(U.nextUpdateState(ready, { status: 'available', version: '0.83.0' }, false).state.version, '0.83.0');
});

test('a download that fails by itself doesn’t leave "Updating…" up forever', () => {
  const r = U.nextUpdateState({ status: 'downloading', percent: 40 }, { status: 'error', message: 'reset' }, false);
  assert.equal(r.state.status, 'idle');
  assert.equal(U.updateIndicator(r.state), null);
});

test('nothing in the title bar while idle, checking, up to date or after an error', () => {
  for (const status of ['idle', 'checking', 'latest', 'error', 'dev', 'manual']) assert.equal(U.updateIndicator({ status }), null, status);
});
