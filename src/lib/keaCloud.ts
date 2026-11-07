// Kea Cloud from the page's side: the sync state for Home's sidebar and header, and "Save to Kea Cloud" for the save
// flow. The files themselves are ordinary files in a folder on this PC (electron/keaCloud.cjs), so editors open and
// save them like any other.
import { create } from 'zustand';
import { api, KeaCloudStatus } from './api';
import { setting } from './settings';
import { ask, prompt, toast } from '../store';
import { formatBytes } from './util';

interface KeaCloudStore {
  status: KeaCloudStatus | null;
  refresh(): Promise<KeaCloudStatus | null>;
}

export const useKeaCloud = create<KeaCloudStore>((set) => ({
  status: null,
  async refresh() {
    const r = await api.keaCloud?.status().catch(() => null);
    const status = r && r.ok ? r.value : null;
    set({ status });
    return status;
  },
}));

/** Kea Cloud can be used: signed in to a Kea account, and not turned off in Settings. */
export const cloudUsable = (s: KeaCloudStatus | null | undefined): s is KeaCloudStatus => !!s && s.signedIn && s.enabled;

/** Keep the status current while something shows it (Home's Kea Cloud view polls faster). */
let watchers = 0;
let timer: ReturnType<typeof setInterval> | null = null;
export function watchKeaCloud(fast = false) {
  watchers++;
  useKeaCloud.getState().refresh();
  const every = fast ? 4000 : 20000;
  if (timer) clearInterval(timer);
  timer = setInterval(() => useKeaCloud.getState().refresh(), every);
  return () => {
    if (--watchers <= 0 && timer) {
      clearInterval(timer);
      timer = null;
      watchers = 0;
    }
  };
}

export const STATE_LABEL: Record<KeaCloudStatus['state'], string> = {
  signedOut: 'Signed out',
  off: 'Off',
  offline: 'Offline: changes sync when you’re back online',
  full: 'Storage full',
  error: 'Couldn’t sync',
  syncing: 'Syncing…',
  synced: 'Up to date',
};

export function storageLine(s: KeaCloudStatus) {
  if (!s.storage) return '';
  const { used, quota } = s.storage;
  return quota < 0 ? `${formatBytes(used)} used` : `${formatBytes(used)} of ${formatBytes(quota)} used`;
}

/** Is this path one of Kea Cloud's documents? */
export function inKeaCloud(p: string | null | undefined, s = useKeaCloud.getState().status) {
  if (!p || !s?.root) return false;
  const a = p.toLowerCase().replace(/\//g, '\\');
  const r = s.root.toLowerCase().replace(/\//g, '\\').replace(/\\+$/, '');
  return a === r || a.startsWith(r + '\\');
}

/**
 * How a path is shown to people: a Kea Cloud file as "Kea Cloud › Folder › name" (its real folder is hidden inside
 * Kea's profile), anything else as it is.
 */
export function friendlyPath(p: string, s = useKeaCloud.getState().status) {
  if (!inKeaCloud(p, s) || !s?.root) return p;
  const rest = p.slice(s.root.replace(/[\\/]+$/, '').length).split(/[\\/]/).filter(Boolean);
  return ['Kea Cloud', ...rest].join(' › ');
}
/** The folder a file is in, for "Opened just now · Documents": Kea Cloud files say Kea Cloud (and their sub-folder). */
export function folderLabel(p: string, s = useKeaCloud.getState().status) {
  if (inKeaCloud(p, s)) return friendlyPath(p, s).split(' › ').slice(0, -1).join(' › ') || 'Kea Cloud';
  return p.split(/[\\/]/).slice(-2, -1)[0] || p;
}

/**
 * Asked before the Save dialog for a file that has no place yet: Kea Cloud or this PC (Settings → Kea Cloud →
 * "New files save to"). Returns the Kea Cloud path chosen, 'pc' for the usual dialog, or null when cancelled.
 */
export async function chooseSaveTarget(suggested: string): Promise<string | 'pc' | null> {
  const pref = setting<string>('keaCloud.saveTo');
  if (pref === 'pc') return 'pc';
  const s = (await useKeaCloud.getState().refresh()) ?? null;
  if (!cloudUsable(s)) return 'pc';
  let where = pref === 'cloud' ? 'cloud' : '';
  if (!where) {
    where = await ask('Where do you want to save it?', `Kea Cloud keeps it in your Kea storage${s.email ? ` (${s.email})` : ''}, on your other computers and your phone too.`, [
      { id: 'cancel', label: 'Cancel' },
      { id: 'pc', label: 'This PC…' },
      { id: 'cloud', label: 'Kea Cloud', primary: true },
    ]);
  }
  if (where === 'pc') return 'pc';
  if (where !== 'cloud') return null;
  if (s.state === 'full') toast('Your Kea storage is full. It’s saved on this PC and goes up when there’s room.', 'error');
  const dot = suggested.lastIndexOf('.');
  const ext = dot > 0 ? suggested.slice(dot) : '';
  const name = await prompt('Save to Kea Cloud', 'File name', dot > 0 ? suggested.slice(0, dot) : suggested);
  if (name === null || !name.trim()) return null;
  const r = await api.keaCloud.newPath(name.trim().toLowerCase().endsWith(ext.toLowerCase()) ? name.trim() : name.trim() + ext);
  if (!r.ok) {
    toast(r.error, 'error');
    return null;
  }
  return r.value;
}
