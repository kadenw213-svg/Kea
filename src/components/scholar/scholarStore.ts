import { create } from 'zustand';
import { useTabs } from '../../store';

/** What the Scholar tab shows. */
export type ScholarView = { name: 'week' } | { name: 'inbox' } | { name: 'messages'; id?: string } | { name: 'calendar' } | { name: 'class'; courseId: string; tab?: 'weeks' } | { name: 'library' } | { name: 'add' } | { name: 'scans' } | { name: 'resources' } | { name: 'account' };

interface ScholarStore {
  view: ScholarView;
  /** The item open in the side panel. */
  itemId: string | null;
  /** Bumped when classes change (after a scan or a checkmark), so views reload. */
  version: number;
  /** The practice exam or flashcard deck being taken, if any. */
  study: string | null;
  set(p: Partial<ScholarStore>): void;
}

export const useScholar = create<ScholarStore>((set) => ({
  view: { name: 'week' },
  itemId: null,
  version: 0,
  study: null,
  set: (p) => set(p)
}));

// A burst of changes (a scan saving one thing after another) reloads the screens once, not once per change: every
// reload re-reads the classes, the calendar and the study sets.
let reloadTimer: ReturnType<typeof setTimeout> | null = null;
export const reloadScholar = () => {
  if (reloadTimer) return;
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    useScholar.getState().set({ version: useScholar.getState().version + 1 });
  }, 400);
};

/** Open the Scholar tab (one per window) at a view. */
export function openScholar(view: ScholarView = { name: 'week' }) {
  useScholar.getState().set({ view, itemId: null });
  const tabs = useTabs.getState();
  const existing = tabs.tabs.find((t) => t.kind === 'scholar');
  if (existing) tabs.setActive(existing.id);
  else tabs.addTab({ kind: 'scholar', name: 'Scholar', path: null, data: null });
}
