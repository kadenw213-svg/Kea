import type { DocState, Layer } from './types';

/**
 * Undo history as snapshots that share canvases. Canvases are never edited once a
 * snapshot holds them (the engine copies a canvas before changing it, see `frozen`),
 * so each step only costs the memory of the layers it actually changed.
 */

/** Canvases some history step holds: must be copied before editing. */
export const frozen = new WeakSet<HTMLCanvasElement>();

export function cloneLayer(l: Layer): Layer {
  const base: any = { ...l, mask: l.mask ? { ...l.mask } : null };
  if (l.kind === 'group') base.children = l.children.map(cloneLayer);
  if (l.kind === 'adjust') base.adj = JSON.parse(JSON.stringify(l.adj));
  if (l.kind === 'text') base.text = { ...l.text };
  if (l.kind === 'shape') base.shape = { ...l.shape };
  return base;
}

export function cloneState(s: DocState): DocState {
  return {
    doc: { w: s.doc.w, h: s.doc.h, layers: s.doc.layers.map(cloneLayer) },
    activeId: s.activeId,
    selection: s.selection ? { canvas: s.selection.canvas, bounds: { ...s.selection.bounds } } : null
  };
}

function canvasesOf(s: DocState, out: Set<HTMLCanvasElement>) {
  const walk = (ls: Layer[]) => {
    for (const l of ls) {
      if (l.kind === 'group') walk(l.children);
      else if (l.kind !== 'adjust') out.add(l.canvas);
      if (l.mask) out.add(l.mask.canvas);
    }
  };
  walk(s.doc.layers);
  if (s.selection) out.add(s.selection.canvas);
}

export interface HistoryEntry {
  /** Unique for the editor's lifetime (used to tell whether the saved state is showing). */
  id: number;
  label: string;
  state: DocState;
}
let nextId = 1;

export class History {
  entries: HistoryEntry[] = [];
  index = -1;
  /** Memory budget for all snapshots together. */
  maxBytes = 1.5 * 1024 * 1024 * 1024;
  maxSteps = 300;

  reset(label: string, state: DocState) {
    this.entries = [];
    this.index = -1;
    this.push(label, state);
  }

  push(label: string, state: DocState) {
    const snap = cloneState(state);
    const set = new Set<HTMLCanvasElement>();
    canvasesOf(snap, set);
    set.forEach((c) => frozen.add(c));
    this.entries = this.entries.slice(0, this.index + 1);
    this.entries.push({ id: nextId++, label, state: snap });
    this.index = this.entries.length - 1;
    this.trim();
  }

  /** Drop the oldest steps while over the step count or memory budget (always keeps the newest two). */
  private trim() {
    while (this.entries.length > this.maxSteps) this.dropOldest();
    while (this.entries.length > 2 && this.bytes() > this.maxBytes) this.dropOldest();
  }
  private dropOldest() {
    this.entries.shift();
    this.index--;
  }
  /** Id of the step being shown. */
  get currentId() {
    return this.entries[this.index]?.id ?? 0;
  }

  bytes(): number {
    const set = new Set<HTMLCanvasElement>();
    for (const e of this.entries) canvasesOf(e.state, set);
    let n = 0;
    set.forEach((c) => (n += c.width * c.height * 4));
    return n;
  }

  get canUndo() {
    return this.index > 0;
  }
  get canRedo() {
    return this.index < this.entries.length - 1;
  }
  /** A working copy of step `i` (the snapshot itself stays untouched). */
  stateAt(i: number): DocState {
    return cloneState(this.entries[i].state);
  }
}
