// Study materials: practice exams and flashcard decks. Claude writes a whole set at once, only when the student asks;
// Kea keeps it and shuffles, samples and grades it here, as often as the student likes, with no Claude involved.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, ClipboardList, Layers, Loader2, RotateCcw, Shuffle, Trash2, X, AlertTriangle, Plus, Pencil, ClipboardPaste, Star, Brain, Shapes, FileCheck, Repeat } from 'lucide-react';
import { api, ScholarCourse, ScholarCourseDetail, StudyCard, StudyHistory, StudyKind, StudyQuestion, StudySet, StudySetFull } from '../../lib/api';
import { toast } from '../../store';
import { MenuButton } from '../Popover';
import { useScholar } from './scholarStore';
import { Bar, progressOf, span, useLiveRun, useNow } from './ScansView';
import { ReadingButton, ReadingContext, ReadingPane, ReadingTarget, useMissReading } from './ReadingPane';
import { judgeBlank } from '../../lib/blank';
import { CardTest, Learn, Match, Review, ReviewBanner, SetEditor, SpeakButton, StarButton } from './StudyModes';
import { openStudyHub, parseScope, StudyHub } from './StudyHub';
import '../../styles/study.css';
import { MathText } from './MathText';

// ---------- Shared state ----------
/** Every set, reloaded when Kea says something changed (a set finished) and while one is being made. */
export function useStudySets() {
  const version = useScholar((s) => s.version);
  const [sets, setSets] = useState<StudySet[] | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => api.scholar.studyList().then((s) => live && setSets(s));
    load();
    // (A run reports every step; the sets only change when one starts or ends.)
    let wasRunning: boolean | null = null;
    const offs = [
      api.scholar.onRun((r) => {
        if (r.running !== wasRunning) load();
        wasRunning = r.running;
      }),
      api.scholar.onChanged(load)
    ];
    return () => {
      live = false;
      offs.forEach((f) => f());
    };
  }, [version]);
  return sets;
}

/** Whether new sets can be made: Claude signed in and the engine installed (checked once per session). */
let canMakeCache: Promise<boolean> | null = null;
export function useCanMake() {
  const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => {
    canMakeCache =
      canMakeCache ||
      api.scholar
        .check()
        .then((c) => !!(c.claude && c.account?.loggedIn && c.engineReady))
        .catch(() => false);
    canMakeCache.then(setOk);
  }, []);
  return ok;
}

export const openStudySet = (id: string) => useScholar.getState().set({ study: id });

const SIZES: Record<StudyKind, number[]> = { exam: [25, 50, 100], cards: [30, 60, 100] };
const pct = (f: number | null) => (f == null ? '' : `${Math.round(f * 100)}%`);
const madeOn = (at: string) => new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

type Target = { itemId?: string; chapters?: string[] };
type Mode = 'mix' | 'saved' | 'new';

async function make(kind: StudyKind, courseId: string, count: number, target: Target, mode: Mode = 'mix') {
  try {
    const id = await api.scholar.studyMake({ kind, courseId, count, mode, ...target });
    useScholar.getState().set({ version: useScholar.getState().version + 1 });
    // From saved questions it's ready now: open it.
    if (mode === 'saved') openStudySet(id);
    else toast(`Making your ${kind === 'exam' ? 'practice exam' : 'flashcards'}. It's usually ready in a minute or two.`, 'success');
  } catch (err: any) {
    toast(err.message, 'error');
  }
}

/** Share of a mixed set that's reused (the rest is new): matches the main process. */
const REUSE = 0.6;

/** The menu: a set from saved questions (instant, no Claude), or a new one that reuses some and adds new ones. */
export function MakeMenu({ kind, courseId, target, canMake, close }: { kind: StudyKind; courseId: string; target: Target; canMake: boolean | null; close(): void }) {
  const [saved, setSaved] = useState<number | null>(null);
  useEffect(() => {
    api.scholar.studySaved({ kind, courseId, ...target }).then((r) => setSaved(r.count)).catch(() => setSaved(0));
  }, []);
  const noun = kind === 'exam' ? 'questions' : 'cards';
  const go = (n: number, mode: Mode) => (close(), make(kind, courseId, n, target, mode));
  const fromSaved = saved ? [10, 25, 50].filter((n) => n < saved) : [];
  return (
    <>
      {saved != null && saved >= 5 && (
        <>
          <div className="st-menu-label">From your {saved} saved {noun} · ready now</div>
          {fromSaved.map((n) => (
            <button key={n} className="menu-item" onClick={() => go(n, 'saved')}>
              {n} saved {noun}
            </button>
          ))}
          <button className="menu-item" onClick={() => go(saved, 'saved')}>
            All {saved} saved {noun}
          </button>
          <div className="menu-sep" />
        </>
      )}
      <div className="st-menu-label">{saved ? `New set (adds new ${noun} to your saved ones)` : kind === 'exam' ? 'Exam-style questions, with answers' : 'Cards'}</div>
      {SIZES[kind].map((n) => {
        const reuse = Math.min(saved || 0, Math.floor(n * REUSE));
        return (
          <button key={n} className="menu-item" disabled={canMake === false} title={canMake === false ? 'Connect your Claude account in Scans to make new ones' : undefined} onClick={() => go(n, 'mix')}>
            {n} {noun}
            {reuse > 0 && (
              <span className="muted st-menu-note">
                {reuse} saved + {n - reuse} new
              </span>
            )}
          </button>
        );
      })}
    </>
  );
}

function MakeButton({ kind, disabled, canMake, courseId, target, label }: { kind: StudyKind; disabled: boolean; canMake: boolean | null; courseId: string; target: Target; label?: string }) {
  return (
    <MenuButton
      button={() => (
        <button className="btn sm" disabled={disabled}>
          {kind === 'exam' ? <ClipboardList size={14} /> : <Layers size={14} />} {label || (kind === 'exam' ? 'Practice exam' : 'Flashcards')}
        </button>
      )}
    >
      {(close) => <MakeMenu kind={kind} courseId={courseId} target={target} canMake={canMake} close={close} />}
    </MenuButton>
  );
}

/** A set being made: a bar with the time left, or its place in line. */
function MakingProgress({ id }: { id: string }) {
  const { run, queue } = useLiveRun();
  const mine = run && run.arg.split(/\s+/)[0] === id ? run : null;
  const now = useNow(!!mine);
  if (mine) {
    const p = progressOf(mine, [], now);
    return (
      <div className="st-progress">
        <Bar value={p.overall} />
        <span className="muted">
          {mine.phase === 'claude' ? `About ${span(p.left)} left` : mine.step || 'Getting ready…'} · {Math.round(p.overall * 100)}%
        </span>
      </div>
    );
  }
  const at = queue.findIndex((q) => q.arg.split(/\s+/)[0] === id);
  if (at >= 0) {
    const wait = (run ? progressOf(run, [], now).left : 0) + queue.slice(0, at).reduce((n, q) => n + (q.expectedMs || 0), 0) + (queue[at].expectedMs || 0);
    return (
      <div className="st-progress">
        <Bar value={0.02} />
        <span className="muted">
          Waiting for {at + (run ? 1 : 0)} scan{at + (run ? 1 : 0) === 1 ? '' : 's'} ahead · ready in about {span(wait)}
        </span>
      </div>
    );
  }
  return null;
}

export function SetRow({ s, showCourse = false }: { s: StudySet; showCourse?: boolean }) {
  const [sure, setSure] = useState(false);
  const Icon = s.kind === 'exam' ? ClipboardList : Layers;
  const meta =
    s.status === 'making'
      ? 'Being made…'
      : s.status === 'failed'
        ? s.error || 'Didn’t work'
        : [
            `${s.count} ${s.kind === 'exam' ? 'questions' : 'cards'}${s.source === 'saved' ? ', from saved ones' : s.reused ? ` (${s.reused} saved, ${s.count - s.reused} new)` : ''}`,
            s.source === 'mine' && s.editedAt && s.editedAt.slice(0, 10) !== s.createdAt.slice(0, 10) ? `edited ${madeOn(s.editedAt)}` : `made ${madeOn(s.createdAt)}`,
            s.kind === 'exam' && s.best != null ? `best ${pct(s.best)} (${s.attempts} tr${s.attempts === 1 ? 'y' : 'ies'})` : '',
            s.kind === 'cards' && s.known ? `${s.known} known` : ''
          ]
            .filter(Boolean)
            .join(' · ');
  return (
    <div className={`st-row ${s.status}`}>
      {s.status === 'making' ? <Loader2 size={16} className="spin" /> : s.status === 'failed' ? <AlertTriangle size={16} /> : <Icon size={16} />}
      <div className="st-text">
        <div className="st-title">
          {showCourse && <span className="st-code">{s.courseCode}</span>}
          {s.itemTitle || s.title.replace(/^(Practice exam|Flashcards): /, '')}
        </div>
        <div className="muted st-meta">
          {s.kind === 'exam' ? 'Practice exam' : s.source === 'mine' ? 'Your set' : 'Flashcards'} · {meta}
        </div>
        {s.status === 'making' && <MakingProgress id={s.id} />}
      </div>
      {s.status === 'ready' && s.source === 'mine' && (
        <button className="icon-btn sm" title="Edit" onClick={() => openStudySet(`edit:${s.id}`)}>
          <Pencil size={14} />
        </button>
      )}
      {s.status === 'ready' && (
        <button className="btn sm tonal" onClick={() => openStudySet(s.id)}>
          {s.kind === 'exam' ? 'Take' : 'Study'}
        </button>
      )}
      {s.status !== 'making' &&
        (sure ? (
          <button className="btn sm danger" onClick={() => api.scholar.studyDelete(s.id).then(() => useScholar.getState().set({ version: useScholar.getState().version + 1 }))} onMouseLeave={() => setSure(false)}>
            Delete?
          </button>
        ) : (
          <button className="icon-btn sm" title="Delete" onClick={() => setSure(true)}>
            <Trash2 size={14} />
          </button>
        ))}
    </div>
  );
}

/**
 * Practice for one test or assignment, or for chapters: the sets already made for it (with scores), and buttons to make
 * another practice exam or deck.
 */
export function PracticeBox({ courseId, itemId, chapters, title = 'Practice' }: { courseId: string; itemId?: string; chapters?: string[]; title?: string }) {
  const sets = useStudySets();
  const canMake = useCanMake();
  const key = (chapters || []).join('|');
  const mine = (sets || []).filter((s) => s.courseId === courseId && (itemId ? s.itemId === itemId : !s.itemId && s.chapters.join('|') === key));
  const target = itemId ? { itemId } : { chapters };
  return (
    <section className="st-box">
      <div className="tb-h">{title}</div>
      {mine.length > 0 && (
        <div className="st-list">
          {mine.map((s) => (
            <SetRow key={s.id} s={s} />
          ))}
        </div>
      )}
      <div className="st-make">
        <MakeButton kind="exam" disabled={false} canMake={canMake} courseId={courseId} target={target} label={mine.some((s) => s.kind === 'exam') ? 'Another practice exam' : undefined} />
        <MakeButton kind="cards" disabled={false} canMake={canMake} courseId={courseId} target={target} label={mine.some((s) => s.kind === 'cards') ? 'More flashcards' : undefined} />
      </div>
      {!mine.length && <div className="muted st-hint">Written once from your chapters and the class's review sheets, then shuffled into a new exam every time you take it.</div>}
    </section>
  );
}

// ---------- My resources ----------
export function ResourcesView({ courses, courseId }: { courses: ScholarCourse[]; courseId?: string }) {
  const sets = useStudySets();
  const [filter, setFilter] = useState<string>(courseId || '');
  const shown = (sets || []).filter((s) => !filter || s.courseId === filter);
  const byCourse = new Map<string, StudySet[]>();
  for (const s of shown) byCourse.set(s.courseId, [...(byCourse.get(s.courseId) || []), s]);
  return (
    <div className={courseId ? '' : 'sch-page'}>
      {!courseId && (
        <>
          <h1 className="sch-title">My resources</h1>
          <p className="sch-sub">Your practice exams and flashcards. Each one is saved here: take it again any time and Kea shuffles it into a new exam.</p>
        </>
      )}
      <div className="st-own">
        <button className="btn sm" onClick={() => openStudySet('edit:new')}>
          <Plus size={14} /> Make your own set
        </button>
        <button className="btn sm" onClick={() => openStudySet('edit:import')}>
          <ClipboardPaste size={14} /> Import from Quizlet
        </button>
      </div>
      <Maker courses={courses} courseId={courseId || filter} />
      {!courseId && courses.length > 1 && (
        <div className="st-seg st-filter">
          <button className={!filter ? 'on' : ''} onClick={() => setFilter('')}>
            All
          </button>
          {courses.map((c) => (
            <button key={c.id} className={filter === c.id ? 'on' : ''} onClick={() => setFilter(c.id)}>
              {c.code}
            </button>
          ))}
        </div>
      )}
      {sets === null ? (
        <div className="spinner" />
      ) : !shown.length ? (
        <div className="sch-empty">Nothing made yet. Make a practice exam or flashcards above, or from any test or textbook chapter.</div>
      ) : (
        [...byCourse.entries()].map(([cid, list]) => (
          <section key={cid}>
            {!courseId && <h2 className="sch-h2">{cid ? courses.find((c) => c.id === cid)?.code || list[0].courseCode : 'Your own sets'}</h2>}
            <div className="st-list">
              {list.map((s) => (
                <SetRow key={s.id} s={s} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}

/** Make a set for any chapters of a class. */
function Maker({ courses, courseId }: { courses: ScholarCourse[]; courseId: string }) {
  const canMake = useCanMake();
  const [cid, setCid] = useState(courseId || courses[0]?.id || '');
  const [detail, setDetail] = useState<ScholarCourseDetail | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  useEffect(() => setCid(courseId || courses[0]?.id || ''), [courseId, courses]);
  useEffect(() => {
    setPicked([]);
    if (cid) api.scholar.course(cid).then(setDetail);
  }, [cid]);
  if (!courses.length) return null;
  const toggle = (l: string) => setPicked((p) => (p.includes(l) ? p.filter((x) => x !== l) : [...p, l]));
  return (
    <section className="st-maker">
      <div className="st-maker-head">
        <ClipboardList size={15} /> <b>Study chapters</b>
        {!courseId && (
          <select value={cid} onChange={(e) => setCid(e.target.value)}>
            {courses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code}
              </option>
            ))}
          </select>
        )}
        <span className="muted">Pick chapters:</span>
      </div>
      <div className="st-chips">
        {(detail?.chapters || []).map((ch) => (
          <button key={ch.label} className={`st-chip ${picked.includes(ch.label) ? 'on' : ''}`} onClick={() => toggle(ch.label)} title={ch.title || ''}>
            {picked.includes(ch.label) && <Check size={12} />} {ch.label.replace('Chapter ', 'Ch ')}
          </button>
        ))}
      </div>
      <div className="st-make">
        <button
          className="btn primary sm"
          disabled={!picked.length}
          onClick={() => {
            const chapters = sortLabels(picked, detail);
            openStudyHub({ courseId: cid, code: detail?.code || '', title: chapters.length === 1 ? chapters[0] : `${chapters.length} chapters`, chapters });
          }}
        >
          <ClipboardList size={14} /> Study {picked.length ? sortLabels(picked, detail).map((x) => x.replace(/^Chapter /, 'Ch ')).join(', ') : 'these'}
        </button>
        {canMake === false && <span className="muted st-hint">Writing new questions needs your Claude account (set it up in Scans). Studying saved ones works without it.</span>}
      </div>
    </section>
  );
}
const sortLabels = (picked: string[], d: ScholarCourseDetail | null) => (d ? d.chapters.map((c) => c.label).filter((l) => picked.includes(l)) : picked);

// ---------- Taking a set ----------
type DeckMode = 'cards' | 'learn' | 'test' | 'match';
const DECK_MODES: [DeckMode, string, typeof Layers][] = [
  ['cards', 'Flashcards', Layers],
  ['learn', 'Learn', Brain],
  ['test', 'Test', FileCheck],
  ['match', 'Match', Shapes]
];

/**
 * The full-window player. `id` is a set's id, or "review:<courseId|all>" for spaced review, or "edit:<id>",
 * "edit:new" and "edit:import" for the set editor.
 */
export function StudyPlayer({ id: fullId, onClose }: { id: string; onClose(): void }) {
  // ("<set id>#learn" opens a deck at Learn, "#match" at Match: the Study page's buttons.)
  const [id, startMode] = fullId.split('#') as [string, DeckMode | undefined];
  const [set, setSet] = useState<StudySetFull | null>(null);
  const [mode, setMode] = useState<DeckMode>(startMode || 'cards');
  const hub = id.startsWith('hub:') ? parseScope(id) : null;
  // The class's textbook chapters, so each question can open its reading beside the quiz.
  const [pdfs, setPdfs] = useState<Map<string, string>>(new Map());
  const [reading, setReading] = useState<ReadingTarget | null>(null);
  const [pdfCourse, setPdfCourse] = useState('');
  // "review:<courseId|all>" or "review:<courseId>:<chapters>" (one chapter's or one test's review).
  const reviewParts = id.startsWith('review:') ? id.slice(7).split(':') : null;
  const review = reviewParts ? reviewParts[0] : null;
  const reviewChapters = reviewParts?.[1] ? decodeURIComponent(reviewParts[1]).split('|').filter(Boolean) : [];
  const reviewSections = reviewParts?.[2] ? decodeURIComponent(reviewParts[2]).split('|').filter(Boolean) : [];
  const edit = id.startsWith('edit:') ? id.slice(5) : null;
  useEffect(() => {
    setSet(null);
    setMode(startMode || 'cards');
    if (hub) setPdfCourse(hub.courseId);
    if (review != null || edit != null || hub) return;
    const asCards = id.startsWith('qcards:');
    api.scholar.studyGet(asCards ? id.slice(7) : id).then((s) => {
      if (!s) return onClose();
      setSet(asCards ? questionCards(s) : s);
      if (s.courseId) setPdfCourse(s.courseId);
    });
  }, [fullId]);
  // The textbook chapters of the class in front of the student (Review moves between classes).
  useEffect(() => {
    if (!pdfCourse) return setPdfs(new Map());
    api.scholar.course(pdfCourse).then((c) => setPdfs(new Map((c?.chapters || []).filter((ch) => ch.pdf).map((ch) => [ch.label, ch.pdf!.file]))));
  }, [pdfCourse]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && (reading ? setReading(null) : onClose());
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [reading]);
  const file = reading && pdfs.get(reading.chapter);
  const title = hub ? 'Study' : review != null ? 'Review' : edit != null ? (edit === 'new' || edit === 'import' ? 'New set' : 'Edit set') : set?.title || '';
  const body = hub ? (
    <StudyHub scope={hub} />
  ) : review != null ? (
      <Review courseId={review === 'all' ? '' : review} chapters={reviewChapters} sections={reviewSections} />
    ) : edit != null ? (
      <SetEditor id={edit === 'new' || edit === 'import' ? undefined : edit} startWithImport={edit === 'import'} onClose={onClose} />
    ) : !set ? (
      <div className="spinner" />
    ) : set.kind === 'exam' ? (
      <Exam set={set} />
    ) : mode === 'learn' ? (
      <Learn set={set} />
    ) : mode === 'test' ? (
      <CardTest set={set} />
    ) : mode === 'match' ? (
      <Match set={set} />
    ) : (
      <Cards set={set} />
    );
  return (
    <ReadingContext.Provider value={{ has: (ch) => !!ch && pdfs.has(ch), open: setReading, current: reading, course: (cid) => cid !== pdfCourse && (setReading(null), setPdfCourse(cid)) }}>
      <div className={`st-player ${file ? 'with-reading' : ''}`}>
        <div className="st-player-head">
          <button className="icon-btn" onClick={onClose} title="Close (Esc)">
            <X size={18} />
          </button>
          <div className="st-player-title">{title}</div>
          {set?.kind === 'cards' && (
            <div className="st-seg st-modes">
              {DECK_MODES.map(([m, label, Icon]) => (
                <button key={m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>
                  <Icon size={13} /> {label}
                </button>
              ))}
            </div>
          )}
          {set?.source === 'mine' && (
            <button className="btn sm" onClick={() => useScholar.getState().set({ study: `edit:${set.id}` })}>
              <Pencil size={13} /> Edit
            </button>
          )}
        </div>
        <div className="st-player-body">
          <div className="st-main">{body}</div>
          {file && reading && <ReadingPane file={file} target={reading} onClose={() => setReading(null)} />}
        </div>
      </div>
    </ReadingContext.Provider>
  );
}

export function shuffle<T>(a: T[]): T[] {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}

/** A question as shown: choices in a fresh order, with the stored answer mapped to it. */
export interface Shown {
  q: StudyQuestion;
  order: number[]; // shown position → original choice index
}
export type Answer = number | number[] | boolean | string | null;

function parseNumber(s: string): number | null {
  const t = s
    .trim()
    .replace(/,/g, '')
    .replace(/\s*[x×*]\s*10\s*\^\s*/i, 'e')
    .replace(/[^\d.eE+\-]/g, '');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Right or wrong (short answers are marked by the student: null until then; a blank is marked by judgeBlank, null while
 * it decides, and the student can overrule it).
 */
export function grade(s: Shown, a: Answer, self?: boolean, judged?: boolean): boolean | null {
  const q = s.q;
  if (q.type === 'blank') return self ?? judged ?? null;
  if (q.type === 'mc') return typeof a === 'number' && s.order[a] === q.answer;
  if (q.type === 'multi') {
    if (!Array.isArray(a)) return false;
    const got = a.map((i) => s.order[i]).sort();
    return got.length === q.answer.length && got.every((x, i) => x === q.answer[i]);
  }
  if (q.type === 'tf') return a === q.answer;
  if (q.type === 'num') {
    const n = typeof a === 'string' ? parseNumber(a) : null;
    return n != null && Math.abs(n - q.answer) <= q.tolerance + 1e-12;
  }
  return self ?? null;
}

/**
 * Which questions a practice exam asks: ones missed last time first, then ones never tried, then the longest since
 * last seen, with some chance in it; ones right every time and seen lately come last, so a bank isn't repeated
 * question for question but misses come back. Then shuffled.
 */
function choose(all: StudyQuestion[], n: number, history: Record<string, StudyHistory>) {
  const now = Date.now();
  const score = (q: StudyQuestion) => {
    const h = q.k ? history[q.k] : undefined;
    if (!h) return 3 + Math.random();
    const days = (now - Date.parse(h.last)) / 864e5;
    return (h.lastRight === false ? 4 : 1 - h.right / Math.max(1, h.seen)) + Math.min(2, days / 7) + Math.random() * 0.75;
  };
  return shuffle(
    all
      .map((q) => ({ q, s: score(q) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, n)
      .map((x) => x.q)
  );
}

export function Exam({ set }: { set: StudySetFull }) {
  const all = set.questions || [];
  const [n, setN] = useState(Math.min(all.length, 25));
  const [instant, setInstant] = useState(false);
  const [run, setRun] = useState<Shown[] | null>(null);
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [selfMarks, setSelfMarks] = useState<(boolean | undefined)[]>([]);
  const [judged, setJudged] = useState<(boolean | undefined)[]>([]);
  const [checked, setChecked] = useState<boolean[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const [saved, setSaved] = useState(false);

  const start = () => {
    opened.current = new Set();
    const picked = choose(all, n, set.history || {});
    setRun(picked.map((q) => ({ q, order: 'choices' in q ? shuffle(q.choices.map((_, i) => i)) : [] })));
    setAnswers(picked.map(() => null));
    setSelfMarks([]);
    setJudged([]);
    setChecked([]);
    setSubmitted(false);
    setSaved(false);
  };
  const results = useMemo(() => (run ? run.map((s, i) => grade(s, answers[i], selfMarks[i], judged[i])) : []), [run, answers, selfMarks, judged]);
  // Blanks are marked as they're revealed: Kea's own matching, then the local model for anything it can't place.
  useEffect(() => {
    if (!run) return;
    run.forEach((s, i) => {
      const q = s.q;
      if (q.type !== 'blank' || judged[i] !== undefined || !(submitted || checked[i])) return;
      judgeBlank(typeof answers[i] === 'string' ? (answers[i] as string) : '', q.answer, q.accept || [], q.q).then((ok) =>
        setJudged((p) => {
          const c = [...p];
          c[i] = ok;
          return c;
        })
      );
    });
  }, [run, submitted, checked]);
  const score = results.filter((r) => r === true).length;
  const unmarked = results.filter((r) => r === null).length;
  // A miss opens the reading that teaches it: as soon as it's checked, or (at the end) the first one missed.
  const missReading = useMissReading();
  const opened = useRef<Set<number>>(new Set());
  useEffect(() => {
    if (!run) return;
    const target = (i: number) => {
      const q = run[i].q;
      opened.current.add(i);
      missReading({ chapter: q.chapter, section: q.section, topic: q.topic, query: `${q.q} ${answerText(q)}`, key: q.k, steps: q.steps });
    };
    if (submitted) {
      const first = results.findIndex((r) => r === false);
      if (first >= 0 && !opened.current.size) target(first);
      return;
    }
    const miss = results.findIndex((r, i) => r === false && checked[i] && !opened.current.has(i));
    if (miss >= 0) target(miss);
  }, [results, submitted, checked]);
  // Save the attempt once everything is marked (short answers need the student's own mark).
  useEffect(() => {
    if (submitted && !saved && run && unmarked === 0) {
      setSaved(true);
      api.scholar.studyAttempt(set.id, { score, total: run.length, n: run.length, items: run.map((s, i) => [s.q.k || '', results[i]] as [string, boolean | null]).filter(([k]) => k) });
    }
  }, [submitted, unmarked, saved]);

  if (!run) {
    const counts = [10, 25, 50, all.length].filter((x, i, a) => x <= all.length && a.indexOf(x) === i);
    return (
      <div className="st-setup">
        <h2>{all.length} questions in this set</h2>
        <p className="muted">Each practice exam asks the questions you missed or haven't seen in a while first, with the choices in a new order.</p>
        <div className="st-setup-row">
          <span>Questions</span>
          <div className="st-seg">
            {counts.map((c) => (
              <button key={c} className={n === c ? 'on' : ''} onClick={() => setN(c)}>
                {c === all.length ? `All ${c}` : c}
              </button>
            ))}
          </div>
        </div>
        <div className="st-setup-row">
          <span>Answers</span>
          <div className="st-seg">
            <button className={!instant ? 'on' : ''} onClick={() => setInstant(false)}>
              At the end, like an exam
            </button>
            <button className={instant ? 'on' : ''} onClick={() => setInstant(true)}>
              After each question
            </button>
          </div>
        </div>
        <button className="btn primary" onClick={start}>
          Start
        </button>
      </div>
    );
  }

  const setAnswer = (i: number, a: Answer) => !submitted && !checked[i] && setAnswers((p) => p.map((x, k) => (k === i ? a : x)));
  const answered = answers.filter((a) => a !== null && a !== '' && !(Array.isArray(a) && !a.length)).length;
  return (
    <div className="st-exam">
      {submitted && (
        <div className="st-score">
          <div className="st-score-big">{unmarked ? `${score}/${run.length - unmarked}` : `${Math.round((score / run.length) * 100)}%`}</div>
          <div>
            <b>
              {score} of {run.length} right
            </b>
            {unmarked > 0 && <div className="muted">Mark your {unmarked} written answer{unmarked === 1 ? '' : 's'} below to finish.</div>}
          </div>
          <button className="btn tonal" onClick={start}>
            <RotateCcw size={14} /> New practice exam
          </button>
        </div>
      )}
      {run.map((s, i) => (
        <QuestionCard
          key={i}
          num={i + 1}
          s={s}
          answer={answers[i]}
          setAnswer={(a) => setAnswer(i, a)}
          reveal={submitted || !!checked[i]}
          result={results[i]}
          onSelf={(ok) => setSelfMarks((p) => {
            const c = [...p];
            c[i] = ok;
            return c;
          })}
          onCheck={instant && !checked[i] && !submitted ? () => setChecked((p) => {
            const c = [...p];
            c[i] = true;
            return c;
          }) : undefined}
        />
      ))}
      {!submitted && (
        <div className="st-submit">
          <span className="muted">
            {answered} of {run.length} answered
          </span>
          <button className="btn primary" onClick={() => (setSubmitted(true), document.querySelector('.st-main')?.scrollTo({ top: 0, behavior: 'smooth' }))}>
            Finish and see my score
          </button>
        </div>
      )}
    </div>
  );
}

/** A question's right answer in words (what the book should say). */
/**
 * A question set as flashcards: the question on the front, the right answer on the back (and for a calculation, the
 * answer with its unit). So every set can be studied in Flashcards and Learn, as on Quizlet, before any cards are
 * written. Written-answer questions stay in practice exams.
 */
function questionCards(s: StudySetFull): StudySetFull {
  const back = (q: StudyQuestion) =>
    q.type === 'tf' ? (q.answer ? 'True' : 'False') : q.type === 'num' ? `${q.answer}${q.unit ? ` ${q.unit}` : ''}` : answerText(q);
  const cards = (s.questions || [])
    .filter((q) => q.type !== 'short')
    .map((q) => ({ k: q.k, front: q.type === 'tf' ? `True or false: ${q.q}` : q.q, back: back(q), chapter: q.chapter, section: q.section, topic: q.topic }));
  // (The same id as the questions' own set, so Learn and known-card progress are kept between sessions.)
  return { ...s, kind: 'cards', cards, questions: undefined, count: cards.length };
}

/**
 * The worked solution, step by step: open by itself after a miss, a click away after a right answer. A question
 * without steps yet offers to have its chapter's written now.
 */
export function WorkedSteps({ q, open: startOpen }: { q: StudyQuestion; open: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const [asked, setAsked] = useState(false);
  useEffect(() => setOpen(startOpen), [startOpen, q.k]);
  if (q.type === 'short') return null;
  if (!q.steps?.length) {
    if (!startOpen || !q.k) return null;
    return (
      <div className="st-steps none">
        {asked ? (
          <span className="muted">The step-by-step solutions for this chapter are being written (a few minutes; follow it under Scans).</span>
        ) : (
          <button
            className="btn sm"
            onClick={() =>
              api.scholar
                .studyStepsFor(q.k!)
                .then(() => setAsked(true))
                .catch((err) => toast(err?.message || 'Kea couldn’t start that.', 'error'))
            }
          >
            Write step-by-step solutions for {q.chapter || 'this chapter'}
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="st-steps">
      {q.answerDisputed && <div className="st-disputed">Kea’s review found the stored answer to this question may be wrong: the steps below work it correctly.</div>}
      <button className="st-steps-head" onClick={() => setOpen(!open)}>
        {open ? 'Step by step' : 'Show the steps'}
        <span className="muted"> · {q.steps.length} steps</span>
      </button>
      {open && (
        <ol>
          {q.steps.map((s, i) => (
            <li key={i}>
              <MathText text={s} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

const answerText = (q: StudyQuestion) =>
  q.type === 'mc' ? q.choices[q.answer] : q.type === 'multi' ? q.answer.map((i) => q.choices[i]).join(' ') : q.type === 'tf' ? '' : q.type === 'num' ? q.unit || '' : q.answer;

export function QuestionCard({ num, s, answer, setAnswer, reveal, result, onSelf, onCheck }: { num: number; s: Shown; answer: Answer; setAnswer(a: Answer): void; reveal: boolean; result: boolean | null; onSelf(ok: boolean): void; onCheck?: () => void }) {
  const q = s.q;
  const state = !reveal ? '' : result === true ? 'right' : result === false ? 'wrong' : 'mark';
  return (
    <div className={`st-q ${state}`}>
      <div className="st-q-head">
        <span className="st-num">{num}</span>
        <div className="st-stem"><MathText text={q.q} /></div>
        <ReadingButton id={q.k} chapter={q.chapter} section={q.section} topic={q.topic} query={`${q.q} ${answerText(q)}`} steps={q.steps} />
      </div>
      {(q.type === 'mc' || q.type === 'multi') && (
        <div className="st-choices">
          {s.order.map((orig, pos) => {
            const on = q.type === 'mc' ? answer === pos : Array.isArray(answer) && answer.includes(pos);
            const correct = q.type === 'mc' ? q.answer === orig : q.answer.includes(orig);
            return (
              <button
                key={pos}
                className={`st-choice ${on ? 'on' : ''} ${reveal && correct ? 'correct' : ''} ${reveal && on && !correct ? 'incorrect' : ''}`}
                onClick={() => (q.type === 'mc' ? setAnswer(pos) : setAnswer(on ? (answer as number[]).filter((x) => x !== pos) : [...((answer as number[]) || []), pos]))}
              >
                <span className="st-letter">{String.fromCharCode(65 + pos)}</span>
                <span><MathText text={q.choices[orig]} /></span>
              </button>
            );
          })}
          {q.type === 'multi' && !reveal && <div className="muted st-hint">Select all that apply.</div>}
        </div>
      )}
      {q.type === 'tf' && (
        <div className="st-choices row">
          {[true, false].map((v) => (
            <button key={String(v)} className={`st-choice ${answer === v ? 'on' : ''} ${reveal && q.answer === v ? 'correct' : ''} ${reveal && answer === v && q.answer !== v ? 'incorrect' : ''}`} onClick={() => setAnswer(v)}>
              {v ? 'True' : 'False'}
            </button>
          ))}
        </div>
      )}
      {q.type === 'num' && (
        <div className="st-num-in">
          <input value={typeof answer === 'string' ? answer : ''} onChange={(e) => setAnswer(e.target.value)} placeholder="Your answer" disabled={reveal} inputMode="decimal" />
          {q.unit && <span className="muted">{q.unit}</span>}
          {reveal && (
            <span className="st-correct-val">
              Answer: {q.answer}
              {q.unit ? ` ${q.unit}` : ''}
            </span>
          )}
        </div>
      )}
      {q.type === 'blank' && (
        <div className="st-num-in">
          <input value={typeof answer === 'string' ? answer : ''} onChange={(e) => setAnswer(e.target.value)} placeholder="A word or two" disabled={reveal} autoCapitalize="off" spellCheck={false} />
          {reveal && result === null && <span className="muted">Checking…</span>}
          {reveal && result !== null && <span className="st-correct-val">Answer: {q.answer}</span>}
          {reveal && result === false && (
            <button className="btn sm" onClick={() => onSelf(true)} title="Kea marked this wrong, but it means the same thing">
              <Check size={13} /> I was right
            </button>
          )}
        </div>
      )}
      {q.type === 'short' && <textarea className="st-short" value={typeof answer === 'string' ? answer : ''} onChange={(e) => setAnswer(e.target.value)} placeholder="Write your answer" disabled={reveal} rows={3} />}
      {onCheck && (
        <button className="btn sm" onClick={onCheck}>
          Check
        </button>
      )}
      {reveal && (
        <div className="st-explain">
          {q.type === 'short' && (
            <div className="st-model">
              <b>Model answer:</b> <MathText text={q.answer} />
            </div>
          )}
          <div><MathText text={q.explain} /></div>
          <WorkedSteps q={q} open={result === false} />
          {q.type === 'short' && (
            <div className="st-self">
              <span className="muted">Did you get it?</span>
              <button className={`btn sm ${result === true ? 'tonal' : ''}`} onClick={() => onSelf(true)}>
                <Check size={13} /> Yes
              </button>
              <button className={`btn sm ${result === false ? 'tonal' : ''}`} onClick={() => onSelf(false)}>
                <X size={13} /> No
              </button>
            </div>
          )}
          {(q.chapter || q.topic) && <div className="muted st-src">{[q.chapter, q.topic, q.source].filter(Boolean).join(' · ')}</div>}
        </div>
      )}
    </div>
  );
}

function Cards({ set }: { set: StudySetFull }) {
  const cards = set.cards || [];
  const [known, setKnown] = useState<number[]>(set.known || []);
  const [onlyLearning, setOnlyLearning] = useState(false);
  const [starred, setStarred] = useState<string[]>(set.starred || []);
  const [onlyStarred, setOnlyStarred] = useState(false);
  const [order, setOrder] = useState<number[]>(() => cards.map((_, i) => i));
  const [pos, setPos] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const deck = order.filter((i) => (!onlyLearning || !known.includes(i)) && (!onlyStarred || starred.includes(cards[i].k!)));
  const idx = deck[Math.min(pos, deck.length - 1)];
  const card: StudyCard | undefined = cards[idx];
  const move = (d: number) => {
    setFlipped(false);
    setPos((p) => Math.max(0, Math.min(deck.length - 1, p + d)));
  };
  const missReading = useMissReading();
  const mark = (isKnown: boolean) => {
    if (!isKnown && card) missReading({ chapter: card.chapter, section: card.section, topic: card.topic, query: `${card.front} ${card.back}`, key: card.k });
    const next = isKnown ? [...new Set([...known, idx])] : known.filter((x) => x !== idx);
    setKnown(next);
    api.scholar.studyKnown(set.id, next);
    setFlipped(false);
    if (!onlyLearning || !isKnown) setPos((p) => Math.min(deck.length - 1, p + 1));
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.key === ' ' || e.key === 'Enter') (e.preventDefault(), setFlipped((f) => !f));
      if (e.key === 'ArrowRight') move(1);
      if (e.key === 'ArrowLeft') move(-1);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });
  return (
    <div className="st-cards">
      <div className="st-cards-bar">
        <span className="muted">
          {deck.length ? `${Math.min(pos, deck.length - 1) + 1} / ${deck.length}` : 'All known'} · {known.length} of {cards.length} known
        </span>
        <button className="btn sm" onClick={() => (setOrder(shuffle(cards.map((_, i) => i))), setPos(0), setFlipped(false))}>
          <Shuffle size={13} /> Shuffle
        </button>
        <button className={`btn sm ${onlyLearning ? 'tonal' : ''}`} onClick={() => (setOnlyLearning(!onlyLearning), setPos(0), setFlipped(false))}>
          Only ones I'm learning
        </button>
        {starred.length > 0 && (
          <button className={`btn sm ${onlyStarred ? 'tonal' : ''}`} onClick={() => (setOnlyStarred(!onlyStarred), setPos(0), setFlipped(false))}>
            <Star size={13} /> Starred ({starred.length})
          </button>
        )}
      </div>
      {card ? (
        <>
          <button className={`st-card ${flipped ? 'flipped' : ''}`} onClick={() => setFlipped(!flipped)} title="Click or press Space to flip">
            <div className="st-card-side"><MathText text={flipped ? card.back : card.front} /></div>
            <div className="muted st-card-foot">
              {flipped ? 'Answer' : 'Click to flip'}
              {card.chapter ? ` · ${card.chapter}` : ''}
              {known.includes(idx) ? ' · Known' : ''}
            </div>
          </button>
          <div className="st-cards-nav">
            <button className="icon-btn" onClick={() => move(-1)} disabled={pos === 0} title="Previous (←)">
              <ArrowLeft size={18} />
            </button>
            <button className="btn" onClick={() => mark(false)}>
              Still learning
            </button>
            <button className="btn primary" onClick={() => mark(true)}>
              <Check size={14} /> I know it
            </button>
            <button className="icon-btn" onClick={() => move(1)} disabled={pos >= deck.length - 1} title="Next (→)">
              <ArrowRight size={18} />
            </button>
            <ReadingButton id={card.k} chapter={card.chapter} section={card.section} topic={card.topic} query={`${card.front} ${card.back}`} />
            <StarButton k={card.k} starred={starred.includes(card.k!)} onChange={(on) => setStarred((s) => (on ? [...s, card.k!] : s.filter((x) => x !== card.k)))} />
            <SpeakButton text={flipped ? card.back : card.front} />
          </div>
        </>
      ) : onlyStarred ? (
        <div className="sch-empty">No starred cards left here.</div>
      ) : (
        <div className="sch-empty">
          You know every card in this deck.
          <button className="btn sm" onClick={() => (setKnown([]), api.scholar.studyKnown(set.id, []), setOnlyLearning(false))}>
            Start over
          </button>
        </div>
      )}
    </div>
  );
}
