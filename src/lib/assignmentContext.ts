// Which assignment a file is for, chosen in the Claude tab: one of the student's assignments from Kea Scholar, or a
// rubric or guidelines they pasted. Kept per file (by its path) so a document remembers its assignment; Claude is
// given the whole assignment once per conversation (assistant.ts), and again when it changes.
import { create } from 'zustand';
import { api } from './api';
import { useTabs } from '../store';

/** `title`: the assignment's own title (without the course), for naming a new file after it. */
export type AssignmentRef = { id: string; label: string; title?: string } | { pasted: string; label: string };

const KEY = 'kea.assistant.assignments';
const load = (): Record<string, AssignmentRef> => {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}') || {};
  } catch {
    return {};
  }
};

export const useAssignments = create<{ byFile: Record<string, AssignmentRef> }>(() => ({ byFile: load() }));

/** The key a tab's file is remembered by: its path (or Drive id); an unsaved file only for as long as it's open. */
export const fileKey = (tabId: string) => {
  const t = useTabs.getState().tabs.find((x) => x.id === tabId);
  return t?.path || (t?.remote ? `google:${t.remote.id}` : `tab:${tabId}`);
};

export const assignmentOf = (tabId: string): AssignmentRef | null => useAssignments.getState().byFile[fileKey(tabId)] || null;

function store(byFile: Record<string, AssignmentRef>) {
  useAssignments.setState({ byFile });
  try {
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(Object.entries(byFile).filter(([f]) => !f.startsWith('tab:')))));
  } catch {}
}

export function setAssignment(tabId: string, ref: AssignmentRef | null) {
  const byFile = { ...useAssignments.getState().byFile };
  const k = fileKey(tabId);
  if (ref) byFile[k] = ref;
  else delete byFile[k];
  store(byFile);
}

/** Called when a file's key changes (a new file saved for the first time), so what's kept for it follows it. */
const followers: ((from: string, to: string) => void)[] = [];
export const onFileKeyChange = (fn: (from: string, to: string) => void) => void followers.push(fn);

// A file linked to an assignment keeps the link when it's saved somewhere new (a new file's key goes from the tab
// to its path; Save as keeps the link on the old file too).
const keyOfTab = (t: { id: string; path: string | null; remote?: { id: string } }) => t.path || (t.remote ? `google:${t.remote.id}` : `tab:${t.id}`);
useTabs.subscribe((s, prev) => {
  if (s.tabs === prev.tabs) return;
  for (const t of s.tabs) {
    const before = prev.tabs.find((x) => x.id === t.id);
    if (!before) continue;
    const from = keyOfTab(before);
    const to = keyOfTab(t);
    if (from === to) continue;
    const byFile = useAssignments.getState().byFile;
    if (byFile[from] && !byFile[to]) {
      const next = { ...byFile, [to]: byFile[from] };
      if (from.startsWith('tab:')) delete next[from];
      store(next);
    }
    for (const f of followers) f(from, to);
  }
});

/** What identifies the assignment as given to Claude (a change means Claude is given the new one). */
export const assignmentSig = (r: AssignmentRef) => ('id' in r ? `id:${r.id}` : `paste:${r.pasted.length}:${r.pasted.slice(0, 80)}`);

/** The assignment as Claude reads it: everything Kea has on it, or the pasted rubric. */
export async function assignmentText(r: AssignmentRef): Promise<string> {
  if ('pasted' in r) return `The rubric and guidelines the student pasted:\n${r.pasted.slice(0, 60000)}`;
  const b = await api.scholar.assignmentBrief(r.id).catch(() => null);
  return b ? b.text : `${r.label} (Kea can't find this assignment on the calendar any more: ask the student to paste its rubric).`;
}
