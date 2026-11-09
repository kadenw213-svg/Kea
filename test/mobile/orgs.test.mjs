// Work on the phone (mobile/src/orgCore.ts): join links and addresses, the server's identity (Ed25519, pinned), the
// pass flow and its daily renewal, the account server being down, a server signing the account out, abilities, and
// the saved copy shown while servers can't be reached (clocking in is never queued). Against a fake Kea account
// server, fake KeaS servers and a stand-in for the phone's native side (test/mobile/orgFakes.mjs).
//   node --test test/mobile/orgs.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { clock, fakeAccount, fakeKeaC, fakeKeaS, fakePhone, memStore } from './orgFakes.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '../../mobile/src');

let C;
const open = [];
before(async () => {
  const esbuild = require('esbuild');
  const out = path.join(os.tmpdir(), `kea-phone-orgCore-${process.pid}.cjs`);
  await esbuild.build({ entryPoints: [path.join(src, 'orgCore.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
  C = require(out);
  fs.rmSync(out, { force: true });
});
after(async () => {
  await Promise.all(open.map((s) => s.close()));
});

/** A Kea account server, one KeaS and a phone signed in online, with a fresh client. */
async function world({ check = 'native', features, sessionMs, online = true } = {}) {
  const keac = await fakeKeaC(features ? { features } : {});
  const keas = await fakeKeaS({ keys: () => [keac.jwk], sessionMs });
  open.push(keac, keas);
  const phone = fakePhone({ keac, check });
  const account = fakeAccount(keac, { online });
  const store = memStore();
  const client = C.createOrgClient({ native: phone, account, store, now: () => clock.now() });
  return { keac, keas, phone, account, store, client };
}
/** Nothing the app's code got from the native side ever held a pass or a session. */
function noSecrets(w) {
  const all = w.phone.seenByApp.join('\n');
  for (const e of w.phone.rec.values()) {
    if (e.pass) assert.ok(!all.includes(e.pass), 'a pass reached the app');
    if (e.token) assert.ok(!all.includes(e.token), 'a session reached the app');
  }
  assert.ok(!/"pass"\s*:\s*"ey/.test(all));
  assert.ok(!/"token"\s*:/.test(all));
}

// ---------- links, codes and addresses ----------
test('join links, addresses and bare codes', () => {
  assert.deepEqual(C.parseJoin('kea://join?s=https%3A%2F%2Fpool.example.org%2F&c=POOL-1234'), { url: 'https://pool.example.org', code: 'POOL-1234' });
  assert.deepEqual(C.parseJoin('kea:join?s=pool.example.org&c=X1'), { url: 'https://pool.example.org', code: 'X1' });
  assert.deepEqual(C.parseJoin({ address: 'pool.example.org:8443', code: ' AB ' }), { url: 'https://pool.example.org:8443', code: 'AB' });
  assert.deepEqual(C.parseJoin('  LIB-CODE  '), { url: null, code: 'LIB-CODE' });
  assert.equal(C.joinLink('https://pool.example.org/', 'P 1'), 'kea://join?s=https%3A%2F%2Fpool.example.org&c=P%201');
  assert.throws(() => C.parseJoin('kea://join?s=https%3A%2F%2Fx.org'), /isn’t complete/);
  assert.throws(() => C.parseJoin('kea://open?s=a&c=b'), /isn’t a join link/);
  assert.throws(() => C.parseJoin({ address: 'http://pool.example.org', code: 'x' }), /https/);
  assert.throws(() => C.parseJoin({ address: 'ftp://pool.example.org', code: 'x' }), /https/);
  assert.throws(() => C.parseJoin({ address: 'https://me:pw@pool.example.org', code: 'x' }), /server address/);
  assert.throws(() => C.parseJoin(''), /join code/);
  assert.equal(C.cleanUrl('http://127.0.0.1:8080/x'), 'http://127.0.0.1:8080');
  assert.equal(C.hostedOrgsOn({ service: 'keac', features: ['pass', 'hostedOrgs'] }), true);
  assert.equal(C.hostedOrgsOn({ service: 'keac', features: ['pass'] }), false);
  assert.equal(C.hostedOrgsOn({ ok: true, service: 'kea-hub' }), true, 'a Kea Hub 0.5 has organizations on the account session');
  assert.equal(C.hostedOrgsOn(null), false);
});

// ---------- identity ----------
test('identity: Ed25519 checked natively or through WebCrypto, id bound to the key, and pinned on joining', async () => {
  const w = await world();
  const id = await w.client.identity(w.keas.url, null);
  assert.equal(id.serverId, w.keas.serverId);
  assert.equal(id.name, 'Westside Pool');
  // Older Android (no Ed25519 of its own): WebCrypto checks the signature.
  const old = await world({ check: 'unavailable' });
  assert.equal((await old.client.identity(old.keas.url, null)).serverId, old.keas.serverId);
  old.keas.state.mode = 'badSig';
  await assert.rejects(() => old.client.identity(old.keas.url, null), (e) => e.status === 495 && /signature is wrong/.test(e.message));
  // A wrong id or signature, whoever checks it.
  w.keas.state.mode = 'wrongId';
  await assert.rejects(() => w.client.identity(w.keas.url, null), (e) => e.status === 495 && /doesn’t match its key/.test(e.message));
  w.keas.state.mode = 'badSig';
  await assert.rejects(() => w.client.identity(w.keas.url, null), (e) => e.status === 495);
  w.keas.state.mode = 'ok';
  // The native verdict counts on its own too (a WebCrypto "yes" never outvotes a native "no").
  const a = JSON.parse((await w.phone.orgIdentity({ url: w.keas.url })).body);
  await assert.rejects(() => C.checkIdentity(a, 'other-nonce', null, 'ok'), /signature is wrong/);
  const r = await w.phone.orgIdentity({ url: w.keas.url });
  await assert.rejects(() => C.checkIdentity(JSON.parse(r.body), r.nonce, null, 'bad'), /signature is wrong/);
  assert.equal((await C.checkIdentity(JSON.parse(r.body), r.nonce, null, 'ok')).serverId, w.keas.serverId);
  // Neither can check: refused, with what fixes it.
  const proto = Object.getPrototypeOf(globalThis.crypto.subtle);
  const real = proto.importKey;
  proto.importKey = async function (fmt, key, alg, ...rest) {
    if (alg?.name === 'Ed25519') throw Object.assign(new Error('Algorithm: Unrecognized name'), { name: 'NotSupportedError' });
    return real.call(this, fmt, key, alg, ...rest);
  };
  try {
    const r2 = await w.phone.orgIdentity({ url: w.keas.url });
    await assert.rejects(() => C.checkIdentity(JSON.parse(r2.body), r2.nonce, null, 'unavailable'), (e) => e.status === 495 && e.data.unsupported && /WebView/.test(e.message));
    assert.equal((await C.checkIdentity(JSON.parse(r2.body), r2.nonce, null, 'ok')).serverId, w.keas.serverId);
  } finally {
    proto.importKey = real;
  }
  // Pinned: after joining, another key at the same address is refused.
  await w.client.join(w.keas.joinLink());
  w.keas.replaceKey();
  await assert.rejects(() => w.client.join(w.keas.joinLink()), (e) => e.status === 495 && e.data.changed);
  w.phone.rec.forEach((e) => delete e.token);
  await assert.rejects(() => w.client.orgs().then((o) => (o.servers[0].error ? Promise.reject(new Error(o.servers[0].error)) : o)), /isn’t the one you joined/);
  assert.ok(w.keas.state.passesSeen <= 1, 'no pass went to the replaced server');
});

// ---------- the pass flow ----------
test('joining by link: identity, a pass from the account server, the server’s own session; secrets stay native', async () => {
  const w = await world();
  assert.deepEqual(await w.client.servers(), []);
  const r = await w.client.join(w.keas.joinLink());
  assert.equal(r.org.name, 'Westside Pool');
  assert.equal(r.server.serverId, w.keas.serverId);
  assert.equal(r.server.hasPass, true);
  assert.equal(r.server.hasToken, true);
  assert.equal(w.keac.state.passes.length, 1);
  assert.equal(w.keac.state.passes[0].serverId, w.keas.serverId);
  assert.equal(w.keas.state.passesSeen, 1);
  // Advanced: the address and the code typed in.
  const again = await w.client.join({ address: w.keas.url, code: w.keas.code });
  assert.equal(again.server.serverId, w.keas.serverId);
  assert.equal((await w.client.servers()).length, 1);
  // A code that doesn't work leaves nothing behind.
  const other = await fakeKeaS({ keys: () => [w.keac.jwk], name: 'Eastside Gym' });
  open.push(other);
  await assert.rejects(() => w.client.join(other.joinLink('WRONG-CODE-000')), /code doesn’t work/);
  assert.equal((await w.client.servers()).length, 1);
  // The orgs list has it, with what I can do there.
  const o = await w.client.orgs();
  const pool = o.orgs.find((x) => x.src === w.keas.serverId);
  assert.equal(pool.name, 'Westside Pool');
  assert.deepEqual(pool.abilities, ['clock.self', 'timeoff.request']);
  assert.equal(pool.serverName, 'Westside Pool');
  noSecrets(w);
  // A pass made for another server is never kept for this one.
  const w2 = await world();
  w2.keac.state.wrongAud = true;
  await assert.rejects(() => w2.client.join(w2.keas.joinLink()), /pass for another server/);
  assert.equal(w2.keas.state.passesSeen, 0);
});

test('joining needs the account online; a bare code joins a hosted organization on the account session', async () => {
  const w = await world();
  const r = await w.client.join('LIBRARY-CODE-99');
  assert.equal(r.org.name, 'Riverside Library');
  assert.equal(r.server, null);
  assert.equal(w.keac.state.passes.length, 0, 'hosted organizations take no pass');
  await w.client.join(w.keas.joinLink());
  const o = await w.client.orgs();
  assert.deepEqual(o.orgs.map((x) => [x.name, x.src === C.HUB]).sort(), [['Riverside Library', true], ['Westside Pool', false]]);
  // An account server without hosted organizations: the code has to say which server.
  const nohost = await world({ features: ['pass'] });
  await assert.rejects(() => nohost.client.join('LIBRARY-CODE-99'), (e) => e.data.needsServer);
  // Signed in on the phone only: joining waits for online.
  const off = await world({ online: false });
  await assert.rejects(() => off.client.join(off.keas.joinLink()), (e) => e.data.needsOnline);
  await assert.rejects(() => off.client.join('LIBRARY-CODE-99'), (e) => e.data.needsOnline);
});

test('passes renew about once a day; while the account server is down the pass and session kept go on working', async () => {
  const w = await world({ sessionMs: 2 * 86400e3 });
  await w.client.join(w.keas.joinLink());
  assert.equal(w.keac.state.passes.length, 1);
  clock.add(3 * 3600e3);
  assert.deepEqual(await w.client.renew(), [], 'a pass a few hours old is kept');
  assert.equal(w.keac.state.passes.length, 1);
  clock.add(18 * 3600e3);
  const r = await w.client.renew();
  assert.deepEqual(r.map((x) => x.ok), [true]);
  assert.equal(w.keac.state.passes.length, 2, 'a day-old pass is renewed');
  // The account server goes down: renewing fails quietly and the server keeps answering on its session.
  w.keac.state.down = true;
  clock.add(21 * 3600e3);
  const r2 = await w.client.renew();
  assert.equal(r2.length, 1);
  assert.equal(w.keac.state.passes.length, 2);
  assert.equal((await w.client.shifts()).shifts.length, 2);
  // Its session ends while the account server is still down: a new session from the pass kept.
  w.keas.state.sessions.clear();
  const s = await w.client.shifts();
  assert.equal(s.shifts.length, 2);
  assert.equal(s.saved, false);
  assert.equal(w.keac.state.passes.length, 2);
  w.keac.state.down = false;
  // Signed in on this phone only (not online): the pass kept still works until it ends.
  w.account.on = false;
  w.keas.state.sessions.clear();
  assert.equal((await w.client.shifts()).shifts.length, 2);
  // Once it has ended and no new one can be had, the server waits for online.
  clock.add(8 * 86400e3);
  w.keas.state.sessions.clear();
  const o = await w.client.orgs();
  assert.match(o.servers[0].error || '', /Sign in with Google/);
  w.account.on = true;
  clock.add(-8 * 86400e3);
});

test('a server that refuses a brand-new pass has signed the account out; "Sign in again" asks it once more', async () => {
  const w = await world();
  await w.client.join(w.keas.joinLink());
  assert.equal((await w.client.orgs()).orgs.length, 1);
  const before = w.keac.state.passes.length;
  w.keas.state.revoked.add(w.keac.account.id);
  const o = await w.client.orgs();
  const sv = o.servers.find((x) => x.serverId === w.keas.serverId);
  assert.equal(sv.signedOut, true);
  assert.equal(w.keac.state.passes.length, before + 1, 'tried once with a new pass first');
  const [view] = await w.client.servers();
  assert.equal(view.signedOut, true);
  assert.equal(view.hasToken, false);
  // From then on nothing is sent to it until "Sign in again".
  const seen = w.keas.state.passesSeen;
  assert.equal(o.orgs.length, 0);
  await assert.rejects(() => w.client.call(w.keas.org.id, 'GET', `/v1/orgs/${w.keas.org.id}/clock`), (e) => e.status === 401 && e.data.signedOut && /Westside Pool signed you out/.test(e.message));
  assert.equal(w.keas.state.passesSeen, seen);
  await assert.rejects(() => w.client.again(w.keas.serverId), /signed you out/);
  w.keas.state.revoked.clear();
  const back = await w.client.again(w.keas.serverId);
  assert.equal(back.signedOut, false);
  assert.equal((await w.client.orgs()).orgs.length, 1);
  noSecrets(w);
});

// ---------- abilities ----------
test('abilities: the server’s list and scopes, or the fixed role on a Kea Hub 0.5', () => {
  const member = { memberStatus: 'active', role: 'member', abilities: ['clock.self', 'timeoff.request'] };
  assert.equal(C.can(member, 'clock.self'), true);
  assert.equal(C.can(member, 'timecards.approve'), false);
  const a = C.workAreas(member);
  assert.equal(a.clock, true);
  assert.equal(a.approvals, false);
  assert.equal(a.editShifts, false);
  // A custom role given for one department.
  const lead = { memberStatus: 'active', role: 'member', abilities: ['clock.self', 'swaps.decide', 'schedule.edit'], scopes: { 'swaps.decide': ['d1'], 'schedule.edit': ['d1'] } };
  assert.equal(C.can(lead, 'swaps.decide'), true);
  assert.equal(C.can(lead, 'swaps.decide', 'd1'), true);
  assert.equal(C.can(lead, 'swaps.decide', 'd2'), false);
  assert.equal(C.can(lead, 'swaps.decide', null), false);
  assert.equal(C.workAreas(lead).approvals, true);
  assert.equal(C.workAreas(lead).approveJoins, false);
  // A Kea Hub 0.5 sends only the role.
  assert.equal(C.can({ memberStatus: 'active', role: 'manager' }, 'timecards.approve'), true);
  assert.equal(C.can({ memberStatus: 'active', role: 'manager' }, 'rates.view'), false);
  assert.equal(C.can({ memberStatus: 'active', role: 'member' }, 'people.approve'), false);
  assert.equal(C.can({ memberStatus: 'active', role: 'owner' }, 'anything.at.all'), true);
  // Waiting to be approved: nothing yet.
  assert.equal(C.can({ ...member, memberStatus: 'pending' }, 'clock.self'), false);
  assert.equal(C.canAny(lead, ['people.approve', 'swaps.decide']), true);
});

test('abilities come from each organization’s me, per server', async () => {
  const w = await world();
  await w.client.join(w.keas.joinLink());
  w.keas.state.abilities = ['clock.self', 'timeoff.request', 'timecards.approve'];
  let [org] = (await w.client.orgs()).orgs;
  assert.equal(C.workAreas(org).approveTimecards, true);
  // A server without custom roles (Hub 0.5 style): the role decides.
  w.keas.state.abilities = null;
  w.keas.state.role = 'manager';
  [org] = (await w.client.orgs()).orgs;
  assert.equal(org.abilities, null);
  assert.equal(C.workAreas(org).decideSwaps, true);
});

// ---------- offline ----------
test('offline: the saved shifts and to-dos are shown; clocking in is never queued', async () => {
  const w = await world();
  await w.client.join(w.keas.joinLink());
  await w.client.join('LIBRARY-CODE-99');
  const s1 = await w.client.shifts();
  assert.deepEqual(s1.shifts.map((s) => s.id), ['pool-1', 'lib-1', 'pool-2']);
  assert.equal(s1.saved, false);
  const t1 = await w.client.todo();
  assert.deepEqual(t1.items.map((t) => t.title).sort(), ['Read the library rules', 'Read the pool rules']);
  // The pool's server can't be reached: its part comes from the saved copy, the library's is live.
  w.keas.state.down = true;
  const s2 = await w.client.shifts();
  assert.deepEqual(s2.shifts.map((s) => s.id), ['pool-1', 'lib-1', 'pool-2']);
  assert.equal(s2.saved, true);
  assert.deepEqual(s2.offline, [w.keas.serverId]);
  const t2 = await w.client.todo();
  assert.equal(t2.items.length, 2);
  assert.equal(t2.saved, true);
  // Everything unreachable (no signal): all of it from the copy.
  w.keac.state.down = true;
  const s3 = await w.client.shifts();
  assert.equal(s3.shifts.length, 3);
  assert.equal(s3.saved, true);
  assert.ok(s3.at > 0);
  assert.equal((await w.client.todo()).items.length, 2);
  assert.equal(w.client.saved().shifts.length, 3);
  // Clocking in: said plainly, and nothing is sent later.
  const pool = s3.orgs.find((o) => o.src === w.keas.serverId);
  await assert.rejects(() => w.client.clock(pool.id, 'in'), (e) => e.status === 0 && e.data.notQueued && e.message === 'Clocking in needs a connection to Westside Pool.');
  w.keas.state.down = false;
  w.keac.state.down = false;
  await w.client.orgs();
  assert.equal(w.keas.state.punches.length, 0);
  // Back online: clocking in with a pay code works.
  const r = await w.client.clock(pool.id, 'in', 'pc-life');
  assert.equal(r.punch.payCodeId, 'pc-life');
  assert.equal(w.keas.state.punches[0].source, 'phone');
  // Shifts that ended drop out of the copy.
  clock.add(10 * 86400e3);
  assert.equal(w.client.saved().shifts.length, 0);
  clock.add(-10 * 86400e3);
});

test('each account on the phone has its own servers and saved copy', async () => {
  const w = await world();
  await w.client.join(w.keas.joinLink());
  await w.client.shifts();
  assert.equal(w.client.saved().shifts.length, 2);
  w.account.k = 'local-ben';
  assert.deepEqual(await w.client.servers(), []);
  assert.deepEqual(w.client.saved().shifts, []);
  assert.deepEqual(w.client.saved().orgs, []);
  // (A copy that says it's another account's is never shown, even under this one's key.)
  w.store.set('kea.work.local-ben', w.store.get('kea.work.local-ana'));
  assert.deepEqual(w.client.saved().shifts, []);
  w.account.k = 'local-ana';
  assert.equal(w.client.saved().shifts.length, 2);
  w.client.forgetCache();
  assert.equal(w.client.saved().shifts.length, 0);
  // Removing a server forgets it and its part of the copy.
  await w.client.shifts();
  await w.client.remove(w.keas.serverId);
  assert.deepEqual(await w.client.servers(), []);
  assert.equal(w.client.saved().shifts.length, 0);
  // Only org routes are sent.
  await assert.rejects(() => w.client.call('x', 'GET', '/v1/files?prefix=kea/'), /can’t send that|isn’t one of yours/);
});
