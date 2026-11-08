// The Kea account on the phone (mobile/src/accountCore.ts and account.ts), with no passwords: the accounts kept on the
// phone (just an email offline), the states, linking by the same email only, Google and Microsoft sign-in addresses
// (PKCE), the first sign-in making the online account after the terms, and the flows
// against a stand-in phone (encrypted storage, the browser coming back) and a stand-in account server (the Kea account
// server, or a Kea Hub 0.5). No real Google, Microsoft or server is reached.
//   node --test test/mobile/account.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '../../mobile/src');

// ---------- a stand-in phone and account server ----------
const b64u = (s) => Buffer.from(s).toString('base64url');
const idToken = (email, extra = {}) => `${b64u(JSON.stringify({ alg: 'none' }))}.${b64u(JSON.stringify({ email, email_verified: true, ...extra }))}.sig`;
const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => void storage.set(k, String(v)),
  removeItem: (k) => void storage.delete(k),
  clear: () => storage.clear()
};

const server = {
  kind: 'keac', // 'keac' | 'hub05'
  up: true,
  online: new Map(), // email -> { id, email, password, displayName }
  calls: [],
  terms: { version: 7, sections: [{ id: 'a', title: 'A', body: 'x' }, { id: 'b', title: 'B', body: 'y' }] },
  sessions: new Map(),
  handle(method, p, body, token) {
    const acct = (a) => ({ id: a.id, email: a.email, displayName: a.displayName });
    const session = (a) => {
      const t = crypto.randomBytes(8).toString('hex');
      this.sessions.set(t, a.email);
      return this.kind === 'keac' ? { token: t, me: { account: acct(a) } } : { token: t, account: acct(a) };
    };
    if (p === '/v1/health') return [200, this.kind === 'keac' ? { ok: true, service: 'keac', features: ['google', 'microsoft', 'oauthCreate', 'passwordRetired', 'passes'] } : { ok: true, service: 'kea-hub' }];
    if (p === '/v1/terms') return [200, { terms: this.terms }];
    if (p === '/v1/auth/login' || p === '/v1/auth/register') return [410, { error: 'Kea accounts now sign in with Google or Microsoft only.', passwordRetired: true }];
    const fromToken = (t) => JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString()).email;
    if (p === '/v1/auth/oauth' || p === '/v1/auth/google') {
      if (p === '/v1/auth/oauth' && this.kind !== 'keac') return [404, { error: 'Not found.' }];
      const email = fromToken(body.idToken);
      const a = this.online.get(email);
      if (!a && this.kind !== 'keac') return [404, { error: 'No account for that email.' }];
      if (!a && body.termsVersion == null) return [404, { error: `There’s no Kea account for ${email} yet. Agree to the terms to make it.`, needsAccount: true, email, name: null }];
      if (!a) {
        if (body.termsVersion !== this.terms.version || body.age13 !== true || 'password' in body) return [400, { error: 'Agree to the terms.' }];
        const n = { id: `acc_${this.online.size + 1}`, email, displayName: email.split('@')[0] };
        this.online.set(email, n);
        return [201, session(n)];
      }
      if (a.totp && body.code !== '123456') return [401, { error: 'Enter the code.', totpRequired: true }];
      return [200, session(a)];
    }
    if (p === '/v1/me') {
      const e = this.sessions.get(token);
      if (!e) return [401, { error: 'Signed out.' }];
      return [200, { account: acct(this.online.get(e)) }];
    }
    if (p === '/v1/auth/logout') return this.sessions.delete(token), [200, { ok: true }];
    return [404, { error: 'Not found.' }];
  }
};

const phone = {
  url: '',
  token: '',
  email: '',
  accounts: '',
  listeners: { oauth: [] },
  providerEmail: 'sam@example.com',
  opened: [],
  tokenForms: [],
  async hubState() {
    return { url: this.url, signedIn: !!this.token, email: this.email, root: '/lib' };
  },
  async hubSetUrl({ url }) {
    if (new URL(url).origin !== (this.url && new URL(this.url).origin)) this.token = this.email = '';
    this.url = url;
  },
  async hubForget() {
    this.token = this.email = '';
  },
  async hubRequest(o) {
    server.calls.push({ method: o.method, path: o.path, connectMs: o.connectMs, readMs: o.readMs, auth: o.auth });
    if (!this.url) throw new Error('This copy of Kea has no Kea account address yet.');
    if (!server.up) throw new Error('timeout');
    const [status, body] = server.handle(o.method, o.path, o.body ? JSON.parse(o.body) : {}, o.auth ? this.token : '');
    const out = { ...body };
    if (o.keepToken && status < 300 && out.token) {
      this.token = out.token;
      this.email = (out.account || out.me?.account)?.email || '';
      delete out.token;
    }
    return { status, body: JSON.stringify(out), version: '' };
  },
  async accountsRead() {
    return { text: this.accounts };
  },
  async accountsWrite({ text }) {
    this.accounts = text;
  },
  async addListener(ev, cb) {
    this.listeners[ev].push(cb);
    return { remove() {} };
  },
  async takeOauth() {
    return {};
  },
  // The phone's browser: the provider's page signs in as providerEmail and comes back to the app's own address.
  async oauthOpen({ url }) {
    const u = new URL(url);
    this.opened.push(u);
    const back = `${u.searchParams.get('redirect_uri')}?code=c-${this.opened.length}&state=${encodeURIComponent(u.searchParams.get('state'))}`;
    setTimeout(() => this.listeners.oauth.forEach((cb) => cb({ url: back })), 5);
  },
  async oauthToken({ provider, body }) {
    this.tokenForms.push({ provider, form: new URLSearchParams(body) });
    return { status: 200, body: JSON.stringify({ id_token: idToken(this.providerEmail) }) };
  }
};
globalThis.__keaMock = phone;

let C, A;
before(async () => {
  const esbuild = require('esbuild');
  const stub = { name: 'kea-stub', setup: (b) => b.onResolve({ filter: /^\.\/kea$/ }, () => ({ path: path.join(here, 'keaStub.mjs') })) };
  const build = async (entry, extra = {}) => {
    const out = path.join(os.tmpdir(), `kea-phone-${path.basename(entry, '.ts')}-${process.pid}.cjs`);
    await esbuild.build({ entryPoints: [path.join(src, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent', plugins: [stub], ...extra });
    const m = require(out);
    fs.rmSync(out, { force: true });
    return m;
  };
  C = await build('accountCore.ts');
  A = await build('account.ts', { define: { 'import.meta.env': JSON.stringify({ VITE_KEA_GOOGLE_CLIENT_ID: 'g-test.apps.googleusercontent.com', VITE_KEA_MICROSOFT_CLIENT_ID: 'ms-test' }) } });
});
after(async () => {
  await A?.signOut().catch(() => {});
});

const memIO = () => {
  let text = null;
  return { io: { read: async () => text, write: async (t) => void (text = t) }, text: () => text };
};

// ---------- the accounts on the phone ----------
test('accounts on the phone: just an email, made at once; the same email opens it again; online sign-ins link by email', async () => {
  const m = memIO();
  let t = 1000;
  const S = C.createStore(m.io, { now: () => ++t });
  assert.equal(await S.active(), null);
  const r = await S.open({ email: ' Sam@Example.com ', name: 'Sam' });
  const a = r.account;
  assert.equal(r.created, true);
  assert.equal(a.email, 'sam@example.com');
  assert.equal(a.hub, null);
  assert.equal((await S.active()).id, a.id);
  assert.deepEqual(Object.keys(JSON.parse(m.text()).accounts[a.id]).sort(), ['createdAt', 'email', 'hub', 'id', 'lastSignIn', 'name']);
  await assert.rejects(() => S.open({ email: 'nope' }), (e) => e.field === 'email');
  assert.equal(C.makeVerifier, undefined, 'no password verifier any more');
  assert.equal(C.passwordProblem, undefined);

  await S.signOut();
  assert.equal(await S.active(), null);
  assert.equal((await S.list()).length, 1, 'signing out keeps the account here');
  const again = await S.open({ email: 'SAM@example.com' });
  assert.equal(again.created, false);
  assert.equal(again.account.id, a.id, 'the same account, with what it has here');

  // An online sign-in for the same email links this account (nothing else changes); another email gets its own.
  const linked = await S.attachOnline({ email: 'sam@example.com', name: 'Sam Online', hubId: 'acc_1', url: 'https://k.example', provider: 'google' });
  assert.equal(linked.id, a.id);
  assert.equal(linked.name, 'Sam');
  assert.deepEqual(linked.hub, { id: 'acc_1', url: 'https://k.example', provider: 'google' });
  const other = await S.attachOnline({ email: 'kim@example.com', hubId: 'acc_2', url: 'https://k.example' });
  assert.notEqual(other.id, a.id);
  assert.equal((await S.list())[0].email, 'kim@example.com');
  await S.remove(other.id);
  assert.equal(await S.find('kim@example.com'), null);
  // A broken record reads as empty, never an error.
  const S2 = C.createStore({ read: async () => '{nope', write: async () => {} });
  assert.equal(await S2.active(), null);
});

test('an older phone record (PBKDF2 verifiers): its accounts and emails stay, the verifiers are dropped once', async () => {
  const m = memIO();
  await m.io.write(JSON.stringify({ v: 1, active: 'loc_a', accounts: { loc_a: { id: 'loc_a', email: 'Sam@Example.com', name: 'Sam', createdAt: 1, lastSignIn: 2, verifier: { alg: 'pbkdf2-sha256', iter: 600000, keylen: 32, salt: 'AA==', hash: 'AA==' }, hub: { id: 'acc_1', url: 'https://k.example', provider: 'google' } } } }));
  const S = C.createStore(m.io);
  const a = await S.active();
  assert.equal(a.id, 'loc_a', 'still signed in as before');
  assert.equal(a.email, 'sam@example.com');
  assert.deepEqual(a.hub, { id: 'acc_1', url: 'https://k.example', provider: 'google' });
  assert.ok(!m.text().includes('verifier') && !m.text().includes('pbkdf2'));
  assert.equal(JSON.parse(m.text()).v, 2);
  await S.signOut();
  assert.equal((await S.open({ email: 'sam@example.com' })).account.id, 'loc_a');
});

// ---------- states and the locked wording ----------
test('states come from the phone alone, and cloud features say what they need', () => {
  assert.equal(C.accountState({ active: null, hasToken: false }), 'none');
  assert.equal(C.accountState({ active: { hub: null }, hasToken: false }), 'offline');
  assert.equal(C.accountState({ active: { hub: { id: 'x' } }, hasToken: false }), 'linked');
  assert.equal(C.accountState({ active: null, hasToken: true }), 'online');
  assert.equal(C.gateOpen('none'), true);
  assert.equal(C.gateOpen('offline'), false);
  const s = (state, o = {}) => ({ state, reachable: false, checked: false, url: 'https://k.example', ...o });
  assert.equal(C.onlineNeed(s('offline')), 'offline');
  assert.equal(C.onlineNeed(s('linked')), 'linked');
  assert.equal(C.onlineNeed(s('online')), null, 'not checked yet: nothing is locked');
  assert.equal(C.onlineNeed(s('online', { checked: true })), 'unreachable');
  assert.equal(C.onlineNeed(s('online', { checked: true, reachable: true })), null);
  assert.equal(C.onlineNeed(s('offline', { url: '' })), 'noAddress');
  // The same words as Kea on the computer (src/components/account/NeedsOnline.tsx), with "phone" for "computer".
  assert.equal(C.needsOnlineText('offline').title, 'Needs your Kea account online');
  assert.equal(C.needsOnlineText('offline').text, 'Take your account online with Google or Microsoft to use it. Everything on this phone works without it.');
  assert.equal(C.needsOnlineText('offline').action, 'Go online');
  assert.equal(C.needsOnlineText('linked').text, 'Sign in online to use it.');

  assert.equal(C.needsOnlineText('linked').action, 'Sign in online');
  assert.equal(C.needsOnlineText('unreachable').text, 'Kea can’t reach it right now, and tries again by itself.');
  assert.equal(C.needsOnlineText('unreachable').action, null);
});

// ---------- linking ----------
test('linking: the same email only', () => {
  assert.deepEqual(C.idTokenEmail(idToken('Sam@Example.com', { name: 'Sam' })), { email: 'sam@example.com', name: 'Sam' });
  assert.deepEqual(C.idTokenEmail('garbage'), { email: '', name: null });
  assert.deepEqual(C.linkDecision({ email: 'sam@example.com', hub: null }, 'SAM@example.com'), { link: true, reason: 'link' });
  assert.deepEqual(C.linkDecision({ email: 'sam@example.com', hub: { id: 'x' } }, 'sam@example.com'), { link: true, reason: 'relink' });
  const d = C.linkDecision({ email: 'sam@example.com' }, 'other@example.com');
  assert.deepEqual(d, { link: false, reason: 'differentEmail', accountEmail: 'sam@example.com', providerEmail: 'other@example.com' });
  assert.equal(C.linkRefusal(d, 'Google'), 'That Google account is other@example.com, not sam@example.com. A different email never links to this account, and nothing here changed.');
  assert.equal(C.linkDecision({ email: 'sam@example.com' }, '').reason, 'noEmail');
  assert.equal(C.linkDecision(null, 'sam@example.com').reason, 'noAccount');
});

// ---------- PKCE and the sign-in addresses ----------
test('PKCE: S256 (RFC 7636 appendix B), and a fresh verifier each time', async () => {
  assert.equal(await C.pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  const a = await C.pkcePair(),
    b = await C.pkcePair();
  assert.match(a.verifier, /^[A-Za-z0-9_-]{64}$/);
  assert.notEqual(a.verifier, b.verifier);
  assert.equal(a.challenge, crypto.createHash('sha256').update(a.verifier).digest('base64url'));
  assert.equal(a.method, 'S256');
});

test('Google and Microsoft addresses: Custom Tabs back to com.kea.scholar:/oauth, no client secret', () => {
  assert.equal(C.REDIRECT_URI, 'com.kea.scholar:/oauth');
  const g = new URL(C.authorizeUrl('google', { clientId: 'gid', challenge: 'ch', state: 'st', loginHint: 'sam@example.com' }));
  assert.equal(g.origin + g.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.deepEqual(Object.fromEntries(g.searchParams), { client_id: 'gid', redirect_uri: 'com.kea.scholar:/oauth', response_type: 'code', scope: 'openid email profile', code_challenge: 'ch', code_challenge_method: 'S256', state: 'st', prompt: 'select_account', login_hint: 'sam@example.com' });
  const m = new URL(C.authorizeUrl('microsoft', { clientId: 'mid', challenge: 'ch', state: 'st' }));
  assert.equal(m.origin + m.pathname, 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
  assert.equal(m.searchParams.get('response_mode'), 'query');
  assert.equal(m.searchParams.get('login_hint'), null);
  const t = C.tokenRequest('microsoft', { clientId: 'mid', code: 'c', verifier: 'v' });
  assert.equal(t.url, 'https://login.microsoftonline.com/common/oauth2/v2.0/token');
  const f = new URLSearchParams(t.body);
  assert.deepEqual(Object.fromEntries(f), { code: 'c', client_id: 'mid', code_verifier: 'v', grant_type: 'authorization_code', redirect_uri: 'com.kea.scholar:/oauth', scope: 'openid email profile' });
  const tg = new URLSearchParams(C.tokenRequest('google', { clientId: 'gid', code: 'c', verifier: 'v' }).body);
  assert.equal(tg.get('client_secret'), null);
  assert.equal(tg.get('scope'), null);
  assert.throws(() => C.authorizeUrl('github', { clientId: 'x', challenge: 'c', state: 's' }), /Unknown/);

  assert.deepEqual(C.parseRedirect('com.kea.scholar:/oauth?code=abc&state=st', 'st'), { code: 'abc' });
  assert.match(C.parseRedirect('com.kea.scholar:/oauth?code=abc&state=old', 'st').error, /older attempt/);
  assert.match(C.parseRedirect('https://evil.example/oauth?code=abc&state=st', 'st').error, /didn’t come back/);
  assert.match(C.parseRedirect('com.kea.scholar:/other?code=abc&state=st', 'st').error, /didn’t come back/);
  assert.deepEqual(C.parseRedirect('com.kea.scholar:/oauth?error=access_denied&state=st', 'st', 'Google'), { error: 'Google sign-in was cancelled.', cancelled: true });
  assert.match(C.parseRedirect('com.kea.scholar:/oauth?state=st', 'st').error, /cancelled/);
});

test('which server: the Kea account server takes /v1/auth/oauth; a Kea Hub 0.5 Google only at /v1/auth/google', () => {
  const keac = C.serverKind({ ok: true, service: 'keac', features: ['google', 'microsoft', 'passes'] });
  assert.deepEqual(keac, { current: true, google: true, microsoft: true });
  const hub = C.serverKind({ ok: true, service: 'kea-hub' });
  assert.deepEqual(hub, { current: false, google: true, microsoft: false });
  assert.deepEqual(C.oauthRequest(keac, 'microsoft', 'tok', { code: '123456' }), { path: '/v1/auth/oauth', body: { provider: 'microsoft', idToken: 'tok', code: '123456' } });
  assert.deepEqual(C.oauthRequest(keac, 'google', 'tok', { termsVersion: 3, termsSections: ['a'], age13: true }), { path: '/v1/auth/oauth', body: { provider: 'google', idToken: 'tok', termsVersion: 3, termsSections: ['a'], age13: true } });
  assert.deepEqual(C.oauthRequest(hub, 'google', 'tok'), { path: '/v1/auth/google', body: { idToken: 'tok' } });
  assert.throws(() => C.oauthRequest(hub, 'microsoft', 'tok'), /Microsoft/);
  assert.equal(C.registerRequest, undefined, 'no password registration any more');
});

test('the address: built in (empty until it exists), the Advanced one first, https only', () => {
  assert.equal(C.DEFAULT_ACCOUNT_URL, '');
  assert.equal(C.accountUrl('', ''), '');
  assert.equal(C.accountUrl('k.example/x', 'https://built.example'), 'https://k.example');
  assert.equal(C.accountUrl('', 'https://built.example/'), 'https://built.example');
  assert.equal(C.accountUrl('http://k.example', 'https://built.example'), 'https://built.example');
  assert.throws(() => C.normalizeAccountUrl('http://k.example'), /https/);
  assert.throws(() => C.normalizeAccountUrl(''), /address/);
});

// ---------- the flows, on a stand-in phone ----------
const reset = async ({ kind = 'keac', up = true, url = 'https://keac.example' } = {}) => {
  await A.signOut().catch(() => {});
  Object.assign(server, { kind, up, calls: [] });
  server.online.clear();
  server.sessions.clear();
  Object.assign(phone, { url: '', token: '', email: '', accounts: '', opened: [], tokenForms: [], providerEmail: 'sam@example.com' });
  storage.clear();
  if (url) storage.set('kea.accountUrl', url);
};
const auth = () => server.calls.filter((c) => c.path.startsWith('/v1/auth/') && c.path !== '/v1/auth/logout');

test('flows: just an email opens Kea on the phone with no connection; the server unreachable is a normal state', async () => {
  await reset({ up: false });
  const s0 = await A.status();
  assert.equal(s0.state, 'none');
  assert.equal(s0.checked, true);
  assert.equal(s0.reachable, false);
  // The background check is short.
  assert.deepEqual(server.calls.map((c) => [c.path, c.connectMs, c.readMs]), [['/v1/health', 4000, 4000]]);
  server.calls = [];
  const s = await A.openOffline({ email: 'sam@example.com', name: 'Sam' });
  assert.equal(s.state, 'offline');
  assert.equal(s.created, true);
  assert.equal(server.calls.length, 0, 'no connection needed');
  await A.signOut();
  assert.equal((await A.local()).state, 'none');
  const back = await A.openOffline({ email: 'SAM@example.com' });
  assert.equal(back.state, 'offline');
  assert.equal(back.created, false);
  assert.equal(back.account.id, s.account.id, 'the same account on this phone');
  assert.equal(auth().length, 0);
  assert.equal(A.login, undefined);
  assert.equal(A.create, undefined);
});

test('flows: the first Google sign-in asks for the terms, then the same sign-in makes the online account; it stays signed in', async () => {
  await reset();
  const s0 = await A.status();
  await assert.rejects(() => A.oauthSignIn({ provider: 'google' }), (e) => e.status === 404 && e.data.needsAccount === true && e.data.email === 'sam@example.com');
  assert.deepEqual((await A.local()).pending, { email: 'sam@example.com', name: null, provider: 'google' });
  const opens = phone.opened.length;
  await assert.rejects(() => A.continueSignIn({ termsVersion: 7, termsSections: ['a', 'b'], age13: false }), /13/);
  const terms = await A.currentTerms();
  const s = await A.continueSignIn({ termsVersion: terms.version, termsSections: terms.sections.map((x) => x.id), age13: true });
  assert.equal(s.state, 'online');
  assert.equal(s.account.linked, true);
  assert.equal(phone.opened.length, opens, 'the same Google sign-in, no second trip');
  const tokens = auth().map((c) => c.path);
  assert.deepEqual(tokens, ['/v1/auth/oauth', '/v1/auth/oauth']);
  assert.equal((await A.local()).pending, null);
  assert.equal(storage.get('kea.hubOn'), '1');
  // Stays signed in; signed out with no connection, the same email opens it again (linked).
  await A.signOut();
  server.up = false;
  const off = await A.openOffline({ email: 'sam@example.com' });
  assert.equal(off.state, 'linked');
  server.up = true;
  // The session ending online leaves the account signed in here, linked.
  phone.providerEmail = 'sam@example.com';
  const on = await A.link({ provider: 'google' });
  assert.equal(on.state, 'online');
  server.sessions.clear();
  assert.equal((await A.status()).state, 'linked');
  void s0;
});

test('flows: going online links only the same email; an existing (moved) account with that email is signed in to', async () => {
  await reset();
  await A.openOffline({ email: 'sam@example.com' });
  phone.providerEmail = 'someone.else@example.com';
  await assert.rejects(
    () => A.link({ provider: 'google' }),
    (e) => e.status === 409 && e.data.mismatch && e.message === 'That Google account is someone.else@example.com, not sam@example.com. A different email never links to this account, and nothing here changed.'
  );
  assert.equal((await A.local()).state, 'offline');
  assert.equal(auth().length, 0, 'a different email never reaches the server');
  // The browser went to Google with PKCE and came back to the app's own address.
  const u = phone.opened.at(-1);
  assert.equal(u.searchParams.get('client_id'), 'g-test.apps.googleusercontent.com');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('login_hint'), 'sam@example.com');
  const form = phone.tokenForms.at(-1).form;
  assert.equal(await C.pkceChallenge(form.get('code_verifier')), u.searchParams.get('code_challenge'));
  assert.equal(form.get('redirect_uri'), 'com.kea.scholar:/oauth');
  // The same email, an online account made elsewhere (moved from the old Hub): signed in to and linked.
  server.online.set('sam@example.com', { id: 'acc_moved', email: 'sam@example.com', displayName: 'Sam' });
  phone.providerEmail = 'sam@example.com';
  const s = await A.link({ provider: 'google' });
  assert.equal(s.state, 'online');
  assert.equal(s.account.provider, 'google');
  assert.ok(!auth().some((c) => c.path === '/v1/auth/login' || c.path === '/v1/auth/register'));
});

test('flows: only the owner account is asked for a two-step code; the same sign-in goes again with it', async () => {
  await reset();
  server.online.set('sam@example.com', { id: 'acc_owner', email: 'sam@example.com', displayName: 'Owner', totp: true });
  await assert.rejects(() => A.oauthSignIn({ provider: 'google' }), (e) => e.data?.totpRequired === true);
  const opens = phone.opened.length;
  const s = await A.continueSignIn({ code: '123 456' });
  assert.equal(s.state, 'online');
  assert.equal(phone.opened.length, opens);
});

test('flows: Continue with Google on a Kea Hub 0.5 uses /v1/auth/google; Microsoft is offered only where the server takes it', async () => {
  await reset({ kind: 'hub05', url: 'https://old-hub05.example' });
  server.online.set('sam@example.com', { id: 'acc_1', email: 'sam@example.com', displayName: 'Sam' });
  const s = await A.oauthSignIn({ provider: 'google' });
  assert.equal(s.state, 'online');
  assert.equal(s.microsoftOnServer, false);
  assert.ok(auth().some((c) => c.path === '/v1/auth/google'));
  assert.ok(!auth().some((c) => c.path === '/v1/auth/oauth'));
  await assert.rejects(() => A.oauthSignIn({ provider: 'microsoft' }), /Microsoft/);
  // An older server with no account for that email: said plainly.
  phone.providerEmail = 'nobody@example.com';
  await A.signOut();
  await assert.rejects(() => A.oauthSignIn({ provider: 'google' }), (e) => e.status === 404 && e.data.noAccount === true);

  await reset({ kind: 'keac' });
  server.online.set('sam@example.com', { id: 'acc_1', email: 'sam@example.com', displayName: 'Sam' });
  const m = await A.oauthSignIn({ provider: 'microsoft' });
  assert.equal(m.state, 'online');
  assert.equal(phone.opened.at(-1).host, 'login.microsoftonline.com');
  assert.equal(phone.tokenForms.at(-1).provider, 'microsoft');
  assert.ok(auth().some((c) => c.path === '/v1/auth/oauth'));
});

test('flows: with no address anywhere, the account on the phone still works and online waits calmly', async () => {
  await reset({ url: '' });
  const s = await A.status();
  assert.equal(s.url, '');
  assert.equal(server.calls.length, 0);
  assert.equal((await A.openOffline({ email: 'sam@example.com' })).state, 'offline');
  assert.equal(C.onlineNeed(await A.local()), 'noAddress');
  await assert.rejects(() => A.link({ provider: 'google' }), (e) => e.data.noAddress);
  // Setting one under Advanced: https only.
  await assert.rejects(() => A.setAdvancedUrl('http://k.example'), /https/);
  const a = await A.setAdvancedUrl('keac.example');
  assert.equal(a.url, 'https://keac.example');
  assert.equal(phone.url, 'https://keac.example');
});

test('flows: a phone signed in before accounts were kept here becomes a linked account, its typed address under Advanced', async () => {
  await reset({ url: null });
  storage.delete('kea.accountUrl');
  Object.assign(phone, { url: 'https://old-hub.example', token: 'tok-old', email: 'old@example.com' });
  server.up = false;
  const s = await A.status();
  assert.equal(s.state, 'online');
  assert.equal(s.account.email, 'old@example.com');
  assert.equal(s.advancedUrl, 'https://old-hub.example');
  assert.equal(phone.token, 'tok-old', 'the sign-in is kept');
  phone.token = '';
  assert.equal((await A.local()).state, 'linked');
});
