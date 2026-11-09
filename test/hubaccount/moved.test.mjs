// The Kea account server moved (the owner's Kea Hub to KeaC, electron/hub.cjs): the old address says where it went
// ({ movedTo, keacKeyKid } in its health check, 410 on account routes). Kea follows only to an https (or this-computer)
// address that has the old server's signing key, and then it's like changing the address under Advanced: the online
// sign-in ends, the account on this computer stays, and a notice says to sign in once (with Google or Microsoft).
// Otherwise nothing switches and the notice says the new address couldn't be checked.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-moved-'));
const electron = require('../worker/electronStub.cjs');
electron._paths.userData = userData;
electron._paths.appData = userData;
const sent = [];
electron.BrowserWindow.getAllWindows = () => [{ isDestroyed: () => false, webContents: { send: (ch) => sent.push(ch) } }];
const settings = require('../../electron/settings.cjs');
const hub = require('../../electron/hub.cjs');
const A = hub._account;
A.setBackground(false);
A.setLimits({ req: 3000, status: 2000 });
const tokenFile = path.join(userData, 'hub-session.bin');
const idToken = (email) => `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ email, n: Math.random() })).toString('base64url')}.sig`;
const emailOf = (tok) => JSON.parse(Buffer.from(String(tok).split('.')[1], 'base64url').toString('utf8')).email;
A.setIdTokens(async () => idToken('ana@x.org'));

const servers = [];
function serve(handler) {
  return new Promise((r) => {
    const s = http.createServer((rq, rs) => {
      let body = '';
      rq.on('data', (c) => (body += c));
      rq.on('end', () => {
        const [status, json] = handler(rq.method, new URL(rq.url, 'http://x').pathname, body ? JSON.parse(body) : null, rq) || [404, { error: 'Not found.' }];
        rs.writeHead(status, { 'content-type': 'application/json' });
        rs.end(JSON.stringify(json));
      });
    });
    s.listen(0, '127.0.0.1', () => {
      servers.push(s);
      r({ url: `http://127.0.0.1:${s.address().port}`, calls: [] });
    });
  });
}
after(() => {
  for (const s of servers) s.close();
  fs.rmSync(userData, { recursive: true, force: true });
});

const account = { id: 'h-ana', email: 'ana@x.org', displayName: 'Ana', emailVerified: true };
const me = () => ({ account, terms: { needsAgreement: false, current: 1 }, progress: null });
/** A Kea account server (the Hub before the move, or the new one): signs in ana@x.org with Google. */
function accountRoutes(name, srv, extra = () => null) {
  return (m, p, b, rq) => {
    srv.calls.push(`${m} ${p}`);
    const x = extra(m, p, b, rq);
    if (x) return x;
    if (p === '/v1/health') return [200, { ok: true, service: name }];
    if (p === '/v1/auth/google' || p === '/v1/auth/oauth') return emailOf(b?.idToken) === 'ana@x.org' ? [200, { token: `${name}-token`, account }] : [404, { error: 'No account.' }];
    if (p === '/v1/me') return rq.headers.authorization === `Bearer ${name}-token` ? [200, me()] : [401, { error: 'Sign in again.' }];
    return null;
  };
}
/** The old Hub: an account server until `moved` is set, then it only says where it went. */
async function oldHub({ keys = null } = {}) {
  const srv = await serve((...a) => srv.route(...a));
  srv.moved = null;
  srv.route = (m, p, b, rq) => {
    if (!srv.moved) return accountRoutes('kea-hub', srv)(m, p, b, rq);
    srv.calls.push(`${m} ${p}`);
    if (p === '/v1/health') return [200, { ok: true, ...srv.moved }];
    if (p === '/v1/keys' && keys) return [200, { keys }];
    return [410, { error: 'Kea accounts moved', movedTo: srv.moved.movedTo }];
  };
  return srv;
}
async function newServer(kid) {
  const srv = await serve((...a) => accountRoutes('keac', srv, (m, p) => (p === '/v1/keys' ? [200, { keys: [{ kid: 'older', status: 'retired' }, { kid, status: 'current' }] }] : null))(...a));
  return srv;
}
const fresh = () => {
  for (const f of fs.readdirSync(userData)) if (f !== 'settings.json') fs.rmSync(path.join(userData, f), { recursive: true, force: true });
  settings.set({ 'hub.url': null });
  A.reset();
};
/** Ana's account on this computer, signed in online on the old Hub. */
async function anaOnline(old) {
  process.env.KEA_HUB_URL = old.url;
  const s = await A.oauthSignIn({ provider: 'google' });
  assert.equal(s.state, 'online');
  return s;
}

test('moved, with the same signing key: Kea switches, the online sign-in ends, the account here stays, a notice says to sign in once', async () => {
  fresh();
  const old = await oldHub();
  const keac = await newServer('kid-1');
  await anaOnline(old);
  old.moved = { movedTo: keac.url, keacKeyKid: 'kid-1' };
  sent.length = 0;
  let s = await A.status();
  assert.equal(hub.url(), keac.url, 'the new address is used');
  assert.equal(settings.get('hub.url'), keac.url, 'kept as hub.url');
  assert.ok(keac.calls.includes('GET /v1/keys'), 'its keys were checked');
  assert.equal(s.url, keac.url);
  assert.equal(s.signedIn, false, 'sessions don’t move');
  assert.equal(fs.existsSync(tokenFile), false);
  assert.equal(s.state, 'linked', 'still signed in on this computer');
  assert.equal(s.account.email, 'ana@x.org');
  assert.equal(s.reachable, true, 'the new address was asked');
  assert.equal(s.moved.kind, 'moved');
  assert.equal(s.moved.to, keac.url);
  assert.equal(s.moved.seen, false);
  assert.ok(sent.includes('hub:changed'));
  // The notice is shown once.
  assert.equal(A.movedSeen().moved.seen, true);
  assert.equal(A.local().moved.seen, true);
  // Signed out with no connection: the account here opens again.
  A.logout();
  process.env.KEA_HUB_URL = 'http://127.0.0.1:9';
  settings.set({ 'hub.url': 'http://127.0.0.1:9' });
  assert.equal(A.openHere({ email: 'ana@x.org' }).state, 'linked');
  // Signing in once on the new server.
  settings.set({ 'hub.url': keac.url });
  s = await A.link({ provider: 'google' });
  assert.equal(s.state, 'online');
  assert.ok(keac.calls.includes('POST /v1/auth/google'));
  assert.equal(hub._token(), 'keac-token');
  assert.equal(s.moved, null, 'the notice has done its job');
});

test('moved, but the new address has another signing key: nothing switches, the notice says it couldn’t be checked', async () => {
  fresh();
  const old = await oldHub();
  const fake = await newServer('someone-elses-key');
  await anaOnline(old);
  old.moved = { movedTo: fake.url, keacKeyKid: 'kid-1' };
  const s = await A.status();
  assert.equal(hub.url(), old.url, 'Kea kept the old address');
  assert.equal(settings.get('hub.url', null), null);
  assert.equal(s.moved.kind, 'unchecked');
  assert.equal(s.moved.to, fake.url, 'the address, for Advanced');
  assert.match(s.moved.reason, /different key/);
  assert.ok(!fake.calls.includes('POST /v1/auth/google') && !fake.calls.includes('GET /v1/me'), 'nothing was sent there');
  // An account route says so too (and isn't asked again at once).
  await assert.rejects(hub.req('GET', '/v1/me'), (e) => e.status === 410 && e.data?.unchecked && /couldn’t be checked/.test(e.message));
  assert.equal(fake.calls.filter((c) => c === 'GET /v1/keys').length, 1, 'tried again only after a while');
  assert.equal(A.local().state !== 'none', true);
});

test('a sign-in that meets the move goes to the checked new address at once', async () => {
  fresh();
  const old = await oldHub();
  const keac = await newServer('kid-2');
  process.env.KEA_HUB_URL = old.url;
  old.moved = { movedTo: keac.url, keacKeyKid: 'kid-2' };
  const s = await A.oauthSignIn({ provider: 'google' });
  assert.equal(s.state, 'online');
  assert.equal(hub.url(), keac.url);
  assert.equal(hub._token(), 'keac-token');
  assert.equal(s.moved, null, 'signed in there: no notice needed');
});

test('no key id in the health check: the old server’s own key list, or no switch', async () => {
  fresh();
  let old = await oldHub({ keys: [{ kid: 'kid-3', status: 'current' }] });
  let keac = await newServer('kid-3');
  process.env.KEA_HUB_URL = old.url;
  old.moved = { movedTo: keac.url };
  await A.status();
  assert.equal(hub.url(), keac.url);
  assert.ok(old.calls.includes('GET /v1/keys'));

  fresh();
  old = await oldHub(); // (its /v1/keys answers 410 now)
  keac = await newServer('kid-3');
  process.env.KEA_HUB_URL = old.url;
  old.moved = { movedTo: keac.url };
  const s = await A.status();
  assert.equal(hub.url(), old.url);
  assert.equal(s.moved.kind, 'unchecked');
  assert.match(s.moved.reason, /which signing key/);
});

test('a plain http address on another computer, or none at all, is never followed', async () => {
  fresh();
  const old = await oldHub();
  process.env.KEA_HUB_URL = old.url;
  old.moved = { movedTo: 'http://keac.example.org', keacKeyKid: 'kid-1' };
  let s = await A.status();
  assert.equal(hub.url(), old.url);
  assert.equal(s.moved.kind, 'unchecked');
  assert.equal(s.moved.to, 'http://keac.example.org');
  assert.match(s.moved.reason, /https/);

  fresh();
  old.moved = { movedTo: null, keacKeyKid: 'kid-1' };
  s = await A.status();
  assert.equal(hub.url(), old.url);
  assert.equal(s.moved.kind, 'unchecked');
  assert.equal(s.moved.to, null);
});

test('the shown wording', () => {
  const src = fs.readFileSync(require.resolve('../../electron/hub.cjs'), 'utf8');
  assert.ok(src.includes('Your Kea account moved to a new address. Sign in once to continue.'));
  assert.ok(src.includes('Your Kea account server moved, but the new address couldn’t be checked.'));
});
