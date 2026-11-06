// Which assignment a file is for, chosen in the Claude tab: one of the student's assignments from Kea Scholar, or a
// rubric or guidelines they pasted. Kept per file (by its path) so a document remembers its assignment; Claude is
// given the whole assignment once per conversation (assistant.ts), and again when it changes.
import { create } from 'zustand';
import { api } from './api';
import { useTabs } from '../store';

export type AssignmentRef = { id: string; label: string } | { pasted: string; label: string };

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

export function setAssignment(tabId: string, ref: AssignmentRef | null) {
  const byFile = { ...useAssignments.getState().byFile };
  const k = fileKey(tabId);
  if (ref) byFile[k] = ref;
  else delete byFile[k];
  useAssignments.setState({ byFile });
  try {
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(Object.entries(byFile).filter(([f]) => !f.startsWith('tab:')))));
  } catch {}
}

/** What identifies the assignment as given to Claude (a change means Claude is given the new one). */
export const assignmentSig = (r: AssignmentRef) => ('id' in r ? `id:${r.id}` : `paste:${r.pasted.length}:${r.pasted.slice(0, 80)}`);

/** The assignment as Claude reads it: everything Kea has on it, or the pasted rubric. */
export async function assignmentText(r: AssignmentRef): Promise<string> {
  if ('pasted' in r) return `The rubric and guidelines the student pasted:\n${r.pasted.slice(0, 60000)}`;
  const b = await api.scholar.assignmentBrief(r.id).catch(() => null);
  return b ? b.text : `${r.label} (Kea can't find this assignment on the calendar any more: ask the student to paste its rubric).`;
}
