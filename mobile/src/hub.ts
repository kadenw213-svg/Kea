// The phone's link to the online Kea account (the same account as Kea on the PC): requests, the terms gate, and syncing
// the PC's Kea folder through Kea cloud instead of a cloud drive's file picker. When this phone is signed in and Kea's
// folder is found (hubPickFolder: the newest one, picked by itself), kea.ts reads and writes through here; otherwise it
// keeps using the drive files.
//
// Requests go through native code (KeaPlugin.hubRequest, Hub.java), which holds the session token in Android's
// encrypted storage and adds it to each request: the web code never sees the token.
import { Kea } from './kea';
import { normalizeAccountUrl } from './accountCore';
import { FULL_EVERY, createPhoneSync, newestProfileIn, profilesIn, toRemote, type HubFile, type SyncClient, type SyncState } from './hubsync';

const PROFILE = 'kea.hubProfile';
const STATE = 'kea.hubSync';
const ON = 'kea.hubOn';

export class HubError extends Error {
  constructor(
    message: string,
    public status: number,
    public data: any = {}
  ) {
    super(message);
  }
}

/** What someone types → the account server's https origin (accountCore.normalizeAccountUrl, as a HubError). */
export function normalizeHubUrl(input: string): string {
  try {
    return normalizeAccountUrl(input);
  } catch (e: any) {
    throw new HubError(String(e?.message || e), 400);
  }
}

/** Not reaching the server is a normal answer (status 0): the app shows "offline", never an error screen. */
export const OFFLINE_MSG = 'Can’t reach the Kea account server right now. Everything on this phone still works; Kea tries again by itself.';
/** How long a request may take (connecting, then reading): background checks are short, files may be big. */
export const LIMITS = { status: { connectMs: 4000, readMs: 4000 }, auth: { connectMs: 8000, readMs: 20000 } } as const;

// ---------- whether the server answered lately (this run of the app) ----------
export const reach = { reachable: false, at: 0 };
const listeners = new Set<() => void>();
/** Something about the account changed by itself (the session ended, the server came back): tell the screens. */
export function onAccountChange(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
export function accountChanged() {
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {}
  }
}
function seen(ok: boolean) {
  const was = reach.reachable;
  reach.reachable = ok;
  reach.at = Date.now();
  if (was !== ok) accountChanged();
}

const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/');
const parse = (text: string) => {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
};

/**
 * One API call; throws HubError (with the server's own message) for anything but 2xx. `limit`: how long it may take
 * (LIMITS; files keep the native default). `reauth`: the route asks for a fresh Google or Microsoft sign-in, so a 401
 * is about that, not that the sign-in ended.
 */
export async function hubCall<T = any>(method: string, path: string, body?: unknown, opts: { auth?: boolean; keepToken?: boolean; limit?: keyof typeof LIMITS; reauth?: boolean } = {}): Promise<T> {
  let r: { status: number; body: string };
  const auth = opts.auth !== false;
  try {
    r = await Kea.hubRequest({ method, path, body: body === undefined ? undefined : JSON.stringify(body), auth, keepToken: opts.keepToken, ...(opts.limit ? LIMITS[opts.limit] : {}) });
  } catch (e: any) {
    seen(false);
    throw new HubError(OFFLINE_MSG, 0, { unreachable: true, detail: String(e?.message || e) });
  }
  seen(true);
  const data = parse(r.body);
  if (r.status >= 200 && r.status < 300) return data as T;
  if (r.status === 401 && auth && !data.totpRequired && !opts.reauth && (await Kea.hubState().catch(() => null))?.signedIn) {
    // The online session ended (signed out elsewhere, suspended). The account stays signed in on
    // this phone; only what needs it online waits for "Sign in online".
    await hubDropSession({ keepProfile: true });
    accountChanged();
  }
  throw new HubError(data.error || `Your Kea account server answered ${r.status}.`, r.status, data);
}

/** Plain words for why syncing through the Hub stopped. */
export function hubProblem(e: any): string {
  const s = e?.status;
  if (s === 401) return 'Your Kea account sign-in ended. Sign in again under Settings → Kea account.';
  if (s === 428) return 'The Kea terms have changed. Open Settings → Kea account to read what changed and agree.';
  if (s === 0) return 'Couldn’t reach the Kea account server. Check your connection; your classes from last time are shown.';
  return String(e?.message || e);
}

// ---------- sign-in state ----------
export interface HubInfo {
  url: string;
  signedIn: boolean;
  email: string;
  root: string;
  profile: string;
}
export const hubProfile = () => localStorage.getItem(PROFILE) || '';
/** Signed in with a profile chosen, as last known (kea.ts asks this synchronously before each read or write). */
export const hubOn = () => localStorage.getItem(ON) === '1' && !!hubProfile();
export async function hubInfo(): Promise<HubInfo> {
  const s = await Kea.hubState().catch(() => ({ url: '', signedIn: false, email: '', root: '' }));
  try {
    localStorage.setItem(ON, s.signedIn ? '1' : '0');
  } catch {}
  return { ...s, profile: hubProfile() };
}

export interface TermsSection {
  id: string;
  title: string;
  body: string;
}
export interface TermsGate {
  version: number;
  summary: string;
  /** Only what's new or changed since this account last agreed (everything, for an account that never did). */
  sections: (TermsSection & { kind: 'new' | 'changed' })[];
  removed: { id: string; title: string }[];
  /** Every section id of the current version (agreeing records them all; the rest were agreed to before). */
  allIds: string[];
}

/** What changed in the terms since this account last agreed. */
export async function termsGate(): Promise<TermsGate> {
  const [ch, cur] = await Promise.all([
    hubCall<{ to: number; summary: string; added: TermsSection[]; changed: { id: string; title: string; after: TermsSection }[]; removed: { id: string; title: string }[] }>('GET', '/v1/terms/changes'),
    hubCall<{ terms: { version: number; sections: TermsSection[] } }>('GET', '/v1/terms', undefined, { auth: false })
  ]);
  return {
    version: ch.to,
    summary: ch.summary || '',
    sections: [...ch.added.map((s) => ({ ...s, kind: 'new' as const })), ...ch.changed.map((c) => ({ ...c.after, kind: 'changed' as const }))],
    removed: ch.removed || [],
    allIds: cur.terms.sections.map((s) => s.id)
  };
}
export async function acceptTerms(g: TermsGate) {
  await hubCall('POST', '/v1/terms/accept', { termsVersion: g.version, termsSections: g.allIds });
}
/** The readable terms page on the Hub (only the changes, when `since` is given). */
export const termsUrl = (url: string, since?: number | null) => `${url}/terms${since ? `?since=${since}` : ''}`;

/** The folders (Kea → <name>) the PC has synced into this account's storage that have Kea's data file. */
export async function hubProfiles(): Promise<string[]> {
  const r = await hubCall<{ files: HubFile[] }>('GET', `/v1/files?prefix=${encodeURIComponent('kea/Kea/')}`);
  return profilesIn(r.files);
}
export function setHubProfile(name: string) {
  localStorage.setItem(PROFILE, name);
  sync().use(name);
}

let pickedAt = 0;
/**
 * Read the folder Kea on the PC writes the phone copy into: the one whose kea-data.json is newest (folders from before
 * one calendar per account may linger). Switches when a newer one appears. Returns the folder, or '' when there are no
 * classes in Kea cloud yet. Throws HubError like any call (offline, the terms gate, a sign-in that ended).
 */
export async function hubPickFolder(): Promise<string> {
  const r = await hubCall<{ files: HubFile[] }>('GET', `/v1/files?prefix=${encodeURIComponent('kea/Kea/')}`, undefined, { limit: 'auth' });
  pickedAt = Date.now();
  const newest = newestProfileIn(r.files) || '';
  if (newest && newest !== hubProfile()) setHubProfile(newest);
  return newest;
}

/**
 * The online session on this phone ends (another account signs in, the server ended it, or signing out): the token is
 * forgotten and the drive files (if chosen) take over again. `keepProfile`: the same account will sign in again, so
 * which classes it showed is kept.
 */
export async function hubDropSession({ keepProfile = false }: { keepProfile?: boolean } = {}) {
  await Kea.hubForget().catch(() => {});
  for (const k of keepProfile ? [ON] : [ON, PROFILE, STATE]) localStorage.removeItem(k);
  if (!keepProfile) engine = null;
}
/** A different account signed in online: the last one's classes and sync state are never shown to it. */
export function hubNewAccount() {
  for (const k of [PROFILE, STATE]) localStorage.removeItem(k);
  engine = null;
}
/** After an online sign-in: classes come through the account again. */
export function hubSessionStarted() {
  try {
    localStorage.setItem(ON, '1');
  } catch {}
}
/** Sign out: the server ends the session (if it can be reached soon), then the phone forgets it. */
export async function hubSignOut() {
  await hubCall('POST', '/v1/auth/logout', undefined, { limit: 'status' }).catch(() => {});
  await hubDropSession();
}

// ---------- the sync engine over the native client ----------
const client: SyncClient = {
  async list(prefix, since) {
    return hubCall('GET', `/v1/files?prefix=${encodeURIComponent(prefix)}&since=${since || 0}`);
  },
  async getText(path) {
    const r = await Kea.hubRequest({ method: 'GET', path: `/v1/files/${enc(path)}` });
    if (r.status !== 200) throw new HubError(parse(r.body).error || `Your Kea account server answered ${r.status}.`, r.status, parse(r.body));
    return { text: r.body, version: Number(r.version) || 0 };
  },
  async download(path, to, f) {
    const r = await Kea.hubDownload({ path: `/v1/files/${enc(path)}`, to, size: f.size, sha256: f.sha256 });
    if (r.status !== 200) throw new HubError(parse(r.body || '').error || `Your Kea account server answered ${r.status}.`, r.status);
  },
  async removeLocal(to) {
    await Kea.hubRemoveLocal({ to });
  },
  async putText(path, text, opts) {
    const r = await Kea.hubRequest({
      method: 'PUT',
      path: `/v1/files/${enc(path)}`,
      body: text,
      contentType: 'application/octet-stream',
      ifMatch: opts.ifMatch ? String(opts.ifMatch) : undefined,
      ifNoneMatch: !!opts.ifNoneMatch
    });
    const data = parse(r.body);
    if (r.status >= 300) throw new HubError(data.error || `Your Kea account server answered ${r.status}.`, r.status, data);
    return { version: Number(data.version) || 0 };
  }
};
let engine: ReturnType<typeof createPhoneSync> | null = null;
// One Hub pass at a time (reading the classes, the textbooks and sending phone.json all share the sync state).
let chain: Promise<unknown> = Promise.resolve();
const serial = <T,>(fn: () => Promise<T>): Promise<T> => {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
};
function sync() {
  if (!engine) {
    engine = createPhoneSync({
      client,
      load: () => {
        try {
          return JSON.parse(localStorage.getItem(STATE) || 'null') as SyncState | null;
        } catch {
          return null;
        }
      },
      save: (s) => {
        try {
          localStorage.setItem(STATE, JSON.stringify(s));
        } catch {}
      },
      log: (m) => console.warn(m)
    });
    if (hubProfile()) engine.use(hubProfile());
  }
  return engine;
}

/** kea-data.json from the Hub: its text when it changed (or `force`), else null (the copy from last time is current). */
export async function hubReadData(force: boolean): Promise<string | null> {
  return serial(async () => {
    // (Now and then, and when asked for anyway: a newer folder from the PC takes over. Offline: the one from last time.)
    if (force || Date.now() - pickedAt > FULL_EVERY) {
      const was = hubProfile();
      try {
        await hubPickFolder();
      } catch {}
      if (hubProfile() !== was) force = true;
    }
    return (await sync().pull(force)).data;
  });
}
export async function hubPushPhone(text: string) {
  return serial(() => sync().push(text));
}
/** The textbooks, one file at a time, in the same library folder the drive's zip unpacks into. */
export async function hubSyncLibrary(progress?: (p: { files: number; name: string }) => void) {
  const info = await Kea.hubState();
  const r = await serial(async () => {
    try {
      // (Something new may have arrived since the classes were read.)
      await sync().pull(false);
    } catch {}
    return sync().library(progress);
  });
  return { root: info.root, changed: r.files > 0 || r.removed > 0, files: r.total, missing: false, error: r.errors ? `${r.errors} textbook file${r.errors === 1 ? '' : 's'} didn’t download; they’re tried again next time.` : undefined };
}
/** The Hub path of this profile's folder (for messages). */
export const hubFolder = () => toRemote(`Kea/${hubProfile()}`);

// ---------- the account: notifications, storage, supporter ----------
export interface HubNote {
  id: number;
  kind: string;
  title: string;
  body: string;
  note: string | null;
  createdAt: number;
  readAt: number | null;
}
export interface HubMeSummary {
  name: string;
  supporter: { active: boolean; until: number | null } | null;
  storage: { used: number; quota: number; over?: boolean };
}
export async function hubMe(): Promise<HubMeSummary> {
  const r = await hubCall<{ account: { displayName: string; supporter?: { active: boolean; until: number | null } }; storage: HubMeSummary['storage'] }>('GET', '/v1/me');
  return { name: r.account.displayName, supporter: r.account.supporter ?? null, storage: r.storage };
}
/** This account's notifications, newest first, and how many are unread. */
export const hubNotes = () => hubCall<{ notifications: HubNote[]; unread: number }>('GET', '/v1/me/notifications?limit=50');
export const hubNotesRead = (a: { ids?: number[]; all?: boolean }) => hubCall<{ unread: number }>('POST', '/v1/me/notifications/read', a.all ? { all: true } : { ids: a.ids || [] });
