// My resources: every class's chapters, to read or to be quizzed on (one switch decides what a tap does), and the
// practice you've done or made yourself. Question banks stay out of sight: they're what every quiz draws from.
import { useEffect, useMemo, useState } from 'react';
import { BookOpen, Brain, Check, ClipboardCheck, ClipboardList, ClipboardPaste, Layers, Plus } from 'lucide-react';
import { api, ScholarCourse, ScholarCourseDetail, StudySet } from '../../lib/api';
import { openPaths } from '../../lib/open';
import { setPdfTarget } from '../../lib/pdfTarget';
import { useScholar } from './scholarStore';
import { SetRow, openStudySet, useStudySets } from './Study';
import { openStudyHub } from './StudyHub';

type Mode = 'read' | 'quiz';
const MODE_KEY = 'kea.resources.mode';
const readMode = (): Mode => {
  try {
    return localStorage.getItem(MODE_KEY) === 'read' ? 'read' : 'quiz';
  } catch {
    return 'quiz';
  }
};

export function ResourcesView({ courses, courseId }: { courses: ScholarCourse[]; courseId?: string }) {
  const version = useScholar((s) => s.version);
  const sets = useStudySets();
  const [mode, setModeState] = useState<Mode>(readMode);
  const setMode = (m: Mode) => {
    setModeState(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {}
  };
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

  // Saved questions per chapter (from the chapters' question banks), shown in quiz mode.
  const questions = useMemo(() => {
    const out = new Map<string, number>();
    for (const s of sets || [])
      if (s.bank && s.kind === 'exam' && s.status === 'ready') for (const ch of s.chapters) out.set(`${s.courseId}|${ch}`, (out.get(`${s.courseId}|${ch}`) || 0) + s.count);
    return out;
  }, [sets]);
  const shownClasses = (details || []).filter((d) => !filter || d.id === filter);
  // Practice that's yours: exams taken, sets being made, your own and imported sets.
  const practice = (sets || []).filter((s) => !s.bank && (!filter || s.courseId === filter) && (s.attempts > 0 || s.status !== 'ready' || s.source === 'mine'));
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
    const one = d.chapters.find((c) => c.label === ordered[0]);
    openStudyHub({ courseId: d.id, code: d.code, title: ordered.length === 1 ? (one?.title ? `${one.label}: ${one.title}` : one?.label || '') : `${ordered.length} chapters`, chapters: ordered });
  };

  return (
    <div className={courseId ? 'res' : 'sch-page res'}>
      {!courseId && (
        <>
          <h1 className="sch-title">My resources</h1>
          <p className="sch-sub">Every chapter of your classes, to read or to be quizzed on, and the practice you've done.</p>
        </>
      )}
      <div className="res-bar">
        <div className="st-seg res-mode" role="tablist">
          <button className={mode === 'read' ? 'on' : ''} onClick={() => (setMode('read'), setPicked([]))}>
            <BookOpen size={14} /> Read
          </button>
          <button className={mode === 'quiz' ? 'on' : ''} onClick={() => setMode('quiz')}>
            <ClipboardCheck size={14} /> Quiz me
          </button>
        </div>
        <span className="muted res-hint">{mode === 'read' ? 'Tap a chapter to open its textbook.' : 'Tap a chapter to be quizzed on it, or tick a few to quiz them together.'}</span>
        {!courseId && courses.length > 1 && (
          <div className="seg-mini res-classes">
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
      </div>

      {mode === 'quiz' && (
        <button className="res-review" onClick={() => openStudySet(`review:${filter || 'all'}`)}>
          <Brain size={18} />
          <span>
            <b>Review what's due</b>
            <span className="muted">Cards and questions coming back before each test{filter ? '' : ', every class'}</span>
          </span>
        </button>
      )}

      {!details ? (
        <div className="spinner" />
      ) : (
        shownClasses.map((d) => (
          <section key={d.id} className="res-class">
            {!courseId && <h2 className="sch-h2">{d.code}</h2>}
            <div className="res-chapters">
              {d.chapters.map((ch) => {
                const key = `${d.id}|${ch.label}`;
                const n = questions.get(key) || 0;
                const can = mode === 'read' ? !!ch.pdf : n > 0;
                const on = picked.includes(key);
                return (
                  <div key={ch.label} className={`res-ch ${can ? '' : 'off'} ${on ? 'on' : ''}`}>
                    {mode === 'quiz' && (
                      <button className={`res-tick ${on ? 'on' : ''}`} disabled={!can} onClick={() => toggle(key)} title="Quiz this chapter together with others">
                        {on && <Check size={13} />}
                      </button>
                    )}
                    <button className="res-ch-main" disabled={!can} onClick={() => (mode === 'read' ? read(d, ch.label) : quiz(d, [ch.label]))}>
                      <span className="res-ch-title">
                        <b>{ch.label.replace(/^Chapter /, 'Ch ')}</b> {ch.title || ''}
                      </span>
                      <span className="muted res-ch-sub">
                        {mode === 'read'
                          ? ch.pdf
                            ? `${ch.pdf.pages ? `${ch.pdf.pages} pages` : 'Textbook chapter'}${ch.sections.length ? ` · ${ch.sections.length} sections` : ''}`
                            : 'Being written'
                          : n
                            ? `${n} questions`
                            : 'No questions yet'}
                      </span>
                    </button>
                    {mode === 'read' ? <BookOpen size={15} className="res-go" /> : <ClipboardCheck size={15} className="res-go" />}
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
                  <ClipboardCheck size={14} /> Quiz these {picked.length}
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
