// The top of Home when classes are connected: what's next, what's due soon and what needs attention, then each class
// as a card (its picture from the class site, its colour, its grade and this week's reading, side by side). A card
// opens the class, where Study and Readings are at the top. Settings → Scholar → Home sets what the cards show.
import { useEffect, useState } from 'react';
import { AlertTriangle, BookOpen, CalendarDays, ChevronRight, Inbox, Library, Mail, MapPin, Sun } from 'lucide-react';
import { api, ScholarCourse, ScholarItem, ScholarReading } from '../../lib/api';
import { openPaths } from '../../lib/open';
import { setPdfTarget } from '../../lib/pdfTarget';
import { openScholar, useScholar, type ScholarView } from '../scholar/scholarStore';
import { isDone, isMissing, useColors } from '../scholar/kinds';
import { useSetting, useThemeDark } from '../../lib/settings';
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

type TodayData = { courses: ScholarCourse[]; soon: ScholarItem[]; week: ScholarItem[]; missing: ScholarItem[]; grades: Record<string, number | null> };

/** Classes, items and counts for Home; null until read. */
function useToday() {
  const version = useScholar((s) => s.version);
  const inboxTick = useScholar((s) => s.inboxTick);
  const [data, setData] = useState<TodayData | null>(null);
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    let live = true;
    (async () => {
      const courses = await api.scholar.courses().catch(() => [] as ScholarCourse[]);
      if (!courses.length) return live && setData({ courses, soon: [], week: [], missing: [], grades: {} });
      const now = new Date();
      const t = iso(now);
      const [around, past, grades] = await Promise.all([
        api.scholar.items({ from: iso(addDays(now, -7)), to: iso(addDays(now, 2)) }).catch(() => [] as ScholarItem[]),
        api.scholar.items({ from: iso(addDays(now, -28)), to: t }).catch(() => [] as ScholarItem[]),
        Promise.all(courses.map((c) => api.scholar.grades(c.id, c.code).catch(() => null)))
      ]);
      if (!live) return;
      setData({
        courses,
        soon: around.filter((i) => i.type !== 'weekly_reading' && i.date >= t),
        week: around.filter((i) => i.type === 'weekly_reading' && i.date <= t && (i.dateEnd || i.date) >= t),
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

async function read(r: ScholarReading) {
  if (!r.pdf) return;
  setPdfTarget(r.pdf.file, r.chapter);
  await openPaths([r.pdf.file]);
}

export function HomeToday() {
  const { data, unread } = useToday();
  const dark = useThemeDark();
  const colors = useColors((data?.courses || []).map((c) => c.id));
  const showCards = useSetting<boolean>('scholar.homeClasses') !== false;
  const columns = Number(useSetting<string>('scholar.homeColumns') || 2);
  const pictures = useSetting<boolean>('scholar.homePictures') !== false;
  const weekReading = useSetting<boolean>('scholar.homeWeek') !== false;
  const showGrades = useSetting<boolean>('scholar.homeGrades') !== false;
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
    <>
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
              <button onClick={() => go({ name: 'inbox' })}>
                <Inbox size={16} /> Inbox{unread ? <em>{unread}</em> : null}
              </button>
              <button onClick={() => go({ name: 'messages' })}>
                <Mail size={16} /> Messages
              </button>
              <button onClick={() => go({ name: 'library' })}>
                <Library size={16} /> Library
              </button>
            </div>
          </div>
        </div>
      </section>

      {showCards && (
        <section className="ccards" style={{ ['--cols' as any]: Math.min(4, Math.max(1, columns || 2)) }}>
          {data.courses.map((c) => {
            const k = colors.course(c.id);
            const week = data.week.find((b) => b.courseId === c.id);
            const reads = week?.readings || [];
            const grade = data.grades[c.id];
            return (
              <div key={c.id} className="ccard" style={{ ['--k' as any]: k }}>
                <button className="ccard-open" onClick={() => go({ name: 'class', courseId: c.id })} title={`Open ${c.code}`}>
                  <span className={`ccard-pic ${pictures && c.image ? '' : 'plain'}`}>
                    {pictures && c.image ? <img src={c.image} alt="" /> : <span className="ccard-mono">{c.code.replace(/\d.*$/, '')}</span>}
                  </span>
                  <span className="ccard-body">
                    <span className="ccard-code">{c.code}</span>
                    <span className="ccard-name">{c.name}</span>
                    {c.next && (
                      <span className="ccard-next muted">
                        Next: {c.next.title}
                        {c.next.date === t ? ' · today' : ` · ${new Date(`${c.next.date}T12:00`).toLocaleDateString([], { weekday: 'short' })}`}
                      </span>
                    )}
                  </span>
                  {showGrades && grade != null && (
                    <span className="ccard-grade" style={{ color: gradeColor(grade, dark) }}>
                      {grade}%
                    </span>
                  )}
                </button>
                {weekReading && reads.length > 0 && (
                  <div className="ccard-reads">
                    <span className="ccard-reads-label">This week</span>
                    {reads.map((r) => (
                      <button key={r.chapter} className="ccard-read" disabled={!r.pdf} onClick={() => read(r)} title={`${r.chapter}${r.title ? `: ${r.title}` : ''}${r.pdf ? '' : ' (being written)'}`}>
                        <BookOpen size={13} /> {r.chapter.replace(/^Chapter /, 'Ch ')}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </section>
      )}
    </>
  );
}
