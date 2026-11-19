import { useEffect, useMemo, useState } from 'react';
import { CheckSquare, Square, ChevronDown, ChevronUp } from 'lucide-react';
import { assignmentText, type AssignmentRef } from '../../lib/assignmentContext';
import { requirementsFrom, check, type DocPart, type Req } from '../../lib/assignmentChecklist';
import { editorRegistry } from '../../store';

const MIN_KEY = 'kea.assistant.checklistMin';
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
 * Kea as you write; the rest are boxes you tick. It folds down to one line ("3 of 5") and remembers that.
 */
export function AssignmentChecklist({ tabId, file, assignment, active }: { tabId: string; file: string; assignment: AssignmentRef; active: boolean }) {
  const [reqs, setReqs] = useState<Req[]>([]);
  const [parts, setParts] = useState<DocPart[]>([]);
  const [ticks, setTicks] = useState<Record<string, boolean>>(() => readJson(ticksKey(file), {}));
  const [min, setMin] = useState<boolean>(() => readJson(MIN_KEY, false));
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
  const toggle = (id: string) => {
    const next = { ...ticks, [id]: !ticks[id] };
    setTicks(next);
    writeJson(ticksKey(file), next);
  };
  const fold = () => {
    setMin(!min);
    writeJson(MIN_KEY, !min);
  };

  return (
    <div className={`ab-check ${min ? 'min' : ''}`} role="region" aria-label="Assignment checklist">
      <button className="ab-check-head" onClick={fold} aria-expanded={!min} title={min ? 'Show the checklist' : 'Fold the checklist'}>
        <CheckSquare size={14} /> <b>Checklist</b>
        <span className="ab-check-count">
          {doneCount} of {rows.length}
        </span>
        <span className="ab-check-bar" aria-hidden>
          <span style={{ width: `${(doneCount / rows.length) * 100}%` }} />
        </span>
        {min ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
      </button>
      {!min && (
        <ul className="ab-check-list">
          {rows.map(({ r, auto, done }) => (
            <li key={r.id} className={done ? 'done' : ''}>
              {auto ? (
                <span className="ab-check-box" aria-hidden>
                  {done ? <CheckSquare size={14} /> : <Square size={14} />}
                </span>
              ) : (
                <button className="ab-check-box" onClick={() => toggle(r.id)} aria-pressed={done} title={done ? 'Untick' : 'Tick when it’s done'}>
                  {done ? <CheckSquare size={14} /> : <Square size={14} />}
                </button>
              )}
              <span className="ab-check-text">{r.text}</span>
              {auto && <span className="ab-check-detail">{auto.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
