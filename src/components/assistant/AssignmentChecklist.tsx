import { useEffect, useMemo, useState } from 'react';
import { CheckSquare, Square, ChevronDown, CheckCircle2, Circle } from 'lucide-react';
import { MenuButton } from '../Popover';
import { assignmentText, type AssignmentRef } from '../../lib/assignmentContext';
import { requirementsFrom, check, type DocPart, type Req } from '../../lib/assignmentChecklist';
import { editorRegistry } from '../../store';

const ticksKey = (file: string) => `kea.assistant.ticks.${file}`;
const readJson = <T,>(key: string, fallback: T): T => {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback;
  } catch {
    return fallback;
  }
};
const writeJson = (key: string, v: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {}
};

/**
 * What the assignment asks for, as a short list beside the work: length, number of sources and format are checked by
 * Kea as you write; the rest are boxes you tick. A chip in the assignment bar ("3/5 done") opens it as a small card.
 */
export function AssignmentChecklist({ tabId, file, assignment, active }: { tabId: string; file: string; assignment: AssignmentRef; active: boolean }) {
  const [reqs, setReqs] = useState<Req[]>([]);
  const [parts, setParts] = useState<DocPart[]>([]);
  const [ticks, setTicks] = useState<Record<string, boolean>>(() => readJson(ticksKey(file), {}));
  const sig = 'id' in assignment ? assignment.id : assignment.pasted.slice(0, 80);

  useEffect(() => {
    let live = true;
    assignmentText(assignment)
      .then((t) => live && setReqs(requirementsFrom(t)))
      .catch(() => live && setReqs([]));
    return () => {
      live = false;
    };
  }, [sig]);
  useEffect(() => setTicks(readJson(ticksKey(file), {})), [file]);

  // The file's text, looked at every few seconds while it's on screen.
  useEffect(() => {
    if (!active || !reqs.length) return;
    let live = true;
    const look = async () => {
      const d = await editorRegistry.get(tabId)?.ai?.getDocument().catch(() => null);
      if (live && d) setParts((d.sections || []).map((s: any) => ({ label: s.label, text: s.text })));
    };
    look();
    const t = setInterval(look, 4000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [active, tabId, reqs.length]);

  const rows = useMemo(
    () =>
      reqs.map((r) => {
        const auto = check(r, parts);
        return { r, auto, done: auto ? auto.done : !!ticks[r.id] };
      }),
    [reqs, parts, ticks]
  );
  if (!reqs.length) return null;
  const doneCount = rows.filter((x) => x.done).length;
  const all = doneCount === rows.length;
  const toggle = (id: string) => {
    const next = { ...ticks, [id]: !ticks[id] };
    setTicks(next);
    writeJson(ticksKey(file), next);
  };
  // A small ring that fills as the requirements are met.
  const R = 6;
  const C = 2 * Math.PI * R;

  return (
    <MenuButton
      title="What the assignment asks for"
      button={(o) => (
        <button className={`ab-chip ab-check-chip ${all ? 'all' : ''} ${o ? 'open' : ''}`}>
          <svg width="16" height="16" viewBox="0 0 16 16" className="ab-ring" aria-hidden>
            <circle cx="8" cy="8" r={R} className="ab-ring-bg" />
            <circle cx="8" cy="8" r={R} className="ab-ring-fg" strokeDasharray={C} strokeDashoffset={C * (1 - doneCount / rows.length)} />
          </svg>
          <span>
            {doneCount}/{rows.length}
          </span>
          <span className="ab-chip-word">done</span>
          <ChevronDown size={12} className="ab-caret" />
        </button>
      )}
    >
      {() => (
        <div className="ab-card ab-check" role="region" aria-label="Assignment checklist">
          <div className="ab-card-head">
            <div>
              <div className="ab-card-title">Checklist</div>
              <div className="ab-card-sub">{all ? 'Everything the assignment asks for is done.' : `${doneCount} of ${rows.length} done. Kea checks length, sources and format as you write.`}</div>
            </div>
          </div>
          <ul className="ab-check-list">
            {rows.map(({ r, auto, done }) => (
              <li key={r.id} className={done ? 'done' : ''}>
                {auto ? (
                  <span className="ab-check-box auto" title="Kea checks this one as you write" aria-hidden>
                    {done ? <CheckCircle2 size={16} /> : <Circle size={16} />}
                  </span>
                ) : (
                  <button className="ab-check-box" onClick={() => toggle(r.id)} aria-pressed={done} title={done ? 'Untick' : 'Tick when it’s done'}>
                    {done ? <CheckSquare size={16} /> : <Square size={16} />}
                  </button>
                )}
                <span className="ab-check-text">{r.text}</span>
                {auto && <span className="ab-check-detail">{auto.detail}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </MenuButton>
  );
}
