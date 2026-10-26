// What a student sees after checking an answer: right or wrong, why each choice is right or wrong, and the worked
// solution as a walkthrough (what the question asks, the formula with every symbol explained, each step, the answer
// boxed). Older questions with plain-text steps show them as a numbered list. Everything here is written with the
// question, so it shows at once.
import { useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronRight, HelpCircle, X } from 'lucide-react';
import { StudyQuestion, StudyStep } from '../../lib/api';
import { cachedSvg, texToSvg } from '../../lib/tex';
import { MathText } from './MathText';

type Shown = { q: StudyQuestion; order: number[] };
type Answer = number | number[] | boolean | string | null;

/** LaTeX drawn as math (MathJax, offline); plain text with symbols until it's drawn, or if it can't be. */
export function Tex({ tex, display }: { tex: string; display?: boolean }) {
  const [svg, setSvg] = useState(() => cachedSvg(tex, !!display));
  useEffect(() => {
    let live = true;
    const hit = cachedSvg(tex, !!display);
    if (hit) setSvg(hit);
    else texToSvg(tex, !!display).then((s) => live && setSvg(s));
    return () => {
      live = false;
    };
  }, [tex, display]);
  if (!svg || !svg.startsWith('<svg')) return <span className={display ? 'ex-tex display plain' : 'ex-tex plain'}><MathText text={tex} /></span>;
  return <span className={display ? 'ex-tex display' : 'ex-tex'} dangerouslySetInnerHTML={{ __html: svg }} />;
}

/** A step as one line of plain text (for places that list steps compactly, and for Claude's briefs). */
export const stepText = (s: StudyStep) =>
  typeof s === 'string' ? s : [s.title, s.text, s.math, ...(s.terms || []).map((t) => `${t.sym}: ${t.means}${t.value ? ` = ${t.value}` : ''}`)].filter(Boolean).join(' — ');

/** A calculation or multi-step question: its walkthrough opens by itself, right or wrong. */
export const isWorked = (q: StudyQuestion) => q.type === 'num' || (q as any).level === 'apply' || (q as any).level === 'multistep' || !!q.final;

/** Has a walkthrough in the new form (headed steps, or what it asks / the boxed answer). */
const isWalkthrough = (q: StudyQuestion) => !!q.asks || !!q.final || (q.steps || []).some((s) => typeof s !== 'string');

const letter = (pos: number) => String.fromCharCode(65 + pos);

function answerLine(q: StudyQuestion, s: Shown) {
  if (q.type === 'mc') {
    const pos = s.order.indexOf(q.answer);
    return (
      <>
        {letter(pos)}. <MathText text={q.choices[q.answer]} />
      </>
    );
  }
  if (q.type === 'multi')
    return (
      <>
        {q.answer
          .map((orig) => s.order.indexOf(orig))
          .sort((a, b) => a - b)
          .map(letter)
          .join(', ')}
      </>
    );
  if (q.type === 'tf') return <>{q.answer ? 'True' : 'False'}</>;
  if (q.type === 'num')
    return (
      <>
        {q.answer}
        {q.unit ? ` ${q.unit}` : ''}
      </>
    );
  if (q.type === 'match') return <>shown beside each term</>;
  return <MathText text={q.answer} />;
}

/** `dunno`: the student said they didn't know: the answer and the whole walkthrough, without a verdict. */
export function Explanation({ q, s, answer, result, onSelf, dunno }: { q: StudyQuestion; s: Shown; answer: Answer; result: boolean | null; onSelf(ok: boolean): void; dunno?: boolean }) {
  return (
    <div className="st-explain ex">
      {dunno ? (
        <div className="ex-verdict help">
          <HelpCircle size={16} />
          <span>
            <b>Here’s how it works.</b> The answer is {q.type === 'short' ? <MathText text={q.answer} /> : answerLine(q, s)}.
          </span>
        </div>
      ) : q.type === 'short' ? (
        <div className="ex-verdict mark">
          <b>Model answer</b>
          <div className="ex-model">
            <MathText text={q.answer} />
          </div>
        </div>
      ) : result === null ? null : (
        <div className={`ex-verdict ${result ? 'right' : 'wrong'}`}>
          {result ? <Check size={16} /> : <X size={16} />}
          <span>
            <b>{result ? 'Correct.' : 'Not quite.'}</b>
            {!result && (
              <>
                {' '}
                The answer is {answerLine(q, s)}.
              </>
            )}
          </span>
        </div>
      )}
      {q.explain && (
        <section className="ex-sec">
          <h4>Why</h4>
          <div className="ex-text">
            <MathText text={q.explain} />
          </div>
        </section>
      )}
      {(q.type === 'mc' || q.type === 'multi') && <Choices q={q} s={s} answer={answer} />}
      <Walkthrough q={q} open={!!dunno || result === false || isWorked(q)} />
      {q.type === 'short' && !dunno && (
        <div className="st-self">
          <span className="muted">Did you get it?</span>
          <button className={`btn sm ${result === true ? 'tonal' : ''}`} onClick={() => onSelf(true)}>
            <Check size={13} /> Yes
          </button>
          <button className={`btn sm ${result === false ? 'tonal' : ''}`} onClick={() => onSelf(false)}>
            <X size={13} /> No
          </button>
        </div>
      )}
      {(q.chapter || q.topic) && <div className="muted st-src">{[q.chapter, q.topic, q.source].filter(Boolean).join(' · ')}</div>}
    </div>
  );
}

/** Every choice, in the order shown, marked right or wrong with the reason (the mistake a wrong one stands for). */
function Choices({ q, s, answer }: { q: Extract<StudyQuestion, { type: 'mc' | 'multi' }>; s: Shown; answer: Answer }) {
  const picked = new Set((q.type === 'mc' ? [answer] : Array.isArray(answer) ? answer : []).filter((p): p is number => typeof p === 'number'));
  const right = (orig: number) => (q.type === 'mc' ? q.answer === orig : (q.answer as number[]).includes(orig));
  // (Without any notes there's nothing to add beyond the colours on the choices themselves.)
  if (!q.wrong?.some(Boolean)) return null;
  return (
    <section className="ex-sec">
      <h4>Each choice</h4>
      <ul className="ex-choices">
        {s.order.map((orig, pos) => {
          const ok = right(orig);
          const note = ok ? 'This is the answer.' : q.wrong?.[orig] || 'Not the answer.';
          return (
            <li key={pos} className={`${ok ? 'right' : 'wrong'} ${picked.has(pos) ? 'picked' : ''}`}>
              <span className="ex-mark">{ok ? <Check size={14} /> : <X size={14} />}</span>
              <div>
                <div className="ex-choice">
                  <b>{letter(pos)}.</b> <MathText text={q.choices[orig]} />
                  {picked.has(pos) && <span className="ex-yours">Your answer</span>}
                </div>
                <div className="ex-note">
                  <MathText text={note} />
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The worked solution, written with the question. */
export function Walkthrough({ q, open: startOpen }: { q: StudyQuestion; open: boolean }) {
  const [open, setOpen] = useState(startOpen);
  useEffect(() => setOpen(startOpen), [startOpen, q.k]);
  if (q.type === 'short') return null;
  const steps = q.steps || [];
  if (!steps.length && !q.final) return null;
  const walk = isWalkthrough(q);
  return (
    <section className="ex-sec ex-walk">
      <button className="ex-walk-head" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        <h4>Step by step</h4>
        {!open && <span className="muted">{steps.length} steps</span>}
      </button>
      {open && (
        <div className="ex-walk-body">
          {q.answerDisputed && <div className="st-disputed">Kea’s review found the stored answer to this question may be wrong: the steps below work it correctly.</div>}
          {q.asks && (
            <div className="ex-asks">
              <div className="ex-label">What the question is asking</div>
              <MathText text={q.asks} />
            </div>
          )}
          <ol className={walk ? 'ex-steps' : 'ex-steps plain'}>
            {steps.map((st, i) => (
              <Step key={i} n={i + 1} step={st} />
            ))}
          </ol>
          {q.final && (q.final.math || q.final.text) && (
            <div className="ex-final">
              <div className="ex-label">Answer</div>
              {q.final.math && <Tex tex={`\\boxed{${q.final.math}}`} display />}
              {q.final.text && (
                <div>
                  <MathText text={q.final.text} />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function Step({ n, step }: { n: number; step: StudyStep }) {
  if (typeof step === 'string')
    return (
      <li>
        <MathText text={step} />
      </li>
    );
  return (
    <li className="ex-step">
      <div className="ex-step-head">
        <span className="ex-step-n">Step {n}</span>
        {step.title && <b>{step.title}</b>}
      </div>
      {step.text && (
        <div className="ex-text">
          <MathText text={step.text} />
        </div>
      )}
      {step.math && <Tex tex={step.math} display />}
      {!!step.terms?.length && (
        <dl className="ex-terms">
          {step.terms.map((t, i) => (
            <div key={i}>
              <dt>
                <Tex tex={t.sym} />
              </dt>
              <dd>
                <span>
                  <MathText text={t.means} />
                </span>
                {t.value && (
                  <span className="ex-val">
                    {' = '}
                    <MathText text={t.value} />
                  </span>
                )}
                {t.why && (
                  <span className="ex-why">
                    <MathText text={t.why} />
                  </span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  );
}
