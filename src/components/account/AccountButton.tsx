// The account in the title bar, in every mode: your picture, and a menu with who's signed in, the account page,
// notifications, checking for updates and signing out. With no account yet, a quiet "Sign in with Google" instead.
import { Bell, LogIn, LogOut, RefreshCw, UserCircle } from 'lucide-react';
import { installNow, openUpdates, useUpdates } from '../Updates';
import { MenuButton } from '../Popover';
import { Avatar, VerifiedBadge, useAccount } from '../scholar/Account';
import { signOutAsked } from '../scholar/HubAccount';
import { SIGN_IN_WAITS, openAccount, signInWaits, signInWithGoogle, useHubNotifications, useHubStatus } from './hubStore';

export function AccountButton() {
  const status = useHubStatus();
  const [account] = useAccount();
  const notes = useHubNotifications();
  const update = useUpdates((s) => s.state.status);
  if (status && status.state === 'none') {
    const waits = signInWaits(status);
    return (
      <button className={`btn sm acct-tb-signin ${waits ? 'waits' : ''}`} title={waits ? `${SIGN_IN_WAITS} Kea tries again by itself.` : 'Sign in with Google to use Kea cloud, classes and organizations. Everything on this computer works without it.'} onClick={() => signInWithGoogle()}>
        <LogIn size={14} /> Sign in with Google
      </button>
    );
  }
  if (!status?.account || !account) return null;
  const unread = notes?.unread ?? status.me?.notifications?.unread ?? 0;
  return (
    <MenuButton
      title={`${account.name || account.email} · Your Kea account`}
      align="right"
      button={() => (
        <button className="icon-btn sm acct-tb" aria-label="Your Kea account">
          <Avatar account={account} size={24} />
          {unread > 0 && <span className="update-dot" />}
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="menu-title acct-tb-who">
            <span className="acct-tb-name">
              {account.name || account.email} <VerifiedBadge account={account} size={13} />
            </span>
            <span className="muted">{account.email}</span>
            {status.state === 'online' ? !account.verified && <span className="acct-tb-warn">Email not verified</span> : <span className="muted">{status.state === 'offline' ? 'On this computer only' : 'Not signed in online right now'}</span>}
          </div>
          <button className="menu-item" onClick={() => (close(), openAccount())}>
            <UserCircle size={16} /> Your account
          </button>
          <button className="menu-item" onClick={() => (close(), openAccount())}>
            <Bell size={16} /> Notifications {unread > 0 && <span className="kbd" style={{ color: 'var(--accent)' }}>{unread}</span>}
          </button>
          <button className="menu-item" onClick={() => (close(), update === 'ready' ? installNow() : openUpdates())}>
            <RefreshCw size={16} /> {update === 'ready' ? 'Restart to update' : update === 'available' || update === 'downloading' ? 'Update available' : 'Check for updates'}
          </button>
          <div className="menu-sep" />
          <button className="menu-item" onClick={() => (close(), signOutAsked())}>
            <LogOut size={16} /> Sign out
          </button>
        </>
      )}
    </MenuButton>
  );
}
