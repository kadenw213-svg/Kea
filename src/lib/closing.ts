import { useTabs, editorRegistry, ask } from '../store';
import { api } from './api';

/** Close a tab, offering to save unsaved changes first. Resolves false if the user cancelled. */
export async function requestCloseTab(id: string): Promise<boolean> {
  const tab = useTabs.getState().tabs.find((t) => t.id === id);
  if (!tab || tab.kind === 'home') return true;
  if (tab.dirty) {
    useTabs.getState().setActive(id);
    const choice = await ask(`Save changes to ${tab.name}?`, 'Your changes will be lost if you close without saving.', [
      { id: 'discard', label: "Don't save", danger: true },
      { id: 'cancel', label: 'Cancel' },
      { id: 'save', label: 'Save', primary: true }
    ]);
    if (choice === 'cancel') return false;
    if (choice === 'save') {
      const ok = await editorRegistry.get(id)?.save(false);
      if (!ok) return false;
    }
  }
  useTabs.getState().closeTab(id);
  return true;
}

export async function requestQuit() {
  const dirty = useTabs.getState().tabs.filter((t) => t.dirty);
  for (const t of dirty) {
    if (!(await requestCloseTab(t.id))) return;
  }
  api.confirmClose();
}
