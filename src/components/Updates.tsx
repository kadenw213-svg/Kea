import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { Download, RefreshCw, CheckCircle2, AlertCircle, Sparkles, X } from 'lucide-react';
import { api, UpdateState } from '../lib/api';
import { useTabs } from '../store';
import { requestCloseTab } from '../lib/closing';
import { setting } from '../lib/settings';

interface UpdateStore {
  state: UpdateState;
  version: string;
  open: boolean;
  set(s: Partial<UpdateStore>): void;
}

export const useUpdates = create<UpdateStore>((set) => ({
  state: { status: 'idle' },
  version: '',
  open: false,
  set: (s) => set(s)
}));

let silent = false;

/** Wire updater events once, and quietly check a few seconds after launch. */
export function initUpdates() {
  api.getVersion().then((version) => useUpdates.getState().set({ version }));
  api.onUpdateState((state) => {
    // A background check only surfaces when there is something to install.
    if (silent && (state.status === 'latest' || state.status === 'error' || state.status === 'checking')) {
      if (state.status !== 'checking') silent = false;
      return;
    }
    silent = false;
    useUpdates.getState().set({ state });
  });
  setTimeout(() => {
    if (!setting('updates.autoCheck')) return;
    silent = true;
    api.checkForUpdates().then((r) => {
      if (r.status === 'dev' || r.status === 'error') silent = false;
    });
  }, 6000);
}

export function openUpdates(check = true) {
  const s = useUpdates.getState();
  s.set({ open: true });
  if (check && !['downloading', 'ready', 'available'].includes(s.state.status)) {
    silent = false;
    s.set({ state: { status: 'checking' } });
    api.checkForUpdates().then((r) => {
      if (r.status === 'dev') s.set({ state: { status: 'dev' } });
      else if (r.status === 'error') s.set({ state: { status: 'error', message: r.message } });
    });
  }
}

async function installNow() {
  // Offer to save unsaved work before the app restarts.
  for (const t of useTabs.getState().tabs.filter((x) => x.dirty)) {
    if (!(await requestCloseTab(t.id))) return;
  }
  api.installUpdate();
}

export function UpdateDialog() {
  const { state, version, open, set } = useUpdates();
  const [notesOpen, setNotesOpen] = useState(false);
  useEffect(() => setNotesOpen(false), [state.version]);
  if (!open) return null;
  const close = () => set({ open: false });
  const notes = typeof state.notes === 'string' ? state.notes.replace(/<[^>]+>/g, '').trim() : '';

  let icon = <RefreshCw size={28} className="spin-slow" />;
  let title = 'Checking for updates…';
  let body: React.ReactNode = 'Looking for a newer version of Kea.';
  let actions: React.ReactNode = (
    <button className="btn" onClick={close}>
      Close
    </button>
  );

  switch (state.status) {
    case 'latest':
      icon = <CheckCircle2 size={28} color="var(--success)" />;
      title = "You're up to date";
      body = `Kea ${version} is the newest version.`;
      break;
    case 'available':
      icon = <Sparkles size={28} color="var(--accent)" />;
      title = `Version ${state.version} is available`;
      body = (
        <>
          You have {version}. The update downloads in the background — keep working while it does.
          {notes && (
            <button className="link-btn" onClick={() => setNotesOpen((o) => !o)}>
              {notesOpen ? 'Hide' : "What's new"}
            </button>
          )}
          {notesOpen && <pre className="update-notes">{notes}</pre>}
        </>
      );
      actions = (
        <>
          <button className="btn" onClick={close}>
            Later
          </button>
          <button
            className="btn primary"
            onClick={() => {
              set({ state: { ...state, status: 'downloading', percent: 0 } });
              api.downloadUpdate();
            }}
          >
            <Download size={16} /> Download update
          </button>
        </>
      );
      break;
    case 'downloading':
      icon = <Download size={28} color="var(--accent)" />;
      title = 'Downloading update…';
      body = (
        <div>
          <div className="progress">
            <div style={{ width: `${state.percent || 0}%` }} />
          </div>
          <div style={{ marginTop: 8, color: 'var(--text-3)' }}>{state.percent || 0}% · you can close this and keep working</div>
        </div>
      );
      actions = (
        <button className="btn" onClick={close}>
          Hide
        </button>
      );
      break;
    case 'ready':
      icon = <CheckCircle2 size={28} color="var(--success)" />;
      title = 'Update ready to install';
      body = `Kea will restart into version ${state.version || ''}. You'll be asked to save any unsaved work first.`;
      actions = (
        <>
          <button className="btn" onClick={close}>
            On next launch
          </button>
          <button className="btn primary" onClick={installNow}>
            <RefreshCw size={16} /> Restart and update
          </button>
        </>
      );
      break;
    case 'error':
      icon = <AlertCircle size={28} color="var(--danger)" />;
      title = "Couldn't check for updates";
      body = state.message || 'Something went wrong.';
      actions = (
        <>
          <button className="btn" onClick={close}>
            Close
          </button>
          <button className="btn primary" onClick={() => openUpdates(true)}>
            Try again
          </button>
        </>
      );
      break;
    case 'dev':
      icon = <AlertCircle size={28} color="var(--warning)" />;
      title = 'Updates work in the installed app';
      body = "You're running Kea from source. Install it with the setup file to get one-click updates.";
      break;
  }

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog update-dialog">
        <button className="icon-btn sm update-x" onClick={close}>
          <X size={16} />
        </button>
        <div className="update-icon">{icon}</div>
        <h2>{title}</h2>
        <div className="update-body">{body}</div>
        <div className="dialog-actions">{actions}</div>
        <div className="update-foot">Current version {version}</div>
      </div>
    </div>
  );
}
