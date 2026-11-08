// The Kea account on the phone, without Android: the password check, the accounts kept on this phone, which one is
// signed in, whether a Google or Microsoft sign-in links to it, the account state, and the Google and Microsoft
// sign-in addresses (PKCE). account.ts uses this with the phone's encrypted storage; the tests use it with a stand-in.
// The same model as Kea on the computer (electron/accountCore.cjs).
//
// The stored record (kept by native code in Android's encrypted storage, never a password, only a verifier of it):
//   { v: 1, active: <local id> | null,
//     accounts: { <local id>: { id, email, name, createdAt, lastSignIn, verifier | null,
//                               hub: { id, url, provider?, at } | null } } }
// An account made here is "offline" until it is linked to an online Kea account (hub set). A Kea account signed in
// online here is kept the same way, with a verifier of the password it was signed in with, so it can be signed in
// again offline. Accounts used before stay: signing out only clears `active`.
//
// (Only erasable TypeScript here: Node runs this file as it is in the tests.)

/** The Kea account server's address, built in. Empty until it has one; then the address under Advanced is used. */
export const DEFAULT_ACCOUNT_URL = '';

export const norm = (e: unknown) =>
  String(e || '')
    .trim()
    .toLowerCase();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- bytes ----------
const subtle = () => {
  const s = (globalThis as any).crypto?.subtle;
  if (!s) throw new Error('This phone’s browser can’t check passwords.');
  return s as SubtleCrypto;
};
export const randomBytes = (n: number) => (globalThis as any).crypto.getRandomValues(new Uint8Array(n)) as Uint8Array;
export function toB64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}
export function fromB64(s: string): Uint8Array {
  const bin = atob(String(s || '').replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export const b64url = (b: Uint8Array) => toB64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ---------- The password verifier ----------
// PBKDF2-HMAC-SHA256 through the phone's WebCrypto (BoringSSL in Android's WebView), 600,000 iterations, a 16-byte
// random salt and a 32-byte key. (Kea on the computer uses scrypt; the phone has no vetted scrypt: Android's own crypto
// doesn't offer it and none is among Kea's packages, and scrypt at Kea's strength needs 128 MB inside the app. A
// verifier never leaves the device it was made on, so the two needn't match.) The settings are kept with each
// verifier so they can be raised later without breaking older ones.
export interface Verifier {
  alg: 'pbkdf2-sha256';
  iter: number;
  keylen: number;
  salt: string;
  hash: string;
}
export interface VerifierParams {
  iter: number;
  keylen: number;
}
export const STRONG: VerifierParams = { iter: 600_000, keylen: 32 };

async function pbkdf2(password: string, salt: Uint8Array, { iter, keylen }: VerifierParams): Promise<Uint8Array> {
  const s = subtle();
  const key = await s.importKey('raw', new TextEncoder().encode(String(password).normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await s.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: iter }, key, keylen * 8));
}
export async function makeVerifier(password: string, params: VerifierParams = STRONG): Promise<Verifier> {
  if (typeof password !== 'string' || !password) throw new Error('Enter a password.');
  const salt = randomBytes(16);
  const key = await pbkdf2(password, salt, params);
  return { alg: 'pbkdf2-sha256', iter: params.iter, keylen: params.keylen, salt: toB64(salt), hash: toB64(key) };
}
const same = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
};
/** Whether the password matches; constant-time, and false (never an error) for a missing or broken verifier. */
export async function checkVerifier(password: string, v: any): Promise<boolean> {
  if (typeof password !== 'string' || !v || v.alg !== 'pbkdf2-sha256') return false;
  let want: Uint8Array, salt: Uint8Array;
  try {
    want = fromB64(String(v.hash || ''));
    salt = fromB64(String(v.salt || ''));
  } catch {
    return false;
  }
  const iter = Number(v.iter),
    keylen = Number(v.keylen);
  // (Only sane settings: a changed record can't make Kea spend minutes on one check.)
  if (!want.length || keylen !== want.length || !(keylen >= 16 && keylen <= 64) || !(Number.isInteger(iter) && iter >= 1000 && iter <= 5_000_000) || !salt.length) return false;
  try {
    return same(await pbkdf2(password, salt, { iter, keylen }), want);
  } catch {
    return false;
  }
}
/** A verifier made with weaker settings than today's (it's made again at the next sign-in). */
export const weak = (v: any, strong: VerifierParams = STRONG) => !v || Number(v.iter) < strong.iter || Number(v.keylen) < strong.keylen;

/**
 * The Kea account server's rule (so the same password works when the account goes online): at least 10 characters,
 * not one repeated character, not the email or the name in it.
 */
export function passwordProblem(password: string, email: string, name = ''): string | null {
  if (typeof password !== 'string' || !password) return 'Enter a password.';
  if ([...password].length < 10) return 'Use at least 10 characters. A few random words works well.';
  if (password.length > 256) return 'Use 256 characters or fewer.';
  const low = password.toLowerCase();
  if (/^(.)\1+$/.test(password)) return 'That password is one repeated character.';
  const local = norm(email).split('@')[0];
  if (local.length >= 4 && low.includes(local)) return 'Don’t use your email in your password.';
  const n = String(name || '')
    .toLowerCase()
    .replace(/\s+/g, '');
  if (n.length >= 4 && low.replace(/\s+/g, '').includes(n)) return 'Don’t use your name in your password.';
  return null;
}

// ---------- The accounts kept on this phone ----------
export interface HubLinkRec {
  id: string | null;
  url: string;
  provider?: string | null;
  at?: number;
}
interface Rec {
  id: string;
  email: string;
  name: string;
  createdAt: number;
  lastSignIn: number | null;
  verifier: Verifier | null;
  hub: HubLinkRec | null;
}
interface State {
  v: 1;
  active: string | null;
  accounts: Record<string, Rec>;
}
/** An account as the rest of the app sees it (no verifier). */
export interface LocalAccount {
  id: string;
  email: string;
  name: string;
  createdAt: number;
  lastSignIn: number | null;
  canSignInOffline: boolean;
  hub: { id: string | null; url: string; provider: string | null } | null;
}
export interface StoreIO {
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
}
export type CheckResult = { ok: true; account: LocalAccount; weak: boolean } | { ok: false; reason: 'unknown' | 'noVerifier' | 'wrong'; account: LocalAccount | null };

/** A problem with what was typed: `field` says where, `exists` that the account is already on this phone. */
export class AccountError extends Error {
  field: string | null;
  exists: boolean;
  constructor(message: string, o: { field?: string | null; exists?: boolean } = {}) {
    super(message);
    this.field = o.field ?? null;
    this.exists = !!o.exists;
  }
}
const EXISTS = 'This phone already has a Kea account with this email. Sign in instead.';
const NOT_HERE = 'That account isn’t on this phone.';

export function createStore(io: StoreIO, { params = STRONG, now = Date.now }: { params?: VerifierParams; now?: () => number } = {}) {
  const empty = (): State => ({ v: 1, active: null, accounts: {} });
  async function read(): Promise<State> {
    try {
      const j = JSON.parse((await io.read()) || 'null');
      if (!j || typeof j !== 'object' || typeof j.accounts !== 'object' || !j.accounts) return empty();
      return { v: 1, active: typeof j.active === 'string' && j.accounts[j.active] ? j.active : null, accounts: j.accounts };
    } catch {
      return empty();
    }
  }
  // (One change at a time: each reads what the last one wrote.)
  let chain: Promise<unknown> = Promise.resolve();
  function update<T>(fn: (s: State) => T): Promise<T> {
    const p = chain.then(async () => {
      const s = await read();
      const out = fn(s);
      await io.write(JSON.stringify(s));
      return out;
    });
    chain = p.catch(() => {});
    return p;
  }
  const byEmail = (s: State, email: string) => Object.values(s.accounts).find((a) => norm(a.email) === norm(email)) || null;
  const pub = (a: Rec | null | undefined): LocalAccount | null =>
    a ? { id: a.id, email: a.email, name: a.name || '', createdAt: a.createdAt, lastSignIn: a.lastSignIn || null, canSignInOffline: !!a.verifier, hub: a.hub ? { id: a.hub.id ?? null, url: a.hub.url, provider: a.hub.provider || null } : null } : null;
  const newId = () => `loc_${b64url(randomBytes(12))}`;
  const name60 = (n: unknown) => String(n || '').trim().slice(0, 60);

  const store = {
    read,
    /** The account signed in on this phone now, or null. */
    async active() {
      const s = await read();
      return pub(s.active ? s.accounts[s.active] : null);
    },
    async get(id: string) {
      return pub((await read()).accounts[id]);
    },
    async find(email: string) {
      return pub(byEmail(await read(), email));
    },
    /** Every account used here, most recent first. */
    async list() {
      return Object.values((await read()).accounts)
        .sort((a, b) => (b.lastSignIn || b.createdAt || 0) - (a.lastSignIn || a.createdAt || 0))
        .map((a) => pub(a)!);
    },
    /** A new account on this phone, made at once and signed in: no connection needed. */
    async create({ email, password, name }: { email: string; password: string; name?: string }) {
      const e = norm(email);
      if (!EMAIL.test(e)) throw new AccountError('Add your email address.', { field: 'email' });
      const problem = passwordProblem(password, e, name);
      if (problem) throw new AccountError(problem, { field: 'password' });
      if (byEmail(await read(), e)) throw new AccountError(EXISTS, { exists: true });
      const verifier = await makeVerifier(password, params);
      return update((s) => {
        if (byEmail(s, e)) throw new AccountError(EXISTS, { exists: true });
        const a: Rec = { id: newId(), email: e, name: name60(name), createdAt: now(), lastSignIn: now(), verifier, hub: null };
        s.accounts[a.id] = a;
        s.active = a.id;
        return pub(a)!;
      });
    },
    /**
     * Checking the password against the verifier kept here: { ok: true, account } when it matches; otherwise
     * { ok: false, reason: 'unknown' (no account with this email here) | 'noVerifier' (never signed in here with a
     * password) | 'wrong', account }.
     */
    async check({ email, password }: { email: string; password: string }): Promise<CheckResult> {
      const a = byEmail(await read(), email);
      if (!a) return { ok: false, reason: 'unknown', account: null };
      if (!a.verifier) return { ok: false, reason: 'noVerifier', account: pub(a) };
      if (!(await checkVerifier(password, a.verifier))) return { ok: false, reason: 'wrong', account: pub(a) };
      return { ok: true, account: pub(a)!, weak: weak(a.verifier, params) };
    },
    async signIn({ email, password }: { email: string; password: string }): Promise<CheckResult> {
      const r = await store.check({ email, password });
      if (!r.ok) return r;
      if (r.weak) await store.setPassword(r.account.id, password);
      return { ok: true, account: await store.activate(r.account.id), weak: false };
    },
    activate(id: string) {
      return update((s) => {
        if (!s.accounts[id]) throw new AccountError(NOT_HERE);
        s.active = id;
        s.accounts[id].lastSignIn = now();
        return pub(s.accounts[id])!;
      });
    },
    /** Signed out here: the account and its verifier stay, so it can sign in again (also offline). */
    signOut() {
      return update((s) => void (s.active = null));
    },
    async setPassword(id: string, password: string) {
      const verifier = await makeVerifier(password, params);
      return update((s) => {
        if (!s.accounts[id]) throw new AccountError(NOT_HERE);
        s.accounts[id].verifier = verifier;
        return pub(s.accounts[id])!;
      });
    },
    setName(id: string, name: string) {
      return update((s) => {
        if (s.accounts[id]) s.accounts[id].name = name60(name);
        return pub(s.accounts[id]);
      });
    },
    /**
     * After a sign-in to an online Kea account (password, Google or Microsoft): the account kept here for that email
     * (made if there's none), linked to the online one and signed in. `password`: the one just used online, kept as
     * a verifier so it signs in offline later. Nothing else about the account here changes.
     */
    async rememberOnline({ password = null, ...rest }: { email: string; name?: string | null; hubId: string | null; url: string; provider?: string | null; password?: string | null }) {
      return store.attachOnline({ ...rest, verifier: password ? await makeVerifier(password, params) : null });
    },
    attachOnline({ email, name, hubId, url, provider = null, verifier = null }: { email: string; name?: string | null; hubId: string | null; url: string; provider?: string | null; verifier?: Verifier | null }) {
      return update((s) => {
        let a = byEmail(s, email);
        if (!a) {
          a = { id: newId(), email: norm(email), name: name60(name), createdAt: now(), lastSignIn: null, verifier: null, hub: null };
          s.accounts[a.id] = a;
        }
        if (name && !a.name) a.name = name60(name);
        if (verifier) a.verifier = verifier;
        a.hub = { id: hubId ?? a.hub?.id ?? null, url, provider: provider || a.hub?.provider || null, at: now() };
        a.lastSignIn = now();
        s.active = a.id;
        return pub(a)!;
      });
    },
    /** The online account was deleted: it goes from this phone too. */
    remove(id: string) {
      return update((s) => {
        delete s.accounts[id];
        if (s.active === id) s.active = null;
      });
    }
  };
  return store;
}
export type AccountStore = ReturnType<typeof createStore>;

// ---------- Linking ----------
/** The email in an ID token's payload (not checked here: the Kea account server checks the token itself). */
export function idTokenEmail(idToken: string): { email: string; name: string | null } {
  try {
    const p = JSON.parse(new TextDecoder().decode(fromB64(String(idToken).split('.')[1])));
    return { email: norm(p.email || p.preferred_username || p.upn || ''), name: p.name || null };
  } catch {
    return { email: '', name: null };
  }
}
export type LinkDecision = { link: true; reason: 'link' | 'relink' } | { link: false; reason: 'noAccount' | 'noEmail' } | { link: false; reason: 'differentEmail'; accountEmail: string; providerEmail: string };
/**
 * Whether a Google or Microsoft sign-in may link to this account: only when it is the same email. A different email
 * never links; the account here and everything on this phone stay as they are.
 */
export function linkDecision(account: { email: string; hub?: unknown } | null, providerEmail: string): LinkDecision {
  if (!account) return { link: false, reason: 'noAccount' };
  const want = norm(account.email),
    got = norm(providerEmail);
  if (!got) return { link: false, reason: 'noEmail' };
  if (got !== want) return { link: false, reason: 'differentEmail', accountEmail: want, providerEmail: got };
  return { link: true, reason: account.hub ? 'relink' : 'link' };
}
/** The words for a sign-in that doesn't link. */
export function linkRefusal(d: LinkDecision, label: string): string {
  return d.reason === 'differentEmail' ? `That ${label} account is ${d.providerEmail}, not ${d.accountEmail}. A different email never links to this account, and nothing here changed.` : `${label} didn’t say which email it is. Try again.`;
}

// ---------- The account state ----------
export type AccountState = 'none' | 'offline' | 'linked' | 'online';
/**
 * From what's on this phone only (never the network):
 *   none    no account signed in here;
 *   offline an account made on this phone, not linked to an online Kea account: everything on the phone works, cloud
 *           features show "Needs your Kea account online";
 *   linked  linked to an online Kea account, signed in here without an online session: the same, with "Sign in online";
 *   online  signed in to the online Kea account here (whether or not it can be reached right now).
 */
export function accountState({ active, hasToken }: { active: { hub?: unknown } | null; hasToken: boolean }): AccountState {
  if (hasToken) return 'online';
  if (!active) return 'none';
  return active.hub ? 'linked' : 'offline';
}
/** The sign-in screen shows only while no account is signed in; it never waits for the network. */
export const gateOpen = (state: AccountState) => state === 'none';
/** What a cloud feature shows in its place: null when it can be used now. */
export type OnlineNeed = 'none' | 'offline' | 'linked' | 'unreachable' | 'noAddress';
export function onlineNeed(s: { state: AccountState; reachable: boolean; checked: boolean; url?: string } | null): OnlineNeed | null {
  if (!s) return null;
  if (s.state === 'none' || s.state === 'offline' || s.state === 'linked') return s.url === '' && s.state !== 'linked' ? 'noAddress' : s.state;
  return s.reachable || !s.checked ? null : 'unreachable';
}
/** The calm words cloud features show while the account isn't online (as Kea on the computer says them). */
export function needsOnlineText(need: OnlineNeed, onlineNote: string | null = null): { title: string; text: string; action: string | null } {
  const title = 'Needs your Kea account online';
  if (need === 'linked') return { title, text: onlineNote === 'password' ? 'Your password changed online. Sign in online again to use it.' : 'Sign in online to use it.', action: 'Sign in online' };
  if (need === 'unreachable') return { title, text: 'Kea can’t reach it right now, and tries again by itself.', action: null };
  if (need === 'noAddress') return { title, text: 'This copy of Kea has no Kea account address yet. Add it under Settings → Kea account → Advanced. Everything on this phone works without it.', action: null };
  return { title, text: 'Take your account online with Google or Microsoft to use it. Everything on this phone works without it.', action: 'Go online' };
}

// ---------- The account server's address ----------
/** What someone types → the server's https origin. Bare names get https://; anything else is refused. */
export function normalizeAccountUrl(input: string): string {
  let s = String(input || '').trim();
  if (!s) throw new Error('Enter your Kea account’s address.');
  if (!/^[a-z]+:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error('That isn’t a web address.');
  }
  if (u.protocol !== 'https:') throw new Error('Use an https:// address. Android only connects to your Kea account over a secure link.');
  return u.origin;
}
/** The address in use: the one under Advanced, else the built-in one ('' when neither). */
export function accountUrl(advanced: string | null | undefined, builtIn = DEFAULT_ACCOUNT_URL): string {
  for (const u of [advanced, builtIn]) {
    if (!u || !String(u).trim()) continue;
    try {
      return normalizeAccountUrl(String(u));
    } catch {}
  }
  return '';
}

// ---------- What the server can do (its /v1/health) ----------
export interface ServerKind {
  /** The Kea account server (KeaC): /v1/auth/oauth and /v1/auth/register with a provider's ID token. */
  current: boolean;
  google: boolean;
  microsoft: boolean;
}
/** A server without the newer features is a Kea Hub 0.5: Google only, at /v1/auth/google. */
export function serverKind(health: any): ServerKind {
  const f: string[] = Array.isArray(health?.features) ? health.features : [];
  const current = health?.service === 'keac' || f.includes('microsoft');
  return { current, google: current ? f.includes('google') || !f.length : true, microsoft: current && (f.includes('microsoft') || !f.length) };
}
/** The request that signs in with a provider's ID token. */
export function oauthRequest(kind: ServerKind, provider: Provider, idToken: string, code?: string): { path: string; body: Record<string, unknown> } {
  const c = code ? { code } : {};
  if (kind.current) return { path: '/v1/auth/oauth', body: { provider, idToken, ...c } };
  if (provider === 'google') return { path: '/v1/auth/google', body: { idToken, ...c } };
  throw new Error('Your Kea account server doesn’t take Microsoft sign-in yet. Use Google, or your email and password.');
}
/** The request that makes the online Kea account for the account on this phone (both server kinds read it). */
export function registerRequest(o: { email: string; name?: string; password: string; provider: Provider; idToken: string; termsVersion: number; termsSections: string[]; age13: boolean }) {
  return {
    path: '/v1/auth/register',
    body: {
      email: norm(o.email),
      password: o.password,
      displayName: o.name || norm(o.email).split('@')[0],
      ...(o.name ? { name: o.name } : {}),
      age13: o.age13 === true,
      termsVersion: o.termsVersion,
      termsSections: o.termsSections,
      provider: o.provider,
      idToken: o.idToken,
      ...(o.provider === 'google' ? { googleIdToken: o.idToken } : {})
    }
  };
}

// ---------- Google and Microsoft sign-in (Custom Tabs + PKCE, back through the app's own address) ----------
export type Provider = 'google' | 'microsoft';
/** Where the provider sends the browser back: the app's own scheme (its application id), caught by MainActivity. */
export const REDIRECT_SCHEME = 'com.kea.scholar';
export const REDIRECT_URI = `${REDIRECT_SCHEME}:/oauth`;
export const PROVIDERS: Record<Provider, { label: string; authorize: string; token: string; extra: Record<string, string> }> = {
  google: {
    label: 'Google',
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    extra: { prompt: 'select_account' }
  },
  microsoft: {
    label: 'Microsoft',
    // (common: personal Microsoft accounts and work or school ones.)
    authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    extra: { prompt: 'select_account', response_mode: 'query' }
  }
};
export const SCOPE = 'openid email profile';
const sha256 = async (s: string) => new Uint8Array(await subtle().digest('SHA-256', new TextEncoder().encode(s)));
/** A PKCE pair (RFC 7636, S256): the verifier stays on the phone, the challenge goes in the sign-in address. */
export async function pkcePair() {
  const verifier = b64url(randomBytes(48));
  return { verifier, challenge: b64url(await sha256(verifier)), method: 'S256' as const };
}
export const pkceChallenge = async (verifier: string) => b64url(await sha256(verifier));
/** The address that opens the provider's sign-in page. */
export function authorizeUrl(provider: Provider, o: { clientId: string; challenge: string; state: string; redirectUri?: string; loginHint?: string; nonce?: string }): string {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`Unknown sign-in: ${provider}`);
  const u = new URL(p.authorize);
  u.search = new URLSearchParams({
    client_id: o.clientId,
    redirect_uri: o.redirectUri || REDIRECT_URI,
    response_type: 'code',
    scope: SCOPE,
    code_challenge: o.challenge,
    code_challenge_method: 'S256',
    state: o.state,
    ...(o.nonce ? { nonce: o.nonce } : {}),
    ...p.extra,
    ...(o.loginHint ? { login_hint: o.loginHint } : {})
  }).toString();
  return u.toString();
}
/** The form body that trades the code for tokens (no client secret: the phone is a public client, PKCE stands in). */
export function tokenRequest(provider: Provider, o: { clientId: string; code: string; verifier: string; redirectUri?: string }): { url: string; body: string } {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`Unknown sign-in: ${provider}`);
  return {
    url: p.token,
    body: new URLSearchParams({
      code: o.code,
      client_id: o.clientId,
      code_verifier: o.verifier,
      grant_type: 'authorization_code',
      redirect_uri: o.redirectUri || REDIRECT_URI,
      ...(provider === 'microsoft' ? { scope: SCOPE } : {})
    }).toString()
  };
}
/**
 * The address the browser came back to: { code } for this sign-in, or { error } in words. Only the app's own
 * address, and only with the `state` this sign-in sent.
 */
export function parseRedirect(url: string, state: string, label = 'The'): { code: string } | { error: string; cancelled?: boolean } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { error: 'That sign-in didn’t come back to Kea. Try again.' };
  }
  if (u.protocol !== `${REDIRECT_SCHEME}:` || u.pathname.replace(/^\/+/, '/') !== '/oauth') return { error: 'That sign-in didn’t come back to Kea. Try again.' };
  if (!state || u.searchParams.get('state') !== state) return { error: 'That sign-in was for an older attempt. Try again.' };
  const err = u.searchParams.get('error');
  if (err) return { error: err === 'access_denied' ? `${label} sign-in was cancelled.` : u.searchParams.get('error_description') || `${label} sign-in didn’t finish.`, cancelled: err === 'access_denied' };
  const code = u.searchParams.get('code');
  return code ? { code } : { error: `${label} sign-in was cancelled.`, cancelled: true };
}
