import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, XCircle, Loader2, Play, Square, RefreshCw, BookOpen, Bell, Activity, Clock, Smartphone, Monitor, Search, Download, Crown, Cloud, ChevronDown, ChevronRight, Settings2 } from 'lucide-react';
import { api, DeviceShare, DevicesStatus, QueuedRun, RunProgress, ScholarNews, ScholarPending, ScholarRun } from '../../lib/api';
import { useSetting, openSettings } from '../../lib/settings';
import { toast } from '../../store';
import { reloadScholar } from './scholarStore';

const APK = 'https://github.com/kadenw213-svg/kea/releases/latest/download/Kea-Android.apk';

// ---------- Time and progress ----------
const ago = (iso?: string | null) => {
  if (!iso) return 'never';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};
export const span = (ms: number) => {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
};
const classOf = (arg?: string) => /^([A-Z]{2,5}\d{3,5})\b/.exec(String(arg || '').trim())?.[1] || '';

/**
 * How far a run is (0–1) and roughly how long is left, from what runs like it took before (time and Claude's steps),
 * what Claude says (percent), the rest of its batch and the queue behind it.
 */
export function progressOf(r: RunProgress, queue: QueuedRun[], now: number) {
  const exp = r.expectedMs || 5 * 60000;
  let f: number;
  let left: number;
  if (r.phase !== 'claude') {
    // Kea's own check first: quick, and often all there is.
    f = Math.min(0.08, 0.02 + ((now - Date.parse(r.start)) / 60000) * 0.06);
    left = exp;
  } else {
    const elapsed = now - Date.parse(r.claudeStart || r.start);
    const parts = [elapsed / exp];
    if (r.expectedTurns) parts.push((r.turns || 0) / r.expectedTurns);
    if (r.percent != null) parts.push(r.percent / 100);
    const raw = Math.min(0.97, parts.reduce((a, b) => a + b, 0) / parts.length);
    f = 0.08 + 0.9 * raw;
    // Blend the usual length with this run's own pace once it's well under way.
    const total = raw > 0.15 ? (exp + elapsed / raw) / 2 : exp;
    left = Math.max(30000, total - elapsed);
  }
  const b = r.batch;
  const overall = b && b.total > 1 ? (b.done + f) / b.total : f;
  const queued = queue.reduce((n, q) => n + (q.expectedMs || 0), 0);
  return { overall: Math.max(0.02, Math.min(0.99, overall)), left, all: left + queued };
}

export function useNow(on: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

export function Bar({ value, tone }: { value: number; tone?: 'amber' }) {
  return (
    <div className={`kbar ${tone || ''}`} role="progressbar" aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100}>
      <i style={{ width: `${Math.round(value * 1000) / 10}%` }} />
    </div>
  );
}

// ---------- The status card: what's happening now ----------
function StatusCard({ run, queue, paused, dev, lastRun }: { run: RunProgress | null; queue: QueuedRun[]; paused: ScholarPending | null; dev: DevicesStatus | null; lastRun: ScholarRun | undefined }) {
  const now = useNow(!!run);
  const remote = dev?.role === 'follower';
  const where = remote ? dev?.primary?.name : null;
  const scanTime = useSetting<string>('scholar.scanTime') || '05:00';
  const every = useSetting<string>('scholar.scanEvery') || '1';
  const start = async (task: 'daily' | 'sync' | 'study') => {
    try {
      const r = await api.scholar.run(task);
      toast(typeof r === 'object' && r.relayed ? `Asked ${r.relayed} to run it${r.online ? '' : ' (it starts when that device is next on)'}.` : 'Started.', 'success');
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };

  if (run) {
    const p = progressOf(run, queue, now);
    const code = classOf(run.arg);
    return (
      <section className="kcard scan-hero running">
        <div className="hero-top">
          <Loader2 size={20} className="spin hero-icon" />
          <div className="hero-text">
            <div className="hero-title">
              {run.label}
              {code ? ` · ${code}` : ''}
            </div>
            <div className="hero-sub">
              {run.batch && run.batch.total > 1 ? `Class ${Math.min(run.batch.done + 1, run.batch.total)} of ${run.batch.total} · ` : ''}
              {run.phase === 'claude' ? 'Claude is reading' : 'Kea is checking by itself'}
              {where ? ` · on ${where}` : ''}
            </div>
          </div>
          <button className="btn sm" onClick={() => api.scholar.stop().then(() => toast(remote ? `Asked ${where} to stop.` : 'Stopping.', 'success'))}>
            <Square size={13} /> Stop
          </button>
        </div>
        <Bar value={p.overall} />
        <div className="hero-meta">
          <span>
            <b>About {span(queue.length ? p.all : p.left)} left</b>
            {queue.length ? ` (this part: ${span(p.left)})` : ''}
          </span>
          <span>{Math.round(p.overall * 100)}%</span>
        </div>
        {run.step && <div className="hero-step">{run.step}</div>}
        {!!queue.length && (
          <div className="hero-queue">
            Then: {queue.slice(0, 4).map((q) => (q.label === run.label && classOf(q.arg) ? classOf(q.arg) : classOf(q.arg) ? `${q.label} (${classOf(q.arg)})` : q.label)).join(', ')}
            {queue.length > 4 ? ` · and ${queue.length - 4} more` : ''}
          </div>
        )}
      </section>
    );
  }

  if (paused) {
    const until = new Date(paused.until);
    return (
      <section className="kcard scan-hero paused">
        <div className="hero-top">
          <Clock size={20} className="hero-icon" />
          <div className="hero-text">
            <div className="hero-title">
              {paused.label} is paused{paused.more ? ` (and ${paused.more} more run${paused.more > 1 ? 's' : ''} waiting)` : ''}
            </div>
            <div className="hero-sub">
              {paused.reason === 'closed' ? 'Kea closed while it was running.' : paused.reason === 'error' ? 'Claude couldn’t be reached.' : 'Your Claude usage limit was reached.'} Everything found so far is saved, and it
              continues where it stopped
              {until.getTime() <= Date.now() ? ' as soon as Kea is ready' : ` at ${until.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`}
              {until.getTime() > Date.now() && until.toDateString() !== new Date().toDateString() ? ` on ${until.toLocaleDateString(undefined, { weekday: 'long' })}` : ''}
              {where ? ` on ${where}` : ''}.
            </div>
          </div>
          <button className="btn sm" onClick={() => api.scholar.resume().then(() => toast('Continuing.', 'success'))}>
            <Play size={13} /> Continue now
          </button>
        </div>
        <Bar value={Math.max(0.02, 1 - (until.getTime() - Date.now()) / (5 * 3600e3))} tone="amber" />
      </section>
    );
  }

  const next = Number(every) ? `Checks ${Number(every) === 1 ? 'every day' : Number(every) === 7 ? 'once a week' : `every ${every} days`} after ${new Date(`2000-01-01T${scanTime}`).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'Checks run only when you ask';
  return (
    <section className="kcard scan-hero idle">
      <div className="hero-top">
        {lastRun && lastRun.ok === false ? <XCircle size={20} className="hero-icon bad" /> : <CheckCircle2 size={20} className="hero-icon good" />}
        <div className="hero-text">
          <div className="hero-title">{lastRun && lastRun.ok === false ? 'The last scan didn’t finish' : 'Your classes are up to date'}</div>
          <div className="hero-sub">
            {lastRun ? `Last scan ${ago(lastRun.end || lastRun.start)} (${lastRun.label}${classOf(lastRun.arg) ? `, ${classOf(lastRun.arg)}` : ''})` : 'No scans yet'} · {next}
            {where ? ` · scans run on ${where}` : ''}
          </div>
        </div>
      </div>
      <div className="hero-actions">
        <button className="btn primary" onClick={() => start('daily')}>
          <RefreshCw size={14} /> Check now
        </button>
        <button className="btn sm ghost" onClick={() => start('sync')} title="Readings, links and anything that changed in each class">
          <Activity size={14} /> Update readings
        </button>
        <button className="btn sm ghost" onClick={() => start('study')} title="Textbook chapters still to write">
          <BookOpen size={14} /> Write chapters
        </button>
        <button className="btn sm ghost icon-only" onClick={() => openSettings('scholar')} title="When and how often Kea checks">
          <Settings2 size={14} />
        </button>
      </div>
    </section>
  );
}

// ---------- Devices: the drive, every device, which one is the primary ----------
function DevicesCard({ dev, reload }: { dev: DevicesStatus | null; reload: () => void }) {
  const [busy, setBusy] = useState('');
  const [finding, setFinding] = useState(false);
  if (!dev) return null;
  const act = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    try {
      await fn();
      if (done) toast(done, 'success');
      reload();
      reloadScholar();
    } catch (err: any) {
      toast(err.message, 'error');
    }
    setBusy('');
  };
  const driveName = (d: { label: string; account: string }) => (d.account ? `${d.label} · ${d.account}` : d.label);
  const auto = dev.drives.find((d) => d.id === 'onedrive') || dev.drives.find((d) => d.id === 'google') || dev.drives[0];
  const others = dev.devices.filter((d) => !d.me);
  return (
    <section className="kcard devices">
      <div className="kcard-head">
        <h2>Devices</h2>
        {dev.role === 'follower' && dev.waiting ? (
          <span className="pill amber">Bringing your classes in…</span>
        ) : dev.role === 'follower' ? (
          <span className="pill good">In step with {dev.primary?.name}</span>
        ) : dev.role === 'primary' && others.length ? (
          <span className="pill good">This device scans for {others.length === 1 ? '1 other' : `${others.length} others`}</span>
        ) : null}
      </div>

      <label className="drive-row">
        <Cloud size={16} />
        <span>Sync through</span>
        <select value={dev.choice} disabled={!!busy} onChange={(e) => act('drive', () => api.scholar.setDrive(e.target.value))}>
          <option value="auto">Automatic{auto ? ` (${driveName(auto)})` : ''}</option>
          {dev.drives
            .filter((d) => d.id !== 'dropbox' || dev.choice === 'dropbox')
            .map((d) => (
              <option key={d.id} value={d.id}>
                {driveName(d)}
              </option>
            ))}
          {dev.choice === 'custom' && <option value="custom">Your own folder (Settings)</option>}
          <option value="off">Don’t sync</option>
        </select>
      </label>
      {!dev.drive && dev.choice !== 'off' && <p className="warn-line">That drive isn’t on this computer. Install OneDrive or Google Drive and sign in, or pick another one above.</p>}
      {dev.drive && <p className="hint-line">Every device must use this same drive and account to see each other.</p>}

      {dev.waiting && (
        <div className="wait-box">
          <div>
            Your classes from <b>{dev.primary?.name}</b> are downloading from {dev.drive?.label}…
          </div>
          <Bar value={dev.waiting.of ? dev.waiting.have / dev.waiting.of : 0.05} />
        </div>
      )}

      {dev.elsewhere.map((s) => (
        <div key={s.root + s.profile} className="alert-row">
          <div>
            <b>{s.primary}</b> shares classes as “{s.profile}” in {s.label}, separately from this device.
          </div>
          <button className="btn sm primary" disabled={!!busy} onClick={() => act('join', () => api.scholar.devicesJoin(s), `Using ${s.primary}'s classes here.`)}>
            Use those
          </button>
        </div>
      ))}

      {dev.drive && dev.on && (
        <div className="dev-list">
          {dev.devices.map((d) => (
            <div key={d.id} className={`dev-row ${d.online ? '' : 'off'}`}>
              <Monitor size={18} />
              <div className="dev-main">
                <div className="dev-name">
                  {d.name}
                  {d.me && <span className="tag">This device</span>}
                  {d.primary && (
                    <span className="tag primary">
                      <Crown size={11} /> Primary · scans
                    </span>
                  )}
                </div>
                <div className="dev-sub">
                  {d.me ? 'On now' : d.online ? 'On now' : `Last on ${ago(d.at)}`}
                  {d.drive ? ` · ${driveName(d.drive)}` : ''}
                  {d.version ? ` · Kea ${d.version}` : ''}
                </div>
              </div>
              {!d.primary && (
                <button
                  className="btn sm"
                  disabled={!!busy}
                  onClick={() => act(`p-${d.id}`, () => api.scholar.makePrimary(d.id), d.me ? 'This device now does the scans.' : `${d.name} now does the scans${d.online ? '' : ' (from when it’s next on)'}.`)}
                >
                  {busy === `p-${d.id}` ? <Loader2 size={13} className="spin" /> : <Crown size={13} />} Make primary
                </button>
              )}
            </div>
          ))}
          <div className="dev-row">
            <Smartphone size={18} />
            <div className="dev-main">
              <div className="dev-name">Android phone</div>
              <div className="dev-sub">
                {dev.phone ? (
                  `Last synced ${ago(dev.phone.at)}`
                ) : (
                  <>
                    Not set up. On your phone, open <span className="pn-select">{APK}</span> and install it.
                  </>
                )}
              </div>
            </div>
          </div>
          {!others.length && <p className="hint-line">Open Kea on another computer with the same drive and it shows up here within a minute. Only the primary scans; the others just keep in step.</p>}
        </div>
      )}

      <button className="link-btn" onClick={() => setFinding(!finding)}>
        {finding ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Bring in classes from another device
      </button>
      {finding && <FromAnotherDevice onDone={reload} />}
    </section>
  );
}

/**
 * Bring in the classes another device shares: looks in every drive on this computer, lists what it finds (or says
 * what's missing), and makes this device follow that one's primary.
 */
export function FromAnotherDevice({ onDone }: { onDone?: () => void }) {
  const [res, setRes] = useState<Awaited<ReturnType<typeof api.scholar.devicesFind>> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const look = async () => {
    setBusy('find');
    try {
      setRes(await api.scholar.devicesFind());
    } catch (err: any) {
      toast(err.message, 'error');
    }
    setBusy(null);
  };
  useEffect(() => {
    look();
  }, []);
  const use = async (s: DeviceShare) => {
    setBusy(s.root + s.profile);
    try {
      const r = await api.scholar.devicesJoin(s);
      if (r.primary) toast('This device is already the primary for these classes.', 'success');
      else if (r.ok) toast(`Your classes from ${r.from} are here. This device now keeps in step with it.`, 'success');
      else toast(r.waiting || 'Still waiting for the drive.', 'success');
      reloadScholar();
      onDone?.();
    } catch (err: any) {
      toast(err.message, 'error');
    }
    setBusy(null);
  };
  return (
    <div className="find-box">
      {!res ? (
        <div className="muted">
          <Loader2 size={14} className="spin" /> Looking in your drives…
        </div>
      ) : (
        <>
          {res.found.map((s) => (
            <div key={s.root + s.profile} className="dev-row">
              <Cloud size={18} />
              <div className="dev-main">
                <div className="dev-name">{s.profile}</div>
                <div className="dev-sub">
                  {s.mine ? 'This device is its primary' : `Scanned by ${s.primary}, last on ${ago(s.at)}`} · {s.account ? `${s.label} · ${s.account}` : s.label}
                  {!s.ready && !s.mine ? ' · still downloading' : ''}
                </div>
              </div>
              <button className="btn sm primary" disabled={!!busy || s.mine} onClick={() => use(s)}>
                {busy === s.root + s.profile ? <Loader2 size={13} className="spin" /> : <Download size={13} />} {s.mine ? 'This device' : 'Use these classes'}
              </button>
            </div>
          ))}
          {!res.found.length && <p className="muted">No classes from another device were found on {res.me}.</p>}
          {res.notes.map((n) => (
            <p key={n} className="hint-line">
              {n}
            </p>
          ))}
          <button className="btn sm" onClick={look} disabled={!!busy}>
            {busy === 'find' ? <Loader2 size={13} className="spin" /> : <Search size={13} />} Look again
          </button>
        </>
      )}
    </div>
  );
}

// ---------- History ----------
function History({ activity }: { activity: ScholarRun[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  if (!activity.length) return null;
  const list = all ? activity : activity.slice(0, 8);
  return (
    <section className="kcard">
      <div className="kcard-head">
        <h2>Recent scans</h2>
      </div>
      <div className="hist">
        {list.map((a) => {
          const ms = a.end ? new Date(a.end).getTime() - new Date(a.start).getTime() : 0;
          return (
            <div key={a.id} className={`hist-row ${open === a.id ? 'open' : ''}`} onClick={() => setOpen(open === a.id ? null : a.id)}>
              <div className="hist-head">
                {a.ok ? <CheckCircle2 size={15} className="good" /> : a.paused ? <Clock size={15} className="amber" /> : <XCircle size={15} className="bad" />}
                <span className="hist-label">
                  {a.label}
                  {classOf(a.arg) ? ` · ${classOf(a.arg)}` : ''}
                </span>
                <span className="hist-meta">
                  {ago(a.start)}
                  {ms ? ` · ${span(ms)}` : ''}
                  {a.why === 'schedule' ? ' · scheduled' : ''}
                </span>
              </div>
              {open === a.id && <div className="hist-body">{a.summary}</div>}
            </div>
          );
        })}
      </div>
      {activity.length > 8 && (
        <button className="link-btn" onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${activity.length}`}
        </button>
      )}
    </section>
  );
}

/**
 * The run in progress and the queue behind it, live: this device's, or (on a device that isn't the primary) the
 * primary's, read from the drive every few seconds. Off when `on` is false.
 */
export function useLiveRun(on = true) {
  const [run, setRun] = useState<ScholarRun | null>(null);
  const [queue, setQueue] = useState<QueuedRun[]>([]);
  const [dev, setDev] = useState<DevicesStatus | null>(null);
  useEffect(() => {
    if (!on) return;
    let live = true;
    const load = () =>
      Promise.all([api.scholar.runStatus(), api.scholar.devices().catch(() => null)]).then(([st, d]) => {
        if (!live) return;
        setRun(st.running);
        setQueue(st.queued);
        setDev(d);
      });
    load();
    const off = api.scholar.onRun((r) => {
      setRun(r.running ? r : null);
      api.scholar.runStatus().then((s) => live && setQueue(s.queued));
    });
    const t = setInterval(load, 5000);
    return () => ((live = false), off(), clearInterval(t));
  }, [on]);
  if (run) return { run: { ...run, step: run.steps[run.steps.length - 1]?.message || '' } as RunProgress, queue };
  return dev?.role === 'follower' ? { run: dev.run, queue: dev.queue || [] } : { run: null as RunProgress | null, queue };
}

/** Scans: what's happening now (with a progress bar and time left), your devices, and what ran before. */
export function ScansView() {
  const [run, setRun] = useState<ScholarRun | null>(null);
  const [queue, setQueue] = useState<QueuedRun[]>([]);
  const [activity, setActivity] = useState<ScholarRun[]>([]);
  const [news, setNews] = useState<ScholarNews[]>([]);
  const [paused, setPaused] = useState<ScholarPending | null>(null);
  const [dev, setDev] = useState<DevicesStatus | null>(null);
  const load = async () => {
    const [st, a, n, p, d] = await Promise.all([api.scholar.runStatus(), api.scholar.activity(), api.scholar.news(), api.scholar.pending(), api.scholar.devices().catch(() => null)]);
    setRun(st.running);
    setQueue(st.queued);
    setActivity(a);
    setNews(n);
    setPaused(p);
    setDev(d);
  };
  const loadDevices = () => api.scholar.devices().then(setDev).catch(() => {});
  useEffect(() => {
    load();
    const offs = [
      api.scholar.onRun((r) => {
        setRun(r.running ? r : null);
        api.scholar.runStatus().then((s) => setQueue(s.queued));
        if (!r.running) (load(), reloadScholar());
      }),
      api.scholar.onNews(() => load()),
      api.scholar.onResume((p) => setPaused(p)),
      api.scholar.onChanged(() => loadDevices())
    ];
    // Another device's progress arrives through the drive: look again every few seconds while it runs.
    const t = setInterval(loadDevices, 5000);
    return () => (offs.forEach((f) => f()), clearInterval(t));
  }, []);
  // A run here, or (on a device that isn't the primary) the primary's run.
  const shown: RunProgress | null = useMemo(() => {
    if (run) return { ...run, step: run.steps[run.steps.length - 1]?.message || '' };
    return dev?.role === 'follower' ? dev.run : null;
  }, [run, dev]);
  const shownQueue = run ? queue : dev?.queue || [];
  const shownPaused = dev?.role === 'follower' ? dev.pending || null : paused;
  return (
    <div className="sch-page scans">
      <h1 className="sch-title">Scans</h1>
      <StatusCard run={shown} queue={shownQueue} paused={shown ? null : shownPaused} dev={dev} lastRun={activity[0]} />
      {news.some((n) => !n.read) && (
        <p className="muted inbox-hint">
          <Bell size={13} /> New messages, grades and announcements are in the Inbox.
        </p>
      )}
      <DevicesCard dev={dev} reload={loadDevices} />
      <History activity={activity} />
    </div>
  );
}
