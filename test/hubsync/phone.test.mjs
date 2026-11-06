// The phone's Hub sync (mobile/src/hubsync.ts): its rules against a stand-in Hub, then a real Kea Hub with Kea on a PC
// (electron/scholar/hubsync.cjs) on the other side.
//   node --test test/hubsync/phone.test.mjs
// The real-Hub part needs the KeaS repo: next to this one (../KeaS), or named by KEAS_DIR.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerAndSignIn } from '../hubRegister.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = require('../../electron/scholar/hubsync.cjs');
const HUB = [process.env.KEAS_DIR && path.join(process.env.KEAS_DIR, 'hub/index.mjs'), path.resolve(here, '../../../KeaS/hub/index.mjs')].find((p) => p && fs.existsSync(p));

// The phone's TypeScript, bundled for Node the way the app bundles it.
let P;
before(async () => {
  const out = path.join(os.tmpdir(), `kea-phone-hubsync-${process.pid}.cjs`);
  await require('esbuild').build({ entryPoints: [path.resolve(here, '../../mobile/src/hubsync.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
  P = require(out);
  fs.rmSync(out, { force: true });
});

// ---------- the rules, against a stand-in Hub ----------
function fakeHub() {
  const files = new Map(); // path -> { text, version, updatedAt, sha256, size }
  let t = 1000;
  const hub = {
    files,
    write(p, text) {
      const old = files.get(p);
      files.set(p, { text, version: (old?.version ?? 0) + 1, updatedAt: ++t, sha256: `sha-${text}`, size: text.length });
    },
    del: (p) => files.delete(p),
    local: new Map(),
    calls: { get: 0, download: 0, put: 0 },
    client: {
      async list(prefix, since) {
        return { now: t + 1, files: [...files].filter(([p, f]) => p.startsWith(prefix) && f.updatedAt > since).map(([p, f]) => ({ path: p, size: f.size, version: f.version, sha256: f.sha256, updatedAt: f.updatedAt })) };
      },
      async getText(p) {
        hub.calls.get++;
        const f = files.get(p);
        if (!f) throw Object.assign(new Error('No such file.'), { status: 404 });
        return { text: f.text, version: f.version };
      },
      async download(p, to) {
        hub.calls.download++;
        hub.local.set(to, files.get(p).text);
      },
      async removeLocal(to) {
        hub.local.delete(to);
      },
      async putText(p, text, { ifMatch, ifNoneMatch }) {
        hub.calls.put++;
        const f = files.get(p);
        if ((ifNoneMatch && f) || (ifMatch && f?.version !== ifMatch)) throw Object.assign(new Error('changed'), { status: 412, data: { version: f?.version ?? null } });
        hub.write(p, text);
        return { version: files.get(p).version };
      }
    }
  };
  return hub;
}
const phone = (hub, clock = { t: 0 }) => {
  let saved = null;
  const s = P.createPhoneSync({ client: hub.client, load: () => saved && JSON.parse(saved), save: (x) => (saved = JSON.stringify(x)), now: () => clock.t, log: (m) => (s.logs = [...(s.logs || []), m]) });
  return s;
};

test('names are encoded exactly as Kea on the PC encodes them', () => {
  for (const n of ['Ch 1 #cells [v2].pdf', 'a~b.json', 'Quiz: 3?.json', 'ünïcode ok.txt', 'Biology 101 — Fall', '日本語 notes', 'emoji 📘.pdf']) {
    assert.equal(P.encodeSeg(n), desktop.encodeSeg(n), n);
    assert.equal(P.decodeSeg(P.encodeSeg(n)), n);
  }
  const rel = 'Kea/My School #2027/Textbooks/BIO 101/Ch 1 #cells.pdf';
  assert.equal(P.toRemote(rel), desktop.toRemote(rel));
  assert.equal(P.toLocal(desktop.toRemote(rel)), rel);
});

test('profiles: every Kea → <profile> folder that has the data file', () => {
  const list = ['kea/Kea/School/kea-data.json', 'kea/Kea/School/phone.json', `kea/Kea/${P.encodeSeg('Work #2')}/kea-data.json`, 'kea/Kea/Empty/Devices/x.json'].map((path) => ({ path }));
  assert.deepEqual(P.profilesIn(list), ['School', 'Work #2']);
});

test('only what changed moves; textbooks queue until the library step', async () => {
  const hub = fakeHub();
  hub.write('kea/Kea/School/kea-data.json', '{"v":1}');
  hub.write('kea/Kea/School/Textbooks/BIO/ch1.pdf', 'pdf1');
  hub.write('kea/Kea/School/Devices/primary.json', '{}');
  hub.write('kea/Kea/Other/kea-data.json', '{"other":1}');
  const clock = { t: 0 };
  const s = phone(hub, clock);
  await assert.rejects(s.pull(), /profile/);
  s.use('School');
  let r = await s.pull();
  assert.equal(r.data, '{"v":1}');
  assert.deepEqual(Object.keys(s.state().todo), ['Textbooks/BIO/ch1.pdf']);
  let lib = await s.library();
  assert.equal(lib.files, 1);
  assert.equal(hub.local.get('Textbooks/BIO/ch1.pdf'), 'pdf1');
  assert.ok(!hub.local.has('Devices/primary.json'), 'the PCs’ device files stay off the phone');

  // Nothing changed: no data read, no download.
  clock.t += 1000;
  r = await s.pull();
  assert.equal(r.data, null);
  assert.equal((await s.library()).files, 0);
  assert.equal(hub.calls.get, 1);
  assert.equal(hub.calls.download, 1);

  // Asked for anyway (no copy kept on the phone): read by name, even from a "what changed" listing.
  r = await s.pull(true);
  assert.equal(r.data, '{"v":1}');

  // The PC changes one chapter and the data: just those.
  hub.write('kea/Kea/School/Textbooks/BIO/ch2.pdf', 'pdf2');
  hub.write('kea/Kea/School/kea-data.json', '{"v":2}');
  r = await s.pull();
  assert.equal(r.data, '{"v":2}');
  lib = await s.library();
  assert.equal(lib.files, 1);
  assert.equal(hub.local.get('Textbooks/BIO/ch2.pdf'), 'pdf2');
});

test('a name with an impossible code point is skipped, and the sync goes on', async () => {
  // (Past U+10FFFF, or more than 6 hex digits: String.fromCodePoint would throw and stop the whole sync.)
  assert.equal(P.decodeSeg('a~110000~b'), null);
  assert.equal(P.decodeSeg('a~0000041~b'), null);
  assert.equal(P.decodeSeg('a~10ffff~b'), 'a\u{10ffff}b');
  assert.equal(P.toLocal('kea/Kea/School/Textbooks/x~ffffffff~.pdf'), null);
  assert.deepEqual(P.profilesIn([{ path: 'kea/Kea/Bad~110000~/kea-data.json' }, { path: 'kea/Kea/School/kea-data.json' }]), ['School']);
  const hub = fakeHub();
  hub.write('kea/Kea/School/kea-data.json', '{"v":1}');
  hub.write('kea/Kea/School/Textbooks/BIO/bad~110000~.pdf', 'bad');
  hub.write('kea/Kea/School/Textbooks/BIO/ch1.pdf', 'pdf1');
  const s = phone(hub);
  s.use('School');
  const r = await s.pull();
  assert.equal(r.data, '{"v":1}');
  assert.deepEqual(Object.keys(s.state().todo), ['Textbooks/BIO/ch1.pdf']);
  assert.equal((await s.library()).files, 1);
  assert.equal(hub.local.get('Textbooks/BIO/ch1.pdf'), 'pdf1');
  assert.ok(s.logs.some((m) => /Skipped/.test(m)));
});

test('deletions arrive with the full listing; a mass disappearance deletes nothing', async () => {
  const hub = fakeHub();
  hub.write('kea/Kea/School/kea-data.json', '{}');
  for (let i = 0; i < 30; i++) hub.write(`kea/Kea/School/Textbooks/C/ch${i}.pdf`, `p${i}`);
  const clock = { t: 0 };
  const s = phone(hub, clock);
  s.use('School');
  await s.pull();
  await s.library();
  assert.equal(hub.local.size, 30);

  // One deleted on the PC: gone here after the next full listing (not the quick ones between).
  hub.del('kea/Kea/School/Textbooks/C/ch0.pdf');
  clock.t += 1000;
  await s.pull();
  await s.library();
  assert.ok(hub.local.has('Textbooks/C/ch0.pdf'));
  clock.t += P.FULL_EVERY + 1;
  await s.pull();
  const lib = await s.library();
  assert.equal(lib.removed, 1);
  assert.ok(!hub.local.has('Textbooks/C/ch0.pdf'));

  // Most of them vanish at once (a renamed profile, a listing gone wrong): nothing is removed.
  for (let i = 1; i < 25; i++) hub.del(`kea/Kea/School/Textbooks/C/ch${i}.pdf`);
  clock.t += P.FULL_EVERY + 1;
  await s.pull();
  assert.equal((await s.library()).removed, 0);
  assert.equal(hub.local.size, 29);
  assert.match(s.logs.join('\n'), /none were removed/);
});

test('phone.json: sent only when it changed, and the phone wins a clash', async () => {
  const hub = fakeHub();
  hub.write('kea/Kea/School/kea-data.json', '{}');
  const s = phone(hub);
  s.use('School');
  assert.equal(await s.push('{"done":1}'), true);
  assert.equal(await s.push('{"done":1}'), false);
  assert.equal(hub.calls.put, 1);
  // Another copy of the phone (a reinstall) wrote it meanwhile: this change goes over that version.
  hub.write('kea/Kea/School/phone.json', '{"other":1}');
  assert.equal(await s.push('{"done":2}'), true);
  assert.equal(hub.files.get('kea/Kea/School/phone.json').text, '{"done":2}');
  // The versions seen in a listing are used for the next send, without a clash.
  hub.write('kea/Kea/School/phone.json', '{"x":1}');
  await s.pull();
  const puts = hub.calls.put;
  await s.push('{"done":3}');
  assert.equal(hub.calls.put, puts + 1);
});

test('a profile with no data file yet says so in plain words', async () => {
  const hub = fakeHub();
  const s = phone(hub);
  s.use('School');
  await assert.rejects(s.pull(true), /no classes in your Kea storage yet/);
});

// ---------- against a real Kea Hub, with Kea on a PC on the other side ----------
let hub, base, dir, token;
before(async () => {
  if (!HUB) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-phone-hub-'));
  const { createHub } = await import(pathToFileURL(HUB).href);
  hub = createHub({ dataDir: path.join(dir, 'hub'), log: false, defaultQuotaBytes: 1024 ** 3 });
  const p = await hub.listen({ port: 0, ownerPort: 0 });
  base = `http://127.0.0.1:${p.port}`;
  const t = (await (await fetch(`${base}/v1/terms`)).json()).terms;
  const r = await registerAndSignIn(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'phone@example.com', password: 'lantern velvet orbit', displayName: 'Me', age13: true, termsVersion: t.version, termsSections: t.sections.map((s) => s.id) }) });
  token = (await r.json()).token;
});
after(async () => {
  if (!HUB) return;
  await hub.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The phone's client as KeaPlugin + hub.ts make it, over plain HTTP (the native side's job, done here with fetch). */
function realPhoneClient(libRoot) {
  const H = () => ({ authorization: `Bearer ${token}`, 'x-kea-client': 'Kea for Android' });
  const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
  const fail = async (r) => {
    const data = await r.json().catch(() => ({}));
    throw Object.assign(new Error(data.error || String(r.status)), { status: r.status, data });
  };
  return {
    async list(prefix, since) {
      const r = await fetch(`${base}/v1/files?prefix=${encodeURIComponent(prefix)}&since=${since || 0}`, { headers: H() });
      if (!r.ok) await fail(r);
      return r.json();
    },
    async getText(p) {
      const r = await fetch(`${base}/v1/files/${enc(p)}`, { headers: H() });
      if (!r.ok) await fail(r);
      return { text: await r.text(), version: Number(String(r.headers.get('etag')).replace(/"/g, '')) };
    },
    async download(p, to) {
      const r = await fetch(`${base}/v1/files/${enc(p)}`, { headers: H() });
      if (!r.ok) await fail(r);
      const file = path.join(libRoot, to);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    },
    async removeLocal(to) {
      fs.rmSync(path.join(libRoot, to), { force: true });
    },
    async putText(p, text, { ifMatch, ifNoneMatch }) {
      const r = await fetch(`${base}/v1/files/${enc(p)}`, { method: 'PUT', headers: { ...H(), ...(ifMatch ? { 'if-match': `"${ifMatch}"` } : {}), ...(ifNoneMatch ? { 'if-none-match': '*' } : {}) }, body: text });
      if (!r.ok) await fail(r);
      return r.json();
    }
  };
}

test('Kea on a PC and the phone stay in step through a real Kea Hub', { skip: !HUB && 'KeaS repo not found (set KEAS_DIR)' }, async () => {
  // The PC: its Kea Hub sync folder, as cloud.cjs syncHub lays it out.
  const pcRoot = path.join(dir, 'pc', 'hub-sync');
  const pc = desktop.createSync({ root: pcRoot, stateFile: path.join(dir, 'pc', 'state.json'), client: desktop.httpClient({ base: () => base, token: () => token, fetchFn: fetch }), now: () => Date.now() + 10_000 });
  const w = (rel, text) => (fs.mkdirSync(path.dirname(path.join(pcRoot, rel)), { recursive: true }), fs.writeFileSync(path.join(pcRoot, rel), text));
  w('Kea/School #2027/kea-data.json', '{"courses":[{"code":"BIO 101"}]}');
  w('Kea/School #2027/Textbooks/BIO 101/Ch 1 #cells.pdf', '%PDF chapter one');
  w('Kea/School #2027/Devices/primary.json', '{"id":"pc"}');
  await pc.cycle();

  const libRoot = path.join(dir, 'phone', 'library');
  let saved = null;
  const clock = { t: Date.now() };
  const ph = P.createPhoneSync({ client: realPhoneClient(libRoot), load: () => saved && JSON.parse(saved), save: (x) => (saved = JSON.stringify(x)), now: () => clock.t });
  const listed = await realPhoneClient(libRoot).list('kea/Kea/', 0);
  assert.deepEqual(P.profilesIn(listed.files), ['School #2027']);
  ph.use('School #2027');
  const r = await ph.pull();
  assert.equal(JSON.parse(r.data).courses[0].code, 'BIO 101');
  await ph.library();
  assert.equal(fs.readFileSync(path.join(libRoot, 'Textbooks/BIO 101/Ch 1 #cells.pdf'), 'utf8'), '%PDF chapter one');

  // The phone's checkmarks reach the PC's folder, where Kea reads phone.json.
  await ph.push('{"done":{"a":{"on":true}}}');
  await pc.cycle();
  assert.equal(fs.readFileSync(path.join(pcRoot, 'Kea/School #2027/phone.json'), 'utf8'), '{"done":{"a":{"on":true}}}');

  // A newer chapter on the PC, and an old one deleted: the phone follows (the deletion with its next full listing).
  w('Kea/School #2027/Textbooks/BIO 101/Ch 2.pdf', '%PDF chapter two');
  fs.rmSync(path.join(pcRoot, 'Kea/School #2027/Textbooks/BIO 101/Ch 1 #cells.pdf'));
  await pc.cycle();
  clock.t += P.FULL_EVERY + 1;
  await ph.pull();
  await ph.library();
  assert.ok(fs.existsSync(path.join(libRoot, 'Textbooks/BIO 101/Ch 2.pdf')));
  assert.ok(!fs.existsSync(path.join(libRoot, 'Textbooks/BIO 101/Ch 1 #cells.pdf')));

  // The phone's next change goes over whatever version is there, and the PC gets it.
  await ph.push('{"done":{"b":{"on":true}}}');
  await pc.cycle();
  assert.equal(fs.readFileSync(path.join(pcRoot, 'Kea/School #2027/phone.json'), 'utf8'), '{"done":{"b":{"on":true}}}');
});
