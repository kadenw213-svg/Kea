// The top of Home when classes are connected: what's next, what's due soon, what needs attention, and one click to
// every part of Scholar and each class. Informational at a glance; everything else is a click away.
import { useEffect, useState } from 'react';
import { AlertTriangle, BookOpen, CalendarDays, ChevronRight, Inbox, Layers, Mail, MapPin, Sun } from 'lucide-react';
import { api, ScholarCourse, ScholarItem } from '../../lib/api';
import { openScholar, useScholar, type ScholarView } from '../scholar/scholarStore';
import { isDone, isMissing, useColors } from '../scholar/kinds';
import { useThemeDark } from '../../lib/settings';
import { gradeColor } from '../../lib/themes';

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const clock = (t: string | null) => {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};
const minutes = (t: string | null) => (t ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : -1);

/** Classes, items and counts for Home; null until read, or when Scholar has no classes. */
function useToday() {
  const version = useScholar((s) => s.version);
  const inboxTick = useScholar((s) => s.inboxTick);
  const [data, setData] = useState<{ courses: ScholarCourse[]; soon: ScholarItem[]; missing: ScholarItem[]; grades: Record<string, number | null> } | null>(null);
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    let live = true;
    (async () => {
      const courses = await api.scholar.courses().catch(() => [] as ScholarCourse[]);
      if (!courses.length) return live && setData({ courses, soon: [], missing: [], grades: {} });
      const now = new Date();
      const [soon, past, grades] = await Promise.all([
        api.scholar.items({ from: iso(now), to: iso(addDays(now, 2)) }).catch(() => [] as ScholarItem[]),
        api.scholar.items({ from: iso(addDays(now, -28)), to: iso(now) }).catch(() => [] as ScholarItem[]),
        Promise.all(courses.map((c) => api.scholar.grades(c.id, c.code).catch(() => null)))
      ]);
      if (!live) return;
      setData({
        courses,
        soon: soon.filter((i) => i.type !== 'weekly_reading'),
        missing: past.filter((i) => isMissing(i)),
        grades: Object.fromEntries(courses.map((c, k) => [c.id, grades[k]?.final?.percent ?? null]))
      });
    })();
    return () => {
      live = false;
    };
  }, [version]);
  useEffect(() => {
    api.scholar
      .inbox()
      .then((l) => setUnread(l.filter((i) => !i.read).length))
      .catch(() => {});
  }, [inboxTick, version]);
  return { data, unread };
}

export function HomeToday() {
  const { data, unread } = useToday();
  const dark = useThemeDark();
  const colors = useColors((data?.courses || []).map((c) => c.id));
  if (!data) return <section className="today today-loading" />;
  const go = (view: ScholarView) => openScholar(view);
  if (!data.courses.length)
    return (
      <section className="today">
        <button className="today-setup" onClick={() => go({ name: 'week' })}>
          <Sun size={20} />
          <span>
            <b>Set up Scholar</b>
            <span className="muted">Connect your classes: what's due, your readings and textbooks, and studying, kept up to date for you.</span>
          </span>
          <ChevronRight size={18} />
        </button>
      </section>
    );
  const t = iso(new Date());
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const next = data.soon.find((i) => i.date === t && i.start && minutes(i.start) > nowMin);
  const dueToday = data.soon.filter((i) => i.date === t && i.due && !isDone(i));
  const upcoming = data.soon.filter((i) => (i.due || i.type === 'exam' || i.type === 'quiz') && !isDone(i)).slice(0, 5);
  const day = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  return (
    <section className="today">
      <div className="today-head">
        <div>
          <span className="today-day">{day}</span>
          <h2>
            {next ? (
              <>
                Next: {next.courseCode} {next.title.length > 40 ? next.type : next.title} at {clock(next.start)}
                {next.location && next.location !== 'Online' && (
                  <span className="today-where">
                    <MapPin size={14} /> {next.location.split(',').pop()!.trim()}
                  </span>
                )}
              </>
            ) : (
              'Nothing else scheduled today'
            )}
          </h2>
        </div>
        <div className="today-stats">
          <button className="today-stat" onClick={() => go({ name: 'week' })}>
            <b>{dueToday.length}</b>
            <span>due today</span>
          </button>
          <button className={`today-stat ${data.missing.length ? 'warn' : ''}`} onClick={() => go({ name: 'week' })}>
            <b>{data.missing.length}</b>
            <span>missing</span>
          </button>
          <button className="today-stat" onClick={() => go({ name: 'inbox' })}>
            <b>{unread}</b>
            <span>unread</span>
          </button>
        </div>
      </div>

      <div className="today-body">
        <div className="today-list">
          <div className="today-label">Coming up</div>
          {upcoming.length ? (
            upcoming.map((i) => (
              <button key={i.id} className="today-item" onClick={() => go({ name: 'week' })} style={{ ['--k' as any]: colors.item(i) }}>
                <span className="today-item-title">{i.title}</span>
                <span className="muted">
                  {i.courseCode} · {i.date === t ? 'today' : new Date(`${i.date}T12:00`).toLocaleDateString([], { weekday: 'short' })}
                  {i.due ? ` ${clock(i.due)}` : ''}
                </span>
              </button>
            ))
          ) : (
            <span className="muted today-none">Nothing due in the next two days.</span>
          )}
          {data.missing.length > 0 && (
            <button className="today-missing" onClick={() => go({ name: 'week' })}>
              <AlertTriangle size={14} /> {data.missing.length} missing: {data.missing[0].title}
              {data.missing.length > 1 ? ` and ${data.missing.length - 1} more` : ''}
            </button>
          )}
        </div>

        <div className="today-side">
          <div className="today-label">Go to</div>
          <div className="today-nav">
            <button onClick={() => go({ name: 'week' })}>
              <Sun size={16} /> This week
            </button>
            <button onClick={() => go({ name: 'calendar' })}>
              <CalendarDays size={16} /> Calendar
            </button>
            <button onClick={() => go({ name: 'resources' })}>
              <Layers size={16} /> Study
            </button>
            <button onClick={() => go({ name: 'library' })}>
              <BookOpen size={16} /> Library
            </button>
            <button onClick={() => go({ name: 'inbox' })}>
              <Inbox size={16} /> Inbox{unread ? <em>{unread}</em> : null}
            </button>
            <button onClick={() => go({ name: 'messages' })}>
              <Mail size={16} /> Messages
            </button>
          </div>
          <div className="today-label">Classes</div>
          <div className="today-classes">
            {data.courses.map((c) => (
              <button key={c.id} onClick={() => go({ name: 'class', courseId: c.id })} title={c.name}>
                <i style={{ background: colors.course(c.id) }} />
                <b>{c.code}</b>
                {data.grades[c.id] != null && <span style={{ color: gradeColor(data.grades[c.id], dark) }}>{data.grades[c.id]}%</span>}
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
