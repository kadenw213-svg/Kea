import { useEffect, useMemo, useRef, useState } from 'react';
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
  Globe,
  MoreHorizontal,
  Upload,
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
import { useSettings, useThemeDark } from '../../lib/settings';
import { gradeColor } from '../../lib/themes';
import { toast, prompt } from '../../store';
import { useScholar, reloadScholar, bumpInbox, ScholarView } from './scholarStore';
import { Picker as HandInPicker } from './HandIn';
import { MenuButton } from '../Popover';
import { SetupWizard } from './Setup';
import { ScansView, FromAnotherDevice } from './ScansView';
import { CATEGORIES, Colors, LinkGroups, TODO, categoryOf, isDone, isMissing, isUnconfirmed, openLink, primaryLink, assignmentDoc, setClassColor, setTypeColor, useColors } from './kinds';
import { StudyPlayer } from './Study';
import { ResourcesView } from './Resources';
import { MessagesView } from './Messages';
import { ChangesBox, ClassRules, SyllabusMap, ItemHistory } from './History';
import { openStudyHub } from './StudyHub';
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
  const { view, version, inboxTick, set, study } = useScholar();
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
  useEffect(() => api.scholar.onOpenMail((id, reply) => useScholar.getState().set({ view: { name: 'messages', id, reply } })), []);
  useEffect(() => {
    const inbox = () =>
      api.scholar
        .inbox()
        .then((n) => setUnread(n.filter((x) => !x.read).length))
        .catch(() => {});
    api.scholar
      .runStatus()
      .then((s) => setScanning(!!s.running))
      .catch(() => {});
    inbox();
    const offs = [api.scholar.onRun((r) => setScanning(r.running)), api.scholar.onNews(inbox)];
    return () => offs.forEach((f) => f());
    // (inboxTick: something was read or deleted in the Inbox or Messages, so the count is read again.)
  }, [version, inboxTick]);
  // The open item, read again after a scan or a change, so its date, hand-in state and Missing banner are current.
  const itemRef = useRef(item);
  itemRef.current = item;
  useEffect(() => {
    const cur = itemRef.current;
    if (!version || !cur) return;
    let live = true;
    // (Its date may have moved: look well around the date it had.)
    const day = parse(cur.date);
    api.scholar
      .items({ from: iso(addDays(day, -120)), to: iso(addDays(day, 120)), courseId: cur.courseId })
      .then((list) => {
        const fresh = list.find((x) => x.id === cur.id);
        if (live && fresh) setItem((now) => (now?.id === fresh.id ? fresh : now));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
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
      <MessagesView courses={ctx.courses} openId={view.id} reply={view.reply} />
    ) : view.name === 'inbox' ? (
      <InboxView ctx={ctx} />
    ) : view.name === 'calendar' ? (
      <CalendarView ctx={ctx} />
    ) : view.name === 'class' ? (
      <ClassView ctx={ctx} courseId={view.courseId} startTab={view.tab} />
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
                {grades[c.id] != null && <GradeText className="sch-grade" percent={grades[c.id]!} />}
              </span>
              <span className="sch-cname">{c.name}</span>
            </span>
            {c.dueThisWeek > 0 && <span className="sch-badge" title={`${c.dueThisWeek} due this week`}>{c.dueThisWeek}</span>}
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
            {typeLabel(it)}
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
          {it.opensAt && <span className="opens-tag" title={`Opens on your class site ${opensText(it.opensAt)}`}>Opens {new Date(it.opensAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>}
          {!it.done && (it.handIn === 'graded' || it.handIn === 'submitted') && <span className="hand-tag">{it.handIn === 'graded' ? 'Graded' : 'Handed in'}</span>}
        </div>
      </div>
      <div className="sch-row-actions">
        {quick && !it.opensAt && (
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
        {it.readings.length > 0 && !['administrative_deadline', 'break', 'no_class'].includes(it.type) && (
          <button
            className="btn sm"
            title={`Study ${it.readings.map((r) => r.chapter).join(', ')}: practice exam, flashcards, Learn and Match`}
            onClick={(e) => {
              e.stopPropagation();
              openStudyHub({ courseId: it.courseId, code: it.courseCode, title: it.title, chapters: it.readings.map((r) => r.chapter), itemId: TEST.has(it.type) ? it.id : undefined });
            }}
          >
            <ClipboardCheck size={14} /> Study
          </button>
        )}
      </div>
    </div>
  );
}

/** "Mon, Oct 26, 12:01 AM": when locked work opens. */
const opensText = (at: string) => new Date(at).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** An item's kind in words (a lab report filed as a lab handout reads "Lab report"). */
const typeLabel = (it: ScholarItem) => (it.type === 'lab_handout' && /\breport\b/i.test(it.title) ? 'Lab report' : TYPE_LABEL[it.type] || it.type);

/**
 * Today's date ("2026-10-24"), which changes at midnight while the screen stays open (a timer to the next midnight,
 * and a look when the window comes back, in case the computer slept through it).
 */
function useToday() {
  const [day, setDay] = useState(today);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const check = () => setDay((d) => (d === today() ? d : today()));
    const arm = () => {
      clearTimeout(t);
      const now = new Date();
      const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
      t = setTimeout(() => (check(), arm()), Math.min(next.getTime() - now.getTime(), 2 ** 31 - 1));
    };
    const onFocus = () => (check(), arm());
    arm();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      clearTimeout(t);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, []);
  return day;
}

// ---------- This week ----------
function WeekView({ ctx }: { ctx: Ctx }) {
  const from = useToday();
  const to = iso(addDays(parse(from), 13));
  const items = useItems(from, to);
  const past = useItems(iso(addDays(parse(from), -28)), iso(addDays(parse(from), -1)));
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
  const daySection = (d: string) => (
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
  );
  return (
    <div className="sch-page">
      <h1 className="sch-title">This week</h1>
      <p className="sch-sub">
        {open ? `${open} thing${open === 1 ? '' : 's'} due in the next 14 days.` : 'Nothing due in the next 14 days.'}
        {next ? ` Next: ${next.courseCode} ${TYPE_LABEL[next.type]?.toLowerCase() || ''} at ${clock(next.start)}${next.location && next.location !== 'Online' ? ` in ${shortRoom(next.location)}` : ''}.` : ''}
      </p>
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
            <b>{unconfirmed.length} done? Check {unconfirmed.length === 1 ? 'it' : 'them'} off</b>
            <span className="muted">Past items your class site can't confirm (no grade or hand-in folder). Check off what you did.</span>
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
      {days.filter((d) => d === from).map(daySection)}
      {banners.length > 0 && (
        <section>
          <h2 className="sch-h2">Reading and topics</h2>
          <div className="sch-banners">
            {banners.map((b) => (
              <ReadingCard key={b.id} ctx={ctx} b={b} />
            ))}
          </div>
        </section>
      )}
      {days.filter((d) => d !== from).map(daySection)}
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
        {showCourse && (
          <button
            className="link-btn sm wbw-all"
            title="Every week of this class: its topics and what's due"
            onClick={(e) => {
              e.stopPropagation();
              useScholar.getState().set({ view: { name: 'class', courseId: b.courseId, tab: 'weeks' } });
            }}
          >
            All weeks
          </button>
        )}
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
              <span className="sch-chapter-btns">
                <button
                  className="btn sm tonal"
                  onClick={(e) => {
                    e.stopPropagation();
                    openReading(r);
                  }}
                >
                  <BookOpen size={14} /> Read
                </button>
                <button
                  className="btn sm"
                  title="Review, practice exams, flashcards, Learn and Match for this chapter"
                  onClick={(e) => {
                    e.stopPropagation();
                    openStudyHub({ courseId: b.courseId, code: b.courseCode, title: `${r.chapter}${r.title ? `: ${r.title}` : ''}`, chapters: [r.chapter] });
                  }}
                >
                  <ClipboardCheck size={14} /> Study
                </button>
              </span>
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
  const [loadError, setLoadError] = useState('');
  const load = () =>
    api.scholar
      .inbox()
      .then((r) => (setItems(r), setLoadError('')))
      .catch((err) => setLoadError(String(err?.message || err)));
  useEffect(() => {
    load();
    return api.scholar.onNews(() => load());
  }, [version]);
  if (!items && loadError)
    return (
      <div className="sch-page">
        <h1 className="sch-title">Inbox</h1>
        <div className="sch-empty">
          <AlertTriangle size={26} />
          <div>Kea couldn’t read your Inbox: {loadError}</div>
          <button className="btn sm" onClick={() => (setLoadError(''), load())}>
            <RefreshCw size={13} /> Try again
          </button>
        </div>
      </div>
    );
  if (!items) return <Loading />;
  const codes = [...new Set(items.map((i) => i.course).filter(Boolean))].sort();
  const shown = items.filter((i) => filter === 'all' || (filter === 'unread' ? !i.read : i.course === filter));
  const color = (code: string) => {
    const c = ctx.courses.find((x) => x.code === code);
    return c ? ctx.colors.course(c.id) : 'var(--text-3)';
  };
  const read = (i: ScholarInboxItem) => {
    if (!i.read) {
      api.scholar
        .markInboxRead([i.id])
        .then(bumpInbox)
        .catch(() => {});
      setItems(items.map((x) => (x.id === i.id ? { ...x, read: true } : x)));
    }
  };
  // Deleted messages stay deleted: Kea remembers them, so the next look at the class site doesn't bring them back.
  const remove = (ids: string[]) => {
    if (!ids.length) return;
    api.scholar
      .deleteInbox(ids)
      .then(bumpInbox)
      .catch((err) => toast(String(err?.message || err), 'error'));
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
        <span className="ml-top-gap" />
        <button className="icon-btn" onClick={checkNow} disabled={checking} title="Check your class site for new messages now">
          {checking ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}
        </button>
        {confirmRead ? (
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
          (items.some((i) => !i.read) || readShown.length > 0) && (
            <MenuButton
              align="right"
              title="More"
              button={() => (
                <button className="icon-btn">
                  <MoreHorizontal size={16} />
                </button>
              )}
            >
              {(close) => (
                <>
                  {items.some((i) => !i.read) && (
                    <button className="menu-item" onClick={() => (api.scholar.markInboxRead().then(bumpInbox).catch(() => {}), setItems(items.map((x) => ({ ...x, read: true }))), close())}>
                      <CheckCircle2 size={14} /> Mark all read
                    </button>
                  )}
                  {readShown.length > 0 && (
                    <button className="menu-item" onClick={() => (setConfirmRead(true), close())}>
                      <Trash2 size={14} /> Delete read messages
                    </button>
                  )}
                </>
              )}
            </MenuButton>
          )
        )}
      </div>
      <p className="sch-sub">Announcements, grades, feedback and class-site messages, as they happen, and anything that needs you.</p>
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
                    {i.percent != null ? <> · <GradeText percent={i.percent} /></> : ''}
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
                <button key={i.id} className={`wk-chip ${isDone(i) ? 'done' : ''} ${isMissing(i) ? 'missing' : ''}`} style={{ ['--kc' as any]: ctx.colors.item(i) }} onClick={() => ctx.open(i)} title={`${i.courseCode} · ${typeLabel(i)}: ${i.title}${i.due ? ` · due ${clock(i.due)}` : ''}`}>
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
                    title={`${i.courseCode} · ${typeLabel(i)}: ${i.title}`}
                  >
                    <span className="wk-block-title">
                      {showCourse && <b>{i.courseCode} </b>}
                      {typeLabel(i)}
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
                        title={`${i.courseCode} · ${typeLabel(i)}: ${i.title}`}
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
/**
 * Every week of the class, start to end: what it covers (each chapter's topics, with the textbook and Study) and
 * everything due in it. This week first and open; the weeks before it folded at the bottom.
 */
function WeeksView({ ctx, c }: { ctx: Ctx; c: ScholarCourseDetail }) {
  const items = useItems(iso(addDays(new Date(), -150)), iso(addDays(new Date(), 200)), c.id);
  const now = today();
  if (!items) return <Loading />;
  const weeks = items.filter((i) => i.type === 'weekly_reading').sort((a, b) => a.date.localeCompare(b.date));
  if (!weeks.length) return <div className="sch-empty">No weeks are built for this class yet. Kea builds them from the class schedule on its weekly update.</div>;
  const chapter = new Map(c.chapters.map((ch) => [ch.label, ch]));
  const end = (w: ScholarItem) => w.dateEnd || iso(addDays(new Date(`${w.date}T12:00`), 6));
  const due = (w: ScholarItem) => items.filter((i) => i.type !== 'weekly_reading' && i.type !== 'lecture' && i.date >= w.date && i.date <= end(w));
  const current = weeks.filter((w) => end(w) >= now);
  const past = weeks.filter((w) => end(w) < now).reverse();
  const week = (w: ScholarItem, open: boolean) => (
    <details key={w.id} className={`wbw-week ${w.date <= now && end(w) >= now ? 'now' : ''}`} open={open}>
      <summary>
        <b>
          {shortDate(w.date)} – {shortDate(end(w))}
        </b>
        {w.date <= now && end(w) >= now && <span className="wbw-now">This week</span>}
        <span className="muted">{w.readings.map((r) => r.chapter.replace(/^Chapter /, 'Ch ')).join(', ') || w.title}</span>
        <span className="muted wbw-count">{due(w).length ? `${due(w).length} due` : ''}</span>
      </summary>
      {w.readings.map((r) => {
        const ch = chapter.get(r.chapter);
        return (
          <div key={r.chapter} className="wbw-ch">
            <div className="wbw-ch-head">
              <span>
                <b>{r.chapter}</b>
                {r.title ? `: ${r.title}` : ''}
              </span>
              <span className="sch-chapter-btns">
                {r.pdf && (
                  <button className="btn sm tonal" onClick={() => openReading(r)}>
                    <BookOpen size={14} /> Read
                  </button>
                )}
                <button className="btn sm" onClick={() => openStudyHub({ courseId: c.id, code: c.code, title: r.title ? `${r.chapter}: ${r.title}` : r.chapter, chapters: [r.chapter] })}>
                  <ClipboardCheck size={14} /> Study
                </button>
              </span>
            </div>
            {ch?.sections?.length ? (
              <ul className="wbw-topics">
                {ch.sections.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            ) : ch?.objectives?.length ? (
              <ul className="wbw-topics">
                {ch.objectives.slice(0, 8).map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            ) : (
              r.summary && <div className="rd-summary">{r.summary}</div>
            )}
          </div>
        );
      })}
      {due(w).length > 0 && (
        <div className="sch-list wbw-due">
          {due(w).map((i) => (
            <ItemRow key={i.id} ctx={ctx} it={i} showCourse={false} showDate />
          ))}
        </div>
      )}
    </details>
  );
  return (
    <div className="wbw-weeks">
      {current.map((w, k) => week(w, k < 2))}
      {past.length > 0 && <h2 className="sch-h2">Earlier weeks</h2>}
      {past.map((w) => week(w, false))}
    </div>
  );
}

function ClassView({ ctx, courseId, startTab }: { ctx: Ctx; courseId: string; startTab?: 'weeks' }) {
  const version = useScholar((s) => s.version);
  // undefined while loading; null when there's no such class (removed, or another profile's).
  const [c, setC] = useState<ScholarCourseDetail | null | undefined>(undefined);
  const [loadError, setLoadError] = useState('');
  const [tab, setTab] = useState<'week' | 'weeks' | 'calendar' | 'textbook' | 'grades' | 'study'>(startTab || 'week');
  const [grades, setGrades] = useState<ScholarGrades | null>(null);
  useEffect(() => {
    let live = true;
    api.scholar
      .course(courseId)
      .then((r) => {
        if (!live) return;
        setC(r);
        setLoadError('');
        if (r)
          api.scholar
            .grades(r.id, r.code)
            .then((g) => live && setGrades(g))
            .catch(() => {});
      })
      .catch((err) => {
        if (!live) return;
        setLoadError(String(err?.message || err));
        setC((cur) => (cur === undefined ? null : cur));
      });
    return () => {
      live = false;
    };
  }, [courseId, version]);
  useEffect(() => setTab(startTab || 'week'), [courseId, startTab]);
  const day = useToday();
  const items = useItems(iso(addDays(parse(day), -28)), iso(addDays(parse(day), 20)), courseId);
  if (c === undefined) return <Loading />;
  if (!c)
    return (
      <div className="sch-page">
        <div className="sch-empty">
          <AlertTriangle size={26} />
          <div>{loadError ? `Kea couldn’t open this class: ${loadError}` : 'Class not found. It may have been removed, or it belongs to another profile.'}</div>
          <button className="btn sm" onClick={() => ctx.go({ name: 'week' })}>
            Back to This week
          </button>
        </div>
      </div>
    );
  const missing = (items || []).filter((i) => isMissing(i));
  const upcoming = (items || []).filter((i) => i.date >= day &&i.type !== 'weekly_reading' && !missing.includes(i) && !isUnconfirmed(i));
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
            <GradeText percent={grades.final.percent} text={grades.final.percent != null ? `${grades.final.percent}%` : grades.final.shown} />
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
            ['weeks', 'Week by week'],
            ['textbook', 'Textbook'],
            ['calendar', 'Calendar'],
            ['grades', 'Grades'],
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
      {tab === 'weeks' && <WeeksView ctx={ctx} c={c} />}
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
                <div className="gr-score">
                  <GradeText as="b" percent={g.percent} text={g.percent != null ? `${g.percent}%` : g.shown} />
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
                  openStudyHub({ courseId: c.id, code: c.code, title: `${ch.label}${ch.title ? `: ${ch.title}` : ''}`, chapters: [ch.label] });
                }}
                title="Review, practice exams, flashcards, Learn and Match for this chapter"
              >
                <ClipboardCheck size={14} /> Study
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

/**
 * The one assignment folder that is this item, or null when there isn't exactly one: the same name first, then the
 * same words with the same numbers ("Lab 1" is "Lab 1 Report", never "Lab 10 Report" or "Lab 11").
 */
function matchFolder<F extends { name: string }>(folders: F[], title: string): F | null {
  const words = (s: string) =>
    s
      .toLowerCase()
      .replace(/([a-z])(\d)/g, '$1 $2')
      .replace(/(\d)([a-z])/g, '$1 $2')
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      // ("02" is 2.)
      .map((x) => (/^\d+$/.test(x) ? String(Number(x)) : x));
  const norm = (s: string) => words(s).join(' ');
  const exact = folders.filter((f) => norm(f.name) === norm(title));
  if (exact.length) return exact.length === 1 ? exact[0] : null;
  const nums = (w: string[]) => w.filter((x) => /^\d+$/.test(x)).map(Number).join(',');
  const tw = words(title);
  const close = folders.filter((f) => {
    const fw = words(f.name);
    // Every number the same, in the same order.
    if (nums(fw) !== nums(tw)) return false;
    // Every word of the shorter name is a whole word of the longer one (and not only its numbers).
    const [short, long] = fw.length <= tw.length ? [fw, tw] : [tw, fw];
    return short.some((x) => !/^\d+$/.test(x)) && short.every((x) => long.includes(x));
  });
  return close.length === 1 ? close[0] : null;
}

// ---------- The item panel ----------
function ItemPanel({ ctx, item: it, onClose }: { ctx: Ctx; item: ScholarItem; onClose(): void }) {
  const links = useMemo(() => [...it.links, ...(it.platformLinks || []), ...it.weeklyLinks], [it]);
  // Each outside platform it's done on (Science Interactive, ALEKS), besides its hand-in page.
  const platforms = (it.platformLinks || []).filter((l) => l.url !== primaryLink(it)?.url);
  // (Some items' only description is their own title: nothing more to say.)
  // (Nor one that only repeats the title and the date: "Saturday, October 24, 2026 11:59 PM: <title> due".)
  const restOf = (t: string) =>
    t
      .replace(it.title, '')
      .replace(/\b(mon|tues|wednes|thurs|fri|satur|sun)day\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?|\b\d{1,4}\b|\b(am|pm|due)\b|[,:.\s-]/gi, '')
      .trim();
  const instructions = [it.description, it.sourceWording].find((t) => t && t.trim() !== it.title.trim() && restOf(t).length > 12) || '';
  // What a test is like ("Exam format: essay, multiple choice…"); the rest of its study focus stays internal and goes
  // into practice exams and flashcards instead of a wall of topics here.
  const format = it.studyFocus.find((f) => /^(exam |test |quiz )?format\b/i.test(f));
  // What the instructor said to know for it (besides its format), shown plainly.
  const toKnow = it.studyFocus.filter((f) => f !== format && f.trim());
  // Anything that covers chapters (an exam, an assignment, a lab, a lecture) can be studied.
  const practice = it.readings.length > 0 && !['administrative_deadline', 'break', 'no_class'].includes(it.type);
  const missing = isMissing(it);
  // Not open yet on the class site: its links lead to a locked page, so show when it opens instead.
  const quick = it.opensAt ? null : primaryLink(it);
  const doc = it.opensAt ? null : assignmentDoc(it);
  const cat = categoryOf(it.type);
  // Graded work with no hand-in page: say so, so a missing button doesn't look like a bug.
  const handsIn = TODO.has(it.type) && !['weekly_reading', 'lecture', 'reading'].includes(it.type);
  // Handing in a file from here: pick it, and Kea opens this assignment's folder page with the file attached.
  const handInFile = async () => {
    const files = await api.openDialog({ title: 'Choose the file to hand in', filters: [{ name: 'Documents', extensions: ['pdf', 'docx', 'doc', 'pptx', 'xlsx', 'png', 'jpg', 'jpeg', 'txt'] }] }).catch(() => []);
    const file = files?.[0]?.path;
    if (!file) return;
    try {
      const targets = await api.scholar.handInTargets();
      const course = targets.find((t) => t.code === it.courseCode);
      const folder = course ? matchFolder(course.folders, it.title) : null;
      // Not one clear folder: the student picks it, from this class's folders.
      if (!course || !folder) return setPickFile(file);
      const r = await api.scholar.handIn(course.ou, folder.id, file);
      toast(r.attached ? 'Your file is attached on the hand-in page. Check it there, then press Submit.' : 'The hand-in page is open. Add your file there, then press Submit.', 'success');
    } catch (err: any) {
      toast(`Kea couldn’t open the hand-in page: ${String(err?.message || err)}`, 'error');
    }
  };
  const [pickFile, setPickFile] = useState<string | null>(null);
  useEffect(() => setPickFile(null), [it.id]);
  return (
    <aside className="sch-panel" style={{ ['--kc' as any]: ctx.colors.item(it) }}>
      <div className="sch-panel-head">
        <span className="sch-chip" style={{ borderColor: ctx.colors.course(it.courseId), color: ctx.colors.course(it.courseId) }}>
          {it.courseCode}
        </span>
        <span className="sch-type" style={{ color: ctx.colors.type(it.type) }} title={cat.label}>
          {typeLabel(it)}
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
        {(it.platformLinks || []).length > 0 && (
          <div>
            <Globe size={14} />
            <span>Done on: {(it.platformLinks || []).map((l) => l.label.replace(/^Open /, '')).join(', ')}</span>
          </div>
        )}
        {handsIn && (
          <div>
            <Upload size={14} />
            <span>
              {it.opensAt ? (
                <b>Opens {opensText(it.opensAt)}</b>
              ) : quick && quick.label === 'Hand in' ? (
                'Hand in: the assignment folder on your class site'
              ) : (it.platformLinks || []).length && !/\b(pdf|notebook|report|upload|scan\w*)\b/i.test(it.title) ? (
                // (Work done on the platform is handed in there: ALEKS homework, an online quiz.)
                `Hand in: on ${(it.platformLinks || [])[0].label.replace(/^Open /, '')}`
              ) : quick && quick.label === 'Discussion' ? (
                'Hand in: post in the discussion (the button below opens its topic)'
              ) : quick && quick.label === 'Quiz' ? (
                'Taken on your class site: the button below opens the quiz'
              ) : quick && !(it.platformLinks || []).length ? (
                `Done on: ${quick.label}`
              ) : it.location && /class|lab|room|hall|in person/i.test(it.location) ? (
                'Hand in: in class'
              ) : (
                <span className="muted">No hand-in page on your class site yet (it may still be hidden or locked)</span>
              )}
            </span>
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
        {!it.opensAt &&
          platforms.map((l) => (
            <button key={l.url} className="btn" onClick={() => openLink(l.url)} title="Through your class's own link, so the platform knows which class it is">
              <Globe size={15} /> {l.label}
            </button>
          ))}
        {doc && (
          <button className="btn" onClick={() => openLink(doc.url)} title={doc.label}>
            <FileText size={15} /> Open assignment
          </button>
        )}
        {quick?.label === 'Hand in' && (
          <button className="btn" onClick={handInFile} title="Choose a file; Kea attaches it on the hand-in page, and you press Submit there">
            <Upload size={15} /> Hand in a file…
          </button>
        )}
      </div>
      {pickFile && (
        <div className="pn-handin-pick">
          <HandInPicker path={pickFile} dirty={false} only={it.courseCode} title={it.title} close={() => setPickFile(null)} />
          <button className="btn sm" onClick={() => setPickFile(null)}>
            Cancel
          </button>
        </div>
      )}
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
      {toKnow.length > 0 && (
        <section>
          <div className="tb-h">What to know</div>
          <ul className="pn-know">
            {toKnow.slice(0, 12).map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </section>
      )}
      {practice && (
        <section className="st-box">
          <div className="tb-h">Study for this</div>
          <button
            className="btn primary sm"
            onClick={() => openStudyHub({ courseId: it.courseId, code: it.courseCode, title: it.title, chapters: it.readings.map((r) => r.chapter), itemId: TEST.has(it.type) ? it.id : undefined })}
          >
            <ClipboardCheck size={14} /> Study {it.readings.map((r) => r.chapter.replace(/^Chapter /, 'Ch ')).join(', ')}
          </button>
          <div className="muted st-hint">A practice exam, flashcards, Learn and Match on everything this covers, by topic.</div>
        </section>
      )}
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

/** A grade, coloured by its letter: A dark green, B yellow-green, C yellow, D orange, F red. */
function GradeText({ percent, text, className, as = 'span' }: { percent: number | null | undefined; text?: string | null; className?: string; as?: 'span' | 'b' }) {
  const dark = useThemeDark();
  const Tag = as;
  return (
    <Tag className={className} style={{ color: gradeColor(percent, dark) }}>
      {text ?? `${percent}%`}
    </Tag>
  );
}
