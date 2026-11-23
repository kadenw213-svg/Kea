// A message Claude drafted (Kea 0.101.2, the draft_message tool): shown in the chat for the person to check and
// approve. Nothing is sent until they press Send. They can change the wording, untick people, send through Gmail
// (each person gets their own email), open it in their own mail app instead, or cancel.
import { useState } from 'react';
import { Mail, Send, ExternalLink, X, Check } from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../store';
import { patchChat, type ChatItem } from './assistantStore';

export function DraftCard({ it, tabId }: { it: ChatItem; tabId: string }) {
  const d = it.draft!;
  const [subject, setSubject] = useState(d.subject);
  const [body, setBody] = useState(d.body);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const to = d.recipients.filter((r) => !off.has(r.email));
  const done = (state: 'sent' | 'opened' | 'cancelled', note: string) =>
    patchChat(tabId, (c) => ({ items: c.items.map((x) => (x.id === it.id ? { ...x, draft: { ...d, subject, body, state, note } } : x)) }));

  const send = async () => {
    if (!to.length) return;
    setBusy(true);
    try {
      if (!(await api.mail.status()).connected) await api.google.connectAll();
      const r = await api.mail.send({ subject, body, recipients: to });
      const note = r.failed.length ? `Sent to ${r.sent.length}; not sent to ${r.failed.map((f) => f.email).join(', ')} (${r.failed[0].error})` : `Sent to ${r.sent.length} ${r.sent.length === 1 ? 'person' : 'people'}`;
      done('sent', note);
      toast(note, r.failed.length ? 'error' : 'success');
    } catch (err: any) {
      toast(/REFUSED|access_denied/i.test(String(err?.message)) ? 'Google didn’t let Kea send mail. You can open it in your mail app instead.' : String(err?.message || err).replace(/^.*?\[\w+\]\s*/, ''), 'error');
    } finally {
      setBusy(false);
    }
  };
  const openApp = async () => {
    await api.mail.compose({ subject, body, recipients: to });
    done('opened', `Opened in your mail app for ${to.length} ${to.length === 1 ? 'person' : 'people'} (in Bcc)`);
  };

  if (d.state)
    return (
      <div className={`as-draft finished ${d.state}`}>
        {d.state === 'cancelled' ? <X size={14} /> : <Check size={14} />}
        <span>
          <b>{d.subject}</b> · {d.state === 'cancelled' ? 'Not sent' : d.note}
        </span>
      </div>
    );

  return (
    <div className="as-draft" role="group" aria-label="Message to approve">
      <div className="as-draft-head">
        <Mail size={14} /> Message to approve
        <span className="muted">Nothing is sent until you press Send.</span>
      </div>
      <div className="as-draft-to">
        <span className="as-draft-k">To</span>
        <div className="as-draft-people">
          {d.recipients.map((r) => (
            <label key={r.email} className={`as-draft-person ${off.has(r.email) ? 'off' : ''}`} title={r.email}>
              <input
                type="checkbox"
                checked={!off.has(r.email)}
                onChange={(e) => {
                  const next = new Set(off);
                  e.target.checked ? next.delete(r.email) : next.add(r.email);
                  setOff(next);
                }}
              />
              {r.name || r.email}
              <span className="muted">{r.name ? r.email : ''}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="as-draft-to">
        <span className="as-draft-k">Subject</span>
        <input className="input sm" value={subject} onChange={(e) => setSubject(e.target.value)} />
      </div>
      <textarea className="input as-draft-body" rows={Math.min(12, Math.max(4, body.split('\n').length + 1))} value={body} onChange={(e) => setBody(e.target.value)} />
      {/\{(first|name)\}/.test(body + subject) && <div className="muted as-draft-hint">{'{first}'} becomes each person’s first name.</div>}
      <div className="as-draft-acts">
        <button className="btn primary sm" disabled={busy || !to.length} onClick={send} title="Through your Gmail: each person gets their own email">
          <Send size={13} /> Send to {to.length} {to.length === 1 ? 'person' : 'people'}
        </button>
        <button className="btn sm" disabled={busy || !to.length} onClick={openApp} title="Your own mail app, with everyone in Bcc">
          <ExternalLink size={13} /> Open in my mail app
        </button>
        <button className="btn ghost sm" disabled={busy} onClick={() => done('cancelled', '')}>
          Cancel
        </button>
      </div>
    </div>
  );
}
