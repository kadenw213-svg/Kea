// Shared work folders on this PC (electron/teamFoldersCore.cjs) against a real KeaS 0.10 server (its own test helpers,
// from the KeaS repo beside this one, or KEAS_NEW_DIR): a copy comes down for everyone with access; a view-only copy is
// read-only and never goes up; an editor's save goes up; changes on both sides keep both; a file removed on the server
// goes here only if it wasn't changed here; Claude's file setting reaches the project file; losing access keeps the
// copy as an ordinary folder.
// Run: node --test test/work/teamFolders.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createTeamFolders, besideName } = require('../../electron/teamFoldersCore.cjs');
const keas = process.env.KEAS_NEW_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'KeaS');
const helpers = path.join(keas, 'test', 'org', 'helpers.mjs');
const has = fs.existsSync(path.join(keas, 'org', 'folders.mjs')) && fs.existsSync(helpers);

let H, boss, mgr, ana, pool, roles, folder;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-team-folders-'));
const call = (...a) => H.call(...a);
const ok = (...a) => H.ok(...a);

/** The client teamFolders.cjs gives the core, for one person (their session on the test server). */
function clientFor(who) {
  const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
  const fail = async (r) => {
    const d = await r.json().catch(() => ({}));
    throw Object.assign(new Error(d.error || String(r.status)), { status: r.status, data: d });
  };
  const url = (o, f, rest = '') => `${H.base}/v1/orgs/${o}/folders/${f}${rest}`;
  const auth = { authorization: `Bearer ${who.token}` };
  return {
    async files(_s, o, f, since) {
      const r = await fetch(url(o, f, `/files?since=${since || 0}`), { headers: auth });
      if (!r.ok) await fail(r);
      return r.json();
    },
    async get(_s, o, f, p) {
      const r = await fetch(url(o, f, `/files/${enc(p)}`), { headers: auth });
      if (!r.ok) await fail(r);
      return Buffer.from(await r.arrayBuffer());
    },
    async put(_s, o, f, p, data, { ifMatch, ifNoneMatch } = {}) {
      const r = await fetch(url(o, f, `/files/${enc(p)}`), { method: 'PUT', headers: { ...auth, ...(ifMatch ? { 'if-match': `"${ifMatch}"` } : {}), ...(ifNoneMatch ? { 'if-none-match': '*' } : {}) }, body: data });
      if (!r.ok) await fail(r);
      return r.json();
    },
    async orgName() {
      return 'Westside Pool';
    }
  };
}
const put = (who, p, text, headers = {}) => fetch(`${H.base}/v1/orgs/${pool.id}/folders/${folder.id}/files/${p.split('/').map(encodeURIComponent).join('/')}`, { method: 'PUT', headers: { authorization: `Bearer ${who.token}`, ...headers }, body: text });
const make = (who, name) => createTeamFolders({ stateFile: path.join(tmp, name, 'state.json'), rootDir: path.join(tmp, name, 'Documents'), client: clientFor(who) });
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

before(async () => {
  if (!has) return;
  const { startHub } = await import(pathToFileURL(helpers).href);
  H = await startHub({ clock: Date.UTC(2026, 10, 21, 16), prefix: 'kea-team-folders-hub-' });
  [boss, mgr, ana] = await Promise.all([H.person('boss@pool.org', 'Pat Boss'), H.person('mgr@pool.org', 'Max Manager'), H.person('ana@pool.org', 'Ana Ruiz')]);
  pool = await H.orgWith(boss, 'Westside Pool', [[mgr, 'manager'], [ana, 'member']]);
  roles = Object.fromEntries(ok(await call('GET', `/v1/orgs/${pool.id}/roles`, boss.token)).roles.map((r) => [r.templateKey ?? r.name, r]));
  folder = ok(await call('POST', `/v1/orgs/${pool.id}/folders`, boss.token, { name: 'Lesson plans' }), 201).folder;
  ok(await call('PUT', `/v1/orgs/${pool.id}/folders/${folder.id}/access`, boss.token, { grants: [{ kind: 'account', id: boss.id, access: 'manage' }, { kind: 'role', id: roles.manager.id, access: 'edit' }, { kind: 'account', id: ana.id, access: 'view' }] }));
  assert.equal((await put(boss, 'Week 1/plan.txt', 'Swim drills')).status, 201);
  assert.equal((await put(boss, 'notes.txt', 'Bring towels')).status, 201);
});
after(() => {
  H?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('names beside a file: "(your copy)", then numbered', () => {
  const taken = new Set(['a/Essay (your copy).docx']);
  assert.equal(besideName('a/Essay.docx', 'your copy', (p) => taken.has(p)), 'a/Essay (your copy 2).docx');
  assert.equal(besideName('notes', 'removed from shared folder', () => false), 'notes (removed from shared folder)');
});

test('a copy comes down for each person, read-only for the viewer, with the project file', { skip: !has && 'needs the KeaS repo (0.10 or later) beside Kea, or KEAS_NEW_DIR' }, async () => {
  const anaTf = make(ana, 'ana');
  const h = await anaTf.open({ src: 'hub', orgId: pool.id, folderId: folder.id });
  assert.equal(h.access, 'view');
  assert.equal(h.root, path.join(tmp, 'ana', 'Documents', 'Westside Pool', 'Lesson plans'));
  assert.equal(fs.readFileSync(path.join(h.root, 'Week 1', 'plan.txt'), 'utf8'), 'Swim drills');
  assert.equal(fs.readFileSync(path.join(h.root, 'notes.txt'), 'utf8'), 'Bring towels');
  const pj = readJson(path.join(h.root, '.kea-project.json'));
  assert.deepEqual([pj.kind, pj.name, pj.shared.access, pj.shared.orgId, pj.shared.claude, pj.shared.off], ['work', 'Lesson plans', 'view', pool.id, true, []]);
  if (process.platform === 'win32') assert.throws(() => fs.writeFileSync(path.join(h.root, 'notes.txt'), 'mine'), /EPERM|EACCES/);
  // A viewer's save never goes up.
  await assert.rejects(anaTf.upload(path.join(h.root, 'notes.txt')), /only view/);
});

test('an editor’s save goes up; everyone else gets it on the next pass', { skip: !has }, async () => {
  const mgrTf = make(mgr, 'mgr');
  const h = await mgrTf.open({ src: 'hub', orgId: pool.id, folderId: folder.id });
  assert.equal(h.access, 'edit');
  const f = path.join(h.root, 'Week 1', 'plan.txt');
  fs.writeFileSync(f, 'Swim drills, then relays');
  assert.deepEqual(await mgrTf.upload(f), { ok: true, version: 2 });
  assert.deepEqual(await mgrTf.upload(f), { ok: true, same: true });
  // A new file of theirs goes up too.
  fs.writeFileSync(path.join(h.root, 'Roster.csv'), 'name\nAna');
  assert.equal((await mgrTf.upload(path.join(h.root, 'Roster.csv'))).ok, true);
  const anaTf = make(ana, 'ana');
  await anaTf.syncAll();
  const root = path.join(tmp, 'ana', 'Documents', 'Westside Pool', 'Lesson plans');
  assert.equal(fs.readFileSync(path.join(root, 'Week 1', 'plan.txt'), 'utf8'), 'Swim drills, then relays');
  assert.equal(fs.readFileSync(path.join(root, 'Roster.csv'), 'utf8'), 'name\nAna');
});

test('changed here and on the server: both kept (theirs is the file, yours beside it)', { skip: !has }, async () => {
  const mgrTf = make(mgr, 'mgr');
  const root = path.join(tmp, 'mgr', 'Documents', 'Westside Pool', 'Lesson plans');
  // The owner changes notes.txt on the server; the manager changes it here before the next pass, then saves.
  assert.equal((await put(boss, 'notes.txt', 'Bring towels and caps', { 'if-match': '"1"' })).status, 200);
  fs.writeFileSync(path.join(root, 'notes.txt'), 'Bring goggles');
  const r = await mgrTf.upload(path.join(root, 'notes.txt'));
  assert.deepEqual(r, { conflict: true, keptAs: 'notes (your copy).txt' });
  assert.equal(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8'), 'Bring towels and caps');
  assert.equal(fs.readFileSync(path.join(root, 'notes (your copy).txt'), 'utf8'), 'Bring goggles');
  // Changed here, not saved up, and changed there: the next pass keeps both the same way.
  assert.equal((await put(boss, 'Roster.csv', 'name\nAna\nBen', { 'if-match': '"1"' })).status, 200);
  fs.writeFileSync(path.join(root, 'Roster.csv'), 'name\nAna\nCy');
  await mgrTf.syncAll();
  assert.equal(fs.readFileSync(path.join(root, 'Roster.csv'), 'utf8'), 'name\nAna\nBen');
  assert.equal(fs.readFileSync(path.join(root, 'Roster (your copy).csv'), 'utf8'), 'name\nAna\nCy');
});

test('Claude off for one file reaches every copy’s project file', { skip: !has }, async () => {
  ok(await call('PATCH', `/v1/orgs/${pool.id}/folders/${folder.id}/files/claude`, boss.token, { path: 'Week 1/plan.txt', claude: false }));
  const anaTf = make(ana, 'ana');
  // (A setting change alone shows up in the full listing.)
  anaTf._state().folders[`hub|${pool.id}|${folder.id}`].fullAt = 0;
  await anaTf.syncAll();
  const pj = readJson(path.join(tmp, 'ana', 'Documents', 'Westside Pool', 'Lesson plans', '.kea-project.json'));
  assert.deepEqual(pj.shared.off, ['Week 1/plan.txt']);
  // Turning the folder's switch off: every file.
  ok(await call('PATCH', `/v1/orgs/${pool.id}/folders/${folder.id}`, boss.token, { claude: false }));
  await anaTf.syncAll();
  const pj2 = readJson(path.join(tmp, 'ana', 'Documents', 'Westside Pool', 'Lesson plans', '.kea-project.json'));
  assert.equal(pj2.shared.claude, false);
  assert.deepEqual(pj2.shared.off, ['Roster.csv', 'Week 1/plan.txt', 'notes.txt']);
});

test('removed on the server: gone here when unchanged, kept (renamed) when changed here', { skip: !has }, async () => {
  const mgrTf = make(mgr, 'mgr');
  const root = path.join(tmp, 'mgr', 'Documents', 'Westside Pool', 'Lesson plans');
  await mgrTf.syncAll();
  fs.writeFileSync(path.join(root, 'Roster.csv'), 'name\nmine');
  const del = (p) => fetch(`${H.base}/v1/orgs/${pool.id}/folders/${folder.id}/files/${p.split('/').map(encodeURIComponent).join('/')}`, { method: 'DELETE', headers: { authorization: `Bearer ${boss.token}` } });
  assert.equal((await del('Week 1/plan.txt')).status, 200);
  assert.equal((await del('Roster.csv')).status, 200);
  mgrTf._state().folders[`hub|${pool.id}|${folder.id}`].fullAt = 0;
  await mgrTf.syncAll();
  assert.equal(fs.existsSync(path.join(root, 'Week 1', 'plan.txt')), false);
  assert.equal(fs.existsSync(path.join(root, 'Roster.csv')), false);
  assert.equal(fs.readFileSync(path.join(root, 'Roster (removed from shared folder).csv'), 'utf8'), 'name\nmine');
});

test('access taken away: the copy stops updating and becomes an ordinary folder, nothing deleted', { skip: !has }, async () => {
  ok(await call('PUT', `/v1/orgs/${pool.id}/folders/${folder.id}/access`, boss.token, { grants: [{ kind: 'account', id: boss.id, access: 'manage' }, { kind: 'role', id: roles.manager.id, access: 'edit' }] }));
  const anaTf = make(ana, 'ana');
  await anaTf.syncAll();
  const [h] = anaTf.list();
  assert.equal(h.gone, true);
  assert.equal(h.root, path.join(tmp, 'ana', 'Documents', 'Westside Pool (no longer shared)', 'Lesson plans'));
  assert.equal(fs.readFileSync(path.join(h.root, 'notes.txt'), 'utf8'), 'Bring towels and caps');
  assert.equal(readJson(path.join(h.root, '.kea-project.json')).shared, undefined);
  fs.writeFileSync(path.join(h.root, 'notes.txt'), 'writable again');
});

test('the Electron side loads and answers the page: nothing kept here yet, and bad ids refused', async () => {
  const electron = require('../worker/electronStub.cjs');
  const user = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-team-folders-ipc-'));
  electron._paths.userData = user;
  fs.writeFileSync(path.join(user, 'settings.json'), JSON.stringify({ 'scholar.cloud': 'off', 'scholar.pcSync': false }));
  const handlers = {};
  electron.ipcMain.handle = (name, fn) => (handlers[name] = fn);
  const page = { senderFrame: { url: 'app://kea/', parent: null }, sender: { send() {}, isDestroyed: () => false } };
  const tf = require('../../electron/teamFolders.cjs');
  tf.register();
  tf.stop();
  for (const n of ['list', 'here', 'create', 'open', 'forget', 'rename', 'remove', 'access', 'people', 'fileClaude', 'whereIs', 'upload', 'syncNow']) assert.ok(handlers[`teamFolders:${n}`], n);
  assert.deepEqual(await handlers['teamFolders:here'](page), { ok: true, value: [] });
  const bad = await handlers['teamFolders:open'](page, { orgId: '../x', folderId: 'f' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /which organization/);
  const notShared = await handlers['teamFolders:upload'](page, { file: path.join(user, 'a.docx') });
  assert.deepEqual([notShared.ok, notShared.error], [false, 'That file isn’t in a shared folder.']);
  fs.rmSync(user, { recursive: true, force: true });
});
