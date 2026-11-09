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
/**
 * Who's signed in: first from this computer alone (at once, so nothing waits on the network), then after a background
 * check of the Kea account server (a few seconds at most). Not reaching the server is a normal answer.
 */
export function refreshHub() {
  if (!useHub.getState().status) loadLocal();
  return api.hub.status().then((r) => {
    if (r.ok) useHub.getState().set(r.value);
    return r;
  });
}
/** Only what this computer knows (instant). */
export function loadLocal() {
  return api.hub.local().then((r) => {
    // (A full status that arrived first is newer: kept.)
    if (r.ok && !useHub.getState().status) useHub.getState().set(r.value);
    return r;
  });
}
/** The account page's lock for cloud features: what's missing. The server not answering comes first. */
export function onlineNeed(s: HubStatus | null): 'none' | 'offline' | 'linked' | 'unreachable' | null {
  if (!s) return null;
  if (s.checked && !s.reachable) return 'unreachable';
  if (s.state === 'none' || s.state === 'offline' || s.state === 'linked') return s.state;
  return null;
}
/** Signing in waits for the Kea account server: checked, and not answering. */
export const signInWaits = (s: HubStatus | null) => !!s && s.checked && !s.reachable;
export const SIGN_IN_WAITS = 'Sign-in is available once Kea can reach the Kea account server.';
/** The provider "Sign in with Google" uses: Google, or Microsoft when only it is set up here. null: neither is. */
export const signInProvider = (s: HubStatus | null) => (s?.providers.google ? 'google' : s?.providers.microsoft ? 'microsoft' : null);

/**
 * Sign in with Google with no account here yet (the title bar, a locked cloud feature): one sign-in makes the account
 * or signs in to it. When it needs one more step (the terms for a new account, the owner's code), or this copy of Kea
 * has no sign-in set up, or an account is already here (linking checks its email), the account page opens instead.
 */
export async function signInWithGoogle() {
  const s = useHub.getState().status;
  if (signInWaits(s)) {
    toast(`${SIGN_IN_WAITS} Kea tries again by itself.`, 'info');
    refreshHub();
    return;
  }
  const provider = signInProvider(s);
  if (!provider || !s || s.state !== 'none') return openAccount();
  const r = await api.hub.oauthSignIn({ provider });
  if (r.ok) {
    useHub.getState().set(r.value);
    toast('Signed in to your Kea account.', 'success');
    return;
  }
  if (r.data?.needsAccount || r.data?.totpRequired) {
    await refreshHub();
    return openAccount();
  }
  if (r.status === 0) refreshHub();
  toast(r.error, r.status === 0 ? 'info' : 'error');
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

/** The account's id, email and name, also while the server is offline (what Kea last saw), or made on this computer. */
export function accountOf(s: HubStatus | null) {
  if (!s) return null;
  if (!s.signedIn) return s.account ? { id: s.account.id, email: s.account.email, name: s.account.name, emailVerified: false, verifiedBy: null, owner: false, totpEnabled: false } : null;
  const a = s.me?.account;
  const c = s.cached;
  if (a) return { id: a.id, email: a.email, name: a.displayName, emailVerified: a.emailVerified, verifiedBy: a.verifiedBy, owner: a.owner, totpEnabled: a.totpEnabled };
  if (c) return { id: c.id ?? null, email: c.email, name: c.name, emailVerified: c.emailVerified, verifiedBy: c.verifiedBy ?? null, owner: !!c.owner, totpEnabled: !!c.totpEnabled };
  return null;
}
