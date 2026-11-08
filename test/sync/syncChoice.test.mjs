// Where your things sync (electron/syncChoice.cjs): the choices, switching (a copy goes to the new place, nothing is
// deleted, the old place keeps its copy), and the one-time move from "Automatic" to an explicit choice.
//   node --test test/sync/
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-syncchoice-'));
const userData = path.join(dir, 'userData');
fs.mkdirSync(userData, { recursive: true });
const gdrive = path.join(dir, 'My Drive');
const onedrive = path.join(dir, 'OneDrive');
fs.mkdirSync(gdrive);
fs.mkdirSync(onedrive);

const state = { signedIn: true, restarted: 0, servers: [], drives: [] };
const hubRoot = path.join(userData, 'hub-sync');
const fakeHub = { signedIn: () => state.signedIn, cached: () => ({ email: 'ana@example.com' }), syncRoot: () => hubRoot, url: () => 'http://127.0.0.1:1', _token: () => 't', restartSync: () => state.restarted++ };
// cloud.cjs as it would be: the drives here, and the profile folder in whichever is chosen.
let settings;
const driveFor = (id) => (id === 'kea-hub' ? (state.signedIn ? { id, path: hubRoot } : null) : id === 'custom' ? { id, path: settings.get('scholar.cloudPath') } : state.drives.find((d) => d.id === id) || (id.startsWith('keas:') ? { id, path: path.join(userData, 'keas-sync', id.slice(5)) } : null));
const fakeCloud = {
  drives: () => state.drives,
  autoDrive: () => (state.signedIn ? { id: 'kea-hub', path: hubRoot } : state.drives.find((d) => d.id === 'onedrive') || state.drives[0] || null),
  drive: () => driveFor(settings.get('scholar.cloud', 'kea-hub')),
  target: () => {
    const d = fakeCloud.drive();
    return d?.path ? path.join(d.path, 'Kea', 'School') : null;
  },
};
const electron = { app: { getPath: () => userData }, ipcMain: { handle() {}, on() {} }, BrowserWindow: { getAllWindows: () => [] } };
const load = Module._load;
Module._load = function (req, parent, ...rest) {
  if (req === 'electron') return electron;
  if (parent?.filename?.endsWith('syncChoice.cjs')) {
    if (req === './hub.cjs') return fakeHub;
    if (req === './scholar/cloud.cjs') return fakeCloud;
    if (req === './servers.cjs') return { list: () => state.servers, store: () => ({ _secretOf: () => ({ token: 'keas-token' }), session: async () => 'keas-token' }) };
    if (req === './scholar/index.cjs') return { driveChanged: async () => {} };
  }
  return load.call(this, req, parent, ...rest);
};
settings = require('../../electron/settings.cjs');
const sc = require('../../electron/syncChoice.cjs');
after(() => {
  Module._load = load;
  fs.rmSync(dir, { recursive: true, force: true });
});
const write = (p, text, mtime) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  if (mtime) fs.utimesSync(p, mtime, mtime);
};
beforeEach(() => {
  state.signedIn = true;
  state.servers = [];
  state.drives = [{ id: 'google', label: 'Google Drive', path: gdrive, account: 'G: drive' }, { id: 'onedrive', label: 'OneDrive', path: onedrive, account: 'ana@outlook.com' }];
  settings.set({ 'scholar.cloud': null, 'scholar.cloudPath': null, 'sync.migrated': null });
});

test('copying into the new place: what’s missing is copied, nothing is replaced or deleted', () => {
  const a = path.join(dir, 'copy-a');
  const b = path.join(dir, 'copy-b');
  const t = new Date('2026-11-01T10:00:00Z');
  write(path.join(a, 'Essay.docx'), 'mine', t);
  write(path.join(a, 'Class', 'Notes.docx'), 'notes', t);
  write(path.join(a, 'Same.txt'), 'same', t);
  write(path.join(a, '~$Essay.docx'), 'lock');
  write(path.join(b, 'Essay.docx'), 'theirs');
  write(path.join(b, 'Same.txt'), 'same', t);
  write(path.join(b, 'Only there.txt'), 'x');
  const r = sc._pure.copyInto(a, b, 'Kea cloud');
  assert.deepEqual(r, { copied: 1, same: 1, kept: 1 });
  assert.equal(fs.readFileSync(path.join(b, 'Essay.docx'), 'utf8'), 'theirs', 'never replaced');
  assert.equal(fs.readFileSync(path.join(b, 'Essay (from Kea cloud).docx'), 'utf8'), 'mine');
  assert.equal(fs.readFileSync(path.join(b, 'Class', 'Notes.docx'), 'utf8'), 'notes');
  assert.ok(fs.existsSync(path.join(b, 'Only there.txt')));
  assert.ok(!fs.existsSync(path.join(b, '~$Essay.docx')), 'lock files stay behind');
  assert.equal(fs.readFileSync(path.join(a, 'Essay.docx'), 'utf8'), 'mine', 'the old place keeps its copy');
  // Twice: nothing more happens.
  assert.deepEqual(sc._pure.copyInto(a, b, 'Kea cloud'), { copied: 0, same: 2, kept: 1 });
});

test('the confirmation says what gets a copy where', () => {
  const kea = { id: 'kea-hub', kind: 'kea', label: 'Kea cloud' };
  const off = { id: 'off', kind: 'off', label: 'Off' };
  const gd = { id: 'google', kind: 'drive', label: 'Google Drive' };
  assert.equal(sc._pure.previewText({ from: off, to: kea, documents: 1, classes: false, phone: false }), '1 document gets a copy in Kea cloud.');
  assert.equal(sc._pure.previewText({ from: kea, to: gd, documents: 3, classes: true, phone: false }), 'Your classes and 3 documents get a copy in Google Drive. Nothing is deleted: the copy in Kea cloud stays as it is.');
  assert.equal(sc._pure.previewText({ from: gd, to: kea, documents: 0, classes: false, phone: false }), 'Your things sync through Kea cloud from now on. Nothing is deleted: the copy in Google Drive stays as it is.');
});

test('the choices: Kea cloud first, the drives (also ones not here), a folder, joined servers, off', () => {
  state.servers = [{ serverId: 'S1aaaaaaaaaaaaaaaaaaaa', name: 'Westside Pool', url: 'https://pool.example.org', signedOut: false }];
  state.drives = state.drives.filter((d) => d.id !== 'google');
  const o = sc.options();
  assert.deepEqual(o.map((x) => x.id), ['kea-hub', 'google', 'onedrive', 'dropbox', 'custom', 'keas:S1aaaaaaaaaaaaaaaaaaaa', 'off']);
  assert.deepEqual(o.map((x) => x.available), [true, false, true, false, false, true, true]);
  assert.equal(o[0].label, 'Kea cloud');
  assert.equal(o[0].locked, false);
  state.signedIn = false;
  assert.deepEqual([sc.placeOf('kea-hub').locked, sc.placeOf('kea-hub').why], [true, 'needsOnline'], 'locked until online');
  assert.equal(sc.current(), 'kea-hub', 'Kea cloud is the default');
});

test('switching from Kea cloud to Google Drive: documents and the phone’s file get a copy, the old ones stay', async () => {
  write(path.join(hubRoot, 'Documents', 'Essay.docx'), 'essay');
  write(path.join(hubRoot, 'Kea', 'School', 'phone.json'), '{"marks":1}');
  const p = sc.preview('google');
  assert.equal(p.documents, 1);
  assert.match(p.text, /^Your classes and 1 document get a copy in Google Drive\. Nothing is deleted: the copy in Kea cloud stays as it is\. On your phone, choose Google Drive/);
  const before = state.restarted;
  const r = await sc.choose('google');
  assert.equal(settings.get('scholar.cloud'), 'google');
  assert.equal(r.choice, 'google');
  assert.equal(fs.readFileSync(path.join(gdrive, 'Kea Documents', 'Essay.docx'), 'utf8'), 'essay');
  assert.equal(fs.readFileSync(path.join(gdrive, 'Kea', 'School', 'phone.json'), 'utf8'), '{"marks":1}');
  assert.ok(fs.existsSync(path.join(hubRoot, 'Documents', 'Essay.docx')), 'the Kea cloud copy stays');
  assert.equal(state.restarted, before + 1, 'the syncs restart for the new place');
  assert.equal(sc.serverPlace(), null, 'a drive syncs by itself: no server mirror');
  assert.equal(sc.docsRoot(), path.join(gdrive, 'Kea Documents'));
});

test('a drive that isn’t here, or a folder not picked: refused, and the choice stays', async () => {
  state.drives = state.drives.filter((d) => d.id !== 'google');
  await assert.rejects(sc.choose('google'), /isn’t on this computer/);
  await assert.rejects(sc.choose('dropbox'), /isn’t on this computer/);
  await assert.rejects(sc.choose('custom'), /Pick a folder/);
  await assert.rejects(sc.choose('custom', '\\\\server\\share'), /Pick a folder/);
  await assert.rejects(sc.choose('somewhere'), /can’t sync there/);
  assert.equal(sc.current(), 'kea-hub');
  const mine = path.join(dir, 'Synced folder');
  fs.mkdirSync(mine, { recursive: true });
  await sc.choose('custom', mine);
  assert.deepEqual([settings.get('scholar.cloud'), settings.get('scholar.cloudPath')], ['custom', mine]);
  assert.equal(sc.placeOf('custom').detail, mine);
});

test('a KeaS server: it syncs through its own folder here with its session; off keeps things on this computer', async () => {
  state.servers = [{ serverId: 'S1aaaaaaaaaaaaaaaaaaaa', name: 'Westside Pool', url: 'https://pool.example.org', signedOut: false }];
  await sc.choose('keas:S1aaaaaaaaaaaaaaaaaaaa');
  const sp = sc.serverPlace();
  assert.equal(sp.key, 'keas:S1aaaaaaaaaaaaaaaaaaaa');
  assert.equal(sp.base(), 'https://pool.example.org');
  assert.equal(sp.token(), 'keas-token');
  assert.equal(sp.root, path.join(userData, 'keas-sync', 'S1aaaaaaaaaaaaaaaaaaaa'));
  assert.equal(sc.docsRoot(), path.join(sp.root, 'Documents'));
  // Signed out of it: nothing syncs there until it lets the account in again.
  state.servers[0].signedOut = true;
  assert.equal(sc.serverPlace(), null);
  assert.equal(sc.placeOf('keas:S1aaaaaaaaaaaaaaaaaaaa').why, 'signedOut');
  const p = sc.preview('off');
  assert.match(p.text, /^Nothing new leaves this computer from now on\./);
  await sc.choose('off');
  assert.equal(sc.docsRoot(), path.join(userData, 'Kea Documents'));
});

test('updating: a computer on “Automatic” keeps syncing where it did', () => {
  // Signed in online: Kea cloud.
  sc.migrate();
  assert.equal(settings.get('scholar.cloud'), 'kea-hub');
  // Not online, already syncing through OneDrive (its Kea folder is there): stays on OneDrive.
  settings.set({ 'scholar.cloud': 'auto', 'sync.migrated': null });
  state.signedIn = false;
  fs.mkdirSync(path.join(onedrive, 'Kea'), { recursive: true });
  sc.migrate();
  assert.equal(settings.get('scholar.cloud'), 'onedrive');
  // Never synced anywhere: Kea cloud (locked until online).
  fs.rmSync(path.join(onedrive, 'Kea'), { recursive: true });
  settings.set({ 'scholar.cloud': null, 'sync.migrated': null });
  sc.migrate();
  assert.equal(settings.get('scholar.cloud'), 'kea-hub');
  // A choice someone made stays, and it only ever runs once.
  settings.set({ 'scholar.cloud': 'off', 'sync.migrated': null });
  sc.migrate();
  assert.equal(settings.get('scholar.cloud'), 'off');
  settings.set({ 'scholar.cloud': 'auto' });
  sc.migrate();
  assert.equal(settings.get('scholar.cloud'), 'auto');
});
