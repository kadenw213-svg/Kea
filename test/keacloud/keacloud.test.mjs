// Kea cloud (electron/keaCloud.cjs) and the parts of hubsync.cjs it relies on: the pure rules, then two devices
// syncing documents through a real Kea Hub (from the KeaS repo next to this one, or KEAS_DIR).
//   node --test test/keacloud/
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerAndSignIn } from '../hubRegister.mjs';
import { ofetch } from '../ownerFetch.mjs';

const require = createRequire(import.meta.url);
const kc = require('../../electron/keaCloud.cjs');
const { createSync, httpClient, conflictName, skipName } = require('../../electron/scholar/hubsync.cjs');
const here = path.dirname(fileURLToPath(import.meta.url));
const HUB = [process.env.KEAS_DIR && path.join(process.env.KEAS_DIR, 'hub/index.mjs'), path.resolve(here, '../../../KeaS/hub/index.mjs')].find((p) => p && fs.existsSync(p)) || '';
const haveHub = !!HUB;

// ---------- Pure rules ----------
test('paths: only inside the Kea cloud folder', () => {
  const root = path.join(os.tmpdir(), 'hub-sync', 'Documents');
  assert.equal(kc.isInside(root, path.join(root, 'Essay.docx')), true);
  assert.equal(kc.isInside(root, path.join(root, 'Class', 'Notes.docx')), true);
  assert.equal(kc.isInside(root, root), true);
  assert.equal(kc.isInside(root, path.join(root, '..', 'Kea', 'School', 'kea-data.json')), false);
  assert.equal(kc.isInside(root, path.join(root + '-other', 'x.docx')), false);
  assert.equal(kc.isInside(root, path.parse(root).root), false);
});

test('file names a person can give a document', () => {
  for (const ok of ['Essay.docx', 'Lab report (final).docx', 'ünïcode notes.txt', 'a.b.c.pdf']) assert.equal(kc.validName(ok), true, ok);
  for (const bad of ['', '   ', '..', 'a/b.docx', 'a\\b.docx', 'what?.docx', 'CON', 'nul.txt', 'trailing.', 'x'.repeat(201)]) assert.equal(kc.validName(bad), false, JSON.stringify(bad));
});

test('a new document never replaces one already there', () => {
  const taken = new Set(['Essay.docx', 'Essay (2).docx', 'Notes']);
  const has = (n) => taken.has(n);
  assert.equal(kc.uniqueName('Budget.xlsx', has), 'Budget.xlsx');
  assert.equal(kc.uniqueName('Essay.docx', has), 'Essay (3).docx');
  assert.equal(kc.uniqueName('Notes', has), 'Notes (2)');
});

test("a clash keeps the other device's copy beside this one", () => {
  const taken = new Set(['Documents/Essay (from another device).docx']);
  assert.equal(conflictName('Documents/Essay.docx', () => false), 'Documents/Essay (from another device).docx');
  assert.equal(conflictName('Documents/Essay.docx', (r) => taken.has(r)), 'Documents/Essay (from another device 2).docx');
  assert.equal(conflictName('README', () => false), 'README (from another device)');
});

test('half-written saves and Office lock files never sync', () => {
  for (const n of ['Essay.docx.kea-tmp', 'x.tmp', 'y.part', '~$Essay.docx']) assert.equal(skipName(n), true, n);
  for (const n of ['Essay.docx', 'tmp.txt', 'partners.xlsx']) assert.equal(skipName(n), false, n);
});

test("each file's state, and the one word for the header", () => {
  const stat = { size: 10, mtimeMs: 1000 };
  assert.equal(kc.fileState(stat, { size: 10, mtime: 1000, v: 2 }), 'synced');
  assert.equal(kc.fileState(stat, { size: 10, mtime: 900, v: 2 }), 'pending');
  assert.equal(kc.fileState(stat, undefined), 'pending');
  assert.equal(kc.fileState(stat, undefined, 'full'), 'full');
  assert.equal(kc.fileState(stat, undefined, 'name'), 'local');
  assert.equal(kc.fileState(stat, undefined, 10), 'local', 'too big at this size');
  assert.equal(kc.fileState({ size: 11, mtimeMs: 2 }, undefined, 10), 'pending', 'changed since it was too big');

  const on = { on: true, last: 5, error: null };
  assert.equal(kc.summarize({ signedIn: false, enabled: true, sync: on, st: {}, pending: 0 }), 'signedOut');
  assert.equal(kc.summarize({ signedIn: true, enabled: false, sync: on, st: {}, pending: 0 }), 'off');
  assert.equal(kc.summarize({ signedIn: true, enabled: true, sync: { ...on, error: 'fetch failed', offline: true }, st: {}, pending: 0 }), 'offline');
  assert.equal(kc.summarize({ signedIn: true, enabled: true, sync: { ...on, error: 'Kea Hub said 500', offline: false }, st: {}, pending: 0 }), 'error');
  assert.equal(kc.summarize({ signedIn: true, enabled: true, sync: on, st: { full: { message: 'full' } }, pending: 0 }), 'full');
  assert.equal(kc.summarize({ signedIn: true, enabled: true, sync: on, st: {}, pending: 2 }), 'syncing');
  assert.equal(kc.summarize({ signedIn: true, enabled: true, sync: on, st: {}, pending: 0 }), 'synced');
});

test('scope: only Documents/ when Scholar syncs through another drive', () => {
  let onHub = false;
  const o = kc.syncOptions(() => onHub);
  assert.equal(o.scope()('Documents/Essay.docx'), true);
  assert.equal(o.scope()('Kea/School/kea-data.json'), false);
  assert.equal(o.scope()('DocumentsX/a.txt'), false);
  onHub = true;
  assert.equal(o.scope()('Kea/School/kea-data.json'), true);
  assert.equal(o.keepBoth('Documents/a.docx'), true);
  assert.equal(o.keepBoth('Kea/School/kea-data.json'), false);
});

// ---------- Against a real Kea Hub ----------
let hub, base, ownerBase, dir, token, accountId;
before(async () => {
  if (!haveHub) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-cloud-'));
  const { createHub } = await import(pathToFileURL(HUB).href);
  // (Unverified accounts get a small size on a real Hub; this test's account isn't verified.)
  hub = createHub({ dataDir: path.join(dir, 'hub'), log: false, defaultQuotaBytes: 1024 ** 3, unverifiedQuotaBytes: 1024 ** 3 });
  const p = await hub.listen({ port: 0, ownerPort: 0 });
  base = `http://127.0.0.1:${p.port}`;
  ownerBase = `http://127.0.0.1:${p.ownerPort}`;
  const t = (await (await fetch(`${base}/v1/terms`)).json()).terms;
  const r = await (await registerAndSignIn(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'doc@example.com', password: 'lantern velvet orbit', displayName: 'Doc', age13: true, birthYear: 1995, termsVersion: t.version, termsSections: t.sections.map((s) => s.id) }) })).json();
  token = r.token;
  accountId = r.account?.id;
});
after(async () => {
  if (!haveHub) return;
  await hub.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// A device: its own folder and state, syncing with Kea cloud's options. ("now" runs ahead so new files count as settled.)
function device(name, scholarOnHub = () => false) {
  const root = path.join(dir, name, 'hub-sync');
  const s = createSync({ root, stateFile: path.join(dir, name, 'state.json'), client: httpClient({ base: () => base, token: () => token, fetchFn: fetch }), now: () => Date.now() + 10_000, ...kc.syncOptions(scholarOnHub) });
  const w = (rel, text) => (fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }), fs.writeFileSync(path.join(root, rel), text));
  const r = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const has = (rel) => fs.existsSync(path.join(root, rel));
  return { root, s, w, r, has, full: () => (s.state().fullAt = 0) };
}
const hubFiles = async () => (await (await fetch(`${base}/v1/files?prefix=kea/`, { headers: { authorization: `Bearer ${token}` } })).json()).files.map((f) => f.path).sort();

test('documents go up and come down on another device; Scholar files stay out of scope', { skip: !haveHub && 'KeaS repo not next to this one' }, async () => {
  const A = device('A'), B = device('B');
  A.w('Documents/Essay.docx', 'v1');
  A.w('Documents/Class/Notes.txt', 'notes');
  A.w('Kea/School/kea-data.json', '{"scholar":"via OneDrive"}');
  A.w('Documents/Essay.docx.kea-tmp', 'half');
  let c = await A.s.cycle();
  assert.equal(c.up, 2);
  assert.deepEqual(await hubFiles(), ['kea/Documents/Class/Notes.txt', 'kea/Documents/Essay.docx']);
  assert.ok(A.s.state().storage.used > 0 && A.s.state().storage.quota === 1024 ** 3, 'storage used/total comes with the listing');
  await B.s.cycle();
  assert.equal(B.r('Documents/Essay.docx'), 'v1');
  assert.equal(B.r('Documents/Class/Notes.txt'), 'notes');

  // An edit on B reaches A.
  B.w('Documents/Essay.docx', 'v2 from B');
  await B.s.cycle();
  await A.s.cycle();
  assert.equal(A.r('Documents/Essay.docx'), 'v2 from B');

  // Deleted on A (rename is a delete plus a new file): gone from the Hub and, at the next full listing, from B.
  fs.renameSync(path.join(A.root, 'Documents/Class/Notes.txt'), path.join(A.root, 'Documents/Class/Lecture notes.txt'));
  await A.s.cycle();
  assert.deepEqual(await hubFiles(), ['kea/Documents/Class/Lecture notes.txt', 'kea/Documents/Essay.docx']);
  B.full();
  await B.s.cycle();
  assert.equal(B.has('Documents/Class/Notes.txt'), false);
  assert.equal(B.r('Documents/Class/Lecture notes.txt'), 'notes');
  // The Scholar file outside Documents/ was never sent, and never deleted.
  assert.equal(A.r('Kea/School/kea-data.json'), '{"scholar":"via OneDrive"}');
});

test('the same document changed on two devices: both versions are kept', { skip: !haveHub && 'KeaS repo not next to this one' }, async () => {
  const A = device('A'), B = device('B');
  await A.s.cycle();
  await B.s.cycle();
  A.w('Documents/Essay.docx', 'A edit');
  B.w('Documents/Essay.docx', 'B edit');
  await A.s.cycle();
  await B.s.cycle(); // B's change wins the name; A's version is kept beside it on B
  assert.equal(B.r('Documents/Essay.docx'), 'B edit');
  assert.equal(B.r('Documents/Essay (from another device).docx'), 'A edit');
  assert.equal(B.s.state().conflicts.at(-1).copy, 'Documents/Essay (from another device).docx');
  await B.s.cycle(); // the kept copy goes up
  await A.s.cycle();
  assert.equal(A.r('Documents/Essay.docx'), 'B edit');
  assert.equal(A.r('Documents/Essay (from another device).docx'), 'A edit');
});

test('narrowing the scope never deletes the files left out', { skip: !haveHub && 'KeaS repo not next to this one' }, async () => {
  let onHub = true;
  const C = device('C', () => onHub);
  C.w('Kea/School/kea-data.json', '{"v":1}');
  C.w('Documents/Plan.docx', 'plan');
  await C.s.cycle();
  assert.ok((await hubFiles()).includes('kea/Kea/School/kea-data.json'));
  onHub = false; // Scholar moved to OneDrive: Kea cloud keeps only documents in step
  fs.rmSync(path.join(C.root, 'Kea'), { recursive: true });
  C.full();
  await C.s.cycle();
  assert.ok((await hubFiles()).includes('kea/Kea/School/kea-data.json'), 'out of scope: left alone on the Hub');
});

test('a full Kea storage keeps the file here, says so, and syncs again when there is room', { skip: !haveHub && 'KeaS repo not next to this one' }, async () => {
  const owner = (p, body) => ofetch(ownerBase + p, { method: 'POST', headers: { 'x-kea-owner-key': hub.ownerKey, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const id = accountId || 'doc@example.com';
  const D = device('D');
  await D.s.cycle();
  await owner(`/owner/accounts/${id}/quota`, { gb: 0 });
  D.w('Documents/Big.pdf', 'x'.repeat(5000));
  const c = await D.s.cycle();
  assert.equal(c.up >= 0, true);
  assert.ok(D.s.state().full?.message, 'the Hub says why (its own words)');
  assert.equal(D.s.state().skip['Documents/Big.pdf'], 'full');
  assert.equal(kc.fileState(fs.statSync(path.join(D.root, 'Documents/Big.pdf')), D.s.state().files['Documents/Big.pdf'], D.s.state().skip['Documents/Big.pdf']), 'full');
  assert.ok(!(await hubFiles()).includes('kea/Documents/Big.pdf'));
  await owner(`/owner/accounts/${id}/quota`, { gb: null });
  await D.s.cycle();
  assert.equal(D.s.state().full, null);
  assert.ok((await hubFiles()).includes('kea/Documents/Big.pdf'));
});
