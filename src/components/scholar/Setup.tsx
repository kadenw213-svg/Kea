import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Circle, Loader2, Bot, Cpu, School, Play, Square, RefreshCw, BookOpen, Bell, KeyRound, Activity } from 'lucide-react';
import { api, ScholarSetup, SchoolInfo, ScholarRun, ScholarNews } from '../../lib/api';
import { toast } from '../../store';
import { reloadScholar } from './scholarStore';

const timeAgo = (iso: string) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

function Step({ done, busy, icon, title, children }: { done: boolean; busy?: boolean; icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className={`setup-step ${done ? 'done' : ''}`}>
      <div className="setup-mark">{busy ? <Loader2 size={18} className="spin" /> : done ? <CheckCircle2 size={18} /> : <Circle size={18} />}</div>
      <div className="setup-body">
        <div className="setup-title">
          {icon} {title}
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * Connecting a school: Claude Code (the user's own Claude account), the scan engine (Python, through uv), the class
 * site with Kea's sign-in, then a test and the first scan. Each piece says what it is and why it's needed.
 */
export function SetupWizard({ onDone }: { onDone?(): void }) {
  const [c, setC] = useState<ScholarSetup | null>(null);
  const [school, setSchool] = useState<SchoolInfo | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState('');
  const [home, setHome] = useState('');
  const [remember, setRemember] = useState(true);
  const [probe, setProbe] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  const refresh = async () => {
    const [cc, s, st] = await Promise.all([api.scholar.check(), api.scholar.school(), api.scholar.siteStatus()]);
    setC(cc);
    setSchool(s);
    setSignedIn(st.signedIn);
    if (s.home && !home) setHome(s.home);
  };
  useEffect(() => {
    refresh();
    return api.scholar.onSetupLine((l) => setLog((x) => (x + l).slice(-6000)));
  }, []);
  useEffect(() => {
    logRef.current?.scrollTo({ top: 1e9 });
  }, [log]);

  const act = async (id: string, fn: () => Promise<any>, ok?: string) => {
    setBusy(id);
    setLog('');
    try {
      await fn();
      if (ok) toast(ok, 'success');
    } catch (err: any) {
      toast(String(err?.message || err).split('\n')[0], 'error');
    } finally {
      setBusy(null);
      refresh();
    }
  };

  if (!c || !school) return <Loader2 size={18} className="spin" />;
  const claudeOk = !!c.claude && c.account.loggedIn;
  const engineOk = !!c.uv && c.engineReady;
  const siteOk = !!school.home && signedIn;
  const all = claudeOk && engineOk && siteOk;

  return (
    <div className="setup">
      <Step done={claudeOk} busy={busy === 'claude'} icon={<Bot size={16} />} title="Your Claude account">
        <p>
          Kea uses <b>Claude Code</b>, Anthropic's free app for your Claude account, to read your class site and write your textbook chapters. It runs hidden in the
          background with Kea's own instructions, and can only read your class site and save into Kea.
        </p>
        {!c.claude ? (
          <button className="btn tonal sm" disabled={!!busy} onClick={() => act('claude', () => api.scholar.installClaude(), 'Claude Code is installed.')}>
            Install Claude Code
          </button>
        ) : !c.account.loggedIn ? (
          <button className="btn tonal sm" disabled={!!busy} onClick={() => act('claude', () => api.scholar.signInClaude())}>
            Sign in to Claude
          </button>
        ) : (
          <div className="setup-ok">
            Signed in{c.account.email ? ` as ${c.account.email}` : ''}
            {c.account.plan ? ` (Claude ${c.account.plan[0].toUpperCase()}${c.account.plan.slice(1)})` : ''}.
          </div>
        )}
        {c.claude && !c.account.loggedIn && <p className="muted">Signing in opens a small window and your browser. Kea notices when you're done.</p>}
      </Step>

      <Step done={engineOk} busy={busy === 'engine'} icon={<Cpu size={16} />} title="The scan engine">
        <p>
          The exact parts of a scan (reading dates, matching each assignment once, building textbook PDFs) are done by a small Python program that comes with Kea.{' '}
          <b>uv</b> installs Python and what it needs, in your own user folder (no admin rights, nothing system-wide).
        </p>
        {!c.uv ? (
          <button className="btn tonal sm" disabled={!!busy} onClick={() => act('engine', () => api.scholar.installUv(), 'uv is installed.')}>
            Install uv
          </button>
        ) : !c.engineReady ? (
          <button className="btn tonal sm" disabled={!!busy} onClick={() => act('engine', () => api.scholar.setupEngine(), 'The scan engine is ready.')}>
            Set up the scan engine (about a minute)
          </button>
        ) : (
          <div className="setup-ok">Ready.</div>
        )}
      </Step>

      <Step done={siteOk} busy={busy === 'site'} icon={<School size={16} />} title="Your class site">
        <p>The address of your school's D2L (Brightspace) home page, the page you see after you sign in.</p>
        <div className="setup-row">
          <input className="input" value={home} placeholder="https://yourschool.edu/d2l/home" onChange={(e) => setHome(e.target.value)} />
          <button
            className="btn tonal sm"
            disabled={!!busy || !/^https:\/\/\S+$/.test(home.trim())}
            onClick={() =>
              act('site', async () => {
                await api.scholar.setSchoolHome(home.trim());
                const r = await api.scholar.signIn(remember);
                if (!r.signedIn) throw new Error('Not signed in yet. Try again when you are ready.');
              }, 'Signed in to your class site.')
            }
          >
            {signedIn ? 'Sign in again' : 'Sign in'}
          </button>
        </div>
        <label className="setup-check">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Let Kea sign me in next time
        </label>
        <p className="muted">
          You sign in yourself, in a Kea window. With this on, Kea saves that login on this computer, encrypted by Windows, and uses it when your class site asks
          again, the way a password manager does. Claude never sees it.
        </p>
        {school.remembers && (
          <div className="setup-ok">
            <KeyRound size={13} /> Kea remembers your login for {school.loginHost}.{' '}
            <button className="link-btn" onClick={() => act('site', () => api.scholar.forgetLogin(), 'Kea forgot your saved login.')}>
              Forget it
            </button>
          </div>
        )}
        {signedIn && <div className="setup-ok">Signed in.</div>}
      </Step>

      <Step done={!!probe && all} busy={busy === 'probe'} icon={<Play size={16} />} title="Check and scan">
        <p>
          A quick test that everything talks to each other, then your first scan. <b>Scans use your Claude plan's usage</b>: a first scan of all your classes is the
          biggest (it reads everything once); daily checks are small.
        </p>
        <div className="setup-row">
          <button
            className="btn sm"
            disabled={!!busy || !claudeOk}
            onClick={() =>
              act('probe', async () => {
                await api.scholar.run('probe');
                for (let i = 0; i < 90; i++) {
                  await new Promise((r) => setTimeout(r, 2000));
                  const st = await api.scholar.runStatus();
                  if (!st.running && !st.queued.length) break;
                }
                const a = (await api.scholar.activity())[0];
                setProbe(a?.ok ? a.summary : `Failed: ${a?.summary || 'no answer'}`);
              })
            }
          >
            Test the connection
          </button>
          <button
            className="btn tonal sm"
            disabled={!!busy || !all}
            onClick={async () => {
              await api.scholar.run('import');
              toast('Scanning your classes in the background. You can keep working; Kea shows progress under Scans.', 'success');
              onDone?.();
            }}
          >
            Scan my classes
          </button>
        </div>
        {probe && <div className="setup-ok">{probe}</div>}
      </Step>

      {log && (
        <pre className="setup-log" ref={logRef}>
          {log}
        </pre>
      )}
    </div>
  );
}

/** Scans: what's running, what ran, and the news from your classes (what the daily email used to say). */
export function ScansView() {
  const [run, setRun] = useState<(ScholarRun & { running: boolean }) | null>(null);
  const [activity, setActivity] = useState<ScholarRun[]>([]);
  const [news, setNews] = useState<ScholarNews[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const load = async () => {
    const [st, a, n] = await Promise.all([api.scholar.runStatus(), api.scholar.activity(), api.scholar.news()]);
    setRun(st.running ? { ...st.running, running: true } : null);
    setActivity(a);
    setNews(n);
  };
  useEffect(() => {
    load();
    const offs = [
      api.scholar.onRun((r) => {
        setRun(r.running ? r : null);
        if (!r.running) (load(), reloadScholar());
      }),
      api.scholar.onNews(() => load())
    ];
    return () => offs.forEach((f) => f());
  }, []);
  useEffect(() => {
    if (news.some((n) => !n.read)) api.scholar.markNewsRead();
  }, [news]);
  const start = (task: 'daily' | 'sync' | 'study') => api.scholar.run(task).then(() => toast('Started in the background.', 'success'));
  return (
    <div className="sch-page">
      <h1 className="sch-title">Scans</h1>
      <p className="sch-sub">Kea checks your classes every day by itself. You can also run a check now.</p>
      <div className="scan-actions">
        <button className="btn sm" onClick={() => start('daily')} disabled={!!run}>
          <RefreshCw size={14} /> Check my classes now
        </button>
        <button className="btn sm" onClick={() => start('sync')} disabled={!!run}>
          <Activity size={14} /> Update readings and links
        </button>
        <button className="btn sm" onClick={() => start('study')} disabled={!!run}>
          <BookOpen size={14} /> Write this week's textbook chapters
        </button>
        {run && (
          <button className="btn sm" onClick={() => api.scholar.stop()}>
            <Square size={14} /> Stop
          </button>
        )}
      </div>
      {run && (
        <div className="scan-now">
          <Loader2 size={16} className="spin" />
          <div>
            <b>{run.label}</b>
            <div className="muted">{run.steps[run.steps.length - 1]?.message || 'Starting…'}</div>
          </div>
        </div>
      )}
      {news.length > 0 && (
        <section>
          <h2 className="sch-h2">
            <Bell size={13} /> From your classes
          </h2>
          <div className="sch-list">
            {news.slice(0, 40).map((n) => (
              <div key={n.id} className="news-item" onClick={() => setOpen(open === n.id ? null : n.id)}>
                <div className="news-head">
                  {n.course && <span className="sch-chip">{n.course}</span>}
                  <b>{n.title}</b>
                  <span className="muted">{timeAgo(n.at)}</span>
                </div>
                <div className={`news-body ${open === n.id ? 'open' : ''}`}>{n.body}</div>
              </div>
            ))}
          </div>
        </section>
      )}
      <section>
        <h2 className="sch-h2">Recent scans</h2>
        {!activity.length ? (
          <div className="muted">No scans yet.</div>
        ) : (
          <div className="sch-list">
            {activity.slice(0, 20).map((a) => (
              <div key={a.id} className="news-item" onClick={() => setOpen(open === a.id ? null : a.id)}>
                <div className="news-head">
                  {a.ok ? <CheckCircle2 size={15} color="#81c995" /> : <Circle size={15} color="#f28b82" />}
                  <b>{a.label}</b>
                  <span className="muted">
                    {timeAgo(a.start)}
                    {a.why === 'schedule' ? ' · scheduled' : ''}
                  </span>
                </div>
                <div className={`news-body ${open === a.id ? 'open' : ''}`}>{a.summary}</div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
