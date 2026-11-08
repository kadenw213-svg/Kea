// Kea cloud's status: the sync state, the storage used, and what to do when it's full or signed out. Shown on Home
// (above Kea cloud's files) and in Settings → Accounts & cloud → Kea cloud.
import { useEffect } from 'react';
import { AlertTriangle, CheckCircle2, CloudOff, FolderOpen, Loader2, RefreshCw } from 'lucide-react';
import { api, KeaCloudStatus } from '../../lib/api';
import { STATE_LABEL, storageLine, useKeaCloud, watchKeaCloud } from '../../lib/keaCloud';
import { NeedsOnline } from '../account/NeedsOnline';
import { Logo } from '../Logo';
import { PlaceIcon, SyncPicker } from '../settings/SyncPicker';
import { toast } from '../../store';
import { timeAgo } from '../../lib/util';

export function KeaCloudMark({ size = 17 }: { size?: number }) {
  // Kea's own logo, the same mark Kea cloud has in Settings → Where your things sync (each drive shows its own logo).
  return <Logo size={size} className="kc-mark" />;
}

export function StateIcon({ s, size = 14 }: { s: KeaCloudStatus['state']; size?: number }) {
  if (s === 'synced' || s === 'drive') return <CheckCircle2 size={size} className="kc-ok" />;
  if (s === 'syncing') return <Loader2 size={size} className="spin kc-busy" />;
  if (s === 'offline') return <CloudOff size={size} className="kc-off" />;
  if (s === 'full' || s === 'error') return <AlertTriangle size={size} className="kc-bad" />;
  return <CloudOff size={size} className="kc-off" />;
}

function StorageBar({ s }: { s: KeaCloudStatus }) {
  if (!s.storage) return null;
  const { used, quota } = s.storage;
  const pct = quota > 0 ? Math.min(100, (used / quota) * 100) : quota === 0 && used > 0 ? 100 : 0;
  return (
    <div className="kc-storage" title={storageLine(s)}>
      <div className={`kc-bar ${pct >= 95 ? 'bad' : pct >= 80 ? 'warn' : ''}`}>
        <span style={{ width: `${Math.max(pct, used > 0 ? 1.5 : 0)}%` }} />
      </div>
      <span className="muted">{storageLine(s)}</span>
    </div>
  );
}

async function syncNow() {
  const r = await api.keaCloud.syncNow();
  if (r.ok) useKeaCloud.setState({ status: r.value });
  else toast(r.error, 'error');
}

/** The strip above Kea cloud's files on Home. */
export function KeaCloudHeader() {
  const s = useKeaCloud((x) => x.status);
  useEffect(() => watchKeaCloud(true), []);
  if (!s) return null;
  if (!s.signedIn)
    return (
      <div className="kc-head">
        {!s.place || s.place.kind === 'kea' ? <NeedsOnline compact what="Kea cloud keeps your documents on all your devices" /> : <span className="muted">{notHere(s)}</span>}
      </div>
    );
  return (
    <>
      <div className="kc-head">
        <span className={`kc-state st-${s.state}`}>
          <StateIcon s={s.state} />
          {STATE_LABEL[s.state]}
        </span>
        <StorageBar s={s} />
        {(!s.place || s.place.kind === 'kea' || s.place.kind === 'keas') && (
          <button className="icon-btn sm" title="Sync now" onClick={syncNow}>
            <RefreshCw size={15} />
          </button>
        )}
      </div>
      {s.state === 'full' && <div className="kc-alert">{s.message || 'Your Kea storage is full. Delete documents you don’t need, or ask for more space.'} Until there’s room, new changes stay on this PC.</div>}
      {s.state === 'error' && s.message && <div className="kc-alert">{s.message}</div>}
      {s.conflicts.length > 0 && Date.now() - s.conflicts[s.conflicts.length - 1].at < 86400_000 && (
        <div className="kc-note">
          {s.conflicts[s.conflicts.length - 1].rel.split('/').pop()} was changed on another device at the same time. Both versions are kept: the other one is “{s.conflicts[s.conflicts.length - 1].copy.split('/').pop()}”.
        </div>
      )}
    </>
  );
}

/** Why documents can't be used now, for a place other than Kea cloud. */
const notHere = (s: KeaCloudStatus) =>
  s.place?.why === 'signedOut' ? `${s.place.label} signed you out. Pick another place in Settings → Kea cloud.` : `${s.place?.label ?? 'That place'} isn’t on this computer. Pick another place in Settings → Kea cloud.`;

/** Settings → Kea cloud: where things sync, then the same status, with the folder and sync controls. */
export function KeaCloudPanel() {
  return (
    <>
      <SyncPicker />
      <KeaCloudStatusPanel />
    </>
  );
}
function KeaCloudStatusPanel() {
  const s = useKeaCloud((x) => x.status);
  useEffect(() => watchKeaCloud(true), []);
  if (!s) return <div className="muted">Loading…</div>;
  if (!s.signedIn) return s.place && s.place.kind !== 'kea' ? <p className="warn-line">{notHere(s)}</p> : null;
  const server = !s.place || s.place.kind === 'kea' || s.place.kind === 'keas';
  return (
    <div className="kc-panel">
      <PlaceIcon place={s.place ?? { kind: 'kea' }} size={26} />
      <div className="kc-panel-main">
        <b>
          <span className={`kc-state st-${s.state}`}>
            <StateIcon s={s.state} /> {STATE_LABEL[s.state]}
          </span>
        </b>
        <span className="muted">
          {s.place && s.place.kind !== 'kea' ? s.place.label : s.email}
          {s.files ? ` · ${s.files} document${s.files === 1 ? '' : 's'}` : ''}
          {s.last ? ` · checked ${timeAgo(s.last)}` : ''}
        </span>
        <StorageBar s={s} />
      </div>
      {server && (
        <button className="btn sm" onClick={syncNow}>
          <RefreshCw size={14} /> Sync now
        </button>
      )}
      <button className="btn sm" onClick={() => api.keaCloud.open()}>
        <FolderOpen size={14} /> Open folder
      </button>
    </div>
  );
}
