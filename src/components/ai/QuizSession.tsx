import { useEffect, useRef, useState } from 'react';
import { ChevronRight, RotateCcw, Shuffle, Check, X, FileSearch, HelpCircle, Loader2 } from 'lucide-react';
import { toast } from '../../store';
import { setting } from '../../lib/settings';
import { FORMAT_LABEL, PlanItem, Question, StudyRecord, writeQuestion, contextFor, gradeFill, gradeWritten, recordResult, saveRecord, retestItem, planQuiz } from '../../lib/study';

export interface QuizSessionData {
  docKey: string;
  text: string;
  rec: StudyRecord;
  plan: PlanItem[];
  first: Question | null;
  pool: string[]; // concept ids in scope
  covering: string;
}

type Answer = { picked: number[]; text: string; ok: boolean; feedback?: string; dontKnow?: boolean };
const letter = (i: number) => String.fromCharCode(65 + i);

/**
 * A practice quiz on the open reading, one question at a time. Questions are written in the background while you
 * answer; a missed concept comes back two questions later in another format.
 */
export function QuizSession({ data, hooks }: { data: QuizSessionData; hooks: any }) {
  const [items, setItems] = useState<PlanItem[]>(data.plan);
  // Questions are tied to their plan item (not its position), so inserting a retest never mixes them up.
  const written = useRef(new Map<PlanItem, Question | null>(data.first ? [[data.plan[0], data.first]] : []));
  const [, bump] = useState(0);
  const refresh = () => bump((n) => n + 1);
  const [pos, setPos] = useState(0);
  const [answers, setAnswers] = useState<Record<number, Answer>>({});
  const [sel, setSel] = useState<number[]>([]);
  const [text, setText] = useState('');
  const [grading, setGrading] = useState(false);
  const [round, setRound] = useState(0);
  const cancelled = useRef(false);
  const busy = useRef(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const retested = useRef(new Set<string>());
  useEffect(() => () => void (cancelled.current = true), []);
  useEffect(() => boxRef.current?.focus({ preventScroll: true }), [round]);

  // Write questions ahead of the learner (the current one and the next two), one at a time.
  useEffect(() => {
    if (busy.current || cancelled.current) return;
    const item = [pos, pos + 1, pos + 2].map((i) => items[i]).find((it) => it && !written.current.has(it));
    if (!item) return;
    busy.current = true;
    const avoid = [...written.current.values()].filter(Boolean).map((x) => (x as Question).prompt);
    writeQuestion(item, data.rec, contextFor(data.text, item.concept, item.partner), () => cancelled.current, avoid)
      .then((x) => written.current.set(item, x))
      .catch(() => written.current.set(item, null))
      .finally(() => {
        busy.current = false;
        if (!cancelled.current) refresh();
      });
  });

  // Skip questions that couldn't be written.
  useEffect(() => {
    const it = items[pos];
    if (it && written.current.get(it) === null) setItems((all) => all.filter((x) => x !== it));
  });

  const done = pos >= items.length;
  const q = items[pos] ? written.current.get(items[pos]) : undefined;
  const a = answers[pos];
  const score = Object.values(answers).filter((x) => x.ok).length;

  const finish = async (ok: boolean, extra: Partial<Answer> = {}) => {
    const item = items[pos];
    setAnswers((cur) => ({ ...cur, [pos]: { picked: sel, text, ok, ...extra } }));
    recordResult(data.rec, q ? { ...item, format: q.format } : item, ok, q?.prompt);
    saveRecord(data.docKey, data.rec);
    // A miss comes back two questions later, in a different format (once per concept per quiz).
    const due = Math.max(0, Number(setting('ai.quizRetestAfter') ?? 2));
    if (!ok && !item.retest && !retested.current.has(item.concept.id)) {
      retested.current.add(item.concept.id);
      const at = Math.min(items.length, pos + 1 + due);
      setItems((it) => [...it.slice(0, at), retestItem(item), ...it.slice(at)]);
    }
  };

  const submit = async (dontKnow = false, pick?: number) => {
    if (!q || a || grading) return;
    if (dontKnow) return finish(false, { dontKnow: true });
    if (q.format === 'mc' || q.format === 'tf') {
      const choice = pick ?? sel[0];
      if (choice === undefined) return;
      setSel([choice]);
      return finish(choice === q.correct[0], { picked: [choice] });
    }
    if (q.format === 'multi') {
      if (!sel.length) return;
      const ok = sel.length === q.correct.length && sel.every((i) => q.correct.includes(i));
      return finish(ok);
    }
    if (!text.trim()) return;
    if (q.format === 'fill') {
      if (gradeFill(q, text)) return finish(true);
      // Not an exact match: let the AI decide whether it's an acceptable synonym.
      setGrading(true);
      const g = await gradeWritten(q.prompt.replace('_____', '___'), [`The blank is "${q.accepted[0]}" (or an exact synonym)`], text, () => cancelled.current).catch(() => ({ correct: false, feedback: '' }));
      setGrading(false);
      return finish(g.correct, { feedback: g.feedback });
    }
    setGrading(true);
    const g = await gradeWritten(q.prompt, q.keyPoints, text, () => cancelled.current).catch(() => ({ correct: false, feedback: "Couldn't grade this answer." }));
    setGrading(false);
    return finish(g.correct, { feedback: g.feedback });
  };

  const next = () => {
    if (!a) return;
    setSel([]);
    setText('');
    setPos(pos + 1);
  };

  const restart = (onlyMissed: boolean) => {
    const pool = data.rec.concepts.filter((c) => data.pool.includes(c.id));
    const missedIds = items.filter((_, i) => answers[i] && !answers[i].ok).map((it) => it.concept.id);
    const base = onlyMissed ? pool.filter((c) => missedIds.includes(c.id)) : pool;
    const count = onlyMissed ? Math.max(1, Math.min(base.length * 2, 10)) : data.plan.length;
    const plan = planQuiz(data.rec, count, base.length ? base : pool, (setting('ai.studyDifficulty') as any) || 'medium', onlyMissed);
    retested.current.clear();
    written.current.clear();
    setItems(plan);
    setAnswers({});
    setSel([]);
    setText('');
    setPos(0);
    setRound((r) => r + 1);
  };

  const correctText = (x: Question) =>
    x.format === 'fill' ? x.accepted[0] : x.format === 'short' ? x.modelAnswer || x.keyPoints.join('; ') : x.correct.map((i) => `${letter(i)}. ${x.choices[i]}`).join(' · ');
  const showSource = (src: string) => (hooks?.reveal?.(src) ? undefined : toast("Couldn't find that passage in the document."));

  return (
    <div
      className="ai-msg assistant study quiz-one"
      ref={boxRef}
      tabIndex={0}
      onKeyDown={(e) => {
        if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA') {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            a ? next() : submit();
          }
          return;
        }
        if (!q || done) return;
        const k = e.key.toLowerCase();
        const idx = /^[1-6]$/.test(k) ? Number(k) - 1 : -1;
        if (idx >= 0 && idx < q.choices.length && !a) {
          e.preventDefault();
          if (q.format === 'multi') setSel((s) => (s.includes(idx) ? s.filter((x) => x !== idx) : [...s, idx]));
          else submit(false, idx);
        } else if (k === 'enter') {
          e.preventDefault();
          a ? next() : submit();
        }
      }}
    >
      <div className="study-head">
        <span>Practice quiz</span>
        <span className="muted">{done ? `${items.length} of ${items.length}` : `Question ${pos + 1} of ${items.length}`}</span>
      </div>
      {data.covering && <div className="quiz-covering">Covering: {data.covering}</div>}
      <div className="quiz-progress">
        <span style={{ width: `${(Math.min(pos + (a ? 1 : 0), items.length) / Math.max(1, items.length)) * 100}%` }} />
      </div>

      {!done && !q && (
        <div className="quiz-wait">
          <Loader2 size={15} className="spin" /> Writing the next question…
        </div>
      )}

      {!done && q && (
        <div className="quiz-q">
          <div className="quiz-tags">
            <span className="quiz-tag">{FORMAT_LABEL[q.format]}</span>
            {items[pos].retest && <span className="quiz-tag again">Again, a new way</span>}
            {items[pos].kind === 'applied' && <span className="quiz-tag">Apply it</span>}
          </div>
          <div className="quiz-text">{q.prompt}</div>

          {(q.format === 'mc' || q.format === 'tf' || q.format === 'multi') &&
            q.choices.map((c, j) => {
              const chosen = sel.includes(j);
              const right = a && q.correct.includes(j);
              const wrong = a && chosen && !q.correct.includes(j);
              return (
                <button
                  key={j}
                  disabled={!!a}
                  className={`quiz-choice ${chosen && !a ? 'chosen' : ''} ${right ? 'right' : ''} ${wrong ? 'wrong' : ''}`}
                  onClick={() => {
                    // Single-choice questions are answered on click; select-all toggles until "Check answer".
                    if (q.format === 'multi') setSel((s) => (s.includes(j) ? s.filter((x) => x !== j) : [...s, j]));
                    else submit(false, j);
                  }}
                >
                  <span className="quiz-letter">{q.format === 'multi' ? (chosen || right ? '☑' : '☐') : letter(j)}</span> {c}
                </button>
              );
            })}

          {(q.format === 'fill' || q.format === 'short') &&
            (q.format === 'fill' ? (
              <input className="input quiz-input" placeholder="Type the missing word or term" value={text} disabled={!!a} onChange={(e) => setText(e.target.value)} autoFocus />
            ) : (
              <textarea className="input quiz-input" rows={3} placeholder="Answer in 1–3 sentences" value={text} disabled={!!a} onChange={(e) => setText(e.target.value)} autoFocus />
            ))}

          {!a && (
            <div className="ai-actions quiz-nav">
              <button className="btn sm" onClick={() => submit(true)} disabled={grading} title="Counts as a miss, and you'll see the answer">
                <HelpCircle size={13} /> I don't know
              </button>
              {(q.format === 'multi' || q.format === 'fill' || q.format === 'short') && (
                <button className="btn sm tonal" onClick={() => submit()} disabled={grading || (q.format === 'multi' ? !sel.length : !text.trim())}>
                  {grading ? (
                    <>
                      <Loader2 size={13} className="spin" /> Checking…
                    </>
                  ) : (
                    <>
                      <Check size={13} /> Check answer
                    </>
                  )}
                </button>
              )}
            </div>
          )}

          {a && (
            <>
              <div className={`quiz-feedback ${a.ok ? 'ok' : 'bad'}`}>
                <b>{a.ok ? 'Correct.' : a.dontKnow ? 'Here’s the answer:' : 'Not quite.'}</b>
                {!a.ok && <div className="quiz-answer">{correctText(q)}</div>}
                {q.format === 'tf' && q.fix && <div className="quiz-answer">True version: {q.fix}</div>}
                {a.feedback && <div>{a.feedback}</div>}
                {q.explanation && <div className="quiz-why">{q.explanation}</div>}
                {!a.ok && hooks?.reveal && (
                  <button className="link-btn quiz-src" onClick={() => showSource(items[pos].concept.source)}>
                    <FileSearch size={12} /> Show in document
                  </button>
                )}
              </div>
              <div className="ai-actions quiz-nav">
                <span className="muted">{score} right so far</span>
                <button className="btn sm tonal" onClick={next} title="Enter">
                  {pos + 1 < items.length ? 'Next question' : 'See results'} <ChevronRight size={14} />
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {done && (
        <div className="study-done">
          <div className="study-score">
            {score} / {items.length} correct ({Math.round((score / Math.max(1, items.length)) * 100)}%)
          </div>
          {score < items.length && (
            <div className="quiz-missed">
              <div className="muted">Review what you missed:</div>
              {items.map((it, i) =>
                answers[i] && !answers[i].ok && written.current.get(it) ? (
                  <div key={i} className="quiz-missed-item">
                    <div>
                      <b>{it.concept.name}</b> <span className="muted">· {it.concept.section}</span>
                    </div>
                    <div className="quiz-why">{correctText(written.current.get(it) as Question)}</div>
                    {hooks?.reveal && (
                      <button className="link-btn quiz-src" onClick={() => showSource(it.concept.source)}>
                        <FileSearch size={12} /> Show in document
                      </button>
                    )}
                  </div>
                ) : null
              )}
            </div>
          )}
          <div className="ai-actions">
            {score < items.length && (
              <button className="btn sm tonal" onClick={() => restart(true)}>
                <RotateCcw size={13} /> Quiz me on what I missed
              </button>
            )}
            <button className="btn sm tonal" onClick={() => restart(false)}>
              <Shuffle size={13} /> New quiz
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
