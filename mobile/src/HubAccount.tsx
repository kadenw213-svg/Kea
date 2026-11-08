// The Kea account on the phone. An account is made, and signed in to, on the phone at once with no connection; the same
// account goes online with Google or Microsoft (the same email links it), or signs in online with its password. Online,
// the account's terms, which profile's classes to show, its notifications and storage; the classes and textbooks then
// come through the Kea account instead of a drive's files. The account's address is under Advanced.
import { useEffect, useState } from 'react';
import { Bell, Check, CheckCircle2, ExternalLink, Heart, KeyRound, Loader2, LogIn, LogOut, RefreshCw, Smartphone, UserPlus, UserRound } from 'lucide-react';
import { Kea } from './kea';
import { HubError, HubInfo, HubMeSummary, HubNote, TermsGate, acceptTerms, hubInfo, hubMe, hubNotes, hubNotesRead, hubProfiles, setHubProfile, termsGate, termsUrl } from './hub';
import { create, currentTerms, link, login, oauthSignIn, setAdvancedUrl, signOut, status as accountStatus, type AccountStatus, type SignedIn } from './account';
import { PROVIDERS, passwordProblem, type Provider } from './accountCore';
import { NeedsOnline, useAccount } from './NeedsOnline';

/** `onChange`: signed in or out, or the profile changed (the app reads the classes again). */
export function HubAccount({ onChange, compact = false }: { onChange(): void; compact?: boolean }) {
  const [s, setS] = useAccount();
  const changed = (n: AccountStatus) => {
    setS(n);
    onChange();
  };
  if (!s)
    return (
      <p className="muted small">
        <Loader2 size={14} className="spin" /> Checking your Kea account…
      </p>
    );
  return (
    <>
      {s.state === 'none' && <Start s={s} compact={compact} onDone={changed} />}
      {(s.state === 'offline' || s.state === 'linked') && <OnPhone s={s} onDone={changed} />}
      {s.state === 'online' && <Online s={s} compact={compact} onChange={onChange} onSignedOut={changed} />}
      <Advanced s={s} onDone={changed} />
    </>
  );
}

const errText = (e: any) => String(e?.message || e);
const providerList = (s: AccountStatus): Provider[] => (['google', 'microsoft'] as Provider[]).filter((p) => s.providers[p] && !(p === 'microsoft' && s.microsoftOnServer === false));

/** Continue with Google / Microsoft (only the ones this copy of Kea is set up for). */
function ProviderButtons({ s, busy, verb = 'Continue with', onPick }: { s: AccountStatus; busy: boolean; verb?: string; onPick(p: Provider): void }) {
  const list = providerList(s);
  if (!list.length || !s.url) return null;
  return (
    <>
      {list.map((p) => (
        <button key={p} className="btn" disabled={busy} onClick={() => onPick(p)}>
          <LogIn size={16} /> {verb} {PROVIDERS[p].label}
        </button>
      ))}
    </>
  );
}

// ---------- No account signed in on this phone: sign in, or make one ----------
function Start({ s, compact, onDone }: { s: AccountStatus; compact: boolean; onDone(s: AccountStatus): void }) {
  const [mode, setMode] = useState<'signin' | 'create'>(s.known.length ? 'signin' : 'create');
  const [email, setEmail] = useState(s.known[0]?.email || '');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needCode, setNeedCode] = useState<null | 'password' | Provider>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const run = async (fn: () => Promise<SignedIn | AccountStatus>, codeFor: 'password' | Provider | null = null) => {
    setBusy(true);
    setMsg('');
    try {
      const r = await fn();
      setPassword('');
      setCode('');
      setNeedCode(null);
      onDone(r);
    } catch (e: any) {
      if (e instanceof HubError && e.data?.totpRequired && codeFor) {
        if (needCode) setMsg(e.message);
        setNeedCode(codeFor);
      } else setMsg(errText(e));
    }
    setBusy(false);
  };
  const problem = mode === 'create' && password ? passwordProblem(password, email, name) : null;
  return (
    <>
      {!compact && <p className="muted small">Your Kea account is kept on this phone and works with no connection. Take it online with Google or Microsoft to get your classes and textbooks from Kea on your computer, with no drive app or file picking.</p>}
      <div className="chips">
        <button className={mode === 'signin' ? 'on' : ''} onClick={() => (setMode('signin'), setMsg(''))}>
          Sign in
        </button>
        <button className={mode === 'create' ? 'on' : ''} onClick={() => (setMode('create'), setMsg(''), setNeedCode(null))}>
          Create account
        </button>
      </div>
      {mode === 'create' && <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name (optional)" autoComplete="name" />}
      <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" autoCapitalize="none" autoComplete="username" inputMode="email" list="kea-known" />
      {s.known.length > 0 && (
        <datalist id="kea-known">
          {s.known.map((k) => (
            <option key={k.email} value={k.email} />
          ))}
        </datalist>
      )}
      <input className="input" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={mode === 'create' ? 'Choose a password' : 'Password'} type="password" autoComplete={mode === 'create' ? 'new-password' : 'current-password'} />
      {needCode && <input className="input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="6-digit code from your authenticator app" inputMode="numeric" autoComplete="one-time-code" maxLength={12} />}
      {mode === 'create' ? (
        <>
          {problem && <p className="muted small">{problem}</p>}
          <button className="btn primary" disabled={busy || !email.trim() || !!problem || !password} onClick={() => run(() => create({ email, password, name }))}>
            {busy ? <Loader2 size={16} className="spin" /> : <UserPlus size={16} />} Create account
          </button>
          <p className="muted small">Made on this phone right away, no connection needed. The same password works online once you take it online.</p>
        </>
      ) : (
        <button
          className="btn primary"
          disabled={busy || (needCode === 'password' || !needCode ? !email.trim() || !password : false) || (!!needCode && code.replace(/\s/g, '').length < 6)}
          onClick={() => (needCode && needCode !== 'password' ? run(() => oauthSignIn({ provider: needCode, code }), needCode) : run(() => login({ email, password, code: needCode ? code : undefined }), 'password'))}
        >
          {busy ? <Loader2 size={16} className="spin" /> : <KeyRound size={16} />} Sign in
        </button>
      )}
      <ProviderButtons s={s} busy={busy} onPick={(p) => run(() => oauthSignIn({ provider: p, email: email.trim() || undefined }), p)} />
      {msg && <p className="note warn">{msg}</p>}
      <p className="muted small">Only a check of your password is kept, in Android’s encrypted storage, never the password itself.</p>
    </>
  );
}

// ---------- Signed in on this phone, not online: everything here works; going online is one step ----------
function OnPhone({ s, onDone }: { s: AccountStatus; onDone(s: AccountStatus): void }) {
  const a = s.account!;
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needCode, setNeedCode] = useState(false);
  // Making the online account: which provider, and the terms to agree to.
  const [making, setMaking] = useState<Provider | null>(null);
  const [terms, setTerms] = useState<{ version: number; sections: { id: string; title: string }[] } | null>(null);
  const [agree, setAgree] = useState(false);
  const [age13, setAge13] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [open, setOpen] = useState(false);
  const run = async (fn: () => Promise<SignedIn | AccountStatus>) => {
    setBusy(true);
    setMsg('');
    try {
      const r = await fn();
      setPassword('');
      setCode('');
      setNeedCode(false);
      setMaking(null);
      onDone(r);
    } catch (e: any) {
      if (e instanceof HubError && e.data?.totpRequired) {
        if (needCode) setMsg(e.message);
        setNeedCode(true);
      } else if (e instanceof HubError && e.data?.needsCreate && !making) {
        setMsg(e.message);
        startMaking((e as any).provider);
      } else setMsg(errText(e));
    }
    setBusy(false);
  };
  const startMaking = async (p: Provider) => {
    setMaking(p);
    try {
      setTerms(await currentTerms());
    } catch (e) {
      setMsg(errText(e));
    }
  };
  const goOnline = (p: Provider) =>
    run(async () => {
      try {
        return await link({ provider: p });
      } catch (e: any) {
        if (e instanceof HubError && e.data?.needsCreate) (e as any).provider = p;
        throw e;
      }
    });
  return (
    <>
      <div className="set-row">
        <Smartphone size={18} className="ok-ic" />
        <span>
          <b>{a.name || a.email}</b>
          <span className="muted small block">
            {a.name ? `${a.email} · ` : ''}
            {s.state === 'linked' ? 'Signed in on this phone; your Kea account online isn’t signed in right now' : 'On this phone only'}
          </span>
        </span>
      </div>
      <NeedsOnline status={s} what="Your classes, Kea storage and notifications through your Kea account" onOpen={() => setOpen(true)} />
      {(open || s.state === 'linked' || making) && s.url && (
        <>
          {s.state === 'linked' && !making && (
            <>
              <input className="input" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" type="password" autoComplete="current-password" />
              {needCode && <input className="input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="6-digit code from your authenticator app" inputMode="numeric" autoComplete="one-time-code" maxLength={12} />}
              <button className="btn primary" disabled={busy || !password || (needCode && code.replace(/\s/g, '').length < 6)} onClick={() => run(() => login({ email: a.email, password, code: needCode ? code : undefined, online: true }))}>
                {busy ? <Loader2 size={16} className="spin" /> : <KeyRound size={16} />} Sign in online
              </button>
            </>
          )}
          {!making && <ProviderButtons s={s} busy={busy} onPick={goOnline} />}
          {!making && s.state === 'offline' && !providerList(s).length && <p className="muted small">Taking an account online needs Google or Microsoft sign-in, which this copy of Kea isn’t set up for. Everything on this phone keeps working.</p>}
          {!making && s.state === 'offline' && providerList(s).length > 0 && <p className="muted small">Use the {providerList(s).map((p) => PROVIDERS[p].label).join(' or ')} account with {a.email}. A different email never links to this account, and nothing on this phone changes.</p>}
          {making && (
            <>
              <p className="small">
                Make your online Kea account for <b>{a.email}</b> with {PROVIDERS[making].label}. Enter this account’s password; it becomes your online password too.
              </p>
              <input className="input" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="This account’s password" type="password" autoComplete="current-password" />
              {needCode && <input className="input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="6-digit code from your authenticator app" inputMode="numeric" autoComplete="one-time-code" maxLength={12} />}
              <label className="toggle">
                <input type="checkbox" checked={age13} onChange={(e) => setAge13(e.target.checked)} />
                <span>I’m 13 or older</span>
              </label>
              <label className="toggle">
                <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} disabled={!terms} />
                <span>I agree to the Kea terms{terms ? ` (${terms.sections.length} sections)` : ''}</span>
              </label>
              <button className="btn ghost" onClick={() => Kea.open({ url: termsUrl(s.url) })}>
                <ExternalLink size={16} /> Read the Kea terms
              </button>
              <button
                className="btn primary"
                disabled={busy || !password || !agree || !age13 || !terms || (needCode && code.replace(/\s/g, '').length < 6)}
                onClick={() =>
                  run(() =>
                    needCode ? link({ provider: making, password, code }) : link({ provider: making, password, termsVersion: terms!.version, termsSections: terms!.sections.map((x) => x.id), age13 })
                  )
                }
              >
                {busy ? <Loader2 size={16} className="spin" /> : <UserPlus size={16} />} Make my online Kea account
              </button>
              <button className="btn ghost" disabled={busy} onClick={() => (setMaking(null), setMsg(''))}>
                Not now
              </button>
            </>
          )}
        </>
      )}
      {msg && <p className="note warn">{msg}</p>}
      <button className="btn ghost danger-text" disabled={busy} onClick={() => run(() => signOut())}>
        <LogOut size={16} /> Sign out on this phone
      </button>
    </>
  );
}

// ---------- The address, under Advanced ----------
function Advanced({ s, onDone }: { s: AccountStatus; onDone(s: AccountStatus): void }) {
  const [url, setUrl] = useState(s.advancedUrl);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  useEffect(() => setUrl(s.advancedUrl), [s.advancedUrl]);
  const save = async (v: string) => {
    setBusy(true);
    setMsg('');
    try {
      onDone(await setAdvancedUrl(v));
      setMsg(v.trim() ? 'Saved.' : 'Back to the built-in address.');
    } catch (e) {
      setMsg(errText(e));
    }
    setBusy(false);
  };
  return (
    <details className="why">
      <summary>Advanced</summary>
      <label className="muted small" htmlFor="kea-account-url">
        Kea account address
      </label>
      <input id="kea-account-url" className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={s.defaultUrl || 'https://…'} autoCapitalize="none" autoCorrect="off" inputMode="url" />
      <p className="muted small">
        {s.defaultUrl ? `Empty uses the built-in address (${safeHost(s.defaultUrl)}).` : 'This copy of Kea has no built-in address; enter the one Kea on your computer uses.'} Changing it signs this phone out online; the account on this phone stays.
        {s.url ? ` In use: ${safeHost(s.url)}${s.checked ? (s.reachable ? ', answering.' : ', not answering right now.') : '.'}` : ''}
      </p>
      <div className="actions">
        <button className="btn" disabled={busy || url.trim() === s.advancedUrl} onClick={() => save(url)}>
          <Check size={16} /> Save
        </button>
        {s.advancedUrl && (
          <button className="btn ghost" disabled={busy} onClick={() => (setUrl(''), save(''))}>
            Use the built-in address
          </button>
        )}
      </div>
      {msg && <p className="muted small">{msg}</p>}
    </details>
  );
}

// ---------- Online: the terms, which classes, notifications and storage ----------
type View = 'loading' | 'terms' | 'profile' | 'ready';

function Online({ s, compact, onChange, onSignedOut }: { s: AccountStatus; compact: boolean; onChange(): void; onSignedOut(s: AccountStatus): void }) {
  const [info, setInfo] = useState<HubInfo | null>(null);
  const [view, setView] = useState<View>('loading');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [gate, setGate] = useState<TermsGate | null>(null);
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [profiles, setProfiles] = useState<string[] | null>(null);

  /** Where things stand: terms to agree to, a profile to choose, or all set. */
  const check = async () => {
    const i = await hubInfo();
    setInfo(i);
    if (!i.signedIn) return accountStatus().then(onSignedOut);
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
      if (e instanceof HubError && e.status === 401) return accountStatus().then(onSignedOut);
      // (Offline: the account is still signed in; what's shown is from last time.)
      if (!(e instanceof HubError && e.status === 0)) setMsg(errText(e));
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
      setMsg(errText(e));
    }
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
      setMsg(errText(e));
    }
    setBusy(false);
  };

  const out = async () => {
    setBusy(true);
    const r = await signOut();
    setBusy(false);
    setProfiles(null);
    setMsg('');
    onSignedOut(r);
  };

  const who = s.account?.email || info?.email;
  const unreachable = <NeedsOnline status={s} compact what="Your classes come from last time" />;

  if (view === 'loading')
    return (
      <p className="muted small">
        <Loader2 size={14} className="spin" /> Checking your Kea account…
      </p>
    );

  if (view === 'terms' && gate) {
    const all = gate.sections.every((x) => ticked[x.id]);
    return (
      <>
        <p>
          <b>The Kea terms have changed.</b> Here is only what changed since you last agreed. Tick each section to keep using your Kea account online.
        </p>
        {gate.summary && <p className="note">{gate.summary}</p>}
        {gate.sections.map((x) => (
          <div key={x.id} className="note terms-sec">
            <span className="muted small">{x.kind === 'new' ? 'New' : 'Changed'}</span>
            <b className="block">{x.title}</b>
            {x.body.split('\n').map((line, i) => (line.trim() ? <p key={i} className="small">{line.replace(/^- /, '• ')}</p> : null))}
            <label className="toggle">
              <input type="checkbox" checked={!!ticked[x.id]} onChange={(e) => setTicked({ ...ticked, [x.id]: e.target.checked })} />
              <span>I agree to “{x.title}”</span>
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
        <button className="btn ghost danger-text" disabled={busy} onClick={out}>
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
          Signed in as <b>{who}</b>. {profiles?.length ? 'Which classes should this phone show?' : ''}
        </p>
        {unreachable}
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
        {!compact && <AccountNotes />}
        <button className="btn ghost danger-text" disabled={busy} onClick={out}>
          <LogOut size={16} /> Sign out
        </button>
      </>
    );

  return (
    <>
      <div className="set-row">
        <CheckCircle2 size={18} className="ok-ic" />
        <span>
          <b>{who}</b>
          <span className="muted small block">
            {info?.profile ? `${info.profile} · ` : ''}
            Your Kea account online
          </span>
        </span>
      </div>
      {unreachable}
      {msg && <p className="note warn">{msg}</p>}
      {!compact && <AccountNotes />}
      <div className="actions">
        {(profiles?.length || 0) > 1 && (
          <button className="btn" onClick={() => setView('profile')}>
            <UserRound size={16} /> Other classes
          </button>
        )}
        <button className="btn ghost danger-text" disabled={busy} onClick={out}>
          <LogOut size={16} /> Sign out
        </button>
      </div>
    </>
  );
}

const size = (b: number) => (b >= 1024 ** 3 ? `${(Math.round((b / 1024 ** 3) * 10) / 10).toLocaleString()} GB` : `${(b / 1024 ** 2).toFixed(1)} MB`);
const when = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** The account's notices (storage, supporter, approvals, finished requests), the supporter badge, and storage. */
function AccountNotes() {
  const [me, setMe] = useState<HubMeSummary | null>(null);
  const [notes, setNotes] = useState<{ notifications: HubNote[]; unread: number } | null>(null);
  const [all, setAll] = useState(false);
  const load = async () => {
    try {
      const [m, n] = await Promise.all([hubMe(), hubNotes()]);
      setMe(m);
      setNotes(n);
    } catch {
      // (Offline, or the terms gate: the account screen says so above.)
    }
  };
  useEffect(() => {
    load();
  }, []);
  const read = async (a: { ids?: number[]; all?: boolean }) => {
    try {
      await hubNotesRead(a);
    } catch {}
    load();
  };
  if (!me && !notes) return null;
  const list = notes ? (all ? notes.notifications : notes.notifications.slice(0, 5)) : [];
  return (
    <div className="acct-notes">
      {me && (
        <p className="small">
          {me.name}
          {me.supporter?.active && (
            <span className="supporter-badge">
              <Heart size={11} /> Supporter
            </span>
          )}
          <span className="muted block">
            Kea storage: {size(me.storage.used)} of {size(me.storage.quota)}
            {me.supporter?.active && me.supporter.until ? ` · supporter until ${new Date(me.supporter.until).toLocaleDateString(undefined, { timeZone: 'UTC' })}, thank you!` : ''}
          </span>
        </p>
      )}
      {me?.storage.over && <p className="note warn small">Your Kea storage is over its limit. Nothing has been deleted; new files wait until you’re under it. Delete some files in Kea on your computer to make room.</p>}
      {notes && (
        <>
          <div className="notes-head">
            <b>
              <Bell size={14} /> Notifications
            </b>
            {notes.unread > 0 && <span className="count">{notes.unread}</span>}
            {notes.unread > 0 && (
              <button className="btn ghost small-btn" onClick={() => read({ all: true })}>
                <Check size={14} /> Mark all read
              </button>
            )}
          </div>
          {!notes.notifications.length && <p className="muted small">Nothing yet. Changes to your account, approvals and finished requests show up here.</p>}
          {list.map((n) => (
            <button key={n.id} className={`acct-note ${n.readAt ? '' : 'unread'}`} onClick={() => !n.readAt && read({ ids: [n.id] })}>
              <b className="block">{n.title}</b>
              {n.body && <span className="small block">{n.body}</span>}
              {n.note && <span className="muted small block">“{n.note}” · Kea’s creator</span>}
              <span className="muted small block">{when(n.createdAt)}</span>
            </button>
          ))}
          {notes.notifications.length > 5 && (
            <button className="btn ghost" onClick={() => setAll(!all)}>
              {all ? 'Show fewer' : `Show all ${notes.notifications.length}`}
            </button>
          )}
        </>
      )}
    </div>
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
