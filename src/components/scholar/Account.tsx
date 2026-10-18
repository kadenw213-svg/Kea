import { useEffect, useState } from 'react';
import { BadgeCheck, Camera, LogOut, ShieldAlert, Trash2 } from 'lucide-react';
import { create } from 'zustand';
import { api, KeaAccount } from '../../lib/api';
import { toast, ask } from '../../store';

// The account, shared by every view that shows it (loaded once, refreshed after a change).
const useAccountStore = create<{ account: KeaAccount | null | undefined; set(a: KeaAccount | null): void }>((set) => ({ account: undefined, set: (account) => set({ account }) }));
let loading = false;
export function useAccount() {
  const { account, set } = useAccountStore();
  useEffect(() => {
    if (account !== undefined || loading) return;
    loading = true;
    api.account
      .get()
      .then(set)
      .catch(() => set(null))
      .finally(() => (loading = false));
  }, [account]);
  return [account, set] as const;
}

/** The verified mark beside a name; Kea's creator gets their own. */
export function VerifiedBadge({ account, size = 15 }: { account: KeaAccount | null | undefined; size?: number }) {
  if (!account?.verified) return null;
  return (
    <span className={`acct-badge ${account.owner ? 'owner' : ''}`} title={account.owner ? 'Verified · Kea’s creator' : `Verified through ${account.verifiedBy}`}>
      <BadgeCheck size={size} />
    </span>
  );
}

/** A round picture, or the first letter of the name. */
export function Avatar({ account, size = 28 }: { account: KeaAccount | null | undefined; size?: number }) {
  const letter = (account?.name || account?.email || 'K')[0].toUpperCase();
  return account?.avatar ? (
    <img className="acct-avatar" src={account.avatar} alt="" style={{ width: size, height: size }} />
  ) : (
    <span className="acct-avatar letter" style={{ width: size, height: size, fontSize: size * 0.45 }}>
      {letter}
    </span>
  );
}

/** Setting up or editing the account: email, name, picture, and verifying the email against this computer's sign-ins. */
export function AccountCard({ onVerified }: { onVerified?(): void }) {
  const [account, setAccount] = useAccount();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [suggest, setSuggest] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    api.account.suggest().then(setSuggest).catch(() => {});
  }, []);
  useEffect(() => {
    if (account) (setEmail(account.email), setName(account.name));
  }, [account]);

  const act = async (fn: () => Promise<KeaAccount | null>, ok?: string) => {
    setBusy(true);
    try {
      const a = await fn();
      setAccount(a);
      if (a?.verified) {
        if (ok) toast(ok, 'success');
        onVerified?.();
      }
      return a;
    } catch (err: any) {
      toast(String(err?.message || err), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (account === undefined) return null;
  if (!account || editing)
    return (
      <div className="acct-card">
        <div className="acct-form">
          <label>
            <span>Email</span>
            <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" type="email" autoFocus />
          </label>
          {suggest.length > 0 && (
            <div className="acct-suggest">
              <span className="muted">Signed in on this computer:</span>
              {suggest.map((s) => (
                <button key={s} className={`chip ${s === email ? 'on' : ''}`} onClick={() => setEmail(s)}>
                  {s}
                </button>
              ))}
            </div>
          )}
          <label>
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="What Kea calls you" />
          </label>
          <p className="muted acct-note">
            Your email is verified by matching an account already signed in on this computer: the Claude account Kea uses, OneDrive or Google. It stays on this computer.
          </p>
          <div className="acct-actions">
            <button
              className="btn primary"
              disabled={busy || !email.trim()}
              onClick={async () => {
                const a = await act(() => api.account.save({ email, name }), 'Your account is set up and verified.');
                if (a) setEditing(false);
                if (a && !a.verified) toast(`Saved, but ${a.email} isn't signed in on this computer yet, so it isn't verified.`, 'error');
              }}
            >
              Save and verify
            </button>
            {account && (
              <button className="btn" onClick={() => setEditing(false)}>
                Cancel
              </button>
            )}
          </div>
        </div>
      </div>
    );

  return (
    <div className="acct-card">
      <div className="acct-head">
        <button className="acct-pic" onClick={() => act(() => api.account.avatar())} title="Change your picture" disabled={busy}>
          <Avatar account={account} size={64} />
          <span className="acct-pic-cam">
            <Camera size={14} />
          </span>
        </button>
        <div className="acct-who">
          <div className="acct-name">
            {account.name || account.email.split('@')[0]} <VerifiedBadge account={account} size={18} />
          </div>
          <div className="muted">{account.email}</div>
          <div className={`acct-status ${account.verified ? 'ok' : 'bad'}`}>
            {account.verified ? (
              account.owner ? (
                'Verified · Kea’s creator'
              ) : (
                `Verified through ${account.verifiedBy}`
              )
            ) : (
              <>
                <ShieldAlert size={13} /> Not verified: school mode stays off until it is
              </>
            )}
          </div>
        </div>
      </div>
      <div className="acct-actions">
        {!account.verified && (
          <button className="btn primary sm" disabled={busy} onClick={() => act(() => api.account.verify(), 'Verified.')}>
            <BadgeCheck size={14} /> Verify
          </button>
        )}
        <button className="btn sm" onClick={() => setEditing(true)}>
          Edit
        </button>
        {account.avatar && (
          <button className="btn sm" disabled={busy} onClick={() => act(() => api.account.avatar(true))}>
            <Trash2 size={13} /> Remove picture
          </button>
        )}
        <button
          className="btn sm"
          onClick={async () => {
            if ((await ask('Sign out of your Kea account?', 'School mode stops scanning until you sign in again. Your classes stay on this computer.', [{ id: 'cancel', label: 'Cancel' }, { id: 'out', label: 'Sign out', primary: true }])) !== 'out') return;
            await api.account.signOut();
            setAccount(null);
          }}
        >
          <LogOut size={13} /> Sign out
        </button>
      </div>
    </div>
  );
}
