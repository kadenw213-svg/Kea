import { api } from './api';
import { useTabs, toast, ask } from '../store';
import { setting, openSettings } from './settings';
import { extOf } from './fileTypes';

export const GOOGLE_EXTS = new Set(['gdoc', 'gsheet', 'gslides']);
export const isGoogleShortcut = (p: string) => GOOGLE_EXTS.has(extOf(p));

const cleanError = (err: any) =>
  String(err?.message || err)
    .replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    .replace(/^\[[A-Z_]+\] /, '');
const codeOf = (err: any) => /\[([A-Z_]+)\]/.exec(String(err?.message || ''))?.[1];

/**
 * Asks Google once for access to Drive, in the browser, with Kea's built-in client (the Google account the person
 * signed in to Kea with comes first). 'ok', 'refused' (Google said no: Kea isn't reviewed for Drive yet, so only its
 * test users get through), or 'failed' (said in a toast).
 */
export async function connectDrive(): Promise<'ok' | 'refused' | 'failed'> {
  try {
    toast('Finish in your browser…');
    const who = await api.google.signIn();
    toast(`Google Drive connected${who.email ? ` as ${who.email}` : ''}.`, 'success');
    return 'ok';
  } catch (err) {
    if (codeOf(err) === 'REFUSED') return 'refused';
    toast(cleanError(err), 'error');
    return 'failed';
  }
}

/** Google said no: plainly, with the browser one click away. */
async function refusedAsk(name: string, localPath: string) {
  const choice = await ask('Google didn’t allow it yet', `Kea can’t open “${name}” from your Drive right now. It opens in your browser instead.`, [
    { id: 'cancel', label: 'Close' },
    { id: 'browser', label: 'Open in browser instead', primary: true }
  ]);
  if (choice === 'browser') api.openPath(localPath);
}

/** Make sure Drive is connected; 'browser' when the person picked that (or Drive isn't available here). */
async function ensureConnected(name: string, localPath: string): Promise<boolean | 'browser'> {
  const st = await api.google.status();
  if (st.signedIn && st.configured) return true;
  // (No built-in Google client in this copy of Kea: the browser, without a question.)
  if (!st.configured) return 'browser';
  const choice = await ask('Open in Kea?', `“${name}” is in your Google Drive. Kea asks Google once for access, then it opens here and saves back to Drive.`, [
    { id: 'browser', label: 'Open in browser instead' },
    { id: 'cancel', label: 'Cancel' },
    { id: 'go', label: 'Connect Google Drive', primary: true }
  ]);
  if (choice === 'browser') return 'browser';
  if (choice !== 'go') return false;
  const r = await connectDrive();
  if (r === 'refused') await refusedAsk(name, localPath);
  return r === 'ok';
}

/** Open a Google Drive for desktop shortcut (.gdoc/.gsheet/.gslides) as a real document in Kea. */
export async function openGoogleShortcut(localPath: string) {
  const name = localPath.split(/[\\/]/).pop()!.replace(/\.(gdoc|gsheet|gslides)$/i, '');
  if (setting('google.openWith') === 'browser') {
    api.openPath(localPath);
    return;
  }
  const ready = await ensureConnected(name, localPath);
  if (ready === 'browser') return void api.openPath(localPath);
  if (!ready) return;
  const existing = useTabs.getState().tabs.find((t) => t.remote?.localPath.toLowerCase() === localPath.toLowerCase());
  if (existing) return useTabs.getState().setActive(existing.id);
  toast(`Opening ${name} from Google Drive…`);
  try {
    const f = await api.google.open(localPath);
    useTabs.getState().addTab({
      kind: f.kind,
      name: `${f.name}.${f.ext}`,
      path: null,
      data: f.data,
      remote: { provider: 'google', id: f.id, ext: f.ext, localPath, canEdit: f.canEdit }
    });
    api.addRecent(localPath);
    if (!f.canEdit) toast("You can only view this file in Google Drive, so changes will be saved as a copy on this PC.");
  } catch (err) {
    const code = codeOf(err);
    if (code === 'NO_CLIENT') return void api.openPath(localPath);
    if (code === 'NO_ACCOUNT') {
      toast('Connect Google Drive again.', 'error');
      openSettings('google');
      return;
    }
    if (code === 'REFUSED') return refusedAsk(name, localPath);
    const choice = await ask(`Couldn't open ${name}`, cleanError(err), [
      { id: 'cancel', label: 'Close' },
      { id: 'browser', label: 'Open in browser instead', primary: true }
    ]);
    if (choice === 'browser') api.openPath(localPath);
  }
}

/** Upload a tab's contents back to Google Drive. */
export async function saveToGoogle(tabId: string, data: Uint8Array) {
  const t = useTabs.getState().tabs.find((x) => x.id === tabId);
  if (!t?.remote) throw new Error('Not a Google file');
  try {
    await api.google.save(t.remote.id, t.remote.ext, data);
  } catch (err) {
    throw new Error(cleanError(err));
  }
}
