import { create } from 'zustand';
import type { EditorKind } from './lib/fileTypes';
import { uid } from './lib/util';
import { setting } from './lib/settings';

export interface Tab {
  id: string;
  kind: EditorKind | 'home';
  name: string;
  path: string | null;
  data: Uint8Array | null;
  dirty: boolean;
  /** A Google Docs/Sheets/Slides file edited in Slate and saved back to Google Drive. */
  remote?: { provider: 'google'; id: string; ext: string; localPath: string; canEdit: boolean };
  /** Bumped when the file is reloaded from disk so the editor remounts. */
  version: number;
}

export interface EditorHandle {
  save(saveAs: boolean): Promise<boolean>;
  print?(): Promise<void>;
  exportPdf?(): Promise<void>;
  /** Produce the file bytes without saving (used by automated checks). */
  debugBuild?(): Promise<Uint8Array>;
  /** Produce the PDF export without asking where to save (used by automated checks). */
  debugPdf?(): Promise<Uint8Array>;
  /** Hooks the AI sidebar uses to read and change the document. */
  ai?: AiHooks;
}

export interface DocSection {
  id: string;
  label: string;
  text: string;
}

export interface AiHooks {
  /** Short noun for the UI: "document", "PDF", "sheet", "presentation", "file". */
  noun: string;
  getDocument(): Promise<{ full: string; sections: DocSection[] }>;
  /** Replace the current selection; false if this editor can't. */
  replaceSelection?(text: string): boolean;
  /** Insert after the selection / at the cursor (or as a comment for PDFs). */
  insertText?(text: string): boolean;
  /** Scroll to and highlight a quote from the document. */
  reveal?(quote: string): boolean;
  /** Find a quote and replace it (used by "Apply" on suggestions). */
  replaceQuote?(quote: string, replacement: string): boolean;
  /** Run edits so they show up as tracked suggestions (accept / reject) instead of changing the text. */
  track?<T>(fn: () => T): T;
  /** Leave a reviewer comment (from "Slate AI") on a quote; false if the quote can't be found. */
  addComment?(quote: string, text: string): boolean;
  insertLabel?: string;
}

/** Stable hooks object that always calls the editor's latest implementation. */
export function proxyAi(ref: { current: AiHooks }): AiHooks {
  const c = ref.current;
  return {
    get noun() {
      return ref.current.noun;
    },
    get insertLabel() {
      return ref.current.insertLabel;
    },
    getDocument: () => ref.current.getDocument(),
    ...(c.replaceSelection ? { replaceSelection: (t: string) => ref.current.replaceSelection?.(t) ?? false } : {}),
    ...(c.insertText ? { insertText: (t: string) => ref.current.insertText?.(t) ?? false } : {}),
    ...(c.reveal ? { reveal: (q: string) => ref.current.reveal?.(q) ?? false } : {}),
    ...(c.replaceQuote ? { replaceQuote: (q: string, r: string) => ref.current.replaceQuote?.(q, r) ?? false } : {}),
    ...(c.addComment ? { addComment: (q: string, t: string) => ref.current.addComment?.(q, t) ?? false } : {}),
    ...(c.track ? { track: <T,>(fn: () => T) => (ref.current.track ? ref.current.track(fn) : fn()) } : {})
  };
}

/** Two tabs side by side. The active tab (keyboard focus) is one of them. */
export interface Split {
  left: string;
  right: string;
  /** Share of the width the left side gets (0.15–0.85). */
  ratio: number;
}

interface TabState {
  tabs: Tab[];
  activeId: string;
  split: Split | null;
  /** Show `id` beside the active tab (or the next tab if `id` is the active one). */
  openSplit(id?: string): void;
  closeSplit(): void;
  setSplitRatio(r: number): void;
  addTab(t: Omit<Tab, 'id' | 'dirty' | 'version' | 'remote'> & { remote?: Tab['remote'] }): string;
  closeTab(id: string): void;
  setActive(id: string): void;
  updateTab(id: string, patch: Partial<Tab>): void;
  moveTab(from: number, to: number): void;
}

const HOME: Tab = { id: 'home', kind: 'home', name: 'Home', path: null, data: null, dirty: false, version: 0 };

export const useTabs = create<TabState>((set, get) => ({
  tabs: [HOME],
  activeId: 'home',
  split: null,
  openSplit(id) {
    const { tabs, activeId, split } = get();
    const cur = activeId;
    let other = id && id !== cur ? id : undefined;
    if (!other) {
      // Pick a neighbour: the next tab, else the previous one, else Home.
      const i = tabs.findIndex((t) => t.id === cur);
      other = (tabs[i + 1] || tabs[i - 1] || HOME).id;
    }
    if (other === cur) return;
    // Keep the same left-to-right order as the tab bar.
    const idx = (x: string) => tabs.findIndex((t) => t.id === x);
    const [left, right] = idx(other) < idx(cur) ? [other, cur] : [cur, other];
    set({ split: { left, right, ratio: split?.ratio ?? 0.5 }, activeId: other });
  },
  closeSplit() {
    set({ split: null });
  },
  setSplitRatio(r) {
    const s = get().split;
    if (s) set({ split: { ...s, ratio: Math.min(0.85, Math.max(0.15, r)) } });
  },
  addTab(t) {
    const id = uid();
    set((s) => ({ tabs: [...s.tabs, { ...t, id, dirty: false, version: 0 }], activeId: id }));
    return id;
  },
  closeTab(id) {
    if (id === 'home') return;
    const { tabs, activeId } = get();
    const idx = tabs.findIndex((t) => t.id === id);
    const next = tabs.filter((t) => t.id !== id);
    let nextActive = activeId;
    if (activeId === id) {
      const pref = setting<string>('general.tabsCloseToLeft');
      nextActive = (pref === 'home' ? HOME : pref === 'left' ? next[idx - 1] || next[idx] || HOME : next[idx] || next[idx - 1] || HOME).id;
    }
    editorRegistry.delete(id);
    let split = get().split;
    if (split && (split.left === id || split.right === id)) {
      // Closing one side of a split leaves the other side on its own.
      nextActive = split.left === id ? split.right : split.left;
      split = null;
    }
    set({ tabs: next, activeId: nextActive, split });
  },
  setActive(id) {
    const { split, activeId } = get();
    if (split && id !== split.left && id !== split.right) {
      // Picking another tab while split replaces the side that has focus.
      const side = activeId === split.left ? 'left' : 'right';
      return set({ activeId: id, split: { ...split, [side]: id } });
    }
    set({ activeId: id });
  },
  updateTab(id, patch) {
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
  },
  moveTab(from, to) {
    set((s) => {
      if (from === 0 || to === 0) return s;
      const tabs = [...s.tabs];
      const [t] = tabs.splice(from, 1);
      tabs.splice(to, 0, t);
      return { tabs };
    });
  }
}));

export const editorRegistry = new Map<string, EditorHandle>();
(window as any).__slate = { useTabs: () => useTabs, editorRegistry };

/** Counts edits per tab, so a save only marks a tab clean if nothing changed while it was saving. */
export const editSeq = new Map<string, number>();

export function setDirty(id: string, dirty: boolean) {
  if (dirty) editSeq.set(id, (editSeq.get(id) || 0) + 1);
  const t = useTabs.getState().tabs.find((x) => x.id === id);
  if (t && t.dirty !== dirty) useTabs.getState().updateTab(id, { dirty });
}

// ---------- Dialogs & toasts ----------
export interface DialogButton {
  id: string;
  label: string;
  primary?: boolean;
  danger?: boolean;
}
export interface DialogRequest {
  id: string;
  title: string;
  message?: string;
  buttons?: DialogButton[];
  input?: { label?: string; value: string; placeholder?: string };
  resolve(result: { button: string; value?: string }): void;
}
export interface Toast {
  id: string;
  message: string;
  kind: 'info' | 'error' | 'success';
}

interface UiState {
  dialogs: DialogRequest[];
  toasts: Toast[];
  pushDialog(d: DialogRequest): void;
  popDialog(id: string): void;
  toast(message: string, kind?: Toast['kind']): void;
}

export const useUi = create<UiState>((set) => ({
  dialogs: [],
  toasts: [],
  pushDialog: (d) => set((s) => ({ dialogs: [...s.dialogs, d] })),
  popDialog: (id) => set((s) => ({ dialogs: s.dialogs.filter((d) => d.id !== id) })),
  toast: (message, kind = 'info') => {
    const id = uid();
    set((s) => ({ toasts: [...s.toasts, { id, message, kind }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 6000 : 3200);
  }
}));

export function ask(title: string, message: string, buttons: DialogButton[]): Promise<string> {
  return new Promise((res) => {
    useUi.getState().pushDialog({ id: uid(), title, message, buttons, resolve: (r) => res(r.button) });
  });
}

export function prompt(title: string, label: string, value = '', placeholder = ''): Promise<string | null> {
  return new Promise((res) => {
    useUi.getState().pushDialog({
      id: uid(),
      title,
      input: { label, value, placeholder },
      buttons: [
        { id: 'cancel', label: 'Cancel' },
        { id: 'ok', label: 'OK', primary: true }
      ],
      resolve: (r) => res(r.button === 'ok' ? (r.value ?? '') : null)
    });
  });
}

export const toast = (m: string, k?: Toast['kind']) => useUi.getState().toast(m, k);
