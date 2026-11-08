// What Kea shows about updates, from what the updater says (electron/main.cjs sends each state). Kept free of React and
// of the app's bridge, for the tests.
import type { UpdateState } from './api';

/** Something to install or on its way: these always show, whoever started the check. */
const PENDING = new Set(['available', 'downloading', 'ready']);

/**
 * The state to show after the updater says `incoming`. `asked`: the person pressed Check for updates and is waiting
 * for the answer. A check Kea runs by itself only shows when it finds something: its "up to date" or "couldn't
 * reach GitHub" stays out of the way. A downloaded update stays "ready" until Kea restarts, even if a later check
 * finds the same version again.
 */
export function nextUpdateState(prev: UpdateState, incoming: UpdateState, asked: boolean): { state: UpdateState; asked: boolean } {
  if (prev.status === 'ready' && (incoming.status === 'available' || incoming.status === 'downloading' || incoming.status === 'checking') && (!incoming.version || incoming.version === prev.version))
    return { state: prev, asked: false };
  if (PENDING.has(incoming.status)) return { state: incoming, asked: false };
  // (A download that failed on its own doesn't leave "Updating 40%" up: Kea tries again with its next check.)
  if (!asked) return { state: incoming.status === 'error' && prev.status === 'downloading' ? { status: 'idle' } : prev, asked: false };
  // (Still waiting while it checks; any other answer is the answer.)
  return { state: incoming, asked: incoming.status === 'checking' };
}

export interface UpdateIndicator {
  kind: 'ready' | 'downloading' | 'available';
  label: string;
  title: string;
}

/** The title bar's indicator: an update downloaded and waiting, on its way, or found (and not downloading by itself). */
export function updateIndicator(s: UpdateState): UpdateIndicator | null {
  const v = s.version ? ` ${s.version}` : '';
  switch (s.status) {
    case 'ready':
      return { kind: 'ready', label: 'Restart to update', title: `Kea${v} is downloaded. Restart Kea to finish updating (you can save your work first).` };
    case 'downloading':
      return { kind: 'downloading', label: `Updating ${Math.max(0, Math.min(100, Math.round(s.percent || 0)))}%`, title: `Downloading Kea${v}. Keep working; Kea tells you when it’s ready.` };
    case 'available':
      return { kind: 'available', label: 'Update available', title: `Kea${v} is out. Click to download it.` };
    default:
      return null;
  }
}

/** The answer to a check the person asked for, in a few words. */
export function updateHeadline(s: UpdateState): string {
  switch (s.status) {
    case 'checking':
      return 'Checking for updates…';
    case 'latest':
      return 'Kea is up to date';
    case 'available':
      return s.version ? `Kea ${s.version} is available` : 'An update is available';
    case 'downloading':
      return 'Downloading the update…';
    case 'ready':
      return 'Restart to update';
    case 'error':
      return 'Couldn’t check for updates';
    case 'manual':
      return 'This copy of Kea can’t update itself';
    case 'dev':
      return 'Updates work in the installed app';
    default:
      return 'Check for updates';
  }
}
