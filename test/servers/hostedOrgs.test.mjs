// Organizations hosted on the Kea account server, and pay codes in Work (electron/hubOrg.cjs with the rules in
// src/components/work/payRules.ts), against a fake account server that hosts orgs (fakes.mjs fakeHostedKeaC) and a
// joined KeaS: hosted orgs listed beside the KeaS server's, signed in with the account session itself (no pass), a
// plain join code going to the account server, the hosting application flow (POST /v1/orgs refused), a suspended
// and a removed organization, and who sees which pay codes and rates, and which codes the pickers offer.
//   node --test test/servers/
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { fakeHostedKeaC, fakeKeaC, fakeKeaS } from './fakes.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const core = require('../../electron/serversCore.cjs');
const { timedFetch } = require('../../electron/accountCore.cjs');
const APP = { senderFrame: { url: 'app://kea/index.html', parent: null } };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-hosted-'));
const hosted = await fakeHostedKeaC();
const passes = await fakeKeaC();
const keas = await fakeKeaS({ keys: () => [passes.jwk] });

// hub.cjs's req, the way it talks to the Kea account server: the account's own session (Bearer), and { auth: false }.
let session = 'sess-ana';
let hubUrl = hosted.url;
const hubReq = async (method, p, body, { auth = true } = {}) => {
  let r;
  try {
    r = await timedFetch(fetch, hubUrl + p, { method, headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${session}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }, 3000);
  } catch {
    throw Object.assign(new Error('offline'), { status: 0 });
  }
  const j = r.json();
  if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status, data: j });
  return j;
};
// (The KeaS server's passes come from a pass-issuing fake; the account server itself never sees a pass request.)
const passReq = async (method, p, body) => {
  const r = await timedFetch(fetch, passes.url + p, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${passes.session}` }, body: body === undefined ? undefined : JSON.stringify(body) }, 3000);
  const j = r.json();
  if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status, data: j });
  return j;
};
const S = core.createServers({ file: path.join(dir, 'l.json'), secretsFile: path.join(dir, 's.bin'), fetchFn: fetch, timedFetch, account: { key: () => 'local-ana', req: passReq } });

const handlers = {};
const fakeElectron = { app: { getPath: () => dir }, ipcMain: { handle: (n, f) => (handlers[n] = f) }, dialog: {}, BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] }, shell: {} };
const load = Module._load;
Module._load = function (req, parent, ...rest) {
  if (req === 'electron') return fakeElectron;
  if (req === './hub.cjs' && parent?.filename?.endsWith('hubOrg.cjs')) return { req: (...a) => hubReq(...a), cached: () => ({ id: 'acct-ana' }), signedIn: () => true };
  if (req === './servers.cjs' && parent?.filename?.endsWith('hubOrg.cjs')) return { list: () => S.list(), req: (...a) => S.req(...a) };
  return load.call(this, req, parent, ...rest);
};
const hubOrg = require('../../electron/hubOrg.cjs');
hubOrg.register();
const call = async (method, p, body) => {
  const r = await handlers['hubOrg:call'](APP, { method, path: p, body });
  if (!r.ok) throw Object.assign(new Error(r.error), { status: r.status, data: r.data });
  return r.value;
};
const as = (s) => (session = s);

let R; // src/components/work/payRules.ts
before(async () => {
  const out = path.join(os.tmpdir(), `kea-payrules-${process.pid}.cjs`);
  await require('esbuild').build({ entryPoints: [path.resolve(here, '../../src/components/work/payRules.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
  R = require(out);
  fs.rmSync(out, { force: true });
});
after(async () => {
  Module._load = load;
  await keas.close();
  await passes.close();
  await hosted.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
/** An org as Work holds it (refreshOrgs): the list entry with what GET /v1/orgs/:id says I can do. */
async function orgAs(s, id = 'hosted-camp') {
  as(s);
  const d = await call('GET', `/v1/orgs/${id}`);
  return { ...d.org, abilities: d.me.abilities, scopes: d.me.scopes, roles: d.me.roles };
}

// ---------- hosted organizations ----------
test('hosted organizations are listed beside a KeaS server’s, with the account session and no pass', async () => {
  as('sess-ana');
  await S.join(keas.joinLink());
  const r = await call('GET', '/v1/orgs');
  assert.deepEqual(r.orgs.map((o) => [o.name, o.server?.name ?? null, !!o.hosted]), [['Pine Hollow Camp', null, true], ['Westside Pool', 'Westside Pool', false]]);
  assert.deepEqual(r.account, { hostedOrgs: true, applications: true });
  assert.ok(!hosted.state.sent.some((x) => x.includes('/v1/pass')), 'the account server was never asked for a pass for its own orgs');
  assert.ok(hosted.state.sent.includes('GET /v1/orgs'));
  // Each organization's routes go to its own server.
  hosted.state.sent.length = 0;
  await call('GET', '/v1/orgs/hosted-camp');
  await call('GET', `/v1/orgs/${keas.state.orgs[0].id}`);
  assert.deepEqual(hosted.state.sent, ['GET /v1/orgs/hosted-camp']);
});

test('a plain join code goes to the Kea account server', async () => {
  hosted.state.orgs.push({ id: 'hosted-swim', name: 'Swim Club', kind: 'school', tz: 'America/Denver', status: 'active', code: 'SWIM-CLUB-0001' });
  as('sess-ana');
  hosted.state.sent.length = 0;
  const r = await call('POST', '/v1/orgs/join', { code: 'swim club 0001' });
  assert.equal(r.org.name, 'Swim Club');
  assert.deepEqual(hosted.state.sent, ['POST /v1/orgs/join']);
  assert.ok((await call('GET', '/v1/orgs')).orgs.some((o) => o.id === 'hosted-swim' && o.hosted));
});

test('making an organization is an application: refused directly, pending, then approved into the list', async () => {
  as('sess-bo');
  await assert.rejects(call('POST', '/v1/orgs', { name: 'Bo’s Pool' }), (e) => e.status === 403);
  assert.deepEqual((await call('GET', '/v1/apply')).applications, []);
  assert.equal(R.latestApplication([], 'hosting'), null);
  const sent = await call('POST', '/v1/apply', { kind: 'hosting', orgKind: 'employer', name: 'Bo’s Pool', note: 'About 20 lifeguards.' });
  assert.equal(sent.status, 'pending');
  await assert.rejects(call('POST', '/v1/apply', { kind: 'hosting', orgKind: 'employer', name: 'Again' }), /already waiting/);
  let last = R.latestApplication((await call('GET', '/v1/apply')).applications, 'hosting');
  assert.equal(R.applicationLine(last), 'Bo’s Pool: your application is waiting for review.');
  const o = hosted.approve(last.id);
  last = R.latestApplication((await call('GET', '/v1/apply')).applications, 'hosting');
  assert.equal(R.applicationLine(last), 'Bo’s Pool was approved. It’s in your organizations.');
  const list = await call('GET', '/v1/orgs');
  assert.ok(list.orgs.some((x) => x.id === o.id && x.name === 'Bo’s Pool' && x.hosted));
  // A declined one says why, and another can be sent.
  await call('POST', '/v1/apply', { kind: 'hosting', orgKind: 'school', name: 'Bo’s School', note: '' });
  hosted.decline(R.latestApplication((await call('GET', '/v1/apply')).applications, 'hosting').id, 'Please run your own KeaS.');
  assert.equal(R.applicationLine(R.latestApplication((await call('GET', '/v1/apply')).applications, 'hosting')), 'Bo’s School wasn’t approved: Please run your own KeaS. You can apply again.');
});

test('a creator application (classes in the public list) through School, in the older shape too', async () => {
  const { _test: hc } = require('../../electron/hubClasses.cjs');
  as('sess-cy');
  assert.deepEqual(hc.creatorStatus(await hubReq('GET', '/v1/apply')), { status: 'none' });
  const r = await hubReq('POST', '/v1/apply', { kind: 'creator', note: 'A study group for BIOL 1010.', organization: 'Pikes Peak State College' });
  assert.equal(hc.creatorStatus({ applications: [r.application] }).status, 'pending');
  hosted.decline(r.application.id, 'Add more detail.');
  assert.deepEqual(hc.creatorStatus(await hubReq('GET', '/v1/apply')), { status: 'rejected', note: 'Add more detail.', appliedAt: r.application.createdAt, organization: 'Pikes Peak State College' });
  assert.deepEqual(hc.creatorStatus({ creator: true, applications: [] }), { status: 'approved' });
});

test('a suspended organization answers 403 and shows as suspended; a removed one 404', async () => {
  const camp = hosted.state.orgs.find((o) => o.id === 'hosted-swim');
  camp.status = 'suspended';
  as('sess-ana');
  const e = await call('GET', '/v1/orgs/hosted-swim').catch((x) => x);
  assert.equal(e.status, 403);
  assert.equal(R.orgGone(e), 'suspended');
  hosted.state.orgs.splice(hosted.state.orgs.indexOf(camp), 1);
  const gone = await call('GET', '/v1/orgs/hosted-swim').catch((x) => x);
  assert.equal(R.orgGone(gone), 'removed');
  assert.equal(R.orgGone({ status: 0, message: 'offline' }), null, 'offline changes nothing');
  assert.equal(R.orgGone({ status: 403, message: 'You can’t do that.' }), null, 'a plain refusal isn’t a suspension');
});

test('an older account server (no hostedOrgs): no applications, and Work still lists the KeaS server', async () => {
  const old = await fakeHostedKeaC({ features: [] });
  hubOrg._resetFeatures();
  hubUrl = old.url;
  try {
    const r = await call('GET', '/v1/orgs');
    assert.deepEqual(r.account, { hostedOrgs: false, applications: false });
    assert.deepEqual(r.orgs.map((o) => o.name), ['Westside Pool']);
  } finally {
    hubUrl = hosted.url;
    hubOrg._resetFeatures();
    await old.close();
  }
});

// ---------- pay codes ----------
test('a member sees only the codes they were given, with their own rates; the picker offers only those turned on', async () => {
  as('sess-ana');
  const my = await call('GET', '/v1/orgs/hosted-camp/me/pay');
  assert.deepEqual(my.codes.map((c) => c.name), ['Lifeguard', 'Swim instructor', 'Old code']);
  assert.ok(!my.codes.some((c) => c.name === 'Front desk'), 'never a code they weren’t given');
  assert.deepEqual(R.pickable(my).map((c) => c.id), ['pc-guard', 'pc-swim'], 'a turned-off code isn’t offered');
  assert.equal(R.codeLabel(my.codes[0], true), 'Lifeguard · $15.00/h', 'their own rate');
  // The organization's list and other people's codes stay closed to a member.
  await assert.rejects(call('GET', '/v1/orgs/hosted-camp/pay-codes'), (e) => e.status === 403);
  await assert.rejects(call('GET', '/v1/orgs/hosted-camp/members/acct-bo/pay-codes'), (e) => e.status === 403);
  const member = await orgAs('sess-ana');
  assert.equal(R.seesCodeList(member), false);
  assert.equal(R.seesRates(member), false);
  // No stubs from this server: nothing to show (and the note it sends isn't one).
  assert.equal(R.stubsOf(my), null);
  hosted.state.stubs = [{ id: 's1', periodStart: '2026-10-18', periodEnd: '2026-10-31', payDate: '2026-11-06', grossCents: 61500, net: 540.25 }];
  const withStubs = await call('GET', '/v1/orgs/hosted-camp/me/pay');
  assert.equal(R.stubsOf(withStubs).length, 1);
  assert.deepEqual([R.stubCents(withStubs.stubs[0], 'gross'), R.stubCents(withStubs.stubs[0], 'net')], [61500, 54025]);
  hosted.state.stubs = null;
});

test('a manager without rates.view sees names only; with rates.view, the rates', async () => {
  const bo = await orgAs('sess-bo');
  assert.equal(R.seesCodeList(bo), true, 'scheduling sees the codes');
  assert.equal(R.seesRates(bo), false);
  const list = await call('GET', '/v1/orgs/hosted-camp/pay-codes');
  assert.ok(list.codes.every((c) => c.rate === undefined && c.rateCents === undefined), 'the server sends no rates');
  const ana = await call('GET', '/v1/orgs/hosted-camp/members/acct-ana/pay-codes');
  assert.deepEqual(ana.codes.map((c) => R.codeLabel(c, R.seesRates(bo))), ['Lifeguard', 'Swim instructor', 'Old code']);
  // Even if a rate came along, Kea wouldn't show it without rates.view.
  assert.equal(R.codeLabel({ name: 'Lifeguard', rateCents: 1500 }, R.seesRates(bo)), 'Lifeguard');
  assert.deepEqual(R.withoutRate({ id: 'x', name: 'Lifeguard', rate: 15, rateCents: 1500 }), { id: 'x', name: 'Lifeguard' });

  const cy = await orgAs('sess-cy');
  assert.equal(R.seesRates(cy), true);
  const theirs = await call('GET', '/v1/orgs/hosted-camp/members/acct-ana/pay-codes');
  assert.deepEqual(theirs.codes.map((c) => R.codeLabel(c, R.seesRates(cy))), ['Lifeguard · $15.00/h', 'Swim instructor · $18.00/h', 'Old code · $10.00/h']);
  const all = await call('GET', '/v1/orgs/hosted-camp/pay-codes');
  assert.deepEqual(R.grantable(all.codes, theirs.codes).map((c) => c.name), ['Front desk'], 'only codes turned on and not theirs yet');
  assert.equal(R.keepsHistory(all.codes), false, 'no effective dates: a simple rate edit');
  assert.equal(R.keepsHistory([{ ...all.codes[0], effectiveFrom: '2026-11-01' }]), true);
});

test('the shift and clock pickers: only my codes, the shift’s code or my default first, and the server agrees', async () => {
  as('sess-ana');
  const my = await call('GET', '/v1/orgs/hosted-camp/me/pay');
  const codes = R.pickable(my);
  assert.equal(R.hasChoice(codes), true);
  assert.equal(R.pickedCode(codes, 'pc-swim', my.defaultCodeId), 'pc-swim');
  assert.equal(R.pickedCode(codes, 'pc-desk', my.defaultCodeId), 'pc-guard', 'a code that isn’t mine falls back to my default');
  assert.equal(R.pickedCode(codes, 'pc-old', null), 'pc-guard', 'nor a turned-off one');
  assert.equal(R.pickedCode([], null, null), '');
  assert.equal(R.hasChoice([codes[0]]), false, 'one code: no picker');
  // My shift: switch to another of my codes; one that isn't mine is refused.
  assert.equal((await call('POST', '/v1/orgs/hosted-camp/shifts/sh-1/pay-code', { payCodeId: 'pc-swim' })).payCodeId, 'pc-swim');
  await assert.rejects(call('POST', '/v1/orgs/hosted-camp/shifts/sh-1/pay-code', { payCodeId: 'pc-desk' }), /wasn’t given/);
  // Clocking in: the picked code, else the shift's when it's mine, else none (the server uses my default).
  assert.equal(R.clockInCode(codes, 'pc-swim', 'pc-guard'), 'pc-swim');
  assert.equal(R.clockInCode(codes, null, 'pc-guard'), 'pc-guard');
  assert.equal(R.clockInCode(codes, 'pc-desk', 'pc-desk'), null);
  const p = await call('POST', '/v1/orgs/hosted-camp/clock', { type: 'in', source: 'app', payCodeId: R.clockInCode(codes, 'pc-swim', null) });
  assert.equal(p.punch.payCodeId, 'pc-swim');
  await assert.rejects(call('POST', '/v1/orgs/hosted-camp/clock', { type: 'in', payCodeId: 'pc-desk' }), (e) => e.status === 400);
  // A manager building schedules picks among the assignee's codes only.
  as('sess-bo');
  const theirs = await call('GET', '/v1/orgs/hosted-camp/members/acct-ana/pay-codes');
  assert.deepEqual(R.shiftChoices(theirs.codes).map((c) => c.id), ['pc-guard', 'pc-swim']);
  assert.equal((await call('POST', '/v1/orgs/hosted-camp/shifts/sh-1/pay-code', { payCodeId: 'pc-guard' })).payCodeId, 'pc-guard');
});

test('the pay feed is for payroll and never goes through Kea', async () => {
  as('sess-cy');
  await assert.rejects(call('GET', '/v1/orgs/hosted-camp/pay-feed?from=2026-11-01&to=2026-11-14'), (e) => e.status === 400);
  assert.ok(!hosted.state.sent.some((x) => x.includes('pay-feed')));
});
