// The phone app's link to Kea's native parts (KeaPlugin.java) and its data: the copy Kea on the PC keeps in the cloud
// drive (classes, calendar, grades) and what the phone reads from the class site itself (announcements, grades,
// assignment folders).
import { registerPlugin } from '@capacitor/core';
import type { ScholarCourse, ScholarCourseDetail, ScholarGrades, ScholarInboxItem, ScholarItem } from '../../src/lib/api';

interface KeaNative {
  setup(o: { home: string; user?: string; pass?: string }): Promise<void>;
  state(): Promise<{ home: string; hasLogin: boolean; signedIn: boolean; dataFolder: string; notifications: boolean }>;
  signIn(o?: { show?: boolean }): Promise<{ signedIn: boolean }>;
  get(o: { url: string }): Promise<{ status: number; body: string }>;
  open(o: { url: string }): Promise<void>;
  handIn(o: { url: string; file: string }): Promise<void>;
  watch(o: { le: string; lp: string; courses: { code: string; ou: string }[] }): Promise<void>;
  allowNotifications(): Promise<void>;
  checkNow(): Promise<{ count: number }>;
  phoneInbox(): Promise<{ items: ScholarInboxItem[] }>;
  pickFolder(): Promise<{ folder: string }>;
  readFile(o: { path?: string }): Promise<{ text: string; modified: number }>;
  openFile(o: { path: string }): Promise<void>;
  scan(o?: { name?: string }): Promise<{ file: string; pages: number; name: string }>;
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
}

const CACHE = 'kea.data';
export function cachedData(): KeaData | null {
  try {
    return JSON.parse(localStorage.getItem(CACHE) || 'null');
  } catch {
    return null;
  }
}

/** Read the data file from the chosen folder (falls back to the last copy when offline). */
export async function loadData(): Promise<KeaData | null> {
  try {
    const r = await Kea.readFile({ path: 'kea-data.json' });
    const d = JSON.parse(r.text) as KeaData;
    try {
      localStorage.setItem(CACHE, r.text);
    } catch {}
    return d;
  } catch {
    return cachedData();
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

// ---------- What's checked off on the phone ----------
const DONE = 'kea.done';
export function phoneDone(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(DONE) || '{}');
  } catch {
    return {};
  }
}
export function setPhoneDone(id: string, on: boolean) {
  const d = phoneDone();
  if (on) d[id] = new Date().toISOString();
  else delete d[id];
  try {
    localStorage.setItem(DONE, JSON.stringify(d));
  } catch {}
}
