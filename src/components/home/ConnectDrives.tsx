import { useEffect, useRef, useState } from 'react';
import { X, Check, Loader2, LogIn, FolderOpen } from 'lucide-react';
import { api, DriveId, DriveInfo, DriveProgress } from '../../lib/api';
import { toast } from '../../store';
import { formatBytes } from '../../lib/util';
import { DriveLogo } from './DriveLogo';

const BLURB: Record<DriveId, string> = {
  onedrive: 'Built into Windows. Sign in with your Microsoft account.',
  gdrive: "Uses Google's free Drive app. Slate downloads it from Google (about 280 MB), then you sign in with Google.",
  dropbox: "Uses Dropbox's app. Slate downloads it from Dropbox, then you sign in.",
  icloud: 'Uses Apple’s iCloud app from the Microsoft Store. Sign in with your Apple ID.'
};

export function ConnectDrives({ drives, onClose, onChange }: { drives: DriveInfo[]; onClose: () => void; onChange: (d: DriveInfo[]) => void }) {
  const [progress, setProgress] = useState<Partial<Record<DriveId, DriveProgress | { status: 'waiting' }>>>({});
  const known = useRef(new Set(drives.flatMap((d) => d.accounts.map((a) => a.path.toLowerCase()))));
  const waiting = Object.values(progress).some((p) => p && p.status !== 'error');

  useEffect(() => api.onDriveProgress((m) => setProgress((p) => ({ ...p, [m.id]: m }))), []);

  // While something is being set up, look for the drive's folder to appear (the sync app creates it after sign-in).
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(async () => {
      const next = await api.detectDrives();
      const fresh = next.flatMap((d) => d.accounts.filter((a) => !known.current.has(a.path.toLowerCase())).map((a) => ({ d, a })));
      if (!fresh.length) return;
      for (const { d, a } of fresh) {
        known.current.add(a.path.toLowerCase());
        toast(`${d.label} connected. Your files are on Home now.`, 'success');
        setProgress((p) => ({ ...p, [d.id]: undefined }));
      }
      onChange(next);
    }, 3000);
    return () => clearInterval(t);
  }, [waiting]);

  const connect = async (d: DriveInfo) => {
    setProgress((p) => ({ ...p, [d.id]: { status: 'waiting' } }));
    try {
      const r = await api.connectDrive(d.id);
      if (r.action === 'launched') toast(`Finish signing in to ${d.label} in its window. Slate will pick it up automatically.`);
      else if (r.action === 'installing') toast(`Follow ${d.label}'s setup, then sign in. Slate will pick it up automatically.`);
      else toast(`Install ${d.label} from the page that opened, then sign in.`);
      setProgress((p) => ({ ...p, [d.id]: { status: 'waiting' } }));
    } catch (err: any) {
      const message = String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      setProgress((p) => ({ ...p, [d.id]: { id: d.id, status: 'error', error: message } }));
    }
  };

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog drives-dialog">
        <div className="ai-settings-head">
          <h2>Cloud drives</h2>
          <button className="icon-btn sm" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <p>
          Sign in once and your cloud files show up on Home. Each service's own app keeps them in sync, so Slate never
          sees your password and works offline with anything you've opened.
        </p>
        <div className="drive-list">
          {drives.map((d) => {
            const pr = progress[d.id];
            const connected = d.accounts.length > 0;
            return (
              <div key={d.id} className={`drive-row ${connected ? 'on' : ''}`}>
                <DriveLogo id={d.id} size={34} />
                <div className="drive-info">
                  <div className="drive-name">
                    {d.label}
                    {connected && (
                      <span className="drive-ok">
                        <Check size={12} /> Connected
                      </span>
                    )}
                  </div>
                  {connected ? (
                    d.accounts.map((a) => (
                      <div key={a.path} className="muted drive-path">
                        <FolderOpen size={12} /> {a.path}
                      </div>
                    ))
                  ) : pr && pr.status === 'downloading' ? (
                    <div className="drive-progress">
                      <div className="bar">
                        <div style={{ width: pr.total ? `${(100 * (pr.received || 0)) / pr.total}%` : '8%' }} />
                      </div>
                      <span className="muted">
                        Downloading {d.label}… {formatBytes(pr.received || 0)}
                        {pr.total ? ` of ${formatBytes(pr.total)}` : ''}
                      </span>
                    </div>
                  ) : pr && pr.status === 'error' ? (
                    <div className="drive-err">{pr.error}</div>
                  ) : pr ? (
                    <div className="muted">
                      {pr.status === 'verifying' ? 'Checking the download is genuine…' : pr.status === 'installing' ? 'Installing. Follow the setup window, then sign in.' : 'Waiting for you to sign in…'}
                    </div>
                  ) : (
                    <div className="muted">{d.installed ? 'Installed. Sign in to see your files here.' : BLURB[d.id]}</div>
                  )}
                </div>
                {!connected &&
                  (pr && pr.status !== 'error' ? (
                    <Loader2 size={18} className="spin muted" />
                  ) : (
                    <button className="btn tonal" onClick={() => connect(d)}>
                      <LogIn size={14} /> Sign in
                    </button>
                  ))}
              </div>
            );
          })}
        </div>
        <div className="dialog-actions">
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
