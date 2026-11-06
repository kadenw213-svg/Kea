// Kea Hub classes inside School: join with a code or link, My classes, a class's page (sessions with meeting links,
// study sets, leaderboards, people), and the instructor's tools (invites, sessions, sets, hosting).
import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  Award,
  CalendarPlus,
  Check,
  ClipboardCheck,
  Copy,
  Flame,
  GraduationCap,
  Link2,
  LogOut,
  Pencil,
  Plus,
  Trash2,
  Trophy,
  UserMinus,
  Users,
  Video,
  X,
  Download,
  CloudOff,
} from 'lucide-react';
import { hubc, useHubClasses, HubClass, HubClassDetail, HubSession, HubSetInfo, HubSetFull, HubAnswer, HubBoard, NewQuestion, ImportableSet, BoardShow, HubProgress, comesBack } from '../../lib/hubClasses';
import { HubResult, api } from '../../lib/api';
import { toast, ask } from '../../store';
import { useScholar } from './scholarStore';
import { useHubStatus, refreshHub, SupporterBadge } from './HubAccount';
import { openLink } from './kinds';
import { MathText } from './MathText';
import { BoardChoice } from './BoardName';
import '../../styles/study.css';
import '../../styles/hubclasses.css';

/** A Hub call: the value, or null after showing the error. */
async function run<T>(p: Promise<HubResult<T>>): Promise<T | null> {
  const r = await p;
  if (r.ok) return r.value;
  toast(r.error, 'error');
  return null;
}
const go = (view: { name: 'hub'; classId?: string }) => useScholar.getState().set({ view });
const roleName = (r: string | null) => (r === 'instructor' ? 'Instructor' : r === 'ta' ? 'Teaching assistant' : 'Student');
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const timeOnly = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const copy = (text: string, what: string) => navigator.clipboard.writeText(text).then(() => toast(`${what} copied`, 'success'));

/** Reload My classes when this page opens and whenever a class changes. */
export function useHubClassList() {
  const st = useHubClasses();
  const status = useHubStatus();
  useEffect(() => {
    if (status?.signedIn) st.load();
    else if (status && !status.signedIn) useHubClasses.setState({ list: [], loaded: true });
    return api.hubClasses.onChanged(() => useHubClasses.getState().load());
  }, [status?.signedIn]);
  return st;
}

// ---------- The School sidebar ----------
export function HubNav({ classId, on }: { classId?: string; on: boolean }) {
  const { list } = useHubClassList();
  return (
    <>
      <div className="sch-head">Kea Hub classes</div>
      {list.map((c) => (
        <button key={c.id} className={`sch-link sch-course ${on && classId === c.id ? 'on' : ''}`} onClick={() => go({ name: 'hub', classId: c.id })} title={c.title}>
          <span className="sch-dot hubc-dot" />
          <span className="sch-course-text">
            <span className="sch-code">{c.title}</span>
            <span className="sch-cname">{roleName(c.role)}</span>
          </span>
        </button>
      ))}
      <button className={`sch-link sch-add ${on && !classId ? 'on' : ''}`} onClick={() => go({ name: 'hub' })}>
        <Users size={17} /> {list.length ? 'Join or teach a class' : 'Join a class'}
      </button>
    </>
  );
}

// ---------- Pages ----------
export function HubView({ classId }: { classId?: string }) {
  const status = useHubStatus();
  useEffect(() => {
    refreshHub();
  }, []);
  if (!status) return <div className="center-fill"><div className="spinner" /></div>;
  if (!status.signedIn)
    return (
      <div className="sch-page">
        <h1 className="sch-title">Kea Hub classes</h1>
        <p className="sch-sub">Classes on the Kea Hub: join with a code from your instructor, study the class’s sets and see the leaderboard.</p>
        <div className="acct-card">
          <p className="muted acct-note">Sign in to your Kea account first.</p>
          <div className="acct-actions">
            <button className="btn primary" onClick={() => useScholar.getState().set({ view: { name: 'account' } })}>
              Sign in or create an account
            </button>
          </div>
        </div>
      </div>
    );
  return classId ? <ClassPage key={classId} id={classId} /> : <HubHome />;
}

function OfflineNote({ when: at }: { when?: number }) {
  return (
    <p className="hub-warn hubc-offline">
      <CloudOff size={14} /> The Kea Hub is offline, so this is what Kea last saw{at ? ` (${new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })})` : ''}. Changes can be made when it’s back.
    </p>
  );
}

function HubHome() {
  const { list, offline, loaded } = useHubClassList();
  const status = useHubStatus();
  const progress = status?.me?.progress ?? status?.cached?.progress ?? null;
  return (
    <div className="sch-page">
      <h1 className="sch-title">Kea Hub classes</h1>
      <p className="sch-sub">Join a class with a code from your instructor, or teach your own.</p>
      {(offline || (status && !status.reachable)) && <OfflineNote />}
      {progress && <ProgressStrip p={progress} />}
      <JoinBox />
      <h2 className="sch-h2">My classes</h2>
      {!loaded ? (
        <div className="spinner" />
      ) : list.length ? (
        <div className="hubc-grid">
          {list.map((c) => (
            <ClassCard key={c.id} c={c} />
          ))}
        </div>
      ) : (
        <p className="muted">No classes yet. Join one with a code above.</p>
      )}
      <TeachBox />
    </div>
  );
}

function ProgressStrip({ p }: { p: HubProgress }) {
  const pct = p.next > p.floor ? Math.round(((p.xp - p.floor) / (p.next - p.floor)) * 100) : 100;
  return (
    <div className="hubc-progress" title={`${p.next - p.xp} XP to level ${p.level + 1}`}>
      <span className="hubc-level">
        <Award size={16} /> Level {p.level}
      </span>
      <span className="hubc-bar">
        <span style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} />
      </span>
      <span className="muted">{p.xp} XP</span>
      <span className="hubc-streak" title="Days in a row you studied">
        <Flame size={15} /> {p.streak}-day streak
      </span>
      {p.today > 0 && <span className="muted">+{p.today} today</span>}
    </div>
  );
}

function ClassCard({ c }: { c: HubClass }) {
  return (
    <button className="hubc-card" onClick={() => go({ name: 'hub', classId: c.id })}>
      <span className="hubc-card-title">{c.title}</span>
      <span className="muted">{c.instructors.map((i) => i.name).join(', ') || 'Instructor'}</span>
      <span className="hubc-card-foot">
        <span className="hubc-pill">{roleName(c.role)}</span>
        <span className="muted">
          <Users size={12} /> {c.members}
        </span>
      </span>
    </button>
  );
}

/** Paste a code or an invite link, see which class it is, then join. */
export function JoinBox() {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<{ code: string; title: string; instructors: string; role: string; alreadyMember: boolean; id: string } | null>(null);
  const look = async () => {
    setBusy(true);
    const r = await run(hubc.preview(text));
    setBusy(false);
    if (r) setFound({ code: r.code, title: r.class.title, instructors: r.class.instructors.map((i) => i.name).join(', '), role: r.role, alreadyMember: r.alreadyMember, id: r.class.id });
  };
  const join = async () => {
    if (!found) return;
    setBusy(true);
    const r = await run(hubc.join(found.code));
    setBusy(false);
    if (!r) return;
    toast(r.alreadyMember ? `You’re already in ${r.class.title}.` : `You joined ${r.class.title}.`, 'success');
    await useHubClasses.getState().load();
    setText('');
    setFound(null);
    go({ name: 'hub', classId: r.class.id });
  };
  return (
    <div className="acct-card hubc-join">
      <h3 className="hub-title">Join a class</h3>
      {!found ? (
        <form
          className="hubc-row"
          onSubmit={(e) => {
            e.preventDefault();
            look();
          }}
        >
          <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Class code or invite link" aria-label="Class code or invite link" />
          <button className="btn primary" type="submit" disabled={busy || !text.trim()}>
            Next
          </button>
        </form>
      ) : (
        <div className="hubc-found">
          <div>
            <div className="hubc-card-title">{found.title}</div>
            <div className="muted">
              {found.instructors ? `Taught by ${found.instructors} · ` : ''}You’d join as {found.role === 'ta' ? 'a teaching assistant' : 'a student'}.
            </div>
          </div>
          <div className="acct-actions">
            {found.alreadyMember ? (
              <button className="btn primary" onClick={() => go({ name: 'hub', classId: found.id })}>
                You’re in it: open the class
              </button>
            ) : (
              <button className="btn primary" disabled={busy} onClick={join}>
                Join {found.title}
              </button>
            )}
            <button className="btn" onClick={() => setFound(null)}>
              Back
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Teaching on the Kea Hub: make a class once approved, or apply for hosting. */
function TeachBox() {
  const status = useHubStatus();
  const canHost = !!(status?.me?.account.canHost ?? status?.cached?.canHost);
  const [hosting, setHosting] = useState<{ status: string; note?: string | null } | null>(null);
  const [reason, setReason] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!canHost) hubc.hosting().then((r) => r.ok && setHosting(r.value));
  }, [canHost]);
  return (
    <>
      <h2 className="sch-h2">Teach a class</h2>
      <div className="acct-card">
        {canHost ? (
          !open ? (
            <div className="hubc-row">
              <span className="muted grow">Make a class, invite people with a code, put sessions on their calendars and give them study sets.</span>
              <button className="btn primary" onClick={() => setOpen(true)}>
                <Plus size={14} /> New class
              </button>
            </div>
          ) : (
            <form
              className="acct-form"
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                const r = await run(hubc.create({ title, description }));
                setBusy(false);
                if (!r) return;
                toast(`${r.class.title} is ready. Make an invite code next.`, 'success');
                await useHubClasses.getState().load();
                go({ name: 'hub', classId: r.class.id });
              }}
            >
              <label>
                <span>Class name</span>
                <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="For example: BIOL 1010 Study Group" autoFocus maxLength={120} />
              </label>
              <label>
                <span>About the class (optional)</span>
                <textarea className="input hubc-text" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={4000} rows={3} />
              </label>
              <div className="acct-actions">
                <button className="btn primary" type="submit" disabled={busy || !title.trim()}>
                  Make the class
                </button>
                <button className="btn" type="button" onClick={() => setOpen(false)}>
                  Cancel
                </button>
              </div>
            </form>
          )
        ) : hosting?.status === 'pending' ? (
          <p className="muted acct-note">Your application to teach on the Kea Hub is waiting for review. You’ll be able to make classes here once it’s approved.</p>
        ) : (
          <form
            className="acct-form"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              const r = await run(hubc.applyHosting(reason));
              setBusy(false);
              if (r) (setHosting(r), toast('Application sent.', 'success'));
            }}
          >
            <p className="muted acct-note">
              Teaching on the Kea Hub needs approval from the person who runs it.
              {hosting?.status === 'rejected' ? ` Your last application wasn’t approved${hosting.note ? `: ${hosting.note}` : '.'} You can apply again.` : ''}
            </p>
            <label>
              <span>What will you teach, and who is it for?</span>
              <textarea className="input hubc-text" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={2000} placeholder="For example: a weekly study group for my BIOL 1010 section at PPSC, about 15 people." />
            </label>
            <div className="acct-actions">
              <button className="btn primary" type="submit" disabled={busy || reason.trim().length < 20}>
                Apply to teach
              </button>
              {reason.trim().length > 0 && reason.trim().length < 20 && <span className="muted">A sentence or two, please (20 characters or more).</span>}
            </div>
          </form>
        )}
      </div>
    </>
  );
}

// ---------- One class ----------
type Tab = 'sessions' | 'study' | 'board' | 'people' | 'invites' | 'settings';

function ClassPage({ id }: { id: string }) {
  const [d, setD] = useState<HubClassDetail | null | undefined>(undefined);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('sessions');
  const load = async () => {
    const r = await hubc.detail(id);
    if (r.ok) setD(r.value);
    else (setError(r.error), setD(null));
  };
  useEffect(() => {
    load();
    return api.hubClasses.onChanged(load);
  }, [id]);
  if (d === undefined) return <div className="center-fill"><div className="spinner" /></div>;
  if (!d)
    return (
      <div className="sch-page">
        <h1 className="sch-title">Class not found</h1>
        <p className="sch-sub">{error || 'You may have left it, or it was removed.'}</p>
        <button className="btn" onClick={() => go({ name: 'hub' })}>
          Back to Kea Hub classes
        </button>
      </div>
    );
  const c = d.class;
  const teacher = c.role === 'instructor' || c.role === 'ta';
  const instructor = c.role === 'instructor';
  const tabs: [Tab, string][] = [
    ['sessions', 'Sessions'],
    ['study', 'Study'],
    ['board', 'Leaderboard'],
    ['people', 'People'],
    ...(teacher ? ([['invites', 'Invites']] as [Tab, string][]) : []),
    ['settings', instructor ? 'Class settings' : 'Settings'],
  ];
  const next = d.sessions.find((s) => Date.parse(s.end) > Date.now());
  return (
    <div className="sch-page">
      {d.offline && <OfflineNote />}
      <div className="cls-head">
        <span className="cls-color hubc-color" />
        <div className="cls-head-text">
          <h1 className="sch-title">{c.title}</h1>
          <div className="cls-facts">
            <span>
              <GraduationCap size={13} /> {c.instructors.map((i) => i.name).join(', ') || 'Instructor'}
            </span>
            <span>
              <Users size={13} /> {c.members} {c.members === 1 ? 'member' : 'members'}
            </span>
            <span className="hubc-pill">{roleName(c.role)}</span>
            {c.status === 'archived' && <span className="hubc-pill">Archived</span>}
          </div>
          {c.description && <p className="hubc-desc">{c.description}</p>}
        </div>
        {c.meetingUrl && (
          <button className="btn sm" onClick={() => openLink(c.meetingUrl!)}>
            <Video size={13} /> Class meeting
          </button>
        )}
      </div>
      {next && (
        <div className="hubc-next">
          <CalendarPlus size={16} />
          <span className="grow">
            <b>{Date.parse(next.start) <= Date.now() ? 'Happening now' : 'Next'}:</b> {next.title} · {when(next.start)}–{timeOnly(next.end)}
            {next.location ? ` · ${next.location}` : ''}
          </span>
          {(next.meetingUrl || c.meetingUrl) && (
            <button className="btn sm primary" onClick={() => openLink((next.meetingUrl || c.meetingUrl)!)}>
              <Video size={13} /> Join the meeting
            </button>
          )}
        </div>
      )}
      {!instructor && <ProgressStrip p={d.progress} />}
      <div className="st-seg hubc-tabs" role="tablist">
        {tabs.map(([t, label]) => (
          <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)} role="tab" aria-selected={tab === t}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'sessions' && <Sessions d={d} teacher={teacher} reload={load} />}
      {tab === 'study' && <Sets d={d} teacher={teacher} reload={load} />}
      {tab === 'board' && <Board d={d} />}
      {tab === 'people' && <People d={d} instructor={instructor} reload={load} />}
      {tab === 'invites' && teacher && <Invites d={d} reload={load} />}
      {tab === 'settings' && <ClassSettings d={d} instructor={instructor} reload={load} />}
    </div>
  );
}

// ---------- Sessions ----------
function Sessions({ d, teacher, reload }: { d: HubClassDetail; teacher: boolean; reload(): void }) {
  const [editing, setEditing] = useState<HubSession | 'new' | null>(null);
  const [showPast, setShowPast] = useState(false);
  const now = Date.now();
  const upcoming = d.sessions.filter((s) => Date.parse(s.end) > now);
  const past = d.sessions.filter((s) => Date.parse(s.end) <= now).reverse();
  return (
    <div>
      {teacher && !editing && (
        <div className="acct-actions hubc-gap">
          <button className="btn primary sm" disabled={d.offline} onClick={() => setEditing('new')}>
            <CalendarPlus size={14} /> Add a session
          </button>
        </div>
      )}
      {editing && <SessionEditor d={d} s={editing === 'new' ? null : editing} onDone={() => (setEditing(null), reload())} />}
      <h2 className="sch-h2">Coming up</h2>
      {upcoming.length ? (
        <div className="sch-list">
          {upcoming.map((s) => (
            <SessionRow key={s.id} s={s} teacher={teacher && !d.offline} onEdit={() => setEditing(s)} fallbackUrl={d.class.meetingUrl} />
          ))}
        </div>
      ) : (
        <p className="muted">Nothing scheduled.{teacher ? ' Add a session and it shows on everyone’s Kea calendar.' : ' Sessions show here and on your calendar when your instructor adds them.'}</p>
      )}
      {past.length > 0 && (
        <>
          <button className="link-btn hubc-gap" onClick={() => setShowPast(!showPast)}>
            {showPast ? 'Hide' : 'Show'} {past.length} past {past.length === 1 ? 'session' : 'sessions'}
          </button>
          {showPast && (
            <div className="sch-list">
              {past.map((s) => (
                <SessionRow key={s.id} s={s} teacher={teacher && !d.offline} onEdit={() => setEditing(s)} past />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SessionRow({ s, teacher, onEdit, past, fallbackUrl }: { s: HubSession; teacher: boolean; onEdit(): void; past?: boolean; fallbackUrl?: string | null }) {
  const url = s.meetingUrl || fallbackUrl || null;
  return (
    <div className={`sch-row hubc-session ${past ? 'past' : ''}`}>
      <div className="sch-row-main">
        <div className="sch-row-title">{s.title}</div>
        <div className="muted">
          {when(s.start)}–{timeOnly(s.end)}
          {s.location ? ` · ${s.location}` : ''}
        </div>
        {s.notes && <div className="hubc-notes">{s.notes}</div>}
      </div>
      {url && !past && (
        <button className="btn sm" onClick={() => openLink(url)} title={url}>
          <Video size={13} /> Join
        </button>
      )}
      {teacher && (
        <button className="icon-btn sm" onClick={onEdit} title="Edit">
          <Pencil size={14} />
        </button>
      )}
    </div>
  );
}

const pad = (n: number) => String(n).padStart(2, '0');
const dateField = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeField = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

function SessionEditor({ d, s, onDone }: { d: HubClassDetail; s: HubSession | null; onDone(): void }) {
  const start0 = s ? new Date(s.start) : (() => { const t = new Date(Date.now() + 86400_000); t.setMinutes(0, 0, 0); return t; })();
  const end0 = s ? new Date(s.end) : new Date(start0.getTime() + 3600_000);
  const [title, setTitle] = useState(s?.title ?? '');
  const [date, setDate] = useState(dateField(start0));
  const [from, setFrom] = useState(timeField(start0));
  const [to, setTo] = useState(timeField(end0));
  const [location, setLocation] = useState(s?.location ?? '');
  const [url, setUrl] = useState(s?.meetingUrl ?? '');
  const [notes, setNotes] = useState(s?.notes ?? '');
  const [repeat, setRepeat] = useState(1);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const start = new Date(`${date}T${from}`);
    let end = new Date(`${date}T${to}`);
    // (Ends past midnight: the next day.)
    if (end <= start) end = new Date(end.getTime() + 86400_000);
    if (isNaN(start.getTime())) return toast('Pick a date and a start time.', 'error');
    setBusy(true);
    // A weekly class: the same session for the next weeks too (new sessions only).
    for (let w = 0; w < (s ? 1 : repeat); w++) {
      const shift = w * 7 * 86400_000;
      const r = await run(hubc.saveSession({ classId: d.class.id, id: s?.id, title, start: new Date(start.getTime() + shift).toISOString(), end: new Date(end.getTime() + shift).toISOString(), location, meetingUrl: url, notes }));
      if (!r) return setBusy(false);
    }
    setBusy(false);
    toast(s ? 'Session saved.' : repeat > 1 ? `${repeat} sessions added to the calendar.` : 'Session added to the calendar.', 'success');
    onDone();
  };
  return (
    <div className="acct-card hubc-editor">
      <h3 className="hub-title">{s ? 'Edit session' : 'New session'}</h3>
      <div className="acct-form">
        <label>
          <span>What</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="For example: Week 3 review" autoFocus maxLength={120} />
        </label>
        <div className="hubc-cols">
          <label>
            <span>Date</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label>
            <span>From</span>
            <input type="time" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label>
            <span>To</span>
            <input type="time" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          {!s && (
            <label>
              <span>Repeat weekly</span>
              <select className="select" value={repeat} onChange={(e) => setRepeat(Number(e.target.value))}>
                {[1, 2, 4, 6, 8, 10, 12, 16].map((n) => (
                  <option key={n} value={n}>
                    {n === 1 ? 'Just once' : `${n} weeks`}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <label>
          <span>Where (optional)</span>
          <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="A room, or leave empty for online" maxLength={200} />
        </label>
        <label>
          <span>Meeting link (optional)</span>
          <span className="hubc-row">
            <input className="grow" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://meet.jit.si/… or a Zoom or Google Meet link" />
            <button className="btn sm" type="button" onClick={async () => { const l = await run(hubc.jitsi(d.class.title)); if (l) setUrl(l); }} title="A free Jitsi Meet room, no account needed">
              <Link2 size={13} /> Make a Jitsi link
            </button>
          </span>
        </label>
        <label>
          <span>Notes (optional)</span>
          <textarea className="input hubc-text" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={4000} />
        </label>
        <div className="acct-actions">
          <button className="btn primary" disabled={busy || !title.trim()} onClick={save}>
            {s ? 'Save' : 'Add to the calendar'}
          </button>
          <button className="btn" onClick={onDone}>
            Cancel
          </button>
          {s && (
            <button
              className="btn danger"
              onClick={async () => {
                if ((await ask('Delete this session?', `${s.title} comes off everyone’s calendar.`, [{ id: 'no', label: 'Cancel' }, { id: 'yes', label: 'Delete', danger: true, primary: true }])) !== 'yes') return;
                if (await run(hubc.deleteSession(s.id))) onDone();
              }}
            >
              <Trash2 size={13} /> Delete
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- Study sets ----------
function Sets({ d, teacher, reload }: { d: HubClassDetail; teacher: boolean; reload(): void }) {
  const [making, setMaking] = useState(false);
  if (making) return <SetMaker classId={d.class.id} onDone={() => (setMaking(false), reload())} />;
  return (
    <div>
      {teacher && (
        <div className="acct-actions hubc-gap">
          <button className="btn primary sm" disabled={d.offline} onClick={() => setMaking(true)}>
            <Plus size={14} /> New study set
          </button>
        </div>
      )}
      {d.sets.length ? (
        <div className="sch-list">
          {d.sets.map((s) => (
            <SetRow key={s.id} s={s} teacher={teacher && !d.offline} offline={d.offline} reload={reload} />
          ))}
        </div>
      ) : (
        <p className="muted">{teacher ? 'No study sets yet. Make one, or bring in one of your Kea practice exams or flashcard decks.' : 'No study sets yet.'}</p>
      )}
      <p className="muted hubc-small">
        Each question scores the first time you get it right while it’s due. Then it comes back after 1 day, 3 days, a week and so on; answering sooner is free practice. Wrong answers never cost points.
      </p>
    </div>
  );
}

function SetRow({ s, teacher, offline, reload }: { s: HubSetInfo; teacher: boolean; offline: boolean; reload(): void }) {
  return (
    <div className="sch-row">
      <ClipboardCheck size={18} className="hubc-ico" />
      <div className="sch-row-main">
        <div className="sch-row-title">{s.title}</div>
        <div className="muted">
          {s.questions} questions · {s.learned} learned · {s.due ? `${s.due} ready to score` : 'all caught up'}
          {!s.leaderboard && ' · practice only'}
        </div>
      </div>
      <button className="btn sm primary" disabled={offline} onClick={() => useScholar.getState().set({ study: `hub:${s.id}` })} title={offline ? 'Needs the Kea Hub (answers are checked there)' : ''}>
        {s.due ? 'Study' : 'Practice'} <ArrowRight size={13} />
      </button>
      {teacher && (
        <button
          className="icon-btn sm"
          title="Delete set"
          onClick={async () => {
            if ((await ask(`Delete ${s.title}?`, 'Everyone’s progress on it goes too. Points already earned stay on the leaderboard.', [{ id: 'no', label: 'Cancel' }, { id: 'yes', label: 'Delete', danger: true, primary: true }])) !== 'yes') return;
            if (await run(hubc.deleteSet(s.id))) reload();
          }}
        >
          <Trash2 size={14} />
        </button>
      )}
    </div>
  );
}

const blankQ = (): NewQuestion => ({ q: '', choices: ['', '', '', ''], answer: 0, why: '' });

/** Write a set by hand, or bring in one of Kea's own study sets and edit it before saving. */
function SetMaker({ classId, onDone }: { classId: string; onDone(): void }) {
  const [title, setTitle] = useState('');
  const [qs, setQs] = useState<NewQuestion[]>([blankQ()]);
  const [leaderboard, setLeaderboard] = useState(true);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [importable, setImportable] = useState<ImportableSet[] | null>(null);
  useEffect(() => {
    if (picking && !importable) run(hubc.importable()).then((l) => setImportable(l || []));
  }, [picking]);
  const upd = (i: number, q: Partial<NewQuestion>) => setQs(qs.map((x, j) => (j === i ? { ...x, ...q } : x)));
  const clean = qs
    .map((q) => {
      const choices = q.choices.map((c) => c.trim());
      const kept = choices.map((c, i) => [c, i] as const).filter(([c]) => c);
      return { q: q.q.trim(), choices: kept.map(([c]) => c), answer: kept.findIndex(([, i]) => i === q.answer), why: q.why?.trim() || undefined };
    })
    .filter((q) => q.q && q.choices.length >= 2 && q.answer >= 0);
  const save = async () => {
    setBusy(true);
    const r = await run(hubc.createSet(classId, title, clean, leaderboard));
    setBusy(false);
    if (r) (toast(`${title} saved with ${r.count} questions.`, 'success'), onDone());
  };
  const bring = async (s: ImportableSet) => {
    const r = await run(hubc.importSet(s.id));
    if (!r) return;
    if (!r.questions.length) return toast('None of that set’s questions can be graded by choice (it’s all typed answers or matching).', 'error');
    setTitle(title || r.title);
    setQs([...qs.filter((q) => q.q.trim()), ...r.questions.map((q) => ({ ...q, choices: [...q.choices], why: q.why || '' }))]);
    setPicking(false);
    toast(`${r.questions.length} questions added${r.skipped ? `; ${r.skipped} left out (typed answers, matching or pictures)` : ''}. Check them before saving.`, 'success');
  };
  return (
    <div className="acct-card hubc-editor hubc-wide">
      <h3 className="hub-title">New study set</h3>
      <div className="acct-form">
        <label>
          <span>Name</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="For example: Chapter 3 review" maxLength={120} autoFocus />
        </label>
        <label className="hub-agree">
          <input type="checkbox" checked={leaderboard} onChange={(e) => setLeaderboard(e.target.checked)} /> Counts for the class leaderboard
        </label>
        <div className="acct-actions">
          <button className="btn sm" onClick={() => setPicking(!picking)}>
            <Download size={13} /> Bring in one of my Kea study sets
          </button>
        </div>
        {picking && (
          <div className="hubc-pick">
            {!importable ? (
              <div className="spinner" />
            ) : importable.length ? (
              importable.map((s) => (
                <button key={s.id} className="sch-row hubc-pick-row" onClick={() => bring(s)}>
                  <span className="sch-row-main">
                    <span className="sch-row-title">{s.title}</span>
                    <span className="muted">
                      {s.courseCode} · {s.kind === 'cards' ? 'Flashcards' : 'Practice exam'} · {s.count}
                    </span>
                  </span>
                  <Plus size={14} />
                </button>
              ))
            ) : (
              <p className="muted">No Kea practice exams or flashcards in this profile yet.</p>
            )}
          </div>
        )}
        {qs.map((q, i) => (
          <div key={i} className="hubc-qedit">
            <div className="hubc-row">
              <span className="st-num">{i + 1}</span>
              <textarea className="input hubc-text grow" value={q.q} onChange={(e) => upd(i, { q: e.target.value })} placeholder="Question" rows={2} maxLength={2000} />
              <button className="icon-btn sm" title="Remove question" onClick={() => setQs(qs.length > 1 ? qs.filter((_, j) => j !== i) : [blankQ()])}>
                <X size={14} />
              </button>
            </div>
            {q.choices.map((c, j) => (
              <div key={j} className="hubc-row hubc-choice">
                <input type="radio" name={`ans-${i}`} checked={q.answer === j} onChange={() => upd(i, { answer: j })} title="The right answer" aria-label={`Choice ${j + 1} is right`} />
                <input className="input grow" value={c} onChange={(e) => upd(i, { choices: q.choices.map((x, k) => (k === j ? e.target.value : x)) })} placeholder={`Choice ${String.fromCharCode(65 + j)}${j === q.answer ? ' (right answer)' : ''}`} maxLength={500} />
                {q.choices.length > 2 && (
                  <button className="icon-btn sm" title="Remove choice" onClick={() => upd(i, { choices: q.choices.filter((_, k) => k !== j), answer: q.answer === j ? 0 : q.answer > j ? q.answer - 1 : q.answer })}>
                    <X size={13} />
                  </button>
                )}
              </div>
            ))}
            <div className="hubc-row">
              {q.choices.length < 8 && (
                <button className="link-btn" onClick={() => upd(i, { choices: [...q.choices, ''] })}>
                  Add a choice
                </button>
              )}
            </div>
            <input className="input" value={q.why || ''} onChange={(e) => upd(i, { why: e.target.value })} placeholder="Why it’s right (optional, shown after answering)" maxLength={2000} />
          </div>
        ))}
        <div className="acct-actions">
          <button className="btn sm" onClick={() => setQs([...qs, blankQ()])}>
            <Plus size={13} /> Add a question
          </button>
        </div>
        <div className="acct-actions">
          <button className="btn primary" disabled={busy || !title.trim() || !clean.length} onClick={save}>
            Save the set ({clean.length} {clean.length === 1 ? 'question' : 'questions'})
          </button>
          <button className="btn" onClick={onDone}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- Practice (full window, like Kea's own study player) ----------
export function HubPractice({ setId, onClose }: { setId: string; onClose(): void }) {
  const [set, setSet] = useState<HubSetFull | null>(null);
  const [queue, setQueue] = useState<string[]>([]);
  const [cur, setCur] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const [result, setResult] = useState<HubAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const [earned, setEarned] = useState(0);
  const [right, setRight] = useState(0);
  const [progress, setProgress] = useState<HubProgress | null>(null);
  const [freePractice, setFreePractice] = useState(false);
  useEffect(() => {
    run(hubc.set(setId)).then((s) => {
      if (!s) return onClose();
      setSet(s);
      const due = s.questions.filter((q) => q.due).map((q) => q.id);
      // Nothing due: free practice through everything (no points).
      setFreePractice(!due.length);
      setQueue(due.length ? due : s.questions.map((q) => q.id));
    });
  }, [setId]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  const q = set?.questions.find((x) => x.id === queue[cur]);
  const answer = async (i: number) => {
    if (!q || result || busy) return;
    setPicked(i);
    setBusy(true);
    const r = await run(hubc.answer(setId, q.id, i));
    setBusy(false);
    if (!r) return setPicked(null);
    setResult(r);
    setProgress(r.progress);
    setEarned((n) => n + r.points);
    if (r.correct) setRight((n) => n + 1);
  };
  const next = () => {
    // A miss comes back at the end of this round (getting it right after a miss still earns a little).
    if (result && !result.correct && result.scoring) setQueue((qq) => [...qq, qq[cur]]);
    setCur(cur + 1);
    setPicked(null);
    setResult(null);
  };
  const finished = set && cur >= queue.length;
  return (
    <div className="st-player">
      <div className="st-player-head">
        <button className="icon-btn" onClick={onClose} title="Close (Esc)">
          <X size={18} />
        </button>
        <div className="st-player-title">{set?.set.title ?? 'Study set'}</div>
        {progress && (
          <span className="hubc-head-stats">
            <span>
              <Award size={14} /> Level {progress.level}
            </span>
            <span>{progress.xp} XP</span>
            <span title="Days in a row you studied">
              <Flame size={14} /> {progress.streak}-day streak
            </span>
          </span>
        )}
      </div>
      <div className="st-player-body">
        <div className="st-main">
          {!set ? (
            <div className="center-fill">
              <div className="spinner" />
            </div>
          ) : finished ? (
            <div className="st-exam hubc-done">
              <Trophy size={36} className="hubc-ico" />
              <h2>{freePractice ? 'Practice round done' : 'All caught up'}</h2>
              <p className="muted">
                {right} of {queue.length} right{earned ? ` · +${earned} XP` : ''}. {freePractice ? 'Nothing here was due, so this round was for practice only.' : 'These come back for more points on their review dates.'}
              </p>
              <div className="acct-actions">
                <button className="btn primary" onClick={onClose}>
                  Done
                </button>
                <button className="btn" onClick={() => (setFreePractice(true), setQueue(set.questions.map((x) => x.id)), setCur(0), setRight(0))}>
                  Practice them all again
                </button>
              </div>
            </div>
          ) : q ? (
            <div className="st-exam st-one">
              <div className="st-one-top">
                <span className="st-one-count">
                  Question {cur + 1} <span className="muted">of {queue.length}</span>
                </span>
                <span className="muted">
                  {freePractice ? 'Practice: no points' : earned ? `+${earned} XP this round` : ''}
                </span>
              </div>
              <div className={`st-q ${result ? (result.correct ? 'right' : 'wrong') : ''}`}>
                <div className="st-q-head">
                  <span className="st-num">{cur + 1}</span>
                  <div className="st-stem">
                    <MathText text={q.q} />
                  </div>
                </div>
                <div className="st-choices">
                  {q.choices.map((c, i) => (
                    <button
                      key={i}
                      className={`st-choice ${picked === i ? 'on' : ''} ${result && result.answer === i ? 'correct' : ''} ${result && picked === i && !result.correct ? 'incorrect' : ''}`}
                      onClick={() => answer(i)}
                      disabled={!!result || busy}
                    >
                      <span className="st-letter">{String.fromCharCode(65 + i)}</span>
                      <span>
                        <MathText text={c} />
                      </span>
                    </button>
                  ))}
                </div>
                {result && (
                  <div className="st-explain ex">
                    <div className={`ex-verdict ${result.correct ? 'right' : 'wrong'}`}>
                      {result.correct ? <Check size={16} className="ex-check" /> : <X size={16} />}
                      <span>
                        <b>{result.correct ? 'Correct.' : 'Not quite.'}</b>{' '}
                        {!result.correct && (
                          <>
                            The answer is {String.fromCharCode(65 + result.answer)}. <MathText text={q.choices[result.answer]} />
                          </>
                        )}
                      </span>
                    </div>
                    {result.why && (
                      <section className="ex-sec">
                        <h4>Why</h4>
                        <div className="ex-text">
                          <MathText text={result.why} />
                        </div>
                      </section>
                    )}
                    <div className="hubc-score">
                      {result.points > 0 && <span className="hubc-pts">+{result.points} XP</span>}
                      <span className="muted">
                        {!result.scoring
                          ? `Not due yet, so no points this time. It scores again ${comesBack(q.dueAt ?? result.nextDueAt)}.`
                          : result.correct
                            ? `Comes back ${comesBack(result.nextDueAt)}${result.capped ? '. You reached today’s point limit, so this counted for less' : ''}.`
                            : 'No points lost. It comes back at the end of this round; getting it right then still earns a little.'}
                      </span>
                    </div>
                  </div>
                )}
              </div>
              <div className="st-one-nav">
                <span className="grow" />
                {result && (
                  <button className="btn primary" onClick={next} autoFocus>
                    Next <ArrowRight size={14} />
                  </button>
                )}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ---------- Leaderboard ----------
function Board({ d }: { d: HubClassDetail }) {
  const [period, setPeriod] = useState<'week' | 'all'>('week');
  const [b, setB] = useState<HubBoard | null>(null);
  useEffect(() => {
    setB(null);
    run(hubc.leaderboard(d.class.id, period)).then(setB);
  }, [period, d.class.id]);
  return (
    <div>
      <div className="hubc-row hubc-gap">
        <div className="st-seg">
          <button className={period === 'week' ? 'on' : ''} onClick={() => setPeriod('week')}>
            This week
          </button>
          <button className={period === 'all' ? 'on' : ''} onClick={() => setPeriod('all')}>
            All time
          </button>
        </div>
        <span className="muted hubc-small">{period === 'week' ? 'Starts over every Monday.' : ''}</span>
      </div>
      {b?.offline && <OfflineNote />}
      {!b ? (
        <div className="spinner" />
      ) : b.board.length ? (
        <ol className="hubc-board">
          {b.board.map((e, i) => (
            <li key={i} className={e.you ? 'you' : ''}>
              <span className={`hubc-rank r${e.rank}`}>{e.rank}</span>
              <span className="grow">
                {e.name}
                {e.supporter && <SupporterBadge compact />}
                {e.you && <span className="muted"> (you)</span>}
              </span>
              <span className="hubc-pts">{e.points} XP</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted">No points yet{period === 'week' ? ' this week' : ''}. Study a set to get on the board.</p>
      )}
      {b && b.board.some((e, i) => e.rank > i + 1 && (i === 0 || e.rank > b.board[i - 1].rank + 1)) && <p className="muted hubc-small">Some people in this class keep their names hidden, so a few places aren’t shown.</p>}
      {b?.you && !b.board.some((e) => e.you) && (
        <p className="muted">
          You: #{b.you.rank} with {b.you.points} XP{d.class.board === 'hidden' ? ' (hidden from others)' : ''}.
        </p>
      )}
      <MyBoardName d={d} />
    </div>
  );
}

/** How you show on this class's board. */
function MyBoardName({ d }: { d: HubClassDetail }) {
  const [show, setShow] = useState<BoardShow>(d.class.board || 'name');
  const [nick, setNick] = useState(d.class.nickname || '');
  const [busy, setBusy] = useState(false);
  if (d.class.role === 'instructor') return null;
  return (
    <div className="acct-card hubc-gap">
      <h3 className="hub-title">How you show here</h3>
      <BoardChoice show={show} nick={nick} setShow={setShow} setNick={setNick} />
      <div className="acct-actions">
        <button
          className="btn sm primary"
          disabled={busy || d.offline || (show === 'nickname' && !nick.trim())}
          onClick={async () => {
            setBusy(true);
            const r = await run(hubc.setMine(d.class.id, show, show === 'nickname' ? nick.trim() : nick.trim() || null));
            setBusy(false);
            if (r) toast('Saved for this class.', 'success');
          }}
        >
          Save for this class
        </button>
        <span className="muted hubc-small">For every class at once: Settings → Kea account.</span>
      </div>
    </div>
  );
}

// ---------- People ----------
function People({ d, instructor, reload }: { d: HubClassDetail; instructor: boolean; reload(): void }) {
  const groups: [string, typeof d.members][] = [
    ['Instructors', d.members.filter((m) => m.role === 'instructor')],
    ['Teaching assistants', d.members.filter((m) => m.role === 'ta')],
    ['Students', d.members.filter((m) => m.role === 'student')],
  ];
  const hidden = d.class.members - d.members.length;
  return (
    <div>
      {groups
        .filter(([, l]) => l.length)
        .map(([label, l]) => (
          <div key={label}>
            <h2 className="sch-h2">{label}</h2>
            <div className="sch-list">
              {l.map((m, i) => (
                <div key={m.id || i} className="sch-row hubc-person">
                  <span className="sch-avatar">{(m.name || '?')[0]}</span>
                  <span className="sch-row-main">
                    {m.name || 'Hidden'}
                    {m.supporter && <SupporterBadge />}
                    {m.you && <span className="muted"> (you)</span>}
                    {m.phone && (
                      <button className="hub-phone-chip" title="Copy the phone number" onClick={() => copy(m.phone!, 'Phone number')}>
                        {m.phone}
                      </button>
                    )}
                  </span>
                  {instructor && m.id && !m.you && m.role !== 'instructor' && !d.offline && (
                    <button
                      className="icon-btn sm"
                      title="Remove from the class"
                      onClick={async () => {
                        if ((await ask(`Remove ${m.name || 'this person'}?`, 'They leave the class and its calendar. They can rejoin only with a new code.', [{ id: 'no', label: 'Cancel' }, { id: 'yes', label: 'Remove', danger: true, primary: true }])) !== 'yes') return;
                        if (await run(hubc.removeMember(d.class.id, m.id!))) reload();
                      }}
                    >
                      <UserMinus size={14} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      {hidden > 0 && <p className="muted hubc-small">{hidden === 1 ? 'One student keeps their name hidden.' : `${hidden} students keep their names hidden.`}</p>}
    </div>
  );
}

// ---------- Invites ----------
function Invites({ d, reload }: { d: HubClassDetail; reload(): void }) {
  const [role, setRole] = useState<'student' | 'ta'>('student');
  const [maxUses, setMaxUses] = useState('');
  const [days, setDays] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const link = (code: string) => d.inviteBase + code;
  const live = d.invites.filter((i) => !i.expired);
  const used = d.invites.filter((i) => i.expired);
  return (
    <div>
      <div className="acct-card hubc-gap">
        <h3 className="hub-title">Make an invite code</h3>
        <p className="muted acct-note">Share the code or the link. Anyone with a Kea account who has it can join until you turn it off.</p>
        <div className="hubc-row">
          <div className="st-seg">
            <button className={role === 'student' ? 'on' : ''} onClick={() => setRole('student')}>
              Students
            </button>
            <button className={role === 'ta' ? 'on' : ''} onClick={() => setRole('ta')}>
              Teaching assistants
            </button>
          </div>
          <button className="link-btn" onClick={() => setAdvanced(!advanced)}>
            {advanced ? 'Fewer options' : 'Advanced'}
          </button>
        </div>
        {advanced && (
          <div className="hubc-cols acct-form">
            <label>
              <span>Most people who can use it</span>
              <input type="number" min={1} max={10000} value={maxUses} onChange={(e) => setMaxUses(e.target.value)} placeholder="No limit" />
            </label>
            <label>
              <span>Stops working after (days)</span>
              <input type="number" min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} placeholder="Never" />
            </label>
          </div>
        )}
        <div className="acct-actions">
          <button
            className="btn primary"
            disabled={busy || d.offline}
            onClick={async () => {
              setBusy(true);
              const r = await run(hubc.invite(d.class.id, { role, maxUses: Number(maxUses) || null, expiresDays: Number(days) || null }));
              setBusy(false);
              if (!r) return;
              await navigator.clipboard.writeText(r.code).catch(() => {});
              toast(`Code ${r.code} made and copied.`, 'success');
              reload();
            }}
          >
            <Plus size={14} /> Make a code
          </button>
        </div>
      </div>
      <h2 className="sch-h2">Codes that work</h2>
      {live.length ? (
        <div className="sch-list">
          {live.map((i) => (
            <div key={i.code} className="sch-row hubc-invite">
              <span className="hubc-code">{i.code.replace(/(.{5})/, '$1-')}</span>
              <span className="sch-row-main muted">
                {i.role === 'ta' ? 'Teaching assistants' : 'Students'} · used {i.uses}
                {i.maxUses ? ` of ${i.maxUses}` : ''} {i.expiresAt ? `· until ${new Date(i.expiresAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : ''}
              </span>
              <button className="btn sm" onClick={() => copy(i.code, 'Code')}>
                <Copy size={13} /> Code
              </button>
              <button className="btn sm" onClick={() => copy(link(i.code), 'Link')} title={link(i.code)}>
                <Link2 size={13} /> Link
              </button>
              <button
                className="icon-btn sm"
                title="Turn off this code"
                disabled={d.offline}
                onClick={async () => {
                  if ((await ask('Turn off this code?', 'Nobody new can join with it. People already in the class stay.', [{ id: 'no', label: 'Cancel' }, { id: 'yes', label: 'Turn off', danger: true, primary: true }])) !== 'yes') return;
                  if (await run(hubc.revoke(i.code))) reload();
                }}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="muted">No codes yet.</p>
      )}
      {used.length > 0 && <p className="muted hubc-small">{used.length} used up or expired.</p>}
    </div>
  );
}

// ---------- Class settings / leaving ----------
function ClassSettings({ d, instructor, reload }: { d: HubClassDetail; instructor: boolean; reload(): void }) {
  const c = d.class;
  const [title, setTitle] = useState(c.title);
  const [description, setDescription] = useState(c.description || '');
  const [url, setUrl] = useState(c.meetingUrl || '');
  const [busy, setBusy] = useState(false);
  const creator = useMemo(() => instructor && d.members.some((m) => m.you && m.role === 'instructor'), [d]);
  return (
    <div>
      {instructor && (
        <div className="acct-card hubc-gap">
          <h3 className="hub-title">About the class</h3>
          <div className="acct-form">
            <label>
              <span>Name</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
            </label>
            <label>
              <span>About</span>
              <textarea className="input hubc-text" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={4000} />
            </label>
            <label>
              <span>Usual meeting link (used when a session has none)</span>
              <span className="hubc-row">
                <input className="grow" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://meet.jit.si/…" />
                <button className="btn sm" type="button" onClick={async () => { const l = await run(hubc.jitsi(title)); if (l) setUrl(l); }}>
                  <Link2 size={13} /> Make a Jitsi link
                </button>
              </span>
            </label>
            <div className="acct-actions">
              <button
                className="btn primary"
                disabled={busy || d.offline || !title.trim()}
                onClick={async () => {
                  setBusy(true);
                  const r = await run(hubc.update(c.id, { title, description, meetingUrl: url.trim() || null }));
                  setBusy(false);
                  if (r) (toast('Saved.', 'success'), useHubClasses.getState().load(), reload());
                }}
              >
                Save
              </button>
              <button
                className="btn"
                disabled={d.offline}
                onClick={async () => {
                  const archive = c.status === 'active';
                  if (archive && (await ask('Archive this class?', 'It leaves everyone’s class list and calendar, and its codes stop working. Its sets and scores are kept.', [{ id: 'no', label: 'Cancel' }, { id: 'yes', label: 'Archive', primary: true }])) !== 'yes') return;
                  const r = await run(hubc.update(c.id, { status: archive ? 'archived' : 'active' }));
                  if (r) (useHubClasses.getState().load(), archive ? go({ name: 'hub' }) : reload());
                }}
              >
                {c.status === 'active' ? 'Archive the class' : 'Bring the class back'}
              </button>
            </div>
          </div>
        </div>
      )}
      {!creator && (
        <div className="acct-card">
          <h3 className="hub-title">Leave the class</h3>
          <p className="muted acct-note">It comes off your class list and calendar. Your points stay on its leaderboard. You’d need a new code to come back.</p>
          <div className="acct-actions">
            <button
              className="btn"
              disabled={d.offline}
              onClick={async () => {
                if ((await ask(`Leave ${c.title}?`, 'You’d need a new code to come back.', [{ id: 'no', label: 'Cancel' }, { id: 'yes', label: 'Leave', danger: true, primary: true }])) !== 'yes') return;
                if (!(await run(hubc.leave(c.id)))) return;
                toast(`You left ${c.title}.`, 'success');
                await useHubClasses.getState().load();
                go({ name: 'hub' });
              }}
            >
              <LogOut size={13} /> Leave
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
