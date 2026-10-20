// Studying on the phone: Kea on the PC's own study code (electron/scholar/study.cjs) runs here over an in-memory copy of
// the PC's study folder (from kea-data.json). What's done here (answers, flashcards, stars, Learn and Match, spaced
// review, sets made from saved questions) is kept on the phone, merged under each new copy from the PC with the same
// rules the PC uses (studyMerge.cjs), and sent to the PC in phone.json. Writing new questions is asked of the PC.
import * as vfs from './node/fs';
import { setData } from './node/db';
import type { KeaData } from './kea';
// (Kea on the PC's modules, bundled as they are: see vite.config.mjs.)
import studyCjs from '../../electron/scholar/study.cjs';
import mergeCjs from '../../electron/scholar/studyMerge.cjs';

export const study = studyCjs as any;
const { PROGRESS, mergeProgress } = mergeCjs as { PROGRESS: string[]; mergeProgress(a: any, b: any): { files: Record<string, any>; changed: boolean } };

const ROOT = '/kea/study/';
const OVERLAY = 'kea.studyOverlay';
const REQUESTS = 'kea.requests';

const readLS = <T,>(k: string, fallback: T): T => {
  try {
    return JSON.parse(localStorage.getItem(k) || 'null') ?? fallback;
  } catch {
    return fallback;
  }
};
const parse = (s: string | undefined, fallback: any) => {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
};

/** What was written here, by path in the study folder ("attempts.json", "sets/exam-x.json"). */
let overlay: Record<string, string> = readLS(OVERLAY, {});
/** The PC's copy, as it came. */
let baseIndex: { id: string }[] = [];
let loading = false;
let saveTimer: any = null;
let changedHook: (() => void) | null = null;

/** Told after anything here changes (so phone.json goes out, and screens refresh). */
export function onStudyChange(f: () => void) {
  changedHook = f;
}

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(OVERLAY, JSON.stringify(overlay));
    } catch {
      // Full: the phone's own sets go first (the PC keeps a copy of each once it has them).
      for (const k of Object.keys(overlay)) if (k.startsWith('sets/') || k.startsWith('local/')) delete overlay[k];
      try {
        localStorage.setItem(OVERLAY, JSON.stringify(overlay));
      } catch {}
    }
  }, 400);
}

vfs.onWrite((p, data) => {
  if (loading || !p.startsWith(ROOT)) return;
  const rel = p.slice(ROOT.length);
  if (data === null) delete overlay[rel];
  else overlay[rel] = data;
  persist();
  changedHook?.();
});

/** Load the PC's study folder from its data file, with what was done on the phone merged in. */
export function loadStudy(d: KeaData) {
  setData(d);
  loading = true;
  try {
    vfs.clear('/kea/study');
    const base: Record<string, string> = {};
    for (const [rel, v] of Object.entries((d as any).study || {})) base[rel] = JSON.stringify(v);
    const files: Record<string, string> = { ...base };
    // Progress: the PC's and the phone's, merged; kept as the phone's from now on (merging again changes nothing).
    const merged = mergeProgress(
      Object.fromEntries(PROGRESS.map((f) => [f, parse(base[f], {})])),
      Object.fromEntries(PROGRESS.map((f) => [f, parse(overlay[f], {})]))
    ).files;
    for (const f of PROGRESS) {
      files[f] = JSON.stringify(merged[f]);
      overlay[f] = files[f];
    }
    // Sets made here: kept until the PC's copy has them.
    baseIndex = parse(base['index.json'], []);
    const have = new Set(baseIndex.map((e) => e.id));
    const mine = (parse(overlay['index.json'], []) as any[]).filter((e) => e && !have.has(e.id));
    files['index.json'] = JSON.stringify([...baseIndex, ...mine]);
    if (mine.length) overlay['index.json'] = JSON.stringify(mine);
    else delete overlay['index.json'];
    for (const rel of Object.keys(overlay))
      if (/^(sets|local|mine)\//.test(rel)) {
        const id = rel.replace(/^.*\//, '').replace(/\.json$/, '');
        if (have.has(id)) delete overlay[rel];
        else files[rel] = overlay[rel];
      }
    vfs.load(Object.fromEntries(Object.entries(files).map(([rel, s]) => [ROOT + rel, s])));
  } finally {
    loading = false;
  }
  persist();
}

/** What phone.json carries for the PC: the progress files, and the sets made here (with their questions). */
export function studyOut() {
  const read = (rel: string, fallback: any) => {
    try {
      return JSON.parse(vfs.readFileSync(ROOT + rel));
    } catch {
      return fallback;
    }
  };
  const out: Record<string, any> = Object.fromEntries(PROGRESS.map((f) => [f, read(f, {})]));
  const have = new Set(baseIndex.map((e) => e.id));
  out.made = (read('index.json', []) as any[])
    .filter((e) => e && !have.has(e.id) && e.status === 'ready')
    .map((entry) => ({ entry, set: read(`sets/${entry.id}.json`, null) || read(`local/${entry.id}.json`, null) || read(`mine/${entry.id}.json`, null) }))
    .filter((m) => m.set);
  return out;
}

// ---------- Asking the PC ----------
export type PhoneRequest = { id: string; task: string; arg?: string; req?: unknown; at: string };
export const phoneRequests = () => readLS<PhoneRequest[]>(REQUESTS, []).filter((r) => Date.now() - Date.parse(r.at) < 7 * 864e5);
/** Ask Kea on the PC to do something (write questions, worked steps, check the class site); sent in phone.json. */
export function askPC(task: string, more: { arg?: string; req?: unknown } = {}) {
  const list = phoneRequests();
  list.push({ id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, task, ...more, at: new Date().toISOString() });
  try {
    localStorage.setItem(REQUESTS, JSON.stringify(list.slice(-50)));
  } catch {}
  changedHook?.();
}

/** A set the PC is writing, shown here as being made until its copy arrives. */
export function placeholder(entry: Record<string, unknown>) {
  const idx = (() => {
    try {
      return JSON.parse(vfs.readFileSync(`${ROOT}index.json`));
    } catch {
      return [];
    }
  })();
  vfs.writeFileSync(`${ROOT}index.json`, JSON.stringify([...idx.filter((e: any) => e.id !== entry.id), entry]));
}
