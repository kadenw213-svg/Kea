// What Kea shows about updates, from what the updater says (electron/main.cjs sends each state). Kept free of React and
// of the app's bridge, for the tests.
import type { UpdateHealth, UpdateState } from './api';

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
  kind: 'ready' | 'downloading' | 'available' | 'required' | 'stale';
  label: string;
  title: string;
}

/** When Kea says it isn't keeping up: checks failing this many times in a row and for this long, or an update waiting this long. */
export const STALE = { failures: 3, failingMs: 2 * 864e5, waitingMs: 3 * 864e5 };

/** "3 days" / "5 hours" / "a few minutes". */
export function ago(ms: number): string {
  const h = Math.floor(ms / 36e5);
  if (h >= 48) return `${Math.floor(h / 24)} days`;
  if (h >= 1) return h === 1 ? 'an hour' : `${h} hours`;
  return 'a few minutes';
}

/** A time for "Last checked …": today's time, or the date. */
export function when(at: number | null | undefined, now = Date.now()): string {
  if (!at) return 'never';
  const d = new Date(at);
  const today = new Date(now).toDateString() === d.toDateString();
  return today ? `today at ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * What Kea says about staying up to date when nothing is on its way: a server turned it away as too old (it must
 * update), its own checks keep failing, an update has waited too long, or a server knows of a newer Kea that Kea's own
 * check didn't find (GitHub can't be reached from here). null: all fine.
 */
export function staleness(h: UpdateHealth | null | undefined, now = Date.now()): (UpdateIndicator & { detail: string }) | null {
  if (!h) return null;
  if (h.tooOld) {
    const min = h.tooOld.minVersion ? ` (it needs ${h.tooOld.minVersion} or newer; this is ${h.version})` : '';
    return { kind: 'required', label: 'Update Kea', title: h.tooOld.error, detail: `${h.tooOld.error}${min}` };
  }
  const waiting = h.downloaded || h.available;
  if (waiting && now - waiting.at > STALE.waitingMs) {
    const how = h.downloaded ? 'is downloaded and waiting for Kea to restart' : 'is out and hasn’t been downloaded';
    return { kind: 'stale', label: 'Update waiting', title: `Kea ${waiting.version} ${how} (${ago(now - waiting.at)}).`, detail: `Kea ${waiting.version} ${how} for ${ago(now - waiting.at)}. This is ${h.version}.` };
  }
  const lastGood = h.lastOkAt ?? 0;
  if (h.failures >= STALE.failures && now - lastGood > STALE.failingMs) {
    const since = h.lastOkAt ? `since ${when(h.lastOkAt, now)}` : 'yet';
    return { kind: 'stale', label: 'Can’t check for updates', title: `Kea hasn’t been able to check for updates ${since}: ${h.lastError || 'the update feed didn’t answer'}`, detail: `Kea hasn’t been able to check for updates ${since} (${h.failures} tries in a row). Last problem: ${h.lastError || 'the update feed didn’t answer'}` };
  }
  if (h.latest) {
    const by = h.latest.from === 'account' ? 'your Kea account server' : 'your organization’s server';
    return { kind: 'available', label: 'Update available', title: `Kea ${h.latest.version} is out (${by} says so). Click to update.`, detail: `Kea ${h.latest.version} is out, ${by} says. This is ${h.version}.` };
  }
  return null;
}

/**
 * The title bar's indicator: Kea must update to keep using a server, an update downloaded and waiting, on its way, or
 * found (and not downloading by itself); otherwise what `staleness` says about the health (checks failing, an update
 * waiting too long, a newer Kea a server knows of).
 */
export function updateIndicator(s: UpdateState, health?: UpdateHealth | null, now = Date.now()): UpdateIndicator | null {
  const st = staleness(health, now);
  if (st?.kind === 'required') return st;
  const own = ownIndicator(s);
  if (own) return own.kind === 'ready' && st?.kind === 'stale' && health?.downloaded ? { ...own, title: st.title } : own;
  return st;
}
function ownIndicator(s: UpdateState): UpdateIndicator | null {
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
