import { create } from 'zustand';
import type { DictEntry } from '../../lib/api';
import type { ExplainResult } from '../../lib/lookup';
import type { AnswerResult } from '../../lib/question';
import { storageGet } from '../../lib/legacy';

/** One lookup in the panel: a Wikipedia explanation or a dictionary entry. */
export interface LookupCard {
  id: string;
  kind: 'explain' | 'define' | 'answer';
  query: string;
  loading?: boolean;
  status?: string;
  error?: string;
  explain?: ExplainResult;
  /** A highlighted question: the passages that answer each part. */
  answer?: AnswerResult;
  /** null = not in the dictionary. */
  define?: DictEntry | null;
}

interface LookupStore {
  open: boolean;
  /** The latest highlight in each tab. */
  selections: Record<string, string>;
  cards: LookupCard[];
  set(p: Partial<LookupStore>): void;
}

const OPEN_KEY = 'kea.ai.open';
const initialOpen = (() => {
  try {
    return storageGet('ai.open') === '1';
  } catch {
    return false;
  }
})();

export const useLookup = create<LookupStore>((set) => ({
  open: initialOpen,
  selections: {},
  cards: [],
  set: (p) => set(p)
}));

export function setLookupOpen(open: boolean) {
  useLookup.getState().set({ open });
  try {
    localStorage.setItem(OPEN_KEY, open ? '1' : '0');
  } catch {}
}

export const toggleLookup = () => setLookupOpen(!useLookup.getState().open);

/** Editors call this whenever their selection changes. Empty selections are ignored so the last highlight stays. */
export function publishSelection(tabId: string, text: string) {
  const t = text.replace(/ /g, ' ').trim();
  if (!t) return;
  const s = useLookup.getState();
  if (s.selections[tabId] === t) return;
  s.set({ selections: { ...s.selections, [tabId]: t.length > 20000 ? t.slice(0, 20000) : t } });
}

export function clearSelection(tabId: string) {
  const s = useLookup.getState();
  const next = { ...s.selections };
  delete next[tabId];
  s.set({ selections: next });
}
