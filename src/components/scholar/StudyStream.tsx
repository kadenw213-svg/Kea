// The Study stream: tick chapters, Start, and questions come one after another until Exit (or Esc). No counters, no
// score, no end: a miss comes back a few questions later, and once everything has been seen it keeps going round, misses
// first (the order is src/lib/studyQueue.ts, shared with the phone). Multiple choice and true-or-false check on the
// click; Enter (or Next) goes on. A right answer shows a line of why; a wrong one the whole explanation and walkthrough.
//
// Answers are saved under one bucket per class, `stream-<courseId>` (no set file), every 10 answers and on leaving,
// each exactly once. A fill-in-the-blank still being marked is held until it is. An answer to a question shown again
// after a miss is saved as a relearn answer ([k, ok, 'r']), which doesn't count towards what's learned.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { api, StudyHistory, StudyQuestion, StudySetFull } from '../../lib/api';
import { useScholar } from './scholarStore';
import { Answer, QuestionCard, Shown, grade, showQuestion } from './Study';
import { StarButton } from './StudyModes';
import { judgeBlank } from '../../lib/blank';
import { createLog, createQueue, Served } from '../../lib/studyQueue';
import { streamSettings, studyMix } from '../../lib/studyMix';
import { playRight, playWrong } from '../../lib/sound';

/** What a stream asks: chapters (or some of their topics), and/or the class's bookmarked questions. */
export interface StreamScope {
  courseId: string;
  code: string;
  /** The chapters ticked, in the class's order. */
  chapters: string[];
  /** Only some topics ticked: "chapter \0 section" for each. (Not given: the whole of each chapter.) */
  topics?: string[];
  /** The class's bookmarked questions too (or only them, with no chapters). */
  bookmarks?: boolean;
  /** Every chapter of the class ticked: one chapter at a time in curriculum order. */
  progression?: boolean;
}

/** Open the stream (in the full-window player). */
export const openStream = (scope: StreamScope) => useScholar.getState().set({ study: `stream:${encodeURIComponent(JSON.stringify(scope))}` });
export const parseStream = (id: string): StreamScope | null => {
  try {
    return JSON.parse(decodeURIComponent(id.slice(7)));
  } catch {
    return null;
  }
};
const short = (label: string) => label.replace(/^Chapter /, 'Ch ');
/** The header's words: the class and its chapters. */
export function streamTitle(code: string, chapters: string[], bookmarks?: boolean) {
  const chs = chapters.length > 4 ? `${chapters.slice(0, 3).map(short).join(', ')} and ${chapters.length - 3} more` : chapters.map(short).join(', ');
  return [code, [chs, bookmarks ? 'Bookmarked' : ''].filter(Boolean).join(' · ')].filter(Boolean).join(' · ');
}

type Item = StudyQuestion & { k: string; type: string; chapter: string | null; level?: string | null };
const given = (a: Answer) => a !== null && a !== '' && !(Array.isArray(a) && !a.length);
/** Kinds checked by a click on a choice. */
const ONE_CLICK = new Set(['mc', 'tf']);

interface Card {
  served: Served<Item>;
  shown: Shown;
  /** Its place in the save log once it's been moved past (null while it's on screen). */
  logged: number | null;
  /** The blank's mark from judgeBlank, once it's come. */
  judged?: boolean;
}

/** `set`: a saved practice set's questions ("Take"); otherwise the class's questions in `scope`. */
export function StudyStream({ scope, set }: { scope?: StreamScope; set?: StudySetFull }) {
  const courseId = scope?.courseId || set?.courseId || '';
  const bucket = `stream-${(courseId || 'mine').replace(/[^A-Za-z0-9-]+/g, '-')}`;
  const [data, setData] = useState<{ items: Item[]; history: Record<string, StudyHistory>; starred: Set<string>; order: string[] } | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      const src = set || (await api.scholar.studyGet(`stream:${courseId}`).catch(() => null));
      const course = courseId ? await api.scholar.course(courseId).catch(() => null) : null;
      const starred = new Set(src?.starred || []);
      const topics = scope?.topics ? new Set(scope.topics) : null;
      const chapters = new Set(scope?.chapters || []);
      const all = ((src?.questions || []) as Item[]).filter((q) => q.k);
      const items = set
        ? all
        : all.filter((q) => (q.chapter && chapters.has(q.chapter) && (!topics || topics.has(`${q.chapter}\u0000${q.section || 'Other'}`))) || (scope?.bookmarks && starred.has(q.k)));
      // (The class's chapters in curriculum order; anything else after, as it comes.)
      const order = (course?.chapters || []).map((c) => c.label);
      if (live) setData({ items, history: src?.history || {}, starred, order });
    })();
    return () => {
      live = false;
    };
  }, [courseId, set?.id]);

  const queue = useMemo(() => {
    if (!data) return null;
    const s = streamSettings();
    return createQueue(data.items, { history: data.history, chapters: data.order, progression: !!scope?.progression, mix: studyMix(), missGap: s.missGap, reviewShare: s.reviewShare, learnedAt: s.learnedAt });
  }, [data]);
  const log = useRef(createLog());
  const [card, setCard] = useState<Card | null>(null);
  const [answer, setAnswerRaw] = useState<Answer>(null);
  const [revealed, setRevealed] = useState(false);
  const [dunno, setDunno] = useState(false);
  const [self, setSelf] = useState<boolean | undefined>(undefined);
  const [judged, setJudged] = useState<boolean | undefined>(undefined);
  const [starred, setStarred] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!queue) return;
    setStarred(new Set(data!.starred));
    load();
  }, [queue]);

  const load = () => {
    const served = queue?.next();
    setCard(served ? { served, shown: showQuestion(served.item), logged: null } : null);
    setAnswerRaw(null);
    setRevealed(false);
    setDunno(false);
    setSelf(undefined);
    setJudged(undefined);
    document.querySelector('.st-main')?.scrollTo({ top: 0 });
  };

  const result = card && revealed ? (dunno ? false : grade(card.shown, answer, self, judged)) : null;
  /** What's saved: a miss on a question whose stored answer may be wrong counts neither way. */
  const saved = (r: boolean | null) => (r === false && card?.shown.q.answerDisputed ? null : r);

  // Save what's waiting (every 10 answers, and everything on leaving).
  const flush = (final: boolean) => {
    const items = log.current.take(final);
    if (!items.length) return;
    const marked = items.filter(([, ok]) => ok != null);
    api.scholar.studyAttempt(bucket, { score: marked.filter(([, ok]) => ok).length, total: marked.length, n: items.length, items, final } as any).catch(() => {});
  };
  /** The card on screen into the log (when it's moved past, or on leaving with its answer showing). */
  const record = (c: Card, r: boolean | null) => {
    if (c.logged != null) return;
    const blankWaiting = c.shown.q.type === 'blank' && !dunno && self === undefined && c.judged === undefined;
    c.logged = log.current.add(c.served.item.k, blankWaiting ? null : saved(r), c.served.relearn, blankWaiting);
    if (!blankWaiting) queue?.answer(c.served, r);
  };
  const latest = useRef({ card, revealed, result, record, flush });
  latest.current = { card, revealed, result, record, flush };
  useEffect(() => {
    const leave = () => {
      const l = latest.current;
      if (l.card && l.revealed) l.record(l.card, l.result);
      l.flush(true);
    };
    window.addEventListener('beforeunload', leave);
    return () => (window.removeEventListener('beforeunload', leave), leave());
  }, []);

  const next = () => {
    if (!card || !revealed) return;
    record(card, result);
    if (log.current.waiting() >= 10) flush(false);
    load();
  };

  // A blank is marked by Kea's own matching (then the local model); the mark may come after the card has moved on.
  const reveal = (a: Answer = answer) => {
    if (!card || revealed) return;
    setRevealed(true);
    const q = card.shown.q;
    if (q.type === 'blank') {
      const c = card;
      judgeBlank(typeof a === 'string' ? a : '', q.answer, q.accept || [], q.q).then((ok) => {
        c.judged = ok;
        if (c.logged != null) {
          log.current.mark(c.logged, ok === false && q.answerDisputed ? null : ok);
          queue?.answer(c.served, ok);
        } else if (latest.current.card === c) setJudged(ok);
      });
    }
  };
  const setAnswer = (a: Answer) => {
    if (revealed || !card) return;
    setAnswerRaw(a);
    if (ONE_CLICK.has(card.shown.q.type)) reveal(a);
  };

  // A sound when the verdict comes (if turned on).
  const sounded = useRef<number | null>(null);
  useEffect(() => {
    if (!card || !revealed || result == null || sounded.current === card.served.at) return;
    sounded.current = card.served.at;
    if (!streamSettings().sound) return;
    if (result) playRight();
    else playWrong();
    // TODO(phone): a light haptic tap here once @capacitor/haptics is part of the phone app (not added: no new deps).
  }, [card, revealed, result]);

  // Keys: 1–9 pick a choice, Enter goes on. In a text box Enter checks first; the next Enter goes on.
  const keys = useRef({ card, revealed, answer, next, reveal, setAnswer });
  keys.current = { card, revealed, answer, next, reveal, setAnswer };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = keys.current;
      if (!k.card || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName || '';
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!t?.isContentEditable;
      const q = k.card.shown.q;
      if (e.key === 'Enter' && !e.shiftKey) {
        if (typing) {
          if (tag === 'INPUT' && !k.revealed && given(k.answer)) (e.preventDefault(), k.reveal());
          return;
        }
        e.preventDefault();
        if (k.revealed) k.next();
        else if (given(k.answer)) k.reveal();
        return;
      }
      if (typing || k.revealed || !/^[1-9]$/.test(e.key)) return;
      const pos = Number(e.key) - 1;
      if (q.type === 'tf' && pos < 2) k.setAnswer(pos === 0);
      else if (q.type === 'mc' && pos < k.card.shown.order.length) k.setAnswer(pos);
      else if (q.type === 'multi' && pos < k.card.shown.order.length) {
        const cur = Array.isArray(k.answer) ? (k.answer as number[]) : [];
        k.setAnswer(cur.includes(pos) ? cur.filter((x) => x !== pos) : [...cur, pos]);
      } else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!data) return <div className="spinner" />;
  if (!card)
    return (
      <div className="st-stream">
        <div className="sch-empty">{scope?.bookmarks && !scope.chapters.length ? 'No saved questions yet. Tap the bookmark on any question to keep it here.' : 'No questions here yet.'}</div>
      </div>
    );
  const q = card.shown.q;
  return (
    <div className="st-stream">
      <div key={card.served.at} className="st-stream-card">
        <QuestionCard
          s={card.shown}
          answer={answer}
          setAnswer={setAnswer}
          reveal={revealed}
          result={result}
          onSelf={(ok) => setSelf(ok)}
          dunno={dunno}
          onDontKnow={!revealed ? () => (setDunno(true), setRevealed(true)) : undefined}
          onCheck={!revealed && !ONE_CLICK.has(q.type) && given(answer) ? () => reveal() : undefined}
          brief
        />
        <div className="st-stream-foot">
          <StarButton k={card.served.item.k} starred={starred.has(card.served.item.k)} label onChange={(on) => setStarred((s) => (on ? new Set([...s, card.served.item.k]) : new Set([...s].filter((x) => x !== card.served.item.k))))} />
          <span className="grow" />
          {revealed && (
            <button className="btn primary" onClick={next} autoFocus>
              Next <ArrowRight size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
