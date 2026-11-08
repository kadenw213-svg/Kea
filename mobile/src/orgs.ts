// Work on the phone (orgCore.ts does the work): the organization servers this Kea account joined, with their passes
// and sessions kept by native code in Android's encrypted storage (KeaPlugin org*, Orgs.java; this code never sees
// them), hosted organizations on the Kea account server through the account session (hub.ts), join links that
// opened Kea, the daily pass renewal while Kea is open, and the saved copy in app storage.
import { useEffect, useState } from 'react';
import { Kea } from './kea';
import { local, serverHealth, type AccountStatus } from './account';
import { hubCall, onAccountChange } from './hub';
import { HUB, OrgError, createOrgClient, hostedOrgsOn, type KeyValue } from './orgCore';

export { HUB, OrgError };
export { can, canAny, workAreas, joinLink, parseJoin } from './orgCore';
export type { WorkOrg, ServerView } from './orgCore';

const HOSTED = 'kea.work.hosted';
let acct: AccountStatus | null = null;

const store: KeyValue = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
  remove: (k) => {
    try {
      localStorage.removeItem(k);
    } catch {}
  }
};

export const work = createOrgClient({
  native: Kea,
  store,
  account: {
    key: () => acct?.account?.id ?? null,
    online: () => acct?.state === 'online',
    async hosted() {
      // (Offline: what the server said last time, so its organizations show from the saved copy.)
      const h = await serverHealth();
      if (h) store.set(HOSTED, hostedOrgsOn(h) ? '1' : '0');
      return store.get(HOSTED) === '1';
    },
    req: (method, path, body) => hubCall(method, path, body, { limit: 'auth' })
  }
});

/** The account as the phone knows it now (Work keys everything by it). */
export async function workAccount(): Promise<AccountStatus> {
  acct = await local();
  return acct;
}

/** Whether Work has anything to show: an account online or linked, or servers joined on this phone. */
export async function workReady(): Promise<{ account: AccountStatus; servers: number; usable: boolean }> {
  const a = await workAccount();
  const servers = a.account ? (await work.servers()).length : 0;
  return { account: a, servers, usable: a.state === 'online' || a.state === 'linked' || servers > 0 };
}

// ---------- the daily pass renewal (while Kea is open; quiet when nothing answers) ----------
let renewing: Promise<unknown> | null = null;
let lastRenew = 0;
export function renewSoon(force = false) {
  if (renewing || (!force && Date.now() - lastRenew < 3600e3)) return;
  lastRenew = Date.now();
  renewing = workAccount()
    .then(() => (acct?.account ? work.renew() : []))
    .catch(() => [])
    .finally(() => (renewing = null));
}
let hooked = false;
export function startRenewal() {
  if (hooked) return;
  hooked = true;
  renewSoon(true);
  setInterval(() => renewSoon(), 3600e3);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && renewSoon());
  onAccountChange(() => void workAccount().catch(() => {}));
}

// ---------- join links that opened Kea ----------
let pendingLink: string | null = null;
const linkListeners = new Set<(l: string) => void>();
let linksHooked = false;
/** Join links tapped anywhere on the phone: the latest one, until it's used (Work opens with it filled in). */
export function useJoinLink(): [string | null, () => void] {
  const [l, setL] = useState<string | null>(pendingLink);
  useEffect(() => {
    const fn = (x: string) => setL(x);
    linkListeners.add(fn);
    return () => void linkListeners.delete(fn);
  }, []);
  return [l, () => ((pendingLink = null), setL(null))];
}
/** Called once at start: a join link that opened Kea, and any that arrive while it's open. `open`: show Work. */
export function hookJoinLinks(open: () => void) {
  if (linksHooked) return;
  linksHooked = true;
  const got = (link?: string) => {
    if (!link) return;
    pendingLink = link;
    for (const fn of [...linkListeners]) fn(link);
    open();
  };
  Kea.takeJoin()
    .then((r) => got(r.link))
    .catch(() => {});
  Kea.addListener('join', (p) => got(p.link)).catch(() => {});
}
