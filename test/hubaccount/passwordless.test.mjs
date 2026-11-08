// Kea accounts without passwords (electron/hub.cjs), against a stand-in for the Kea account server: the first Google or
// Microsoft sign-in for an email answers 404 { needsAccount } and Kea sends the same ID token again with the terms to
// make the account; an existing account (one moved from the old Hub, with a password nobody types any more) is signed
// in to by the same email; the account on this computer links only by the same verified email; only the owner's
// account is asked for a two-step code (the same token goes again with it); signing out other devices sends a fresh
// Google sign-in, never a password.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-passwordless-'));
const electron = require('../worker/electronStub.cjs');
electron._paths.userData = userData;
electron._paths.appData = userData;
const settings = require('../../electron/settings.cjs');
const hub = require('../../electron/hub.cjs');
const A = hub._account;
A.setBackground(false);
A.setLimits({ req: 3000, status: 2000 });

// The stand-in server: accounts by email; a token is "used up" only when it signs in or makes the account.
const accounts = new Map();
const used = new Set();
const calls = [];
const TERMS = { version: 3, sections: [{ id: 'a', title: 'A', body: 'x' }] };
const acct = (a) => ({ id: a.id, email: a.email, displayName: a.name, emailVerified: a.ev, verifiedBy: a.ev ? 'Google' : null, owner: !!a.owner, totpEnabled: !!a.owner });
const emailOf = (tok) => JSON.parse(Buffer.from(String(tok).split('.')[1], 'base64url').toString('utf8')).email;
let session = null;
const server = http.createServer((rq, rs) => {
  let body = '';
  rq.on('data', (c) => (body += c));
  rq.on('end', () => {
    const b = body ? JSON.parse(body) : {};
    const p = new URL(rq.url, 'http://x').pathname;
    calls.push({ path: p, body: b });
    let out = [404, { error: 'Not found.' }];
    const signIn = (a) => ((session = `s-${a.id}`), [200, { token: session, me: acct(a), account: acct(a), terms: { needsAgreement: false } }]);
    if (p === '/v1/health') out = [200, { ok: true, service: 'keac', features: ['google', 'microsoft', 'oauthCreate', 'passwordRetired'] }];
    else if (p === '/v1/terms') out = [200, { terms: TERMS, versions: [] }];
    else if (p === '/v1/auth/oauth' || p === '/v1/auth/google') {
      const email = emailOf(b.idToken);
      const a = accounts.get(email);
      if (used.has(b.idToken)) out = [401, { error: 'That Google sign-in was already used. Try again.' }];
      else if (!a && b.termsVersion == null) out = [404, { error: `There’s no Kea account for ${email} yet. Agree to the terms to make it.`, needsAccount: true, email, name: 'From Google' }];
      else if (!a) {
        if (b.termsVersion !== TERMS.version || b.age13 !== true || !(b.termsSections || []).includes('a')) out = [400, { error: 'Agree to every section of the terms.' }];
        else {
          used.add(b.idToken);
          const n = { id: `k-${accounts.size + 1}`, email, name: 'From Google', ev: true };
          accounts.set(email, n);
          out = signIn(n);
          out[0] = 201;
        }
      } else if (a.owner && b.code !== '123456') out = [401, { error: 'Enter the code from your authenticator app.', totpRequired: true, backupCodes: true }];
      else {
        used.add(b.idToken);
        a.ev = true;
        out = signIn(a);
      }
    } else if (p === '/v1/auth/login' || p === '/v1/auth/register') out = [410, { error: 'Kea accounts now sign in with Google or Microsoft only.', passwordRetired: true }];
    else if (p === '/v1/me') {
      const a = [...accounts.values()].find((x) => rq.headers.authorization === `Bearer s-${x.id}`);
      out = a ? [200, { account: acct(a), terms: { needsAgreement: false }, storage: { used: 0, quota: 1 }, notifications: { latest: 0 } }] : [401, { error: 'Sign in again.' }];
    } else if (p === '/v1/me/sessions/sign-out-others') out = b.idToken && b.provider ? [200, { signedOut: 2 }] : [401, { error: 'Continue with Google or Microsoft to confirm it’s you.', signInRequired: true }];
    else if (p === '/v1/me/delete') out = b.idToken && b.provider && b.confirm === 'DELETE' && !('password' in b) ? [200, { ok: true, deleted: true }] : [401, { error: 'Continue with Google or Microsoft to confirm it’s you.' }];
    else if (p === '/v1/auth/logout') out = [200, { ok: true }];
    rs.writeHead(out[0], { 'content-type': 'application/json' });
    rs.end(JSON.stringify(out[1]));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
settings.set({ 'hub.url': `http://127.0.0.1:${server.address().port}` });
after(() => {
  server.close();
  fs.rmSync(userData, { recursive: true, force: true });
});
let n = 0;
const idToken = (email) => `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ email, n: ++n })).toString('base64url')}.sig`;
const fresh = () => {
  for (const f of fs.readdirSync(userData)) if (f !== 'settings.json') fs.rmSync(path.join(userData, f), { recursive: true, force: true });
  A.reset();
  calls.length = 0;
  accounts.clear();
};
const signInPaths = () => calls.filter((c) => c.path.startsWith('/v1/auth/')).map((c) => c.path);

test('the first Google sign-in for an email asks for the terms, then the same sign-in makes the account', async () => {
  fresh();
  A.setIdTokens(async () => idToken('new@x.org'));
  await assert.rejects(A.oauthSignIn({ provider: 'google' }), (e) => e.status === 404 && e.data?.needsAccount === true && e.data.email === 'new@x.org');
  assert.deepEqual(A.local().pending, { email: 'new@x.org', name: 'From Google', provider: 'google' }, 'the page can show the terms step');
  assert.equal(A.local().state, 'none');
  // Too young: said here, nothing sent.
  await assert.rejects(A.continueSignIn({ termsVersion: 3, termsSections: ['a'], age13: false }), /13 and older/);
  const before = calls.length;
  const s = await A.continueSignIn({ termsVersion: 3, termsSections: ['a'], age13: true });
  assert.equal(s.state, 'online');
  assert.equal(s.account.email, 'new@x.org');
  const sent = calls.slice(before).find((c) => c.path === '/v1/auth/google');
  assert.equal(emailOf(sent.body.idToken), 'new@x.org');
  assert.equal(sent.body.idToken, calls.find((c) => c.path === '/v1/auth/google').body.idToken, 'the same ID token, sent again with the terms');
  assert.equal(A.local().pending, null);
  assert.ok(!signInPaths().includes('/v1/auth/login') && !signInPaths().includes('/v1/auth/register'), 'no password routes');
  // Nothing waiting: continuing says so.
  await assert.rejects(A.continueSignIn({ termsVersion: 3, termsSections: ['a'], age13: true }), (e) => e.data?.expired === true);
});

test('an offline account with the same email links on its first online sign-in; nothing here is lost', async () => {
  fresh();
  const off = A.openOffline({ email: 'ola@x.org', name: 'Ola' });
  fs.writeFileSync(path.join(userData, 'ola.txt'), 'kept');
  A.setIdTokens(async () => idToken('ola@x.org'));
  await assert.rejects(A.link({ provider: 'google' }), (e) => e.data?.needsAccount === true);
  const s = await A.continueSignIn({ termsVersion: 3, termsSections: ['a'], age13: true });
  assert.equal(s.state, 'online');
  assert.equal(s.account.id, off.account.id, 'the same account here, now linked');
  assert.equal(s.account.linked, true);
  assert.equal(fs.readFileSync(path.join(userData, 'ola.txt'), 'utf8'), 'kept');
});

test('a different verified email never links: nothing is sent and the offline account stays as it was', async () => {
  fresh();
  const off = A.openOffline({ email: 'ola@x.org' });
  A.setIdTokens(async () => idToken('someone@else.org'));
  await assert.rejects(A.link({ provider: 'google' }), (e) => e.status === 409 && e.data?.mismatch === true && e.data.reason === 'differentEmail');
  assert.deepEqual(signInPaths(), [], 'the sign-in never went to the server');
  const s = A.local();
  assert.equal(s.state, 'offline');
  assert.equal(s.account.id, off.account.id);
  assert.equal(s.pending, null);
});

test('an account moved from the old Hub (a password, email not verified yet) signs in with Google on the same email', async () => {
  fresh();
  accounts.set('moved@x.org', { id: 'k-moved', email: 'moved@x.org', name: 'Moved', ev: false });
  A.setIdTokens(async () => idToken('moved@x.org'));
  const s = await A.oauthSignIn({ provider: 'google' });
  assert.equal(s.state, 'online');
  assert.equal(s.me.account.id, 'k-moved', 'the existing account, not a new one');
  assert.equal(s.me.account.emailVerified, true, 'the sign-in verified its email');
  assert.equal(hub.current().hub.id, 'k-moved');
  // Signed out, then the same email offline: this computer's things for it open again.
  A.logout();
  const again = A.openOffline({ email: 'moved@x.org' });
  assert.equal(again.state, 'linked');
  assert.equal(again.account.id, s.account.id);
});

test('only the owner’s account asks for its two-step code; the same sign-in goes again with it', async () => {
  fresh();
  accounts.set('owner@x.org', { id: 'k-owner', email: 'owner@x.org', name: 'Owner', ev: true, owner: true });
  A.setIdTokens(async () => idToken('owner@x.org'));
  await assert.rejects(A.oauthSignIn({ provider: 'google' }), (e) => e.data?.totpRequired === true);
  await assert.rejects(A.continueSignIn({ code: '000000' }), (e) => e.data?.totpRequired === true);
  const s = await A.continueSignIn({ code: '123456' });
  assert.equal(s.state, 'online');
  const tokens = calls.filter((c) => c.path === '/v1/auth/google').map((c) => c.body.idToken);
  assert.equal(new Set(tokens).size, 1, 'one Google sign-in for all three tries');
});

test('signing out other devices sends a fresh Google sign-in, never a password', async () => {
  fresh();
  accounts.set('del@x.org', { id: 'k-del', email: 'del@x.org', name: 'Del', ev: true });
  A.setIdTokens(async () => idToken('del@x.org'));
  await A.oauthSignIn({ provider: 'google' });
  const r = await A.signOutOthers({ provider: 'google' });
  assert.equal(r.signedOut, 2);
  const c = calls.find((x) => x.path === '/v1/me/sessions/sign-out-others');
  assert.equal(c.body.provider, 'google');
  assert.equal(emailOf(c.body.idToken), 'del@x.org');
  assert.ok(!('password' in c.body));
});

test('an older Kea account server that still wants a password is never sent one', async () => {
  fresh();
  A.openOffline({ email: 'ola@x.org' });
  for (const k of ['login', 'create']) assert.equal(A[k], undefined, `no ${k} with a password`);
  const src = fs.readFileSync(require.resolve('../../electron/hub.cjs'), 'utf8');
  assert.ok(!/\/v1\/auth\/login|\/v1\/auth\/register|\/v1\/me\/password|totp\/setup/.test(src), 'no password or two-step routes in Kea');
});
