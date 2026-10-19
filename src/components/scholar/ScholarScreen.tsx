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
  ChevronDown,
  Activity,
  Loader2,
  AlertTriangle,
  Inbox,
  MapPin,
  Mail,
  Palette,
  Megaphone,
  RefreshCw,
  RotateCcw,
  Clock,
  Award,
  Layers,
  Trash2,
  Monitor,
  ClipboardCheck,
  ShieldAlert,
  Reply
} from 'lucide-react';
import { inboxParts, kindOf } from './inboxFormat';
import { api, ProfileList, ScholarCourse, ScholarCourseDetail, ScholarGrades, ScholarInboxItem, ScholarItem, ScholarReading } from '../../lib/api';
import { openPaths } from '../../lib/open';
import { setPdfTarget } from '../../lib/pdfTarget';
import { useSettings } from '../../lib/settings';
import { toast, prompt } from '../../store';
import { useScholar, reloadScholar, ScholarView } from './scholarStore';
import { MenuButton } from '../Popover';
import { SetupWizard } from './Setup';
import { ScansView, FromAnotherDevice } from './ScansView';
import { CATEGORIES, Colors, LinkGroups, TODO, categoryOf, isDone, isMissing, isUnconfirmed, openLink, primaryLink, setClassColor, setTypeColor, useColors } from './kinds';
import { PracticeBox, ResourcesView, StudyPlayer } from './Study';
import { ReviewBanner } from './StudyModes';
import { MessagesView } from './Messages';
import { ChangesBox, ClassRules, SyllabusMap, ItemHistory } from './History';
import { quizChapter } from './QuizMe';
import { AccountCard, Avatar, VerifiedBadge, useAccount } from './Account';
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
  if (s === iso(addDays(new Date(), -1))) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
};
const shortDate = (s: string) => parse(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const clock = (t: string | null) => {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
};
const minutes = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};
const timeAgo = (at: string) => {
  const s = (Date.now() - new Date(at).getTime()) / 1000;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
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
const TEST = new Set(['exam', 'final_exam', 'lab_practical', 'quiz']);
/** A short room for tight spaces: "PPSC Rampart Range Campus, E112" → "E112". */
const shortRoom = (loc: string) => (loc === 'Online' ? 'Online' : loc.split(',').pop()!.trim());

async function openReading(r: ScholarReading) {
  if (!r.pdf) return;
  setPdfTarget(r.pdf.file, r.chapter);
  await openPaths([r.pdf.file]);
}

// ---------- The screen ----------
export function ScholarScreen() {
  const { view, version, set, study } = useScholar();
  const [profiles, setProfiles] = useState<ProfileList | null>(null);
  const [hasData, setHasData] = useState<boolean | null>(null);
  const [courses, setCourses] = useState<ScholarCourse[]>([]);
  const [item, setItem] = useState<ScholarItem | null>(null);
  const [scanning, setScanning] = useState(false);
  const [unread, setUnread] = useState(0);
  const [missing, setMissing] = useState(0);
  const [grades, setGrades] = useState<Record<string, number | null>>({});

  useEffect(() => api.scholar.onChanged(() => reloadScholar()), []);
  // A new-message notification clicked: its message, open in Messages.
  useEffect(() => api.scholar.onOpenMail((id) => useScholar.getState().set({ view: { name: 'messages', id } })), []);
  useEffect(() => {
    const inbox = () => api.scholar.inbox().then((n) => setUnread(n.filter((x) => !x.read).length));
    api.scholar.runStatus().then((s) => setScanning(!!s.running));
    inbox();
    const offs = [api.scholar.onRun((r) => setScanning(r.running)), api.scholar.onNews(inbox)];
    return () => offs.forEach((f) => f());
  }, [version]);
  useEffect(() => {
    let live = true;
    (async () => {
      const [p, st, cs] = await Promise.all([api.scholar.profiles(), api.scholar.status(), api.scholar.courses()]);
      if (!live) return;
      setProfiles(p);
      setHasData(st.hasData);
      setCourses(cs);
      const past = await api.scholar.items({ from: iso(addDays(new Date(), -28)), to: today() });
      if (live) setMissing(past.filter((i) => isMissing(i)).length);
      const g = await Promise.all(cs.map((c) => api.scholar.grades(c.id, c.code).catch(() => null)));
      if (live) setGrades(Object.fromEntries(cs.map((c, k) => [c.id, g[k]?.final?.percent ?? null])));
    })().catch((err) => toast(`Couldn't load your classes: ${err.message}`, 'error'));
    return () => {
      live = false;
    };
  }, [version]);

  const colors = useColors(courses.map((c) => c.id));
  const go = (v: ScholarView) => (set({ view: v }), setItem(null));
  const toggleDone = async (it: ScholarItem) => {
    await api.scholar.setDone(it.id, !it.done);
    if (item?.id === it.id) setItem({ ...it, done: it.done ? null : new Date().toISOString() });
    reloadScholar();
  };
  const ctx: Ctx = { colors, open: setItem, toggleDone, courses, go };

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
  const [account] = useAccount();
  const main =
    hasData === null ? (
      <div className="center-fill">
        <div className="spinner" />
      </div>
    ) : (!hasData && !['scans', 'library', 'inbox', 'resources', 'account'].includes(view.name)) || view.name === 'add' ? (
      <AddClass first={!hasData} />
    ) : view.name === 'messages' ? (
      <MessagesView courses={ctx.courses} openId={view.id} />
    ) : view.name === 'inbox' ? (
      <InboxView ctx={ctx} />
    ) : view.name === 'calendar' ? (
      <CalendarView ctx={ctx} />
    ) : view.name === 'class' ? (
      <ClassView ctx={ctx} courseId={view.courseId} />
    ) : view.name === 'library' ? (
      <LibraryView />
    ) : view.name === 'resources' ? (
      <ResourcesView courses={courses} />
    ) : view.name === 'scans' ? (
      <ScansView />
    ) : view.name === 'account' ? (
      <div className="sch-page">
        <h1 className="sch-title">Your account</h1>
        <p className="sch-sub">School mode needs an account with a verified email.</p>
        <AccountCard />
      </div>
    ) : (
      <WeekView ctx={ctx} />
    );

  return (
    <div className="scholar">
      <nav className="sch-nav">
        <MenuButton
          button={() => (
            <button className="sch-profile" title="Your account and profiles">
              {account ? <Avatar account={account} size={26} /> : <span className="sch-avatar">{(activeProfile?.name || 'S')[0]}</span>}
              <span className="sch-profile-name">
                {account?.name || activeProfile?.name || 'School'}
                <VerifiedBadge account={account} size={13} />
              </span>
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
              <button className="menu-item" onClick={() => (close(), go({ name: 'account' }))}>
                <Avatar account={account} size={16} /> {account ? 'Your account' : 'Set up your account'}
              </button>
              <button className="menu-item" onClick={() => (close(), newProfile())}>
                <Plus size={15} /> New profile…
              </button>
            </>
          )}
        </MenuButton>

        <button className={`sch-link ${view.name === 'week' ? 'on' : ''}`} onClick={() => go({ name: 'week' })} disabled={!hasData}>
          <Sun size={17} /> This week
          {missing > 0 && (
            <span className="sch-badge alert" title={`${missing} missing`}>
              {missing}
            </span>
          )}
        </button>
        <button className={`sch-link ${view.name === 'inbox' ? 'on' : ''}`} onClick={() => go({ name: 'inbox' })}>
          <Inbox size={17} /> Inbox
          {unread > 0 && <span className="sch-badge strong">{unread}</span>}
        </button>
        <button className={`sch-link ${view.name === 'messages' ? 'on' : ''}`} onClick={() => go({ name: 'messages' })} disabled={!hasData}>
          <Mail size={17} /> Messages
        </button>
        <button className={`sch-link ${view.name === 'calendar' ? 'on' : ''}`} onClick={() => go({ name: 'calendar' })} disabled={!hasData}>
          <CalendarDays size={17} /> Calendar
        </button>
        <button className={`sch-link ${view.name === 'resources' ? 'on' : ''}`} onClick={() => go({ name: 'resources' })} disabled={!hasData}>
          <Layers size={17} /> My resources
        </button>
        <div className="sch-head">Classes</div>
        {courses.map((c) => (
          <button key={c.id} className={`sch-link sch-course ${view.name === 'class' && view.courseId === c.id ? 'on' : ''}`} onClick={() => go({ name: 'class', courseId: c.id })} title={c.name}>
            <span className="sch-dot" style={{ background: colors.course(c.id) }} />
            <span className="sch-course-text">
              <span className="sch-code">
                {c.code}
                {grades[c.id] != null && <span className={`sch-grade ${grades[c.id]! < 60 ? 'low' : ''}`}>{grades[c.id]}%</span>}
              </span>
              <span className="sch-cname">{c.name}</span>
            </span>
            {c.dueThisWeek > 0 && <span className="sch-badge">{c.dueThisWeek}</span>}
          </button>
        ))}
        <button className={`sch-link sch-add ${view.name === 'add' ? 'on' : ''}`} onClick={() => go({ name: 'add' })}>
          <Plus size={17} /> Add a class
        </button>
        <div className="sch-spacer" />
        <button className={`sch-link ${view.name === 'scans' ? 'on' : ''}`} onClick={() => go({ name: 'scans' })}>
          {scanning ? <Loader2 size={17} className="spin" /> : <Activity size={17} />} {scanning ? 'Scanning…' : 'Scans'}
        </button>
        <button className={`sch-link ${view.name === 'library' ? 'on' : ''}`} onClick={() => go({ name: 'library' })}>
          <Library size={17} /> Library
        </button>
      </nav>
      <main className="sch-main">
        {hasData && account !== undefined && !account?.verified && view.name !== 'account' && (
          <div className="acct-banner">
            <ShieldAlert size={16} />
            <span>School mode now needs a Kea account with a verified email. Class checks are paused until you add one.</span>
            <button className="btn sm primary" onClick={() => go({ name: 'account' })}>
              Set up your account
            </button>
          </div>
        )}
        {main}
      </main>
      {item && <ItemPanel ctx={ctx} item={item} onClose={() => setItem(null)} />}
      {study && <StudyPlayer id={study} onClose={() => set({ study: null })} />}
    </div>
  );
}

interface Ctx {
  colors: Colors;
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

/** When an item happens, in words: "Due 11:59 PM", "5:30–7:20 PM". */
const whenOf = (it: ScholarItem) => (it.due ? `Due ${clock(it.due)}` : it.start ? `${clock(it.start)}${it.end ? `–${clock(it.end)}` : ''}` : '');

// ---------- One item, as a row ----------
function ItemRow({ ctx, it, showCourse = true, showDate = false }: { ctx: Ctx; it: ScholarItem; showCourse?: boolean; showDate?: boolean }) {
  const todo = TODO.has(it.type);
  const missing = isMissing(it);
  const quick = primaryLink(it);
  const reading = it.readings.find((r) => r.pdf);
  const accent = ctx.colors.item(it);
  return (
    <div className={`sch-row ${isDone(it) ? 'done' : ''} ${missing ? 'missing' : ''}`} style={{ ['--kc' as any]: accent }} onClick={() => ctx.open(it)}>
      {todo ? (
        <button
          className="sch-check"
          title={it.done ? 'Mark as not done' : isDone(it) ? (it.handIn === 'graded' ? 'Graded on your class site' : 'Handed in on your class site') : 'Mark as done'}
          onClick={(e) => {
            e.stopPropagation();
            ctx.toggleDone(it);
          }}
        >
          {isDone(it) ? <CheckCircle2 size={19} /> : <Circle size={19} />}
        </button>
      ) : (
        <span className="sch-check static">
          <span className="sch-dot" style={{ background: accent }} />
        </span>
      )}
      <div className="sch-row-main">
        <div className="sch-row-title">
          {missing && (
            <span className="miss-flag" title="Past due and not checked off">
              <AlertTriangle size={12} /> Missing
            </span>
          )}
          {it.title}
        </div>
        <div className="sch-row-meta">
          {showCourse && (
            <span className="sch-chip" style={{ borderColor: ctx.colors.course(it.courseId), color: ctx.colors.course(it.courseId) }}>
              {it.courseCode}
            </span>
          )}
          <span className="sch-type" style={{ color: ctx.colors.type(it.type) }}>
            {TYPE_LABEL[it.type] || it.type}
          </span>
          {showDate && <span>· {dayName(it.date)}</span>}
          {whenOf(it) && <span>· {whenOf(it)}</span>}
          {it.location && it.location !== 'Online' && (
            <span className="sch-room" title={it.locationUsual ? `${it.location} (the class's usual room)` : it.location}>
              <MapPin size={11} /> {shortRoom(it.location)}
            </span>
          )}
          {it.points ? <span>· {it.points} pts</span> : null}
          {it.tentative && <span title="The date isn't confirmed by the class yet">· date to confirm</span>}
          {!it.done && (it.handIn === 'graded' || it.handIn === 'submitted') && <span className="hand-tag">{it.handIn === 'graded' ? 'Graded' : 'Handed in'}</span>}
        </div>
      </div>
      <div className="sch-row-actions">
        {quick && (
          <button
            className="btn sm sch-quick"
            title={`${quick.label}: opens the page on your class site`}
            onClick={(e) => {
              e.stopPropagation();
              openLink(quick.url);
            }}
          >
            <quick.icon size={14} /> {quick.label}
          </button>
        )}
        {reading && (
          <button
            className="btn sm tonal"
            title={`Open ${reading.chapter} in the textbook`}
            onClick={(e) => {
              e.stopPropagation();
              openReading(reading);
            }}
          >
            <BookOpen size={14} /> Read
          </button>
        )}
      </div>
    </div>
  );
}

// ---------- This week ----------
function WeekView({ ctx }: { ctx: Ctx }) {
  const from = today();
  const to = iso(addDays(new Date(), 13));
  const items = useItems(from, to);
  const past = useItems(iso(addDays(new Date(), -28)), iso(addDays(new Date(), -1)));
  const [missOpen, setMissOpen] = useState(true);
  const [uncOpen, setUncOpen] = useState(false);
  if (!items || !past) return <Loading />;
  const recent = [...past, ...items.filter((i) => i.date === from)];
  const missing = recent.filter((i) => isMissing(i));
  const unconfirmed = recent.filter((i) => isUnconfirmed(i));
  const checkAllOff = async () => {
    for (const i of unconfirmed) await api.scholar.setDone(i.id, true);
    toast(`Checked off ${unconfirmed.length} item${unconfirmed.length === 1 ? '' : 's'}.`, 'success');
    reloadScholar();
  };
  // Each class's current week (or its next one, between weeks).
  const banners = ctx.courses
    .map((c) => {
      const mine = items.filter((i) => i.type === 'weekly_reading' && i.courseId === c.id);
      return mine.find((b) => b.date <= from && (b.dateEnd || b.date) >= from) || mine.find((b) => b.date > from);
    })
    .filter((b): b is ScholarItem => !!b);
  const due = items.filter((i) => i.type !== 'weekly_reading' && i.date >= from && !missing.includes(i) && !unconfirmed.includes(i));
  const days = [...new Set(due.map((i) => i.date))];
  const open = due.filter((i) => TODO.has(i.type) && !isDone(i)).length;
  const next = due.find((i) => i.date === from && i.start && minutes(i.start) > new Date().getHours() * 60 + new Date().getMinutes());
  return (
    <div className="sch-page">
      <h1 className="sch-title">This week</h1>
      <p className="sch-sub">
        {open ? `${open} thing${open === 1 ? '' : 's'} to do in the next two weeks.` : 'Nothing left to do in the next two weeks.'}
        {next ? ` Next: ${next.courseCode} ${TYPE_LABEL[next.type]?.toLowerCase() || ''} at ${clock(next.start)}${next.location && next.location !== 'Online' ? ` in ${shortRoom(next.location)}` : ''}.` : ''}
      </p>
      <ReviewBanner />
      <ChangesBox />
      {missing.length > 0 && (
        <section className="miss-box">
          <button className="miss-head" onClick={() => setMissOpen(!missOpen)}>
            <AlertTriangle size={16} />
            <b>
              {missing.length} missing
            </b>
            <span className="muted">Past due, and your class site shows nothing handed in. Hand them in if you still can.</span>
            <ChevronDown size={15} className={missOpen ? 'flip' : ''} />
          </button>
          {missOpen && (
            <div className="sch-list">
              {missing.map((i) => (
                <ItemRow key={i.id} ctx={ctx} it={i} showDate />
              ))}
            </div>
          )}
        </section>
      )}
      {unconfirmed.length > 0 && (
        <section className="unc-box">
          <button className="miss-head unc" onClick={() => setUncOpen(!uncOpen)}>
            <Circle size={15} />
            <b>{unconfirmed.length} past due, not checked off</b>
            <span className="muted">Kea couldn't confirm these on your class site (no grade or hand-in folder yet).</span>
            <ChevronDown size={15} className={uncOpen ? 'flip' : ''} />
          </button>
          {uncOpen && (
            <>
              <div className="sch-list">
                {unconfirmed.map((i) => (
                  <ItemRow key={i.id} ctx={ctx} it={i} showDate />
                ))}
              </div>
              <button className="btn sm unc-all" onClick={checkAllOff}>
                <CheckCircle2 size={14} /> Check all of these off
              </button>
            </>
          )}
        </section>
      )}
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
  const count = b.weeklyLinks.length;
  return (
    <div className="sch-banner" style={{ borderLeftColor: ctx.colors.course(b.courseId) }} onClick={() => ctx.open(b)}>
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
              {!r.pdf && <span className="muted sch-nopdf">Textbook chapter being written</span>}
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
      {count > 0 && <div className="sch-banner-more">{count} videos, slides and handouts</div>}
    </div>
  );
}

// ---------- Inbox ----------
function InboxView({ ctx }: { ctx: Ctx }) {
  const version = useScholar((s) => s.version);
  const [items, setItems] = useState<ScholarInboxItem[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>('all');
  const [checking, setChecking] = useState(false);
  const [confirmRead, setConfirmRead] = useState(false);
  const load = () => api.scholar.inbox().then(setItems);
  useEffect(() => {
    load();
    return api.scholar.onNews(() => load());
  }, [version]);
  if (!items) return <Loading />;
  const codes = [...new Set(items.map((i) => i.course).filter(Boolean))].sort();
  const shown = items.filter((i) => filter === 'all' || (filter === 'unread' ? !i.read : i.course === filter));
  const color = (code: string) => {
    const c = ctx.courses.find((x) => x.code === code);
    return c ? ctx.colors.course(c.id) : 'var(--text-3)';
  };
  const read = (i: ScholarInboxItem) => {
    if (!i.read) {
      api.scholar.markInboxRead([i.id]);
      setItems(items.map((x) => (x.id === i.id ? { ...x, read: true } : x)));
    }
  };
  // Deleted messages stay deleted: Kea remembers them, so the next look at the class site doesn't bring them back.
  const remove = (ids: string[]) => {
    if (!ids.length) return;
    api.scholar.deleteInbox(ids);
    setItems(items.filter((x) => !ids.includes(x.id)));
    if (open && ids.includes(open)) setOpen(null);
  };
  const readShown = shown.filter((i) => i.read);
  const checkNow = async () => {
    setChecking(true);
    const ok = await api.scholar.checkInbox().catch(() => false);
    setChecking(false);
    if (!ok) toast('Kea isn’t signed in to your class site right now. Sign in under Add a class → From your school.', 'error');
    load();
  };
  return (
    <div className="sch-page">
      <div className="cal-bar">
        <h1 className="sch-title">Inbox</h1>
        <div className="seg-mini wrap">
          {['all', 'unread', ...codes].map((f) => (
            <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
              {f === 'all' ? 'All' : f === 'unread' ? `Unread${items.some((i) => !i.read) ? ` (${items.filter((i) => !i.read).length})` : ''}` : f}
            </button>
          ))}
        </div>
        <button className="btn sm" onClick={checkNow} disabled={checking}>
          {checking ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} Check now
        </button>
        {items.some((i) => !i.read) && (
          <button className="btn sm" onClick={() => (api.scholar.markInboxRead(), setItems(items.map((x) => ({ ...x, read: true }))))}>
            Mark all read
          </button>
        )}
        {readShown.length > 0 &&
          (confirmRead ? (
            <span className="ib-confirm">
              Delete {readShown.length} read message{readShown.length === 1 ? '' : 's'}?
              <button className="btn sm danger" onClick={() => (remove(readShown.map((i) => i.id)), setConfirmRead(false))}>
                Delete
              </button>
              <button className="btn sm" onClick={() => setConfirmRead(false)}>
                Cancel
              </button>
            </span>
          ) : (
            <button className="btn sm" onClick={() => setConfirmRead(true)}>
              <Trash2 size={14} /> Delete read
            </button>
          ))}
      </div>
      <p className="sch-sub">One message per thing, as it happens: announcements, grades, feedback and class-site messages come straight from your class site (every half hour unless you change it in Settings → Scholar). Anything that needs you comes from the class check.</p>
      {!shown.length ? (
        <div className="sch-empty">
          <Inbox size={26} />
          <div>Nothing here yet.</div>
        </div>
      ) : (
        <div className="ib-list">
          {shown.map((i) => {
            const k = kindOf(i);
            const parts = inboxParts(i);
            return (
            <div key={i.id} className={`ib-item ${i.read ? '' : 'unread'} ${open === i.id ? 'open' : ''}`} style={{ '--k': k.color } as React.CSSProperties} onClick={() => (setOpen(open === i.id ? null : i.id), read(i))}>
              <div className="ib-head">
                <span className="ib-icon">{i.kind === 'announcement' ? <Megaphone size={15} /> : i.kind === 'grade' || i.kind === 'feedback' ? <Award size={15} /> : i.kind === 'needs_you' || i.kind === 'attention' || i.kind === 'missed' ? <AlertTriangle size={15} /> : <Mail size={15} />}</span>
                <span className="ib-kind">{k.label}</span>
                {i.course && (
                  <span className="sch-chip" style={{ borderColor: color(i.course), color: color(i.course) }}>
                    {i.course}
                  </span>
                )}
                <b className="ib-title">{i.title}</b>
                {i.score && (
                  <span className="ib-score">
                    {i.score}
                    {i.percent != null ? ` · ${i.percent}%` : ''}
                  </span>
                )}
                {i.updated && <span className="ln-tag">Updated</span>}
                <span className="muted ib-at">{i.at ? timeAgo(i.at) : ''}</span>
                <button
                  className="ib-del"
                  title="Delete"
                  aria-label="Delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    remove([i.id]);
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
              {parts.text && <div className="ib-body">{parts.text}</div>}
              {(parts.links.length > 0 || i.kind === 'message') && (
                <div className="ib-links">
                  {i.kind === 'message' && (
                    <button
                      className="ib-link primary"
                      title="Opens the message on your class site with Reply already pressed"
                      onClick={(e) => {
                        e.stopPropagation();
                        read(i);
                        useScholar.getState().set({ view: { name: 'messages' } });
                      }}
                    >
                      <Reply size={12} /> Reply
                    </button>
                  )}
                  {(open === i.id ? parts.links : parts.links.slice(0, 3)).map((l) => (
                    <button
                      key={l.url}
                      className="ib-link"
                      title={l.url}
                      onClick={(e) => {
                        e.stopPropagation();
                        read(i);
                        openLink(l.url);
                      }}
                    >
                      <ExternalLink size={12} /> {l.label}
                    </button>
                  ))}
                  {open !== i.id && parts.links.length > 3 && <span className="muted ib-more">+{parts.links.length - 3} more</span>}
                </div>
              )}
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------- Calendar ----------
function ColorsMenu({ ctx }: { ctx: Ctx }) {
  const by = ctx.colors.by;
  return (
    <MenuButton
      button={() => (
        <button className="btn sm" title="Colors">
          <Palette size={14} /> Colors
        </button>
      )}
    >
      {() => (
        <div className="colors-menu" onClick={(e) => e.stopPropagation()}>
          <div className="seg-mini full">
            <button className={by === 'type' ? 'on' : ''} onClick={() => useSettings.getState().set({ 'scholar.colorBy': 'type' })}>
              By kind
            </button>
            <button className={by === 'class' ? 'on' : ''} onClick={() => useSettings.getState().set({ 'scholar.colorBy': 'class' })}>
              By class
            </button>
          </div>
          {(by === 'type' ? CATEGORIES.map((c) => ({ id: c.id, label: c.label, color: ctx.colors.type(c.types[0]), set: setTypeColor })) : ctx.courses.map((c) => ({ id: c.id, label: c.code, color: ctx.colors.course(c.id), set: setClassColor }))).map((row) => (
            <label key={row.id} className="colors-row">
              <input type="color" value={row.color} onChange={(e) => row.set(row.id, e.target.value)} />
              <span>{row.label}</span>
              <button className="icon-btn sm" title="Back to the default color" onClick={(e) => (e.preventDefault(), row.set(row.id, null))}>
                <RotateCcw size={13} />
              </button>
            </label>
          ))}
        </div>
      )}
    </MenuButton>
  );
}

function CalendarView({ ctx, courseId }: { ctx: Ctx; courseId?: string }) {
  const [anchor, setAnchor] = useState(() => new Date());
  const [mode, setMode] = useState<'week' | 'month' | 'agenda'>(() => (localStorage.getItem('kea.cal.mode') as any) || 'week');
  useEffect(() => {
    try {
      localStorage.setItem('kea.cal.mode', mode);
    } catch {}
  }, [mode]);
  const month = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const weekStart = addDays(anchor, -((anchor.getDay() + 6) % 7));
  // Month: six school weeks (Monday to Sunday) from the Monday on or before the 1st. Week: Monday to Sunday.
  const start = mode === 'week' ? weekStart : addDays(month, -((month.getDay() + 6) % 7));
  const end = mode === 'week' ? addDays(weekStart, 6) : addDays(start, 41);
  const items = useItems(iso(start), iso(end), courseId);
  const shift = (n: number) => setAnchor(mode === 'week' ? addDays(anchor, 7 * n) : new Date(anchor.getFullYear(), anchor.getMonth() + n, 1));
  const title = mode === 'week' ? `${shortDate(iso(weekStart))} – ${shortDate(iso(addDays(weekStart, 6)))}, ${weekStart.getFullYear()}` : month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  return (
    <div className={`sch-page wide ${courseId ? 'embedded' : ''}`}>
      <div className="cal-bar">
        {!courseId && <h1 className="sch-title">Calendar</h1>}
        <div className="cal-nav">
          <button className="icon-btn sm" onClick={() => shift(-1)} title="Previous">
            <ChevronLeft size={17} />
          </button>
          <span className="cal-month">{title}</span>
          <button className="icon-btn sm" onClick={() => shift(1)} title="Next">
            <ChevronRight size={17} />
          </button>
          <button className="btn sm" onClick={() => setAnchor(new Date())}>
            Today
          </button>
        </div>
        <div className="cal-tools">
          <ColorsMenu ctx={ctx} />
          <div className="seg-mini">
            {(
              [
                ['week', 'Week'],
                ['month', 'Month'],
                ['agenda', 'List']
              ] as const
            ).map(([id, label]) => (
              <button key={id} className={mode === id ? 'on' : ''} onClick={() => setMode(id)}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
      {!items ? (
        <Loading />
      ) : mode === 'week' ? (
        <WeekGrid ctx={ctx} items={items} start={weekStart} showCourse={!courseId} />
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
        <MonthGrid ctx={ctx} items={items} start={start} month={month} showCourse={!courseId} />
      )}
      <Legend ctx={ctx} />
    </div>
  );
}

function Legend({ ctx }: { ctx: Ctx }) {
  if (ctx.colors.by === 'class')
    return (
      <div className="cal-legend">
        {ctx.courses.map((c) => (
          <span key={c.id}>
            <span className="sch-dot" style={{ background: ctx.colors.course(c.id) }} /> {c.code}
          </span>
        ))}
      </div>
    );
  return (
    <div className="cal-legend">
      {CATEGORIES.filter((c) => c.id !== 'reading').map((c) => (
        <span key={c.id}>
          <span className="sch-dot" style={{ background: ctx.colors.type(c.types[0]) }} /> {c.label}
        </span>
      ))}
    </div>
  );
}

/** One week with an hour grid: class meetings as blocks at their times, due work at the top of each day. */
function WeekGrid({ ctx, items, start, showCourse }: { ctx: Ctx; items: ScholarItem[]; start: Date; showCourse: boolean }) {
  const days = Array.from({ length: 7 }, (_, d) => iso(addDays(start, d)));
  const t = today();
  const timed = items.filter((i) => i.start && i.type !== 'weekly_reading');
  // The hours shown: 8 am to 6 pm, stretched to fit the week's classes.
  const first = Math.min(8, ...timed.map((i) => Math.floor(minutes(i.start!) / 60)));
  const last = Math.max(18, ...timed.map((i) => Math.ceil(minutes(i.end || i.start!) / 60) + (i.end ? 0 : 1)));
  const HOUR = 48;
  const banners = items.filter((i) => i.type === 'weekly_reading');
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  return (
    <div className="wk">
      {banners.length > 0 && (
        <div className="wk-banners">
          {banners.map((b) => (
            <button key={b.id} className="cal-banner" style={{ background: `${ctx.colors.course(b.courseId)}22`, color: ctx.colors.course(b.courseId) }} onClick={() => ctx.open(b)} title={b.title}>
              {showCourse && <b>{b.courseCode}</b>} {b.readings.length ? b.readings.map((r) => r.chapter.replace('Chapter ', 'Ch ')).join(', ') : b.title}
            </button>
          ))}
        </div>
      )}
      <div className="wk-head">
        <div />
        {days.map((d) => (
          <div key={d} className={`wk-dow ${d === t ? 'today' : ''}`}>
            <span>{parse(d).toLocaleDateString(undefined, { weekday: 'short' })}</span>
            <b>{parse(d).getDate()}</b>
          </div>
        ))}
      </div>
      <div className="wk-due">
        <div className="wk-gutter">Due</div>
        {days.map((d) => (
          <div key={d} className={`wk-due-day ${d === t ? 'today' : ''}`}>
            {items
              .filter((i) => i.date === d && !i.start && i.type !== 'weekly_reading')
              .map((i) => (
                <button key={i.id} className={`wk-chip ${isDone(i) ? 'done' : ''} ${isMissing(i) ? 'missing' : ''}`} style={{ ['--kc' as any]: ctx.colors.item(i) }} onClick={() => ctx.open(i)} title={`${i.courseCode} · ${TYPE_LABEL[i.type] || i.type}: ${i.title}${i.due ? ` · due ${clock(i.due)}` : ''}`}>
                  {isMissing(i) && <AlertTriangle size={11} />}
                  {showCourse && <b>{i.courseCode}</b>} {i.title}
                </button>
              ))}
          </div>
        ))}
      </div>
      <div className="wk-body" style={{ height: (last - first) * HOUR }}>
        <div className="wk-hours">
          {Array.from({ length: last - first }, (_, h) => (
            <div key={h} style={{ height: HOUR }}>
              {new Date(2000, 0, 1, first + h).toLocaleTimeString(undefined, { hour: 'numeric' })}
            </div>
          ))}
        </div>
        {days.map((d) => (
          <div key={d} className={`wk-col ${d === t ? 'today' : ''}`}>
            {Array.from({ length: last - first }, (_, h) => (
              <div key={h} className="wk-line" style={{ top: h * HOUR }} />
            ))}
            {d === t && nowMin >= first * 60 && nowMin <= last * 60 && <div className="wk-now" style={{ top: ((nowMin - first * 60) / 60) * HOUR }} />}
            {timed
              .filter((i) => i.date === d)
              .map((i) => {
                const s = minutes(i.start!);
                const e = i.end ? minutes(i.end) : s + 50;
                return (
                  <button
                    key={i.id}
                    className={`wk-block ${i.done ? 'done' : ''}`}
                    style={{ top: ((s - first * 60) / 60) * HOUR, height: Math.max(22, ((e - s) / 60) * HOUR - 2), ['--kc' as any]: ctx.colors.item(i) }}
                    onClick={() => ctx.open(i)}
                    title={`${i.courseCode} · ${TYPE_LABEL[i.type] || i.type}: ${i.title}`}
                  >
                    <span className="wk-block-title">
                      {showCourse && <b>{i.courseCode} </b>}
                      {TYPE_LABEL[i.type] || i.type}
                    </span>
                    <span className="wk-block-sub">{i.title.replace(/^.*?(Lecture|Lab)\s*[—–-]\s*/, '')}</span>
                    <span className="wk-block-sub">
                      {clock(i.start)}
                      {i.end ? `–${clock(i.end)}` : ''}
                      {i.location && i.location !== 'Online' ? ` · ${shortRoom(i.location)}` : ''}
                    </span>
                  </button>
                );
              })}
          </div>
        ))}
      </div>
    </div>
  );
}

function MonthGrid({ ctx, items, start, month, showCourse }: { ctx: Ctx; items: ScholarItem[]; start: Date; month: Date; showCourse: boolean }) {
  const t = today();
  const weeks = Array.from({ length: 6 }, (_, w) => Array.from({ length: 7 }, (_, d) => iso(addDays(start, w * 7 + d))));
  return (
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
                  <button key={b.id} className="cal-banner" style={{ background: `${ctx.colors.course(b.courseId)}22`, color: ctx.colors.course(b.courseId) }} onClick={() => ctx.open(b)} title={b.title}>
                    {showCourse && <b>{b.courseCode}</b>} {b.readings.length ? b.readings.map((r) => r.chapter.replace('Chapter ', 'Ch ')).join(', ') : b.title}
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
                        className={`cal-item ${isDone(i) ? 'done' : ''} ${TEST.has(i.type) ? 'test' : ''} ${isMissing(i) ? 'missing' : ''}`}
                        onClick={() => ctx.open(i)}
                        title={`${i.courseCode} · ${TYPE_LABEL[i.type] || i.type}: ${i.title}`}
                      >
                        <span className="sch-dot" style={{ background: ctx.colors.item(i) }} />
                        {i.start && <span className="cal-item-time">{clock(i.start).replace(':00', '').replace(' ', '').toLowerCase()}</span>}
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
  );
}

// ---------- One class ----------
function ClassView({ ctx, courseId }: { ctx: Ctx; courseId: string }) {
  const version = useScholar((s) => s.version);
  const [c, setC] = useState<ScholarCourseDetail | null>(null);
  const [tab, setTab] = useState<'week' | 'calendar' | 'textbook' | 'grades' | 'study'>('week');
  const [grades, setGrades] = useState<ScholarGrades | null>(null);
  useEffect(() => {
    let live = true;
    api.scholar.course(courseId).then((r) => {
      if (!live) return;
      setC(r);
      if (r) api.scholar.grades(r.id, r.code).then((g) => live && setGrades(g));
    });
    return () => {
      live = false;
    };
  }, [courseId, version]);
  useEffect(() => setTab('week'), [courseId]);
  const items = useItems(iso(addDays(new Date(), -28)), iso(addDays(new Date(), 20)), courseId);
  if (!c) return <Loading />;
  const missing = (items || []).filter((i) => isMissing(i));
  const upcoming = (items || []).filter((i) => i.date >= today() && i.type !== 'weekly_reading' && !missing.includes(i) && !isUnconfirmed(i));
  return (
    <div className="sch-page">
      <div className="cls-head">
        <span className="cls-color" style={{ background: ctx.colors.course(c.id) }} />
        <div className="cls-head-text">
          <h1 className="sch-title">
            {c.code} <span className="cls-name">{c.name}</span>
          </h1>
          <div className="cls-facts">
            {c.term && <span>{c.term}</span>}
            {c.delivery && <span>{c.delivery}</span>}
            {c.instructor && (
              <span>
                <GraduationCap size={13} /> {c.instructor}
              </span>
            )}
            {c.contact && (
              <span className="cls-contact" title="Instructor's contact">
                <Mail size={13} /> {c.contact}
              </span>
            )}
          </div>
        </div>
        {grades?.final && (grades.final.percent != null || grades.final.shown) && (
          <button className="grade-big" onClick={() => setTab('grades')} title="Your overall grade">
            <span>{grades.final.percent != null ? `${grades.final.percent}%` : grades.final.shown}</span>
            <small>{grades.final.percent != null && grades.final.shown && !grades.final.shown.includes('%') ? grades.final.shown : 'Grade'}</small>
          </button>
        )}
        {c.url && (
          <button className="btn sm" onClick={() => openLink(c.url!)}>
            <ExternalLink size={13} /> Class site
          </button>
        )}
      </div>
      <ClassRules code={c.code} />
      <SyllabusMap code={c.code} />
      <div className="cls-tabs">
        {(
          [
            ['week', 'Coming up'],
            ['textbook', 'Textbook'],
            ['calendar', 'Calendar'],
            ['grades', 'Grades'],
            ['study', 'Practice']
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
            {missing.length > 0 && (
              <section className="miss-box">
                <div className="miss-head static">
                  <AlertTriangle size={16} /> <b>{missing.length} missing</b>
                </div>
                <div className="sch-list">
                  {missing.map((i) => (
                    <ItemRow key={i.id} ctx={ctx} it={i} showCourse={false} showDate />
                  ))}
                </div>
              </section>
            )}
            {items
              .filter((i) => i.type === 'weekly_reading' && (i.dateEnd || i.date) >= today())
              .slice(0, 2)
              .map((b) => (
                <ReadingCard key={b.id} ctx={ctx} b={b} showCourse={false} />
              ))}
            <div className="sch-list" style={{ marginTop: 14 }}>
              {upcoming.map((i) => (
                <div key={i.id} className="cls-dated">
                  <span className="cls-date">{dayName(i.date)}</span>
                  <ItemRow ctx={ctx} it={i} showCourse={false} />
                </div>
              ))}
            </div>
            {c.portal.length > 0 && (
              <section>
                <h2 className="sch-h2">Class site</h2>
                <div className="ln-list row">
                  {c.portal
                    .filter((p) => ['home', 'content', 'grades', 'announcements', 'dropbox', 'quizzes', 'discussions', 'external_home', 'external_gradebook'].includes(p.kind))
                    .map((p) => (
                      <button key={p.url} className="ln-main pill" onClick={() => openLink(p.url)}>
                        <ExternalLink size={13} /> {p.label || p.kind.replace('external_', '').replace(/^\w/, (x) => x.toUpperCase())}
                      </button>
                    ))}
                </div>
              </section>
            )}
          </>
        ))}
      {tab === 'textbook' && <Textbook c={c} />}
      {tab === 'grades' &&
        (!grades || !grades.items.length ? (
          <div className="sch-empty">No grades yet. They appear after Kea's next check of your class site.</div>
        ) : (
          <div className="gr-list">
            {grades.items.map((g) => (
              <div key={g.id} className="gr-row">
                <div className="gr-main">
                  <div className="gr-title">{g.title}</div>
                  {g.comment && <div className="gr-comment">{g.comment}</div>}
                </div>
                <div className={`gr-score ${g.percent != null && g.percent < 60 ? 'low' : g.percent != null && g.percent >= 90 ? 'high' : ''}`}>
                  <b>{g.percent != null ? `${g.percent}%` : g.shown}</b>
                  {g.score && <span className="muted">{g.score}</span>}
                </div>
              </div>
            ))}
            {grades.url && (
              <button className="btn sm" style={{ alignSelf: 'flex-start', marginTop: 8 }} onClick={() => openLink(grades.url)}>
                <ExternalLink size={13} /> Grades on the class site
              </button>
            )}
          </div>
        ))}
      {tab === 'calendar' && <CalendarView ctx={ctx} courseId={c.id} />}
      {tab === 'study' && <ResourcesView courses={ctx.courses} courseId={c.id} />}
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
              {ch.summary && <div className="rd-summary">{ch.summary}</div>}
              <div className="muted tb-meta">{ch.pdf ? `${ch.pdf.pages || '?'} pages` : 'Being written'}</div>
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
            {ch.pdf && (
              <button
                className="btn sm"
                onClick={(e) => {
                  e.stopPropagation();
                  quizChapter(c.id, ch.label);
                }}
                title="Quiz yourself on this chapter's saved questions"
              >
                <ClipboardCheck size={14} /> Quiz me
              </button>
            )}
          </div>
          {open === ch.label && (
            <div className="tb-detail">
              {ch.readingUrl && (
                <button className="btn sm" onClick={() => openLink(ch.readingUrl!)}>
                  <ExternalLink size={13} /> {ch.readingLabel || 'Class reading'}
                </button>
              )}
              <PracticeBox courseId={c.id} chapters={[ch.label]} title={`Practice ${ch.label}`} />
              {ch.pdf && <RewriteButton code={c.code} chapter={ch.label} />}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** Write a chapter's textbook again under Kea's current guidelines (Claude, on the device that scans); asks once first. */
function RewriteButton({ code, chapter }: { code: string; chapter: string }) {
  const [sure, setSure] = useState(false);
  const go = async () => {
    if (!sure) return setSure(true);
    setSure(false);
    try {
      await api.scholar.run('study', `rewrite ${code} ${chapter}`);
      toast(`Rewriting ${chapter}. It takes about 5 minutes; follow it under Scans. The new chapter replaces this one.`, 'success');
    } catch (err: any) {
      toast(err?.message || 'Kea couldn’t start the rewrite.', 'error');
    }
  };
  return (
    <button className="btn sm" onClick={go} onBlur={() => setSure(false)} title="Write this chapter again with Kea’s latest guidelines, using your class’s review sheets and test focus. Uses your Claude account.">
      <RefreshCw size={13} /> {sure ? 'Rewrite with Claude? Click again' : 'Rewrite chapter'}
    </button>
  );
}

// ---------- The item panel ----------
function ItemPanel({ ctx, item: it, onClose }: { ctx: Ctx; item: ScholarItem; onClose(): void }) {
  const links = useMemo(() => [...it.links, ...it.weeklyLinks], [it]);
  // (Some items' only description is their own title: nothing more to say.)
  const instructions = [it.description, it.sourceWording].find((t) => t && t.trim() !== it.title.trim()) || '';
  // What a test is like ("Exam format: essay, multiple choice…"); the rest of its study focus stays internal and goes
  // into practice exams and flashcards instead of a wall of topics here.
  const format = it.studyFocus.find((f) => /^(exam |test |quiz )?format\b/i.test(f));
  const practice = TEST.has(it.type) || (it.readings.length > 0 && TODO.has(it.type) && !['administrative_deadline', 'other_deadline'].includes(it.type));
  const missing = isMissing(it);
  const quick = primaryLink(it);
  const cat = categoryOf(it.type);
  // Handing in a file from here: pick it, and Kea opens this assignment's folder page with the file attached.
  const handInFile = async () => {
    const files = await api.openDialog({ title: 'Choose the file to hand in', filters: [{ name: 'Documents', extensions: ['pdf', 'docx', 'doc', 'pptx', 'xlsx', 'png', 'jpg', 'jpeg', 'txt'] }] }).catch(() => []);
    const file = files?.[0]?.path;
    if (!file) return;
    const targets = await api.scholar.handInTargets();
    const course = targets.find((t) => t.code === it.courseCode);
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const folder = course?.folders.find((f) => norm(f.name) === norm(it.title)) || course?.folders.find((f) => norm(f.name).includes(norm(it.title)) || norm(it.title).includes(norm(f.name)));
    if (!course || !folder) return toast('Kea couldn’t match this to an assignment folder. Use Open hand-in page instead, or the Hand in button on the open PDF.', 'error');
    const r = await api.scholar.handIn(course.ou, folder.id, file);
    toast(r.attached ? 'Your file is attached on the hand-in page. Check it there, then press Submit.' : 'The hand-in page is open. Add your file there, then press Submit.', 'success');
  };
  return (
    <aside className="sch-panel" style={{ ['--kc' as any]: ctx.colors.item(it) }}>
      <div className="sch-panel-head">
        <span className="sch-chip" style={{ borderColor: ctx.colors.course(it.courseId), color: ctx.colors.course(it.courseId) }}>
          {it.courseCode}
        </span>
        <span className="sch-type" style={{ color: ctx.colors.type(it.type) }} title={cat.label}>
          {TYPE_LABEL[it.type] || it.type}
        </span>
        <button className="icon-btn sm" onClick={onClose} title="Close">
          <X size={16} />
        </button>
      </div>
      <h2 className="sch-panel-title">{it.title}</h2>
      {missing && (
        <div className="miss-banner">
          <AlertTriangle size={15} /> Missing: this was due {dayName(it.date).toLowerCase()}
          {it.due ? ` at ${clock(it.due)}` : ''}, and your class site shows nothing handed in.
        </div>
      )}
      <div className="pn-facts">
        <div>
          <Clock size={14} />
          <span>
            {dayName(it.date)}
            {it.dateEnd && it.dateEnd !== it.date ? ` – ${shortDate(it.dateEnd)}` : ''}
            {it.due ? `, due ${clock(it.due)}` : it.start ? `, ${clock(it.start)}${it.end ? `–${clock(it.end)}` : ''}` : ''}
            {it.points ? ` · ${it.points} points` : ''}
          </span>
        </div>
        {it.location && (
          <div>
            <MapPin size={14} />
            <span>
              {it.location}
              {it.locationUsual && <span className="muted"> (usual room)</span>}
            </span>
          </div>
        )}
        {it.module && (
          <div>
            <FolderInput size={14} />
            <span>{it.module}</span>
          </div>
        )}
      </div>
      <div className="pn-actions">
        {TODO.has(it.type) && (
          <button className={`btn ${isDone(it) ? '' : 'tonal'}`} onClick={() => ctx.toggleDone(it)}>
            {isDone(it) ? <CheckCircle2 size={16} /> : <Circle size={16} />} {it.done ? 'Done' : it.handIn === 'graded' ? 'Graded' : it.handIn === 'submitted' ? 'Handed in' : 'Mark as done'}
          </button>
        )}
        {quick && (
          <button className="btn primary" onClick={() => openLink(quick.url)}>
            <quick.icon size={15} /> {quick.label === 'Hand in' ? 'Open hand-in page' : `Open ${quick.label}`}
          </button>
        )}
        {quick?.label === 'Hand in' && (
          <button className="btn" onClick={handInFile} title="Choose a file; Kea attaches it on the hand-in page, and you press Submit there">
            <FileText size={15} /> Hand in a file…
          </button>
        )}
      </div>
      {format && <p className="pn-format">{format.replace(/^(exam |test |quiz )?format:\s*/i, 'Format: ')}</p>}
      {it.readings.length > 0 && (
        <section>
          <div className="tb-h">{TEST.has(it.type) ? 'Covers' : 'Reading'}</div>
          {it.readings.map((r) => (
            <div key={r.chapter} className="sch-reading">
              <div className="sch-chapter">
                <span>
                  <b>{r.chapter}</b>
                  {r.title ? `: ${r.title}` : ''}
                </span>
                {r.pdf ? (
                  <button className="btn sm tonal" onClick={() => openReading(r)}>
                    <BookOpen size={14} /> Read
                  </button>
                ) : (
                  <span className="muted sch-nopdf">Being written</span>
                )}
              </div>
              {r.summary && <div className="rd-summary">{r.summary}</div>}
            </div>
          ))}
        </section>
      )}
      {practice && <PracticeBox courseId={it.courseId} itemId={it.id} />}
      {instructions && (
        <section>
          <div className="tb-h">Instructions</div>
          <p className="sch-desc">{instructions}</p>
        </section>
      )}
      <LinkGroups links={links} />
      <ItemHistory key={it.id} id={it.id} />
      {(it.instructor || it.contact) && (
        <section>
          <div className="tb-h">Contact</div>
          <div className="pn-contact">
            {it.instructor && <span>{it.instructor}</span>}
            {it.contact && (
              <span className="muted pn-select" title="Select to copy">
                {it.contact}
              </span>
            )}
          </div>
        </section>
      )}
    </aside>
  );
}

// ---------- Adding a class ----------
/** Before school mode: an account with a verified email. */
function AccountStep() {
  return (
    <div className="acct-step">
      <h3>First, your Kea account</h3>
      <p className="muted">School mode needs an account with a verified email. Use the email of your Claude account (or a OneDrive or Google account signed in here), and Kea verifies it at once.</p>
      <AccountCard />
    </div>
  );
}

function AddClass({ first }: { first: boolean }) {
  const [account] = useAccount();
  const [gate, setGate] = useState(false);
  const [other, setOther] = useState(false);
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
          <div className="add-desc">Kea keeps your assignments, tests, readings, announcements and a weekly textbook up to date from your class site.</div>
        </button>
        <button className="add-card" onClick={() => setOther(true)}>
          <Monitor size={26} />
          <div className="add-name">From another device</div>
          <div className="add-desc">Already use Kea on another computer? Bring its classes here through your OneDrive or Google Drive. Only one device scans, so nothing uses your Claude plan twice.</div>
        </button>
      </div>
      {other && (
        <div className="gate">
          <h2>Bring in classes from another device</h2>
          <p>Kea looks in OneDrive and Google Drive on this computer for the classes your other device shares. Both need the same drive account, and Kea open on the other one.</p>
          {account?.verified ? <FromAnotherDevice onDone={() => useScholar.getState().set({ view: { name: 'week' } })} /> : <AccountStep />}
        </div>
      )}
      {gate && (
        <div className="gate">
          <h2>Connect your Claude account to scan your classes</h2>
          <p>
            A class's first scan reads its syllabus, modules, assignments and tests once. Kea uses <b>Claude</b> for that, through your own Claude account, because it needs judgment
            to find everything and get dates exactly right. It also writes each week's textbook chapter from what your class covers.
          </p>
          <ul>
            <li>After the first scan, Kea checks your classes itself every morning and only asks Claude about classes where something changed.</li>
            <li>Announcements are checked every half hour by Kea alone, with no Claude usage.</li>
            <li>Kea signs in to your class site with the details you save in Kea. It only shows you a window if your school asks for a code.</li>
            <li>
              <b>It uses your Claude plan's usage.</b> A first scan of a class is the biggest; daily checks are small, and quiet days use none.
            </li>
            <li>Without Claude, this stays off rather than guessing. Library classes work without it.</li>
          </ul>
          {account?.verified ? (
            <SetupWizard onDone={() => useScholar.getState().set({ view: { name: 'scans' } })} />
          ) : (
            <AccountStep />
          )}
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
