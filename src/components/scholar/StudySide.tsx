// The study player's side pane, opened once a question is answered: Teach (Claude teaches the idea behind the question,
// step by step, on the student's Claude plan), the class textbook where the question is taught (Book), and the
// Encyclopedia (Wikipedia and the dictionary) for any word or idea in it. Highlight something after answering and
// "Teach" and "Look up" buttons appear over it. Before answering, all of it waits: a new question hides the pane, and it
// comes back (on that question) when the question is answered.
import { createContext, useContext, useEffect, useState } from 'react';
import { BookOpen, Globe, GraduationCap, Lightbulb, Search, Trash2, X } from 'lucide-react';
import { LookupBody } from '../lookup/LookupPanel';
import type { LookupCard } from '../lookup/lookupStore';
import { ReadingPane, ReadingTarget } from './ReadingPane';
import { TeachPane, TeachSubject } from './Teach';
import { api as keaApi } from '../../lib/api';

// Teach runs on this device's own Claude (Claude Code signed in to the student's plan): where there's none (the phone,
// a PC without Claude Code), there's no Teach, rather than a request sent off to another computer.
let claudeHere: Promise<boolean> | null = null;
const checkClaude = () =>
  (claudeHere ||= (async () => {
    try {
      const s = await (keaApi as any).assistant?.planStatus?.();
      return !!(s && s.installed && s.loggedIn);
    } catch {
      return false;
    }
  })());
export function useClaudeHere() {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    let live = true;
    checkClaude().then((v) => live && setOk(v));
    return () => {
      live = false;
    };
  }, []);
  return ok;
}

/** Kea for Android (its build marks itself): the simpler phone versions of the shared screens. */
const onPhone = () => !!(window as any).keaPhone;

export type SideTab = 'teach' | 'book' | 'look';

/** What the questions can do with the pane. */
export interface StudySide {
  tab: SideTab | null;
  show(tab: SideTab | null): void;
  /** The question on screen isn't answered yet: the pane waits. */
  lock(): void;
  /** Answered: the pane opens on this question (its place in the book, its words for the Encyclopedia, it for Teach). */
  answered(target: ReadingTarget | null, text: string, subject: TeachSubject | null): void;
  /** Look this up in the Encyclopedia now. */
  lookUp(text: string): void;
  /** A lesson now: on this highlighted text, or ('') on the whole question. */
  teach(text: string): void;
  /** Teach is offered (the question can be taught: it's one of the class's saved questions). */
  canTeach: boolean;
  /** Can this chapter open in the book? */
  hasBook(chapter?: string | null): boolean;
}
export const StudySideContext = createContext<StudySide | null>(null);
export const useStudySide = () => useContext(StudySideContext);

interface Look {
  cards: LookupCard[];
  ask: { text: string; at: number } | null;
  /** The answered question's words: the context that picks a term's meaning. */
  text: string;
}

/** The pane's state, kept by the player while it's open (so lookups stay from question to question). */
export function useStudySideState(books: Map<string, string>, reading: ReadingTarget | null, setReading: (t: ReadingTarget | null) => void) {
  const [tab, setTab] = useState<SideTab | null>(null);
  const [locked, setLocked] = useState(false);
  const [look, setLook] = useState<Look>({ cards: [], ask: null, text: '' });
  const [subject, setSubject] = useState<TeachSubject | null>(null);
  const [teachAsk, setTeachAsk] = useState<{ text: string; at: number } | null>(null);
  const file = reading ? books.get(reading.chapter) : undefined;
  const teachable = useClaudeHere() && !!subject;
  // (Book asked for a question with no textbook chapter: the Encyclopedia instead.)
  const shown: SideTab | null = locked ? null : (tab === 'book' && !file) || (tab === 'teach' && !teachable) ? 'look' : tab;
  const api: StudySide = {
    tab: shown,
    show: setTab,
    lock: () => setLocked(true),
    answered: (t, text, s) => {
      setLocked(false);
      setReading(t && books.has(t.chapter) ? t : null);
      setLook((l) => ({ ...l, text }));
      setSubject(s);
    },
    lookUp: (text) => {
      setTab('look');
      setLook((l) => ({ ...l, ask: { text, at: Date.now() } }));
    },
    teach: (text) => {
      setTab('teach');
      setTeachAsk({ text, at: Date.now() });
    },
    canTeach: teachable,
    hasBook: (ch) => !!ch && books.has(ch)
  };
  const pane = shown ? (
    <aside className="st-reading st-side">
      <div className="st-side-tabs" role="tablist">
        {teachable && (
          <button role="tab" aria-selected={shown === 'teach'} className={shown === 'teach' ? 'on' : ''} onClick={() => setTab('teach')}>
            <GraduationCap size={14} /> Teach
          </button>
        )}
        {file && reading && (
          <button role="tab" aria-selected={shown === 'book'} className={shown === 'book' ? 'on' : ''} onClick={() => setTab('book')}>
            <BookOpen size={14} /> Book
          </button>
        )}
        <button role="tab" aria-selected={shown === 'look'} className={shown === 'look' ? 'on' : ''} onClick={() => setTab('look')}>
          <Globe size={14} /> Encyclopedia
        </button>
        <span className="grow" />
        {shown === 'look' && look.cards.length > 0 && (
          <button className="icon-btn sm" title="Clear results" onClick={() => setLook((l) => ({ ...l, cards: [] }))}>
            <Trash2 size={15} />
          </button>
        )}
        <button className="icon-btn sm" title="Close (Esc)" onClick={() => setTab(null)}>
          <X size={15} />
        </button>
      </div>
      {shown === 'teach' ? (
        <TeachPane subject={subject} ask={teachAsk} />
      ) : shown === 'book' && file && reading ? (
        <ReadingPane bare file={file} target={reading} onClose={() => setTab(null)} />
      ) : (
        <div className="st-look">
          <LookupBody cards={look.cards} setCards={(f) => setLook((l) => ({ ...l, cards: f(l.cards) }))} selection="" active docText={async () => look.text} ask={look.ask} simple={onPhone()} />
        </div>
      )}
    </aside>
  ) : null;
  return { api, pane, open: !!shown, close: () => setTab(null) };
}

/**
 * The "Look up" button over a highlight inside `root` (the answered question and its explanation). Highlighting on a
 * phone happens without a mouse, so it follows the selection itself rather than mouse-up.
 */
export function LookUpChip({ root, on }: { root: HTMLElement | null; on: boolean }) {
  const side = useStudySide();
  const [hit, setHit] = useState<{ text: string; x: number; y: number } | null>(null);
  useEffect(() => {
    if (!on || !root) return setHit(null);
    const read = () => {
      const sel = window.getSelection();
      const text = sel?.toString().replace(/\s+/g, ' ').trim() || '';
      if (!sel || !sel.rangeCount || !text || text.length > 200 || !root.contains(sel.anchorNode) || !root.contains(sel.focusNode)) return setHit(null);
      const r = sel.getRangeAt(0).getBoundingClientRect();
      // (Nothing to point at when it's scrolled out of sight.)
      if ((!r.width && !r.height) || r.bottom < 0 || r.top > window.innerHeight) return setHit(null);
      // (Under the highlight: a phone puts its own Copy / Select all bar above it.)
      setHit({ text, x: Math.min(window.innerWidth - 60, Math.max(60, r.left + r.width / 2)), y: Math.min(window.innerHeight - 44, r.bottom + 8) });
    };
    let t: ReturnType<typeof setTimeout>;
    const later = () => (clearTimeout(t), (t = setTimeout(read, 120)));
    document.addEventListener('selectionchange', later);
    root.addEventListener('scroll', later, true);
    return () => (clearTimeout(t), document.removeEventListener('selectionchange', later), root.removeEventListener('scroll', later, true));
  }, [root, on]);
  if (!hit || !side) return null;
  const go = (f: () => void) => {
    f();
    window.getSelection()?.removeAllRanges();
    setHit(null);
  };
  return (
    <div
      className="st-lookup-chip"
      style={{ left: hit.x, top: hit.y }}
      // (Pressed without taking the highlight away first.)
      onPointerDown={(e) => e.preventDefault()}
    >
      {side.canTeach && (
        <button className="btn sm primary" onPointerDown={(e) => e.preventDefault()} onClick={() => go(() => side.teach(hit.text))}>
          <GraduationCap size={13} /> Teach
        </button>
      )}
      <button className="btn sm tonal" onPointerDown={(e) => e.preventDefault()} onClick={() => go(() => side.lookUp(hit.text))}>
        {onPhone() ? (
          <>
            <Lightbulb size={13} /> Explain
          </>
        ) : (
          <>
            <Search size={13} /> Look up
          </>
        )}
      </button>
    </div>
  );
}
