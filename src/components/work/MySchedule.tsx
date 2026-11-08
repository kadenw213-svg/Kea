// My schedule: published shifts and org class sessions by week, swaps (offer mine, take others'), and the whole
// team's schedule when the org shows it. The shifts come from Kea's calendar copy (api.hubOrg.events), which is there
// when the Hub can't be reached; the Hub's own list adds swap details and notes when it answers.
import { useEffect, useMemo, useState } from 'react';
import { CalendarPlus, Clock3, GraduationCap, Repeat, Undo2, Users } from 'lucide-react';
import { api, WorkEvent } from '../../lib/api';
import { ask, prompt, toast } from '../../store';
import { act, clock, fmtDay, fmtWhen, todayIso, useHub, useMyId, useWork, addDays } from './workStore';
import { Card, Empty, Loading, Problem, Seg } from './ui';
import type { Member, Org, Shift, Swap } from './types';
import { can } from './types';
import { MyShiftCode } from './PayCodes';
import type { MyPay } from './payRules';

export function MySchedule({ org }: { org: Org }) {
  const [view, setView] = useState<'mine' | 'team'>('mine');
  const me = useMyId();
  const focus = useWork((s) => s.focus);
  const from = new Date(Date.now() - 86400_000).toISOString();
  const to = new Date(Date.now() + 70 * 86400_000).toISOString();
  const shifts = useHub<{ shifts: Shift[] }>(`/v1/orgs/${org.id}/my-shifts?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  const swaps = useHub<{ swaps: Swap[] }>(`/v1/orgs/${org.id}/swaps`);
  // My own pay codes, for the code on each shift (only codes I was given; none on a server without pay codes).
  const pay = useHub<MyPay>(`/v1/orgs/${org.id}/me/pay`);
  const [events, setEvents] = useState<WorkEvent[] | null>(null);
  const [offline, setOffline] = useState<{ at: number | null } | null>(null);
  const version = useWork((s) => s.version);
  useEffect(() => {
    api.hubOrg.events(from, to).then((r) => {
      if (r.ok) {
        setEvents(r.value.events.filter((e) => e.orgId === org.id));
        setOffline(r.value.offline ? { at: r.value.at ?? null } : null);
      } else setEvents([]);
    });
  }, [org.id, version]);
  const canTeam = can(org, 'schedule.view') || org.settings?.membersSeeSchedule !== false;

  // The Hub's list when it answered; otherwise the shifts from the saved copy.
  const mine: Shift[] = shifts.data?.shifts ?? (events ?? []).filter((e) => e.kind === 'shift').map(fromEvent);
  const classes = (events ?? []).filter((e) => e.kind === 'class');
  const byDate = useMemo(() => {
    const m = new Map<string, { shifts: Shift[]; classes: WorkEvent[] }>();
    const at = (d: string) => m.get(d) ?? m.set(d, { shifts: [], classes: [] }).get(d)!;
    for (const s of mine) at(s.date).shifts.push(s);
    for (const c of classes) at(c.date).classes.push(c);
    return [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  }, [mine, classes]);

  const open = (swaps.data?.swaps ?? []).filter((w) => w.status === 'offered' && w.shift && w.from !== me);
  // Shifts I took that wait for a manager: still the other person's until then.
  const waiting = (swaps.data?.swaps ?? []).filter((w) => w.status === 'claimed' && w.claimant === me && w.shift);
  const total = mine.filter((s) => s.date >= todayIso() && s.date < addDays(todayIso(), 7)).reduce((t, s) => t + (s.endAt - s.startAt) / 3600_000, 0);

  const offer = async (s: Shift) => {
    const note = await prompt('Offer this shift', 'A note for whoever takes it (optional)', '', 'For example: family trip');
    if (note === null) return;
    act(`/v1/orgs/${org.id}/shifts/${s.id}/swap`, { note: note || null }, 'Offered. It stays yours until someone takes it.');
  };
  const claim = async (w: Swap) => {
    const s = w.shift!;
    const what = `${s.positionName ?? 'Shift'}, ${fmtDay(s.date)}, ${clock(s.start, org.tz)}–${clock(s.end, org.tz)}`;
    const needsOk = org.settings ? org.settings.swapNeedsApproval !== false : true;
    if ((await ask(`Take ${w.fromName ? `${w.fromName}’s` : 'this'} shift?`, `${what}. ${needsOk ? 'Your manager approves it before it’s yours, and taking it can’t be undone here.' : 'It’s yours right away.'}`, [{ id: 'no', label: 'Cancel' }, { id: 'yes', label: 'Take it', primary: true }])) !== 'yes') return;
    const r = await act<{ swap: Swap }>(`/v1/orgs/${org.id}/swaps/${w.id}/claim`, {});
    if (r) toast(r.swap.status === 'approved' ? 'The shift is yours.' : 'Taken. It shows under “Waiting for your manager” until it’s approved.');
  };

  if (view === 'team') return <TeamSchedule org={org} onBack={() => setView('mine')} />;
  return (
    <div className="wk-sched">
      <div className="wk-toolbar">
        <span className="wk-big">{Math.round(total * 10) / 10} h</span>
        <span className="muted">in the next 7 days</span>
        <span className="wk-spacer" />
        {canTeam && (
          <button className="btn sm" onClick={() => setView('team')}>
            <Users size={14} /> Everyone
          </button>
        )}
        <button
          className="btn sm"
          title="Save the shifts and classes of all your organizations as a calendar file for Outlook, Google Calendar or Apple Calendar"
          onClick={async () => {
            const r = await api.hubOrg.saveIcs(from, to);
            if (!r.ok) toast(r.error, 'error');
            else if (r.value) toast('Saved. Open the file to add your shifts to your calendar app.');
            else toast('Nothing to add yet.');
          }}
        >
          <CalendarPlus size={14} /> Add to my calendar app
        </button>
      </div>
      {offline && (
        <p className="af-info">
          Your Kea account can’t be reached online, so this is the schedule Kea saved{offline.at ? ` ${fmtWhen(offline.at)}` : ' last time'}. Swaps wait until it’s back.
        </p>
      )}
      {waiting.length > 0 && (
        <Card title="Waiting for your manager">
          <div className="wk-list">
            {waiting.map((w) => (
              <div key={w.id} className="wk-row">
                <Clock3 size={15} />
                <span className="wk-row-main">
                  <span className="wk-row-title">
                    {w.shift!.positionName} · {fmtDay(w.shift!.date)} · {clock(w.shift!.start, org.tz)}–{clock(w.shift!.end, org.tz)}
                  </span>
                  <span className="wk-row-sub">You’re taking it from {w.fromName ?? 'a coworker'}. It’s yours once a manager approves.</span>
                </span>
                <span className="wk-pill warn">Waiting</span>
              </div>
            ))}
          </div>
        </Card>
      )}
      {open.length > 0 && !offline && (
        <Card title="Shifts up for grabs">
          <div className="wk-list">
            {open.map((w) => (
              <div key={w.id} className={`wk-row ${focus?.swapId === w.id ? 'focus' : ''}`}>
                <span className="wk-row-main">
                  <span className="wk-row-title">
                    {w.shift!.positionName} · {fmtDay(w.shift!.date)} · {clock(w.shift!.start, org.tz)}–{clock(w.shift!.end, org.tz)}
                  </span>
                  <span className="wk-row-sub">
                    From {w.fromName}
                    {w.to ? ' (to you)' : ''}
                    {w.note ? ` · “${w.note}”` : ''}
                  </span>
                </span>
                <button className="btn sm primary" onClick={() => claim(w)}>
                  Take it
                </button>
              </div>
            ))}
          </div>
        </Card>
      )}
      {/* (Offline, the saved copy above says so; the Hub's own error would only repeat it.) */}
      {!offline && events !== null && <Problem error={shifts.error} retry={shifts.reload} />}
      {!shifts.data && (events === null || (!offline && !shifts.error)) ? (
        <Loading />
      ) : !byDate.length ? (
        <Empty title="No shifts yet">Published shifts show here and in your to-do list. Classes you’re assigned show here too.</Empty>
      ) : (
        <div className="wk-days">
          {byDate.map(([d, x]) => (
            <div key={d} className={`wk-day ${d === todayIso() ? 'today' : ''}`}>
              <div className="wk-day-date">
                <span className="wk-day-wd">{fmtDay(d, { weekday: 'short' })}</span>
                <span className="wk-day-n">{Number(d.slice(8))}</span>
                <span className="wk-day-m">{fmtDay(d, { month: 'short' })}</span>
              </div>
              <div className="wk-day-items">
                {x.shifts.map((s) => {
                  const sw = (swaps.data?.swaps ?? []).find((w) => w.shiftId === s.id && ['offered', 'claimed'].includes(w.status));
                  return (
                    <div key={s.id} className={`wk-shift ${focus?.swapId && sw?.id === focus.swapId ? 'focus' : ''}`}>
                      <span className="wk-shift-time">
                        {clock(s.start, org.tz)}–{clock(s.end, org.tz)}
                      </span>
                      <span className="wk-shift-what">{s.positionName}</span>
                      {s.note && <span className="muted">{s.note}</span>}
                      <span className="wk-spacer" />
                      {!offline && !sw && <MyShiftCode org={org} shift={s} my={pay.data} />}
                      {offline ? null : sw ? (
                        <>
                          <span className="wk-pill warn">{sw.status === 'claimed' ? `${sw.claimantName} is taking it` : 'Offered'}</span>
                          <button className="icon-btn sm" title="Take back" onClick={() => act(`/v1/orgs/${org.id}/swaps/${sw.id}/cancel`, {}, 'It’s yours again.')}>
                            <Undo2 size={14} />
                          </button>
                        </>
                      ) : (
                        s.startAt > Date.now() && (
                          <button className="btn sm" onClick={() => offer(s)}>
                            <Repeat size={13} /> Swap
                          </button>
                        )
                      )}
                    </div>
                  );
                })}
                {x.classes.map((c) => (
                  <div key={c.id} className="wk-shift class">
                    <GraduationCap size={14} />
                    <span className="wk-shift-time">
                      {clock(c.start, org.tz)}–{clock(c.end, org.tz)}
                    </span>
                    <span className="wk-shift-what">{c.title}</span>
                    {c.location && <span className="muted">{c.location}</span>}
                    {c.meetingUrl && (
                      <a className="btn sm" href={c.meetingUrl} target="_blank" rel="noreferrer">
                        Join
                      </a>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** A shift from the saved calendar copy (what's needed to list it; no swap or note). */
function fromEvent(e: WorkEvent): Shift {
  return { id: e.id.replace(/^shift:/, ''), scheduleId: null, accountId: null, name: null, positionId: '', positionName: e.title, departmentId: null, date: e.date, blockId: null, slotKey: null, start: e.start, end: e.end, startAt: Date.parse(e.start), endAt: Date.parse(e.end), status: 'published', source: 'calendar', note: null, forced: false, swap: null };
}

function TeamSchedule({ org, onBack }: { org: Org; onBack(): void }) {
  const [start, setStart] = useState(() => {
    const t = todayIso();
    return addDays(t, -((new Date().getDay() - org.workweekStart + 7) % 7));
  });
  const from = new Date(start + 'T00:00:00').toISOString();
  const to = new Date(addDays(start, 7) + 'T00:00:00').toISOString();
  const { data, error } = useHub<{ shifts: Shift[] }>(`/v1/orgs/${org.id}/schedule?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  return (
    <div className="wk-sched">
      <div className="wk-toolbar">
        <button className="btn link sm" onClick={onBack}>
          My shifts
        </button>
        <span className="wk-spacer" />
        <button className="btn sm" onClick={() => setStart(addDays(start, -7))}>
          Earlier
        </button>
        <span className="wk-week">
          {fmtDay(days[0], { month: 'short', day: 'numeric' })} – {fmtDay(days[6], { month: 'short', day: 'numeric' })}
        </span>
        <button className="btn sm" onClick={() => setStart(addDays(start, 7))}>
          Later
        </button>
      </div>
      <Problem error={error} />
      {!data ? (
        <Loading />
      ) : (
        <div className="wk-team">
          {days.map((d) => {
            const list = data.shifts.filter((s) => s.date === d);
            return (
              <div key={d} className={`wk-team-day ${d === todayIso() ? 'today' : ''}`}>
                <div className="wk-team-head">{fmtDay(d)}</div>
                {list.length === 0 && <div className="muted af-small">No shifts</div>}
                {list.map((s) => (
                  <div key={s.id} className="wk-team-shift">
                    <span className="wk-shift-time">
                      {clock(s.start, org.tz)}–{clock(s.end, org.tz)}
                    </span>
                    <span>{s.name}</span>
                    <span className="muted">{s.positionName}</span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
export type { Member };
