// Linking a file to an assignment (the Claude tab's picker, or the assignment bar in Docs and Slides). A new, empty,
// untitled document or presentation is named after the assignment: the title cleaned for file names, never a name
// an open file or a file in the save folder already has. Files with a name or content of their own are left alone.
import { api } from './api';
import { setting } from './settings';
import { useTabs, editorRegistry } from '../store';
import { setAssignment, type AssignmentRef } from './assignmentContext';
import { isEmptyContent, nameForAssignment, safeFileName, uniqueName, classFieldReplacements, GENERIC_NAME } from './fileNames';

/** Tabs named after their assignment: their first save suggests that name (not the first line). */
const named = new Set<string>();
export const namedAfterAssignment = (tabId: string) => named.has(tabId);

/** Link (or with null, unlink) the file in `tabId` to an assignment, naming a new empty file after it. */
export async function linkAssignment(tabId: string, ref: AssignmentRef | null): Promise<string | null> {
  setAssignment(tabId, ref);
  if (!ref || !('id' in ref)) return null;
  fillClassFields(tabId, ref.id).catch(() => {});
  if (!ref.title || setting('assistant.nameFromAssignment') === false) return null;
  return (await nameAfter(tabId, ref.title)) ?? (await renameSaved(tabId, ref.title));
}

/**
 * A document made from a school template (MLA, APA, Chicago) has "Instructor Name" and "Course Name" lines in its
 * heading: once it's linked to an assignment, Kea knows the class and fills them in. Only those exact lines; nothing
 * the student wrote is touched. (The student's name and the date are filled when the template opens.)
 */
async function fillClassFields(tabId: string, id: string) {
  if (setting('templates.fillClass') === false) return;
  const hooks = editorRegistry.get(tabId)?.ai;
  if (!hooks?.replaceQuote || hooks.noun !== 'document') return;
  const doc = await hooks.getDocument();
  const lines = new Set(doc.sections.map((s) => s.text.trim()));
  if (!['Instructor Name', 'Course Name', 'Course Number: Course Name'].some((l) => lines.has(l))) return;
  const b = await api.scholar.assignmentBrief(id);
  if (!b) return;
  for (const [from, to] of classFieldReplacements(b)) if (lines.has(from) && to) hooks.replaceQuote(from, to);
}

/**
 * A saved file linked to an assignment is renamed after it, when it still has a generic name ("Document 3", "MLA
 * essay", "Untitled"): on disk, next to where it is, never over another file. Files the student named stay as they are.
 */
async function renameSaved(tabId: string, title: string): Promise<string | null> {
  const tab = useTabs.getState().tabs.find((t) => t.id === tabId);
  if (!tab?.path || tab.remote || tab.dirty) return null;
  const sep = tab.path.includes('\\') ? '\\' : '/';
  const dir = tab.path.slice(0, tab.path.lastIndexOf(sep));
  const file = tab.path.slice(tab.path.lastIndexOf(sep) + 1);
  const dot = file.lastIndexOf('.');
  const base = dot > 0 ? file.slice(0, dot) : file;
  const ext = dot > 0 ? file.slice(dot) : '';
  if (!GENERIC_NAME.test(base)) return null;
  let name = safeFileName(title);
  if (!name || name === base) return null;
  const taken: string[] = [];
  for (let i = 0; i < 50 && (await api.fileExists(`${dir}${sep}${name}${ext}`).catch(() => true)); i++) {
    taken.push(name);
    name = uniqueName(safeFileName(title), taken);
  }
  const to = `${dir}${sep}${name}${ext}`;
  if (!(await api.renameFile(tab.path, to).catch(() => false))) return null;
  useTabs.getState().updateTab(tabId, { path: to, name: `${name}${ext}` });
  return name;
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
