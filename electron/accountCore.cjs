// The Kea account on this computer, without Electron: the accounts kept here, which one is signed in, whether a sign-in
// with Google or Microsoft links to it, and what the start screen shows. hub.cjs uses this with the files in Kea's
// userData folder; the tests use it with a scratch folder.
//
// There are no passwords. Online, a Kea account signs in with Google or Microsoft only. On this computer an account is
// just its email: typing it opens that account's things here at once (made the first time), with no connection. Once
// signed in, Kea stays signed in here (offline too) until the person signs out.
//
// offline-account.json:
//   { v: 2, active: <local id> | null,
//     accounts: { <local id>: { id, email, name, createdAt, lastSignIn, hub: { id, url, provider?, at } | null } } }
// An account made here is "offline" until a Google or Microsoft sign-in with the same email links it to the online
// Kea account (hub set). Accounts used before stay in the file: signing out only clears `active`.
// (Version 1 kept a scrypt verifier of a password with each account. Reading the file drops it, once; the accounts,
// their emails and everything kept for them stay.)
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FILE = 'offline-account.json';
const norm = (e) => String(e || '').trim().toLowerCase();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** The record as kept now: only these fields (an older file's verifier is left behind). */
const clean = (a) => ({ id: a.id, email: norm(a.email), name: String(a.name || '').slice(0, 60), createdAt: a.createdAt || null, lastSignIn: a.lastSignIn || null, hub: a.hub && typeof a.hub === 'object' && a.hub.id ? { id: a.hub.id, url: a.hub.url, provider: a.hub.provider || null, at: a.hub.at || null } : null });

// ---------- The accounts kept here ----------
function createStore(dir, { now = Date.now } = {}) {
  const file = path.join(dir, FILE);
  const empty = () => ({ v: 2, active: null, accounts: {} });
  function write(s) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(s, null, 1));
    fs.renameSync(file + '.tmp', file);
  }
  function read() {
    let j;
    try {
      j = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return empty();
    }
    if (!j || typeof j !== 'object' || typeof j.accounts !== 'object' || !j.accounts) return empty();
    const accounts = {};
    for (const [id, a] of Object.entries(j.accounts)) if (a && typeof a === 'object' && EMAIL.test(norm(a.email))) accounts[id] = clean({ ...a, id });
    const s = { v: 2, active: typeof j.active === 'string' && accounts[j.active] ? j.active : null, accounts };
    // (An older file: written again at once without its verifiers.)
    if (j.v !== 2 || Object.values(j.accounts).some((a) => a && 'verifier' in a)) {
      try {
        write(s);
      } catch {}
    }
    return s;
  }
  const update = (fn) => {
    const s = read();
    const out = fn(s);
    write(s);
    return out;
  };
  const byEmail = (s, email) => Object.values(s.accounts).find((a) => norm(a.email) === norm(email)) || null;
  const pub = (a) => (a ? { id: a.id, email: a.email, name: a.name || '', createdAt: a.createdAt, lastSignIn: a.lastSignIn || null, hub: a.hub ? { id: a.hub.id, url: a.hub.url, provider: a.hub.provider || null } : null } : null);
  const newId = () => `loc_${crypto.randomBytes(12).toString('base64url')}`;

  return {
    file,
    read,
    /** The account signed in on this computer now, or null. */
    active() {
      const s = read();
      return pub(s.active ? s.accounts[s.active] : null);
    },
    get(id) {
      return pub(read().accounts[id]);
    },
    find(email) {
      return pub(byEmail(read(), email));
    },
    /** Every account used here, most recent first (for "accounts on this computer"). */
    list() {
      return Object.values(read().accounts)
        .sort((a, b) => (b.lastSignIn || b.createdAt || 0) - (a.lastSignIn || a.createdAt || 0))
        .map(pub);
    },
    /**
     * Using Kea on this computer with just an email: the account kept here for it is signed in (its things here open
     * again), or one is made, at once. No connection needed. Returns { account, created }.
     */
    open({ email, name }) {
      const e = norm(email);
      if (!EMAIL.test(e)) throw Object.assign(new Error('Add your email address.'), { field: 'email' });
      return update((s) => {
        let a = byEmail(s, e);
        const created = !a;
        if (!a) {
          a = { id: newId(), email: e, name: String(name || '').trim().slice(0, 60), createdAt: now(), lastSignIn: null, hub: null };
          s.accounts[a.id] = a;
        }
        a.lastSignIn = now();
        s.active = a.id;
        return { account: pub(a), created };
      });
    },
    activate(id) {
      return update((s) => {
        if (!s.accounts[id]) throw new Error('That account isn’t on this computer.');
        s.active = id;
        s.accounts[id].lastSignIn = now();
        return pub(s.accounts[id]);
      });
    },
    /** Signed out here: the account stays, so typing its email opens it again (also offline). */
    signOut() {
      update((s) => void (s.active = null));
    },
    setName(id, name) {
      return update((s) => {
        if (s.accounts[id]) s.accounts[id].name = String(name || '').trim().slice(0, 60);
        return pub(s.accounts[id]);
      });
    },
    /**
     * After a sign-in to an online Kea account (Google or Microsoft): the account kept here for that email (made if
     * there's none), linked to the online one and signed in. Nothing else about the account here changes.
     */
    attachOnline({ email, name, hubId, url, provider = null }) {
      return update((s) => {
        let a = byEmail(s, email);
        if (!a) {
          a = { id: newId(), email: norm(email), name: String(name || '').trim().slice(0, 60), createdAt: now(), hub: null };
          s.accounts[a.id] = a;
        }
        if (name && !a.name) a.name = String(name).trim().slice(0, 60);
        a.hub = { id: hubId, url, provider: provider || a.hub?.provider || null, at: now() };
        a.lastSignIn = now();
        s.active = a.id;
        return pub(a);
      });
    },
    /** The online account was deleted: it goes from this computer too. */
    remove(id) {
      update((s) => {
        delete s.accounts[id];
        if (s.active === id) s.active = null;
      });
    },
  };
}

// ---------- Linking ----------
/** The email in an ID token's payload (not checked here: the Kea account server checks the token itself). */
function idTokenEmail(idToken) {
  try {
    const p = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8'));
    return { email: norm(p.email || p.preferred_username || p.upn || ''), name: p.name || null };
  } catch {
    return { email: '', name: null };
  }
}
/**
 * Whether a Google or Microsoft sign-in may link to this account: only when it is the same email. A different email
 * never links; the account here and everything on this computer stay as they are.
 */
function linkDecision(account, providerEmail) {
  if (!account) return { link: false, reason: 'noAccount' };
  const want = norm(account.email), got = norm(providerEmail);
  if (!got) return { link: false, reason: 'noEmail' };
  if (got !== want) return { link: false, reason: 'differentEmail', accountEmail: want, providerEmail: got };
  return { link: true, reason: account.hub ? 'relink' : 'link' };
}

// ---------- What the start screen and the rest of Kea show ----------
/**
 * The account state, from what's on this computer only (never the network):
 *   none    no account signed in here: the start screen (sign in, or make an account) shows;
 *   offline an account made on this computer, not linked to an online Kea account: everything on this computer works,
 *           cloud features show "Needs your Kea account online";
 *   linked  an account linked to an online Kea account, signed in here without an online session (opened offline by
 *           its email, or the session ended): the same, with "Continue with Google" to sign in online again;
 *   online  signed in to the online Kea account here (whether or not it can be reached right now).
 */
function accountState({ active, hasToken }) {
  if (hasToken) return 'online';
  if (!active) return 'none';
  return active.hub ? 'linked' : 'offline';
}
/** The start screen shows only while no account is signed in; it never waits for the network. */
const gateOpen = (state) => state === 'none';

// ---------- Talking to a server, never waiting forever ----------
/** fetch with a time limit (the whole request, connecting included). A timeout throws { timeout: true }. */
async function timedFetch(fetchFn, url, opts = {}, ms = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetchFn(url, { ...opts, signal: ctl.signal });
    // (The body is read inside the time limit too: a server that sends headers and then stalls is unreachable.)
    // (A stand-in response with only json() works too.)
    let text = '', body;
    if (typeof res.text === 'function') text = await res.text();
    else body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, headers: res.headers, text, json: () => (body !== undefined ? body : text ? JSON.parse(text) : {}) };
  } catch (e) {
    if (ctl.signal.aborted) throw Object.assign(new Error('Timed out.'), { timeout: true });
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// ---------- Google and Microsoft sign-in (loopback + PKCE) ----------
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** A PKCE pair (RFC 7636, S256): the verifier stays here, the challenge goes in the sign-in address. */
function pkcePair() {
  const verifier = b64url(crypto.randomBytes(48));
  return { verifier, challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), method: 'S256' };
}
const PROVIDERS = {
  google: {
    label: 'Google',
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    redirectHost: '127.0.0.1',
    extra: { prompt: 'select_account' },
  },
  microsoft: {
    label: 'Microsoft',
    // (common: personal Microsoft accounts and work or school ones.)
    authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    // (Microsoft's app registrations take loopback redirects as http://localhost with any port.)
    redirectHost: 'localhost',
    extra: { prompt: 'select_account', response_mode: 'query' },
  },
};
const SCOPE = 'openid email profile';
/** The address that opens the provider's sign-in page. */
function authorizeUrl(provider, { clientId, port, challenge, state, loginHint, nonce }) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`Unknown sign-in: ${provider}`);
  const u = new URL(p.authorize);
  u.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `http://${p.redirectHost}:${port}`,
    response_type: 'code',
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    ...(nonce ? { nonce } : {}),
    ...p.extra,
    ...(loginHint ? { login_hint: loginHint } : {}),
  }).toString();
  return u.toString();
}
/** The form body that trades the code for tokens. */
function tokenRequest(provider, { clientId, clientSecret, code, verifier, port }) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`Unknown sign-in: ${provider}`);
  return {
    url: p.token,
    body: new URLSearchParams({
      code,
      client_id: clientId,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: `http://${p.redirectHost}:${port}`,
      ...(provider === 'microsoft' ? { scope: SCOPE } : {}),
    }).toString(),
  };
}

module.exports = { FILE, EMAIL, createStore, idTokenEmail, linkDecision, accountState, gateOpen, timedFetch, pkcePair, authorizeUrl, tokenRequest, PROVIDERS, norm };
