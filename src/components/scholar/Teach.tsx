// Teach, in the study player's side pane: Claude's lesson on the question just answered (or on a highlighted part of
// it), written on the spot through the student's own Claude plan and streamed in as it's written. A lesson is the idea,
// where the answer went wrong, then the steps (each calculation, each part of a structure, each stage of a process),
// then check questions on the same idea from a new angle. Those are practice inside the lesson: nothing about them is
// saved as an answer, so they never count towards what's learned. Follow-up questions continue the same conversation.
// Lessons are saved per question, so they open again free (and on the phone, which asks the PC to write them).
import { useEffect, useMemo, useRef, useState } from 'react';
import MarkdownIt from 'markdown-it';
import { ArrowUp, Check, GraduationCap, RotateCcw, Square, X } from 'lucide-react';
import { api, Lesson, StudyQuestion, TeachCheck } from '../../lib/api';
import { uid } from '../../lib/util';
import { setting } from '../../lib/settings';
import { latexToText } from '../../lib/lookup';

/** The question in front of the student, answered: what Teach is about. */
export interface TeachSubject {
  k: string;
  q: StudyQuestion;
  courseCode: string;
  /** Their answer in the question's own choice numbers (not the shuffled order on screen). */
  answer: number | number[] | boolean | string | null;
  right: boolean | null;
  dunno: boolean;
}

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
md.renderer.rules.link_open = (tokens, i, options, _env, self) => {
  tokens[i].attrSet('target', '_blank');
  tokens[i].attrSet('rel', 'noreferrer');
  return self.renderToken(tokens, i, options);
};
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** The lesson without its check block (also while it's still being written). */
const bodyOf = (text: string) => text.replace(/```check[\s\S]*?(```|$)/, '').trim();
const modelName = (m: string) => (/opus/i.test(m) ? 'Opus' : /haiku/i.test(m) ? 'Haiku' : 'Sonnet');

/** A lesson's Markdown, with its math typeset (offline, MathJax) once drawn and readable text until then. */
function LessonText({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => {
    const tex: { t: string; d: boolean }[] = [];
    // Math out of the way first, so Markdown doesn't read its _ and * as emphasis.
    const src = text.replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\$([^$\n]+?)\$|\\\(([\s\S]+?)\\\)/g, (_m, a, b, c, d) => {
      tex.push({ t: (a ?? b ?? c ?? d).trim(), d: a != null || b != null });
      return `@@TEX${tex.length - 1}@@`;
    });
    return md.render(src).replace(/@@TEX(\d+)@@/g, (_m, i) => {
      const x = tex[Number(i)];
      return `<span class="tx${x.d ? ' display' : ''}" data-tex="${esc(x.t)}">${esc(latexToText(x.t))}</span>`;
    });
  }, [text]);
  useEffect(() => {
    let live = true;
    const spans = [...(ref.current?.querySelectorAll<HTMLElement>('span.tx:not([data-done])') || [])];
    if (!spans.length) return;
    import('../../lib/tex')
      .then(async ({ texToSvg }) => {
        for (const s of spans) {
          const svg = await texToSvg(s.dataset.tex || '', s.classList.contains('display')).catch(() => '');
          if (!live) return;
          if (svg && !/math-error/.test(svg)) (s.innerHTML = svg), s.setAttribute('data-done', '');
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [html]);
  return <div ref={ref} className="tc-text" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** The check questions: pick one to see if it's right and why. Practice only, never saved. */
function Checks({ checks }: { checks: TeachCheck[] }) {
  const [picked, setPicked] = useState<Record<number, number>>({});
  if (!checks.length) return null;
  return (
    <div className="tc-checks">
      <div className="tc-checks-head">
        Check yourself <span className="muted">· practice, doesn’t count towards what you’ve learned</span>
      </div>
      {checks.map((c, i) => {
        const p = picked[i];
        const done = p != null;
        return (
          <div key={i} className="tc-check">
            <div className="tc-check-q">
              <LessonText text={c.q} />
            </div>
            <div className="tc-choices">
              {c.choices.map((ch, j) => (
                <button key={j} disabled={done} className={`tc-choice ${done && j === c.answer ? 'right' : ''} ${done && j === p && p !== c.answer ? 'wrong' : ''}`} onClick={() => setPicked((x) => ({ ...x, [i]: j }))}>
                  <span className="tc-letter">{String.fromCharCode(65 + j)}</span>
                  <LessonText text={ch} />
                  {done && j === c.answer && <Check size={14} />}
                  {done && j === p && p !== c.answer && <X size={14} />}
                </button>
              ))}
            </div>
            {done && (
              <div className={`tc-why ${p === c.answer ? 'right' : 'wrong'}`}>
                <b>{p === c.answer ? 'Right.' : 'Not quite.'}</b> <LessonText text={c.why} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** One lesson: the text, its checks, then each follow-up and its answer. */
function LessonView({ lesson }: { lesson: Lesson }) {
  return (
    <div className="tc-lesson">
      {lesson.focus && <div className="tc-focus">On “{lesson.focus}”</div>}
      <LessonText text={lesson.text} />
      <Checks checks={lesson.checks} />
      {lesson.followups.map((f, i) => (
        <div key={i} className="tc-follow">
          <div className="tc-ask">{f.ask}</div>
          <LessonText text={f.text} />
          <Checks checks={f.checks} />
        </div>
      ))}
    </div>
  );
}

/**
 * The Teach tab. `ask` (from a "Teach" button or a highlight) starts a lesson; just opening the tab never does, so
 * moving on with the tab open doesn't spend anything.
 */
export function TeachPane({ subject, ask }: { subject: TeachSubject | null; ask: { text: string; at: number } | null }) {
  const [lessons, setLessons] = useState<Lesson[] | null>(null);
  const [run, setRun] = useState<{ id: string; text: string; ask?: string; focus?: string } | null>(null);
  const [error, setError] = useState('');
  const [queued, setQueued] = useState('');
  const [draft, setDraft] = useState('');
  const [older, setOlder] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const k = subject?.k || '';
  const handled = useRef(0);

  useEffect(() => {
    let live = true;
    setLessons(null);
    setError('');
    setQueued('');
    setOlder(false);
    if (k) api.scholar.lessons(k).then((l) => live && setLessons(l || [])).catch(() => live && setLessons([]));
    // (A lesson asked for on the phone arrives with the PC's next copy.)
    const off = api.scholar.onChanged(() => k && api.scholar.lessons(k).then((l) => live && l && setLessons(l)).catch(() => {}));
    return () => {
      live = false;
      off();
    };
  }, [k]);
  // The text as it streams in.
  useEffect(() => api.scholar.onTeach(({ id, text }) => setRun((r) => (r && r.id === id ? { ...r, text: r.text + text } : r))), []);
  // A lesson running when the question changes or the pane closes is stopped (it's saved only if it finished).
  useEffect(() => {
    return () => {
      setRun((r) => {
        if (r) api.scholar.teachStop(r.id);
        return null;
      });
    };
  }, [k]);
  const latest = lessons?.[lessons.length - 1] || null;
  // While Claude writes, the reading stays where it starts (a new lesson at the top, a follow-up at its question)
  // instead of following the text down.
  useEffect(() => {
    const box = scroller.current;
    if (!run || !box) return;
    const at = run.ask ? box.querySelector<HTMLElement>('[data-run]') : null;
    box.scrollTo({ top: at ? Math.max(0, at.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 8) : 0 });
  }, [run?.id]);

  const start = async (req: { focus?: string; lessonId?: string; ask?: string; again?: boolean }) => {
    if (!subject || run) return;
    const id = uid();
    setError('');
    setQueued('');
    setRun({ id, text: '', ask: req.ask, focus: req.focus });
    if (req.ask) setDraft('');
    try {
      const r = await api.scholar.teach(id, { k: subject.k, answer: subject.answer, right: subject.right, dunno: subject.dunno, question: subject.q, courseCode: subject.courseCode, ...req });
      if (r.queued) setQueued(req.ask ? 'Asked your PC. Claude answers there, and it shows here with your PC’s next copy (a minute or two while it’s on).' : 'Claude runs on your PC, so the phone asked it. The lesson shows here with your PC’s next copy (a minute or two while it’s on), and stays with this question.');
      else if (r.error) setError(r.error);
      else if (r.lesson) {
        const l = r.lesson;
        setLessons((ls) => [...(ls || []).filter((x) => x.id !== l.id), l]);
        if (!req.lessonId) scroller.current?.scrollTo({ top: 0 });
      }
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setRun((x) => (x?.id === id ? null : x));
    }
  };

  // Asked from a button or a highlight: a new lesson (on the highlight, if there is one).
  useEffect(() => {
    if (!ask || ask.at === handled.current || !subject || lessons === null) return;
    handled.current = ask.at;
    // (The whole question asked again with a lesson already saved: that lesson, not another.)
    if (!ask.text && latest && !latest.focus) return;
    start({ focus: ask.text || undefined });
  }, [ask?.at, lessons === null, k]);

  if (!subject) return <div className="tc-empty muted">Answer the question first.</div>;
  const model = modelName(setting('study.teach.model') || 'claude-sonnet-5-5');
  return (
    <div className="st-teach" ref={scroller}>
      {lessons === null ? (
        <div className="spinner" />
      ) : !latest && !run && queued ? (
        <div className="tc-intro">
          <GraduationCap size={26} />
          <div className="tc-intro-title">Your PC is writing the lesson</div>
          <div className="muted">{queued}</div>
        </div>
      ) : !latest && !run ? (
        <div className="tc-intro">
          <GraduationCap size={26} />
          <div className="tc-intro-title">Learn the idea behind this question</div>
          <div className="muted">Claude teaches it step by step for your answer: the concept, where it went wrong, each step or part, then a couple of questions to check yourself. Highlight any words in the question to be taught just that.</div>
          <button className="btn primary" onClick={() => start({})}>
            <GraduationCap size={15} /> Teach me this
          </button>
          <div className="muted small">On your Claude plan · {model}</div>
        </div>
      ) : (
        <>
          {lessons && lessons.length > 1 && (
            <button className="tc-older" onClick={() => setOlder(!older)}>
              {older ? 'Hide' : 'Show'} earlier lessons ({lessons.length - 1})
            </button>
          )}
          {older && lessons?.slice(0, -1).map((l) => <LessonView key={l.id} lesson={l} />)}
          {/* A new lesson while it's written replaces the view; a follow-up is written under the lesson. */}
          {latest && !(run && !run.ask) && <LessonView lesson={latest} />}
          {run && (
            <div className={run.ask ? 'tc-follow' : 'tc-lesson'} data-run>
              {run.ask && <div className="tc-ask">{run.ask}</div>}
              {!run.ask && run.focus && <div className="tc-focus">On “{run.focus}”</div>}
              {run.text ? <LessonText text={bodyOf(run.text)} /> : null}
              <div className="tc-writing">
                <span className="dot-pulse" /> {run.text ? 'Writing…' : run.ask ? 'Thinking about your question…' : `Claude is preparing your lesson (${model})…`}
                <button className="btn sm ghost" onClick={() => api.scholar.teachStop(run.id)}>
                  <Square size={12} /> Stop
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {error && <div className="tc-error">{error}</div>}
      {queued && latest && <div className="tc-queued muted">{queued}</div>}
      {latest && !run && (
        <div className="tc-more">
          <form
            className="tc-input"
            onSubmit={(e) => {
              e.preventDefault();
              if (draft.trim()) start({ lessonId: latest.id, ask: draft.trim() });
            }}
          >
            <textarea
              className="input"
              rows={1}
              value={draft}
              placeholder="Ask a follow-up, or say “give me another one”"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // (Enter sends; the study keys stay out of it.)
                e.stopPropagation();
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  if (draft.trim()) start({ lessonId: latest.id, ask: draft.trim() });
                }
              }}
            />
            <button className="icon-btn" type="submit" title="Ask" disabled={!draft.trim()}>
              <ArrowUp size={16} />
            </button>
          </form>
          <button className="btn sm ghost tc-again" onClick={() => start({ again: true })} title="A fresh lesson on the whole question, from another angle">
            <RotateCcw size={13} /> Teach it a different way
          </button>
        </div>
      )}
    </div>
  );
}
