// The Kea account on the phone (mobile/src/accountCore.ts and account.ts), with no passwords: the accounts kept on the
// phone (made only by a Google or Microsoft sign-in; email-only ones from older Kea kept working), the states, linking
// by the same email only, Google and Microsoft sign-in addresses (PKCE), the first sign-in making the online account
// after the terms and waiting for the server, and the flows
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
  patches: [],
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
      const a = this.online.get(e);
      if (method === 'PATCH') {
        if ('phone' in body && body.phone !== null && !/^\+[1-9]\d{7,14}$/.test(body.phone)) return [400, { error: 'That phone number isn’t valid.' }];
        if ('name' in body) a.displayName = body.name;
        if ('phone' in body) a.phone = body.phone;
        if (body.phoneShare) a.phoneShare = { ...(a.phoneShare || { orgs: true, classmates: false }), ...body.phoneShare };
        this.patches.push(body);
      }
      return [200, { account: acct(a), name: a.displayName, phone: a.phone ?? null, phoneShare: a.phoneShare || { orgs: true, classmates: false } }];
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

/** An email-only account as Kea 0.82 and older left it on the phone (Kea no longer makes these), signed in. */
const legacyRecord = (email, name = '') => JSON.stringify({ v: 2, active: 'loc_old', accounts: { loc_old: { id: 'loc_old', email, name, createdAt: 1, lastSignIn: 2, hub: null } } });

// ---------- the accounts on the phone ----------
test('accounts on the phone: nothing makes one with just an email; an older one opens again; online sign-ins link by email', async () => {
  const m = memIO();
  let t = 1000;
  const S = C.createStore(m.io, { now: () => ++t });
  assert.equal(await S.active(), null);
  assert.equal(S.open, undefined, 'no way to make an account with just an email');
  await assert.rejects(() => S.reopen({ email: 'sam@example.com' }), (e) => e.noAccount === true && /Sign in with Google/.test(e.message));
  await assert.rejects(() => S.reopen({ email: 'nope' }), (e) => e.field === 'email');
  assert.equal(m.text(), null, 'nothing was written');
  assert.equal(C.makeVerifier, undefined, 'no password verifier any more');
  assert.equal(C.passwordProblem, undefined);
  assert.equal(C.gateOpen, undefined, 'no sign-in screen in front of Kea');

  // An email-only account an older Kea made: still signed in; signed out, it opens again here.
  await m.io.write(legacyRecord('sam@example.com', 'Sam'));
  const a = await S.active();
  assert.equal(a.id, 'loc_old');
  assert.equal(a.hub, null);
  await S.signOut();
  assert.equal(await S.active(), null);
  assert.equal((await S.list()).length, 1, 'signing out keeps the account here');
  const again = await S.reopen({ email: 'SAM@example.com' });
  assert.equal(again.id, a.id, 'the same account, with what it has here');

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
  assert.equal((await S.reopen({ email: 'sam@example.com' })).id, 'loc_a');
});

// ---------- states and the locked wording ----------
test('states come from the phone alone, and cloud features say what they need', () => {
  assert.equal(C.accountState({ active: null, hasToken: false }), 'none');
  assert.equal(C.accountState({ active: { hub: null }, hasToken: false }), 'offline');
  assert.equal(C.accountState({ active: { hub: { id: 'x' } }, hasToken: false }), 'linked');
  assert.equal(C.accountState({ active: null, hasToken: true }), 'online');
  const s = (state, o = {}) => ({ state, reachable: false, checked: false, url: 'https://k.example', ...o });
  assert.equal(C.onlineNeed(s('none')), 'none');
  assert.equal(C.onlineNeed(s('offline')), 'offline');
  assert.equal(C.onlineNeed(s('linked')), 'linked');
  assert.equal(C.onlineNeed(s('online')), null, 'not checked yet: nothing is locked');
  assert.equal(C.onlineNeed(s('online', { checked: true })), 'unreachable');
  assert.equal(C.onlineNeed(s('none', { checked: true })), 'unreachable', 'the server not answering comes first');
  assert.equal(C.onlineNeed(s('online', { checked: true, reachable: true })), null);
  assert.equal(C.onlineNeed(s('offline', { url: '' })), 'noAddress');
  assert.equal(C.signInWaits({ checked: true, reachable: false }), true);
  assert.equal(C.signInWaits({ checked: false, reachable: false }), false);
  // The same words as Kea on the computer (src/components/account/NeedsOnline.tsx).
  for (const need of ['none', 'offline', 'linked']) {
    assert.equal(C.needsOnlineText(need).title, 'Needs your Kea account');
    assert.equal(C.needsOnlineText(need).text, 'Sign in with Google to use this.');
    assert.equal(C.needsOnlineText(need).action, 'Sign in with Google');
  }
  assert.equal(C.needsOnlineText('unreachable').text, 'Can’t reach the Kea account server right now. Kea tries again by itself.');
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

test('the address: built in, the Advanced one first, https only', () => {
  assert.match(C.DEFAULT_ACCOUNT_URL, /^https:\/\/[^/]+$/);
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

test('flows: a brand-new phone with the server down opens with no account, and nothing tries to make one', async () => {
  await reset({ up: false });
  const s0 = await A.status();
  assert.equal(s0.state, 'none');
  assert.equal(s0.account, null);
  assert.equal(s0.checked, true);
  assert.equal(s0.reachable, false);
  // The background check is short.
  assert.deepEqual(server.calls.map((c) => [c.path, c.connectMs, c.readMs]), [['/v1/health', 4000, 4000]]);
  // Sign in with Google waits for the server: no browser opens, nothing is made.
  await assert.rejects(() => A.oauthSignIn({ provider: 'google' }), (e) => e.status === 0 && e.data?.unreachable === true && /Sign-in is available once Kea can reach the Kea account server/.test(e.message));
  assert.equal(phone.opened.length, 0, 'no Google sign-in was started');
  assert.equal(auth().length, 0);
  // No way to make one with just an email; opening one by email only finds one already here.
  assert.equal(A.openOffline, undefined);
  await assert.rejects(() => A.openHere({ email: 'sam@example.com' }), (e) => e.status === 404 && e.data?.noAccount === true);
  assert.equal(phone.accounts, '', 'nothing was written');
  assert.equal((await A.local()).state, 'none');
  assert.equal(A.login, undefined);
  assert.equal(A.create, undefined);
  // The sign-in screen has no "Use offline".
  const ui = fs.readFileSync(path.join(src, 'HubAccount.tsx'), 'utf8');
  assert.ok(!/Use offline|openOffline/.test(ui));
});

test('flows: an email-only account from an older Kea stays signed in with the server down; signed out, it opens again', async () => {
  await reset({ up: false });
  phone.accounts = legacyRecord('sam@example.com', 'Sam');
  const s = await A.status();
  assert.equal(s.state, 'offline', 'still signed in');
  assert.equal(s.account.id, 'loc_old');
  await A.signOut();
  assert.equal((await A.local()).state, 'none');
  const back = await A.openHere({ email: 'SAM@example.com' });
  assert.equal(back.state, 'offline');
  assert.equal(back.account.id, 'loc_old', 'the same account on this phone');
  assert.equal(auth().length, 0, 'no connection needed');
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
  // Stays signed in while the server is down; signed out with no connection, it opens again here (linked).
  server.up = false;
  const still = await A.status();
  assert.equal(still.state, 'online', 'still signed in with the server down');
  assert.equal(still.account.id, s.account.id);
  await A.signOut();
  const off = await A.openHere({ email: 'sam@example.com' });
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
  phone.accounts = legacyRecord('sam@example.com');
  await A.status();
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

test('flows: with no address under Advanced, the built-in one is used, and the account on the phone works', async () => {
  await reset({ url: '' });
  const s = await A.status();
  assert.equal(s.url, C.DEFAULT_ACCOUNT_URL);
  phone.accounts = legacyRecord('sam@example.com');
  assert.equal((await A.local()).state, 'offline');
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

// ---------- name and phone ----------
test('profile on the phone: the card is due once after the first sign-in; saving sends PATCH /v1/me; offline it waits and goes later', async () => {
  await reset();
  server.patches.length = 0;
  await assert.rejects(() => A.oauthSignIn({ provider: 'google' }), (e) => e.data?.needsAccount === true);
  const terms = await A.currentTerms();
  const s = await A.continueSignIn({ termsVersion: terms.version, termsSections: terms.sections.map((x) => x.id), age13: true });
  assert.equal(s.state, 'online');
  assert.equal(A.profileDue('sam@example.com'), true, 'the card shows after the first sign-in');
  // The defaults until changed: organizations yes, classmates no.
  const p0 = await A.profile();
  assert.deepEqual(p0.phoneShare, { orgs: true, classmates: false });
  assert.equal(p0.phone, null);
  // Saved online.
  const r = await A.saveProfile({ name: 'Sam Lee', phone: '+15551234567', phoneShare: { orgs: true, classmates: false } });
  assert.equal(r.queued, false);
  assert.equal(r.profile.name, 'Sam Lee');
  assert.equal(r.profile.phone, '+15551234567');
  assert.deepEqual(server.patches.at(-1), { name: 'Sam Lee', phone: '+15551234567', phoneShare: { orgs: true, classmates: false } });
  A.profileAsked();
  assert.equal(A.profileDue('sam@example.com'), false, 'shown once');
  // The server says what's wrong.
  await assert.rejects(() => A.saveProfile({ phone: '12' }), (e) => e.status === 400 && /isn’t valid/.test(e.message));
  // Offline: kept on the phone, shown, and sent once the server answers.
  server.up = false;
  const q = await A.saveProfile({ phoneShare: { classmates: true } });
  assert.equal(q.queued, true);
  assert.equal(q.profile.queued, true);
  assert.deepEqual(q.profile.phoneShare, { orgs: true, classmates: true });
  assert.equal(q.profile.phone, '+15551234567', 'what Kea last saw stays');
  const sent = server.patches.length;
  server.up = true;
  await A.status();
  assert.deepEqual(server.patches.slice(sent), [{ phoneShare: { classmates: true } }], 'the waiting change went');
  const after = await A.profile();
  assert.equal(after.queued, false);
  assert.deepEqual(after.phoneShare, { orgs: true, classmates: true });
  await A.signOut();
});
