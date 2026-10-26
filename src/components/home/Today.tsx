// The top of Home when classes are connected: missing work first (when there is any), then each class as a card (its
// picture from the class site, its colour and its grade). A card opens the class, where Study, Readings and this week's
// reading are at the top; what's next is on the calendar. Settings → Scholar → Home sets what the cards show.
import { useEffect, useState } from 'react';
import { AlertTriangle, ChevronRight, Sun } from 'lucide-react';
import { api, ScholarCourse, ScholarItem } from '../../lib/api';
import { openScholar, useScholar, type ScholarView } from '../scholar/scholarStore';
import { isMissing, useColors } from '../scholar/kinds';
import { useSetting, useThemeDark } from '../../lib/settings';
import { gradeColor } from '../../lib/themes';

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

type TodayData = { courses: ScholarCourse[]; missing: ScholarItem[]; grades: Record<string, number | null> };

/** Classes, missing work and grades for Home; null until read. */
function useToday() {
  const version = useScholar((s) => s.version);
  const [data, setData] = useState<TodayData | null>(null);
  useEffect(() => {
    let live = true;
    (async () => {
      const courses = await api.scholar.courses().catch(() => [] as ScholarCourse[]);
      if (!courses.length) return live && setData({ courses, missing: [], grades: {} });
      const now = new Date();
      const [past, grades] = await Promise.all([
        api.scholar.items({ from: iso(addDays(now, -28)), to: iso(now) }).catch(() => [] as ScholarItem[]),
        Promise.all(courses.map((c) => api.scholar.grades(c.id, c.code).catch(() => null)))
      ]);
      if (!live) return;
      setData({ courses, missing: past.filter((i) => isMissing(i)), grades: Object.fromEntries(courses.map((c, k) => [c.id, grades[k]?.final?.percent ?? null])) });
    })();
    return () => {
      live = false;
    };
  }, [version]);
  return data;
}

export function HomeToday() {
  const data = useToday();
  const dark = useThemeDark();
  const colors = useColors((data?.courses || []).map((c) => c.id));
  const showCards = useSetting<boolean>('scholar.homeClasses') !== false;
  const columns = Number(useSetting<string>('scholar.homeColumns') || 2);
  const pictures = useSetting<boolean>('scholar.homePictures') !== false;
  const showGrades = useSetting<boolean>('scholar.homeGrades') !== false;
  if (!data) return <section className="today-loading" />;
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
  return (
    <>
      {data.missing.length > 0 && (
        <section className="home-miss">
          <div className="home-miss-head">
            <AlertTriangle size={15} /> {data.missing.length} missing
          </div>
          {data.missing.map((i) => (
            <button key={i.id} className="home-miss-row" onClick={() => go({ name: 'class', courseId: i.courseId })}>
              <b>{i.courseCode}</b>
              <span>{i.title}</span>
              <span className="muted">{new Date(`${i.date}T12:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</span>
            </button>
          ))}
        </section>
      )}
      {showCards && (
        <section className="ccards" style={{ ['--cols' as any]: Math.min(4, Math.max(1, columns || 2)) }}>
          {data.courses.map((c) => {
            const grade = data.grades[c.id];
            return (
              <div key={c.id} className="ccard" style={{ ['--k' as any]: colors.course(c.id) }}>
                <button className="ccard-open" onClick={() => go({ name: 'class', courseId: c.id })} title={`Open ${c.code}`}>
                  <span className={`ccard-pic ${pictures && c.image ? '' : 'plain'}`}>
                    {pictures && c.image ? <img src={c.image} alt="" /> : <span className="ccard-mono">{c.code.replace(/\d.*$/, '')}</span>}
                  </span>
                  <span className="ccard-body">
                    <span className="ccard-code">{c.code}</span>
                    <span className="ccard-name">{c.name}</span>
                  </span>
                  {showGrades && grade != null && (
                    <span className="ccard-grade" style={{ color: gradeColor(grade, dark) }}>
                      {grade}%
                    </span>
                  )}
                </button>
              </div>
            );
          })}
        </section>
      )}
    </>
  );
}
