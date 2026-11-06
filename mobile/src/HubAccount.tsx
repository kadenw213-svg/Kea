// The Kea account on the phone: sign in to the same account as Kea on the PC (two-step code when it's on), agree to
// what changed in the terms, choose which profile's classes to show, and sign out. Signed in, the classes and
// textbooks come through the Kea Hub instead of a drive's files.
import { useEffect, useState } from 'react';
import { Check, CheckCircle2, ExternalLink, KeyRound, Loader2, LogOut, RefreshCw, UserRound } from 'lucide-react';
import { Kea } from './kea';
import { HubError, HubInfo, TermsGate, acceptTerms, hubInfo, hubProfiles, hubSignIn, hubSignOut, setHubProfile, termsGate, termsUrl } from './hub';

type View = 'loading' | 'signin' | 'terms' | 'profile' | 'ready';

/** `onChange`: signed in or out, or the profile changed (the app reads the classes again). */
export function HubAccount({ onChange, compact = false }: { onChange(): void; compact?: boolean }) {
  const [info, setInfo] = useState<HubInfo | null>(null);
  const [view, setView] = useState<View>('loading');
  const [url, setUrl] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needCode, setNeedCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [gate, setGate] = useState<TermsGate | null>(null);
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [profiles, setProfiles] = useState<string[] | null>(null);

  /** Where things stand: signed out, terms to agree to, a profile to choose, or all set. */
  const check = async () => {
    const i = await hubInfo();
    setInfo(i);
    if (!url) setUrl(i.url);
    if (!email) setEmail(i.email);
    if (!i.signedIn) return setView('signin');
    try {
      const list = await hubProfiles();
      setProfiles(list);
      if (!i.profile || !list.includes(i.profile)) {
        if (list.length === 1) {
          setHubProfile(list[0]);
          setInfo({ ...i, profile: list[0] });
          onChange();
          return setView('ready');
        }
        return setView('profile');
      }
      setView('ready');
    } catch (e: any) {
      if (e instanceof HubError && e.status === 428) return openGate();
      if (e instanceof HubError && e.status === 401) {
        await Kea.hubForget().catch(() => {});
        setMsg('Your sign-in ended. Sign in again.');
        return setView('signin');
      }
      // (Offline: the account is still signed in; what's shown is from last time.)
      setMsg(String(e?.message || e));
      setView(i.profile ? 'ready' : 'profile');
    }
  };
  useEffect(() => {
    check();
  }, []);

  const openGate = async () => {
    try {
      const g = await termsGate();
      setGate(g);
      setTicked({});
      setView('terms');
    } catch (e: any) {
      setMsg(String(e?.message || e));
    }
  };

  const signIn = async () => {
    setBusy(true);
    setMsg('');
    try {
      const r = await hubSignIn({ url, email, password, code: needCode ? code : undefined });
      setPassword('');
      setCode('');
      setNeedCode(false);
      if (r.needsTerms) await openGate();
      else await check();
      onChange();
    } catch (e: any) {
      if (e instanceof HubError && e.data?.totpRequired) {
        setNeedCode(true);
        if (needCode) setMsg(e.message);
      } else setMsg(String(e?.message || e));
    }
    setBusy(false);
  };

  const agree = async () => {
    if (!gate) return;
    setBusy(true);
    setMsg('');
    try {
      await acceptTerms(gate);
      setGate(null);
      await check();
      onChange();
    } catch (e: any) {
      // The terms changed again while they were being read: show the newest.
      if (e instanceof HubError && e.status === 409) await openGate();
      setMsg(String(e?.message || e));
    }
    setBusy(false);
  };

  const signOut = async () => {
    setBusy(true);
    await hubSignOut();
    setBusy(false);
    setProfiles(null);
    setMsg('');
    await check();
    onChange();
  };

  if (view === 'loading')
    return (
      <p className="muted small">
        <Loader2 size={14} className="spin" /> Checking your Kea account…
      </p>
    );

  if (view === 'signin')
    return (
      <>
        {!compact && <p className="muted small">Sign in with the same Kea account as Kea on your computer, and your classes and textbooks come straight from your Kea storage. No drive app or file picking needed.</p>}
        <label className="muted small" htmlFor="hub-url">
          Kea Hub address
        </label>
        <input id="hub-url" className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://your-hub.example.ts.net" autoCapitalize="none" autoCorrect="off" inputMode="url" />
        <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" autoCapitalize="none" autoComplete="username" inputMode="email" />
        <input className="input" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" type="password" autoComplete="current-password" />
        {needCode && (
          <input className="input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="6-digit code from your authenticator app" inputMode="numeric" autoComplete="one-time-code" maxLength={8} />
        )}
        <button className="btn primary" disabled={busy || !url.trim() || !email.trim() || !password || (needCode && code.replace(/\s/g, '').length < 6)} onClick={signIn}>
          {busy ? <Loader2 size={16} className="spin" /> : <KeyRound size={16} />} Sign in
        </button>
        {msg && <p className="note warn">{msg}</p>}
        <p className="muted small">
          The address is the one in Kea on your computer, under your name → Your account. New to Kea? Create your account there first. Your sign-in is kept in Android’s encrypted storage.
        </p>
        {url.trim() && (
          <button className="btn ghost" onClick={() => Kea.open({ url: termsUrl(safeOrigin(url)) })}>
            <ExternalLink size={16} /> Read the Kea terms
          </button>
        )}
      </>
    );

  if (view === 'terms' && gate) {
    const all = gate.sections.every((s) => ticked[s.id]);
    return (
      <>
        <p>
          <b>The Kea terms have changed.</b> Here is only what changed since you last agreed. Tick each section to keep using your Kea account.
        </p>
        {gate.summary && <p className="note">{gate.summary}</p>}
        {gate.sections.map((s) => (
          <div key={s.id} className="note terms-sec">
            <span className="muted small">{s.kind === 'new' ? 'New' : 'Changed'}</span>
            <b className="block">{s.title}</b>
            {s.body.split('\n').map((line, i) => (line.trim() ? <p key={i} className="small">{line.replace(/^- /, '• ')}</p> : null))}
            <label className="toggle">
              <input type="checkbox" checked={!!ticked[s.id]} onChange={(e) => setTicked({ ...ticked, [s.id]: e.target.checked })} />
              <span>I agree to “{s.title}”</span>
            </label>
          </div>
        ))}
        {gate.removed.length > 0 && <p className="muted small">Removed: {gate.removed.map((r) => r.title).join(', ')}.</p>}
        <button className="btn primary" disabled={busy || !all} onClick={agree}>
          {busy ? <Loader2 size={16} className="spin" /> : <Check size={16} />} Agree
        </button>
        <button className="btn ghost" onClick={() => info && Kea.open({ url: termsUrl(info.url) })}>
          <ExternalLink size={16} /> Read the full terms
        </button>
        <button className="btn ghost danger-text" disabled={busy} onClick={signOut}>
          <LogOut size={16} /> Sign out instead
        </button>
        {msg && <p className="note warn">{msg}</p>}
      </>
    );
  }

  if (view === 'profile')
    return (
      <>
        <p>
          Signed in as <b>{info?.email}</b>. {profiles?.length ? 'Which classes should this phone show?' : ''}
        </p>
        {profiles && !profiles.length && (
          <p className="note">No classes in your Kea storage yet. Sign in to the same Kea account in Kea on your computer, and it syncs your classes here. Then check again.</p>
        )}
        <div className="drives">
          {(profiles || []).map((p) => (
            <button
              key={p}
              className="drive-opt"
              onClick={() => {
                setHubProfile(p);
                setInfo(info && { ...info, profile: p });
                setView('ready');
                onChange();
              }}
            >
              <UserRound size={22} />
              <span>
                <b>{p}</b>
              </span>
            </button>
          ))}
        </div>
        <button className="btn" disabled={busy} onClick={check}>
          <RefreshCw size={16} /> Check again
        </button>
        {msg && <p className="note warn">{msg}</p>}
        <button className="btn ghost danger-text" disabled={busy} onClick={signOut}>
          <LogOut size={16} /> Sign out
        </button>
      </>
    );

  return (
    <>
      <div className="set-row">
        <CheckCircle2 size={18} className="ok-ic" />
        <span>
          <b>{info?.email}</b>
          <span className="muted small block">
            {info?.profile ? `${info.profile} · ` : ''}
            {safeHost(info?.url)}
          </span>
        </span>
      </div>
      {msg && <p className="note warn">{msg}</p>}
      <div className="actions">
        {(profiles?.length || 0) > 1 && (
          <button className="btn" onClick={() => setView('profile')}>
            <UserRound size={16} /> Other classes
          </button>
        )}
        <button className="btn ghost danger-text" disabled={busy} onClick={signOut}>
          <LogOut size={16} /> Sign out
        </button>
      </div>
    </>
  );
}

const safeHost = (u?: string) => {
  try {
    return new URL(u || '').host;
  } catch {
    return '';
  }
};
const safeOrigin = (u: string) => {
  try {
    return new URL(/^[a-z]+:\/\//i.test(u.trim()) ? u.trim() : `https://${u.trim()}`).origin;
  } catch {
    return '';
  }
};
