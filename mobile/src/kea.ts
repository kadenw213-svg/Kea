// The phone app's link to Kea's native parts (KeaPlugin.java) and its data: the copy Kea on the PC keeps in the cloud
// drive (classes, calendar, grades) and what the phone reads from the class site itself (announcements, grades,
// assignment folders).
import { registerPlugin } from '@capacitor/core';
import { phoneRequests, studyOut } from './study';
import type { ScholarCourse, ScholarCourseDetail, ScholarGrades, ScholarInboxItem, ScholarItem } from '../../src/lib/api';

interface KeaNative {
  setup(o: { home: string; user?: string; pass?: string }): Promise<void>;
  /** `drive`: where the chosen files or folder live (see DriveFrom). */
  state(): Promise<{ home: string; hasLogin: boolean; signedIn: boolean; dataFolder: string; dataFileOnly?: boolean; files?: string[]; drive?: DriveFrom; notifications: boolean }>;
  pickDataFile(): Promise<{ files: string[] }>;
  /** Kea's three files, chosen together (kea-data.json, kea-library.zip, phone.json), from the drive named. */
  pickFiles(o?: { drive?: string }): Promise<{ files: string[]; from?: DriveFrom }>;
  /** Which drive apps are installed. */
  drives(): Promise<Partial<Record<'google' | 'onedrive' | 'dropbox', boolean>>>;
  /** Unpack the library when the PC wrote a new one. */
  syncLibrary(): Promise<{ root: string; changed: boolean; files?: number; missing?: boolean; error?: string }>;
  addListener(event: 'library', cb: (p: { files: number; bytes: number; name: string }) => void): Promise<{ remove(): void }>;
  addListener(event: 'opened', cb: (f: OpenedFile) => void): Promise<{ remove(): void }>;
  /** The file Kea was opened with (Open with, Share), once. */
  takeOpenedFile(): Promise<{ file?: OpenedFile }>;
  signIn(o?: { show?: boolean }): Promise<{ signedIn: boolean }>;
  get(o: { url: string }): Promise<{ status: number; body: string }>;
  open(o: { url: string }): Promise<void>;
  handIn(o: { url: string; file: string }): Promise<void>;
  watch(o: { le?: string; lp?: string; platform?: string; courses: { code: string; ou: string }[] }): Promise<void>;
  allowNotifications(): Promise<void>;
  checkNow(): Promise<{ count: number }>;
  phoneInbox(): Promise<{ items: ScholarInboxItem[] }>;
  /** A folder holding Kea's files (or one above them: Kea, Kea → School). Not every drive app allows folders. */
  pickFolder(): Promise<{ folder: string; base: string; from?: DriveFrom }>;
  /** Forget the pairing with the PC (the phone's own files stay). */
  unpair(): Promise<void>;
  writeFile(o: { path: string; text: string }): Promise<void>;
  readFile(o: { path?: string }): Promise<{ text: string; modified: number }>;
  openFile(o: { path: string }): Promise<void>;
  scan(o?: { name?: string }): Promise<{ file: string; path: string; pages: number; name: string }>;
  /** `file`: a content address, or a path to one of Kea's own files. */
  share(o: { file: string; name?: string }): Promise<void>;
  saveCopy(o: { file: string; name: string }): Promise<{ name: string }>;
  /** The phone's own scans and PDFs, newest first. */
  listFiles(): Promise<{ files: PhoneFile[] }>;
  /** Choose a PDF anywhere; it's copied into Kea's files. */
  pickPdf(): Promise<{ path: string; name: string }>;
  /** Choose any file; it's copied into Kea's files. */
  pickFile(): Promise<{ path: string; name: string; type: string }>;
  /** One of Kea's files in another app (Android asks which). */
  openWith(o: { path: string }): Promise<void>;
  renameFile(o: { path: string; name: string }): Promise<{ path: string; name: string }>;
  deleteFile(o: { path: string }): Promise<void>;
  appInfo(): Promise<{ version: string; build: number }>;
  /** The phone's text-to-speech voices for its language (offline ones first). */
  voices(): Promise<{ voices: PhoneVoice[] }>;
  say(o: { text: string; voice?: string; rate?: number }): Promise<void>;
  /** Read sentences aloud like an audiobook (keeps going with the screen off); `id` says where each is. */
  readAloud(o: { items: { id: string; text: string; pause?: number }[]; title: string; voice?: string; rate?: number; loop?: boolean }): Promise<void>;
  readMore(o: { items: { id: string; text: string }[] }): Promise<void>;
  readControl(o: { action: 'pause' | 'resume' | 'stop' | 'skip' | 'settings' | 'sleep' | 'state'; by?: number; voice?: string; rate?: number; minutes?: number }): Promise<{ playing: boolean; id: string; sleepLeft: number }>;
  addListener(event: 'speech', cb: (p: { id: string; index: number; total: number; state: 'playing' | 'paused' | 'stopped' | 'done' | 'error' }) => void): Promise<{ remove(): void }>;
  downloadUpdate(o: { url: string }): Promise<{ path: string; version: string }>;
  installUpdate(): Promise<{ started: boolean; needsPermission?: boolean }>;
  addListener(event: 'update', cb: (p: { received: number; total: number }) => void): Promise<{ remove(): void }>;
}

// (A test can stand in for the native side: window.__keaMock, set before the app loads. The app never sets it.)
/** A file another app opened with Kea, copied where the reader can load it. */
export type OpenedFile = { path: string; name: string; type: string };
/** A text-to-speech voice on the phone. `online`: needs a connection (offline ones keep reading with no signal). */
export type PhoneVoice = { name: string; locale: string; country: string; quality: number; online: boolean; isDefault: boolean };
/** Where a chosen file came from: a drive's app, the phone's storage, Downloads (a one-time copy) or another app. */
export type DriveFrom = 'google' | 'onedrive' | 'dropbox' | 'phone' | 'downloads' | 'other' | '';
/** One of the phone's own files: a scan, or a PDF opened or chosen in Kea. */
export type PhoneFile = { path: string; name: string; size: number; modified: number; kind: 'scan' | 'file' };

/** How many pages each scan has (the scanner says; kept by path). */
const PAGES = 'kea.pages';
export const pagesOf = (path: string): number | null => {
  try {
    return JSON.parse(localStorage.getItem(PAGES) || '{}')[path] ?? null;
  } catch {
    return null;
  }
};
export const setPages = (path: string, n: number) => {
  try {
    const all = JSON.parse(localStorage.getItem(PAGES) || '{}');
    all[path] = n;
    localStorage.setItem(PAGES, JSON.stringify(all));
  } catch {}
};

export const Kea: KeaNative = (globalThis as any).__keaMock || registerPlugin<KeaNative>('Kea');

/** What Kea on the PC wrote to the cloud drive. */
export interface KeaData {
  synced: string;
  profile: string;
  home: string;
  /** The class site's platform (from the PC; older data files don't say, so it's read from the address). */
  platform?: 'd2l' | 'canvas';
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

/** A class's id on the class site, from its address ("…/d2l/home/661880", or Canvas's "…/courses/1234"). */
export const ouOf = (url: string | null | undefined) => (String(url || '').match(/\/d2l\/home\/(\d+)|\/courses\/(\d+)/) || []).slice(1).find(Boolean) || '';

/** Which platform the class site is: what the PC says, or (older data) what its address shows. */
export const platformOf = (d: Pick<KeaData, 'home' | 'platform'>): 'd2l' | 'canvas' =>
  d.platform || (/\/d2l\//i.test(d.home || '') ? 'd2l' : /instructure\.com/i.test(d.home || '') ? 'canvas' : 'd2l');

let versions: { le: string; lp: string } | null = null;
export async function api(home: string, rel: string) {
  const r = await Kea.get({ url: new URL(rel, home).href });
  if (r.status !== 200) throw new Error(`The class site answered ${r.status}.`);
  // (Canvas starts its JSON with "while(1);" for a signed-in session.)
  return JSON.parse(String(r.body).replace(/^while\(1\);/, ''));
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
  const platform = platformOf(d);
  const v = platform === 'canvas' ? {} : await d2lVersions(d.home);
  const courses = d.details.map((c) => ({ code: c.code, ou: ouOf(c.url) })).filter((c) => c.ou);
  await Kea.watch({ ...v, platform, courses });
}

/** Every class's assignment folders, straight from the class site, soonest due first. */
export async function folders(d: KeaData) {
  const canvas = platformOf(d) === 'canvas';
  const v = canvas ? null : await d2lVersions(d.home);
  const out: { code: string; ou: string; folders: { id: number; name: string; due: string | null; closed: boolean }[] }[] = [];
  for (const c of d.details) {
    const ou = ouOf(c.url);
    if (!ou) continue;
    try {
      const now = Date.now();
      // Canvas: assignments that take a file (its own list pages up to 100 at a time; the first page is the soonest).
      const list = canvas
        ? ((await api(d.home, `/api/v1/courses/${ou}/assignments?per_page=100&order_by=due_at`)) || [])
            .filter((a: any) => (a.submission_types || []).includes('online_upload') && a.published !== false)
            .map((a: any) => ({ Id: a.id, Name: a.name, DueDate: a.due_at, Availability: { EndDate: a.lock_at } }))
        : await api(d.home, `/d2l/api/le/${v!.le}/${ou}/dropbox/folders/`);
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

export const handInUrl = (d: Pick<KeaData, 'home' | 'platform'>, ou: string, folder: number) =>
  new URL(platformOf(d) === 'canvas' ? `/courses/${ou}/assignments/${folder}` : `/d2l/lms/dropbox/user/folder_submit_files.d2l?db=${folder}&grpid=0&isprv=0&bp=0&ou=${ou}`, d.home).href;

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
export function syncOut() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    let study: unknown = null;
    try {
      study = studyOut();
    } catch {}
    Kea.writeFile({ path: 'phone.json', text: JSON.stringify({ at: new Date().toISOString(), done: phoneDone(), read: phoneRead().slice(-1000), deleted: phoneDeleted().slice(-1000), study, requests: phoneRequests() }) }).catch(() => {});
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
