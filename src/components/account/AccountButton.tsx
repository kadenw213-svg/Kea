// The account in the title bar, in every mode: your picture, and a menu with who's signed in, the account page,
// notifications and signing out.
import { Bell, LogOut, UserCircle } from 'lucide-react';
import { MenuButton } from '../Popover';
import { Avatar, VerifiedBadge, useAccount } from '../scholar/Account';
import { signOutAsked } from '../scholar/HubAccount';
import { openAccount, useHubNotifications, useHubStatus } from './hubStore';

export function AccountButton() {
  const status = useHubStatus();
  const [account] = useAccount();
  const notes = useHubNotifications();
  if (!status?.signedIn || !account) return null;
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
            {!account.verified && <span className="acct-tb-warn">Email not verified</span>}
          </div>
          <button className="menu-item" onClick={() => (close(), openAccount())}>
            <UserCircle size={16} /> Your account
          </button>
          <button className="menu-item" onClick={() => (close(), openAccount())}>
            <Bell size={16} /> Notifications {unread > 0 && <span className="kbd" style={{ color: 'var(--accent)' }}>{unread}</span>}
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
