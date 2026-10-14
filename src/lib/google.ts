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

/** Make sure Google sign-in is ready; returns false if the user chose not to continue. */
async function ensureSignedIn(name: string): Promise<boolean | 'browser'> {
  const st = await api.google.status();
  if (st.signedIn && st.configured) return true;
  const choice = await ask(
    'Open Google files in Slate',
    st.configured
      ? `To open “${name}” here, sign in to your Google account once. Slate downloads it, and saves your changes back to Google Drive so it stays a Google file.`
      : `Google Docs, Sheets and Slides live in Google's cloud. To open them in Slate, connect your Google account once. It takes about five minutes to set up, and Settings walks you through it.`,
    [
      { id: 'browser', label: 'Open in browser instead' },
      { id: 'cancel', label: 'Cancel' },
      { id: 'go', label: st.configured ? 'Sign in with Google' : 'Set it up', primary: true }
    ]
  );
  if (choice === 'browser') return 'browser';
  if (choice !== 'go') return false;
  if (!st.configured) {
    openSettings('google');
    return false;
  }
  try {
    toast('Finish signing in in your browser…');
    const who = await api.google.signIn();
    toast(`Signed in${who.email ? ` as ${who.email}` : ''}`, 'success');
    return true;
  } catch (err) {
    toast(cleanError(err), 'error');
    return false;
  }
}

/** Open a Google Drive for desktop shortcut (.gdoc/.gsheet/.gslides) as a real document in Slate. */
export async function openGoogleShortcut(localPath: string) {
  const name = localPath.split(/[\\/]/).pop()!.replace(/\.(gdoc|gsheet|gslides)$/i, '');
  if (setting('google.openWith') === 'browser') {
    api.openPath(localPath);
    return;
  }
  const ready = await ensureSignedIn(name);
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
    if (code === 'NO_ACCOUNT') {
      toast('Please sign in to Google again.', 'error');
      openSettings('google');
    } else if (code === 'NO_CLIENT') openSettings('google');
    else {
      const choice = await ask(`Couldn't open ${name}`, cleanError(err), [
        { id: 'cancel', label: 'Close' },
        { id: 'browser', label: 'Open in browser', primary: true }
      ]);
      if (choice === 'browser') api.openPath(localPath);
    }
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
