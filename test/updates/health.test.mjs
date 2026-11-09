// Kea never goes stale without saying so (electron/updateHealth.cjs, src/lib/updateState.ts staleness): update checks
// that keep failing, an update waiting too long, a newer Kea a server knows of (docs/protocol.md section 0) when
// GitHub can't be reached, and a server that turns this Kea away as too old (426), which the account client
// (electron/hub.cjs) and the organization client (electron/serversCore.cjs) both report instead of failing quietly.
//   node --test test/updates/health.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-update-health-'));
const { createUpdateHealth, newer } = require('../../electron/updateHealth.cjs');
const DAY = 864e5;
let U;
before(async () => {
  const out = path.join(os.tmpdir(), `kea-update-state-h-${process.pid}.cjs`);
  await require('esbuild').build({ entryPoints: [path.resolve(here, '../../src/lib/updateState.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
  U = require(out);
  fs.rmSync(out, { force: true });
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

let n = 0;
const make = (clock, version = '0.85.0') => createUpdateHealth({ file: path.join(dir, `h${++n}.json`), version: () => version, now: () => clock.t });

test('checks that keep failing add up across restarts and say so with the last good check; one that works clears them', () => {
  const clock = { t: Date.UTC(2026, 10, 1, 9) };
  const file = path.join(dir, 'restart.json');
  let H = createUpdateHealth({ file, version: '0.85.0', now: () => clock.t });
  H.checking();
  H.ok();
  const good = clock.t;
  for (let i = 0; i < 2; i++) {
    clock.t += DAY;
    H.checking();
    H.failed('You’re offline, or GitHub can’t be reached. Kea tries again later.');
  }
  assert.equal(U.staleness(H.get(), clock.t), null, 'two failures: not yet');
  // Kea restarts: the count carries on.
  H = createUpdateHealth({ file, version: '0.85.0', now: () => clock.t });
  clock.t += DAY;
  H.failed('GitHub answered 503');
  const h = H.get();
  assert.equal(h.failures, 3);
  assert.equal(h.lastOkAt, good);
  const st = U.staleness(h, clock.t);
  assert.equal(st.kind, 'stale');
  assert.equal(st.label, 'Can’t check for updates');
  assert.match(st.detail, /3 tries in a row.*GitHub answered 503/);
  assert.equal(U.updateIndicator({ status: 'idle' }, h, clock.t).label, 'Can’t check for updates', 'the title-bar pill says it');
  H.ok();
  assert.equal(H.get().failures, 0);
  assert.equal(U.staleness(H.get(), clock.t), null);
});

test('an update found or downloaded and still not installed after 3 days says so; installing it ends that', () => {
  const clock = { t: Date.UTC(2026, 10, 1, 9) };
  const H = make(clock);
  H.downloaded('0.86.0');
  clock.t += 2 * DAY;
  assert.equal(U.updateIndicator({ status: 'ready', version: '0.86.0' }, H.get(), clock.t).title.startsWith('Kea 0.86.0 is downloaded. Restart'), true);
  clock.t += 2 * DAY;
  const ind = U.updateIndicator({ status: 'ready', version: '0.86.0' }, H.get(), clock.t);
  assert.equal(ind.label, 'Restart to update');
  assert.match(ind.title, /waiting for Kea to restart \(4 days\)/);
  assert.equal(U.staleness(H.get(), clock.t).label, 'Update waiting');
  // Found but not downloaded (downloads turned off), for days.
  const F = make(clock);
  F.found('0.86.0');
  clock.t += 4 * DAY;
  assert.match(U.staleness(F.get(), clock.t).detail, /is out and hasn’t been downloaded for 4 days/);
  // Kea is now 0.86.0: nothing waits.
  const after = createUpdateHealth({ file: path.join(dir, `h${n}.json`), version: '0.86.0', now: () => clock.t });
  assert.equal(after.get().available, null);
  assert.equal(U.staleness(after.get(), clock.t), null);
});

test('a newer Kea a server knows of shows as Update available when Kea’s own check found nothing; older servers say nothing', () => {
  const clock = { t: Date.UTC(2026, 10, 1, 9) };
  const H = make(clock);
  H.serverSays('account', { ok: true, service: 'keac', features: [] });
  assert.equal(H.get().latest, null, 'an older server has no latest');
  H.serverSays('account', { latest: { kea: '0.85.0', keas: '0.9.0' } });
  assert.equal(H.get().latest, null, 'the same version is not newer');
  H.serverSays('org:https://pool.example.org', { latest: { kea: '0.86.1' } });
  H.serverSays('account', { latest: { kea: '0.86.0' } });
  assert.deepEqual({ ...H.get().latest, at: 0 }, { version: '0.86.1', from: 'org:https://pool.example.org', at: 0 });
  const ind = U.updateIndicator({ status: 'error', message: 'offline' }, H.get(), clock.t);
  assert.equal(ind.kind, 'available');
  assert.match(ind.title, /Kea 0\.86\.1 is out \(your organization’s server says so\)/);
  // Kea's own updater finding it wins (the dialog downloads it).
  assert.equal(U.updateIndicator({ status: 'available', version: '0.86.1' }, H.get(), clock.t).title, 'Kea 0.86.1 is out. Click to download it.');
  assert.ok(newer('0.10.0', '0.9.9') && !newer('0.9.9', '0.10.0') && !newer('x', '1.0.0'));
});

test('a server that turns Kea away as too old: "Update Kea" in the title bar, over everything else, until it serves Kea again', () => {
  const clock = { t: Date.UTC(2026, 10, 1, 9) };
  const H = make(clock, '0.84.1');
  H.downloaded('0.86.0');
  H.tooOld('org:https://pool.example.org', { error: 'Update Kea to keep using this organization’s server.', minVersion: '0.85.0', updateUrl: 'https://example.org/r' });
  H.tooOld('account', { error: 'Update Kea to keep using your Kea account.', minVersion: '0.85.0', updateUrl: 'https://example.org/r' });
  assert.equal(H.get().tooOld.from, 'account', 'the account’s refusal comes first');
  const ind = U.updateIndicator({ status: 'ready', version: '0.86.0' }, H.get(), clock.t);
  assert.deepEqual([ind.kind, ind.label, ind.title], ['required', 'Update Kea', 'Update Kea to keep using your Kea account.']);
  assert.match(U.staleness(H.get(), clock.t).detail, /needs 0\.85\.0 or newer; this is 0\.84\.1/);
  H.served('account');
  assert.equal(H.get().tooOld.from, 'org:https://pool.example.org');
  H.served('org:https://pool.example.org');
  assert.equal(H.get().tooOld, null);
  // Kea updated past the minimum: an old refusal no longer counts.
  H.tooOld('account', { error: 'Update Kea to keep using your Kea account.', minVersion: '0.84.0' });
  assert.equal(H.get().tooOld, null);
});

// ---------- the clients: a 426 is reported, not a broken account or organization ----------
function server(handler) {
  const seen = [];
  const s = http.createServer((q, r) => {
    seen.push({ path: new URL(q.url, 'http://x').pathname, client: q.headers['x-kea-client'] || null });
    const [status, body] = handler(q);
    r.writeHead(status, { 'content-type': 'application/json' });
    r.end(JSON.stringify(body));
  });
  return new Promise((ok) => s.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${s.address().port}`, seen, close: () => new Promise((d) => s.close(d)) })));
}

test('the organization client says which Kea it is, and a 426 becomes "Update Kea" with the server’s words', async () => {
  const core = require('../../electron/serversCore.cjs');
  const { timedFetch } = require('../../electron/accountCore.cjs');
  const clock = { t: Date.now() };
  const H = make(clock, '0.84.1');
  let old = true;
  const s = await server(() => (old ? [426, { error: 'Update Kea to keep using this organization’s server.', upgradeRequired: true, app: 'kea', version: '0.84.1', minVersion: '0.85.0', updateUrl: 'https://example.org/r' }] : [400, { error: 'Send nonce' }]));
  const sub = path.join(dir, 'servers');
  const S = core.createServers({ file: path.join(sub, 'l.json'), secretsFile: path.join(sub, 's.bin'), fetchFn: fetch, timedFetch, account: { key: () => 'me', req: async () => ({}) }, client: 'Kea/0.84.1', versions: H });
  await assert.rejects(S.join({ address: s.url, code: 'ABCD-EFGH' }), (e) => e.status === 426 && e.message === 'Update Kea to keep using this organization’s server.' && e.data.upgradeRequired === true);
  assert.equal(s.seen[0].client, 'Kea/0.84.1');
  assert.equal(H.get().tooOld.from, `org:${s.url}`);
  old = false;
  await assert.rejects(S.join({ address: s.url, code: 'ABCD-EFGH' }));
  assert.equal(H.get().tooOld, null, 'served again: the notice is gone');
  await s.close();
});

test('the account client: a 426 is said plainly, kept for the account page, and the health check’s newest Kea is noted', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-health-hub-'));
  const electron = require('../worker/electronStub.cjs');
  electron._paths.userData = userData;
  electron._paths.appData = userData;
  const settings = require('../../electron/settings.cjs');
  const hub = require('../../electron/hub.cjs');
  const A = hub._account;
  A.setBackground(false);
  A.setLimits({ req: 3000, status: 2000 });
  const clock = { t: Date.now() };
  const H = make(clock, '0.0.0');
  A.setVersions(H);
  let old = true;
  const s = await server((q) => {
    const p = new URL(q.url, 'http://x').pathname;
    if (p === '/v1/health') return [200, { ok: true, service: 'keac', protocol: 1, minClients: { kea: '0.85.0' }, latest: { kea: '0.86.0', keas: '0.9.0' } }];
    return old ? [426, { error: 'Update Kea to keep using your Kea account.', upgradeRequired: true, app: 'kea', version: '0.0.0', minVersion: '0.85.0', updateUrl: 'https://example.org/r' }] : [200, { terms: { version: 1, sections: [] } }];
  });
  settings.set({ 'hub.url': s.url });
  try {
    await hub.req('GET', '/v1/health', undefined, { auth: false });
    assert.equal(H.get().latest.version, '0.86.0');
    await assert.rejects(hub.req('GET', '/v1/terms', undefined, { auth: false }), (e) => e.status === 426 && e.message === 'Update Kea to keep using your Kea account.');
    assert.ok(s.seen.every((x) => /^Kea\//.test(x.client)), 'every account request says which Kea it is');
    assert.deepEqual(A.local().tooOld, { error: 'Update Kea to keep using your Kea account.', minVersion: '0.85.0', updateUrl: 'https://example.org/r' });
    old = false;
    await hub.req('GET', '/v1/terms', undefined, { auth: false });
    assert.equal(A.local().tooOld, null);
  } finally {
    await s.close();
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
