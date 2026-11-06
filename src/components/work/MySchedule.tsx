// My schedule: published shifts and org class sessions by week, swaps (offer mine, take others'), and the whole
// team's schedule when the org shows it.
import { useEffect, useMemo, useState } from 'react';
import { CalendarPlus, GraduationCap, Repeat, Undo2, Users } from 'lucide-react';
import { api, WorkEvent } from '../../lib/api';
import { ask, prompt, toast } from '../../store';
import { act, clock, fmtDay, todayIso, useHub, useMyId, useWork, addDays } from './workStore';
import { Card, Empty, Loading, Problem, Seg } from './ui';
import type { Member, Org, Shift, Swap } from './types';

export function MySchedule({ org }: { org: Org }) {
  const [view, setView] = useState<'mine' | 'team'>('mine');
  const me = useMyId();
  const focus = useWork((s) => s.focus);
  const from = new Date(Date.now() - 86400_000).toISOString();
  const to = new Date(Date.now() + 70 * 86400_000).toISOString();
  const shifts = useHub<{ shifts: Shift[] }>(`/v1/orgs/${org.id}/my-shifts?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  const swaps = useHub<{ swaps: Swap[] }>(`/v1/orgs/${org.id}/swaps`);
  const [events, setEvents] = useState<WorkEvent[] | null>(null);
  const [offline, setOffline] = useState(false);
  const version = useWork((s) => s.version);
  useEffect(() => {
    api.hubOrg.events(from, to).then((r) => {
      if (r.ok) {
        setEvents(r.value.events.filter((e) => e.orgId === org.id));
        setOffline(r.value.offline);
      }
    });
  }, [org.id, version]);
  const canTeam = org.role !== 'member' || org.settings?.membersSeeSchedule !== false;

  const mine = shifts.data?.shifts ?? [];
  const classes = (events ?? []).filter((e) => e.kind === 'class');
  const byDate = useMemo(() => {
    const m = new Map<string, { shifts: Shift[]; classes: WorkEvent[] }>();
    const at = (d: string) => m.get(d) ?? m.set(d, { shifts: [], classes: [] }).get(d)!;
    for (const s of mine) at(s.date).shifts.push(s);
    for (const c of classes) at(c.date).classes.push(c);
    return [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  }, [mine, classes]);

  const open = (swaps.data?.swaps ?? []).filter((w) => w.status === 'offered' && w.shift && w.from !== me);
  const total = mine.filter((s) => s.date >= todayIso() && s.date < addDays(todayIso(), 7)).reduce((t, s) => t + (s.endAt - s.startAt) / 3600_000, 0);

  const offer = async (s: Shift) => {
    const note = await prompt('Offer this shift', 'A note for whoever takes it (optional)', '', 'For example: family trip');
    if (note === null) return;
    act(`/v1/orgs/${org.id}/shifts/${s.id}/swap`, { note: note || null }, 'Offered. It stays yours until someone takes it.');
  };
  const claim = async (w: Swap) => {
    const r = await act<{ swap: Swap }>(`/v1/orgs/${org.id}/swaps/${w.id}/claim`, {});
    if (r) toast(r.swap.status === 'approved' ? 'The shift is yours.' : 'Taken. Your manager will approve it.');
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
          title="Save as a calendar file for Outlook, Google Calendar or Apple Calendar"
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
      {offline && <p className="af-info">The Kea Hub can’t be reached, so this is the schedule Kea saved last time.</p>}
      {open.length > 0 && (
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
      <Problem error={shifts.error} retry={shifts.reload} />
      {!shifts.data ? (
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
                      {sw ? (
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
