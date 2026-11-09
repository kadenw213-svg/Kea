// Settings → Google account: one card. Connected as … / Connect Google Drive / Disconnect. Kea uses its own built-in
// Google client (the same as "Sign in with Google"), so there is nothing to set up.
import { useEffect, useState } from 'react';
import { CheckCircle2, ExternalLink, Loader2, LogOut } from 'lucide-react';
import { api } from '../../lib/api';
import { connectDrive } from '../../lib/google';
import { DriveLogo } from '../home/DriveLogo';

export function GooglePanel() {
  const [status, setStatus] = useState<{ configured: boolean; signedIn: boolean; email: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const refresh = () => api.google.status().then(setStatus);
  useEffect(() => {
    refresh();
  }, []);

  const connect = async () => {
    setBusy(true);
    setRefused(null);
    const r = await connectDrive();
    setBusy(false);
    if (r === 'refused') setRefused('Google didn’t let Kea open your Drive yet. Google files still open in your browser.');
    refresh();
  };

  return (
    <div className="gpanel">
      <div className="gcard">
        <DriveLogo id="gdrive" size={30} />
        <div className="gcard-main">
          <div className="gcard-title">Google Drive</div>
          <div className="muted">
            {status?.signedIn ? (
              <>
                <CheckCircle2 size={13} color="var(--success)" style={{ verticalAlign: -2 }} /> Connected{status.email ? ` as ${status.email}` : ''}. Docs, Sheets and Slides open in Kea and save back to Drive.
              </>
            ) : status && !status.configured ? (
              'Google Drive isn’t available in this copy of Kea. Google files open in your browser.'
            ) : (
              'Open Google Docs, Sheets and Slides right here, and save back to Drive.'
            )}
          </div>
          {refused && (
            <div className="muted gcard-note">
              <ExternalLink size={12} style={{ verticalAlign: -1 }} /> {refused}
            </div>
          )}
        </div>
        {status?.signedIn ? (
          <button
            className="btn sm"
            onClick={async () => {
              await api.google.signOut();
              refresh();
            }}
          >
            <LogOut size={14} /> Disconnect
          </button>
        ) : (
          status?.configured && (
            <button className="btn sm primary" disabled={busy} onClick={connect}>
              {busy && <Loader2 size={14} className="spin" />} Connect Google Drive
            </button>
          )
        )}
      </div>
    </div>
  );
}
