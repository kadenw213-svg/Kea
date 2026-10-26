// Studying and reading on the phone, with the same screens as Kea on the PC: the study player (study hub, practice
// exams, flashcards, Learn, Match, spaced review) and the reader, for textbooks and any PDF.
import { StudyPlayer } from '../../src/components/scholar/Study';
import { useScholar } from '../../src/components/scholar/scholarStore';
import type { OpenedFile } from './kea';
import type { BookTarget } from './Book';
import { Viewer } from './Viewer';
import { useBack } from './back';

/** The textbook open on the phone: a chapter's PDF from the library (or any PDF), where it was left. */
export type ReaderTarget = BookTarget;

/** The study player (over everything) whenever a set, the hub or review is open. */
export function StudyHost() {
  const id = useScholar((s) => s.study);
  // (Back leaves the quiz or deck: its answers are saved as it closes.)
  useBack(!!id, () => useScholar.getState().set({ study: null }));
  if (!id) return null;
  return (
    <div className="m-overlay">
      <StudyPlayer id={id} onClose={() => useScholar.getState().set({ study: null })} />
    </div>
  );
}

/** A file opened with Kea (Open with, Share, or downloaded from the class site): whatever it is, in Kea's viewer. */
export function OpenedView({ file, onClose }: { file: OpenedFile; onClose(): void }) {
  return <Viewer target={{ file: file.path, title: file.name, type: file.type }} onClose={onClose} />;
}

/** A chapter's textbook, or any file, full screen: to read, listen to, or look through. */
export function Reader({ target, onClose, onOpen }: { target: ReaderTarget; onClose(): void; onOpen?(t: ReaderTarget): void }) {
  return <Viewer key={target.file} target={target} onClose={onClose} onOpen={onOpen as any} />;
}
