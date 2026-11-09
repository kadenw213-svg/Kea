import { useEffect, useRef, useState } from 'react';
import { BadgeCheck, Bell, Check, Copy, ExternalLink, Heart, LogIn, LogOut, Pencil, Phone, Trash2 } from 'lucide-react';
import { api, HubConsent, HubNotification, HubNotifications, HubQuestionChapter, HubResult, HubScanJob, HubSectionRequest, HubServing, HubStatus, HubTerms, HubTermsChanges, KeaSignInProvider, TermsSection } from '../../lib/api';
import { toast, ask } from '../../store';
import { formatBytes } from '../../lib/util';
import { useKeaModes } from '../../lib/modes';
import { useKeaCloud, watchKeaCloud } from '../../lib/keaCloud';
import { PHONE_HINT, SHARE_DEFAULTS, oneStepAgreement, profileSave, savedText, showPhone } from '../../lib/profile';
import { SIGN_IN_WAITS, hubStatusNow, loadLocal, openAccount, refreshHub, refreshNotifications, run, setHubNotifications, setHubStatus, signInWaits, useHubNotifications, useHubStatus } from '../account/hubStore';
import { NeedsOnline } from '../account/NeedsOnline';
import { OwnClaudeSwitch, useOwnClaudeOnly } from '../account/OwnClaude';
import { SignInSecurity, YourData } from '../account/Security';
import { ProfileHead, VerifiedBadge, useAccount } from './Account';
import { UpdateRequired } from '../Updates';

// The Kea account: one sign-in for Kea and KeaS, made with Google or Microsoft once the Kea account server answers.
// Without one everything on this computer works. Its state lives in account/hubStore.ts (shared with the title bar,
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

/** The owner account's two-step code (or a backup code): the only Kea account that still has one. */
function CodeBox({ code, setCode }: { code: string; setCode(c: string): void }) {
  return (
    <label>
      <span>Two-step code</span>
      <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9 -]/g, '').slice(0, 11))} autoComplete="one-time-code" spellCheck={false} maxLength={11} autoFocus />
      <span className="acct-hint">The owner account asks for the code from its authenticator app, or a backup code.</span>
    </label>
  );
}

const providerLabel = (p: KeaSignInProvider) => (p === 'microsoft' ? 'Microsoft' : 'Google');
const NOT_SET_UP = 'Sign-in isn’t available in this copy of Kea. Everything on this computer still works.';
/**
 * The Sign in with Google / Microsoft buttons this copy of Kea is set up for (none: a plain sentence instead). While
 * the Kea account server can't be reached they wait, and say so; Kea checks again by itself.
 */
function ProviderButtons({ busy, onPick, primary = true }: { busy: boolean; onPick(p: KeaSignInProvider): void; primary?: boolean }) {
  const status = useHubStatus();
  const list: KeaSignInProvider[] = (['google', 'microsoft'] as KeaSignInProvider[]).filter((p) => status?.providers[p]);
  if (!list.length) return <p className="muted acct-note">{NOT_SET_UP}</p>;
  const waits = signInWaits(status);
  return (
    <>
      <div className="acct-actions">
        {list.map((p) => (
          <button key={p} type="button" className={`btn ${primary ? 'primary' : ''}`} disabled={busy || waits} onClick={() => onPick(p)}>
            <LogIn size={14} /> Sign in with {providerLabel(p)}
          </button>
        ))}
      </div>
      {waits && <p className="muted acct-note">{SIGN_IN_WAITS} Kea tries again by itself.</p>}
    </>
  );
}

/**
 * Sign in with Google or Microsoft, and what it may still need: the terms (the first sign-in makes the account) or the
 * owner's two-step code. signIn starts it with no account here; link takes an account here online.
 */
function useOnlineSignIn(onDone: () => void) {
  const status = useHubStatus();
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<'terms' | 'code' | null>(null);
  const [mismatch, setMismatch] = useState<{ provider: KeaSignInProvider; providerEmail: string; accountEmail: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // (A sign-in still waiting for the terms after the page reloaded.)
  useEffect(() => {
    if (status?.pending && !step) setStep(status.pending.code ? 'code' : 'terms');
  }, [!!status?.pending]);
  const handle = (r: HubResult<HubStatus>, provider?: KeaSignInProvider) => {
    setNote(null);
    if (r.ok) {
      setHubStatus(r.value);
      setStep(null);
      setMismatch(null);
      toast(r.value.state === 'online' ? 'Signed in to your Kea account.' : 'Signed in.', 'success');
      onDone();
      return;
    }
    if (r.data?.needsAccount) return void (refreshHub(), setStep('terms'));
    if (r.data?.totpRequired) {
      if (step === 'code') toast(r.error, 'error');
      return void setStep('code');
    }
    setStep(null);
    if (r.data?.mismatch && r.data.reason === 'differentEmail' && provider) return void setMismatch({ provider, providerEmail: r.data.providerEmail, accountEmail: r.data.accountEmail });
    if (r.status === 0) refreshHub();
    if (r.status === 0 || r.data?.noAccount || r.data?.notSetUp || r.data?.expired) return void setNote(r.error);
    toast(r.error, 'error');
  };
  const call = async (p: Promise<HubResult<HubStatus>>, provider?: KeaSignInProvider) => {
    setBusy(true);
    const r = await p;
    setBusy(false);
    handle(r, provider);
  };
  return {
    busy,
    step,
    mismatch,
    note,
    clearMismatch: () => setMismatch(null),
    signIn: (provider: KeaSignInProvider) => call(api.hub.oauthSignIn({ provider }), provider),
    link: (provider: KeaSignInProvider) => call(api.hub.link({ provider }), provider),
    finish: (a: Parameters<typeof api.hub.continueSignIn>[0]) => call(api.hub.continueSignIn(a)),
    cancel: async () => {
      setStep(null);
      const r = await api.hub.cancelSignIn();
      if (r.ok) setHubStatus(r.value);
    },
  };
}
type OnlineSignIn = ReturnType<typeof useOnlineSignIn>;

/**
 * The first Google or Microsoft sign-in for an email makes the Kea account: one step, one button. "Agree and continue"
 * agrees to every section of the current terms and confirms 13 or older (oneStepAgreement), as the server asks.
 */
function NewOnlineAccount({ s }: { s: OnlineSignIn }) {
  const status = useHubStatus();
  const [terms, setTerms] = useState<HubTerms | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.hub.terms().then((r) => (r.ok ? setTerms(r.value) : setErr(r.error)));
  }, []);
  const email = status?.pending?.email;
  return (
    <div className="acct-form hub-onestep">
      <h3 className="hub-title">One last step{email ? <span className="muted hub-onestep-email"> · {email}</span> : null}</h3>
      <p className="acct-note">
        By continuing you agree to the{' '}
        <button type="button" className="btn link hub-inline-link" onClick={() => api.hub.openTerms()}>
          Kea terms
        </button>{' '}
        and confirm you’re 13 or older.
      </p>
      {err && <p className="hub-warn">{err}</p>}
      <div className="acct-actions">
        <button className="btn primary" disabled={s.busy || !terms} onClick={() => terms && s.finish(oneStepAgreement(terms.terms))}>
          {terms ? 'Agree and continue' : 'Getting the terms…'}
        </button>
        <button className="btn" disabled={s.busy} onClick={s.cancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** The owner account's two-step code, after its Google or Microsoft sign-in. */
function OwnerCode({ s }: { s: OnlineSignIn }) {
  const [code, setCode] = useState('');
  return (
    <form className="acct-form" onSubmit={(e) => (e.preventDefault(), s.finish({ code }))}>
      <CodeBox code={code} setCode={setCode} />
      <div className="acct-actions">
        <button className="btn primary" type="submit" disabled={s.busy || code.replace(/\s/g, '').length < 6}>
          Sign in
        </button>
        <button className="btn" type="button" disabled={s.busy} onClick={s.cancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * No account signed in here: Sign in with Google or Microsoft makes the account or signs in to it, once the Kea account
 * server answers. Everything already on this computer stays. An account used here before (signed out) opens again from
 * its email, with no connection needed; nothing here makes a new one.
 */
function SignInStart({ onDone }: { onDone(): void }) {
  const status = useHubStatus();
  const s = useOnlineSignIn(onDone);
  const [busy, setBusy] = useState(false);
  if (s.step === 'terms') return <NewOnlineAccount s={s} />;
  if (s.step === 'code') return <OwnerCode s={s} />;
  const known = status?.known || [];
  const reopen = async (email: string) => {
    setBusy(true);
    const r = await api.hub.openHere({ email });
    setBusy(false);
    if (!r.ok) return void toast(r.error, 'error');
    setHubStatus(r.value);
    toast('Signed in.', 'success');
    onDone();
  };
  return (
    <div className="acct-form">
      <p className="muted acct-note">One click, and your classes, Kea cloud and organizations follow you to every device. Everything on this computer stays.</p>
      <ProviderButtons busy={s.busy} onPick={s.signIn} />
      {s.note && <p className="hub-warn">{s.note}</p>}
      {known.length > 0 && (
        <>
          <div className="acct-or muted">or open one used here before</div>
          <div className="acct-known" aria-label="Accounts on this computer">
            {known.slice(0, 4).map((k) => (
              <button key={k.email} type="button" className="btn sm" disabled={busy || s.busy} onClick={() => reopen(k.email)} title={k.name || undefined}>
                {k.email}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Taking the account on this computer online (or signing in online again): Sign in with Google or Microsoft with the
 * same email. The same email links (the online account is made then, with the terms, or signed in to); a different
 * email never links. Nothing on this computer is deleted either way.
 */
function GoOnline() {
  const status = useHubStatus();
  const s = useOnlineSignIn(() => {});
  const reachable = !!status?.reachable;
  useEffect(() => {
    // (Not reachable: checked again every 20 seconds while this is open.)
    if (reachable) return;
    const t = setInterval(() => refreshHub(), 20_000);
    return () => clearInterval(t);
  }, [reachable]);
  if (!status?.account) return null;
  const again = status.state === 'linked';
  if (s.mismatch)
    return (
      <div className="acct-form">
        <h3 className="hub-title">That’s a different email</h3>
        <p className="hub-warn">
          That {providerLabel(s.mismatch.provider)} account is {s.mismatch.providerEmail}, not {s.mismatch.accountEmail}. A different email never links to this account, and nothing on this computer changed.
        </p>
        <div className="acct-actions">
          <button className="btn" onClick={signOutAsked}>
            Use a different account
          </button>
          <button className="btn primary" onClick={s.clearMismatch}>
            Keep this account as it is
          </button>
        </div>
      </div>
    );
  if (s.step === 'terms') return <NewOnlineAccount s={s} />;
  if (s.step === 'code') return <OwnerCode s={s} />;
  return (
    <div className="acct-form">
      <h3 className="hub-title">{again ? 'Sign in again' : 'Take your account online'}</h3>
      <p className="muted acct-note">
        {status.moved?.kind === 'moved' && status.moved.to === status.url
          ? 'Your Kea account moved to a new address. Sign in once to continue.'
          : again
            ? 'Sign in once more to get Kea cloud, classes and Work back. Everything else already works.'
            : `Sign in as ${status.account.email}. Everything on this computer stays.`}
      </p>
      {s.note && <p className="hub-warn">{s.note}</p>}
      <ProviderButtons busy={s.busy} onPick={s.link} />
    </div>
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
    ? 'Kea keeps working on this computer without an account. Kea cloud, classes and your organizations stop syncing here, and the copy of your shifts on this computer is removed. Documents saved on this computer stay, and you can sign in again any time.'
    : 'Kea keeps working on this computer without an account. Your account and everything on this computer stay, so you can open it again any time under Settings → Kea account.';
  if ((await ask(`Sign out${who ? ` of ${who}` : ''}?`, body, [{ id: 'cancel', label: 'Cancel' }, { id: 'out', label: 'Sign out', primary: true }])) !== 'out') return;
  const r = await run(api.hub.logout());
  if (r) setHubStatus(r);
}

/**
 * The account page (Settings → Kea account, and School's "Your account"): who you are, taking the account online,
 * storage, notifications, the phone number, sign-in and security, your data, signing out, and
 * (under Advanced) the server's address.
 */
export function HubPanel() {
  const status = useHubStatus();
  const [account] = useAccount();
  const modes = useKeaModes();
  const kc = useKeaCloud((x) => x.status);
  useEffect(() => {
    refreshHub();
    return watchKeaCloud();
  }, []);
  // (Kea cloud's figure is the newer one: when it moves, the account's is fetched again so both say the same.)
  const kcUsed = kc?.storage?.used;
  useEffect(() => {
    if (kcUsed != null && status?.me && kcUsed !== status.me.storage.used) refreshHub();
  }, [kcUsed]);
  if (!status) return null;

  if (status.state === 'none')
    return (
      <div className="acct-page">
        <UpdateRequired />
        <div className="acct-card hub-card">
          <h3 className="hub-title">Your Kea account</h3>
          <SignInStart onDone={() => {}} />
        </div>
        <HubAddressBox />
      </div>
    );

  if (status.state === 'offline' || status.state === 'linked') {
    const a = status.account!;
    return (
      <div className="acct-page">
        <UpdateRequired />
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
        <div className="acct-card">
          <GoOnline />
        </div>
        <HubAddressBox />
      </div>
    );
  }

  const me = status.me;
  // Offline: what Kea last saw.
  const c = status.cached;
  const supporter = me?.account.supporter ?? c?.supporter ?? null;
  const who = me?.account ?? (c ? { displayName: c.name, email: c.email, owner: !!c.owner } : status.account ? { displayName: status.account.name, email: status.account.email, owner: false } : null);
  const storage = me ? { used: kc?.storage?.used ?? me.storage.used, quota: kc?.storage?.quota ?? me.storage.quota } : null;
  const games = modes.school || modes.personal;
  return (
    <div className="acct-page">
        <UpdateRequired />
      <div className="acct-card hub-card">
        {!status.reachable && status.checked && <p className="hub-warn">Can’t reach the Kea account server right now. You’re still signed in: Kea keeps working with what it last saw and catches up when it’s back.</p>}
        {status.profileNote && <p className="hub-warn">{status.profileNote}</p>}
        {who && (
          <ProfileHead>
            <div className="acct-who">
              <div className="acct-name">
                {status.profile?.name || who.displayName || <span className="muted">No name yet</span>} <VerifiedBadge account={account} size={16} /> {supporter?.active && <SupporterBadge />}
              </div>
              <div className="muted">
                {who.email}
                {status.profile?.phone ? ` · ${showPhone(status.profile.phone)}` : ''}
              </div>
              {who.owner && <div className="acct-status ok">Kea’s creator</div>}
            </div>
          </ProfileHead>
        )}
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
              <span>
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
      {status.signedIn && (
        <div className="acct-card">
          <ProfileForm />
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
 * Kea opens at once, with or without an account: nothing waits for the account or the network. This only loads who's
 * signed in (this computer first, then a background check of the server), and while there's no account and the Kea
 * account server can't be reached, checks again every 20 seconds so "Sign in with Google" is ready once it answers.
 * Once signed in, Kea stays signed in here (offline too) until the person signs out.
 */
export function AccountWatch() {
  const status = useHubStatus();
  useEffect(() => {
    loadLocal();
    refreshHub();
  }, []);
  const waiting = !!status && status.state === 'none' && signInWaits(status);
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => refreshHub(), 20_000);
    return () => clearInterval(t);
  }, [waiting]);
  return null;
}

/** One switch with its words (the settings look). */
function ShareSwitch({ on, set, label, hint }: { on: boolean; set(v: boolean): void; label: string; hint?: string }) {
  return (
    <div className="hub-share-row">
      <span className="hub-share-text">
        {label}
        {hint && <span className="muted hub-share-hint">{hint}</span>}
      </span>
      <button type="button" role="switch" aria-checked={on} aria-label={label} className={`switch ${on ? 'on' : ''}`} onClick={() => set(!on)}>
        <span />
      </button>
    </div>
  );
}

/**
 * Your name and phone number: the small card after the first sign-in (`welcome`: Skip, and everything is sent), and
 * the same form in Settings → Kea account (only what changed is sent). The phone is optional, checked lightly and kept
 * as +15551234567. Saving while the server can't be reached keeps the change here and sends it once it's back.
 */
export function ProfileForm({ welcome = false, onDone }: { welcome?: boolean; onDone?(): void }) {
  const status = useHubStatus();
  const p = status?.profile ?? null;
  const fallbackName = p?.name || status?.me?.account.displayName || status?.cached?.name || status?.account?.name || '';
  const [name, setName] = useState(fallbackName);
  const [phone, setPhone] = useState(p?.phone ? showPhone(p.phone) : '');
  const [orgs, setOrgs] = useState(p?.phoneShare.orgs ?? SHARE_DEFAULTS.orgs);
  const [classmates, setClassmates] = useState(p?.phoneShare.classmates ?? SHARE_DEFAULTS.classmates);
  const [err, setErr] = useState<{ field: 'name' | 'phone' | null; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // (What Kea knows changed, from elsewhere: the form follows, unless it's being typed in.)
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (touched || !p) return;
    setName(p.name || fallbackName);
    setPhone(p.phone ? showPhone(p.phone) : '');
    setOrgs(p.phoneShare.orgs);
    setClassmates(p.phoneShare.classmates);
  }, [p?.name, p?.phone, p?.phoneShare.orgs, p?.phoneShare.classmates]);
  const touch = <T,>(set: (v: T) => void) => (v: T) => (setTouched(true), setErr(null), set(v));
  const save = async () => {
    const v = profileSave({ name, phone, phoneShare: { orgs, classmates } }, welcome ? null : p);
    if (!v.ok) return setErr({ field: v.field, text: v.error });
    if (!Object.keys(v.patch).length) return onDone?.();
    setBusy(true);
    const r = await api.hub.saveProfile(v.patch);
    setBusy(false);
    if (!r.ok) return setErr({ field: r.data?.field ?? null, text: r.error });
    setHubStatus(r.value);
    setTouched(false);
    toast(savedText(!!r.value.profileQueued), 'success');
    onDone?.();
  };
  return (
    <form className="acct-form hub-profile" onSubmit={(e) => (e.preventDefault(), save())}>
      {!welcome && (
        <h3 className="hub-title">
          <Phone size={14} /> Name and phone
        </h3>
      )}
      <label>
        <span>Name</span>
        <input value={name} onChange={(e) => touch(setName)(e.target.value)} maxLength={60} autoComplete="name" aria-invalid={err?.field === 'name'} autoFocus={welcome} />
      </label>
      <label>
        <span>
          Phone number <span className="muted hub-optional">optional</span>
        </span>
        <input value={phone} onChange={(e) => touch(setPhone)(e.target.value)} type="tel" inputMode="tel" autoComplete="tel" placeholder="(555) 123-4567" aria-invalid={err?.field === 'phone'} />
      </label>
      <div className="hub-share">
        <ShareSwitch on={orgs} set={touch(setOrgs)} label="Share with organizations I join" />
        <ShareSwitch on={classmates} set={touch(setClassmates)} label="Share with classmates" />
      </div>
      {err ? <p className="hub-warn">{err.text}</p> : <p className="muted acct-note">{phone.trim() ? 'Never public and never on leaderboards.' : PHONE_HINT}</p>}
      {p?.queued && !touched && <p className="muted acct-note">{savedText(true)}</p>}
      <div className="acct-actions">
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        {welcome && (
          <button className="btn" type="button" disabled={busy} onClick={() => onDone?.()}>
            Skip
          </button>
        )}
      </div>
    </form>
  );
}

/**
 * Right after the first sign-in on this computer: a small card for your name and phone. Skippable; it shows once, and
 * the same form is in Settings → Kea account.
 */
export function ProfileWelcome() {
  const status = useHubStatus();
  if (!status?.askProfile || !status.signedIn || status.pending) return null;
  // (Agreeing to changed terms comes first.)
  if (status.me?.terms.needsAgreement) return null;
  const done = async () => {
    const r = await api.hub.profileAsked();
    if (r.ok) setHubStatus(r.value);
  };
  return (
    <div className="scrim">
      <div className="dialog hub-welcome">
        <h2>You’re in</h2>
        <p className="muted">Add your name and, if you like, a phone number. You can change them any time in Settings → Kea account.</p>
        <ProfileForm welcome onDone={done} />
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
 * Shown once when the Kea account server moved to a new address (the owner's Hub to KeaC). Checked: Kea uses the new
 * address and the person signs in online once there (the account on this computer stays).
 * Not checked: Kea kept the old address, and Advanced says where the old one said it went.
 */
export function MovedNotice() {
  const status = useHubStatus();
  const m = status?.moved;
  if (!m || m.seen) return null;
  const close = async () => {
    const r = await api.hub.movedSeen();
    if (r.ok) setHubStatus(r.value);
  };
  return (
    <div className="scrim">
      <div className="dialog">
        {m.kind === 'moved' ? (
          <>
            <h2>Your Kea account moved</h2>
            <p>Your Kea account moved to a new address. Sign in once to continue.</p>
            <p className="muted">Everything on this computer stays, and you stay signed in here without a connection.</p>
          </>
        ) : (
          <>
            <h2>Your Kea account server moved</h2>
            <p>Your Kea account server moved, but the new address couldn’t be checked. Kea kept using {m.from} and tries again later.</p>
          </>
        )}
        <details className="gate-advanced">
          <summary>Advanced</summary>
          <p className="muted acct-note">
            Old address: {m.from}
            <br />
            New address: {m.to || 'not given'}
            {m.reason && (
              <>
                <br />
                {m.reason}
              </>
            )}
          </p>
          {m.kind === 'unchecked' && <HubAddress />}
        </details>
        <div className="dialog-actions">
          {m.kind === 'moved' && status?.account && !status.signedIn && (
            <button className="btn" onClick={() => (close(), openAccount())}>
              <LogIn size={14} /> Sign in
            </button>
          )}
          <button className="btn primary" onClick={close}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * No Claude account? Kea's shared Claude (run by Kea's creator, free, limited and queued) can set up your classes.
 * Only the class site's address goes to the Kea account server, never the login: while the scan runs it browses the class
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
  // "Use my own Claude": Kea's shared Claude is never asked (the switch says why, right here).
  const ownOnly = useOwnClaudeOnly();
  return (
    <div className="hub-shared">
      <h3 className="hub-title">No Claude account? Use Kea’s shared Claude</h3>
      <p className="muted acct-note">
        Free, with limits: one full scan per class each term, a light check at most once a day, practice questions 25 at a time and one guide per assignment. It needs your Kea account online. Your school password never leaves this computer: the scan reads your class site through this Kea, so keep Kea open while it runs. With your own Claude there are no limits and no account is needed.
      </p>
      <OwnClaudeSwitch />
      {ownOnly ? (
        <p className="muted acct-note">Kea uses only your own Claude. Turn the switch off to use Kea’s shared Claude.</p>
      ) : !status?.signedIn || !status.reachable ? (
        <NeedsOnline what="Kea’s shared Claude" />
      ) : !status.me ? null : status.me.account.birthYear == null || status.me.account.parentSignOff === 'needed' || status.me.account.parentSignOff === 'pending' ? (
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
      {!ownOnly && status?.signedIn && status.me && status.me.account.birthYear != null && (status.me.account.parentSignOff === 'approved' || status.me.account.parentSignOff === 'not_needed') && (
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
      <p className="muted acct-note">Ask for 25 new questions on one chapter; the next 25 come once you’ve answered 20. They’re different from the ones you have, classmates who ask for the same chapter get them too, and they show up in Study after a sync.</p>
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
