// Kea Cloud's status: the sync state, the storage used, and what to do when it's full or signed out. Shown on Home
// (above Kea Cloud's files) and in Settings → Accounts & cloud → Kea Cloud.
import { useEffect } from 'react';
import { AlertTriangle, CheckCircle2, CloudOff, FolderOpen, Loader2, RefreshCw } from 'lucide-react';
import { api, KeaCloudStatus } from '../../lib/api';
import { STATE_LABEL, storageLine, useKeaCloud, watchKeaCloud } from '../../lib/keaCloud';
import { NeedsOnline } from '../account/NeedsOnline';
import { toast } from '../../store';
import { timeAgo } from '../../lib/util';

export function KeaCloudMark({ size = 17 }: { size?: number }) {
  // A plain cloud in Kea's accent: Kea's own storage, set apart from OneDrive and Google Drive. (No tick: whether it's
  // up to date is shown beside the files, and a tick on a signed-out cloud read as "synced".)
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className="kc-mark">
      <path d="M7 18.5h10.2a4.3 4.3 0 0 0 .6-8.56A6 6 0 0 0 6.2 9.3 4.6 4.6 0 0 0 7 18.5Z" fill="var(--accent)" opacity="0.22" stroke="var(--accent)" strokeWidth="1.7" strokeLinejoin="round" />
    </svg>
  );
}

export function StateIcon({ s, size = 14 }: { s: KeaCloudStatus['state']; size?: number }) {
  if (s === 'synced') return <CheckCircle2 size={size} className="kc-ok" />;
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

/** The strip above Kea Cloud's files on Home. */
export function KeaCloudHeader() {
  const s = useKeaCloud((x) => x.status);
  useEffect(() => watchKeaCloud(true), []);
  if (!s) return null;
  if (!s.signedIn)
    return (
      <div className="kc-head">
        <NeedsOnline compact what="Kea Cloud keeps your documents on all your devices" />
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
        <button className="icon-btn sm" title="Sync now" onClick={syncNow}>
          <RefreshCw size={15} />
        </button>
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

/** Settings → Kea Cloud: the same status, with the folder and sync controls. */
export function KeaCloudPanel() {
  const s = useKeaCloud((x) => x.status);
  useEffect(() => watchKeaCloud(true), []);
  if (!s) return <div className="muted">Loading…</div>;
  if (!s.signedIn)
    return (
      <div className="kc-panel">
        <KeaCloudMark size={28} />
        <div className="kc-panel-main">
          <NeedsOnline what="Kea Cloud uses the storage that comes with your online Kea account" />
        </div>
      </div>
    );
  return (
    <div className="kc-panel">
      <KeaCloudMark size={28} />
      <div className="kc-panel-main">
        <b>
          <span className={`kc-state st-${s.state}`}>
            <StateIcon s={s.state} /> {STATE_LABEL[s.state]}
          </span>
        </b>
        <span className="muted">
          {s.email}
          {s.files ? ` · ${s.files} document${s.files === 1 ? '' : 's'}` : ''}
          {s.last ? ` · checked ${timeAgo(s.last)}` : ''}
        </span>
        <StorageBar s={s} />
      </div>
      <button className="btn sm" onClick={syncNow}>
        <RefreshCw size={14} /> Sync now
      </button>
      <button className="btn sm" onClick={() => api.keaCloud.open()}>
        <FolderOpen size={14} /> Open folder
      </button>
    </div>
  );
}
