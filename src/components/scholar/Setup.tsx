import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Circle, Loader2, Bot, Cpu, School, Play, KeyRound, Copy, RefreshCw } from 'lucide-react';
import { api, ScholarSetup, SchoolInfo, SchoolPlatform } from '../../lib/api';
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
 * Signing Claude Code in (first setup, or again after its sign-in expires, about once a month), as numbered steps,
 * with the command to type by hand when no window opens.
 */
export function ClaudeSignIn({ onDone, again }: { onDone?(signedIn: boolean): void; again?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [command, setCommand] = useState('');
  const go = async () => {
    setBusy(true);
    setFailed(false);
    let ok = false;
    try {
      const r = await api.scholar.signInClaude();
      ok = r.loggedIn;
      if (r.command) setCommand(r.command);
      if (ok) toast(`Claude is connected${r.email ? ` as ${r.email}` : ''}.`, 'success');
      else setFailed(true);
    } catch (err: any) {
      toast(String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '').split('\n')[0], 'error');
      setFailed(true);
    }
    setBusy(false);
    onDone?.(ok);
  };
  return (
    <div className="claude-signin">
      <ol className="claude-steps">
        <li>Click <b>{again ? 'Sign in to Claude again' : 'Sign in to Claude'}</b>. A small black window opens, and then your browser.</li>
        <li>In the browser, sign in with your Claude account and click <b>Authorize</b>.</li>
        <li>If the small window asks you to paste a code, copy it from the browser, paste it there and press Enter.</li>
        <li>Come back here. Kea notices by itself when you’re signed in.</li>
      </ol>
      <div className="setup-row">
        <button className="btn tonal sm" disabled={busy} onClick={go}>
          {busy ? (
            <>
              <Loader2 size={13} className="spin" /> Waiting for you to sign in…
            </>
          ) : again ? (
            'Sign in to Claude again'
          ) : (
            'Sign in to Claude'
          )}
        </button>
      </div>
      {busy && <p className="muted">Close the small window to stop waiting.</p>}
      {failed && (
        <div className="claude-manual">
          <p className="warn-line">You’re not signed in yet. Try again, or if no window opened, sign in by hand:</p>
          <ol className="claude-steps">
            <li>Press the Windows key, type <b>Terminal</b> and open it.</li>
            <li>
              Paste this and press Enter:
              {command && (
                <div className="setup-row">
                  <code className="claude-cmd">{command}</code>
                  <button className="btn sm" onClick={() => (navigator.clipboard.writeText(command), toast('Copied.', 'success'))}>
                    <Copy size={13} /> Copy
                  </button>
                </div>
              )}
            </li>
            <li>Follow steps 2 and 3 above, then click <b>Check again</b>.</li>
          </ol>
          <button className="btn sm" onClick={() => onDone?.(false)}>
            <RefreshCw size={13} /> Check again
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Shown at the top of Scans when this computer's own Claude was set up but has signed out (Claude Code's sign-in
 * expires about once a month): what happened, and the same steps as first setup to connect it again.
 */
export function ClaudeReconnect() {
  const [c, setC] = useState<ScholarSetup | null>(null);
  const load = () => api.scholar.check().then(setC).catch(() => {});
  useEffect(() => {
    load();
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, []);
  if (!c || !c.claude || c.account.loggedIn || !c.hasData) return null;
  return (
    <div className="gate claude-reconnect">
      <h2>
        <Bot size={18} /> Your Claude is signed out
      </h2>
      <p>
        Claude Code’s sign-in expires now and then (usually about once a month), so Kea can’t use your Claude plan until you sign in again. Until then, scans and new study
        questions wait or use Kea’s shared Claude if your Kea account has it. Nothing you’ve saved is lost.
      </p>
      <ClaudeSignIn again onDone={() => load()} />
    </div>
  );
}

/**
 * Connecting a school: Claude Code (the user's own Claude account), the scan engine (Python, through uv), the class
 * site with Kea's sign-in, then a test and the first scan. Each piece says what it is and why it's needed. `target`:
 * which class site this sets up (another school's, from Add a class); the first one when left out.
 */
export function SetupWizard({ onDone, target }: { onDone?(): void; target?: string }) {
  const [c, setC] = useState<ScholarSetup | null>(null);
  const [school, setSchool] = useState<SchoolInfo | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState('');
  const [home, setHome] = useState('');
  const [platform, setPlatform] = useState<SchoolPlatform | null>(null);
  const [remember, setRemember] = useState(true);
  const [probe, setProbe] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  const refresh = async () => {
    const [cc, s, st] = await Promise.all([api.scholar.check(target), api.scholar.school(target), api.scholar.siteStatus(target)]);
    setC(cc);
    setSchool(s);
    setSignedIn(st.signedIn);
    if (s.home && !home) setHome(s.home);
    if (s.home && !platform) setPlatform(s.platform);
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
  // The platform, guessed from the address until the student picks one (D2L homes are under /d2l/; Canvas sites are
  // mostly *.instructure.com).
  const guessed: SchoolPlatform = /\/d2l\//i.test(home) ? 'd2l' : /instructure\.com|\/\/canvas\./i.test(home) ? 'canvas' : 'd2l';
  const site = platform || guessed;

  return (
    <div className="setup">
      <Step done={claudeOk} busy={busy === 'claude'} icon={<Bot size={16} />} title="Your Claude account">
        <p>
          Kea uses <b>Claude Code</b>, Anthropic's free app for your Claude account, to read your class site and write your textbook chapters. It runs hidden in the
          background with Kea's own instructions. It can read only Kea's class folder, your class site and the school platforms your classes link to, and it saves only into Kea.
        </p>
        <p className="muted">
          What it reads from your classes (announcements, assignments, grades, files, messages and discussion posts, including classmates' posts and names) is sent to Anthropic to be processed under your Claude account's terms. Your classes are stored on this computer, and a copy goes to the drive chosen under Scans → Devices (your Kea account’s own folder in Kea cloud when you’re signed in, otherwise your OneDrive or Google Drive) so your phone and your other computers can use them. Choose “Don’t sync” there to keep them only on this computer. Kea never brings in another computer’s classes unless you say so.
        </p>
        {!c.claude ? (
          <button className="btn tonal sm" disabled={!!busy} onClick={() => act('claude', () => api.scholar.installClaude(), 'Claude Code is installed.')}>
            Install Claude Code
          </button>
        ) : !c.account.loggedIn ? (
          <ClaudeSignIn onDone={refresh} />
        ) : (
          <div className="setup-ok">
            Signed in{c.account.email ? ` as ${c.account.email}` : ''}
            {c.account.plan ? ` (Claude ${c.account.plan[0].toUpperCase()}${c.account.plan.slice(1)})` : ''}.
          </div>
        )}
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
          <button className="btn tonal sm" disabled={!!busy} onClick={() => act('engine', () => api.scholar.setupEngine(target), 'The scan engine is ready.')}>
            Set up the scan engine (about a minute)
          </button>
        ) : (
          <div className="setup-ok">Ready.</div>
        )}
      </Step>

      <Step done={siteOk} busy={busy === 'site'} icon={<School size={16} />} title="Your class site">
        <p>Which system your school uses for classes, and the address of its home page (the page you see after you sign in).</p>
        <div className="seg-row" role="radiogroup" aria-label="Your school's class site">
          {(
            [
              ['d2l', 'D2L Brightspace'],
              ['canvas', 'Canvas']
            ] as const
          ).map(([id, label]) => (
            <label key={id} className="setup-check">
              <input type="radio" name="platform" checked={site === id} onChange={() => setPlatform(id)} /> {label}
            </label>
          ))}
        </div>
        <div className="setup-row">
          <input className="input" value={home} placeholder={site === 'canvas' ? 'https://yourschool.instructure.com' : 'https://yourschool.edu/d2l/home'} onChange={(e) => setHome(e.target.value)} />
          <button
            className="btn tonal sm"
            disabled={!!busy || !/^https:\/\/\S+$/.test(home.trim())}
            onClick={() =>
              act('site', async () => {
                await api.scholar.setSchoolHome(home.trim(), site, target);
                const r = await api.scholar.signIn(remember, target);
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
            <button className="link-btn" onClick={() => act('site', () => api.scholar.forgetLogin(target), 'Kea forgot your saved login.')}>
              Forget it
            </button>
          </div>
        )}
        {signedIn && <div className="setup-ok">Signed in.</div>}
        {site === 'canvas' && (
          <p className="muted">If something from your Canvas classes looks wrong or missing, tell us under Settings → Feedback.</p>
        )}
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
                // (The run doesn't come back with its id, so this test's run is the probe that started after the click
                // and has finished, not whatever ran last.)
                const since = Date.now() - 1000;
                await api.scholar.run('probe', '', target);
                const mine = (a: { task: string; start: string; end: string | null }) => a.task === 'probe' && new Date(a.start).getTime() >= since && !!a.end;
                let a = null as Awaited<ReturnType<typeof api.scholar.activity>>[number] | null;
                for (let i = 0; i < 90 && !a; i++) {
                  await new Promise((r) => setTimeout(r, 2000));
                  a = (await api.scholar.activity()).find(mine) || null;
                }
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
              try {
                const r = await api.scholar.run('import', '', target);
                toast(
                  typeof r === 'object' && r.relayed
                    ? `Asked ${r.relayed} to scan your classes${r.online ? '' : ' (it starts when that device is next on)'}. Progress shows under Scans.`
                    : 'Scanning your classes in the background. You can keep working; Kea shows progress under Scans.',
                  'success'
                );
                onDone?.();
              } catch (err: any) {
                // (An account without a verified email, for one: say so instead of failing silently.)
                toast(String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '').split('\n')[0], 'error');
              }
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

