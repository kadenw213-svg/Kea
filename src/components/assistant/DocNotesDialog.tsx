// "Notes on this file": the working notes Claude keeps for this file (docNotes.ts), to read, change or clear.
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { NotebookPen, X } from 'lucide-react';
import { notesOf, setNotes, useDocNotes, NOTES_MAX } from '../../lib/docNotes';
import { fileKey } from '../../lib/assignmentContext';

export function DocNotesButton({ tabId }: { tabId: string }) {
  const [open, setOpen] = useState(false);
  const has = useDocNotes((s) => !!s.byFile[fileKey(tabId)]?.text);
  return (
    <>
      <button className={`icon-btn sm ${has ? 'on' : ''}`} title={has ? 'Notes on this file: what Claude keeps for later conversations' : 'Notes on this file (none yet: Claude writes them once something is settled)'} onClick={() => setOpen(true)}>
        <NotebookPen size={15} />
      </button>
      {/* (On the page itself: the panel's glass would clip a dialog drawn inside it.) */}
      {open && createPortal(<DocNotesDialog tabId={tabId} onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

function DocNotesDialog({ tabId, onClose }: { tabId: string; onClose(): void }) {
  const [text, setText] = useState(() => notesOf(tabId));
  const saved = notesOf(tabId);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog dn-dialog" role="dialog" aria-label="Notes on this file">
        <div className="dn-head">
          <b>Notes on this file</b>
          <button className="icon-btn sm" title="Close" onClick={onClose}>
            <X size={15} />
          </button>
        </div>
        <p className="muted small">Claude keeps these short notes so a new conversation about this file starts from what’s already settled: the assignment, the plan, what’s decided and what’s left. Change anything; Claude reads your version next time.</p>
        <textarea className="dn-text" value={text} maxLength={NOTES_MAX} onChange={(e) => setText(e.target.value)} placeholder="Nothing yet. Claude writes these once something about this work is settled, or write your own." rows={14} />
        <div className="dn-foot">
          <span className="muted small">
            {text.length.toLocaleString()} / {NOTES_MAX.toLocaleString()}
          </span>
          <span className="grow" />
          {saved && (
            <button className="btn ghost" onClick={() => (setNotes(tabId, ''), onClose())}>
              Clear
            </button>
          )}
          <button className="btn primary" disabled={text.trim() === saved} onClick={() => (setNotes(tabId, text), onClose())}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
