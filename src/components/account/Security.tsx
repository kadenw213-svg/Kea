// The account page's "Sign-in and security" and "Your data": password, two-step sign-in, signed-in devices, the data
// download and deleting the account. Each uses the Kea Hub's own routes; the Hub asks for the password again before
// anything that changes how you sign in.
import { useEffect, useMemo, useState } from 'react';
import { Copy, Download, Eye, EyeOff, KeyRound, LogOut, Monitor, ShieldCheck, Smartphone, Trash2 } from 'lucide-react';
import qrcode from 'qrcode-generator';
import { api, HubSession, HubStatus } from '../../lib/api';
import { ask, toast } from '../../store';
import { run, setHubStatus } from './hubStore';

/** A password box with a show/hide button. */
export function PasswordInput({ value, onChange, autoComplete = 'current-password', placeholder, autoFocus }: { value: string; onChange(v: string): void; autoComplete?: string; placeholder?: string; autoFocus?: boolean }) {
  const [show, setShow] = useState(false);
  return (
    <span className="acct-pw">
      <input value={value} onChange={(e) => onChange(e.target.value)} type={show ? 'text' : 'password'} autoComplete={autoComplete} placeholder={placeholder} autoFocus={autoFocus} />
      <button type="button" className="icon-btn sm" title={show ? 'Hide password' : 'Show password'} aria-label={show ? 'Hide password' : 'Show password'} onClick={() => setShow(!show)}>
        {show ? <EyeOff size={14} /> : <Eye size={14} />}
      </button>
    </span>
  );
}

/** The Hub's rule for a new password, said before it's sent (the Hub also refuses common ones). */
export const passwordHint = (pw: string) => (!pw ? 'At least 10 characters. A few random words works well.' : [...pw].length < 10 ? `${10 - [...pw].length} more character${10 - [...pw].length === 1 ? '' : 's'} (at least 10).` : null);

/** A code box for the 6 digits from an authenticator app. */
function CodeInput({ value, onChange, autoFocus }: { value: string; onChange(v: string): void; autoFocus?: boolean }) {
  return <input className="acct-code" value={value} onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" placeholder="123456" autoFocus={autoFocus} />;
}

/** The QR code for an authenticator app, drawn here (the secret never leaves this computer for a QR service). */
function Qr({ text }: { text: string }) {
  const svg = useMemo(() => {
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    const n = q.getModuleCount();
    const m = 4; // quiet zone
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + m},${r + m}h1v1h-1z`;
    return { d, size: n + 2 * m };
  }, [text]);
  return (
    <svg className="acct-qr" viewBox={`0 0 ${svg.size} ${svg.size}`} width={180} height={180} role="img" aria-label="QR code for your authenticator app" shapeRendering="crispEdges">
      <rect width={svg.size} height={svg.size} fill="#fff" />
      <path d={svg.d} fill="#000" />
    </svg>
  );
}

function ChangePassword({ status, onDone }: { status: HubStatus; onDone(): void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const hint = passwordHint(next);
  return (
    <form
      className="acct-form acct-sub"
      onSubmit={async (e) => {
        e.preventDefault();
        if (hint) return;
        setBusy(true);
        const s = await run(api.hub.changePassword({ current, next }));
        setBusy(false);
        if (s) (setHubStatus(s), toast('Password changed. Your other devices are signed out.', 'success'), onDone());
      }}
    >
      <input type="email" autoComplete="username" value={status.me?.account.email ?? ''} readOnly hidden />
      <label>
        <span>Current password</span>
        <PasswordInput value={current} onChange={setCurrent} autoFocus />
      </label>
      <label>
        <span>New password</span>
        <PasswordInput value={next} onChange={setNext} autoComplete="new-password" />
        {hint && <span className="acct-hint">{hint}</span>}
      </label>
      <p className="muted acct-note">Every other device signed in to your account is signed out.</p>
      <div className="acct-actions">
        <button className="btn primary sm" type="submit" disabled={busy || !current || !!hint}>
          Change password
        </button>
        <button className="btn sm" type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** New backup codes, shown once: Copy, Save as text, and "I saved these" before they go. */
function BackupCodesShown({ codes, email, onDone }: { codes: string[]; email: string; onDone(): void }) {
  const [saved, setSaved] = useState(false);
  const text = () =>
    [`Kea two-step sign-in backup codes for ${email}`, `Made ${new Date().toLocaleString()}`, '', 'Each code works once, in place of the code from your authenticator app. Keep them somewhere safe.', '', ...codes, ''].join('\r\n');
  return (
    <div className="acct-form acct-sub">
      <p>
        <b>Your backup codes.</b> If you lose your phone, each one signs you in once instead of the code from your authenticator app. They’re shown only now, so keep them somewhere safe.
      </p>
      <ol className="acct-codes">
        {codes.map((c) => (
          <li key={c}>
            <code>{c}</code>
          </li>
        ))}
      </ol>
      <div className="acct-actions">
        <button
          className="btn sm"
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(codes.join('\n'));
              toast('Copied.', 'success');
            } catch {
              toast('Select the codes to copy them.', 'error');
            }
          }}
        >
          <Copy size={14} /> Copy
        </button>
        <button
          className="btn sm"
          type="button"
          onClick={async () => {
            const p = await api.saveDialog({ title: 'Save your backup codes', defaultPath: 'Kea backup codes.txt', filters: [{ name: 'Text', extensions: ['txt'] }] });
            if (p && (await api.writeFile(p, new TextEncoder().encode(text())))) toast('Saved.', 'success');
          }}
        >
          <Download size={14} /> Save as text…
        </button>
      </div>
      <label className="acct-check">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I saved these
      </label>
      <div className="acct-actions">
        <button className="btn primary sm" type="button" disabled={!saved} onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

function TwoStep({ status }: { status: HubStatus }) {
  const a = status.me!.account;
  const [step, setStep] = useState<'idle' | 'password' | 'scan' | 'off' | 'regen' | 'codes'>('idle');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const reset = () => (setStep('idle'), setPassword(''), setCode(''), setSetup(null), setCodes(null));
  if (step === 'codes' && codes) return <BackupCodesShown codes={codes} email={a.email} onDone={reset} />;
  const go = async <T,>(p: Promise<any>, then: (v: T) => void) => {
    setBusy(true);
    const v = await run<T>(p);
    setBusy(false);
    if (v) then(v);
  };
  if (a.totpEnabled)
    return (
      <div className="acct-row-block">
        <div className="acct-row">
          <ShieldCheck size={16} className="hub-ok" />
          <span className="acct-row-main">
            <b>Two-step sign-in is on.</b> Signing in asks for a code from your authenticator app.
          </span>
          {step === 'idle' && !a.owner && (
            <button className="btn sm" onClick={() => setStep('off')}>
              Turn off
            </button>
          )}
        </div>
        {a.owner && <p className="muted acct-note">The Hub owner’s account keeps it on.</p>}
        {/* (Only with a Hub that has backup codes: it says how many are left.) */}
        {a.backupCodesLeft != null && step === 'idle' && (
          <div className="acct-row">
            <KeyRound size={16} />
            <span className="acct-row-main">
              <b>Backup codes:</b> {a.backupCodesLeft === 0 ? 'none left.' : `${a.backupCodesLeft} left.`} Each signs you in once if you lose your phone.
            </span>
            <button className="btn sm" onClick={() => setStep('regen')}>
              New backup codes
            </button>
          </div>
        )}
        {step === 'regen' && (
          <form
            className="acct-form acct-sub"
            onSubmit={(e) => (
              e.preventDefault(),
              go<{ backupCodes: string[] }>(api.hub.backupCodes({ password, code }), async (v) => {
                setCodes(v.backupCodes);
                setStep('codes');
                setPassword('');
                setCode('');
                const s = await api.hub.status();
                if (s.ok) setHubStatus(s.value);
              })
            )}
          >
            <p className="muted acct-note">New backup codes replace the old ones, which stop working.</p>
            <label>
              <span>Your password</span>
              <PasswordInput value={password} onChange={setPassword} autoFocus />
            </label>
            <label>
              <span>Code from your authenticator app</span>
              <CodeInput value={code} onChange={setCode} />
            </label>
            <div className="acct-actions">
              <button className="btn sm primary" type="submit" disabled={busy || !password || code.length !== 6}>
                Make new backup codes
              </button>
              <button className="btn sm" type="button" onClick={reset}>
                Cancel
              </button>
            </div>
          </form>
        )}
        {step === 'off' && (
          <form className="acct-form acct-sub" onSubmit={(e) => (e.preventDefault(), go<HubStatus>(api.hub.totpDisable({ password, code }), (s) => (setHubStatus(s), toast('Two-step sign-in is off.', 'success'), reset())))}>
            <label>
              <span>Your password</span>
              <PasswordInput value={password} onChange={setPassword} autoFocus />
            </label>
            <label>
              <span>Code from your authenticator app</span>
              <CodeInput value={code} onChange={setCode} />
            </label>
            <div className="acct-actions">
              <button className="btn sm danger" type="submit" disabled={busy || !password || code.length !== 6}>
                Turn off two-step sign-in
              </button>
              <button className="btn sm" type="button" onClick={reset}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    );
  return (
    <div className="acct-row-block">
      <div className="acct-row">
        <Smartphone size={16} />
        <span className="acct-row-main">
          <b>Two-step sign-in is off.</b> With it on, signing in also asks for a code from an app on your phone (Google Authenticator, Microsoft Authenticator, 1Password…).
        </span>
        {step === 'idle' && (
          <button className="btn sm" onClick={() => setStep('password')}>
            Turn on
          </button>
        )}
      </div>
      {step === 'password' && (
        <form className="acct-form acct-sub" onSubmit={(e) => (e.preventDefault(), go<{ secret: string; uri: string }>(api.hub.totpSetup({ password }), (v) => (setSetup(v), setStep('scan'))))}>
          <label>
            <span>Your password</span>
            <PasswordInput value={password} onChange={setPassword} autoFocus />
          </label>
          <div className="acct-actions">
            <button className="btn primary sm" type="submit" disabled={busy || !password}>
              Next
            </button>
            <button className="btn sm" type="button" onClick={reset}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {step === 'scan' && setup && (
        <form className="acct-form acct-sub" onSubmit={(e) => (e.preventDefault(), go<HubStatus & { backupCodes?: string[] }>(api.hub.totpEnable({ code }), ({ backupCodes, ...s }) => {
              setHubStatus(s);
              toast('Two-step sign-in is on.', 'success');
              // (A Hub with backup codes made ten: shown once, before anything else.)
              if (backupCodes?.length) (setCodes(backupCodes), setStep('codes'), setCode(''), setPassword(''), setSetup(null));
              else reset();
            }))}>
          <div className="acct-totp">
            <Qr text={setup.uri} />
            <div className="acct-totp-text">
              <p>1. In your authenticator app, add an account and scan this code.</p>
              <p className="muted acct-note">
                Can’t scan? Type this key instead: <code className="acct-secret">{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
              </p>
              <label>
                <span>2. Enter the 6-digit code it shows</span>
                <CodeInput value={code} onChange={setCode} autoFocus />
              </label>
            </div>
          </div>
          <div className="acct-actions">
            <button className="btn primary sm" type="submit" disabled={busy || code.length !== 6}>
              Turn on two-step sign-in
            </button>
            <button className="btn sm" type="button" onClick={reset}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

const when = (ms: number) => {
  const m = Math.round((Date.now() - ms) / 60_000);
  if (m < 2) return 'active now';
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};
/** "Kea/0.69.0" → "Kea 0.69.0"; nothing known → "Another device". */
const clientName = (c: string | null) => (c ? c.replace('/', ' ') : 'Another device');

function Devices() {
  const [list, setList] = useState<HubSession[] | null>(null);
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => api.hub.sessions().then((r) => r.ok && setList(r.value.sessions));
  useEffect(() => {
    load();
  }, []);
  if (!list) return null;
  const others = list.filter((s) => !s.current);
  return (
    <div className="acct-row-block">
      <div className="acct-row">
        <Monitor size={16} />
        <span className="acct-row-main">
          <b>Signed in on {list.length === 1 ? '1 device' : `${list.length} devices`}</b>
        </span>
        {others.length > 0 && !asking && (
          <button className="btn sm" onClick={() => setAsking(true)}>
            <LogOut size={13} /> Sign out everywhere else
          </button>
        )}
      </div>
      <ul className="acct-devices">
        {list.map((s) => (
          <li key={s.id}>
            <span>{clientName(s.client)}</span>
            <span className="muted">{s.current ? 'This computer' : when(s.lastSeen)}</span>
          </li>
        ))}
      </ul>
      {asking && (
        <form
          className="acct-form acct-sub"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            const r = await run(api.hub.signOutOthers({ password }));
            setBusy(false);
            if (r) {
              toast(r.signedOut === 1 ? 'Signed out 1 other device.' : `Signed out ${r.signedOut} other devices.`, 'success');
              setAsking(false);
              setPassword('');
              load();
            }
          }}
        >
          <label>
            <span>Your password</span>
            <PasswordInput value={password} onChange={setPassword} autoFocus />
          </label>
          <div className="acct-actions">
            <button className="btn primary sm" type="submit" disabled={busy || !password}>
              Sign out {others.length === 1 ? 'the other device' : `${others.length} other devices`}
            </button>
            <button className="btn sm" type="button" onClick={() => (setAsking(false), setPassword(''))}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/** Password, two-step sign-in and signed-in devices. */
export function SignInSecurity({ status }: { status: HubStatus }) {
  const [changing, setChanging] = useState(false);
  if (!status.me) return null;
  return (
    <section className="acct-section">
      <h3 className="hub-title">Sign-in and security</h3>
      <div className="acct-row-block">
        <div className="acct-row">
          <KeyRound size={16} />
          <span className="acct-row-main">
            <b>Password</b>
          </span>
          {!changing && (
            <button className="btn sm" onClick={() => setChanging(true)}>
              Change password
            </button>
          )}
        </div>
        {changing && <ChangePassword status={status} onDone={() => setChanging(false)} />}
      </div>
      <TwoStep status={status} />
      <Devices />
    </section>
  );
}

/** Downloading everything the Hub keeps about you, and deleting the account. */
export function YourData({ status }: { status: HubStatus }) {
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [typed, setTyped] = useState('');
  const a = status.me?.account;
  if (!a) return null;
  return (
    <section className="acct-section">
      <h3 className="hub-title">Your data</h3>
      <div className="acct-row-block">
        <div className="acct-row">
          <Download size={16} />
          <span className="acct-row-main">Everything your online Kea account keeps about you (account, classes, organizations, availability, shifts, files list, sign-ins) as one file.</span>
          <button
            className="btn sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const r = await api.hub.exportData();
              setBusy(false);
              if (!r.ok) toast(r.error, 'error');
              else if (r.value) toast('Your data is saved.', 'success');
            }}
          >
            Download my data
          </button>
        </div>
      </div>
      {!a.owner && (
        <div className="acct-row-block">
          <div className="acct-row">
            <Trash2 size={16} />
            <span className="acct-row-main">Delete your Kea account and everything the Hub keeps for it.</span>
            {!deleting && (
              <button className="btn sm danger" onClick={() => setDeleting(true)}>
                Delete my account
              </button>
            )}
          </div>
          {deleting && (
            <form
              className="acct-form acct-sub acct-danger"
              onSubmit={async (e) => {
                e.preventDefault();
                if ((await ask(`Delete ${a.email}?`, 'This can’t be undone. You leave every class and organization, and your Kea Cloud files are deleted. Documents saved on this computer stay.', [{ id: 'no', label: 'Keep my account' }, { id: 'yes', label: 'Delete it', danger: true, primary: true }])) !== 'yes') return;
                setBusy(true);
                const s = await run(api.hub.deleteAccount({ confirm: 'DELETE', password, code: a.totpEnabled ? code : undefined }));
                setBusy(false);
                if (s) (setHubStatus(s), toast('Your Kea account is deleted.', 'success'));
              }}
            >
              <p className="acct-note">
                <b>This can’t be undone.</b> Your classes, study progress, organization memberships, availability, Kea Cloud files and notifications are deleted from the Hub. If you’re the only owner of an organization or class that still has members, the Hub says so and nothing is deleted: make someone else an owner first. Download your data first if you want a copy.
              </p>
              <label>
                <span>Your password</span>
                <PasswordInput value={password} onChange={setPassword} autoFocus />
              </label>
              {a.totpEnabled && (
                <label>
                  <span>Code from your authenticator app</span>
                  <CodeInput value={code} onChange={setCode} />
                </label>
              )}
              <label>
                <span>Type DELETE to confirm</span>
                <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
              </label>
              <div className="acct-actions">
                <button className="btn sm danger" type="submit" disabled={busy || !password || typed !== 'DELETE' || (a.totpEnabled && code.length !== 6)}>
                  Delete my account
                </button>
                <button className="btn sm" type="button" onClick={() => (setDeleting(false), setPassword(''), setCode(''), setTyped(''))}>
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </section>
  );
}
