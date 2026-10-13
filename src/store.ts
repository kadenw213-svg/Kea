import { create } from 'zustand';
import type { EditorKind } from './lib/fileTypes';
import { uid } from './lib/util';

export interface Tab {
  id: string;
  kind: EditorKind | 'home';
  name: string;
  path: string | null;
  data: Uint8Array | null;
  dirty: boolean;
  /** Bumped when the file is reloaded from disk so the editor remounts. */
  version: number;
}

export interface EditorHandle {
  save(saveAs: boolean): Promise<boolean>;
  print?(): Promise<void>;
  exportPdf?(): Promise<void>;
  /** Produce the file bytes without saving (used by automated checks). */
  debugBuild?(): Promise<Uint8Array>;
}

interface TabState {
  tabs: Tab[];
  activeId: string;
  addTab(t: Omit<Tab, 'id' | 'dirty' | 'version'>): string;
  closeTab(id: string): void;
  setActive(id: string): void;
  updateTab(id: string, patch: Partial<Tab>): void;
  moveTab(from: number, to: number): void;
}

const HOME: Tab = { id: 'home', kind: 'home', name: 'Home', path: null, data: null, dirty: false, version: 0 };

export const useTabs = create<TabState>((set, get) => ({
  tabs: [HOME],
  activeId: 'home',
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
    if (activeId === id) nextActive = (next[idx] || next[idx - 1] || HOME).id;
    editorRegistry.delete(id);
    set({ tabs: next, activeId: nextActive });
  },
  setActive(id) {
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

export function setDirty(id: string, dirty: boolean) {
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
