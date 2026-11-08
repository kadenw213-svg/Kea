// Offline-first Kea accounts (electron/accountCore.cjs, electron/hub.cjs): an account is made and signed in on this
// computer with no connection (a scrypt verifier, never the password); an online sign-in keeps a verifier too, so the
// same account signs in offline later; the start screen decides from this computer alone; every request to the server
// has a time limit and "can't reach it" is a normal answer; a Google or Microsoft sign-in links only the same email,
// and linking never deletes anything here. The real-Hub parts use KeaS/hub next to this repo (or KEAS_DIR).
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

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const HUB = [process.env.KEAS_DIR && path.join(process.env.KEAS_DIR, 'hub/index.mjs'), path.resolve(here, '../../../KeaS/hub/index.mjs')].find((p) => p && fs.existsSync(p)) || '';
const core = require('../../electron/accountCore.cjs');
const FAST = { N: 2 ** 10, r: 8, p: 1, keylen: 32 }; // (weak settings, only to keep the store tests quick)

const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `kea-offline-${n}-`));
const dirs = [];
const scratch = (n) => (dirs.push(tmp(n)), dirs[dirs.length - 1]);

// ---------- The verifier ----------
test('the verifier: scrypt with strong settings and a random salt, checked in constant time, never the password', async () => {
  const v = await core.makeVerifier('lantern velvet orbit');
  assert.equal(v.alg, 'scrypt');
  assert.ok(v.N >= 2 ** 17 && v.r >= 8 && v.keylen >= 32, 'strong settings');
  assert.equal(Buffer.from(v.salt, 'base64').length, 16);
  assert.ok(!JSON.stringify(v).includes('lantern'));
  assert.equal(await core.checkVerifier('lantern velvet orbit', v), true);
  assert.equal(await core.checkVerifier('lantern velvet orbiT', v), false);
  assert.equal(await core.checkVerifier('', v), false);
  // The same password twice: different salts, different hashes.
  const w = await core.makeVerifier('lantern velvet orbit', FAST);
  assert.notEqual(w.salt, v.salt);
  // A changed or broken verifier is a "no", never an error, and never makes Kea do huge work.
  assert.equal(await core.checkVerifier('lantern velvet orbit', { ...w, hash: 'AAAA' }), false);
  assert.equal(await core.checkVerifier('lantern velvet orbit', { ...w, N: 2 ** 30 }), false);
  assert.equal(await core.checkVerifier('lantern velvet orbit', { ...w, N: 1000 }), false);
  assert.equal(await core.checkVerifier('lantern velvet orbit', null), false);
  assert.match(fs.readFileSync(require.resolve('../../electron/accountCore.cjs'), 'utf8'), /timingSafeEqual/);
});

test('the password rule matches the Kea account server’s', () => {
  assert.match(core.passwordProblem('short', 'a@x.org'), /10 characters/);
  assert.match(core.passwordProblem('aaaaaaaaaaaa', 'a@x.org'), /repeated/);
  assert.match(core.passwordProblem('samantha-likes-tea', 'samantha@x.org'), /email/);
  assert.equal(core.passwordProblem('lantern velvet orbit', 'sam@x.org'), null);
});

// ---------- Accounts on this computer ----------
test('making an account offline: at once, signed in, kept with a verifier only', async () => {
  const d = scratch('store');
  const S = core.createStore(d, { params: FAST });
  assert.equal(S.active(), null);
  const a = await S.create({ email: ' Ana@X.org ', password: 'lantern velvet orbit', name: 'Ana' });
  assert.equal(a.email, 'ana@x.org');
  assert.equal(a.name, 'Ana');
  assert.equal(a.canSignInOffline, true);
  assert.equal(a.hub, null);
  assert.equal(S.active().id, a.id);
  const raw = fs.readFileSync(path.join(d, core.FILE), 'utf8');
  assert.ok(!raw.includes('lantern'), 'the password is never kept');
  assert.match(raw, /"alg": "scrypt"/);
  // The name is optional.
  const b = await S.create({ email: 'ben@x.org', password: 'quiet harbor lamp' });
  assert.equal(b.name, '');
  // One account per email here; a bad email or password is said plainly.
  await assert.rejects(S.create({ email: 'ANA@x.org', password: 'lantern velvet orbit' }), /already has a Kea account/);
  await assert.rejects(S.create({ email: 'not-an-email', password: 'lantern velvet orbit' }), /email/);
  await assert.rejects(S.create({ email: 'cy@x.org', password: 'short' }), /10 characters/);
});

test('signing in offline, signing out, and switching: one account at a time, the others kept', async () => {
  const S = core.createStore(scratch('signin'), { params: FAST });
  const ana = await S.create({ email: 'ana@x.org', password: 'lantern velvet orbit', name: 'Ana' });
  S.signOut();
  assert.equal(S.active(), null);
  assert.equal(S.list().length, 1, 'signing out keeps the account here');
  assert.deepEqual(await S.signIn({ email: 'ana@x.org', password: 'nope nope nope' }).then((r) => [r.ok, r.reason]), [false, 'wrong']);
  assert.deepEqual(await S.signIn({ email: 'who@x.org', password: 'lantern velvet orbit' }).then((r) => [r.ok, r.reason]), [false, 'unknown']);
  assert.equal(S.active(), null);
  const r = await S.signIn({ email: 'ANA@x.org', password: 'lantern velvet orbit' });
  assert.equal(r.ok, true);
  assert.equal(S.active().id, ana.id);
  const ben = await S.create({ email: 'ben@x.org', password: 'quiet harbor lamp' });
  assert.equal(S.active().id, ben.id, 'the new one is the one signed in');
  assert.deepEqual(S.list().map((x) => x.email).sort(), ['ana@x.org', 'ben@x.org']);
  // A verifier made with weaker settings is made again at the next sign-in.
  const weak = core.createStore(scratch('weak'), { params: FAST });
  await weak.create({ email: 'cy@x.org', password: 'lantern velvet orbit' });
  const strong = core.createStore(path.dirname(weak.file));
  await strong.signIn({ email: 'cy@x.org', password: 'lantern velvet orbit' });
  assert.equal(JSON.parse(fs.readFileSync(weak.file, 'utf8')).accounts[strong.active().id].verifier.N, core.STRONG.N);
});

test('after an online sign-in the same account signs in offline; linking keeps the account here', async () => {
  const S = core.createStore(scratch('online'), { params: FAST });
  const off = await S.create({ email: 'ana@x.org', password: 'lantern velvet orbit', name: 'Ana' });
  const linked = await S.rememberOnline({ email: 'ana@x.org', name: 'Ana Online', hubId: 'h1', url: 'http://hub', provider: 'google' });
  assert.equal(linked.id, off.id, 'the same account, now linked');
  assert.equal(linked.name, 'Ana', 'nothing else about it changes');
  assert.deepEqual(linked.hub, { id: 'h1', url: 'http://hub', provider: 'google' });
  assert.equal((await S.check({ email: 'ana@x.org', password: 'lantern velvet orbit' })).ok, true, 'its password still works offline');
  // An online account new to this computer: kept with the password it signed in with.
  S.signOut();
  const ben = await S.rememberOnline({ email: 'ben@x.org', name: 'Ben', hubId: 'h2', url: 'http://hub', password: 'quiet harbor lamp' });
  assert.equal(ben.canSignInOffline, true);
  S.signOut();
  assert.equal((await S.signIn({ email: 'ben@x.org', password: 'quiet harbor lamp' })).ok, true);
  // Signed in with Google only (no password yet): it can't sign in offline until a password sign-in.
  const cy = S.attachOnline({ email: 'cy@x.org', name: 'Cy', hubId: 'h3', url: 'http://hub' });
  assert.equal(cy.canSignInOffline, false);
  assert.equal((await S.check({ email: 'cy@x.org', password: 'anything at all' })).reason, 'noVerifier');
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

// ---------- The start screen ----------
test('the start screen decides from this computer alone', () => {
  const S = (active, hasToken) => core.accountState({ active, hasToken });
  assert.equal(S(null, false), 'none');
  assert.equal(S({ hub: null }, false), 'offline');
  assert.equal(S({ hub: { id: 'h1' } }, false), 'linked');
  assert.equal(S({ hub: { id: 'h1' } }, true), 'online');
  assert.equal(S(null, true), 'online', 'a sign-in from before accounts were kept here');
  assert.equal(core.gateOpen('none'), true);
  for (const s of ['offline', 'linked', 'online']) assert.equal(core.gateOpen(s), false, s);
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

test('offline: make an account, sign out, sign in again, start Kea again: never waiting on the network', async () => {
  wipe();
  setHub(`http://127.0.0.1:${deadPort}`);
  A.setLimits({ req: 1500, status: 800 });
  // The start screen's first answer is from this computer alone.
  let t0 = Date.now();
  let s = A.local();
  assert.ok(Date.now() - t0 < 100);
  assert.equal(s.state, 'none');
  assert.equal(s.reachable, false);
  assert.equal(s.checked, false);
  s = await A.create({ email: 'ana@x.org', password: 'lantern velvet orbit', name: 'Ana' });
  assert.equal(s.state, 'offline');
  assert.equal(s.account.email, 'ana@x.org');
  assert.equal(s.signedIn, false);
  // The server can't be reached: a normal answer, quickly.
  t0 = Date.now();
  s = await A.status();
  assert.ok(Date.now() - t0 < 1500);
  assert.equal(s.state, 'offline');
  assert.equal(s.reachable, false);
  assert.equal(s.checked, true);
  assert.equal(A.logout().state, 'none');
  await assert.rejects(A.login({ email: 'ana@x.org', password: 'wrong password!' }), /Wrong password/);
  s = await A.login({ email: 'ana@x.org', password: 'lantern velvet orbit' });
  assert.equal(s.state, 'offline');
  assert.deepEqual(s.known.map((k) => k.email), ['ana@x.org']);
  // "Restart": a fresh read of this computer's files says the same.
  A.reset();
  assert.equal(A.local().state, 'offline');
  assert.equal(A.local().account.email, 'ana@x.org');
  // An email this computer never saw, offline: said plainly, as "unreachable".
  A.logout();
  await assert.rejects(A.login({ email: 'new@x.org', password: 'lantern velvet orbit' }), (e) => e.status === 0 && /hasn’t signed in on this computer/.test(e.message));
});

test('a server that takes the connection and never answers: status gives up within its limit', async () => {
  wipe();
  const srv = await slowServer('silent');
  setHub(srv.url);
  A.setLimits({ req: 600, status: 300 });
  await A.create({ email: 'ana@x.org', password: 'lantern velvet orbit' });
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

test('an existing online account (Hub 0.5) signs in as before, then offline with the same password', { skip }, async () => {
  wipe();
  setHub(hubBase);
  A.setLimits({ req: 8000, status: 4000 });
  const t = await terms();
  const reg = await registerAndSignIn(hubBase, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'sam@example.com', password: 'lantern velvet orbit', displayName: 'Sam', age13: true, termsVersion: t.version, termsSections: t.sections.map((s) => s.id) }) });
  assert.equal(reg.status, 200);
  let s = await A.login({ email: 'sam@example.com', password: 'lantern velvet orbit' });
  assert.equal(s.state, 'online');
  assert.equal(s.me.account.email, 'sam@example.com');
  assert.ok(fs.existsSync(tokenFile), 'the online session is kept (encrypted when the OS can)');
  const kept = JSON.parse(fs.readFileSync(path.join(userData, core.FILE), 'utf8'));
  assert.ok(!JSON.stringify(kept).includes('lantern'), 'never the password');
  assert.equal(Object.values(kept.accounts)[0].verifier.alg, 'scrypt');
  // Sign out, the network goes away, sign in again: offline, against the verifier.
  A.logout();
  setHub(`http://127.0.0.1:${deadPort}`);
  A.setLimits({ req: 1500, status: 800 });
  s = await A.login({ email: 'sam@example.com', password: 'lantern velvet orbit' });
  assert.equal(s.state, 'linked');
  assert.equal(s.account.email, 'sam@example.com');
  // Online again: the session comes back by itself (the background sign-in).
  setHub(hubBase);
  A.setLimits({ req: 8000, status: 4000 });
  A.reset();
  sent.length = 0;
  s = await A.login({ email: 'sam@example.com', password: 'lantern velvet orbit' });
  assert.equal(s.state, 'linked', 'signed in here at once');
  for (let i = 0; i < 100 && A.local().state !== 'online'; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(A.local().state, 'online');
  assert.ok(sent.includes('hub:changed'), 'the page is told');
});

test('going online with Google: the same email links and keeps everything here; a different email never links', { skip }, async () => {
  wipe();
  setHub(hubBase);
  A.setLimits({ req: 8000, status: 4000 });
  let s = await A.create({ email: 'lin@example.com', password: 'quiet harbor lamp', name: 'Lin' });
  const localId = s.account.id;
  // Something of this account's on this computer.
  fs.writeFileSync(path.join(userData, 'my-notes.txt'), 'kept');
  // A different email: nothing changes.
  A.setIdTokens(async () => googleToken({ email: 'someone.else@example.com' }));
  const t = await terms();
  const agree = { termsVersion: t.version, termsSections: t.sections.map((x) => x.id), age13: true };
  await assert.rejects(A.link({ provider: 'google', password: 'quiet harbor lamp', ...agree }), (e) => e.status === 409 && e.data?.mismatch && e.data.reason === 'differentEmail' && /never links/.test(e.message));
  assert.equal(A.local().state, 'offline');
  assert.equal(fs.existsSync(tokenFile), false);
  // The wrong password for this account: refused before anything goes online.
  A.setIdTokens(async () => googleToken({ email: 'lin@example.com' }));
  await assert.rejects(A.link({ provider: 'google', password: 'not my password', ...agree }), /isn’t this account’s password/);
  // The same email: the online account is made (Google-verified) and linked.
  s = await A.link({ provider: 'google', password: 'quiet harbor lamp', ...agree });
  assert.equal(s.state, 'online');
  assert.equal(s.account.id, localId, 'the same account here');
  assert.equal(s.me.account.email, 'lin@example.com');
  assert.equal(s.me.account.emailVerified, true);
  assert.equal(fs.readFileSync(path.join(userData, 'my-notes.txt'), 'utf8'), 'kept', 'nothing here is deleted by linking');
  assert.equal(hub.current().hub.provider, 'google');
  // Later, from the start screen: Continue with Google signs in to the same account.
  A.logout();
  s = await A.oauthSignIn({ provider: 'google', email: 'lin@example.com' });
  assert.equal(s.state, 'online');
  assert.equal(s.account.id, localId);
  // And the password still signs in offline.
  A.logout();
  setHub(`http://127.0.0.1:${deadPort}`);
  A.setLimits({ req: 1500, status: 800 });
  assert.equal((await A.login({ email: 'lin@example.com', password: 'quiet harbor lamp' })).state, 'linked');
});

test('going online when the online account already exists: Continue with Google signs in to it and links', { skip }, async () => {
  wipe();
  setHub(hubBase);
  A.setLimits({ req: 8000, status: 4000 });
  const t = await terms();
  await registerAndSignIn(hubBase, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'max@example.com', password: 'other strong secret', displayName: 'Max', age13: true, termsVersion: t.version, termsSections: t.sections.map((s) => s.id) }) });
  const s0 = await A.create({ email: 'max@example.com', password: 'local strong secret' });
  A.setIdTokens(async () => googleToken({ email: 'max@example.com' }));
  // With this computer's (different) password, the server can't sign in: said plainly, offering Google again.
  await assert.rejects(A.link({ provider: 'google', password: 'local strong secret', termsVersion: t.version, termsSections: t.sections.map((x) => x.id), age13: true }), (e) => e.data?.existsOnline === true);
  assert.equal(A.local().state, 'offline');
  const s = await A.link({ provider: 'google' });
  assert.equal(s.state, 'online');
  assert.equal(s.account.id, s0.account.id);
  // Its offline password is still this computer's.
  A.logout();
  assert.equal((await A.login({ email: 'max@example.com', password: 'local strong secret' })).state !== 'none', true);
});
