import { useEffect, useState } from 'react';
import { ClipboardCheck } from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../store';
import { MenuButton } from '../Popover';
import { openScholar, useScholar } from './scholarStore';
import { openStream } from './StudyStream';

/**
 * Quiz yourself on a chapter: its saved questions (the chapter's question bank and every set made on it), as the Study
 * stream, unseen and missed questions first.
 */
export async function quizChapter(courseId: string, chapter: string, code = '') {
  const { count } = await api.scholar.studySaved({ kind: 'exam', courseId, chapters: [chapter] }).catch(() => ({ count: 0 }));
  if (!count) {
    const writing = await api.scholar.studyBanks().catch(() => false);
    return toast(writing ? `${chapter}'s questions are being written. They'll be ready in a few minutes (follow it under Scans).` : `${chapter} has no saved questions yet, and Claude isn't connected to write them.`, writing ? 'success' : 'error');
  }
  // (No set is made for it: its answers go to the class's stream bucket.)
  openScholar(useScholar.getState().view);
  openStream({ courseId, code, chapters: [chapter] });
}

/** The PDF toolbar's Quiz me, shown when the open file is one of your class textbooks. */
export function QuizMeButton({ path, chapter }: { path: string; chapter?: string | null }) {
  const [tb, setTb] = useState<{ courseId: string; code: string; chapters: string[] } | null>(null);
  useEffect(() => {
    let live = true;
    api.scholar
      .textbookOf(path)
      .then((r) => live && setTb(r))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [path]);
  if (!tb) return null;
  const button = (onClick?: () => void) => (
    <button className="btn sm tonal" onClick={onClick} title="Quiz yourself on this chapter's saved questions">
      <ClipboardCheck size={15} /> Quiz me
    </button>
  );
  if (tb.chapters.length === 1) return button(() => quizChapter(tb.courseId, tb.chapters[0], tb.code));
  const first = chapter && tb.chapters.includes(chapter) ? [chapter, ...tb.chapters.filter((c) => c !== chapter)] : tb.chapters;
  return (
    <MenuButton button={() => button()}>
      {(close: () => void) => (
        <>
          {first.map((c) => (
            <button key={c} className="menu-item" onClick={() => (close(), quizChapter(tb.courseId, c, tb.code))}>
              {c}
            </button>
          ))}
        </>
      )}
    </MenuButton>
  );
}
