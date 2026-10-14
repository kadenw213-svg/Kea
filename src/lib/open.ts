import { api, FileEntry } from './api';
import { kindFor, extOf, UNSUPPORTED_HINT, OPEN_FILTERS } from './fileTypes';
import { useTabs, toast, ask } from '../store';
import type { EditorKind } from './fileTypes';
import { isGoogleShortcut, openGoogleShortcut } from './google';

export async function openEntry(entry: FileEntry) {
  const { tabs, setActive, addTab } = useTabs.getState();
  const existing = tabs.find((t) => t.path && t.path.toLowerCase() === entry.path.toLowerCase());
  if (existing) {
    setActive(existing.id);
    return;
  }
  const kind = kindFor(entry.name, entry.data);
  if (kind === 'unsupported') {
    const ext = extOf(entry.name);
    const hint = UNSUPPORTED_HINT[ext];
    const choice = await ask(
      `Can't open ${entry.name}`,
      hint || `.${ext || 'unknown'} files aren't supported. You can still try opening it as plain text.`,
      hint
        ? [{ id: 'ok', label: 'OK', primary: true }]
        : [
            { id: 'cancel', label: 'Cancel' },
            { id: 'text', label: 'Open as text', primary: true }
          ]
    );
    if (choice !== 'text') return;
    addTab({ kind: 'code', name: entry.name, path: entry.path, data: entry.data });
  } else {
    addTab({ kind, name: entry.name, path: entry.path, data: entry.data });
  }
  if (entry.path) api.addRecent(entry.path);
}

export async function openPaths(paths: string[]) {
  for (const p of paths) {
    if (isGoogleShortcut(p)) {
      await openGoogleShortcut(p);
      continue;
    }
    try {
      await openEntry(await api.readFile(p));
    } catch (err: any) {
      toast(`Couldn't open ${p.split(/[\\/]/).pop()}: ${err?.message || 'file not found'}`, 'error');
      api.removeRecent(p);
    }
  }
}

export async function openWithDialog() {
  const files = await api.openDialog({ title: 'Open file', multi: true, filters: OPEN_FILTERS });
  for (const f of files) await openEntry(f);
}

let untitledCounter = 1;
export function newFile(kind: EditorKind) {
  const names: Record<string, string> = {
    doc: 'Untitled document',
    sheet: 'Untitled spreadsheet',
    slides: 'Untitled presentation',
    code: 'Untitled',
    pdf: 'Untitled'
  };
  const n = untitledCounter++;
  let name = n === 1 ? names[kind] : `${names[kind]} ${n}`;
  if (kind === 'code') name += '.txt';
  useTabs.getState().addTab({ kind, name, path: null, data: null });
}
