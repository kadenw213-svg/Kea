// The account as Kea shows it (electron/account.cjs): the account signed in on this computer (made here or online),
// "verified" only from the online account, and the picture kept here for the account it belongs to. An older local
// account's picture goes with the first Kea account signed in; its own email and name are never shown again. The old
// "verified on this computer" proof for School is gone: scans with your own Claude don't need a verified email.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
const APP = { senderFrame: { url: 'app://kea/index.html', parent: null } }; // a call from Kea's own page

const require = createRequire(import.meta.url);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-account-'));
const handlers = {};
let current = null; // the account signed in here (hub.cjs current())
let hubCache = null; // what the online account last said (hub.cjs cached())
const fakeElectron = { app: { getPath: () => dir }, ipcMain: { handle: (n, f) => (handlers[n] = f) }, dialog: {}, BrowserWindow: { fromWebContents: () => null } };
const load = Module._load;
Module._load = function (req, parent, ...rest) {
  if (req === 'electron') return fakeElectron;
  if (req === './hub.cjs' && parent?.filename?.endsWith('account.cjs')) return { current: () => current, cached: () => hubCache };
  return load.call(this, req, parent, ...rest);
};
const account = require('../../electron/account.cjs');
account.register();
after(() => {
  Module._load = load;
  fs.rmSync(dir, { recursive: true, force: true });
});
const file = path.join(dir, 'account.json');
const write = (a) => fs.writeFileSync(file, JSON.stringify(a));
const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
beforeEach(() => {
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true });
  current = null;
  hubCache = null;
});

test('nobody signed in: no account, whatever an old local one says', () => {
  write({ email: 'old@x.org', name: 'Old', verified: { email: 'old@x.org', by: 'Claude' } });
  assert.equal(account.get(), null);
});

test('an account made on this computer: its email and name, never verified', () => {
  current = { id: 'loc_1', email: 'ana@x.org', name: 'Ana', hub: null };
  assert.deepEqual(account.get(), { email: 'ana@x.org', name: 'Ana', avatar: null, crop: null, verified: false, verifiedBy: null, owner: false });
});

test('an online account: verified and the owner mark come from it, only for the same email', () => {
  current = { id: 'loc_1', email: 'ana@x.org', name: 'Ana', hub: { id: 'a1' } };
  hubCache = { id: 'a1', email: 'ana@x.org', name: 'Ana B', emailVerified: true, verifiedBy: 'Google', owner: false };
  assert.equal(account.get().verified, true);
  assert.equal(account.get().verifiedBy, 'Google');
  assert.equal(account.get().name, 'Ana B');
  // (What another account's online details say never counts.)
  hubCache = { id: 'b2', email: 'ben@x.org', name: 'Ben', emailVerified: true, owner: true };
  assert.equal(account.get().verified, false);
  assert.equal(account.get().owner, false);
});

test('an old local account: its picture goes with the first account, its email, name and proof are dropped', () => {
  fs.writeFileSync(path.join(dir, 'account-avatar-1.png'), Buffer.from([137, 80, 78, 71]));
  write({ email: 'Ana@X.org', name: 'Local name', avatar: 'account-avatar-1.png', crop: { x: 0.5, y: 0.5, zoom: 1, w: 10, h: 10 }, verified: { email: 'ana@x.org', by: 'Claude' } });
  current = { id: 'loc_1', email: 'ana@x.org', name: 'Ana', hub: null };
  const a = account.get();
  assert.equal(a.name, 'Ana');
  assert.match(a.avatar, /^data:image\/png;base64,/);
  assert.equal(a.verified, false, 'a sign-in on this computer no longer counts as verified');
  const kept = read();
  assert.equal(kept.accountId, 'loc_1');
  for (const k of ['email', 'name', 'verified', 'proof']) assert.equal(kept[k], undefined, k);
  // Someone else signs in here: not Ana's picture.
  current = { id: 'loc_2', email: 'ben@x.org', name: 'Ben', hub: null };
  assert.equal(account.get().avatar, null);
});

test('a picture chosen under the online id (before accounts were kept here) is still that account’s', () => {
  fs.writeFileSync(path.join(dir, 'account-avatar-3.png'), Buffer.from([137, 80, 78, 71]));
  write({ accountId: 'a1', avatar: 'account-avatar-3.png' });
  current = { id: 'loc_1', email: 'ana@x.org', name: 'Ana', hub: { id: 'a1' } };
  assert.match(account.get().avatar, /^data:image\/png;base64,/);
});

test('a picture is changed only for its own account, and deleting the account removes it', async () => {
  fs.writeFileSync(path.join(dir, 'account-avatar-2.png'), 'x');
  write({ accountId: 'loc_1', avatar: 'account-avatar-2.png' });
  current = { id: 'loc_2', email: 'ben@x.org', name: 'Ben', hub: null };
  await assert.rejects(async () => handlers['account:crop'](APP, { x: 0.5, y: 0.5, zoom: 1, w: 1, h: 1 }), /Choose a picture first/);
  account.forget('b2', 'loc_2');
  assert.ok(fs.existsSync(file));
  account.forget('a1', 'loc_1');
  assert.ok(!fs.existsSync(file));
  assert.ok(!fs.existsSync(path.join(dir, 'account-avatar-2.png')));
});

test('the old routes are gone, School’s proof included', () => {
  for (const n of ['account:save', 'account:suggest', 'account:signOut', 'account:verify', 'account:verifyHere']) assert.equal(handlers[n], undefined, n);
  for (const n of ['account:get', 'account:avatar', 'account:crop']) assert.ok(handlers[n], n);
  assert.equal(account.verified, undefined);
});
