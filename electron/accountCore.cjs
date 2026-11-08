// The Kea account on this computer, without Electron: the password check, the accounts kept here, which one is signed
// in, whether a sign-in with Google or Microsoft links to it, and what the start screen shows. hub.cjs uses this with
// the files in Kea's userData folder; the tests use it with a scratch folder.
//
// offline-account.json (never a password, only a scrypt verifier of it):
//   { v: 1, active: <local id> | null,
//     accounts: { <local id>: { id, email, name, createdAt, lastSignIn, verifier | null,
//                               hub: { id, url, provider?, at } | null } } }
// An account made here is "offline" until it is linked to an online Kea account (hub set). A Kea account that was
// signed in online here is kept the same way, with a verifier of the password it was signed in with, so it can be
// signed in again offline. Accounts used before stay in the file: signing out only clears `active`.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FILE = 'offline-account.json';
const norm = (e) => String(e || '').trim().toLowerCase();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- The password verifier ----------
// scrypt with N = 2^17, r = 8, p = 1 (about 128 MB and a few hundred milliseconds), a 16-byte random salt and a 32-byte
// key. The parameters are kept with each verifier so they can be raised later without breaking older ones.
const STRONG = { N: 2 ** 17, r: 8, p: 1, keylen: 32 };
const scrypt = (password, salt, { N, r, p, keylen }) =>
  new Promise((resolve, reject) =>
    crypto.scrypt(String(password).normalize('NFKC'), salt, keylen, { N, r, p, maxmem: 256 * N * r + 32 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)))
  );
async function makeVerifier(password, params = STRONG) {
  if (typeof password !== 'string' || !password) throw new Error('Enter a password.');
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, params);
  return { alg: 'scrypt', N: params.N, r: params.r, p: params.p, keylen: params.keylen, salt: salt.toString('base64'), hash: key.toString('base64') };
}
/** Whether the password matches; constant-time, and false (never an error) for a missing or broken verifier. */
async function checkVerifier(password, v) {
  if (typeof password !== 'string' || !v || v.alg !== 'scrypt') return false;
  const want = Buffer.from(String(v.hash || ''), 'base64');
  const N = Number(v.N), r = Number(v.r), p = Number(v.p), keylen = Number(v.keylen);
  // (Only sane parameters: a changed file can't make Kea spend minutes or gigabytes on one check.)
  if (!want.length || keylen !== want.length || !(N >= 2 ** 10 && N <= 2 ** 20 && (N & (N - 1)) === 0) || !(r >= 1 && r <= 32) || !(p >= 1 && p <= 4)) return false;
  let got;
  try {
    got = await scrypt(password, Buffer.from(String(v.salt || ''), 'base64'), { N, r, p, keylen });
  } catch {
    return false;
  }
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
/** A verifier made with weaker settings than today's (it's made again at the next sign-in). */
const weak = (v) => !v || Number(v.N) < STRONG.N || Number(v.keylen) < STRONG.keylen;

/**
 * The Kea account server's rule (so the same password works when the account goes online): at least 10 characters,
 * not one repeated character, not the email or the name in it.
 */
function passwordProblem(password, email, name = '') {
  if (typeof password !== 'string' || !password) return 'Enter a password.';
  if ([...password].length < 10) return 'Use at least 10 characters. A few random words works well.';
  if (password.length > 256) return 'Use 256 characters or fewer.';
  const low = password.toLowerCase();
  if (/^(.)\1+$/.test(password)) return 'That password is one repeated character.';
  const local = norm(email).split('@')[0];
  if (local.length >= 4 && low.includes(local)) return 'Don’t use your email in your password.';
  const n = String(name || '').toLowerCase().replace(/\s+/g, '');
  if (n.length >= 4 && low.replace(/\s+/g, '').includes(n)) return 'Don’t use your name in your password.';
  return null;
}

// ---------- The accounts kept here ----------
function createStore(dir, { params = STRONG, now = Date.now } = {}) {
  const file = path.join(dir, FILE);
  const empty = () => ({ v: 1, active: null, accounts: {} });
  function read() {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!j || typeof j !== 'object' || typeof j.accounts !== 'object' || !j.accounts) return empty();
      return { v: 1, active: typeof j.active === 'string' && j.accounts[j.active] ? j.active : null, accounts: j.accounts };
    } catch {
      return empty();
    }
  }
  function write(s) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(s, null, 1));
    fs.renameSync(file + '.tmp', file);
  }
  const update = (fn) => {
    const s = read();
    const out = fn(s);
    write(s);
    return out;
  };
  const byEmail = (s, email) => Object.values(s.accounts).find((a) => norm(a.email) === norm(email)) || null;
  const pub = (a) => (a ? { id: a.id, email: a.email, name: a.name || '', createdAt: a.createdAt, lastSignIn: a.lastSignIn || null, canSignInOffline: !!a.verifier, hub: a.hub ? { id: a.hub.id, url: a.hub.url, provider: a.hub.provider || null } : null } : null);
  const newId = () => `loc_${crypto.randomBytes(12).toString('base64url')}`;

  return {
    file,
    read,
    /** The account signed in on this computer now (its record, verifier left out), or null. */
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
    /** A new account on this computer, made at once and signed in: no connection needed. */
    async create({ email, password, name }) {
      const e = norm(email);
      if (!EMAIL.test(e)) throw Object.assign(new Error('Add your email address.'), { field: 'email' });
      const problem = passwordProblem(password, e, name);
      if (problem) throw Object.assign(new Error(problem), { field: 'password' });
      if (byEmail(read(), e)) throw Object.assign(new Error('This computer already has a Kea account with this email. Sign in instead.'), { exists: true });
      const verifier = await makeVerifier(password, params);
      return update((s) => {
        if (byEmail(s, e)) throw Object.assign(new Error('This computer already has a Kea account with this email. Sign in instead.'), { exists: true });
        const a = { id: newId(), email: e, name: String(name || '').trim().slice(0, 60), createdAt: now(), lastSignIn: now(), verifier, hub: null };
        s.accounts[a.id] = a;
        s.active = a.id;
        return pub(a);
      });
    },
    /**
     * Signing in on this computer with the password: { ok: true, account } when it matches the verifier kept here;
     * otherwise { ok: false, reason: 'unknown' (no account with this email here) | 'noVerifier' (never signed in here
     * with a password) | 'wrong', account }.
     */
    async check({ email, password }) {
      const a = byEmail(read(), email);
      if (!a) return { ok: false, reason: 'unknown', account: null };
      if (!a.verifier) return { ok: false, reason: 'noVerifier', account: pub(a) };
      if (!(await checkVerifier(password, a.verifier))) return { ok: false, reason: 'wrong', account: pub(a) };
      return { ok: true, account: pub(a), weak: weak(a.verifier) };
    },
    async signIn({ email, password }) {
      const r = await this.check({ email, password });
      if (!r.ok) return r;
      if (r.weak) await this.setPassword(r.account.id, password);
      return { ok: true, account: this.activate(r.account.id) };
    },
    activate(id) {
      return update((s) => {
        if (!s.accounts[id]) throw new Error('That account isn’t on this computer.');
        s.active = id;
        s.accounts[id].lastSignIn = now();
        return pub(s.accounts[id]);
      });
    },
    /** Signed out here: the account and its verifier stay, so it can sign in again (also offline). */
    signOut() {
      update((s) => void (s.active = null));
    },
    async setPassword(id, password) {
      const verifier = await makeVerifier(password, params);
      return update((s) => {
        if (!s.accounts[id]) throw new Error('That account isn’t on this computer.');
        s.accounts[id].verifier = verifier;
        return pub(s.accounts[id]);
      });
    },
    setName(id, name) {
      return update((s) => {
        if (s.accounts[id]) s.accounts[id].name = String(name || '').trim().slice(0, 60);
        return pub(s.accounts[id]);
      });
    },
    /**
     * After a sign-in to an online Kea account (password, Google or Microsoft): the account kept here for that email
     * (made if there's none), linked to the online one and signed in. `password`: the one just used online, kept as
     * a verifier so it signs in offline later. Nothing else about the account here changes.
     */
    async rememberOnline({ password = null, ...rest }) {
      return this.attachOnline({ ...rest, verifier: password ? await makeVerifier(password, params) : null });
    },
    /** rememberOnline with the verifier already made (or none): no waiting, for the first start after an update. */
    attachOnline({ email, name, hubId, url, provider = null, verifier = null }) {
      return update((s) => {
        let a = byEmail(s, email);
        if (!a) {
          a = { id: newId(), email: norm(email), name: String(name || '').trim().slice(0, 60), createdAt: now(), verifier: null, hub: null };
          s.accounts[a.id] = a;
        }
        if (name && !a.name) a.name = String(name).trim().slice(0, 60);
        if (verifier) a.verifier = verifier;
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
 *   linked  an account linked to an online Kea account, signed in here without an online session (offline sign-in,
 *           or the session ended): the same, with "Sign in online";
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

module.exports = { FILE, STRONG, makeVerifier, checkVerifier, passwordProblem, createStore, idTokenEmail, linkDecision, accountState, gateOpen, timedFetch, pkcePair, authorizeUrl, tokenRequest, PROVIDERS, norm };
