// Work across several servers (electron/hubOrg.cjs with electron/serversCore.cjs): organizations on the Kea account
// server and on a joined KeaS listed together, each call going to the server that holds the organization, to-dos and
// the calendar put together, and a server that's offline or signed the account out shown as such.
//   node --test test/servers/
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fakeKeaC, fakeKeaS } from './fakes.mjs';

const require = createRequire(import.meta.url);
const core = require('../../electron/serversCore.cjs');
const { timedFetch } = require('../../electron/accountCore.cjs');
const APP = { senderFrame: { url: 'app://kea/index.html', parent: null } };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-work-servers-'));
const keac = await fakeKeaC();
const keas = await fakeKeaS({ keys: () => [keac.jwk] });
const accountReq = async (method, p, body) => {
  let r;
  try {
    r = await timedFetch(fetch, keac.url + p, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${keac.session}` }, body: body === undefined ? undefined : JSON.stringify(body) }, 3000);
  } catch {
    throw Object.assign(new Error('offline'), { status: 0 });
  }
  const j = r.json();
  if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status, data: j });
  return j;
};
const S = core.createServers({ file: path.join(dir, 'l.json'), secretsFile: path.join(dir, 's.bin'), fetchFn: fetch, timedFetch, account: { key: () => 'local-ana', req: accountReq } });

// The Kea account server's own organizations (Hub 0.5 style), as hub.cjs's req would answer.
const hubSent = [];
let hubDown = false;
const hubReq = async (method, p, body) => {
  hubSent.push(`${method} ${p}`);
  if (hubDown) throw Object.assign(new Error('offline'), { status: 0 });
  if (p === '/v1/orgs') return { orgs: [{ id: 'org-hub', name: 'Pine Hollow Camp', role: 'manager', memberStatus: 'active', status: 'active' }] };
  if (p === '/v1/todo') return { now: 1, items: [{ key: 'form:org-hub:1', orgId: 'org-hub', orgName: 'Pine Hollow Camp', title: 'Availability due', overdue: true, urgency: 3 }], snoozed: [] };
  if (p.startsWith('/v1/orgs-calendar')) return { events: [{ id: 'shift:hub', orgId: 'org-hub', orgName: 'Pine Hollow Camp', title: 'Counselor', start: '2026-12-01T15:00:00.000Z', end: '2026-12-01T19:00:00.000Z' }] };
  if (p.startsWith('/v1/orgs/org-hub')) return { org: { id: 'org-hub' }, me: { role: 'manager' } };
  if (p === '/v1/todo/snooze') return { ok: true, at: 'hub' };
  throw Object.assign(new Error('Not found.'), { status: 404 });
};
const handlers = {};
const fakeElectron = { app: { getPath: () => dir }, ipcMain: { handle: (n, f) => (handlers[n] = f) }, dialog: {}, BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] }, shell: {} };
const load = Module._load;
Module._load = function (req, parent, ...rest) {
  if (req === 'electron') return fakeElectron;
  if (req === './hub.cjs' && parent?.filename?.endsWith('hubOrg.cjs')) return { req: (...a) => hubReq(...a), cached: () => ({ id: 'acct-ana' }), signedIn: () => true };
  if (req === './servers.cjs' && parent?.filename?.endsWith('hubOrg.cjs')) return { list: () => S.list(), req: (...a) => S.req(...a) };
  return load.call(this, req, parent, ...rest);
};
const hubOrg = require('../../electron/hubOrg.cjs');
hubOrg.register();
const call = async (method, p, body) => {
  const r = await handlers['hubOrg:call'](APP, { method, path: p, body });
  if (!r.ok) throw Object.assign(new Error(r.error), { status: r.status, data: r.data });
  return r.value;
};
after(async () => {
  Module._load = load;
  await keas.close();
  await keac.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const orgId = keas.state.orgs[0].id;

test('organizations on the Kea account server and on a joined server, together', async () => {
  await S.join(keas.joinLink());
  const r = await call('GET', '/v1/orgs');
  assert.deepEqual(r.orgs.map((o) => [o.name, o.server?.name ?? null]), [['Pine Hollow Camp', null], ['Westside Pool', 'Westside Pool']]);
  assert.deepEqual(r.servers.map((s) => [s.name, s.offline, s.signedOut]), [['Westside Pool', false, false]]);
});

test('each call goes to the server that holds the organization', async () => {
  hubSent.length = 0;
  const me = await call('GET', `/v1/orgs/${orgId}`);
  assert.deepEqual(me.me.abilities, ['clock.self', 'timeoff.request']);
  const p = await call('POST', `/v1/orgs/${orgId}/clock`, { type: 'in' });
  assert.equal(p.punch.type, 'in');
  assert.equal((await call('GET', `/v1/orgs/${orgId}/clock`)).clockedIn, true);
  assert.ok(!hubSent.some((x) => x.includes(orgId)), 'nothing about the KeaS org went to the Kea account server');
  await call('GET', '/v1/orgs/org-hub');
  assert.ok(hubSent.includes('GET /v1/orgs/org-hub'));
});

test('to-dos and the calendar from every server; a snooze goes back where the item came from', async () => {
  const t = await call('GET', '/v1/todo');
  assert.deepEqual(t.items.map((i) => i.orgId), ['org-hub', orgId], 'overdue first');
  hubSent.length = 0;
  await call('POST', '/v1/todo/snooze', { key: 'form:org-hub:1', hours: 24 });
  assert.deepEqual(hubSent, ['POST /v1/todo/snooze']);
  const ev = await handlers['hubOrg:events'](APP, { from: '2026-11-30T00:00:00Z', to: '2026-12-31T00:00:00Z' });
  assert.deepEqual(ev.value.events.map((e) => e.orgId).sort(), ['org-hub', orgId].sort());
});

test('a server offline: the other organizations still show, and its shifts come from the copy on this PC', async () => {
  const saved = keas.state.mode;
  // (Closing the fake would end it for the later tests: make it unreachable by pointing the entry elsewhere instead.)
  const file = path.join(dir, 'l.json');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const realUrl = j.servers[0].url;
  j.servers[0].url = 'http://127.0.0.1:9';
  fs.writeFileSync(file, JSON.stringify(j));
  const r = await call('GET', '/v1/orgs');
  assert.deepEqual(r.orgs.map((o) => o.name), ['Pine Hollow Camp']);
  assert.equal(r.servers[0].offline, true);
  const ev = await handlers['hubOrg:events'](APP, { from: '2026-11-30T00:00:00Z', to: '2026-12-31T00:00:00Z' });
  assert.deepEqual(ev.value.events.map((e) => e.orgId).sort(), ['org-hub', orgId].sort(), 'its shifts from the copy');
  // Everything offline: the copy, marked offline.
  hubDown = true;
  const off = await handlers['hubOrg:events'](APP, { from: '2026-11-30T00:00:00Z', to: '2026-12-31T00:00:00Z' });
  assert.deepEqual([off.value.offline, off.value.events.length], [true, 2]);
  hubDown = false;
  j.servers[0].url = realUrl;
  fs.writeFileSync(file, JSON.stringify(j));
  keas.state.mode = saved;
});

test('a server that signed the account out shows as such, and the rest of Work goes on', async () => {
  keas.state.revoked.add(keac.account.id);
  const r = await call('GET', '/v1/orgs');
  assert.deepEqual(r.orgs.map((o) => o.name), ['Pine Hollow Camp']);
  assert.deepEqual([r.servers[0].signedOut, r.servers[0].message], [true, 'Westside Pool signed you out.']);
  await assert.rejects(call('GET', `/v1/orgs/${orgId}/clock`), (e) => e.status === 401 && e.data?.signedOut);
  keas.state.revoked.clear();
});
