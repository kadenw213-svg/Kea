// One account (electron/account.cjs): Kea shows the Kea Hub account's email, name and verified mark; only the picture
// and School's "signed in on this computer" proof are kept here, for the account they belong to. An older local
// account's picture goes with the first Kea account signed in; its own email and name are never shown again.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-account-'));
const handlers = {};
let hubCache = null;
const fakeElectron = { app: { getPath: () => dir }, ipcMain: { handle: (n, f) => (handlers[n] = f) }, dialog: {}, BrowserWindow: { fromWebContents: () => null } };
const load = Module._load;
Module._load = function (req, parent, ...rest) {
  if (req === 'electron') return fakeElectron;
  if (req === './hub.cjs' && parent?.filename?.endsWith('account.cjs')) return { cached: () => hubCache };
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
  hubCache = null;
});

test('signed out of the Kea account: no account, whatever an old local one says', () => {
  write({ email: 'old@x.org', name: 'Old', verified: { email: 'old@x.org', by: 'Claude' } });
  assert.equal(account.get(), null);
  assert.equal(account.verified(), false);
});

test('name, email and verified come from the Kea account', () => {
  hubCache = { id: 'a1', email: 'ana@x.org', name: 'Ana', emailVerified: false, verifiedBy: null, owner: false };
  assert.deepEqual(account.get(), { email: 'ana@x.org', name: 'Ana', avatar: null, crop: null, verified: false, verifiedBy: null, verifiedHere: false, owner: false });
  hubCache = { ...hubCache, emailVerified: true, verifiedBy: 'google' };
  assert.equal(account.get().verified, true);
  assert.equal(account.get().verifiedBy, 'google');
  assert.equal(account.verified(), true);
});

test('an old local account: its picture goes with the first Kea account, its email and name are dropped, its proof only counts for the same email', () => {
  fs.writeFileSync(path.join(dir, 'account-avatar-1.png'), Buffer.from([137, 80, 78, 71]));
  write({ email: 'Ana@X.org', name: 'Local name', avatar: 'account-avatar-1.png', crop: { x: 0.5, y: 0.5, zoom: 1, w: 10, h: 10 }, verified: { email: 'ana@x.org', by: 'Claude' } });
  hubCache = { id: 'a1', email: 'ana@x.org', name: 'Ana', emailVerified: false };
  const a = account.get();
  assert.equal(a.name, 'Ana');
  assert.match(a.avatar, /^data:image\/png;base64,/);
  assert.equal(a.verified, true);
  assert.equal(a.verifiedHere, true);
  const kept = read();
  assert.equal(kept.accountId, 'a1');
  assert.equal(kept.email, undefined);
  assert.equal(kept.name, undefined);
  assert.equal(kept.proof.by, 'Claude');

  // Someone else signs in here: not Ana's picture, not Ana's proof.
  hubCache = { id: 'b2', email: 'ben@x.org', name: 'Ben', emailVerified: false };
  assert.equal(account.get().avatar, null);
  assert.equal(account.get().verified, false);

  // A proof for a different email never counts.
  write({ email: 'other@x.org', verified: { email: 'other@x.org', by: 'Google' } });
  assert.equal(account.get().verified, false);
});

test('a picture is changed only for its own account, and deleting the account removes it', async () => {
  hubCache = { id: 'a1', email: 'ana@x.org', name: 'Ana' };
  fs.writeFileSync(path.join(dir, 'account-avatar-2.png'), 'x');
  write({ accountId: 'a1', avatar: 'account-avatar-2.png' });
  hubCache = { id: 'b2', email: 'ben@x.org', name: 'Ben' };
  await assert.rejects(async () => handlers['account:crop']({}, { x: 0.5, y: 0.5, zoom: 1, w: 1, h: 1 }), /Choose a picture first/);
  account.forget('b2');
  assert.ok(fs.existsSync(file));
  account.forget('a1');
  assert.ok(!fs.existsSync(file));
  assert.ok(!fs.existsSync(path.join(dir, 'account-avatar-2.png')));
});

test('the old local account’s routes are gone', () => {
  for (const n of ['account:save', 'account:suggest', 'account:signOut', 'account:verify']) assert.equal(handlers[n], undefined, n);
  for (const n of ['account:get', 'account:verifyHere', 'account:avatar', 'account:crop']) assert.ok(handlers[n], n);
});
