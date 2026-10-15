import { create } from 'zustand';
import type { AiState } from '../../lib/api';

export interface AiMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  kind?: 'text' | 'suggestions' | 'flashcards';
  data?: any;
  context?: string; // short label of what the request was about
  streaming?: boolean;
  error?: boolean;
  requestId?: string;
  retry?: () => void;
  speed?: number;
  /** Suggestions already put into the document (indexes), and how. */
  applied?: number[];
  appliedHow?: 'direct' | 'track' | 'comment';
  /** Wikipedia articles this answer was checked against, or why the check didn't happen. */
  wiki?: { title: string; url: string; edited: string | null }[];
  wikiNote?: string;
  /** The answer replaced the highlighted text automatically. */
  replaced?: 'direct' | 'track';
}

interface AiStore {
  open: boolean;
  pinned: boolean;
  pinnedText: string | null;
  pinnedTab: string | null;
  scope: 'selection' | 'document';
  scopeChosen: boolean;
  selections: Record<string, string>;
  messages: AiMessage[];
  busy: string | null; // request id
  state: AiState | null;
  settingsOpen: boolean;
  set(p: Partial<AiStore>): void;
}

const OPEN_KEY = 'slate.ai.open';
const initialOpen = (() => {
  try {
    return localStorage.getItem(OPEN_KEY) === '1';
  } catch {
    return false;
  }
})();

export const useAi = create<AiStore>((set) => ({
  open: initialOpen,
  pinned: false,
  pinnedText: null,
  pinnedTab: null,
  scope: 'selection',
  scopeChosen: false,
  selections: {},
  messages: [],
  busy: null,
  state: null,
  settingsOpen: false,
  set: (p) => set(p)
}));

export function setAiOpen(open: boolean) {
  useAi.getState().set({ open });
  try {
    localStorage.setItem(OPEN_KEY, open ? '1' : '0');
  } catch {}
}

export function toggleAi() {
  const s = useAi.getState();
  if (!s.open) s.set({ scopeChosen: false });
  setAiOpen(!s.open);
}

/** Editors call this whenever their selection changes. Empty selections are ignored so the box keeps its text. */
export function publishSelection(tabId: string, text: string) {
  const t = text.replace(/ /g, ' ').trim();
  if (!t) return;
  const s = useAi.getState();
  if (s.selections[tabId] === t) return;
  s.set({ selections: { ...s.selections, [tabId]: t.length > 20000 ? t.slice(0, 20000) : t }, ...(s.scopeChosen ? {} : { scope: 'selection' }) });
}

export function clearSelection(tabId: string) {
  const s = useAi.getState();
  const next = { ...s.selections };
  delete next[tabId];
  s.set({ selections: next });
}

(window as any).__slateAi = useAi;
