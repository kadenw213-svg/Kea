// Folding sections, everywhere in Kea: on a screen with several, the first starts open and the rest start closed, and
// what the person opens or closes is remembered on this device, per screen and section. Nothing else changes a
// choice: a refresh, a sync or new data never reopens a section that was closed. (The pieces on screen are in
// src/components/Fold.tsx; this is the logic and the saved choices, kept free of React for the tests.)
import { create } from 'zustand';

export const FOLDS_KEY = 'kea.folds';
/** Guides kept their steps' choices here before every screen shared one place (read once, then moved). */
const OLD_GUIDE_KEY = 'kea.guideFolds';
/** Choices kept; the oldest go first once there are more. */
export const MAX_CHOICES = 3000;

/** true: opened, false: closed. A section never touched has no entry and follows its default. */
export type FoldChoices = Record<string, boolean>;

export interface FoldStorage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem?(k: string): void;
}

let storage: FoldStorage | null = null;
const store = (): FoldStorage | null => {
  if (storage) return storage;
  try {
    return (globalThis as any).localStorage ?? null;
  } catch {
    return null;
  }
};
/** For the tests: a stand-in for the browser's storage. */
export function setFoldStorage(s: FoldStorage | null) {
  storage = s;
  useFolds.setState({ choices: readFoldChoices() });
}

export const foldKey = (screen: string, section: string) => `${screen}|${section}`;

/** The saved choices, with a guide's older ones moved in under `guide:<item>`. */
export function readFoldChoices(): FoldChoices {
  const s = store();
  if (!s) return {};
  let out: FoldChoices = {};
  try {
    out = JSON.parse(s.getItem(FOLDS_KEY) || '{}') || {};
  } catch {}
  try {
    const old = s.getItem(OLD_GUIDE_KEY);
    if (old) {
      const prev = JSON.parse(old) || {};
      // (An old key was "<item>|<step>", so "guide:<item>|<step>" is foldKey(`guide:<item>`, step).)
      for (const [k, v] of Object.entries(prev)) if (typeof v === 'boolean' && !(`guide:${k}` in out)) out[`guide:${k}`] = v;
      s.setItem(FOLDS_KEY, JSON.stringify(out));
      s.removeItem?.(OLD_GUIDE_KEY);
    }
  } catch {}
  return out;
}

/** The choices with these changes, newest last, and only the newest MAX_CHOICES kept. */
export function withChoices(all: FoldChoices, screen: string, changes: [section: string, open: boolean][], max = MAX_CHOICES): FoldChoices {
  const next = { ...all };
  for (const [section, open] of changes) {
    const k = foldKey(screen, section);
    delete next[k];
    next[k] = open;
  }
  const keys = Object.keys(next);
  for (const k of keys.slice(0, Math.max(0, keys.length - max))) delete next[k];
  return next;
}

/** The person's choice for a section, if they made one. */
export const foldChoice = (all: FoldChoices, screen: string, section: string): boolean | undefined => all[foldKey(screen, section)];

/** Open by default: only the first section of the screen (the first one actually showing). */
export const openByDefault = (order: string[], section: string) => order.length > 0 && order[0] === section;

/** Whether a section shows open: the person's choice, or else its default. */
export function isFoldOpen(all: FoldChoices, screen: string, section: string, byDefault: boolean) {
  return foldChoice(all, screen, section) ?? byDefault;
}

/**
 * What a closed section's header still shows, so closing it never hides something urgent: the count of overdue or
 * failed things in it ("3"), or "!" for an error without a count. Nothing while it's open (the things are in view) or
 * when there's nothing urgent.
 */
export function foldAlert(open: boolean, urgent: number | boolean | string | null | undefined): string | null {
  if (open || urgent == null || urgent === false || urgent === 0 || urgent === '') return null;
  if (urgent === true) return '!';
  return String(urgent);
}

interface FoldStore {
  choices: FoldChoices;
  set(screen: string, changes: [section: string, open: boolean][]): void;
}
export const useFolds = create<FoldStore>((set, get) => ({
  choices: readFoldChoices(),
  set(screen, changes) {
    const next = withChoices(get().choices, screen, changes);
    try {
      store()?.setItem(FOLDS_KEY, JSON.stringify(next));
    } catch {}
    set({ choices: next });
  }
}));

/** Remember one section's choice (also for opening a section from elsewhere, e.g. a settings search result). */
export const setFold = (screen: string, section: string, open: boolean) => useFolds.getState().set(screen, [[section, open]]);
