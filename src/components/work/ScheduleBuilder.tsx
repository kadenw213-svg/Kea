// Managers: build a schedule from an availability form. Drag people (or tap an available name) onto a block; cert,
// minor, overlap and overtime rules are checked live. Auto-fill fills open places from availability. Drafts from
// other tools wait for review here. Nothing reaches people until Publish. A click on a placed shift sets its pay code
// (only one of that person's own codes).
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, CalendarRange, Check as CheckIcon, Eraser, Plus, Send, Sparkles, TriangleAlert, Wand2, X } from 'lucide-react';
import { ask, toast } from '../../store';
import { act, addDays, clock, wantText, fmtDay, fmtRange, hrs, money, post, useHub, useWork, WorkError } from './workStore';
import { Advanced, Card, Check, Empty, Loading, Problem } from './ui';
import type { Draft, Form, Org, Problem as Prob, Schedule, SchedPerson, SchedSlot, SchedView, Shift, Structure, Verdict } from './types';
import { can } from './types';
import { ShiftCodeBar } from './PayCodes';
import type { PayCodeList } from './payRules';

export function SchedulingTab({ org }: { org: Org }) {
  const focus = useWork((s) => s.focus);
  const [open, setOpen] = useState<string | null>(focus?.scheduleId ?? null);
  useEffect(() => setOpen(focus?.scheduleId ?? null), [focus?.scheduleId]);
  const list = useHub<{ schedules: Schedule[] }>(`/v1/orgs/${org.id}/schedules`);
  const forms = useHub<{ forms: Form[] }>(`/v1/orgs/${org.id}/forms`);
  const [formId, setFormId] = useState('');
  if (open) return <Builder org={org} id={open} onBack={() => setOpen(null)} />;
  if (list.error) return <Problem error={list.error} retry={list.reload} />;
  if (!list.data) return <Loading />;
  const usable = (forms.data?.forms ?? []).filter((f) => f.status !== 'draft');
  return (
    <div className="wk-stack">
      {can(org, 'schedule.edit') && <Card title="New schedule">
        <div className="wk-form-row">
          <select className="input sm" value={formId} onChange={(e) => setFormId(e.target.value)}>
            <option value="">From availability form…</option>
            {usable.map((f) => (
              <option key={f.id} value={f.id}>
                {f.title}
              </option>
            ))}
          </select>
          <button
            className="btn sm primary"
            disabled={!formId}
            onClick={async () => {
              const r = await act<{ schedule: Schedule }>(`/v1/orgs/${org.id}/schedules`, { formId });
              if (r) setOpen(r.schedule.id);
            }}
          >
            <Plus size={14} /> Make schedule
          </button>
        </div>
        {!usable.length && <p className="muted af-small">Send an availability form first; the schedule is built from its blocks and answers.</p>}
      </Card>}
      {list.data.schedules.length === 0 ? (
        <Empty title="No schedules yet" />
      ) : (
        <div className="wk-list">
          {list.data.schedules.map((s) => (
            <button key={s.id} className="wk-row-btn" onClick={() => setOpen(s.id)}>
              <CalendarRange size={18} />
              <span className="wk-row-main">
                <span className="wk-row-title">{s.title}</span>
                <span className="wk-row-sub">
                  {fmtDay(s.periodStart, { month: 'short', day: 'numeric' })} – {fmtDay(s.periodEnd, { month: 'short', day: 'numeric' })} · {s.published} published
                  {s.drafts ? ` · ${s.drafts} not published yet` : ''}
                </span>
              </span>
              <span className={`wk-pill ${s.status === 'published' ? 'good' : ''}`}>{s.status === 'published' ? 'Published' : 'Draft'}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

type Hover = { slot: string; person: string; verdict: Verdict | null };

function Builder({ org, id, onBack }: { org: Org; id: string; onBack(): void }) {
  const { data, error, reload } = useHub<SchedView>(`/v1/orgs/${org.id}/schedules/${id}`);
  const structure = useHub<Structure>(`/v1/orgs/${org.id}/structure`);
  const [week, setWeek] = useState<string | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [pick, setPick] = useState<string | null>(null); // a person picked (tap) to place
  const [unfilled, setUnfilled] = useState<{ slotKey: string; positionId: string; missing: number; reasons: Record<string, number> }[] | null>(null);
  const [opts, setOpts] = useState<{ useIfNeeded: boolean; hardMaxHours: boolean; allowOvertime: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const checks = useRef(new Map<string, Verdict>());
  // A shift whose pay code is being set (a click on it), and the codes' names for the shifts' tooltips.
  const [codeShift, setCodeShift] = useState<string | null>(null);
  const codeList = useHub<PayCodeList>(can(org, 'schedule.edit') ? `/v1/orgs/${org.id}/pay-codes` : null);
  useEffect(() => {
    if (data && !week) setWeek(data.weeks.find((w) => addDays(w, 6) >= isoToday()) ?? data.weeks[0] ?? null);
    if (data && !opts) setOpts(data.autofillDefaults);
    checks.current.clear();
  }, [data]);
  const pos = useMemo(() => new Map((structure.data?.positions ?? []).map((p) => [p.id, p.name])), [structure.data]);
  if (error) return <Problem error={error} retry={reload} />;
  if (!data || !week) return <Loading />;
  const people = new Map(data.people.map((p) => [p.id, p]));
  const shiftById = new Map(data.shifts.map((s) => [s.id, s]));
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i)).filter((d) => d >= data.schedule.periodStart && d <= data.schedule.periodEnd);
  const weekHours = (p: SchedPerson) => p.hoursByWeek[week] ?? 0;
  const drafts = data.shifts.filter((s) => s.status === 'draft' && s.accountId).length;
  const codeNames = new Map((codeList.data?.codes ?? []).map((c) => [c.id, c.name]));

  /** Which of the block's needed positions a person would fill. */
  const positionFor = (slot: SchedSlot, p: SchedPerson) => {
    const filled = (pid: string) => slot.assigned.map((a) => shiftById.get(a)).filter((s) => s?.positionId === pid).length;
    return slot.need.find((n) => p.positionIds.includes(n.positionId) && filled(n.positionId) < n.count)?.positionId ?? slot.need.find((n) => p.positionIds.includes(n.positionId))?.positionId ?? p.positionIds[0] ?? null;
  };
  const check = async (slot: SchedSlot, personId: string) => {
    const p = people.get(personId);
    const positionId = p && positionFor(slot, p);
    if (!positionId) return null;
    const k = `${slot.key}|${personId}|${positionId}`;
    if (checks.current.has(k)) return checks.current.get(k)!;
    try {
      const v = await post<Verdict>(`/v1/orgs/${org.id}/schedules/${id}/check`, { accountId: personId, positionId, date: slot.date, blockId: slot.blockId });
      checks.current.set(k, v);
      return v;
    } catch {
      return null;
    }
  };
  const assign = async (slot: SchedSlot, personId: string, force = false): Promise<void> => {
    const p = people.get(personId);
    const positionId = p && positionFor(slot, p);
    if (!positionId) return void toast(`${p?.name ?? 'They'} has no position for this block. Set positions under People.`, 'error');
    try {
      const r = await post<{ shift: Shift } & Verdict>(`/v1/orgs/${org.id}/shifts`, { scheduleId: id, accountId: personId, positionId, date: slot.date, blockId: slot.blockId, force });
      const warn = r.problems?.filter((x) => !x.blocking) ?? [];
      if (warn.length) toast(`${p!.name}: ${warn.map((w) => w.message).join('; ')}`, 'info');
      setPick(null);
      reload();
    } catch (e: any) {
      if (e instanceof WorkError && e.status === 409 && e.data?.problems) {
        const probs: Prob[] = e.data.problems;
        if (e.data.canForce) {
          const yes = await ask(`Assign ${p!.name} anyway?`, probs.map((x) => x.message).join('\n'), [
            { id: 'no', label: 'Cancel' },
            { id: 'yes', label: 'Assign anyway', primary: true }
          ]);
          if (yes === 'yes') return assign(slot, personId, true);
        } else toast(`${p!.name} can’t take this: ${probs.filter((x) => x.blocking).map((x) => x.message).join('; ')}`, 'error');
      } else toast(e.message, 'error');
    }
  };
  const unassign = (s: Shift) => act(`/v1/orgs/${org.id}/shifts/${s.id}/delete`).then(() => reload());

  const autofill = async () => {
    setBusy(true);
    try {
      const r = await post<{ added: number; ifNeededUsed: number; unfilled: typeof unfilled }>(`/v1/orgs/${org.id}/schedules/${id}/autofill`, opts ?? {});
      const left = r.unfilled!.reduce((t, u) => t + u.missing, 0);
      toast(`Added ${r.added} ${r.added === 1 ? 'shift' : 'shifts'}${r.ifNeededUsed ? ` (${r.ifNeededUsed} from If needed)` : ''}.${left ? ` ${left} still open.` : ' Every place is filled.'}`);
      setUnfilled(r.unfilled);
      reload();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const publish = async (confirm = false): Promise<void> => {
    try {
      const r = await post<{ published: number }>(`/v1/orgs/${org.id}/schedules/${id}/publish`, { confirmOverBudget: confirm });
      toast(`Published ${r.published} ${r.published === 1 ? 'shift' : 'shifts'}. People see them now.`);
      reload();
    } catch (e: any) {
      if (e instanceof WorkError && e.status === 409 && e.data?.budgetWarnings) {
        const yes = await ask('This goes over budget', e.data.budgetWarnings.map((b: any) => `${b.departmentName}: ${money(b.scheduled)} of ${money(b.amount)}`).join('\n'), [
          { id: 'no', label: 'Cancel' },
          { id: 'yes', label: 'Publish anyway', primary: true }
        ]);
        if (yes === 'yes') return publish(true);
      } else toast(e.message, 'error');
    }
  };

  const overBudget = data.budget.filter((b) => b.current && b.warn);
  // (Building needs schedule.edit; someone who may only publish sees the schedule and the Publish button.)
  const editable = can(org, 'schedule.edit');
  const reason: Record<string, string> = {
    cert_missing: 'no cert',
    cert_expired: 'cert expired',
    position_min_age: 'too young',
    minor_day_hours: 'minor hours',
    minor_week_hours: 'minor hours',
    minor_time_of_day: 'minor times',
    overlap: 'already working',
    overtime_weekly: 'overtime',
    desired_max: 'over wanted hours',
    under_minimum_age: 'too young'
  };
  return (
    <div className="sb">
      <div className="wk-toolbar">
        <button className="btn link sm" onClick={onBack}>
          <ArrowLeft size={15} /> Schedules
        </button>
        <h2 className="wk-h2">{data.schedule.title}</h2>
        <span className="wk-spacer" />
        {editable && <button className="btn sm" disabled={busy} onClick={autofill} title="Fill open places from availability. Rules are never broken; Available comes before If needed.">
          <Wand2 size={14} /> Auto-fill
        </button>}
        {editable && <button className="btn sm" onClick={async () => (await ask('Clear auto-filled shifts?', 'Shifts you placed yourself stay.', [{ id: 'no', label: 'Cancel' }, { id: 'yes', label: 'Clear', primary: true }])) === 'yes' && act(`/v1/orgs/${org.id}/schedules/${id}/clear`, { source: 'autofill' }, 'Cleared.')}>
          <Eraser size={14} /> Clear auto-fill
        </button>}
        {can(org, 'schedule.publish') && <button className="btn sm primary" disabled={!drafts} onClick={() => publish()}>
          <Send size={14} /> Publish{drafts ? ` ${drafts}` : ''}
        </button>}
      </div>
      <Advanced label="Auto-fill options">
        {opts && (
          <>
            <Check label="Use people who said If needed" checked={opts.useIfNeeded} onChange={(v) => setOpts({ ...opts, useIfNeeded: v })} />
            <Check label="Never go past the hours people want" checked={opts.hardMaxHours} onChange={(v) => setOpts({ ...opts, hardMaxHours: v })} />
            <Check label="Allow overtime" checked={opts.allowOvertime} onChange={(v) => setOpts({ ...opts, allowOvertime: v })} />
          </>
        )}
      </Advanced>
      {data.budget.length > 0 && (
        <div className="sb-budget">
          {data.budget
            .filter((b) => b.current)
            .map((b) => (
              <div key={b.id} className={`sb-bud ${b.over ? 'bad' : b.warn ? 'warn' : ''}`} title={`${b.hours} h scheduled`}>
                <span>{b.departmentName}</span>
                <div className="wk-bar">
                  <div style={{ width: `${Math.min(100, b.pct ?? 0)}%` }} />
                </div>
                <span>
                  {money(b.scheduled)} / {money(b.amount)}
                </span>
              </div>
            ))}
        </div>
      )}
      {overBudget.length > 0 && <p className="af-info">Over the warning line: {overBudget.map((b) => `${b.departmentName} ${b.pct}%`).join(', ')}.</p>}
      {data.draftsWaiting > 0 && <Drafts org={org} id={id} pos={pos} />}
      {unfilled && unfilled.length > 0 && (
        <Card title="Still open after auto-fill" fold={false} actions={<button className="icon-btn sm" onClick={() => setUnfilled(null)}><X size={14} /></button>}>
          <div className="wk-tags">
            {unfilled.slice(0, 60).map((u) => {
              const s = data.slots.find((x) => x.key === u.slotKey);
              const why = Object.entries(u.reasons)
                .map(([k, n]) => `${n} ${reason[k] ?? k}`)
                .join(', ');
              return (
                <span key={u.slotKey + u.positionId} className="wk-pill warn" title={why || 'Nobody marked this block'}>
                  {s ? `${fmtDay(s.date)} ${fmtRange(s)}` : u.slotKey}: {u.missing} {pos.get(u.positionId) ?? ''}
                  {why ? ` (${why})` : ' (nobody available)'}
                </span>
              );
            })}
          </div>
        </Card>
      )}
      {codeShift && shiftById.get(codeShift) && <ShiftCodeBar org={org} shift={shiftById.get(codeShift)!} onDone={() => (setCodeShift(null), reload())} />}
      <div className="sb-weeks">
        {data.weeks.map((w) => (
          <button key={w} className={`wk-chip ${w === week ? 'on' : ''}`} onClick={() => setWeek(w)}>
            {fmtDay(w < data.schedule.periodStart ? data.schedule.periodStart : w, { month: 'short', day: 'numeric' })}
          </button>
        ))}
      </div>
      <div className="sb-main">
        <aside className="sb-people">
          <div className="sb-people-head">People {pick && <span className="muted">· tap a block</span>}</div>
          {data.people
            .filter((p) => p.positionIds.length)
            .map((p) => {
              const h = weekHours(p);
              const tone = p.desiredMax != null && h > p.desiredMax ? 'bad' : p.desiredMin != null && h < p.desiredMin ? 'low' : 'ok';
              return (
                <div
                  key={p.id}
                  className={`sb-person ${pick === p.id ? 'picked' : ''} ${p.submitted ? '' : 'nosub'}`}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData('text/kea-person', p.id);
                    e.dataTransfer.effectAllowed = 'copy';
                    dragId.current = p.id;
                  }}
                  onClick={() => setPick(pick === p.id ? null : p.id)}
                  title={[p.note, p.submitted ? null : 'Hasn’t sent availability'].filter(Boolean).join(' · ')}
                >
                  <span className="sb-pname">
                    {p.name}
                    {p.minor && <span className="wk-pill sm">U18</span>}
                  </span>
                  <span className={`sb-hours ${tone}`}>
                    {hrs(h)}
                    {wantText(p.desiredMin, p.desiredMax) ? ` · wants ${wantText(p.desiredMin, p.desiredMax)}` : ''}
                  </span>
                </div>
              );
            })}
        </aside>
        <div className="sb-grid" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(150px, 1fr))` }}>
          {days.map((d) => (
            <div key={d} className="sb-col">
              <div className="sb-colhead">{fmtDay(d)}</div>
              {data.slots
                .filter((s) => s.date === d)
                .map((s) => {
                  const assigned = s.assigned.map((a) => shiftById.get(a)!).filter(Boolean);
                  const placed = new Set(assigned.map((a) => a.accountId));
                  const short = s.needTotal - assigned.filter((a) => a.accountId).length;
                  const hv = hover?.slot === s.key ? hover : null;
                  return (
                    <div
                      key={s.key}
                      className={`sb-slot ${short > 0 ? 'short' : 'full'} ${hv ? (hv.verdict?.blocked ? 'drop-bad' : 'drop-ok') : ''} ${pick ? 'pickable' : ''}`}
                      onDragOver={(e) => {
                        if (!e.dataTransfer.types.includes('text/kea-person')) return;
                        e.preventDefault();
                      }}
                      onDragEnter={(e) => {
                        const pid = (e.dataTransfer.types.includes('text/kea-person') && dragId.current) || null;
                        if (!pid) return;
                        setHover({ slot: s.key, person: pid, verdict: null });
                        check(s, pid).then((v) => setHover((h) => (h && h.slot === s.key && h.person === pid ? { ...h, verdict: v } : h)));
                      }}
                      onDragLeave={(e) => {
                        if (!(e.currentTarget as Node).contains(e.relatedTarget as Node)) setHover((h) => (h?.slot === s.key ? null : h));
                      }}
                      onDrop={(e) => {
                        const pid = e.dataTransfer.getData('text/kea-person');
                        setHover(null);
                        if (pid) assign(s, pid);
                      }}
                      onClick={() => pick && assign(s, pick)}
                    >
                      <div className="sb-slot-head">
                        <span className="sb-time">{s.label ? `${s.label} · ` : ''}{fmtRange(s)}</span>
                        <span className={`sb-need ${short > 0 ? 'short' : ''}`}>
                          {assigned.filter((a) => a.accountId).length}/{s.needTotal}
                        </span>
                      </div>
                      {assigned.map((a) => (
                        <span
                          key={a.id}
                          className={`sb-shift ${a.status} ${a.forced ? 'forced' : ''} ${codeShift === a.id ? 'picked' : ''}`}
                          title={`${a.positionName}${a.payCodeId && codeNames.get(a.payCodeId) ? ` · ${codeNames.get(a.payCodeId)}` : ''}${a.status === 'draft' ? ' · not published' : ''}${a.source === 'autofill' ? ' · auto-filled' : ''}${a.forced ? ' · assigned past a warning' : ''}${editable && a.accountId && codeList.data?.codes.length ? ' · click for its pay code' : ''}`}
                          onClick={(e) => {
                            if (!editable || !a.accountId || !codeList.data?.codes.length || pick) return;
                            e.stopPropagation();
                            setCodeShift(codeShift === a.id ? null : a.id);
                          }}
                        >
                          {a.source === 'autofill' && <Sparkles size={11} />}
                          {a.forced && <TriangleAlert size={11} />}
                          {a.name ?? 'Open'}
                          <button className="sb-x" title="Remove" onClick={(e) => (e.stopPropagation(), unassign(a))}>
                            <X size={11} />
                          </button>
                        </span>
                      ))}
                      {hv?.verdict && hv.verdict.problems.length > 0 && (
                        <div className={`sb-warn ${hv.verdict.blocked ? 'bad' : ''}`}>
                          {hv.verdict.problems.map((p) => (
                            <div key={p.code + p.message}>{p.message}</div>
                          ))}
                        </div>
                      )}
                      {short > 0 && (
                        <div className="sb-avail">
                          {[...s.available.map((x) => [x, 'A'] as const), ...s.ifNeeded.map((x) => [x, 'I'] as const)]
                            .filter(([x]) => !placed.has(x) && people.has(x))
                            .map(([x, st]) => (
                              <button
                                key={x}
                                className={`sb-cand ${st}`}
                                draggable
                                onDragStart={(e) => {
                                  e.dataTransfer.setData('text/kea-person', x);
                                  dragId.current = x;
                                }}
                                onClick={(e) => (e.stopPropagation(), assign(s, x))}
                                title={st === 'A' ? 'Available · tap to assign' : 'If needed · tap to assign'}
                              >
                                {people.get(x)!.name.split(' ')[0]}
                              </button>
                            ))}
                        </div>
                      )}
                      {s.dateNotes.length > 0 && s === data.slots.find((x) => x.date === d) && (
                        <div className="sb-notes">
                          {s.dateNotes.map((n) => (
                            <div key={n.id}>
                              {n.name.split(' ')[0]}: {n.note}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
          ))}
        </div>
      </div>
      <DragTracker />
    </div>
  );
}
const isoToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
// dataTransfer can't be read during dragenter, so the dragged person is kept here too.
const dragId = { current: null as string | null };
function DragTracker() {
  useEffect(() => {
    const end = () => setTimeout(() => (dragId.current = null), 0);
    window.addEventListener('dragend', end);
    return () => window.removeEventListener('dragend', end);
  }, []);
  return null;
}

function Drafts({ org, id, pos }: { org: Org; id: string; pos: Map<string, string> }) {
  const { data } = useHub<{ drafts: Draft[] }>(`/v1/orgs/${org.id}/schedules/${id}/drafts`);
  const waiting = (data?.drafts ?? []).filter((d) => d.status === 'waiting');
  if (!waiting.length) return null;
  return (
    <>
      {waiting.map((d) => (
        <Card
          key={d.id}
          title={`A draft to review (${d.shifts.length} shifts)`}
          className="sb-draft"
          actions={
            <>
              <button className="btn sm" onClick={() => act(`/v1/orgs/${org.id}/drafts/${d.id}/discard`, {}, 'Set aside.')}>
                Set aside
              </button>
              <button
                className="btn sm primary"
                onClick={async () => {
                  const r = await act<{ added: number; skipped: unknown[] }>(`/v1/orgs/${org.id}/drafts/${d.id}/apply`);
                  if (r) toast(`Added ${r.added} as unpublished shifts${r.skipped.length ? `; left out ${r.skipped.length} that break a rule` : ''}. Review, then publish.`);
                }}
              >
                <CheckIcon size={14} /> Use it
              </button>
            </>
          }
        >
          {d.summary && <p className="sb-draft-sum">{d.summary}</p>}
          <ul className="wk-diff">
            {d.shifts.slice(0, 30).map((s, i) => (
              <li key={i} className={s.blocked ? 'wk-warn-text' : ''}>
                {fmtDay(s.date)} {clock(s.startAt, org.tz)}: {s.name} as {pos.get(s.positionId) ?? 'staff'}
                {s.why ? ` · ${s.why}` : ''}
                {s.blocked ? ` · ${s.problems.filter((p) => p.blocking).map((p) => p.message).join('; ')}` : ''}
              </li>
            ))}
            {d.shifts.length > 30 && <li className="muted">and {d.shifts.length - 30} more</li>}
          </ul>
        </Card>
      ))}
    </>
  );
}
