// Typed answers are marked by Claude when it can be reached (Settings → Study, study.markWithClaude); the student marks
// them only offline, without Claude on this PC, or when Claude's mark fails.
import { useEffect, useState } from 'react';
import { api, type StudyQuestion } from './api';
import { setting } from './settings';
import { uid } from './util';

export type ShortMark = { state: 'checking' } | { state: 'done'; right: boolean; why: string } | { state: 'self' };

// (One mark per question and answer, kept while Kea runs: a card shown again, or remounted, isn't marked twice.)
const cache = new Map<string, Promise<ShortMark>>();

function ask(q: StudyQuestion, answer: string): Promise<ShortMark> {
  const key = `${(q as any).k || q.q}\u0000${answer}`;
  let p = cache.get(key);
  if (!p) {
    p = (async (): Promise<ShortMark> => {
      if (!api.scholar.markShort || (typeof navigator !== 'undefined' && navigator.onLine === false) || setting('study.markWithClaude') === false) return { state: 'self' };
      const r = await api.scholar.markShort(uid(), { question: q, answer }).catch(() => null);
      return r && typeof r.right === 'boolean' ? { state: 'done', right: r.right, why: r.why || '' } : { state: 'self' };
    })();
    cache.set(key, p);
    // (A failure isn't kept: the next look tries again.)
    p.then((m) => m.state === 'self' && cache.delete(key));
  }
  return p;
}

/** Claude's mark on a typed answer once it's shown (`on`); calls `onMark` once with the verdict. */
export function useShortMark(q: StudyQuestion, answer: string, on: boolean, onMark: (right: boolean) => void): ShortMark | null {
  const [m, setM] = useState<ShortMark | null>(null);
  useEffect(() => {
    if (!on || q.type !== 'short') return setM(null);
    if (!answer.trim()) return setM({ state: 'self' });
    let live = true;
    setM({ state: 'checking' });
    ask(q, answer.trim()).then((r) => {
      if (!live) return;
      setM(r);
      if (r.state === 'done') onMark(r.right);
    });
    return () => {
      live = false;
    };
  }, [on, q, answer]);
  return m;
}
