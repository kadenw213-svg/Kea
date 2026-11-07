// Word, Excel and PowerPoint files can hold things Kea can't keep yet (charts, SmartArt, text boxes, pivot tables…).
// Saving such a file over itself drops them, so autosave leaves it alone and Save asks once, offering a copy.
import { useEffect, useRef } from 'react';
import { ask } from '../store';
import type { Tab } from '../store';
import { baseName } from './fileTypes';
import { isSilentSave } from './save';
import { officeLosses, listWords } from './officeLossScan';

/**
 * For an editor of Word, Excel or PowerPoint files: scans the file when it opens, holds autosave while saving over
 * it would drop something, and asks once on Save (keep the original, save a copy).
 */
export function useOfficeLossGuard(tab: Tab) {
  const g = useRef({ losses: [] as string[], accepted: false, path: tab.path });
  useEffect(() => {
    let live = true;
    g.current = { losses: [], accepted: false, path: tab.path };
    if (tab.path) officeLosses(tab.path, tab.data).then((l) => live && (g.current.losses = l));
    return () => {
      live = false;
    };
    // Only the file as opened matters; saving elsewhere (Save as) accepts the change below.
  }, [tab.id, tab.version]);
  return {
    /** Why autosave must wait, or null. */
    holdReason(): string | null {
      const s = g.current;
      return s.losses.length && !s.accepted && tab.path === s.path ? `Autosave paused: Kea can’t keep this file’s ${listWords(s.losses)}.` : null;
    },
    /** Before saving over the original: 'save' (go ahead), 'copy' (save as a new file instead) or 'cancel'. */
    async confirm(saveAs: boolean, name: string): Promise<'save' | 'copy' | 'cancel'> {
      const s = g.current;
      if (!s.losses.length || s.accepted) return 'save';
      if (saveAs) {
        s.accepted = true;
        return 'save';
      }
      const choice = await ask(`Save over ${name}?`, `Kea can’t keep its ${listWords(s.losses)}. Save a copy to leave the original as it is.`, [
        { id: 'cancel', label: 'Cancel' },
        { id: 'save', label: 'Save over it', danger: true },
        { id: 'copy', label: 'Save a copy…', primary: true }
      ]);
      if (choice === 'save' || choice === 'copy') s.accepted = choice === 'save';
      return choice === 'save' || choice === 'copy' ? choice : 'cancel';
    },
    /** A copy was saved: the tab now holds Kea's own file, so later saves don't ask. */
    accept() {
      g.current.accepted = true;
    },
    /** Run an editor's save with this guard: autosave holds, an explicit Save asks once. */
    async save(saveAs: boolean, run: (saveAs: boolean, opts?: { suggestedName?: string }) => Promise<boolean>): Promise<boolean> {
      if (isSilentSave()) return this.holdReason() ? false : run(saveAs);
      const c = await this.confirm(saveAs, tab.name);
      if (c === 'cancel') return false;
      const ok = await run(saveAs || c === 'copy', c === 'copy' ? { suggestedName: `${baseName(tab.name)} copy` } : undefined);
      if (ok && c === 'copy') this.accept();
      return ok;
    }
  };
}
