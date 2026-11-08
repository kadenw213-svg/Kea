// The to-do box: everything waiting on you across your organizations, most urgent first, each with its countdown.
import { useEffect, useState } from 'react';
import { AlarmClock, BadgeAlert, CalendarClock, CheckCircle2, ClipboardList, GraduationCap, Repeat, ShieldAlert, Wallet, FileSignature, Inbox } from 'lucide-react';
import { api } from '../../lib/api';
import { act, clock, countdown, fmtDay, useHub, useWork, Tab } from './workStore';
import type { TodoItem } from './types';

const ICON: Record<string, JSX.Element> = {
  availability: <ClipboardList size={16} />,
  cert: <BadgeAlert size={16} />,
  class: <GraduationCap size={16} />,
  swap: <Repeat size={16} />,
  ack: <FileSignature size={16} />,
  missing: <ClipboardList size={16} />,
  approvals: <Inbox size={16} />,
  budget: <Wallet size={16} />,
  drafts: <CalendarClock size={16} />,
  staffcerts: <ShieldAlert size={16} />
};

/** Where an item's one tap goes. */
function open(it: TodoItem) {
  const go = useWork.getState().go;
  const a = it.action;
  const to = (tab: Tab, focus: any = null) => go(it.orgId, tab, focus);
  switch (a.type) {
    case 'form':
      return to('availability', { formId: a.formId });
    case 'formPeople':
      return to('forms', { formId: a.formId, view: 'people' });
    case 'cert':
    case 'class':
      return to('certs');
    case 'swap':
      return to('schedule', { swapId: a.swapId });
    case 'ack':
      return to('org', { view: 'policies' });
    case 'approvals':
      return to('people', { view: 'approvals' });
    case 'schedule':
      return to('scheduling', { scheduleId: a.scheduleId });
    case 'budgets':
      return to('budgets');
    case 'certs':
      return to('training');
  }
}

function tone(it: TodoItem) {
  if (it.overdue || it.stage === 'expired') return 'bad';
  if (it.stage === '7' || (it.msLeft != null && it.msLeft < 2 * 86400_000)) return 'bad';
  if (it.stage === '30' || it.stage === 'missing' || (it.msLeft != null && it.msLeft < 7 * 86400_000) || it.urgency >= 2) return 'warn';
  return 'calm';
}

function when(it: TodoItem) {
  if (it.kind === 'cert') {
    if (it.stage === 'expired') return it.detail;
    if (it.stage === 'missing') return 'Needed';
    return it.daysLeft != null ? `${it.daysLeft} ${it.daysLeft === 1 ? 'day' : 'days'} left` : '';
  }
  if (it.kind === 'class' && it.nextSession) return countdown(it.nextSession.startAt - Date.now(), { due: 'Starts' });
  if (it.kind === 'swap' && it.msLeft != null) return countdown(it.msLeft, { due: 'Shift' });
  if (it.overdue && it.msLeft != null) return countdown(it.msLeft, { late: 'late' });
  return countdown(it.msLeft);
}

/** The Hub writes dates as 2026-12-01; show them the way people read them. */
function friendly(it: TodoItem) {
  if (it.kind === 'class' && it.nextSession) return `Next session ${fmtDay(it.nextSession.start.slice(0, 10))}, ${clock(it.nextSession.start)}${it.nextSession.location ? ` · ${it.nextSession.location}` : ''}`;
  return dates(it.detail);
}
function dates(text: string) {
  return text.replace(/\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?/g, (d) => fmtDay(d.slice(0, 10), { weekday: 'short', month: 'short', day: 'numeric' }));
}

export function TodoBox({ orgId }: { orgId?: string | null }) {
  const { data, error, reload } = useHub<{ now: number; items: TodoItem[]; snoozed: TodoItem[] }>('/v1/todo');
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [at, setAt] = useState<number | null>(null);
  useEffect(() => {
    if (data && !error) setAt(Date.now());
  }, [data, error]);
  // Countdowns stay current while the screen is open; the list itself is fetched again every few minutes while it
  // shows, when Kea's window comes back to the front, and when an account notification arrives (approvals).
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 60_000);
    const again = setInterval(() => document.visibilityState === 'visible' && reload(), 3 * 60_000);
    const onFocus = () => reload();
    window.addEventListener('focus', onFocus);
    const off = api.hub.onNotifications(() => reload());
    return () => (clearInterval(t), clearInterval(again), window.removeEventListener('focus', onFocus), off());
  }, []);
  if (error && !data)
    return (
      <section className="wk-todo">
        <header className="wk-todo-head">
          <h2>To do</h2>
        </header>
        <div className="wk-todo-clear muted">Can’t reach your organizations right now. Your to-do list comes back when Kea can.</div>
      </section>
    );
  if (!data) return <div className="wk-todo loading" />;
  const skew = Date.now() - data.now;
  const fix = (it: TodoItem) => ({ ...it, msLeft: it.dueAt == null ? null : it.dueAt - (Date.now() - skew) });
  const items = data.items.map(fix);
  const multi = new Set(items.map((i) => i.orgId)).size > 1;
  return (
    <section className="wk-todo">
      <header className="wk-todo-head">
        <h2>To do</h2>
        <span className="wk-todo-count">{items.length ? `${items.length} ${items.length === 1 ? 'thing' : 'things'}` : ''}</span>
        {error && at && <span className="muted af-small">Offline · as of {clock(at)}</span>}
        {data.snoozed.length > 0 && (
          <button className="btn link sm" onClick={() => setShowSnoozed(!showSnoozed)}>
            {showSnoozed ? 'Hide snoozed' : `Snoozed (${data.snoozed.length})`}
          </button>
        )}
      </header>
      {items.length === 0 ? (
        <div className="wk-todo-clear">
          <CheckCircle2 size={18} /> All caught up.
        </div>
      ) : (
        <ul className="wk-todo-list">
          {items.map((it) => (
            <li key={it.key} className={`wk-todo-item ${tone(it)} ${orgId && it.orgId !== orgId ? 'other' : ''}`}>
              <button className="wk-todo-main" onClick={() => open(it)}>
                <span className="wk-todo-icon">{ICON[it.kind] ?? <ClipboardList size={16} />}</span>
                <span className="wk-todo-text">
                  <span className="wk-todo-title">{dates(it.title)}</span>
                  <span className="wk-todo-detail">
                    {multi && <span className="wk-todo-org">{it.orgName} · </span>}
                    {it.kind === 'cert' && it.stage === 'expired' ? 'Recertify to get shifts again' : friendly(it)}
                  </span>
                </span>
                <span className="wk-todo-when">{when(it)}</span>
              </button>
              <button className="icon-btn sm wk-todo-snooze" title="Snooze for a day" onClick={() => act('/v1/todo/snooze', { key: it.key, hours: 24 }, 'Snoozed until tomorrow.')}>
                <AlarmClock size={15} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {showSnoozed && (
        <ul className="wk-todo-list snoozed">
          {data.snoozed.map((it) => (
            <li key={it.key} className="wk-todo-item calm">
              <span className="wk-todo-main static">
                <span className="wk-todo-icon">{ICON[it.kind]}</span>
                <span className="wk-todo-text">
                  <span className="wk-todo-title">{it.title}</span>
                  <span className="wk-todo-detail">
                    Back {new Date(it.snoozedUntil!).toLocaleDateString(undefined, { weekday: 'short' })} {clock(it.snoozedUntil!)}
                  </span>
                </span>
              </span>
              <button className="btn sm" onClick={() => act('/v1/todo/snooze', { key: it.key, hours: 0 })}>
                Show now
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
