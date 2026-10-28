// Saved: every bookmarked question of a class (or of every class), by chapter. Each opens to its question, answer and
// whole explanation; "Study these" starts the Study stream on just the bookmarks. Bookmarks are the same stars.json
// marks the bookmark button sets anywhere in Kea.
import { useEffect, useMemo, useState } from 'react';
import { BookmarkX, ChevronDown, ChevronRight, Play } from 'lucide-react';
import { api, StudyQuestion } from '../../lib/api';
import { useScholar } from './scholarStore';
import { Explanation } from './Explanation';
import { MathText } from './MathText';
import { StudyImage } from './StudyImage';
import { openStream } from './StudyStream';

type SavedQ = StudyQuestion & { k: string; courseId: string; courseCode: string };
const short = (label: string) => label.replace(/^Chapter /, 'Ch ');
const byNumber = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/** `courseId` empty: every class. */
export function Saved({ courseId = '' }: { courseId?: string }) {
  const version = useScholar((s) => s.version);
  const [list, setList] = useState<SavedQ[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.scholar
      .studyGet(`saved:${courseId || 'all'}`)
      .then((s) => live && setList(((s?.questions || []) as SavedQ[]).filter((q) => q.k)))
      .catch(() => live && setList([]));
    return () => {
      live = false;
    };
  }, [courseId, version]);

  // Class, then chapter, in order.
  const groups = useMemo(() => {
    const by = new Map<string, { code: string; chapters: Map<string, SavedQ[]> }>();
    for (const q of list || []) {
      const c = by.get(q.courseId) || { code: q.courseCode, chapters: new Map() };
      const ch = q.chapter || 'Other';
      c.chapters.set(ch, [...(c.chapters.get(ch) || []), q]);
      by.set(q.courseId, c);
    }
    return [...by].sort(([, a], [, b]) => byNumber(a.code, b.code)).map(([id, c]) => ({ id, code: c.code, chapters: [...c.chapters].sort(([a], [b]) => byNumber(a, b)) }));
  }, [list]);

  const remove = (k: string) => {
    api.scholar.studyStar(k, false);
    setList((l) => (l || []).filter((q) => q.k !== k));
    if (open === k) setOpen(null);
  };

  if (!list) return <div className="spinner" />;
  if (!list.length)
    return (
      <div className="saved">
        <div className="sch-empty">No saved questions yet. Tap the bookmark on any question to keep it here.</div>
      </div>
    );
  return (
    <div className="saved">
      {groups.map((g) => (
        <section key={g.id} className="saved-class">
          <div className="saved-head">
            {!courseId && <h2 className="sch-h2">{g.code}</h2>}
            <span className="grow" />
            <button className="btn sm primary" onClick={() => openStream({ courseId: g.id, code: g.code, chapters: [], bookmarks: true })}>
              <Play size={13} /> Study these
            </button>
          </div>
          {g.chapters.map(([ch, qs]) => (
            <div key={ch} className="saved-ch">
              <div className="tb-h">{short(ch)}</div>
              {qs.map((q) => {
                const isOpen = open === q.k;
                return (
                  <div key={q.k} className={`saved-q ${isOpen ? 'open' : ''}`}>
                    <button className="saved-q-row" onClick={() => setOpen(isOpen ? null : q.k)} aria-expanded={isOpen}>
                      {isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                      <span className="saved-q-text">
                        <MathText text={q.q} />
                      </span>
                    </button>
                    {isOpen && (
                      <div className="saved-q-body">
                        <StudyImage src={q.image} credit={q.image_credit} />
                        {'choices' in q && (
                          <ol className="saved-choices">
                            {q.choices.map((c, i) => (
                              <li key={i}>
                                <MathText text={c} />
                              </li>
                            ))}
                          </ol>
                        )}
                        {q.type === 'match' && (
                          <ul className="saved-choices">
                            {q.pairs.map(([a, b], i) => (
                              <li key={i}>
                                <MathText text={`${a}: ${b}`} />
                              </li>
                            ))}
                          </ul>
                        )}
                        {/* (As "I don't know" shows it: the answer, then why and the whole walkthrough.) */}
                        <Explanation q={q} s={{ q, order: 'choices' in q ? q.choices.map((_, i) => i) : q.type === 'match' ? q.pairs.map((_, i) => i) : [] }} answer={null} result={null} onSelf={() => {}} dunno />
                        <button className="btn sm" onClick={() => remove(q.k)}>
                          <BookmarkX size={13} /> Remove bookmark
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
