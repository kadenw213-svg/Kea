import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { Download, RefreshCw, CheckCircle2, AlertCircle, Sparkles, X } from 'lucide-react';
import { api, UpdateState } from '../lib/api';
import { useTabs } from '../store';
import { requestCloseTab } from '../lib/closing';
import { nextUpdateState, updateHeadline, updateIndicator } from '../lib/updateState';

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

// The person pressed Check for updates and is waiting for the answer (a check Kea runs by itself stays quiet).
let asked = false;
const RELEASES = 'https://github.com/kadenw213-svg/kea/releases';

const apply = (incoming: UpdateState) => {
  const s = useUpdates.getState();
  const r = nextUpdateState(s.state, incoming, asked);
  asked = r.asked;
  if (r.state !== s.state) s.set({ state: r.state });
};

/**
 * Wire updater events once. Kea itself checks soon after it starts and every few hours, in every mode
 * (electron/main.cjs); this window picks up where the updater is, so a download finished before it opened still says
 * "Restart to update".
 */
export function initUpdates() {
  api.getVersion().then((version) => useUpdates.getState().set({ version }));
  api.onUpdateState(apply);
  api.updateStatus?.().then(apply, () => {});
}

export function openUpdates(check = true) {
  const s = useUpdates.getState();
  s.set({ open: true });
  if (check && !['downloading', 'ready', 'available'].includes(s.state.status)) {
    asked = true;
    s.set({ state: { status: 'checking' } });
    api.checkForUpdates().then((r) => {
      if (r.status === 'dev' || r.status === 'manual') apply({ status: r.status });
      else if (r.status === 'error') apply({ status: 'error', message: r.message });
    });
  }
}

/** Download the update that was found (when updates don't download by themselves). */
function download() {
  const s = useUpdates.getState();
  s.set({ state: { ...s.state, status: 'downloading', percent: 0 } });
  api.downloadUpdate();
}

/** In the title bar, on every screen: an update downloaded and waiting ("Restart to update"), on its way, or found. */
export function UpdatePill() {
  const state = useUpdates((s) => s.state);
  const ind = updateIndicator(state);
  if (!ind) return null;
  return (
    <button className={`update-pill ${ind.kind}`} title={ind.title} onClick={() => (ind.kind === 'ready' ? installNow() : openUpdates(false))}>
      {ind.kind === 'ready' ? <RefreshCw size={14} /> : <Download size={14} />}
      {ind.label}
    </button>
  );
}

export async function installNow() {
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
      title = updateHeadline(state);
      body = `You have the newest version, ${version}.`;
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
            onClick={download}
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
      title = 'Update ready';
      body = `Kea restarts into version ${state.version || ''}. You can save any unsaved work first. Or it installs by itself the next time you close Kea.`;
      actions = (
        <>
          <button className="btn" onClick={close}>
            Later
          </button>
          <button className="btn primary" onClick={installNow}>
            <RefreshCw size={16} /> Restart to update
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
    case 'manual':
      icon = <Download size={28} color="var(--accent)" />;
      title = 'This copy of Kea can’t update itself';
      body = 'Get the installer from the release notes. Installed, Kea keeps itself up to date.';
      actions = (
        <>
          <button className="btn" onClick={close}>
            Close
          </button>
          <button className="btn primary" onClick={() => (window.open(RELEASES), close())}>
            Release notes
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
