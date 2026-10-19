// More ways to study a set, all on this computer with no Claude: Learn (rounds that go from picking the answer to
// typing it, until every card is mastered), Match (pair terms with definitions against the clock), a Test made from a
// deck, spaced Review across every set (timed so each card comes back before the test it's on), and sets the student
// makes or pastes in from Quizlet.
import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronRight, ClipboardPaste, Plus, RotateCcw, Star, Timer, Trash2, Trophy, Volume2, X } from 'lucide-react';
import { api, ReviewItem, ReviewQueue, ScholarCourse, StudyCard, StudyQuestion, StudySetFull } from '../../lib/api';
import { toast } from '../../store';
import { judgeBlank } from '../../lib/blank';
import { reloadScholar, useScholar } from './scholarStore';
import { Exam, grade, QuestionCard, Shown, Answer, shuffle } from './Study';
import { ReadingContext, useMissReading } from './ReadingPane';
import { MathText } from './MathText';
import { openStudyHub } from './StudyHub';

// ---------- Small shared pieces ----------
/** Read a side aloud with the computer's own voice (nothing leaves the computer). */
export function speak(text: string) {
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 0.95;
    speechSynthesis.speak(u);
  } catch {}
}
export function SpeakButton({ text }: { text: string }) {
  return (
    <button
      className="icon-btn sm"
      title="Read aloud"
      onClick={(e) => {
        e.stopPropagation();
        speak(text);
      }}
    >
      <Volume2 size={15} />
    </button>
  );
}
export function StarButton({ k, starred, onChange }: { k?: string; starred: boolean; onChange(on: boolean): void }) {
  if (!k) return null;
  return (
    <button
      className={`icon-btn sm st-star ${starred ? 'on' : ''}`}
      title={starred ? 'Starred: tap to unstar' : 'Star it to study it on its own'}
      onClick={(e) => {
        e.stopPropagation();
        api.scholar.studyStar(k, !starred);
        onChange(!starred);
      }}
    >
      <Star size={15} fill={starred ? 'currentColor' : 'none'} />
    </button>
  );
}
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
/** Three wrong answers for a card: other cards' sides, from its own chapter first. */
function distractors(card: StudyCard, all: StudyCard[], side: 'front' | 'back', n = 3) {
  const right = card[side].trim().toLowerCase();
  const seen = new Set([right]);
  const pool = shuffle(all.filter((c) => c !== card)).sort((a, b) => Number(b.chapter === card.chapter) - Number(a.chapter === card.chapter));
  const out: string[] = [];
  for (const c of pool) {
    const t = c[side].trim();
    if (out.length >= n) break;
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out;
}
function ProgressLine({ done, total, label }: { done: number; total: number; label?: string }) {
  return (
    <div className="sm-progress">
      <div className="sm-progress-bar">
        <div style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
      </div>
      <span className="muted">{label ?? `${done} / ${total}`}</span>
    </div>
  );
}

// ---------- Learn ----------
// Each card goes new → familiar (picked the right answer) → mastered (typed it, or picked it the other way round when
// it's too long to type). Rounds of seven; a miss sends the card back a step and it comes again later in the round.
// Mastered cards join spaced review, so they come back before the test.
type LearnQ = { card: StudyCard; mode: 'choose' | 'write' | 'choose-back'; choices?: string[] };
type AnswerWith = 'both' | 'choose' | 'write';
const ROUND = 7;

export function Learn({ set }: { set: StudySetFull }) {
  const cards = set.cards || [];
  const [levels, setLevels] = useState<Record<string, number>>(set.learn || {});
  const [starred, setStarred] = useState<string[]>(set.starred || []);
  const [onlyStarred, setOnlyStarred] = useState(false);
  const [answerWith, setAnswerWith] = useState<AnswerWith>('both');
  const [queue, setQueue] = useState<LearnQ[] | null>(null);
  const [pos, setPos] = useState(0);
  const [given, setGiven] = useState('');
  const [picked, setPicked] = useState<number | null>(null);
  const [result, setResult] = useState<boolean | null | 'checking'>(null);
  const [roundDone, setRoundDone] = useState<StudyCard[]>([]);
  // The card's level before the last answer (to undo a miss with "I was right").
  const [before, setBefore] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const pool = cards.filter((c) => !onlyStarred || starred.includes(c.k!));
  const mastered = pool.filter((c) => levels[c.k!] === 2).length;
  const familiar = pool.filter((c) => levels[c.k!] === 1).length;

  const modeFor = (c: StudyCard, lvl: number): LearnQ['mode'] => {
    if (answerWith === 'choose') return lvl === 0 ? 'choose' : 'choose-back';
    if (answerWith === 'write') return words(c.front) <= 6 ? 'write' : 'choose-back';
    return lvl === 0 ? 'choose' : words(c.front) <= 6 ? 'write' : 'choose-back';
  };
  const ask = (c: StudyCard, lvl: number): LearnQ => {
    const mode = modeFor(c, lvl);
    if (mode === 'write') return { card: c, mode };
    const side = mode === 'choose' ? 'back' : 'front';
    return { card: c, mode, choices: shuffle([c[side].trim(), ...distractors(c, cards, side)]) };
  };
  const startRound = () => {
    // Cards already on their way first, then new ones, in the deck's order.
    const left = pool.filter((c) => levels[c.k!] !== 2).sort((a, b) => (levels[b.k!] || 0) - (levels[a.k!] || 0));
    setQueue(left.slice(0, ROUND).map((c) => ask(c, levels[c.k!] || 0)));
    setRoundDone([]);
    setPos(0);
    reset();
  };
  const reset = () => (setGiven(''), setPicked(null), setResult(null));
  const q = queue?.[pos];
  const save = (next: Record<string, number>) => (setLevels(next), api.scholar.studyLearn(set.id, next));
  const missReading = useMissReading();

  const answered = (ok: boolean) => {
    if (!q) return;
    setResult(ok);
    const k = q.card.k!;
    const lvl = levels[k] || 0;
    setBefore(lvl);
    const next = { ...levels, [k]: ok ? Math.min(2, lvl + 1) : 0 };
    save(next);
    if (!ok) missReading({ chapter: q.card.chapter || set.chapters[0], section: q.card.section, topic: q.card.topic, query: `${q.card.front} ${q.card.back}`, key: k });
    if (ok && next[k] === 2) {
      setRoundDone((d) => [...d, q.card]);
      api.scholar.studyReviewMark(k, 'good', { courseId: set.courseId, chapter: q.card.chapter || set.chapters[0] || null }).catch(() => {});
    }
    // Not mastered yet: it comes again later in this round, a step further along (or back at the start).
    if (next[k] !== 2) setQueue((Q) => (Q ? [...Q, ask(q.card, next[k])] : Q));
  };
  const override = () => {
    if (!q) return;
    const k = q.card.k!;
    // "I was right": the miss is undone (the repeat it queued comes off) and it counts as right.
    const lvl = Math.min(2, before + 1);
    const nextLevels = { ...levels, [k]: lvl };
    save(nextLevels);
    setResult(true);
    setQueue((Q) => (Q ? [...Q.slice(0, -1), ...(lvl === 2 ? [] : [ask(q.card, lvl)])] : Q));
    if (lvl === 2) {
      setRoundDone((d) => [...d, q.card]);
      api.scholar.studyReviewMark(k, 'good', { courseId: set.courseId, chapter: q.card.chapter || set.chapters[0] || null }).catch(() => {});
    }
  };
  const check = async () => {
    if (!q || result !== null) return;
    if (q.mode === 'write') {
      if (!given.trim()) return;
      setResult('checking');
      answered(await judgeBlank(given, q.card.front, [], q.card.back));
    } else if (picked != null) answered(q.choices![picked] === (q.mode === 'choose' ? q.card.back : q.card.front).trim());
  };
  const next = () => {
    if (!queue) return;
    if (pos + 1 >= queue.length) setQueue([]);
    else setPos(pos + 1);
    reset();
  };
  useEffect(() => {
    if (q?.mode === 'write' && result === null) input.current?.focus();
  }, [q, result]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!q) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        if (result === null) check();
        else if (result !== 'checking') next();
      }
      if (q.mode !== 'write' && result === null && /^[1-4]$/.test(e.key)) setPicked(Number(e.key) - 1);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  // Setup, and between rounds.
  if (!queue || !q) {
    const finished = pool.length > 0 && mastered === pool.length;
    return (
      <div className="st-cards sm-learn">
        <h2>{finished ? 'You’ve mastered every card' : queue ? 'Round done' : 'Learn'}</h2>
        <ProgressLine done={mastered} total={pool.length} label={`${mastered} mastered · ${familiar} familiar · ${pool.length - mastered - familiar} not started`} />
        {queue && roundDone.length > 0 && (
          <div className="sm-round">
            <div className="muted">Mastered this round:</div>
            {roundDone.map((c) => (
              <div key={c.k} className="sm-round-row">
                <Check size={14} /> <b><MathText text={c.front} /></b> <span className="muted"><MathText text={c.back} /></span>
              </div>
            ))}
          </div>
        )}
        {!queue && (
          <>
            <p className="muted">Each card starts as multiple choice. Get it right and next time you type the term from its definition. Miss one and it comes back later in the round. Cards you master join your spaced review.</p>
            <div className="st-setup-row">
              <span>Answer by</span>
              <div className="st-seg">
                {(
                  [
                    ['both', 'Choosing, then typing'],
                    ['choose', 'Choosing only'],
                    ['write', 'Typing only']
                  ] as const
                ).map(([v, l]) => (
                  <button key={v} className={answerWith === v ? 'on' : ''} onClick={() => setAnswerWith(v)}>
                    {l}
                  </button>
                ))}
              </div>
            </div>
            {starred.length > 0 && (
              <div className="st-setup-row">
                <span>Cards</span>
                <div className="st-seg">
                  <button className={!onlyStarred ? 'on' : ''} onClick={() => setOnlyStarred(false)}>
                    All {cards.length}
                  </button>
                  <button className={onlyStarred ? 'on' : ''} onClick={() => setOnlyStarred(true)}>
                    <Star size={12} /> Starred ({starred.length})
                  </button>
                </div>
              </div>
            )}
          </>
        )}
        <div className="sm-actions">
          {finished ? (
            <button className="btn" onClick={() => save({})}>
              <RotateCcw size={14} /> Start over
            </button>
          ) : (
            <button className="btn primary" onClick={startRound} disabled={!pool.length}>
              {queue ? 'Next round' : mastered || familiar ? 'Keep going' : 'Start'} <ChevronRight size={15} />
            </button>
          )}
          {!finished && (mastered > 0 || familiar > 0) && !queue && (
            <button className="btn" onClick={() => save({})}>
              <RotateCcw size={14} /> Reset progress
            </button>
          )}
        </div>
      </div>
    );
  }

  const prompt = q.mode === 'choose' ? q.card.front : q.card.back;
  const rightText = (q.mode === 'choose' ? q.card.back : q.card.front).trim();
  return (
    <div className="st-cards sm-learn">
      <ProgressLine done={mastered} total={pool.length} label={`${mastered} of ${pool.length} mastered`} />
      <div className="sm-prompt">
        <div className="sm-prompt-label muted">
          {q.mode === 'choose' ? 'Term' : 'Definition'}
          {q.card.chapter ? ` · ${q.card.chapter}` : ''}
          <span className="sm-prompt-tools">
            <StarButton k={q.card.k} starred={starred.includes(q.card.k!)} onChange={(on) => setStarred((s) => (on ? [...s, q.card.k!] : s.filter((x) => x !== q.card.k)))} />
            <SpeakButton text={prompt} />
          </span>
        </div>
        <div className="sm-prompt-text"><MathText text={prompt} /></div>
      </div>
      {q.mode === 'write' ? (
        <div className="sm-write">
          <input ref={input} value={given} onChange={(e) => result === null && setGiven(e.target.value)} placeholder="Type the term" spellCheck={false} autoCapitalize="off" disabled={result !== null} />
          {result === null && (
            <button className="btn primary" onClick={check} disabled={!given.trim()}>
              Check
            </button>
          )}
        </div>
      ) : (
        <div className="st-choices sm-choices">
          {q.choices!.map((c, i) => {
            const isRight = c === rightText;
            return (
              <button key={i} className={`st-choice ${picked === i ? 'on' : ''} ${result !== null && isRight ? 'correct' : ''} ${result === false && picked === i ? 'incorrect' : ''}`} onClick={() => result === null && setPicked(i)} disabled={result !== null}>
                <span className="st-letter">{i + 1}</span>
                <span><MathText text={c} /></span>
              </button>
            );
          })}
          {result === null && (
            <button className="btn primary sm-check" onClick={check} disabled={picked == null}>
              Check
            </button>
          )}
        </div>
      )}
      {result === 'checking' && <div className="muted sm-feedback">Checking…</div>}
      {(result === true || result === false) && (
        <div className={`sm-feedback ${result ? 'right' : 'wrong'}`}>
          <b>{result ? 'Right.' : 'Not quite.'}</b> {!result && <span>The answer is <b><MathText text={rightText} /></b>.</span>}
          {result === false && q.mode === 'write' && (
            <button className="btn sm" onClick={override} title="Kea marked this wrong, but it means the same thing">
              <Check size={13} /> I was right
            </button>
          )}
          <button className="btn primary sm" onClick={next}>
            Continue <ChevronRight size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

// ---------- Match ----------
type Tile = { id: number; pair: number; text: string; side: 'front' | 'back' };
const MATCH_PAIRS = 6;

export function Match({ set }: { set: StudySetFull }) {
  const cards = set.cards || [];
  const [tiles, setTiles] = useState<Tile[] | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [gone, setGone] = useState<Set<number>>(new Set());
  const [miss, setMiss] = useState<number[]>([]);
  const [start, setStart] = useState(0);
  const [penalty, setPenalty] = useState(0);
  const [now, setNow] = useState(0);
  const [done, setDone] = useState<number | null>(null);
  const [best, setBest] = useState<number | null>(set.matchBest ?? null);
  const play = () => {
    const pick = shuffle(cards).slice(0, Math.min(MATCH_PAIRS, cards.length));
    const t: Tile[] = [];
    pick.forEach((c, i) => {
      t.push({ id: i * 2, pair: i, text: c.front, side: 'front' });
      t.push({ id: i * 2 + 1, pair: i, text: c.back.length > 140 ? `${c.back.slice(0, 137)}…` : c.back, side: 'back' });
    });
    setTiles(shuffle(t));
    setGone(new Set());
    setSel(null);
    setMiss([]);
    setPenalty(0);
    setDone(null);
    setStart(Date.now());
    setNow(Date.now());
  };
  useEffect(() => {
    if (!tiles || done != null) return;
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, [tiles, done]);
  const tap = (t: Tile) => {
    if (gone.has(t.id) || done != null) return;
    if (sel == null || sel === t.id) return setSel(sel === t.id ? null : t.id);
    const a = tiles!.find((x) => x.id === sel)!;
    if (a.pair === t.pair && a.side !== t.side) {
      const g = new Set(gone);
      g.add(a.id);
      g.add(t.id);
      setGone(g);
      setSel(null);
      if (g.size === tiles!.length) {
        const ms = Date.now() - start + penalty;
        setDone(ms);
        api.scholar.studyMatch(set.id, ms).then((b) => setBest(b));
      }
    } else {
      // A wrong pair costs a second.
      setMiss([a.id, t.id]);
      setPenalty((p) => p + 1000);
      setSel(null);
      setTimeout(() => setMiss([]), 450);
    }
  };
  const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  if (cards.length < 2) return <div className="sch-empty">Match needs at least two cards.</div>;
  if (!tiles)
    return (
      <div className="st-cards sm-match-setup">
        <h2>Match</h2>
        <p className="muted">Match each term with its definition as fast as you can. A wrong pair adds a second.</p>
        {best != null && (
          <p>
            <Trophy size={14} /> Your best: <b>{secs(best)}</b>
          </p>
        )}
        <button className="btn primary" onClick={play}>
          Start
        </button>
      </div>
    );
  return (
    <div className="sm-match">
      <div className="sm-match-bar">
        <span>
          <Timer size={14} /> {secs((done ?? now - start) + (done == null ? penalty : 0))}
          {penalty > 0 && done == null && <span className="muted"> (+{penalty / 1000}s)</span>}
        </span>
        {best != null && <span className="muted">Best {secs(best)}</span>}
        <button className="btn sm" onClick={play}>
          <RotateCcw size={13} /> Restart
        </button>
      </div>
      {done != null ? (
        <div className="sm-match-done">
          <Trophy size={28} />
          <h2>{secs(done)}</h2>
          <p className="muted">{best != null && done <= best ? 'A new best time.' : best != null ? `Your best is ${secs(best)}.` : ''}</p>
          <button className="btn primary" onClick={play}>
            Play again
          </button>
        </div>
      ) : (
        <div className="sm-match-grid">
          {tiles.map((t) => (
            <button key={t.id} className={`sm-tile ${t.side} ${sel === t.id ? 'on' : ''} ${gone.has(t.id) ? 'gone' : ''} ${miss.includes(t.id) ? 'miss' : ''}`} onClick={() => tap(t)} disabled={gone.has(t.id)}>
              {t.text}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- Test (from a deck) ----------
/** A practice test made from cards: pick the definition, type the term, or true/false on a pairing. */
function cardQuestions(cards: StudyCard[]): StudyQuestion[] {
  return shuffle(cards).map((c, i) => {
    const base = { explain: `${c.front}: ${c.back}`, chapter: c.chapter, section: c.section || null, topic: c.topic || null, source: null };
    const kind = cards.length >= 4 ? i % 5 : 4;
    if ((kind === 1 || kind === 3) && words(c.front) <= 6) return { ...base, k: `${c.k}-w`, type: 'blank', q: `${c.back}\n\nThe term: ____`, answer: c.front, accept: [] } as StudyQuestion;
    if (kind === 4 && cards.length >= 2) {
      const truth = Math.random() < 0.5;
      const other = truth ? c.back : distractors(c, cards, 'back', 1)[0] || c.back;
      return { ...base, k: `${c.k}-t`, type: 'tf', q: `${c.front}\n\n${other}`, answer: truth || other === c.back } as StudyQuestion;
    }
    const choices = shuffle([c.back.trim(), ...distractors(c, cards, 'back')]);
    return { ...base, k: `${c.k}-c`, type: 'mc', q: c.front, choices, answer: choices.indexOf(c.back.trim()) } as StudyQuestion;
  });
}
export function CardTest({ set }: { set: StudySetFull }) {
  const questions = useMemo(() => cardQuestions(set.cards || []), [set.id]);
  return <Exam set={{ ...set, kind: 'exam', questions, history: set.history || {} }} />;
}

// ---------- Spaced review ----------
type Grade = 'again' | 'good' | 'easy';
const testIn = (t: ReviewItem['test']) => {
  if (!t) return '';
  const now = new Date();
  const days = Math.round((Date.parse(`${t.date}T12:00:00`) - new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12).getTime()) / 864e5);
  return days <= 0 ? `${t.title} is today` : days === 1 ? `${t.title} is tomorrow` : `${t.title} in ${days} days`;
};

export function Review({ courseId, chapters = [], sections = [] }: { courseId: string; chapters?: string[]; sections?: string[] }) {
  const [queue, setQueue] = useState<ReviewQueue | null>(null);
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [pos, setPos] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [answer, setAnswer] = useState<Answer>(null);
  const [revealed, setRevealed] = useState(false);
  const [judged, setJudged] = useState<boolean | undefined>(undefined);
  const [self, setSelf] = useState<boolean | undefined>(undefined);
  const [tally, setTally] = useState({ again: 0, good: 0, easy: 0 });
  // Studying ahead: the unseen questions too, past today's few new ones.
  const [ahead, setAhead] = useState(false);
  const load = (more = ahead) =>
    api.scholar.studyReview({ courseId, chapters, sections, ...(more ? { newPerDay: 1000, limit: 30 } : {}) }).then((q) => {
      setQueue(q);
      // Due ones first; new ones mixed in among them so a session isn't all new at the end.
      const fresh = [...q.fresh];
      const out: ReviewItem[] = [];
      for (const d of q.due) {
        out.push(d);
        if (fresh.length && out.length % 4 === 3) out.push(fresh.shift()!);
      }
      setItems([...out, ...fresh]);
      setPos(0);
      clear();
    });
  useEffect(() => {
    load();
  }, [courseId, chapters.join('|'), sections.join('|')]);
  const clear = () => (setFlipped(false), setAnswer(null), setRevealed(false), setJudged(undefined), setSelf(undefined));
  const it = items[pos];
  const shown: Shown | null = useMemo(() => {
    if (!it || it.kind !== 'question') return null;
    const q = it.item as StudyQuestion;
    return { q, order: 'choices' in q ? shuffle(q.choices.map((_, i) => i)) : [] };
  }, [it?.k, pos]);
  const result = shown && revealed ? grade(shown, answer, self, judged) : null;
  const reading = useContext(ReadingContext);
  const missReading = useMissReading();
  // The textbook beside it is the class of the item in front of the student.
  useEffect(() => {
    if (it) reading.course?.(it.courseId);
  }, [it?.courseId]);
  const lookUp = () => {
    if (!it) return;
    const x = it.item as StudyCard & StudyQuestion;
    missReading({ chapter: it.chapter, section: x.section, topic: x.topic, query: it.kind === 'card' ? `${x.front} ${x.back}` : `${x.q} ${typeof x.answer === 'string' ? x.answer : ''}`, key: it.k, steps: it.kind === 'card' ? undefined : x.steps });
  };
  useEffect(() => {
    if (result === false) lookUp();
  }, [result]);
  useEffect(() => {
    if (!shown || !revealed || shown.q.type !== 'blank' || judged !== undefined) return;
    const q = shown.q;
    judgeBlank(typeof answer === 'string' ? answer : '', q.answer, q.accept || [], q.q).then(setJudged);
  }, [revealed, shown]);
  const mark = (g: Grade) => {
    if (!it) return;
    if (g === 'again' && it.kind === 'card') lookUp();
    api.scholar.studyReviewMark(it.k, g, { courseId: it.courseId, chapter: it.chapter });
    setTally((t) => ({ ...t, [g]: t[g] + 1 }));
    // Missed: it comes again at the end of this session.
    if (g === 'again') setItems((list) => [...list, it]);
    setPos((p) => p + 1);
    clear();
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!it || (e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA') return;
      if (it.kind === 'card') {
        if ((e.key === ' ' || e.key === 'Enter') && !flipped) (e.preventDefault(), setFlipped(true));
        else if (flipped && ['1', '2', '3'].includes(e.key)) mark((['again', 'good', 'easy'] as const)[Number(e.key) - 1]);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  if (!queue) return <div className="spinner" />;
  const total = items.length;
  const unseen = Object.values(queue.counts).reduce((n, c) => n + c.fresh, 0);
  if (!total)
    return (
      <div className="st-cards sm-review-done">
        <h2>Nothing due right now</h2>
        <p className="muted">Everything you've studied is scheduled to come back before its test, and today's new questions are done.</p>
        {unseen > 0 && (
          <button
            className="btn primary"
            onClick={() => {
              setAhead(true);
              load(true);
            }}
          >
            Study ahead: {Math.min(30, unseen)} of {unseen} new questions
          </button>
        )}
      </div>
    );
  if (pos >= total)
    return (
      <div className="st-cards sm-review-done">
        <Trophy size={28} />
        <h2>Review done</h2>
        <p className="muted">
          {tally.good + tally.easy} remembered, {tally.again} to practise again. Each one is scheduled to come back, before its test when there is one.
        </p>
        <button className="btn" onClick={() => load()}>
          Check for more
        </button>
      </div>
    );
  const card = it.kind === 'card' ? (it.item as StudyCard) : null;
  return (
    <div className="st-cards sm-review">
      <ProgressLine done={pos} total={total} label={`${pos} of ${total} · ${queue.due.length} due, ${queue.fresh.length} new`} />
      <div className="sm-review-meta muted">
        <span className="st-code">{it.courseCode || 'Mine'}</span>
        {it.chapter && <span>{it.chapter}</span>}
        {it.box == null && <span className="sm-new">New</span>}
        {it.test && <span className="sm-test">{testIn(it.test)}</span>}
      </div>
      {card ? (
        <>
          <button className={`st-card ${flipped ? 'flipped' : ''}`} onClick={() => setFlipped(true)}>
            <div className="st-card-side"><MathText text={flipped ? card.back : card.front} /></div>
            <div className="muted st-card-foot">{flipped ? 'How well did you know it?' : 'Think of the answer, then tap or press Space'}</div>
          </button>
          <div className="st-cards-nav">
            <SpeakButton text={flipped ? card.back : card.front} />
            {flipped ? (
              <>
                <button className="btn" onClick={() => mark('again')} title="1">
                  Didn’t know it
                </button>
                <button className="btn primary" onClick={() => mark('good')} title="2">
                  Knew it
                </button>
                <button className="btn tonal" onClick={() => mark('easy')} title="3">
                  Easy
                </button>
              </>
            ) : (
              <button className="btn primary" onClick={() => setFlipped(true)}>
                Show answer
              </button>
            )}
          </div>
        </>
      ) : (
        shown && (
          <>
            <QuestionCard num={pos + 1} s={shown} answer={answer} setAnswer={(a) => !revealed && setAnswer(a)} reveal={revealed} result={result} onSelf={setSelf} onCheck={!revealed ? () => setRevealed(true) : undefined} />
            {revealed && result !== null && (
              <div className="st-cards-nav">
                {result ? (
                  <>
                    <button className="btn primary" onClick={() => mark('good')}>
                      Next
                    </button>
                    <button className="btn tonal" onClick={() => mark('easy')}>
                      That was easy
                    </button>
                  </>
                ) : (
                  <button className="btn primary" onClick={() => mark('again')}>
                    Next (it comes back)
                  </button>
                )}
              </div>
            )}
          </>
        )
      )}
    </div>
  );
}

/** The review summary on My resources: what's due per class, and a button to start. */
/** Pick a class and its chapters, then study exactly those (topics and which questions are chosen on the Study page). */
function StudyPicker({ classes }: { classes: { id: string; code: string }[] }) {
  const [cid, setCid] = useState(classes[0]?.id || '');
  const [chapters, setChapters] = useState<{ label: string; title: string | null }[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  useEffect(() => {
    setPicked([]);
    if (cid) api.scholar.course(cid).then((c) => setChapters((c?.chapters || []).filter((ch) => ch.pdf).map((ch) => ({ label: ch.label, title: ch.title }))));
  }, [cid]);
  const code = classes.find((c) => c.id === cid)?.code || '';
  const go = () => {
    const chs = chapters.map((c) => c.label).filter((l) => picked.includes(l));
    openStudyHub({ courseId: cid, code, title: chs.length === 1 ? `${chs[0]}${chapters.find((c) => c.label === chs[0])?.title ? `: ${chapters.find((c) => c.label === chs[0])?.title}` : ''}` : `${code}: ${chs.map((c) => c.replace(/^Chapter /, 'Ch ')).join(', ')}`, chapters: chs });
  };
  return (
    <div className="sm-picker">
      <div className="hub-pick-row">
        <span className="hub-pick-label">Class</span>
        {classes.map((c) => (
          <button key={c.id} className={`st-chip ${cid === c.id ? 'on' : ''}`} onClick={() => setCid(c.id)}>
            {c.code}
          </button>
        ))}
      </div>
      <div className="hub-pick-row">
        <span className="hub-pick-label">Chapters</span>
        <button className={`st-chip ${picked.length === chapters.length && chapters.length ? 'on' : ''}`} onClick={() => setPicked(picked.length === chapters.length ? [] : chapters.map((c) => c.label))}>
          All
        </button>
        {chapters.map((ch) => {
          const on = picked.includes(ch.label);
          return (
            <button key={ch.label} className={`st-chip ${on ? 'on' : ''}`} title={ch.title || ''} onClick={() => setPicked(on ? picked.filter((x) => x !== ch.label) : [...picked, ch.label])}>
              {ch.label.replace(/^Chapter /, 'Ch ')}
            </button>
          );
        })}
      </div>
      <div className="sm-picker-go">
        <button className="btn primary sm" disabled={!picked.length} onClick={go}>
          Study {picked.length ? `${picked.length} chapter${picked.length > 1 ? 's' : ''}` : ''}
        </button>
        <span className="muted">Then pick topics and which questions (new, missed, starred).</span>
      </div>
    </div>
  );
}

export function ReviewBanner({ courseId = '' }: { courseId?: string }) {
  const version = useScholar((s) => s.version);
  const [q, setQ] = useState<ReviewQueue | null>(null);
  const [pickOpen, setPickOpen] = useState(false);
  useEffect(() => {
    api.scholar.studyReview({ courseId, limit: 1000 }).then(setQ).catch(() => {});
  }, [version, courseId]);
  if (!q) return null;
  const counts = Object.entries(q.counts).filter(([id, c]) => (!courseId || id === courseId) && c.total);
  const due = counts.reduce((n, [, c]) => n + c.due, 0);
  const fresh = Math.min(q.newToday, counts.reduce((n, [, c]) => n + c.fresh, 0));
  if (!counts.length) return null;
  const start = (id: string) => useScholar.getState().set({ study: `review:${id}` });
  const [picking, setPicking] = [pickOpen, setPickOpen];
  // Each class: what's due, how much is mastered, and its next test; the soonest test first.
  const rows = counts.sort(([, a], [, b]) => (a.test?.date || '9999').localeCompare(b.test?.date || '9999'));
  return (
    <section className="sm-banner">
      <div className="sm-banner-top">
        <div>
          <b>{due ? `${due} to review` : 'Review'}</b>
          {fresh > 0 && <span className="muted"> · {fresh} new today</span>}
          <div className="muted sm-banner-sub">Spaced so every question comes back before its test, shared between your classes.</div>
        </div>
        <button className="btn sm" onClick={() => setPicking(!picking)}>
          Choose what to study
        </button>
        <button className="btn primary sm" disabled={!due && !fresh} onClick={() => start(courseId || 'all')}>
          {due || fresh ? 'Review all' : 'All caught up'}
        </button>
      </div>
      {picking && <StudyPicker classes={rows.map(([id, c]) => ({ id, code: c.code })).filter((c) => c.code)} />}
      <div className="sm-classes">
        {rows.map(([id, c]) => {
          const days = c.test ? Math.round((Date.parse(`${c.test.date}T12:00`) - Date.now()) / 864e5) : null;
          return (
            <button key={id} className="sm-class" onClick={() => start(id)} title={`Review ${c.code || 'your own sets'} only`}>
              <b>{c.code || 'Mine'}</b>
              <span className="sm-class-bar">
                <i style={{ width: `${((c.mastered || 0) / c.total) * 100}%` }} />
              </span>
              <span className="muted">
                {c.due ? `${c.due} due` : 'caught up'}
                {days != null && days >= 0 && days <= 14 ? ` · test ${days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days}d`}` : ''}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

// ---------- Making a set yourself (or pasting one from Quizlet) ----------
type Row = { front: string; back: string; chapter?: string | null };
const TERM_SEPS = [
  ['\t', 'Tab'],
  [',', 'Comma'],
  [' - ', 'Dash ( - )'],
  [':', 'Colon']
] as const;
const ROW_SEPS = [
  ['\n', 'New line'],
  [';', 'Semicolon'],
  ['\n\n', 'Blank line']
] as const;

/** Text from Quizlet's Export (or any list) as cards: one card per row, term and definition split at the first separator. */
export function parsePasted(text: string, termSep: string, rowSep: string): Row[] {
  const rows = rowSep === '\n' ? text.split(/\r?\n/) : rowSep === '\n\n' ? text.split(/\r?\n\s*\r?\n/) : text.split(rowSep);
  const out: Row[] = [];
  for (const r of rows) {
    const line = r.replace(/\r/g, '').trim();
    if (!line) continue;
    const at = line.indexOf(termSep);
    if (at < 0) continue;
    const front = line.slice(0, at).trim();
    const back = line.slice(at + termSep.length).trim();
    if (front && back) out.push({ front, back });
  }
  return out;
}

export function SetEditor({ id, startWithImport, onClose }: { id?: string; startWithImport?: boolean; onClose(): void }) {
  const [courses, setCourses] = useState<ScholarCourse[]>([]);
  const [title, setTitle] = useState('');
  const [courseId, setCourseId] = useState('');
  const [rows, setRows] = useState<Row[]>([{ front: '', back: '' }, { front: '', back: '' }, { front: '', back: '' }]);
  const [importing, setImporting] = useState(!!startWithImport);
  const [paste, setPaste] = useState('');
  const [termSep, setTermSep] = useState('\t');
  const [rowSep, setRowSep] = useState('\n');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.scholar.courses().then((c) => setCourses(c)).catch(() => {});
    if (id)
      api.scholar.studyGet(id).then((s) => {
        if (!s) return;
        setTitle(s.title);
        setCourseId(s.courseId || '');
        setRows((s.cards || []).map((c) => ({ front: c.front, back: c.back, chapter: c.chapter })));
      });
  }, [id]);
  const parsed = useMemo(() => parsePasted(paste, termSep, rowSep), [paste, termSep, rowSep]);
  const filled = rows.filter((r) => r.front.trim() && r.back.trim());
  const setRow = (i: number, p: Partial<Row>) => setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...p } : r)));
  const save = async () => {
    setBusy(true);
    try {
      const newId = await api.scholar.studySaveMine({ id, title: title.trim() || 'My cards', courseId, cards: filled });
      reloadScholar();
      toast(id ? 'Set saved.' : `Made “${title.trim() || 'My cards'}” with ${filled.length} cards.`, 'success');
      useScholar.getState().set({ study: newId });
    } catch (err: any) {
      toast(err?.message || 'Kea couldn’t save the set.', 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="st-cards sm-editor">
      <h2>{id ? 'Edit set' : 'New set'}</h2>
      <div className="sm-editor-head">
        <input className="sm-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title, like “Chapter 5 vocabulary”" autoFocus={!id} />
        <select value={courseId} onChange={(e) => setCourseId(e.target.value)} title="Which class it's for (it joins that class's review)">
          <option value="">No class</option>
          {courses.map((c) => (
            <option key={c.id} value={c.id}>
              {c.code}
            </option>
          ))}
        </select>
        <button className={`btn sm ${importing ? 'tonal' : ''}`} onClick={() => setImporting(!importing)}>
          <ClipboardPaste size={14} /> Import
        </button>
      </div>
      {importing && (
        <section className="sm-import">
          <p className="muted">
            Paste your cards: from Quizlet, open the set, choose <b>…</b> → <b>Export</b>, copy the text and paste it here. Any list with one card per line works too.
          </p>
          <textarea value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={'mitochondria\tmakes most of the cell’s energy (ATP)\nribosome\tbuilds proteins'} rows={7} spellCheck={false} />
          <div className="sm-import-opts">
            <label>
              Between term and definition
              <select value={termSep} onChange={(e) => setTermSep(e.target.value)}>
                {TERM_SEPS.map(([v, l]) => (
                  <option key={l} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Between cards
              <select value={rowSep} onChange={(e) => setRowSep(e.target.value)}>
                {ROW_SEPS.map(([v, l]) => (
                  <option key={l} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="btn primary sm"
              disabled={!parsed.length}
              onClick={() => {
                setRows((rs) => [...rs.filter((r) => r.front.trim() || r.back.trim()), ...parsed]);
                setPaste('');
                setImporting(false);
              }}
            >
              Add {parsed.length || ''} card{parsed.length === 1 ? '' : 's'}
            </button>
          </div>
          {parsed.length > 0 && (
            <div className="sm-import-preview muted">
              First: <b>{parsed[0].front}</b> → {parsed[0].back.slice(0, 80)}
            </div>
          )}
        </section>
      )}
      <div className="sm-rows">
        {rows.map((r, i) => (
          <div key={i} className="sm-row">
            <span className="sm-row-num">{i + 1}</span>
            <textarea value={r.front} onChange={(e) => setRow(i, { front: e.target.value })} placeholder="Term" rows={1} />
            <textarea value={r.back} onChange={(e) => setRow(i, { back: e.target.value })} placeholder="Definition" rows={2} />
            <button className="icon-btn sm" title="Remove" onClick={() => setRows((rs) => rs.filter((_, k) => k !== i))}>
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
      <div className="sm-actions">
        <button className="btn" onClick={() => setRows((rs) => [...rs, { front: '', back: '' }])}>
          <Plus size={14} /> Add a card
        </button>
        <span className="muted">{filled.length} cards</span>
        <button className="btn" onClick={onClose}>
          <X size={14} /> Cancel
        </button>
        <button className="btn primary" disabled={busy || !filled.length} onClick={save}>
          <Check size={14} /> {id ? 'Save' : 'Create set'}
        </button>
      </div>
    </div>
  );
}
