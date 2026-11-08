import { ReactNode, useEffect, useRef, useState } from 'react';
import { BadgeCheck, Camera, Check, Move, ShieldCheck, Trash2 } from 'lucide-react';
import { create } from 'zustand';
import { api, AvatarCrop, KeaAccount } from '../../lib/api';
import { toast } from '../../store';
import { accountOf, run, setHubStatus, useHubStatus } from '../account/hubStore';

// The Kea account as Kea shows it (name, picture, verified): the account signed in on this computer. Its email and
// name are kept here, verified comes from the online account; the picture is kept on this computer
// (electron/account.cjs). Reloaded whenever the status says something about the account changed, so every view agrees
// right after signing in or out.
const useAccountStore = create<{ account: KeaAccount | null | undefined; set(a: KeaAccount | null): void }>((set) => ({ account: undefined, set: (account) => set({ account }) }));
let loadedFor = '';
function load(key: string, force = false) {
  if (loadedFor === key && !force) return;
  loadedFor = key;
  api.account
    .get()
    .then((a) => loadedFor === key && useAccountStore.getState().set(a))
    .catch(() => loadedFor === key && useAccountStore.getState().set(null));
}
/** [account, set]: undefined while loading, null when signed out. */
export function useAccount() {
  const status = useHubStatus();
  const a = accountOf(status);
  const key = !status ? '' : a ? `${a.id}|${a.email}|${a.name}|${a.emailVerified}` : 'out';
  const { account, set } = useAccountStore();
  useEffect(() => {
    if (key && key !== 'out') load(key);
  }, [key]);
  return [!key ? undefined : key === 'out' ? null : account, set] as const;
}

/** The badge beside a name: only Kea's creator has one (a verified email shows no badge). */
export function VerifiedBadge({ account, size = 15 }: { account: KeaAccount | null | undefined; size?: number }) {
  if (!account?.verified || !account.owner) return null;
  return (
    <span className="acct-badge owner" title="Kea’s creator">
      <BadgeCheck size={size} />
    </span>
  );
}

/** The picture placed in a circle of this size: its chosen centre in the middle, zoomed as chosen. */
function placed(c: AvatarCrop, size: number) {
  const k = (size * c.zoom) / Math.min(c.w, c.h);
  const w = c.w * k;
  const h = c.h * k;
  return { backgroundSize: `${w}px ${h}px`, backgroundPosition: `${size / 2 - c.x * w}px ${size / 2 - c.y * h}px` };
}

/** A round picture, or the first letter of the name. */
export function Avatar({ account, size = 28 }: { account: KeaAccount | null | undefined; size?: number }) {
  const letter = (account?.name || account?.email || 'K')[0].toUpperCase();
  if (account?.avatar && account.crop) return <span className="acct-avatar placed" style={{ width: size, height: size, backgroundImage: `url("${account.avatar}")`, ...placed(account.crop, size) }} />;
  return account?.avatar ? (
    <img className="acct-avatar" src={account.avatar} alt="" style={{ width: size, height: size }} />
  ) : (
    <span className="acct-avatar letter" style={{ width: size, height: size, fontSize: size * 0.45 }}>
      {letter}
    </span>
  );
}

/** Moving the picture in its circle: drag it anywhere, zoom with the slider or the mouse wheel. */
function AdjustPicture({ account, onDone }: { account: KeaAccount; onDone(a: KeaAccount | null): void }) {
  const SIZE = 220;
  const [crop, setCrop] = useState<AvatarCrop | null>(account.crop);
  const drag = useRef<{ x: number; y: number; from: AvatarCrop } | null>(null);
  useEffect(() => {
    if (crop) return;
    const img = new Image();
    img.onload = () => setCrop({ x: 0.5, y: 0.5, zoom: 1, w: img.naturalWidth, h: img.naturalHeight });
    img.src = account.avatar!;
  }, []);
  if (!crop) return null;
  // The circle always stays covered by the picture.
  const fit = (c: AvatarCrop): AvatarCrop => {
    const k = (SIZE * c.zoom) / Math.min(c.w, c.h);
    const hx = SIZE / 2 / (c.w * k);
    const hy = SIZE / 2 / (c.h * k);
    return { ...c, x: Math.min(1 - hx, Math.max(hx, c.x)), y: Math.min(1 - hy, Math.max(hy, c.y)) };
  };
  const zoomTo = (z: number) => setCrop((c) => c && fit({ ...c, zoom: Math.min(6, Math.max(1, z)) }));
  return (
    <div className="acct-adjust">
      <div
        className="acct-adjust-view"
        style={{ width: SIZE, height: SIZE, backgroundImage: `url("${account.avatar}")`, ...placed(crop, SIZE) }}
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, from: crop };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const k = (SIZE * d.from.zoom) / Math.min(d.from.w, d.from.h);
          setCrop(fit({ ...d.from, x: d.from.x - (e.clientX - d.x) / (d.from.w * k), y: d.from.y - (e.clientY - d.y) / (d.from.h * k) }));
        }}
        onPointerUp={() => (drag.current = null)}
        onWheel={(e) => zoomTo(crop.zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08))}
      >
        <span className="acct-adjust-hint">
          <Move size={13} /> Drag to move
        </span>
      </div>
      <label className="acct-adjust-zoom">
        <span className="muted">Zoom</span>
        <input type="range" min={1} max={6} step={0.01} value={crop.zoom} onChange={(e) => zoomTo(Number(e.target.value))} />
      </label>
      <div className="acct-actions">
        <button className="btn primary sm" onClick={async () => onDone(await api.account.crop(crop).catch(() => null))}>
          <Check size={14} /> Done
        </button>
        <button className="btn sm" onClick={() => onDone(null)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** The account page's head: the picture (click to change it), and beside it whatever the page puts there. */
export function ProfileHead({ children }: { children: ReactNode }) {
  const [account, setAccount] = useAccount();
  const [busy, setBusy] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  if (!account) return <div className="acct-head">{children}</div>;
  const act = async (fn: () => Promise<KeaAccount | null>) => {
    setBusy(true);
    try {
      const a = await fn();
      if (a) setAccount(a);
      return a;
    } catch (err: any) {
      toast(String(err?.message || err), 'error');
      return null;
    } finally {
      setBusy(false);
    }
  };
  if (adjusting && account.avatar) return <AdjustPicture account={account} onDone={(a) => (a && setAccount(a), setAdjusting(false))} />;
  return (
    <div className="acct-head">
      <div className="acct-pic-col">
        <button
          className="acct-pic"
          onClick={async () => {
            const before = account.avatar;
            const a = await act(() => api.account.avatar());
            // A new picture goes straight to placing it.
            if (a?.avatar && a.avatar !== before) setAdjusting(true);
          }}
          title={account.avatar ? 'Change your picture' : 'Add a picture'}
          disabled={busy}
        >
          <Avatar account={account} size={64} />
          <span className="acct-pic-cam">
            <Camera size={14} />
          </span>
        </button>
        {account.avatar && (
          <span className="acct-pic-btns">
            <button className="icon-btn sm" title="Move or zoom the picture" disabled={busy} onClick={() => setAdjusting(true)}>
              <Move size={13} />
            </button>
            <button className="icon-btn sm" title="Remove the picture" disabled={busy} onClick={() => act(() => api.account.avatar(true))}>
              <Trash2 size={13} />
            </button>
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

/** Verifying the online Kea account's email with Google (joining an organization and Kea's shared Claude need it). */
export function VerifyEmail({ compact = false }: { compact?: boolean }) {
  const status = useHubStatus();
  const [account] = useAccount();
  const [busy, setBusy] = useState(false);
  if (!account || account.verified || !status?.signedIn) return null;
  return (
    <div className={`acct-verify ${compact ? 'compact' : ''}`}>
      {!compact && <p className="muted acct-note">Verify {account.email} by signing in to Google with it. Joining an organization and Kea’s shared Claude need this.</p>}
      <div className="acct-actions">
        <button
          className="btn primary sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const s = await run(api.hub.googleVerify());
            setBusy(false);
            if (s) (setHubStatus(s), toast('Email verified with Google.', 'success'));
          }}
        >
          <ShieldCheck size={14} /> Verify with Google
        </button>
      </div>
    </div>
  );
}
