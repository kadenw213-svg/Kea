// The phone's stand-in for Kea on the PC's window.api, for the screens the phone shares with the PC (practice exams,
// flashcards, Learn, Match, spaced review, the study hub, the textbook reader): the same calls, answered here from the
// PC's copy and the phone's own progress (study.ts), with anything that needs Claude or the class site asked of the PC.
import { Capacitor } from '@capacitor/core';
import { Kea, KeaData } from './kea';
import { askPC, placeholder, study } from './study';

let data: KeaData | null = null;
let libraryRoot = '';
const listeners = new Set<() => void>();
const settingsListeners = new Set<(all: Record<string, any>) => void>();

/** The current copy from the PC, and where the library (textbooks, pictures) was unpacked on the phone. */
export function setDesktopData(d: KeaData | null, root?: string) {
  data = d;
  if (root !== undefined) libraryRoot = root;
}
/** Screens showing study sets reload. */
export function studyChanged() {
  listeners.forEach((f) => f());
}
/** A library file ("Textbooks/BIO1112/x.pdf", "study/images/…") as a URL the phone's web view can load, or null. */
export function libraryUrl(rel: string) {
  if (!libraryRoot || !rel) return null;
  return Capacitor.convertFileSrc(`${libraryRoot}/${rel.replace(/^\/+/, '')}`);
}

const SETTINGS = 'kea.settings';
const readSettings = (): Record<string, any> => {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS) || '{}');
  } catch {
    return {};
  }
};

const notHere = async () => {
  throw new Error('That’s only on Kea on your PC.');
};

const api: any = {
  settings: {
    get: async () => readSettings(),
    set: async (patch: Record<string, any>) => {
      const all = { ...readSettings(), ...patch };
      for (const [k, v] of Object.entries(all)) if (v === null) delete all[k];
      try {
        localStorage.setItem(SETTINGS, JSON.stringify(all));
      } catch {}
      settingsListeners.forEach((f) => f(all));
      return all;
    },
    onChange: (cb: (all: Record<string, any>) => void) => (settingsListeners.add(cb), () => settingsListeners.delete(cb))
  },
  setZoom: () => {},
  // The textbook PDFs, read from the library the phone unpacked.
  readFile: async (p: string) => {
    // (A file opened with Kea from another app is a full path on the phone.)
    const url = p.startsWith('/') ? Capacitor.convertFileSrc(p) : libraryUrl(p);
    if (!url) throw new Error('This chapter isn’t on the phone yet. It arrives with the next library from your PC.');
    const r = await fetch(url);
    if (!r.ok) throw new Error('This chapter isn’t on the phone yet. It arrives with the next library from your PC.');
    const name = p.split('/').pop() || p;
    return { path: p, name, ext: name.split('.').pop() || '', data: new Uint8Array(await r.arrayBuffer()) };
  },
  // No local model on the phone: written answers are marked by Kea's matching, or by the student.
  ai: {
    state: async () => ({ models: [], settings: { tier: '' } }),
    generate: notHere,
    stop: () => {},
    onEvent: () => () => {}
  },
  scholar: {
    courses: async () => data?.courses || [],
    courseImages: async () => 0,
    course: async (id: string) => data?.details.find((c) => c.id === id || c.code === id) || null,
    openLink: async (url: string) => (Kea.open({ url }), true),
    // Claude writes on the PC: from here, asking always works (the PC does it when it's on).
    check: async () => ({ claude: true, account: { loggedIn: true }, engineReady: true }),
    runStatus: async () => ({ running: null, queued: [] }),
    devices: async () => null,
    onRun: () => () => {},
    onChanged: (cb: () => void) => (listeners.add(cb), () => listeners.delete(cb)),
    studyList: async () => study.list(),
    studyGet: async (id: string) => study.get(id),
    studySaved: async (req: any) => study.saved(req),
    studyPool: async ({ courseId, chapters }: { courseId: string; chapters: string[] }) => study.pool(courseId, chapters),
    studyImage: async (rel: string) => libraryUrl(`study/${rel}`),
    studyDelete: async (id: string) => study.remove(id),
    studyAttempt: async (id: string, a: any) => study.saveAttempt(id, a),
    studyKnown: async (id: string, known: string[]) => study.setKnown(id, known),
    studySaveMine: async (set: any) => study.saveMine(set),
    studyStar: async (k: string, on: boolean) => study.star(k, on),
    studyLearn: async (id: string, levels: any) => study.learnSet(id, levels),
    studyMatch: async (id: string, ms: number) => study.matchBest(id, ms),
    studyReview: async (opts: any) => study.reviewQueue(opts || {}),
    studyReviewMark: async (k: string, grade: string, ctx: any) => study.reviewMark(k, grade, ctx || {}),
    // From saved questions: made here, at once. New questions: the PC writes them (it has the class files and Claude),
    // and the set shows as being made until the PC's copy brings it.
    studyMake: async (req: any) => {
      if (req.mode === 'saved') {
        const { id } = await study.request(req);
        studyChanged();
        return id;
      }
      const id = req.id || `${req.kind}-${Date.now().toString(36)}`;
      askPC('practice', { req: { ...req, id } });
      const c = data?.courses.find((x) => x.id === req.courseId);
      placeholder({ id, kind: req.kind, title: `${req.kind === 'exam' ? 'Practice exam' : 'Flashcards'}: ${(req.chapters || []).join(', ') || 'being written'}`, courseId: req.courseId, courseCode: c?.code || '', chapters: req.chapters || [], itemId: req.itemId || null, itemTitle: null, count: req.count || 25, reused: 0, createdAt: new Date().toISOString(), status: 'making', source: 'claude' });
      studyChanged();
      return id;
    },
    studyStepsFor: async (k: string) => {
      const w = study.whereIs(k);
      if (!w?.courseCode || !w.chapter) throw new Error('Kea couldn’t find which chapter this question is from.');
      askPC('steps', { arg: `${w.courseCode} ${w.chapter}` });
      return { queued: true, ...w };
    },
    studyBanks: async () => (askPC('banks'), true),
    textbookOf: async () => null
  }
};

/** Install it before any shared screen loads (they read window.api when they're imported). */
export function installDesktopApi() {
  (window as any).api = api;
}
