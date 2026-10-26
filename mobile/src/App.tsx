import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Award, Home, BookOpen, Brain, CalendarDays, Camera, CheckCircle2, ChevronLeft, ChevronRight, Circle, ClipboardCheck, Download, ExternalLink, FileText, FolderOpen, GraduationCap, Inbox, Layers, Loader2, Mail, MapPin, Megaphone, RefreshCw, Settings, Sun, Trash2, X } from 'lucide-react';
import type { ScholarChapter, ScholarInboxItem, ScholarItem, StudySet } from '../../src/lib/api';
import { api } from '../../src/lib/api';
import { inboxParts, kindOf } from '../../src/components/scholar/inboxFormat';
import { CATEGORIES, LinkGroups, TODO, categoryOf, isDone, isMissing, primaryLink } from '../../src/components/scholar/kinds';
import { Kea, KeaData, cachedData, doneOf, inboxKey, loadData, phoneDeleted, phoneDone, phoneRead, setPhoneDeleted, setPhoneDone, setPhoneRead, syncOut, watchClasses } from './kea';
import { loadStudy, onStudyChange } from './study';
import { setDesktopData, studyChanged } from './desktopApi';
import { OpenedView, Reader, ReaderTarget, StudyHost } from './StudyTab';
import type { OpenedFile } from './kea';
import { openStudyHub } from '../../src/components/scholar/StudyHub';
import { openStudySet } from '../../src/components/scholar/Study';
import { StudyPicker } from '../../src/components/scholar/StudyModes';
import { places } from './Book';
import { reloadScholar, useScholar } from '../../src/components/scholar/scholarStore';
import { FilesTab } from './Files';
import { PairFlow, SettingsPage, Welcome } from './Welcome';
import { checkForUpdate, installUpdate, useUpdate } from './update';
import { toast } from './ui';
import { useBack } from './back';
import { getLook } from './theme';
import { THEMES, gradeColor, ink } from '../../src/lib/themes';

// ---------- Dates ----------
const pad = (n: number) => String(n).padStart(2, '0');
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const today = () => iso(new Date());
const dayName = (s: string) => (s === today() ? 'Today' : s === iso(addDays(new Date(), 1)) ? 'Tomorrow' : parse(s).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }));
const clock = (t: string | null) => {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
};
const whenOf = (it: ScholarItem) => (it.due ? `Due ${clock(it.due)}` : it.start ? `${clock(it.start)}${it.end ? `–${clock(it.end)}` : ''}` : '');
const room = (loc: string | null) => (loc && loc !== 'Online' ? loc.split(',').pop()!.trim() : '');
const ago = (at: string) => {
  const s = (Date.now() - new Date(at).getTime()) / 1000;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};
// (Made for dark backgrounds; darker on a light theme so they still read.)
const typeColor = (t: string) => ink(categoryOf(t).color, THEMES[getLook().theme]?.dark !== false);
const LABEL: Record<string, string> = { lecture: 'Lecture', lab: 'Lab', exam: 'Exam', final_exam: 'Final exam', lab_practical: 'Lab practical', quiz: 'Quiz', assignment: 'Assignment', discussion: 'Discussion', paper: 'Paper', peer_review: 'Peer review', lab_handout: 'Lab handout', other_deadline: 'To do', administrative_deadline: 'Deadline', break: 'Break', reading: 'Reading', weekly_reading: 'This week', project: 'Project' };

/** The PC's copy into the shared study code and screens (and once, what changes here goes back to the PC). */
let studyHooked = false;
function useStudyData(data: KeaData | null) {
  useEffect(() => {
    if (!studyHooked) {
      studyHooked = true;
      onStudyChange(() => {
        syncOut();
        studyChanged();
      });
    }
    if (!data) return;
    try {
      loadStudy(data);
    } catch (e) {
      console.error('Study', e);
    }
    setDesktopData(data);
    studyChanged();
    reloadScholar();
  }, [data]);
}

// Classes connected: Home (what's next and missing, studying, readings and each class), the calendar, the inbox and
// files. Not connected: files (scan and PDFs) and what connecting classes would add.
type Tab = 'calendar' | 'classes' | 'inbox' | 'files';
const WELCOMED = 'kea.welcomed';

export function App() {
  const [data, setData] = useState<KeaData | null>(cachedData());
  const [state, setState] = useState<Awaited<ReturnType<typeof Kea.state>> | null>(null);
  const [welcomed, setWelcomed] = useState(() => !!localStorage.getItem(WELCOMED));
  // (No tab picked yet: Home with classes, Scan & PDFs without.)
  const [tab, setTab] = useState<Tab | null>(null);
  const [item, setItem] = useState<ScholarItem | null>(null);
  const [course, setCourse] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  const [settings, setSettings] = useState(false);
  const [phoneInbox, setPhoneInbox] = useState<ScholarInboxItem[]>([]);
  const [done, setDone] = useState(phoneDone());
  const [refreshing, setRefreshing] = useState(false);
  // Starting up with classes: which step it's on, and what went wrong (shown instead of an endless spinner).
  const [step, setStep] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The library (textbooks, question pictures): unpacked when the PC wrote a new one, with how far along it is.
  const [library, setLibrary] = useState<{ busy: boolean; files: number; missing?: boolean } | null>(null);
  const [reader, setReader] = useState<ReaderTarget | null>(null);
  // A file another app opened with Kea.
  const [opened, setOpened] = useState<OpenedFile | null>(null);
  const update = useUpdate();
  useEffect(() => {
    Kea.takeOpenedFile()
      .then((r) => r.file && setOpened(r.file))
      .catch(() => {});
    const sub = Kea.addListener('opened', (f) => setOpened(f));
    return () => {
      sub.then((s) => s.remove());
    };
  }, []);
  useStudyData(data);
  useEffect(() => {
    const sub = Kea.addListener('library', (p) => setLibrary({ busy: true, files: p.files }));
    return () => {
      sub.then((s) => s.remove());
    };
  }, []);
  const syncLibrary = async () => {
    setLibrary((l) => ({ busy: true, files: l?.files || 0 }));
    // (The size the PC wrote: a zip the drive app hasn't finished downloading is left for next time.)
    const size = (cachedData() as { library?: { size?: number } | null } | null)?.library?.size;
    const r = await Kea.syncLibrary(size ? { size } : {}).catch(() => null);
    setLibrary({ busy: false, files: r?.files || 0, missing: r?.missing });
    if (r?.root) {
      setDesktopData(cachedData(), r.root);
      if (r.changed) studyChanged();
    }
  };

  // The classes come from the drive file first and alone: signing in to the class site and its own check run after,
  // in the background, so a slow sign-in never holds up the screen.
  const refresh = async () => {
    setRefreshing(true);
    setLoadError(null);
    try {
      setStep(1);
      const st = await Kea.state();
      setState(st);
      if (st.dataFolder) {
        // (Someone already connected skips the tour.)
        if (!localStorage.getItem(WELCOMED)) {
          localStorage.setItem(WELCOMED, '1');
          setWelcomed(true);
        }
        setStep(2);
        const r = await loadData();
        setStep(3);
        if (r.data) {
          setData(r.data);
          watchClasses(r.data).catch(() => {});
        }
        if (r.error) setLoadError(r.error);
        // (The textbooks after the classes: the screen is up while they come.)
        syncLibrary();
      }
      setRefreshing(false);
      if (st.dataFolder && st.home && st.hasLogin) await Kea.checkNow().catch(() => null);
      setPhoneInbox((await Kea.phoneInbox()).items || []);
    } finally {
      setRefreshing(false);
    }
  };
  useEffect(() => {
    refresh();
    checkForUpdate().catch(() => {});
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      refresh();
      checkForUpdate().catch(() => {});
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  // Each item's checkmark: the PC's, unless the phone changed it more recently.
  const items = useMemo(() => (data?.items || []).map((i) => ({ ...i, done: doneOf(i, data?.doneLog, done) })), [data, done]);
  const toggle = (it: ScholarItem) => {
    // Graded or handed-in work counts as done already; a tap there still records the phone's own checkmark.
    const on = !isDone(it);
    setPhoneDone(it.id, on);
    setDone(phoneDone());
    if (item?.id === it.id) setItem({ ...it, done: on ? new Date().toISOString() : null, handIn: on ? it.handIn : null });
  };
  const [deleted, setDeleted] = useState<string[]>(phoneDeleted);
  const inbox = useMemo(() => {
    // Deleted here or on the PC (both by content, since each side names messages its own way).
    const seen = new Set<string>([...deleted, ...(data?.inboxDeleted || [])]);
    return [...phoneInbox, ...(data?.inbox || [])]
      .filter((i) => {
        const k = inboxKey(i);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort((a, b) => String(b.at).localeCompare(String(a.at)));
  }, [phoneInbox, data, deleted]);
  const remove = (list: ScholarInboxItem[]) => {
    setPhoneDeleted(list.map(inboxKey));
    setDeleted(phoneDeleted());
  };
  const [readIds, setReadIds] = useState<string[]>(phoneRead);
  const unread = inbox.filter((i) => !i.read && !readIds.includes(i.id)).length;
  // Read on the phone: remembered here and passed to the PC (read on the PC arrives in its copy).
  const markRead = (ids: string[]) => {
    const fresh = ids.filter((id) => !readIds.includes(id));
    if (!fresh.length) return;
    setPhoneRead(fresh);
    setReadIds(phoneRead());
  };
  const missing = items.filter((i) => isMissing(i));

  const paired = !!state?.dataFolder;
  const classes = paired && data ? data : null;
  const finishWelcome = (connect: boolean) => {
    localStorage.setItem(WELCOMED, '1');
    setWelcomed(true);
    setTab('files');
    if (connect) setPairing(true);
  };
  const read = (path: string, name: string) => setReader({ file: path, chapter: name, title: name.replace(/\.pdf$/i, '') });

  // Back (the phone's button): another tab goes Home first, then whatever opened on top closes first. (Before the
  // early returns below, so the hooks run in the same order every time.)
  useBack(!!classes && !!tab && tab !== 'classes', () => setTab('classes'));
  useBack(!!item, () => setItem(null));
  useBack(!!reader, () => setReader(null));
  useBack(!!opened, () => setOpened(null));
  useBack(settings, () => setSettings(false));

  if (!welcomed && state && !paired) return <Welcome onTools={() => finishWelcome(false)} onConnect={() => finishWelcome(true)} />;
  if (pairing)
    return (
      <PairFlow
        state={state}
        onCancel={() => setPairing(false)}
        onDone={() => {
          setPairing(false);
          setTab('classes');
          refresh();
        }}
      />
    );
  // Classes connected but not read yet: a real progress bar, or what went wrong.
  if (paired && !data)
    return (
      <div className="page loading">
        <h1>Kea</h1>
        {!loadError ? (
          <>
            <div className="bar">
              <span style={{ width: `${[8, 30, 70, 100][step] || 8}%` }} />
            </div>
            <p className="muted">{['Starting…', 'Checking your setup…', 'Reading your classes from your drive…', 'Opening…'][step]}</p>
            <p className="muted small">This takes a few seconds. Kea only reads the copy your computer already made.</p>
          </>
        ) : (
          <>
            <p className="note">{loadError}</p>
            <button className="btn primary" onClick={refresh}>
              <RefreshCw size={16} /> Try again
            </button>
            <button className="btn" onClick={() => setPairing(true)}>
              <FolderOpen size={16} /> Choose Kea’s files again
            </button>
            <button className="btn ghost" onClick={() => (setState({ ...state!, dataFolder: '' }), setTab('files'))}>
              Use the scanner and PDFs for now
            </button>
          </>
        )}
      </div>
    );

  const tabs = (
    classes
      ? [
          ['classes', Home, 'Home', missing.length],
          ['calendar', CalendarDays, 'Calendar', 0],
          ['inbox', Inbox, 'Inbox', unread],
          ['files', Camera, 'Scan', 0]
        ]
      : [
          ['files', Camera, 'Scan & PDFs', 0],
          ['classes', GraduationCap, 'Classes', 0]
        ]
  ) as [Tab, typeof Sun, string, number][];
  const current = tab && tabs.some(([id]) => id === tab) ? tab : tabs[0][0];
  const ctx = classes && { data: classes, items, open: setItem, toggle, openCourse: (code: string) => (setCourse(code), setTab('classes')), read: (t: ReaderTarget) => setReader(t) };
  return (
    <div className="app">
      <header className="top">
        <div className="brand">Kea</div>
        {classes && (
          <button className="icon" onClick={refresh} aria-label="Refresh">
            {refreshing ? <Loader2 size={20} className="spin" /> : <RefreshCw size={20} />}
          </button>
        )}
        <button className="icon" onClick={() => setSettings(true)} aria-label="Settings">
          <Settings size={20} />
        </button>
      </header>
      <main className="body">
        {update.status === 'ready' && (
          <button className="stale upd" onClick={installUpdate}>
            <Download size={14} /> {update.needsPermission ? 'Allow Kea to install updates, then tap here again.' : `Kea ${update.next} is ready. Tap to install.`}
          </button>
        )}
        {classes && loadError && (
          <button className="stale" onClick={() => setPairing(true)}>
            <AlertTriangle size={14} /> Showing your last copy: {loadError} Tap to fix.
          </button>
        )}
        {classes && library?.busy && (
          <div className="stale lib">
            <Loader2 size={14} className="spin" /> Getting your textbooks{library.files ? ` · ${library.files} files` : ''}…
          </div>
        )}
        {ctx && current === 'inbox' && <InboxView items={inbox} readIds={readIds} markRead={markRead} remove={remove} />}
        {ctx && current === 'calendar' && <Agenda ctx={ctx} />}
        {current === 'classes' && (ctx ? <Classes ctx={ctx} code={course} setCode={setCourse} missing={missing} /> : <ClassesPitch onConnect={() => setPairing(true)} />)}
        {current === 'files' && <FilesTab data={classes} read={read} />}
      </main>
      <nav className="tabs">
        {tabs.map(([id, Icon, label, badge]) => (
          <button key={id} className={current === id ? 'on' : ''} onClick={() => (setTab(id), id !== 'classes' && setCourse(null))}>
            <Icon size={22} />
            <span>{label}</span>
            {badge > 0 && <b className={id === 'classes' ? 'alert' : ''}>{badge}</b>}
          </button>
        ))}
      </nav>
      {item && ctx && <Sheet ctx={ctx} it={item} onClose={() => setItem(null)} />}
      <StudyHost />
      {reader && <Reader target={reader} onClose={() => setReader(null)} onOpen={setReader} />}
      {opened && <OpenedView file={opened} onClose={() => setOpened(null)} />}
      {settings && (
        <SettingsPage
          state={state}
          paired={paired}
          onClose={() => setSettings(false)}
          onPair={() => (setSettings(false), setPairing(true))}
          onWelcome={() => (setSettings(false), localStorage.removeItem(WELCOMED), setWelcomed(false))}
          onUnpaired={() => {
            setSettings(false);
            setData(null);
            setTab('files');
            refresh();
          }}
        />
      )}
    </div>
  );
}

/** Not connected yet: what classes add, and the way in. */
function ClassesPitch({ onConnect }: { onConnect(): void }) {
  return (
    <div className="page">
      <div className="pitch">
        <GraduationCap size={34} />
        <h1>Your classes, on your phone</h1>
        <p className="muted">Connect to Kea on your computer and everything it keeps for your classes comes here too.</p>
        <ul className="perks">
          <li>
            <CalendarDays size={18} /> Due dates, classes and tests, with what’s done and missing
          </li>
          <li>
            <BookOpen size={18} /> Textbook chapters to read anywhere, even offline
          </li>
          <li>
            <Brain size={18} /> Practice exams, flashcards and review that sync both ways
          </li>
          <li>
            <Inbox size={18} /> Announcements, grades and messages, with notifications
          </li>
          <li>
            <Camera size={18} /> Scan your work and hand it in to the right assignment
          </li>
        </ul>
        <button className="btn primary big" onClick={onConnect}>
          <GraduationCap size={18} /> Connect my classes
        </button>
        <p className="muted small">Needs Kea on a Windows computer with your classes set up. It takes about two minutes.</p>
      </div>
    </div>
  );
}

type Ctx = { data: KeaData; items: ScholarItem[]; open(it: ScholarItem): void; toggle(it: ScholarItem): void; openCourse(code: string): void; read(t: ReaderTarget): void };

function Row({ ctx, it, date }: { ctx: Ctx; it: ScholarItem; date?: boolean }) {
  const miss = isMissing(it);
  return (
    <div className={`row ${isDone(it) ? 'done' : ''} ${miss ? 'missing' : ''}`} style={{ borderLeftColor: typeColor(it.type) }} onClick={() => ctx.open(it)}>
      {TODO.has(it.type) ? (
        <button
          className="check"
          onClick={(e) => {
            e.stopPropagation();
            ctx.toggle(it);
          }}
        >
          {isDone(it) ? <CheckCircle2 size={22} /> : <Circle size={22} />}
        </button>
      ) : (
        <span className="dot" style={{ background: typeColor(it.type) }} />
      )}
      <div className="row-main">
        <div className="row-title">
          {miss && (
            <span className="flag">
              <AlertTriangle size={11} /> Missing
            </span>
          )}
          {it.title}
        </div>
        <div className="row-meta">
          <b>{it.courseCode}</b>
          <span style={{ color: typeColor(it.type) }}>{LABEL[it.type] || it.type}</span>
          {date && <span>{dayName(it.date)}</span>}
          {whenOf(it) && <span>{whenOf(it)}</span>}
          {room(it.location) && (
            <span>
              <MapPin size={11} /> {room(it.location)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/** The top of Home: the next class or event today, missing work, and this week's reading. */
function TodayTop({ ctx, missing }: { ctx: Ctx; missing: ScholarItem[] }) {
  const t = today();
  const now = new Date().getHours() * 60 + new Date().getMinutes();
  const next = ctx.items.find((i) => i.type !== 'weekly_reading' && i.date === t && i.start && Number(i.start.slice(0, 2)) * 60 + Number(i.start.slice(3, 5)) > now);
  const banners = ctx.data.courses
    .map((c) => ctx.items.find((b) => b.type === 'weekly_reading' && b.courseId === c.id && b.date <= t && (b.dateEnd || b.date) >= t))
    .filter((b): b is ScholarItem => !!b);
  return (
    <>
      {next && (
        <div className="next" style={{ borderColor: typeColor(next.type) }} onClick={() => ctx.open(next)}>
          <div className="next-k">Next</div>
          <div className="next-t">
            {next.courseCode} {LABEL[next.type] || ''} at {clock(next.start)}
          </div>
          {room(next.location) && (
            <div className="next-r">
              <MapPin size={13} /> {next.location}
            </div>
          )}
        </div>
      )}
      {missing.length > 0 && (
        <section className="miss">
          <h2>
            <AlertTriangle size={14} /> {missing.length} missing
          </h2>
          {missing.map((i) => (
            <Row key={i.id} ctx={ctx} it={i} date />
          ))}
        </section>
      )}
      {banners.length > 0 && (
        <section>
          <h2>Reading this week</h2>
          <div className="wk-reads">
            {banners.flatMap((b) =>
              (b.readings.length ? b.readings : [{ chapter: b.title, title: null, pdf: null } as any]).map((r: any) => (
                <div key={`${b.id}:${r.chapter}`} className="wk-read">
                  <button className="wk-read-main" disabled={!r.pdf} onClick={() => r.pdf && ctx.read({ file: r.pdf.file, chapter: r.chapter, title: r.title || r.chapter })}>
                    <span className="wk-read-code">{b.courseCode}</span>
                    <span className="wk-read-title">
                      <b>{r.chapter.replace(/^Chapter /, 'Ch ')}</b> {r.title || ''}
                    </span>
                    {r.pdf && <BookOpen size={16} className="wk-read-go" />}
                  </button>
                  {b.readings.length > 0 && (
                    <button className="wk-read-study" aria-label="Study" onClick={() => openStudyHub({ courseId: b.courseId, code: b.courseCode, title: `${r.chapter}${r.title ? `: ${r.title}` : ''}`, chapters: [r.chapter] })}>
                      <ClipboardCheck size={16} />
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        </section>
      )}
    </>
  );
}

function InboxView({ items, readIds, markRead, remove }: { items: ScholarInboxItem[]; readIds: string[]; markRead(ids: string[]): void; remove(items: ScholarInboxItem[]): void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState(() => localStorage.getItem('kea.inboxClass') || 'all');
  const [kind, setKind] = useState<'all' | 'messages' | 'announcements' | 'grades'>('all');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [query, setQuery] = useState('');
  const [oldest, setOldest] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [replying, setReplying] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const codes = [...new Set(items.map((i) => i.course).filter(Boolean))].sort();
  const kindOfItem = (i: ScholarInboxItem) => (i.kind === 'grade' || i.kind === 'feedback' ? 'grades' : i.kind === 'announcement' ? 'announcements' : 'messages');
  const q = query.trim().toLowerCase();
  const shown = items
    .filter((i) => filter === 'all' || i.course === filter)
    .filter((i) => kind === 'all' || kindOfItem(i) === kind)
    .filter((i) => !unreadOnly || (!i.read && !readIds.includes(i.id)))
    .filter((i) => !q || `${i.course} ${i.title} ${i.body} ${(i as any).from || ''}`.toLowerCase().includes(q));
  if (oldest) shown.reverse();
  const readShown = shown.filter((i) => i.read || readIds.includes(i.id));
  const pickClass = (c: string) => {
    setFilter(c);
    try {
      localStorage.setItem('kea.inboxClass', c);
    } catch {}
  };
  const send = async (i: ScholarInboxItem) => {
    setSending(true);
    try {
      await Kea.reply({ conv: (i as any).conv, text: draft });
      toast('Reply sent.');
      setDraft('');
      setReplying(null);
    } catch (e) {
      toast(e);
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="page">
      <div className="inbox-filters">
        <input className="inbox-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search messages" />
        <select className="class-pick" value={codes.includes(filter) ? filter : 'all'} onChange={(e) => pickClass(e.target.value)} aria-label="Class">
          <option value="all">All classes</option>
          {codes.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
      <div className="chips wrap">
        {(
          [
            ['all', 'Everything'],
            ['messages', 'Messages'],
            ['announcements', 'Announcements'],
            ['grades', 'Grades']
          ] as const
        ).map(([k, label]) => (
          <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
            {label}
          </button>
        ))}
        <button className={unreadOnly ? 'on' : ''} onClick={() => setUnreadOnly(!unreadOnly)}>
          Unread
        </button>
        <button onClick={() => setOldest(!oldest)}>{oldest ? 'Oldest first' : 'Newest first'}</button>
      </div>
      <div className="inbox-acts">
        <button onClick={() => markRead(items.map((i) => i.id))}>Mark all read</button>
        {readShown.length > 0 &&
          (confirm ? (
            <button className="danger" onClick={() => (remove(readShown), setConfirm(false))}>
              Delete {readShown.length} read?
            </button>
          ) : (
            <button onClick={() => setConfirm(true)}>Delete read</button>
          ))}
      </div>
      {!shown.length && <div className="empty">{items.length ? 'Nothing matches these filters.' : 'Nothing yet. New announcements, grades and messages land here, with a notification.'}</div>}
      {shown.map((i) => {
        const unread = !i.read && !readIds.includes(i.id);
        const k = kindOf(i);
        const parts = inboxParts(i);
        return (
          <div key={i.id} className={`msg ${unread ? 'unread' : ''} ${open === i.id ? 'open' : ''}`} style={{ '--k': k.color } as React.CSSProperties} onClick={() => (setOpen(open === i.id ? null : i.id), markRead([i.id]))}>
            <div className="msg-head">
              {i.kind === 'announcement' ? <Megaphone size={15} /> : i.kind === 'grade' || i.kind === 'feedback' ? <Award size={15} /> : i.kind === 'needs_you' || i.kind === 'attention' || i.kind === 'missed' ? <AlertTriangle size={15} /> : <Mail size={15} />}
              <span className="msg-kind">{k.label}</span>
              {i.course && <b>{i.course}</b>}
              {(i as any).from && <span className="msg-from">{(i as any).from}</span>}
              <span className="muted small msg-at">{i.at ? ago(i.at) : ''}</span>
            </div>
            <div className="msg-title">
              {i.title}
              {i.score && <span className="msg-score">{i.score}{i.percent != null ? ` · ${i.percent}%` : ''}</span>}
            </div>
            {parts.text && <div className="msg-body">{parts.text}</div>}
            {parts.links.length > 0 && (
              <div className="msg-links">
                {(open === i.id ? parts.links : parts.links.slice(0, 2)).map((l) => (
                  <button
                    key={l.url}
                    onClick={(e) => {
                      e.stopPropagation();
                      markRead([i.id]);
                      Kea.open({ url: l.url });
                    }}
                  >
                    <ExternalLink size={13} /> {l.label}
                  </button>
                ))}
              </div>
            )}
            {open === i.id && replying === i.id && (
              <div className="msg-reply" onClick={(e) => e.stopPropagation()}>
                <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} placeholder={`Reply${(i as any).from ? ` to ${(i as any).from}` : ''}`} autoFocus />
                <div className="actions">
                  <button className="btn primary" disabled={!draft.trim() || sending} onClick={() => send(i)}>
                    {sending ? <Loader2 size={14} className="spin" /> : <Mail size={14} />} Send
                  </button>
                  <button className="btn" onClick={() => setReplying(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {open === i.id && replying !== i.id && (
              <div className="msg-actions">
                {kindOfItem(i) === 'messages' && ((i as any).conv || i.url) && (
                  <button
                    className="btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      if ((i as any).conv) setReplying(i.id);
                      else Kea.open({ url: i.url! });
                    }}
                  >
                    <Mail size={14} /> {(i as any).conv ? 'Reply' : 'Reply on the class site'}
                  </button>
                )}
                <button
                  className="btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    remove([i]);
                  }}
                >
                  <Trash2 size={14} /> Delete
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Agenda({ ctx }: { ctx: Ctx }) {
  const [start, setStart] = useState(() => addDays(new Date(), -((new Date().getDay() + 6) % 7)));
  const days = Array.from({ length: 7 }, (_, k) => iso(addDays(start, k)));
  const [day, setDay] = useState(today());
  const list = ctx.items.filter((i) => i.date === day && i.type !== 'weekly_reading');
  return (
    <div className="page">
      <div className="week">
        <button className="icon" onClick={() => setStart(addDays(start, -7))}>
          <ChevronLeft size={18} />
        </button>
        {days.map((d) => {
          const n = ctx.items.filter((i) => i.date === d && i.type !== 'weekly_reading');
          return (
            <button key={d} className={`wd ${d === day ? 'on' : ''} ${d === today() ? 'today' : ''}`} onClick={() => setDay(d)}>
              <span>{parse(d).toLocaleDateString(undefined, { weekday: 'narrow' })}</span>
              <b>{parse(d).getDate()}</b>
              <i>
                {n.slice(0, 4).map((x) => (
                  <em key={x.id} style={{ background: typeColor(x.type) }} />
                ))}
              </i>
            </button>
          );
        })}
        <button className="icon flip" onClick={() => setStart(addDays(start, 7))}>
          <ChevronLeft size={18} />
        </button>
      </div>
      <h2>{dayName(day)}</h2>
      {!list.length && <div className="empty">Nothing on this day.</div>}
      {list.map((i) => (
        <Row key={i.id} ctx={ctx} it={i} />
      ))}
      <div className="legend">
        {CATEGORIES.filter((c) => c.id !== 'reading').map((c) => (
          <span key={c.id}>
            <em style={{ background: c.color }} /> {c.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Every class (with review across all of them), and one class: its grade, what's coming, its chapters to read and
 * study, its practice sets and its grades. */
function Classes({ ctx, code, setCode, missing }: { ctx: Ctx; code: string | null; setCode(c: string | null): void; missing: ScholarItem[] }) {
  const version = useScholar((s) => s.version);
  const [sets, setSets] = useState<StudySet[]>([]);
  const [due, setDue] = useState<number | null>(null);
  const [allGrades, setAllGrades] = useState(false);
  useEffect(() => {
    api.scholar.studyList().then(setSets).catch(() => setSets([]));
    api.scholar
      .studyReview({ limit: 200 })
      .then((q) => setDue(q.due.length + q.fresh.length))
      .catch(() => setDue(null));
  }, [ctx.data, version]);
  const [readings, setReadings] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const c = ctx.data.details.find((x) => x.code === code);
  useBack(!!c, () => setCode(null));
  useBack(readings, () => setReadings(false));
  useBack(reviewing, () => setReviewing(false));
  const classList = ctx.data.details.map((d) => ({ id: d.id, code: d.code }));
  if (!c && readings) return <Readings ctx={ctx} onBack={() => setReadings(false)} />;
  if (!c && reviewing) return <ReviewPick ctx={ctx} due={due} onBack={() => setReviewing(false)} />;
  if (!c)
    return (
      <div className="page">
        <TodayTop ctx={ctx} missing={missing} />
        <div className="hub2">
          <button className="card review-all" onClick={() => setReviewing(true)}>
            <Brain size={22} />
            <span>
              <b>Review</b>
              <span className="muted small block">{due ? `${due} due · pick a class or chapters` : 'Everything, a class, or chapters'}</span>
            </span>
          </button>
          <button className="card review-all" onClick={() => setReadings(true)}>
            <BookOpen size={22} />
            <span>
              <b>Readings</b>
              <span className="muted small block">Every chapter, to read or listen to</span>
            </span>
          </button>
        </div>
        <h2>Your classes</h2>
        {ctx.data.details.map((d) => {
          const g = ctx.data.grades[d.code]?.final;
          const banks = sets.filter((s) => s.courseId === d.id && s.bank && s.status === 'ready').length;
          return (
            <button key={d.id} className="card class" onClick={() => setCode(d.code)}>
              <span className="class-main">
                <b>{d.code}</b>
                <span className="muted small block">{d.name}</span>
                <span className="muted small block">
                  {d.chapters.filter((ch) => ch.pdf).length} chapters to read{banks ? ` · ${banks} question banks` : ''}
                </span>
              </span>
              {g && <span className="grade" style={{ color: gradeTint(g.percent) }}>{g.percent != null ? `${g.percent}%` : g.shown}</span>}
            </button>
          );
        })}
        <p className="muted small">Everything here works offline. Answers, flashcards and stars go back to your computer; new questions are written there.</p>
      </div>
    );
  const grades = ctx.data.grades[c.code];
  const upcoming = ctx.items.filter((i) => i.courseId === c.id && i.date >= today() && i.type !== 'weekly_reading').slice(0, 6);
  const mine = sets.filter((s) => s.courseId === c.id && !s.bank && s.status !== 'failed');
  const gradeItems = grades?.items || [];
  return (
    <div className="page">
      <button className="back" onClick={() => setCode(null)}>
        <ChevronLeft size={18} /> Home
      </button>
      <div className="class-head">
        <span className="class-main">
          <h1>{c.code}</h1>
          <span className="muted">{c.name}</span>
          {(c.instructor || c.contact) && <span className="muted small block">{[c.instructor, c.contact].filter(Boolean).join(' · ')}</span>}
        </span>
        {grades?.final && <span className="bigrade" style={{ color: gradeTint(grades.final.percent) }}>{grades.final.percent != null ? `${grades.final.percent}%` : grades.final.shown}</span>}
      </div>
      <div className="grid2">
        <button className="btn" onClick={() => openStudySet(`review:${c.id}`)}>
          <Brain size={16} /> Review all
        </button>
        {c.url ? (
          <button className="btn" onClick={() => Kea.open({ url: c.url! })}>
            <ExternalLink size={16} /> Class site
          </button>
        ) : (
          <span />
        )}
      </div>
      {c.chapters.length > 0 && (
        <>
          <h2>Chapters</h2>
          <div className="wk-reads">
            {c.chapters.map((ch: ScholarChapter) => (
              <div key={ch.label} className="wk-read">
                <button className="wk-read-main" disabled={!ch.pdf} onClick={() => ch.pdf && ctx.read({ file: ch.pdf.file, chapter: ch.label, title: ch.title || ch.label })}>
                  <span className="wk-read-title">
                    <b>{ch.label.replace(/^Chapter /, 'Ch ')}</b> {ch.title || ''}
                    {!ch.pdf && <span className="muted small"> · being written</span>}
                  </span>
                  {ch.pdf && <BookOpen size={16} className="wk-read-go" />}
                </button>
                <button className="wk-read-study" aria-label="Study" onClick={() => openStudyHub({ courseId: c.id, code: c.code, title: ch.title ? `${ch.label}: ${ch.title}` : ch.label, chapters: [ch.label] })}>
                  <ClipboardCheck size={16} />
                </button>
              </div>
            ))}
          </div>
          <p className="muted small">Tap a chapter to read it; the clipboard opens its questions and flashcards.</p>
        </>
      )}
      {upcoming.length > 0 && (
        <>
          <h2>Coming up</h2>
          {upcoming.map((i) => (
            <Row key={i.id} ctx={ctx} it={i} date />
          ))}
        </>
      )}
      {mine.length > 0 && (
        <>
          <h2>Your practice sets</h2>
          {mine.map((s) => (
            <button key={s.id} className="card link" disabled={s.status !== 'ready'} onClick={() => openStudySet(s.id)}>
              {s.kind === 'exam' ? <ClipboardCheck size={16} /> : <Layers size={16} />}
              <span className="class-main">
                {s.itemTitle || s.title.replace(/^(Practice exam|Flashcards): /, '')}
                <span className="muted small block">{s.status === 'making' ? 'Being written on your computer…' : `${s.count} ${s.kind === 'exam' ? 'questions' : 'cards'}${s.best != null ? ` · best ${Math.round(s.best * 100)}%` : ''}`}</span>
              </span>
            </button>
          ))}
        </>
      )}
      {gradeItems.length > 0 && (
        <>
          <h2>Grades</h2>
          {(allGrades ? gradeItems : gradeItems.slice(0, 5)).map((g) => (
            <div key={g.id} className="card grade-row">
              <div className="class-main">
                <div>{g.title}</div>
                {g.comment && <div className="muted small">{g.comment}</div>}
              </div>
              <b style={{ color: gradeTint(g.percent) }}>{g.percent != null ? `${g.percent}%` : g.shown}</b>
            </div>
          ))}
          {gradeItems.length > 5 && (
            <button className="btn ghost" onClick={() => setAllGrades(!allGrades)}>
              {allGrades ? 'Show fewer' : `Show all ${gradeItems.length} grades`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

const TEST = new Set(['exam', 'final_exam', 'lab_practical', 'quiz']);

function Sheet({ ctx, it, onClose }: { ctx: Ctx; it: ScholarItem; onClose(): void }) {
  const quick = primaryLink(it);
  const instructions = [it.description, it.sourceWording].find((t) => t && t.trim() !== it.title.trim()) || '';
  const format = it.studyFocus.find((f) => /^(exam |test |quiz )?format\b/i.test(f));
  return (
    <div className="sheet-bg" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} style={{ borderTopColor: typeColor(it.type) }}>
        <div className="sheet-head">
          <b>{it.courseCode}</b>
          <span style={{ color: typeColor(it.type) }}>{LABEL[it.type] || it.type}</span>
          <button className="icon" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <h1>{it.title}</h1>
        {isMissing(it) && (
          <div className="miss-banner">
            <AlertTriangle size={14} /> Missing: nothing handed in on the class site.
          </div>
        )}
        <p className="muted">
          {dayName(it.date)}
          {whenOf(it) ? `, ${whenOf(it).toLowerCase()}` : ''}
          {it.location ? ` · ${it.location}` : ''}
        </p>
        {format && <p className="muted small">{format.replace(/^(exam |test |quiz )?format:\s*/i, 'Format: ')}</p>}
        <div className="actions">
          {TODO.has(it.type) && (
            <button className="btn" onClick={() => ctx.toggle(it)}>
              {isDone(it) ? <CheckCircle2 size={16} /> : <Circle size={16} />} {isDone(it) ? 'Done' : 'Mark as done'}
            </button>
          )}
          {quick && (
            <button className="btn primary" onClick={() => Kea.open({ url: quick.url })}>
              <quick.icon size={16} /> {quick.label}
            </button>
          )}
          {quick?.label === 'Hand in' && (
            <button
              className="btn primary"
              onClick={async () => {
                try {
                  const s = await Kea.scan({ name: it.title });
                  await Kea.handIn({ url: quick.url, file: s.file });
                } catch (e: any) {
                  if (!/No scan/.test(String(e?.message))) toast(e);
                }
              }}
            >
              <Camera size={16} /> Scan &amp; hand in
            </button>
          )}
        </div>
        {it.readings.length > 0 && (
          <>
            <h2>{TEST.has(it.type) ? 'Covers' : 'Reading'}</h2>
            {it.readings.map((r) => (
              <button key={r.chapter} className="card link" disabled={!r.pdf} onClick={() => r.pdf && (onClose(), ctx.read({ file: r.pdf.file, chapter: r.chapter, title: r.title || r.chapter }))}>
                <BookOpen size={16} />
                <span>
                  {r.chapter}
                  {r.title ? `: ${r.title}` : ''}
                  {!r.pdf && <span className="muted small"> (being written)</span>}
                  {r.summary && <span className="muted small block">{r.summary}</span>}
                </span>
              </button>
            ))}
          </>
        )}
        {it.readings.length > 0 && !['administrative_deadline', 'break', 'no_class'].includes(it.type) && (
          <button
            className="btn primary"
            onClick={() => (onClose(), openStudyHub({ courseId: it.courseId, code: it.courseCode, title: it.title, chapters: it.readings.map((r) => r.chapter), itemId: TEST.has(it.type) ? it.id : undefined }))}
          >
            <ClipboardCheck size={16} /> Study {it.readings.map((r) => r.chapter.replace(/^Chapter /, 'Ch ')).join(', ')}
          </button>
        )}
        {instructions && (
          <>
            <h2>Instructions</h2>
            <p className="pre">{instructions}</p>
          </>
        )}
        <LinkGroups links={[...it.links, ...(it.platformLinks || []), ...it.weeklyLinks]} onOpen={(url) => Kea.open({ url })} />
        {(it.instructor || it.contact) && <p className="muted small">{[it.instructor, it.contact].filter(Boolean).join(' · ')}</p>}
      </div>
    </div>
  );
}


/** Every class's chapters to read (or listen to), one class at a time or all of them, with a check when finished. */
function Readings({ ctx, onBack }: { ctx: Ctx; onBack(): void }) {
  const done = places();
  const [only, setOnly] = useState(() => localStorage.getItem(READINGS_CLASS) || '');
  const pick = (id: string) => {
    setOnly(id);
    try {
      localStorage.setItem(READINGS_CLASS, id);
    } catch {}
  };
  const withPdfs = ctx.data.details.filter((d) => d.chapters.some((ch) => ch.pdf));
  const shown = withPdfs.filter((d) => !only || d.id === only);
  return (
    <div className="page">
      <button className="back" onClick={onBack}>
        <ChevronLeft size={18} /> Home
      </button>
      <h1>Readings</h1>
      {withPdfs.length > 1 && (
        <select className="class-pick" value={only && withPdfs.some((d) => d.id === only) ? only : ''} onChange={(e) => pick(e.target.value)} aria-label="Class">
          <option value="">All classes</option>
          {withPdfs.map((d) => (
            <option key={d.id} value={d.id}>
              {d.code} · {d.name}
            </option>
          ))}
        </select>
      )}
      <p className="muted small">Tap a chapter to read it. In the book, the headphones read it aloud, even with the screen off or no signal.</p>
      {(shown.length ? shown : withPdfs).map((d) => {
        const chs = d.chapters.filter((ch) => ch.pdf);
        return (
          <section key={d.id}>
            <h2>
              {d.code} <span className="muted small">· {d.name}</span>
            </h2>
            <div className="wk-reads">
              {chs.map((ch) => {
                const p = done[ch.pdf!.file];
                const finished = !!p?.pages && p.page + 1 >= p.pages * 0.95;
                return (
                  <div key={ch.label} className="wk-read">
                    <button className="wk-read-main" onClick={() => ctx.read({ file: ch.pdf!.file, chapter: ch.label, title: ch.title || ch.label })}>
                      <span className="wk-read-title">
                        <b>{ch.label.replace(/^Chapter /, 'Ch ')}</b> {ch.title || ''}
                      </span>
                      {finished ? <CheckCircle2 size={16} className="wk-read-done" aria-label="Finished" /> : <BookOpen size={16} className="wk-read-go" />}
                    </button>
                    <button className="wk-read-study" aria-label="Study" onClick={() => openStudyHub({ courseId: d.id, code: d.code, title: ch.title ? `${ch.label}: ${ch.title}` : ch.label, chapters: [ch.label] })}>
                      <ClipboardCheck size={16} />
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
const READINGS_CLASS = 'kea.readingsClass';

/** Review: everything, one class, or chosen chapters (spaced review, the ones due first). */
function ReviewPick({ ctx, due, onBack }: { ctx: Ctx; due: number | null; onBack(): void }) {
  const classList = ctx.data.details.map((d) => ({ id: d.id, code: d.code }));
  return (
    <div className="page">
      <button className="back" onClick={onBack}>
        <ChevronLeft size={18} /> Home
      </button>
      <h1>Review</h1>
      <p className="muted small">Questions and cards come back just before you'd forget them, and before each test.</p>
      <button className="card review-all" onClick={() => openStudySet('review:all')}>
        <Brain size={22} />
        <span>
          <b>Everything</b>
          <span className="muted small block">{due ? `${due} due, a mix of every class` : 'A mix of every class'}</span>
        </span>
      </button>
      <h2>One class</h2>
      <div className="chips review-classes">
        {classList.map((c) => (
          <button key={c.id} onClick={() => openStudySet(`review:${c.id}`)}>
            {c.code}
          </button>
        ))}
      </div>
      <h2>Chosen chapters</h2>
      <StudyPicker classes={classList} />
    </div>
  );
}

/** A grade's colour, from A (dark green) to F (red), for the theme in use. */
const gradeTint = (percent: number | null | undefined) => gradeColor(percent, THEMES[getLook().theme]?.dark !== false);
