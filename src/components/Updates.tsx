import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { Download, RefreshCw, CheckCircle2, AlertCircle, Sparkles, X } from 'lucide-react';
import { api, UpdateHealth, UpdateState } from '../lib/api';
import { useTabs } from '../store';
import { requestCloseTab } from '../lib/closing';
import { nextUpdateState, staleness, updateHeadline, updateIndicator, when } from '../lib/updateState';

interface UpdateStore {
  state: UpdateState;
  version: string;
  open: boolean;
  /** Whether Kea is keeping up (electron/updateHealth.cjs): checks, failures, a waiting update, what servers say. */
  health: UpdateHealth | null;
  set(s: Partial<UpdateStore>): void;
}

export const useUpdates = create<UpdateStore>((set) => ({
  state: { status: 'idle' },
  version: '',
  open: false,
  health: null,
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
  api.updateHealth?.().then((health) => useUpdates.getState().set({ health }), () => {});
  api.onUpdateHealth?.((health) => useUpdates.getState().set({ health }));
}

/**
 * The Update button wherever Kea says it must or should update: restart into a downloaded update, download a found
 * one, otherwise check now (which downloads what it finds). A copy that can't update itself opens the download page.
 */
export function updateNow() {
  const { state, health } = useUpdates.getState();
  if (state.status === 'ready') return void installNow();
  if (state.status === 'available') return void (download(), useUpdates.getState().set({ open: true }));
  if (health && health.packaged && health.canSelfUpdate === false) return void window.open(health.tooOld?.updateUrl || RELEASES);
  openUpdates(true);
}

/** "Update Kea to keep using your Kea account", with an Update button: shown where a server turned this Kea away. */
export function UpdateRequired({ from = 'account' }: { from?: 'account' | 'org' | 'any' }) {
  const health = useUpdates((s) => s.health);
  const t = health?.tooOld;
  if (!health || !t || (from === 'account' && t.from !== 'account') || (from === 'org' && !t.from.startsWith('org:'))) return null;
  return (
    <div className="update-required" role="alert">
      <AlertCircle size={18} />
      <div className="update-required-text">
        <strong>{t.error}</strong>
        <span className="muted">
          {t.minVersion ? `It needs Kea ${t.minVersion} or newer; this is ${health.version}. ` : ''}Everything on this computer is kept.
        </span>
      </div>
      <button className="btn primary sm" onClick={updateNow}>
        <Download size={14} /> Update
      </button>
    </div>
  );
}

/** Settings > About: the version, how updates are going, when Kea last checked, and the button for what's next. */
export function UpdateStatusCard() {
  const { state, version, health } = useUpdates();
  const st = staleness(health);
  const ind = updateIndicator(state, health);
  const headline =
    st?.kind === 'required'
      ? 'Kea needs an update'
      : ind?.kind === 'ready'
        ? 'Restart to update'
        : ind?.kind === 'downloading'
          ? ind.label
          : ind?.kind === 'available'
            ? 'An update is available'
            : st?.kind === 'stale'
              ? st.label
              : state.status === 'error'
                ? updateHeadline(state)
                : 'Kea is up to date';
  return (
    <div className="about-card">
      <div className="about-title">Updates</div>
      <p>
        <strong>{headline}</strong> · Kea {version}
      </p>
      {st && <p className={st.kind === 'available' ? 'muted' : 'hub-warn'}>{st.detail}</p>}
      <p className="muted">
        Last checked {when(health?.lastCheckAt)}
        {health?.lastOkAt && health.lastOkAt !== health.lastCheckAt ? ` · last worked ${when(health.lastOkAt)}` : ''}
        {health && health.failures > 0 ? ` · ${health.failures} failed in a row${health.lastError ? `: ${health.lastError}` : ''}` : ''}
      </p>
      <div className="about-links">
        <button className="btn sm primary" onClick={() => (ind?.kind === 'ready' ? installNow() : st || ind ? updateNow() : openUpdates(true))}>
          {ind?.kind === 'ready' ? <RefreshCw size={14} /> : <Download size={14} />}
          {ind?.kind === 'ready' ? 'Restart to update' : st?.kind === 'required' || ind ? 'Update now' : 'Check for updates'}
        </button>
      </div>
    </div>
  );
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
  const health = useUpdates((s) => s.health);
  const ind = updateIndicator(state, health);
  if (!ind) return null;
  // (Found or downloading: the dialog shows it. Must update, failing checks, or a newer Kea a server knows of: the
  // dialog checks again and says what's wrong, with Update.)
  const click = () => (ind.kind === 'ready' ? installNow() : state.status === 'available' || state.status === 'downloading' ? openUpdates(false) : openUpdates(true));
  return (
    <button className={`update-pill ${ind.kind}`} title={ind.title} onClick={click}>
      {ind.kind === 'ready' ? <RefreshCw size={14} /> : ind.kind === 'stale' || ind.kind === 'required' ? <AlertCircle size={14} /> : <Download size={14} />}
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
  const { state, version, open, set, health } = useUpdates();
  const st = staleness(health);
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
        {st && !['downloading', 'ready'].includes(state.status) && <div className={`update-notice ${st.kind}`}>{st.detail}</div>}
        <div className="update-body">{body}</div>
        <div className="dialog-actions">
          {actions}
          {st?.kind === 'required' && !['available', 'checking', 'downloading', 'ready'].includes(state.status) && (
            <button className="btn primary" onClick={updateNow}>
              <Download size={16} /> Update
            </button>
          )}
        </div>
        <div className="update-foot">
          Current version {version} · last checked {when(health?.lastCheckAt)}
        </div>
      </div>
    </div>
  );
}
