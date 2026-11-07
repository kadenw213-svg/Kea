// The account page's main-process side (electron/hub.cjs): a wrong password on a route that asks for it again never
// signs Kea out (a 401 there is the password, not the sign-in), while a 401 anywhere else still does; "Download my
// data" puts the account's and the organizations' exports in one file; deleting the account forgets the sign-in, the
// cached account and the work calendar copy.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const APP = { senderFrame: { url: 'app://kea/index.html', parent: null } }; // a call from Kea's own page

const require = createRequire(import.meta.url);
const electron = require('../worker/electronStub.cjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-security-test-'));
electron._paths.userData = dir;
electron._paths.appData = dir;
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const handlers = {};
electron.ipcMain.handle = (name, fn) => (handlers[name] = fn);
// (No background work: what register() starts on timers never runs here.)
const timers = { setTimeout: globalThis.setTimeout, setInterval: globalThis.setInterval };
globalThis.setTimeout = globalThis.setInterval = () => ({ unref() {} });
const hub = require('../../electron/hub.cjs');
hub.register();
Object.assign(globalThis, timers);

const token = path.join(dir, 'hub-session.bin');
const cache = path.join(dir, 'hub-account.json');
const work = path.join(dir, 'work-calendar.json');
// The Hub, as far as these routes go: path → [status, body].
let routes = {};
const asked = [];
electron.net.fetch = async (url, opts) => {
  const p = new URL(String(url)).pathname;
  asked.push({ p, body: opts?.body ? JSON.parse(opts.body) : undefined });
  const [status, body] = routes[p] || [404, { error: 'Not found.' }];
  return { ok: status < 300, status, json: async () => body };
};
beforeEach(() => {
  fs.writeFileSync(token, 'token-1');
  fs.writeFileSync(cache, JSON.stringify({ id: 'a1', email: 'ana@x.org', name: 'Ana' }));
  fs.writeFileSync(work, JSON.stringify({ account: 'a1', events: [{ id: 'shift:1' }] }));
  routes = {};
  asked.length = 0;
});

test('a wrong password where the Hub asks for it again keeps Kea signed in', async () => {
  routes['/v1/me/password'] = [401, { error: 'Your current password is wrong.' }];
  routes['/v1/me/sessions/sign-out-others'] = [401, { error: 'Your password is wrong.' }];
  routes['/v1/me/totp/setup'] = [401, { error: 'Your password is wrong.' }];
  routes['/v1/me/delete'] = [401, { error: 'Your password or two-step code is wrong.' }];
  for (const [name, arg] of [['hub:changePassword', { current: 'x', next: 'y' }], ['hub:signOutOthers', { password: 'x' }], ['hub:totpSetup', { password: 'x' }], ['hub:deleteAccount', { confirm: 'DELETE', password: 'x' }]]) {
    const r = await handlers[name](APP, arg);
    assert.equal(r.ok, false, name);
    assert.equal(r.status, 401, name);
    assert.ok(fs.existsSync(token), `${name} kept the sign-in`);
    assert.ok(fs.existsSync(cache), `${name} kept the account`);
  }
  // Anywhere else, a 401 means the sign-in ended.
  routes['/v1/me/sessions'] = [401, { error: 'Sign in again.' }];
  await handlers['hub:sessions'](APP, {});
  assert.ok(!fs.existsSync(token));
  assert.ok(!fs.existsSync(work), 'the work calendar copy goes with the sign-in');
});

test('Download my data: both exports in one file', async () => {
  routes['/v1/me/export'] = [200, { account: { email: 'ana@x.org' }, orgs: [{ org_id: 'o1' }] }];
  routes['/v1/orgs-export'] = [200, { memberships: [{ org: 'Pool' }], shifts: [{ date: '2026-12-01' }] }];
  let saved = null;
  const where = await hub._exportData({ save: async (name, text) => ((saved = { name, data: JSON.parse(text) }), 'C:/x.json') });
  assert.equal(where, 'C:/x.json');
  assert.match(saved.name, /^Kea account data \d{4}-\d{2}-\d{2}\.json$/);
  assert.equal(saved.data.account.account.email, 'ana@x.org');
  assert.equal(saved.data.work.shifts[0].date, '2026-12-01');
  // Cancelled: nothing saved, no error.
  assert.equal(await hub._exportData({ save: async () => null }), null);
});

test('deleting the account sends the confirmation and forgets everything about it here', async () => {
  routes['/v1/me/delete'] = [200, { ok: true, deleted: true }];
  const r = await handlers['hub:deleteAccount'](APP, { confirm: 'DELETE', password: 'pw', code: '123456' });
  assert.equal(r.ok, true);
  assert.equal(r.value.signedIn, false);
  assert.deepEqual(asked.find((a) => a.p === '/v1/me/delete').body, { confirm: 'DELETE', password: 'pw', code: '123456' });
  for (const f of [token, cache, work]) assert.ok(!fs.existsSync(f), f);
});
