// The account page's "Sign-in and security" and "Your data": how the account signs in, signed-in devices, the data
// download and deleting the account. There are no Kea passwords: signing out other devices and deleting the account ask
// for a fresh Google or Microsoft sign-in with the account's email, which the Kea account server checks.
import { useEffect, useState } from 'react';
import { Download, LogOut, Monitor, ShieldCheck, Trash2 } from 'lucide-react';
import { api, HubSession, HubStatus, KeaSignInProvider } from '../../lib/api';
import { ask, toast } from '../../store';
import { run, setHubStatus } from './hubStore';

/** Which of Google or Microsoft confirms it's you: the one the account signs in with, when this copy of Kea has it. */
export function proofProvider(status: HubStatus): KeaSignInProvider | null {
  const by = String(status.account?.provider || status.me?.account.verifiedBy || status.cached?.verifiedBy || '').toLowerCase();
  if (by === 'microsoft' && status.providers.microsoft) return 'microsoft';
  if (status.providers.google) return 'google';
  return status.providers.microsoft ? 'microsoft' : null;
}
const label = (p: KeaSignInProvider) => (p === 'microsoft' ? 'Microsoft' : 'Google');

const when = (ms: number) => {
  const m = Math.round((Date.now() - ms) / 60_000);
  if (m < 2) return 'active now';
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};
/** "Kea/0.69.0" → "Kea 0.69.0"; nothing known → "Another device". */
const clientName = (c: string | null) => (c ? c.replace('/', ' ') : 'Another device');

function Devices({ status }: { status: HubStatus }) {
  const [list, setList] = useState<HubSession[] | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.hub.sessions().then((r) => r.ok && setList(r.value.sessions));
  useEffect(() => {
    load();
  }, []);
  if (!list) return null;
  const others = list.filter((s) => !s.current);
  const p = proofProvider(status);
  return (
    <div className="acct-row-block">
      <div className="acct-row">
        <Monitor size={16} />
        <span className="acct-row-main">
          <b>Signed in on {list.length === 1 ? '1 device' : `${list.length} devices`}</b>
        </span>
        {others.length > 0 && p && (
          <button
            className="btn sm"
            disabled={busy}
            title={`Asks you to continue with ${label(p)} first`}
            onClick={async () => {
              setBusy(true);
              const r = await run(api.hub.signOutOthers({ provider: p }));
              setBusy(false);
              if (r) {
                toast(r.signedOut === 1 ? 'Signed out 1 other device.' : `Signed out ${r.signedOut} other devices.`, 'success');
                load();
              }
            }}
          >
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
    </div>
  );
}

/** How the account signs in, and signed-in devices. */
export function SignInSecurity({ status }: { status: HubStatus }) {
  const a = status.me?.account;
  if (!a) return null;
  const by = String(status.account?.provider || a.verifiedBy || '').toLowerCase() === 'microsoft' ? 'Microsoft' : 'Google';
  return (
    <section className="acct-section">
      <h3 className="hub-title">Sign-in and security</h3>
      <div className="acct-row-block">
        <div className="acct-row">
          <ShieldCheck size={16} className="hub-ok" />
          <span className="acct-row-main">
            <b>You sign in with {by}</b> <span className="muted">as {a.email}. Kea has no password to remember.</span>
          </span>
        </div>
        {a.owner && a.totpEnabled && <p className="muted acct-note">The owner account also asks for its two-step code when it signs in.</p>}
      </div>
      <Devices status={status} />
    </section>
  );
}

/** Downloading everything the Hub keeps about you, and deleting the account. */
export function YourData({ status }: { status: HubStatus }) {
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [typed, setTyped] = useState('');
  const a = status.me?.account;
  if (!a) return null;
  const p = proofProvider(status);
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
      {!a.owner && p && (
        <div className="acct-row-block">
          <div className="acct-row">
            <Trash2 size={16} />
            <span className="acct-row-main">Delete your Kea account and everything Kea keeps online for it.</span>
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
                if ((await ask(`Delete ${a.email}?`, 'This can’t be undone. You leave every class and organization, and your Kea cloud files are deleted. Documents saved on this computer stay.', [{ id: 'no', label: 'Keep my account' }, { id: 'yes', label: 'Delete it', danger: true, primary: true }])) !== 'yes') return;
                setBusy(true);
                const s = await run(api.hub.deleteAccount({ confirm: 'DELETE', provider: p }));
                setBusy(false);
                if (s) (setHubStatus(s), toast('Your Kea account is deleted.', 'success'));
              }}
            >
              <p className="acct-note">
                <b>This can’t be undone.</b> Your classes, study progress, organization memberships, availability, Kea cloud files and notifications are deleted online. If you’re the only owner of an organization or class that still has members, Kea says so and nothing is deleted: make someone else an owner first. Download your data first if you want a copy.
              </p>
              <label>
                <span>Type DELETE to confirm</span>
                <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
              </label>
              <div className="acct-actions">
                <button className="btn sm danger" type="submit" disabled={busy || typed !== 'DELETE'}>
                  Continue with {label(p)} and delete
                </button>
                <button className="btn sm" type="button" onClick={() => (setDeleting(false), setTyped(''))}>
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
