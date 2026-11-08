// Taking the account on this computer online (electron/hub.cjs link, with the password and the terms) when the Kea
// account server already has an online account for that email (made on another device). The Kea account server
// answers the new account with 409 { exists: true }; Kea then signs in to that account with this password and links,
// or, when its password is another one, says so and offers Continue with Google again. Other refusals stay as they are.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-link-existing-'));
const electron = require('../worker/electronStub.cjs');
electron._paths.userData = userData;
electron._paths.appData = userData;
const settings = require('../../electron/settings.cjs');
const hub = require('../../electron/hub.cjs');
const A = hub._account;
A.setBackground(false);
A.setLimits({ req: 3000, status: 2000 });

const PW = 'lantern velvet orbit';
const account = (email) => ({ id: `k-${email}`, email, displayName: 'Ola', emailVerified: true });
const calls = [];
let onlinePassword = PW;
let registerAnswer = (email) => [409, { error: `${email} already has a Kea account. Sign in instead (with your password, or with Google).`, exists: true, email }];
const server = http.createServer((rq, rs) => {
  let body = '';
  rq.on('data', (c) => (body += c));
  rq.on('end', () => {
    const b = body ? JSON.parse(body) : {};
    const p = new URL(rq.url, 'http://x').pathname;
    calls.push(`${rq.method} ${p}`);
    let out = [404, { error: 'Not found.' }];
    if (p === '/v1/health') out = [200, { ok: true, service: 'keac', features: ['google'] }];
    else if (p === '/v1/auth/register') out = registerAnswer(b.email);
    else if (p === '/v1/auth/login') out = b.password === onlinePassword ? [200, { token: 'online-token', me: { account: account(b.email) }, account: account(b.email) }] : [401, { error: 'Wrong email or password.' }];
    else if (p === '/v1/me') out = rq.headers.authorization === 'Bearer online-token' ? [200, { account: account('ola@x.org'), terms: { needsAgreement: false } }] : [401, { error: 'Sign in again.' }];
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
const idToken = (email) => `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.sig`;
const agree = { termsVersion: 2, termsSections: ['a'], age13: true };
const fresh = async () => {
  for (const f of fs.readdirSync(userData)) if (f !== 'settings.json') fs.rmSync(path.join(userData, f), { recursive: true, force: true });
  A.reset();
  calls.length = 0;
  await A.create({ email: 'ola@x.org', password: PW, name: 'Ola' });
  A.setIdTokens(async () => idToken('ola@x.org'));
};

test('the email already has an online account with this password: signed in to it and linked', async () => {
  await fresh();
  onlinePassword = PW;
  const s = await A.link({ provider: 'google', password: PW, ...agree });
  assert.equal(s.state, 'online');
  assert.equal(s.account.linked, true);
  assert.equal(hub.current().hub.id, 'k-ola@x.org');
  assert.deepEqual(calls.filter((c) => c.startsWith('POST')), ['POST /v1/auth/register', 'POST /v1/auth/login']);
});

test('…with another password: said plainly, offering Google again; nothing here changes', async () => {
  await fresh();
  onlinePassword = 'a different long password';
  await assert.rejects(A.link({ provider: 'google', password: PW, ...agree }), (e) => e.status === 409 && e.data?.existsOnline === true && /different password/.test(e.message));
  assert.equal(A.local().state, 'offline');
  assert.equal(A.local().account.linked, false);
});

test('other refusals of the new account are shown as they are (no sign-in tried)', async () => {
  await fresh();
  registerAnswer = () => [409, { error: 'The terms changed. Read the latest version and agree to it.', termsVersion: 3 }];
  await assert.rejects(A.link({ provider: 'google', password: PW, ...agree }), (e) => e.status === 409 && e.data?.termsVersion === 3);
  assert.ok(!calls.includes('POST /v1/auth/login'));
  assert.equal(A.local().state, 'offline');
});
