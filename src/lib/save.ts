import { api } from './api';
import { extOf, baseName } from './fileTypes';
import { useTabs, toast } from '../store';

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
  const tab = useTabs.getState().tabs.find((t) => t.id === tabId);
  if (!tab) return false;
  let target = tab.path;
  let format = target ? formats.find((f) => f.ext === extOf(target!)) : undefined;

  if (saveAs || !target || !format) {
    const suggested = `${baseName(tab.name)}.${(format || formats[0]).ext}`;
    const dir = tab.path ? tab.path.replace(/[\/][^\/]*$/, '') : '';
    const chosen = await api.saveDialog({
      title: 'Save as',
      defaultPath: dir ? `${dir}\${suggested}` : suggested,
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
    const name = target!.split(/[\/]/).pop()!;
    useTabs.getState().updateTab(tabId, { path: target!, name, dirty: false });
    api.addRecent(target!);
    toast(`Saved ${name}`, 'success');
    return true;
  } catch (err: any) {
    console.error(err);
    toast(`Could not save: ${err?.message || err}`, 'error');
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
    toast(`Exported ${chosen.split(/[\/]/).pop()}`, 'success');
    return true;
  } catch (err: any) {
    toast(`Export failed: ${err?.message || err}`, 'error');
    return false;
  }
}
