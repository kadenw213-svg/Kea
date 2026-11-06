// The phone's Kea account: signing in to the Kea Hub (the same account as Kea on the PC), the terms gate, and syncing
// the PC's Kea folder through the person's Kea storage instead of a cloud drive's file picker. When this phone is
// signed in and a profile is chosen, kea.ts reads and writes through here; otherwise it keeps using the drive files.
//
// Requests go through native code (KeaPlugin.hubRequest, Hub.java), which holds the session token in Android's
// encrypted storage and adds it to each request: the web code never sees the token.
import { Kea } from './kea';
import { createPhoneSync, profilesIn, toRemote, type HubFile, type SyncClient, type SyncState } from './hubsync';

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

/** What someone types → the Hub's https origin. Bare names get https://; anything else is refused. */
export function normalizeHubUrl(input: string): string {
  let s = String(input || '').trim();
  if (!s) throw new HubError('Enter your Kea Hub’s address (the same one Kea on your computer uses).', 400);
  if (!/^[a-z]+:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new HubError('That isn’t a web address.', 400);
  }
  if (u.protocol !== 'https:') throw new HubError('Use the Hub’s https:// address. Android only connects to a Kea Hub over a secure link.', 400);
  return u.origin;
}

const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/');
const parse = (text: string) => {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
};

/** One API call; throws HubError (with the Hub's own message) for anything but 2xx. */
export async function hubCall<T = any>(method: string, path: string, body?: unknown, opts: { auth?: boolean; keepToken?: boolean } = {}): Promise<T> {
  let r: { status: number; body: string };
  try {
    r = await Kea.hubRequest({ method, path, body: body === undefined ? undefined : JSON.stringify(body), auth: opts.auth !== false, keepToken: opts.keepToken });
  } catch (e: any) {
    throw new HubError(`Couldn’t reach the Kea Hub: ${String(e?.message || e)}`, 0);
  }
  const data = parse(r.body);
  if (r.status >= 200 && r.status < 300) return data as T;
  throw new HubError(data.error || `The Kea Hub answered ${r.status}.`, r.status, data);
}

/** Plain words for why syncing through the Hub stopped. */
export function hubProblem(e: any): string {
  const s = e?.status;
  if (s === 401) return 'Your Kea account sign-in ended. Sign in again under Settings → Kea account.';
  if (s === 428) return 'The Kea terms have changed. Open Settings → Kea account to read what changed and agree.';
  if (s === 0 && /reach/.test(String(e?.message))) return 'Couldn’t reach your Kea Hub. Check your connection; your classes from last time are shown.';
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

/** Sign in (the 6-digit code when two-step sign-in is on). Returns whether the terms must be agreed to first. */
export async function hubSignIn(o: { url: string; email: string; password: string; code?: string }): Promise<{ email: string; needsTerms: boolean }> {
  const url = normalizeHubUrl(o.url);
  await Kea.hubSetUrl({ url });
  const r = await hubCall<{ account: { email: string }; terms?: { needsAgreement: boolean } }>(
    'POST',
    '/v1/auth/login',
    { email: o.email.trim(), password: o.password, ...(o.code ? { code: o.code.replace(/\s+/g, '') } : {}) },
    { auth: false, keepToken: true }
  );
  try {
    localStorage.setItem(ON, '1');
  } catch {}
  return { email: r.account.email, needsTerms: !!r.terms?.needsAgreement };
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

/** The Kea profiles (Kea → School, …) the PC has synced into this account's storage. */
export async function hubProfiles(): Promise<string[]> {
  const r = await hubCall<{ files: HubFile[] }>('GET', `/v1/files?prefix=${encodeURIComponent('kea/Kea/')}`);
  return profilesIn(r.files);
}
export function setHubProfile(name: string) {
  localStorage.setItem(PROFILE, name);
  sync().use(name);
}

/** Sign out: the Hub ends the session, the phone forgets the token, and the drive files (if chosen) take over again. */
export async function hubSignOut() {
  await hubCall('POST', '/v1/auth/logout').catch(() => {});
  await Kea.hubForget();
  for (const k of [ON, PROFILE, STATE]) localStorage.removeItem(k);
  engine = null;
}

// ---------- the sync engine over the native client ----------
const client: SyncClient = {
  async list(prefix, since) {
    return hubCall('GET', `/v1/files?prefix=${encodeURIComponent(prefix)}&since=${since || 0}`);
  },
  async getText(path) {
    const r = await Kea.hubRequest({ method: 'GET', path: `/v1/files/${enc(path)}` });
    if (r.status !== 200) throw new HubError(parse(r.body).error || `The Kea Hub answered ${r.status}.`, r.status, parse(r.body));
    return { text: r.body, version: Number(r.version) || 0 };
  },
  async download(path, to, f) {
    const r = await Kea.hubDownload({ path: `/v1/files/${enc(path)}`, to, size: f.size, sha256: f.sha256 });
    if (r.status !== 200) throw new HubError(parse(r.body || '').error || `The Kea Hub answered ${r.status}.`, r.status);
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
    if (r.status >= 300) throw new HubError(data.error || `The Kea Hub answered ${r.status}.`, r.status, data);
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
  return serial(async () => (await sync().pull(force)).data);
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
