// The phone app's link to Kea's native parts (KeaPlugin.java) and its data: the copy Kea on the PC keeps in the cloud
// drive (classes, calendar, grades) and what the phone reads from the class site itself (announcements, grades,
// assignment folders).
import { registerPlugin } from '@capacitor/core';
import type { ScholarCourse, ScholarCourseDetail, ScholarGrades, ScholarInboxItem, ScholarItem } from '../../src/lib/api';

interface KeaNative {
  setup(o: { home: string; user?: string; pass?: string }): Promise<void>;
  state(): Promise<{ home: string; hasLogin: boolean; signedIn: boolean; dataFolder: string; dataFileOnly?: boolean; notifications: boolean }>;
  pickDataFile(): Promise<{ file: string }>;
  signIn(o?: { show?: boolean }): Promise<{ signedIn: boolean }>;
  get(o: { url: string }): Promise<{ status: number; body: string }>;
  open(o: { url: string }): Promise<void>;
  handIn(o: { url: string; file: string }): Promise<void>;
  watch(o: { le: string; lp: string; courses: { code: string; ou: string }[] }): Promise<void>;
  allowNotifications(): Promise<void>;
  checkNow(): Promise<{ count: number }>;
  phoneInbox(): Promise<{ items: ScholarInboxItem[] }>;
  pickFolder(): Promise<{ folder: string }>;
  writeFile(o: { path: string; text: string }): Promise<void>;
  readFile(o: { path?: string }): Promise<{ text: string; modified: number }>;
  openFile(o: { path: string }): Promise<void>;
  scan(o?: { name?: string }): Promise<{ file: string; pages: number; name: string }>;
  share(o: { file: string; name?: string }): Promise<void>;
  saveCopy(o: { file: string; name: string }): Promise<{ name: string }>;
}

export const Kea = registerPlugin<KeaNative>('Kea');

/** What Kea on the PC wrote to the cloud drive. */
export interface KeaData {
  synced: string;
  profile: string;
  home: string;
  courses: ScholarCourse[];
  items: ScholarItem[];
  details: ScholarCourseDetail[];
  grades: Record<string, ScholarGrades | null>;
  inbox: ScholarInboxItem[];
  /** Inbox messages deleted on the PC, by content, so the phone hides its own copies too. */
  inboxDeleted?: string[];
  /** The PC's checkmark changes, with their times (for merging with the phone's). */
  doneLog?: Record<string, { on: boolean; at: string }>;
}

const CACHE = 'kea.data';
export function cachedData(): KeaData | null {
  try {
    return JSON.parse(localStorage.getItem(CACHE) || 'null');
  } catch {
    return null;
  }
}

/**
 * Read the data file from the chosen folder (or the file chosen on its own), giving up after `ms` (a drive app that's
 * still downloading it). Falls back to the last copy; `error` says why the fresh one couldn't be read.
 */
export async function loadData(ms = 45000): Promise<{ data: KeaData | null; error: string | null }> {
  try {
    const r = await Promise.race([Kea.readFile({ path: 'kea-data.json' }), new Promise<never>((_, no) => setTimeout(() => no(new Error('timeout')), ms))]);
    const d = JSON.parse(r.text) as KeaData;
    try {
      localStorage.setItem(CACHE, r.text);
    } catch {}
    return { data: d, error: null };
  } catch (e: any) {
    const m = String(e?.message || e);
    const error = /timeout/.test(m)
      ? 'Your drive app is taking too long to hand Kea the file (it may still be downloading it).'
      : /not found/.test(m)
        ? 'The chosen folder has no kea-data.json in it.'
        : /No Kea folder/.test(m)
          ? 'No Kea folder or file is chosen yet.'
          : /JSON|Unexpected/.test(m)
            ? 'kea-data.json was only partly downloaded. Try again in a moment.'
            : m;
    return { data: cachedData(), error };
  }
}

/** A class's org unit id, from its class-site address ("…/d2l/home/661880"). */
export const ouOf = (url: string | null | undefined) => (String(url || '').match(/\/d2l\/home\/(\d+)/) || [])[1] || '';

let versions: { le: string; lp: string } | null = null;
export async function api(home: string, rel: string) {
  const r = await Kea.get({ url: new URL(rel, home).href });
  if (r.status !== 200) throw new Error(`The class site answered ${r.status}.`);
  return JSON.parse(r.body);
}
export async function d2lVersions(home: string) {
  if (versions) return versions;
  const v = { le: '1.74', lp: '1.47' };
  try {
    for (const p of await api(home, '/d2l/api/versions/')) if (p.ProductCode in v) (v as any)[p.ProductCode] = p.LatestVersion;
  } catch {}
  versions = v;
  return v;
}

/** Tell the background check which classes to watch. */
export async function watchClasses(d: KeaData) {
  const v = await d2lVersions(d.home);
  const courses = d.details.map((c) => ({ code: c.code, ou: ouOf(c.url) })).filter((c) => c.ou);
  await Kea.watch({ ...v, courses });
}

/** Every class's assignment folders, straight from the class site, soonest due first. */
export async function folders(d: KeaData) {
  const v = await d2lVersions(d.home);
  const out: { code: string; ou: string; folders: { id: number; name: string; due: string | null; closed: boolean }[] }[] = [];
  for (const c of d.details) {
    const ou = ouOf(c.url);
    if (!ou) continue;
    try {
      const list = await api(d.home, `/d2l/api/le/${v.le}/${ou}/dropbox/folders/`);
      const now = Date.now();
      out.push({
        code: c.code,
        ou,
        folders: (list || [])
          .filter((f: any) => !f.IsHidden)
          .map((f: any) => ({ id: f.Id, name: f.Name, due: f.DueDate || null, closed: !!(f.Availability?.EndDate && new Date(f.Availability.EndDate).getTime() < now) }))
          .sort((a: any, b: any) => Number(a.closed) - Number(b.closed) || Math.abs(new Date(a.due || 8e15).getTime() - now) - Math.abs(new Date(b.due || 8e15).getTime() - now))
      });
    } catch {}
  }
  return out;
}

export const handInUrl = (home: string, ou: string, folder: number) => new URL(`/d2l/lms/dropbox/user/folder_submit_files.d2l?db=${folder}&grpid=0&isprv=0&bp=0&ou=${ou}`, home).href;

// ---------- Checkmarks and read messages, synced with the PC through the drive folder ----------
// Every change is logged with its time; the PC does the same. Whichever side changed an item last wins.
export type DoneLog = Record<string, { on: boolean; at: string }>;
const DONE = 'kea.doneLog';
const READ = 'kea.read';
const load = <T,>(k: string, fallback: T): T => {
  try {
    return JSON.parse(localStorage.getItem(k) || 'null') ?? fallback;
  } catch {
    return fallback;
  }
};
const store = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {}
};
const DELETED = 'kea.deleted';
export const phoneDone = () => load<DoneLog>(DONE, {});
export const phoneRead = () => load<string[]>(READ, []);
/** Inbox messages deleted on the phone, by content (the phone's own checks name them differently from the PC). */
export const phoneDeleted = () => load<string[]>(DELETED, []);
export const inboxKey = (i: { course: string; title: string; body: string }) => `${i.course}|${i.title}|${String(i.body || '').slice(0, 60)}`;

let timer: any = null;
/** Write phone.json for Kea on the PC (a moment after the last change, so a burst of taps is one write). */
function syncOut() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    Kea.writeFile({ path: 'phone.json', text: JSON.stringify({ at: new Date().toISOString(), done: phoneDone(), read: phoneRead().slice(-1000), deleted: phoneDeleted().slice(-1000) }) }).catch(() => {});
  }, 1500);
}
export function setPhoneDeleted(keys: string[]) {
  store(DELETED, [...new Set([...phoneDeleted(), ...keys])].slice(-2000));
  syncOut();
}
export function setPhoneDone(id: string, on: boolean) {
  const d = phoneDone();
  d[id] = { on, at: new Date().toISOString() };
  store(DONE, d);
  syncOut();
}
export function setPhoneRead(ids: string[]) {
  store(READ, [...new Set([...phoneRead(), ...ids])].slice(-2000));
  syncOut();
}

/** An item's checkmark: the PC's, unless the phone changed it more recently. */
export function doneOf(it: { id: string; done: string | null }, pcLog: DoneLog | undefined, mine: DoneLog): string | null {
  const p = mine[it.id];
  const pc = pcLog?.[it.id];
  if (p && (!pc || p.at > pc.at)) return p.on ? p.at : null;
  return it.done;
}
