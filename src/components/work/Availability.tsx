// Filling in an availability form, phone first: a calendar of the period with each date's blocks as chips. Tap a
// chip to cycle Available, If needed, Not available; drag across chips to paint; tap a weekday's block to set it for
// the whole period; All day or Off for a date; prefill from your usual week or last month.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, CalendarCheck2, CheckCircle2, Eraser, History, MessageSquare, Send, Sun } from 'lucide-react';
import { ask, toast } from '../../store';
import { bump, wantText, addDays, countdown, fmtDay, fmtRange, fmtWhen, parseDate, post, setLeaveGuard, todayIso, useHub, useWork, WD, WEEKDAYS } from './workStore';
import { Card, Empty, Loading, Num, Problem, Check, Field } from './ui';
import type { Answer, Form, FormView, Org, Slot } from './types';

const NEXT: Record<Answer, Answer> = { N: 'A', A: 'I', I: 'N' };
const WORD: Record<Answer, string> = { A: 'Available', I: 'If needed', N: 'Not available' };

/** The member's list of forms, or one form open. */
export function AvailabilityTab({ org }: { org: Org }) {
  const focus = useWork((s) => s.focus);
  const [open, setOpen] = useState<string | null>(focus?.formId ?? null);
  useEffect(() => setOpen(focus?.formId ?? null), [focus?.formId]);
  const { data, error, reload } = useHub<{ forms: Form[] }>(`/v1/orgs/${org.id}/forms`);
  if (open) return <FillForm org={org} formId={open} onBack={() => setOpen(null)} />;
  if (error) return <Problem error={error} retry={reload} />;
  if (!data) return <Loading />;
  const forms = data.forms.filter((f) => f.status !== 'draft' && f.periodEnd >= todayIso());
  if (!forms.length) return <Empty title="No availability forms right now">When your manager sends one out, it shows here and in your to-do list.</Empty>;
  return (
    <div className="wk-list">
      {forms.map((f) => {
        const left = f.deadlineAt ? f.deadlineAt - Date.now() : null;
        return (
          <button key={f.id} className="wk-row-btn" onClick={() => setOpen(f.id)}>
            <span className="wk-row-main">
              <span className="wk-row-title">{f.title}</span>
              <span className="wk-row-sub">
                {fmtDay(f.periodStart, { month: 'short', day: 'numeric' })} – {fmtDay(f.periodEnd, { month: 'short', day: 'numeric' })}
                {f.status === 'closed' ? ' · Closed' : ''}
              </span>
            </span>
            {f.submittedAt ? (
              <span className="wk-pill good">
                <CheckCircle2 size={13} /> Sent
              </span>
            ) : (
              <span className={`wk-pill ${left != null && left < 0 ? 'bad' : left != null && left < 3 * 86400_000 ? 'warn' : ''}`}>{left == null ? 'Not sent' : countdown(left)}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function FillForm({ org, formId, onBack }: { org: Org; formId: string; onBack(): void }) {
  const { data, error, reload } = useHub<FormView>(`/v1/orgs/${org.id}/forms/${formId}`);
  if (error) return <Problem error={error} retry={reload} />;
  if (!data) return <Loading />;
  return <Filler key={data.form.id + (data.response?.submittedAt ?? '')} org={org} view={data} onBack={onBack} />;
}

function Filler({ org, view, onBack }: { org: Org; view: FormView; onBack(): void }) {
  const { form, slots, state, prefill } = view;
  const r = view.response;
  const [answers, setAnswers] = useState<Record<string, Answer>>(() => ({ ...(r?.answers ?? (Object.keys(prefill.usual).length ? prefill.usual : {})) }));
  const [dateNotes, setDateNotes] = useState<Record<string, string>>(r?.dateNotes ?? {});
  const [note, setNote] = useState(r?.note ?? '');
  const [dmin, setDmin] = useState<number | null>(r?.desiredMin ?? prefill.desiredMin ?? null);
  const [dmax, setDmax] = useState<number | null>(r?.desiredMax ?? prefill.desiredMax ?? null);
  const [daysOff, setDaysOff] = useState(r?.daysOff ?? '');
  const [extra, setExtra] = useState<Record<string, any>>(r?.extra ?? {});
  const [saveUsual, setSaveUsual] = useState(!Object.keys(prefill.usual).length);
  const [reason, setReason] = useState('');
  const [noteOpen, setNoteOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const readOnly = !state.canEdit && !state.changeRequest;
  const q = form.questions;
  // What's on screen against what was last loaded or saved: leaving with changes asks first.
  const now = JSON.stringify({ answers, dateNotes, note, dmin, dmax, daysOff, extra });
  const [saved, setSaved] = useState(now);
  const dirty = !readOnly && now !== saved;
  const canDraft = !state.pastDeadline && !state.changeRequest;

  const byDate = useMemo(() => {
    const m = new Map<string, Slot[]>();
    for (const s of slots) (m.get(s.date) ?? m.set(s.date, []).get(s.date)!).push(s);
    return m;
  }, [slots]);
  const closed = useMemo(() => new Map(form.exceptions.filter((e) => e.kind === 'closed').map((e) => [e.date, e.note || 'Closed'])), [form]);
  const weekly = useMemo(() => {
    // The weekday rows for bulk setting: each weekday's blocks in time order.
    const m = new Map<number, typeof form.blocks>();
    for (const b of [...form.blocks].sort((a, c) => a.start.localeCompare(c.start))) (m.get(b.weekday!) ?? m.set(b.weekday!, []).get(b.weekday!)!).push(b);
    return [1, 2, 3, 4, 5, 6, 0].filter((d) => m.has(d)).map((d) => ({ weekday: d, blocks: m.get(d)! }));
  }, [form]);

  const get = (k: string): Answer => answers[k] ?? 'N';
  const set = (keys: string[], v: Answer) => {
    if (readOnly) return;
    setAnswers((a) => {
      const n = { ...a };
      for (const k of keys) v === 'N' ? delete n[k] : (n[k] = v);
      return n;
    });
  };

  // Painting: press on a chip, then drag across others to give them the same state (works with touch too).
  const paint = useRef<Answer | null>(null);
  useEffect(() => {
    const up = () => (paint.current = null);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, []);
  const onChipDown = (e: React.PointerEvent, k: string) => {
    if (readOnly) return;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    const v = NEXT[get(k)];
    paint.current = v;
    set([k], v);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!paint.current) return;
    const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const k = el?.closest<HTMLElement>('[data-slot]')?.dataset.slot;
    if (k && get(k) !== paint.current) set([k], paint.current);
  };
  const bulk = (blockId: string) => {
    const keys = slots.filter((s) => s.blockId === blockId && !s.special).map((s) => s.key);
    const counts = { A: 0, I: 0, N: 0 };
    keys.forEach((k) => counts[get(k)]++);
    const most = (['A', 'I', 'N'] as Answer[]).reduce((a, b) => (counts[b] > counts[a] ? b : a), 'N');
    set(keys, NEXT[most]);
  };

  // Hours marked, as a weekly average over the period.
  const days = (parseDate(form.periodEnd).getTime() - parseDate(form.periodStart).getTime()) / 86400_000 + 1;
  const weeks = Math.max(1, days) / 7;
  let am = 0,
    im = 0;
  for (const s of slots) {
    if (get(s.key) === 'A') am += s.minutes;
    else if (get(s.key) === 'I') im += s.minutes;
  }
  const perWeek = Math.round((am / 60 / weeks) * 10) / 10;
  const perWeekI = Math.round((im / 60 / weeks) * 10) / 10;
  const hoursTone = dmin != null && perWeek < dmin ? 'warn' : 'good';

  const rangeBad = dmin != null && dmax != null && dmin > dmax;
  const send = async (submit: boolean): Promise<boolean> => {
    if (rangeBad) {
      toast('The hours you want: “From” is more than “To”.', 'error');
      return false;
    }
    // Nothing marked counts as "not available" on every date: say so before sending that.
    if (submit && am + im === 0 && slots.length > 0) {
      const yes = (await ask('Send as not available?', 'Nothing is marked, so this tells your manager you can’t work any of these dates.', [{ id: 'no', label: 'Go back' }, { id: 'yes', label: 'Send as not available', primary: true }])) === 'yes';
      if (!yes) return false;
    }
    setBusy(true);
    try {
      const res = await post<{ status: string }>(`/v1/orgs/${org.id}/forms/${form.id}/response`, {
        answers,
        dateNotes,
        note: note || null,
        desiredMin: dmin,
        desiredMax: dmax,
        daysOff: daysOff || null,
        extra,
        submit,
        saveUsual,
        reason: reason || null
      });
      toast(
        res.status === 'change_requested'
          ? 'Change sent to your manager.'
          : res.status === 'draft'
            ? 'Saved. Send it before the deadline.'
            : res.status === 'late'
              ? 'Sent. It was after the deadline, so your manager will see it marked late.'
              : 'Sent. You can change it until the deadline.'
      );
      setSaved(now);
      setLeaveGuard(null);
      bump();
      if (submit) onBack();
      return true;
    } catch (e: any) {
      toast(e.message, 'error');
      return false;
    } finally {
      setBusy(false);
    }
  };

  // Unsent changes: Back, another tab or another organization asks first.
  const confirmLeave = async () => {
    const choice = await ask('Keep your changes?', canDraft ? 'You changed this form but haven’t saved or sent it.' : 'You changed this form but haven’t sent it.', [
      { id: 'stay', label: 'Keep editing' },
      { id: 'drop', label: 'Discard changes', danger: true },
      ...(canDraft ? [{ id: 'save', label: 'Save for later', primary: true }] : [])
    ]);
    if (choice === 'save') return send(false);
    return choice === 'drop';
  };
  const guard = useRef(confirmLeave);
  guard.current = confirmLeave;
  useEffect(() => {
    if (!dirty) return;
    setLeaveGuard(() => guard.current());
    return () => setLeaveGuard(null);
  }, [dirty]);
  const back = async () => {
    if (dirty && !(await confirmLeave())) return;
    setLeaveGuard(null);
    onBack();
  };
  // Prefills and Clear replace what's marked: asked first when something is.
  const replaceAll = async (next: Record<string, Answer>, what: string) => {
    if (Object.keys(answers).length && (await ask(`${what}?`, 'This replaces what you’ve marked on every date.', [{ id: 'no', label: 'Cancel' }, { id: 'yes', label: what, primary: true }])) !== 'yes') return;
    setAnswers({ ...next });
  };

  // The calendar: weeks from the Sunday on or before the start.
  const first = form.periodStart;
  const lead = parseDate(first).getDay();
  const cells: (string | null)[] = Array.from({ length: lead }, () => null);
  for (let d = first; d <= form.periodEnd; d = addDays(d, 1)) cells.push(d);

  return (
    <div className="af">
      <div className="af-top">
        <button className="btn link sm" onClick={back}>
          <ArrowLeft size={15} /> Forms
        </button>
        <h2 className="af-title">{form.title}</h2>
        <div className="af-sub">
          {fmtDay(form.periodStart, { month: 'long', day: 'numeric' })} – {fmtDay(form.periodEnd, { month: 'long', day: 'numeric' })}
          {form.deadlineAt && (
            <span className={`wk-pill ${state.pastDeadline ? 'bad' : form.deadlineAt - Date.now() < 3 * 86400_000 ? 'warn' : ''}`}>
              {state.pastDeadline ? `Deadline was ${fmtWhen(form.deadlineAt, org.tz)}` : `${countdown(form.deadlineAt - Date.now())} · ${fmtWhen(form.deadlineAt, org.tz)}`}
            </span>
          )}
        </div>
        {form.minorNote && <p className="af-minor">{form.minorNote}</p>}
        {state.changeRequest && <p className="af-info">The deadline has passed. Changes you send now go to your manager to approve.</p>}
        {state.scheduleOut && state.pastDeadline && <p className="af-info">The schedule for these dates is out. Talk to your manager about changes; new answers count from the next form.</p>}
        {state.lastChange?.status === 'pending' && <p className="af-info">Your last change is waiting for your manager.</p>}
      </div>

      {!readOnly && (
        <div className="af-tools">
          {Object.keys(prefill.usual).length > 0 && (
            <button className="btn tonal sm" onClick={() => replaceAll(prefill.usual, 'Use my usual week')}>
              <Sun size={14} /> My usual week
            </button>
          )}
          {prefill.last && (
            <button className="btn tonal sm" onClick={() => replaceAll(prefill.last!, `Same as ${prefill.lastTitle?.replace(/ availability$/i, '') ?? 'last time'}`)}>
              <History size={14} /> Same as {prefill.lastTitle?.replace(/ availability$/i, '') ?? 'last time'}
            </button>
          )}
          <button className="btn tonal sm" disabled={!Object.keys(answers).length} onClick={() => replaceAll({}, 'Clear everything')}>
            <Eraser size={14} /> Clear
          </button>
        </div>
      )}

      <div className="af-legend">
        <span className="af-chip A">Available</span>
        <span className="af-chip I">If needed</span>
        <span className="af-chip N">Not available</span>
        <span className="muted">Tap to change. Drag to fill several.</span>
      </div>

      {!readOnly && weekly.length > 0 && (
        <Card title="Every week" className="af-weekly">
          <p className="muted af-small">Tap a block to set it for every date in the period.</p>
          {weekly.map((w) => (
            <div key={w.weekday} className="af-wrow">
              <span className="af-wday">{WD[w.weekday]}</span>
              <div className="af-chips">
                {w.blocks.map((b) => {
                  const keys = slots.filter((s) => s.blockId === b.id && !s.special).map((s) => s.key);
                  const all = keys.length && keys.every((k) => get(k) === get(keys[0])) ? get(keys[0]) : null;
                  return (
                    <button key={b.id} className={`af-chip ${all ?? 'mixed'}`} onClick={() => bulk(b.id)} title={`Every ${WEEKDAYS[w.weekday]}`}>
                      {b.label ? `${b.label} ` : ''}
                      {fmtRange(b)}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </Card>
      )}

      <div className="af-cal" onPointerMove={onMove}>
        {WD.map((d) => (
          <div key={d} className="af-head">
            {d}
          </div>
        ))}
        {cells.map((d, i) => {
          if (!d) return <div key={`b${i}`} className="af-day blank" />;
          const list = byDate.get(d) ?? [];
          const shut = closed.get(d);
          if (!list.length)
            return (
              <div key={d} className="af-day none">
                <div className="af-date">{fmtDay(d)}</div>
                <div className="muted af-small">{shut ?? 'No blocks'}</div>
              </div>
            );
          const keys = list.map((s) => s.key);
          return (
            <div key={d} className={`af-day ${keys.some((k) => get(k) !== 'N') ? 'some' : ''}`}>
              <div className="af-date">
                <span>{fmtDay(d)}</span>
                {!readOnly && (
                  <span className="af-daybtns">
                    <button className="af-mini" onClick={() => set(keys, 'A')}>
                      All day
                    </button>
                    <button className="af-mini" onClick={() => set(keys, 'N')}>
                      Off
                    </button>
                    <button className={`af-mini icon ${dateNotes[d] ? 'on' : ''}`} title="Note for this date" onClick={() => setNoteOpen(noteOpen === d ? null : d)}>
                      <MessageSquare size={13} />
                    </button>
                  </span>
                )}
              </div>
              {list[0].note && <div className="af-dnote">{list[0].note}</div>}
              <div className="af-chips">
                {list.map((s) => (
                  <button key={s.key} data-slot={s.key} className={`af-chip ${get(s.key)} ${s.special ? 'special' : ''}`} onPointerDown={(e) => onChipDown(e, s.key)} title={WORD[get(s.key)]} disabled={readOnly}>
                    {s.label ? <span className="af-chip-label">{s.label}</span> : null}
                    {fmtRange(s)}
                  </button>
                ))}
              </div>
              {(noteOpen === d || (readOnly && dateNotes[d])) && (
                <input
                  className="input sm af-note"
                  autoFocus={!readOnly}
                  readOnly={readOnly}
                  placeholder="Note for this date"
                  value={dateNotes[d] ?? ''}
                  onChange={(e) => setDateNotes({ ...dateNotes, [d]: e.target.value })}
                />
              )}
              {noteOpen !== d && dateNotes[d] && !readOnly && <div className="af-dnote mine">{dateNotes[d]}</div>}
            </div>
          );
        })}
      </div>

      <div className={`af-hours ${hoursTone}`}>
        <CalendarCheck2 size={16} />
        <span>
          <b>{perWeek} h</b> a week available{perWeekI ? ` · ${perWeekI} h if needed` : ''}
          {wantText(dmin, dmax) && <span className="muted"> · you want {wantText(dmin, dmax)}</span>}
        </span>
      </div>

      <Card title="A few questions">
        {q.desiredHours.on && (
          <Field label="Hours you want each week">
            <div className="af-range">
              <Num value={dmin} onChange={setDmin} placeholder="From" max={168} />
              <span>to</span>
              <Num value={dmax} onChange={setDmax} placeholder="To" max={168} />
            </div>
            {rangeBad && <span className="wk-hint bad">“From” is more than “To”.</span>}
          </Field>
        )}
        {q.daysOff.on && (
          <Field label="Days you need off">
            <input className="input" readOnly={readOnly} value={daysOff} placeholder="For example 12/24–12/26" onChange={(e) => setDaysOff(e.target.value)} />
          </Field>
        )}
        {q.custom
          .filter((c) => c.on)
          .map((c) => (
            <Field key={c.id} label={c.label}>
              {c.type === 'yesno' ? (
                <div className="wk-seg">
                  {[
                    [true, 'Yes'],
                    [false, 'No']
                  ].map(([v, l]) => (
                    <button key={String(v)} className={extra[c.id] === v ? 'on' : ''} disabled={readOnly} onClick={() => setExtra({ ...extra, [c.id]: v })}>
                      {l as string}
                    </button>
                  ))}
                </div>
              ) : c.type === 'choice' ? (
                <select className="input" disabled={readOnly} value={(extra[c.id] as string) ?? ''} onChange={(e) => setExtra({ ...extra, [c.id]: e.target.value || undefined })}>
                  <option value="">Choose…</option>
                  {c.options.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
              ) : c.type === 'multi' ? (
                <div className="af-chips">
                  {c.options.map((o) => {
                    const cur: string[] = Array.isArray(extra[c.id]) ? extra[c.id] : [];
                    const on = cur.includes(o);
                    return (
                      <button key={o} className={`wk-pick ${on ? 'on' : ''}`} disabled={readOnly} onClick={() => setExtra({ ...extra, [c.id]: on ? cur.filter((x) => x !== o) : [...cur, o] })}>
                        {o}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <input className="input" readOnly={readOnly} value={(extra[c.id] as string) ?? ''} onChange={(e) => setExtra({ ...extra, [c.id]: e.target.value })} />
              )}
            </Field>
          ))}
        {q.notes.on && (
          <Field label="Anything else">
            <textarea className="input wk-textarea" readOnly={readOnly} value={note} placeholder="For example: prefer opening shifts; subject to change" onChange={(e) => setNote(e.target.value)} />
          </Field>
        )}
        {!readOnly && <Check label="Keep this as my usual week" hint="(next time, “My usual week” fills the form with it)" checked={saveUsual} onChange={setSaveUsual} />}
        {state.changeRequest && (
          <Field label="Why the change">
            <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Optional" />
          </Field>
        )}
      </Card>

      {!readOnly && (
        <div className="af-send">
          {dirty && <span className="muted af-small">Not saved yet</span>}
          {!state.pastDeadline && (
            <button className="btn" disabled={busy} onClick={() => send(false)}>
              Save for later
            </button>
          )}
          <button className="btn primary" disabled={busy} onClick={() => send(true)}>
            <Send size={15} /> {state.changeRequest ? 'Send change request' : r?.submittedAt ? 'Send update' : 'Send'}
          </button>
        </div>
      )}
      {r?.submittedAt && <p className="muted af-small">Last sent {fmtWhen(r.submittedAt)}.</p>}
    </div>
  );
}
