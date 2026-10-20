// Studying on the phone, with the same screens as Kea on the PC: the study hub for any chapter or test (practice exam,
// flashcards, Learn, Match, topics, missed and starred), spaced review, and the textbook reader with its worked steps.
import { useEffect, useState } from 'react';
import { BookOpen, Brain, ClipboardCheck, ChevronLeft, Layers, X } from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import type { ScholarChapter, StudySet } from '../../src/lib/api';
import { StudyPlayer, openStudySet } from '../../src/components/scholar/Study';
import { openStudyHub } from '../../src/components/scholar/StudyHub';
import { ReadingPane } from '../../src/components/scholar/ReadingPane';
import { useScholar } from '../../src/components/scholar/scholarStore';
import { api } from '../../src/lib/api';
import type { KeaData, OpenedFile } from './kea';

/** The textbook open on the phone: a chapter's PDF from the library, at its start. */
export type ReaderTarget = { file: string; chapter: string; title: string };

/** The study player (over everything) whenever a set, the hub or review is open. */
export function StudyHost() {
  const id = useScholar((s) => s.study);
  if (!id) return null;
  return (
    <div className="m-overlay">
      <StudyPlayer id={id} onClose={() => useScholar.getState().set({ study: null })} />
    </div>
  );
}

/** A file opened with Kea (Open with, Share): PDFs in the reader, pictures and text as they are. */
export function OpenedView({ file, onClose }: { file: OpenedFile; onClose(): void }) {
  const [text, setText] = useState<string | null>(null);
  const kind = /pdf/i.test(file.type) || /\.pdf$/i.test(file.name) ? 'pdf' : /^image\//i.test(file.type) ? 'image' : /^text\//i.test(file.type) || /\.(txt|md|csv)$/i.test(file.name) ? 'text' : 'other';
  useEffect(() => {
    if (kind === 'text')
      fetch(Capacitor.convertFileSrc(file.path))
        .then((r) => r.text())
        .then(setText)
        .catch(() => setText(''));
  }, [file.path]);
  if (kind === 'pdf') return <Reader target={{ file: file.path, chapter: file.name, title: file.name }} onClose={onClose} />;
  return (
    <div className="m-overlay">
      <div className="st-reading-head">
        <span className="st-reading-title">{file.name}</span>
        <button className="icon-btn" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <div className="m-opened">
        {kind === 'image' && <img src={Capacitor.convertFileSrc(file.path)} alt="" />}
        {kind === 'text' && <pre>{text ?? 'Opening…'}</pre>}
        {kind === 'other' && <p className="muted">Kea can't show this kind of file yet.</p>}
      </div>
    </div>
  );
}

/** A chapter's textbook, full screen. */
export function Reader({ target, onClose }: { target: ReaderTarget; onClose(): void }) {
  return (
    <div className="m-overlay m-reader">
      <ReadingPane file={target.file} target={{ chapter: target.chapter }} onClose={onClose} />
    </div>
  );
}

export function StudyTab({ data, read }: { data: KeaData; read(t: ReaderTarget): void }) {
  const version = useScholar((s) => s.version);
  const [sets, setSets] = useState<StudySet[]>([]);
  const [due, setDue] = useState<number | null>(null);
  const [course, setCourse] = useState<string | null>(null);
  useEffect(() => {
    api.scholar.studyList().then(setSets).catch(() => setSets([]));
    api.scholar
      .studyReview({ limit: 200 })
      .then((q) => setDue(q.due.length + q.fresh.length))
      .catch(() => setDue(null));
  }, [data, version]);

  const c = data.details.find((d) => d.code === course);
  if (c) {
    const mine = sets.filter((s) => s.courseId === c.id && !s.bank && s.status !== 'failed');
    return (
      <div className="page">
        <button className="back" onClick={() => setCourse(null)}>
          <ChevronLeft size={18} /> Study
        </button>
        <h1>
          {c.code} <span className="muted">{c.name}</span>
        </h1>
        <button className="btn" onClick={() => openStudySet(`review:${c.id}`)}>
          <Brain size={16} /> Review {c.code}
        </button>
        <h2>Chapters</h2>
        {c.chapters.map((ch: ScholarChapter) => (
          <div key={ch.label} className="card st-m-ch">
            <div>
              <b>{ch.label}</b>
              {ch.title ? `: ${ch.title}` : ''}
              {ch.summary && <div className="muted small">{ch.summary}</div>}
            </div>
            <div className="actions">
              <button className="btn" onClick={() => openStudyHub({ courseId: c.id, code: c.code, title: ch.title ? `${ch.label}: ${ch.title}` : ch.label, chapters: [ch.label] })}>
                <ClipboardCheck size={16} /> Study
              </button>
              {ch.pdf && (
                <button className="btn" onClick={() => read({ file: ch.pdf!.file, chapter: ch.label, title: ch.title || ch.label })}>
                  <BookOpen size={16} /> Read
                </button>
              )}
            </div>
          </div>
        ))}
        {mine.length > 0 && (
          <>
            <h2>Your sets</h2>
            {mine.map((s) => (
              <button key={s.id} className="card link" disabled={s.status !== 'ready'} onClick={() => openStudySet(s.id)}>
                {s.kind === 'exam' ? <ClipboardCheck size={16} /> : <Layers size={16} />}
                <span>
                  {s.itemTitle || s.title.replace(/^(Practice exam|Flashcards): /, '')}
                  <span className="muted small block">{s.status === 'making' ? 'Being written on your PC…' : `${s.count} ${s.kind === 'exam' ? 'questions' : 'cards'}${s.best != null ? ` · best ${Math.round(s.best * 100)}%` : ''}`}</span>
                </span>
              </button>
            ))}
          </>
        )}
      </div>
    );
  }
  return (
    <div className="page">
      <button className="card review-all" onClick={() => openStudySet('review:all')}>
        <Brain size={22} />
        <span>
          <b>Review</b>
          <span className="muted small block">{due == null ? 'Cards and questions coming due, before each test' : due ? `${due} due now, every class` : 'Nothing due right now'}</span>
        </span>
      </button>
      <h2>Classes</h2>
      {data.details.map((d) => {
        const banks = sets.filter((s) => s.courseId === d.id && s.bank && s.status === 'ready').length;
        return (
          <button key={d.id} className="card class" onClick={() => setCourse(d.code)}>
            <div>
              <b>{d.code}</b>
              <div className="muted small">
                {d.chapters.length} chapters{banks ? ` · ${banks} question banks` : ''}
              </div>
            </div>
          </button>
        );
      })}
      <p className="muted small">
        Everything here works offline. Answers, flashcards and stars go back to your PC; new questions and worked steps are written there.
      </p>
    </div>
  );
}
