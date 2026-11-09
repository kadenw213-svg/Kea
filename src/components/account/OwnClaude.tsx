// "Use my own Claude": one switch, shown wherever Kea's shared Claude is offered (and in Settings → Claude Assistant).
// On, Kea uses only the Claude on this PC and never asks Kea's shared Claude (electron/scholar/claudeRoute.cjs).
import { OWN_CLAUDE_WHY, useSetting, useSettings } from '../../lib/settings';

export function OwnClaudeSwitch({ className = '' }: { className?: string }) {
  const on = !!useSetting<boolean>('claude.ownOnly');
  return (
    <label className={`own-claude ${className}`.trim()}>
      <input type="checkbox" checked={on} onChange={(e) => useSettings.getState().set({ 'claude.ownOnly': e.target.checked })} />
      <span>
        <b>Use my own Claude</b> <span className="muted">{OWN_CLAUDE_WHY}</span>
      </span>
    </label>
  );
}

/** Whether "Use my own Claude" is on (Kea's shared Claude is never used). */
export const useOwnClaudeOnly = () => !!useSetting<boolean>('claude.ownOnly');
