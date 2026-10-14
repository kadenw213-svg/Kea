import { useMemo, useState } from 'react';
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

/** Multiple-choice practice quiz with instant feedback and a score. */
export function QuizView({ questions, hooks }: { questions: QuizQuestion[]; hooks: any }) {
  const [picked, setPicked] = useState<Record<number, number>>({});
  const answered = Object.keys(picked).length;
  const score = useMemo(() => questions.filter((q, i) => picked[i] === q.answer).length, [picked, questions]);
  const asMarkdown = () =>
    questions
      .map((q, i) => `${i + 1}. ${q.question}\n${q.choices.map((c, j) => `   ${String.fromCharCode(65 + j)}) ${c}`).join('\n')}`)
      .join('\n\n') +
    '\n\n**Answers:** ' +
    questions.map((q, i) => `${i + 1}${String.fromCharCode(65 + q.answer)}`).join(', ');

  return (
    <div className="ai-msg assistant study">
      <div className="study-head">
        <span>Practice quiz · {questions.length} questions</span>
        {answered > 0 && (
          <span className="muted">
            {score} / {answered} right
          </span>
        )}
      </div>
      {questions.map((q, i) => {
        const p = picked[i];
        const done = p !== undefined;
        return (
          <div key={i} className="quiz-q">
            <div className="quiz-text">
              {i + 1}. {q.question}
            </div>
            {q.choices.map((c, j) => (
              <button
                key={j}
                disabled={done}
                className={`quiz-choice ${done && j === q.answer ? 'right' : ''} ${done && j === p && p !== q.answer ? 'wrong' : ''}`}
                onClick={() => setPicked({ ...picked, [i]: j })}
              >
                <span className="quiz-letter">{String.fromCharCode(65 + j)}</span> {c}
              </button>
            ))}
            {done && q.explanation && <div className="quiz-why">{q.explanation}</div>}
          </div>
        );
      })}
      {answered === questions.length && (
        <div className="study-done">
          <div className="study-score">
            Score: {score} / {questions.length} ({Math.round((score / questions.length) * 100)}%)
          </div>
          <div className="ai-actions">
            <button className="btn sm tonal" onClick={() => setPicked({})}>
              <RotateCcw size={13} /> Try again
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
