// Studying a class: its chapters, each opening to its topics; tick what to study and Start goes straight into a practice
// exam of those questions, one at a time with the explanation after each (or at the end, like a test). The mix of
// question kinds follows Settings (Practice questions, under Advanced). Opened from a class's Study button, a chapter,
// or a test (its chapters ticked already).
import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronRight, ClipboardList, Image, Loader2, Minus, Sparkles } from 'lucide-react';
import { api, PoolItem, ReviewQueue, ScholarChapter } from '../../lib/api';
import { toast } from '../../store';
import { pickByMix } from '../../lib/studyMix';
import { useScholar } from './scholarStore';
import { SetRow, shuffle, useCanMake, useStudySets } from './Study';

export interface StudyScope {
  courseId: string;
  code: string;
  title: string;
  chapters: string[];
  /** The test or assignment it's for, when there is one. */
  itemId?: string;
  /** The chapters ticked when it opens (all of them when not given and there are three or fewer). */
  selected?: string[];
}

/** Open the Study page for a scope (in the full-window player). */
export const openStudyHub = (scope: StudyScope) => useScholar.getState().set({ study: `hub:${encodeURIComponent(JSON.stringify(scope))}` });
/** A class's Study page: every chapter, none ticked yet (or the ones given). */
export const openClassStudy = (c: { id: string; code: string }, chapters: string[], selected?: string[]) => openStudyHub({ courseId: c.id, code: c.code, title: 'Study', chapters, selected: selected || [] });
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
// The same scope always opens the same practice exam, so its scores build up.
const stableId = (kind: string, s: StudyScope) => stableStudyId(`${kind}-hub`, [s.courseId, s.itemId || '', ...s.chapters]);
const SIZES = [10, 25, 50];
type Which = 'all' | 'new' | 'missed' | 'starred';
const WHICH: [Which, string][] = [
  ['all', 'All'],
  ['missed', 'Ones I missed'],
  ['new', 'Not seen yet'],
  ['starred', 'Starred']
];
const isMissed = (p: PoolItem) => p.lastRight === false || (p.seen > 0 && p.right < p.seen && p.lastRight !== true);
const isNew = (p: PoolItem) => !p.seen && p.box == null;
const matches = (w: Which) => (p: PoolItem) => (w === 'new' ? isNew(p) : w === 'missed' ? isMissed(p) : w === 'starred' ? p.starred : true);
const short = (label: string) => label.replace(/^Chapter /, 'Ch ');
const topicOf = (p: PoolItem) => `${p.chapter || ''}\u0000${p.section || 'Other'}`;

/** A remembered choice on this device. */
function useStored<T>(key: string, start: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const s = localStorage.getItem(key);
      return s == null ? start : (JSON.parse(s) as T);
    } catch {
      return start;
    }
  });
  return [
    v,
    (x: T) => {
      setV(x);
      try {
        localStorage.setItem(key, JSON.stringify(x));
      } catch {}
    }
  ];
}

export function StudyHub({ scope }: { scope: StudyScope }) {
  const sets = useStudySets();
  const canMake = useCanMake();
  const [q, setQ] = useState<ReviewQueue | null>(null);
  const [pool, setPool] = useState<PoolItem[] | null>(null);
  const [titles, setTitles] = useState<Map<string, string>>(new Map());
  const [size, setSize] = useStored('kea.examSize', 25);
  // One at a time with the answer after each (the default), or all at the end like the real test.
  const [instant, setInstantRaw] = useState(() => {
    try {
      return localStorage.getItem('kea.examInstant') !== '0';
    } catch {
      return true;
    }
  });
  const setInstant = (v: boolean) => {
    setInstantRaw(v);
    try {
      localStorage.setItem('kea.examInstant', v ? '1' : '0');
    } catch {}
  };
  const [which, setWhich] = useState<Which>('all');
  const [busy, setBusy] = useState('');
  // The options are open on a wide screen; on a phone they fold into one line under Start.
  const [opts, setOpts] = useState(false);
  const [open, setOpen] = useState<string[]>(() => (scope.chapters.length === 1 ? scope.chapters : []));
  // What's ticked: topics, as "chapter \0 section". Filled in once the questions are read.
  const [ticked, setTicked] = useState<Set<string> | null>(null);

  useEffect(() => {
    api.scholar
      .studyPool({ courseId: scope.courseId, chapters: scope.chapters })
      .then(setPool)
      .catch(() => setPool([]));
  }, [scope.courseId, scope.chapters.join('|'), sets?.length]);
  useEffect(() => {
    api.scholar
      .course(scope.courseId)
      .then((c) => setTitles(new Map((c?.chapters || []).map((ch: ScholarChapter) => [ch.label, ch.title || '']))))
      .catch(() => {});
    api.scholar
      .studyReview({ courseId: scope.courseId, chapters: scope.chapters, limit: 1000 })
      .then(setQ)
      .catch(() => setQ(null));
  }, [scope.courseId, scope.chapters.join('|')]);

  // Each chapter's topics (textbook sections) and their questions.
  const tree = useMemo(() => {
    const by = new Map<string, Map<string, PoolItem[]>>(scope.chapters.map((ch) => [ch, new Map()]));
    for (const p of pool || []) {
      const ch = p.chapter || scope.chapters[0];
      if (!by.has(ch)) by.set(ch, new Map());
      const t = p.section || 'Other';
      by.get(ch)!.set(t, [...(by.get(ch)!.get(t) || []), p]);
    }
    for (const [ch, topics] of by) by.set(ch, new Map([...topics].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))));
    return by;
  }, [pool, scope.chapters.join('|')]);
  useEffect(() => {
    if (!pool || ticked) return;
    const start = scope.selected ?? (scope.itemId || scope.chapters.length <= 3 ? scope.chapters : []);
    setTicked(new Set(pool.filter((p) => start.includes(p.chapter || scope.chapters[0])).map(topicOf)));
  }, [pool]);

  const sel = ticked || new Set<string>();
  const inPick = (pool || []).filter((p) => sel.has(topicOf(p)));
  const picked = inPick.filter(matches(which));
  const n = Math.min(size, picked.length);
  const c = q?.counts[scope.courseId];
  const days = c?.test ? Math.round((Date.parse(`${c.test.date}T12:00`) - Date.now()) / 864e5) : null;
  // The chapters ticked (by any of their topics, or the chapter itself when it has no questions yet).
  const tickedChapters = scope.chapters.filter((ch) => [...sel].some((k) => k.startsWith(`${ch}\u0000`)));
  const target = scope.itemId ? { itemId: scope.itemId } : { chapters: tickedChapters.length ? tickedChapters : scope.chapters };
  // A chapter being written now (a set still being made for it alone).
  const writing = (ch: string) => (sets || []).some((st) => st.courseId === scope.courseId && st.status === 'making' && st.kind === 'exam' && st.chapters.length === 1 && st.chapters[0] === ch);
  const toWrite = tickedChapters.filter((ch) => !writing(ch));
  // 25 new questions for each ticked chapter (one set each, written one after another on your Claude plan).
  const writeTicked = async () => {
    setBusy('write');
    try {
      for (const ch of toWrite) await api.scholar.studyMake({ kind: 'exam', courseId: scope.courseId, chapters: [ch], count: 25, mode: 'new' });
      useScholar.getState().set({ version: useScholar.getState().version + 1 });
      toast(`Writing 25 questions for ${toWrite.length === 1 ? short(toWrite[0]) : `each of ${toWrite.length} chapters`}, each with its walkthrough. A chapter takes a few minutes.`, 'success');
    } catch (err: any) {
      toast(err?.message || 'Kea couldn’t start that.', 'error');
    } finally {
      setBusy('');
    }
  };
  const chapterList = (chs: string[]) => (chs.length <= 4 ? chs.map(short).join(', ') : `${chs.slice(0, 3).map(short).join(', ')} and ${chs.length - 3} more`);
  const mine = (sets || []).filter((s) => s.courseId === scope.courseId && (scope.itemId ? s.itemId === scope.itemId : s.chapters.join('|') === scope.chapters.join('|')) && s.kind === 'exam' && s.attempts > 0);
  const mastered = inPick.filter((p) => p.lastRight === true).length;
  const learning = inPick.filter((p) => p.lastRight === false).length;

  const toggle = (keys: string[], on: boolean) => {
    const next = new Set(sel);
    keys.forEach((k) => (on ? next.add(k) : next.delete(k)));
    setTicked(next);
  };
  const start = async () => {
    setBusy('exam');
    try {
      // Missed ones first, then new ones, then the rest; the mix of kinds from Settings.
      const ordered = [...shuffle(picked.filter(isMissed)), ...shuffle(picked.filter((p) => !isMissed(p) && isNew(p))), ...shuffle(picked.filter((p) => !isMissed(p) && !isNew(p)))];
      const keys = pickByMix(ordered, n).map((p) => p.k);
      // (Named for the chapters picked, in the class's order; a test keeps its own name.)
      const chapters = scope.chapters.filter((ch) => picked.some((p) => (p.chapter || scope.chapters[0]) === ch));
      const id = await api.scholar.studyMake({ id: stableId('exam-pick', { ...scope, chapters }), kind: 'exam', courseId: scope.courseId, ...(scope.itemId ? { itemId: scope.itemId } : { chapters }), mode: 'saved', count: keys.length, pick: keys });
      useScholar.getState().set({ study: id + (instant ? '#exam-instant' : '#exam') });
    } catch (err: any) {
      toast(err?.message || 'Kea couldn’t open it.', 'error');
    } finally {
      setBusy('');
    }
  };
  const chapterTitle = (ch: string) => titles.get(ch) || '';
  const keysOf = (ch: string, topics: Map<string, PoolItem[]>) => (topics.size ? [...topics.keys()].map((t) => `${ch}\u0000${t}`) : [`${ch}\u0000*`]);
  const allKeys = [...tree].flatMap(([ch, topics]) => keysOf(ch, topics));

  return (
    <div className="hub">
      <div className="hub-head">
        <span className="hub-code">{scope.code}</span>
        <h2>{scope.title}</h2>
        <div className="muted">
          {scope.chapters.length === 1 ? `${short(scope.chapters[0])}${chapterTitle(scope.chapters[0]) && scope.title !== `${scope.chapters[0]}: ${chapterTitle(scope.chapters[0])}` ? `: ${chapterTitle(scope.chapters[0])}` : ''}` : 'Pick the chapters or topics to study'}
          {c?.test && days != null && days >= 0 ? ` · ${c.test.title} ${days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`}` : ''}
        </div>
      </div>

      <div className="hub-tree">
        <div className="hub-tree-head">
          <span className="tb-h">Chapters</span>
          {allKeys.length > 0 && (
            <button className="link-btn" onClick={() => toggle(allKeys, sel.size < allKeys.length)}>
              {sel.size < allKeys.length ? 'Select all' : 'Clear'}
            </button>
          )}
        </div>
        {!pool ? (
          <div className="hub-tree-loading">
            <Loader2 size={16} className="spin" />
          </div>
        ) : (
          [...tree].map(([ch, topics]) => {
            const keys = keysOf(ch, topics);
            const count = [...topics.values()].reduce((a, l) => a + l.length, 0);
            const on = keys.filter((k) => sel.has(k)).length;
            const state = !on ? 'none' : on === keys.length ? 'all' : 'some';
            const isOpen = open.includes(ch);
            const right = [...topics.values()].flat().filter((p) => p.lastRight === true).length;
            return (
              <div key={ch} className={`hub-ch ${state !== 'none' ? 'on' : ''} ${count ? '' : 'empty'}`}>
                <div className="hub-ch-row">
                  <button className={`hub-tick ${state}`} onClick={() => toggle(keys, state !== 'all')} aria-label={`Tick ${ch}`}>
                    {state === 'all' ? <Check size={13} /> : state === 'some' ? <Minus size={13} /> : null}
                  </button>
                  <button className="hub-ch-main" onClick={() => (topics.size > 1 ? setOpen(isOpen ? open.filter((x) => x !== ch) : [...open, ch]) : toggle(keys, state !== 'all'))}>
                    <span className="hub-ch-title">
                      <b>{short(ch)}</b> {chapterTitle(ch)}
                    </span>
                    <span className="hub-ch-sub muted">
                      {writing(ch) ? 'Being written…' : count ? `${count} questions${topics.size > 1 ? ` · ${topics.size} topics` : ''}` : 'No questions yet'}
                    </span>
                    {count > 0 && (
                      <span className="hub-ch-bar" title={`${right} of ${count} right last time`}>
                        <i style={{ width: `${(right / count) * 100}%` }} />
                      </span>
                    )}
                    {topics.size > 1 && (isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />)}
                  </button>
                </div>
                {isOpen && topics.size > 1 && (
                  <div className="hub-topics">
                    {[...topics].map(([t, list]) => {
                      const k = `${ch}\u0000${t}`;
                      return (
                        <button key={k} className={`hub-topic ${sel.has(k) ? 'on' : ''}`} onClick={() => toggle([k], !sel.has(k))}>
                          <span className={`hub-tick ${sel.has(k) ? 'all' : 'none'}`}>{sel.has(k) && <Check size={12} />}</span>
                          <span className="hub-topic-name">{t}</span>
                          <span className="hub-n">{list.length}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Start, with the few choices that matter beside it (kept on screen at the bottom). */}
      <div className="hub-practice">
        <div className="hub-practice-main">
          <ClipboardList size={22} />
          <div>
            <b>Practice exam</b>
            <span className="muted">
              {!sel.size
                ? 'Tick a chapter or topic above'
                : picked.length
                  ? `${picked.length} questions${inPick.length ? ` · ${mastered} right last time, ${learning} missed` : ''}`
                  : !inPick.length
                    ? 'No questions yet in what you ticked: write some below'
                    : 'None match what you picked'}
            </span>
          </div>
          <button className="btn primary hub-start" disabled={!n || !!busy} onClick={start}>
            {busy === 'exam' ? <Loader2 size={15} className="spin" /> : null} Start{n ? ` ${n}` : ''}
          </button>
        </div>
        {picked.length > 0 && !opts && (
          <button className="hub-opts-sum" onClick={() => setOpts(true)}>
            {n} questions · answers {instant ? 'after each question' : 'at the end'}
            {which !== 'all' ? ` · ${WHICH.find(([w]) => w === which)![1].toLowerCase()}` : ''} <span>Change</span>
          </button>
        )}
        {inPick.length > 0 && opts && (
          <div className="hub-options">
            <div className="hub-opt">
              <span>How many</span>
              <div className="hub-sizes">
                {SIZES.filter((x) => x < picked.length).map((x) => (
                  <button key={x} className={size === x ? 'on' : ''} onClick={() => setSize(x)}>
                    {x}
                  </button>
                ))}
                <button className={size >= picked.length ? 'on' : ''} onClick={() => setSize(Math.max(picked.length, 1000))}>
                  All {picked.length}
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
            <div className="hub-opt">
              <span>Which</span>
              <div className="hub-sizes">
                {WHICH.map(([w, label]) => {
                  const k = inPick.filter(matches(w)).length;
                  return (
                    <button key={w} className={which === w ? 'on' : ''} disabled={!k && w !== 'all'} onClick={() => setWhich(w)}>
                      {label} <span className="hub-n">{k}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      {mine.length > 0 && (
        <details className="hub-past">
          <summary className="tb-h">Past practice exams ({mine.length})</summary>
          <div className="st-list">
            {mine.map((s) => (
              <SetRow key={s.id} s={s} />
            ))}
          </div>
        </details>
      )}

      <div className="hub-more">
        <span className="tb-h">Write questions</span>
        <button
          className="btn sm tonal"
          disabled={canMake === false || !!busy || !toWrite.length || !!scope.itemId}
          onClick={writeTicked}
          title={canMake === false ? 'Connect your Claude account in Scans to write questions' : 'Each chapter gets its own set of 25 new questions (multiple choice, fill in the blank, matching and more), each with its walkthrough'}
        >
          {busy === 'write' ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}{' '}
          {toWrite.length ? `Write 25 questions for ${toWrite.length === 1 ? short(toWrite[0]) : `each of ${toWrite.length} chapters`}` : 'Tick chapters to write questions for'}
        </button>
        {toWrite.length > 1 && <span className="muted hub-write-which">{chapterList(toWrite)}</span>}
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
      </div>
    </div>
  );
}
