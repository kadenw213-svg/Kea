// "Where your things sync": one choice for classes, Kea cloud documents and the phone's files (electron/syncChoice.cjs).
// Shown in Settings → Kea cloud, on the first-run screen, and in the Kea cloud panel. Switching is one click and a
// short confirmation of what gets a copy where; nothing is deleted, and the old place keeps its copy.
import { useEffect, useState } from 'react';
import { Building2, Check, CloudOff, FolderOpen, Loader2 } from 'lucide-react';
import { api, SyncPlace, SyncStatus } from '../../lib/api';
import { Logo } from '../Logo';
import { DriveLogo } from '../home/DriveLogo';
import { NeedsOnline } from '../account/NeedsOnline';
import { useHubStatus } from '../account/hubStore';
import { useKeaCloud } from '../../lib/keaCloud';
import { ask, toast } from '../../store';

/** The same mark for a place everywhere: Kea's logo for Kea cloud, each drive's own logo, a folder, a server, off. */
export function PlaceIcon({ place, size = 18 }: { place: Pick<SyncPlace, 'kind'> & { brand?: string | null }; size?: number }) {
  if (place.kind === 'kea') return <Logo size={size} />;
  if (place.kind === 'drive') return <DriveLogo id={place.brand === 'google' ? 'gdrive' : place.brand || 'onedrive'} size={size} />;
  if (place.kind === 'folder') return <FolderOpen size={size - 2} />;
  if (place.kind === 'keas') return <Building2 size={size - 2} />;
  return <CloudOff size={size - 2} />;
}

const WHY: Record<string, string> = {
  notHere: 'Not on this computer',
  noFolder: 'Pick a folder',
  notJoined: 'Join it in Work first',
  signedOut: 'This organization signed you out',
};

let cache: SyncStatus | null = null;
export function useSyncStatus(): [SyncStatus | null, () => Promise<void>] {
  const [st, setSt] = useState<SyncStatus | null>(cache);
  const hub = useHubStatus();
  const load = async () => {
    const r = await api.sync.status();
    if (r.ok) setSt((cache = r.value));
  };
  useEffect(() => {
    load();
    return api.servers.onChanged(() => load());
  }, [hub?.signedIn, hub?.account?.id]);
  return [st, load];
}

export function SyncPicker({ compact = false }: { compact?: boolean }) {
  const [st, load] = useSyncStatus();
  const [busy, setBusy] = useState<string | null>(null);
  if (!st) return <div className="muted">Loading…</div>;

  const pick = async (o: SyncPlace) => {
    if (busy) return;
    if (o.id === st.choice && o.id !== 'custom') return;
    let folder: string | undefined;
    if (o.id === 'custom') {
      const r = await api.sync.pickFolder();
      if (!r.ok || !r.value) return;
      folder = r.value;
    }
    const pv = await api.sync.preview(o.id);
    if (!pv.ok) return toast(pv.error, 'error');
    const to = o.id === 'custom' && folder ? `${folder}` : o.label;
    if ((await ask(o.kind === 'off' ? 'Turn syncing off?' : `Sync through ${to}?`, pv.value.text, [{ id: 'no', label: 'Cancel' }, { id: 'yes', label: o.kind === 'off' ? 'Turn off' : 'Switch', primary: true }])) !== 'yes') return;
    setBusy(o.id);
    const r = await api.sync.choose(o.id, folder);
    setBusy(null);
    if (!r.ok) return toast(r.error, 'error');
    cache = r.value;
    await load();
    useKeaCloud.getState().refresh();
    toast(o.kind === 'off' ? 'Syncing is off. Everything stays on this computer.' : `Your things sync through ${o.label} now.`);
  };

  const cur = st.place;
  return (
    <div className={`sync-pick ${compact ? 'compact' : ''}`}>
      {!compact && <div className="sync-pick-head">Where your things sync</div>}
      {!compact && <p className="muted sync-pick-sub">Your classes, Kea cloud documents and your phone’s files go to the same place.</p>}
      <div className="sync-opts" role="radiogroup" aria-label="Where your things sync">
        {st.options
          .filter((o) => !compact || o.available || o.id === 'kea-hub' || o.id === 'custom')
          .map((o) => {
            const on = o.id === st.choice;
            const blocked = !o.available && o.id !== 'custom';
            const note = on && o.locked && o.why === 'needsOnline' ? 'Waits until your Kea account is online' : !o.available || (o.locked && o.why !== 'needsOnline') ? WHY[o.why || ''] || '' : '';
            return (
              <button key={o.id} role="radio" aria-checked={on} className={`sync-opt ${on ? 'on' : ''} ${blocked ? 'dim' : ''}`} disabled={blocked || !!busy} title={blocked ? WHY[o.why || ''] : undefined} onClick={() => pick(o)}>
                <span className="sync-ico">
                  <PlaceIcon place={o} />
                </span>
                <span className="sync-txt">
                  <b>
                    {o.id === 'custom' ? 'Any synced folder' : o.label}
                    {o.id === 'kea-hub' && <span className="muted sync-def"> · default</span>}
                  </b>
                  <span className="muted">{note || (o.id === 'custom' && !o.root ? 'Pick a folder another app syncs' : o.detail)}</span>
                </span>
                {busy === o.id ? <Loader2 size={15} className="spin" /> : on ? <Check size={15} className="sync-check" /> : null}
              </button>
            );
          })}
      </div>
      {cur.kind === 'kea' && cur.locked && <NeedsOnline compact what="Kea cloud keeps your things on all your devices" />}
      {cur.kind === 'keas' && cur.why === 'signedOut' && <p className="warn-line">{cur.label} signed you out, so nothing syncs there now. Pick another place, or sign in again in Work.</p>}
      {cur.kind === 'drive' && !cur.available && <p className="warn-line">{cur.label} isn’t on this computer. Install it and sign in, or pick another place.</p>}
    </div>
  );
}

/** One line: where things sync now, for places that only mention it (the Devices card, Settings → School). */
export function SyncLine({ onChange }: { onChange?(): void }) {
  const [st] = useSyncStatus();
  if (!st) return null;
  return (
    <span className="sync-line">
      <PlaceIcon place={st.place} size={15} />
      <span>{st.place.kind === 'off' ? 'Syncing is off' : `Syncs through ${st.place.label}`}</span>
      {onChange && (
        <button className="btn link sm" onClick={onChange}>
          Change
        </button>
      )}
    </span>
  );
}
