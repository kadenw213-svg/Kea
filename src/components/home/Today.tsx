// The top of Home when School is on: one Scholar button that opens This week. Classes, grades and what's due live in
// Scholar itself; Home only says how much is waiting today.
import { useEffect, useState } from 'react';
import { AlertTriangle, ChevronRight, GraduationCap, Sun } from 'lucide-react';
import { api, ScholarItem } from '../../lib/api';
import { openScholar, useScholar } from '../scholar/scholarStore';
import { isDone, isMissing } from '../scholar/kinds';

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

type TodayData = { classes: number; missing: number; dueToday: number };

/** How many classes, missing items and items due today; null until read. */
function useToday() {
  const version = useScholar((s) => s.version);
  const [data, setData] = useState<TodayData | null>(null);
  useEffect(() => {
    let live = true;
    (async () => {
      const courses = await api.scholar.courses().catch(() => []);
      if (!courses.length) return live && setData({ classes: 0, missing: 0, dueToday: 0 });
      const now = new Date();
      const items = await api.scholar.items({ from: iso(addDays(now, -28)), to: iso(now) }).catch(() => [] as ScholarItem[]);
      if (!live) return;
      const t = iso(now);
      setData({
        classes: courses.length,
        missing: items.filter((i) => isMissing(i)).length,
        dueToday: items.filter((i) => i.date === t && i.type !== 'weekly_reading' && i.type !== 'lecture' && !isDone(i) && !isMissing(i)).length
      });
    })();
    return () => {
      live = false;
    };
  }, [version]);
  return data;
}

export function HomeToday() {
  const data = useToday();
  if (!data) return <section className="today-loading" />;
  const go = () => openScholar({ name: 'week' });
  if (!data.classes)
    return (
      <section className="today">
        <button className="today-setup" onClick={go}>
          <Sun size={20} />
          <span>
            <b>Set up Scholar</b>
            <span className="muted">Connect your classes: what's due, your readings and textbooks, and studying, kept up to date for you.</span>
          </span>
          <ChevronRight size={18} />
        </button>
      </section>
    );
  const parts = [data.dueToday ? `${data.dueToday} due today` : 'Nothing due today'];
  return (
    <section className="today">
      <button className="today-setup" onClick={go}>
        <GraduationCap size={20} />
        <span>
          <b>Scholar</b>
          <span className="muted">
            This week · {parts.join(' · ')}
            {data.missing > 0 && (
              <span className="today-miss">
                {' · '}
                <AlertTriangle size={12} /> {data.missing} missing
              </span>
            )}
          </span>
        </span>
        <ChevronRight size={18} />
      </button>
    </section>
  );
}
