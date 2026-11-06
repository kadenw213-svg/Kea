import { useEffect, useState } from 'react';
import { BadgeCheck, Bell, Check, ExternalLink, Heart, KeyRound, LogIn, LogOut, Phone, ShieldCheck, Trash2, UserPlus } from 'lucide-react';
import { create } from 'zustand';
import { api, HubConsent, HubNotification, HubNotifications, HubPhoneVisibility, HubQuestionChapter, HubResult, HubScanJob, HubSectionRequest, HubServing, HubStatus, HubTerms, HubTermsChanges, TermsSection } from '../../lib/api';
import { toast, ask } from '../../store';
import { openScholar } from './scholarStore';

// The Kea Hub account: one sign-in for Kea and KeaS. Shared state, so the account page and the terms gate agree.
const useHub = create<{ status: HubStatus | null; set(s: HubStatus | null): void }>((set) => ({ status: null, set: (status) => set({ status }) }));
export function refreshHub() {
  return api.hub.status().then((r) => {
    if (r.ok) useHub.getState().set(r.value);
    return r;
  });
}
export const useHubStatus = () => useHub((s) => s.status);

// Notifications for this account: kept here so the account panel, wherever it shows, and the global listener agree.
const useNotes = create<{ notes: HubNotifications | null; set(n: HubNotifications | null): void }>((set) => ({ notes: null, set: (notes) => set({ notes }) }));
export const useHubNotifications = () => useNotes((s) => s.notes);
export function refreshNotifications() {
  return api.hub.notifications().then((r) => {
    if (r.ok) useNotes.getState().set(r.value);
    return r;
  });
}

/** A Kea supporter's badge next to their name: a thank-you, nothing more. `compact`: the heart only. */
export function SupporterBadge({ compact = false }: { compact?: boolean }) {
  return (
    <span className={`hub-supporter ${compact ? 'compact' : ''}`} title="Kea supporter" aria-label="Kea supporter">
      <Heart size={11} />
      {!compact && 'Supporter'}
    </span>
  );
}

/** 5 GB, 5,000 GB, 300 MB, 3 KB (the way the Hub writes sizes in its notices). */
const sizeText = (b: number) => {
  const at = (unit: string, size: number) => `${(Math.round((b / size) * 10) / 10).toLocaleString()} ${unit}`;
  return b >= 1024 ** 3 ? at('GB', 1024 ** 3) : b >= 1024 ** 2 ? at('MB', 1024 ** 2) : b >= 1024 ? at('KB', 1024) : `${Math.max(0, b)} bytes`;
};
const usedText = (b: number) => (b >= 1024 ** 3 || b < 1024 ** 2 ? sizeText(b) : `${(b / 1024 ** 2).toFixed(1)} MB`);
// (In UTC, the way the Hub writes dates in its notices, so both say the same day.)
const dayText = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
function agoText(ms: number) {
  const m = Math.round((Date.now() - ms) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 24 * 60) return `${Math.round(m / 60)} h ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Shows a Hub error as a toast; returns the value or null. */
async function run<T>(p: Promise<HubResult<T>>): Promise<T | null> {
  const r = await p;
  if (r.ok) return r.value;
  toast(r.error, 'error');
  return null;
}

/** Section text: lines starting "- " are a list, other lines are paragraphs. */
function SectionBody({ body }: { body: string }) {
  const blocks: JSX.Element[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) blocks.push(<ul key={blocks.length}>{list.map((l, i) => <li key={i}>{l}</li>)}</ul>);
    list = [];
  };
  for (const line of body.split('\n')) {
    if (line.startsWith('- ')) list.push(line.slice(2));
    else {
      flush();
      if (line.trim()) blocks.push(<p key={blocks.length}>{line}</p>);
    }
  }
  flush();
  return <div className="hub-terms-body">{blocks}</div>;
}

/** Every section, each with its own "I agree" box. All must be ticked. */
function TermsAgreement({ sections, onChange }: { sections: TermsSection[]; onChange(allAgreed: boolean): void }) {
  const [agreed, setAgreed] = useState<Set<string>>(new Set());
  useEffect(() => onChange(sections.every((s) => agreed.has(s.id))), [agreed, sections]);
  return (
    <div className="hub-terms-list">
      {sections.map((s) => (
        <section key={s.id} className={`hub-terms-section ${agreed.has(s.id) ? 'agreed' : ''}`}>
          <h4>{s.title}</h4>
          <SectionBody body={s.body} />
          <label className="hub-agree">
            <input
              type="checkbox"
              checked={agreed.has(s.id)}
              onChange={(e) => {
                const next = new Set(agreed);
                e.target.checked ? next.add(s.id) : next.delete(s.id);
                setAgreed(next);
              }}
            />
            I agree to this section
          </label>
        </section>
      ))}
    </div>
  );
}

function SignIn({ onDone }: { onDone(): void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needCode, setNeedCode] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [busy, setBusy] = useState(false);
  const finish = async (p: Promise<HubResult<HubStatus>>, ok: string) => {
    setBusy(true);
    const r = await p;
    setBusy(false);
    if (r.ok) {
      useHub.getState().set(r.value);
      toast(ok, 'success');
      onDone();
    } else if (r.data?.totpRequired) {
      setNeedCode(true);
      if (needCode) toast(r.error, 'error');
    } else toast(r.error, 'error');
  };
  if (resetting)
    return (
      <div className="acct-form">
        <p className="muted acct-note">Forgot your password? Sign in to Google with your Kea email to prove it's you, then pick a new password. Every other device gets signed out.</p>
        <label>
          <span>Your Kea email</span>
          <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoFocus />
        </label>
        <label>
          <span>New password</span>
          <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete="new-password" placeholder="10+ characters; a few random words works well" />
        </label>
        {needCode && (
          <label>
            <span>Code from your authenticator app</span>
            <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" maxLength={6} />
          </label>
        )}
        <div className="acct-actions">
          <button className="btn primary" disabled={busy || !password} onClick={() => finish(api.hub.googleReset({ email, password, code }), 'Password changed. You’re signed in.')}>
            <KeyRound size={14} /> Verify with Google and reset
          </button>
          <button className="btn" onClick={() => setResetting(false)}>
            Back
          </button>
        </div>
      </div>
    );
  return (
    <form
      className="acct-form"
      onSubmit={(e) => {
        e.preventDefault();
        finish(api.hub.login({ email, password, code: needCode ? code : undefined }), 'Signed in to your Kea account.');
      }}
    >
      <label>
        <span>Email</span>
        <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="username" autoFocus />
      </label>
      <label>
        <span>Password</span>
        <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete="current-password" />
      </label>
      {needCode && (
        <label>
          <span>Code from your authenticator app</span>
          <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" maxLength={6} autoFocus />
        </label>
      )}
      <div className="acct-actions">
        <button className="btn primary" type="submit" disabled={busy || !email || !password}>
          <LogIn size={14} /> Sign in
        </button>
        <button className="btn" type="button" disabled={busy} onClick={() => finish(api.hub.googleSignIn({ email, code: needCode ? code : undefined }), 'Signed in with Google.')}>
          Sign in with Google
        </button>
        <button className="btn link" type="button" onClick={() => setResetting(true)}>
          Forgot password?
        </button>
      </div>
    </form>
  );
}

function CreateAccount({ onDone }: { onDone(): void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [age13, setAge13] = useState(false);
  const [birthYear, setBirthYear] = useState('');
  const thisYear = new Date().getFullYear();
  const yearOk = /^\d{4}$/.test(birthYear) && Number(birthYear) >= 1900 && Number(birthYear) <= thisYear - 13;
  const [step, setStep] = useState<'details' | 'terms'>('details');
  const [terms, setTerms] = useState<HubTerms | null>(null);
  const [allAgreed, setAllAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (step === 'terms' && !terms) run(api.hub.terms()).then(setTerms);
  }, [step]);
  if (step === 'details')
    return (
      <form
        className="acct-form"
        onSubmit={(e) => {
          e.preventDefault();
          setStep('terms');
        }}
      >
        <label>
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="What people see" autoFocus />
        </label>
        <label>
          <span>Email</span>
          <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="username" />
        </label>
        <label>
          <span>Password</span>
          <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete="new-password" placeholder="10+ characters; a few random words works well" />
        </label>
        <label>
          <span>Year you were born</span>
          <input value={birthYear} onChange={(e) => setBirthYear(e.target.value.replace(/\D/g, '').slice(0, 4))} inputMode="numeric" placeholder={String(thisYear - 20)} />
        </label>
        <label className="hub-agree">
          <input type="checkbox" checked={age13} onChange={(e) => setAge13(e.target.checked)} /> I'm 13 or older
        </label>
        <p className="muted acct-note">Only the year is kept. Under 18, a parent or guardian signs off before Kea’s shared Claude works for you; everything else works without it.</p>
        <p className="muted acct-note">Your password is never stored, only a scrambled form of it, so not even Kea's creator can read it.</p>
        <div className="acct-actions">
          <button className="btn primary" type="submit" disabled={!name.trim() || !email.trim() || password.length < 10 || !age13 || !yearOk}>
            Next: the terms
          </button>
        </div>
      </form>
    );
  if (!terms) return <p className="muted">Getting the terms…</p>;
  return (
    <div className="acct-form">
      <div className="hub-terms-head">
        <div>
          <strong>{terms.terms.title}</strong>
          <div className="muted">
            Version {terms.terms.version} · {terms.terms.label}
          </div>
        </div>
        <button className="btn sm" onClick={() => api.hub.openTerms()}>
          <ExternalLink size={13} /> Open the full page
        </button>
      </div>
      <p className="muted acct-note">Read each section and tick it. Every section has to be agreed to before the account can be made.</p>
      <TermsAgreement sections={terms.terms.sections} onChange={setAllAgreed} />
      <div className="acct-actions">
        <button
          className="btn primary"
          disabled={busy || !allAgreed}
          onClick={async () => {
            setBusy(true);
            const r = await api.hub.register({ name, email, password, age13, birthYear: Number(birthYear), termsVersion: terms.terms.version, termsSections: terms.terms.sections.map((s) => s.id) });
            setBusy(false);
            if (r.ok) {
              useHub.getState().set(r.value);
              toast('Your Kea account is ready.', 'success');
              onDone();
            } else {
              toast(r.error, 'error');
              if (r.status === 409 && r.data?.termsVersion) setTerms(null), setStep('details');
              if (r.data?.field === 'password' || r.status === 409) setStep('details');
            }
          }}
        >
          <UserPlus size={14} /> Agree and create my account
        </button>
        <button className="btn" onClick={() => setStep('details')}>
          Back
        </button>
      </div>
    </div>
  );
}

/** The Kea account section of the account page. */
export function HubPanel() {
  const status = useHubStatus();
  const notes = useHubNotifications();
  const [mode, setMode] = useState<'signin' | 'create'>('signin');
  const [busy, setBusy] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  useEffect(() => {
    refreshHub();
  }, []);
  if (!status) return null;

  // (Shown openly while the Hub can't be reached: a wrong address is the usual reason on a new device.)
  const advancedBox = (
    <div className="hub-advanced">
      {status.reachable && (
        <button className="btn link sm" onClick={() => setAdvanced(!advanced)}>
          {advanced ? 'Hide' : 'Advanced'}
        </button>
      )}
      {(advanced || !status.reachable) && <HubAddress />}
    </div>
  );

  if (!status.signedIn)
    return (
      <div className="acct-card hub-card">
        <h3 className="hub-title">Your Kea account</h3>
        <p className="muted acct-note">One account for Kea and KeaS: classes, study groups, leaderboards and your Kea storage.</p>
        {!status.reachable && <p className="hub-warn">Can't reach the Kea Hub right now. You can still use Kea; sign in when it's back.</p>}
        <div className="hub-tabs">
          <button className={`chip ${mode === 'signin' ? 'on' : ''}`} onClick={() => setMode('signin')}>
            Sign in
          </button>
          <button className={`chip ${mode === 'create' ? 'on' : ''}`} onClick={() => setMode('create')}>
            Create an account
          </button>
        </div>
        {mode === 'signin' ? <SignIn onDone={() => {}} /> : <CreateAccount onDone={() => {}} />}
        {advancedBox}
      </div>
    );

  const me = status.me;
  // Offline: what Kea last saw.
  const c = status.cached;
  const supporter = me?.account.supporter ?? c?.supporter ?? null;
  const who = me?.account ?? (c ? { displayName: c.name, email: c.email, emailVerified: c.emailVerified, verifiedBy: c.verifiedBy ?? null, owner: !!c.owner } : null);
  return (
    <div className="acct-card hub-card">
      <h3 className="hub-title">Your Kea account</h3>
      {!status.reachable && <p className="hub-warn">The Kea Hub is offline right now (its computer may be asleep or updating). You’re still signed in: Kea keeps working with what it last saw and catches up when it’s back.</p>}
      {who && (
        <>
          <div className="acct-who">
            <div className="acct-name">
              {who.displayName} {who.emailVerified && <BadgeCheck size={16} className="hub-ok" />} {supporter?.active && <SupporterBadge />}
            </div>
            <div className="muted">{who.email}</div>
            <div className={`acct-status ${who.emailVerified ? 'ok' : 'bad'}`}>
              {who.owner ? 'Kea’s creator · Hub owner' : who.emailVerified ? `Email verified (${who.verifiedBy})` : 'Email not verified yet'}
            </div>
          </div>
          {me && (
            <div className="hub-stats">
              <span>Level {me.progress.level}</span>
              <span>{me.progress.xp} XP</span>
              <span>{me.progress.streak}-day streak</span>
              <span>
                Storage {usedText(me.storage.used)} of {sizeText(me.storage.quota)}
              </span>
            </div>
          )}
          {me?.storage.over && (
            <p className="hub-warn">
              Your Kea storage is over its limit: you’re using {usedText(me.storage.used)} of {sizeText(me.storage.quota)}. Nothing has been deleted, and you can still open, change and delete your files. New files wait until you’re under the limit, so delete some to make room.
            </p>
          )}
          {supporter?.active && supporter.until && (
            <p className="muted acct-note hub-supporter-note">
              <Heart size={13} /> Thank you for supporting Kea. Until {dayText(supporter.until)} your storage is {me ? sizeText(me.storage.quota) : 'bigger'} and a supporter badge shows next to your name in classes and organizations.
            </p>
          )}
        </>
      )}
      <div className="acct-actions">
        {who && !who.emailVerified && (
          <button className="btn primary sm" disabled={busy} onClick={async () => { setBusy(true); const s = await run(api.hub.googleVerify()); setBusy(false); if (s) (useHub.getState().set(s), toast('Email verified with Google.', 'success')); }}>
            <ShieldCheck size={14} /> Verify with Google
          </button>
        )}
        <button className="btn sm" onClick={() => api.hub.openTerms()}>
          <ExternalLink size={13} /> Terms
        </button>
        <button
          className="btn sm"
          onClick={async () => {
            if ((await ask('Sign out of your Kea account?', 'Classes, study groups and your Kea storage stop syncing on this computer until you sign in again.', [{ id: 'cancel', label: 'Cancel' }, { id: 'out', label: 'Sign out', primary: true }])) !== 'out') return;
            const s = await run(api.hub.logout());
            if (s) useHub.getState().set(s);
          }}
        >
          <LogOut size={13} /> Sign out
        </button>
      </div>
      {me && <PhoneSetting status={status} />}
      {(me || notes) && <NotificationList />}
      {advancedBox}
    </div>
  );
}

/** The optional phone number, and who sees it. Never on leaderboards; nobody sees it unless chosen here. */
function PhoneSetting({ status }: { status: HubStatus }) {
  const cur = status.me?.account.phone ?? { number: null, visibility: 'nobody' as HubPhoneVisibility };
  const [number, setNumber] = useState(cur.number || '');
  const [visibility, setVisibility] = useState<HubPhoneVisibility>(cur.visibility);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setNumber(cur.number || '');
    setVisibility(cur.visibility);
  }, [cur.number, cur.visibility]);
  const save = async (patch: { phone?: string | null; visibility?: HubPhoneVisibility }, done: string) => {
    setBusy(true);
    const s = await run(api.hub.setPhone(patch));
    setBusy(false);
    if (s) (useHub.getState().set(s), toast(done, 'success'));
  };
  const changed = number.trim() !== (cur.number || '') || visibility !== cur.visibility;
  return (
    <div className="acct-form hub-phone">
      <h3 className="hub-title">
        <Phone size={14} /> Phone number <span className="muted hub-optional">optional</span>
      </h3>
      <div className="hub-phone-row">
        <label>
          <span>Number</span>
          <input value={number} onChange={(e) => setNumber(e.target.value)} type="tel" inputMode="tel" autoComplete="tel" placeholder="+1 719 555 0100" />
        </label>
        <label>
          <span>Who sees it</span>
          <select value={visibility} onChange={(e) => setVisibility(e.target.value as HubPhoneVisibility)} disabled={!number.trim()}>
            <option value="nobody">Nobody</option>
            <option value="classes">Classmates in my classes</option>
            <option value="orgs">Coworkers in my organizations</option>
            <option value="both">Classmates and coworkers</option>
          </select>
        </label>
      </div>
      <p className="muted acct-note">It shows in class and organization member lists only for the people you pick, never on leaderboards and never publicly.</p>
      <div className="acct-actions">
        <button className="btn sm primary" disabled={busy || !changed || !number.trim()} onClick={() => save({ phone: number.trim(), visibility }, 'Phone number saved.')}>
          Save
        </button>
        {cur.number && (
          <button className="btn sm" disabled={busy} onClick={() => save({ phone: null }, 'Phone number removed.')}>
            Remove
          </button>
        )}
      </div>
    </div>
  );
}

/** This account's notifications, newest first, with the unread count. Opening one marks it read. */
function NotificationList() {
  const notes = useHubNotifications();
  const [all, setAll] = useState(false);
  useEffect(() => {
    refreshNotifications();
  }, []);
  if (!notes) return null;
  const list = all ? notes.notifications : notes.notifications.slice(0, 5);
  const act = async (p: Promise<HubResult<HubNotifications>>) => {
    const r = await run(p);
    if (r) useNotes.getState().set(r);
  };
  return (
    <div className="hub-notes">
      <div className="hub-notes-head">
        <h3 className="hub-title">
          <Bell size={14} /> Notifications {notes.unread > 0 && <span className="hub-count">{notes.unread}</span>}
        </h3>
        {notes.unread > 0 && (
          <button className="btn link sm" onClick={() => act(api.hub.notificationsRead({ all: true }))}>
            <Check size={13} /> Mark all read
          </button>
        )}
        {notes.notifications.some((n) => n.readAt) && (
          <button className="btn link sm" onClick={() => act(api.hub.notificationsDelete({ all: true }))}>
            <Trash2 size={13} /> Clear read
          </button>
        )}
      </div>
      {!notes.notifications.length ? (
        <p className="muted acct-note">Nothing yet. Changes to your account, approvals and finished requests show up here.</p>
      ) : (
        <ul className="hub-note-list">
          {list.map((n) => (
            <NoteItem key={n.id} n={n} onRead={() => act(api.hub.notificationsRead({ ids: [n.id] }))} />
          ))}
        </ul>
      )}
      {notes.notifications.length > 5 && (
        <button className="btn link sm" onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${notes.notifications.length}`}
        </button>
      )}
    </div>
  );
}
function NoteItem({ n, onRead }: { n: HubNotification; onRead(): void }) {
  return (
    <li className={`hub-note ${n.readAt ? '' : 'unread'}`} onClick={() => !n.readAt && onRead()} title={n.readAt ? undefined : 'Mark as read'}>
      <span className="hub-note-dot" aria-hidden />
      <div className="hub-note-main">
        <div className="hub-note-title">{n.title}</div>
        {/* (Who asked, shown as a plain labelled name, never mixed into the title where it could pose as Kea.) */}
        {n.kind === 'course_join' && typeof n.data?.name === 'string' && n.data.name && (
          <div className="hub-note-body">
            From: <b>{n.data.name}</b>
          </div>
        )}
        {n.body && <div className="hub-note-body">{n.body}</div>}
        {n.note && <div className="hub-note-quote">“{n.note}” · Kea’s creator</div>}
      </div>
      <span className="muted hub-note-time">{agoText(n.createdAt)}</span>
    </li>
  );
}

/** Where the Kea Hub is. Every device needs the Hub's public address (https://….ts.net); 127.0.0.1 only works on the
 * Hub's own computer. Empty goes back to the address this copy of Kea came with. */
export function HubAddress() {
  const status = useHubStatus();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (status) setUrl(status.url);
  }, [status?.url]);
  if (!status) return null;
  const save = async (to: string) => {
    setBusy(true);
    const s = await run(api.hub.setUrl(to));
    setBusy(false);
    if (!s) return;
    useHub.getState().set(s);
    toast(s.reachable ? 'Connected to the Kea Hub.' : 'Saved, but the Kea Hub doesn’t answer at that address yet.', s.reachable ? 'success' : 'error');
  };
  return (
    <form
      className="acct-form"
      onSubmit={(e) => {
        e.preventDefault();
        save(url.trim());
      }}
    >
      <label>
        <span>Kea Hub address</span>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={status.defaultUrl || 'https://name.tailnet.ts.net'} spellCheck={false} />
      </label>
      <p className="muted acct-note">
        {status.reachable ? 'Connected.' : 'Not answering at this address.'} Ask whoever runs your Kea Hub for its address if it isn’t this one.
      </p>
      <div className="acct-actions">
        <button className="btn sm" type="submit" disabled={busy || !url.trim() || url.trim() === status.url}>
          Save address
        </button>
        {status.defaultUrl && status.url !== status.defaultUrl && (
          <button className="btn sm" type="button" disabled={busy} onClick={() => save('')}>
            Use the usual address
          </button>
        )}
        <button className="btn sm" type="button" disabled={busy} onClick={async () => (setBusy(true), await refreshHub(), setBusy(false))}>
          Try again
        </button>
      </div>
    </form>
  );
}

/** Donations: one quiet line at the bottom of the home screen, and nowhere else. Never a pop-up, never a reminder,
 * nothing locked behind it. Hidden until the Hub's owner sets a donation link. */
export function SupportLink() {
  const [s, setS] = useState<{ url: string | null; message: string | null } | null>(null);
  useEffect(() => {
    api.hub.support().then((r) => r.ok && setS(r.value));
  }, []);
  if (!s?.url) return null;
  return (
    <p className="hub-support">
      {s.message || 'Kea is free. If it helps you, you can chip in.'}{' '}
      <button className="btn link sm" onClick={() => api.hub.openSupport()}>
        Support Kea
      </button>
    </p>
  );
}

/**
 * When the terms change, nothing on the Hub works until the person agrees again. This shows only what changed
 * (new, changed with the old wording one click away, removed), each changed section ticked separately.
 */
export function TermsGate() {
  const status = useHubStatus();
  const [changes, setChanges] = useState<HubTermsChanges | null>(null);
  const [allIds, setAllIds] = useState<string[] | null>(null);
  const [allAgreed, setAllAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const needs = !!status?.signedIn && !!status.me?.terms.needsAgreement;
  useEffect(() => {
    refreshHub();
    const t = setInterval(refreshHub, 30 * 60_000);
    // (Mounted once for the whole app, so these live here: account notifications from the main process, and a
    // clicked Windows notification opening the account page.)
    const offNotes = api.hub.onNotifications((n) => useNotes.getState().set(n));
    const offOpen = api.hub.onOpenAccount(() => openScholar({ name: 'account' }));
    return () => (clearInterval(t), offNotes(), offOpen());
  }, []);
  useEffect(() => {
    if (!needs) return setChanges(null);
    run(api.hub.changes()).then(setChanges);
    run(api.hub.terms()).then((t) => t && setAllIds(t.terms.sections.map((s) => s.id)));
  }, [needs, status?.me?.terms.current]);
  if (!needs || !changes || !allIds) return null;
  const toTick: TermsSection[] = [...changes.added, ...changes.changed.map((c) => c.after)];
  return (
    <div className="scrim">
      <div className="dialog hub-gate">
        <h2>The Kea terms have changed</h2>
        <p>
          Version {changes.to} replaces version {changes.from ?? '—'}. Here is only what changed. Agree to keep using your Kea account (classes, study groups, storage). Until then you can still read the terms, download your data, or sign out.
        </p>
        {changes.summary && <p className="hub-summary">{changes.summary}</p>}
        <div className="hub-gate-scroll">
          {changes.removed.map((r) => (
            <section key={r.id} className="hub-terms-section removed">
              <span className="hub-tag removed">Removed</span>
              <h4>{r.title}</h4>
            </section>
          ))}
          {changes.changed.length > 0 && (
            <details className="hub-before">
              <summary>Show what the changed sections said before</summary>
              {changes.changed.map((c) => (
                <section key={c.id} className="hub-terms-section">
                  <h4>{c.before.title} (before)</h4>
                  <SectionBody body={c.before.body} />
                </section>
              ))}
            </details>
          )}
          <TermsAgreement sections={toTick} onChange={setAllAgreed} />
        </div>
        <div className="dialog-actions">
          <button className="btn" onClick={() => api.hub.openTerms(changes.from ?? undefined)}>
            <ExternalLink size={13} /> Open in browser
          </button>
          <button className="btn" onClick={async () => { const s = await run(api.hub.logout()); if (s) useHub.getState().set(s); }}>
            Sign out
          </button>
          <button
            className="btn primary"
            disabled={busy || !allAgreed}
            onClick={async () => {
              setBusy(true);
              const s = await run(api.hub.accept({ termsVersion: changes.to, termsSections: allIds }));
              setBusy(false);
              if (s) (useHub.getState().set(s), toast('Thanks. You’re all set.', 'success'));
            }}
          >
            Agree to the updated terms
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * No Claude account? Kea's shared Claude (run by Kea's creator, free, limited and queued) can set up this profile's
 * classes. Only the class site's address goes to the Hub, never the login: while the scan runs it browses the class
 * site through this Kea, which has to stay open.
 */
export function SharedClaude() {
  const status = useHubStatus();
  const [home, setHome] = useState('');
  const [site, setSite] = useState<{ home: string; signedIn: boolean } | null>(null);
  const [jobs, setJobs] = useState<HubScanJob[]>([]);
  const [serving, setServing] = useState<HubServing[]>([]);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    const s = await api.scholar.siteStatus().catch(() => null);
    if (s) setSite({ home: s.home || '', signedIn: s.signedIn });
    const j = await api.hub.scanJobs();
    if (j.ok) {
      setJobs(j.value.jobs);
      setServing(j.value.serving || []);
    }
  };
  useEffect(() => {
    refreshHub();
    load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, []);
  const open = jobs.find((j) => j.kind !== 'more_questions' && (j.status === 'queued' || j.status === 'running'));
  const last = jobs.find((j) => j.kind !== 'more_questions' && (j.status === 'done' || j.status === 'failed'));
  return (
    <div className="hub-shared">
      <h3 className="hub-title">No Claude account? Use Kea’s shared Claude</h3>
      <p className="muted acct-note">
        Free and limited: Kea’s creator’s Claude sets up your classes once, in a queue. Your school password never leaves this computer: the scan reads your class site through this Kea, so keep Kea open while it runs. To rescan or rewrite anything later, connect your own Claude.
      </p>
      {!status?.signedIn ? (
        <p className="hub-warn">Sign in to your Kea account first (your name → Your account), and verify your email with Google.</p>
      ) : !status.me?.account.emailVerified ? (
        <p className="hub-warn">Verify your email with Google first (your name → Your account).</p>
      ) : status.me.account.birthYear == null || status.me.account.parentSignOff === 'needed' || status.me.account.parentSignOff === 'pending' ? (
        <ParentSignOff status={status} />
      ) : open ? (
        <p className="hub-warn">
          {open.status === 'running'
            ? serving.length
              ? `Kea’s shared Claude is reading your class site through this Kea now (read-only, ${serving[0].calls} page${serving[0].calls === 1 ? '' : 's'} so far, until ${new Date(serving[0].until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} at most). Keep Kea open.`
              : 'Your scan is running now. Keep Kea open.'
            : `You’re in line${open.position != null ? `: ${open.position} ahead of you, about ${Math.max(1, open.etaMinutes ?? 0)} min` : ''}. Keep Kea open around then.`}
        </p>
      ) : (
        <div className="acct-form">
          {!site?.home && (
            <label>
              <span>Your class site’s address</span>
              <input value={home} onChange={(e) => setHome(e.target.value)} placeholder="https://yourschool.brightspace.com or https://yourschool.instructure.com" />
            </label>
          )}
          {last && <p className="muted acct-note">Last scan: {last.status === 'done' ? 'done' : `didn’t finish (${last.note || 'unknown reason'})`}.</p>}
          <div className="acct-actions">
            {!site?.home ? (
              <button className="btn" disabled={!/^https:\/\//.test(home.trim())} onClick={async () => (await api.scholar.setSchoolHome(home.trim()), load())}>
                Save the address
              </button>
            ) : !site.signedIn ? (
              <button className="btn" onClick={async () => (await api.scholar.signIn(true).catch((e) => toast(String(e.message || e), 'error')), load())}>
                Sign in to your class site
              </button>
            ) : (
              <button
                className="btn primary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  const r = await api.hub.requestScan();
                  setBusy(false);
                  if (r.ok) toast(r.value.status === 'queued' ? 'You’re in the queue. Keep Kea open.' : r.value.message || 'Done.', r.value.status === 'pending' || r.value.status === 'declined' ? 'info' : 'success');
                  else toast(r.error, 'error');
                  load();
                }}
              >
                Set up my classes with Kea’s shared Claude
              </button>
            )}
          </div>
        </div>
      )}
      {status?.signedIn && <SectionRequests />}
      {status?.signedIn && status.me?.account.emailVerified && status.me.account.birthYear != null && (status.me.account.parentSignOff === 'approved' || status.me.account.parentSignOff === 'not_needed') && (
        <MoreQuestions jobs={jobs} onAsked={load} />
      )}
    </div>
  );
}

/**
 * Classmates asking to join a course section you're in (its shared material and question batches). Knowing the course
 * isn't enough to get in: someone in the section lets them in here, or shares the section's code.
 */
function SectionRequests() {
  const [incoming, setIncoming] = useState<HubSectionRequest[]>([]);
  const [busy, setBusy] = useState('');
  const load = async () => {
    const r = await api.hub.sectionRequests();
    if (r.ok) setIncoming(r.value.incoming);
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);
  if (!incoming.length) return null;
  const decide = async (q: HubSectionRequest, approve: boolean) => {
    setBusy(q.id);
    const r = await api.hub.sectionDecide({ id: q.id, approve });
    setBusy('');
    if (r.ok) toast(approve ? `${q.name || 'They'} can use this section’s material now.` : 'Said no.', 'success');
    else toast(r.error, 'error');
    load();
  };
  return (
    <div className="acct-form">
      <h3 className="hub-title">Asking to join your course sections</h3>
      <p className="muted acct-note">Only let in people you know are in the class. They get the section’s shared material and practice questions.</p>
      {incoming.map((q) => (
        <div key={q.id} className="acct-actions">
          <span>
            <b>{q.name || 'Someone'}</b> · {q.label || 'a course'}
          </span>
          <button className="btn sm primary" disabled={busy === q.id} onClick={() => decide(q, true)}>
            Let in
          </button>
          <button className="btn sm" disabled={busy === q.id} onClick={() => decide(q, false)}>
            Say no
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * Under 18: the birth year (once), then a parent's or guardian's sign-off. The parent proves their email with Google,
 * here on this computer, or on the page a link opens (sent to them however the member likes).
 */
function ParentSignOff({ status }: { status: HubStatus }) {
  const a = status.me!.account;
  const [year, setYear] = useState('');
  const [parentEmail, setParentEmail] = useState(a.parentEmail || '');
  const [consent, setConsent] = useState<HubConsent | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (a.birthYear != null) run(api.hub.consent()).then((c) => c && setConsent((was) => ({ ...c, link: was?.link ?? null })));
  }, [a.birthYear, a.parentSignOff]);
  const thisYear = new Date().getFullYear();
  if (a.birthYear == null)
    return (
      <div className="acct-form">
        <p className="muted acct-note">Kea’s shared Claude asks for the year you were born, once. Under 18, a parent or guardian signs off first.</p>
        <label>
          <span>Year you were born</span>
          <input value={year} onChange={(e) => setYear(e.target.value.replace(/\D/g, '').slice(0, 4))} inputMode="numeric" placeholder={String(thisYear - 20)} />
        </label>
        <div className="acct-actions">
          <button
            className="btn primary"
            disabled={busy || !/^\d{4}$/.test(year)}
            onClick={async () => {
              if ((await ask(`Born in ${year}?`, 'It can’t be changed afterwards. Kea support can correct a mistake.', [{ id: 'cancel', label: 'Cancel' }, { id: 'save', label: 'Save', primary: true }])) !== 'save') return;
              setBusy(true);
              const r = await run(api.hub.birthYear(Number(year)));
              setBusy(false);
              if (r) refreshHub();
            }}
          >
            Save
          </button>
        </div>
      </div>
    );
  const pending = a.parentSignOff === 'pending';
  const to = consent?.parentEmail || a.parentEmail;
  return (
    <div className="acct-form">
      <p className="hub-warn">You’re under 18, so a parent or guardian signs off before Kea’s shared Claude works for you. Everything else in Kea works without it.</p>
      <label>
        <span>Your parent’s or guardian’s email</span>
        <input value={parentEmail} onChange={(e) => setParentEmail(e.target.value)} type="email" placeholder="the email they sign in to Google with" />
      </label>
      <div className="acct-actions">
        <button
          className="btn primary"
          disabled={busy || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parentEmail.trim())}
          onClick={async () => {
            setBusy(true);
            const c = await run(api.hub.consentRequest(parentEmail.trim()));
            setBusy(false);
            if (c) {
              setConsent(c);
              refreshHub();
            }
          }}
        >
          {pending ? 'Ask again (new link)' : 'Ask for a sign-off'}
        </button>
      </div>
      {pending && (
        <>
          <p className="muted acct-note">
            Two ways for {to} to sign off: here, now, by signing in to Google with that email; or from the link, on their own phone or computer.
          </p>
          <div className="acct-actions">
            <button
              className="btn"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                const r = await api.hub.consentGoogle();
                setBusy(false);
                if (r.ok) {
                  toast('Signed off. Kea’s shared Claude works for you now.', 'success');
                  refreshHub();
                } else toast(r.error, 'error');
              }}
            >
              <BadgeCheck size={14} /> Parent: Verify with Google
            </button>
            {consent?.link ? (
              <button
                className="btn"
                onClick={async () => {
                  await navigator.clipboard.writeText(consent.link!).catch(() => {});
                  toast('Sign-off link copied. Send it to your parent or guardian; it works for 14 days.', 'success');
                }}
              >
                Copy the sign-off link
              </button>
            ) : (
              <span className="muted acct-note">For a new link, choose Ask again.</span>
            )}
          </div>
        </>
      )}
      {!pending && consent?.requests?.[0]?.status === 'declined' && <p className="muted acct-note">Your last request was declined.</p>}
    </div>
  );
}

/** One batch of new practice questions (25) for a chapter, from Kea's shared Claude. Never a rewrite. */
function MoreQuestions({ jobs, onAsked }: { jobs: HubScanJob[]; onAsked(): void }) {
  const [chapters, setChapters] = useState<HubQuestionChapter[] | null>(null);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  // The course section someone else started: waiting to be let in, or a section code typed in.
  const [gate, setGate] = useState<{ status: 'pending' | 'declined'; message: string } | null>(null);
  const [joinCode, setJoinCode] = useState('');
  useEffect(() => {
    api.hub.questionChapters().then((r) => setChapters(r.ok ? r.value : []));
  }, []);
  const waiting = jobs.filter((j) => j.kind === 'more_questions' && (j.status === 'queued' || j.status === 'running'));
  const lastDone = jobs.find((j) => j.kind === 'more_questions' && (j.status === 'done' || j.status === 'failed'));
  if (chapters && !chapters.length) return null;
  const chosen = chapters?.find((c) => `${c.courseId}|${c.label}` === pick) || null;
  return (
    <div className="acct-form">
      <h3 className="hub-title">Ran out of practice questions?</h3>
      <p className="muted acct-note">Ask for 25 new questions on one chapter. They’re different from the ones you have, classmates who ask for the same chapter get them too, and they show up in My resources after a sync.</p>
      {waiting.map((j) => (
        <p key={j.id} className="hub-warn">
          {j.chapter}: {j.status === 'running' ? 'being written now.' : `in line${j.position != null ? `, about ${Math.max(1, j.etaMinutes ?? 0)} min` : ''}.`}
        </p>
      ))}
      {lastDone && <p className="muted acct-note">Last batch ({lastDone.chapter}): {lastDone.status === 'done' ? lastDone.note || 'done' : `didn’t finish (${lastDone.note || 'unknown reason'})`}.</p>}
      <label>
        <span>Chapter</span>
        <select value={pick} onChange={(e) => setPick(e.target.value)} disabled={!chapters}>
          <option value="">{chapters ? 'Choose a chapter' : 'Loading…'}</option>
          {(chapters || []).map((c) => (
            <option key={`${c.courseId}|${c.label}`} value={`${c.courseId}|${c.label}`}>
              {c.code} · {c.label}
              {c.test ? ` (test ${c.test})` : ''}
            </option>
          ))}
        </select>
      </label>
      <div className="acct-actions">
        <button
          className="btn primary"
          disabled={busy || !chosen}
          onClick={async () => {
            setBusy(true);
            const r = await api.hub.requestQuestions({ courseId: chosen!.courseId, chapter: chosen!.label, ...(joinCode.trim() ? { joinCode: joinCode.trim() } : {}) });
            setBusy(false);
            if (r.ok && (r.value.status === 'pending' || r.value.status === 'declined')) setGate({ status: r.value.status, message: r.value.message || '' });
            else if (r.ok) {
              setGate(null);
              setJoinCode('');
              toast(r.value.status === 'queued' ? 'Asked for 25 more. They arrive with a sync once they’re written.' : r.value.message || 'Done.', 'success');
            } else toast(r.error, 'error');
            onAsked();
          }}
        >
          Ask for 25 more questions
        </button>
        {chosen && (
          <button
            className="btn"
            title="For classmates: with it they get into this course section without waiting for you to let them in"
            onClick={async () => {
              const r = await api.hub.sectionCode({ courseId: chosen.courseId });
              if (!r.ok) return toast(r.status === 404 ? 'You’re not in this course section on the Kea Hub yet. Ask for questions first.' : r.error, 'error');
              await navigator.clipboard.writeText(r.value.code).catch(() => {});
              toast(`Section code ${r.value.code} copied. Share it only with classmates.`, 'success');
            }}
          >
            Copy the section code
          </button>
        )}
      </div>
      {gate && (
        <>
          <p className="hub-warn">{gate.message || 'Someone in this course section has to let you in first.'}</p>
          <label>
            <span>Section code from a classmate (optional)</span>
            <input value={joinCode} onChange={(e) => setJoinCode(e.target.value)} placeholder="10 letters and numbers" maxLength={20} />
          </label>
          <p className="muted acct-note">With the code, ask again and you’re in at once. Without it, ask again once someone lets you in.</p>
        </>
      )}
    </div>
  );
}
