// Managers: availability forms. Make one in about a minute (next month, copy last month or start from templates),
// then see the results as a matrix of dates and blocks with coverage against need, a people view, and CSV exports.
import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, BellRing, Check as CheckIcon, Copy, Download, Plus, Send, Trash2, X, CalendarRange } from 'lucide-react';
import { api } from '../../lib/api';
import { ask, toast } from '../../store';
import { act, wantText, addDays, countdown, fmtDay, fmtRange, fmtShortDate, fmtWhen, hrs, nextMonthRange, post, useHub, useWork, WD, WEEKDAYS } from './workStore';
import { Advanced, Card, Check, Empty, Field, Loading, Num, Problem, Seg } from './ui';
import type { Block, Change, DateException, Form, MatrixSlot, Org, PersonRow, Position, Structure, Questions, CustomQuestion } from './types';

const newId = () => `b${Math.random().toString(36).slice(2, 9)}`;

export function FormsTab({ org }: { org: Org }) {
  const focus = useWork((s) => s.focus);
  const [open, setOpen] = useState<{ id: string; view?: string } | null>(focus?.formId ? { id: focus.formId, view: focus.view } : null);
  const [making, setMaking] = useState(false);
  useEffect(() => {
    if (focus?.formId) setOpen({ id: focus.formId, view: focus.view });
  }, [focus?.formId, focus?.view]);
  const { data, error, reload } = useHub<{ forms: Form[] }>(`/v1/orgs/${org.id}/forms`);
  if (open) return <FormDetail org={org} id={open.id} view={open.view} onBack={() => setOpen(null)} />;
  if (making) return <NewForm org={org} forms={data?.forms ?? []} onDone={(id) => (setMaking(false), id && setOpen({ id, view: 'edit' }))} />;
  if (error) return <Problem error={error} retry={reload} />;
  if (!data) return <Loading />;
  return (
    <div className="wk-stack">
      <div className="wk-toolbar">
        <button className="btn primary" onClick={() => setMaking(true)}>
          <Plus size={15} /> New availability form
        </button>
      </div>
      {data.forms.length === 0 ? (
        <Empty title="No forms yet">Make one for next month. People fill it in on their phone or in Kea; you get a matrix of who can work when.</Empty>
      ) : (
        <div className="wk-list">
          {data.forms.map((f) => (
            <button key={f.id} className="wk-row-btn" onClick={() => setOpen({ id: f.id, view: f.status === 'draft' ? 'edit' : 'matrix' })}>
              <span className="wk-row-main">
                <span className="wk-row-title">{f.title}</span>
                <span className="wk-row-sub">
                  {fmtDay(f.periodStart, { month: 'short', day: 'numeric' })} – {fmtDay(f.periodEnd, { month: 'short', day: 'numeric' })}
                  {f.deadlineAt && f.status === 'open' ? ` · ${countdown(f.deadlineAt - Date.now(), { late: 'past the deadline' })}` : ''}
                </span>
              </span>
              <span className={`wk-pill ${f.status === 'open' ? 'good' : ''}`}>{f.status === 'draft' ? 'Not sent' : f.status === 'open' ? 'Open' : 'Closed'}</span>
              {f.status !== 'draft' && (
                <span className="wk-count">
                  {f.responses}/{f.audienceCount}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function NewForm({ org, forms, onDone }: { org: Org; forms: Form[]; onDone(id: string | null): void }) {
  const def = nextMonthRange();
  const [month, setMonth] = useState(def.start.slice(0, 7));
  const sets = useHub<{ blockSets: { id: string; name: string; blocks: Block[] }[] }>(`/v1/orgs/${org.id}/block-sets`);
  const last = forms.filter((f) => f.periodStart < `${month}-01`)[0] ?? forms[0];
  const [from, setFrom] = useState<'copy' | 'templates' | 'blank'>(last ? 'copy' : 'templates');
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const start = `${month}-01`;
  const end = (() => {
    const [y, m] = month.split('-').map(Number);
    return fmtIso(new Date(y, m, 0));
  })();
  const make = async () => {
    setBusy(true);
    try {
      const r = await post<{ form: Form }>(`/v1/orgs/${org.id}/forms`, {
        periodStart: start,
        periodEnd: end,
        ...(from === 'copy' ? { copyFrom: last?.id } : from === 'templates' ? { blockSetIds: picked } : { blocks: [] })
      });
      onDone(r.form.id);
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="wk-stack wk-narrow">
      <button className="btn link sm" onClick={() => onDone(null)}>
        <ArrowLeft size={15} /> Forms
      </button>
      <Card title="New availability form">
        <Field label="Month">
          <input className="input" type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        </Field>
        <Field label="Blocks">
          <div className="wk-radios">
            {last && (
              <label className="wk-check">
                <input type="radio" checked={from === 'copy'} onChange={() => setFrom('copy')} />
                <span>
                  Copy {last.title} <span className="wk-hint">(blocks, questions and who gets it)</span>
                </span>
              </label>
            )}
            <label className="wk-check">
              <input type="radio" checked={from === 'templates'} onChange={() => setFrom('templates')} />
              <span>From block templates</span>
            </label>
            {from === 'templates' && (
              <div className="wk-tags wk-indent">
                {(sets.data?.blockSets ?? []).map((s) => (
                  <button key={s.id} className={`wk-chip ${picked.includes(s.id) ? 'on' : ''}`} onClick={() => setPicked(picked.includes(s.id) ? picked.filter((x) => x !== s.id) : [...picked, s.id])}>
                    {s.name} ({s.blocks.length})
                  </button>
                ))}
                {sets.data && !sets.data.blockSets.length && <span className="muted">No templates yet. Start blank, then save the blocks as a template.</span>}
              </div>
            )}
            <label className="wk-check">
              <input type="radio" checked={from === 'blank'} onChange={() => setFrom('blank')} />
              <span>Start blank</span>
            </label>
          </div>
        </Field>
        <div className="wk-actions">
          <button className="btn primary" disabled={busy} onClick={make}>
            Make form
          </button>
        </div>
      </Card>
    </div>
  );
}
const fmtIso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function FormDetail({ org, id, view: v0, onBack }: { org: Org; id: string; view?: string; onBack(): void }) {
  const list = useHub<{ forms: Form[] }>(`/v1/orgs/${org.id}/forms`);
  const form = list.data?.forms.find((f) => f.id === id) ?? null;
  const [view, setView] = useState<string>(v0 ?? 'matrix');
  useEffect(() => setView(v0 ?? (form?.status === 'draft' ? 'edit' : 'matrix')), [id, v0, form?.status === 'draft']);
  const go = useWork((s) => s.go);
  if (list.error) return <Problem error={list.error} retry={list.reload} />;
  if (!form) return list.data ? <Empty title="That form was deleted." /> : <Loading />;
  const makeSchedule = async () => {
    const r = await act<{ schedule: { id: string } }>(`/v1/orgs/${org.id}/schedules`, { formId: form.id });
    if (r) go(org.id, 'scheduling', { scheduleId: r.schedule.id });
  };
  return (
    <div className="wk-stack">
      <div className="wk-toolbar">
        <button className="btn link sm" onClick={onBack}>
          <ArrowLeft size={15} /> Forms
        </button>
        <h2 className="wk-h2">{form.title}</h2>
        <span className={`wk-pill ${form.status === 'open' ? 'good' : ''}`}>{form.status === 'draft' ? 'Not sent' : form.status === 'open' ? 'Open' : 'Closed'}</span>
        <span className="wk-spacer" />
        {form.status === 'draft' ? (
          <button className="btn primary sm" onClick={() => act(`/v1/orgs/${org.id}/forms/${form.id}/open`, {}, 'Sent. It’s in everyone’s to-do list now.').then((r) => r && setView('people'))}>
            <Send size={14} /> Send out
          </button>
        ) : (
          <>
            <button className="btn sm" onClick={makeSchedule}>
              <CalendarRange size={14} /> Make schedule
            </button>
            <button className="btn sm" onClick={() => saveCsv(org, form, 'sheets')} title="The same columns as a Google Sheets form export">
              <Download size={14} /> CSV
            </button>
          </>
        )}
      </div>
      <Seg
        value={view}
        onChange={setView}
        options={[
          ...(form.status === 'draft' ? [] : ([['matrix', 'Matrix'], ['people', 'People'], ['changes', 'Changes']] as [string, string][])),
          ['edit', form.status === 'draft' ? 'Set up' : 'Edit']
        ]}
      />
      {view === 'matrix' && <Matrix org={org} form={form} />}
      {view === 'people' && <People org={org} form={form} />}
      {view === 'changes' && <Changes org={org} form={form} />}
      {view === 'edit' && <FormEditor key={form.id} org={org} form={form} onDeleted={onBack} />}
    </div>
  );
}

async function saveCsv(org: Org, form: Form, format: 'sheets' | 'long') {
  const r = await api.hubOrg.saveCsv(org.id, form.id, format);
  if (!r.ok) return toast(r.error, 'error');
  if (r.value) toast('Saved.');
}

// ---------- results ----------
function heat(s: MatrixSlot) {
  if (!s.needTotal) return 'none';
  const r = s.available.length / s.needTotal;
  return r >= 1.5 ? 'g3' : r >= 1 ? 'g2' : r + s.ifNeeded.length / s.needTotal >= 1 ? 'y' : r > 0 ? 'o' : 'r';
}
function Matrix({ org, form }: { org: Org; form: Form }) {
  const structure = useHub<Structure>(`/v1/orgs/${org.id}/structure`);
  const [pos, setPos] = useState('');
  const { data, error, reload } = useHub<{ slots: MatrixSlot[]; submitted: number }>(`/v1/orgs/${org.id}/forms/${form.id}/matrix${pos ? `?positionId=${pos}` : ''}`);
  const [open, setOpen] = useState<string | null>(null);
  const byDate = useMemo(() => {
    const m = new Map<string, MatrixSlot[]>();
    for (const s of data?.slots ?? []) (m.get(s.date) ?? m.set(s.date, []).get(s.date)!).push(s);
    return [...m.entries()];
  }, [data]);
  if (error) return <Problem error={error} retry={reload} />;
  if (!data) return <Loading />;
  return (
    <div className="wk-stack">
      <div className="wk-toolbar">
        <span className="muted">{data.submitted} sent</span>
        <span className="wk-spacer" />
        <select className="input sm wk-auto" value={pos} onChange={(e) => setPos(e.target.value)}>
          <option value="">All positions</option>
          {structure.data?.positions.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <span className="mx-legend">
          <span className="mx-cell r" /> short
          <span className="mx-cell y" /> with if-needed
          <span className="mx-cell g2" /> covered
        </span>
      </div>
      <div className="mx">
        {byDate.map(([d, list]) => (
          <div key={d} className="mx-row">
            <div className="mx-date">
              <span>{fmtDay(d)}</span>
            </div>
            <div className="mx-cells">
              {list.map((s) => (
                <button key={s.key} className={`mx-cell ${heat(s)} ${open === s.key ? 'open' : ''}`} onClick={() => setOpen(open === s.key ? null : s.key)} title={`${s.available.length} available, ${s.ifNeeded.length} if needed, ${s.needTotal} needed`}>
                  <span className="mx-time">{s.label ?? fmtRange(s)}</span>
                  <span className="mx-count">
                    <b>{s.available.length}</b>
                    {s.ifNeeded.length ? <span className="mx-if"> +{s.ifNeeded.length}</span> : null}
                    {s.needTotal ? <span className="mx-need"> / {s.needTotal}</span> : null}
                  </span>
                </button>
              ))}
            </div>
            {list.some((s) => open === s.key) && (
              <div className="mx-names">
                {list
                  .filter((s) => open === s.key)
                  .map((s) => (
                    <div key={s.key}>
                      <b>{fmtRange(s)}</b> · Available: {s.available.map((p) => p.name).join(', ') || 'nobody'}
                      {s.ifNeeded.length ? ` · If needed: ${s.ifNeeded.map((p) => p.name).join(', ')}` : ''}
                    </div>
                  ))}
              </div>
            )}
            {list[0].notes.length > 0 && (
              <div className="mx-notes">
                {list[0].notes.map((n) => (
                  <span key={n.id}>
                    <b>{n.name}:</b> {n.note}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function People({ org, form }: { org: Org; form: Form }) {
  const { data, error, reload } = useHub<{ people: PersonRow[]; missing: number }>(`/v1/orgs/${org.id}/forms/${form.id}/people`);
  const [sort, setSort] = useState<'name' | 'missing'>('missing');
  if (error) return <Problem error={error} retry={reload} />;
  if (!data) return <Loading />;
  const rows = [...data.people].sort((a, b) => (sort === 'missing' ? Number(a.submitted) - Number(b.submitted) : 0) || a.name.localeCompare(b.name));
  return (
    <div className="wk-stack">
      <div className="wk-toolbar">
        <span className={data.missing ? 'wk-pill warn' : 'wk-pill good'}>{data.missing ? `${data.missing} haven’t sent it` : 'Everyone has sent it'}</span>
        <span className="wk-spacer" />
        <Seg value={sort} onChange={setSort} options={[['missing', 'Not sent first'], ['name', 'By name']]} />
        {data.missing > 0 && form.status === 'open' && (
          <button className="btn sm" onClick={() => act<{ nudged: number }>(`/v1/orgs/${org.id}/forms/${form.id}/nudge`, {}).then((r) => r && toast(`Reminded ${r.nudged}.`))}>
            <BellRing size={14} /> Remind everyone
          </button>
        )}
        <button className="btn sm" onClick={() => saveCsv(org, form, 'long')} title="One row per person, date and block">
          <Download size={14} /> CSV by date
        </button>
      </div>
      <table className="wk-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Sent</th>
            <th>Wants</th>
            <th>Available</th>
            <th>If needed</th>
            <th>Notes</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const want = wantText(p.desiredMin, p.desiredMax) ?? '—';
            const low = p.submitted && p.desiredMin != null && p.hours.perWeekAvailable < p.desiredMin;
            return (
              <tr key={p.id} className={p.submitted ? '' : 'wk-dim'}>
                <td>
                  {p.name}
                  {p.minor && <span className="wk-pill sm">Under 18</span>}
                </td>
                <td>{p.submitted ? <span className={p.late ? 'wk-pill warn' : ''}>{p.late ? 'Late · ' : ''}{fmtWhen(p.submittedAt!, org.tz)}</span> : p.nudgedAt ? `Reminded ${fmtWhen(p.nudgedAt)}` : 'Not yet'}</td>
                <td>{want}</td>
                <td className={low ? 'wk-warn-text' : ''}>{p.submitted ? `${hrs(p.hours.perWeekAvailable)}/wk` : ''}</td>
                <td>{p.submitted && p.hours.perWeekIfNeeded ? `${hrs(p.hours.perWeekIfNeeded)}/wk` : ''}</td>
                <td className="wk-notes-cell">
                  {[p.note, p.daysOff && `Off: ${p.daysOff}`, ...Object.entries(p.dateNotes).map(([d, n]) => `${fmtShortDate(d)}: ${n}`)].filter(Boolean).join(' · ')}
                  {p.pendingChange && <span className="wk-pill warn sm">Change waiting</span>}
                </td>
                <td>
                  {!p.submitted && form.status === 'open' && (
                    <button className="btn sm" onClick={() => act(`/v1/orgs/${org.id}/forms/${form.id}/nudge`, { accountIds: [p.id] }, `Reminded ${p.name}.`)}>
                      Remind
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Changes({ org, form }: { org: Org; form: Form }) {
  const { data, error } = useHub<{ changes: Change[] }>(`/v1/orgs/${org.id}/forms/${form.id}/changes`);
  if (error) return <Problem error={error} />;
  if (!data) return <Loading />;
  if (!data.changes.length) return <Empty title="No change requests">After the deadline, changes people send wait here for you.</Empty>;
  const word = { A: 'Available', I: 'If needed', N: 'Not available' } as const;
  return (
    <div className="wk-list">
      {data.changes.map((c) => (
        <Card
          key={c.id}
          title={`${c.name}${c.reason ? `: “${c.reason}”` : ''}`}
          actions={
            c.status === 'pending' ? (
              <>
                <button className="btn sm" onClick={() => act(`/v1/orgs/${org.id}/changes/${c.id}/decide`, { approve: false }, 'Declined.')}>
                  <X size={14} /> Decline
                </button>
                <button className="btn sm primary" onClick={() => act(`/v1/orgs/${org.id}/changes/${c.id}/decide`, { approve: true }, 'Approved.')}>
                  <CheckIcon size={14} /> Approve
                </button>
              </>
            ) : (
              <span className="wk-pill">{c.status === 'approved' ? 'Approved' : 'Declined'}</span>
            )
          }
        >
          <ul className="wk-diff">
            {c.diff.slice(0, 40).map((d) => {
              const [date, block] = d.key.split('|');
              const b = form.blocks.find((x) => x.id === block);
              return (
                <li key={d.key}>
                  {fmtDay(date)} {b ? fmtRange(b) : ''}: {word[d.from]} → <b>{word[d.to]}</b>
                </li>
              );
            })}
            {c.diff.length > 40 && <li className="muted">and {c.diff.length - 40} more</li>}
          </ul>
        </Card>
      ))}
    </div>
  );
}

// ---------- the editor ----------
function NeedEditor({ need, positions, onChange }: { need: Block['need']; positions: Position[]; onChange(n: Block['need']): void }) {
  const unused = positions.filter((p) => !need.some((n) => n.positionId === p.id));
  return (
    <span className="fe-need">
      {need.map((n) => (
        <span key={n.positionId} className="fe-need-item">
          <Num value={n.count} onChange={(v) => onChange(v ? need.map((x) => (x.positionId === n.positionId ? { ...x, count: v } : x)) : need.filter((x) => x.positionId !== n.positionId))} />
          {positions.find((p) => p.id === n.positionId)?.name ?? '?'}
        </span>
      ))}
      {unused.length > 0 && (
        <select className="input sm fe-need-add" value="" onChange={(e) => e.target.value && onChange([...need, { positionId: e.target.value, count: 1 }])} title="How many people this block needs">
          <option value="">{need.length ? '+ need' : 'Need…'}</option>
          {unused.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      )}
    </span>
  );
}

function BlockRow({ b, positions, onChange, onRemove }: { b: Block; positions: Position[]; onChange(b: Block): void; onRemove(): void }) {
  return (
    <div className="fe-block">
      <input className="input sm fe-time" type="time" value={b.start} onChange={(e) => onChange({ ...b, start: e.target.value })} />
      <span>to</span>
      <input className="input sm fe-time" type="time" value={b.end} onChange={(e) => onChange({ ...b, end: e.target.value })} />
      <input className="input sm fe-label" placeholder="Name (optional)" value={b.label ?? ''} onChange={(e) => onChange({ ...b, label: e.target.value || null })} />
      <NeedEditor need={b.need} positions={positions} onChange={(need) => onChange({ ...b, need })} />
      <input
        className="input sm fe-tags"
        placeholder="Tags: opener, closer"
        title="Preferences people can match (auto-fill puts openers on blocks tagged opener)"
        value={b.tags.join(', ')}
        onChange={(e) => onChange({ ...b, tags: e.target.value.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean) })}
      />
      <button className="icon-btn sm" title="Remove" onClick={onRemove}>
        <Trash2 size={14} />
      </button>
    </div>
  );
}

function FormEditor({ org, form, onDeleted }: { org: Org; form: Form; onDeleted(): void }) {
  const structure = useHub<Structure>(`/v1/orgs/${org.id}/structure`);
  const positions = structure.data?.positions ?? [];
  const [title, setTitle] = useState(form.title);
  const [start, setStart] = useState(form.periodStart);
  const [end, setEnd] = useState(form.periodEnd);
  const [deadline, setDeadline] = useState(form.deadlineAt ? toLocalInput(form.deadlineAt) : '');
  const [blocks, setBlocks] = useState<Block[]>(form.blocks);
  const [exceptions, setExceptions] = useState<DateException[]>(form.exceptions);
  const [questions, setQuestions] = useState<Questions>(form.questions);
  const [aud, setAud] = useState({ departments: form.audience.departments ?? [], positions: form.audience.positions ?? [] });
  const [minorNote, setMinorNote] = useState(form.minorNote ?? '');
  const [reminders, setReminders] = useState(form.reminders.join(', '));
  const [allowChanges, setAllowChanges] = useState(form.allowChanges);
  const [tplName, setTplName] = useState('');
  const [dirty, setDirty] = useState(false);
  const touch = <T,>(f: (v: T) => void) => (v: T) => (f(v), setDirty(true));

  const save = async (quiet = false) => {
    const r = await act(
      `/v1/orgs/${org.id}/forms/${form.id}`,
      {
        title,
        periodStart: start,
        periodEnd: end,
        deadline: deadline ? new Date(deadline).toISOString() : null,
        blocks,
        exceptions,
        questions,
        audience: aud,
        minorNote: minorNote || null,
        reminders: reminders.split(/[ ,]+/).map(Number).filter((n) => Number.isFinite(n) && n >= 0),
        allowChanges
      },
      quiet ? undefined : 'Saved.'
    );
    if (r) setDirty(false);
    return !!r;
  };
  const setDay = (wd: number, list: Block[]) => touch(setBlocks)([...blocks.filter((b) => b.weekday !== wd), ...list.map((b) => ({ ...b, weekday: wd }))]);
  const copyTo = (wd: number, days: number[]) => {
    const src = blocks.filter((b) => b.weekday === wd);
    touch(setBlocks)([...blocks.filter((b) => !days.includes(b.weekday!) || b.weekday === wd), ...days.filter((d) => d !== wd).flatMap((d) => src.map((b) => ({ ...b, id: newId(), weekday: d })))]);
  };
  const order = [1, 2, 3, 4, 5, 6, 0];
  const depts = structure.data?.departments ?? [];
  return (
    <div className="wk-stack fe">
      <Card title="Basics">
        <div className="wk-form-grid">
          <Field label="Title">
            <input className="input" value={title} onChange={(e) => touch(setTitle)(e.target.value)} />
          </Field>
          <Field label="From">
            <input className="input" type="date" value={start} onChange={(e) => touch(setStart)(e.target.value)} />
          </Field>
          <Field label="To">
            <input className="input" type="date" value={end} onChange={(e) => touch(setEnd)(e.target.value)} />
          </Field>
          <Field label="Deadline">
            <input className="input" type="datetime-local" value={deadline} onChange={(e) => touch(setDeadline)(e.target.value)} />
          </Field>
        </div>
      </Card>
      <Card title="Blocks each week" actions={<span className="muted">{blocks.length} blocks</span>}>
        {order.map((wd) => {
          const list = blocks.filter((b) => b.weekday === wd).sort((a, b) => a.start.localeCompare(b.start));
          return (
            <div key={wd} className="fe-day">
              <div className="fe-day-head">
                <b>{WEEKDAYS[wd]}</b>
                <span className="wk-spacer" />
                {list.length > 0 && wd >= 1 && wd <= 5 && (
                  <button className="btn link sm" onClick={() => copyTo(wd, [1, 2, 3, 4, 5])}>
                    <Copy size={13} /> Same on all weekdays
                  </button>
                )}
                <button className="btn link sm" onClick={() => setDay(wd, [...list, { id: newId(), weekday: wd, start: list.at(-1)?.end ?? '09:00', end: '13:00', need: list.at(-1)?.need ?? [], tags: [] }])}>
                  <Plus size={13} /> Block
                </button>
              </div>
              {list.map((b) => (
                <BlockRow key={b.id} b={b} positions={positions} onChange={(nb) => setDay(wd, list.map((x) => (x.id === b.id ? nb : x)))} onRemove={() => setDay(wd, list.filter((x) => x.id !== b.id))} />
              ))}
            </div>
          );
        })}
      </Card>
      <Card
        title="Dates that differ"
        actions={
          <button className="btn link sm" onClick={() => touch(setExceptions)([...exceptions, { date: start, kind: 'closed', note: '' }])}>
            <Plus size={13} /> Date
          </button>
        }
      >
        {!exceptions.length && <p className="muted">Holidays, special hours, meets and events.</p>}
        {exceptions.map((e, i) => {
          const upd = (x: Partial<DateException>) => touch(setExceptions)(exceptions.map((y, j) => (j === i ? { ...y, ...x } : y)));
          return (
            <div key={i} className="fe-ex">
              <div className="fe-block">
                <input className="input sm" type="date" min={start} max={end} value={e.date} onChange={(ev) => upd({ date: ev.target.value })} />
                <select className="input sm wk-auto" value={e.kind} onChange={(ev) => upd({ kind: ev.target.value as DateException['kind'], blocks: ev.target.value === 'closed' ? undefined : e.blocks ?? [] })}>
                  <option value="closed">Closed</option>
                  <option value="hours">Different hours</option>
                  <option value="extra">Extra blocks</option>
                </select>
                <input className="input sm" placeholder={e.kind === 'closed' ? 'Why, for example Christmas' : 'Note'} value={e.note ?? ''} onChange={(ev) => upd({ note: ev.target.value })} />
                {e.kind !== 'closed' && (
                  <button className="btn link sm" onClick={() => upd({ blocks: [...(e.blocks ?? []), { id: newId(), start: '17:00', end: '21:00', label: null, need: [], tags: [] }] })}>
                    <Plus size={13} /> Block
                  </button>
                )}
                <button className="icon-btn sm" title="Remove" onClick={() => touch(setExceptions)(exceptions.filter((_, j) => j !== i))}>
                  <Trash2 size={14} />
                </button>
              </div>
              {(e.blocks ?? []).map((b) => (
                <div key={b.id} className="wk-indent">
                  <BlockRow b={b} positions={positions} onChange={(nb) => upd({ blocks: e.blocks!.map((x) => (x.id === b.id ? nb : x)) })} onRemove={() => upd({ blocks: e.blocks!.filter((x) => x.id !== b.id) })} />
                </div>
              ))}
            </div>
          );
        })}
      </Card>
      <Card title="Questions">
        <Check label="Hours wanted each week" checked={questions.desiredHours.on} onChange={(on) => touch(setQuestions)({ ...questions, desiredHours: { on } })} />
        <Check label="Days off needed" checked={questions.daysOff.on} onChange={(on) => touch(setQuestions)({ ...questions, daysOff: { on } })} />
        <Check label="Notes" checked={questions.notes.on} onChange={(on) => touch(setQuestions)({ ...questions, notes: { on } })} />
        {questions.custom.map((c, i) => {
          const upd = (x: Partial<CustomQuestion>) => touch(setQuestions)({ ...questions, custom: questions.custom.map((y, j) => (j === i ? { ...y, ...x } : y)) });
          return (
            <div key={c.id} className="fe-block">
              <input type="checkbox" checked={c.on} onChange={(e) => upd({ on: e.target.checked })} title="Ask this" />
              <input className="input sm" value={c.label} placeholder="Question" onChange={(e) => upd({ label: e.target.value })} />
              <select className="input sm wk-auto" value={c.type} onChange={(e) => upd({ type: e.target.value as CustomQuestion['type'] })}>
                <option value="text">Text</option>
                <option value="yesno">Yes or no</option>
                <option value="choice">Pick one</option>
                <option value="multi">Pick any</option>
              </select>
              {(c.type === 'choice' || c.type === 'multi') && <input className="input sm" placeholder="Choices, separated by commas" value={c.options.join(', ')} onChange={(e) => upd({ options: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />}
              <button className="icon-btn sm" title="Remove" onClick={() => touch(setQuestions)({ ...questions, custom: questions.custom.filter((_, j) => j !== i) })}>
                <Trash2 size={14} />
              </button>
            </div>
          );
        })}
        <button className="btn link sm" onClick={() => touch(setQuestions)({ ...questions, custom: [...questions.custom, { id: `q${Date.now().toString(36)}`, label: '', type: 'text', options: [], on: true }] })}>
          <Plus size={13} /> Question
        </button>
      </Card>
      <Card title="Who gets it">
        <p className="muted af-small">{aud.departments.length || aud.positions.length ? 'Only the departments and positions picked.' : 'Everyone in the organization.'}</p>
        <div className="wk-tags">
          {depts.map((d) => (
            <button key={d.id} className={`wk-chip ${aud.departments.includes(d.id) ? 'on' : ''}`} onClick={() => touch(setAud)({ ...aud, departments: aud.departments.includes(d.id) ? aud.departments.filter((x) => x !== d.id) : [...aud.departments, d.id] })}>
              {d.name}
            </button>
          ))}
          {positions.map((p) => (
            <button key={p.id} className={`wk-chip ${aud.positions.includes(p.id) ? 'on' : ''}`} onClick={() => touch(setAud)({ ...aud, positions: aud.positions.includes(p.id) ? aud.positions.filter((x) => x !== p.id) : [...aud.positions, p.id] })}>
              {p.name}
            </button>
          ))}
        </div>
      </Card>
      <Advanced>
        <Field label="Note shown only to people under 18">
          <input className="input" value={minorNote} onChange={(e) => touch(setMinorNote)(e.target.value)} placeholder="For example: no shifts before 7am on school days" />
        </Field>
        <Field label="Reminders (hours before the deadline)" hint="0 is the morning of. The to-do item moves up at each one.">
          <input className="input" value={reminders} onChange={(e) => touch(setReminders)(e.target.value)} />
        </Field>
        <Check label="After the deadline, people can send changes for you to approve" checked={allowChanges} onChange={touch(setAllowChanges)} />
        <Field label="Save these blocks as a template">
          <div className="wk-form-row">
            <input className="input sm" placeholder="Template name, for example Lifeguard blocks" value={tplName} onChange={(e) => setTplName(e.target.value)} />
            <button className="btn sm" disabled={!tplName.trim() || !blocks.length} onClick={async () => (await act(`/v1/orgs/${org.id}/block-sets`, { name: tplName, blocks }, 'Template saved.')) && setTplName('')}>
              Save template
            </button>
          </div>
        </Field>
      </Advanced>
      <div className="wk-actions sticky">
        <button
          className="btn danger"
          onClick={async () => {
            if ((await ask('Delete this form?', 'Everyone’s answers are deleted too.', [{ id: 'no', label: 'Cancel' }, { id: 'yes', label: 'Delete', danger: true, primary: true }])) === 'yes' && (await act(`/v1/orgs/${org.id}/forms/${form.id}/delete`))) onDeleted();
          }}
        >
          Delete
        </button>
        {form.status === 'open' && (
          <button className="btn" onClick={() => act(`/v1/orgs/${org.id}/forms/${form.id}/close`, {}, 'Closed. No more answers.')}>
            Close form
          </button>
        )}
        <span className="wk-spacer" />
        <button className="btn" disabled={!dirty} onClick={() => save()}>
          Save
        </button>
        {form.status === 'draft' && (
          <button className="btn primary" onClick={async () => (!dirty || (await save(true))) && act(`/v1/orgs/${org.id}/forms/${form.id}/open`, {}, 'Sent. It’s in everyone’s to-do list now.')}>
            <Send size={14} /> Send out
          </button>
        )}
      </div>
    </div>
  );
}
const toLocalInput = (ms: number) => {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
};
export { addDays, WD };
