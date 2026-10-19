// One place to study anything: a chapter, a test, an assignment, or chapters you pick. Like a Quizlet set page: how
// much you've mastered, and every way to study it (spaced review, a practice exam from the saved questions, flashcards,
// Learn and Match), with past practice exams and their scores. Opened by the one Study button wherever there's
// something to study, so there aren't different buttons doing the same thing in different places.
import { useEffect, useState } from 'react';
import { Brain, ClipboardList, Layers, Loader2, Repeat, Shapes, Sparkles } from 'lucide-react';
import { api, ReviewQueue } from '../../lib/api';
import { toast } from '../../store';
import { MenuButton } from '../Popover';
import { useScholar } from './scholarStore';
import { MakeMenu, SetRow, useCanMake, useStudySets } from './Study';

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

// The same scope always opens the same practice exam and deck, so their scores and Learn progress build up.
const stableId = (kind: string, s: StudyScope) => `${kind}-hub${(s.courseId + (s.itemId || '') + s.chapters.join('')).toLowerCase().replace(/[^a-z0-9]+/g, '')}`.slice(0, 60);
const SIZES = [10, 25, 50];

export function StudyHub({ scope }: { scope: StudyScope }) {
  const sets = useStudySets();
  const canMake = useCanMake();
  const [q, setQ] = useState<ReviewQueue | null>(null);
  const [saved, setSaved] = useState<{ exam: number; cards: number } | null>(null);
  const [size, setSize] = useState(25);
  const [busy, setBusy] = useState('');
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
  const total = c?.total || 0;
  const mastered = c?.mastered || 0;
  const learning = c?.learning || 0;
  const due = c?.due || 0;
  const days = c?.test ? Math.round((Date.parse(`${c.test.date}T12:00`) - Date.now()) / 864e5) : null;
  const mine = (sets || []).filter((s) => s.courseId === scope.courseId && (scope.itemId ? s.itemId === scope.itemId : s.chapters.join('|') === scope.chapters.join('|')) && s.kind === 'exam' && s.attempts > 0);

  const open = async (kind: 'exam' | 'cards', count: number, mode = '') => {
    setBusy(kind + mode);
    try {
      // No flashcards yet: the saved questions, as cards.
      if (kind === 'cards' && !cards) {
        const id = await api.scholar.studyMake({ id: stableId('exam-all', scope), kind: 'exam', courseId: scope.courseId, ...target, mode: 'saved', count: exam });
        useScholar.getState().set({ study: `qcards:${id}${mode ? `#${mode}` : ''}` });
        return;
      }
      const id = await api.scholar.studyMake({ id: stableId(kind, scope), kind, courseId: scope.courseId, ...target, mode: 'saved', count });
      useScholar.getState().set({ study: mode ? `${id}#${mode}` : id });
    } catch (err: any) {
      toast(err?.message || 'Kea couldn’t open it.', 'error');
    } finally {
      setBusy('');
    }
  };
  const review = () => useScholar.getState().set({ study: `review:${scope.courseId}:${encodeURIComponent(scope.chapters.join('|'))}` });
  const exam = saved?.exam || 0;
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
            <span><i className="m" /> {mastered} mastered</span>
            <span><i className="l" /> {learning} learning</span>
            <span><i /> {total - mastered - learning} not seen yet</span>
          </div>
        </div>
      )}

      <div className="hub-modes">
        <button className="hub-mode primary" onClick={review} disabled={!total}>
          <Repeat size={20} />
          <b>Review</b>
          <span>{total ? (due ? `${due} due now` : 'Ready when you are') : 'No questions yet'}</span>
          <small>Spaced, so everything comes back before the test</small>
        </button>
        <div className="hub-mode">
          <ClipboardList size={20} />
          <b>Practice exam</b>
          <span>{exam ? `From ${exam} saved questions, shuffled` : saved ? 'No questions yet' : '…'}</span>
          {exam > 0 && (
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
          )}
          <button className="btn primary sm" disabled={!exam || !!busy} onClick={() => open('exam', Math.min(size, exam))}>
            {busy === 'exam' ? <Loader2 size={13} className="spin" /> : null} Start
          </button>
        </div>
        {(
          [
            ['', 'Flashcards', Layers, 'Flip through, star the hard ones'],
            ['learn', 'Learn', Brain, 'Rounds until you know every card'],
            ['match', 'Match', Shapes, 'Race to pair terms and meanings']
          ] as const
        ).map(([mode, label, Icon, sub]) => (
          <button key={label} className="hub-mode" disabled={(!cards && (mode === 'match' || !exam)) || !!busy} onClick={() => open('cards', cards || exam, mode)}>
            <Icon size={20} />
            <b>{label}</b>
            <span>{cards ? `${cards} cards` : mode === 'match' ? 'Needs flashcards' : exam ? `${exam} questions as cards` : 'No cards yet'}</span>
            <small>{sub}</small>
          </button>
        ))}
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
        <MenuButton
          button={() => (
            <button className="btn sm" disabled={canMake === false}>
              <Sparkles size={13} /> Write more questions
            </button>
          )}
        >
          {(close) => <MakeMenu kind="exam" courseId={scope.courseId} target={target} canMake={canMake} close={close} />}
        </MenuButton>
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
