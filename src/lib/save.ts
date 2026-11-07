import { api } from './api';
import { extOf, baseName } from './fileTypes';
import { useTabs, toast, editSeq } from '../store';
import { setting } from './settings';
import { saveToGoogle } from './google';
import { chooseSaveTarget, inKeaCloud } from './keaCloud';

/** Turn a title (a document's first line, a slide's title) into a file name: no characters Windows refuses, at most ~60 long. */
export function safeFileName(title: string) {
  const clean = title.replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  if (clean.length <= 60) return clean;
  const cut = clean.slice(0, 60);
  const sp = cut.lastIndexOf(' ');
  return (sp > 30 ? cut.slice(0, sp) : cut).trim();
}

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
export async function saveTabFile(tabId: string, formats: SaveFormat[], saveAs: boolean, opts: { suggestedName?: string } = {}): Promise<boolean> {
  const seq = editSeq.get(tabId) || 0;
  const tab = useTabs.getState().tabs.find((t) => t.id === tabId);
  if (!tab) return false;

  // Google Docs/Sheets/Slides: upload back to Google Drive (it converts to its own format).
  if (tab.remote && tab.remote.canEdit && !saveAs) {
    if (isSilentSave() && !setting('google.autosave')) return false;
    const fmt = formats.find((f) => f.ext === tab.remote!.ext) || formats[0];
    try {
      await saveToGoogle(tabId, await fmt.build());
      useTabs.getState().updateTab(tabId, { dirty: (editSeq.get(tabId) || 0) !== seq });
      if (!isSilentSave()) toast('Saved to Google Drive', 'success');
      return true;
    } catch (err: any) {
      if (!isSilentSave()) toast(`Couldn't save to Google Drive: ${err?.message || err}`, 'error');
      return false;
    }
  }
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
    const suggested = `${safeFileName(opts.suggestedName || '') || baseName(tab.name)}.${(format || formats[0]).ext}`;
    // Kea Cloud's folder is hidden inside Kea's profile: Save as from there starts in the usual save folder instead.
    const dir = tab.path && !inKeaCloud(tab.path) ? tab.path.replace(/[\\/][^\\/]*$/, '') : '';
    // A file with no place yet: Kea Cloud or this PC (asked only when signed in to a Kea account).
    const where = !tab.path ? await chooseSaveTarget(suggested) : 'pc';
    if (where === null) return false;
    const chosen = where !== 'pc' ? where : await api.saveDialog({
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
    useTabs.getState().updateTab(tabId, { path: target!, name, remote: undefined, dirty: (editSeq.get(tabId) || 0) !== seq });
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
