// The Kea account's state, shared by everything that shows it (the account page, the title bar, the gates, Work and
// School), and the one way to open the account page.
import { create } from 'zustand';
import { api, HubNotifications, HubResult, HubStatus } from '../../lib/api';
import { openSettings } from '../../lib/settings';
import { toast } from '../../store';

const useHub = create<{ status: HubStatus | null; set(s: HubStatus | null): void }>((set) => ({ status: null, set: (status) => set({ status }) }));
export const useHubStatus = () => useHub((s) => s.status);
export const setHubStatus = (s: HubStatus) => useHub.getState().set(s);
export const hubStatusNow = () => useHub.getState().status;
export function refreshHub() {
  return api.hub.status().then((r) => {
    if (r.ok) useHub.getState().set(r.value);
    return r;
  });
}

// Notifications for this account: kept here so the account page and the global listener agree.
const useNotes = create<{ notes: HubNotifications | null; set(n: HubNotifications | null): void }>((set) => ({ notes: null, set: (notes) => set({ notes }) }));
export const useHubNotifications = () => useNotes((s) => s.notes);
export const setHubNotifications = (n: HubNotifications | null) => useNotes.getState().set(n);
export function refreshNotifications() {
  return api.hub.notifications().then((r) => {
    if (r.ok) useNotes.getState().set(r.value);
    return r;
  });
}

/** The account page: Settings → Kea account, in every mode. */
export const openAccount = () => openSettings('account');

/** Shows a Hub error as a toast; returns the value or null. */
export async function run<T>(p: Promise<HubResult<T>>): Promise<T | null> {
  const r = await p;
  if (r.ok) return r.value;
  toast(r.error, 'error');
  return null;
}

/** The account's id, email and name, also while the Hub is offline (what Kea last saw). */
export function accountOf(s: HubStatus | null) {
  if (!s?.signedIn) return null;
  const a = s.me?.account;
  const c = s.cached;
  if (a) return { id: a.id, email: a.email, name: a.displayName, emailVerified: a.emailVerified, verifiedBy: a.verifiedBy, owner: a.owner, totpEnabled: a.totpEnabled };
  if (c) return { id: c.id ?? null, email: c.email, name: c.name, emailVerified: c.emailVerified, verifiedBy: c.verifiedBy ?? null, owner: !!c.owner, totpEnabled: !!c.totpEnabled };
  return null;
}
