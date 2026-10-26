// One place to study anything: a chapter, a test, an assignment, a lab or lecture, or chapters you pick. Like a Quizlet
// set page: how your practice has gone, and every way to study it (a practice exam from the saved questions,
// flashcards, Learn and Match, by topic), with past practice exams and their scores. No pacing: you choose what to study. Opened by the one Study button wherever there's
// something to study, so there aren't different buttons doing the same thing in different places.
import { useEffect, useState } from 'react';
import { Brain, ClipboardList, Headphones, Image, Layers, Loader2, Shapes, Sparkles } from 'lucide-react';
import { api, PoolItem, ReviewQueue } from '../../lib/api';
import { toast } from '../../store';
import { MenuButton } from '../Popover';
import { useScholar } from './scholarStore';
import { MakeMenu, SetRow, shuffle, useCanMake, useStudySets } from './Study';

export interface StudyScope {
  courseId: string;
  code: string;
  title: string;
  chapters: string[];
  /** The test or assignment it's for, when there is one. */
  itemId?: string;
}

/** Open the Study page for a scope (in the full-window player). */
export const openStudyHub = (scope: StudyScope) => useScholar.getState().set({ study: `hub:${encodeURIComponent(JSON.stringify(scope))}` });
export const parseScope = (id: string): StudyScope | null => {
  try {
    return JSON.parse(decodeURIComponent(id.slice(4)));
  } catch {
    return null;
  }
};

/** A short hash of a string (FNV-1a, 32 bits, base 36). */
const shortHash = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
};
/**
 * A study set's fixed id for something studied again and again (letters, digits and hyphens only, as study.cjs
 * accepts). An id that fits in 60 characters is the same as before; a longer one is cut and ends in a hash of the
 * whole scope, so "Ch 1–6" and "Ch 1–7" never share one.
 */
export function stableStudyId(prefix: string, parts: string[]) {
  const id = `${prefix}${parts.join('').toLowerCase().replace(/[^a-z0-9]+/g, '')}`;
  return id.length <= 60 ? id : `${id.slice(0, 56)}-${shortHash(JSON.stringify([prefix, ...parts]))}`;
}
// The same scope always opens the same practice exam and deck, so their scores and Learn progress build up.
const stableId = (kind: string, s: StudyScope) => stableStudyId(`${kind}-hub`, [s.courseId, s.itemId || '', ...s.chapters]);
const SIZES = [10, 25, 50];
type Which = 'all' | 'new' | 'missed' | 'starred';
const WHICH: [Which, string][] = [
  ['all', 'All'],
  ['new', 'Not seen yet'],
  ['missed', 'Ones I missed'],
  ['starred', 'Starred']
];
const isMissed = (p: PoolItem) => p.lastRight === false || (p.seen > 0 && p.right < p.seen && p.lastRight !== true);

export function StudyHub({ scope }: { scope: StudyScope }) {
  const sets = useStudySets();
  const canMake = useCanMake();
  const [q, setQ] = useState<ReviewQueue | null>(null);
  const [saved, setSaved] = useState<{ exam: number; cards: number } | null>(null);
  const [size, setSize] = useState(25);
  // Answers at the end (like the real exam) or after each question; remembered on this device.
  const [instant, setInstantState] = useState(() => {
    try {
      return localStorage.getItem('kea.examInstant') !== '0';
    } catch {
      return true;
    }
  });
  const setInstant = (v: boolean) => {
    setInstantState(v);
    try {
      localStorage.setItem('kea.examInstant', v ? '1' : '0');
    } catch {}
  };
  // Opens the exam straight away (no second setup screen).
  const go = instant ? '#exam-instant' : '#exam';
  const [busy, setBusy] = useState('');
  // What to study: the topics (textbook sections) picked, none meaning all; and which of their questions.
  const [pool, setPool] = useState<PoolItem[] | null>(null);
  const [topics, setTopics] = useState<string[]>([]);
  const [which, setWhich] = useState<Which>('all');
  // The options are open on a wide screen; on a phone they fold into one line under Start.
  const [opts, setOpts] = useState(() => typeof window === 'undefined' || window.innerWidth > 700);
  useEffect(() => {
    api.scholar
      .studyPool({ courseId: scope.courseId, chapters: scope.chapters })
      .then(setPool)
      .catch(() => setPool([]));
  }, [scope.courseId, scope.chapters.join('|'), sets?.length]);
  const sectionsOf = [...new Set((pool || []).map((p) => p.section || 'Other'))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const inTopics = (pool || []).filter((p) => !topics.length || topics.includes(p.section || 'Other'));
  const picked = inTopics.filter((p) => (which === 'new' ? !p.seen && p.box == null : which === 'missed' ? isMissed(p) : which === 'starred' ? p.starred : true));
  const narrowed = topics.length > 0 || which !== 'all';
  const target = scope.itemId ? { itemId: scope.itemId } : { chapters: scope.chapters };
  useEffect(() => {
    api.scholar
      .studyReview({ courseId: scope.courseId, chapters: scope.chapters, limit: 1000 })
      .then(setQ)
      .catch(() => setQ(null));
    Promise.all([api.scholar.studySaved({ kind: 'exam', courseId: scope.courseId, ...target }), api.scholar.studySaved({ kind: 'cards', courseId: scope.courseId, ...target })])
      .then(([e, c]) => setSaved({ exam: e.count, cards: c.count }))
      .catch(() => setSaved({ exam: 0, cards: 0 }));
  }, [scope.courseId, scope.itemId, scope.chapters.join('|'), sets?.length]);

  const c = q?.counts[scope.courseId];
  // How practice has gone, question by question (the picked topics only, when some are picked).
  const total = inTopics.length;
  const mastered = inTopics.filter((p) => p.lastRight === true).length;
  const learning = inTopics.filter((p) => p.lastRight === false).length;
  const days = c?.test ? Math.round((Date.parse(`${c.test.date}T12:00`) - Date.now()) / 864e5) : null;
  const mine = (sets || []).filter((s) => s.courseId === scope.courseId && (scope.itemId ? s.itemId === scope.itemId : s.chapters.join('|') === scope.chapters.join('|')) && s.kind === 'exam' && s.attempts > 0);

  const open = async (kind: 'exam' | 'cards', count: number, mode = '') => {
    setBusy(kind + mode);
    try {
      // A practice exam of exactly what's picked (missed ones first when there are more than asked for).
      if (kind === 'exam' && narrowed) {
        const keys = [...shuffle(picked.filter(isMissed)), ...shuffle(picked.filter((p) => !isMissed(p)))].slice(0, count).map((p) => p.k);
        const id = await api.scholar.studyMake({ id: stableId('exam-pick', scope), kind: 'exam', courseId: scope.courseId, ...target, mode: 'saved', count: keys.length, pick: keys });
        useScholar.getState().set({ study: id + go });
        return;
      }
      // No flashcards yet (or a narrowed choice): the saved questions, as cards.
      if (kind === 'cards' && (!cards || narrowed)) {
        const keys = narrowed ? picked.map((p) => p.k) : undefined;
        const id = await api.scholar.studyMake({ id: stableId(narrowed ? 'exam-pickc' : 'exam-all', scope), kind: 'exam', courseId: scope.courseId, ...target, mode: 'saved', count: keys ? keys.length : exam, ...(keys ? { pick: keys } : {}) });
        useScholar.getState().set({ study: `qcards:${id}${mode ? `#${mode}` : ''}` });
        return;
      }
      const id = await api.scholar.studyMake({ id: stableId(kind, scope), kind, courseId: scope.courseId, ...target, mode: 'saved', count });
      useScholar.getState().set({ study: mode ? `${id}#${mode}` : kind === 'exam' ? id + go : id });
    } catch (err: any) {
      toast(err?.message || 'Kea couldn’t open it.', 'error');
    } finally {
      setBusy('');
    }
  };
  const exam = narrowed ? picked.length : saved?.exam || 0;
  const cards = saved?.cards || 0;

  return (
    <div className="hub">
      <div className="hub-head">
        <span className="hub-code">{scope.code}</span>
        <h2>{scope.title}</h2>
        <div className="muted">
          {scope.chapters.map((ch) => ch.replace(/^Chapter /, 'Ch ')).join(', ')}
          {c?.test && days != null && days >= 0 ? ` · ${c.test.title} ${days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`}` : ''}
        </div>
      </div>

      {total > 0 && (
        <div className="hub-mastery">
          <div className="hub-bar">
            <span className="m" style={{ width: `${(mastered / total) * 100}%` }} />
            <span className="l" style={{ width: `${(learning / total) * 100}%` }} />
          </div>
          <div className="hub-legend">
            <span><i className="m" /> {mastered} right last time</span>
            <span><i className="l" /> {learning} missed last time</span>
            <span><i /> {total - mastered - learning} not tried yet</span>
          </div>
        </div>
      )}

      {/* The main thing to do: practise, with a sensible default (25 questions, one at a time) and the options beside it. */}
      <div className="hub-practice">
        <div className="hub-practice-main">
          <ClipboardList size={22} />
          <div>
            <b>Practice questions</b>
            <span className="muted">{exam ? (narrowed ? `${exam} questions match what you picked` : `${exam} questions, shuffled, missed ones first`) : narrowed ? 'None match what you picked' : saved ? 'No questions yet' : '…'}</span>
          </div>
          <button className="btn primary hub-start" disabled={!exam || !!busy} onClick={() => open('exam', Math.min(size, exam))}>
            {busy === 'exam' ? <Loader2 size={15} className="spin" /> : null} Start {exam ? Math.min(size, exam) : ''}
          </button>
        </div>
        {exam > 0 && !opts && (
          <button className="hub-opts-sum" onClick={() => setOpts(true)}>
            {Math.min(size, exam)} questions · answers {instant ? 'after each question' : 'at the end'}
            {which !== 'all' ? ` · ${WHICH.find(([w]) => w === which)![1].toLowerCase()}` : ''}
            {topics.length ? ` · ${topics.length} topic${topics.length > 1 ? 's' : ''}` : ''} <span>Change</span>
          </button>
        )}
        {exam > 0 && opts && (
          <div className="hub-options">
            <div className="hub-opt">
              <span>How many</span>
              <div className="hub-sizes">
                {SIZES.filter((n) => n < exam).map((n) => (
                  <button key={n} className={size === n ? 'on' : ''} onClick={() => setSize(n)}>
                    {n}
                  </button>
                ))}
                <button className={size >= exam ? 'on' : ''} onClick={() => setSize(exam)}>
                  All {exam}
                </button>
              </div>
            </div>
            <div className="hub-opt">
              <span>Answers</span>
              <div className="hub-sizes">
                <button className={instant ? 'on' : ''} onClick={() => setInstant(true)}>
                  After each question
                </button>
                <button className={!instant ? 'on' : ''} onClick={() => setInstant(false)}>
                  At the end, like a test
                </button>
              </div>
            </div>
            {(pool?.length || 0) > 0 && (
              <div className="hub-opt">
                <span>Which</span>
                <div className="hub-sizes">
                  {WHICH.map(([w, label]) => {
                    const n = inTopics.filter((p) => (w === 'new' ? !p.seen && p.box == null : w === 'missed' ? isMissed(p) : w === 'starred' ? p.starred : true)).length;
                    return (
                      <button key={w} className={which === w ? 'on' : ''} disabled={!n && w !== 'all'} onClick={() => setWhich(w)}>
                        {label} <span className="hub-n">{n}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {/* (Topics only when there's more than one to choose between.) */}
            {sectionsOf.length > 1 && (
              <div className="hub-opt">
                <span>Topics</span>
                <div className="hub-sizes wrap">
                  <button className={!topics.length ? 'on' : ''} onClick={() => setTopics([])}>
                    All
                  </button>
                  {sectionsOf.map((t) => {
                    const n = (pool || []).filter((p) => (p.section || 'Other') === t).length;
                    const on = topics.includes(t);
                    return (
                      <button key={t} className={on ? 'on' : ''} onClick={() => setTopics(on ? topics.filter((x) => x !== t) : [...topics, t])} title={t}>
                        {t.length > 40 ? `${t.slice(0, 38)}…` : t} <span className="hub-n">{n}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="hub-ways">
        <div className="tb-h">Other ways to study</div>
        <div className="hub-modes">
          {(
            [
              ['', 'Flashcards', Layers, 'Flip through, star the hard ones'],
              ['learn', 'Learn', Brain, 'Rounds until you know every card'],
              ['match', 'Match', Shapes, 'Pair terms and meanings'],
              ['listen', 'Listen', Headphones, 'Hands-free, read aloud']
            ] as const
          ).map(([mode, label, Icon, sub]) => (
            <button key={label} className="hub-mode" disabled={((!cards || narrowed) && (mode === 'match' || !exam)) || !!busy} onClick={() => open('cards', cards || exam, mode)} title={sub}>
              <Icon size={18} />
              <span className="hub-mode-text">
                <b>{label}</b>
                <small>{cards && !narrowed ? `${cards} cards` : mode === 'match' ? 'Needs flashcards' : exam ? `${exam} as cards` : 'No cards yet'}</small>
              </span>
            </button>
          ))}
        </div>
      </div>

      {!exam && saved && (
        <p className="muted hub-note">
          {canMake === false ? 'No questions have been written for this yet, and Claude isn’t connected to write them.' : 'No questions have been written for this yet: write some below (about a minute).'}
        </p>
      )}

      {mine.length > 0 && (
        <section>
          <div className="tb-h">Your practice exams</div>
          <div className="st-list">
            {mine.map((s) => (
              <SetRow key={s.id} s={s} />
            ))}
          </div>
        </section>
      )}

      <div className="hub-more">
        <span className="tb-h">Make more</span>
        <MenuButton
          button={() => (
            <button className="btn sm" disabled={canMake === false}>
              <Sparkles size={13} /> Write more questions
            </button>
          )}
        >
          {(close) => <MakeMenu kind="exam" courseId={scope.courseId} target={target} canMake={canMake} close={close} />}
        </MenuButton>
        <button
          className="btn sm"
          disabled={canMake === false || !!busy}
          title="Questions that show a specimen, structure or labeled diagram and ask what it is (pictures from Wikimedia Commons)"
          onClick={async () => {
            setBusy('pictures');
            try {
              await api.scholar.studyMake({ kind: 'exam', courseId: scope.courseId, ...target, count: 25, mode: 'new', pictures: true });
              toast('Writing 25 picture questions. They’ll be ready in a few minutes.', 'success');
            } catch (err: any) {
              toast(err?.message || 'Kea couldn’t start that.', 'error');
            } finally {
              setBusy('');
            }
          }}
        >
          <Image size={13} /> Picture questions
        </button>
        <MenuButton
          button={() => (
            <button className="btn sm" disabled={canMake === false}>
              <Layers size={13} /> {cards ? 'More flashcards' : 'Make flashcards'}
            </button>
          )}
        >
          {(close) => <MakeMenu kind="cards" courseId={scope.courseId} target={target} canMake={canMake} close={close} />}
        </MenuButton>
      </div>
    </div>
  );
}
