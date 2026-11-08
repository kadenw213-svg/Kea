// The Kea account on the phone: an account opened on the phone with just its email and no connection, linked to the
// online Kea account by the same Google or Microsoft email, and signed in online with Google or Microsoft (no
// passwords). Every answer comes from what's on the phone at once; the server is only checked in the background, never
// longer than a few seconds, and not reaching it is a normal state. The same rules as Kea on the computer
// (electron/hub.cjs).
//
// Where things are kept:
//   - the accounts: Android's encrypted storage (KeaPlugin.accountsRead/Write, Store.secure);
//   - the online session token: Android's encrypted storage too (Hub.java), never seen by this code;
//   - the address under Advanced: localStorage kea.accountUrl (the built-in DEFAULT_ACCOUNT_URL otherwise).
import { Kea } from './kea';
import {
  AccountError,
  DEFAULT_ACCOUNT_URL,
  PROVIDERS,
  accountState,
  accountUrl,
  authorizeUrl,
  b64url,
  createStore,
  idTokenEmail,
  linkDecision,
  linkRefusal,
  normalizeAccountUrl,
  norm,
  oauthRequest,
  parseRedirect,
  pkceChallenge,
  randomBytes,
  serverKind,
  tokenRequest,
  type AccountState,
  type LocalAccount,
  type Provider,
  type ServerKind
} from './accountCore';
import { HubError, OFFLINE_MSG, accountChanged, hubCall, hubDropSession, hubNewAccount, hubSessionStarted, hubSignOut, reach } from './hub';

const ADVANCED = 'kea.accountUrl';
const PENDING = 'kea.oauthPending';

// ---------- Google and Microsoft client ids (build config: none ship, and the buttons stay hidden without them) ----------
// Set in the environment of `vite build`: VITE_KEA_GOOGLE_CLIENT_ID (an OAuth client that allows the
// com.kea.scholar:/oauth redirect) and VITE_KEA_MICROSOFT_CLIENT_ID (an Azure app registration with the "Mobile and
// desktop" redirect com.kea.scholar:/oauth). Public clients: no secret, PKCE instead.
const env: Record<string, string | undefined> = (import.meta as any).env || {};
export const clientId = (p: Provider) => String((p === 'microsoft' ? env.VITE_KEA_MICROSOFT_CLIENT_ID : env.VITE_KEA_GOOGLE_CLIENT_ID) || '').trim();
export const providers = () => ({ google: !!clientId('google'), microsoft: !!clientId('microsoft') });

// ---------- the address ----------
export const advancedUrl = () => {
  try {
    return localStorage.getItem(ADVANCED) || '';
  } catch {
    return '';
  }
};
export const currentUrl = () => accountUrl(advancedUrl(), DEFAULT_ACCOUNT_URL);
/**
 * The native side talks to the address in use. (A phone signed in before the address moved under Advanced keeps
 * the one it typed, as the Advanced address.) A different address signs the phone out online first (Hub.java).
 */
async function ensureUrl(): Promise<void> {
  const h = await Kea.hubState().catch(() => null);
  try {
    const typed = h?.url ? accountUrl(h.url, '') : '';
    if (localStorage.getItem(ADVANCED) === null && typed && typed !== accountUrl(DEFAULT_ACCOUNT_URL, '')) localStorage.setItem(ADVANCED, typed);
  } catch {}
  const want = currentUrl();
  if (want && h && accountUrl(h.url, '') !== want) await Kea.hubSetUrl({ url: want }).catch(() => {});
}
/** The address under Advanced ('' goes back to the built-in one). */
export async function setAdvancedUrl(input: string) {
  const u = input.trim() ? normalizeAccountUrl(input) : '';
  try {
    // ('' rather than nothing: an address typed before this version isn't brought back.)
    localStorage.setItem(ADVANCED, u);
  } catch {}
  health = null;
  reach.at = 0;
  await ensureUrl();
  accountChanged();
  return status();
}

// ---------- the accounts on this phone ----------
let store: ReturnType<typeof createStore> | null = null;
const accounts = () =>
  (store ??= createStore({
    read: async () => (await Kea.accountsRead().catch(() => ({ text: '' }))).text || null,
    write: (text) => Kea.accountsWrite({ text })
  }));

const fail = (message: string, status: number, data: any = {}) => new HubError(message, status, data);
const needAddress = () => {
  if (!currentUrl()) throw fail('This copy of Kea has no Kea account address yet. Add it under Advanced, or keep using the account on this phone.', 0, { noAddress: true });
};

// ---------- what the server can do, and whether it answers ----------
let health: { kind: ServerKind; at: number; url: string; raw: any } | null = null;
async function serverInfo(): Promise<ServerKind> {
  if (health && health.url === currentUrl() && Date.now() - health.at < 10 * 60e3) return health.kind;
  const h = await hubCall('GET', '/v1/health', undefined, { auth: false, limit: 'status' });
  health = { kind: serverKind(h), at: Date.now(), url: currentUrl(), raw: h };
  return health.kind;
}
/** The account server's /v1/health as last read (read again when it's older than ten minutes), or null offline. */
export async function serverHealth(): Promise<any | null> {
  try {
    await serverInfo();
  } catch {}
  return health && health.url === currentUrl() ? health.raw : null;
}

export interface AccountStatus {
  state: AccountState;
  url: string;
  advancedUrl: string;
  defaultUrl: string;
  account: { id: string; email: string; name: string; linked: boolean; provider: string | null } | null;
  known: { email: string; name: string }[];
  providers: { google: boolean; microsoft: boolean };
  /** A Google or Microsoft sign-in waiting for the terms (a new account) or the owner's two-step code. */
  pending: { email: string; name: string | null; provider: Provider } | null;
  signedIn: boolean;
  reachable: boolean;
  checked: boolean;
  /** The server can take Microsoft sign-in (the Kea account server; a Kea Hub 0.5 takes Google only). */
  microsoftOnServer: boolean | null;
}

/** The account signed in here, also for a phone signed in before it kept accounts (sign-in only, Kea 0.70). */
async function activeAccount(h: { signedIn: boolean; email: string }): Promise<LocalAccount | null> {
  const S = accounts();
  let a = await S.active();
  if (!a && h.signedIn && h.email) a = await S.attachOnline({ email: h.email, hubId: null, url: currentUrl() });
  return a;
}
/** Where things stand, from the phone alone (never the network). */
export async function local(): Promise<AccountStatus> {
  await ensureUrl();
  const h = await Kea.hubState().catch(() => ({ url: '', signedIn: false, email: '', root: '' }));
  const a = await activeAccount(h);
  const state = accountState({ active: a, hasToken: h.signedIn });
  return {
    state,
    url: currentUrl(),
    advancedUrl: advancedUrl(),
    defaultUrl: DEFAULT_ACCOUNT_URL,
    account: a ? { id: a.id, email: a.email, name: a.name, linked: !!a.hub, provider: a.hub?.provider || null } : null,
    known: (await accounts().list()).map((x) => ({ email: x.email, name: x.name })),
    providers: providers(),
    pending: pending && Date.now() - pending.at < PENDING_MS ? { email: pending.email, name: pending.name, provider: pending.provider } : null,
    signedIn: h.signedIn,
    reachable: reach.reachable,
    checked: reach.at > 0,
    microsoftOnServer: health && health.url === currentUrl() ? health.kind.microsoft : null
  };
}
/** What local() says, after a short background check of the server (a few seconds at most). */
export async function status(): Promise<AccountStatus> {
  await ensureUrl();
  if (!currentUrl()) return local();
  try {
    await serverInfo();
  } catch {}
  const h = await Kea.hubState().catch(() => null);
  if (h?.signedIn && reach.reachable) {
    try {
      const me = await hubCall<{ account: { id: string; email: string; displayName?: string } }>('GET', '/v1/me', undefined, { limit: 'status' });
      const a = await accounts().active();
      if (me?.account?.email && (!a || norm(a.email) !== norm(me.account.email) || a.hub?.id !== me.account.id))
        await accounts().attachOnline({ email: me.account.email, name: me.account.displayName, hubId: me.account.id, url: currentUrl() });
    } catch {
      // (Offline, the terms gate, or the session ended: still signed in here, working from what Kea last knew.)
    }
  }
  return local();
}

/** An online sign-in's answer (Hub 0.5: { account }; the Kea account server: { me: { account } }). */
const onlineAccountOf = (r: any) => r?.account || r?.me?.account || null;
export type SignedIn = AccountStatus & { needsTerms?: boolean };
/**
 * After any online sign-in (the token is already kept natively): the account on this phone for that email (made if
 * there's none, linked, signed in).
 */
async function signedIn(r: any, { provider = null }: { provider?: string | null } = {}): Promise<SignedIn> {
  const acc = onlineAccountOf(r);
  if (acc?.email) {
    const was = await accounts().active();
    // (Another account's classes and sync state are never shown to this one.)
    if (was && norm(was.email) !== norm(acc.email)) hubNewAccount();
    await accounts().attachOnline({ email: acc.email, name: acc.displayName, hubId: acc.id ?? null, url: currentUrl(), provider });
  }
  hubSessionStarted();
  pending = null;
  accountChanged();
  return { ...(await local()), needsTerms: !!(r?.terms?.needsAgreement || r?.me?.terms?.needsAgreement) };
}
/** Before signing in online as `email`: another account's online session here ends (one account at a time). */
async function switchingTo(email: string) {
  const was = await accounts().active();
  if (was && norm(was.email) !== norm(email) && (await Kea.hubState().catch(() => null))?.signedIn) await hubDropSession();
}

// ---------- signing in ----------
// No passwords: on this phone an account is its email, and online a Kea account signs in with Google or Microsoft.
/** Using Kea on this phone with just an email, no connection needed: that account's things here open, or it's made. */
export async function openOffline({ email, name }: { email: string; name?: string }): Promise<AccountStatus & { created: boolean }> {
  pending = null;
  let r;
  try {
    const was = await accounts().active();
    if ((await Kea.hubState().catch(() => null))?.signedIn && (!was || norm(was.email) !== norm(email))) await hubDropSession();
    r = await accounts().open({ email, name });
  } catch (e: any) {
    if (e instanceof AccountError) throw fail(e.message, 400, { field: e.field });
    throw e;
  }
  accountChanged();
  return { ...(await local()), created: r.created };
}
/** Signed out on this phone: the online session ends too; the account stays (its email opens it again, offline too). */
export async function signOut(): Promise<AccountStatus> {
  pending = null;
  await hubSignOut();
  await accounts().signOut();
  accountChanged();
  return local();
}

// ---------- Google and Microsoft ----------
// A sign-in waiting for one more thing: the terms (the first sign-in makes the account) or, for the owner's account
// only, its two-step code. Its ID token stays in this page's memory for a few minutes and goes again with that; the
// Kea account server uses it up only when it signs in.
type Pending = { provider: Provider; idToken: string; email: string; name: string | null; at: number };
let pending: Pending | null = null;
const PENDING_MS = 10 * 60e3;
/** Signing in with a provider's ID token: the Kea account server at /v1/auth/oauth, a Kea Hub 0.5 at /v1/auth/google. */
async function oauthLogin(provider: Provider, idToken: string, extra: Record<string, unknown> = {}) {
  let kind: ServerKind;
  try {
    kind = await serverInfo();
  } catch (e: any) {
    throw e?.status === 0 ? fail(OFFLINE_MSG, 0, { unreachable: true }) : e;
  }
  let req;
  try {
    req = oauthRequest(kind, provider, idToken, extra);
  } catch (e: any) {
    throw fail(String(e?.message || e), 400, { unsupported: true });
  }
  return hubCall('POST', req.path, req.body, { auth: false, keepToken: true, limit: 'auth' });
}
async function trySignIn(p: Omit<Pending, 'at'>, extra: Record<string, unknown> = {}): Promise<SignedIn> {
  await switchingTo(p.email);
  let r;
  try {
    r = await oauthLogin(p.provider, p.idToken, extra);
  } catch (e: any) {
    if (e?.status === 404 && e?.data?.needsAccount) {
      pending = { ...p, email: e.data.email || p.email, name: e.data.name || null, at: Date.now() };
      throw fail(`Create your Kea account for ${pending.email}: agree to the terms first.`, 404, { needsAccount: true, email: pending.email, name: pending.name });
    }
    if (e?.data?.totpRequired) {
      pending = { ...p, at: Date.now() };
      throw e;
    }
    pending = null;
    // (An older Kea account server that can't make accounts this way.)
    if (e?.status === 404) throw fail(`There’s no online Kea account for ${p.email || 'that email'} yet.`, 404, { noAccount: true });
    throw e;
  }
  return signedIn(r, { provider: p.provider });
}
/**
 * Continue with Google or Microsoft from the sign-in screen: signs in to the online Kea account for that email, made
 * now if there's none (the screen then shows the terms, and continueSignIn finishes). The account on this phone with
 * the same email is linked (made if there's none).
 */
export async function oauthSignIn({ provider }: { provider: Provider }, given?: string): Promise<SignedIn> {
  needAddress();
  await ensureUrl();
  pending = null;
  const idToken = given || (await idTokenFor(provider, undefined, { purpose: 'signin' }));
  return trySignIn({ provider, idToken, email: idTokenEmail(idToken).email, name: idTokenEmail(idToken).name });
}
/**
 * Taking the account on this phone online (or signing in online again): a Google or Microsoft sign-in with the same
 * email. A different email never links: nothing is sent and nothing here changes. Nothing on the phone is deleted.
 */
export async function link({ provider }: { provider: Provider }, given?: string): Promise<SignedIn> {
  const label = PROVIDERS[provider]?.label;
  if (!label) throw fail('Pick Google or Microsoft.', 400);
  const rec = await accounts().active();
  if (!rec) throw fail('Sign in on this phone first.', 401);
  needAddress();
  await ensureUrl();
  pending = null;
  const idToken = given || (await idTokenFor(provider, rec.email, { purpose: 'link' }));
  const who = idTokenEmail(idToken);
  const d = linkDecision(rec, who.email);
  if (!d.link) throw fail(linkRefusal(d, label), 409, { mismatch: true, ...d });
  return trySignIn({ provider, idToken, email: who.email, name: who.name });
}
/** The waiting sign-in, finished: with the terms agreed (a new account), or the owner's two-step code. */
export async function continueSignIn(o: { code?: string; termsVersion?: number; termsSections?: string[]; age13?: boolean }): Promise<SignedIn> {
  const p = pending;
  if (!p || Date.now() - p.at > PENDING_MS) {
    pending = null;
    throw fail('That sign-in timed out. Continue with Google or Microsoft again.', 408, { expired: true });
  }
  if (o.code) {
    const code = o.code.replace(/\s+/g, '');
    try {
      return await trySignIn(p, { code });
    } catch (e: any) {
      // (A Kea Hub 0.5 uses the Google sign-in up before it asks for the code: one more sign-in, the code with it.)
      if (!(e?.status === 401 && /already used/i.test(String(e?.message)))) throw e;
      return trySignIn({ ...p, idToken: await idTokenFor(p.provider, p.email || undefined, { purpose: 'signin' }) }, { code });
    }
  }
  if (o.age13 !== true) throw fail('Kea accounts are for people 13 and older.', 400, { field: 'age13' });
  return trySignIn(p, { termsVersion: o.termsVersion, termsSections: o.termsSections || [], age13: true });
}
export function cancelSignIn(): Promise<AccountStatus> {
  pending = null;
  return local();
}
/** The current terms (for making the online account): the version and every section id. */
export async function currentTerms(): Promise<{ version: number; sections: { id: string; title: string; body: string }[] }> {
  needAddress();
  await ensureUrl();
  const r = await hubCall<{ terms: { version: number; sections: { id: string; title: string; body: string }[] } }>('GET', '/v1/terms', undefined, { auth: false, limit: 'auth' });
  return r.terms;
}
// ---------- the ID token: Custom Tabs + PKCE, back through com.kea.scholar:/oauth ----------
type Waiting = { state: string; provider: Provider; verifier: string; resolve(t: string): void; reject(e: any): void; timer: ReturnType<typeof setTimeout> };
let waiting: Waiting | null = null;
let listening = false;

function listen() {
  if (listening) return;
  listening = true;
  Kea.addListener('oauth', ({ url }) => void onRedirect(url)).catch(() => (listening = false));
}
async function onRedirect(url: string) {
  const w = waiting;
  if (!w) return;
  const back = parseRedirect(url, w.state, PROVIDERS[w.provider].label);
  if ('error' in back) {
    // (Another attempt's answer: keep waiting for this one.)
    if (/older attempt/.test(back.error)) return;
    return done(w, fail(back.error, 400, { cancelled: !!back.cancelled }));
  }
  try {
    done(w, null, await exchange(w.provider, back.code, w.verifier));
  } catch (e) {
    done(w, e);
  }
}
function done(w: Waiting, err: any, token?: string) {
  clearTimeout(w.timer);
  if (waiting === w) waiting = null;
  try {
    localStorage.removeItem(PENDING);
  } catch {}
  if (err) w.reject(err);
  else w.resolve(token!);
}
async function exchange(provider: Provider, code: string, verifier: string): Promise<string> {
  const label = PROVIDERS[provider].label;
  const t = tokenRequest(provider, { clientId: clientId(provider), code, verifier });
  let r;
  try {
    r = await Kea.oauthToken({ provider, body: t.body });
  } catch {
    throw fail(`Can’t reach ${label} right now.`, 0, { unreachable: true });
  }
  let j: any = {};
  try {
    j = JSON.parse(r.body || '{}');
  } catch {}
  if (r.status < 200 || r.status >= 300 || !j.id_token) throw fail(j.error_description || `${label} sign-in failed.`, 400);
  return j.id_token;
}
export const NOT_SET_UP = 'Online sign-in isn’t available in this copy of Kea yet. You can still use Kea on this phone with just your email.';
async function idTokenFor(provider: Provider, loginHint: string | undefined, { purpose }: { purpose: 'signin' | 'link' }): Promise<string> {
  const label = PROVIDERS[provider]?.label || provider;
  if (!clientId(provider)) throw fail(NOT_SET_UP, 503, { notSetUp: true });
  if (waiting) done(waiting, fail('Replaced by a newer sign-in.', 409));
  listen();
  const verifier = b64url(randomBytes(48));
  const state = b64url(randomBytes(16));
  const url = authorizeUrl(provider, { clientId: clientId(provider), challenge: await pkceChallenge(verifier), state, loginHint });
  // (Kept for a few minutes in case Android closes Kea while the sign-in page is open: see resumeOauth.)
  try {
    localStorage.setItem(PENDING, JSON.stringify({ provider, verifier, state, purpose, at: Date.now() }));
  } catch {}
  return new Promise<string>((resolve, reject) => {
    const w: Waiting = { state, provider, verifier, resolve, reject, timer: setTimeout(() => done(w, fail(`${label} sign-in timed out.`, 408)), 5 * 60e3) };
    waiting = w;
    Kea.oauthOpen({ url }).catch((e) => done(w, fail(`Couldn’t open ${label}’s sign-in page: ${String(e?.message || e)}`, 400)));
  });
}
/**
 * Android closed Kea while Google's or Microsoft's page was open, and the sign-in came back to a fresh start: it is
 * finished here (signing in, or linking the account on this phone). null when there was nothing to finish.
 */
export async function resumeOauth(): Promise<SignedIn | null> {
  const r = await Kea.takeOauth().catch(() => ({}) as { url?: string });
  if (!r.url) return null;
  let p: any = null;
  try {
    p = JSON.parse(localStorage.getItem(PENDING) || 'null');
    localStorage.removeItem(PENDING);
  } catch {}
  if (!p || Date.now() - Number(p.at) > 10 * 60e3 || !PROVIDERS[p.provider as Provider]) return null;
  const back = parseRedirect(r.url, p.state, PROVIDERS[p.provider as Provider].label);
  if ('error' in back) throw fail(back.error, 400);
  await ensureUrl();
  const idToken = await exchange(p.provider, back.code, p.verifier);
  return p.purpose === 'link' ? link({ provider: p.provider }, idToken) : oauthSignIn({ provider: p.provider }, idToken);
}

/** Plain words for a failed account action (offline is calm, never an error screen). */
export const accountProblem = (e: any) => String(e?.message || e);
