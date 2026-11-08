// Cloud features (classes through the Kea account, Kea storage, notifications) while the account isn't online: a calm
// "Needs your Kea account online" in their place, with the one thing to do about it. Never an error. The same words
// as Kea on the computer (src/components/account/NeedsOnline.tsx).
import { useEffect, useState } from 'react';
import { CloudOff } from 'lucide-react';
import { needsOnlineText, onlineNeed } from './accountCore';
import { local, status, type AccountStatus } from './account';
import { onAccountChange } from './hub';

/** The account's state on this phone, kept current (from the phone at once, then a short check of the server). */
export function useAccount(): [AccountStatus | null, (s: AccountStatus) => void] {
  const [s, setS] = useState<AccountStatus | null>(null);
  useEffect(() => {
    let live = true;
    const set = (x: AccountStatus) => live && setS(x);
    local().then(set, () => {});
    status().then(set, () => {});
    const off = onAccountChange(() => void local().then(set, () => {}));
    return () => {
      live = false;
      off();
    };
  }, []);
  return [s, setS];
}

export function NeedsOnline({ status: s, what, compact = false, onOpen }: { status: AccountStatus | null; what?: string; compact?: boolean; onOpen?(): void }) {
  const need = onlineNeed(s);
  if (!need) return null;
  const t = needsOnlineText(need, s?.onlineNote ?? null);
  return (
    <div className={`needs-online ${compact ? 'compact' : ''}`}>
      <CloudOff size={16} />
      <div className="needs-online-text">
        <b>{t.title}</b>
        <span className="muted small">
          {what ? `${what}. ` : ''}
          {t.text}
        </span>
      </div>
      {t.action && onOpen && (
        <button className="btn small-btn" onClick={onOpen}>
          {t.action}
        </button>
      )}
    </div>
  );
}
