// Studying a class: its chapters, each opening to its topics, and the class's bookmarked questions. Tick what to study
// and Start goes into the Study stream of those questions (StudyStream.tsx), which runs until Exit. Every chapter of
// the class ticked is the class in curriculum order, one chapter at a time. Opened from a class's Study button, a
// chapter, or a test (its chapters ticked already).
import { useEffect, useMemo, useState } from 'react';
import { Bookmark, Check, Target, ChevronDown, ChevronRight, Image, Loader2, Minus, Play, Sparkles } from 'lucide-react';
import { api, PoolItem, ReviewQueue, ScholarChapter } from '../../lib/api';
import { toast } from '../../store';
import { useScholar } from './scholarStore';
import { useCanMake, useStudySets } from './Study';
import { openStream } from './StudyStream';

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
/**
 * A class's Study page: every chapter, none ticked yet (or the ones given). `stream`: straight into the Study stream on
 * the chapters given instead (a chapter's own Study button).
 */
export const openClassStudy = (c: { id: string; code: string }, chapters: string[], selected?: string[], stream?: boolean) =>
  stream && selected?.length ? openStream({ courseId: c.id, code: c.code, chapters: selected }) : openStudyHub({ courseId: c.id, code: c.code, title: 'Study', chapters, selected: selected || [] });
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
const short = (label: string) => label.replace(/^Chapter /, 'Ch ');
const SEP = String.fromCharCode(0);
const topicOf = (p: PoolItem) => `${p.chapter || ''}${SEP}${p.section || 'Other'}`;
/** The Bookmarked row's tick, kept with the topics'. */
const BOOKMARKS = `${SEP}bookmarks`;
/** The Weak spots row's tick. */
const WEAK = `${SEP}weak`;

/**
 * Your weak spots: every question in a topic where under 70% of your latest answers were right (at least 3 answered),
 * and any question you got wrong last time. Weakest topics first.
 */
function weakSpots(pool: PoolItem[]) {
  const by = new Map<string, { seen: number; right: number; name: string }>();
  for (const p of pool) {
    if (p.lastRight == null) continue;
    const t = by.get(topicOf(p)) || { seen: 0, right: 0, name: p.section || p.chapter || 'Other' };
    t.seen++;
    if (p.lastRight) t.right++;
    by.set(topicOf(p), t);
  }
  const weak = [...by].filter(([, t]) => t.seen >= 3 && t.right / t.seen < 0.7).sort(([, a], [, b]) => a.right / a.seen - b.right / b.seen);
  const topics = new Set(weak.map(([k]) => k));
  return { keys: pool.filter((p) => topics.has(topicOf(p)) || p.lastRight === false).map((p) => p.k), names: weak.map(([, t]) => t.name) };
}

export function StudyHub({ scope }: { scope: StudyScope }) {
  const sets = useStudySets();
  const canMake = useCanMake();
  const [q, setQ] = useState<ReviewQueue | null>(null);
  const [pool, setPool] = useState<PoolItem[] | null>(null);
  const [titles, setTitles] = useState<Map<string, string>>(new Map());
  // The class's chapters in curriculum order.
  const [curriculum, setCurriculum] = useState<string[] | null>(null);
  const [busy, setBusy] = useState('');
  const [open, setOpen] = useState<string[]>(() => (scope.chapters.length === 1 ? scope.chapters : []));
  // What's ticked: topics, as "chapter \0 section" (and BOOKMARKS). Filled in once the questions are read.
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
      .then((c) => {
        setTitles(new Map((c?.chapters || []).map((ch: ScholarChapter) => [ch.label, ch.title || ''])));
        setCurriculum((c?.chapters || []).map((ch: ScholarChapter) => ch.label));
      })
      .catch(() => setCurriculum([]));
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
  const inPick = (pool || []).filter((p) => sel.has(topicOf(p)) || (sel.has(BOOKMARKS) && p.starred) || (sel.has(WEAK) && weak.keys.includes(p.k)));
  const bookmarked = (pool || []).filter((p) => p.starred).length;
  const weak = useMemo(() => weakSpots(pool || []), [pool]);
  const c = q?.counts[scope.courseId];
  const days = c?.test ? Math.round((Date.parse(`${c.test.date}T12:00`) - Date.now()) / 864e5) : null;
  // The chapters ticked (by any of their topics, or the chapter itself when it has no questions yet).
  const tickedChapters = scope.chapters.filter((ch) => [...sel].some((k) => k.startsWith(`${ch}${SEP}`)));
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

  const toggle = (keys: string[], on: boolean) => {
    const next = new Set(sel);
    keys.forEach((k) => (on ? next.add(k) : next.delete(k)));
    setTicked(next);
  };
  const chapterTitle = (ch: string) => titles.get(ch) || '';
  const keysOf = (ch: string, topics: Map<string, PoolItem[]>) => (topics.size ? [...topics.keys()].map((t) => `${ch}${SEP}${t}`) : [`${ch}${SEP}*`]);
  const allKeys = [...tree].flatMap(([ch, topics]) => keysOf(ch, topics));
  const chapterKeys = [...sel].filter((k) => k !== BOOKMARKS && k !== WEAK);

  // Start: the stream on what's ticked. Every chapter of the class ticked (Select all, or one by one): the class in
  // curriculum order, one chapter at a time, the next once this one is learned.
  const start = () => {
    const order = curriculum?.length ? [...curriculum.filter((ch) => tickedChapters.includes(ch)), ...tickedChapters.filter((ch) => !curriculum.includes(ch))] : tickedChapters;
    const whole = tickedChapters.every((ch) => keysOf(ch, tree.get(ch) || new Map()).every((k) => sel.has(k)));
    // (The Study page of a test shows only its chapters: that isn't the whole class.)
    const everyChapter = !scope.itemId && allKeys.length > 0 && allKeys.every((k) => sel.has(k)) && (curriculum || []).every((ch) => scope.chapters.includes(ch));
    openStream({
      courseId: scope.courseId,
      code: scope.code,
      chapters: order,
      ...(whole ? {} : { topics: chapterKeys }),
      ...(sel.has(BOOKMARKS) ? { bookmarks: true } : {}),
      ...(sel.has(WEAK) && weak.keys.length ? { weak: weak.keys } : {}),
      ...(everyChapter ? { progression: true } : {})
    });
  };

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
            <button className="link-btn" onClick={() => toggle(allKeys, chapterKeys.length < allKeys.length)}>
              {chapterKeys.length < allKeys.length ? 'Select all' : 'Clear'}
            </button>
          )}
        </div>
        {!pool ? (
          <div className="hub-tree-loading">
            <Loader2 size={16} className="spin" />
          </div>
        ) : (
          <>
            {/* The class's bookmarked questions, ticked like a chapter. */}
            <div className={`hub-ch ${sel.has(BOOKMARKS) ? 'on' : ''} ${bookmarked ? '' : 'empty'}`}>
              <div className="hub-ch-row">
                <button className={`hub-tick ${sel.has(BOOKMARKS) ? 'all' : 'none'}`} disabled={!bookmarked} onClick={() => toggle([BOOKMARKS], !sel.has(BOOKMARKS))} aria-label="Tick bookmarked questions">
                  {sel.has(BOOKMARKS) ? <Check size={13} /> : null}
                </button>
                <button className="hub-ch-main" disabled={!bookmarked} onClick={() => toggle([BOOKMARKS], !sel.has(BOOKMARKS))}>
                  <span className="hub-ch-title">
                    <Bookmark size={13} /> <b>Bookmarked ({bookmarked})</b>
                  </span>
                  <span className="hub-ch-sub muted">{bookmarked ? 'The questions you bookmarked' : 'Bookmark any question to keep it here'}</span>
                </button>
              </div>
            </div>
            {/* The questions you're weakest on, ticked like a chapter. */}
            <div className={`hub-ch ${sel.has(WEAK) ? 'on' : ''} ${weak.keys.length ? '' : 'empty'}`}>
              <div className="hub-ch-row">
                <button className={`hub-tick ${sel.has(WEAK) ? 'all' : 'none'}`} disabled={!weak.keys.length} onClick={() => toggle([WEAK], !sel.has(WEAK))} aria-label="Tick your weak spots">
                  {sel.has(WEAK) ? <Check size={13} /> : null}
                </button>
                <button className="hub-ch-main" disabled={!weak.keys.length} onClick={() => toggle([WEAK], !sel.has(WEAK))}>
                  <span className="hub-ch-title">
                    <Target size={13} /> <b>Weak spots ({weak.keys.length})</b>
                  </span>
                  <span className="hub-ch-sub muted">
                    {weak.keys.length ? (weak.names.length ? weak.names.slice(0, 3).join(' · ') : 'Questions you got wrong last time') : 'They appear once you’ve answered some questions'}
                  </span>
                </button>
              </div>
            </div>
            {[...tree].map(([ch, topics]) => {
              const keys = keysOf(ch, topics);
              const count = [...topics.values()].reduce((a, l) => a + l.length, 0);
              const on = keys.filter((k) => sel.has(k)).length;
              const state = !on ? 'none' : on === keys.length ? 'all' : 'some';
              const isOpen = open.includes(ch);
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
                      <span className="hub-ch-sub muted">{writing(ch) ? 'Being written…' : count ? `${count} questions${topics.size > 1 ? ` · ${topics.size} topics` : ''}` : 'No questions yet'}</span>
                      {topics.size > 1 && (isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />)}
                    </button>
                  </div>
                  {isOpen && topics.size > 1 && (
                    <div className="hub-topics">
                      {[...topics].map(([t, list]) => {
                        const k = `${ch}${SEP}${t}`;
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
            })}
          </>
        )}
      </div>

      {/* One button: Start (kept on screen at the bottom). */}
      <div className="hub-practice">
        <button className="btn primary hub-start" disabled={!inPick.length || curriculum === null} onClick={start}>
          <Play size={15} /> Start
        </button>
      </div>

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
