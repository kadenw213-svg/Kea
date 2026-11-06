import { useTabs, editorRegistry, editSeq, Tab, setDirty, ask } from '../store';
import { api, RecoveryEntry } from './api';
import { setting } from './settings';
import { silently } from './save';
import { extOf, baseName } from './fileTypes';
import { openPaths } from './open';

/**
 * Keeps work safe without the user thinking about it:
 *  - Autosave: files that already live somewhere are saved a few seconds after typing stops.
 *  - Crash recovery: every dirty tab (even never-saved ones) is copied to a hidden folder
 *    every few seconds, and offered back on the next start if Kea didn't close normally.
 *  - Session: remembers open files so Kea can reopen them (Settings → General).
 */

const RECOVERY_EXT: Record<string, string> = { doc: 'docx', sheet: 'xlsx', slides: 'pptx', pdf: 'pdf' };
const recoveryExt = (t: Tab) => RECOVERY_EXT[t.kind] || extOf(t.name) || 'txt';

const autosaveTimers = new Map<string, any>();
const savedSeq = new Map<string, number>(); // edit seq last written to the recovery folder
const inRecovery = new Set<string>();
let recoveryTimer: any = null;

/** Save now if this tab can be saved silently (has a location, no dialog needed). */
export async function autosaveNow(tabId: string): Promise<boolean> {
  const tab = useTabs.getState().tabs.find((t) => t.id === tabId);
  const handle = editorRegistry.get(tabId);
  if (!tab || !tab.dirty || (!tab.path && !tab.remote) || !handle) return false;
  try {
    return await silently(() => handle.save(false));
  } catch {
    return false;
  }
}

function scheduleAutosave(tabId: string) {
  if (!setting('files.autosave')) return;
  clearTimeout(autosaveTimers.get(tabId));
  const delay = Math.max(1, Number(setting('files.autosaveDelay')) || 3) * 1000;
  autosaveTimers.set(
    tabId,
    setTimeout(async () => {
      autosaveTimers.delete(tabId);
      const ok = await autosaveNow(tabId);
      // Couldn't save right now (e.g. mid-edit in a cell): try again shortly.
      const tab = useTabs.getState().tabs.find((t) => t.id === tabId);
      if (!ok && tab?.dirty && (tab.path || tab.remote)) setTimeout(() => scheduleAutosave(tabId), 4000);
    }, delay)
  );
}

async function writeRecovery() {
  if (!setting('files.recovery')) return;
  for (const t of useTabs.getState().tabs) {
    if (!t.dirty || t.kind === 'home') continue;
    const seq = editSeq.get(t.id) || 0;
    if (savedSeq.get(t.id) === seq) continue;
    const handle = editorRegistry.get(t.id);
    if (!handle?.debugBuild) continue;
    try {
      const data = await handle.debugBuild();
      await api.recovery.put({ tabId: t.id, name: t.name, path: t.path, kind: t.kind, ext: recoveryExt(t) }, data);
      savedSeq.set(t.id, seq);
      inRecovery.add(t.id);
    } catch (err) {
      console.warn('recovery copy failed', t.name, err);
    }
  }
}

function dropRecovery(tabId: string) {
  if (!inRecovery.has(tabId)) return;
  inRecovery.delete(tabId);
  savedSeq.delete(tabId);
  api.recovery.drop(tabId);
}

function restartRecoveryTimer() {
  clearInterval(recoveryTimer);
  const every = Math.max(5, Number(setting('files.recoveryInterval')) || 15) * 1000;
  recoveryTimer = setInterval(writeRecovery, every);
}

let sessionTimer: any = null;
function rememberSession(tabs: Tab[]) {
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => {
    api.settings.set({ 'session.tabs': tabs.filter((t) => t.path).map((t) => t.path) });
  }, 1000);
}

export function initAutosave() {
  let prevSeq = new Map(editSeq);
  useTabs.subscribe((s, prev) => {
    // New edits → schedule an autosave for that tab.
    for (const t of s.tabs) {
      const seq = editSeq.get(t.id) || 0;
      if (t.dirty && seq !== (prevSeq.get(t.id) || 0)) scheduleAutosave(t.id);
    }
    prevSeq = new Map(editSeq);
    // Saved or closed → the recovery copy is no longer needed.
    for (const p of prev.tabs) {
      const now = s.tabs.find((t) => t.id === p.id);
      if (!now || !now.dirty) dropRecovery(p.id);
      if (!now) clearTimeout(autosaveTimers.get(p.id));
    }
    if (s.tabs.length !== prev.tabs.length || s.tabs.some((t, i) => t.path !== prev.tabs[i]?.path)) rememberSession(s.tabs);
  });
  restartRecoveryTimer();
  let lastInterval = setting('files.recoveryInterval');
  import('./settings').then(({ useSettings }) =>
    useSettings.subscribe((s) => {
      if (s.values['files.recoveryInterval'] !== lastInterval) {
        lastInterval = s.values['files.recoveryInterval'];
        restartRecoveryTimer();
      }
    })
  );
  // Save everything one last time if the window is about to go away.
  window.addEventListener('beforeunload', () => {
    writeRecovery();
  });
}

/** On start: offer to restore work from a crash, then (optionally) reopen last session's files. */
export async function restoreOnStart(openedFromArgs: boolean) {
  const entries = await api.recovery.list().catch(() => [] as RecoveryEntry[]);
  if (entries.length) {
    const names = entries.map((e) => `• ${e.name}`).join('\n');
    const choice = await ask(
      'Restore unsaved work?',
      `Kea didn't close normally last time. It kept copies of ${entries.length === 1 ? 'this file' : 'these files'}:\n${names}`,
      [
        { id: 'discard', label: 'Discard', danger: true },
        { id: 'later', label: 'Ask me later' },
        { id: 'restore', label: 'Restore', primary: true }
      ]
    );
    if (choice === 'restore') {
      for (const e of entries) {
        try {
          const data = await api.recovery.read(e.tabId);
          // Recovery copies are saved in Kea's own format; keep the original location only if it matches.
          const sameFormat = e.path && extOf(e.path) === e.ext;
          const name = sameFormat || extOf(e.name) === e.ext ? e.name : `${baseName(e.name)}.${e.ext}`;
          const id = useTabs.getState().addTab({ kind: e.kind as any, name, path: sameFormat ? e.path : null, data });
          setTimeout(() => setDirty(id, true), 500);
          await api.recovery.drop(e.tabId);
        } catch (err) {
          console.warn('restore failed', e, err);
        }
      }
    } else if (choice === 'discard') {
      for (const e of entries) await api.recovery.drop(e.tabId);
    }
  }
  if (!openedFromArgs && setting('general.startup') === 'restore') {
    const paths: string[] = (setting('session.tabs') as any) || [];
    const open = new Set(useTabs.getState().tabs.map((t) => t.path?.toLowerCase()));
    const todo = paths.filter((p) => p && !open.has(p.toLowerCase()));
    if (todo.length) {
      const exist = await api.statMany(todo);
      await openPaths(exist.filter((x) => x.exists).map((x) => x.path));
    }
  }
}
