// The Kea account. It lives on this computer first (accountCore.cjs: made and signed in offline, with a scrypt verifier
// of the password, never the password), and online on the Kea account server (today the Kea Hub; later KeaC), which
// adds Kea Cloud, hosted classes and organizations, shared Claude and Work. Kea talks to the server here, in the main
// process. The online sign-in (a session token) is encrypted with the OS keychain and never shown to the page. The
// password is sent once, over HTTPS, and never stored here.
//
// Nothing here waits on the network to decide who's signed in: the start screen reads this computer's files at once
// (local()), and the server is checked in the background with time limits (status()). Not reaching it is normal.
//
// Settings: hub.url (where the server is, under Advanced), hub.googleClientId / hub.googleClientSecret and
// hub.microsoftClientId (KEA_GOOGLE_CLIENT_ID, KEA_MICROSOFT_CLIENT_ID): the clients for "Continue with Google" and
// "Continue with Microsoft" (openid, email and profile only).
const { app, ipcMain, shell, net, safeStorage, BrowserWindow } = require('electron');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const settings = require('./settings.cjs');
const { appOnly, handleApp } = require('./ipcGuard.cjs');
const core = require('./accountCore.cjs');

// Where Kea finds the Kea account server unless the person sets another address (Settings → Kea account → Advanced).
// This is the one place to change it: the server's public https:// address goes here for releases, so every device
// reaches it. 127.0.0.1 only works on the server's own PC.
const DEFAULT_HUB_URL = 'http://127.0.0.1:4860';
// How long Kea waits for the server: any request, and the background "is it there" checks.
const LIMITS = { req: 8000, status: 4000 };
const OFFLINE_MSG = 'Can’t reach your Kea account online right now. Everything on this computer still works; Kea tries again by itself.';
const hubUrl = () => String(settings.get('hub.url', '') || process.env.KEA_HUB_URL || DEFAULT_HUB_URL).replace(/\/+$/, '');
const originOf = (u) => {
  try {
    return new URL(u).origin;
  } catch {
    return String(u);
  }
};
const tokenFile = () => path.join(app.getPath('userData'), 'hub-session.bin');
// What the rest of Kea needs to know without asking the Hub (school mode's verified check, the badge): no secrets.
const cacheFile = () => path.join(app.getPath('userData'), 'hub-account.json');

function readToken() {
  try {
    const raw = fs.readFileSync(tokenFile());
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8');
  } catch {
    return null;
  }
}
function writeToken(t) {
  if (!t) return fs.rmSync(tokenFile(), { force: true });
  fs.writeFileSync(tokenFile(), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(t) : Buffer.from(t));
}
function cached() {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
  } catch {
    return null;
  }
}
// What this computer keeps about the signed-in account's work (shifts and org classes for the calendar): never shown
// to the next person who signs in here.
const accountFiles = () => [path.join(app.getPath('userData'), 'work-calendar.json')];
function saveCache(me) {
  if (!me) {
    for (const f of [cacheFile(), ...accountFiles()]) fs.rmSync(f, { force: true });
    return;
  }
  const a = me.account;
  // (Another account's copies stay: each is kept for the account it was made for, and nobody else is shown it.)
  fs.writeFileSync(cacheFile(), JSON.stringify({ id: a.id, email: a.email, name: a.displayName, emailVerified: a.emailVerified, verifiedBy: a.verifiedBy, owner: a.owner, canHost: a.canHost, identityVerified: a.identityVerified, totpEnabled: a.totpEnabled, leaderboard: a.leaderboard ?? null, supporter: a.supporter ?? null, progress: me.progress ?? null, terms: me.terms ?? null, at: Date.now() }, null, 1));
}

class HubError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

// (Tests swap in their own fetch.)
let fetchFn = (...a) => net.fetch(...a);
/**
 * One request to the Kea account server, never longer than `timeout` (8 s; the whole request, connecting included).
 * Not reaching it is status 0, a normal answer: callers show "offline", never an error screen.
 * reauth: the route asks for the password again, so a 401 means a wrong password, not that the sign-in ended.
 */
async function req(method, p, body, { auth = true, reauth = false, timeout } = {}) {
  const token = auth ? readToken() : null;
  let res;
  try {
    res = await core.timedFetch(fetchFn, hubUrl() + p, {
      method,
      headers: { 'content-type': 'application/json', 'x-kea': '1', 'x-kea-client': `Kea/${app.getVersion()}`, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, timeout ?? LIMITS.req);
  } catch (e) {
    seen(false);
    throw new HubError(OFFLINE_MSG, 0, e?.timeout ? { timeout: true } : null);
  }
  let data = {};
  try {
    data = res.json();
  } catch {}
  if (!data || typeof data !== 'object') data = {};
  seen(true);
  if (res.status === 401 && auth && token && !data.totpRequired && !reauth) {
    // The online session ended (signed out elsewhere, password changed, suspended). The account stays signed in on
    // this computer; only what needs it online waits for "Sign in online".
    writeToken(null);
    saveCache(null);
    lastMe = null;
    changed();
  }
  if (!res.ok) throw new HubError(data.error || `Your Kea account server said ${res.status}.`, res.status, data);
  return data;
}

// ---------- Who's signed in on this computer (never waits on the network) ----------
let store = null;
const accounts = () => (store ??= core.createStore(app.getPath('userData')));
// The last background check of the server, and the last account details it sent (this run of Kea only).
const reach = { reachable: false, at: 0 };
let lastMe = null;
function seen(ok) {
  const was = reach.reachable;
  reach.reachable = ok;
  reach.at = Date.now();
  if (was !== ok) changed();
}
/** Tells Kea's page the account changed by itself (a background sign-in finished, the session ended). */
function changed() {
  try {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('hub:changed');
  } catch {}
}
// (Problems with the online sign-in found in the background, for the account page: 'code' | 'password'.)
let onlineNote = null;
// (Off in the tests: no sync or notification polling started by a sign-in.)
let background = true;

const clientId = (provider) =>
  String(
    provider === 'microsoft'
      ? settings.get('hub.microsoftClientId', '') || process.env.KEA_MICROSOFT_CLIENT_ID || ''
      : settings.get('hub.googleClientId', '') || process.env.KEA_GOOGLE_CLIENT_ID || ''
  ).trim();
const providers = () => ({ google: !!clientId('google'), microsoft: !!clientId('microsoft') });

/** The account signed in here, also for a sign-in from before Kea kept accounts on this computer (Kea 0.70). */
function activeAccount() {
  const S = accounts();
  let a = S.active();
  if (!a && readToken()) {
    const c = cached();
    if (c?.email && c.id) a = S.attachOnline({ email: c.email, name: c.name, hubId: c.id, url: hubUrl() });
  }
  return a;
}
function local() {
  const token = !!readToken();
  const a = activeAccount();
  const state = core.accountState({ active: a, hasToken: token });
  return {
    url: hubUrl(),
    defaultUrl: DEFAULT_HUB_URL,
    cached: cached(),
    state,
    account: a ? { id: a.id, email: a.email, name: a.name, linked: !!a.hub, canSignInOffline: a.canSignInOffline, provider: a.hub?.provider || null } : null,
    known: accounts().list().map((x) => ({ email: x.email, name: x.name })),
    providers: providers(),
    onlineNote: state === 'linked' ? onlineNote : null,
    signedIn: token,
    reachable: reach.reachable,
    checked: reach.at > 0,
    me: token && reach.reachable ? lastMe : null,
  };
}

/** An online sign-in's answer (Hub 0.5: { token, account }; the Kea account server: { token, me }). */
const onlineAccountOf = (r) => r?.account || r?.me?.account || null;
/**
 * After any online sign-in: keep the session, and the account on this computer for that email (made if there's none,
 * linked to the online one, signed in). `password`: the one just used online, kept as a verifier so the same account
 * signs in offline later. Any other account's online session here ends (one account at a time).
 */
async function signedIn(r, { password = null, provider = null } = {}) {
  const acc = onlineAccountOf(r);
  const was = accounts().active();
  if (was && acc && core.norm(was.email) !== core.norm(acc.email)) dropSession();
  writeToken(r.token);
  onlineNote = null;
  if (acc) await accounts().rememberOnline({ email: acc.email, name: acc.displayName, hubId: acc.id, url: hubUrl(), provider, password });
  if (background) setTimeout(startSync, 1000);
  try {
    return await refresh();
  } catch (e) {
    if (e.status === 0) return local();
    throw e;
  }
}
async function refresh({ timeout } = {}) {
  if (!readToken()) return status();
  const me = await req('GET', '/v1/me', undefined, { timeout });
  saveCache(me);
  lastMe = me;
  const a = accounts().active();
  if (!a || core.norm(a.email) !== core.norm(me.account.email) || a.hub?.id !== me.account.id) accounts().attachOnline({ email: me.account.email, name: me.account.displayName, hubId: me.account.id, url: hubUrl() });
  // A newer notification than Kea has seen: fetch it now instead of at the next poll.
  if (!process.env.KEA_WORKER_JOB && background) require('./hubNotes.cjs').seen(me.notifications?.latest);
  return { ...local(), signedIn: true, reachable: true, me };
}
/** A Kea account server answers at this address (its health check, within a few seconds). */
async function answers(origin) {
  try {
    const r = await core.timedFetch(fetchFn, `${origin}/v1/health`, { headers: { 'x-kea': '1' } }, LIMITS.status);
    const j = (() => {
      try {
        return r.json();
      } catch {
        return {};
      }
    })();
    return r.ok && (j.service === 'kea-hub' || j.service === 'kea-account' || j.service === 'keac');
  } catch {
    return false;
  }
}
/** What local() says, after checking the server in the background (4 s at most). */
async function status() {
  if (!readToken()) {
    try {
      await req('GET', '/v1/health', undefined, { auth: false, timeout: LIMITS.status });
    } catch {}
    return local();
  }
  try {
    return await refresh({ timeout: LIMITS.status });
  } catch (e) {
    // Offline, or the session ended: still signed in here, working from what Kea last knew.
    if (e.status === 0 || e.status === 401) return local();
    throw e;
  }
}
/** The online session here ends (another account signs in, or signing out); the accounts on this computer stay. */
function dropSession() {
  if (!readToken()) return;
  writeToken(null);
  saveCache(null);
  stopSync();
  lastMe = null;
}

// ---------- Signing in and making an account ----------
/**
 * Signing in with email and password. An account kept on this computer is checked here, at once, with no connection;
 * a linked one then signs in online in the background. An email this computer hasn't signed in with (or a linked
 * account whose password may have changed elsewhere) goes to the server. `online`: sign in online now (the account
 * page's "Sign in online", with a two-step code when asked).
 */
async function login({ email, password, code, online = false }) {
  const S = accounts();
  const e = core.norm(email);
  if (!e || !password) throw new HubError('Enter your email and password.', 400);
  const here = await S.check({ email: e, password });
  if (here.ok && !online) {
    const was = S.active();
    if (was && was.id !== here.account.id) dropSession();
    const r = await S.signIn({ email: e, password });
    if (r.account.hub && !readToken()) onlineInBackground(e, password);
    return local();
  }
  if (here.reason === 'wrong' && !here.account.hub) throw new HubError('Wrong password for this account.', 401);
  let r;
  try {
    r = await req('POST', '/v1/auth/login', { email: e, password, code: code || undefined }, { auth: false });
  } catch (err) {
    if (err.status === 0) {
      if (here.ok) throw new HubError(OFFLINE_MSG, 0, { unreachable: true });
      if (here.reason === 'wrong') throw new HubError('Wrong password. (Kea can’t reach your Kea account online to check a newer one.)', 401);
      throw new HubError('This email hasn’t signed in on this computer before, and Kea can’t reach your Kea account online right now. Try again once you’re online, or create an account on this computer.', 0, { unreachable: true });
    }
    throw err;
  }
  return signedIn(r, { password });
}
let bgLogin = null;
/** A linked account signed in offline: its online session comes back by itself once the server answers. */
function onlineInBackground(email, password) {
  const attempt = async () => {
    try {
      const r = await req('POST', '/v1/auth/login', { email, password }, { auth: false });
      const a = accounts().active();
      if (a && core.norm(a.email) === email && !readToken()) await signedIn(r, { password });
      bgLogin = null;
      changed();
    } catch (e) {
      if (e.status === 0) return void (bgLogin = setTimeout(attempt, 60_000)).unref?.(); // offline: try again in a minute
      bgLogin = null;
      onlineNote = e.data?.totpRequired ? 'code' : 'password';
      changed();
    }
  };
  clearTimeout(bgLogin);
  bgLogin = setTimeout(attempt, 0);
}
/** A new account, made on this computer at once (no connection needed) and signed in. */
async function create({ email, password, name }) {
  try {
    clearTimeout(bgLogin);
    const was = accounts().active();
    if (readToken() && was) dropSession();
    await accounts().create({ email, password, name });
  } catch (e) {
    throw new HubError(e.message, e.exists ? 409 : 400, { field: e.field || null, exists: !!e.exists });
  }
  onlineNote = null;
  return local();
}

/** Signing in with Google or Microsoft's ID token (Hub 0.5 knows Google at /v1/auth/google). */
function oauthLogin(provider, idToken, code) {
  return provider === 'google'
    ? req('POST', '/v1/auth/google', { idToken, code: code || undefined }, { auth: false })
    : req('POST', '/v1/auth/oauth', { provider, idToken, code: code || undefined }, { auth: false });
}
/** From the start screen: Continue with Google or Microsoft (an online account for that email, linked here). */
async function oauthSignIn({ provider = 'google', email, code }) {
  const idToken = await idTokenFor(provider, email);
  return signedIn(await oauthLogin(provider, idToken, code), { provider });
}
const noOnlineAccount = (e) => {
  if (e.status === 404) throw new HubError('There’s no online Kea account for that email yet. Create an account on this computer, then take it online from Settings → Kea account.', 404, { needsCreate: true });
  throw e;
};

/**
 * Taking the account on this computer online: a Google or Microsoft sign-in with the same email links it to the online
 * Kea account for that email (made now when `password` and the terms come along, else signed in to). A different email
 * never links: nothing here changes and the page offers another account or staying offline. Nothing on this computer is
 * deleted by linking.
 */
async function link({ provider = 'google', password, code, termsVersion, termsSections, age13 }) {
  const label = core.PROVIDERS[provider]?.label;
  if (!label) throw new HubError('Pick Google or Microsoft.', 400);
  const rec = accounts().active();
  if (!rec) throw new HubError('Sign in on this computer first.', 401);
  if (password) {
    const c = await accounts().check({ email: rec.email, password });
    if (!c.ok && c.reason !== 'noVerifier') throw new HubError('That isn’t this account’s password.', 401, { field: 'password' });
  }
  // (Finishing a two-step sign-in that the new or existing online account asked for.)
  if (code && password) return signedIn(await req('POST', '/v1/auth/login', { email: rec.email, password, code }, { auth: false }), { password, provider });
  const idToken = await idTokenFor(provider, rec.email);
  const who = core.idTokenEmail(idToken);
  const d = core.linkDecision(rec, who.email);
  if (!d.link)
    throw new HubError(
      d.reason === 'differentEmail' ? `That ${label} account is ${d.providerEmail}, not ${d.accountEmail}. A different email never links to this account, and nothing here changed.` : `${label} didn’t say which email it is. Try again.`,
      409,
      { mismatch: true, ...d }
    );
  if (password && termsVersion != null) {
    const reg = await req('POST', '/v1/auth/register', {
      email: rec.email,
      password,
      displayName: rec.name || rec.email.split('@')[0],
      ...(rec.name ? { name: rec.name } : {}),
      age13: age13 === true,
      termsVersion,
      termsSections,
      provider,
      idToken,
      ...(provider === 'google' ? { googleIdToken: idToken } : {}),
    }, { auth: false });
    if (reg.token) return signedIn(reg, { password, provider });
    // (Hub 0.5 answers the same whether or not the email had an account, and never signs in by itself.)
    try {
      return await signedIn(await req('POST', '/v1/auth/login', { email: rec.email, password }, { auth: false }), { password, provider });
    } catch (e) {
      if (e.data?.totpRequired) throw e;
      if (e.status === 401) throw new HubError(`There’s already an online Kea account for ${rec.email} with a different password. Continue with ${label} again to sign in to it.`, 409, { existsOnline: true });
      throw e;
    }
  }
  try {
    return await signedIn(await oauthLogin(provider, idToken, code), { provider });
  } catch (e) {
    if (e.status === 404) throw new HubError(`There’s no online Kea account for ${rec.email} yet. Enter this account’s password and agree to the terms to make it.`, 404, { needsCreate: true });
    throw e;
  }
}

/**
 * "Download my data": everything the Hub keeps about this account, and its organizations' records about them
 * (availability, certs, shifts), as one JSON file saved where the person picks. Returns the path, or null.
 */
async function exportData({ save = defaultSave } = {}) {
  const account = await req('GET', '/v1/me/export');
  let work = null;
  try {
    work = await req('GET', '/v1/orgs-export');
  } catch (e) {
    if (!e.status) throw e;
  }
  const day = new Date().toISOString().slice(0, 10);
  return save(`Kea account data ${day}.json`, JSON.stringify({ kea: { exportedAt: new Date().toISOString(), hub: hubUrl() }, account, work }, null, 1));
}
async function defaultSave(name, text) {
  const { dialog, BrowserWindow } = require('electron');
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  const r = await dialog.showSaveDialog(win, { title: 'Save your Kea account data', defaultPath: path.join(app.getPath('downloads'), name), filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, text);
  return r.filePath;
}

// ---------- Google and Microsoft sign-in: an ID token from the desktop flow (loopback + PKCE; openid, email, profile) ----------
let pendingOauth = null;
// (Tests answer with their own ID tokens instead of opening a browser.)
let idTokenFn = null;
const idTokenFor = (provider, loginHint) => (idTokenFn ? idTokenFn(provider, loginHint) : oauthIdToken(provider, loginHint));
const googleIdToken = (loginHint) => idTokenFor('google', loginHint);
function oauthIdToken(provider, loginHint) {
  const P = core.PROVIDERS[provider];
  const id = clientId(provider);
  const secret = provider === 'google' ? String(settings.get('hub.googleClientSecret', '') || process.env.KEA_GOOGLE_CLIENT_SECRET || '').trim() : '';
  if (!P || !id) return Promise.reject(new HubError(`Continue with ${P?.label || provider} isn’t set up in this copy of Kea.`, 503));
  if (pendingOauth) pendingOauth.cancel();
  return new Promise((resolve, reject) => {
    const { verifier, challenge } = core.pkcePair();
    const state = crypto.randomBytes(16).toString('base64url');
    const server = http.createServer(async (rq, rs) => {
      const url = new URL(rq.url, 'http://127.0.0.1');
      if (url.pathname !== '/') return rs.writeHead(404).end();
      const page = (ok, msg) => {
        rs.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        rs.end(`<!doctype html><meta charset="utf-8"><title>Kea</title><body style="font-family:Segoe UI,system-ui,sans-serif;background:#131314;color:#e3e3e3;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2 style="font-weight:500">${ok ? 'Done' : 'That didn’t finish'}</h2><p style="color:#9aa0a6">${msg}</p></div></body>`);
      };
      if (url.searchParams.get('state') !== state) return page(false, 'Please try again from Kea.');
      const code = url.searchParams.get('code');
      if (!code) {
        page(false, 'You can close this tab.');
        return finish(new HubError(`${P.label} sign-in was cancelled.`, 400));
      }
      try {
        const t = core.tokenRequest(provider, { clientId: id, clientSecret: secret, code, verifier, port: server.address().port });
        const r = await core.timedFetch(fetchFn, t.url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: t.body }, LIMITS.req);
        let j = {};
        try {
          j = r.json();
        } catch {}
        if (!r.ok || !j.id_token) throw new HubError(j.error_description || `${P.label} sign-in failed.`, 400);
        page(true, 'You can close this tab and go back to Kea.');
        finish(null, j.id_token);
      } catch (err) {
        const msg = err?.timeout ? `Can’t reach ${P.label} right now.` : String(err.message || err);
        page(false, msg);
        finish(err?.timeout ? new HubError(msg, 0) : err);
      }
    });
    const timer = setTimeout(() => finish(new HubError(`${P.label} sign-in timed out.`, 408)), 5 * 60e3);
    const finish = (err, val) => {
      clearTimeout(timer);
      pendingOauth = null;
      setTimeout(() => server.close(), 500);
      err ? reject(err) : resolve(val);
    };
    pendingOauth = { cancel: () => finish(new HubError('Replaced by a newer sign-in.', 409)) };
    server.listen(0, '127.0.0.1', () => {
      shell.openExternal(core.authorizeUrl(provider, { clientId: id, port: server.address().port, challenge, state, loginHint }));
    });
  });
}

// Errors reach the page as { error, status, data } so it can show the right screen (two-step code, terms, ...).
const wrap = (fn) => async (_e, arg) => {
  try {
    return { ok: true, value: await fn(arg || {}) };
  } catch (e) {
    return { ok: false, error: String(e.message || e), status: e.status ?? null, data: e.data ?? null };
  }
};

// ---------- Kea's shared Claude: asking for a scan, and answering the worker's relayed calls ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Write a file into this account's Kea storage (raw bytes). */
async function putFile(p, data) {
  let r;
  try {
    r = await core.timedFetch(fetchFn, `${hubUrl()}/v1/files/${p.split('/').map(encodeURIComponent).join('/')}`, { method: 'PUT', headers: { authorization: `Bearer ${readToken()}`, 'x-kea': '1', 'x-kea-client': `Kea/${app.getVersion()}` }, body: data }, 30_000);
  } catch {
    throw new HubError(OFFLINE_MSG, 0);
  }
  if (!r.ok) {
    let e = {};
    try {
      e = r.json();
    } catch {}
    throw new HubError(e.error || `Your Kea account server said ${r.status}.`, r.status);
  }
}
/**
 * Ask Kea's shared Claude to set up all this profile's classes. Only the class site's address and the profile's name
 * are sent, never the login: the scan browses through this Kea while it runs (answerCalls).
 */
async function requestScan() {
  const browser = require('./scholar/browser.cjs');
  const profiles = require('./scholar/profiles.cjs');
  const info = browser.schoolInfo();
  if (!info.home) throw new HubError('Set up your class site first (Add a class → From your school), then sign in to it.', 400);
  const me = cached();
  if (!me || !isSignedIn()) throw new HubError('Kea’s shared Claude needs your Kea account online. Your own Claude works without it.', 401, { needsOnline: true });
  const profile = profiles.all().list.find((p) => p.id === profiles.active())?.name || 'School';
  const course = { school: info.host, code: 'all-classes', term: new Date().toISOString().slice(0, 7), section: me.id };
  const r = await req('POST', '/v1/scan', { kind: 'initial_scan', course, ...targetArg() });
  if (r.status === 'queued' && r.uploadTo) {
    await putFile(`${r.uploadTo}job.json`, JSON.stringify({ home: info.home, platform: info.platform, profile }));
    await req('POST', `/v1/scan/${r.job.id}/ready`, {});
  }
  if (r.job?.id) myJobs.add(r.job.id, r.job.kind || 'initial_scan');
  watchJobs();
  return r;
}
/**
 * Where course material for this profile goes in this account's Kea storage ("kea/Kea/<profile>/"): the folder this
 * Kea syncs through the Hub. Only when this Kea syncs through the Hub.
 */
function targetArg() {
  try {
    const cloud = require('./scholar/cloud.cjs');
    const t = cloud.drive()?.id === 'kea-hub' ? cloud.target() : null;
    if (!t) return {};
    const rel = path.relative(syncRoot(), t);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return {};
    return { target: `${require('./scholar/hubsync.cjs').toRemote(rel)}/` };
  } catch {
    return {};
  }
}
/** Chapters this profile can ask Kea's shared Claude for more questions on: [{ courseId, code, name, label, test }]. */
async function questionChapters() {
  const db = require('./scholar/db.cjs');
  const profiles = require('./scholar/profiles.cjs');
  const P = profiles.paths();
  const courses = new Map((await db.courses(P.db, P.textbooks, {}).catch(() => [])).map((c) => [c.id, c]));
  return (await db.textbookChapters(P.db, P.textbooks).catch(() => []))
    .filter((x) => courses.has(x.courseId))
    .map((x) => ({ courseId: x.courseId, code: courses.get(x.courseId).code, name: courses.get(x.courseId).name, label: x.label, test: x.test || null }));
}
/**
 * Ask Kea's shared Claude for one batch of new practice questions on a chapter. Classmates (same school, course and
 * term) who ask for the same chapter share the batch. The questions arrive with a later sync (sharedMaterial.cjs).
 */
async function requestQuestions({ courseId, chapter, joinCode }) {
  const me = cached();
  if (!me || !isSignedIn()) throw new HubError('Kea’s shared Claude needs your Kea account online. Your own Claude works without it.', 401, { needsOnline: true });
  const c = (await questionChapters()).find((x) => x.courseId === courseId && x.label === chapter);
  if (!c) throw new HubError('Pick a chapter that has a textbook in Kea.', 400);
  const browser = require('./scholar/browser.cjs');
  const host = browser.schoolInfo().host;
  if (!host) throw new HubError('Set up your class site first (Add a class → From your school).', 400);
  const t = targetArg();
  if (!t.target) throw new HubError('Kea has to sync through your Kea account for this (Settings → Sync: Kea account).', 400);
  const profiles = require('./scholar/profiles.cjs');
  const db = require('./scholar/db.cjs');
  const P = profiles.paths();
  const term = (await db.courses(P.db, P.textbooks, {}).catch(() => [])).find((x) => x.id === courseId)?.term || '';
  const profile = profiles.all().list.find((p) => p.id === profiles.active())?.name || 'School';
  const r = await req('POST', '/v1/scan', {
    kind: 'more_questions',
    course: { school: host, code: c.code, term: term || 'current' },
    chapter,
    ...t,
    detail: { courseCode: c.code, chapter, profile },
    ...(joinCode ? { joinCode: String(joinCode).trim() } : {}),
  });
  if (r.job?.id) myJobs.add(r.job.id, r.job.kind || 'more_questions');
  watchJobs();
  return r;
}
/** The Hub's course section for one of this profile's courses (as requestQuestions names it). */
async function sectionOf(courseId) {
  const c = (await questionChapters()).find((x) => x.courseId === courseId);
  if (!c) throw new HubError('Pick a course that has a textbook in Kea.', 400);
  const host = require('./scholar/browser.cjs').schoolInfo().host;
  if (!host) throw new HubError('Set up your class site first (Add a class → From your school).', 400);
  const profiles = require('./scholar/profiles.cjs');
  const db = require('./scholar/db.cjs');
  const P = profiles.paths();
  const term = (await db.courses(P.db, P.textbooks, {}).catch(() => [])).find((x) => x.id === courseId)?.term || '';
  return { school: host, code: c.code, term: term || 'current' };
}

// While one of this person's jobs runs, the worker's calls come here and are answered with this Kea's own signed-in
// browser, limited to the class site and the platforms it links to (mcp.cjs allowedUrl), and read-only. Only for a job
// THIS device asked for (myJobs: never one the Hub merely says is running), only the operations that kind of job needs,
// and only for a limited time; a notification and the shared-Claude panel say while it's happening.
const RELAY_OPS = { initial_scan: ['request', 'open', 'click', 'status'], update_scan: ['request', 'open', 'click', 'status'] };
const relayMinutes = () => Math.max(10, Math.min(480, Number(settings.get('hub.relayMinutes', 60)) || 60));
/** The shared-Claude jobs this device asked for (userData/hub-my-jobs.json): { [id]: { kind, at, servedFrom } }. */
const myJobs = {
  file: () => path.join(app.getPath('userData'), 'hub-my-jobs.json'),
  read() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file(), 'utf8'));
      return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
    } catch {
      return {};
    }
  },
  write(all) {
    // (Jobs from more than 30 days ago are forgotten.)
    const keep = Object.fromEntries(Object.entries(all).filter(([, v]) => Date.now() - (v.at || 0) < 30 * 864e5));
    fs.writeFileSync(this.file(), JSON.stringify(keep));
  },
  add(id, kind) {
    const all = this.read();
    if (!all[id]) all[id] = { kind, at: Date.now() };
    this.write(all);
  },
  get(id) {
    return this.read()[id] || null;
  },
  /** When this device first served the job's calls (kept, so a restart doesn't start the time limit over). */
  servedFrom(id) {
    const all = this.read();
    if (!all[id]) return null;
    if (!all[id].servedFrom) (all[id].servedFrom = Date.now()), this.write(all);
    return all[id].servedFrom;
  },
};
async function relayOp(op, a, kind = 'initial_scan') {
  if (!(RELAY_OPS[kind] || []).includes(op)) throw new Error(`Not allowed: ${op}`);
  const browser = require('./scholar/browser.cjs');
  const { allowedUrl } = require('./scholar/mcp.cjs');
  const allowed = (u) => {
    try {
      return !!allowedUrl(u);
    } catch {
      return false;
    }
  };
  switch (op) {
    case 'request': {
      const res = await browser.request(allowedUrl(a.url), allowed);
      // (Where it ended up after redirects must be allowed too: an open redirect on an allowed site never carries
      // this person's signed-in page to another host.)
      if (res.url && !allowed(res.url)) throw new Error('That page redirects to a site Kea doesn’t read for the scan.');
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 30 * 1024 * 1024) throw new Error('That file is over 30 MB.');
      return { status: res.status, url: res.url, headers: { 'content-type': res.headers.get('content-type') || '', link: res.headers.get('link') || '' }, body64: buf.toString('base64') };
    }
    case 'open':
      return browser.open(allowedUrl(a.url), Number(a.offset) || 0);
    case 'click':
      return browser.click(String(a.text || '').slice(0, 120), Number(a.nth) || 1, allowed);
    case 'status':
      return browser.status();
    default:
      throw new Error(`Not allowed: ${op}`);
  }
}
/** Jobs being served now: { id, since, until, calls } (for the shared-Claude panel). */
const serving = new Map();
function servingNow() {
  return [...serving.values()].map((x) => ({ ...x }));
}
async function answerCalls(jobId, kind) {
  if (serving.has(jobId)) return;
  const mine = myJobs.get(jobId);
  // A job this device never asked for, or a kind that needs no class site: never served.
  if (!mine || !RELAY_OPS[kind] || (mine.kind && mine.kind !== kind)) return;
  const since = myJobs.servedFrom(jobId);
  const until = since + relayMinutes() * 60e3;
  if (Date.now() >= until) return;
  const state = { id: jobId, kind, since, until, calls: 0 };
  serving.set(jobId, state);
  let note = null;
  try {
    const { Notification } = require('electron');
    if (Notification.isSupported()) {
      note = new Notification({ title: 'Kea’s shared Claude is reading your class site', body: 'Your scan is running and reads your class site through this Kea, read-only. Keep Kea open until it finishes.', silent: true });
      note.show();
    }
  } catch {}
  try {
    for (;;) {
      if (Date.now() >= until) break; // its time is up: the worker's calls go unanswered and the job ends
      let r;
      try {
        r = await req('GET', `/v1/scan/${jobId}/calls`);
      } catch (e) {
        if (e.status === 404 || e.status === 401 || e.status === 403 || e.status === 428) break; // finished, or not ours
        await sleep(5000);
        continue;
      }
      for (const c of r.calls || []) {
        let body;
        if (Date.now() >= until) body = { ok: false, error: 'This Kea stopped answering: the scan reached its time limit.' };
        else
          try {
            state.calls++;
            body = { ok: true, result: await relayOp(c.op, c.args || {}, kind) };
          } catch (e) {
            body = { ok: false, error: String(e.message || e) };
          }
        await req('POST', `/v1/scan/${jobId}/calls/${c.id}/result`, body).catch(() => {});
      }
    }
  } finally {
    serving.delete(jobId);
    try {
      note?.close();
    } catch {}
  }
}
let jobsTimer = null;
const jobsState = { jobs: [], allowance: null, at: 0 };
/** Checks this person's queued jobs (every 20 s while some are waiting, else every 3 minutes) and serves running ones. */
function watchJobs(delay = 1000) {
  clearTimeout(jobsTimer);
  jobsTimer = setTimeout(async () => {
    let busy = false;
    if (isSignedIn()) {
      try {
        const r = await req('GET', '/v1/scan');
        Object.assign(jobsState, { jobs: r.jobs, allowance: r.allowance, at: Date.now() });
        // (Only this device's own scan jobs: answerCalls checks.)
        for (const j of r.jobs) if (j.status === 'running' && RELAY_OPS[j.kind]) answerCalls(j.id, j.kind);
        busy = r.jobs.some((j) => j.status === 'queued' || j.status === 'running');
      } catch {}
    }
    watchJobs(busy ? 20_000 : 180_000);
  }, delay);
}

// ---------- The owner's launcher: runs queued jobs in a hidden worker copy of Kea (scholar/worker.cjs) ----------
// Only on the Hub owner's PC (the owner key from KeaS's setup is there), only when this Kea isn't scanning its own
// classes (the owner's scans come first), one job at a time.
function ownerKeyFile() {
  const set = String(settings.get('hub.ownerKeyFile', '') || '');
  if (set && fs.existsSync(set)) return set;
  try {
    const c = JSON.parse(fs.readFileSync(path.join(app.getPath('appData'), 'KeaS', 'keas-config.json'), 'utf8'));
    const f = c.dataDir && path.join(c.dataDir.replace(/\\\\/g, '\\'), 'owner.key');
    return f && fs.existsSync(f) ? f : null;
  } catch {
    return null;
  }
}
let workerProc = null;
const workerState = { running: null, last: null };
const workersDir = () => path.join(app.getPath('userData'), 'workers');
/** The longest a shared-Claude job may take, in minutes (Settings → Kea's shared Claude). */
const workerMinutes = () => Math.max(10, Math.min(240, Number(settings.get('hub.workerMinutes', 45)) || 45));
/**
 * A finished job's folder (that student's class database, downloads, logs and Claude's transcript) is deleted; only a
 * few lines about it stay, in workers/summary.log.
 */
async function endWorkerFolder(dir, line) {
  let tail = [];
  try {
    tail = fs.readFileSync(path.join(dir, 'worker.log'), 'utf8').trim().split(/\r?\n/).slice(-3).map((l) => l.slice(0, 300));
  } catch {}
  try {
    fs.mkdirSync(workersDir(), { recursive: true });
    const log = path.join(workersDir(), 'summary.log');
    const old = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean).slice(-1000) : [];
    fs.writeFileSync(log, [...old, line, ...tail.map((l) => `    ${l}`)].join('\n') + '\n');
  } catch (e) {
    console.error('Worker summary', e.message);
  }
  // (Windows can hold a file for a moment after the program using it ends.)
  for (let i = 0; i < 10; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      if (!fs.existsSync(dir)) return true;
    } catch {}
    await sleep(1000 * (i + 1));
  }
  console.error('Couldn’t delete the worker folder', dir);
  return false;
}
/** Worker folders left from a job that didn't end cleanly (Kea closed or crashed mid-job). */
async function sweepWorkerFolders() {
  let entries = [];
  try {
    entries = fs.readdirSync(workersDir(), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) if (e.isDirectory()) await endWorkerFolder(path.join(workersDir(), e.name), `${new Date().toISOString()} job ${e.name}: left over from an earlier start, deleted`);
}
async function launcherTick() {
  if (workerProc || process.env.KEA_WORKER_JOB) return;
  if (!cached()?.owner) return;
  const keyFile = ownerKeyFile();
  if (!keyFile) return;
  try {
    const s = require('./scholar/runner.cjs').status();
    if (s.running || s.queued.length) return;
  } catch {
    return;
  }
  await sweepWorkerFolders();
  if (workerProc) return;
  const port = Number(settings.get('hub.ownerPort', 4861)) || 4861;
  const key = fs.readFileSync(keyFile, 'utf8').trim();
  // (Signed with the key, never sending it: electron/ownerauth.cjs.)
  const call = (p, body) => require('./ownerauth.cjs').ownerFetch(`http://127.0.0.1:${port}`, key, 'POST', p, { body: JSON.stringify(body || {}), headers: { 'content-type': 'application/json' }, fetchFn: net.fetch }).then((r) => r.json());
  let job;
  try {
    job = (await call('/owner/scan/next')).job;
  } catch {
    return; // the Hub isn't running here
  }
  if (!job) return;
  const task = { initial_scan: 'import', update_scan: 'sync', more_questions: 'more_questions' }[job.kind];
  if (!task) return void call(`/owner/scan/${job.id}/finish`, { ok: false, note: `Kea can't run "${job.kind}" jobs yet.` });
  // (The Hub makes job ids; one that isn't a plain name never becomes a folder.)
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(String(job.id))) return void call(`/owner/scan/${encodeURIComponent(job.id)}/finish`, { ok: false, note: 'Bad job id.' });
  const dir = path.join(workersDir(), job.id);
  const { spawn } = require('child_process');
  const { killTree } = require('./scholar/procTree.cjs');
  const { minimalEnv } = require('./scholar/workspace.cjs');
  const limitMs = workerMinutes() * 60e3;
  const startedAt = Date.now();
  workerState.running = { id: job.id, kind: job.kind, startedAt };
  // The worker copy gets only what it needs: no tokens or keys from this Kea's environment (the owner key is a file
  // path it reads; Claude's own runs get even less, see workspace.cjs).
  const env = { ...minimalEnv(), KEA_WORKER_JOB: job.id, KEA_WORKER_TASK: task, KEA_USERDATA: dir, KEA_OWNER_KEY_FILE: keyFile, KEA_HUB_OWNER_PORT: String(port), KEA_WORKER_LIMIT_MS: String(limitMs), ...(process.env.KEA_DRY_RUN && !app.isPackaged ? { KEA_DRY_RUN: process.env.KEA_DRY_RUN } : {}) };
  const proc = spawn(process.execPath, app.isPackaged ? [] : [app.getAppPath()], { env, stdio: 'ignore', windowsHide: true });
  workerProc = proc;
  let killedForTime = false;
  // The worker ends Claude at its own limit; if the worker itself is still there a few minutes later, it and
  // everything under it (Claude, Bash, uv, Python) are ended here.
  const backstop = setTimeout(() => {
    killedForTime = true;
    killTree(proc.pid).catch(() => {});
  }, limitMs + 5 * 60e3);
  proc.on('exit', async (code) => {
    clearTimeout(backstop);
    workerProc = null;
    workerState.last = { id: job.id, code, at: Date.now() };
    workerState.running = null;
    // A worker that crashed (or was ended) before reporting: mark the job failed so the queue moves on.
    if (code !== 0) await call(`/owner/scan/${job.id}/finish`, { ok: false, note: killedForTime ? 'The job ran over its time limit.' : `The worker stopped (code ${code}).` }).catch(() => {});
    const mins = Math.round((Date.now() - startedAt) / 60e3);
    await endWorkerFolder(dir, `${new Date().toISOString()} job ${job.id} ${job.kind}: ${code === 0 ? 'done' : killedForTime ? 'ended at the time limit' : `ended (code ${code})`} after ${mins} min`);
  });
}

// ---------- Sync through a server (scholar/hubsync.cjs): the Kea account's storage, or a joined KeaS's ----------
// The folder for the place picked in Settings → Where your things sync (syncChoice.cjs) is mirrored both ways with
// that server's /v1/files: Kea cloud with this account's session, a KeaS server with its own session (servers.cjs).
const isSignedIn = () => !!readToken();
const syncRoot = () => path.join(app.getPath('userData'), 'hub-sync');
let syncer = null, syncKey = null, syncTimer = null, watcher = null, debounce = null, lastDown = 0, materialChecked = false;
const syncState = { on: false, last: null, error: null, counts: null };
function syncNow() {
  if (!syncer) return Promise.resolve(null);
  const onHub = syncKey === 'hub';
  if (onHub && !isSignedIn()) return Promise.resolve(null);
  return syncer
    .cycle()
    .then((c) => {
      Object.assign(syncState, { last: Date.now(), error: null, offline: false, counts: c });
      // Course material from Kea's shared Claude that came down (or is still waiting for its class): take it in.
      if (onHub && (c.down > lastDown || !materialChecked)) {
        materialChecked = true;
        require('./scholar/sharedMaterial.cjs').run().catch((e) => console.error('Shared material', e.message));
      }
      lastDown = c.down;
      return syncState;
    })
    .catch((e) => {
      syncState.error = e.message;
      syncState.offline = !e.status; // (Kea Cloud shows "offline" rather than an error)
      // Signed out elsewhere, or new terms to agree to: stop until that's sorted (status() and the terms gate show it).
      // (A KeaS session that ended is made again from the pass at the next start: servers.cjs.)
      if (e.status === 401 || e.status === 428) stopSync();
    });
}
let starting = false;
async function startSync() {
  let place = null;
  try {
    place = require('./syncChoice.cjs').serverPlace();
  } catch {
    return;
  }
  // Classes and Kea Cloud documents both follow the one choice: nothing to mirror unless it's a server.
  if (!place) return stopSync();
  if (syncer && syncKey === place.key) return;
  if (syncer) stopSync();
  if (starting) return;
  starting = true;
  try {
    // (A KeaS server: its session first, from the pass. Offline or signed out: tried again at the next start.)
    if (place.ensure) await place.ensure();
  } catch (e) {
    Object.assign(syncState, { on: false, error: e.message, offline: !e.status });
    return;
  } finally {
    starting = false;
  }
  if (syncer) return;
  const { createSync, httpClient } = require('./scholar/hubsync.cjs');
  fs.mkdirSync(place.root, { recursive: true });
  syncKey = place.key;
  syncer = createSync({
    root: place.root,
    stateFile: place.stateFile,
    client: httpClient({ base: place.base, token: place.token, fetchFn: net.fetch, client: `Kea/${app.getVersion()}` }),
    log: (m) => console.log(m),
    ...require('./keaCloud.cjs').syncOptions(() => true),
  });
  syncState.on = true;
  syncState.place = place.key;
  // Others' changes every 15 s (a tiny "what changed" request); this device's changes 2 s after they happen.
  syncTimer = setInterval(syncNow, 15_000);
  try {
    watcher = fs.watch(place.root, { recursive: true }, () => {
      clearTimeout(debounce);
      debounce = setTimeout(syncNow, 2000);
    });
  } catch {}
  syncNow();
}
function stopSync() {
  clearInterval(syncTimer);
  clearTimeout(debounce);
  try {
    watcher?.close();
  } catch {}
  syncer = syncTimer = watcher = syncKey = null;
  syncState.on = false;
}
/** The place changed (syncChoice.cjs): the old mirror stops, the new one starts. */
function restartSync() {
  stopSync();
  Object.assign(syncState, { error: null, last: null, counts: null });
  return startSync();
}

function register() {
  handleApp(ipcMain, 'hub:requestScan', wrap(() => requestScan()));
  handleApp(ipcMain, 'hub:questionChapters', wrap(() => questionChapters()));
  handleApp(ipcMain, 'hub:requestQuestions', wrap((a) => requestQuestions(a)));
  // Getting into a course section someone else started: requests to let in (or my own), and the section's code.
  handleApp(ipcMain, 'hub:sectionRequests', wrap(() => (isSignedIn() ? req('GET', '/v1/course-sections/requests') : { incoming: [], mine: [] })));
  handleApp(ipcMain, 'hub:sectionDecide', wrap((a) => req('POST', `/v1/course-sections/requests/${encodeURIComponent(String(a.id))}/decide`, { approve: a.approve === true })));
  handleApp(ipcMain, 'hub:sectionCode', wrap(async (a) => req('POST', '/v1/course-sections/code', { course: await sectionOf(a.courseId), ...(a.reset ? { reset: true } : {}) })));
  handleApp(ipcMain, 'hub:scanJobs', wrap(async () => (isSignedIn() ? { ...(await req('GET', '/v1/scan')), worker: workerState, serving: servingNow() } : { jobs: [], allowance: null, worker: workerState, serving: servingNow() })));
  // A worker copy (scholar/worker.cjs) does none of the background work below.
  if (process.env.KEA_WORKER_JOB) return;
  // Start (or stop) syncing through the Hub when Kea starts, and whenever sign-in or the chosen drive may have changed.
  setTimeout(startSync, 5000);
  setInterval(startSync, 60_000);
  // This person's shared-Claude jobs (answering a running one's calls), and on the owner's PC, the launcher.
  watchJobs(8000);
  setInterval(launcherTick, 60_000);
  handleApp(ipcMain, 'hub:syncStatus', wrap(() => ({ ...syncState })));
  handleApp(ipcMain, 'hub:syncNow', wrap(async () => (await startSync(), await syncNow(), { ...syncState })));
  // Who's signed in, from this computer alone (at once), and after a background check of the server (4 s at most).
  handleApp(ipcMain, 'hub:local', wrap(() => local()));
  handleApp(ipcMain, 'hub:status', wrap(() => status()));
  // Making an account (on this computer, no connection needed), signing in, and taking an account online.
  handleApp(ipcMain, 'hub:create', wrap((a) => create(a)));
  handleApp(ipcMain, 'hub:login', wrap((a) => login(a)));
  handleApp(ipcMain, 'hub:oauthSignIn', wrap((a) => oauthSignIn(a).catch(noOnlineAccount)));
  handleApp(ipcMain, 'hub:googleSignIn', wrap((a) => oauthSignIn({ ...a, provider: 'google' }).catch(noOnlineAccount)));
  handleApp(ipcMain, 'hub:link', wrap((a) => link(a)));
  handleApp(ipcMain, 'hub:terms', wrap(() => req('GET', '/v1/terms', undefined, { auth: false })));
  handleApp(ipcMain, 'hub:support', wrap(() => req('GET', '/v1/support', undefined, { auth: false })));
  handleApp(ipcMain, 'hub:openSupport', wrap(async () => {
    const s = await req('GET', '/v1/support', undefined, { auth: false });
    if (s.url && /^https:\/\//.test(s.url)) await shell.openExternal(s.url);
    return true;
  }));
  handleApp(ipcMain, 'hub:changes', wrap(() => req('GET', '/v1/terms/changes')));
  handleApp(ipcMain, 'hub:openTerms', wrap(({ since }) => shell.openExternal(`${hubUrl()}/terms${since ? `?since=${Number(since)}` : ''}`)));
  // Under 18: the birth year, and a parent's or guardian's sign-off before Kea's shared Claude.
  handleApp(ipcMain, 'hub:birthYear', wrap(async (a) => (await req('POST', '/v1/me/birth-year', { birthYear: Number(a.birthYear) }), refresh())));
  handleApp(ipcMain, 'hub:consent', wrap(() => req('GET', '/v1/me/consent')));
  // The optional phone number and who sees it (classmates, coworkers, both, nobody).
  handleApp(ipcMain, 'hub:setPhone', wrap(async (a) => {
    const body = {};
    if ('phone' in a) body.phone = a.phone == null || a.phone === '' ? null : String(a.phone);
    if (a.visibility) body.visibility = a.visibility;
    await req('POST', '/v1/me/phone', body);
    return refresh();
  }));
  handleApp(ipcMain, 'hub:consentRequest', wrap((a) => req('POST', '/v1/me/consent', { parentEmail: a.parentEmail })));
  handleApp(ipcMain, 'hub:consentGoogle', wrap(async () => {
    const c = await req('GET', '/v1/me/consent');
    if (c.parentSignOff !== 'pending' || !c.parentEmail) throw new HubError('Enter your parent’s or guardian’s email first.', 400);
    await req('POST', '/v1/me/consent/google', { idToken: await googleIdToken(c.parentEmail) });
    return refresh();
  }));
  handleApp(ipcMain, 'hub:accept', wrap(async (a) => (await req('POST', '/v1/terms/accept', { termsVersion: a.termsVersion, termsSections: a.termsSections }), refresh())));
  handleApp(ipcMain, 'hub:googleVerify', wrap(async () => (await req('POST', '/v1/me/verify/google', { idToken: await googleIdToken(cached()?.email) }), refresh())));
  // Forgot the password: prove the email with Google, pick a new one (kept here too, for signing in offline).
  handleApp(ipcMain, 'hub:googleReset', wrap(async (a) => signedIn(await req('POST', '/v1/auth/reset/google', { idToken: await googleIdToken(a.email), password: a.password, code: a.code || undefined }, { auth: false }), { password: a.password, provider: 'google' })));
  // The account page: name, password, two-step sign-in, signed-in devices, the data download, deleting the account.
  // (Changing how you sign in needs the password again: the server checks it.) Without an online session, an account
  // made on this computer changes its name and password here.
  handleApp(ipcMain, 'hub:setName', wrap(async (a) => {
    const name = String(a.name ?? '').trim();
    const rec = accounts().active();
    if (!isSignedIn()) {
      if (!rec) throw new HubError('Sign in first.', 401);
      if (rec.hub) throw new HubError('Sign in online to change your name.', 401, { needsOnline: true });
      if (!name) throw new HubError('Add your name.', 400);
      accounts().setName(rec.id, name);
      return local();
    }
    await req('POST', '/v1/me', { displayName: name });
    if (rec) accounts().setName(rec.id, name);
    return refresh();
  }));
  handleApp(ipcMain, 'hub:changePassword', wrap(async (a) => {
    const rec = accounts().active();
    if (!isSignedIn()) {
      if (!rec) throw new HubError('Sign in first.', 401);
      if (rec.hub) throw new HubError('Sign in online to change this account’s password.', 401, { needsOnline: true });
      if (!(await accounts().check({ email: rec.email, password: a.current })).ok) throw new HubError('That isn’t your current password.', 401);
      const problem = core.passwordProblem(a.next, rec.email, rec.name);
      if (problem) throw new HubError(problem, 400, { field: 'password' });
      await accounts().setPassword(rec.id, a.next);
      return local();
    }
    await req('POST', '/v1/me/password', { current: a.current, next: a.next }, { reauth: true });
    if (rec) await accounts().setPassword(rec.id, a.next);
    return refresh();
  }));
  handleApp(ipcMain, 'hub:totpSetup', wrap((a) => req('POST', '/v1/me/totp/setup', { password: a?.password }, { reauth: true })));
  // (A Hub with backup codes answers with ten of them, shown once: they go back with the status. An older Hub has none.)
  handleApp(ipcMain, 'hub:totpEnable', wrap(async (a) => {
    const r = await req('POST', '/v1/me/totp/enable', { code: a.code }, { reauth: true });
    const st = await refresh();
    return Array.isArray(r?.backupCodes) ? { ...st, backupCodes: r.backupCodes } : st;
  }));
  // New backup codes: the password and a code from the authenticator app. An older Hub doesn't have the route.
  handleApp(ipcMain, 'hub:backupCodes', wrap(async (a) => {
    try {
      return await req('POST', '/v1/me/totp/backup-codes', { password: a?.password, code: a?.code }, { reauth: true });
    } catch (e) {
      if ((e.status === 404 || e.status === 405) && e.message === 'Not found.') throw Object.assign(new Error('Your Kea account server doesn’t have backup codes yet. It needs an update.'), { status: 404 });
      throw e;
    }
  }));
  handleApp(ipcMain, 'hub:totpDisable', wrap(async (a) => (await req('POST', '/v1/me/totp/disable', { password: a.password, code: a.code }, { reauth: true }), refresh())));
  handleApp(ipcMain, 'hub:sessions', wrap(() => req('GET', '/v1/me/sessions')));
  handleApp(ipcMain, 'hub:signOutOthers', wrap((a) => req('POST', '/v1/me/sessions/sign-out-others', { password: a.password }, { reauth: true })));
  handleApp(ipcMain, 'hub:exportData', wrap(() => exportData()));
  handleApp(ipcMain, 'hub:deleteAccount', wrap(async (a) => {
    const id = cached()?.id;
    await req('POST', '/v1/me/delete', { confirm: a.confirm, password: a.password, ...(a.code ? { code: a.code } : {}) }, { reauth: true });
    dropSession();
    // (The account was deleted on request: it goes from this computer too, with its picture.)
    const rec = accounts().active();
    if (rec) accounts().remove(rec.id);
    require('./account.cjs').forget(id, rec?.id);
    return local();
  }));
  // Signing out: back to the start screen. The online session ends; the account stays on this computer, so it can sign
  // in again, also offline. Nothing else on this computer is removed.
  handleApp(ipcMain, 'hub:logout', wrap(async () => {
    clearTimeout(bgLogin);
    if (isSignedIn()) {
      try {
        await req('POST', '/v1/auth/logout', {}, { timeout: LIMITS.status });
      } catch {}
    }
    dropSession();
    accounts().signOut();
    onlineNote = null;
    return local();
  }));
  // (Only Kea's own page may move Kea to another server: ipcGuard.cjs.) An online sign-in belongs to the server it was
  // made on, so it never goes to a different address: moving there ends the online session here. The account on this
  // computer stays signed in.
  const moveHub = (next) => {
    const from = hubUrl();
    settings.set({ 'hub.url': next });
    if (originOf(hubUrl()) === originOf(from)) return;
    dropSession();
  };
  // A new address is used only once a Kea Hub answers there. Moving to another Hub while signed in signs out here, so
  // that's only done once the page has asked (confirm: true); until then it answers 409 { switchSignsOut }.
  ipcMain.handle('hub:setUrl', appOnly(wrap(async ({ url, confirm }) => {
    let next = null;
    if (String(url || '').trim()) {
      let u;
      try {
        u = new URL(/^[a-z]+:\/\//i.test(String(url).trim()) ? String(url).trim() : `https://${String(url).trim()}`);
      } catch {
        throw new HubError('That isn’t a web address. It looks like https://name.tailnet.ts.net', 400);
      }
      if (!/^https?:$/.test(u.protocol)) throw new HubError('Use an https:// address.', 400);
      // Plain http only to this computer itself: anywhere else, someone on the network could pose as the Hub.
      if (u.protocol === 'http:' && !/^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/i.test(u.hostname)) throw new HubError('Use the Hub’s https:// address (it looks like https://name.tailnet.ts.net). Plain http only works for a Hub on this computer.', 400);
      next = u.origin;
    }
    const target = next || String(process.env.KEA_HUB_URL || DEFAULT_HUB_URL).replace(/\/+$/, '');
    if (!(await answers(target))) throw new HubError(`No Kea account server answers at ${target}, so Kea kept ${hubUrl()}. Check the address, or try again once it’s running.`, 400, { notAnswering: true });
    if (isSignedIn() && originOf(target) !== originOf(hubUrl()) && confirm !== true) {
      const who = cached()?.email;
      throw new HubError(`Switching to ${target} ends the online sign-in${who ? ` of ${who}` : ''} here. You stay signed in on this computer, and sign in online again on that server.`, 409, { switchSignsOut: true, to: target });
    }
    moveHub(next);
    return status();
  })));
  // Hub classes, study sets, leaderboards and class sessions on the calendar.
  require('./hubClasses.cjs').register();
  // Notifications for this account (a list in the account panel, and Windows notifications).
  require('./hubNotes.cjs').register();
}

module.exports = {
  _relay: { relayOp, answerCalls, myJobs, servingNow, RELAY_OPS, endWorkerFolder },
  _exportData: exportData,
  // (For the tests: the account flows without IPC, and stand-ins for fetch and the browser sign-in.)
  _account: {
    local, status, login, create, link, oauthSignIn, logout: () => (dropSession(), accounts().signOut(), local()),
    setFetch: (f) => (fetchFn = f),
    setIdTokens: (f) => (idTokenFn = f),
    reset: () => ((store = null), (lastMe = null), (onlineNote = null), clearTimeout(bgLogin), Object.assign(reach, { reachable: false, at: 0 })),
    setLimits: (l) => Object.assign(LIMITS, l),
    setBackground: (on) => (background = on),
  },
  current: () => activeAccount(),
  register, cached, req, signedIn: isSignedIn, syncRoot, syncNow, url: hubUrl, refreshStatus: status, DEFAULT_HUB_URL, syncState: () => ({ ...syncState }), startSync, restartSync, _token: readToken };
