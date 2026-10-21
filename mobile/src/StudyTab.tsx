// Studying and reading on the phone, with the same screens as Kea on the PC: the study player (study hub, practice
// exams, flashcards, Learn, Match, spaced review) and the reader, for textbooks and any PDF.
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import { StudyPlayer } from '../../src/components/scholar/Study';
import { ReadingPane } from '../../src/components/scholar/ReadingPane';
import { useScholar } from '../../src/components/scholar/scholarStore';
import type { OpenedFile } from './kea';

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
