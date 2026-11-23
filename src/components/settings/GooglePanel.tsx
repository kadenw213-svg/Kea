// Settings → Google: one card, one button (Kea 0.102.1). "Connect Google" links everything Kea uses Google for in one
// consent: Drive (Docs, Sheets and Slides open in Kea and save back), Contacts (read-only, so Claude can find people)
// and Gmail send-only (messages Claude drafted, sent only after you approve them). Kea uses its own built-in Google
// client (the same as "Sign in with Google"), so there is nothing to set up.
import { useEffect, useState } from 'react';
import { Check, ExternalLink, Loader2, LogOut, Minus } from 'lucide-react';
import { api } from '../../lib/api';
import { DriveLogo } from '../home/DriveLogo';
import { toast } from '../../store';

type S = { configured: boolean; drive: boolean; email: string | null; contacts: boolean; mail: boolean };

export function GooglePanel() {
  const [s, setS] = useState<S | null>(null);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const refresh = async () => {
    const [g, c, m] = await Promise.all([api.google.status(), api.contacts.status().catch(() => ({ connected: false })), api.mail.status().catch(() => ({ connected: false }))]);
    setS({ configured: g.configured, drive: g.signedIn, email: g.email, contacts: c.connected, mail: m.connected });
  };
  useEffect(() => {
    refresh();
  }, []);

  const connect = async () => {
    setBusy(true);
    setRefused(null);
    try {
      const r = await api.google.connectAll();
      toast(`Connected${r.email ? ` as ${r.email}` : ''}`, 'success');
    } catch (err: any) {
      const m = String(err?.message || err);
      setRefused(/REFUSED|access_denied|denied/i.test(m) ? 'Google didn’t finish connecting. Press Connect Google again and allow every box on Google’s page.' : m.replace(/^.*?\[\w+\]\s*/, ''));
    } finally {
      setBusy(false);
      refresh();
    }
  };
  const disconnect = async () => {
    await Promise.all([api.google.signOut(), api.contacts.disconnect().catch(() => null), api.mail.disconnect().catch(() => null)]);
    refresh();
  };

  const all = !!s && s.drive && s.contacts && s.mail;
  const any = !!s && (s.drive || s.contacts || s.mail);
  const Row = ({ on, label, what }: { on: boolean; label: string; what: string }) => (
    <div className={`gpart ${on ? 'on' : ''}`}>
      {on ? <Check size={13} /> : <Minus size={13} />}
      <span className="gpart-label">{label}</span>
      <span className="muted">{what}</span>
    </div>
  );

  return (
    <div className="gpanel">
      <div className="gcard">
        <DriveLogo id="gdrive" size={30} />
        <div className="gcard-main">
          <div className="gcard-title">Google</div>
          <div className="muted">
            {s && !s.configured
              ? 'Google isn’t available in this copy of Kea yet. Google files open in your browser.'
              : any
                ? `Connected${s?.email ? ` as ${s.email}` : ''}.`
                : 'One click links your Google account to Kea. You choose on Google’s own page.'}
          </div>
          {s?.configured && (
            <div className="gparts">
              <Row on={s.drive} label="Drive" what="Docs, Sheets and Slides open in Kea and save back" />
              <Row on={s.contacts} label="Contacts" what="Claude can find people’s emails and phone numbers (read-only)" />
              <Row on={s.mail} label="Gmail, send only" what="Messages Claude drafts go out after you press Send. Kea never reads your mail." />
            </div>
          )}
          {refused && (
            <div className="muted gcard-note">
              <ExternalLink size={12} style={{ verticalAlign: -1 }} /> {refused}
            </div>
          )}
        </div>
        <div className="gcard-acts">
          {s?.configured && !all && (
            <button className="btn sm primary" disabled={busy} onClick={connect}>
              {busy && <Loader2 size={14} className="spin" />} {any ? 'Connect the rest' : 'Connect Google'}
            </button>
          )}
          {any && (
            <button className="btn sm" onClick={disconnect}>
              <LogOut size={14} /> Disconnect
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
