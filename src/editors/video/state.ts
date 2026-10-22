import { createStore, StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { createContext, useContext } from 'react';
import type { Project, Clip } from './model';
import { projectDuration } from './model';

export type Tool = 'select' | 'razor' | 'ripple' | 'roll' | 'slip';
export type Panel = 'source' | 'timeline' | 'program' | 'other';

/** A transition picked on the timeline: the clip and which edge. */
export interface TransitionRef {
  clipId: string;
  edge: 'in' | 'out';
}

export interface SourceView {
  mediaId: string;
  in: number | null;
  out: number | null;
  /** Playhead inside the source, seconds. */
  t: number;
}

export interface EditorState {
  project: Project;
  past: { p: Project; label: string }[];
  future: { p: Project; label: string }[];
  /** Bumped on every change, so the save button and autosave know. */
  rev: number;
  savedRev: number;
  sel: string[];
  selTransition: TransitionRef | null;
  selMarker: string | null;
  playhead: number;
  playing: boolean;
  /** Shuttle rate: 1 normal, 2/4/8 faster, negative = backwards. */
  rate: number;
  /** Pixels per second on the timeline. */
  zoom: number;
  scrollX: number;
  tool: Tool;
  snapping: boolean;
  focus: Panel;
  source: SourceView | null;
  clipboard: Clip[] | null;
  loop: boolean;
}

export interface Actions {
  /** One undoable change: `fn` edits a deep copy of the project. */
  commit(label: string, fn: (p: Project) => void): void;
  /** Start a drag: remember the project for undo, then call `live` many times and `end` once. */
  begin(label: string): void;
  live(fn: (p: Project) => void): void;
  /** Replace the project during a drag from the snapshot taken by `begin`. */
  liveFrom(fn: (p: Project) => void): void;
  end(): void;
  cancelDrag(): void;
  undo(): string | null;
  redo(): string | null;
  set(patch: Partial<EditorState>): void;
  select(ids: string[]): void;
  seek(t: number): void;
}

export type Store = StoreApi<EditorState & Actions>;

const clone = <T,>(x: T): T => structuredClone(x);

export function makeStore(project: Project): Store {
  let drag: { p: Project; label: string } | null = null;
  return createStore<EditorState & Actions>((set, get) => ({
    project,
    past: [],
    future: [],
    rev: 0,
    savedRev: 0,
    sel: [],
    selTransition: null,
    selMarker: null,
    playhead: project.view?.playhead ?? 0,
    playing: false,
    rate: 1,
    zoom: project.view?.zoom ?? 60,
    scrollX: 0,
    tool: 'select',
    snapping: true,
    focus: 'timeline',
    source: null,
    clipboard: null,
    loop: false,
    commit(label, fn) {
      const cur = get().project;
      const next = clone(cur);
      fn(next);
      const past = [...get().past, { p: cur, label }];
      if (past.length > 300) past.shift();
      set({ project: next, past, future: [], rev: get().rev + 1, ...prune(next, get()) });
    },
    begin(label) {
      drag = { p: get().project, label };
    },
    live(fn) {
      const next = clone(get().project);
      fn(next);
      set({ project: next });
    },
    liveFrom(fn) {
      if (!drag) return;
      const next = clone(drag.p);
      fn(next);
      set({ project: next });
    },
    end() {
      if (!drag) return;
      const d = drag;
      drag = null;
      if (d.p === get().project) return;
      if (JSON.stringify(d.p) === JSON.stringify(get().project)) return set({ project: d.p });
      const past = [...get().past, d];
      if (past.length > 300) past.shift();
      set({ past, future: [], rev: get().rev + 1, ...prune(get().project, get()) });
    },
    cancelDrag() {
      if (drag) set({ project: drag.p });
      drag = null;
    },
    undo() {
      const past = get().past;
      const last = past[past.length - 1];
      if (!last) return null;
      set({ project: last.p, past: past.slice(0, -1), future: [...get().future, { p: get().project, label: last.label }], rev: get().rev + 1, ...prune(last.p, get()) });
      return last.label;
    },
    redo() {
      const fut = get().future;
      const n = fut[fut.length - 1];
      if (!n) return null;
      set({ project: n.p, future: fut.slice(0, -1), past: [...get().past, { p: get().project, label: n.label }], rev: get().rev + 1, ...prune(n.p, get()) });
      return n.label;
    },
    set(patch) {
      set(patch);
    },
    select(ids) {
      set({ sel: ids, selTransition: null, selMarker: null });
    },
    seek(t) {
      set({ playhead: Math.max(0, Math.min(t, Math.max(projectDuration(get().project), 0) + 60 * 60)) });
    }
  }));
}

/** Drop selections that point at clips which no longer exist. */
function prune(p: Project, s: EditorState): Partial<EditorState> {
  const ids = new Set(p.clips.map((c) => c.id));
  const sel = s.sel.filter((id) => ids.has(id));
  const tr = s.selTransition && ids.has(s.selTransition.clipId) ? s.selTransition : null;
  const mk = s.selMarker && p.markers.some((m) => m.id === s.selMarker) ? s.selMarker : null;
  return { sel: sel.length === s.sel.length ? s.sel : sel, selTransition: tr, selMarker: mk };
}

export const StoreContext = createContext<Store>(null as any);

/** Read from the video editor's store (re-renders when the picked value changes). */
export function useVE<T>(pick: (s: EditorState & Actions) => T): T {
  return useStore(useContext(StoreContext), pick);
}
export function useVEStore(): Store {
  return useContext(StoreContext);
}
