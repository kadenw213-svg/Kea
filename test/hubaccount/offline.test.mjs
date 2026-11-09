// Kea accounts on this computer (electron/accountCore.cjs, electron/hub.cjs), with no passwords: an account is made
// only by a Google or Microsoft sign-in, which waits for the Kea account server; with no account (and the server
// down) Kea opens at once and nothing tries to make one; after a sign-in Kea stays signed in here, offline too;
// email-only accounts left by Kea 0.82 and older stay signed in and link only on the same email; every request to the
// server has a time limit and "can't reach it" is a normal answer; linking never deletes anything here. The real-Hub
// parts use KeaS/hub next to this repo (or KEAS_DIR).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateKeyPairSync, sign } from 'node:crypto';
import { registerAndSignIn } from '../hubRegister.mjs';
import { legacyOffline } from './legacyAccount.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const HUB = [process.env.KEAS_DIR && path.join(process.env.KEAS_DIR, 'hub/index.mjs'), path.resolve(here, '../../../KeaS/hub/index.mjs')].find((p) => p && fs.existsSync(p)) || '';
const core = require('../../electron/accountCore.cjs');

const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `kea-offline-${n}-`));
const dirs = [];
const scratch = (n) => (dirs.push(tmp(n)), dirs[dirs.length - 1]);

// ---------- Accounts on this computer ----------
test('nothing on this computer makes an account: reopen opens only one already here; an unknown email is refused, nothing written', () => {
  const d = scratch('store');
  const S = core.createStore(d);
  assert.equal(S.active(), null);
  assert.equal(S.open, undefined, 'no way to make an account with just an email');
  assert.throws(() => S.reopen({ email: 'ana@x.org' }), (e) => e.noAccount === true && /Sign in with Google/.test(e.message));
  assert.throws(() => S.reopen({ email: 'not-an-email' }), (e) => e.field === 'email');
  assert.equal(fs.existsSync(path.join(d, core.FILE)), false, 'nothing was written');
  assert.deepEqual(S.list(), []);
  // Only a Google or Microsoft sign-in keeps an account here.
  const a = S.attachOnline({ email: ' Ana@X.org ', name: 'Ana', hubId: 'h1', url: 'http://hub', provider: 'google' });
  assert.equal(a.email, 'ana@x.org');
  assert.deepEqual(a.hub, { id: 'h1', url: 'http://hub', provider: 'google' });
  const raw = JSON.parse(fs.readFileSync(path.join(d, core.FILE), 'utf8'));
  assert.equal(raw.v, 2);
  assert.deepEqual(Object.keys(raw.accounts[a.id]).sort(), ['createdAt', 'email', 'hub', 'id', 'lastSignIn', 'name']);
  assert.equal(core.makeVerifier, undefined, 'no password verifier any more');
  assert.equal(core.passwordProblem, undefined);
  assert.equal(core.gateOpen, undefined, 'no start screen in front of Kea');
});

test('an email-only account from an older Kea stays signed in; signed out, it opens again here; the others kept', () => {
  const d = scratch('signin');
  const anaId = legacyOffline(d, 'ana@x.org', { name: 'Ana' });
  const S = core.createStore(d);
  assert.equal(S.active().id, anaId, 'still signed in, as the older Kea left it');
  assert.equal(S.active().hub, null);
  S.signOut();
  assert.equal(S.active(), null);
  assert.equal(S.list().length, 1, 'signing out keeps the account here');
  const again = S.reopen({ email: 'ANA@x.org' });
  assert.equal(again.id, anaId, 'the same account, with what it has here');
  assert.equal(again.name, 'Ana');
  const ben = S.attachOnline({ email: 'ben@x.org', hubId: 'h2', url: 'http://hub' });
  assert.equal(S.active().id, ben.id, 'the new one is the one signed in');
  assert.deepEqual(S.list().map((x) => x.email).sort(), ['ana@x.org', 'ben@x.org']);
  // A linked account opens the same way (Kea stays signed in here without a password).
  S.attachOnline({ email: 'ana@x.org', hubId: 'h1', url: 'http://hub', provider: 'google' });
  S.signOut();
  const linked = S.reopen({ email: 'ana@x.org' });
  assert.equal(linked.id, anaId);
  assert.deepEqual(linked.hub, { id: 'h1', url: 'http://hub', provider: 'google' });
});

test('an older file (scrypt verifiers): its accounts and emails stay, the verifiers are dropped once', () => {
  const d = scratch('migrate');
  const old = {
    v: 1,
    active: 'loc_a',
    accounts: {
      loc_a: { id: 'loc_a', email: 'Ana@X.org', name: 'Ana', createdAt: 5, lastSignIn: 9, verifier: { alg: 'scrypt', N: 131072, r: 8, p: 1, keylen: 32, salt: 'c2FsdA==', hash: 'aGFzaA==' }, hub: null },
      loc_b: { id: 'loc_b', email: 'ben@x.org', name: '', createdAt: 6, lastSignIn: 7, verifier: null, hub: { id: 'h-b', url: 'http://hub', provider: 'google', at: 7 } },
      junk: { id: 'junk', email: 'nope' },
    },
  };
  fs.writeFileSync(path.join(d, core.FILE), JSON.stringify(old));
  const S = core.createStore(d);
  assert.equal(S.active().id, 'loc_a', 'still signed in as before');
  assert.equal(S.active().email, 'ana@x.org');
  const raw = fs.readFileSync(path.join(d, core.FILE), 'utf8');
  assert.ok(!raw.includes('verifier') && !raw.includes('scrypt'), 'the verifiers are gone from the file');
  assert.equal(JSON.parse(raw).v, 2);
  assert.deepEqual(S.list().map((a) => a.id).sort(), ['loc_a', 'loc_b']);
  assert.deepEqual(S.get('loc_b').hub, { id: 'h-b', url: 'http://hub', provider: 'google' });
  // Its email opens it again, with its id (so everything kept for it here is its own).
  S.signOut();
  assert.equal(S.reopen({ email: 'ana@x.org' }).id, 'loc_a');
});

test('after an online sign-in the account here is linked and kept; nothing else about it changes', () => {
  const d = scratch('online');
  legacyOffline(d, 'ana@x.org', { name: 'Ana' });
  const S = core.createStore(d);
  const off = S.active();
  const linked = S.attachOnline({ email: 'ana@x.org', name: 'Ana Online', hubId: 'h1', url: 'http://hub', provider: 'google' });
  assert.equal(linked.id, off.id, 'the same account, now linked');
  assert.equal(linked.name, 'Ana', 'nothing else about it changes');
  assert.deepEqual(linked.hub, { id: 'h1', url: 'http://hub', provider: 'google' });
  // An online account new to this computer is kept the same way.
  S.signOut();
  const ben = S.attachOnline({ email: 'ben@x.org', name: 'Ben', hubId: 'h2', url: 'http://hub' });
  assert.equal(ben.name, 'Ben');
  assert.equal(S.active().id, ben.id);
});

// ---------- Linking rules ----------
test('linking: the same email links, a different one never does', () => {
  const acct = { email: 'Ana@X.org', hub: null };
  assert.deepEqual(core.linkDecision(acct, 'ana@x.org'), { link: true, reason: 'link' });
  assert.deepEqual(core.linkDecision({ ...acct, hub: { id: 'h1' } }, 'ANA@x.org'), { link: true, reason: 'relink' });
  assert.deepEqual(core.linkDecision(acct, 'ana@other.org'), { link: false, reason: 'differentEmail', accountEmail: 'ana@x.org', providerEmail: 'ana@other.org' });
  assert.equal(core.linkDecision(acct, '').link, false);
  assert.equal(core.linkDecision(null, 'ana@x.org').link, false);
  // The email in an ID token (Google's email, Microsoft's email or preferred_username).
  const tok = (p) => `x.${Buffer.from(JSON.stringify(p)).toString('base64url')}.y`;
  assert.equal(core.idTokenEmail(tok({ email: 'Ana@X.org' })).email, 'ana@x.org');
  assert.equal(core.idTokenEmail(tok({ preferred_username: 'ana@school.edu' })).email, 'ana@school.edu');
  assert.equal(core.idTokenEmail('garbage').email, '');
});

// ---------- The account state ----------
test('the account state comes from this computer alone', () => {
  const S = (active, hasToken) => core.accountState({ active, hasToken });
  assert.equal(S(null, false), 'none');
  assert.equal(S({ hub: null }, false), 'offline');
  assert.equal(S({ hub: { id: 'h1' } }, false), 'linked');
  assert.equal(S({ hub: { id: 'h1' } }, true), 'online');
  assert.equal(S(null, true), 'online', 'a sign-in from before accounts were kept here');
});

// ---------- Google and Microsoft sign-in addresses ----------
test('sign-in addresses: PKCE S256, loopback redirect, openid email profile, no secrets for Microsoft', () => {
  const p = core.pkcePair();
  assert.match(p.verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.equal(p.challenge, require('crypto').createHash('sha256').update(p.verifier).digest('base64url'));
  const ms = new URL(core.authorizeUrl('microsoft', { clientId: 'ms-client', port: 51234, challenge: p.challenge, state: 'st', loginHint: 'ana@x.org' }));
  assert.equal(ms.origin + ms.pathname, 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
  const q = Object.fromEntries(ms.searchParams);
  assert.equal(q.client_id, 'ms-client');
  assert.equal(q.response_type, 'code');
  assert.equal(q.scope, 'openid email profile');
  assert.equal(q.code_challenge, p.challenge);
  assert.equal(q.code_challenge_method, 'S256');
  assert.equal(q.state, 'st');
  assert.equal(q.login_hint, 'ana@x.org');
  assert.equal(q.redirect_uri, 'http://localhost:51234');
  const t = core.tokenRequest('microsoft', { clientId: 'ms-client', code: 'c0de', verifier: p.verifier, port: 51234 });
  assert.equal(t.url, 'https://login.microsoftonline.com/common/oauth2/v2.0/token');
  const b = Object.fromEntries(new URLSearchParams(t.body));
  assert.deepEqual(b, { code: 'c0de', client_id: 'ms-client', code_verifier: p.verifier, grant_type: 'authorization_code', redirect_uri: 'http://localhost:51234', scope: 'openid email profile' });
  // Google keeps its address and 127.0.0.1 redirect.
  const g = new URL(core.authorizeUrl('google', { clientId: 'g', port: 1, challenge: 'c', state: 's' }));
  assert.equal(g.origin, 'https://accounts.google.com');
  assert.equal(g.searchParams.get('redirect_uri'), 'http://127.0.0.1:1');
  assert.equal(g.searchParams.get('login_hint'), null);
  assert.throws(() => core.authorizeUrl('nope', {}), /Unknown/);
});

// ---------- Time limits ----------
/** A server that takes connections and never answers (or sends headers, then stalls). */
function slowServer(mode) {
  const socks = new Set();
  const s = http.createServer((rq, rs) => {
    if (mode === 'headers') {
      rs.writeHead(200, { 'content-type': 'application/json' });
      rs.write('{"ok":');
    }
  });
  s.on('connection', (c) => (socks.add(c), c.on('close', () => socks.delete(c))));
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${s.address().port}`, close: () => (socks.forEach((c) => c.destroy()), new Promise((d) => s.close(d))) })));
}
test('requests have a time limit: a server that never answers, or stalls mid-answer, is "unreachable"', async () => {
  for (const mode of ['silent', 'headers']) {
    const srv = await slowServer(mode);
    const t0 = Date.now();
    await assert.rejects(core.timedFetch(fetch, `${srv.url}/v1/health`, {}, 300), (e) => e.timeout === true);
    assert.ok(Date.now() - t0 < 2000, `${mode}: gave up in time`);
    await srv.close();
  }
});

// ---------- hub.cjs: the account flows ----------
const electron = require('../worker/electronStub.cjs');
const userData = scratch('userdata');
electron._paths.userData = userData;
electron._paths.appData = userData;
const sent = [];
electron.BrowserWindow.getAllWindows = () => [{ isDestroyed: () => false, webContents: { send: (ch) => sent.push(ch) } }];
// (No background work from register(); none is called here.)
const hub = require('../../electron/hub.cjs');
const A = hub._account;
A.setBackground(false);
// An address where nothing listens: "the network is down".
const deadPort = await new Promise((r) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => r(p));
  });
});
const setHub = (u) => (process.env.KEA_HUB_URL = u);
const tokenFile = path.join(userData, 'hub-session.bin');
const cacheFile = path.join(userData, 'hub-account.json');
const wipe = () => {
  for (const f of fs.readdirSync(userData)) fs.rmSync(path.join(userData, f), { recursive: true, force: true });
  A.reset();
};

test('a brand-new computer with the server down: Kea opens with no account at once, and nothing tries to make one', async () => {
  wipe();
  setHub(`http://127.0.0.1:${deadPort}`);
  A.setLimits({ req: 1500, status: 800 });
  let browser = 0;
  A.setIdTokens(async () => (browser++, 'x.e30.y'));
  // The first answer is from this computer alone: no account, and nothing in front of Kea.
  let t0 = Date.now();
  let s = A.local();
  assert.ok(Date.now() - t0 < 100);
  assert.equal(s.state, 'none');
  assert.equal(s.account, null);
  assert.equal(s.reachable, false);
  assert.equal(s.checked, false);
  // The server can't be reached: a normal answer, quickly, and still no account.
  t0 = Date.now();
  s = await A.status();
  assert.ok(Date.now() - t0 < 1500);
  assert.equal(s.state, 'none');
  assert.equal(s.reachable, false);
  assert.equal(s.checked, true);
  // Sign in with Google waits for the server: no browser opens, nothing is made.
  await assert.rejects(A.oauthSignIn({ provider: 'google' }), (e) => e.status === 0 && e.data?.unreachable === true && /Sign-in is available once Kea can reach the Kea account server/.test(e.message));
  assert.equal(browser, 0, 'no Google sign-in was started');
  // There is no way to make one with just an email any more; opening one by email only finds one already here.
  assert.equal(A.openOffline, undefined);
  assert.throws(() => A.openHere({ email: 'ana@x.org' }), (e) => e.status === 404 && e.data?.noAccount === true);
  assert.equal(fs.existsSync(path.join(userData, core.FILE)), false, 'no account file was written');
  assert.equal(fs.existsSync(tokenFile), false);
  // "Restart": the same.
  A.reset();
  assert.equal(A.local().state, 'none');
  A.setIdTokens(null);
});

test('the offline-create IPC and API are gone: nothing in Kea makes an account with just an email', () => {
  const read = (f) => fs.readFileSync(require.resolve(f), 'utf8');
  const hubSrc = read('../../electron/hub.cjs');
  assert.ok(!/hub:openOffline|openOffline/.test(hubSrc), 'no hub:openOffline handler');
  assert.ok(hubSrc.includes("'hub:openHere'"), 'only reopening an account already here');
  assert.ok(!/openOffline/.test(read('../../electron/preload.cjs')), 'not exposed to the page');
  assert.ok(!/\.open\(\{/.test(read('../../electron/accountCore.cjs')), 'the store has no open-or-make');
  const page = fs.readFileSync(path.resolve(here, '../../src/components/scholar/HubAccount.tsx'), 'utf8');
  assert.ok(!/Use offline|openOffline|AccountGate/.test(page), 'no "Use offline" and no start screen in front of Kea');
  const api = fs.readFileSync(path.resolve(here, '../../src/lib/api.ts'), 'utf8');
  assert.ok(!/openOffline/.test(api));
});

test('an email-only account from an older Kea: still signed in with the server down, signs out, opens again; nothing lost', async () => {
  wipe();
  setHub(`http://127.0.0.1:${deadPort}`);
  A.setLimits({ req: 1500, status: 800 });
  const id = legacyOffline(userData, 'ana@x.org', { name: 'Ana' });
  fs.writeFileSync(path.join(userData, 'ana-notes.txt'), 'kept');
  let s = A.local();
  assert.equal(s.state, 'offline', 'signed in as before');
  assert.equal(s.account.id, id);
  s = await A.status();
  assert.equal(s.state, 'offline', 'the server being down changes nothing');
  assert.equal(s.checked, true);
  assert.equal(A.logout().state, 'none');
  s = A.openHere({ email: 'ANA@x.org' });
  assert.equal(s.state, 'offline');
  assert.equal(s.account.id, id, 'the same account here');
  assert.equal(fs.readFileSync(path.join(userData, 'ana-notes.txt'), 'utf8'), 'kept');
  assert.deepEqual(s.known.map((k) => k.email), ['ana@x.org']);
  A.reset();
  assert.equal(A.local().state, 'offline');
  assert.equal(A.local().account.email, 'ana@x.org');
  assert.throws(() => A.openHere({ email: 'nope' }), /email/);
});

test('no Google or Microsoft client in this copy of Kea: sign-in says so plainly; an account here still works', async () => {
  wipe();
  setHub(`http://127.0.0.1:${deadPort}`);
  A.setIdTokens(null);
  delete process.env.KEA_GOOGLE_CLIENT_ID;
  delete process.env.KEA_MICROSOFT_CLIENT_ID;
  const s = A.local();
  assert.deepEqual(s.providers, { google: false, microsoft: false });
  await assert.rejects(A.oauthSignIn({ provider: 'google' }), (e) => e.status === 503 && e.data?.notSetUp === true && /isn’t available in this copy of Kea\./.test(e.message));
  legacyOffline(userData, 'ana@x.org');
  assert.equal(A.local().state, 'offline');
  await assert.rejects(A.link({ provider: 'google' }), (e) => e.data?.notSetUp === true);
  assert.equal(A.local().state, 'offline', 'nothing changed');
});

test('a server that takes the connection and never answers: status gives up within its limit', async () => {
  wipe();
  const srv = await slowServer('silent');
  setHub(srv.url);
  A.setLimits({ req: 600, status: 300 });
  legacyOffline(userData, 'ana@x.org');
  const t0 = Date.now();
  const s = await A.status();
  assert.ok(Date.now() - t0 < 1500, 'gave up in time');
  assert.equal(s.reachable, false);
  await assert.rejects(hub.req('GET', '/v1/me'), (e) => e.status === 0 && e.data?.timeout === true);
  await srv.close();
});

test('Kea 0.70’s online sign-in (a session, no account kept here yet) is the account signed in here', () => {
  wipe();
  setHub(`http://127.0.0.1:${deadPort}`);
  fs.writeFileSync(tokenFile, 'token-070');
  fs.writeFileSync(cacheFile, JSON.stringify({ id: 'h-070', email: 'old@x.org', name: 'Old', emailVerified: true }));
  const s = A.local();
  assert.equal(s.state, 'online');
  assert.equal(s.signedIn, true);
  assert.equal(s.account.email, 'old@x.org');
  assert.equal(s.account.linked, true);
  assert.equal(hub.current().hub.id, 'h-070');
});

test('an older offline-account.json (Kea 0.80, with a password verifier) keeps its accounts; the same email opens them', () => {
  wipe();
  setHub(`http://127.0.0.1:${deadPort}`);
  fs.writeFileSync(path.join(userData, core.FILE), JSON.stringify({ v: 1, active: null, accounts: { loc_old: { id: 'loc_old', email: 'ola@x.org', name: 'Ola', createdAt: 1, lastSignIn: 2, verifier: { alg: 'scrypt', N: 1024, r: 8, p: 1, keylen: 32, salt: 'AA==', hash: 'AA==' }, hub: null } } }));
  const s = A.local();
  assert.equal(s.state, 'none');
  assert.deepEqual(s.known.map((k) => k.email), ['ola@x.org']);
  assert.ok(!fs.readFileSync(path.join(userData, core.FILE), 'utf8').includes('verifier'));
  const o = A.openHere({ email: 'ola@x.org' });
  assert.equal(o.account.id, 'loc_old');
  assert.equal(o.state, 'offline');
});

// ---------- With a real Kea Hub (0.5) ----------
const google = generateKeyPairSync('rsa', { modulusLength: 2048 });
const googleJwk = { ...google.publicKey.export({ format: 'jwk' }), kid: 'test-kid', alg: 'RS256', use: 'sig' };
function googleToken(claims = {}) {
  const t = Math.floor(Date.now() / 1000);
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-kid', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud: 'kea-test-client', sub: `g-${claims.email}`, email_verified: true, iat: t, exp: t + 3600, nonce: Math.random().toString(36).slice(2), ...claims })).toString('base64url');
  return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), google.privateKey).toString('base64url')}`;
}
let realHub, hubBase;
before(async () => {
  if (!HUB) return;
  const { createHub } = await import(pathToFileURL(HUB).href);
  realHub = createHub({ dataDir: path.join(scratch('hub'), 'hub'), log: false, minFreeBytes: 0, googleClientIds: ['kea-test-client'], googleKeyFn: async () => [googleJwk] });
  const p = await realHub.listen({ port: 0, ownerPort: 0 });
  hubBase = `http://127.0.0.1:${p.port}`;
});
after(async () => {
  if (realHub) await realHub.close();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const terms = async () => (await (await fetch(`${hubBase}/v1/terms`)).json()).terms;
const skip = !HUB && 'KeaS repo not found (set KEAS_DIR)';
/** An account made on the old Hub with a password (as one moved from it): Kea never sends that password. */
const hubAccount = async (email, password = 'lantern velvet orbit') => {
  const t = await terms();
  const reg = await registerAndSignIn(hubBase, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, displayName: email.split('@')[0], age13: true, termsVersion: t.version, termsSections: t.sections.map((s) => s.id) }) });
  assert.equal(reg.status, 200);
};

test('an account that had a password (Hub 0.5) signs in with Google on the same email, then stays signed in here offline', { skip }, async () => {
  wipe();
  setHub(hubBase);
  A.setLimits({ req: 8000, status: 4000 });
  await hubAccount('sam@example.com');
  A.setIdTokens(async () => googleToken({ email: 'sam@example.com' }));
  let s = await A.oauthSignIn({ provider: 'google' });
  assert.equal(s.state, 'online');
  assert.equal(s.me.account.email, 'sam@example.com');
  assert.ok(fs.existsSync(tokenFile), 'the online session is kept (encrypted when the OS can)');
  const kept = fs.readFileSync(path.join(userData, core.FILE), 'utf8');
  assert.ok(!kept.includes('lantern') && !kept.includes('verifier'), 'no password, nor anything made from one');
  const id = s.account.id;
  // The network goes away: still signed in here, working from what Kea last knew.
  setHub(`http://127.0.0.1:${deadPort}`);
  A.setLimits({ req: 1500, status: 800 });
  A.reset();
  s = await A.status();
  assert.equal(s.state, 'online');
  assert.equal(s.account.id, id);
  // Signed out, offline: the account opens again here (linked, signs in online with Google later).
  A.logout();
  s = A.openHere({ email: 'sam@example.com' });
  assert.equal(s.state, 'linked');
  assert.equal(s.account.id, id);
});

test('going online with Google: the same email links and keeps everything here; a different email never links', { skip }, async () => {
  wipe();
  setHub(hubBase);
  A.setLimits({ req: 8000, status: 4000 });
  await hubAccount('lin@example.com', 'quiet harbor lamp');
  const localId = legacyOffline(userData, 'lin@example.com', { name: 'Lin' });
  let s = A.local();
  assert.equal(s.state, 'offline');
  // Something of this account's on this computer.
  fs.writeFileSync(path.join(userData, 'my-notes.txt'), 'kept');
  // A different email: nothing is sent, nothing changes.
  A.setIdTokens(async () => googleToken({ email: 'someone.else@example.com' }));
  await assert.rejects(A.link({ provider: 'google' }), (e) => e.status === 409 && e.data?.mismatch && e.data.reason === 'differentEmail' && /never links/.test(e.message));
  assert.equal(A.local().state, 'offline');
  assert.equal(fs.existsSync(tokenFile), false);
  // The same email: linked to the online account.
  A.setIdTokens(async () => googleToken({ email: 'lin@example.com' }));
  s = await A.link({ provider: 'google' });
  assert.equal(s.state, 'online');
  assert.equal(s.account.id, localId, 'the same account here');
  assert.equal(s.me.account.email, 'lin@example.com');
  assert.equal(s.me.account.emailVerified, true, 'the Google sign-in verified it');
  assert.equal(fs.readFileSync(path.join(userData, 'my-notes.txt'), 'utf8'), 'kept', 'nothing here is deleted by linking');
  assert.equal(hub.current().hub.provider, 'google');
  // Later, from the start screen: Continue with Google signs in to the same account.
  A.logout();
  s = await A.oauthSignIn({ provider: 'google' });
  assert.equal(s.state, 'online');
  assert.equal(s.account.id, localId);
});

test('an older server with no account for that email: said plainly; nothing here changes', { skip }, async () => {
  wipe();
  setHub(hubBase);
  A.setLimits({ req: 8000, status: 4000 });
  legacyOffline(userData, 'nobody@example.com');
  A.setIdTokens(async () => googleToken({ email: 'nobody@example.com' }));
  await assert.rejects(A.link({ provider: 'google' }), (e) => e.status === 404 && e.data?.noAccount === true);
  assert.equal(A.local().state, 'offline');
});
