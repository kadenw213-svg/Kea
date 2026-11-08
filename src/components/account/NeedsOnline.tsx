// Cloud features (Kea cloud, hosted classes and organizations, Kea's shared Claude, Work) while the account isn't
// online: a calm "Needs your Kea account online" in their place, with the one thing to do about it. Never an error.
import { CloudOff } from 'lucide-react';
import { onlineNeed, openAccount, useHubStatus } from './hubStore';

export function NeedsOnline({ what, compact = false, onOpen }: { what?: string; compact?: boolean; onOpen?(): void }) {
  const s = useHubStatus();
  const need = onlineNeed(s);
  const text =
    need === 'linked'
      ? 'Sign in online to use it.'
      : need === 'unreachable'
        ? 'Kea can’t reach it right now, and tries again by itself.'
        : 'Take your account online with Google or Microsoft to use it. Everything on this computer works without it.';
  return (
    <div className={`needs-online ${compact ? 'compact' : ''}`}>
      <CloudOff size={16} />
      <div className="needs-online-text">
        <b>Needs your Kea account online</b>
        <span className="muted">
          {what ? `${what}. ` : ''}
          {text}
        </span>
      </div>
      {need !== 'unreachable' && (
        <button className="btn sm" onClick={() => (onOpen ? onOpen() : openAccount())}>
          {need === 'linked' ? 'Sign in online' : 'Go online'}
        </button>
      )}
    </div>
  );
}
