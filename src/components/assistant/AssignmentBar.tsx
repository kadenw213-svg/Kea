import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { ClipboardList, RefreshCw, ChevronDown, ChevronUp, X, Sparkles, ListChecks, Square } from 'lucide-react';
import { useSetting } from '../../lib/settings';
import { useAssignments, fileKey, assignmentSig, type AssignmentRef } from '../../lib/assignmentContext';
import { linkAssignment } from '../../lib/assignmentLink';
import { useGrades, estimateGrade, stopGrade, gradingInfo, hasRubric, claudeReady, currentHash } from '../../lib/gradeRun';
import { gradeKey, readCached, checkedAgo, type GradeEstimate } from '../../lib/gradeEstimate';
import { ask } from '../../lib/assistant';
import { useAssistant, setAssistantOpen, chatOf } from './assistantStore';
import { AssignmentPicker } from './AssignmentPicker';
import { toast } from '../../store';
import { useKeaModes } from '../../lib/modes';
import '../../styles/assistant.css';

/** Which tab's assignment picker is open from its editor (the File menu's "For an assignment…"). */
const usePicker = create<{ tabId: string | null }>(() => ({ tabId: null }));
export const openAssignmentPicker = (tabId: string) => usePicker.setState({ tabId });

/** Ask Claude (in the Claude tab) to go through the file against the assignment, leaving margin comments. */
export function checkAgainstRubric(tabId: string, rubric: boolean) {
  if (chatOf(tabId).busy) return toast('Claude is still working on this file. Try again when it’s done.');
  setAssistantOpen(true);
  ask(tabId, rubric ? 'Review this against my assignment’s rubric' : 'Review this against my assignment’s instructions');
}

/**
 * The assignment bar, the one place for assignment-aware Claude features in Docs and Slides: what the file is for,
 * the estimated grade (Refresh, and how it was worked out), and Check against rubric. Shown only on a file linked to
 * an assignment; nothing at all otherwise (the link is made from the file's menu or the Claude tab).
 */
export function AssignmentBar({ tabId, active }: { tabId: string; active: boolean }) {
  const ref = useAssignments((s) => s.byFile[fileKey(tabId)] || null);
  const show = useSetting<boolean>('assistant.assignmentBar') !== false;
  const picking = usePicker((s) => s.tabId === tabId);
  const close = () => usePicker.setState({ tabId: null });
  if (!(ref && show) && !picking) return null;
  return (
    <div className="ab-wrap">
      {ref && show && <Bar tabId={tabId} active={active} assignment={ref} onChange={() => openAssignmentPicker(tabId)} />}
      {picking && (
        <div className="ab-picker-pop">
          <AssignmentPicker tabId={tabId} onClose={close} />
        </div>
      )}
    </div>
  );
}

function Bar({ tabId, active, assignment, onChange }: { tabId: string; active: boolean; assignment: AssignmentRef; onChange(): void }) {
  const sig = assignmentSig(assignment);
  const key = gradeKey(fileKey(tabId), sig);
  const result: GradeEstimate | null = useGrades((s) => readCached(s.byKey[key], sig));
  const running = useGrades((s) => !!s.running[key]);
  const error = useGrades((s) => s.error[key]);
  const chatBusy = useAssistant((s) => !!s.chats[tabId]?.busy);
  const grades = useSetting<boolean>('assistant.gradeEstimate') !== false;
  const roughOk = useSetting<boolean>('assistant.gradeFromInstructions') !== false;
  const autoFirst = useSetting<boolean>('assistant.gradeAutoFirst') === true;
  const [open, setOpen] = useState(false);
  // What Kea knows: whether the assignment has a rubric, and whether Claude is connected (null while finding out).
  const [rubric, setRubric] = useState<boolean | null>(null);
  const [ready, setReady] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    setRubric(null);
    gradingInfo(assignment)
      .then((g) => live && setRubric(hasRubric(g)))
      .catch(() => live && setRubric(false));
    return () => {
      live = false;
    };
  }, [sig]);
  useEffect(() => {
    if (!active || !grades) return;
    let live = true;
    claudeReady().then((r) => live && setReady(r));
    return () => {
      live = false;
    };
  }, [active, grades, sig]);
  // Has the file changed since it was checked? (Looked at every few seconds while the file is on screen.)
  const [hash, setHash] = useState<string | null>(null);
  useEffect(() => {
    if (!active || !result) return;
    let live = true;
    const look = () => currentHash(tabId).then((h) => live && setHash(h));
    look();
    const t = setInterval(look, 4000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [active, !!result, result?.at, tabId]);
  // Once, the first time the bar appears for this file and assignment, when that's turned on (Advanced).
  const autoTried = useRef(false);
  useEffect(() => {
    if (!autoFirst || autoTried.current || !active || !grades || result || running || ready !== true || rubric === null) return;
    autoTried.current = true;
    const done = (() => {
      try {
        const all = JSON.parse(localStorage.getItem(AUTO_KEY) || '[]') as string[];
        if (all.includes(key)) return true;
        localStorage.setItem(AUTO_KEY, JSON.stringify([...all, key].slice(-300)));
      } catch {}
      return false;
    })();
    if (!done && (rubric || roughOk)) estimateGrade(tabId, { rough: !rubric });
  }, [autoFirst, active, grades, result, running, ready, rubric]);

  const changed = !!result && !!hash && hash !== result.docHash;
  const refresh = () => estimateGrade(tabId, { rough: result ? result.rough : !rubric });

  return (
    <div className="assignment-bar" role="region" aria-label="Assignment">
      <div className="ab-row">
        <button className="ab-for" title="Change which assignment this is for" onClick={onChange}>
          <ClipboardList size={14} />
          <span className="ab-label">{assignment.label}</span>
        </button>
        {grades && (
          <div className="ab-grade">
            {ready === false ? (
              <button className="ab-link" title="Estimates run on your own Claude" onClick={() => setAssistantOpen(true)}>
                <Sparkles size={13} /> Connect Claude to estimate a grade
              </button>
            ) : running ? (
              <span className="ab-status">
                <span className="dot-pulse" /> Estimating…
                <button className="icon-btn sm" title="Stop" onClick={() => stopGrade(tabId)}>
                  <Square size={11} />
                </button>
              </span>
            ) : result ? (
              <>
                <span className="ab-score" title="An estimate from Claude, not a grade. Your teacher decides the grade.">
                  Estimated grade: <b>{result.letter}</b> ({result.percent}%)
                </span>
                <span className={`ab-tag ${result.rough ? 'rough' : ''}`}>{result.rough ? 'Rough draft estimate' : 'Draft estimate'}</span>
                <span className="ab-meta">
                  Checked {checkedAgo(result.at)}
                  {changed ? ' · changed since' : ''}
                </span>
                <button className="icon-btn sm" title="Estimate again" onClick={refresh}>
                  <RefreshCw size={13} />
                </button>
                <button className="ab-link" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
                  How {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                </button>
              </>
            ) : rubric ? (
              <button className="ab-link" onClick={() => estimateGrade(tabId)}>
                <RefreshCw size={13} /> Estimate my grade
              </button>
            ) : rubric === false && roughOk ? (
              <button className="ab-link" title="There’s no rubric, so this is a rough guess from the instructions" onClick={() => estimateGrade(tabId, { rough: true })}>
                <RefreshCw size={13} /> Estimate from the assignment instructions (rough)
              </button>
            ) : null}
            {error && !running && <span className="ab-error" title={error}>Couldn’t estimate: {error}</span>}
          </div>
        )}
        <span className="ab-grow" />
        <button className="ab-link" disabled={chatBusy} title={rubric === false ? 'Claude goes through your file against the instructions and leaves comments' : 'Claude goes through your file against the rubric and leaves comments'} onClick={() => checkAgainstRubric(tabId, rubric !== false)}>
          <ListChecks size={14} /> {rubric === false ? 'Check against instructions' : 'Check against rubric'}
        </button>
        <button className="icon-btn sm" title="Not for an assignment" onClick={() => linkAssignment(tabId, null)}>
          <X size={13} />
        </button>
      </div>
      {open && result && (
        <div className="ab-how">
          <table>
            <tbody>
              {result.rows.map((r, i) => (
                <tr key={i}>
                  <td className="ab-crit">{r.criterion}</td>
                  <td className="ab-pts">
                    {fmt(r.earned)} / {fmt(r.possible)}
                  </td>
                  <td className="ab-why">{r.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="ab-note">
            {fmt(result.earned)} of {fmt(result.possible)} points. {result.rough ? 'There’s no rubric, so this is a rough guess from the instructions. ' : ''}An estimate from Claude, not a grade: a draft for you to review, and your teacher decides.
          </div>
        </div>
      )}
    </div>
  );
}

const AUTO_KEY = 'kea.assistant.gradeAuto';
const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** The file menu's entry for linking the file to an assignment (only where classes are in use, or it's linked). */
export function AssignmentMenuItem({ tabId, close }: { tabId: string; close(): void }) {
  const modes = useKeaModes();
  const linked = useAssignments((s) => !!s.byFile[fileKey(tabId)]);
  if (!(modes.school || modes.personal || linked)) return null;
  return (
    <button className="menu-item" onClick={() => (close(), openAssignmentPicker(tabId))}>
      <ClipboardList size={16} /> {linked ? 'Change assignment…' : 'For an assignment…'}
    </button>
  );
}
