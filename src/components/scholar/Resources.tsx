// Study: every class's chapters as one list, each with Read (its textbook) and Study (its questions, as the Study
// stream), and the practice you've made yourself. Review (what's due) is the one button at the top.
import { useEffect, useMemo, useState } from 'react';
import { BookOpen, Check, ClipboardCheck, ClipboardList, ClipboardPaste, GraduationCap, Layers, Plus } from 'lucide-react';
import type { PoolItem } from '../../lib/api';
import { api, ScholarCourse, ScholarCourseDetail, StudySet } from '../../lib/api';
import { openPaths } from '../../lib/open';
import { setPdfTarget } from '../../lib/pdfTarget';
import { useScholar } from './scholarStore';
import { SetRow, openStudySet, useStudySets } from './Study';
import { openStream } from './StudyStream';

/** Practice made for one test (not a set the student made themselves). */
const forTest = (s: StudySet) => !!s.itemId && !s.bank && s.kind === 'exam' && s.source !== 'mine';

export function ResourcesView({ courses, courseId }: { courses: ScholarCourse[]; courseId?: string }) {
  const version = useScholar((s) => s.version);
  const sets = useStudySets();
  const [filter, setFilter] = useState<string>(courseId || '');
  const [details, setDetails] = useState<ScholarCourseDetail[] | null>(null);
  // Chapters ticked to quiz together (one class at a time): "courseId|Chapter N".
  const [picked, setPicked] = useState<string[]>([]);
  useEffect(() => {
    const ids = courseId ? [courseId] : courses.map((c) => c.id);
    Promise.all(ids.map((id) => api.scholar.course(id)))
      .then((list) => setDetails(list.filter((d): d is ScholarCourseDetail => !!d)))
      .catch(() => setDetails([]));
  }, [courseId, courses.map((c) => c.id).join(), version]);
  useEffect(() => setFilter(courseId || ''), [courseId]);

  // Saved questions per chapter (each question once, whichever set it's in).
  const [pools, setPools] = useState<Record<string, PoolItem[]>>({});
  useEffect(() => {
    if (!details) return;
    let live = true;
    Promise.all(details.map((d) => api.scholar.studyPool({ courseId: d.id, chapters: d.chapters.map((c) => c.label) }).then((p) => [d.id, p] as const).catch(() => [d.id, [] as PoolItem[]] as const))).then(
      (list) => live && setPools(Object.fromEntries(list))
    );
    return () => {
      live = false;
    };
  }, [details, sets?.length]);
  const questions = useMemo(() => {
    const out = new Map<string, { n: number }>();
    for (const [cid, list] of Object.entries(pools))
      for (const p of list) {
        const k = `${cid}|${p.chapter}`;
        const e = out.get(k) || { n: 0 };
        e.n++;
        out.set(k, e);
      }
    return out;
  }, [pools]);
  const shownClasses = (details || []).filter((d) => !filter || d.id === filter);
  // Practice that's yours: exams taken, sets being made, your own and imported sets.
  // (Practice for a test is filed under its class's tests instead.)
  const practice = (sets || []).filter((s) => !s.bank && !forTest(s) && (!filter || s.courseId === filter) && (s.attempts > 0 || s.status !== 'ready' || s.source === 'mine'));
  // Each class's coming tests, soonest first, with the practice for them: Kea's own review (made for every quiz and
  // exam, from the teacher's study guide when there is one) and any made from the test. Past tests drop off.
  const today = new Date().toLocaleDateString('en-CA');
  const testsOf = (courseId: string) => {
    const by = new Map<string, StudySet[]>();
    for (const s of (sets || []).filter((x) => forTest(x) && x.courseId === courseId && !(x.itemDate && x.itemDate < today)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
      by.set(s.itemId!, [...(by.get(s.itemId!) || []), s]);
    const when = (list: StudySet[]) => list.find((s) => s.itemDate)?.itemDate || '9999';
    return [...by.values()].sort((a, b) => when(a).localeCompare(when(b)));
  };
  const dateLabel = (d?: string) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : '');
  const pickedClass = picked[0]?.split('|')[0] || '';
  const toggle = (key: string) => setPicked((p) => (p.includes(key) ? p.filter((x) => x !== key) : [...p.filter((x) => x.split('|')[0] === key.split('|')[0]), key]));

  const read = (d: ScholarCourseDetail, label: string) => {
    const ch = d.chapters.find((c) => c.label === label);
    if (!ch?.pdf) return;
    setPdfTarget(ch.pdf.file, ch.label);
    openPaths([ch.pdf.file]);
  };
  const quiz = (d: ScholarCourseDetail, labels: string[]) => {
    const ordered = d.chapters.map((c) => c.label).filter((l) => labels.includes(l));
    // (Straight into the Study stream; every chapter of the class ticked: in curriculum order.)
    openStream({ courseId: d.id, code: d.code, chapters: ordered, ...(ordered.length > 1 && ordered.length === d.chapters.length ? { progression: true } : {}) });
  };

  return (
    <div className={courseId ? 'res' : 'sch-page res'}>
      {!courseId && (
        <>
          <h1 className="sch-title">Study</h1>
          <p className="sch-sub">Every chapter of your classes: read it, or study its questions. Tick several to study them together. Every quiz and exam coming up gets a review Kea makes on its own, from your teacher’s study guide when there is one; it’s under that class’s upcoming tests.</p>
        </>
      )}
      <div className="res-top">
        {!courseId && courses.length > 1 && (
          <div className="seg-mini res-classes">
            <button className={!filter ? 'on' : ''} onClick={() => setFilter('')}>
              All classes
            </button>
            {courses.map((c) => (
              <button key={c.id} className={filter === c.id ? 'on' : ''} onClick={() => setFilter(c.id)}>
                {c.code}
              </button>
            ))}
          </div>
        )}
      </div>

      {!details ? (
        <div className="spinner" />
      ) : (
        shownClasses.map((d) => (
          <section key={d.id} className="res-class">
            {!courseId && <h2 className="sch-h2">{d.code}</h2>}
            {testsOf(d.id).length > 0 && (
              <div className="res-tests">
                <div className="tb-h">
                  <GraduationCap size={13} /> Upcoming tests
                </div>
                {testsOf(d.id).map((list) => (
                  <div key={list[0].itemId!} className="res-test">
                    <div className="res-test-title">
                      <b>{list[0].itemTitle || 'Test'}</b>
                      {list.find((s) => s.itemDate) && <span className="muted"> · {dateLabel(list.find((s) => s.itemDate)?.itemDate)}</span>}
                      {list.some((s) => s.status === 'making') ? <span className="muted"> · Kea is making its review</span> : list.some((s) => s.auto) && <span className="muted"> · review made by Kea</span>}
                    </div>
                    <div className="st-list">
                      {list.map((s) => (
                        <SetRow key={s.id} s={s} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="res-list">
              {d.chapters.map((ch) => {
                const key = `${d.id}|${ch.label}`;
                const q = questions.get(key);
                const n = q?.n || 0;
                const on = picked.includes(key);
                return (
                  <div key={ch.label} className={`res-row ${!n && !ch.pdf ? 'off' : ''} ${on ? 'on' : ''}`}>
                    <button className={`res-tick ${on ? 'on' : ''}`} disabled={!n} onClick={() => toggle(key)} title={n ? 'Study this chapter together with others' : 'No questions yet'} aria-label="Pick">
                      {on && <Check size={13} />}
                    </button>
                    <div className="res-row-main">
                      <span className="res-ch-title">
                        <b>{ch.label.replace(/^Chapter /, 'Ch ')}</b> {ch.title || ''}
                      </span>
                      <span className="muted res-ch-sub">
                        {[ch.pdf ? (ch.pdf.pages ? `${ch.pdf.pages} pages` : 'Reading') : 'Reading being written', n ? `${n} questions` : 'no questions yet'].join(' · ')}
                      </span>
                    </div>
                    <div className="res-acts">
                      <button className="btn sm" disabled={!ch.pdf} onClick={() => read(d, ch.label)}>
                        <BookOpen size={14} /> Read
                      </button>
                      <button className="btn sm" disabled={!n} onClick={() => quiz(d, [ch.label])}>
                        <ClipboardCheck size={14} /> Study
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            {pickedClass === d.id && picked.length > 1 && (
              <div className="res-picked">
                <span>
                  {picked.length} chapters ticked
                </span>
                <button className="btn sm" onClick={() => setPicked([])}>
                  Clear
                </button>
                <button className="btn primary sm" onClick={() => quiz(d, picked.map((k) => k.split('|')[1]))}>
                  <ClipboardCheck size={14} /> Study these {picked.length}
                </button>
              </div>
            )}
          </section>
        ))
      )}

      <section className="res-practice">
        <div className="res-practice-head">
          <h2 className="sch-h2">Your practice</h2>
          <button className="link-btn" onClick={() => openStudySet('edit:new')}>
            <Plus size={13} /> Make a set
          </button>
          <button className="link-btn" onClick={() => openStudySet('edit:import')}>
            <ClipboardPaste size={13} /> Import from Quizlet
          </button>
        </div>
        {sets === null ? null : !practice.length ? (
          <div className="muted res-empty">
            <ClipboardList size={15} /> Practice exams you take and sets you make show here, with your best score.
          </div>
        ) : (
          <div className="st-list">
            {practice.map((s: StudySet) => (
              <SetRow key={s.id} s={s} showCourse={!courseId && !filter} />
            ))}
          </div>
        )}
      </section>
      <p className="muted res-foot">
        <Layers size={13} /> Each chapter's questions come from its question bank, written once and reshuffled every time.
      </p>
    </div>
  );
}
