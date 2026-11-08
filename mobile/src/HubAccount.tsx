// The Kea account on the phone. Continue with Google or Microsoft signs in (the first time it makes the online account,
// after the terms); with no connection, just an email opens that account on the phone at once. An account on the phone
// goes online later with the same email. There are no passwords. Online, the account's terms, its notifications and
// storage; the classes and textbooks then come through Kea cloud instead of a drive's files (from the folder Kea on the
// computer writes them into, picked by itself). The account's address is under Advanced.
import { useEffect, useState } from 'react';
import { Bell, Check, CheckCircle2, ExternalLink, Heart, Loader2, LogIn, LogOut, RefreshCw, Smartphone, UserPlus } from 'lucide-react';
import { Kea } from './kea';
import { HubError, HubInfo, HubMeSummary, HubNote, TermsGate, acceptTerms, hubInfo, hubMe, hubNotes, hubNotesRead, hubPickFolder, termsGate, termsUrl } from './hub';
import { NOT_SET_UP, cancelSignIn, continueSignIn, currentTerms, link, oauthSignIn, openOffline, setAdvancedUrl, signOut, status as accountStatus, type AccountStatus, type SignedIn } from './account';
import { EMAIL, PROVIDERS, type Provider } from './accountCore';
import { NeedsOnline, useAccount } from './NeedsOnline';

/** `onChange`: signed in or out, or Kea's folder in Kea cloud changed (the app reads the classes again). */
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

/** Continue with Google / Microsoft (only the ones this copy of Kea is set up for; none: a plain sentence). */
function ProviderButtons({ s, busy, onPick }: { s: AccountStatus; busy: boolean; onPick(p: Provider): void }) {
  const list = providerList(s);
  if (!list.length) return <p className="muted small">{NOT_SET_UP}</p>;
  if (!s.url) return null;
  return (
    <>
      {list.map((p) => (
        <button key={p} className="btn primary" disabled={busy} onClick={() => onPick(p)}>
          <LogIn size={16} /> Continue with {PROVIDERS[p].label}
        </button>
      ))}
    </>
  );
}

/**
 * Continue with Google or Microsoft and what it may still need: the terms (the first sign-in makes the online account)
 * or the owner's two-step code.
 */
function useOnline(onDone: (s: AccountStatus) => void) {
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<'terms' | 'code' | null>(null);
  const [msg, setMsg] = useState('');
  const run = async (fn: () => Promise<SignedIn | AccountStatus>) => {
    setBusy(true);
    setMsg('');
    try {
      const r = await fn();
      setStep(null);
      onDone(r);
    } catch (e: any) {
      if (e instanceof HubError && e.data?.needsAccount) setStep('terms');
      else if (e instanceof HubError && e.data?.totpRequired) {
        if (step === 'code') setMsg(e.message);
        setStep('code');
      } else {
        setStep(null);
        setMsg(errText(e));
      }
    }
    setBusy(false);
  };
  return { busy, step, msg, run, cancel: () => (setStep(null), run(() => cancelSignIn())) };
}

/** The first Google or Microsoft sign-in for an email: the terms and the age box make the online Kea account. */
function NewOnlineAccount({ s, o }: { s: AccountStatus; o: ReturnType<typeof useOnline> }) {
  const [terms, setTerms] = useState<{ version: number; sections: { id: string; title: string }[] } | null>(null);
  const [agree, setAgree] = useState(false);
  const [age13, setAge13] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    currentTerms().then(setTerms, (e) => setErr(errText(e)));
  }, []);
  return (
    <>
      <p className="small">
        <b>Create your Kea account</b>
        {s.pending?.email ? (
          <>
            {' '}
            for <b>{s.pending.email}</b>
          </>
        ) : null}
        . Agree to the terms to make it.
      </p>
      <label className="toggle">
        <input type="checkbox" checked={age13} onChange={(e) => setAge13(e.target.checked)} />
        <span>I’m 13 or older</span>
      </label>
      <label className="toggle">
        <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} disabled={!terms} />
        <span>I agree to the Kea terms{terms ? ` (${terms.sections.length} sections)` : ''}</span>
      </label>
      {s.url && (
        <button className="btn ghost" onClick={() => Kea.open({ url: termsUrl(s.url) })}>
          <ExternalLink size={16} /> Read the Kea terms
        </button>
      )}
      <button className="btn primary" disabled={o.busy || !agree || !age13 || !terms} onClick={() => o.run(() => continueSignIn({ termsVersion: terms!.version, termsSections: terms!.sections.map((x) => x.id), age13: true }))}>
        {o.busy ? <Loader2 size={16} className="spin" /> : <UserPlus size={16} />} Create my account
      </button>
      <button className="btn ghost" disabled={o.busy} onClick={o.cancel}>
        Cancel
      </button>
      {err && <p className="note warn">{err}</p>}
    </>
  );
}

/** The owner account's two-step code, after its Google or Microsoft sign-in. */
function OwnerCode({ o }: { o: ReturnType<typeof useOnline> }) {
  const [code, setCode] = useState('');
  return (
    <>
      <input className="input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Two-step code" inputMode="text" autoComplete="one-time-code" maxLength={12} />
      <button className="btn primary" disabled={o.busy || code.replace(/\s/g, '').length < 6} onClick={() => o.run(() => continueSignIn({ code }))}>
        {o.busy ? <Loader2 size={16} className="spin" /> : <LogIn size={16} />} Sign in
      </button>
      <button className="btn ghost" disabled={o.busy} onClick={o.cancel}>
        Cancel
      </button>
    </>
  );
}

// ---------- No account signed in on this phone: Continue with Google or Microsoft, or just an email ----------
function Start({ s, compact, onDone }: { s: AccountStatus; compact: boolean; onDone(s: AccountStatus): void }) {
  const [email, setEmail] = useState('');
  const o = useOnline(onDone);
  const step = o.step || (s.pending ? 'terms' : null);
  if (step === 'terms') return <NewOnlineAccount s={s} o={o} />;
  if (step === 'code') return <OwnerCode o={o} />;
  return (
    <>
      {!compact && <p className="muted small">Sign in with Google or Microsoft to get your classes and textbooks from Kea on your computer. No connection? Your email alone opens Kea on this phone.</p>}
      <ProviderButtons s={s} busy={o.busy} onPick={(p) => o.run(() => oauthSignIn({ provider: p }))} />
      <p className="muted small">Or use Kea on this phone:</p>
      {s.known.length > 0 && (
        <div className="chips">
          {s.known.slice(0, 4).map((k) => (
            <button key={k.email} disabled={o.busy} onClick={() => o.run(() => openOffline({ email: k.email }))}>
              {k.email}
            </button>
          ))}
        </div>
      )}
      <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" autoCapitalize="none" autoComplete="username" inputMode="email" />
      <button className="btn" disabled={o.busy || !EMAIL.test(email.trim())} onClick={() => o.run(() => openOffline({ email }))}>
        {o.busy ? <Loader2 size={16} className="spin" /> : <Smartphone size={16} />} Use offline
      </button>
      {o.msg && <p className="note warn">{o.msg}</p>}
    </>
  );
}

// ---------- Signed in on this phone, not online: everything here works; going online is one step ----------
function OnPhone({ s, onDone }: { s: AccountStatus; onDone(s: AccountStatus): void }) {
  const a = s.account!;
  const o = useOnline(onDone);
  const [open, setOpen] = useState(false);
  const step = o.step || (s.pending ? 'terms' : null);
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
      {step === 'terms' ? (
        <NewOnlineAccount s={s} o={o} />
      ) : step === 'code' ? (
        <OwnerCode o={o} />
      ) : (
        <>
          <NeedsOnline status={s} what="Your classes through Kea cloud, Kea storage and notifications" onOpen={() => setOpen(true)} />
          {(open || s.state === 'linked') && (
            <>
              <ProviderButtons s={s} busy={o.busy} onPick={(p) => o.run(() => link({ provider: p }))} />
              {providerList(s).length > 0 && <p className="muted small">Use the account with {a.email}. A different email never links to this account, and nothing on this phone changes.</p>}
            </>
          )}
        </>
      )}
      {o.msg && <p className="note warn">{o.msg}</p>}
      <button className="btn ghost danger-text" disabled={o.busy} onClick={() => o.run(() => signOut())}>
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

// ---------- Online: the terms, notifications and storage ----------
type View = 'loading' | 'terms' | 'ready';

function Online({ s, compact, onChange, onSignedOut }: { s: AccountStatus; compact: boolean; onChange(): void; onSignedOut(s: AccountStatus): void }) {
  const [info, setInfo] = useState<HubInfo | null>(null);
  const [view, setView] = useState<View>('loading');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [gate, setGate] = useState<TermsGate | null>(null);
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  /** Whether Kea cloud has classes from Kea on the computer (null: not known yet, or offline). */
  const [hasClasses, setHasClasses] = useState<boolean | null>(null);

  /**
   * Where things stand: terms to agree to, or all set. Kea's folder in Kea cloud is picked by itself (the newest), so
   * there's nothing to choose.
   */
  const check = async () => {
    const i = await hubInfo();
    setInfo(i);
    if (!i.signedIn) return accountStatus().then(onSignedOut);
    try {
      const folder = await hubPickFolder();
      setHasClasses(!!folder);
      if (folder && folder !== i.profile) {
        setInfo({ ...i, profile: folder });
        onChange();
      }
      setView('ready');
    } catch (e: any) {
      if (e instanceof HubError && e.status === 428) return openGate();
      if (e instanceof HubError && e.status === 401) return accountStatus().then(onSignedOut);
      // (Offline: the account is still signed in; what's shown is from last time.)
      if (!(e instanceof HubError && e.status === 0)) setMsg(errText(e));
      setView('ready');
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
    setHasClasses(null);
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

  return (
    <>
      <div className="set-row">
        <CheckCircle2 size={18} className="ok-ic" />
        <span>
          <b>{who}</b>
          <span className="muted small block">Your Kea account online</span>
        </span>
      </div>
      {unreachable}
      {hasClasses === false && <p className="note">No classes in Kea cloud yet. Sign in to the same Kea account in Kea on your computer and keep it syncing through Kea cloud; your classes come here.</p>}
      {msg && <p className="note warn">{msg}</p>}
      {!compact && <AccountNotes />}
      <div className="actions">
        {hasClasses === false && (
          <button className="btn" disabled={busy} onClick={check}>
            <RefreshCw size={16} /> Check again
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
