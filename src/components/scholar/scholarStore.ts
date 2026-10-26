import { create } from 'zustand';
import { useTabs } from '../../store';

/** What the Scholar tab shows. */
export type ScholarView = { name: 'week' } | { name: 'inbox' } | { name: 'messages'; id?: string; reply?: boolean } | { name: 'calendar' } | { name: 'class'; courseId: string; tab?: 'weeks' | 'textbook' } | { name: 'library' } | { name: 'add' } | { name: 'scans' } | { name: 'resources' } | { name: 'account' };

interface ScholarStore {
  view: ScholarView;
  /** Bumped when classes change (after a scan or a checkmark), so views reload. */
  version: number;
  /** Bumped when Inbox items are read or deleted, so the unread count beside Inbox follows. */
  inboxTick: number;
  /** The practice exam or flashcard deck being taken, if any. */
  study: string | null;
  set(p: Partial<ScholarStore>): void;
}

export const useScholar = create<ScholarStore>((set) => ({
  view: { name: 'week' },
  version: 0,
  inboxTick: 0,
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

/** Inbox items were read or deleted: count the unread ones again (only the count, not every screen). */
export const bumpInbox = () => useScholar.getState().set({ inboxTick: useScholar.getState().inboxTick + 1 });

/** Open the Scholar tab (one per window) at a view. */
export function openScholar(view: ScholarView = { name: 'week' }) {
  useScholar.getState().set({ view });
  const tabs = useTabs.getState();
  const existing = tabs.tabs.find((t) => t.kind === 'scholar');
  if (existing) tabs.setActive(existing.id);
  else tabs.addTab({ kind: 'scholar', name: 'Scholar', path: null, data: null });
}
