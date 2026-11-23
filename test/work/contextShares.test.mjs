// Sharing a context folder with another Kea account (electron/contextSharesCore.cjs) against a real Kea account
// server: KeaC 0.13's own test harness, from the KeaC repo beside this one (or KEAC_DIR). The owner shares their YMCA
// folder with their boss: its files, a linked file and a Google Sheet move up (the Google one as an .xlsx copy), the
// owner's PC keeps the shared copy and marks the old folder as moved, the boss sees it under "shared with me", adds it
// and gets the same files, an edit by the boss reaches the owner, and unsharing takes it away.
// Run: node --test test/work/contextShares.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createTeamFolders } = require('../../electron/teamFoldersCore.cjs');
const { createContextShares, preview, sharedOf } = require('../../electron/contextSharesCore.cjs');
const keac = process.env.KEAC_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'KeaC');
const harness = path.join(keac, 'test', 'harness.mjs');
const has = fs.existsSync(path.join(keac, 'server', 'personalOrgs.mjs')) && fs.existsSync(harness);

let K, owner, boss;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-context-shares-'));
const HUB = 'hub';
const enc = (p) => p.split('/').map(encodeURIComponent).join('/');

/** What contextShares.cjs gives the core, for one person signed in to the test server. */
function wiring(who, name) {
  const auth = { authorization: `Bearer ${who.token}` };
  const fail = async (r) => {
    const d = await r.json().catch(() => ({}));
    throw Object.assign(new Error(d.error || String(r.status)), { status: r.status, data: d });
  };
  const json = async (method, p, body) => {
    const r = await fetch(`${K.base}${p}`, { method, headers: { ...auth, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    if (!r.ok) await fail(r);
    return r.json();
  };
  const url = (o, f, rest = '') => `${K.base}/v1/orgs/${o}/folders/${f}${rest}`;
  const client = {
    files: async (_s, o, f, since) => json('GET', `/v1/orgs/${o}/folders/${f}/files?since=${since || 0}`),
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
    orgName: async () => `${name}'s copy`
  };
  const core = createTeamFolders({ stateFile: path.join(tmp, name, 'state.json'), rootDir: path.join(tmp, name, 'Documents'), client });
  const exportOffice = async (id) => ({ name: 'Shift swaps.xlsx', data: Buffer.from(`xlsx bytes for ${id}`) });
  return { core, shares: createContextShares({ json, client, core, HUB, exportOffice }) };
}

before(async () => {
  if (!has) return;
  const { startKeaC } = await import(pathToFileURL(harness).href);
  K = await startKeaC();
  owner = await K.person('kaden@example.com', 'Kaden Walsh');
  boss = await K.person('boss@ymca.example', 'Bea Boss');
});
after(async () => {
  await K?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('share a context folder with another Kea account, and they get the same files', { skip: !has && 'needs the KeaC repo beside Kea (or KEAC_DIR)' }, async () => {
  // The owner's YMCA folder: two files, a linked file elsewhere on the PC, a Google Sheet.
  const ymca = path.join(tmp, 'owner', 'YMCA');
  fs.mkdirSync(path.join(ymca, 'Week 1'), { recursive: true });
  fs.writeFileSync(path.join(ymca, 'Contacts.csv'), 'Name,Email\nLiam Chen,liam@example.org\n');
  fs.writeFileSync(path.join(ymca, 'Week 1', 'Availability.csv'), 'Name,Mon\nAva Brooks,AM\n');
  const elsewhere = path.join(tmp, 'owner', 'Desktop', 'Rules.md');
  fs.mkdirSync(path.dirname(elsewhere), { recursive: true });
  fs.writeFileSync(elsewhere, '# Desk rules');
  fs.writeFileSync(path.join(ymca, '.kea-project.json'), JSON.stringify({ name: 'YMCA front desk', kind: 'work', exclude: [], refs: [{ path: elsewhere, name: 'Rules.md' }], links: [{ kind: 'sheet', id: 'g1AbCdEfGhIjKlMnOpQrStUv', name: 'Shift swaps' }] }));

  // What sharing would move (the warning).
  assert.deepEqual(preview(ymca), { shared: false, files: 2, bytes: fs.statSync(path.join(ymca, 'Contacts.csv')).size + fs.statSync(path.join(ymca, 'Week 1', 'Availability.csv')).size, refs: 1, google: ['Shift swaps'] });

  const me = wiring(owner, 'owner');
  const steps = [];
  const r = await me.shares.share({ dir: ymca, email: 'BOSS@ymca.example', access: 'edit' }, (msg) => steps.push(msg));
  assert.equal(r.moved, true);
  assert.deepEqual(r.skipped, []);
  assert.equal(steps.length, 4);
  assert.ok(r.people.some((p) => p.email.toLowerCase() === 'boss@ymca.example' && p.access === 'edit'));

  // The owner's PC: the shared copy has every file, the old folder says where it went, the copy keeps its kind.
  const copy = r.root;
  for (const f of ['Contacts.csv', 'Week 1/Availability.csv', 'Rules.md', 'Shift swaps.xlsx']) assert.ok(fs.existsSync(path.join(copy, ...f.split('/'))), f);
  assert.equal(fs.readFileSync(path.join(copy, 'Shift swaps.xlsx'), 'utf8'), 'xlsx bytes for g1AbCdEfGhIjKlMnOpQrStUv');
  const old = JSON.parse(fs.readFileSync(path.join(ymca, '.kea-project.json'), 'utf8'));
  assert.equal(old.movedTo, copy);
  const pj = JSON.parse(fs.readFileSync(path.join(copy, '.kea-project.json'), 'utf8'));
  assert.equal(pj.kind, 'work');
  assert.equal(pj.shared.personal, true);
  assert.equal(pj.links, undefined);
  assert.deepEqual(sharedOf(ymca), { orgId: r.orgId, folderId: r.folderId, root: copy });
  // A second share doesn't move anything again.
  assert.equal(preview(ymca).shared, true);

  // The boss: it's listed as shared with them, they add it and get the same files.
  const them = wiring(boss, 'boss');
  const list = await them.shares.withMe();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'YMCA front desk');
  assert.equal(list[0].owner.name, 'Kaden Walsh');
  const theirs = await them.shares.add({ orgId: list[0].orgId, folderId: list[0].folderId });
  assert.equal(fs.readFileSync(path.join(theirs.root, 'Contacts.csv'), 'utf8'), 'Name,Email\nLiam Chen,liam@example.org\n');
  assert.equal(fs.readFileSync(path.join(theirs.root, 'Rules.md'), 'utf8'), '# Desk rules');

  // The boss edits a file in Kea (a save goes up); the owner's copy catches up.
  fs.writeFileSync(path.join(theirs.root, 'Contacts.csv'), 'Name,Email\nLiam Chen,liam@example.org\nNoah Evans,noah@example.org\n');
  const up = await them.core.upload(path.join(theirs.root, 'Contacts.csv'));
  assert.equal(up.ok, true);
  await me.core.syncAll();
  assert.match(fs.readFileSync(path.join(copy, 'Contacts.csv'), 'utf8'), /Noah Evans/);

  // Unsharing takes it away from the boss (their copy is kept, as an ordinary folder).
  const bossId = r.people.find((p) => p.email.toLowerCase() === 'boss@ymca.example').id;
  const after = await me.shares.unshare({ orgId: r.orgId, folderId: r.folderId, accountId: bossId });
  assert.ok(!after.some((p) => p.id === bossId));
  assert.deepEqual(await them.shares.withMe(), []);
  await them.core.syncAll();
  assert.equal(them.core.list()[0].gone, true);
});

test('sharing with an email that has no Kea account says so, and moves nothing', { skip: !has && 'needs the KeaC repo beside Kea (or KEAC_DIR)' }, async () => {
  const dir = path.join(tmp, 'owner', 'Solo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  fs.writeFileSync(path.join(dir, '.kea-project.json'), JSON.stringify({ name: 'Solo', kind: 'personal', exclude: [] }));
  const me = wiring(owner, 'owner2');
  await assert.rejects(me.shares.share({ dir, email: 'nobody@nowhere.example', access: 'view' }), /No Kea account uses that email/);
  // Nothing moved: the folder is still its own, and nothing is kept as a shared copy.
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.kea-project.json'), 'utf8')).movedTo, undefined);
  assert.equal(sharedOf(dir), null);
  assert.deepEqual(me.core.list(), []);
});
