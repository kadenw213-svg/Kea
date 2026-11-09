// The one-click Kea account and what comes right after it: the one-step terms for a new account, the name-and-phone
// card (phone format, who sees it by default, saving with PATCH /v1/me, a 400 shown as it is, the change waiting on
// this computer while the server can't be reached), the built-in sign-in clients (settings, then the environment, then
// electron/buildConfig.json written at build time, with a plain warning without the owner's file), and Google Drive
// on the same built-in client with nothing to set up. No real Google, Microsoft or server is reached.
//   node --test test/profile/profile.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const dirs = [];
const scratch = (n) => (dirs.push(fs.mkdtempSync(path.join(os.tmpdir(), `kea-profile-${n}-`))), dirs.at(-1));

let P;
before(async () => {
  const out = path.join(os.tmpdir(), `kea-profile-lib-${process.pid}.cjs`);
  await require('esbuild').build({ entryPoints: [path.join(root, 'src/lib/profile.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
  P = require(out);
  fs.rmSync(out, { force: true });
});
const servers = [];
after(() => {
  for (const s of servers) s.close();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

// ---------- the phone number ----------
test('phone numbers: common US ways of writing one become +15551234567; others say plainly what to type', () => {
  for (const v of ['(555) 123-4567', '555-123-4567', '555.123.4567', '555 123 4567', '5551234567', '1-555-123-4567', '1 (555) 123-4567', '+1 555 123 4567', '+15551234567', '  555-123-4567  '])
    assert.deepEqual(P.normalizePhone(v), { ok: true, phone: '+15551234567' }, v);
  assert.deepEqual(P.normalizePhone('+44 20 7946 0958'), { ok: true, phone: '+442079460958' });
  assert.deepEqual(P.normalizePhone(''), { ok: true, phone: null }, 'empty: no number');
  assert.deepEqual(P.normalizePhone(null), { ok: true, phone: null });
  for (const bad of ['123', '555-1234', '055 123 4567', '+1 055 123 4567', '+1 555 123 456', 'call me', '555-123-4567 ext 9', '+0 123 456 789', '12345678901234567'])
    assert.equal(P.normalizePhone(bad).ok, false, bad);
  assert.match(P.normalizePhone('abc').error, /doesn’t look like a phone number/);
  assert.equal(P.showPhone('+15551234567'), '(555) 123-4567');
  assert.equal(P.showPhone('+442079460958'), '+442079460958');
});

// ---------- who sees it, and reading the account ----------
test('who sees the number by default: organizations I join yes, classmates no', () => {
  assert.deepEqual({ ...P.SHARE_DEFAULTS }, { orgs: true, classmates: false });
  assert.deepEqual(P.profileOf({ account: { displayName: 'Ana' } }), { name: 'Ana', phone: null, phoneShare: { orgs: true, classmates: false } });
  assert.deepEqual(P.profileOf(null, 'From Google'), { name: 'From Google', phone: null, phoneShare: { orgs: true, classmates: false } });
  // The Kea account server's /v1/me.
  assert.deepEqual(P.profileOf({ account: { displayName: 'old' }, name: 'Ana Lee', phone: '+15551234567', phoneShare: { orgs: false, classmates: true } }), { name: 'Ana Lee', phone: '+15551234567', phoneShare: { orgs: false, classmates: true } });
  // An older server: account.phone { number, visibility }.
  assert.deepEqual(P.profileOf({ account: { displayName: 'Ana', phone: { number: '+15551234567', visibility: 'both' } } }).phoneShare, { orgs: true, classmates: true });
  assert.deepEqual(P.shareOf({ classmates: true }), { orgs: true, classmates: true });
  // The desktop's own reading of it (electron/hub.cjs) agrees.
  require('../worker/electronStub.cjs');
  const H = require('../../electron/hub.cjs')._account;
  for (const me of [{ account: { displayName: 'Ana' } }, { account: {}, name: 'B', phone: null, phoneShare: { orgs: false, classmates: false } }, { account: { phone: { number: '+15551234567', visibility: 'classes' } } }])
    assert.deepEqual(H.profileOf(me), P.profileOf(me));
});

test('the profile form: the name is needed, the phone checked; only what changed is sent (all of it on the first card)', () => {
  const was = { name: 'Ana', phone: '+15551234567', phoneShare: { orgs: true, classmates: false } };
  assert.deepEqual(P.profileSave({ name: '  ', phone: '', phoneShare: was.phoneShare }, was), { ok: false, field: 'name', error: 'Add your name.' });
  const bad = P.profileSave({ name: 'Ana', phone: '12', phoneShare: was.phoneShare }, was);
  assert.equal(bad.ok, false);
  assert.equal(bad.field, 'phone');
  assert.deepEqual(P.profileSave({ name: 'Ana', phone: '(555) 123-4567', phoneShare: was.phoneShare }, was), { ok: true, patch: {} }, 'nothing changed');
  assert.deepEqual(P.profileSave({ name: ' Ana  Lee ', phone: '', phoneShare: { orgs: true, classmates: true } }, was), { ok: true, patch: { name: 'Ana Lee', phone: null, phoneShare: { classmates: true } } });
  assert.deepEqual(P.profileSave({ name: 'Ana', phone: '555 987 6543', phoneShare: { ...P.SHARE_DEFAULTS } }, null), { ok: true, patch: { name: 'Ana', phone: '+15559876543', phoneShare: { orgs: true, classmates: false } } });
  // The offline note says plainly that it saves once online.
  assert.equal(P.savedText(false), 'Saved.');
  assert.match(P.savedText(true), /once you’re online/);
});

// ---------- the one-step terms ----------
test('a new account is one step: "Agree and continue" agrees to every section and confirms 13 or older', () => {
  const terms = { version: 9, sections: [{ id: 'use' }, { id: 'privacy' }, { id: 'age' }, { id: 'ai' }] };
  assert.deepEqual(P.oneStepAgreement(terms), { age13: true, termsVersion: 9, termsSections: ['use', 'privacy', 'age', 'ai'] });
  for (const f of ['src/components/scholar/HubAccount.tsx', 'mobile/src/HubAccount.tsx']) {
    const src = read(f);
    const at = src.indexOf('function NewOnlineAccount');
    const step = src.slice(at, src.indexOf('/** The owner account', at));
    assert.ok(step.includes('Agree and continue'), `${f}: one button`);
    assert.ok(step.includes('oneStepAgreement('), `${f}: every section and the age`);
    assert.ok(/13 or older/.test(step), `${f}: the age is said`);
    assert.ok(/Kea terms/.test(step), `${f}: a link to read the terms`);
    assert.ok(!/type="checkbox"|TermsAgreement|I agree to this section/.test(step), `${f}: no boxes to tick, no long form`);
    assert.ok(!/\bKeaC\b|[Cc]oming soon/.test(src.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '')), `${f}: no "KeaC" or "coming soon" shown`);
  }
  // The owner's two-step code stays.
  assert.ok(read('src/components/scholar/HubAccount.tsx').includes('function OwnerCode'));
});

// ---------- electron/hub.cjs: saving the name and phone ----------
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
    s.listen(0, '127.0.0.1', () => (servers.push(s), r({ url: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((d) => s.close(d)) })));
  });
}

test('the name-and-phone card after the first sign-in: saved with PATCH /v1/me, a 400 as it is, offline it waits and goes later', async () => {
  const electron = require('../worker/electronStub.cjs');
  const userData = scratch('userdata');
  electron._paths.userData = userData;
  electron._paths.appData = userData;
  const hub = require('../../electron/hub.cjs');
  const A = hub._account;
  A.setBackground(false);
  A.reset();
  A.setLimits({ req: 3000, status: 1500 });
  const idToken = (email) => `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ email, name: 'Ana From Google' })).toString('base64url')}.sig`;
  A.setIdTokens(async () => idToken('ana@x.org'));
  const acct = { id: 'h-ana', email: 'ana@x.org', displayName: 'Ana From Google', emailVerified: true };
  const prof = { name: 'Ana From Google', phone: null, phoneShare: { orgs: true, classmates: false } };
  let made = false;
  const patches = [];
  const me = () => ({ account: { ...acct, displayName: prof.name }, ...prof, terms: { needsAgreement: false, current: 3 }, progress: null, storage: { used: 0, quota: 1 } });
  const srv = await serve((m, p, b, rq) => {
    if (p === '/v1/health') return [200, { ok: true, service: 'keac' }];
    if (p === '/v1/terms') return [200, { terms: { version: 3, sections: [{ id: 'a' }, { id: 'b' }] } }];
    if (p === '/v1/auth/google' || p === '/v1/auth/oauth') {
      if (!made && b.termsVersion == null) return [404, { error: 'No account yet.', needsAccount: true, email: 'ana@x.org', name: 'Ana From Google' }];
      if (!made && (b.age13 !== true || b.termsVersion !== 3 || String(b.termsSections) !== 'a,b')) return [400, { error: 'Agree to the terms.' }];
      made = true;
      return [200, { token: 'tok', me: me() }];
    }
    if (p === '/v1/me' && rq.headers.authorization !== 'Bearer tok') return [401, { error: 'Sign in again.' }];
    if (p === '/v1/me' && m === 'GET') return [200, me()];
    if (p === '/v1/me' && m === 'PATCH') {
      if ('phone' in b && b.phone !== null && !/^\+[1-9]\d{7,14}$/.test(b.phone)) return [400, { error: 'That phone number isn’t valid.' }];
      patches.push(b);
      if (b.name) prof.name = b.name;
      if ('phone' in b) prof.phone = b.phone;
      if (b.phoneShare) prof.phoneShare = { ...prof.phoneShare, ...b.phoneShare };
      return [200, me()];
    }
    return null;
  });
  process.env.KEA_HUB_URL = srv.url;
  // One click: Google, then the one step for a new account (every section and the age at once).
  await assert.rejects(A.oauthSignIn({ provider: 'google' }), (e) => e.data?.needsAccount === true);
  let s = await A.continueSignIn({ age13: true, termsVersion: 3, termsSections: ['a', 'b'] });
  assert.equal(s.state, 'online');
  assert.equal(s.askProfile, true, 'the card is due right after the first sign-in');
  assert.deepEqual({ ...s.profile }, { name: 'Ana From Google', phone: null, phoneShare: { orgs: true, classmates: false }, queued: false }, 'prefilled from Google, the defaults');
  // Saved.
  s = await A.saveProfile({ name: 'Ana Lee', phone: '+15551234567', phoneShare: { orgs: true, classmates: false } });
  assert.deepEqual(patches.at(-1), { name: 'Ana Lee', phone: '+15551234567', phoneShare: { orgs: true, classmates: false } });
  assert.equal(s.profile.name, 'Ana Lee');
  assert.equal(s.profile.phone, '+15551234567');
  assert.equal(s.account.name, 'Ana Lee', 'the name shows on this computer too');
  assert.equal(A.profileAsked().askProfile, false, 'shown once');
  assert.equal(A.local().askProfile, false);
  // The server's 400 comes back as it is.
  await assert.rejects(A.saveProfile({ phone: '12' }), (e) => e.status === 400 && /isn’t valid/.test(e.message));
  await assert.rejects(A.saveProfile({ name: '   ' }), (e) => e.status === 400 && e.data?.field === 'name');
  // Offline: kept here and shown; it goes at the next check that reaches the server.
  process.env.KEA_HUB_URL = 'http://127.0.0.1:1';
  A.setLimits({ req: 800, status: 500 });
  s = await A.saveProfile({ phoneShare: { classmates: true } });
  assert.equal(s.profileQueued, true);
  assert.equal(s.profile.queued, true);
  assert.deepEqual(s.profile.phoneShare, { orgs: true, classmates: true });
  assert.equal(s.profile.phone, '+15551234567', 'what Kea last saw stays');
  s = await A.saveProfile({ phone: null });
  assert.equal(s.profile.phone, null);
  assert.equal(s.state, 'online', 'still signed in while the server is away');
  const queue = JSON.parse(fs.readFileSync(path.join(userData, 'hub-profile-queue.json'), 'utf8'));
  assert.deepEqual(queue['h-ana'].patch, { phoneShare: { classmates: true }, phone: null }, 'both changes wait, together');
  const sent = patches.length;
  process.env.KEA_HUB_URL = srv.url;
  A.setLimits({ req: 3000, status: 1500 });
  s = await A.status();
  assert.deepEqual(patches.slice(sent), [{ phoneShare: { classmates: true }, phone: null }], 'the waiting change went once the server answered');
  assert.equal(s.profile.queued, false);
  assert.equal(s.profile.phone, null);
  assert.deepEqual(s.profile.phoneShare, { orgs: true, classmates: true });
  assert.equal(fs.existsSync(path.join(userData, 'hub-profile-queue.json')), false);
  // Not signed in: nothing is sent.
  A.logout();
  await assert.rejects(A.saveProfile({ name: 'X' }), (e) => e.status === 401);
});

// ---------- the built-in sign-in clients ----------
test('built-in clients: settings first, then the environment, then electron/buildConfig.json', () => {
  const { resolveClients, readBuildConfig } = require('../../electron/oauthClients.cjs');
  const build = { google: { desktopClientId: 'build-g.apps.googleusercontent.com', desktopClientSecret: 'build-secret' }, microsoft: { clientId: 'build-ms' } };
  const none = () => '';
  let c = resolveClients({ get: none, env: {}, build });
  assert.deepEqual(c, { google: { id: 'build-g.apps.googleusercontent.com', secret: 'build-secret', from: 'build' }, microsoft: { id: 'build-ms', from: 'build' } });
  c = resolveClients({ get: none, env: { KEA_GOOGLE_CLIENT_ID: 'env-g', KEA_GOOGLE_CLIENT_SECRET: 'env-s', KEA_MICROSOFT_CLIENT_ID: 'env-ms' }, build });
  assert.deepEqual(c, { google: { id: 'env-g', secret: 'env-s', from: 'env' }, microsoft: { id: 'env-ms', from: 'env' } });
  const set = { 'hub.googleClientId': 'set-g', 'hub.googleClientSecret': 'set-s', 'hub.microsoftClientId': 'set-ms' };
  c = resolveClients({ get: (k) => set[k], env: { KEA_GOOGLE_CLIENT_ID: 'env-g', KEA_MICROSOFT_CLIENT_ID: 'env-ms' }, build });
  assert.deepEqual(c, { google: { id: 'set-g', secret: 'set-s', from: 'settings' }, microsoft: { id: 'set-ms', from: 'settings' } });
  // (A secret never goes with another place's client id.)
  c = resolveClients({ get: none, env: { KEA_GOOGLE_CLIENT_ID: 'env-g' }, build });
  assert.equal(c.google.secret, '');
  assert.deepEqual(resolveClients({ get: none, env: {}, build: {} }), { google: { id: '', secret: '', from: null }, microsoft: { id: '', from: null } });
  assert.deepEqual(readBuildConfig(path.join(scratch('nofile'), 'buildConfig.json')), {}, 'no file: nothing built in');
  // The generated file stays out of the repo.
  assert.ok(read('.gitignore').split(/\r?\n/).includes('electron/buildConfig.json'));
});

test('the build: buildConfig.json from the owner file outside the repo; without it, a clear warning and the build goes on', () => {
  const { writeBuildConfig, readOwnerFile, mobileEnv } = require('../../scripts/oauth-clients.cjs');
  const d = scratch('build');
  const out = path.join(d, 'buildConfig.json');
  const logs = [];
  const log = { warn: (m) => logs.push(['warn', m]), log: (m) => logs.push(['log', m]) };
  // Missing: {} is written, the warning says sign-in won't be available.
  let r = writeBuildConfig({ file: path.join(d, 'missing.json'), out, log });
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), {});
  assert.equal(logs.length, 1);
  assert.equal(logs[0][0], 'warn');
  assert.match(logs[0][1], /Sign in with Google.*won’t be available|won't be available/);
  assert.deepEqual(r.env, {});
  // Present: the desktop clients go in buildConfig.json, the Android one only to the phone's build.
  const owner = path.join(d, 'oauth-clients.json');
  fs.writeFileSync(owner, JSON.stringify({ google: { desktopClientId: 'd.apps.googleusercontent.com', desktopClientSecret: 'GOCSPX-test', androidClientId: 'a.apps.googleusercontent.com' }, microsoft: { clientId: 'ms-id' } }));
  logs.length = 0;
  r = writeBuildConfig({ file: owner, out, log });
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), { google: { desktopClientId: 'd.apps.googleusercontent.com', desktopClientSecret: 'GOCSPX-test' }, microsoft: { clientId: 'ms-id' } });
  assert.deepEqual(r.env, { VITE_KEA_GOOGLE_CLIENT_ID: 'a.apps.googleusercontent.com', VITE_KEA_MICROSOFT_CLIENT_ID: 'ms-id' });
  assert.ok(!logs.some(([, m]) => m.includes('GOCSPX')), 'nothing secret is printed');
  assert.equal(logs[0][0], 'log');
  // Not JSON: a warning too.
  fs.writeFileSync(owner, '{oops');
  assert.match(readOwnerFile(owner).warning, /isn't valid JSON/);
  assert.deepEqual(mobileEnv({}), {});
  // The release, dist and phone builds run it.
  assert.match(read('scripts/release.cjs'), /oauth-clients\.cjs/);
  const pkg = JSON.parse(read('package.json'));
  for (const k of ['build', 'dist', 'dist:mac', 'start']) assert.match(pkg.scripts[k], /oauth-clients\.cjs/, k);
  assert.match(read('scripts/mobile-apk.cjs'), /oauth-clients\.cjs/);
  assert.match(read('mobile/vite.config.mjs'), /oauth-clients\.cjs/);
});

// ---------- Google Drive on the built-in client ----------
test('Google Drive uses the built-in Kea client: one consent added to the Kea sign-in, the same Google account first', () => {
  require('../worker/electronStub.cjs');
  const g = require('../../electron/google.cjs')._drive;
  const was = { ...process.env };
  try {
    delete process.env.KEA_GOOGLE_CLIENT_ID;
    // (No settings and no build file in the repo: nothing built in, said plainly.)
    if (!fs.existsSync(path.join(root, 'electron/buildConfig.json'))) {
      assert.throws(() => g.client(), (e) => e.code === 'NO_CLIENT' && /isn’t available in this copy of Kea/.test(e.message));
      assert.equal(g.status().configured, false);
    }
    process.env.KEA_GOOGLE_CLIENT_ID = 'kea-built-in.apps.googleusercontent.com';
    process.env.KEA_GOOGLE_CLIENT_SECRET = 'kea-secret';
    assert.deepEqual(g.client(), { id: 'kea-built-in.apps.googleusercontent.com', secret: 'kea-secret' }, 'the same client as Sign in with Google');
    assert.equal(g.status().configured, true);
    const u = new URL(g.driveAuthorizeUrl({ clientId: g.client().id, port: 5555, challenge: 'ch', state: 'st', loginHint: 'ana@gmail.com' }));
    const q = Object.fromEntries(u.searchParams);
    assert.equal(u.origin, 'https://accounts.google.com');
    assert.equal(q.client_id, 'kea-built-in.apps.googleusercontent.com');
    assert.equal(q.scope, 'https://www.googleapis.com/auth/drive', 'the Drive scope the feature needs');
    assert.equal(q.include_granted_scopes, 'true', 'incremental consent');
    assert.equal(q.login_hint, 'ana@gmail.com', 'the Google account signed in to Kea');
    assert.equal(q.redirect_uri, 'http://127.0.0.1:5555');
    assert.equal(q.code_challenge_method, 'S256');
    assert.equal(q.access_type, 'offline');
    assert.equal(new URL(g.driveAuthorizeUrl({ clientId: 'x', port: 1, challenge: 'c', state: 's' })).searchParams.get('login_hint'), null);
    // A saved connection renews with the client it was made with; one from another client is asked again.
    assert.equal(g.clientFor({ clientId: 'kea-built-in.apps.googleusercontent.com' }).id, 'kea-built-in.apps.googleusercontent.com');
    assert.throws(() => g.clientFor({ clientId: 'someone-elses-client' }), (e) => e.code === 'NO_ACCOUNT');
    // Google saying no is told plainly, with the browser offered.
    assert.equal(g.refusedError('access_denied'), true);
    assert.equal(g.refusedError('unauthorized_client'), true);
    assert.match(g.REFUSED, /open the file in your browser instead/);
  } finally {
    for (const k of ['KEA_GOOGLE_CLIENT_ID', 'KEA_GOOGLE_CLIENT_SECRET']) (k in was ? (process.env[k] = was[k]) : delete process.env[k]);
  }
});

test('Settings → Google account is one card: no client-id or secret boxes, no setup steps', () => {
  const panel = read('src/components/settings/GooglePanel.tsx');
  assert.ok(!/clientId|clientSecret|Client ID|Client secret|Google Cloud|console\.cloud\.google|5 minutes|five minutes|<input/i.test(panel), 'nothing to set up');
  for (const t of ['Connected', 'Connect Google Drive', 'Disconnect']) assert.ok(panel.includes(t), t);
  assert.ok(!/google\.clientId|google\.clientSecret/.test(read('src/lib/settings.ts')), 'no client fields under Advanced either');
  const lib = read('src/lib/google.ts');
  assert.ok(lib.includes('Open in browser instead'), 'when Google says no, the browser');
  assert.ok(!/Set it up|five minutes/.test(lib));
  assert.ok(!/settings\.get\('google\.clientId'[^)]*\)\s*\|\|\s*''\)\.trim\(\);\s*\n\s*const secret/.test(read('electron/google.cjs')), 'the person’s own client is no longer the one used');
  assert.ok(read('electron/google.cjs').includes("require('./oauthClients.cjs')"));
  assert.ok(read('electron/hub.cjs').includes("require('./oauthClients.cjs')"));
});
