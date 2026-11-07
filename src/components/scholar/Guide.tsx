// An assignment's guide, in the item panel on the PC and the item sheet on the phone: what it's about and its goal, the
// special notes, each step in order (its detail folded until opened, like a question's step by step), a lab's procedure
// and notebook checklist, what to hand in and where, and the class site's rubric. The phone shows the short version.
// Claude writes the guides ahead of time (electron/scholar/guides.cjs); until one is written, the class site's own
// wording shows, folded. The original wording is always there at the bottom, folded.
import { ReactNode, useEffect, useMemo, useState } from 'react';
import MarkdownIt from 'markdown-it';
import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, ExternalLink, FlaskConical, Link2, Lock, Monitor, NotebookPen, RefreshCw, Search, Target, Upload } from 'lucide-react';
import { api, Guide, ScholarItem } from '../../lib/api';
import { TESTS, willGuide } from './itemRules';

// Writing work: what the student is writing about leads the guide.
const FOCUS = new Set(['paper', 'discussion', 'project', 'presentation']);

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
md.renderer.rules.link_open = (tokens, i, options, _env, self) => {
  tokens[i].attrSet('target', '_blank');
  tokens[i].attrSet('rel', 'noreferrer');
  return self.renderToken(tokens, i, options);
};

// Every screen shares one copy of the guides, read again whenever Kea's data changes (a new guide, a phone sync).
let cache: Record<string, Guide> | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
function load() {
  loading = api.scholar
    .guides()
    .then((g) => {
      cache = g || {};
    })
    .catch(() => {
      cache = cache || {};
    })
    .finally(() => listeners.forEach((f) => f()));
  return loading;
}
let watching = false;
/** Every assignment's guide, by item id (null while loading). */
export function useGuides() {
  const [, bump] = useState(0);
  useEffect(() => {
    const f = () => bump((n) => n + 1);
    listeners.add(f);
    if (!cache && !loading) load();
    if (!watching) {
      watching = true;
      api.scholar.onChanged(() => load());
    }
    return () => {
      listeners.delete(f);
    };
  }, []);
  return cache;
}

// Rescans asked for, by item id (when), so the button says so until the new guide arrives, even if the panel closed.
const rescans = new Map<string, number>();
/** Ask for an assignment's guide to be written again now; true once asked. */
async function rescan(it: ScholarItem) {
  await api.scholar.guideRescan(it.id, it.courseCode);
  rescans.set(it.id, Date.now());
  listeners.forEach((f) => f());
}
/** Rescan: the button, and what it says while Kea works. */
function Rescan({ it, g, button, label }: { it: ScholarItem; g: Guide; button?: boolean; label: string }) {
  const [, bump] = useState(0);
  const [error, setError] = useState('');
  const asked = rescans.get(it.id);
  // (Done once a guide newer than the ask arrives.)
  const waiting = !!asked && Date.parse(g.at) < asked;
  if (waiting)
    return (
      <div className="gd-rescanning muted">
        <RefreshCw size={13} className="gd-spin" /> Kea is reading this assignment again. The new guide appears here when it’s written: a few minutes on your PC, or with its next copy on your phone.
      </div>
    );
  return (
    <>
      <button className={button ? 'btn sm tonal' : 'gd-again'} onClick={() => rescan(it).then(() => bump((n) => n + 1), (e) => setError(String(e?.message || e)))}>
        <RefreshCw size={13} /> {label}
      </button>
      {error && <div className="gd-error">{error}</div>}
    </>
  );
}

/** Markdown from a guide (no HTML), with links opening outside Kea. */
function Md({ text, onOpen }: { text: string; onOpen(url: string): void }) {
  const html = useMemo(() => md.render(text), [text]);
  return (
    <div
      className="gd-md"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest('a');
        if (a?.href) {
          e.preventDefault();
          onOpen(a.href);
        }
      }}
    />
  );
}

// Steps checked off, by item and step title (a rewritten guide keeps the ticks of the steps it kept), on this device.
const DONE_KEY = 'kea.guideSteps';
function readDone(): Record<string, true> {
  try {
    return JSON.parse(localStorage.getItem(DONE_KEY) || '{}') || {};
  } catch {
    return {};
  }
}
function useStepChecks(itemId: string) {
  const [all, setAll] = useState(readDone);
  const key = (title: string) => `${itemId}|${title}`;
  return {
    done: (title: string) => !!all[key(title)],
    set(title: string, on: boolean) {
      const next = { ...readDone() };
      if (on) next[key(title)] = true;
      else delete next[key(title)];
      try {
        localStorage.setItem(DONE_KEY, JSON.stringify(next));
      } catch {}
      setAll(next);
    }
  };
}

// Steps the student opened or folded themselves, by item and step title, on this device. A step they never touched
// follows the default (open until checked off). Nothing else changes them: a background refresh of the guides, a
// sync or a checkmark elsewhere never reopens a step that was folded.
const FOLD_KEY = 'kea.guideFolds';
function readFolds(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(FOLD_KEY) || '{}') || {};
  } catch {
    return {};
  }
}
function useStepFolds(itemId: string) {
  const [all, setAll] = useState(readFolds);
  const key = (title: string) => `${itemId}|${title}`;
  return {
    /** true: opened, false: folded, undefined: never touched. */
    choice: (title: string): boolean | undefined => all[key(title)],
    set(changes: [string, boolean][]) {
      const next = { ...readFolds() };
      for (const [title, open] of changes) next[key(title)] = open;
      // (Kept small: the oldest choices go first once there are many.)
      const keys = Object.keys(next);
      for (const k of keys.slice(0, Math.max(0, keys.length - 3000))) delete next[k];
      try {
        localStorage.setItem(FOLD_KEY, JSON.stringify(next));
      } catch {}
      setAll(next);
    }
  };
}

type GuideStep = Guide['steps'][number];
function Step({ n, s, open, done, onDone, onToggle, onOpen, onItem }: { n: number; s: GuideStep; open: boolean; done: boolean; onDone(on: boolean): void; onToggle(): void; onOpen(url: string): void; onItem?(id: string): void }) {
  // (A step about other work in Kea, `item`: the lab a discussion needs, opened in Kea itself with its own links.)
  const item = s.item && onItem ? s.item : null;
  const more = !!(s.detail || s.links?.length || item);
  return (
    <li className={`gd-step ${open ? 'open' : ''} ${done ? 'done' : ''} ${s.unlocks ? 'unlocks' : ''}`}>
      <div className="gd-step-row">
        <button className="gd-check" role="checkbox" aria-checked={done} title={done ? 'Not done yet' : s.unlocks ? 'Done: Kea then reads the instructions it unlocks' : 'Done'} onClick={() => onDone(!done)}>
          {done ? <CheckCircle2 size={18} /> : <span className="gd-n">{n}</span>}
        </button>
        <button className="gd-step-head" onClick={more ? onToggle : undefined} disabled={!more} aria-expanded={more ? open : undefined}>
          <span className="gd-step-title">
            {s.title}
            {s.unlocks && (
              <span className="gd-unlock">
                <Lock size={11} /> unlocks the rest
              </span>
            )}
          </span>
          {more && (open ? <ChevronDown size={15} /> : <ChevronRight size={15} />)}
        </button>
      </div>
      {s.text && <div className="gd-step-text">{s.text}</div>}
      {open && more && (
        <div className="gd-step-detail">
          {s.detail && <Md text={s.detail} onOpen={onOpen} />}
          {(!!s.links?.length || item) && (
            <div className="gd-links">
              {item && (
                <button className="btn sm primary" onClick={() => onItem!(item.id)} title="Opens it here in Kea, with its own links">
                  <Link2 size={13} /> {item.label}
                </button>
              )}
              {(s.links || []).map((l) => (
                <button key={l.url} className="btn sm tonal" onClick={() => onOpen(l.url)} title={l.url}>
                  <ExternalLink size={13} /> {l.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/** Things that aren't supplies to get: devices, accounts, software, files, videos, everyday pens and calculators. */
const NOT_SUPPLY = /\b(video|lecture|computer|laptop|chromebook|internet|wi-?fi|account|access|log ?in|sign ?in|password|browser|software|app|website|site|portal|d2l|canvas|aleks|lesson|open in|pdf|file|document|word|draft|powerpoint|notes|textbook|e-?text|chapter|section|reading|syllabus|rubric|handout|source|post|essay|questions?|minutes|hours|time|pen|pencil|calculator|phone|camera|scanner|printer)s?\b/i;
/** The physical supplies in an older guide's "have ready" list, for a lab only: everything else was never a supply. */
export function supplies(need: string[] | undefined, kind?: string, type?: string): string[] {
  if (kind !== 'lab' && !/^lab/.test(type || '')) return [];
  return (need || []).filter((x) => x && !NOT_SUPPLY.test(x));
}

/**
 * One guide. On the PC, where the work is done, all of it: what it's about and its goal, the special notes, every step,
 * a lab's whole procedure and notebook checklist, what to research, the hand-in and the class site's rubric. `compact`
 * (the phone, for seeing what's coming and handing in paper work): what it's about, the notes and the hand-in.
 */
export function GuideView({ it, g, onOpen, onItem, compact = false }: { it: ScholarItem; g: Guide; onOpen(url: string): void; onItem?(id: string): void; compact?: boolean }) {
  // (A guide from before v0.66.1 kept what unlocks the instructions as a separate gate: it's the first step here.)
  const gated: GuideStep[] =
    g.gate && !g.steps.some((s) => s.unlocks) ? [{ title: g.gate.label || 'Do this first', text: g.gate.what, links: g.gate.url ? [{ label: g.gate.label || 'Open it', url: g.gate.url }] : [], unlocks: true }, ...g.steps] : g.steps;
  // (A guide from before v0.67 listed what to have ready on its own: the physical supplies in it are its first step.)
  const get = supplies(g.need, g.kind, it.type);
  // (A step never repeats the hand-in page, the panel's button; a discussion's steps never link a quiz.)
  const post = it.type === 'discussion' || it.type === 'peer_review';
  const own = new Set([g.submit?.url, ...it.links.filter((l) => l.kind === 'submit').map((l) => l.url)].filter(Boolean));
  const tidy = (s: GuideStep): GuideStep => ({ ...s, links: (s.links || []).filter((l) => !own.has(l.url) && !(post && /quiz_summary|quizzing/i.test(l.url))) });
  const steps: GuideStep[] = (get.length ? [{ title: 'Get your supplies', text: get.join('; '), links: [] }, ...gated] : gated).map(tidy);
  const checks = useStepChecks(it.id);
  const folds = useStepFolds(it.id);
  const [, bump] = useState(0);
  const expandable = steps.map((s, i) => (s.detail || s.links?.length || (s.item && onItem) ? i : -1)).filter((i) => i >= 0);
  // A step the student never opened or folded is open until it's checked off: the questions to answer and the links
  // are the instructions, not extras behind a click. Their own choice always wins.
  const isOpen = (i: number) => folds.choice(steps[i].title) ?? (!compact && !checks.done(steps[i].title));
  // Checking a step off folds it and opens the next step still to do (only then, never by itself); the last step that
  // unlocks the instructions also asks Kea to read them now.
  const check = (s: GuideStep, on: boolean) => {
    checks.set(s.title, on);
    if (on && !compact) {
      const at = steps.indexOf(s);
      const next = expandable.find((i) => i > at && !checks.done(steps[i].title));
      folds.set([[s.title, false], ...(next != null ? ([[steps[next].title, true]] as [string, boolean][]) : [])]);
    }
    if (on && s.unlocks && steps.filter((x) => x.unlocks && x !== s).every((x) => checks.done(x.title))) rescan(it).then(() => bump((n) => n + 1), () => {});
  };
  const all = expandable.length > 0 && expandable.every((i) => isOpen(i));
  const total = g.graded.reduce((n, c) => n + (c.points || 0), 0);
  // (Guides written before v0.66 kept the topic and goal in the writing focus.)
  const topic = g.topic || g.focus?.topic || '';
  const goal = g.goal || g.focus?.question || '';
  const fix = g.focus?.fix || [];
  const notes = [...(g.notes || []), ...g.gaps];
  // (The hand-in page is already a button on the item itself.)
  const ownLink = !!g.submit.url && it.links.some((l) => l.url === g.submit.url);
  const lab = !!(g.procedure || g.notebook?.length);
  // (A quiz or exam is taken, not handed in.)
  const taking = g.kind === 'quiz' || g.kind === 'exam' || TESTS.has(it.type);
  return (
    <section className={`gd ${compact ? 'gd-compact' : ''}`}>
      {topic || goal ? (
        <div className="gd-about">
          <div className="gd-label">
            <Target size={13} /> {FOCUS.has(g.kind) ? 'What you’re writing about' : 'What it’s about'}
          </div>
          {topic && (
            <div className="gd-about-topic">
              {/* (A long one, "Not chosen yet: …" with the options, has only its first sentence in bold.) */}
              <b>{lead(topic)}</b>
              {topic.slice(lead(topic).length)}
            </div>
          )}
          {goal && (
            <p className="gd-about-goal">
              <span className="gd-about-sub">The goal: </span>
              {goal}
            </p>
          )}
        </div>
      ) : (
        g.summary && <p className="gd-summary">{g.summary}</p>
      )}
      {(notes.length > 0 || fix.length > 0) && (
        <Notes compact={compact} count={notes.length + fix.length}>
          {notes.length > 0 && (
            <ul>
              {notes.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
          )}
          {fix.length > 0 && (
            <>
              <div className="gd-notes-sub">From your instructor’s feedback</div>
              <ul>
                {fix.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            </>
          )}
        </Notes>
      )}
      {!compact && (
        <>
          <div className="gd-top">
            <div className="tb-h">What to do</div>
            {expandable.length > 1 && (
              <button className="gd-all" onClick={() => folds.set(expandable.map((i) => [steps[i].title, !all]))}>
                {all ? 'Fold all steps' : 'Open all steps'}
              </button>
            )}
          </div>
          <ol className="gd-steps">
            {steps.map((s, i) => (
              <Step
                key={i}
                n={i + 1}
                s={s}
                open={isOpen(i)}
                done={checks.done(s.title)}
                onDone={(on) => check(s, on)}
                onOpen={onOpen}
                onItem={onItem}
                onToggle={() => folds.set([[s.title, !isOpen(i)]])}
              />
            ))}
          </ol>
          {rescans.has(it.id) && Date.parse(g.at) < rescans.get(it.id)! && (
            <div className="gd-rescanning muted">
              <RefreshCw size={13} className="gd-spin" /> Kea is reading the instructions you unlocked. The rest of this guide appears here when it’s written, in a few minutes.
            </div>
          )}
          {!!g.notebook?.length && (
            <div className="gd-notebook">
              <div className="gd-label">
                <NotebookPen size={13} /> What your lab notebook must have
              </div>
              <ol>
                {g.notebook.map((n, i) => (
                  <li key={i}>
                    <b>{n.item}</b>
                    {n.detail && <span> {n.detail}</span>}
                  </li>
                ))}
              </ol>
            </div>
          )}
          {g.procedure && (
            <details className="gd-fold gd-procedure" open>
              <summary>
                <FlaskConical size={13} /> The lab procedure
              </summary>
              <Md text={g.procedure} onOpen={onOpen} />
            </details>
          )}
          {!!g.focus?.research.length && (
            <details className="gd-fold gd-research">
              <summary>
                <Search size={13} /> What to research ({g.focus.research.length})
              </summary>
              <ul>
                {g.focus.research.map((r, i) => (
                  <li key={i}>
                    <b>{r.question}</b>
                    {r.why && <span className="muted"> {r.why}</span>}
                    {r.search && (
                      <div className="gd-research-search">
                        Search: <code>{r.search}</code>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      {(g.submit.what || g.submit.where) && (
        <div className="gd-submit">
          <div className="gd-label">
            <Upload size={13} /> {taking ? 'Taking it' : 'Hand in'}
          </div>
          {g.submit.what && <div className="gd-submit-what">{g.submit.what}</div>}
          <dl>
            {g.submit.where && (
              <>
                <dt>Where</dt>
                <dd>{g.submit.where}</dd>
              </>
            )}
            {g.submit.format && (
              <>
                <dt>Format</dt>
                <dd>{g.submit.format}</dd>
              </>
            )}
          </dl>
          {g.submit.url && !ownLink && !compact && !(post && /quiz_summary|quizzing/i.test(g.submit.url)) && (
            <button className="btn sm primary" onClick={() => onOpen(g.submit.url!)}>
              <ExternalLink size={13} /> Open the hand-in page
            </button>
          )}
        </div>
      )}
      {!compact && g.rubric ? (
        <details className="gd-fold gd-rubric">
          <summary>
            See the rubric<span className="muted"> · {g.rubric.name}{g.rubric.total ? `, ${g.rubric.total} points` : ''}</span>
          </summary>
          {/* Each criterion: what earns full marks, and the lower levels folded under it. */}
          <ul className="gd-rubric-list">
            {g.rubric.criteria.map((c, i) => {
              const top = c.cells.reduce((b, x, k) => ((x.points ?? -1) > (c.cells[b].points ?? -1) ? k : b), 0);
              const best = c.cells[top];
              return (
                <li key={i}>
                  <div className="gd-crit">
                    <b>{c.name}</b>
                    {best?.points != null && <span className="gd-pts">{best.points} pts</span>}
                  </div>
                  {best?.text && (
                    <div className="gd-rubric-best">
                      <span className="gd-about-sub">{g.rubric!.levels[top] || 'Full marks'}: </span>
                      {best.text}
                    </div>
                  )}
                  {c.cells.length > 1 && (
                    <details className="gd-rubric-more">
                      <summary>Other levels</summary>
                      {c.cells.map((x, k) =>
                        k === top ? null : (
                          <div key={k} className="gd-rubric-level">
                            <b>
                              {g.rubric!.levels[k] || `Level ${k + 1}`}
                              {x.points != null ? ` · ${x.points} pts` : ''}
                            </b>{' '}
                            {x.text}
                          </div>
                        )
                      )}
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
        </details>
      ) : (
        !compact &&
        g.graded.length > 0 && (
          <details className="gd-fold">
            <summary>
              How it’s graded{total ? <span className="muted"> · {total} points</span> : null}
            </summary>
            <ul className="gd-graded">
              {g.graded.map((c, i) => (
                <li key={i}>
                  <div className="gd-crit">
                    <b>{c.criterion}</b>
                    {c.points != null && <span className="gd-pts">{c.points} pts</span>}
                  </div>
                  {c.how && <div className="muted">{c.how}</div>}
                </li>
              ))}
            </ul>
          </details>
        )
      )}
      {compact ? (
        <p className="muted gd-on-pc">
          <Monitor size={13} /> The step-by-step guide{lab ? ', the lab procedure and the notebook checklist are' : g.rubric || g.graded.length ? ' and the rubric are' : ' is'} in Kea on your PC.
        </p>
      ) : (
        <div className="gd-foot">
          <Rescan it={it} g={g} label="Rescan this assignment" />
        </div>
      )}
    </section>
  );
}

/** A topic's first sentence ("Not chosen yet."), or all of a short one. */
function lead(t: string) {
  const m = t.match(/^.{12,160}?[.:](\s|$)/);
  return m ? m[0] : t;
}

/** The special notes: open on the PC; on the phone, folded under their count. */
function Notes({ compact, count, children }: { compact: boolean; count: number; children: ReactNode }) {
  const head = (
    <>
      <AlertCircle size={13} /> Special notes{compact ? ` (${count})` : ''}
    </>
  );
  return compact ? (
    <details className="gd-notes">
      <summary className="gd-label">{head}</summary>
      {children}
    </details>
  ) : (
    <div className="gd-notes">
      <div className="gd-label">{head}</div>
      {children}
    </div>
  );
}

/** The class site's own wording, folded (at the bottom, under the guide; or alone until the guide is written). */
export function OriginalWording({ text, open: startOpen = false }: { text: string; open?: boolean }) {
  if (!text) return null;
  return (
    <details className="gd-fold gd-original" open={startOpen}>
      <summary>From the class site</summary>
      <p className="sch-desc">{text}</p>
    </details>
  );
}

/** What an item shows for its instructions: its guide, or (until one is written) a note and the class site's wording. */
export function AssignmentGuide({ it, raw, onOpen, onItem, compact, checksOn = true }: { it: ScholarItem; raw: string; onOpen(url: string): void; onItem?(id: string): void; compact?: boolean; checksOn?: boolean }) {
  const guides = useGuides();
  const g = guides?.[it.id];
  if (g) return <GuideView it={it} g={g} onOpen={onOpen} onItem={onItem} compact={compact} />;
  // (Promised only when a daily check will really write one: checks are running, and it's work Kea writes guides for.)
  if (!guides || !raw || !checksOn || !willGuide(it)) return null;
  return (
    <section className="gd">
      <div className="tb-h">What to do</div>
      <p className="muted gd-pending">Kea writes a step-by-step guide for this with its next daily check. Until then, the class site’s wording is below.</p>
    </section>
  );
}
