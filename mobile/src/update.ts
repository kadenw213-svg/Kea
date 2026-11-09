// Kea for Android keeps itself up to date from Kea's GitHub releases (the same releases Kea on the PC updates from):
// a check when the app opens (and every six hours while it stays open), the newer app downloaded in the background, then one tap to
// install it. Android always asks the student to confirm an install; it can't happen silently.
import { useEffect, useState } from 'react';
import { Kea } from './kea';

const LATEST = 'https://api.github.com/repos/kadenw213-svg/Kea/releases/latest';
const LAST = 'kea.updateChecked';
export const AUTO = 'kea.autoUpdate';

export type UpdateState =
  | { status: 'idle' | 'checking' | 'current'; version: string; error?: string; latest?: string; checked?: number }
  | { status: 'downloading'; version: string; next: string; percent: number }
  | { status: 'ready'; version: string; next: string; needsPermission?: boolean };

/** "0.52.0" newer than "0.51.3"? */
export const newer = (a: string, b: string) => {
  const x = a.replace(/^v/, '').split('.').map(Number);
  const y = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};

let state: UpdateState = { status: 'idle', version: '' };
const subs = new Set<(s: UpdateState) => void>();
const set = (s: UpdateState) => {
  state = s;
  subs.forEach((f) => f(s));
};

/** Look for a newer Kea and download it. `force`: now, even if it looked recently or updates are set to manual. */
export async function checkForUpdate(force = false) {
  if (state.status === 'checking' || state.status === 'downloading') return;
  // (Downloaded and waiting for its install: nothing more to fetch.)
  if (!force && state.status === 'ready') return;
  const version = state.version || (await Kea.appInfo().catch(() => ({ version: '' }))).version;
  noteOwnVersion(version);
  if (!force) {
    if (localStorage.getItem(AUTO) === 'off') return set({ status: 'idle', version });
    if (Date.now() - Number(localStorage.getItem(LAST) || 0) < 6 * 3600e3 && state.status !== 'idle') return;
  }
  set({ status: 'checking', version });
  try {
    const r = await fetch(LATEST, { cache: 'no-store', headers: { Accept: 'application/vnd.github+json' } });
    if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
    const rel = await r.json();
    localStorage.setItem(LAST, String(Date.now()));
    const next = String(rel.tag_name || '').replace(/^v/, '');
    const apk = (rel.assets || []).find((a: any) => /\.apk$/i.test(a.name));
    if (!next || !version) throw new Error('GitHub didn’t say which version is newest');
    if (!newer(next, version)) return set({ status: 'current', version, latest: next, checked: Date.now() });
    // A newer Kea without the phone app attached: say so rather than "up to date".
    if (!apk) throw new Error(`Kea ${next} is out, but its phone app isn’t attached yet`);
    set({ status: 'downloading', version, next, percent: 0 });
    const sub = await Kea.addListener('update', (p) => p.total > 0 && set({ status: 'downloading', version, next, percent: Math.round((p.received / p.total) * 100) }));
    try {
      await Kea.downloadUpdate({ url: apk.browser_download_url });
    } finally {
      sub.remove();
    }
    set({ status: 'ready', version, next });
  } catch (e: any) {
    set({ status: 'idle', version, error: String(e?.message || e) });
  }
}

/** Open Android's installer for the downloaded update (the first time, Android asks to allow Kea to install updates). */
export async function installUpdate() {
  if (state.status !== 'ready') return;
  const r = await Kea.installUpdate().catch(() => null);
  if (r?.needsPermission) set({ ...state, needsPermission: true });
}

// ---------- what the PC and the servers say (docs/protocol.md section 0) ----------
// So the phone never falls behind without saying so: the newest Kea the Kea account server or an organization's
// server knows of (their /v1/health `latest.kea`), the version Kea on the PC is (kea-data.json `keaVersion`), and a
// server that turned this phone away as too old (426). Kept in localStorage, so it's there after a restart.
const NOTES = 'kea.versionNotes';
export type VersionFrom = 'pc' | 'account' | `org:${string}`;
export interface VersionNotes {
  /** This phone's Kea version, once known. */
  version: string;
  /** Newer versions others say exist: { from: { version, at } }. */
  latest: Record<string, { version: string; at: number }>;
  /** Servers that turned this phone away: { from: { error, minVersion, updateUrl, at } }. */
  tooOld: Record<string, { error: string; minVersion: string | null; updateUrl: string | null; at: number }>;
}
const readNotes = (): VersionNotes => {
  try {
    const j = JSON.parse(localStorage.getItem(NOTES) || '{}');
    return { version: String(j.version || ''), latest: j.latest && typeof j.latest === 'object' ? j.latest : {}, tooOld: j.tooOld && typeof j.tooOld === 'object' ? j.tooOld : {} };
  } catch {
    return { version: '', latest: {}, tooOld: {} };
  }
};
let notes = readNotes();
const noteSubs = new Set<(n: VersionNotes) => void>();
const saveNotes = (n: VersionNotes) => {
  notes = n;
  try {
    localStorage.setItem(NOTES, JSON.stringify(n));
  } catch {}
  noteSubs.forEach((f) => f(n));
};
const VERSION_RE = /^v?\d+\.\d+\.\d+/;
/** This phone's version (Kea.appInfo), for comparing with what others say. */
export function noteOwnVersion(version: string) {
  if (VERSION_RE.test(version) && version !== notes.version) saveNotes({ ...notes, version });
}
/** The PC's Kea version, or a server's health (`latest.kea`). Anything unreadable is ignored. */
export function noteAdvertised(from: VersionFrom, version: unknown) {
  if (typeof version !== 'string' || !VERSION_RE.test(version)) return;
  const v = version.replace(/^v/, '');
  if (notes.latest[from]?.version === v) return;
  saveNotes({ ...notes, latest: { ...notes.latest, [from]: { version: v, at: Date.now() } } });
}
/** A server answered 426 (`body`: { error, minVersion, updateUrl }). */
export function noteTooOld(from: VersionFrom, body: any) {
  const x = { error: String(body?.error || 'Update Kea to keep using your Kea account.'), minVersion: typeof body?.minVersion === 'string' ? body.minVersion : null, updateUrl: typeof body?.updateUrl === 'string' ? body.updateUrl : null, at: Date.now() };
  if (notes.tooOld[from]?.error === x.error && notes.tooOld[from]?.minVersion === x.minVersion) return;
  saveNotes({ ...notes, tooOld: { ...notes.tooOld, [from]: x } });
}
/** That server answered normally: its refusal is over. */
export function noteServed(from: VersionFrom) {
  if (!notes.tooOld[from]) return;
  const { [from]: _gone, ...rest } = notes.tooOld;
  saveNotes({ ...notes, tooOld: rest });
}

/**
 * What the phone says about falling behind: a server that needs a newer Kea (the account server's first), or the
 * newest version the PC or a server has that's newer than this phone. null when it's up to date as far as anyone says.
 */
export function behind(n: VersionNotes = notes): { kind: 'required'; text: string; minVersion: string | null; updateUrl: string | null } | { kind: 'behind'; text: string; version: string; from: string } | null {
  const own = n.version;
  const refusals = Object.entries(n.tooOld).filter(([, x]) => !own || !x.minVersion || newer(x.minVersion, own));
  const r = refusals.find(([f]) => f === 'account') || refusals[0];
  if (r) return { kind: 'required', text: r[1].error, minVersion: r[1].minVersion, updateUrl: r[1].updateUrl };
  if (!own) return null;
  let best: { version: string; from: string } | null = null;
  for (const [from, x] of Object.entries(n.latest)) if (newer(x.version, own) && (!best || newer(x.version, best.version))) best = { version: x.version, from };
  if (!best) return null;
  const who = best.from === 'pc' ? 'Your PC has' : best.from === 'account' ? 'Your Kea account server says' : 'Your organization’s server says';
  return { kind: 'behind', version: best.version, from: best.from, text: best.from === 'pc' ? `${who} Kea ${best.version}; this phone has ${own}.` : `${who} Kea ${best.version} is out; this phone has ${own}.` };
}

export function useVersionNotes() {
  const [n, setN] = useState(notes);
  useEffect(() => {
    noteSubs.add(setN);
    return () => void noteSubs.delete(setN);
  }, []);
  return n;
}

export function useUpdate() {
  const [s, setS] = useState(state);
  useEffect(() => {
    subs.add(setS);
    return () => void subs.delete(setS);
  }, []);
  return s;
}
