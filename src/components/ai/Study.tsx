import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, RotateCcw, Shuffle, Check, X, Sheet, CornerDownLeft, Copy } from 'lucide-react';
import type { Flashcard, QuizQuestion } from '../../lib/ai';
import { useTabs, toast } from '../../store';

const shuffle = <T,>(a: T[]) => {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
};

const csvCell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** Flashcards: click to flip, mark "Got it" or "Again"; cards you missed come back at the end. */
export function FlashcardsView({ cards, title, hooks }: { cards: Flashcard[]; title: string; hooks: any }) {
  const [deck, setDeck] = useState(() => cards.map((_, i) => i));
  const [pos, setPos] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [known, setKnown] = useState<Set<number>>(new Set());
  const done = pos >= deck.length;
  const card = cards[deck[pos]];

  const go = (d: number) => {
    setFlipped(false);
    setPos((p) => Math.max(0, Math.min(deck.length, p + d)));
  };
  const mark = (gotIt: boolean) => {
    const i = deck[pos];
    if (gotIt) setKnown(new Set(known).add(i));
    else setDeck([...deck, i]); // see it again later
    go(1);
  };
  const restart = (onlyMissed: boolean) => {
    const order = onlyMissed ? cards.map((_, i) => i).filter((i) => !known.has(i)) : cards.map((_, i) => i);
    setDeck(shuffle(order.length ? order : cards.map((_, i) => i)));
    if (!onlyMissed) setKnown(new Set());
    setPos(0);
    setFlipped(false);
  };
  const toSheet = () => {
    const csv = 'Front,Back\r\n' + cards.map((c) => `${csvCell(c.front)},${csvCell(c.back)}`).join('\r\n');
    useTabs.getState().addTab({ kind: 'sheet', name: `${title} flashcards.csv`, path: null, data: new TextEncoder().encode(csv) });
  };
  const asMarkdown = () => cards.map((c) => `- **${c.front}**: ${c.back}`).join('\n');

  return (
    <div className="ai-msg assistant study">
      <div className="study-head">
        <span>
          Flashcards · {Math.min(pos + 1, deck.length)} / {deck.length}
        </span>
        <span className="muted">{known.size} known</span>
      </div>
      {!done ? (
        <>
          <button className={`flashcard ${flipped ? 'flipped' : ''}`} onClick={() => setFlipped(!flipped)} title="Click to flip (Space)">
            <span className="fc-side">{flipped ? 'Answer' : 'Question'}</span>
            <span className="fc-text">{flipped ? card.back : card.front}</span>
            {!flipped && <span className="fc-hint">Click to see the answer</span>}
          </button>
          <div className="ai-actions study-nav">
            <button className="icon-btn sm" title="Previous" disabled={pos === 0} onClick={() => go(-1)}>
              <ChevronLeft size={16} />
            </button>
            {flipped ? (
              <>
                <button className="btn sm tonal" onClick={() => mark(false)}>
                  <X size={13} /> Again
                </button>
                <button className="btn sm tonal" onClick={() => mark(true)}>
                  <Check size={13} /> Got it
                </button>
              </>
            ) : (
              <button className="btn sm tonal" onClick={() => setFlipped(true)}>
                Show answer
              </button>
            )}
            <button className="icon-btn sm" title="Skip" onClick={() => go(1)}>
              <ChevronRight size={16} />
            </button>
          </div>
        </>
      ) : (
        <div className="study-done">
          <div className="study-score">
            {known.size} of {cards.length} known
          </div>
          <div className="ai-actions">
            {known.size < cards.length && (
              <button className="btn sm tonal" onClick={() => restart(true)}>
                <RotateCcw size={13} /> Practise the rest
              </button>
            )}
            <button className="btn sm tonal" onClick={() => restart(false)}>
              <Shuffle size={13} /> Start over
            </button>
          </div>
        </div>
      )}
      <div className="ai-actions">
        <button className="btn sm" title="Open the cards in a new spreadsheet" onClick={toSheet}>
          <Sheet size={13} /> Spreadsheet
        </button>
        {hooks?.insertText && (
          <button className="btn sm" onClick={() => (hooks.insertText(asMarkdown()) ? toast('Inserted. Ctrl+Z to undo.', 'success') : toast("Couldn't insert here."))}>
            <CornerDownLeft size={13} /> {hooks.insertLabel || 'Insert'}
          </button>
        )}
        <button className="icon-btn sm" title="Copy all cards" onClick={() => navigator.clipboard.writeText(cards.map((c) => `${c.front}\t${c.back}`).join('\n')).then(() => toast('Copied (tab-separated, ready for Quizlet or Anki)', 'success'))}>
          <Copy size={14} />
        </button>
      </div>
    </div>
  );
}

/** Practice quiz, one question at a time: answer → see why → Next. Keys: 1–4 (or A–D) to answer, Enter for next. */
export function QuizView({ questions, hooks }: { questions: QuizQuestion[]; hooks: any }) {
  // Each attempt shuffles the question order and the answer order (the right answer moves too).
  const prepare = (qs: QuizQuestion[]) =>
    shuffle(qs).map((q) => {
      const order = shuffle(q.choices.map((_, i) => i));
      return { ...q, choices: order.map((i) => q.choices[i]), answer: order.indexOf(q.answer) };
    });
  const [deck, setDeck] = useState<QuizQuestion[]>(() => questions);
  const [pos, setPos] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const [results, setResults] = useState<boolean[]>([]);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => boxRef.current?.focus({ preventScroll: true }), []);
  const done = pos >= deck.length;
  const q = deck[pos];
  const score = results.filter(Boolean).length;

  const answer = (j: number) => {
    if (picked !== null || done || j >= q.choices.length) return;
    setPicked(j);
    setResults([...results, j === q.answer]);
  };
  const next = () => {
    if (picked === null) return;
    setPicked(null);
    setPos(pos + 1);
  };
  const restart = (onlyMissed: boolean) => {
    const base = onlyMissed ? deck.filter((_, i) => results[i] === false) : questions;
    setDeck(prepare(base.length ? base : questions));
    setPos(0);
    setPicked(null);
    setResults([]);
    setTimeout(() => boxRef.current?.focus({ preventScroll: true }), 0);
  };
  const asMarkdown = () =>
    questions
      .map((x, i) => `${i + 1}. ${x.question}\n${x.choices.map((c, j) => `   ${String.fromCharCode(65 + j)}) ${c}`).join('\n')}`)
      .join('\n\n') +
    '\n\n**Answers:** ' +
    questions.map((x, i) => `${i + 1}${String.fromCharCode(65 + x.answer)}`).join(', ');

  return (
    <div
      className="ai-msg assistant study quiz-one"
      ref={boxRef}
      tabIndex={0}
      onKeyDown={(e) => {
        const k = e.key.toLowerCase();
        const idx = /^[1-6]$/.test(k) ? Number(k) - 1 : /^[a-f]$/.test(k) ? k.charCodeAt(0) - 97 : -1;
        if (idx >= 0 && picked === null && !done) {
          e.preventDefault();
          answer(idx);
        } else if (k === 'enter' && picked !== null) {
          e.preventDefault();
          next();
        }
      }}
    >
      <div className="study-head">
        <span>Practice quiz</span>
        <span className="muted">{done ? `${deck.length} of ${deck.length}` : `Question ${pos + 1} of ${deck.length}`}</span>
      </div>
      <div className="quiz-progress">
        <span style={{ width: `${(Math.min(pos + (picked !== null ? 1 : 0), deck.length) / deck.length) * 100}%` }} />
      </div>
      {!done ? (
        <div className="quiz-q">
          <div className="quiz-text">{q.question}</div>
          {q.choices.map((c, j) => (
            <button
              key={j}
              disabled={picked !== null}
              className={`quiz-choice ${picked !== null && j === q.answer ? 'right' : ''} ${picked === j && j !== q.answer ? 'wrong' : ''}`}
              onClick={() => answer(j)}
            >
              <span className="quiz-letter">{String.fromCharCode(65 + j)}</span> {c}
            </button>
          ))}
          {picked !== null && (
            <div className={`quiz-feedback ${picked === q.answer ? 'ok' : 'bad'}`}>
              <b>{picked === q.answer ? 'Correct.' : `Not quite: the answer is ${String.fromCharCode(65 + q.answer)}.`}</b> {q.explanation}
            </div>
          )}
          <div className="ai-actions quiz-nav">
            <span className="muted">{score} right so far</span>
            <button className="btn sm tonal" disabled={picked === null} onClick={next} title="Enter">
              {pos + 1 < deck.length ? 'Next question' : 'See results'} <ChevronRight size={14} />
            </button>
          </div>
        </div>
      ) : (
        <div className="study-done">
          <div className="study-score">
            {score} / {deck.length} correct ({Math.round((score / deck.length) * 100)}%)
          </div>
          {score < deck.length && (
            <div className="quiz-missed">
              <div className="muted">Review what you missed:</div>
              {deck.map((x, i) =>
                results[i] === false ? (
                  <div key={i} className="quiz-missed-item">
                    <div>{x.question}</div>
                    <div className="quiz-why">
                      <b>{x.choices[x.answer]}</b>
                      {x.explanation ? ` · ${x.explanation}` : ''}
                    </div>
                  </div>
                ) : null
              )}
            </div>
          )}
          <div className="ai-actions">
            {score < deck.length && (
              <button className="btn sm tonal" onClick={() => restart(true)}>
                <RotateCcw size={13} /> Retry the ones I missed
              </button>
            )}
            <button className="btn sm tonal" onClick={() => restart(false)}>
              <Shuffle size={13} /> Take it again (shuffled)
            </button>
          </div>
        </div>
      )}
      <div className="ai-actions">
        {hooks?.insertText && (
          <button className="btn sm" onClick={() => (hooks.insertText(asMarkdown()) ? toast('Inserted. Ctrl+Z to undo.', 'success') : toast("Couldn't insert here."))}>
            <CornerDownLeft size={13} /> {hooks.insertLabel || 'Insert'}
          </button>
        )}
        <button className="icon-btn sm" title="Copy quiz" onClick={() => navigator.clipboard.writeText(asMarkdown()).then(() => toast('Copied', 'success'))}>
          <Copy size={14} />
        </button>
      </div>
    </div>
  );
}
