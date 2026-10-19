import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Circle, Loader2, Bot, Cpu, School, Play, KeyRound } from 'lucide-react';
import { api, ScholarSetup, SchoolInfo } from '../../lib/api';
import { toast } from '../../store';

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
          background with Kea's own instructions. It can read only Kea's class folder, your class site and the school platforms your classes link to, and it saves only into Kea.
        </p>
        <p className="muted">
          What it reads from your classes (announcements, assignments, grades, files, messages and discussion posts, including classmates' posts and names) is sent to Anthropic to be processed under your Claude account's terms. Your classes are stored on this computer and, if you turn on device sync, in your own OneDrive or Google Drive folder. Kea has no server of its own.
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

