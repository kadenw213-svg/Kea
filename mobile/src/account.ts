// The Kea account on the phone: accounts made and signed in on the phone with no connection, linked to the online Kea
// account by the same Google or Microsoft email, and signed in online. Every answer comes from what's on the phone at
// once; the server is only checked in the background, never longer than a few seconds, and not reaching it is a
// normal state. The same rules as Kea on the computer (electron/hub.cjs).
//
// Where things are kept:
//   - the accounts and their password verifiers: Android's encrypted storage (KeaPlugin.accountsRead/Write, Store.secure);
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
  registerRequest,
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
  account: { id: string; email: string; name: string; linked: boolean; canSignInOffline: boolean; provider: string | null } | null;
  known: { email: string; name: string }[];
  providers: { google: boolean; microsoft: boolean };
  /** Why the background online sign-in stopped: 'code' (two-step) | 'password' (changed online). */
  onlineNote: string | null;
  signedIn: boolean;
  reachable: boolean;
  checked: boolean;
  /** The server can take Microsoft sign-in (the Kea account server; a Kea Hub 0.5 takes Google only). */
  microsoftOnServer: boolean | null;
}
let onlineNote: string | null = null;

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
    account: a ? { id: a.id, email: a.email, name: a.name, linked: !!a.hub, canSignInOffline: a.canSignInOffline, provider: a.hub?.provider || null } : null,
    known: (await accounts().list()).map((x) => ({ email: x.email, name: x.name })),
    providers: providers(),
    onlineNote: state === 'linked' ? onlineNote : null,
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
 * there's none, linked, signed in), with a verifier of `password` so it signs in offline later.
 */
async function signedIn(r: any, { password = null, provider = null }: { password?: string | null; provider?: string | null } = {}): Promise<SignedIn> {
  const acc = onlineAccountOf(r);
  if (acc?.email) {
    const was = await accounts().active();
    // (Another account's classes and sync state are never shown to this one.)
    if (was && norm(was.email) !== norm(acc.email)) hubNewAccount();
    await accounts().rememberOnline({ email: acc.email, name: acc.displayName, hubId: acc.id ?? null, url: currentUrl(), provider, password });
  }
  hubSessionStarted();
  onlineNote = null;
  clearTimeout(bgLogin);
  accountChanged();
  return { ...(await local()), needsTerms: !!(r?.terms?.needsAgreement || r?.me?.terms?.needsAgreement) };
}
/** Before signing in online as `email`: another account's online session here ends (one account at a time). */
async function switchingTo(email: string) {
  const was = await accounts().active();
  if (was && norm(was.email) !== norm(email) && (await Kea.hubState().catch(() => null))?.signedIn) await hubDropSession();
}

// ---------- signing in and making an account ----------
/**
 * Email and password. An account kept on this phone is checked here, at once, with no connection; a linked one then
 * signs in online in the background. An email this phone hasn't signed in with goes to the server. `online`: sign in
 * online now ("Sign in online", with a two-step code when asked).
 */
export async function login({ email, password, code, online = false }: { email: string; password: string; code?: string; online?: boolean }): Promise<SignedIn> {
  const S = accounts();
  const e = norm(email);
  if (!e || !password) throw fail('Enter your email and password.', 400);
  const here = await S.check({ email: e, password });
  if (here.ok && !online) {
    const was = await S.active();
    if (was && was.id !== here.account.id) await hubDropSession();
    const r = await S.signIn({ email: e, password });
    onlineNote = null;
    if (r.ok && r.account.hub && !(await Kea.hubState().catch(() => null))?.signedIn) onlineInBackground(e, password);
    accountChanged();
    return local();
  }
  if (!here.ok && here.reason === 'wrong' && !here.account?.hub) throw fail('Wrong password for this account.', 401);
  const unreachable = () => {
    if (here.ok) return fail(OFFLINE_MSG, 0, { unreachable: true });
    if (here.reason === 'wrong') return fail('Wrong password. (Kea can’t reach your Kea account online to check a newer one.)', 401);
    return fail('This email hasn’t signed in on this phone before, and Kea can’t reach your Kea account online right now. Try again once you’re online, or create an account on this phone.', 0, { unreachable: true });
  };
  if (!currentUrl()) throw unreachable();
  await ensureUrl();
  await switchingTo(e);
  let r;
  try {
    r = await hubCall('POST', '/v1/auth/login', { email: e, password, ...(code ? { code: code.replace(/\s+/g, '') } : {}) }, { auth: false, keepToken: true, limit: 'auth' });
  } catch (err: any) {
    if (err?.status === 0) throw unreachable();
    throw err;
  }
  return signedIn(r, { password });
}
let bgLogin: ReturnType<typeof setTimeout> | undefined;
/** A linked account signed in offline: its online session comes back by itself once the server answers. */
function onlineInBackground(email: string, password: string) {
  const attempt = async () => {
    try {
      if (!currentUrl()) return;
      await ensureUrl();
      const r = await hubCall('POST', '/v1/auth/login', { email, password }, { auth: false, keepToken: true, limit: 'auth' });
      const a = await accounts().active();
      if (a && norm(a.email) === email) await signedIn(r, { password });
      else await hubDropSession({ keepProfile: true });
    } catch (e: any) {
      if (e?.status === 0) return void (bgLogin = setTimeout(attempt, 60_000)); // offline: try again in a minute
      onlineNote = e?.data?.totpRequired ? 'code' : 'password';
      accountChanged();
    }
  };
  clearTimeout(bgLogin);
  bgLogin = setTimeout(attempt, 0);
}
/** A new account, made on this phone at once (no connection needed) and signed in. */
export async function create({ email, password, name }: { email: string; password: string; name?: string }): Promise<AccountStatus> {
  clearTimeout(bgLogin);
  try {
    const was = await accounts().active();
    if (was && (await Kea.hubState().catch(() => null))?.signedIn) await hubDropSession();
    await accounts().create({ email, password, name });
  } catch (e: any) {
    if (e instanceof AccountError) throw fail(e.message, e.exists ? 409 : 400, { field: e.field, exists: e.exists });
    throw e;
  }
  onlineNote = null;
  accountChanged();
  return local();
}
/** Signed out on this phone: the online session ends too; the account and its verifier stay (it signs in again offline). */
export async function signOut(): Promise<AccountStatus> {
  clearTimeout(bgLogin);
  await hubSignOut();
  await accounts().signOut();
  onlineNote = null;
  accountChanged();
  return local();
}

// ---------- Google and Microsoft ----------
/** Signing in with a provider's ID token: the Kea account server at /v1/auth/oauth, a Kea Hub 0.5 at /v1/auth/google. */
async function oauthLogin(provider: Provider, idToken: string, code?: string) {
  let kind: ServerKind;
  try {
    kind = await serverInfo();
  } catch (e: any) {
    throw e?.status === 0 ? fail(OFFLINE_MSG, 0, { unreachable: true }) : e;
  }
  let req;
  try {
    req = oauthRequest(kind, provider, idToken, code ? code.replace(/\s+/g, '') : undefined);
  } catch (e: any) {
    throw fail(String(e?.message || e), 400, { unsupported: true });
  }
  return hubCall('POST', req.path, req.body, { auth: false, keepToken: true, limit: 'auth' });
}
/** From the sign-in screen: Continue with Google or Microsoft (an online account for that email, kept here and linked). */
export async function oauthSignIn({ provider, email, code }: { provider: Provider; email?: string; code?: string }): Promise<SignedIn> {
  needAddress();
  await ensureUrl();
  const idToken = await idTokenFor(provider, email, { reuse: !!code, purpose: 'signin' });
  return finishOauthSignIn(provider, idToken, code);
}
async function finishOauthSignIn(provider: Provider, idToken: string, code?: string) {
  await switchingTo(idTokenEmail(idToken).email);
  try {
    return await signedIn(await oauthLogin(provider, idToken, code), { provider });
  } catch (e: any) {
    if (e?.status === 404) throw fail('There’s no online Kea account for that email yet. Create an account on this phone, then take it online here with Google or Microsoft.', 404, { needsCreate: true });
    throw e;
  }
}
/**
 * Taking the account on this phone online: a Google or Microsoft sign-in with the same email links it to the online
 * Kea account for that email (made now when `password` and the terms come along, else signed in to). A different
 * email never links: nothing here changes. Nothing on the phone is deleted by linking.
 */
export async function link(o: { provider: Provider; password?: string; code?: string; termsVersion?: number; termsSections?: string[]; age13?: boolean }, given?: string): Promise<SignedIn> {
  const { provider, password, code, termsVersion, termsSections, age13 } = o;
  const label = PROVIDERS[provider]?.label;
  if (!label) throw fail('Pick Google or Microsoft.', 400);
  const rec = await accounts().active();
  if (!rec) throw fail('Sign in on this phone first.', 401);
  needAddress();
  if (password) {
    const c = await accounts().check({ email: rec.email, password });
    if (!c.ok && c.reason !== 'noVerifier') throw fail('That isn’t this account’s password.', 401, { field: 'password' });
  }
  await ensureUrl();
  // (Finishing a two-step sign-in that the new or existing online account asked for.)
  if (code && password) return signedIn(await hubCall('POST', '/v1/auth/login', { email: rec.email, password, code: code.replace(/\s+/g, '') }, { auth: false, keepToken: true, limit: 'auth' }), { password, provider });
  const idToken = given || (await idTokenFor(provider, rec.email, { reuse: true, purpose: 'link' }));
  const d = linkDecision(rec, idTokenEmail(idToken).email);
  if (!d.link) throw fail(linkRefusal(d, label), 409, { mismatch: true, ...d });
  if (password && termsVersion != null) {
    const req = registerRequest({ email: rec.email, name: rec.name, password, provider, idToken, termsVersion, termsSections: termsSections || [], age13: age13 === true });
    const reg = await hubCall('POST', req.path, req.body, { auth: false, keepToken: true, limit: 'auth' });
    if (reg.me || reg.account) return signedIn(reg, { password, provider });
    // (Hub 0.5 answers the same whether or not the email had an account, and never signs in by itself.)
    try {
      return await signedIn(await hubCall('POST', '/v1/auth/login', { email: rec.email, password }, { auth: false, keepToken: true, limit: 'auth' }), { password, provider });
    } catch (e: any) {
      if (e?.data?.totpRequired) throw e;
      if (e?.status === 401) throw fail(`There’s already an online Kea account for ${rec.email} with a different password. Continue with ${label} again to sign in to it.`, 409, { existsOnline: true });
      throw e;
    }
  }
  try {
    return await signedIn(await oauthLogin(provider, idToken, code), { provider });
  } catch (e: any) {
    if (e?.status === 404) throw fail(`There’s no online Kea account for ${rec.email} yet. Enter this account’s password and agree to the terms to make it.`, 404, { needsCreate: true });
    throw e;
  }
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
// (The last ID token, for a minute or two: a two-step code or the terms asked next don't open the browser again.)
let lastToken: { provider: Provider; idToken: string; at: number } | null = null;

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
  lastToken = { provider, idToken: j.id_token, at: Date.now() };
  return j.id_token;
}
async function idTokenFor(provider: Provider, loginHint: string | undefined, { reuse = false, purpose }: { reuse?: boolean; purpose: 'signin' | 'link' }): Promise<string> {
  const label = PROVIDERS[provider]?.label || provider;
  if (!clientId(provider)) throw fail(`Continue with ${label} isn’t set up in this copy of Kea.`, 503);
  // (Only a token for the same email: one that didn't link is never tried again.)
  if (reuse && lastToken && lastToken.provider === provider && Date.now() - lastToken.at < 2 * 60e3 && (!loginHint || idTokenEmail(lastToken.idToken).email === norm(loginHint))) return lastToken.idToken;
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
  return p.purpose === 'link' ? link({ provider: p.provider }, idToken) : finishOauthSignIn(p.provider, idToken);
}

/** Plain words for a failed account action (offline is calm, never an error screen). */
export const accountProblem = (e: any) => String(e?.message || e);
