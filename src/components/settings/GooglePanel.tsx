import { useEffect, useState } from 'react';
import { ExternalLink, LogIn, LogOut, CheckCircle2, Loader2 } from 'lucide-react';
import { api } from '../../lib/api';
import { useSettings, useSetting } from '../../lib/settings';
import { toast } from '../../store';
import { DriveLogo } from '../home/DriveLogo';

const STEPS: { title: string; body: string; url?: string; link?: string }[] = [
  { title: 'Create a free Google Cloud project', body: 'Sign in with the Google account you use for Drive, name the project “Slate”, and click Create.', url: 'https://console.cloud.google.com/projectcreate', link: 'Create project' },
  { title: 'Turn on the Google Drive API', body: 'With the Slate project selected, click Enable.', url: 'https://console.cloud.google.com/apis/library/drive.googleapis.com', link: 'Open Drive API' },
  {
    title: 'Set up the sign-in screen',
    body: 'Click Get started. App name: Slate. Pick your email for support and contact. Audience: External. Then under Audience, click Publish app so your sign-in doesn’t expire every 7 days.',
    url: 'https://console.cloud.google.com/auth/branding',
    link: 'Open sign-in settings'
  },
  { title: 'Create a desktop client', body: 'Click Create client → Application type: Desktop app → name it Slate → Create. Copy the Client ID and Client secret into the boxes below.', url: 'https://console.cloud.google.com/auth/clients', link: 'Open clients' },
  { title: 'Sign in', body: 'Click “Sign in with Google”. Google will say the app isn’t verified. That’s expected for your own private app: click Advanced → Go to Slate → Continue.' }
];

export function GooglePanel() {
  const clientId = useSetting<string>('google.clientId');
  const clientSecret = useSetting<string>('google.clientSecret');
  const [status, setStatus] = useState<{ configured: boolean; signedIn: boolean; email: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => api.google.status().then(setStatus);
  useEffect(() => {
    refresh();
  }, [clientId, clientSecret]);

  const signIn = async () => {
    setBusy(true);
    try {
      toast('Finish signing in in your browser…');
      const who = await api.google.signIn();
      toast(`Signed in${who.email ? ` as ${who.email}` : ''}`, 'success');
    } catch (err: any) {
      toast(String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '').replace(/^\[[A-Z_]+\] /, ''), 'error');
    } finally {
      setBusy(false);
      refresh();
    }
  };

  return (
    <div className="gpanel">
      <div className="gcard">
        <DriveLogo id="gdrive" size={30} />
        <div className="gcard-main">
          <div className="gcard-title">Google Docs, Sheets &amp; Slides</div>
          <div className="muted">
            {status?.signedIn ? (
              <>
                <CheckCircle2 size={13} color="var(--success)" style={{ verticalAlign: -2 }} /> Signed in{status.email ? ` as ${status.email}` : ''}. Google files open in Slate and save back to Google Drive.
              </>
            ) : status?.configured ? (
              'Ready to sign in.'
            ) : (
              'Open .gdoc, .gsheet and .gslides files from Google Drive right here. One-time setup below.'
            )}
          </div>
        </div>
        {status?.signedIn ? (
          <button
            className="btn sm"
            onClick={async () => {
              await api.google.signOut();
              refresh();
            }}
          >
            <LogOut size={14} /> Sign out
          </button>
        ) : (
          <button className="btn sm primary" disabled={!status?.configured || busy} onClick={signIn}>
            {busy ? <Loader2 size={14} className="spin" /> : <LogIn size={14} />} Sign in with Google
          </button>
        )}
      </div>

      {!status?.signedIn && (
        <div className="gsetup">
          <div className="gsetup-head">One-time setup (about 5 minutes)</div>
          <p className="muted gsetup-why">
            Google only lets apps read your Drive with their own “key”. Because Slate has no servers or accounts, you create a free, private key for yourself. Only you use it, and your
            files go straight between this PC and Google.
          </p>
          <ol className="gsteps">
            {STEPS.map((s, i) => (
              <li key={i}>
                <div className="gstep-title">{s.title}</div>
                <div className="gstep-body">{s.body}</div>
                {s.url && (
                  <a href={s.url} target="_blank" className="gstep-link">
                    {s.link} <ExternalLink size={12} />
                  </a>
                )}
                {i === 3 && (
                  <div className="gfields">
                    <label>
                      <span>Client ID</span>
                      <input className="input sm" value={clientId} placeholder="1234…apps.googleusercontent.com" onChange={(e) => useSettings.getState().set({ 'google.clientId': e.target.value.trim() })} />
                    </label>
                    <label>
                      <span>Client secret</span>
                      <input className="input sm" type="password" value={clientSecret} placeholder="GOCSPX-…" onChange={(e) => useSettings.getState().set({ 'google.clientSecret': e.target.value.trim() })} />
                    </label>
                  </div>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
