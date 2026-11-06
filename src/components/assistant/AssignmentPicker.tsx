import { useEffect, useMemo, useRef, useState } from 'react';
import { ClipboardList, X, Search, ClipboardPaste, BookOpenCheck } from 'lucide-react';
import { api, type AssignmentChoice } from '../../lib/api';
import { assignmentOf, setAssignment, useAssignments, fileKey } from '../../lib/assignmentContext';

const dateText = (a: AssignmentChoice) => new Date(`${a.date}T12:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** The composer's button: choose which assignment this file is for, or paste its rubric. */
export function AssignmentButton({ tabId, onOpen }: { tabId: string; onOpen: () => void }) {
  const ref = useAssignments((s) => s.byFile[fileKey(tabId)]);
  return (
    <button className={`icon-btn sm ${ref ? 'on' : ''}`} title={ref ? `For: ${ref.label} (change)` : 'Which assignment is this for? Choose one from your classes or paste its rubric'} onClick={onOpen}>
      <ClipboardList size={16} />
    </button>
  );
}

/** The chosen assignment, shown above the composer. */
export function AssignmentChip({ tabId, onOpen }: { tabId: string; onOpen: () => void }) {
  const ref = useAssignments((s) => s.byFile[fileKey(tabId)]);
  if (!ref) return null;
  return (
    <div className="as-assignment">
      <button className="as-assignment-main" title="Claude works against this assignment's guidelines and rubric (click to change)" onClick={onOpen}>
        <ClipboardList size={14} />
        <span>
          For: <b>{ref.label}</b>
        </span>
      </button>
      <button className="icon-btn sm" title="Not for an assignment" onClick={() => setAssignment(tabId, null)}>
        <X size={12} />
      </button>
    </div>
  );
}

/** Choose an assignment (from Kea Scholar) or paste a rubric. */
export function AssignmentPicker({ tabId, onClose }: { tabId: string; onClose: () => void }) {
  const [list, setList] = useState<AssignmentChoice[] | null>(null);
  const [q, setQ] = useState('');
  const current = assignmentOf(tabId);
  const [pasting, setPasting] = useState(!!current && 'pasted' in current);
  const [paste, setPaste] = useState(current && 'pasted' in current ? current.pasted : '');
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    api.scholar
      .assignments()
      .then(setList)
      .catch(() => setList([]));
  }, []);
  useEffect(() => {
    const down = (e: MouseEvent) => !box.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    setTimeout(() => window.addEventListener('mousedown', down), 0);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', down);
      window.removeEventListener('keydown', key);
    };
  }, [onClose]);
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return (list || []).filter((a) => words.every((w) => `${a.course} ${a.title}`.toLowerCase().includes(w)));
  }, [list, q]);
  const coming = shown.filter((a) => a.date >= today);
  const past = shown.filter((a) => a.date < today);
  const pick = (a: AssignmentChoice) => {
    setAssignment(tabId, { id: a.id, label: `${a.course} · ${a.title}` });
    onClose();
  };
  const row = (a: AssignmentChoice) => (
    <button key={a.id} className={`as-pick-row ${current && 'id' in current && current.id === a.id ? 'on' : ''}`} onClick={() => pick(a)}>
      <span className="as-pick-course">{a.course}</span>
      <span className="as-pick-title">{a.title}</span>
      <span className="as-pick-due">
        {a.guide && <BookOpenCheck size={12} aria-label="Kea has a guide for it" />}
        {dateText(a)}
      </span>
    </button>
  );

  return (
    <div className="as-picker" ref={box}>
      <div className="as-picker-head">
        <b>Which assignment is this for?</b>
        <span className="muted">Claude reads its instructions, rubric and files, and works against them.</span>
      </div>
      {pasting ? (
        <div className="as-paste">
          <textarea autoFocus rows={8} value={paste} placeholder="Paste the rubric, prompt or guidelines here" onChange={(e) => setPaste(e.target.value)} />
          <div className="as-paste-actions">
            <button className="btn sm" onClick={() => setPasting(false)}>
              Back
            </button>
            <button
              className="btn sm primary"
              disabled={paste.trim().length < 20}
              onClick={() => {
                const first = paste.trim().split('\n')[0].slice(0, 50);
                setAssignment(tabId, { pasted: paste.trim(), label: `Pasted rubric (${first}${first.length >= 50 ? '…' : ''})` });
                onClose();
              }}
            >
              Use this
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="as-pick-search">
            <Search size={14} />
            <input autoFocus value={q} placeholder="Search your assignments" onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="as-pick-list">
            {list === null && <div className="muted as-pick-note">Loading…</div>}
            {list !== null && !list.length && <div className="muted as-pick-note">No assignments from your classes on this computer. Paste the rubric instead.</div>}
            {coming.length > 0 && <div className="as-pick-group">Coming up</div>}
            {coming.map(row)}
            {past.length > 0 && <div className="as-pick-group">Past and missing</div>}
            {past.map(row)}
          </div>
          <button className="as-pick-paste" onClick={() => setPasting(true)}>
            <ClipboardPaste size={14} /> Paste a rubric or guidelines instead
          </button>
        </>
      )}
    </div>
  );
}
