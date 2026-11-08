import { useEffect, useRef, useState } from 'react';
import { BadgeCheck, Bell, Check, Copy, ExternalLink, Heart, KeyRound, LogIn, LogOut, Pencil, Phone, Trash2, UserPlus } from 'lucide-react';
import { api, HubConsent, HubNotification, HubNotifications, HubPhoneVisibility, HubQuestionChapter, HubResult, HubScanJob, HubSectionRequest, HubServing, HubStatus, HubTerms, HubTermsChanges, KeaSignInProvider, TermsSection } from '../../lib/api';
import { toast, ask } from '../../store';
import { formatBytes } from '../../lib/util';
import { useKeaModes } from '../../lib/modes';
import { useKeaCloud, watchKeaCloud } from '../../lib/keaCloud';
import { formatPhone } from '../../lib/phone';
import { useSettings } from '../../lib/settings';
import { hubStatusNow, loadLocal, openAccount, refreshHub, refreshNotifications, run, setHubNotifications, setHubStatus, useHubNotifications, useHubStatus } from '../account/hubStore';
import { NeedsOnline } from '../account/NeedsOnline';
import { PasswordInput, passwordHint, SignInSecurity, YourData } from '../account/Security';
import { ProfileHead, VerifiedBadge, VerifyEmail, useAccount } from './Account';

// The Kea account: one sign-in for Kea and KeaS, made on this computer and taken online when wanted. Its state lives in account/hubStore.ts (shared with the title bar,
// Work and School); these are re-exported for the screens that import them from here.
export { refreshHub, refreshNotifications, useHubStatus, useHubNotifications };

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
// (In UTC, the way the Hub writes dates in its notices, so both say the same day.)
const dayText = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
function agoText(ms: number) {
  const m = Math.round((Date.now() - ms) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 24 * 60) return `${Math.round(m / 60)} h ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

/** Every section, each with its own "I agree" box. All must be ticked; the footer counts them and finds the next one. */
function TermsAgreement({ sections, onChange }: { sections: TermsSection[]; onChange(allAgreed: boolean): void }) {
  const [agreed, setAgreed] = useState<Set<string>>(new Set());
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => onChange(sections.every((s) => agreed.has(s.id))), [agreed, sections]);
  const done = sections.filter((s) => agreed.has(s.id)).length;
  const next = sections.find((s) => !agreed.has(s.id));
  return (
    <div className="hub-terms-list" ref={list}>
      {sections.map((s) => (
        <section key={s.id} data-section={s.id} className={`hub-terms-section ${agreed.has(s.id) ? 'agreed' : ''}`}>
          <h4>{s.title}</h4>
          <SectionBody body={s.body} />
          <label className="hub-agree">
            <input
              type="checkbox"
              checked={agreed.has(s.id)}
              onChange={(e) => {
                const n = new Set(agreed);
                e.target.checked ? n.add(s.id) : n.delete(s.id);
                setAgreed(n);
              }}
            />
            I agree to this section
          </label>
        </section>
      ))}
      <div className={`hub-terms-count ${next ? '' : 'done'}`}>
        <span>
          {done} of {sections.length} agreed
        </span>
        {next && (
          <button type="button" className="btn link sm" onClick={() => list.current?.querySelector(`[data-section="${CSS.escape(next.id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>
            Next one to read ↓
          </button>
        )}
      </div>
    </div>
  );
}

/** The two-step code box (or a backup code) an online sign-in asks for. */
function CodeBox({ code, setCode, useBackup, setUseBackup, canBackup }: { code: string; setCode(c: string): void; useBackup: boolean; setUseBackup(b: boolean): void; canBackup: boolean }) {
  return useBackup ? (
    <label>
      <span>Backup code</span>
      <input key="backup" value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9 -]/g, '').slice(0, 11))} autoComplete="off" spellCheck={false} placeholder="XXXXX-XXXXX" maxLength={11} autoFocus />
      <span className="acct-hint">
        One of the backup codes you saved when you turned on two-step sign-in. Each one works once.{' '}
        <button type="button" className="btn link sm" onClick={() => (setUseBackup(false), setCode(''))}>
          Use the code from my app
        </button>
      </span>
    </label>
  ) : (
    <label>
      <span>Code from your authenticator app</span>
      <input key="app" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus />
      <span className="acct-hint">
        Two-step sign-in is on for this account: open your authenticator app and enter the 6-digit code it shows for Kea.
        {canBackup && (
          <>
            {' '}
            <button type="button" className="btn link sm" onClick={() => (setUseBackup(true), setCode(''))}>
              Use a backup code
            </button>
          </>
        )}
      </span>
    </label>
  );
}

/** A code box that appears when an online sign-in asks for one. */
function useCode() {
  const [code, setCode] = useState('');
  const [needCode, setNeedCode] = useState(false);
  // The server takes a backup code in place of the app's (it says so when it asks; an older one doesn't).
  const [canBackup, setCanBackup] = useState(false);
  const [useBackup, setUseBackup] = useState(false);
  return {
    code: needCode ? code : undefined,
    needCode,
    /** An answer asked for a code: the box appears (the first time without a message). */
    asked(r: { data?: any; error: string }) {
      if (!r.data?.totpRequired) return false;
      if (needCode) toast(r.error, 'error');
      setNeedCode(true);
      if (r.data?.backupCodes) setCanBackup(true);
      return true;
    },
    box: needCode ? <CodeBox code={code} setCode={setCode} useBackup={useBackup} setUseBackup={setUseBackup} canBackup={canBackup} /> : null,
  };
}

const providerLabel = (p: KeaSignInProvider) => (p === 'microsoft' ? 'Microsoft' : 'Google');

function SignIn({ onDone, initialEmail = '' }: { onDone(): void; initialEmail?: string }) {
  const status = useHubStatus();
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const c = useCode();
  const [resetting, setResetting] = useState(false);
  const [busy, setBusy] = useState(false);
  // (Can't reach the server for an email this computer hasn't signed in with: said here, calmly, not as an error.)
  const [note, setNote] = useState<string | null>(null);
  const finish = async (p: Promise<HubResult<HubStatus>>, ok: (s: HubStatus) => string) => {
    setBusy(true);
    setNote(null);
    const r = await p;
    setBusy(false);
    if (r.ok) {
      setHubStatus(r.value);
      toast(ok(r.value), 'success');
      onDone();
    } else if (c.asked(r)) {
    } else if (r.status === 0 || r.data?.unreachable || r.data?.needsCreate) setNote(r.error);
    else toast(r.error, 'error');
  };
  const known = status?.known || [];
  const providers = status?.providers;
  if (resetting)
    return (
      <form
        className="acct-form"
        onSubmit={(e) => {
          e.preventDefault();
          finish(api.hub.googleReset({ email, password, code: c.code }), () => 'Password changed. You’re signed in.');
        }}
      >
        <p className="muted acct-note">Forgot your password? Sign in to Google with your Kea email to prove it’s you, then pick a new one. Every other device gets signed out. This needs a connection.</p>
        <p className="hub-warn">This only works when your Kea email is a Google account (Gmail, or a Google Workspace school or work address).</p>
        <label>
          <span>Your Kea email</span>
          <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="username" autoFocus={!email} />
        </label>
        <label>
          <span>New password</span>
          <PasswordInput value={password} onChange={setPassword} autoComplete="new-password" autoFocus={!!email} />
          {passwordHint(password) && <span className="acct-hint">{passwordHint(password)}</span>}
        </label>
        {c.box}
        <div className="acct-actions">
          <button className="btn primary" type="submit" disabled={busy || !EMAIL.test(email.trim()) || !!passwordHint(password)}>
            <KeyRound size={14} /> Verify with Google and reset
          </button>
          <button className="btn" type="button" onClick={() => setResetting(false)}>
            Back
          </button>
        </div>
      </form>
    );
  return (
    <form
      className="acct-form"
      onSubmit={(e) => {
        e.preventDefault();
        finish(api.hub.login({ email, password, code: c.code }), (s) => (s.state === 'online' ? 'Signed in to your Kea account.' : 'Signed in.'));
      }}
    >
      {known.length > 0 && !initialEmail && (
        <div className="acct-known" aria-label="Accounts used on this computer">
          {known.slice(0, 4).map((k) => (
            <button key={k.email} type="button" className={`btn sm ${email === k.email ? 'primary' : ''}`} onClick={() => setEmail(k.email)} title={k.name || undefined}>
              {k.email}
            </button>
          ))}
        </div>
      )}
      <label>
        <span>Email</span>
        <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="username" autoFocus={!email} />
      </label>
      <label>
        <span>Password</span>
        <PasswordInput value={password} onChange={setPassword} autoFocus={!!email} />
      </label>
      {c.box}
      {note && <p className="hub-warn">{note}</p>}
      <div className="acct-actions">
        <button className="btn primary" type="submit" disabled={busy || !email || !password}>
          <LogIn size={14} /> Sign in
        </button>
        <button className="btn" type="button" disabled={busy} onClick={() => finish(api.hub.oauthSignIn({ provider: 'google', email, code: c.code }), () => 'Signed in with Google.')}>
          Continue with Google
        </button>
        {providers?.microsoft && (
          <button className="btn" type="button" disabled={busy} onClick={() => finish(api.hub.oauthSignIn({ provider: 'microsoft', email, code: c.code }), () => 'Signed in with Microsoft.')}>
            Continue with Microsoft
          </button>
        )}
        <button className="btn link" type="button" onClick={() => setResetting(true)}>
          Forgot password?
        </button>
      </div>
      <p className="muted acct-note">An account used on this computer before signs in here with or without a connection. Continue with Google{providers?.microsoft ? ' or Microsoft' : ''} needs a connection and an online Kea account with that email.</p>
    </form>
  );
}

/** A new Kea account, made on this computer at once: no connection needed. It can go online later. */
function CreateAccount({ onDone, onExists }: { onDone(): void; onExists(email: string): void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const problems: Record<string, string | null> = {
    email: EMAIL.test(email.trim()) ? null : 'Add your email address.',
    password: passwordHint(password),
  };
  const show = (k: string) => tried && problems[k] && <span className="acct-hint bad">{problems[k]}</span>;
  return (
    <form
      className="acct-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setTried(true);
        if (Object.values(problems).some(Boolean)) return;
        setBusy(true);
        const r = await api.hub.create({ name: name.trim(), email: email.trim(), password });
        setBusy(false);
        if (r.ok) {
          setHubStatus(r.value);
          toast('Your Kea account is ready.', 'success');
          onDone();
        } else if (r.data?.exists) {
          toast(r.error, 'info');
          onExists(email.trim());
        } else toast(r.error, 'error');
      }}
    >
      <label>
        <span>
          Name <span className="muted hub-optional">optional</span>
        </span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="What people see" maxLength={60} autoFocus />
      </label>
      <label>
        <span>Email</span>
        <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="username" />
        {show('email')}
      </label>
      <label>
        <span>Password</span>
        <PasswordInput value={password} onChange={setPassword} autoComplete="new-password" />
        {problems.password && <span className={`acct-hint ${tried ? 'bad' : ''}`}>{problems.password}</span>}
      </label>
      <p className="muted acct-note">Your account is made on this computer right away, with no connection needed. The password is never stored, only a scrambled form of it. Later you can take it online with Google or Microsoft for Kea Cloud, classes and work.</p>
      <div className="acct-actions">
        <button className="btn primary" type="submit" disabled={busy}>
          <UserPlus size={14} /> Create my account
        </button>
      </div>
    </form>
  );
}

/** Signing in, or making an account; the two switch with the email carried over. */
function SignInOrCreate({ mode, setMode, onDone }: { mode: 'signin' | 'create'; setMode(m: 'signin' | 'create'): void; onDone(): void }) {
  const [email, setEmail] = useState('');
  return mode === 'signin' ? (
    <SignIn key={email} initialEmail={email} onDone={onDone} />
  ) : (
    <CreateAccount
      onDone={onDone}
      onExists={(e) => {
        setEmail(e);
        setMode('signin');
      }}
    />
  );
}

/**
 * Taking the account on this computer online with Google or Microsoft. The same email links (the online account is
 * made now, with this account's password and the terms, or signed in to when it already exists); a different email
 * never links. Nothing on this computer is deleted either way.
 */
function GoOnline() {
  const status = useHubStatus();
  const [password, setPassword] = useState('');
  const [age13, setAge13] = useState(false);
  const [terms, setTerms] = useState<HubTerms | null>(null);
  const [allAgreed, setAllAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mismatch, setMismatch] = useState<{ provider: KeaSignInProvider; providerEmail: string; accountEmail: string } | null>(null);
  const [existing, setExisting] = useState<{ provider: KeaSignInProvider; message: string } | null>(null);
  const [lastProvider, setLastProvider] = useState<KeaSignInProvider>('google');
  const c = useCode();
  const reachable = !!status?.reachable;
  useEffect(() => {
    if (reachable && !terms) api.hub.terms().then((r) => r.ok && setTerms(r.value));
    // (Not reachable: checked again every half minute while this is open.)
    if (reachable) return;
    const t = setInterval(() => refreshHub(), 30_000);
    return () => clearInterval(t);
  }, [reachable]);
  if (!status?.account) return null;
  const go = async (provider: KeaSignInProvider, how: 'create' | 'existing') => {
    setBusy(true);
    setLastProvider(provider);
    const r = await api.hub.link(
      how === 'existing'
        ? { provider, code: c.code }
        : c.code
          ? { provider, password, code: c.code }
          : { provider, password, age13, termsVersion: terms!.terms.version, termsSections: terms!.terms.sections.map((s) => s.id) }
    );
    setBusy(false);
    if (r.ok) {
      setHubStatus(r.value);
      setMismatch(null);
      setExisting(null);
      toast('Your Kea account is online now. Everything on this computer stayed as it was.', 'success');
    } else if (r.data?.mismatch && r.data.reason === 'differentEmail') setMismatch({ provider, providerEmail: r.data.providerEmail, accountEmail: r.data.accountEmail });
    else if (c.asked(r)) {
    } else if (r.data?.existsOnline) setExisting({ provider, message: r.error });
    else toast(r.error, r.data?.needsCreate ? 'info' : 'error');
  };
  if (mismatch)
    return (
      <div className="acct-form">
        <h3 className="hub-title">That’s a different email</h3>
        <p className="hub-warn">
          That {providerLabel(mismatch.provider)} account is {mismatch.providerEmail}, not {mismatch.accountEmail}. A different email never links to this account, and nothing on this computer changed.
        </p>
        <div className="acct-actions">
          <button className="btn" onClick={signOutAsked}>
            Use a different account
          </button>
          <button className="btn primary" onClick={() => setMismatch(null)}>
            Keep using this account offline
          </button>
        </div>
      </div>
    );
  const providers: KeaSignInProvider[] = status.providers.microsoft ? ['google', 'microsoft'] : ['google'];
  const ready = !!password && !!terms && allAgreed && age13;
  return (
    <div className="acct-form">
      <h3 className="hub-title">Take your account online</h3>
      <p className="muted acct-note">
        Online, your account gets Kea Cloud, classes and organizations, Kea’s shared Claude and Work. Sign in with Google or Microsoft as {status.account.email}: the same email links, and everything on this computer stays.
      </p>
      {!reachable ? (
        <>
          <p className="hub-warn">{status.checked ? 'Kea can’t reach your Kea account online right now. Try again once you’re online.' : 'Checking the connection…'}</p>
          <div className="acct-actions">
            <button className="btn sm" disabled={busy} onClick={async () => (setBusy(true), await refreshHub(), setBusy(false))}>
              Try again
            </button>
          </div>
        </>
      ) : existing ? (
        <>
          <p className="hub-warn">{existing.message}</p>
          <div className="acct-actions">
            <button className="btn primary" disabled={busy} onClick={() => go(existing.provider, 'existing')}>
              Continue with {providerLabel(existing.provider)} again
            </button>
            <button className="btn" onClick={() => setExisting(null)}>
              Back
            </button>
          </div>
        </>
      ) : c.needCode ? (
        <>
          {c.box}
          <div className="acct-actions">
            <button className="btn primary" disabled={busy || !c.code} onClick={() => go(lastProvider, 'create')}>
              Sign in
            </button>
          </div>
        </>
      ) : (
        <>
          <label>
            <span>This account’s password</span>
            <PasswordInput value={password} onChange={setPassword} />
            <span className="acct-hint">The online account uses the same password, so you sign in the same way everywhere.</span>
          </label>
          {terms ? (
            <>
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
              <TermsAgreement sections={terms.terms.sections} onChange={setAllAgreed} />
            </>
          ) : (
            <p className="muted">Getting the terms…</p>
          )}
          <label className="hub-agree">
            <input type="checkbox" checked={age13} onChange={(e) => setAge13(e.target.checked)} /> I’m 13 or older
          </label>
          <div className="acct-actions">
            {providers.map((p) => (
              <button key={p} className="btn primary" disabled={busy || !ready} title={ready ? undefined : 'Enter the password, tick every section and the age box first'} onClick={() => go(p, 'create')}>
                Continue with {providerLabel(p)}
              </button>
            ))}
          </div>
          <p className="muted acct-note">
            Already have an online Kea account with this email?{' '}
            {providers.map((p, i) => (
              <span key={p}>
                {i > 0 && ' or '}
                <button className="btn link sm" disabled={busy} onClick={() => go(p, 'existing')}>
                  Continue with {providerLabel(p)}
                </button>
              </span>
            ))}
          </p>
        </>
      )}
    </div>
  );
}

/** A linked account signed in on this computer without its online session: signing in online again. */
function SignInOnline() {
  const status = useHubStatus();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const c = useCode();
  const [mismatch, setMismatch] = useState<string | null>(null);
  if (!status?.account) return null;
  const done = (r: HubResult<HubStatus>) => {
    if (r.ok) return void (setHubStatus(r.value), toast('Signed in online.', 'success'));
    if (r.data?.mismatch) return void setMismatch(r.error);
    if (!c.asked(r)) toast(r.error, 'error');
  };
  return (
    <form
      className="acct-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const r = await api.hub.login({ email: status.account!.email, password, code: c.code, online: true });
        setBusy(false);
        done(r);
      }}
    >
      <h3 className="hub-title">Sign in online</h3>
      <p className="muted acct-note">
        {status.onlineNote === 'password'
          ? 'Your password was changed online. Sign in with the new one to use Kea Cloud, classes and work again.'
          : status.onlineNote === 'code'
            ? 'Your online account asks for a two-step code. Sign in once more to use Kea Cloud, classes and work.'
            : 'You’re signed in on this computer. Sign in online to use Kea Cloud, classes and work; everything else already works.'}
      </p>
      {!status.reachable && status.checked && <p className="hub-warn">Kea can’t reach your Kea account online right now. Try again once you’re online.</p>}
      {mismatch && <p className="hub-warn">{mismatch}</p>}
      <label>
        <span>Password</span>
        <PasswordInput value={password} onChange={setPassword} />
      </label>
      {c.box}
      <div className="acct-actions">
        <button className="btn primary" type="submit" disabled={busy || !password}>
          <LogIn size={14} /> Sign in online
        </button>
        {(['google', ...(status.providers.microsoft ? ['microsoft'] : [])] as KeaSignInProvider[]).map((p) => (
          <button key={p} type="button" className="btn" disabled={busy} onClick={async () => (setBusy(true), done(await api.hub.link({ provider: p, code: c.code })), setBusy(false))}>
            Continue with {providerLabel(p)}
          </button>
        ))}
      </div>
    </form>
  );
}

/** Changing the password of an account made on this computer (checked and kept here). */
function LocalPassword() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  if (!open)
    return (
      <div className="acct-row">
        <span className="acct-row-main">
          <b>Password</b> <span className="muted">kept on this computer as a scrambled form only</span>
        </span>
        <button className="btn sm" onClick={() => setOpen(true)}>
          Change
        </button>
      </div>
    );
  const hint = passwordHint(next);
  return (
    <form
      className="acct-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (hint) return;
        setBusy(true);
        const s = await run(api.hub.changePassword({ current, next }));
        setBusy(false);
        if (s) (setHubStatus(s), toast('Password changed.', 'success'), setOpen(false), setCurrent(''), setNext(''));
      }}
    >
      <label>
        <span>Current password</span>
        <PasswordInput value={current} onChange={setCurrent} autoFocus />
      </label>
      <label>
        <span>New password</span>
        <PasswordInput value={next} onChange={setNext} autoComplete="new-password" />
        {hint && <span className="acct-hint">{hint}</span>}
      </label>
      <div className="acct-actions">
        <button className="btn primary sm" type="submit" disabled={busy || !current || !!hint}>
          Save
        </button>
        <button className="btn sm" type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** The account's name, changed in place. */
function NameLine({ name, badges }: { name: string; badges: JSX.Element | null }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  if (!editing)
    return (
      <div className="acct-name">
        {name || <span className="muted">No name yet</span>} {badges}
        <button className="icon-btn sm" title="Change your name" aria-label="Change your name" onClick={() => (setValue(name), setEditing(true))}>
          <Pencil size={13} />
        </button>
      </div>
    );
  return (
    <form
      className="acct-name-edit"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const s = await run(api.hub.setName(value));
        setBusy(false);
        if (s) (setHubStatus(s), setEditing(false), toast('Name changed.', 'success'));
      }}
    >
      <input value={value} onChange={(e) => setValue(e.target.value)} maxLength={60} autoFocus aria-label="Your name" />
      <button className="btn primary sm" type="submit" disabled={busy || !value.trim() || value.trim() === name}>
        Save
      </button>
      <button className="btn sm" type="button" onClick={() => setEditing(false)}>
        Cancel
      </button>
    </form>
  );
}

/** Signing out: asked first, and what it means said plainly. */
export async function signOutAsked() {
  const s = hubStatusNow();
  const who = s?.account?.email ?? s?.me?.account.email ?? s?.cached?.email;
  const online = !!s?.signedIn;
  const body = online
    ? 'Kea goes back to its start screen. Your account stays on this computer, so you can sign in again, also offline. Kea Cloud, classes and your organizations stop syncing here, and the copy of your shifts on this computer is removed. Documents saved on this computer stay.'
    : 'Kea goes back to its start screen. Your account and everything on this computer stay, so you can sign in again any time.';
  if ((await ask(`Sign out${who ? ` of ${who}` : ''}?`, body, [{ id: 'cancel', label: 'Cancel' }, { id: 'out', label: 'Sign out', primary: true }])) !== 'out') return;
  const r = await run(api.hub.logout());
  if (r) setHubStatus(r);
}

/**
 * The account page (Settings → Kea account, and School's "Your account"): who you are, taking the account online,
 * verifying your email, storage, notifications, the phone number, sign-in and security, your data, signing out, and
 * (under Advanced) the server's address.
 */
export function HubPanel() {
  const status = useHubStatus();
  const [account] = useAccount();
  const modes = useKeaModes();
  const kc = useKeaCloud((x) => x.status);
  const [mode, setMode] = useState<'signin' | 'create'>('signin');
  useEffect(() => {
    refreshHub();
    return watchKeaCloud();
  }, []);
  // (Kea Cloud's figure is the newer one: when it moves, the account's is fetched again so both say the same.)
  const kcUsed = kc?.storage?.used;
  useEffect(() => {
    if (kcUsed != null && status?.me && kcUsed !== status.me.storage.used) refreshHub();
  }, [kcUsed]);
  if (!status) return null;

  if (status.state === 'none')
    return (
      <div className="acct-card hub-card">
        <h3 className="hub-title">Your Kea account</h3>
        <div className="hub-tabs" role="tablist">
          <button role="tab" aria-selected={mode === 'signin'} className={`chip ${mode === 'signin' ? 'on' : ''}`} onClick={() => setMode('signin')}>
            Sign in
          </button>
          <button role="tab" aria-selected={mode === 'create'} className={`chip ${mode === 'create' ? 'on' : ''}`} onClick={() => setMode('create')}>
            Create an account
          </button>
        </div>
        <SignInOrCreate mode={mode} setMode={setMode} onDone={() => {}} />
      </div>
    );

  if (status.state === 'offline' || status.state === 'linked') {
    const a = status.account!;
    return (
      <div className="acct-page">
        <div className="acct-card hub-card">
          <ProfileHead>
            <div className="acct-who">
              {status.state === 'offline' ? <NameLine name={a.name} badges={null} /> : <div className="acct-name">{a.name || a.email}</div>}
              <div className="muted">{a.email}</div>
              <div className="acct-where">{status.state === 'offline' ? 'On this computer only' : 'Signed in on this computer · not online right now'}</div>
            </div>
          </ProfileHead>
          <div className="acct-actions">
            <button className="btn sm" onClick={signOutAsked}>
              <LogOut size={13} /> Sign out
            </button>
          </div>
        </div>
        <div className="acct-card">{status.state === 'offline' ? <GoOnline /> : <SignInOnline />}</div>
        {status.state === 'offline' && (
          <div className="acct-card">
            <LocalPassword />
          </div>
        )}
        <HubAddressBox />
      </div>
    );
  }

  const me = status.me;
  // Offline: what Kea last saw.
  const c = status.cached;
  const supporter = me?.account.supporter ?? c?.supporter ?? null;
  const who = me?.account ?? (c ? { displayName: c.name, email: c.email, emailVerified: c.emailVerified, verifiedBy: c.verifiedBy ?? null, owner: !!c.owner } : status.account ? { displayName: status.account.name, email: status.account.email, emailVerified: false, verifiedBy: null, owner: false } : null);
  const storage = me ? { used: kc?.storage?.used ?? me.storage.used, quota: kc?.storage?.quota ?? me.storage.quota } : null;
  const games = modes.school || modes.personal;
  const how = (by: string | null) => {
    const b = (by ?? '').toLowerCase();
    return b === 'google' ? 'with Google' : b === 'microsoft' ? 'with Microsoft' : b === 'owner' ? 'by Kea’s creator' : b === 'manager' ? 'by a manager' : by ? `(${by})` : '';
  };
  const verifiedText = who?.owner ? 'Kea’s creator' : who?.emailVerified ? `Email verified ${how(who.verifiedBy)}` : 'Email not verified yet';
  return (
    <div className="acct-page">
      <div className="acct-card hub-card">
        {!status.reachable && status.checked && <p className="hub-warn">Can’t reach your Kea account online right now. You’re still signed in: Kea keeps working with what it last saw and catches up when it’s back.</p>}
        {who && (
          <ProfileHead>
            <div className="acct-who">
              {me ? (
                <NameLine name={who.displayName} badges={<>{who.emailVerified && <VerifiedBadge account={account} size={16} />} {supporter?.active && <SupporterBadge />}</>} />
              ) : (
                <div className="acct-name">{who.displayName}</div>
              )}
              <div className="muted">{who.email}</div>
              <div className={`acct-status ${who.emailVerified ? 'ok' : 'bad'}`}>{verifiedText}</div>
            </div>
          </ProfileHead>
        )}
        {me && !me.account.emailVerified && <VerifyEmail />}
        {me && (
          <div className="hub-stats">
            {games && (
              <>
                <span>Level {me.progress.level}</span>
                <span>{me.progress.xp} XP</span>
                <span>{me.progress.streak}-day streak</span>
              </>
            )}
            {storage && (
              <span title={me.account.emailVerified ? undefined : 'Storage grows once your email is verified'}>
                Kea storage: {formatBytes(storage.used)} of {formatBytes(storage.quota)} used
              </span>
            )}
          </div>
        )}
        {me?.storage.over && (
          <p className="hub-warn">
            Your Kea storage is over its limit: you’re using {formatBytes(me.storage.used)} of {formatBytes(me.storage.quota)}. Nothing has been deleted, and you can still open, change and delete your files. New files wait until you’re under the limit, so delete some to make room.
          </p>
        )}
        {supporter?.active && supporter.until && (
          <p className="muted acct-note hub-supporter-note">
            <Heart size={13} /> Thank you for supporting Kea. Until {dayText(supporter.until)} your storage is {me ? sizeText(me.storage.quota) : 'bigger'} and a supporter badge shows next to your name in classes and organizations.
          </p>
        )}
        <div className="acct-actions">
          <button className="btn sm" onClick={() => api.hub.openTerms()}>
            <ExternalLink size={13} /> Terms
          </button>
          <button className="btn sm" onClick={signOutAsked}>
            <LogOut size={13} /> Sign out
          </button>
        </div>
      </div>
      {me && (
        <div className="acct-card">
          <NotificationList />
        </div>
      )}
      {me && (
        <div className="acct-card">
          <PhoneSetting status={status} />
        </div>
      )}
      {me && (
        <div className="acct-card">
          <SignInSecurity status={status} />
        </div>
      )}
      {me && (
        <div className="acct-card">
          <YourData status={status} />
        </div>
      )}
      <HubAddressBox />
    </div>
  );
}

/** Advanced: the Kea account server's address (shown to copy, for Kea on a phone, and changed here). */
function HubAddressBox() {
  const status = useHubStatus();
  const [open, setOpen] = useState(false);
  if (!status) return null;
  return (
    <div className="acct-card hub-advanced-card">
      <div className="acct-row">
        <span className="acct-row-main">
          <b>Advanced</b>
        </span>
        <button className="btn link sm" onClick={() => setOpen(!open)}>
          {open ? 'Hide' : 'Show'}
        </button>
      </div>
      {open && (
        <>
          <div className="acct-row">
            <span className="acct-row-main">
              <span className="muted">Kea account server</span> {status.url}
            </span>
            <button className="icon-btn sm" title="Copy the address (for Kea on your phone)" aria-label="Copy the server address" onClick={() => navigator.clipboard.writeText(status.url).then(() => toast('Address copied.', 'success'), () => {})}>
              <Copy size={13} />
            </button>
          </div>
          <HubAddress />
        </>
      )}
    </div>
  );
}

/**
 * Kea starts with the Kea account: sign in, or make one, before anything else. This is decided from this computer
 * alone, at once: it never waits on the network, and an account works with or without a connection. Once signed in,
 * Kea stays signed in here. Signing out brings this back.
 */
export function AccountGate() {
  const status = useHubStatus();
  const [mode, setMode] = useState<'signin' | 'create' | null>(null);
  useEffect(() => {
    loadLocal();
    refreshHub();
  }, []);
  const open = !!status && status.state === 'none';
  // (Signed out: the start screen is the one place to sign in, so Settings, open on the account page, closes.)
  useEffect(() => {
    if (open) useSettings.getState().ui({ open: false });
  }, [open]);
  // (Before this computer's answer, a few milliseconds: an empty cover, so nothing flashes.)
  if (!status) return <div className="account-gate" />;
  if (!open) return null;
  // (A computer nobody has signed in on starts at making an account.)
  const m = mode ?? (status.known.length ? 'signin' : 'create');
  return (
    <div className="account-gate">
      <div className="account-gate-inner">
        <h1>{m === 'signin' ? 'Sign in to Kea' : 'Create your Kea account'}</h1>
        <p className="welcome-sub">Your Kea account works on this computer right away, with or without a connection. Online, it adds Kea Cloud, classes and work on all your devices.</p>
        <div className="acct-card hub-card">
          <SignInOrCreate mode={m} setMode={setMode} onDone={() => refreshHub()} />
          <p className="account-gate-switch">
            {m === 'signin' ? 'New to Kea? ' : 'Already have an account? '}
            <button className="btn link" onClick={() => setMode(m === 'signin' ? 'create' : 'signin')}>
              {m === 'signin' ? 'Create an account' : 'Sign in'}
            </button>
          </p>
          <details className="gate-advanced">
            <summary>Advanced</summary>
            <HubAddress />
          </details>
        </div>
      </div>
    </div>
  );
}

/** The optional phone number, and who sees it. Never on leaderboards; nobody sees it unless chosen here. */
function PhoneSetting({ status }: { status: HubStatus }) {
  const modes = useKeaModes();
  const cur = status.me?.account.phone ?? { number: null, visibility: 'nobody' as HubPhoneVisibility };
  // (No number yet: who'd see one starts at the people it's usually for: coworkers in Work, classmates in School.)
  const suggested: HubPhoneVisibility = cur.number ? cur.visibility : modes.work && modes.school ? 'both' : modes.work ? 'orgs' : modes.school ? 'classes' : 'nobody';
  const [number, setNumber] = useState(cur.number || '');
  const [visibility, setVisibility] = useState<HubPhoneVisibility>(suggested);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setNumber(cur.number || '');
    setVisibility(suggested);
  }, [cur.number, cur.visibility]);
  const save = async (patch: { phone?: string | null; visibility?: HubPhoneVisibility }, done: string) => {
    setBusy(true);
    const s = await run(api.hub.setPhone(patch));
    setBusy(false);
    if (s) (setHubStatus(s), toast(done, 'success'));
  };
  const changed = number.trim() !== (cur.number || '') || visibility !== cur.visibility;
  return (
    <div className="acct-form hub-phone">
      <h3 className="hub-title">
        <Phone size={14} /> Phone number <span className="muted hub-optional">optional</span>
      </h3>
      {cur.number && (
        <p className="acct-note">
          Saved: <b>{formatPhone(cur.number)}</b>
        </p>
      )}
      <div className="hub-phone-row">
        <label>
          <span>Number</span>
          <input value={number} onChange={(e) => setNumber(e.target.value)} type="tel" inputMode="tel" autoComplete="tel" placeholder="+1 719 555 0100" />
        </label>
        <label>
          <span>Who sees it</span>
          <select className="acct-select" value={visibility} onChange={(e) => setVisibility(e.target.value as HubPhoneVisibility)}>
            <option value="nobody">Nobody</option>
            <option value="classes">Classmates in my classes</option>
            <option value="orgs">Coworkers in my organizations</option>
            <option value="both">Classmates and coworkers</option>
          </select>
        </label>
      </div>
      <p className="muted acct-note">It shows in class and organization member lists only for the people you pick, never on leaderboards and never publicly.</p>
      <div className="acct-actions">
        <button className="btn sm primary" disabled={busy || !changed || !number.trim()} title={!number.trim() ? 'Type a number first' : !changed ? 'Nothing changed' : undefined} onClick={() => save({ phone: number.trim(), visibility }, 'Phone number saved.')}>
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
    if (r) setHubNotifications(r);
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

/** Where the Kea account server is (under Advanced). Every device needs its public address; 127.0.0.1 only works on the
 * server's own computer. Empty goes back to the address this copy of Kea came with. A new address is kept only once a server
 * answers there, and moving to another one while signed in online is asked first (it ends the online sign-in here). */
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
    let r = await api.hub.setUrl(to);
    if (!r.ok && r.data?.switchSignsOut) {
      const yes = (await ask('Switch to another server?', r.error, [{ id: 'no', label: 'Cancel' }, { id: 'yes', label: 'Switch', primary: true }])) === 'yes';
      r = yes ? await api.hub.setUrl(to, true) : r;
      if (!yes) return setBusy(false);
    }
    setBusy(false);
    if (!r.ok) return toast(r.error, 'error');
    setHubStatus(r.value);
    toast(r.value.signedIn ? 'Connected.' : r.value.state === 'linked' ? 'Connected. Sign in online on this server.' : 'Connected.', 'success');
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
        <span>Kea account server address</span>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={status.defaultUrl || 'https://name.tailnet.ts.net'} spellCheck={false} />
      </label>
      <p className="muted acct-note">
        {status.reachable ? 'Connected.' : status.checked ? 'Not answering at this address right now.' : 'Checking…'} Only change this if you were given another address. Kea checks a new address before using it.
      </p>
      <div className="acct-actions">
        <button className="btn sm" type="submit" disabled={busy || !url.trim() || url.trim() === status.url}>
          {busy ? 'Checking…' : 'Save address'}
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
    const offNotes = api.hub.onNotifications((n) => setHubNotifications(n));
    const offOpen = api.hub.onOpenAccount(() => openAccount());
    // (The account changed by itself in the main process: a background online sign-in, the session ended, the
    // server came back or went away.)
    const offChanged = api.hub.onChanged(() => refreshHub());
    return () => (clearInterval(t), offNotes(), offOpen(), offChanged());
  }, []);
  // (Signed in online but the server can't be reached: checked again every minute, so Kea catches up when it's back.)
  const away = !!status?.signedIn && !!status.checked && !status.reachable;
  useEffect(() => {
    if (!away) return;
    const t = setInterval(() => refreshHub(), 60_000);
    return () => clearInterval(t);
  }, [away]);
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
          <button className="btn" onClick={async () => { const s = await run(api.hub.logout()); if (s) setHubStatus(s); }}>
            Sign out
          </button>
          <button
            className="btn primary"
            disabled={busy || !allAgreed}
            onClick={async () => {
              setBusy(true);
              const s = await run(api.hub.accept({ termsVersion: changes.to, termsSections: allIds }));
              setBusy(false);
              if (s) (setHubStatus(s), toast('Thanks. You’re all set.', 'success'));
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
      {!status?.signedIn || !status.reachable ? (
        <NeedsOnline what="Kea’s shared Claude" />
      ) : !status.me?.account.emailVerified ? (
        <div className="hub-warn">Verify your email with Google first. <VerifyEmail compact /></div>
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
              if (!r.ok) return toast(r.status === 404 ? 'You’re not in this course section on Kea yet. Ask for questions first.' : r.error, 'error');
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
