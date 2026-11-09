// Claude's slide edits in the background: the person stays on the slide they're looking at (followed by its id, so
// slides Claude adds, moves or deletes elsewhere don't move them), keeps their selection, and the text box they're
// typing in is never changed under them. Pure (no imports), so tests run it directly.

interface SlideLike {
  id: string;
  els: { id: string }[];
  notes?: string;
  bg?: string;
}

/**
 * Which slide index shows `viewId` now. A slide that's gone (deleted) falls back to the nearest one, at the position
 * it had (`lastIdx`), so the person lands next to where they were.
 */
export function indexOfView(slides: SlideLike[], viewId: string | null, lastIdx: number): number {
  const i = viewId ? slides.findIndex((s) => s.id === viewId) : -1;
  if (i >= 0) return i;
  return Math.max(0, Math.min(lastIdx, slides.length - 1));
}

/** The person's selected element after a change: kept while it still exists on their slide, else none. */
export function keepSelected(slides: SlideLike[], viewIdx: number, selId: string | null): string | null {
  if (!selId) return null;
  return slides[viewIdx]?.els.some((e) => e.id === selId) ? selId : null;
}

/** True when `after` changes (or removes) the element with id `elId` that `before` has. */
export function touchesElement(before: SlideLike[], after: SlideLike[], elId: string | null): boolean {
  if (!elId) return false;
  const find = (slides: SlideLike[]) => {
    for (const s of slides) for (const e of s.els) if (e.id === elId) return e;
    return null;
  };
  const a = find(before);
  if (!a) return false;
  return find(after) !== a;
}

/** What a change touched: the slides that are new or different, and the elements that are new or different. */
export function changedParts(before: SlideLike[], after: SlideLike[]): { slides: string[]; els: string[] } {
  const old = new Map(before.map((s) => [s.id, s]));
  const slides: string[] = [];
  const els: string[] = [];
  for (const s of after) {
    const o = old.get(s.id);
    if (o === s) continue;
    if (!o) {
      slides.push(s.id);
      continue;
    }
    const oldEls = new Map(o.els.map((e) => [e.id, e]));
    let changed = o.notes !== s.notes || o.bg !== s.bg || o.els.length !== s.els.length;
    for (const e of s.els) {
      if (oldEls.get(e.id) !== e) {
        els.push(e.id);
        changed = true;
      }
    }
    if (changed) slides.push(s.id);
  }
  return { slides, els };
}
