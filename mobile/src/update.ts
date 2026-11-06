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
  const version = state.version || (await Kea.appInfo().catch(() => ({ version: '' }))).version;
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

export function useUpdate() {
  const [s, setS] = useState(state);
  useEffect(() => {
    subs.add(setS);
    return () => void subs.delete(setS);
  }, []);
  return s;
}
