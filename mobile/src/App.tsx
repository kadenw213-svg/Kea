import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Award, Bell, BookOpen, Brain, CalendarDays, Camera, CheckCircle2, ChevronDown, ChevronLeft, Circle, ClipboardCheck, Download, ExternalLink, FolderOpen, GraduationCap, Loader2, Mail, MapPin, Megaphone, RefreshCw, Settings, Sun, Trash2, X } from 'lucide-react';
import type { ScholarInboxItem, ScholarItem } from '../../src/lib/api';
import { inboxParts, kindOf } from '../../src/components/scholar/inboxFormat';
import { CATEGORIES, CLASS_COLORS, LinkGroups, TODO, categoryOf, isDone, isMissing, primaryLink } from '../../src/components/scholar/kinds';
import { useSetting } from '../../src/lib/settings';
import { useAreas } from '../../src/lib/areas';
import { Kea, KeaData, PhoneMail, cachedData, doneOf, inboxKey, loadData, phoneDeleted, phoneDone, phoneRead, setPhoneDeleted, setPhoneDone, setPhoneRead, syncOut, watchClasses } from './kea';
import { loadStudy, onStudyChange } from './study';
import { setDesktopData, studyChanged } from './desktopApi';
import { OpenedView, Reader, ReaderTarget, StudyHost } from './StudyTab';
import type { OpenedFile } from './kea';
import { openClassStudy, openStudyHub } from '../../src/components/scholar/StudyHub';
import { places } from './Book';
import { reloadScholar } from '../../src/components/scholar/scholarStore';
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
/** A class's colour: the one chosen on the PC (This week → Colours), or its place in the list. */
const classColor = (data: KeaData, id: string) => {
  const chosen = ((data as any).look?.classColors || {}) as Record<string, string>;
  const i = Math.max(0, data.courses.findIndex((c) => c.id === id));
  return ink(chosen[id] || CLASS_COLORS[i % CLASS_COLORS.length], THEMES[getLook().theme]?.dark !== false);
};
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
type Tab = 'calendar' | 'classes' | 'messages' | 'inbox' | 'files';
const WELCOMED = 'kea.welcomed';

export function App() {
  const areas = useAreas();
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
  const mail = data?.mail || [];
  const unreadMail = mail.filter((m) => !m.read && !readIds.includes(m.id)).length;

  const paired = !!state?.dataFolder;
  const classes = paired && data ? data : null;
  const finishWelcome = (connect: boolean) => {
    localStorage.setItem(WELCOMED, '1');
    setWelcomed(true);
    setTab('files');
    if (connect) setPairing(true);
  };
  const read = (path: string, name: string) => setReader({ file: path, chapter: name, title: name.replace(/\.pdf$/i, '') });

  // Back (the phone's button): another tab goes to the calendar first, then whatever opened on top closes first. (Before
  // the early returns below, so the hooks run in the same order every time.)
  useBack(!!classes && !!tab && tab !== 'calendar', () => setTab('calendar'));
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

  // Only the areas this person uses get a tab (Settings → Home on the PC or phone).
  const school = areas.includes('school');
  const docs = areas.includes('documents');
  const tabs = (
    (classes && school
      ? [
          ['calendar', CalendarDays, 'Calendar', missing.length],
          ['classes', GraduationCap, 'Classes', 0],
          ['messages', Mail, 'Messages', unreadMail],
          ['inbox', Bell, 'Notifications', unread],
          docs && ['files', Camera, 'Scan', 0]
        ]
      : [docs && ['files', Camera, 'Scan & PDFs', 0], school && ['classes', GraduationCap, 'Classes', 0]]
    ).filter(Boolean) as [Tab, typeof Sun, string, number][]
  );
  if (!tabs.length) tabs.push(['files', Camera, 'Scan & PDFs', 0]);
  const current = tab && tabs.some(([id]) => id === tab) ? tab : tabs[0][0];
  const ctx = classes && { data: classes, items, inbox, open: setItem, toggle, openCourse: (code: string) => (setCourse(code), setTab('classes')), read: (t: ReaderTarget) => setReader(t), markRead, calendar: () => setTab('calendar') };
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
        {ctx && current === 'messages' && <MessagesView mail={mail} readIds={readIds} markRead={markRead} />}
        {ctx && current === 'calendar' && <Agenda ctx={ctx} missing={missing} />}
        {current === 'classes' && (ctx ? <Classes ctx={ctx} code={course} setCode={setCourse} missing={missing} /> : <ClassesPitch onConnect={() => setPairing(true)} />)}
        {current === 'files' && <FilesTab data={classes} read={read} />}
      </main>
      <nav className="tabs">
        {tabs.map(([id, Icon, label, badge]) => (
          <button key={id} className={current === id ? 'on' : ''} onClick={() => (setTab(id), id !== 'classes' && setCourse(null))}>
            <Icon size={22} />
            <span>{label}</span>
            {badge > 0 && <b className={id === 'calendar' ? 'alert' : ''}>{badge}</b>}
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
            <Brain size={18} /> Practice exams with a walkthrough for every question, synced both ways
          </li>
          <li>
            <Bell size={18} /> Notifications for messages, replies, announcements and grades
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

type Ctx = { data: KeaData; items: ScholarItem[]; inbox: ScholarInboxItem[]; open(it: ScholarItem): void; toggle(it: ScholarItem): void; openCourse(code: string): void; read(t: ReaderTarget): void; markRead(ids: string[]): void; calendar(): void };

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

/** Missing work across every class, folded to one line at the top of the calendar. */
function MissingFold({ ctx, missing }: { ctx: Ctx; missing: ScholarItem[] }) {
  const [open, setOpen] = useState(false);
  if (!missing.length) return null;
  return (
    <section className="miss">
      <button className="miss-fold" onClick={() => setOpen(!open)}>
        <AlertTriangle size={15} />
        <b>{missing.length} missing</b>
        <span className="muted small">Past due, nothing handed in</span>
        <ChevronDown size={16} className={open ? 'flip-v' : ''} />
      </button>
      {open &&
        missing.map((i) => (
          <Row key={i.id} ctx={ctx} it={i} date />
        ))}
    </section>
  );
}

/** The class site's mailbox: each message, with its full text when open and Reply on the class site. */
function MessagesView({ mail, readIds, markRead }: { mail: PhoneMail[]; readIds: string[]; markRead(ids: string[]): void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState('all');
  const codes = [...new Set(mail.map((m) => m.course).filter(Boolean))].sort();
  const shown = mail.filter((m) => filter === 'all' || m.course === filter);
  // (The sender without the address; the class site's own date wording when it isn't a date.)
  const who = (from: string) => from.replace(/<[^>]*>?.*$/, '').replace(/"/g, '').trim();
  const when = (m: PhoneMail) => (m.date && isNaN(Date.parse(m.date)) ? m.date : ago(m.date || m.first));
  return (
    <div className="page">
      <h1>Messages</h1>
      {codes.length > 1 && (
        <div className="chips wrap">
          {['all', ...codes].map((c) => (
            <button key={c} className={filter === c ? 'on' : ''} onClick={() => setFilter(c)}>
              {c === 'all' ? 'All classes' : c}
            </button>
          ))}
        </div>
      )}
      {!shown.length && <div className="empty">No class-site messages yet. Kea on your computer reads your class site’s mailbox every 15 minutes.</div>}
      {shown.map((m) => {
        const unread = !m.read && !readIds.includes(m.id);
        return (
          <div key={m.id} className={`msg ${unread ? 'unread' : ''} ${open === m.id ? 'open' : ''}`} style={{ '--k': kindOf({ kind: 'message' } as ScholarInboxItem).color } as React.CSSProperties} onClick={() => (setOpen(open === m.id ? null : m.id), markRead([m.id]))}>
            <div className="msg-head">
              <Mail size={15} />
              {m.course && <b>{m.course}</b>}
              {who(m.from) && <span className="msg-from">{who(m.from)}</span>}
              <span className="muted small msg-at">{when(m)}</span>
            </div>
            <div className="msg-title">{m.subject}</div>
            {m.text && <div className="msg-body">{m.text}</div>}
            {open === m.id && m.url && (
              <div className="msg-actions">
                <button
                  className="btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    Kea.open({ url: m.url });
                  }}
                >
                  <Mail size={14} /> Reply on the class site
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Notifications: new messages, replies to your discussion posts, announcements, grades and feedback. */
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
        <input className="inbox-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search notifications" />
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
      {!shown.length && <div className="empty">{items.length ? 'Nothing matches these filters.' : 'Nothing yet. New messages, replies to your posts, announcements and grades land here, with a notification.'}</div>}
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

function Agenda({ ctx, missing }: { ctx: Ctx; missing: ScholarItem[] }) {
  // (Weeks start on the day chosen in Settings, Sunday unless changed.)
  const first = Number(useSetting<string>('scholar.weekStart') ?? 0) || 0;
  const [start, setStart] = useState(() => addDays(new Date(), -((new Date().getDay() - first + 7) % 7)));
  useEffect(() => setStart(addDays(new Date(), -((new Date().getDay() - first + 7) % 7))), [first]);
  const days = Array.from({ length: 7 }, (_, k) => iso(addDays(start, k)));
  const [day, setDay] = useState(today());
  const list = ctx.items.filter((i) => i.date === day && i.type !== 'weekly_reading');
  return (
    <div className="page">
      <MissingFold ctx={ctx} missing={missing} />
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

const shortDate = (d: string) => (d === today() ? 'Today' : parse(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));

/** The class's next tests, in one line of dates. */
function KeyDates({ ctx, c }: { ctx: Ctx; c: KeaData['details'][number] }) {
  const last = iso(addDays(new Date(), 120));
  const tests = ctx.items
    .filter((i) => i.courseId === c.id && TEST.has(i.type) && !isDone(i) && i.date >= today() && i.date <= last)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 4);
  if (!tests.length) return null;
  return (
    <div className="m-dates">
      <span className="m-dates-k">Key dates</span>
      {tests.map((i) => (
        <button key={i.id} onClick={() => ctx.open(i)}>
          <b>{shortDate(i.date)}</b> {i.title}
        </button>
      ))}
    </div>
  );
}

/** The class's announcements, newest first: the latest two, the rest behind "older". */
function ClassNews({ ctx, code }: { ctx: Ctx; code: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const list = ctx.inbox.filter((i) => i.kind === 'announcement' && i.course === code).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  if (!list.length) return null;
  const shown = all ? list : list.slice(0, 2);
  return (
    <>
      <h2>Announcements</h2>
      {shown.map((i) => {
        const parts = inboxParts(i);
        return (
          <div key={i.id} className={`msg ${open === i.id ? 'open' : ''}`} style={{ '--k': kindOf(i).color } as React.CSSProperties} onClick={() => (setOpen(open === i.id ? null : i.id), ctx.markRead([i.id]))}>
            <div className="msg-head">
              <Megaphone size={15} />
              <span className="msg-title">{i.title}</span>
              <span className="muted small msg-at">{i.at ? ago(i.at) : ''}</span>
            </div>
            {parts.text && <div className="msg-body">{parts.text}</div>}
            {open === i.id && parts.links.length > 0 && (
              <div className="msg-links">
                {parts.links.map((l) => (
                  <button
                    key={l.url}
                    onClick={(e) => {
                      e.stopPropagation();
                      Kea.open({ url: l.url });
                    }}
                  >
                    <ExternalLink size={13} /> {l.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {list.length > 2 && (
        <button className="btn ghost" onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `${list.length - 2} older announcement${list.length - 2 === 1 ? '' : 's'}`}
        </button>
      )}
    </>
  );
}

/**
 * Every week of the class, as on the PC: what it covers (each chapter's topics, with Read and Study), its tests by name,
 * and how much else is due (each item is on the calendar). This week open; the weeks ahead folded; earlier weeks in one fold.
 */
function Weeks({ ctx, c }: { ctx: Ctx; c: KeaData['details'][number] }) {
  const now = today();
  const items = ctx.items.filter((i) => i.courseId === c.id);
  const weeks = items.filter((i) => i.type === 'weekly_reading').sort((a, b) => a.date.localeCompare(b.date));
  if (!weeks.length) return <div className="empty">No weeks are built for this class yet. Kea on your computer builds them from the class schedule.</div>;
  const chapter = new Map(c.chapters.map((ch) => [ch.label, ch]));
  const end = (w: ScholarItem) => w.dateEnd || iso(addDays(parse(w.date), 6));
  const due = (w: ScholarItem) => items.filter((i) => i.type !== 'weekly_reading' && i.type !== 'lecture' && i.date >= w.date && i.date <= end(w));
  const current = weeks.filter((w) => end(w) >= now);
  const past = weeks.filter((w) => end(w) < now).reverse();
  const week = (w: ScholarItem, open: boolean) => {
    const list = due(w);
    const tests = list.filter((i) => TEST.has(i.type));
    const rest = list.length - tests.length;
    const isNow = w.date <= now && end(w) >= now;
    return (
      <details key={w.id} className={`pw ${isNow ? 'now' : ''}`} open={open}>
        <summary>
          <b>
            {shortDate(w.date)} – {shortDate(end(w))}
          </b>
          {isNow && <span className="pw-now">This week</span>}
          <span className="muted small">{w.readings.map((r) => r.chapter.replace(/^Chapter /, 'Ch ')).join(', ') || w.title}</span>
          {tests.length > 0 && <span className="pw-tag">{tests.length === 1 ? LABEL[tests[0].type] || 'Test' : `${tests.length} tests`}</span>}
        </summary>
        {w.readings.map((r) => {
          const ch = chapter.get(r.chapter);
          const topics = ch?.sections?.length ? ch.sections : ch?.objectives?.slice(0, 8) || [];
          return (
            <div key={r.chapter} className="pw-ch">
              <b>
                {r.chapter.replace(/^Chapter /, 'Ch ')}
                {r.title ? `: ${r.title}` : ''}
              </b>
              {topics.length > 0 ? (
                <ul>
                  {topics.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
              ) : (
                r.summary && <p className="muted small">{r.summary}</p>
              )}
              <div className="pw-ch-btns">
                {r.pdf && (
                  <button className="btn" onClick={() => ctx.read({ file: r.pdf!.file, chapter: r.chapter, title: r.title || r.chapter })}>
                    <BookOpen size={15} /> Read
                  </button>
                )}
                <button className="btn" onClick={() => openClassStudy(c, c.chapters.map((x) => x.label), [r.chapter], true)}>
                  <ClipboardCheck size={15} /> Study
                </button>
              </div>
            </div>
          );
        })}
        {tests.map((i) => (
          <button key={i.id} className="pw-test" onClick={() => ctx.open(i)}>
            <b>{LABEL[i.type] || 'Test'}</b>
            <span>{i.title}</span>
            <span className="muted small">{dayName(i.date)}</span>
          </button>
        ))}
        {rest > 0 && (
          <button className="pw-more" onClick={ctx.calendar}>
            {rest} other item{rest === 1 ? '' : 's'} due this week, on the calendar
          </button>
        )}
      </details>
    );
  };
  return (
    <div className="pws">
      {current.map((w, k) => week(w, k === 0))}
      {past.length > 0 && (
        <details className="pw-earlier">
          <summary className="muted">Earlier weeks ({past.length})</summary>
          {past.map((w) => week(w, false))}
        </details>
      )}
    </div>
  );
}

/** Every class as a card; one class is its weeks, with Study and Readings at the top and what's missing and due today
 * at the bottom (the grade opens its grades). */
function Classes({ ctx, code, setCode, missing }: { ctx: Ctx; code: string | null; setCode(c: string | null): void; missing: ScholarItem[] }) {
  const [readings, setReadings] = useState(false);
  const [grading, setGrading] = useState(false);
  const c = ctx.data.details.find((x) => x.code === code);
  useEffect(() => (setReadings(false), setGrading(false)), [code]);
  useBack(!!c, () => setCode(null));
  useBack(readings, () => setReadings(false));
  useBack(grading, () => setGrading(false));
  const columns = Number(useSetting<string>('scholar.homeColumns') || 2);
  const pictures = useSetting<boolean>('scholar.homePictures') !== false;
  const showGrades = useSetting<boolean>('scholar.homeGrades') !== false;
  if (c && readings) return <Readings ctx={ctx} course={c} onBack={() => setReadings(false)} />;
  if (!c)
    return (
      <div className="page">
        <h1>Classes</h1>
        <div className="mcards" style={{ ['--cols' as any]: Math.min(2, Math.max(1, columns || 2)) }}>
          {ctx.data.courses.map((d) => {
            const g = ctx.data.grades[d.code]?.final;
            const k = classColor(ctx.data, d.id);
            return (
              <div key={d.id} className="mcard" style={{ ['--k' as any]: k }} onClick={() => setCode(d.code)} role="button">
                <div className={`mcard-pic ${pictures && d.image ? '' : 'plain'}`}>
                  {pictures && d.image ? <img src={d.image} alt="" /> : <span className="mcard-mono">{d.code.replace(/\d.*$/, '')}</span>}
                  {showGrades && g && (g.percent != null || g.shown) && (
                    <span className="mcard-grade" style={{ color: gradeTint(g.percent) }}>
                      {g.percent != null ? `${g.percent}%` : g.shown}
                    </span>
                  )}
                </div>
                <div className="mcard-body">
                  <b className="mcard-code">{d.code}</b>
                  <span className="mcard-name">{d.name}</span>
                </div>
              </div>
            );
          })}
        </div>
        <p className="muted small">Everything here works offline. Answers and bookmarks go back to your computer; new questions are written there.</p>
      </div>
    );
  const k = classColor(ctx.data, c.id);
  const grades = ctx.data.grades[c.code];
  const gradeItems = grades?.items || [];
  const mine = missing.filter((i) => i.courseId === c.id);
  const dueToday = ctx.items.filter((i) => i.courseId === c.id && i.date === today() && i.type !== 'weekly_reading' && i.type !== 'lecture' && !isMissing(i));
  return (
    <div className="page" style={{ ['--k' as any]: k }}>
      <button className="back" onClick={() => (grading ? setGrading(false) : setCode(null))}>
        <ChevronLeft size={18} /> {grading ? 'Week by week' : 'Classes'}
      </button>
      <div className="class-head">
        <span className="class-main">
          <h1 style={{ color: k }}>{c.code}</h1>
          <span className="muted">{c.name}</span>
          {(c.instructor || c.contact) && <span className="muted small block">{[c.instructor, c.contact].filter(Boolean).join(' · ')}</span>}
        </span>
        {grades?.final && (
          <button className="bigrade" style={{ color: gradeTint(grades.final.percent) }} onClick={() => setGrading(!grading)} aria-label="Your grades in this class">
            {grades.final.percent != null ? `${grades.final.percent}%` : grades.final.shown}
          </button>
        )}
      </div>
      <div className="class-go">
        <button onClick={() => openClassStudy(c, c.chapters.map((ch) => ch.label))}>
          <ClipboardCheck size={20} />
          <b>Study</b>
          <span>Practice questions</span>
        </button>
        <button onClick={() => setReadings(true)}>
          <BookOpen size={20} />
          <b>Readings</b>
          <span>{c.chapters.filter((ch) => ch.pdf).length} chapters</span>
        </button>
      </div>
      {grading ? (
        <>
          <h2>Grades</h2>
          {!gradeItems.length && <div className="empty">No grades yet.</div>}
          {gradeItems.map((g) => (
            <div key={g.id} className="card grade-row">
              <div className="class-main">
                <div>{g.title}</div>
                {g.comment && <div className="muted small">{g.comment}</div>}
              </div>
              <b style={{ color: gradeTint(g.percent) }}>{g.percent != null ? `${g.percent}%` : g.shown}</b>
            </div>
          ))}
        </>
      ) : (
        <>
          <KeyDates ctx={ctx} c={c} />
          <ClassNews ctx={ctx} code={c.code} />
          <h2>Week by week</h2>
          <Weeks ctx={ctx} c={c} />
          {mine.length > 0 && (
            <section className="miss">
              <h2>
                <AlertTriangle size={14} /> {mine.length} missing
              </h2>
              {mine.map((i) => (
                <Row key={i.id} ctx={ctx} it={i} date />
              ))}
            </section>
          )}
          <h2>Due today</h2>
          {dueToday.length ? dueToday.map((i) => <Row key={i.id} ctx={ctx} it={i} />) : <div className="muted small">Nothing due today.</div>}
        </>
      )}
      {c.url && (
        <button className="btn ghost" onClick={() => Kea.open({ url: c.url! })}>
          <ExternalLink size={16} /> Class site
        </button>
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


/** A class's chapters to read (or listen to), with a check when finished; the clipboard studies that chapter. */
function Readings({ ctx, course: d, onBack }: { ctx: Ctx; course: KeaData['details'][number]; onBack(): void }) {
  const done = places();
  return (
    <div className="page">
      <button className="back" onClick={onBack}>
        <ChevronLeft size={18} /> {d.code}
      </button>
      <h1>Readings</h1>
      <p className="muted small">Tap a chapter to read it. In the book, the headphones read it aloud, even with the screen off or no signal.</p>
      <div className="wk-reads">
        {d.chapters.map((ch) => {
          const p = ch.pdf ? done[ch.pdf.file] : undefined;
          const finished = !!p?.pages && p.page + 1 >= p.pages * 0.95;
          return (
            <div key={ch.label} className="wk-read">
              <button className="wk-read-main" disabled={!ch.pdf} onClick={() => ch.pdf && ctx.read({ file: ch.pdf.file, chapter: ch.label, title: ch.title || ch.label })}>
                <span className="wk-read-title">
                  <b>{ch.label.replace(/^Chapter /, 'Ch ')}</b> {ch.title || ''}
                  {!ch.pdf && <span className="muted small"> · being written</span>}
                </span>
                {finished ? <CheckCircle2 size={16} className="wk-read-done" aria-label="Finished" /> : ch.pdf ? <BookOpen size={16} className="wk-read-go" /> : null}
              </button>
              <button className="wk-read-study" aria-label="Study" onClick={() => openClassStudy(d, d.chapters.map((x) => x.label), [ch.label], true)}>
                <ClipboardCheck size={16} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A grade's colour, from A (dark green) to F (red), for the theme in use. */
const gradeTint = (percent: number | null | undefined) => gradeColor(percent, THEMES[getLook().theme]?.dark !== false);
