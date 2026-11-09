// Linking a file to an assignment (the Claude tab's picker, or the assignment bar in Docs and Slides). A new, empty,
// untitled document or presentation is named after the assignment: the title cleaned for file names, never a name
// an open file or a file in the save folder already has. Files with a name or content of their own are left alone.
import { api } from './api';
import { setting } from './settings';
import { useTabs, editorRegistry } from '../store';
import { setAssignment, type AssignmentRef } from './assignmentContext';
import { isEmptyContent, nameForAssignment, safeFileName, uniqueName } from './fileNames';

/** Tabs named after their assignment: their first save suggests that name (not the first line). */
const named = new Set<string>();
export const namedAfterAssignment = (tabId: string) => named.has(tabId);

/** Link (or with null, unlink) the file in `tabId` to an assignment, naming a new empty file after it. */
export async function linkAssignment(tabId: string, ref: AssignmentRef | null): Promise<string | null> {
  setAssignment(tabId, ref);
  if (!ref || !('id' in ref) || !ref.title || setting('assistant.nameFromAssignment') === false) return null;
  return nameAfter(tabId, ref.title);
}

async function nameAfter(tabId: string, title: string): Promise<string | null> {
  const tab = useTabs.getState().tabs.find((t) => t.id === tabId);
  if (!tab || tab.remote || tab.path || (tab.kind !== 'doc' && tab.kind !== 'slides')) return null;
  const hooks = editorRegistry.get(tabId)?.ai;
  const d = hooks ? await hooks.getDocument().catch(() => null) : null;
  if (!d) return null;
  const taken = useTabs
    .getState()
    .tabs.filter((t) => t.id !== tabId)
    .map((t) => t.name);
  let name = nameForAssignment({ kind: tab.kind, name: tab.name, hasPath: false, empty: isEmptyContent(tab.kind, d.sections), title, taken });
  if (!name) return null;
  // Never a name already used in the folder new files are saved to.
  const folder = String(setting('files.defaultFolder') || '').replace(/[\\/]+$/, '');
  if (folder) {
    const ext = String(setting(`files.format.${tab.kind}`) || (tab.kind === 'doc' ? 'docx' : 'pptx'));
    const sep = folder.includes('\\') ? '\\' : '/';
    for (let i = 0; i < 50 && (await api.fileExists(`${folder}${sep}${name}.${ext}`).catch(() => false)); i++) {
      taken.push(name);
      name = uniqueName(safeFileName(title), taken);
    }
  }
  // (Still the same new, untitled file? The person may have typed or saved meanwhile.)
  const now = useTabs.getState().tabs.find((t) => t.id === tabId);
  if (!now || now.path || now.name !== tab.name) return null;
  const again = await hooks!.getDocument().catch(() => null);
  if (!again || !isEmptyContent(tab.kind, again.sections)) return null;
  useTabs.getState().updateTab(tabId, { name });
  named.add(tabId);
  return name;
}
