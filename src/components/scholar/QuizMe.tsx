import { useEffect, useState } from 'react';
import { ClipboardCheck } from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../store';
import { MenuButton } from '../Popover';
import { openScholar, useScholar } from './scholarStore';

/**
 * Quiz yourself on a chapter: its saved questions (the chapter's question bank and every set made on it), as one quiz
 * that asks missed and unseen questions first. The same quiz entry is reused each time, so its history builds up.
 */
export async function quizChapter(courseId: string, chapter: string) {
  const { count } = await api.scholar.studySaved({ kind: 'exam', courseId, chapters: [chapter] }).catch(() => ({ count: 0 }));
  if (!count) {
    const writing = await api.scholar.studyBanks().catch(() => false);
    return toast(writing ? `${chapter}'s questions are being written. They'll be ready in a few minutes (follow it under Scans).` : `${chapter} has no saved questions yet, and Claude isn't connected to write them.`, writing ? 'success' : 'error');
  }
  const id = `exam-quiz${(courseId + chapter).toLowerCase().replace(/[^a-z0-9]+/g, '')}`.slice(0, 60);
  try {
    await api.scholar.studyMake({ id, kind: 'exam', courseId, chapters: [chapter], mode: 'saved', count });
    openScholar(useScholar.getState().view);
    useScholar.getState().set({ study: id });
  } catch (err: any) {
    toast(err?.message || 'Kea couldn’t open the quiz.', 'error');
  }
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
  if (tb.chapters.length === 1) return button(() => quizChapter(tb.courseId, tb.chapters[0]));
  const first = chapter && tb.chapters.includes(chapter) ? [chapter, ...tb.chapters.filter((c) => c !== chapter)] : tb.chapters;
  return (
    <MenuButton button={() => button()}>
      {(close: () => void) => (
        <>
          {first.map((c) => (
            <button key={c} className="menu-item" onClick={() => (close(), quizChapter(tb.courseId, c))}>
              {c}
            </button>
          ))}
        </>
      )}
    </MenuButton>
  );
}
