// Cloud features (Kea cloud, hosted classes and organizations, Kea's shared Claude, Work) while there's no account
// online: a calm "Needs your Kea account" in their place, with the one thing to do about it. Never an error.
//   no account, or one not signed in online: "Sign in with Google to use this.";
//   the Kea account server not answering: "Can't reach the Kea account server right now." (Kea tries again by itself).
import { CloudOff } from 'lucide-react';
import { onlineNeed, openAccount, signInWithGoogle, useHubStatus } from './hubStore';

export function NeedsOnline({ what, compact = false, onOpen }: { what?: string; compact?: boolean; onOpen?(): void }) {
  const s = useHubStatus();
  // (Signed in online but not checked yet: the same as not answering, briefly.)
  const need = onlineNeed(s) ?? (s?.signedIn ? 'unreachable' : 'none');
  const text = need === 'unreachable' ? 'Can’t reach the Kea account server right now. Kea tries again by itself.' : 'Sign in with Google to use this.';
  // (With no account, one Google sign-in makes it or signs in; an account here goes online from the account page,
  // where a different email is caught.)
  const go = () => (need === 'none' ? signInWithGoogle() : onOpen ? onOpen() : openAccount());
  return (
    <div className={`needs-online ${compact ? 'compact' : ''}`}>
      <CloudOff size={16} />
      <div className="needs-online-text">
        <b>Needs your Kea account</b>
        <span className="muted">
          {what ? `${what}. ` : ''}
          {text}
        </span>
      </div>
      {need !== 'unreachable' && (
        <button className="btn sm" onClick={go}>
          Sign in with Google
        </button>
      )}
    </div>
  );
}
