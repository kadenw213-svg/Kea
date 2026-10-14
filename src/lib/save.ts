import { api } from './api';
import { extOf, baseName } from './fileTypes';
import { useTabs, toast, editSeq } from '../store';
import { setting } from './settings';

let silentDepth = 0;
/** True while an autosave is running: saves must not show dialogs or toasts. */
export const isSilentSave = () => silentDepth > 0;
/** Run a save without any dialogs or toasts (returns false if it would have needed one). */
export async function silently<T>(fn: () => Promise<T>): Promise<T> {
  silentDepth++;
  try {
    return await fn();
  } finally {
    silentDepth--;
  }
}

export interface SaveFormat {
  name: string;
  ext: string;
  build(): Promise<Uint8Array>;
}

/**
 * Shared save flow for every editor. Saves in place when the current file's
 * extension is one of `formats`, otherwise asks for a location.
 */
export async function saveTabFile(tabId: string, formats: SaveFormat[], saveAs: boolean): Promise<boolean> {
  const seq = editSeq.get(tabId) || 0;
  const tab = useTabs.getState().tabs.find((t) => t.id === tabId);
  if (!tab) return false;
  let target = tab.path;
  let format = target ? formats.find((f) => f.ext === extOf(target!)) : undefined;
  if (!target) {
    // New files: offer the format chosen in Settings first.
    const pref = setting<string>(`files.format.${tab.kind}`);
    const i = formats.findIndex((f) => f.ext === pref);
    if (i > 0) formats = [formats[i], ...formats.filter((_, j) => j !== i)];
  }

  if (saveAs || !target || !format) {
    if (isSilentSave()) return false;
    const suggested = `${baseName(tab.name)}.${(format || formats[0]).ext}`;
    const dir = tab.path ? tab.path.replace(/[\\/][^\\/]*$/, '') : '';
    const chosen = await api.saveDialog({
      title: 'Save as',
      defaultPath: dir ? `${dir}${tab.path!.includes('\\') ? '\\' : '/'}${suggested}` : suggested,
      filters: formats.map((f) => ({ name: f.name, extensions: [f.ext] }))
    });
    if (!chosen) return false;
    target = chosen;
    format = formats.find((f) => f.ext === extOf(chosen)) || formats[0];
    if (!extOf(chosen)) target = `${chosen}.${format.ext}`;
  }

  try {
    const bytes = await format!.build();
    await api.writeFile(target!, bytes);
    const name = target!.split(/[\\/]/).pop()!;
    // Edits made while the file was being written keep the tab marked unsaved.
    useTabs.getState().updateTab(tabId, { path: target!, name, dirty: (editSeq.get(tabId) || 0) !== seq });
    if (!isSilentSave()) {
      api.addRecent(target!);
      toast(`Saved ${name}`, 'success');
    }
    return true;
  } catch (err: any) {
    console.error(err);
    if (!isSilentSave()) toast(`Could not save: ${err?.message || err}`, 'error');
    else console.warn('autosave failed', err);
    return false;
  }
}

/** Export to a separate file without changing what the tab points at. */
export async function exportFile(defaultName: string, format: SaveFormat): Promise<boolean> {
  const chosen = await api.saveDialog({
    title: `Export ${format.name}`,
    defaultPath: defaultName,
    filters: [{ name: format.name, extensions: [format.ext] }]
  });
  if (!chosen) return false;
  try {
    await api.writeFile(chosen, await format.build());
    toast(`Exported ${chosen.split(/[\\/]/).pop()}`, 'success');
    return true;
  } catch (err: any) {
    toast(`Export failed: ${err?.message || err}`, 'error');
    return false;
  }
}
