// Joining KeaS servers with a server pass (electron/serversCore.cjs), against a fake Kea account server and fake KeaS
// doing exactly what protocol section 2 says: join by link, the server proving who it is, the pass and the server's
// session, the daily renewal, the account server being down, a server signing the account out, and a server that
// can't prove its identity.
//   node --test test/servers/
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fakeKeaC, fakeKeaS } from './fakes.mjs';

const require = createRequire(import.meta.url);
const core = require('../../electron/serversCore.cjs');
const { timedFetch } = require('../../electron/accountCore.cjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-servers-'));
const closers = [];
after(async () => {
  for (const c of closers) await c().catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
});

/** hub.cjs's req against the fake account server: status 0 when it can't be reached. */
function accountReq(keac) {
  return async (method, p, body) => {
    let r;
    try {
      r = await timedFetch(fetch, keac.url + p, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${keac.session}` }, body: body === undefined ? undefined : JSON.stringify(body) }, 3000);
    } catch {
      throw Object.assign(new Error('Can’t reach your Kea account online right now.'), { status: 0 });
    }
    const j = r.json();
    if (!r.ok) throw Object.assign(new Error(j.error || String(r.status)), { status: r.status, data: j });
    return j;
  };
}
// (A stand-in for safeStorage: the file must not hold the secrets as plain text.)
const seal = (s) => Buffer.from(Buffer.from(s).map((b) => b ^ 0x5a));
const unseal = (b) => Buffer.from(b.map((x) => x ^ 0x5a)).toString('utf8');

let n = 0;
async function setup({ keasOpts = {}, keacOpts = {} } = {}) {
  const keac = await fakeKeaC(keacOpts);
  const keas = await fakeKeaS({ keys: () => [keac.jwk], ...keasOpts });
  closers.push(keac.close, keas.close);
  const clock = { t: Date.now() };
  keac.state.now = keas.state.now = () => clock.t;
  const sub = path.join(dir, `s${++n}`);
  const S = core.createServers({ file: path.join(sub, 'keas-servers.json'), secretsFile: path.join(sub, 'keas-secrets.bin'), seal, unseal, fetchFn: fetch, timedFetch, account: { key: () => 'local-ana', req: accountReq(keac) }, now: () => clock.t });
  return { keac, keas, S, clock, sub };
}

test('join links: kea://join?s=<address>&c=<code>, or the address and code typed in', () => {
  const link = core.joinLink('https://pool.example.org/', 'ABCD-EFGH-JKMN');
  assert.equal(link, 'kea://join?s=https%3A%2F%2Fpool.example.org&c=ABCD-EFGH-JKMN');
  assert.deepEqual(core.parseJoin(link), { url: 'https://pool.example.org', code: 'ABCD-EFGH-JKMN' });
  assert.deepEqual(core.parseJoin({ address: 'pool.example.org', code: ' X1 ' }), { url: 'https://pool.example.org', code: 'X1' });
  assert.deepEqual(core.parseJoin('ABCD-EFGH-JKMN'), { url: null, code: 'ABCD-EFGH-JKMN' }, 'a bare code is for the Kea account server');
  assert.deepEqual(core.parseJoin('kea://join?s=http%3A%2F%2F127.0.0.1%3A5000&c=Q'), { url: 'http://127.0.0.1:5000', code: 'Q' });
  for (const bad of ['kea://join?s=https%3A%2F%2Fa.org', 'kea://open?s=x&c=y', 'kea://join?s=http%3A%2F%2Fevil.example&c=Q', 'kea://join?s=ftp%3A%2F%2Fa.org&c=Q']) assert.throws(() => core.parseJoin(bad), bad);
});

test('join by link: the server proves who it is, a pass gets its session, the code joins the organization', async () => {
  const { keac, keas, S, sub } = await setup();
  const r = await S.join(keas.joinLink());
  assert.equal(r.org.name, 'Westside Pool');
  assert.deepEqual([r.server.serverId, r.server.name, r.server.signedOut], [keas.serverId, 'Westside Pool', false]);
  assert.equal(keac.state.passes.length, 1);
  assert.equal(keac.state.passes[0].serverId, keas.serverId, 'the pass is asked for this server only');
  assert.equal(S.list().length, 1);
  // Org routes go with the server's own session.
  const orgs = await S.req(keas.serverId, 'GET', '/v1/orgs');
  assert.equal(orgs.orgs[0].name, 'Westside Pool');
  // The list has no secrets; the secrets file has none as plain text.
  const listText = fs.readFileSync(path.join(sub, 'keas-servers.json'), 'utf8');
  assert.ok(!/pass|token/i.test(listText.replace(/"passUntil"/, '')), listText);
  const sec = S._secretOf(keas.serverId);
  assert.ok(sec.pass && sec.token);
  const raw = fs.readFileSync(path.join(sub, 'keas-secrets.bin'));
  assert.ok(!raw.includes(Buffer.from(sec.token)) && !raw.includes(Buffer.from(sec.pass.split('.')[1])));
  // A wrong code: refused by the server, and a new server isn't added for it.
  const other = await fakeKeaS({ keys: () => [keac.jwk], name: 'Lakeside' });
  closers.push(other.close);
  await assert.rejects(S.join(other.joinLink('WRONG-CODE')), /join code isn’t right/);
  assert.equal(S.list().length, 1);
});

test('a server that can’t prove who it is is refused, and gets no pass', async () => {
  for (const mode of ['wrongId', 'badSig']) {
    const { keac, keas, S } = await setup({ keasOpts: { mode } });
    await assert.rejects(S.join(keas.joinLink()), (e) => e.status === 495 && /couldn’t prove who it is/.test(e.message), mode);
    assert.equal(keac.state.passes.length, 0, `${mode}: no pass asked for`);
    assert.equal(keas.state.passesSeen, 0, `${mode}: nothing sent to it`);
    assert.equal(S.list().length, 0);
  }
  // A server joined before that now answers with another identity: refused before any pass goes to it.
  const { keac, keas, S } = await setup();
  await S.join(keas.joinLink());
  await assert.rejects(S.identity(keas.url, 'AAAAAAAAAAAAAAAAAAAAAA'), (e) => e.status === 495 && e.data.changed === true);
  keas.state.mode = 'badSig';
  keas.state.sessions.clear();
  const before = keac.state.passes.length;
  await assert.rejects(S.req(keas.serverId, 'GET', '/v1/orgs'), (e) => e.status === 495);
  assert.equal(keas.state.passesSeen, 1, 'only the pass from joining ever reached it');
  assert.equal(keac.state.passes.length, before);
});

test('the pass is renewed once a day in the background, with a new server session', async () => {
  const { keac, keas, S, clock } = await setup();
  await S.join(keas.joinLink());
  const first = S._secretOf(keas.serverId);
  assert.deepEqual(await S.renew(), [], 'nothing to do the same day');
  clock.t += 21 * 3600e3;
  const r = await S.renew();
  assert.deepEqual(r.map((x) => x.ok), [true]);
  assert.equal(keac.state.passes.length, 2);
  const next = S._secretOf(keas.serverId);
  assert.notEqual(next.pass, first.pass);
  assert.notEqual(next.token, first.token);
  assert.ok(next.passExp > first.passExp);
  assert.equal((await S.req(keas.serverId, 'GET', '/v1/orgs')).orgs.length, 1);
});

test('the account server down: the current pass and server session keep working', async () => {
  const { keac, keas, S, clock } = await setup();
  await S.join(keas.joinLink());
  await keac.close();
  clock.t += 30 * 3600e3;
  // Renewal can't get a new pass, so it signs in again with the pass Kea has (still within its 7 days).
  const r = await S.renew();
  assert.deepEqual(r.map((x) => x.ok), [true]);
  assert.equal((await S.req(keas.serverId, 'GET', '/v1/orgs')).orgs.length, 1);
  // The server's session ended meanwhile: a new one from the same pass.
  keas.state.sessions.clear();
  assert.equal((await S.req(keas.serverId, 'GET', '/v1/orgs')).orgs.length, 1);
  // Once the pass itself has run out, there's nothing to sign in with until the account server is back.
  clock.t += 7 * 86400e3;
  keas.state.sessions.clear();
  await assert.rejects(S.req(keas.serverId, 'GET', '/v1/orgs'), (e) => e.status === 0);
  assert.equal(S.list()[0].signedOut, false, 'not signed out: just waiting');
});

test('a server that refuses the account: “This organization signed you out”, until it lets it in again', async () => {
  const { keac, keas, S } = await setup();
  await S.join(keas.joinLink());
  keas.state.revoked.add(keac.account.id);
  await assert.rejects(S.req(keas.serverId, 'GET', '/v1/orgs'), (e) => e.status === 401 && e.data.signedOut === true && e.message === 'Westside Pool signed you out.');
  const l = S.list()[0];
  assert.deepEqual([l.signedOut, l.message], [true, 'Westside Pool signed you out.']);
  // From then on, nothing more is sent to it.
  const seen = keas.state.passesSeen;
  await assert.rejects(S.req(keas.serverId, 'GET', '/v1/orgs'), (e) => e.data?.signedOut);
  assert.equal(keas.state.passesSeen, seen);
  assert.deepEqual(await S.renew(), [], 'and no renewing');
  await assert.rejects(S.again(keas.serverId), (e) => e.data?.signedOut);
  keas.state.revoked.clear();
  assert.equal((await S.again(keas.serverId)).signedOut, false);
  assert.equal((await S.req(keas.serverId, 'GET', '/v1/orgs')).orgs.length, 1);
  S.remove(keas.serverId);
  assert.deepEqual(S.list(), []);
});

test('a Kea account server without passes (Hub 0.5): joining a server says it needs an update', async () => {
  const { keac, keas, S } = await setup({ keacOpts: { features: [] } });
  await assert.rejects(S.join(keas.joinLink()), (e) => e.status === 501 && e.data.noPasses && /needs an update/.test(e.message));
  assert.deepEqual(S.list(), []);
  assert.equal(keac.state.passes.length, 0);
});

test('a pass made for another server is never handed over', async () => {
  const { keac, keas, S } = await setup();
  const realReq = accountReq(keac);
  const S2 = core.createServers({ file: path.join(dir, 'x', 'l.json'), secretsFile: path.join(dir, 'x', 's.bin'), fetchFn: fetch, timedFetch, account: { key: () => 'local-ana', req: async (m, p, b) => (p === '/v1/pass' ? realReq(m, p, { serverId: 'BBBBBBBBBBBBBBBBBBBBBB' }) : realReq(m, p, b)) } });
  await assert.rejects(S2.join(keas.joinLink()), /pass for another server/);
  assert.equal(keas.state.passesSeen, 0);
  void S;
});

test('each Kea account on this computer has its own servers', async () => {
  const { keac, keas, sub } = await setup();
  let who = 'local-ana';
  const S = core.createServers({ file: path.join(sub, 'keas-servers.json'), secretsFile: path.join(sub, 'keas-secrets.bin'), seal, unseal, fetchFn: fetch, timedFetch, account: { key: () => who, req: accountReq(keac) } });
  await S.join(keas.joinLink());
  who = 'local-max';
  assert.deepEqual(S.list(), []);
  await assert.rejects(S.req(keas.serverId, 'GET', '/v1/orgs'), (e) => e.status === 404);
  who = null;
  await assert.rejects(S.join(keas.joinLink()), (e) => e.data?.needsAccount);
});
