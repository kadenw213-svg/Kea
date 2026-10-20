import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Award, BookOpen, CalendarDays, Camera, CheckCircle2, ChevronLeft, Circle, Download, ExternalLink, Share2, FolderOpen, GraduationCap, Inbox, Loader2, Mail, MapPin, Megaphone, RefreshCw, Settings, Sun, Trash2, Upload, X } from 'lucide-react';
import type { ScholarInboxItem, ScholarItem } from '../../src/lib/api';
import { inboxParts, kindOf } from '../../src/components/scholar/inboxFormat';
import { CATEGORIES, LinkGroups, TODO, categoryOf, isDone, isMissing, primaryLink } from '../../src/components/scholar/kinds';
import { Kea, KeaData, cachedData, doneOf, folders, handInUrl, inboxKey, loadData, phoneDeleted, phoneDone, phoneRead, setPhoneDeleted, setPhoneDone, setPhoneRead, watchClasses } from './kea';

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
const typeColor = (t: string) => categoryOf(t).color;
const LABEL: Record<string, string> = { lecture: 'Lecture', lab: 'Lab', exam: 'Exam', final_exam: 'Final exam', lab_practical: 'Lab practical', quiz: 'Quiz', assignment: 'Assignment', discussion: 'Discussion', paper: 'Paper', peer_review: 'Peer review', lab_handout: 'Lab handout', other_deadline: 'To do', administrative_deadline: 'Deadline', break: 'Break', reading: 'Reading', weekly_reading: 'This week', project: 'Project' };

type Tab = 'today' | 'inbox' | 'calendar' | 'classes' | 'scan';

export function App() {
  const [data, setData] = useState<KeaData | null>(cachedData());
  const [state, setState] = useState<Awaited<ReturnType<typeof Kea.state>> | null>(null);
  const [tab, setTab] = useState<Tab>('today');
  const [item, setItem] = useState<ScholarItem | null>(null);
  const [course, setCourse] = useState<string | null>(null);
  const [setup, setSetup] = useState(false);
  const [phoneInbox, setPhoneInbox] = useState<ScholarInboxItem[]>([]);
  const [done, setDone] = useState(phoneDone());
  const [refreshing, setRefreshing] = useState(false);
  // Starting up: which step it's on, and what went wrong (shown instead of an endless spinner).
  const [step, setStep] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);

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
        setStep(2);
        const r = await loadData();
        setStep(3);
        if (r.data) {
          setData(r.data);
          watchClasses(r.data).catch(() => {});
        }
        if (r.error) setLoadError(r.error);
      }
      setRefreshing(false);
      if (st.home && st.hasLogin) await Kea.checkNow().catch(() => null);
      setPhoneInbox((await Kea.phoneInbox()).items || []);
    } finally {
      setRefreshing(false);
    }
  };
  useEffect(() => {
    refresh();
    const onVisible = () => document.visibilityState === 'visible' && refresh();
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

  const needsSetup = state && (!state.home || !state.hasLogin || !state.dataFolder);
  if (setup || needsSetup) return <Setup state={state} onDone={() => (setSetup(false), refresh())} />;
  if (!data)
    return (
      <div className="page loading">
        <h1>Kea</h1>
        {!loadError ? (
          <>
            <div className="bar">
              <span style={{ width: `${[8, 30, 70, 100][step] || 8}%` }} />
            </div>
            <p className="muted">{['Starting…', 'Checking your setup…', 'Reading your classes from your drive…', 'Opening…'][step]}</p>
            <p className="muted small">This takes a few seconds. Kea only reads the copy your PC already made; it never scans anything here.</p>
          </>
        ) : (
          <>
            <p className="note">{loadError}</p>
            <button className="btn primary" onClick={refresh}>
              <RefreshCw size={16} /> Try again
            </button>
            <button className="btn" onClick={() => Kea.pickDataFile().then(refresh).catch(() => {})}>
              <FolderOpen size={16} /> Choose the kea-data.json file
            </button>
            <p className="muted small">On your drive: Kea → School → kea-data.json (Google Drive: My Drive → Kea → School). Your PC shows which drive it uses under Scans → Devices.</p>
            <button className="btn" onClick={() => setSetup(true)}>
              <Settings size={16} /> Setup
            </button>
          </>
        )}
      </div>
    );

  const ctx = { data, items, open: setItem, toggle, openCourse: (code: string) => (setCourse(code), setTab('classes')) };
  return (
    <div className="app">
      <header className="top">
        <div className="brand">Kea</div>
        <button className="icon" onClick={refresh} aria-label="Refresh">
          {refreshing ? <Loader2 size={20} className="spin" /> : <RefreshCw size={20} />}
        </button>
        <button className="icon" onClick={() => setSetup(true)} aria-label="Settings">
          <Settings size={20} />
        </button>
      </header>
      <main className="body">
        {loadError && (
          <button className="stale" onClick={() => setSetup(true)}>
            <AlertTriangle size={14} /> Showing your last copy: {loadError} Tap to fix.
          </button>
        )}
        {tab === 'today' && <Today ctx={ctx} missing={missing} />}
        {tab === 'inbox' && <InboxView items={inbox} readIds={readIds} markRead={markRead} remove={remove} />}
        {tab === 'calendar' && <Agenda ctx={ctx} />}
        {tab === 'classes' && <Classes ctx={ctx} code={course} setCode={setCourse} />}
        {tab === 'scan' && <Scan data={data} />}
      </main>
      <nav className="tabs">
        {(
          [
            ['today', Sun, 'Today', missing.length],
            ['inbox', Inbox, 'Inbox', unread],
            ['calendar', CalendarDays, 'Calendar', 0],
            ['classes', GraduationCap, 'Classes', 0],
            ['scan', Camera, 'Scan', 0]
          ] as const
        ).map(([id, Icon, label, badge]) => (
          <button key={id} className={tab === id ? 'on' : ''} onClick={() => (setTab(id), id !== 'classes' && setCourse(null))}>
            <Icon size={22} />
            <span>{label}</span>
            {badge > 0 && <b className={id === 'today' ? 'alert' : ''}>{badge}</b>}
          </button>
        ))}
      </nav>
      {item && <Sheet ctx={ctx} it={item} onClose={() => setItem(null)} />}
    </div>
  );
}

type Ctx = { data: KeaData; items: ScholarItem[]; open(it: ScholarItem): void; toggle(it: ScholarItem): void; openCourse(code: string): void };

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

function Today({ ctx, missing }: { ctx: Ctx; missing: ScholarItem[] }) {
  const t = today();
  const week = iso(addDays(new Date(), 7));
  const upcoming = ctx.items.filter((i) => i.type !== 'weekly_reading' && i.date >= t && i.date <= week);
  const days = [...new Set(upcoming.map((i) => i.date))];
  const now = new Date().getHours() * 60 + new Date().getMinutes();
  const next = upcoming.find((i) => i.date === t && i.start && Number(i.start.slice(0, 2)) * 60 + Number(i.start.slice(3, 5)) > now);
  const banners = ctx.data.courses
    .map((c) => ctx.items.find((b) => b.type === 'weekly_reading' && b.courseId === c.id && b.date <= t && (b.dateEnd || b.date) >= t))
    .filter((b): b is ScholarItem => !!b);
  return (
    <div className="page">
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
          {banners.map((b) => (
            <div key={b.id} className="card" onClick={() => ctx.open(b)}>
              <b>{b.courseCode}</b> {b.readings.map((r) => `${r.chapter}${r.title ? `: ${r.title}` : ''}`).join(' · ') || b.title}
            </div>
          ))}
        </section>
      )}
      {days.map((d) => (
        <section key={d}>
          <h2>{dayName(d)}</h2>
          {upcoming
            .filter((i) => i.date === d)
            .map((i) => (
              <Row key={i.id} ctx={ctx} it={i} />
            ))}
        </section>
      ))}
      <p className="muted small">Updated from your PC {ctx.data.synced ? ago(ctx.data.synced) + ' ago' : ''}.</p>
    </div>
  );
}

function InboxView({ items, readIds, markRead, remove }: { items: ScholarInboxItem[]; readIds: string[]; markRead(ids: string[]): void; remove(items: ScholarInboxItem[]): void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState('all');
  const [confirm, setConfirm] = useState(false);
  const codes = [...new Set(items.map((i) => i.course).filter(Boolean))].sort();
  const shown = items.filter((i) => filter === 'all' || i.course === filter);
  const readShown = shown.filter((i) => i.read || readIds.includes(i.id));
  return (
    <div className="page">
      <div className="chips">
        {['all', ...codes].map((c) => (
          <button key={c} className={filter === c ? 'on' : ''} onClick={() => setFilter(c)}>
            {c === 'all' ? 'All' : c}
          </button>
        ))}
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
      {!shown.length && <div className="empty">Nothing yet. New announcements, grades and messages land here, with a notification.</div>}
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
            {open === i.id && (
              <div className="msg-actions">
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

function Classes({ ctx, code, setCode }: { ctx: Ctx; code: string | null; setCode(c: string | null): void }) {
  const c = ctx.data.details.find((x) => x.code === code);
  if (!c)
    return (
      <div className="page">
        {ctx.data.details.map((d) => {
          const g = ctx.data.grades[d.code]?.final;
          return (
            <div key={d.id} className="card class" onClick={() => setCode(d.code)}>
              <div>
                <b>{d.code}</b>
                <div className="muted small">{d.name}</div>
              </div>
              {g && <span className={`grade ${g.percent != null && g.percent < 60 ? 'low' : ''}`}>{g.percent != null ? `${g.percent}%` : g.shown}</span>}
            </div>
          );
        })}
      </div>
    );
  const grades = ctx.data.grades[c.code];
  const upcoming = ctx.items.filter((i) => i.courseId === c.id && i.date >= today() && i.type !== 'weekly_reading').slice(0, 15);
  return (
    <div className="page">
      <button className="back" onClick={() => setCode(null)}>
        <ChevronLeft size={18} /> Classes
      </button>
      <h1>
        {c.code} <span className="muted">{c.name}</span>
      </h1>
      <p className="muted small">{[c.instructor, c.contact].filter(Boolean).join(' · ')}</p>
      {grades?.final && <div className="bigrade">{grades.final.percent != null ? `${grades.final.percent}%` : grades.final.shown}</div>}
      <h2>Coming up</h2>
      {upcoming.map((i) => (
        <Row key={i.id} ctx={ctx} it={i} date />
      ))}
      {c.chapters.some((ch) => ch.pdf) && (
        <>
          <h2>Textbook</h2>
          {c.chapters
            .filter((ch) => ch.pdf)
            .map((ch) => (
              <button key={ch.label} className="card link" onClick={() => Kea.openFile({ path: ch.pdf!.file }).catch((e) => alertLine(e))}>
                <BookOpen size={16} /> {ch.label}
                {ch.title ? `: ${ch.title}` : ''}
              </button>
            ))}
        </>
      )}
      {grades?.items?.length ? (
        <>
          <h2>Grades</h2>
          {grades.items.map((g) => (
            <div key={g.id} className="card grade-row">
              <div>
                <div>{g.title}</div>
                {g.comment && <div className="muted small">{g.comment}</div>}
              </div>
              <b className={g.percent != null && g.percent < 60 ? 'low' : ''}>{g.percent != null ? `${g.percent}%` : g.shown}</b>
            </div>
          ))}
        </>
      ) : null}
      {c.url && (
        <button className="btn" onClick={() => Kea.open({ url: c.url! })}>
          <ExternalLink size={14} /> Class site
        </button>
      )}
    </div>
  );
}

const alertLine = (e: any) => {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = String(e?.message || e);
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
};

function Scan({ data }: { data: KeaData }) {
  const [scan, setScan] = useState<{ file: string; pages: number; name: string } | null>(null);
  const [targets, setTargets] = useState<Awaited<ReturnType<typeof folders>> | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [name, setName] = useState(`Scan ${new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`);
  const start = async () => {
    try {
      const s = await Kea.scan({ name: 'Scan' });
      setScan(s);
      const t = await folders(data);
      setTargets(t);
      setCode(t.find((c) => c.folders.some((f) => !f.closed))?.code || t[0]?.code || null);
    } catch (e: any) {
      if (!/No scan/.test(String(e?.message))) alertLine(e);
    }
  };
  const c = targets?.find((t) => t.code === code);
  return (
    <div className="page">
      {!scan ? (
        <div className="scan-start">
          <Camera size={42} />
          <p>Scan your work, then pick the assignment. Kea opens its hand-in page with the scan attached, and you press Submit.</p>
          <button className="btn primary big" onClick={start}>
            <Camera size={18} /> Scan
          </button>
        </div>
      ) : (
        <>
          <div className="card">
            <b>{scan.pages} page{scan.pages === 1 ? '' : 's'} scanned</b>
            <button className="icon" onClick={() => (setScan(null), setTargets(null))}>
              <X size={18} />
            </button>
          </div>
          <input className="scan-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
          <div className="actions">
            <button className="btn" onClick={() => Kea.share({ file: scan.file, name })}>
              <Share2 size={16} /> Share
            </button>
            <button className="btn" onClick={() => Kea.saveCopy({ file: scan.file, name }).then((r) => alertLine(`Saved to Downloads as ${r.name}`)).catch(alertLine)}>
              <Download size={16} /> Save to Downloads
            </button>
            <button className="btn" onClick={start}>
              <Camera size={16} /> Scan again
            </button>
          </div>
          <h2>Hand it in</h2>
          {!targets ? (
            <div className="center">
              <Loader2 className="spin" /> Finding your assignment folders…
            </div>
          ) : (
            <>
              <div className="chips">
                {targets.map((t) => (
                  <button key={t.code} className={t.code === code ? 'on' : ''} onClick={() => setCode(t.code)}>
                    {t.code}
                  </button>
                ))}
              </div>
              {c?.folders.map((f) => (
                <button key={f.id} className={`card link ${f.closed ? 'closed' : ''}`} disabled={f.closed} onClick={() => (setName(f.name), Kea.handIn({ url: handInUrl(data.home, c.ou, f.id), file: scan.file }))}>
                  <Upload size={16} />
                  <span>
                    {f.name}
                    <span className="muted small"> {f.closed ? 'Closed' : f.due ? `Due ${new Date(f.due).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : ''}</span>
                  </span>
                </button>
              ))}
            </>
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
                  if (!/No scan/.test(String(e?.message))) alertLine(e);
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
              <button key={r.chapter} className="card link" disabled={!r.pdf} onClick={() => r.pdf && Kea.openFile({ path: r.pdf.file }).catch(alertLine)}>
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
        {instructions && (
          <>
            <h2>Instructions</h2>
            <p className="pre">{instructions}</p>
          </>
        )}
        <LinkGroups links={[...it.links, ...it.weeklyLinks]} onOpen={(url) => Kea.open({ url })} />
        {(it.instructor || it.contact) && <p className="muted small">{[it.instructor, it.contact].filter(Boolean).join(' · ')}</p>}
      </div>
    </div>
  );
}

function Setup({ state, onDone }: { state: Awaited<ReturnType<typeof Kea.state>> | null; onDone(): void }) {
  const [home, setHome] = useState(state?.home || 'https://mycourses.cccs.edu/d2l/home');
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const signIn = async () => {
    setBusy('signin');
    setMsg('');
    try {
      await Kea.setup({ home: home.trim(), user: user.trim() || undefined, pass: pass || undefined });
      const r = await Kea.signIn({ show: true });
      setMsg(r.signedIn ? 'Signed in. Kea signs in by itself from now on.' : 'Not signed in yet.');
      await Kea.allowNotifications();
    } catch (e: any) {
      setMsg(String(e?.message || e));
    }
    setBusy('');
  };
  const folder = async () => {
    setBusy('folder');
    try {
      await Kea.pickFolder();
      await Kea.readFile({ path: 'kea-data.json' });
      setMsg('Found your classes.');
    } catch (e: any) {
      setMsg(/not found/.test(String(e?.message)) ? 'That folder has no kea-data.json. Choose OneDrive → Kea → your profile (for example School).' : String(e?.message || e));
    }
    setBusy('');
  };
  const dataFile = async () => {
    setBusy('folder');
    try {
      await Kea.pickDataFile();
      const r = await Kea.readFile({ path: 'kea-data.json' });
      const d = JSON.parse(r.text);
      setMsg(`Found your classes: ${(d.courses || []).map((c: any) => c.code).join(', ')}.`);
    } catch (e: any) {
      setMsg(/No file/.test(String(e?.message)) ? '' : `That isn't Kea's data file: choose kea-data.json in Kea → School. (${String(e?.message || e).slice(0, 80)})`);
    }
    setBusy('');
  };
  return (
    <div className="page setup">
      <h1>Kea</h1>
      <p className="muted">Your classes, inbox and grades, with notifications. Three steps, once.</p>
      <h2>1. Your class site</h2>
      <input value={home} onChange={(e) => setHome(e.target.value)} placeholder="https://yourschool.edu/d2l/home" />
      <input value={user} onChange={(e) => setUser(e.target.value)} placeholder={state?.hasLogin ? 'Username (saved)' : 'Username'} autoCapitalize="none" />
      <input value={pass} onChange={(e) => setPass(e.target.value)} placeholder={state?.hasLogin ? 'Password (saved)' : 'Password'} type="password" />
      <button className="btn primary" disabled={!!busy} onClick={signIn}>
        {busy === 'signin' ? <Loader2 size={16} className="spin" /> : null} Sign in {state?.signedIn ? '(signed in)' : ''}
      </button>
      <p className="muted small">Saved in Android's encrypted storage. Kea signs in by itself after this, the way it does on your PC.</p>
      <h2>2. Your classes from your PC</h2>
      <p className="muted small">
        Kea on your PC keeps your classes in the drive it syncs through (on the PC: Scans → Devices), in Kea → School. Google Drive and OneDrive can't share a whole folder with other apps on Android, so for those choose the file kea-data.json in that folder.
      </p>
      <button className="btn" disabled={!!busy} onClick={dataFile}>
        <FolderOpen size={16} /> {state?.dataFolder ? 'Choose kea-data.json again' : 'Choose kea-data.json'}
      </button>
      <button className="btn" disabled={!!busy} onClick={folder}>
        <FolderOpen size={16} /> Or choose the whole folder (a synced folder on the phone)
      </button>
      <h2>3. Notifications</h2>
      <button className="btn" onClick={() => Kea.allowNotifications()}>
        Allow notifications {state?.notifications ? '(on)' : ''}
      </button>
      {msg && <p className="note">{msg}</p>}
      <button className="btn primary big" onClick={onDone}>
        Done
      </button>
    </div>
  );
}
