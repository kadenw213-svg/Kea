import { useEffect, useMemo, useState } from 'react';
import {
  CalendarDays,
  GraduationCap,
  Library,
  Plus,
  Sun,
  ChevronLeft,
  ChevronRight,
  BookOpen,
  ExternalLink,
  CheckCircle2,
  Circle,
  X,
  FileText,
  Lock,
  FolderInput,
  ChevronDown
} from 'lucide-react';
import { api, ProfileList, ScholarCourse, ScholarCourseDetail, ScholarItem, ScholarReading } from '../../lib/api';
import { openPaths } from '../../lib/open';
import { setPdfTarget } from '../../lib/pdfTarget';
import { toast, prompt } from '../../store';
import { useScholar, reloadScholar, ScholarView } from './scholarStore';
import { MenuButton } from '../Popover';
import '../../styles/scholar.css';

// ---------- Dates ----------
const pad = (n: number) => String(n).padStart(2, '0');
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const today = () => iso(new Date());
const dayName = (s: string) => {
  const d = parse(s);
  const t = today();
  if (s === t) return 'Today';
  if (s === iso(addDays(new Date(), 1))) return 'Tomorrow';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
};
const shortDate = (s: string) => parse(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const clock = (t: string | null) => {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
};

// ---------- Kinds of item ----------
const TYPE_LABEL: Record<string, string> = {
  lecture: 'Lecture',
  lab: 'Lab',
  recitation: 'Recitation',
  seminar: 'Seminar',
  exam: 'Exam',
  final_exam: 'Final exam',
  lab_practical: 'Lab practical',
  quiz: 'Quiz',
  assignment: 'Assignment',
  discussion: 'Discussion',
  project: 'Project',
  presentation: 'Presentation',
  paper: 'Paper',
  draft: 'Draft',
  peer_review: 'Peer review',
  lab_handout: 'Lab handout',
  pre_lab_quiz: 'Pre-lab quiz',
  administrative_deadline: 'Deadline',
  break: 'Break',
  no_class: 'No class',
  reading: 'Reading',
  other_deadline: 'To do',
  weekly_reading: 'This week'
};
/** Things to do (can be checked off), as opposed to class meetings and dates to know. */
const TODO = new Set(['exam', 'final_exam', 'lab_practical', 'quiz', 'assignment', 'discussion', 'project', 'presentation', 'paper', 'draft', 'peer_review', 'pre_lab_quiz', 'other_deadline', 'reading', 'lab_handout']);
const TEST = new Set(['exam', 'final_exam', 'lab_practical', 'quiz']);

const COLORS = ['#8ab4f8', '#81c995', '#fcad70', '#c58af9', '#f28b82', '#78d9ec', '#fdd663', '#ff8bcb'];

async function openReading(r: ScholarReading) {
  if (!r.pdf) return;
  setPdfTarget(r.pdf.file, r.chapter);
  await openPaths([r.pdf.file]);
}

// ---------- The screen ----------
export function ScholarScreen() {
  const { view, version, set } = useScholar();
  const [profiles, setProfiles] = useState<ProfileList | null>(null);
  const [hasData, setHasData] = useState<boolean | null>(null);
  const [courses, setCourses] = useState<ScholarCourse[]>([]);
  const [item, setItem] = useState<ScholarItem | null>(null);

  useEffect(() => api.scholar.onChanged(() => reloadScholar()), []);
  useEffect(() => {
    let live = true;
    (async () => {
      const [p, st, cs] = await Promise.all([api.scholar.profiles(), api.scholar.status(), api.scholar.courses()]);
      if (!live) return;
      setProfiles(p);
      setHasData(st.hasData);
      setCourses(cs);
    })().catch((err) => toast(`Couldn't load your classes: ${err.message}`, 'error'));
    return () => {
      live = false;
    };
  }, [version]);

  const color = useMemo(() => {
    const m = new Map<string, string>();
    courses.forEach((c, i) => m.set(c.id, COLORS[i % COLORS.length]));
    return (courseId: string) => m.get(courseId) || '#9aa0a8';
  }, [courses]);

  const go = (v: ScholarView) => (set({ view: v }), setItem(null));
  const toggleDone = async (it: ScholarItem) => {
    await api.scholar.setDone(it.id, !it.done);
    if (item?.id === it.id) setItem({ ...it, done: it.done ? null : new Date().toISOString() });
    reloadScholar();
  };
  const ctx: Ctx = { color, open: setItem, toggleDone, courses, go };

  const switchProfile = async (id: string) => {
    await api.scholar.selectProfile(id);
    go({ name: 'week' });
    reloadScholar();
  };
  const newProfile = async () => {
    const name = await prompt('New profile', 'A separate set of classes, for example "Personal" or a second school.', '', 'Name');
    if (!name?.trim()) return;
    await api.scholar.createProfile(name.trim());
    go({ name: 'add' });
    reloadScholar();
  };
  const activeProfile = profiles?.list.find((p) => p.id === profiles.active);
  const main =
    hasData === null ? (
      <div className="center-fill">
        <div className="spinner" />
      </div>
    ) : !hasData || view.name === 'add' ? (
      <AddClass first={!hasData} />
    ) : view.name === 'calendar' ? (
      <CalendarView ctx={ctx} />
    ) : view.name === 'class' ? (
      <ClassView ctx={ctx} courseId={view.courseId} />
    ) : view.name === 'library' ? (
      <LibraryView />
    ) : (
      <WeekView ctx={ctx} />
    );

  return (
    <div className="scholar">
      <nav className="sch-nav">
        <MenuButton
          button={() => (
            <button className="sch-profile" title="Switch profile">
              <span className="sch-avatar">{(activeProfile?.name || 'S')[0]}</span>
              <span className="sch-profile-name">{activeProfile?.name || 'School'}</span>
              <ChevronDown size={14} />
            </button>
          )}
        >
          {(close: () => void) => (
            <>
              {profiles?.list.map((p) => (
                <button key={p.id} className="menu-item" onClick={() => (close(), switchProfile(p.id))}>
                  {p.id === profiles.active ? <CheckCircle2 size={15} /> : <Circle size={15} />} {p.name}
                </button>
              ))}
              <div className="menu-sep" />
              <button className="menu-item" onClick={() => (close(), newProfile())}>
                <Plus size={15} /> New profile…
              </button>
            </>
          )}
        </MenuButton>

        <button className={`sch-link ${view.name === 'week' ? 'on' : ''}`} onClick={() => go({ name: 'week' })} disabled={!hasData}>
          <Sun size={17} /> This week
        </button>
        <button className={`sch-link ${view.name === 'calendar' ? 'on' : ''}`} onClick={() => go({ name: 'calendar' })} disabled={!hasData}>
          <CalendarDays size={17} /> Calendar
        </button>
        <div className="sch-head">Classes</div>
        {courses.map((c) => (
          <button key={c.id} className={`sch-link sch-course ${view.name === 'class' && view.courseId === c.id ? 'on' : ''}`} onClick={() => go({ name: 'class', courseId: c.id })} title={c.name}>
            <span className="sch-dot" style={{ background: color(c.id) }} />
            <span className="sch-course-text">
              <span className="sch-code">{c.code}</span>
              <span className="sch-cname">{c.name}</span>
            </span>
            {c.dueThisWeek > 0 && <span className="sch-badge">{c.dueThisWeek}</span>}
          </button>
        ))}
        <button className={`sch-link sch-add ${view.name === 'add' ? 'on' : ''}`} onClick={() => go({ name: 'add' })}>
          <Plus size={17} /> Add a class
        </button>
        <div className="sch-spacer" />
        <button className={`sch-link ${view.name === 'library' ? 'on' : ''}`} onClick={() => go({ name: 'library' })}>
          <Library size={17} /> Library
        </button>
      </nav>
      <main className="sch-main">{main}</main>
      {item && <ItemPanel ctx={ctx} item={item} onClose={() => setItem(null)} />}
    </div>
  );
}

interface Ctx {
  color(courseId: string): string;
  open(it: ScholarItem): void;
  toggleDone(it: ScholarItem): void;
  courses: ScholarCourse[];
  go(v: ScholarView): void;
}

function useItems(from: string, to: string, courseId?: string) {
  const version = useScholar((s) => s.version);
  const [items, setItems] = useState<ScholarItem[] | null>(null);
  useEffect(() => {
    let live = true;
    api.scholar
      .items({ from, to, courseId })
      .then((r) => live && setItems(r))
      .catch(() => live && setItems([]));
    return () => {
      live = false;
    };
  }, [from, to, courseId, version]);
  return items;
}

// ---------- One item, as a row ----------
function ItemRow({ ctx, it, showCourse = true }: { ctx: Ctx; it: ScholarItem; showCourse?: boolean }) {
  const todo = TODO.has(it.type);
  const when = it.due ? `Due ${clock(it.due)}` : it.start ? `${clock(it.start)}${it.end ? `–${clock(it.end)}` : ''}` : '';
  return (
    <div className={`sch-row ${it.done ? 'done' : ''} ${TEST.has(it.type) ? 'test' : ''}`} onClick={() => ctx.open(it)}>
      {todo ? (
        <button
          className="sch-check"
          title={it.done ? 'Mark as not done' : 'Mark as done'}
          onClick={(e) => {
            e.stopPropagation();
            ctx.toggleDone(it);
          }}
        >
          {it.done ? <CheckCircle2 size={19} /> : <Circle size={19} />}
        </button>
      ) : (
        <span className="sch-check static">
          <span className="sch-dot" style={{ background: ctx.color(it.courseId) }} />
        </span>
      )}
      <div className="sch-row-main">
        <div className="sch-row-title">{it.title}</div>
        <div className="sch-row-meta">
          {showCourse && (
            <span className="sch-chip" style={{ borderColor: ctx.color(it.courseId), color: ctx.color(it.courseId) }}>
              {it.courseCode}
            </span>
          )}
          <span>{TYPE_LABEL[it.type] || it.type}</span>
          {when && <span>· {when}</span>}
          {it.tentative && <span title="The date isn't confirmed by the class yet">· date to confirm</span>}
        </div>
      </div>
      {it.readings.some((r) => r.pdf) && (
        <button
          className="btn sm tonal sch-read"
          title={`Open ${it.readings.find((r) => r.pdf)!.chapter} in the textbook`}
          onClick={(e) => {
            e.stopPropagation();
            openReading(it.readings.find((r) => r.pdf)!);
          }}
        >
          <BookOpen size={14} /> Read
        </button>
      )}
    </div>
  );
}

// ---------- This week ----------
function WeekView({ ctx }: { ctx: Ctx }) {
  const from = today();
  const to = iso(addDays(new Date(), 13));
  const items = useItems(from, to);
  if (!items) return <Loading />;
  // Each class's current week (or its next one, between weeks).
  const banners = ctx.courses
    .map((c) => {
      const mine = items.filter((i) => i.type === 'weekly_reading' && i.courseId === c.id);
      return mine.find((b) => b.date <= from && (b.dateEnd || b.date) >= from) || mine.find((b) => b.date > from);
    })
    .filter((b): b is ScholarItem => !!b);
  const due = items.filter((i) => i.type !== 'weekly_reading' && i.date >= from);
  const days = [...new Set(due.map((i) => i.date))];
  const open = due.filter((i) => TODO.has(i.type) && !i.done).length;
  return (
    <div className="sch-page">
      <h1 className="sch-title">This week</h1>
      <p className="sch-sub">{open ? `${open} thing${open === 1 ? '' : 's'} to do in the next two weeks.` : 'Nothing left to do in the next two weeks.'}</p>
      {banners.length > 0 && (
        <section>
          <h2 className="sch-h2">Reading</h2>
          <div className="sch-banners">
            {banners.map((b) => (
              <ReadingCard key={b.id} ctx={ctx} b={b} />
            ))}
          </div>
        </section>
      )}
      {days.map((d) => (
        <section key={d}>
          <h2 className="sch-h2">{dayName(d)}</h2>
          <div className="sch-list">
            {due
              .filter((i) => i.date === d)
              .map((i) => (
                <ItemRow key={i.id} ctx={ctx} it={i} />
              ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/** A class's reading for a week: its chapters, with the textbook chapter to open. */
function ReadingCard({ ctx, b, showCourse = true }: { ctx: Ctx; b: ScholarItem; showCourse?: boolean }) {
  return (
    <div className="sch-banner" style={{ borderLeftColor: ctx.color(b.courseId) }} onClick={() => ctx.open(b)}>
      <div className="sch-banner-head">
        {showCourse && <span className="sch-code">{b.courseCode}</span>}
        <span className="muted">
          {shortDate(b.date)}
          {b.dateEnd ? ` – ${shortDate(b.dateEnd)}` : ''}
        </span>
      </div>
      {b.readings.length ? (
        b.readings.map((r) => (
          <div key={r.chapter} className="sch-chapter">
            <span className="sch-chapter-name">
              <span>
                <b>{r.chapter}</b>
                {r.title ? `: ${r.title}` : ''}
              </span>
              {!r.pdf && <span className="muted sch-nopdf">No textbook chapter yet</span>}
            </span>
            {r.pdf && (
              <button
                className="btn sm tonal"
                onClick={(e) => {
                  e.stopPropagation();
                  openReading(r);
                }}
              >
                <BookOpen size={14} /> Read
              </button>
            )}
          </div>
        ))
      ) : (
        <div className="sch-chapter">{b.title}</div>
      )}
    </div>
  );
}

// ---------- Calendar ----------
function CalendarView({ ctx, courseId }: { ctx: Ctx; courseId?: string }) {
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [mode, setMode] = useState<'month' | 'agenda'>('month');
  // Six school weeks (Monday to Sunday), starting on the Monday on or before the 1st.
  const start = addDays(month, -((month.getDay() + 6) % 7));
  const end = addDays(start, 41);
  const items = useItems(iso(start), iso(end), courseId);
  const t = today();
  const weeks = Array.from({ length: 6 }, (_, w) => Array.from({ length: 7 }, (_, d) => iso(addDays(start, w * 7 + d))));
  const shift = (n: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + n, 1));
  return (
    <div className={`sch-page ${courseId ? 'embedded' : ''}`}>
      <div className="cal-bar">
        {!courseId && <h1 className="sch-title">Calendar</h1>}
        <div className="cal-nav">
          <button className="icon-btn sm" onClick={() => shift(-1)} title="Previous month">
            <ChevronLeft size={17} />
          </button>
          <span className="cal-month">{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
          <button className="icon-btn sm" onClick={() => shift(1)} title="Next month">
            <ChevronRight size={17} />
          </button>
          <button
            className="btn sm"
            onClick={() => {
              const d = new Date();
              setMonth(new Date(d.getFullYear(), d.getMonth(), 1));
            }}
          >
            Today
          </button>
        </div>
        <div className="seg-mini">
          <button className={mode === 'month' ? 'on' : ''} onClick={() => setMode('month')}>
            Month
          </button>
          <button className={mode === 'agenda' ? 'on' : ''} onClick={() => setMode('agenda')}>
            List
          </button>
        </div>
      </div>
      {!items ? (
        <Loading />
      ) : mode === 'agenda' ? (
        <div>
          {[...new Set(items.filter((i) => i.type !== 'weekly_reading' && i.date >= iso(month) && i.date < iso(new Date(month.getFullYear(), month.getMonth() + 1, 1))).map((i) => i.date))].map((d) => (
            <section key={d}>
              <h2 className="sch-h2">{dayName(d)}</h2>
              <div className="sch-list">
                {items
                  .filter((i) => i.date === d && i.type !== 'weekly_reading')
                  .map((i) => (
                    <ItemRow key={i.id} ctx={ctx} it={i} showCourse={!courseId} />
                  ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="cal-grid">
          <div className="cal-weekdays">
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
              <div key={d} className="cal-dow">
                {d}
              </div>
            ))}
          </div>
          {weeks.map((days) => {
            const banners = items.filter((i) => i.type === 'weekly_reading' && i.date <= days[6] && (i.dateEnd || i.date) >= days[0]);
            return (
              <div key={days[0]} className="cal-week">
                {banners.length > 0 && (
                  <div className="cal-banners">
                    {banners.map((b) => (
                      <button key={b.id} className="cal-banner" style={{ background: `${ctx.color(b.courseId)}22`, color: ctx.color(b.courseId) }} onClick={() => ctx.open(b)} title={b.title}>
                        {!courseId && <b>{b.courseCode}</b>} {b.readings.length ? b.readings.map((r) => r.chapter.replace('Chapter ', 'Ch ')).join(', ') : b.title}
                      </button>
                    ))}
                  </div>
                )}
                <div className="cal-days">
                  {days.map((d) => {
                    const list = items.filter((i) => i.date === d && i.type !== 'weekly_reading');
                    return (
                      <div key={d} className={`cal-day ${d === t ? 'today' : ''} ${parse(d).getMonth() !== month.getMonth() ? 'other' : ''}`}>
                        <div className="cal-num">{parse(d).getDate()}</div>
                        {list.slice(0, 5).map((i) => (
                          <button
                            key={i.id}
                            className={`cal-item ${i.done ? 'done' : ''} ${TEST.has(i.type) ? 'test' : ''}`}
                            onClick={() => ctx.open(i)}
                            title={`${i.courseCode} · ${TYPE_LABEL[i.type] || i.type}: ${i.title}`}
                          >
                            <span className="sch-dot" style={{ background: ctx.color(i.courseId) }} />
                            <span className="cal-item-text">{i.title}</span>
                          </button>
                        ))}
                        {list.length > 5 && <div className="cal-more">+{list.length - 5} more</div>}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------- One class ----------
function ClassView({ ctx, courseId }: { ctx: Ctx; courseId: string }) {
  const version = useScholar((s) => s.version);
  const [c, setC] = useState<ScholarCourseDetail | null>(null);
  const [tab, setTab] = useState<'week' | 'calendar' | 'textbook' | 'study'>('week');
  useEffect(() => {
    let live = true;
    api.scholar.course(courseId).then((r) => live && setC(r));
    return () => {
      live = false;
    };
  }, [courseId, version]);
  useEffect(() => setTab('week'), [courseId]);
  const items = useItems(today(), iso(addDays(new Date(), 20)), courseId);
  if (!c) return <Loading />;
  return (
    <div className="sch-page">
      <div className="cls-head">
        <span className="cls-color" style={{ background: ctx.color(c.id) }} />
        <div>
          <h1 className="sch-title">
            {c.code} <span className="cls-name">{c.name}</span>
          </h1>
          <p className="sch-sub">
            {[c.term, c.instructor].filter(Boolean).join(' · ')}
            {c.url && (
              <>
                {' · '}
                <a href={c.url} target="_blank" rel="noreferrer">
                  Open the class site <ExternalLink size={12} />
                </a>
              </>
            )}
          </p>
        </div>
      </div>
      <div className="cls-tabs">
        {(
          [
            ['week', 'Coming up'],
            ['textbook', 'Textbook'],
            ['calendar', 'Calendar'],
            ['study', 'Study']
          ] as const
        ).map(([id, label]) => (
          <button key={id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'week' &&
        (!items ? (
          <Loading />
        ) : (
          <>
            {items
              .filter((i) => i.type === 'weekly_reading')
              .slice(0, 2)
              .map((b) => (
                <ReadingCard key={b.id} ctx={ctx} b={b} showCourse={false} />
              ))}
            <div className="sch-list" style={{ marginTop: 14 }}>
              {items
                .filter((i) => i.type !== 'weekly_reading')
                .map((i) => (
                  <div key={i.id} className="cls-dated">
                    <span className="cls-date">{dayName(i.date)}</span>
                    <ItemRow ctx={ctx} it={i} showCourse={false} />
                  </div>
                ))}
            </div>
          </>
        ))}
      {tab === 'textbook' && <Textbook c={c} />}
      {tab === 'calendar' && <CalendarView ctx={ctx} courseId={c.id} />}
      {tab === 'study' && (
        <div className="sch-empty">
          <Lock size={26} />
          <div>Flashcards, practice quizzes and chapter reviews for this class are coming soon.</div>
          <div className="muted">They're written from your class's own chapters and what its tests cover, once your Claude account is connected.</div>
        </div>
      )}
    </div>
  );
}

/** The class's textbook: one study chapter per chapter of the class, in order. */
function Textbook({ c }: { c: ScholarCourseDetail }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!c.chapters.length) return <div className="sch-empty">No chapters yet. They appear after the class is scanned.</div>;
  return (
    <div className="tb-list">
      {c.chapters.map((ch) => (
        <div key={ch.label} className={`tb-ch ${open === ch.label ? 'open' : ''}`}>
          <div className="tb-row" onClick={() => setOpen(open === ch.label ? null : ch.label)}>
            <FileText size={17} className={ch.pdf ? 'tb-has' : 'tb-none'} />
            <div className="tb-text">
              <div className="tb-title">
                {ch.label}
                {ch.title ? `: ${ch.title}` : ''}
              </div>
              <div className="muted tb-meta">
                {ch.pdf ? `${ch.pdf.pages || '?'} pages` : 'Not written yet'}
                {ch.sections.length ? ` · ${ch.sections.length} sections` : ''}
                {ch.objectives.length ? ` · ${ch.objectives.length} objectives` : ''}
              </div>
            </div>
            {ch.pdf && (
              <button
                className="btn sm tonal"
                onClick={(e) => {
                  e.stopPropagation();
                  openReading({ chapter: ch.label, title: ch.title, pdf: ch.pdf });
                }}
              >
                <BookOpen size={14} /> Read
              </button>
            )}
          </div>
          {open === ch.label && (
            <div className="tb-detail">
              {ch.sections.length > 0 && (
                <>
                  <div className="tb-h">Sections</div>
                  <ul>
                    {ch.sections.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ul>
                </>
              )}
              {ch.objectives.length > 0 && (
                <>
                  <div className="tb-h">What to know</div>
                  <ul>
                    {ch.objectives.map((o) => (
                      <li key={o}>{o}</li>
                    ))}
                  </ul>
                </>
              )}
              {ch.vocabulary && (
                <>
                  <div className="tb-h">Key terms</div>
                  <p>{ch.vocabulary}</p>
                </>
              )}
              {ch.readingUrl && (
                <a href={ch.readingUrl} target="_blank" rel="noreferrer" className="btn sm">
                  <ExternalLink size={13} /> {ch.readingLabel || 'Class reading'}
                </a>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------- The item panel ----------
function ItemPanel({ ctx, item: it, onClose }: { ctx: Ctx; item: ScholarItem; onClose(): void }) {
  const links = [...it.links, ...it.weeklyLinks];
  // (Some items' only description is their own title: nothing more to say.)
  const instructions = [it.description, it.sourceWording].find((t) => t && t.trim() !== it.title.trim()) || '';
  return (
    <aside className="sch-panel">
      <div className="sch-panel-head">
        <span className="sch-chip" style={{ borderColor: ctx.color(it.courseId), color: ctx.color(it.courseId) }}>
          {it.courseCode}
        </span>
        <span className="muted">{TYPE_LABEL[it.type] || it.type}</span>
        <button className="icon-btn sm" onClick={onClose} title="Close">
          <X size={16} />
        </button>
      </div>
      <h2 className="sch-panel-title">{it.title}</h2>
      <div className="sch-panel-when">
        {dayName(it.date)}
        {it.dateEnd && it.dateEnd !== it.date ? ` – ${shortDate(it.dateEnd)}` : ''}
        {it.due ? `, due ${clock(it.due)}` : it.start ? `, ${clock(it.start)}${it.end ? `–${clock(it.end)}` : ''}` : ''}
        {it.points ? ` · ${it.points} points` : ''}
      </div>
      {TODO.has(it.type) && (
        <button className={`btn ${it.done ? '' : 'tonal'} sch-done-btn`} onClick={() => ctx.toggleDone(it)}>
          {it.done ? <CheckCircle2 size={16} /> : <Circle size={16} />} {it.done ? 'Done' : 'Mark as done'}
        </button>
      )}
      {it.readings.length > 0 && (
        <section>
          <div className="tb-h">Reading</div>
          {it.readings.map((r) => (
            <div key={r.chapter} className="sch-chapter">
              <span>
                <b>{r.chapter}</b>
                {r.title ? `: ${r.title}` : ''}
              </span>
              {r.pdf ? (
                <button className="btn sm tonal" onClick={() => openReading(r)}>
                  <BookOpen size={14} /> Read
                </button>
              ) : (
                <span className="muted sch-nopdf">Not written yet</span>
              )}
            </div>
          ))}
        </section>
      )}
      {it.covered.length > 0 && (
        <section>
          <div className="tb-h">Covers</div>
          <p>{it.covered.join(', ')}</p>
        </section>
      )}
      {it.studyFocus.length > 0 && (
        <section>
          <div className="tb-h">Study</div>
          <ul>
            {it.studyFocus.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </section>
      )}
      {instructions && (
        <section>
          <div className="tb-h">Instructions</div>
          <p className="sch-desc">{instructions}</p>
        </section>
      )}
      {links.length > 0 && (
        <section>
          <div className="tb-h">Links</div>
          <div className="sch-links">
            {links.map((l, k) => (
              <a key={k} href={l.url} target="_blank" rel="noreferrer" className="sch-linkrow">
                <ExternalLink size={13} /> {l.label}
              </a>
            ))}
          </div>
        </section>
      )}
    </aside>
  );
}

// ---------- Adding a class ----------
function AddClass({ first }: { first: boolean }) {
  const [gate, setGate] = useState(false);
  const bringIn = async () => {
    const folder = await api.openFolderDialog();
    if (!folder) return;
    try {
      const r = await api.scholar.importExisting(folder);
      toast(`Classes brought in${r.pdfs ? `, with ${r.pdfs} textbook chapter file${r.pdfs === 1 ? '' : 's'}` : ''}.`, 'success');
      useScholar.getState().set({ view: { name: 'week' } });
      reloadScholar();
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };
  return (
    <div className="sch-page">
      <h1 className="sch-title">{first ? 'Add your first class' : 'Add a class'}</h1>
      <p className="sch-sub">Each class gets its own textbook, calendar and study materials.</p>
      <div className="add-cards">
        <div className="add-card disabled">
          <Library size={26} />
          <div className="add-name">From the Library</div>
          <div className="add-desc">Complete courses with a textbook chapter, flashcards and a large quiz bank for every chapter. Free for everyone, nothing to connect.</div>
          <div className="add-soon">Coming soon</div>
        </div>
        <button className="add-card" onClick={() => setGate(true)}>
          <GraduationCap size={26} />
          <div className="add-name">From your school</div>
          <div className="add-desc">Kea scans your class site in the background and keeps your assignments, tests, readings and a weekly textbook up to date.</div>
        </button>
      </div>
      {gate && (
        <div className="gate">
          <h2>Connect your Claude account to scan your classes</h2>
          <p>
            Scanning a class means reading every page of its site: the syllabus, each week's module, assignments, tests and their instructions. Kea uses <b>Claude</b> for that,
            through your own Claude account, because it needs judgment to find everything and get dates exactly right. It also writes each week's textbook chapter from what your
            class covers.
          </p>
          <ul>
            <li>It runs quietly in the background, about once a day, and when a new class appears.</li>
            <li>Kea signs in to your class site with the details you save in Kea. It only shows you a window if your school asks for a code.</li>
            <li>
              <b>It uses your Claude plan's usage.</b> A first scan of a class is the biggest; daily checks are small.
            </li>
            <li>Without Claude, this stays off rather than guessing. Library classes work without it.</li>
          </ul>
          <button className="btn tonal" disabled title="Setup arrives in the next update">
            Set up Claude and my school (next update)
          </button>
          <details className="gate-adv">
            <summary>Already use the Class Calendar Import skills?</summary>
            <p>Bring in the classes, readings and study PDFs they've already made. Your original folder isn't changed.</p>
            <button className="btn sm" onClick={bringIn}>
              <FolderInput size={14} /> Choose the Class Calendar Import folder…
            </button>
          </details>
        </div>
      )}
    </div>
  );
}

function LibraryView() {
  return (
    <div className="sch-page">
      <h1 className="sch-title">Library</h1>
      <div className="sch-empty">
        <Library size={28} />
        <div>Free, complete courses are coming soon.</div>
        <div className="muted">Each one has a full textbook chapter for every chapter, a flashcard deck and about 100 practice questions per chapter, with answers. Nothing to connect.</div>
      </div>
    </div>
  );
}

function Loading() {
  return (
    <div className="center-fill" style={{ minHeight: 200 }}>
      <div className="spinner" />
    </div>
  );
}
