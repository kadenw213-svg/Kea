// The Kea account. It is made and signed in to with Google or Microsoft only (the system browser, loopback + PKCE),
// which needs the Kea account server to answer; there are no Kea passwords or two-step codes (only the owner's account
// still has a two-step code). The server adds Kea cloud, hosted classes and organizations, shared Claude and Work.
// Without an account everything on this computer works, and once signed in Kea stays signed in here (accountCore.cjs),
// offline too, until the person signs out. Kea talks to the server here, in the main process. The online sign-in (a
// session token) is encrypted with the OS keychain and never shown to the page.
//
// Nothing here waits on the network to decide who's signed in: Kea reads this computer's files at once (local()), and
// the server is checked in the background with time limits (status()). Not reaching it is normal.
// (Email-only accounts made here by Kea 0.82 and older stay signed in and link on the same email; no new ones are made.)
//
// Settings: hub.url (where the server is, under Advanced). The clients for "Sign in with Google" and "Sign in with
// Microsoft" (openid, email and profile only) are built in (oauthClients.cjs: settings, then the environment, then the
// build's electron/buildConfig.json). With neither, sign-in isn't available in this copy of Kea (the account page says
// so) and everything on this computer works without an account.
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
const DEFAULT_HUB_URL = 'https://kadensdesktop.tailc64e1d.ts.net';
// How long Kea waits for the server: any request, and the background "is it there" checks.
const LIMITS = { req: 8000, status: 4000 };
const OFFLINE_MSG = 'Can’t reach the Kea account server right now. Everything on this computer still works; Kea tries again by itself.';
// (Signing in, or making the account, while the server can't be reached: nothing is opened or made.)
const SIGNIN_WAITS = 'Sign-in is available once Kea can reach the Kea account server. Kea tries again by itself.';
const hubUrl = () => String(settings.get('hub.url', '') || process.env.KEA_HUB_URL || DEFAULT_HUB_URL).replace(/\/+$/, '');
const originOf = (u) => {
  try {
    return new URL(u).origin;
  } catch {
    return String(u);
  }
};
const tokenFile = () => path.join(app.getPath('userData'), 'hub-session.bin');
// What the rest of Kea needs to know without asking the server (the badge, the owner's launcher): no secrets.
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
const accountFiles = () => [path.join(app.getPath('userData'), 'work-calendar.json'), profileQueueFile()];
function saveCache(me) {
  if (!me) {
    for (const f of [cacheFile(), ...accountFiles()]) fs.rmSync(f, { force: true });
    return;
  }
  const a = me.account;
  // (Another account's copies stay: each is kept for the account it was made for, and nobody else is shown it.)
  fs.writeFileSync(cacheFile(), JSON.stringify({ id: a.id, email: a.email, name: a.displayName, emailVerified: a.emailVerified, verifiedBy: a.verifiedBy, owner: a.owner, canHost: a.canHost, identityVerified: a.identityVerified, totpEnabled: a.totpEnabled, leaderboard: a.leaderboard ?? null, supporter: a.supporter ?? null, progress: me.progress ?? null, terms: me.terms ?? null, profile: profileOf(me), at: Date.now() }, null, 1));
}

// ---------- Name and phone ----------
// GET /v1/me has { name, phone: string | null, phoneShare: { orgs, classmates } }; PATCH /v1/me changes them (400
// { error } when something isn't right). An older server keeps them as account.displayName and account.phone
// ({ number, visibility }). Who sees the number starts at: organizations I join yes, classmates no.
const SHARE_DEFAULTS = { orgs: true, classmates: false };
const VIS_SHARE = { nobody: { orgs: false, classmates: false }, orgs: { orgs: true, classmates: false }, classes: { orgs: false, classmates: true }, both: { orgs: true, classmates: true } };
/** The account's name, phone and who sees it, from a /v1/me answer (either shape). */
function profileOf(me) {
  if (!me || typeof me !== 'object') return null;
  const a = me.account || {};
  const name = typeof me.name === 'string' ? me.name : String(a.displayName || '');
  const phone = 'phone' in me && (typeof me.phone === 'string' || me.phone === null) ? me.phone || null : a.phone?.number || null;
  const ps = me.phoneShare && typeof me.phoneShare === 'object' ? me.phoneShare : (a.phone?.visibility && VIS_SHARE[a.phone.visibility]) || null;
  return { name, phone, phoneShare: { orgs: typeof ps?.orgs === 'boolean' ? ps.orgs : SHARE_DEFAULTS.orgs, classmates: typeof ps?.classmates === 'boolean' ? ps.classmates : SHARE_DEFAULTS.classmates } };
}
/** Only what PATCH /v1/me takes: name (text), phone (text, or null to clear), phoneShare.orgs / .classmates. */
function profilePatch(a = {}) {
  const out = {};
  if (typeof a.name === 'string') out.name = a.name.trim().slice(0, 60);
  if ('phone' in a) out.phone = a.phone == null || String(a.phone).trim() === '' ? null : String(a.phone).trim().slice(0, 20);
  if (a.phoneShare && typeof a.phoneShare === 'object') {
    const ps = {};
    for (const k of ['orgs', 'classmates']) if (typeof a.phoneShare[k] === 'boolean') ps[k] = a.phoneShare[k];
    if (Object.keys(ps).length) out.phoneShare = ps;
  }
  return out;
}
const mergePatch = (was, next) => ({ ...(was || {}), ...next, ...(was?.phoneShare || next.phoneShare ? { phoneShare: { ...(was?.phoneShare || {}), ...(next.phoneShare || {}) } } : {}) });
/** The answer with what was saved in it (a server that answers PATCH with less than the whole account). */
function withPatch(me, patch) {
  if (!me) return me;
  const p = profileOf(me) || {};
  return { ...me, name: patch.name ?? p.name, phone: 'phone' in patch ? patch.phone : p.phone, phoneShare: { ...p.phoneShare, ...(patch.phoneShare || {}) }, account: { ...me.account, ...(patch.name ? { displayName: patch.name } : {}) } };
}
// Changes made while the server couldn't be reached (userData/hub-profile-queue.json: { [online id]: { patch, at } }),
// sent at the next check that reaches it. Removed with the rest of the account's copies when it signs out here.
const profileQueueFile = () => path.join(app.getPath('userData'), 'hub-profile-queue.json');
function profileQueue() {
  try {
    const j = JSON.parse(fs.readFileSync(profileQueueFile(), 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}
function setQueued(id, patch) {
  if (!id) return;
  const all = profileQueue();
  if (patch) all[id] = { patch, at: Date.now() };
  else delete all[id];
  if (Object.keys(all).length) fs.writeFileSync(profileQueueFile(), JSON.stringify(all, null, 1));
  else fs.rmSync(profileQueueFile(), { force: true });
}
// After the first sign-in on this computer, a small card asks for a name and phone once (skippable; editable later in
// Settings → Kea account). userData/hub-profile-asked.json: { ask: <online id> | null, done: [<online id>] }.
const askedFile = () => path.join(app.getPath('userData'), 'hub-profile-asked.json');
function askedState() {
  try {
    const j = JSON.parse(fs.readFileSync(askedFile(), 'utf8'));
    return { ask: typeof j?.ask === 'string' ? j.ask : null, done: Array.isArray(j?.done) ? j.done.filter((x) => typeof x === 'string') : [] };
  } catch {
    return { ask: null, done: [] };
  }
}
function askProfileFor(id) {
  const s = askedState();
  if (!id || s.done.includes(id) || s.ask === id) return;
  fs.writeFileSync(askedFile(), JSON.stringify({ ask: id, done: s.done }, null, 1));
}
function profileAsked() {
  const s = askedState();
  if (s.ask) fs.writeFileSync(askedFile(), JSON.stringify({ ask: null, done: [...new Set([...s.done, s.ask])].slice(-50) }, null, 1));
  return local();
}
/**
 * Saves the name, phone and who sees it (PATCH /v1/me). The name shows here at once. The server not answering is no
 * error: the change waits on this computer ({ profileQueued }) and goes at the next check that reaches it.
 */
async function saveProfile(a) {
  if (!isSignedIn()) throw new HubError('Sign in with Google to save your name and phone.', 401, { needsOnline: true });
  const patch = profilePatch(a);
  if (!Object.keys(patch).length) throw new HubError('Nothing to save.', 400);
  if ('name' in patch && !patch.name) throw new HubError('Add your name.', 400, { field: 'name' });
  const id = cached()?.id || lastMe?.account?.id || null;
  const rec = accounts().active();
  try {
    const me = await req('PATCH', '/v1/me', patch);
    setQueued(id, null);
    profileNote = null;
    if (patch.name && rec) accounts().setName(rec.id, patch.name);
    const full = me?.account ? me : withPatch(lastMe, patch);
    if (full?.account) {
      saveCache(full);
      lastMe = full;
    }
    return { ...local(), signedIn: true, reachable: true, me: lastMe };
  } catch (e) {
    if (e.status !== 0) throw e;
    setQueued(id, mergePatch(profileQueue()[id]?.patch, patch));
    if (patch.name && rec) accounts().setName(rec.id, patch.name);
    return { ...local(), profileQueued: true };
  }
}
/** A change that waited: sent now the server answers (one that it refuses is dropped, and the account page says so). */
async function flushProfile(me, { timeout } = {}) {
  const id = me?.account?.id;
  const q = id && profileQueue()[id];
  if (!q) return me;
  try {
    const r = await req('PATCH', '/v1/me', q.patch, { timeout });
    setQueued(id, null);
    return r?.account ? r : withPatch(me, q.patch);
  } catch (e) {
    if (e.status === 0 || e.status === 401) return me;
    setQueued(id, null);
    profileNote = `Your earlier change to your name or phone wasn’t saved: ${e.message}`;
    return me;
  }
}
// (A queued change the server refused, for the account page.)
let profileNote = null;

class HubError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

// (Tests swap in their own fetch.)
let fetchFn = (...a) => net.fetch(...a);
// Kea's update health (what servers say about versions; tests swap in their own).
let versions = () => require('./updateHealth.cjs').health();
/**
 * One request to the Kea account server, never longer than `timeout` (8 s; the whole request, connecting included).
 * Not reaching it is status 0, a normal answer: callers show "offline", never an error screen.
 * reauth: the route asks for a fresh Google or Microsoft sign-in, so a 401 is about that, not that the sign-in ended.
 */
async function req(method, p, body, { auth = true, reauth = false, timeout, afterMove = false } = {}) {
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
  // Too old for this server (docs/protocol.md section 0): said plainly, with an Update button (updateHealth.cjs), never a
  // half-working account. Any normal answer means it's over.
  if (res.status === 426) {
    versions().tooOld('account', data);
    throw new HubError(data.error || 'Update Kea to keep using your Kea account.', 426, { ...data, upgradeRequired: true });
  }
  if (res.status < 500) versions().served('account');
  if (p === '/v1/health' && res.ok) versions().serverSays('account', data);
  if (res.status === 401 && auth && token && !data.totpRequired && !reauth) {
    // The online session ended (signed out elsewhere, suspended). The account stays signed in on
    // this computer; only what needs it online waits for "Sign in online".
    writeToken(null);
    saveCache(null);
    lastMe = null;
    changed();
  }
  if (res.status === 410 && 'movedTo' in data && !afterMove) {
    // The account server moved (the owner's Hub to KeaC). A checked new address is used from now on; a request made
    // without the online sign-in (signing in, the terms) goes there at once. The online session stays behind: sessions
    // don't move, so the person signs in once on the new server.
    if (await followMove(data)) {
      if (!token) return req(method, p, body, { auth, reauth, timeout, afterMove: true });
      throw new HubError(MOVED_MSG, 401, { moved: true, to: hubUrl() });
    }
    throw new HubError(UNCHECKED_MSG, 410, { unchecked: true, movedTo: typeof data.movedTo === 'string' ? data.movedTo : null });
  }
  if (!res.ok) throw new HubError(data.error || `Your Kea account server said ${res.status}.`, res.status, data);
  return data;
}

// ---------- The Kea account server moved to a new address ----------
// After the move, the old server answers its health check with { ok, movedTo, keacKeyKid } and every other account
// route with 410 { error, movedTo }. Kea follows only to an address that is https (plain http only to this computer
// itself) and has the old server's signing key (the key id in its /v1/keys): anyone could claim an account moved, only
// the real new server has that key. Following it is the same as changing the address under Advanced: the online
// sign-in ends here, the account on this computer stays.
const MOVED_MSG = 'Your Kea account moved to a new address. Sign in once to continue.';
const UNCHECKED_MSG = 'Your Kea account server moved, but the new address couldn’t be checked.';
const isLoopback = (host) => /^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/i.test(host);
/** A server address as Kea keeps it (its origin), or a HubError saying what's wrong with it. */
function serverOrigin(raw) {
  const t = String(raw || '').trim();
  let u;
  try {
    u = new URL(/^[a-z]+:\/\//i.test(t) ? t : `https://${t}`);
  } catch {
    throw new HubError('That isn’t a web address. It looks like https://name.tailnet.ts.net', 400);
  }
  if (!/^https?:$/.test(u.protocol)) throw new HubError('Use an https:// address.', 400);
  // Plain http only to this computer itself: anywhere else, someone on the network could pose as the server.
  if (u.protocol === 'http:' && !isLoopback(u.hostname)) throw new HubError('Use the Kea account server’s https:// address (it looks like https://name.tailnet.ts.net). Plain http only works for one on this computer.', 400);
  return u.origin;
}
/** An online sign-in belongs to the server it was made on: moving to another address ends it here. */
function moveHub(next) {
  const from = hubUrl();
  settings.set({ 'hub.url': next });
  if (originOf(hubUrl()) === originOf(from)) return;
  dropSession();
  lastMe = null;
  Object.assign(reach, { reachable: false, at: 0 });
}
/** A server's signing keys ([{ kid, status }]), or null when it doesn't answer with them. */
async function keysAt(origin) {
  try {
    const r = await core.timedFetch(fetchFn, `${origin}/v1/keys`, { headers: { 'x-kea': '1' }, redirect: 'error' }, LIMITS.status);
    const j = r.ok ? r.json() : null;
    return Array.isArray(j?.keys) ? j.keys.filter((k) => k && typeof k.kid === 'string' && k.kid) : null;
  } catch {
    return null;
  }
}
/** Whether the moved-to address is the real new server: { ok, to, reason }. */
async function checkMove(from, { movedTo, keacKeyKid }) {
  if (!movedTo || typeof movedTo !== 'string') return { ok: false, to: null, reason: 'The old address didn’t say where the account server went.' };
  let to;
  try {
    to = serverOrigin(movedTo);
  } catch (e) {
    return { ok: false, to: String(movedTo), reason: e.message };
  }
  if (originOf(to) === originOf(from)) return { ok: false, to, reason: 'The old address pointed back to itself.' };
  let kid = typeof keacKeyKid === 'string' && keacKeyKid ? keacKeyKid : null;
  if (!kid) {
    // (A 410 says only where: the key id is in the old server's health check, when it names the same address.)
    try {
      const h = (await core.timedFetch(fetchFn, `${from}/v1/health`, { headers: { 'x-kea': '1' } }, LIMITS.status)).json();
      if (typeof h?.keacKeyKid === 'string' && h.keacKeyKid && typeof h.movedTo === 'string' && originOf(h.movedTo) === originOf(to)) kid = h.keacKeyKid;
    } catch {}
  }
  if (!kid) {
    // (An old server that doesn't say the key id in its health check: its own key list, if it still answers it.)
    const old = await keysAt(from);
    kid = old?.find((k) => k.status === 'current')?.kid || (old?.length === 1 ? old[0].kid : null);
  }
  if (!kid) return { ok: false, to, reason: 'The old address didn’t say which signing key the new one has.' };
  const keys = await keysAt(to);
  if (!keys) return { ok: false, to, reason: 'The new address didn’t answer with its signing keys.' };
  if (!keys.some((k) => k.kid === kid && (k.status === undefined || k.status === 'current'))) return { ok: false, to, reason: 'The new address signs with a different key than your Kea account server.' };
  return { ok: true, to };
}
// The notice about it (userData/hub-moved.json: { kind: 'moved' | 'unchecked', from, to, reason, at, seen }), shown once.
const movedFile = () => path.join(app.getPath('userData'), 'hub-moved.json');
function movedNote() {
  try {
    const j = JSON.parse(fs.readFileSync(movedFile(), 'utf8'));
    return j && typeof j === 'object' && (j.kind === 'moved' || j.kind === 'unchecked') ? j : null;
  } catch {
    return null;
  }
}
function noteMove(n) {
  const was = movedNote();
  // (The same unchecked move found again: not shown again once it was seen.)
  const same = was && was.kind === n.kind && was.from === n.from && was.to === n.to;
  fs.writeFileSync(movedFile(), JSON.stringify({ ...n, at: Date.now(), seen: same ? !!was.seen : false }, null, 1));
}
function movedSeen() {
  const n = movedNote();
  if (n && !n.seen) fs.writeFileSync(movedFile(), JSON.stringify({ ...n, seen: true }, null, 1));
  return local();
}
let moving = null;
// (A move that couldn't be checked is tried again after a while, not at every request.)
const moveTried = new Map();
const MOVE_RETRY_MS = 10 * 60e3;
/** Follows the server's move when the new address checks out. True: Kea now uses the new address. */
function followMove(info) {
  if (moving) return moving;
  const from = hubUrl();
  const key = `${from} ${info?.movedTo}`;
  if (Date.now() - (moveTried.get(key) || 0) < MOVE_RETRY_MS) return Promise.resolve(false);
  moving = (async () => {
    const r = await checkMove(from, info || {});
    if (r.ok) {
      moveHub(r.to);
      noteMove({ kind: 'moved', from, to: r.to, reason: null });
      onlineNote = null;
    } else {
      moveTried.set(key, Date.now());
      noteMove({ kind: 'unchecked', from, to: r.to, reason: r.reason });
    }
    changed();
    return r.ok;
  })().finally(() => (moving = null));
  return moving;
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
// (Problems with the online sign-in found in the background, for the account page.)
let onlineNote = null;
// (Off in the tests: no sync or notification polling started by a sign-in.)
let background = true;

const oauthClients = require('./oauthClients.cjs');
const clientId = (provider) => (provider === 'microsoft' ? oauthClients.clients().microsoft.id : oauthClients.clients().google.id);
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
    account: a ? { id: a.id, email: a.email, name: a.name, linked: !!a.hub, provider: a.hub?.provider || null } : null,
    known: accounts().list().map((x) => ({ email: x.email, name: x.name })),
    providers: providers(),
    // (A sign-in waiting for the terms or the owner's code: the page shows that step again after a reload.)
    pending: pending && Date.now() - pending.at < PENDING_MS ? { email: pending.email, name: pending.name || null, provider: pending.provider, ...(pending.code ? { code: true } : {}) } : null,
    onlineNote: state === 'linked' ? onlineNote : null,
    signedIn: token,
    reachable: reach.reachable,
    checked: reach.at > 0,
    me: token && reach.reachable ? lastMe : null,
    moved: movedNote(),
    // The name, phone and who sees it (what Kea last saw, with a change that waits for the server on top), and whether
    // the small "your name and phone" card is due (once, after the first sign-in here).
    profile: token ? profileHere() : null,
    profileNote: token ? profileNote : null,
    askProfile: token && !!cached()?.id && askedState().ask === cached().id,
    // The Kea account server said this Kea is too old (426): { error, minVersion, updateUrl }; the page offers Update.
    tooOld: accountTooOld(),
  };
}
function accountTooOld() {
  try {
    const t = versions().get().tooOld;
    return t && t.from === 'account' ? { error: t.error, minVersion: t.minVersion, updateUrl: t.updateUrl } : null;
  } catch {
    return null;
  }
}
function profileHere() {
  const c = cached();
  const base = (lastMe && profileOf(lastMe)) || c?.profile || (c ? { name: c.name || '', phone: null, phoneShare: { ...SHARE_DEFAULTS } } : null);
  if (!base) return null;
  const q = c?.id && profileQueue()[c.id]?.patch;
  if (!q) return { ...base, queued: false };
  return { name: q.name ?? base.name, phone: 'phone' in q ? q.phone : base.phone, phoneShare: { ...base.phoneShare, ...(q.phoneShare || {}) }, queued: true };
}

/** An online sign-in's answer (Hub 0.5: { token, account }; the Kea account server: { token, me }). */
const onlineAccountOf = (r) => r?.account || r?.me?.account || null;
/**
 * After any online sign-in: keep the session, and the account on this computer for that email (made if there's none,
 * linked to the online one, signed in). Any other account's online session here ends (one account at a time).
 */
async function signedIn(r, { provider = null } = {}) {
  const acc = onlineAccountOf(r);
  const was = accounts().active();
  if (was && acc && core.norm(was.email) !== core.norm(acc.email)) dropSession();
  writeToken(r.token);
  onlineNote = null;
  // (Signed in at the address the server moved to: its notice has done its job.)
  if (movedNote()?.kind === 'moved' && movedNote().to === hubUrl()) fs.rmSync(movedFile(), { force: true });
  if (acc) accounts().attachOnline({ email: acc.email, name: acc.displayName, hubId: acc.id, url: hubUrl(), provider });
  if (acc?.id) askProfileFor(acc.id);
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
  const me = await flushProfile(await req('GET', '/v1/me', undefined, { timeout }), { timeout });
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
let healthAt = 0;
/** What local() says, after checking the server in the background (4 s at most). */
async function status({ again = true } = {}) {
  if (!readToken()) {
    let h = null;
    try {
      h = await req('GET', '/v1/health', undefined, { auth: false, timeout: LIMITS.status });
    } catch {}
    // The server moved: checked, followed, and the new address asked in turn.
    if (h && 'movedTo' in h && (await followMove(h)) && again) return status({ again: false });
    return local();
  }
  // The newest Kea the server knows of (at most hourly; an older server doesn't say), for "Update available" when
  // GitHub can't be reached from here.
  if (Date.now() - healthAt > 3600e3) {
    healthAt = Date.now();
    req('GET', '/v1/health', undefined, { auth: false, timeout: LIMITS.status }).catch(() => {});
  }
  try {
    return await refresh({ timeout: LIMITS.status });
  } catch (e) {
    if (e.data?.moved && again) return status({ again: false });
    // Offline, the session ended, or the server moved somewhere Kea couldn't check: still signed in here, working from
    // what Kea last knew.
    if (e.status === 0 || e.status === 401 || e.status === 410 || e.status === 426) return local();
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
  profileNote = null;
}

// ---------- Signing in ----------
// No passwords: a Kea account signs in with Google or Microsoft, and only then is it made. Nothing makes one here.
/**
 * An account already on this computer (signed out here before), opened again with no connection needed. Never makes
 * one: an email with no account here is refused.
 */
function openHere({ email }) {
  try {
    pending = null;
    const was = accounts().active();
    if (readToken() && (!was || core.norm(was.email) !== core.norm(email))) dropSession();
    accounts().reopen({ email });
  } catch (e) {
    throw new HubError(e.message, e.noAccount ? 404 : 400, { field: e.field || null, noAccount: !!e.noAccount });
  }
  onlineNote = null;
  return local();
}
/** Before a Google or Microsoft sign-in: the Kea account server must answer (a few seconds at most), or nothing starts. */
async function serverAnswers() {
  try {
    await req('GET', '/v1/health', undefined, { auth: false, timeout: LIMITS.status });
  } catch (e) {
    if (e.status === 0) throw new HubError(SIGNIN_WAITS, 0, { unreachable: true });
  }
}

// A Google or Microsoft sign-in waiting for one more thing: the terms (the first sign-in makes the account) or, for the
// owner's account only, its two-step code. Its ID token stays here in the main process (never sent to the page) for a
// few minutes and goes again with that; the Kea account server uses it up only when it signs in.
let pending = null;
const PENDING_MS = 10 * 60e3;
/** Signing in with Google or Microsoft's ID token (Hub 0.5 knows Google at /v1/auth/google). */
function oauthLogin(provider, idToken, extra = {}) {
  return provider === 'google'
    ? req('POST', '/v1/auth/google', { idToken, ...extra }, { auth: false })
    : req('POST', '/v1/auth/oauth', { provider, idToken, ...extra }, { auth: false });
}
async function trySignIn(p, extra = {}) {
  let r;
  try {
    r = await oauthLogin(p.provider, p.idToken, extra);
  } catch (e) {
    if (e.status === 404 && e.data?.needsAccount) {
      pending = { ...p, email: e.data.email || p.email, name: e.data.name || null, at: Date.now() };
      throw new HubError(`Create your Kea account for ${pending.email}: agree to the terms first.`, 404, { needsAccount: true, email: pending.email, name: pending.name });
    }
    if (e.data?.totpRequired) {
      pending = { ...p, code: true, at: Date.now() };
      throw e;
    }
    pending = null;
    // (An older Kea account server that can't make accounts this way.)
    if (e.status === 404) throw new HubError(`There’s no online Kea account for ${p.email || 'that email'} yet.`, 404, { noAccount: true });
    throw e;
  }
  pending = null;
  return signedIn(r, { provider: p.provider });
}
/**
 * Sign in with Google or Microsoft: signs in to the online Kea account for that email, made now if there's none (the
 * page then shows the terms, and continueSignIn finishes). Only once the Kea account server answers: otherwise nothing
 * opens and nothing is made. The account on this computer with the same email is linked (kept here when it's new);
 * nothing here is deleted, and everything already on this computer stays. `expect`: the email of the account signed
 * in here, going online: a different email never links, and then nothing is sent and nothing here changes.
 */
async function oauthSignIn({ provider = 'google', expect = null } = {}) {
  const label = core.PROVIDERS[provider]?.label;
  if (!label) throw new HubError('Pick Google or Microsoft.', 400);
  pending = null;
  if (!idTokenFn && !clientId(provider)) throw new HubError(NOT_SET_UP, 503, { notSetUp: true });
  await serverAnswers();
  const idToken = await idTokenFor(provider, expect || undefined);
  const who = core.idTokenEmail(idToken);
  if (expect) {
    const d = core.linkDecision({ email: expect }, who.email);
    if (!d.link)
      throw new HubError(
        d.reason === 'differentEmail' ? `That ${label} account is ${d.providerEmail}, not ${d.accountEmail}. A different email never links to this account, and nothing here changed.` : `${label} didn’t say which email it is. Try again.`,
        409,
        { mismatch: true, ...d }
      );
  }
  return trySignIn({ provider, idToken, email: who.email, expect });
}
/** The account on this computer goes online (or signs in online again): Continue with Google or Microsoft, same email. */
function link({ provider = 'google' } = {}) {
  const rec = accounts().active();
  if (!rec) throw new HubError('Sign in on this computer first.', 401);
  return oauthSignIn({ provider, expect: rec.email });
}
/** The waiting sign-in, finished: with the terms agreed (a new account), or the owner's two-step code. */
async function continueSignIn({ code, termsVersion, termsSections, age13, name } = {}) {
  const p = pending;
  if (!p || Date.now() - p.at > PENDING_MS) {
    pending = null;
    throw new HubError('That sign-in timed out. Sign in with Google again.', 408, { expired: true });
  }
  if (code) {
    try {
      return await trySignIn(p, { code: String(code).trim() });
    } catch (e) {
      // (A Kea Hub 0.5 uses the Google sign-in up before it asks for the code: one more sign-in, the code with it.)
      if (!(e.status === 401 && /already used/i.test(e.message))) throw e;
      return trySignIn({ ...p, idToken: await idTokenFor(p.provider, p.email || undefined) }, { code: String(code).trim() });
    }
  }
  if (age13 !== true) throw new HubError('Kea accounts are for people 13 and older.', 400, { field: 'age13' });
  return trySignIn(p, { termsVersion, termsSections, age13: true, ...(name ? { name: String(name).trim().slice(0, 60) } : {}) });
}
/** A fresh Google or Microsoft sign-in with this account's email, for what the server asks it for (sign out others, delete). */
async function freshProof(provider) {
  const p = provider === 'microsoft' ? 'microsoft' : 'google';
  return { provider: p, idToken: await idTokenFor(p, cached()?.email) };
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
const NOT_SET_UP = 'Sign-in isn’t available in this copy of Kea. Everything on this computer still works.';
let pendingOauth = null;
// (Tests answer with their own ID tokens instead of opening a browser.)
let idTokenFn = null;
const idTokenFor = (provider, loginHint) => (idTokenFn ? idTokenFn(provider, loginHint) : oauthIdToken(provider, loginHint));
const googleIdToken = (loginHint) => idTokenFor('google', loginHint);
function oauthIdToken(provider, loginHint) {
  const P = core.PROVIDERS[provider];
  const id = clientId(provider);
  const secret = provider === 'google' ? oauthClients.clients().google.secret : '';
  if (!P || !id) return Promise.reject(new HubError(NOT_SET_UP, 503, { notSetUp: true }));
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
  if (!me || !isSignedIn()) throw new HubError('Sign in with Google to use Kea’s shared Claude. Your own Claude works without an account.', 401, { needsOnline: true });
  const profile = profiles.all().list.find((p) => p.id === profiles.active())?.name || 'School';
  const course = { school: info.host, code: 'all-classes', term: new Date().toISOString().slice(0, 7), section: me.id };
  const r = await req('POST', '/v1/scan', { kind: 'initial_scan', course, ...targetArg() }).catch(limitError);
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
  if (!me || !isSignedIn()) throw new HubError('Sign in with Google to use Kea’s shared Claude. Your own Claude works without an account.', 401, { needsOnline: true });
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
  }).catch(limitError);
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

// ---------- When the shared Claude says no: which limit, when it opens again, and the person's own Claude ----------
/** A refusal's sentence for the person: the server's words, with the reset time in this PC's time, and a pointer to their own Claude. */
function sharedClaudeMessage(e) {
  const d = e?.data || {};
  let msg = String(e?.message || 'Kea’s shared Claude couldn’t do that.');
  if (!(e?.status === 429 || (e?.status === 503 && d.code))) return msg;
  const at = Number(d.retryAt);
  if (Number.isFinite(at) && at > Date.now()) {
    const when = new Date(at);
    const sameDay = when.toDateString() === new Date().toDateString();
    const t = when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const label = sameDay ? `at ${t}` : `${when.toLocaleDateString([], { weekday: 'long' })} at ${t}`;
    if (/at midnight UTC/.test(msg)) msg = msg.replace(/at midnight UTC/, label);
    else msg = `${msg} It opens again ${label}.`;
  }
  if (!/own Claude/.test(msg)) msg = `${msg} Or use your own Claude: Settings → Claude Assistant.`;
  return msg;
}
/** Re-throws a shared-Claude refusal with the person's sentence (the limit's name stays in data.limit). */
function limitError(e) {
  if (e instanceof HubError && (e.status === 429 || (e.status === 503 && e.data?.code))) throw new HubError(sharedClaudeMessage(e), e.status, e.data);
  throw e;
}

// ---------- Teach lessons through Kea's shared Claude (scholar/teach.cjs) ----------
/**
 * Asks for a lesson (or a follow-up) and reads it as it's written: onText(piece) for each new piece. Resolves
 * { text, model } when it's done, or { text, stopped: true } when stopped() turned true (it's cancelled on the server).
 * A refusal throws a HubError (status 429 or 503, data.limit names the limit).
 */
async function requestTeach(body, onText = () => {}, { stopped = () => false, waitMs = 15_000 } = {}) {
  const me = cached();
  if (!me || !isSignedIn()) throw new HubError('Sign in to your Kea account to use Kea’s shared Claude, or use your own Claude: Settings → Claude Assistant.', 401, { needsOnline: true });
  const started = await req('POST', '/v1/teach', body);
  const id = encodeURIComponent(started.job.id);
  let text = '';
  let offlineSince = 0;
  for (;;) {
    if (stopped()) {
      await req('POST', `/v1/teach/${id}/cancel`, {}).catch(() => {});
      return { text, stopped: true };
    }
    let j;
    try {
      j = (await req('GET', `/v1/teach/${id}?since=${text.length}&wait=${waitMs}`, undefined, { timeout: waitMs + 10_000 })).job;
      offlineSince = 0;
    } catch (e) {
      if (e.status !== 0) throw e;
      offlineSince ||= Date.now();
      if (Date.now() - offlineSince > 120_000) throw new HubError('Kea lost the connection to your Kea account while the lesson was being written. Try again.', 0);
      await sleep(2000);
      continue;
    }
    if (j.text) {
      text += j.text;
      onText(j.text);
    }
    if (j.status === 'done') {
      // (The finished lesson, whole, when what came in pieces differs from it.)
      if (j.length !== text.length) text = (await req('GET', `/v1/teach/${id}?since=0`)).job.text;
      return { text, model: j.model };
    }
    if (j.status === 'failed') throw new HubError(j.error || 'Kea’s shared Claude couldn’t write this lesson. Try again.', 502);
    if (j.status === 'cancelled') return { text, stopped: true };
  }
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
    // (backends: this Kea runs jobs on the owner's API credits or plan, scholar/backend.cjs; an account server that
    // knows backends sends each job with one.)
    job = (await call('/owner/scan/next', { backends: require('./scholar/backend.cjs').BACKENDS })).job;
  } catch {
    return; // the Hub isn't running here
  }
  if (!job) return;
  const task = { initial_scan: 'import', update_scan: 'sync', more_questions: 'more_questions' }[job.kind];
  if (!task) return void call(`/owner/scan/${job.id}/finish`, { ok: false, note: `This Kea doesn’t run "${job.kind}" jobs for Kea’s shared Claude.` });
  // Only on the locked model for its kind (scholar/usage.cjs): a job naming another model is refused, never run.
  try {
    require('./scholar/usage.cjs').checkJob(job);
  } catch (e) {
    return void call(`/owner/scan/${job.id}/finish`, { ok: false, note: e.message });
  }
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

// ---------- The owner's Kea writes Teach lessons for others (scholar/teach.cjs writeShared) ----------
// Only on the Kea owner's PC (signed in as the owner, with the owner key from KeaS's setup), while this Kea runs. It
// asks the account server for a lesson (waiting up to 15 s at a time, so one is taken within moments), writes it with
// Sonnet and no tools, posts the text as it comes, and reports what it used. Lessons run beside a scan: they're small.
// Settings → Kea's shared Claude → Kea owner: write Teach lessons for others (hub.teachWorker) turns it off.
/** The owner console's caller, or null when this isn't the owner's PC. */
function ownerCaller() {
  const keyFile = ownerKeyFile();
  if (!keyFile) return null;
  const port = Number(settings.get('hub.ownerPort', 4861)) || 4861;
  const key = fs.readFileSync(keyFile, 'utf8').trim();
  return (p, body) => require('./ownerauth.cjs').ownerFetch(`http://127.0.0.1:${port}`, key, 'POST', p, { body: JSON.stringify(body || {}), headers: { 'content-type': 'application/json' }, fetchFn: net.fetch }).then((r) => r.json());
}
const teachState = { running: null, last: null, written: 0 };
/**
 * One turn of the lesson writer: takes the next lesson (waiting up to `wait` ms) and writes it. Answers the job, null
 * when there was none, or 'unsupported' when the account server doesn't hand out lessons (an older one).
 */
async function teachOnce(call, { wait = 15_000, ...opts } = {}) {
  const r = await call('/owner/teach/next', { wait, backends: require('./scholar/backend.cjs').BACKENDS });
  if (!r || !('job' in r)) return 'unsupported';
  const job = r.job;
  if (!job) return null;
  const id = encodeURIComponent(job.id);
  teachState.running = { id: job.id, startedAt: Date.now() };
  try {
    // (The owner's API key, for a lesson on API credits: asked for over the owner console for this lesson only.)
    const apiKey = () => call(`/owner/teach/${id}/api-key`, {}).then((a) => a?.key || null);
    const out = await require('./scholar/teach.cjs').writeShared(job, { apiKey, ...opts, progress: (text) => call(`/owner/teach/${id}/progress`, { text }) });
    // (run: where it ran, for the account server only: backend, fallback, refused, ownerNote, usageByBackend.)
    await call(`/owner/teach/${id}/finish`, { ok: out.ok, ...(out.ok ? { text: out.text } : { error: out.error }), ...(out.usage ? { usage: out.usage } : {}), ...(out.run || {}) });
    teachState.last = { id: job.id, ok: out.ok, at: Date.now() };
    if (out.ok) teachState.written++;
  } finally {
    teachState.running = null;
  }
  return job;
}
let teachLooping = false;
async function teachLoop() {
  if (teachLooping || process.env.KEA_WORKER_JOB) return;
  teachLooping = true;
  try {
    for (;;) {
      const call = cached()?.owner && settings.get('hub.teachWorker', true) !== false ? ownerCaller() : null;
      if (!call) {
        await sleep(60_000);
        continue;
      }
      let r;
      try {
        r = await teachOnce(call);
      } catch {
        r = 'error'; // (the account server isn't running here, or a lesson failed to report)
      }
      if (r === 'unsupported') await sleep(10 * 60_000);
      else if (r === 'error') await sleep(30_000);
    }
  } finally {
    teachLooping = false;
  }
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
      syncState.offline = !e.status; // (Kea cloud shows "offline" rather than an error)
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
  // Classes and Kea cloud documents both follow the one choice: nothing to mirror unless it's a server.
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
  setTimeout(teachLoop, 20_000);
  handleApp(ipcMain, 'hub:syncNow', wrap(async () => (await startSync(), await syncNow(), { ...syncState })));
  // Who's signed in, from this computer alone (at once), and after a background check of the server (4 s at most).
  handleApp(ipcMain, 'hub:local', wrap(() => local()));
  handleApp(ipcMain, 'hub:status', wrap(() => status()));
  // Opening an account already on this computer again (no connection needed; never makes one), Sign in with Google or
  // Microsoft (makes the account, or signs in to it), taking an account here online, and finishing a sign-in that
  // waits for the terms or the owner's code.
  handleApp(ipcMain, 'hub:openHere', wrap((a) => openHere(a)));
  handleApp(ipcMain, 'hub:oauthSignIn', wrap((a) => oauthSignIn({ provider: a.provider })));
  handleApp(ipcMain, 'hub:link', wrap((a) => link(a)));
  handleApp(ipcMain, 'hub:continueSignIn', wrap((a) => continueSignIn(a)));
  handleApp(ipcMain, 'hub:cancelSignIn', wrap(() => ((pending = null), local())));
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
  // The name, the optional phone number and who sees it (PATCH /v1/me; saved later when the server can't be reached),
  // and the "your name and phone" card after the first sign-in, done (saved or skipped).
  handleApp(ipcMain, 'hub:saveProfile', wrap((a) => saveProfile(a)));
  handleApp(ipcMain, 'hub:profileAsked', wrap(() => profileAsked()));
  handleApp(ipcMain, 'hub:consentRequest', wrap((a) => req('POST', '/v1/me/consent', { parentEmail: a.parentEmail })));
  handleApp(ipcMain, 'hub:consentGoogle', wrap(async () => {
    const c = await req('GET', '/v1/me/consent');
    if (c.parentSignOff !== 'pending' || !c.parentEmail) throw new HubError('Enter your parent’s or guardian’s email first.', 400);
    await req('POST', '/v1/me/consent/google', { idToken: await googleIdToken(c.parentEmail) });
    return refresh();
  }));
  handleApp(ipcMain, 'hub:accept', wrap(async (a) => (await req('POST', '/v1/terms/accept', { termsVersion: a.termsVersion, termsSections: a.termsSections }), refresh())));
  // The account page: signed-in devices, the data download, deleting the account (those two ask for a fresh Google or
  // Microsoft sign-in with the account's email). The name of an email-only account from an older Kea, not online yet,
  // changes here (online, the name goes with hub:saveProfile).
  handleApp(ipcMain, 'hub:setName', wrap(async (a) => {
    const name = String(a.name ?? '').trim();
    const rec = accounts().active();
    if (!rec) throw new HubError('Sign in first.', 401);
    if (isSignedIn() || rec.hub) throw new HubError('Sign in with Google to change your name.', 401, { needsOnline: true });
    if (!name) throw new HubError('Add your name.', 400);
    accounts().setName(rec.id, name);
    return local();
  }));
  handleApp(ipcMain, 'hub:sessions', wrap(() => req('GET', '/v1/me/sessions')));
  handleApp(ipcMain, 'hub:signOutOthers', wrap(async (a) => req('POST', '/v1/me/sessions/sign-out-others', await freshProof(a?.provider), { reauth: true })));
  handleApp(ipcMain, 'hub:exportData', wrap(() => exportData()));
  handleApp(ipcMain, 'hub:deleteAccount', wrap(async (a) => {
    const id = cached()?.id;
    if (a.confirm !== 'DELETE') throw new HubError('Type DELETE to confirm.', 400, { field: 'confirm' });
    await req('POST', '/v1/me/delete', { confirm: a.confirm, ...(await freshProof(a.provider)) }, { reauth: true });
    dropSession();
    // (The account was deleted on request: it goes from this computer too, with its picture.)
    const rec = accounts().active();
    if (rec) accounts().remove(rec.id);
    require('./account.cjs').forget(id, rec?.id);
    return local();
  }));
  // Signing out: Kea goes on without an account. The online session ends; the account stays on this computer, so it
  // can be opened again here, also offline. Nothing else on this computer is removed.
  handleApp(ipcMain, 'hub:logout', wrap(async () => {
    pending = null;
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
  // The notice that the server moved was seen.
  handleApp(ipcMain, 'hub:movedSeen', wrap(() => movedSeen()));
  // (Only Kea's own page may move Kea to another server: ipcGuard.cjs.) An online sign-in belongs to the server it was
  // made on, so it never goes to a different address: moving there ends the online session here (moveHub). The account
  // on this computer stays signed in.
  // A new address is used only once a Kea Hub answers there. Moving to another Hub while signed in signs out here, so
  // that's only done once the page has asked (confirm: true); until then it answers 409 { switchSignsOut }.
  ipcMain.handle('hub:setUrl', appOnly(wrap(async ({ url, confirm }) => {
    const next = String(url || '').trim() ? serverOrigin(url) : null;
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
  _teach: { teachOnce, teachState },
  requestTeach, sharedClaudeMessage,
  _exportData: exportData,
  // (For the tests: the account flows without IPC, and stand-ins for fetch and the browser sign-in.)
  _account: {
    local, status, openHere, link, oauthSignIn, continueSignIn, movedSeen, saveProfile, profileAsked, profileOf, logout: () => (dropSession(), accounts().signOut(), local()),
    signOutOthers: async (a) => req('POST', '/v1/me/sessions/sign-out-others', await freshProof(a?.provider), { reauth: true }),
    setFetch: (f) => (fetchFn = f),
    setVersions: (v) => (versions = () => v),
    setIdTokens: (f) => (idTokenFn = f),
    reset: () => ((store = null), (lastMe = null), (onlineNote = null), (profileNote = null), (pending = null), moveTried.clear(), Object.assign(reach, { reachable: false, at: 0 })),
    setLimits: (l) => Object.assign(LIMITS, l),
    setBackground: (on) => (background = on),
  },
  current: () => activeAccount(),
  register, cached, req, signedIn: isSignedIn, syncRoot, syncNow, url: hubUrl, refreshStatus: status, DEFAULT_HUB_URL, syncState: () => ({ ...syncState }), startSync, restartSync, _token: readToken };
