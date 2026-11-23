import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { ClipboardList, RefreshCw, ChevronDown, X, Sparkles, ListChecks, Square, MessageSquare, FileText, ListOrdered, Library, SendHorizontal, MoreHorizontal, Check, Gauge, Replace } from 'lucide-react';
import { MenuButton } from '../Popover';
import { useSetting } from '../../lib/settings';
import { useAssignments, fileKey, assignmentSig, type AssignmentRef } from '../../lib/assignmentContext';
import { linkAssignment } from '../../lib/assignmentLink';
import { useGrades, estimateGrade, stopGrade, gradingInfo, hasRubric, claudeReady, currentHash } from '../../lib/gradeRun';
import { gradeKey, readCached, checkedAgo, type GradeEstimate } from '../../lib/gradeEstimate';
import { ask } from '../../lib/assistant';
import { useAssistant, setAssistantOpen, chatOf } from './assistantStore';
import { AssignmentPicker } from './AssignmentPicker';
import { toast } from '../../store';
import { api } from '../../lib/api';
import { useKeaModes } from '../../lib/modes';
import { AssignmentChecklist } from './AssignmentChecklist';
import '../../styles/assistant.css';

/** Which tab's assignment picker is open from its editor (the File menu's "For an assignment…"). */
const usePicker = create<{ tabId: string | null }>(() => ({ tabId: null }));
export const openAssignmentPicker = (tabId: string) => usePicker.setState({ tabId });

/** Whether Claude leaves pointer comments in the margin when it checks the file (on unless turned off; remembered per file). */
const pointersKey = (tabId: string) => `kea.assistant.pointers.${fileKey(tabId)}`;
export function pointerComments(tabId: string): boolean {
  try {
    return localStorage.getItem(pointersKey(tabId)) !== 'off';
  } catch {
    return true;
  }
}
const setPointerComments = (tabId: string, on: boolean) => {
  try {
    localStorage.setItem(pointersKey(tabId), on ? 'on' : 'off');
  } catch {}
};

/**
 * Ask Claude (in the Claude tab) to go through the file against the assignment. With pointer comments on it leaves
 * short margin comments that point at what to change to meet the rubric; off, it answers in the chat only and leaves
 * the document untouched.
 */
export function checkAgainstRubric(tabId: string, rubric: boolean, comments: boolean = pointerComments(tabId)) {
  if (chatOf(tabId).busy) return toast('Claude is still working on this file. Try again when it’s done.');
  setAssistantOpen(true);
  const what = rubric ? 'my assignment’s rubric' : 'my assignment’s instructions';
  ask(tabId, comments ? `Review this against ${what}` : `Review this against ${what}. Don’t leave margin comments or change the document: answer in the chat with the estimated level for each criterion and the top fixes.`, { quiet: true });
}

/** Ask Claude to gather everything the assignment says to do into one clearly marked section at the top of the file. */
export function gatherInstructions(tabId: string) {
  if (chatOf(tabId).busy) return toast('Claude is still working on this file. Try again when it’s done.');
  setAssistantOpen(true);
  ask(tabId, 'Put this assignment’s instructions at the top of this document as one section headed “Instructions (delete when finished)”: the steps, what to hand in, the requirements (length, sources, format) and how it’s graded, from the assignment above, with nothing invented. Don’t change anything else in the document.', { quiet: true });
}

/**
 * One-click writing suggestions (the document toolbar's Suggestions button): spelling, grammar, punctuation, clarity
 * and wordiness across the whole document, each as a margin comment anchored to its passage with a one-click fix.
 * Nothing in the text changes until the student applies a fix. Runs on the standard model: quick and thorough.
 */
export function writingSuggestions(tabId: string) {
  if (chatOf(tabId).busy) return toast('Claude is still working on this file. Try again when it’s done.');
  setAssistantOpen(true, tabId);
  ask(
    tabId,
    'Give me writing suggestions for the whole document, like a proofreader: every spelling, grammar and punctuation mistake, plus sentences that are unclear, wordy or awkward. Leave each one as its own margin comment (add_comments) anchored to exactly that passage, with kind fix for errors and consider for style, a one-sentence reason, and a rewrite of exactly that passage so I can fix it in one click. Don’t change the document yourself, don’t comment on ideas or structure, and don’t leave more than 30. Then tell me in one line how many you found of each kind.',
    { tier: 'standard', quiet: true }
  );
}

/**
 * The pre-submit check (assignment bar): one final pass against the rubric and every requirement (length, format,
 * citations, what to hand in) before the student turns it in, with an estimated score per criterion.
 */
export function preSubmitCheck(tabId: string) {
  if (chatOf(tabId).busy) return toast('Claude is still working on this file. Try again when it’s done.');
  setAssistantOpen(true, tabId);
  ask(
    tabId,
    'Do a final check before I submit this. Go through every requirement in the assignment (length, format, citation style and Works Cited, required sections and sources, what to hand in) and say for each one whether it’s met, with a ✓ or ✗. Then give an honest estimated score for each rubric criterion against its top level, and the fixes that would gain the most points, in order. Answer in the chat only: don’t change the document or leave comments.',
    { tier: 'deep', quiet: true }
  );
}

/** Ask Claude for an outline of questions to answer, so the thinking and the thesis stay the student’s. */
export function outlineHelp(tabId: string) {
  if (chatOf(tabId).busy) return toast('Claude is still working on this file. Try again when it’s done.');
  setAssistantOpen(true);
  ask(tabId, 'Help me outline this assignment. Don’t write any of my paper. Give me an outline where every part is a question for me to answer (for the intro, each main point, the evidence for it, and the conclusion), based on what the assignment and rubric ask for. Put it in the chat, and ask if I want it inserted in the document.', { quiet: true });
}

/**
 * The assignment bar, the one place for assignment-aware Claude features in Docs and Slides: what the file is for,
 * the estimated grade (Refresh, and how it was worked out), the checklist and Check my work. Shown only on a file linked to
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
  const [pointers, setPointers] = useState(() => pointerComments(tabId));
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
  const togglePointers = () => {
    setPointers(!pointers);
    setPointerComments(tabId, !pointers);
  };
  const against = rubric === false ? 'instructions' : 'rubric';

  // One quiet line: what it's for, the estimated grade, the checklist, then one main action and a menu for the rest.
  // The grade's breakdown and the checklist open as small cards under their chip instead of taking the page's width.
  return (
    <div className="assignment-bar" role="region" aria-label="Assignment">
      <MenuButton
        title="This file's assignment"
        button={(o) => (
          <button className={`ab-chip ab-for ${o ? 'open' : ''}`}>
            <ClipboardList size={14} />
            <span className="ab-label">{assignment.label}</span>
            <ChevronDown size={12} className="ab-caret" />
          </button>
        )}
      >
        {(close) => (
          <>
            <div className="menu-title">For this assignment</div>
            <button className="menu-item" onClick={() => (close(), onChange())}>
              <Replace size={16} /> Change assignment…
            </button>
            <button className="menu-item" disabled={chatBusy} title="Gathers everything the assignment says to do into one section at the top of this document" onClick={() => (close(), gatherInstructions(tabId))}>
              <FileText size={16} /> Put the instructions in the document
            </button>
            <div className="menu-sep" />
            <button className="menu-item" onClick={() => (close(), linkAssignment(tabId, null))}>
              <X size={16} /> Not for an assignment
            </button>
          </>
        )}
      </MenuButton>

      {grades &&
        (ready === false ? (
          <button className="ab-chip" title="Estimates run on your own Claude" onClick={() => setAssistantOpen(true)}>
            <Sparkles size={13} /> Connect Claude
          </button>
        ) : running ? (
          <span className="ab-chip busy">
            <span className="dot-pulse" /> Estimating…
            <button className="ab-chip-x" title="Stop" onClick={() => stopGrade(tabId)}>
              <Square size={10} />
            </button>
          </span>
        ) : result ? (
          <MenuButton
            title="Estimated grade: how it was worked out"
            button={(o) => (
              <button className={`ab-chip ab-grade ${o ? 'open' : ''}`}>
                <span className="ab-letter">{result.letter}</span>
                <span className="ab-pct">{result.percent}%</span>
                {changed && <span className="ab-stale" title="The file changed since this estimate" />}
                <ChevronDown size={12} className="ab-caret" />
              </button>
            )}
          >
            {() => (
              <div className="ab-card ab-how">
                <div className="ab-card-head">
                  <div>
                    <div className="ab-card-title">
                      Estimated grade <b>{result.letter}</b> · {result.percent}%
                    </div>
                    <div className="ab-card-sub">
                      {result.rough ? 'Rough estimate from the instructions' : 'From the rubric'} · checked {checkedAgo(result.at)}
                      {changed ? ' · the file changed since' : ''}
                    </div>
                  </div>
                  <button className="btn sm" onClick={refresh}>
                    <RefreshCw size={13} /> Estimate again
                  </button>
                </div>
                <div className="ab-rows">
                  {result.rows.map((r, i) => (
                    <div className="ab-crow" key={i}>
                      <div className="ab-crow-top">
                        <span className="ab-crit">{r.criterion}</span>
                        <span className="ab-pts">
                          {fmt(r.earned)} / {fmt(r.possible)}
                        </span>
                      </div>
                      <div className="ab-meter" aria-hidden>
                        <span style={{ width: `${r.possible ? Math.min(100, (r.earned / r.possible) * 100) : 0}%` }} />
                      </div>
                      {r.reason && <div className="ab-why">{r.reason}</div>}
                    </div>
                  ))}
                </div>
                <div className="ab-note">An estimate from Claude, not a grade. Your teacher decides.</div>
              </div>
            )}
          </MenuButton>
        ) : rubric || (rubric === false && roughOk) ? (
          <button
            className={`ab-chip ${error ? 'warn' : ''}`}
            title={error ? `Couldn’t estimate: ${error}` : rubric ? 'Claude estimates a grade against the rubric' : 'There’s no rubric, so this is a rough guess from the instructions'}
            onClick={() => estimateGrade(tabId, rubric ? undefined : { rough: true })}
          >
            <Gauge size={13} /> {error ? 'Try the estimate again' : 'Estimate grade'}
          </button>
        ) : null)}

      <AssignmentChecklist tabId={tabId} file={fileKey(tabId)} assignment={assignment} active={active} />

      <span className="ab-grow" />

      <button className="ab-main" disabled={chatBusy} title={`Claude goes through your file against the ${against}` + (pointers ? ' and leaves comments in the margin' : ' and answers in the chat')} onClick={() => checkAgainstRubric(tabId, rubric !== false, pointers)}>
        <ListChecks size={14} /> Check my work
      </button>
      <MenuButton
        align="right"
        title="More for this assignment"
        button={(o) => (
          <button className={`ab-more ${o ? 'open' : ''}`} aria-label="More for this assignment">
            <MoreHorizontal size={16} />
          </button>
        )}
      >
        {(close) => (
          <>
            <button className="menu-item" disabled={chatBusy} title="Every requirement (length, format, citations) checked, and an estimated score for each part of the rubric" onClick={() => (close(), preSubmitCheck(tabId))}>
              <SendHorizontal size={16} /> Final check before I submit
            </button>
            <button className="menu-item" disabled={chatBusy} title="An outline made of questions for you to answer. Claude doesn’t write your paper" onClick={() => (close(), outlineHelp(tabId))}>
              <ListOrdered size={16} /> Help me outline
            </button>
            <button className="menu-item" onClick={() => (close(), api.library.open().catch((err: any) => toast(err?.message || 'Couldn’t open the library.', 'error')))}>
              <Library size={16} /> Find sources in my library
            </button>
            <div className="menu-sep" />
            <button className={`menu-item ${pointers ? 'checked' : ''}`} role="menuitemcheckbox" aria-checked={pointers} title="When on, Check my work leaves short comments in the margin. When off, it answers in the chat only." onClick={togglePointers}>
              <MessageSquare size={16} /> <span className="menu-grow">Leave comments in the margin</span>
              {pointers && <Check size={14} />}
            </button>
          </>
        )}
      </MenuButton>
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
