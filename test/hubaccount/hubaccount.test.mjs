// The Kea account's notifications in Kea (electron/hubNotes.cjs): which ones become Windows notifications (each once,
// and no flood on a new computer), and a round trip with a real Kea Hub (KeaS/hub, next to this repo or at KEAS_DIR):
// the owner changes the account's storage and supporter time, Kea shows each notice once, marks them read, and the
// phone number and supporter badge come back the way the account panel and member lists read them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const HUB = [process.env.KEAS_DIR && path.join(process.env.KEAS_DIR, 'hub/index.mjs'), path.resolve(here, '../../../KeaS/hub/index.mjs')].find((p) => p && fs.existsSync(p)) || '';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-hubaccount-'));
// Stand-ins for Electron, settings and hub.cjs: Windows notifications are recorded instead of shown.
const handlers = {};
const toasts = [];
const sent = [];
const settingsValues = {};
class FakeNotification {
  constructor(o) {
    this.o = o;
  }
  static isSupported() {
    return true;
  }
  on() {}
  show() {
    toasts.push(this.o);
  }
}
const fakeElectron = {
  app: { getPath: () => dir },
  ipcMain: { handle: (n, f) => (handlers[n] = f) },
  Notification: FakeNotification,
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (...a) => sent.push(a) } }] },
};
let hubBase = null, token = null, account = null, refreshed = 0;
const fakeHub = {
  cached: () => account,
  signedIn: () => !!token,
  refreshStatus: async () => (refreshed++, null),
  req: async (method, p, body) => {
    const r = await fetch(hubBase + p, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await r.json();
    if (!r.ok) throw Object.assign(new Error(data.error), { status: r.status });
    return data;
  },
};
const load = Module._load;
Module._load = function (req, parent, ...rest) {
  if (req === 'electron') return fakeElectron;
  if (parent?.filename?.endsWith('hubNotes.cjs')) {
    if (req === './hub.cjs') return fakeHub;
    if (req === './settings.cjs') return { get: (k, d) => (k in settingsValues ? settingsValues[k] : d) };
    if (req === './scholar/notify.cjs') return { silent: () => false };
  }
  return load.call(this, req, parent, ...rest);
};
const notes = require('../../electron/hubNotes.cjs');
notes.register();
const N = notes._test;

const DAY = 86400_000;
const n = (id, extra = {}) => ({ id, kind: 'notice', title: `Notice ${id}`, body: '', note: null, createdAt: Date.now() - 1000, readAt: null, ...extra });

test('Windows notifications: each new unread one once, oldest first', () => {
  assert.deepEqual(N.toShow([n(5), n(4), n(3, { readAt: 1 }), n(2)], 3).map((x) => x.id), [4, 5]);
  assert.deepEqual(N.toShow([n(5), n(4)], 5), []);
  assert.equal(N.highest([n(5), n(9)], 7), 9);
  assert.equal(N.highest([], 7), 7);
  assert.equal(N.highest([], null), 0);
});

test('a new computer: only the newest few from the last few days, not a flood of old notices', () => {
  const now = Date.now();
  const list = [n(10), n(9), n(8), n(7), n(6, { createdAt: now - 10 * DAY })];
  assert.deepEqual(N.toShow(list, null, { nowMs: now }).map((x) => x.id), [8, 9, 10]);
  assert.deepEqual(N.toShow([n(6, { createdAt: now - 10 * DAY })], null, { nowMs: now }), []);
});

test('notification text: the owner’s note, quoted; long text shortened', () => {
  assert.deepEqual(N.toastText(n(1, { title: 'Your Kea storage is now 5,000 GB', body: '', note: 'For your project.' })), { title: 'Your Kea storage is now 5,000 GB', body: '“For your project.”' });
  assert.equal(N.toastText(n(1, { body: 'x'.repeat(400) })).body.length, 238);
  assert.equal(N.refreshesAccount([n(1, { kind: 'storage' })]), true);
  assert.equal(N.refreshesAccount([n(1, { kind: 'material' })]), false);
});

let hub, ownerBase;
before(async () => {
  if (!HUB) return;
  const { createHub } = await import(pathToFileURL(HUB).href);
  hub = createHub({ dataDir: path.join(dir, 'hub'), log: false, minFreeBytes: 0 });
  const p = await hub.listen({ port: 0, ownerPort: 0 });
  hubBase = `http://127.0.0.1:${p.port}`;
  ownerBase = `http://127.0.0.1:${p.ownerPort}`;
});
after(async () => {
  Module._load = load;
  if (hub) await hub.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
const owner = (method, p, body) => fetch(ownerBase + p, { method, headers: { 'content-type': 'application/json', 'x-kea-owner-key': hub.ownerKey }, body: body && JSON.stringify(body) }).then((r) => r.json());

test('with a real Kea Hub: the owner’s changes arrive once, read state round-trips, badge and phone come back', { skip: !HUB && 'KeaS repo not found (set KEAS_DIR)' }, async () => {
  const t = (await (await fetch(`${hubBase}/v1/terms`)).json()).terms;
  for (const id of ['phone-number', 'notifications', 'supporters']) assert.ok(t.sections.some((s) => s.id === id), `terms section ${id}`);
  const reg = await (await fetch(`${hubBase}/v1/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'sam@example.com', password: 'lantern velvet orbit', displayName: 'Sam', age13: true, termsVersion: t.version, termsSections: t.sections.map((s) => s.id) }) })).json();
  token = reg.token;
  account = { id: reg.account.id };
  // The standard storage is 5 GB.
  const me0 = await fakeHub.req('GET', '/v1/me');
  assert.equal(me0.storage.quota, 5 * 1024 ** 3);

  await owner('POST', '/owner/accounts/sam@example.com/quota', { gb: 5000, note: 'For your video project.' });
  await owner('POST', '/owner/accounts/sam@example.com/supporter', { months: 1 });
  const first = await handlers['hub:notifications']();
  assert.equal(first.ok, true, first.error);
  assert.equal(first.value.unread, 2);
  assert.deepEqual(toasts.map((x) => x.title), ['Your Kea storage is now 5,000 GB', 'Thank you for supporting Kea!']);
  assert.equal(toasts[0].body, '“For your video project.”');
  assert.ok(refreshed > 0, 'storage and supporter notices refresh the account panel');
  assert.ok(sent.some(([ch]) => ch === 'hub:notifications'), 'the page is told');

  // Polling again shows nothing twice; a new notice shows once.
  await notes.poll();
  assert.equal(toasts.length, 2);
  await owner('POST', '/owner/accounts/sam@example.com/claude', { limits: { perAccountWeekly: 20 } });
  await notes.poll();
  assert.equal(toasts.length, 3);
  assert.match(toasts[2].title, /up to 20 times a week/);

  // Turned off in Settings: still listed, no Windows notification.
  settingsValues['hub.notifyDesktop'] = false;
  await owner('POST', '/owner/accounts/sam@example.com/notify', { title: 'Quiet one' });
  const quiet = await handlers['hub:notifications']();
  assert.equal(toasts.length, 3);
  assert.equal(quiet.value.notifications[0].title, 'Quiet one');
  delete settingsValues['hub.notifyDesktop'];

  // Mark one read, then all; clear the read ones.
  const one = await handlers['hub:notificationsRead']({}, { ids: [quiet.value.notifications[0].id] });
  assert.equal(one.value.unread, quiet.value.unread - 1);
  const all = await handlers['hub:notificationsRead']({}, { all: true });
  assert.equal(all.value.unread, 0);
  const cleared = await handlers['hub:notificationsDelete']({}, { all: true });
  assert.equal(cleared.value.notifications.length, 0);

  // What the account panel reads: the supporter badge, 5,000 GB, and the phone number in the shape Kea sends it.
  const me = await fakeHub.req('POST', '/v1/me/phone', { phone: '+1 719 555 0100', visibility: 'classes' });
  assert.deepEqual(me.account.phone, { number: '+17195550100', visibility: 'classes' });
  const status = await fakeHub.req('GET', '/v1/me');
  assert.equal(status.account.supporter.active, true);
  assert.equal(status.storage.quota, 5000 * 1024 ** 3);
  assert.equal(status.notifications.unread, 0);
  await assert.rejects(fakeHub.req('POST', '/v1/me/phone', { phone: 'call me' }), /phone number/);

  // Another account signed in on this computer starts its own record (nothing carried over).
  account = { id: 'someone-else' };
  token = null;
  assert.equal((await handlers['hub:notifications']()).value.notifications.length, 0);
});
