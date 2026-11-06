// The top of Home: what matters today, the way a school or workplace app shows it. "Coming up" (what's due and class
// sessions from Scholar), "Classes" (Scholar's classes and Kea Hub classes) and, with Work mode on, "Work" (the to-do
// box's most urgent items and the next shift). Each card only appears when its part of Kea is on; a Personal profile
// shows no Kea Hub classes.
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, BriefcaseBusiness, CalendarClock, CalendarDays, ChevronRight, Clock, GraduationCap, Plus, Users } from 'lucide-react';
import { api, ScholarCourse, ScholarItem, WorkEvent } from '../../lib/api';
import { openScholar, useScholar } from '../scholar/scholarStore';
import { isDone, isMissing, useColors, TODO } from '../scholar/kinds';
import { HubClass, useHubClasses } from '../../lib/hubClasses';
import { isPersonalProfile, openWork, useKeaModes, workAvailable } from '../../lib/modes';
import { useSetting } from '../../lib/settings';

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const dayOf = (s: string) => new Date(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));

/** "Today", "Tomorrow", "Mon", or "Nov 18". */
function dayLabel(date: string, now = new Date()) {
  const days = Math.round((dayOf(date).getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  if (days > 1 && days < 7) return dayOf(date).toLocaleDateString(undefined, { weekday: 'short' });
  return dayOf(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function clock(hhmm: string | null) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
const MEETING = new Set(['lecture', 'lab', 'recitation', 'seminar', 'class_session']);

// ---------- Data ----------
interface SchoolData {
  courses: ScholarCourse[];
  upcoming: ScholarItem[];
  missing: number;
}
function useSchool(on: boolean, days: number) {
  const version = useScholar((s) => s.version);
  const [data, setData] = useState<SchoolData | null>(null);
  useEffect(() => {
    if (!on) return setData(null);
    let live = true;
    (async () => {
      const courses = await api.scholar.courses().catch(() => [] as ScholarCourse[]);
      if (!courses.length) return live && setData({ courses, upcoming: [], missing: 0 });
      const now = new Date();
      const items = await api.scholar.items({ from: iso(addDays(now, -28)), to: iso(addDays(now, Math.max(0, days - 1))) }).catch(() => [] as ScholarItem[]);
      if (!live) return;
      const today = iso(now);
      const nowHm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
      const upcoming = items
        .filter((i) => i.date >= today && !isDone(i) && (TODO.has(i.type) || MEETING.has(i.type)) && i.type !== 'weekly_reading')
        // A class that already ended today is past.
        .filter((i) => !(MEETING.has(i.type) && i.date === today && (i.end || i.start || '99') < nowHm))
        .sort((a, b) => (a.date + (a.due || a.start || '23:59')).localeCompare(b.date + (b.due || b.start || '23:59')));
      setData({ courses, upcoming, missing: items.filter((i) => isMissing(i)).length });
    })();
    return () => {
      live = false;
    };
  }, [on, days, version]);
  return data;
}

function usePersonalProfile(on: boolean) {
  const [personal, setPersonal] = useState(false);
  useEffect(() => {
    if (!on) return;
    api.scholar
      .profiles()
      .then((p) => setPersonal(isPersonalProfile(p.list.find((x) => x.id === p.active))))
      .catch(() => {});
  }, [on]);
  return personal;
}

interface TodoItem {
  key: string;
  title: string;
  orgName: string;
  overdue: boolean;
  msLeft: number | null;
}
function useWorkData(on: boolean) {
  const [data, setData] = useState<{ todo: TodoItem[]; next: WorkEvent | null; offline: boolean } | null>(null);
  useEffect(() => {
    if (!on) return setData(null);
    let live = true;
    (async () => {
      const now = new Date();
      const [todo, ev] = await Promise.all([api.hubOrg.call<{ items: TodoItem[] }>('GET', '/v1/todo').catch(() => null), api.hubOrg.events(now.toISOString(), addDays(now, 21).toISOString()).catch(() => null)]);
      if (!live) return;
      const events = ev && ev.ok ? ev.value.events : [];
      setData({
        todo: todo && todo.ok ? todo.value.items : [],
        next: events.filter((e) => e.kind === 'shift' && e.end > now.toISOString()).sort((a, b) => (a.start < b.start ? -1 : 1))[0] || null,
        offline: !(todo && todo.ok) && (todo?.ok === false && todo.status === 0),
      });
    })();
    return () => {
      live = false;
    };
  }, [on]);
  return data;
}

// ---------- Cards ----------
function Card({ icon, title, action, onAction, children, className = '' }: { icon: JSX.Element; title: string; action?: string; onAction?: () => void; children: React.ReactNode; className?: string }) {
  return (
    <section className={`dcard ${className}`}>
      <header className="dcard-head">
        <span className="dcard-icon">{icon}</span>
        <h3>{title}</h3>
        {action && (
          <button className="dcard-link" onClick={onAction}>
            {action} <ChevronRight size={14} />
          </button>
        )}
      </header>
      {children}
    </section>
  );
}

function ComingUp({ data, max }: { data: SchoolData; max: number }) {
  const colors = useColors(data.courses.map((c) => c.id));
  const list = data.upcoming.slice(0, max);
  const code = (id: string) => data.courses.find((c) => c.id === id)?.code || '';
  return (
    <Card icon={<CalendarClock size={16} />} title="Coming up" action="Calendar" onAction={() => openScholar({ name: 'calendar' })} className="dcard-wide">
      {data.missing > 0 && (
        <button className="dmissing" onClick={() => openScholar({ name: 'calendar' })}>
          <AlertTriangle size={14} /> {data.missing} missing assignment{data.missing === 1 ? '' : 's'}
        </button>
      )}
      {list.length ? (
        <ul className="dlist">
          {list.map((it) => (
            <li key={it.id}>
              <button className="drow" onClick={() => openScholar({ name: 'class', courseId: it.courseId })}>
                <span className={`dday ${it.date === iso(new Date()) ? 'is-today' : ''}`}>{dayLabel(it.date)}</span>
                <span className="ddot" style={{ background: colors.item(it) }} />
                <span className="dmain">
                  <span className="dtitle">{it.title}</span>
                  <span className="dsub">
                    {code(it.courseId)}
                    {MEETING.has(it.type) ? (it.start ? ` · ${clock(it.start)}` : '') : it.due ? ` · due ${clock(it.due)}` : ''}
                    {MEETING.has(it.type) && it.location ? ` · ${it.location}` : ''}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="dempty">Nothing due{data.upcoming.length ? '' : ' in the next few days'}. You’re all caught up.</div>
      )}
      {data.upcoming.length > list.length && (
        <button className="dmore" onClick={() => openScholar({ name: 'calendar' })}>
          {data.upcoming.length - list.length} more this week
        </button>
      )}
    </Card>
  );
}

function Classes({ courses, hubList: shownHub }: { courses: ScholarCourse[]; hubList: HubClass[] }) {
  const colors = useColors(courses.map((c) => c.id));
  return (
    <Card icon={<GraduationCap size={16} />} title="Classes" action="All classes" onAction={() => openScholar({ name: 'calendar' })}>
      <ul className="dlist">
        {courses.slice(0, 6).map((c) => (
          <li key={c.id}>
            <button className="drow" onClick={() => openScholar({ name: 'class', courseId: c.id })}>
              <span className="dswatch" style={{ background: colors.course(c.id) }}>
                {c.image ? <img src={c.image} alt="" /> : null}
              </span>
              <span className="dmain">
                <span className="dtitle">{c.code}</span>
                <span className="dsub">{c.name}</span>
              </span>
              {c.dueThisWeek > 0 && <span className="dbadge">{c.dueThisWeek} due</span>}
            </button>
          </li>
        ))}
        {shownHub.slice(0, 4).map((c) => (
          <li key={c.id}>
            <button className="drow" onClick={() => openScholar({ name: 'hub', classId: c.id })}>
              <span className="dswatch hub">
                <Users size={14} />
              </span>
              <span className="dmain">
                <span className="dtitle">{c.title}</span>
                <span className="dsub">
                  Kea Hub · {c.role === 'instructor' ? 'You teach' : c.role === 'ta' ? 'Assistant' : `${c.members} member${c.members === 1 ? '' : 's'}`}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function shiftWhen(e: WorkEvent) {
  const s = new Date(e.start);
  const end = new Date(e.end);
  const t = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${dayLabel(iso(s))} · ${t(s)}–${t(end)}`;
}
function left(ms: number | null, overdue: boolean) {
  if (ms == null) return '';
  const d = Math.abs(ms) / 86400_000;
  const txt = d >= 1 ? `${Math.round(d)} day${Math.round(d) === 1 ? '' : 's'}` : `${Math.max(1, Math.round(Math.abs(ms) / 3600_000))} h`;
  return overdue || ms < 0 ? `${txt} late` : `${txt} left`;
}

function Work() {
  const data = useWorkData(true);
  if (!data) return null;
  if (data.offline && !data.next && !data.todo.length)
    return (
      <Card icon={<BriefcaseBusiness size={16} />} title="Work" action="Open Work" onAction={openWork}>
        <div className="dempty">Can’t reach the Kea Hub right now. Your shifts show here when it’s back.</div>
      </Card>
    );
  return (
    <Card icon={<BriefcaseBusiness size={16} />} title="Work" action="Open Work" onAction={openWork}>
      {data.next ? (
        <button className="dshift" onClick={openWork}>
          <Clock size={15} />
          <span className="dmain">
            <span className="dtitle">Next shift: {data.next.title}</span>
            <span className="dsub">
              {shiftWhen(data.next)}
              {data.next.location ? ` · ${data.next.location}` : ''} · {data.next.orgName}
            </span>
          </span>
        </button>
      ) : (
        <div className="dempty">No shifts in the next three weeks.</div>
      )}
      {data.todo.length > 0 ? (
        <ul className="dlist">
          {data.todo.slice(0, 4).map((t) => (
            <li key={t.key}>
              <button className="drow" onClick={openWork}>
                <span className={`ddot ${t.overdue ? 'bad' : ''}`} />
                <span className="dmain">
                  <span className="dtitle">{t.title}</span>
                  <span className="dsub">{t.orgName}</span>
                </span>
                {t.msLeft != null && <span className={`dbadge ${t.overdue || t.msLeft < 2 * 86400_000 ? 'bad' : ''}`}>{left(t.msLeft, t.overdue)}</span>}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="dempty">{data.offline ? 'Can’t reach the Kea Hub right now.' : 'Nothing waiting on you.'}</div>
      )}
    </Card>
  );
}

/** Greeting, date and the cards. Returns null when there's nothing to show (School and Work both off). */
export function Dashboard({ showSchool }: { showSchool: boolean }) {
  const modes = useKeaModes();
  const showToday = useSetting<boolean>('home.showToday') !== false;
  const showClasses = useSetting<boolean>('home.showClasses') !== false;
  const showWork = useSetting<boolean>('home.showWork') !== false && modes.work && workAvailable;
  const hubSetting = useSetting<boolean>('home.showHubClasses') !== false;
  const days = Number(useSetting('home.todayDays')) || 7;
  const max = Number(useSetting('home.todayMax')) || 6;
  const school = useSchool(showSchool && (showToday || showClasses), days);
  const personal = usePersonalProfile(showSchool);
  // Kea Hub classes belong to School mode; a Personal profile never shows them.
  const hub = hubSetting && showSchool && modes.school && !personal;
  const hubAll = useHubClasses((s) => s.list);
  const hubLoaded = useHubClasses((s) => s.loaded);
  useEffect(() => {
    if (hub && !hubLoaded) useHubClasses.getState().load();
  }, [hub, hubLoaded]);
  const hubList = hub ? hubAll.filter((c) => c.status === 'active') : [];

  const cards = useMemo(() => {
    const out: JSX.Element[] = [];
    if (showSchool && school && !school.courses.length && showToday)
      out.push(
        <Card key="setup" icon={<CalendarDays size={16} />} title="Your classes" className="dcard-wide">
          <button className="dsetup" onClick={() => openScholar({ name: 'add' })}>
            <Plus size={16} />
            <span className="dmain">
              <span className="dtitle">Add your classes</span>
              <span className="dsub">What’s due, your readings and textbooks, and studying, kept up to date for you.</span>
            </span>
            <ChevronRight size={16} />
          </button>
        </Card>
      );
    if (showSchool && school && school.courses.length && showToday) out.push(<ComingUp key="up" data={school} max={max} />);
    return out;
  }, [showSchool, school, showToday, max]);

  const side: JSX.Element[] = [];
  if (showSchool && showClasses && (school?.courses.length || hubList.length)) side.push(<Classes key="classes" courses={school?.courses || []} hubList={hubList} />);
  if (showWork) side.push(<Work key="work" />);
  if (!cards.length && !side.length) return null;
  return (
    <div className={`dash ${cards.length && side.length ? 'two' : ''}`}>
      {cards.length > 0 && <div className="dash-main">{cards}</div>}
      {side.length > 0 && <div className="dash-side">{side}</div>}
    </div>
  );
}
