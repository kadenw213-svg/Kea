// The Kea account on the phone, without Android: the accounts kept on this phone, which one is signed in, whether a
// Google or Microsoft sign-in links to it, the account state, and the Google and Microsoft sign-in addresses (PKCE).
// account.ts uses this with the phone's encrypted storage; the tests use it with a stand-in. The same model as Kea on
// the computer (electron/accountCore.cjs).
//
// There are no passwords. Online, a Kea account signs in with Google or Microsoft only. On this phone an account is
// just its email: typing it opens that account's things here at once (made the first time), with no connection. Once
// signed in, Kea stays signed in here (offline too) until the person signs out.
//
// The stored record (kept by native code in Android's encrypted storage):
//   { v: 2, active: <local id> | null,
//     accounts: { <local id>: { id, email, name, createdAt, lastSignIn, hub: { id, url, provider?, at } | null } } }
// An account made here is "offline" until a Google or Microsoft sign-in with the same email links it to the online
// Kea account (hub set). Accounts used before stay: signing out only clears `active`.
// (Version 1 kept a PBKDF2 verifier of a password with each account. Reading the record drops it, once; the accounts,
// their emails and everything kept for them stay.)
//
// (Only erasable TypeScript here: Node runs this file as it is in the tests.)

/** The Kea account server's address, built in. Empty until it has one; then the address under Advanced is used. */
export const DEFAULT_ACCOUNT_URL = '';

export const norm = (e: unknown) =>
  String(e || '')
    .trim()
    .toLowerCase();
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- bytes ----------
const subtle = () => {
  const s = (globalThis as any).crypto?.subtle;
  if (!s) throw new Error('This phone’s browser can’t do secure sign-in.');
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
  hub: HubLinkRec | null;
}
interface State {
  v: 2;
  active: string | null;
  accounts: Record<string, Rec>;
}
/** An account as the rest of the app sees it. */
export interface LocalAccount {
  id: string;
  email: string;
  name: string;
  createdAt: number;
  lastSignIn: number | null;
  hub: { id: string | null; url: string; provider: string | null } | null;
}
export interface StoreIO {
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
}

/** A problem with what was typed: `field` says where. */
export class AccountError extends Error {
  field: string | null;
  constructor(message: string, o: { field?: string | null } = {}) {
    super(message);
    this.field = o.field ?? null;
  }
}
const NOT_HERE = 'That account isn’t on this phone.';
const name60 = (n: unknown) => String(n || '').trim().slice(0, 60);
/** The record as kept now: only these fields (an older record's verifier is left behind). */
const clean = (id: string, a: any): Rec => ({
  id,
  email: norm(a.email),
  name: name60(a.name),
  createdAt: Number(a.createdAt) || 0,
  lastSignIn: a.lastSignIn || null,
  hub: a.hub && typeof a.hub === 'object' ? { id: a.hub.id ?? null, url: String(a.hub.url || ''), provider: a.hub.provider || null, at: a.hub.at || undefined } : null
});

export function createStore(io: StoreIO, { now = Date.now }: { now?: () => number } = {}) {
  const empty = (): State => ({ v: 2, active: null, accounts: {} });
  // (An older record is written again without its verifiers, once.)
  let migrated = false;
  async function read(): Promise<State> {
    let j: any;
    try {
      j = JSON.parse((await io.read()) || 'null');
    } catch {
      return empty();
    }
    if (!j || typeof j !== 'object' || typeof j.accounts !== 'object' || !j.accounts) return empty();
    const accounts: Record<string, Rec> = {};
    for (const [id, a] of Object.entries<any>(j.accounts)) if (a && typeof a === 'object' && EMAIL.test(norm(a.email))) accounts[id] = clean(id, a);
    const s: State = { v: 2, active: typeof j.active === 'string' && accounts[j.active] ? j.active : null, accounts };
    if (!migrated && (j.v !== 2 || Object.values<any>(j.accounts).some((a) => a && 'verifier' in a))) {
      migrated = true;
      try {
        await io.write(JSON.stringify(s));
      } catch {}
    }
    return s;
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
    a ? { id: a.id, email: a.email, name: a.name || '', createdAt: a.createdAt, lastSignIn: a.lastSignIn || null, hub: a.hub ? { id: a.hub.id ?? null, url: a.hub.url, provider: a.hub.provider || null } : null } : null;
  const newId = () => `loc_${b64url(randomBytes(12))}`;

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
    /**
     * Using Kea on this phone with just an email: the account kept here for it is signed in (its things here open
     * again), or one is made, at once. No connection needed.
     */
    open({ email, name }: { email: string; name?: string }): Promise<{ account: LocalAccount; created: boolean }> {
      const e = norm(email);
      if (!EMAIL.test(e)) return Promise.reject(new AccountError('Add your email address.', { field: 'email' }));
      return update((s) => {
        let a = byEmail(s, e);
        const created = !a;
        if (!a) {
          a = { id: newId(), email: e, name: name60(name), createdAt: now(), lastSignIn: null, hub: null };
          s.accounts[a.id] = a;
        }
        a.lastSignIn = now();
        s.active = a.id;
        return { account: pub(a)!, created };
      });
    },
    activate(id: string) {
      return update((s) => {
        if (!s.accounts[id]) throw new AccountError(NOT_HERE);
        s.active = id;
        s.accounts[id].lastSignIn = now();
        return pub(s.accounts[id])!;
      });
    },
    /** Signed out here: the account stays, so typing its email opens it again (also offline). */
    signOut() {
      return update((s) => void (s.active = null));
    },
    setName(id: string, name: string) {
      return update((s) => {
        if (s.accounts[id]) s.accounts[id].name = name60(name);
        return pub(s.accounts[id]);
      });
    },
    /**
     * After a sign-in to an online Kea account (Google or Microsoft): the account kept here for that email (made if
     * there's none), linked to the online one and signed in. Nothing else about the account here changes.
     */
    attachOnline({ email, name, hubId, url, provider = null }: { email: string; name?: string | null; hubId: string | null; url: string; provider?: string | null }) {
      return update((s) => {
        let a = byEmail(s, email);
        if (!a) {
          a = { id: newId(), email: norm(email), name: name60(name), createdAt: now(), lastSignIn: null, hub: null };
          s.accounts[a.id] = a;
        }
        if (name && !a.name) a.name = name60(name);
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
  if (need === 'linked') return { title, text: 'Sign in online to use it.', action: 'Sign in online' };
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
/**
 * The request that signs in with a provider's ID token. `extra`: the owner's two-step code, or the terms agreed
 * ({ termsVersion, termsSections, age13 }) when the first sign-in for an email makes the online account.
 */
export function oauthRequest(kind: ServerKind, provider: Provider, idToken: string, extra: Record<string, unknown> = {}): { path: string; body: Record<string, unknown> } {
  if (kind.current) return { path: '/v1/auth/oauth', body: { provider, idToken, ...extra } };
  if (provider === 'google') return { path: '/v1/auth/google', body: { idToken, ...extra } };
  throw new Error('Your Kea account server doesn’t take Microsoft sign-in yet. Use Google.');
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
