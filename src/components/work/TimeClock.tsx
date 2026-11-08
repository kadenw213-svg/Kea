// Work → Time: clocking in and out, today's status, my timecard, missed-punch requests and time off; and for those
// whose roles allow it, everyone's timecards to approve, missed punches and time off to decide, and who's in today.
// Everything goes to the organization's own routes (org/clock.mjs in KeaS); the server checks each ability again.
import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Clock3, LogIn, LogOut, Plus, X } from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../store';
import { act, addDays, bump, clock, fmtDay, post, todayIso, useHub, useMyId } from './workStore';
import { Advanced, Card, Empty, Field, Loading, Problem, Seg } from './ui';
import { can, canAny } from './types';
import type { Org, Shift } from './types';

export interface ClockStatus {
  clockedIn: boolean;
  punch: { id: string; type: 'in' | 'out'; at: string; shiftId: string | null } | null;
  canClock: boolean;
  period: { start: string; end: string };
}
interface TodayShift {
  shiftId: string;
  accountId: string;
  name: string | null;
  positionName: string | null;
  start: string;
  end: string;
  state: 'upcoming' | 'late' | 'clocked_in' | 'clocked_out' | 'no_show';
  minutesLate: number;
  clockedInAt: string | null;
  clockedOutAt: string | null;
}
interface Punch {
  id: string;
  type: 'in' | 'out';
  at: string;
  source: string;
}
interface Timecard {
  person: { id: string; name: string | null };
  period: { start: string; end: string };
  days: { date: string; punches: Punch[]; workedMin: number; regularMin: number; overtimeMin: number }[];
  totals: { workedMin: number; regularMin?: number; overtimeMin: number };
  flags: { code?: string; message?: string }[];
  approved: { by: string; at: string } | null;
  pendingRequests: number;
  timeOff: TimeOff[];
}
interface PunchRequest {
  id: string;
  accountId: string;
  name?: string | null;
  shiftId: string;
  type: 'in' | 'out';
  at: string;
  reasonCode: string;
  note: string | null;
  status: 'pending' | 'approved' | 'denied';
}
interface TimeOff {
  id: string;
  accountId: string;
  name?: string | null;
  kind: string;
  startDate: string;
  endDate: string;
  hours: number | null;
  status: 'pending' | 'approved' | 'denied' | 'cancelled';
}

const h = (min: number) => `${Math.round((min / 60) * 100) / 100} h`;
const REASONS: [string, string][] = [
  ['forgot', 'I forgot to clock'],
  ['device', 'The clock didn’t work'],
  ['early_late_fix', 'Fix a punch that was early or late'],
  ['other', 'Something else'],
];
const STATE: Record<TodayShift['state'], string> = { upcoming: 'Coming up', late: 'Late', clocked_in: 'In', clocked_out: 'Done', no_show: 'Didn’t clock in' };
/** An older server without the time clock answers a bare "Not found.". */
const noClock = (e: { status: number | null; message: string }) => e.status === 404 && e.message === 'Not found.';

/** Clock in or out (the server finds the shift, and says so when there's none and the organization needs one). */
export async function punch(org: Pick<Org, 'id' | 'name'>, type: 'in' | 'out') {
  try {
    const r = await post<{ minutesLate: number; late: boolean; shift: unknown }>(`/v1/orgs/${org.id}/clock`, { type, source: 'app' });
    toast(type === 'out' ? 'Clocked out.' : r.late ? `Clocked in, ${r.minutesLate} min late.` : 'Clocked in.');
    bump();
    return true;
  } catch (e: any) {
    toast(noClock(e) ? `${org.name}’s server doesn’t have the time clock yet.` : e.message, 'error');
    return false;
  }
}

/** The clock button with today's status: on the Time tab, and on Home. */
export function ClockCard({ org, compact = false }: { org: Org; compact?: boolean }) {
  const st = useHub<ClockStatus>(`/v1/orgs/${org.id}/clock`);
  const today = useHub<{ date: string; shifts: TodayShift[] }>(`/v1/orgs/${org.id}/clock/today`);
  const me = useMyId();
  const [busy, setBusy] = useState(false);
  if (st.error) return compact ? null : <Problem error={st.error} retry={st.reload} />;
  if (!st.data) return compact ? null : <Loading />;
  if (!st.data.canClock) return null;
  const mine = (today.data?.shifts ?? []).filter((s) => s.accountId === me);
  const next = mine.find((s) => s.state === 'upcoming' || s.state === 'late') ?? mine[0] ?? null;
  const since = st.data.clockedIn && st.data.punch ? clock(st.data.punch.at, org.tz) : null;
  const go = async () => {
    setBusy(true);
    await punch(org, st.data!.clockedIn ? 'out' : 'in');
    setBusy(false);
  };
  return (
    <div className="wk-clock">
      <Clock3 size={compact ? 16 : 20} />
      <span className="wk-clock-state">
        <b>{since ? `Clocked in since ${since}` : 'Not clocked in'}</b>
        <span className="muted af-small">
          {compact ? `${org.name} · ` : ''}
          {next ? `${next.positionName ?? 'Shift'} ${clock(next.start, org.tz)}–${clock(next.end, org.tz)}${next.state === 'late' && !since ? ` · ${next.minutesLate} min past start` : ''}` : 'No shift today'}
        </span>
      </span>
      <button className={`btn ${st.data.clockedIn ? '' : 'primary'} wk-clock-btn`} disabled={busy} onClick={go}>
        {st.data.clockedIn ? <LogOut size={15} /> : <LogIn size={15} />} {st.data.clockedIn ? 'Clock out' : 'Clock in'}
      </button>
    </div>
  );
}

export function TimeTab({ org }: { org: Org }) {
  const team = canAny(org, ['timecards.view', 'timecards.approve', 'timeoff.decide']);
  const [view, setView] = useState<'mine' | 'team'>('mine');
  return (
    <div className="wk-stack">
      {team && (
        <Seg
          value={view}
          onChange={setView}
          options={[
            ['mine', 'Mine'],
            ['team', 'Everyone'],
          ]}
        />
      )}
      {view === 'team' && team ? (
        <TeamTime org={org} />
      ) : (
        <>
          {can(org, 'clock.self') && (
            <Card title="Time clock">
              <ClockCard org={org} />
            </Card>
          )}
          <MyTimecard org={org} />
          {can(org, 'clock.self') && <MissedPunch org={org} />}
          <MyTimeOff org={org} />
        </>
      )}
    </div>
  );
}

/** Pay periods back and forward from the one the server sent (they're all the same length). */
function usePeriod(initial: { start: string; end: string } | null) {
  const [start, setStart] = useState<string | null>(null);
  const len = initial ? Math.round((Date.parse(initial.end) - Date.parse(initial.start)) / 864e5) + 1 : 14;
  const cur = start ?? initial?.start ?? null;
  return { start: cur, end: cur ? addDays(cur, len - 1) : null, prev: () => cur && setStart(addDays(cur, -len)), next: () => cur && setStart(addDays(cur, len)), reset: () => setStart(null), moved: start != null };
}
function PeriodNav({ p, label }: { p: ReturnType<typeof usePeriod>; label?: string }) {
  if (!p.start || !p.end) return null;
  return (
    <span className="wk-inline">
      <button className="icon-btn sm" title="Earlier pay period" onClick={p.prev}>
        <ChevronLeft size={15} />
      </button>
      {label ?? `${fmtDay(p.start, { month: 'short', day: 'numeric' })} – ${fmtDay(p.end, { month: 'short', day: 'numeric' })}`}
      <button className="icon-btn sm" title="Later pay period" onClick={p.next}>
        <ChevronRight size={15} />
      </button>
    </span>
  );
}

function MyTimecard({ org }: { org: Org }) {
  const st = useHub<ClockStatus>(`/v1/orgs/${org.id}/clock`);
  const p = usePeriod(st.data?.period ?? null);
  const tc = useHub<Timecard>(p.start ? `/v1/orgs/${org.id}/timecards?periodStart=${p.start}` : null);
  if (st.error) return <Problem error={st.error === 'Not found.' ? `${org.name}’s server doesn’t have the time clock yet.` : st.error} />;
  return (
    <Card title="My timecard" actions={<PeriodNav p={p} />}>
      {tc.error && <Problem error={tc.error} retry={tc.reload} />}
      {!tc.data ? (
        !tc.error && <Loading />
      ) : (
        <>
          <table className="wk-table wk-tc-table">
            <tbody>
              {tc.data.days
                .filter((d) => d.punches.length || d.date <= todayIso())
                .map((d) => (
                  <tr key={d.date} className={d.punches.length ? '' : 'wk-dim'}>
                    <td>{fmtDay(d.date)}</td>
                    <td>{d.punches.map((x) => `${x.type === 'in' ? 'In' : 'Out'} ${clock(x.at, org.tz)}${x.source.startsWith('request:') ? ' (fixed)' : ''}`).join(' · ') || '—'}</td>
                    <td className="num">{d.workedMin ? h(d.workedMin) : ''}</td>
                    <td className="num muted">{d.overtimeMin ? `${h(d.overtimeMin)} overtime` : ''}</td>
                  </tr>
                ))}
            </tbody>
          </table>
          <p className="af-small">
            <b>{h(tc.data.totals.workedMin)}</b> worked{tc.data.totals.overtimeMin ? `, ${h(tc.data.totals.overtimeMin)} overtime` : ''}
            {tc.data.approved ? ' · Approved' : ''}
            {tc.data.pendingRequests ? ` · ${tc.data.pendingRequests} fix${tc.data.pendingRequests === 1 ? '' : 'es'} waiting` : ''}
          </p>
          {tc.data.flags.length > 0 && <p className="muted af-small">{tc.data.flags.map((f) => f.message || f.code).join(' · ')}</p>}
        </>
      )}
    </Card>
  );
}

/** "I forgot to clock out": a request for a manager to add the punch to one of my shifts. */
function MissedPunch({ org }: { org: Org }) {
  const me = useMyId();
  const from = useMemo(() => new Date(Date.now() - 3 * 864e5).toISOString(), []);
  const to = useMemo(() => new Date(Date.now() + 864e5).toISOString(), []);
  const shifts = useHub<{ shifts: Shift[] }>(`/v1/orgs/${org.id}/my-shifts?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  const reqs = useHub<{ requests: PunchRequest[] }>(`/v1/orgs/${org.id}/punch-requests`);
  const [open, setOpen] = useState(false);
  const [shiftId, setShiftId] = useState('');
  const [type, setType] = useState<'in' | 'out'>('out');
  const [at, setAt] = useState('');
  const [reason, setReason] = useState('forgot');
  const [note, setNote] = useState('');
  const past = (shifts.data?.shifts ?? []).filter((s) => s.startAt <= Date.now());
  const mine = (reqs.data?.requests ?? []).filter((r) => r.accountId === me).slice(0, 5);
  const local = (iso: string) => {
    const d = new Date(iso);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };
  const pick = (id: string, t = type) => {
    setShiftId(id);
    const s = past.find((x) => x.id === id);
    if (s) setAt(local(t === 'in' ? s.start : s.end));
  };
  const send = async () => {
    if (await act(`/v1/orgs/${org.id}/punch-requests`, { shiftId, type, at: new Date(at).toISOString(), reasonCode: reason, note: note.trim() || null }, 'Sent. Your manager fixes it.')) {
      setOpen(false);
      setNote('');
    }
  };
  return (
    <Card
      title="Missed a punch?"
      actions={
        !open && (
          <button className="btn link sm" onClick={() => setOpen(true)}>
            <Plus size={13} /> Ask for a fix
          </button>
        )
      }
    >
      {open &&
        (!past.length ? (
          <p className="muted">No shifts of yours in the last three days.</p>
        ) : (
          <>
            <div className="wk-form-grid">
              <Field label="Shift">
                <select className="input sm" value={shiftId} onChange={(e) => pick(e.target.value)}>
                  <option value="">Pick a shift…</option>
                  {past.map((s) => (
                    <option key={s.id} value={s.id}>
                      {fmtDay(s.date)} · {s.positionName ?? 'Shift'} {clock(s.start, org.tz)}–{clock(s.end, org.tz)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Missing">
                <select className="input sm" value={type} onChange={(e) => (setType(e.target.value as 'in' | 'out'), shiftId && pick(shiftId, e.target.value as 'in' | 'out'))}>
                  <option value="in">Clocking in</option>
                  <option value="out">Clocking out</option>
                </select>
              </Field>
              <Field label="When">
                <input className="input sm" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
              </Field>
              <Field label="Why">
                <select className="input sm" value={reason} onChange={(e) => setReason(e.target.value)}>
                  {REASONS.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <input className="input sm" placeholder={reason === 'other' ? 'Say what happened' : 'A note (optional)'} value={note} onChange={(e) => setNote(e.target.value)} />
            <div className="wk-actions">
              <button className="btn sm" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button className="btn sm primary" disabled={!shiftId || !at || (reason === 'other' && !note.trim())} onClick={send}>
                Send
              </button>
            </div>
          </>
        ))}
      {!open && !mine.length && <p className="muted af-small">Forgot to clock in or out? Ask here, and your manager adds it to your timecard.</p>}
      {mine.map((r) => (
        <div key={r.id} className="wk-row">
          <span className="wk-row-main">
            <span className="wk-row-title">
              {r.type === 'in' ? 'Clock in' : 'Clock out'} at {clock(r.at, org.tz)}, {fmtDay(r.at.slice(0, 10))}
            </span>
            <span className="wk-row-sub">{r.status === 'pending' ? 'Waiting for your manager' : r.status === 'approved' ? 'Fixed' : 'Not approved'}</span>
          </span>
        </div>
      ))}
    </Card>
  );
}

function MyTimeOff({ org }: { org: Org }) {
  const me = useMyId();
  const data = useHub<{ timeOff: TimeOff[]; kinds: string[] }>(`/v1/orgs/${org.id}/time-off`);
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState('vacation');
  const [start, setStart] = useState(addDays(todayIso(), 7));
  const [end, setEnd] = useState(addDays(todayIso(), 7));
  const [hours, setHours] = useState('');
  if (data.error) return null;
  const mine = (data.data?.timeOff ?? []).filter((t) => t.accountId === me && t.status !== 'cancelled');
  const ask = can(org, 'timeoff.request');
  if (!ask && !mine.length) return null;
  const send = async () => {
    if (await act(`/v1/orgs/${org.id}/time-off`, { kind, startDate: start, endDate: end < start ? start : end, hours: hours ? Number(hours) : null }, 'Asked. Your manager decides.')) setOpen(false);
  };
  return (
    <Card
      title="Time off"
      actions={
        ask &&
        !open && (
          <button className="btn link sm" onClick={() => setOpen(true)}>
            <Plus size={13} /> Ask for time off
          </button>
        )
      }
    >
      {open && (
        <>
          <div className="wk-form-grid">
            <Field label="Kind">
              <select className="input sm" value={kind} onChange={(e) => setKind(e.target.value)}>
                {(data.data?.kinds ?? ['vacation', 'sick', 'personal']).map((k) => (
                  <option key={k} value={k}>
                    {k.charAt(0).toUpperCase() + k.slice(1)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="First day">
              <input className="input sm" type="date" value={start} onChange={(e) => (setStart(e.target.value), end < e.target.value && setEnd(e.target.value))} />
            </Field>
            <Field label="Last day">
              <input className="input sm" type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} />
            </Field>
          </div>
          <Advanced>
            <Field label="Hours" hint="Only when it isn’t whole days.">
              <input className="input sm" type="number" min={0} step={0.25} value={hours} onChange={(e) => setHours(e.target.value)} />
            </Field>
          </Advanced>
          <div className="wk-actions">
            <button className="btn sm" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button className="btn sm primary" onClick={send}>
              Ask
            </button>
          </div>
        </>
      )}
      {!open && !mine.length && <p className="muted af-small">Nothing asked for.</p>}
      {mine.map((t) => (
        <div key={t.id} className="wk-row">
          <span className="wk-row-main">
            <span className="wk-row-title">
              {t.kind.charAt(0).toUpperCase() + t.kind.slice(1)}: {fmtDay(t.startDate)}
              {t.endDate !== t.startDate ? ` – ${fmtDay(t.endDate)}` : ''}
            </span>
            <span className="wk-row-sub">{t.status === 'pending' ? 'Waiting for your manager' : t.status === 'approved' ? 'Approved' : 'Not approved'}</span>
          </span>
          {(t.status === 'pending' || (t.status === 'approved' && t.startDate > todayIso())) && (
            <button className="btn sm" onClick={() => act(`/v1/orgs/${org.id}/time-off/${t.id}/cancel`, {}, 'Taken back.')}>
              Take back
            </button>
          )}
        </div>
      ))}
    </Card>
  );
}

/** Everyone's time, for those whose roles allow it. */
function TeamTime({ org }: { org: Org }) {
  const me = useMyId();
  const view = can(org, 'timecards.view');
  const approve = can(org, 'timecards.approve');
  const period = useHub<{ period: { start: string; end: string }; current: { start: string; end: string }; people: { accountId: string; name: string; workedMin: number; overtimeMin: number; approved: boolean; flags: number; pendingRequests: number; mine: boolean }[] }>(view ? `/v1/orgs/${org.id}/timecards/period` : null);
  const p = usePeriod(period.data?.period ?? null);
  const shown = useHub<typeof period.data>(view && p.moved && p.start ? `/v1/orgs/${org.id}/timecards/period?periodStart=${p.start}` : null);
  const data = p.moved ? shown.data : period.data;
  const reqs = useHub<{ requests: PunchRequest[] }>(approve ? `/v1/orgs/${org.id}/punch-requests?status=pending` : null);
  const off = useHub<{ timeOff: TimeOff[] }>(can(org, 'timeoff.decide') ? `/v1/orgs/${org.id}/time-off?status=pending` : null);
  const today = useHub<{ shifts: TodayShift[] }>(view ? `/v1/orgs/${org.id}/clock/today` : null);
  const waiting = (data?.people ?? []).filter((x) => !x.approved && !x.mine && x.workedMin > 0);
  const others = (reqs.data?.requests ?? []).filter((r) => r.accountId !== me);
  const offs = (off.data?.timeOff ?? []).filter((t) => t.accountId !== me);
  return (
    <>
      {view && (
        <Card
          title="Timecards"
          actions={
            <>
              <PeriodNav p={p} label={data ? `${fmtDay(data.period.start, { month: 'short', day: 'numeric' })} – ${fmtDay(data.period.end, { month: 'short', day: 'numeric' })}` : undefined} />
              {approve && waiting.length > 1 && (
                <button className="btn sm" onClick={() => act(`/v1/orgs/${org.id}/timecards/approve-many`, { accountIds: waiting.map((x) => x.accountId), periodStart: data!.period.start }, 'Approved.')}>
                  Approve {waiting.length}
                </button>
              )}
            </>
          }
        >
          {(period.error || shown.error) && <Problem error={period.error || shown.error} />}
          {!data ? (
            !period.error && <Loading />
          ) : !data.people.length ? (
            <Empty title="Nobody’s timecard to show" />
          ) : (
            <table className="wk-table wk-tc-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th className="num">Worked</th>
                  <th className="num">Overtime</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.people.map((x) => (
                  <tr key={x.accountId}>
                    <td>
                      {x.name}
                      {x.pendingRequests ? <span className="wk-pill sm">{x.pendingRequests} fix{x.pendingRequests === 1 ? '' : 'es'} waiting</span> : null}
                      {x.flags ? <span className="wk-pill sm">{x.flags} to check</span> : null}
                    </td>
                    <td className="num">{h(x.workedMin)}</td>
                    <td className="num">{x.overtimeMin ? h(x.overtimeMin) : ''}</td>
                    <td className="wk-nowrap">
                      {x.approved ? (
                        <>
                          <span className="wk-pill good sm">Approved</span>
                          {approve && !x.mine && (
                            <button className="btn link sm" onClick={() => act(`/v1/orgs/${org.id}/timecards/unapprove`, { accountId: x.accountId, periodStart: data.period.start }, 'Approval taken back.')}>
                              Undo
                            </button>
                          )}
                        </>
                      ) : (
                        approve &&
                        !x.mine && (
                          <button className="btn sm" onClick={() => act(`/v1/orgs/${org.id}/timecards/approve`, { accountId: x.accountId, periodStart: data.period.start }, 'Approved.')}>
                            Approve
                          </button>
                        )
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
      {approve && others.length > 0 && (
        <Card title="Missed punches to fix">
          {others.map((r) => (
            <div key={r.id} className="wk-row">
              <span className="wk-row-main">
                <span className="wk-row-title">
                  {r.name}: {r.type === 'in' ? 'clock in' : 'clock out'} at {clock(r.at, org.tz)}, {fmtDay(r.at.slice(0, 10))}
                </span>
                <span className="wk-row-sub">
                  {REASONS.find(([v]) => v === r.reasonCode)?.[1] ?? r.reasonCode}
                  {r.note ? ` · “${r.note}”` : ''}
                </span>
              </span>
              <button className="btn sm" onClick={() => act(`/v1/orgs/${org.id}/punch-requests/${r.id}/decide`, { approve: false }, 'Declined.')}>
                <X size={14} /> Decline
              </button>
              <button className="btn sm primary" onClick={() => act(`/v1/orgs/${org.id}/punch-requests/${r.id}/decide`, { approve: true }, 'Added to their timecard.')}>
                Fix it
              </button>
            </div>
          ))}
        </Card>
      )}
      {offs.length > 0 && (
        <Card title="Time off to decide">
          {offs.map((t) => (
            <div key={t.id} className="wk-row">
              <span className="wk-row-main">
                <span className="wk-row-title">
                  {t.name}: {t.kind}, {fmtDay(t.startDate)}
                  {t.endDate !== t.startDate ? ` – ${fmtDay(t.endDate)}` : ''}
                </span>
                {t.hours ? <span className="wk-row-sub">{t.hours} h</span> : null}
              </span>
              <button className="btn sm" onClick={() => act(`/v1/orgs/${org.id}/time-off/${t.id}/decide`, { approve: false }, 'Declined.')}>
                <X size={14} /> Decline
              </button>
              <button className="btn sm primary" onClick={() => act(`/v1/orgs/${org.id}/time-off/${t.id}/decide`, { approve: true }, 'Approved.')}>
                Approve
              </button>
            </div>
          ))}
        </Card>
      )}
      {view && (today.data?.shifts.length ?? 0) > 0 && (
        <Card title="Today">
          {today.data!.shifts.map((s) => (
            <div key={s.shiftId} className="wk-row">
              <span className="wk-row-main">
                <span className="wk-row-title">{s.name}</span>
                <span className="wk-row-sub">
                  {s.positionName ?? 'Shift'} {clock(s.start, org.tz)}–{clock(s.end, org.tz)}
                </span>
              </span>
              <span className={`wk-pill sm ${s.state === 'late' || s.state === 'no_show' ? 'bad' : s.state === 'clocked_in' ? 'good' : ''}`}>
                {STATE[s.state]}
                {s.state === 'late' ? ` ${s.minutesLate} min` : ''}
              </span>
            </div>
          ))}
        </Card>
      )}
    </>
  );
}

/**
 * Home's Work card: a clock button for each organization where I clock in (the server says so: canClock), with
 * today's status. Organizations on a server without the time clock are left out.
 */
export function HomeClock() {
  const [list, setList] = useState<{ org: Pick<Org, 'id' | 'name' | 'tz'>; st: ClockStatus }[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    (async () => {
      const r = await api.hubOrg.call<{ orgs: Org[] }>('GET', '/v1/orgs');
      if (!r.ok) return setList([]);
      const out: { org: Org; st: ClockStatus }[] = [];
      await Promise.all(
        r.value.orgs
          .filter((o) => o.memberStatus === 'active' && o.status === 'active')
          .map(async (o) => {
            const c = await api.hubOrg.call<ClockStatus>('GET', `/v1/orgs/${o.id}/clock`);
            if (c.ok && c.value.canClock) out.push({ org: o, st: c.value });
          })
      );
      setList(out.sort((a, b) => a.org.name.localeCompare(b.org.name)));
    })();
  }, [n]);
  if (!list?.length) return null;
  return (
    <div className="dclock">
      {list.map(({ org, st }) => (
        <div key={org.id} className="wk-clock">
          <Clock3 size={15} />
          <span className="wk-clock-state">
            <span className="dtitle">{st.clockedIn && st.punch ? `Clocked in since ${clock(st.punch.at, org.tz)}` : 'Not clocked in'}</span>
            <span className="dsub">{org.name}</span>
          </span>
          <button
            className={`btn sm ${st.clockedIn ? '' : 'primary'}`}
            disabled={busy === org.id}
            onClick={async () => {
              setBusy(org.id);
              await punch(org as Org, st.clockedIn ? 'out' : 'in');
              setBusy(null);
              setN((x) => x + 1);
            }}
          >
            {st.clockedIn ? 'Clock out' : 'Clock in'}
          </button>
        </div>
      ))}
    </div>
  );
}
