// Work on the phone, without Android: the organization servers this Kea account joined, signing in to them with a
// server pass (protocol section 2), hosted organizations on the Kea account server (section 5), and the Work tab's
// lists put together from all of them, with a saved copy for when they can't be reached. orgs.ts wires this to the
// phone's native side (KeaPlugin org*, Orgs.java); the tests use it with a stand-in phone, account server and KeaS.
// The same model as Kea on the computer (electron/serversCore.cjs, electron/hubOrg.cjs).
//
//   1. The server proves who it is: GET <keas>/v1/identity?nonce=<n> answers { serverId, publicKey (JWK), name, sig },
//      sig = Ed25519 over "kea-server-identity:<serverId>:<nonce>", serverId = base64url(sha256(raw key))[0..22].
//      The native side checks the signature with Android's own Ed25519 (Android 13 and later); this code checks it
//      again with the WebView's WebCrypto Ed25519, which is how phones before Android 13 check it. The id is pinned on
//      joining: a server at the same address with another id is refused from then on.
//   2. A pass for that id from the Kea account server: POST <keac>/v1/pass { serverId } -> { pass, exp }. Native code
//      asks for it with the account session, checks it's for this server (aud keas:<id>) and keeps it.
//   3. The pass for the server's own session: POST <keas>/v1/auth/pass { pass } -> { token, exp }. Kept natively too.
//      Passes and sessions never reach this code: it only sees when they were made and when they end.
//   4. Passes are renewed once a day while online. While the account server can't be reached, the phone keeps using
//      the pass and session it has. A server that refuses a brand-new pass has signed this account out.
//
// Hosted organizations (on the Kea account server, when its /v1/health lists 'hostedOrgs'; a Kea Hub 0.5 has its own
// organizations too) take the account session itself: no pass.
//
// (Only erasable TypeScript here: Node runs this file as it is in the tests.)

export const DAY = 864e5;
/** A pass older than this is renewed (about once a day). */
export const PASS_RENEW_MS = 20 * 3600e3;
/** The Kea account server, as a source of organizations. */
export const HUB = 'hub';

export class OrgError extends Error {
  status: number;
  data: any;
  constructor(message: string, status: number, data: any = null) {
    super(message);
    this.status = status;
    this.data = data ?? null;
  }
}

// ---------- bytes ----------
const subtle = (): SubtleCrypto | null => (globalThis as any).crypto?.subtle ?? null;
function b64urlOf(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function bytesOf(s: string): Uint8Array {
  const t = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  if (/[^A-Za-z0-9+/=]/.test(t)) return new Uint8Array(0);
  let bin = '';
  try {
    bin = atob(t + '==='.slice((t.length + 3) % 4));
  } catch {
    return new Uint8Array(0);
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const utf8 = (s: string) => new TextEncoder().encode(s);

/** serverId for a raw 32-byte Ed25519 public key. */
export async function serverIdOf(raw: Uint8Array): Promise<string> {
  const s = subtle();
  if (!s) throw new OrgError('This phone can’t check servers.', 495, { identity: false });
  return b64urlOf(new Uint8Array(await s.digest('SHA-256', raw as BufferSource))).slice(0, 22);
}

/** Ed25519 through WebCrypto: true or false, or null when this WebView has no Ed25519. */
export async function webEd25519(rawKey: Uint8Array, message: Uint8Array, sig: Uint8Array): Promise<boolean | null> {
  const s = subtle();
  if (!s) return null;
  let key: CryptoKey;
  try {
    key = await s.importKey('raw', rawKey as BufferSource, { name: 'Ed25519' }, false, ['verify']);
  } catch (e: any) {
    // (An older WebView doesn't know the algorithm; a key it knows but can't use is simply a wrong one.)
    return e?.name === 'NotSupportedError' || /not supported|unrecognized|unknown/i.test(String(e?.message)) ? null : false;
  }
  try {
    return await s.verify({ name: 'Ed25519' }, key, sig as BufferSource, message as BufferSource);
  } catch {
    return false;
  }
}

// ---------- addresses and join links ----------
/** A server address Kea will talk to: https anywhere, plain http only to the phone itself. Returns its origin. */
export function cleanUrl(input: unknown): string {
  const s = String(input ?? '').trim();
  if (!s) throw new OrgError('Enter the server’s address.', 400);
  let u: URL;
  try {
    u = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    throw new OrgError('That isn’t a server address. It looks like https://name.example.org', 400);
  }
  if (!/^https?:$/.test(u.protocol)) throw new OrgError('Use an https:// address.', 400);
  if (u.username || u.password) throw new OrgError('That isn’t a server address. It looks like https://name.example.org', 400);
  if (u.protocol === 'http:' && !/^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/i.test(u.hostname)) throw new OrgError('Use the server’s https:// address.', 400);
  return u.origin;
}

/**
 * What someone pasted or typed to join: a join link (kea://join?s=...&c=...), or { address, code } from Advanced.
 * A bare code (no server) returns { url: null, code }: a code for the Kea account server's own organizations.
 */
export function parseJoin(input: unknown): { url: string | null; code: string } {
  if (input && typeof input === 'object') {
    const o = input as { address?: string; code?: string };
    const code = String(o.code ?? '').trim();
    if (!code) throw new OrgError('Enter the join code.', 400);
    return { url: o.address && String(o.address).trim() ? cleanUrl(o.address) : null, code };
  }
  const s = String(input ?? '').trim();
  if (/^kea:/i.test(s)) {
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      throw new OrgError('That join link isn’t complete. Copy the whole link again.', 400);
    }
    // (kea://join?... parses with host "join"; kea:join?... with path "join".)
    const what = (u.host || u.pathname.replace(/^\/+/, '')).toLowerCase();
    if (what !== 'join') throw new OrgError('That isn’t a join link.', 400);
    const server = u.searchParams.get('s');
    const code = (u.searchParams.get('c') || '').trim();
    if (!server || !code) throw new OrgError('That join link isn’t complete. Copy the whole link again.', 400);
    return { url: cleanUrl(server), code };
  }
  if (!s) throw new OrgError('Enter the join code.', 400);
  if (s.length > 200) throw new OrgError('That isn’t a join code.', 400);
  return { url: null, code: s };
}
export const joinLink = (url: string, code: string) => `kea://join?s=${encodeURIComponent(cleanUrl(url))}&c=${encodeURIComponent(String(code).trim())}`;

/** Whether the Kea account server has organizations of its own (its /v1/health). */
export function hostedOrgsOn(health: any): boolean {
  if (!health || typeof health !== 'object') return false;
  // (A Kea Hub 0.5 sends no feature list, and has organizations on the account session.)
  if (!Array.isArray(health.features)) return health.service !== 'keac';
  return health.features.includes('hostedOrgs');
}

// ---------- the server's identity ----------
export interface Identity {
  serverId: string;
  name: string | null;
}
/**
 * Checks a server's answer to /v1/identity for `nonce`. `nativeCheck`: what Android's own Ed25519 said ('ok', 'bad',
 * or 'unavailable' before Android 13). Returns { serverId, name } or throws (status 495: it couldn't prove who it is).
 */
export async function checkIdentity(answer: any, nonce: string, expectId: string | null = null, nativeCheck: 'ok' | 'bad' | 'unavailable' = 'unavailable'): Promise<Identity> {
  const refuse = (why: string): never => {
    throw new OrgError(`This server couldn’t prove who it is, so Kea didn’t connect (${why}).`, 495, { identity: false });
  };
  const a = answer && typeof answer === 'object' ? answer : {};
  const jwk = a.publicKey;
  if (!jwk || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') refuse('no Ed25519 key');
  const raw = bytesOf(jwk.x);
  if (raw.length !== 32) refuse('a key of the wrong length');
  const id = await serverIdOf(raw);
  if (a.serverId !== id) refuse('its id doesn’t match its key');
  if (nativeCheck === 'bad') refuse('its signature is wrong');
  const sig = bytesOf(a.sig || '');
  const web = sig.length === 64 ? await webEd25519(raw, utf8(`kea-server-identity:${id}:${nonce}`), sig) : false;
  if (web === false) refuse('its signature is wrong');
  if (web === null && nativeCheck !== 'ok') throw new OrgError('This phone can’t check a server’s identity yet, so Kea didn’t connect. Updating Android System WebView (or Android) fixes it.', 495, { identity: false, unsupported: true });
  if (expectId && id !== expectId) throw new OrgError('The server at this address isn’t the one you joined. Kea didn’t connect. If the organization moved its server, remove it here and join again with a new link.', 495, { identity: false, changed: true });
  return { serverId: id, name: String(a.name || '').slice(0, 120) || null };
}

// ---------- abilities (the same rules as Kea on the computer: src/components/work/types.ts) ----------
// A newer server sends each person's abilities (me.abilities, me.scopes) with the organization. A Kea Hub 0.5 sends
// only the fixed role: then the role's abilities are these (the lists the newer server starts its roles with).
export type Role = 'owner' | 'admin' | 'manager' | 'member';
const MEMBER_ABILITIES = ['clock.self', 'timeoff.request'];
const MANAGER_ABILITIES = [...MEMBER_ABILITIES, 'people.view', 'people.approve', 'people.verify', 'people.edit', 'people.remove', 'codes.make', 'budgets.view', 'certs.manage', 'classes.manage', 'forms.manage', 'schedule.view', 'schedule.edit', 'schedule.publish', 'swaps.decide', 'policies.manage', 'timecards.view', 'timecards.approve', 'timeoff.decide'];
const ADMIN_ABILITIES = [...MANAGER_ABILITIES, 'people.birthdate', 'roles.assign', 'roles.manage', 'structure.edit', 'settings.edit', 'rates.view', 'rates.assign', 'budgets.costs', 'budgets.edit', 'certs.types'];
export const ROLE_ABILITIES: Record<Role, string[]> = { member: MEMBER_ABILITIES, manager: MANAGER_ABILITIES, admin: ADMIN_ABILITIES, owner: [...ADMIN_ABILITIES] };
const SELF_ABILITIES = new Set(['clock.self', 'timeoff.request']);
export interface AbilityHolder {
  role?: Role | null;
  memberStatus?: string | null;
  abilities?: string[] | null;
  scopes?: Record<string, 'org' | string[]> | null;
}
/**
 * Can I do this in this organization? deptId: undefined = anywhere at all, null = for the whole organization, a
 * department id = there. (The server has the last word: it refuses what I can't do.)
 */
export function can(org: AbilityHolder | null | undefined, ability: string, deptId?: string | null): boolean {
  if (!org || org.memberStatus !== 'active') return false;
  if (!Array.isArray(org.abilities)) {
    if (org.role === 'owner') return true;
    return (ROLE_ABILITIES[(org.role || 'member') as Role] ?? []).includes(ability);
  }
  const s = org.scopes?.[ability] ?? (org.abilities.includes(ability) ? 'org' : undefined);
  if (!s) return false;
  if (s === 'org' || SELF_ABILITIES.has(ability)) return true;
  if (deptId === undefined) return s.length > 0;
  return deptId != null && s.includes(deptId);
}
export const canAny = (org: AbilityHolder | null | undefined, list: string[], deptId?: string | null) => list.some((a) => can(org, a, deptId));
/** What the Work tab offers someone in an organization (only screens for things they can do). */
export function workAreas(org: AbilityHolder | null | undefined) {
  return {
    clock: can(org, 'clock.self'),
    timeOff: can(org, 'timeoff.request'),
    approveJoins: can(org, 'people.approve'),
    approveTime: canAny(org, ['timecards.approve', 'timeoff.decide']),
    approveTimecards: can(org, 'timecards.approve'),
    decideTimeOff: can(org, 'timeoff.decide'),
    decideSwaps: can(org, 'swaps.decide'),
    editShifts: can(org, 'schedule.edit'),
    publish: can(org, 'schedule.publish'),
    teamSchedule: canAny(org, ['schedule.view', 'schedule.edit']),
    approvals: canAny(org, ['people.approve', 'timecards.approve', 'timeoff.decide', 'swaps.decide'])
  };
}

// ---------- the client ----------
export interface ServerView {
  serverId: string;
  url: string;
  name: string | null;
  joinedAt: number;
  signedOut: boolean;
  message: string | null;
  passAt: number | null;
  passExp: number | null;
  hasPass: boolean;
  hasToken: boolean;
}
export interface NativeAnswer {
  status: number;
  body: string;
}
/**
 * The native side: it keeps the joined servers, passes and server sessions in Android's encrypted storage, and makes
 * every request. A call that couldn't reach anything rejects. None of it ever returns a pass or a session token.
 */
export interface NativeOrgs {
  orgList(o: { account: string }): Promise<{ servers: ServerView[] }>;
  /** GET <url>/v1/identity with a fresh nonce; `check`: Android's own Ed25519 verdict. */
  orgIdentity(o: { url: string }): Promise<NativeAnswer & { nonce: string; check: 'ok' | 'bad' | 'unavailable' }>;
  /** Adds a server just checked by orgIdentity (the native side refuses one it hasn't checked). */
  orgAdd(o: { account: string; url: string; serverId: string; name: string | null }): Promise<void>;
  orgUpdate(o: { account: string; serverId: string; name?: string | null; signedOut?: boolean; message?: string | null }): Promise<void>;
  orgRemove(o: { account: string; serverId: string }): Promise<void>;
  /** POST <account server>/v1/pass { serverId } with the account session; the pass is kept natively. */
  orgFetchPass(o: { account: string; serverId: string }): Promise<NativeAnswer & { exp?: number }>;
  /** POST <server>/v1/auth/pass with the kept pass; the session is kept natively. */
  orgSignIn(o: { account: string; serverId: string }): Promise<NativeAnswer>;
  orgRequest(o: { account: string; serverId: string; method: string; path: string; body?: string }): Promise<NativeAnswer>;
  orgDropSession(o: { account: string; serverId: string }): Promise<void>;
}
export interface AccountSide {
  /** This Kea account's id on the phone (each account has its own servers and saved copy), or null. */
  key(): string | null;
  /** Signed in online here (an account session to ask for passes with). */
  online(): boolean;
  /** The Kea account server has organizations of its own. */
  hosted(): Promise<boolean>;
  /** A request to the Kea account server with the account session (throws { status, message, data }). */
  req(method: string, path: string, body?: unknown): Promise<any>;
}
export interface KeyValue {
  get(k: string): string | null;
  set(k: string, v: string): void;
  remove(k: string): void;
}

const parse = (t: string) => {
  try {
    const j = t ? JSON.parse(t) : {};
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
};
const UNREACHABLE = 'Can’t reach this organization’s server right now. Kea tries again by itself.';
const unreachable = (detail?: unknown) => new OrgError(UNREACHABLE, 0, { unreachable: true, detail: detail == null ? null : String((detail as any)?.message ?? detail) });
const routeOk = (p: string) => typeof p === 'string' && p.length < 2000 && p.startsWith('/v1/') && !p.includes('..') && /^\/v1\/(orgs(\/|$|\?)|orgs-calendar(\?|$)|todo(\/snooze)?(\?|$))/.test(p);

export interface WorkOrg {
  id: string;
  name: string;
  tz: string;
  role?: Role | null;
  memberStatus?: string | null;
  status?: string;
  abilities?: string[] | null;
  scopes?: Record<string, 'org' | string[]> | null;
  myId?: string | null;
  settings?: any;
  /** Where it is: 'hub' (the Kea account server) or a joined server's id. */
  src: string;
  serverName: string | null;
}

export function createOrgClient({ native, account, store, now = () => Date.now() }: { native: NativeOrgs; account: AccountSide; store: KeyValue; now?: () => number }) {
  const me = () => {
    const k = account.key();
    if (!k) throw new OrgError('Sign in to your Kea account first.', 401, { needsAccount: true });
    return k;
  };
  async function servers(): Promise<ServerView[]> {
    const k = account.key();
    if (!k) return [];
    try {
      return (await native.orgList({ account: k })).servers || [];
    } catch {
      return [];
    }
  }
  const find = async (id: string) => (await servers()).find((s) => s.serverId === id) ?? null;

  async function identity(url: string, expectId: string | null): Promise<Identity> {
    let r;
    try {
      r = await native.orgIdentity({ url });
    } catch (e) {
      throw unreachable(e);
    }
    if (r.status < 200 || r.status >= 300) throw new OrgError(r.status === 404 ? 'There’s no Kea organization server at that address.' : parse(r.body).error || `The server said ${r.status}.`, r.status === 404 ? 404 : 502);
    return checkIdentity(parse(r.body), r.nonce, expectId, r.check);
  }

  /** A pass for this server: a new one from the account server, or (while it can't be reached) the one kept. */
  async function pass(s: ServerView, fresh: boolean): Promise<void> {
    const have = s.hasPass && (s.passExp ?? 0) > now() + 60_000;
    if (have && !fresh && now() - (s.passAt || 0) < PASS_RENEW_MS) return;
    if (!account.online()) {
      // (Signed in on this phone only: the pass kept keeps working until it ends.)
      if (have) return;
      throw new OrgError('Sign in with Google to connect to this organization.', 401, { needsOnline: true });
    }
    let r;
    try {
      r = await native.orgFetchPass({ account: me(), serverId: s.serverId });
    } catch {
      // The account server is down or the phone is offline: keep going on the pass kept (protocol 2.7).
      if (have) return;
      throw new OrgError('Can’t reach the Kea account server right now, so Kea can’t connect to this organization yet. It tries again by itself.', 0, { unreachable: true, account: true });
    }
    if (r.status >= 200 && r.status < 300) return;
    if (r.status === 404 || r.status === 405) throw new OrgError('Your Kea account server can’t sign you in to other servers yet. It needs an update.', 501, { noPasses: true });
    const d = parse(r.body);
    if (r.status === 502 && d.wrongAudience) throw new OrgError('The Kea account server sent a pass for another server. Kea didn’t use it.', 502);
    if (r.status === 0 && have) return;
    throw new OrgError(d.error || `Your Kea account server answered ${r.status}.`, r.status || 0, { ...d, account: true });
  }

  const signedOutError = (s: Pick<ServerView, 'name' | 'serverId'>, reason?: string | null) => new OrgError(`${s.name || 'This organization'} signed you out.`, 401, { signedOut: true, serverId: s.serverId, reason: reason || null });

  /** Signs in to a server with a pass: checks who it is first, then trades the pass for the server's session. */
  async function signIn(s: ServerView, fresh = false): Promise<void> {
    await identity(s.url, s.serverId);
    await pass(s, fresh);
    let r;
    try {
      r = await native.orgSignIn({ account: me(), serverId: s.serverId });
    } catch (e) {
      throw unreachable(e);
    }
    if (r.status === 401 || r.status === 403) {
      const reason = parse(r.body).error || null;
      // A pass the server won't take: once more with a brand-new one (an older pass may have been replaced). A server
      // that refuses that too has signed this account out (also when no newer pass can be had).
      if (!fresh) {
        try {
          return await signIn(s, true);
        } catch (e: any) {
          if (e?.data?.signedOut || e?.status === 495 || e?.status === 0) throw e;
        }
      }
      await native.orgUpdate({ account: me(), serverId: s.serverId, signedOut: true, message: reason }).catch(() => {});
      await native.orgDropSession({ account: me(), serverId: s.serverId }).catch(() => {});
      throw signedOutError(s, reason);
    }
    if (r.status < 200 || r.status >= 300) throw new OrgError(parse(r.body).error || `The server said ${r.status}.`, r.status);
    if (s.signedOut) await native.orgUpdate({ account: me(), serverId: s.serverId, signedOut: false, message: null }).catch(() => {});
  }

  /** A request to a joined server, with its session (signing in with a pass when there's none or it ended). */
  async function serverReq(id: string, method: string, p: string, body?: unknown): Promise<any> {
    const s = await find(id);
    if (!s) throw new OrgError('This server isn’t one of yours on this phone.', 404);
    if (s.signedOut) throw signedOutError(s, s.message);
    if (!s.hasToken) await signIn(s);
    const send = async () => {
      try {
        return await native.orgRequest({ account: me(), serverId: id, method, path: p, body: body === undefined ? undefined : JSON.stringify(body) });
      } catch (e) {
        throw unreachable(e);
      }
    };
    let r = await send();
    if (r.status === 401) {
      // The server session ended: a new one from the pass (signIn marks the account signed out if that's refused).
      await signIn({ ...s, hasToken: false });
      r = await send();
    }
    const d = parse(r.body);
    if (r.status < 200 || r.status >= 300) throw new OrgError(d.error || `The server said ${r.status}.`, r.status, d);
    return d;
  }

  /**
   * Joining by link (or address + code): the server proves who it is, a pass gets a session, and the code goes to
   * the server. A bare code goes to the Kea account server's own organizations.
   */
  async function join(input: unknown): Promise<{ org: any; pending?: boolean; message?: string; alreadyMember?: boolean; server: ServerView | null }> {
    const { url, code } = parseJoin(input);
    const acct = me();
    if (!url) {
      if (!account.online()) throw new OrgError('Sign in with Google to join with a code.', 401, { needsOnline: true });
      if (!(await account.hosted().catch(() => false))) throw new OrgError('That code doesn’t say which server it’s for. Use the join link, or enter the server’s address under Advanced.', 400, { needsServer: true });
      const r = await account.req('POST', '/v1/orgs/join', { code });
      return { ...r, server: null };
    }
    const known = (await servers()).find((s) => s.url === url) ?? null;
    if (!known && !account.online()) throw new OrgError('Sign in with Google to join an organization.', 401, { needsOnline: true });
    const id = await identity(url, known?.serverId ?? null);
    if (!known) await native.orgAdd({ account: acct, url, serverId: id.serverId, name: id.name });
    else if (known.signedOut) await native.orgUpdate({ account: acct, serverId: known.serverId, signedOut: false, message: null });
    const entry = (await find(id.serverId)) as ServerView;
    try {
      await signIn(entry, !!known?.signedOut);
      const r = await serverReq(id.serverId, 'POST', '/v1/orgs/join', { code });
      if (id.name && id.name !== entry.name) await native.orgUpdate({ account: acct, serverId: id.serverId, name: id.name });
      return { ...r, server: await find(id.serverId) };
    } catch (e) {
      // (Added first, so the pass and session could be kept for it; taken out again when the code didn't work.)
      if (!known) await native.orgRemove({ account: acct, serverId: id.serverId }).catch(() => {});
      throw e;
    }
  }

  /** Renews passes (and so server sessions) a day old. Quiet: nothing is shown for a server that can't be reached. */
  async function renew() {
    const out: { serverId: string; ok: boolean; status?: number; error?: string }[] = [];
    for (const s of await servers()) {
      if (s.signedOut) continue;
      if (s.passAt && now() - s.passAt < PASS_RENEW_MS && s.hasToken) continue;
      try {
        await signIn(s);
        out.push({ serverId: s.serverId, ok: true });
      } catch (e: any) {
        out.push({ serverId: s.serverId, ok: false, status: e?.status, error: String(e?.message || e) });
      }
    }
    return out;
  }

  /** "Sign in again" after a server signed this account out: a new pass, and the server decides. */
  async function again(id: string) {
    const s = await find(id);
    if (!s) throw new OrgError('This server isn’t one of yours on this phone.', 404);
    await native.orgUpdate({ account: me(), serverId: id, signedOut: false, message: null });
    await signIn({ ...s, signedOut: false, hasPass: false }, true);
    return find(id);
  }
  async function remove(id: string) {
    await native.orgRemove({ account: me(), serverId: id });
    dropCache((src) => src === id);
  }

  // ---------- organizations on every source ----------
  const orgSource = new Map<string, string>();
  const todoSource = new Map<string, string>();
  async function sources(): Promise<string[]> {
    const out: string[] = [];
    if (account.online() && (await account.hosted().catch(() => false))) out.push(HUB);
    for (const s of await servers()) out.push(s.serverId);
    return out;
  }
  async function send(src: string, method: string, p: string, body?: unknown) {
    if (!routeOk(p)) throw new OrgError('Kea can’t send that to an organization.', 400);
    if (src === HUB) {
      try {
        return await account.req(method, p, body);
      } catch (e: any) {
        throw new OrgError(String(e?.message || e), e?.status ?? 0, e?.data ?? null);
      }
    }
    return serverReq(src, method, p, body);
  }
  const all = async (method: string, p: string) =>
    Promise.all((await sources()).map((src) => send(src, method, p).then((value) => ({ src, ok: true as const, value }), (error: OrgError) => ({ src, ok: false as const, error }))));

  /** One org route, to the server that holds that organization. */
  async function call(orgId: string, method: string, p: string, body?: unknown) {
    if (!orgSource.has(orgId) && !readCache().orgs.some((o) => o.id === orgId)) await orgs().catch(() => null);
    const src = orgSource.get(orgId) ?? readCache().orgs.find((o) => o.id === orgId)?.src;
    if (!src) throw new OrgError('That organization isn’t one of yours on this phone.', 404);
    return send(src, method, p, method === 'GET' ? undefined : body ?? {});
  }

  // ---------- the saved copy (this account's only; never tokens, only what the Work tab shows) ----------
  const cacheKey = () => `kea.work.${me()}`;
  interface Cache {
    account: string;
    at: number;
    orgs: WorkOrg[];
    shifts: any[];
    todo: any[];
    seen: Record<string, number>;
  }
  function readCache(): Cache {
    const empty: Cache = { account: account.key() || '', at: 0, orgs: [], shifts: [], todo: [], seen: {} };
    try {
      const c = JSON.parse(store.get(cacheKey()) || 'null');
      if (!c || c.account !== account.key()) return empty;
      return { ...empty, ...c };
    } catch {
      return empty;
    }
  }
  function writeCache(c: Cache) {
    try {
      store.set(cacheKey(), JSON.stringify(c));
    } catch {}
  }
  function dropCache(which: (src: string) => boolean) {
    const c = readCache();
    writeCache({ ...c, orgs: c.orgs.filter((o) => !which(o.src)), shifts: c.shifts.filter((x) => !which(x.src)), todo: c.todo.filter((x) => !which(x.src)) });
  }

  /** My organizations on every source, each with what I can do there. Sources that can't be reached keep their copy. */
  async function orgs(): Promise<{ orgs: WorkOrg[]; servers: (ServerView & { offline: boolean; error: string | null })[]; offline: string[]; hubOffline: boolean; hubError: string | null; at: number | null }> {
    const res = await all('GET', '/v1/orgs');
    const list = await servers();
    const names = new Map(list.map((s) => [s.serverId, s.name]));
    const cache = readCache();
    const out: WorkOrg[] = [];
    const offline: string[] = [];
    for (const r of res) {
      if (!r.ok) {
        // (A Kea account server without organizations answers 404: that's simply none.)
        if (r.src === HUB && r.error.status === 404) continue;
        if (r.error.status === 0) {
          offline.push(r.src);
          for (const o of cache.orgs.filter((x) => x.src === r.src)) (orgSource.set(o.id, o.src), out.push(o));
        }
        continue;
      }
      const got = (r.value?.orgs || []) as any[];
      const details = await Promise.all(got.map((o) => send(r.src, 'GET', `/v1/orgs/${encodeURIComponent(o.id)}`).catch(() => null)));
      got.forEach((o, i) => {
        const d = details[i];
        const m = d?.me ?? null;
        orgSource.set(o.id, r.src);
        out.push({
          id: o.id,
          name: o.name,
          tz: o.tz || 'UTC',
          role: (m?.role ?? o.role ?? null) as Role | null,
          memberStatus: o.memberStatus ?? m?.status ?? null,
          status: o.status,
          abilities: Array.isArray(m?.abilities) ? m.abilities : null,
          scopes: m?.scopes ?? null,
          myId: m?.id ?? null,
          settings: d?.org?.settings ?? o.settings ?? null,
          src: r.src,
          serverName: r.src === HUB ? null : names.get(r.src) ?? null
        });
      });
    }
    // (Nothing throws here: a server that signed this account out, or one that needs online, says so on its own line.)
    const hubFailed = res.find((r) => !r.ok && r.src === HUB && r.error.status !== 404 && r.error.status !== 0) as { error: OrgError } | undefined;
    const answered = new Set(res.filter((r) => r.ok).map((r) => r.src));
    writeCache({ ...cache, account: me(), at: answered.size ? now() : cache.at, orgs: out, seen: { ...cache.seen, ...Object.fromEntries([...answered].map((s) => [s, now()])) } });
    return {
      orgs: out,
      servers: list.map((s) => {
        const r = res.find((x) => x.src === s.serverId);
        return { ...s, offline: !!r && !r.ok && r.error.status === 0, signedOut: s.signedOut || (!!r && !r.ok && !!r.error.data?.signedOut), error: r && !r.ok && r.error.status !== 0 ? r.error.message : null };
      }),
      offline,
      hubOffline: offline.includes(HUB),
      hubError: hubFailed ? hubFailed.error.message : null,
      at: offline.length ? cache.seen[offline[0]] ?? cache.at ?? null : null
    };
  }

  /** My upcoming published shifts from every organization, soonest first; the saved copy for the ones offline. */
  async function shifts({ days = 42 }: { days?: number } = {}) {
    const o = await orgs();
    const from = new Date(now() - 12 * 3600e3).toISOString();
    const to = new Date(now() + days * DAY).toISOString();
    const cache = readCache();
    const out: any[] = [];
    const offline = new Set(o.offline);
    const missed = new Set<string>();
    await Promise.all(
      o.orgs.map(async (org) => {
        if (offline.has(org.src)) return;
        try {
          const r = await send(org.src, 'GET', `/v1/orgs/${encodeURIComponent(org.id)}/my-shifts?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
          for (const s of r.shifts || []) out.push({ ...s, orgId: org.id, orgName: org.name, tz: org.tz, src: org.src });
        } catch (e: any) {
          if (e?.status === 0) missed.add(org.id);
        }
      })
    );
    const kept = cache.shifts.filter((s) => (offline.has(s.src) || missed.has(s.orgId)) && Date.parse(s.end) > now());
    const fresh = [...out].sort((a, b) => a.startAt - b.startAt);
    const shown = [...fresh, ...kept].sort((a, b) => (a.startAt ?? Date.parse(a.start)) - (b.startAt ?? Date.parse(b.start)));
    const c = readCache();
    writeCache({ ...c, shifts: [...fresh, ...c.shifts.filter((s) => (offline.has(s.src) || missed.has(s.orgId)) && Date.parse(s.end) > now() - DAY)] });
    return { shifts: shown, orgs: o.orgs, saved: kept.length > 0 || offline.size > 0 || missed.size > 0, offline: o.offline, at: o.at };
  }

  /** My to-dos from every source (the saved copy for the ones offline). */
  async function todo() {
    const res = await all('GET', '/v1/todo');
    const cache = readCache();
    const offline = res.filter((r) => !r.ok && r.error.status === 0).map((r) => r.src);
    const items: any[] = [];
    for (const r of res) {
      if (!r.ok) continue;
      for (const it of r.value?.items || []) (todoSource.set(it.key, r.src), items.push({ ...it, src: r.src }));
    }
    const kept = cache.todo.filter((t) => offline.includes(t.src));
    writeCache({ ...readCache(), todo: [...items, ...kept] });
    const list = [...items, ...kept].sort((a, b) => Number(!!b.overdue) - Number(!!a.overdue) || (b.urgency ?? 0) - (a.urgency ?? 0) || (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity));
    if (!res.some((r) => r.ok) && !kept.length && res.length && !offline.length) throw (res.find((r) => !r.ok) as any)?.error;
    return { items: list, saved: offline.length > 0, offline, at: offline.length ? cache.seen[offline[0]] ?? cache.at : null };
  }

  /** What was saved last time, from the phone alone (for the first moment, and when nothing answers). */
  function saved() {
    const c = readCache();
    return { orgs: c.orgs, shifts: c.shifts.filter((s) => Date.parse(s.end) > now()), todo: c.todo, at: c.at || null };
  }

  /**
   * Clock in or out. Never queued: a punch is made by the organization's server at the moment it gets it, so while
   * the server can't be reached this says so instead (the server has no offline punches).
   */
  async function clock(orgId: string, type: 'in' | 'out', payCodeId?: string | null) {
    const name = readCache().orgs.find((o) => o.id === orgId)?.name ?? 'your organization';
    try {
      return await call(orgId, 'POST', `/v1/orgs/${encodeURIComponent(orgId)}/clock`, { type, source: 'phone', ...(type === 'in' && payCodeId ? { payCodeId } : {}) });
    } catch (e: any) {
      if (e?.status === 0) throw new OrgError(`Clocking ${type} needs a connection to ${name}.`, 0, { unreachable: true, notQueued: true });
      throw e;
    }
  }

  /** Is this organization's server answering right now (from the last lists)? */
  const sourceOf = (orgId: string) => orgSource.get(orgId) ?? readCache().orgs.find((o) => o.id === orgId)?.src ?? null;

  /** A to-do's snooze goes to the server that sent it. */
  const snooze = (key: string, hours = 24) => send(todoSource.get(key) ?? HUB, 'POST', '/v1/todo/snooze', { key, hours });

  /** Another account signed in, or this one signed out: its copy goes. */
  const forgetCache = () => {
    try {
      store.remove(cacheKey());
    } catch {}
  };

  return { servers, join, renew, again, remove, orgs, shifts, todo, saved, clock, call, sourceOf, snooze, identity, forgetCache, _signIn: signIn };
}
export type OrgClient = ReturnType<typeof createOrgClient>;
