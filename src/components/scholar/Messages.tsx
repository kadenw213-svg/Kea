// Class-site messages like email: the messages your class site sent you, read in full; replies and new messages
// written here and sent through the class site by Kea (it presses the site's own Reply and Send); drafts kept as you
// type; and a record of what you sent, marked when the class site confirmed it.
import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Clock, FileText, Inbox, Loader2, Mail, PenSquare, RefreshCw, Reply, Send, Trash2, X } from 'lucide-react';
import { api, MailDraft, MailList, ScholarCourse } from '../../lib/api';
import { useSetting, useSettings } from '../../lib/settings';
import { toast } from '../../store';
import { useScholar } from './scholarStore';

type Box = 'inbox' | 'sent' | 'drafts';
type Compose = MailDraft & { key: string };

const when = (at: string) => {
  const d = new Date(at);
  // (The class site's own date text, as it shows it, when it isn't one Kea can read.)
  if (isNaN(d.getTime())) return at;
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

function useMail() {
  const version = useScholar((s) => s.version);
  const [mail, setMail] = useState<MailList | null>(null);
  const load = () => api.scholar.mailList().then(setMail).catch(() => setMail({ messages: [], sent: [], drafts: [], checked: null }));
  useEffect(() => {
    load();
    const off = api.scholar.onChanged(load);
    return off;
  }, [version]);
  return [mail, load] as const;
}

/** Writing a reply or a new message. Saves a draft as you type; Send goes through the class site. */
function Composer({ draft, courses, onClose, onSent }: { draft: Compose; courses: ScholarCourse[]; onClose(): void; onSent(): void }) {
  const [d, setD] = useState<Compose>(draft);
  const [sending, setSending] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => area.current?.focus(), []);
  // Drafts are saved a moment after you stop typing.
  useEffect(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => api.scholar.mailDraft(d.key, d.body.trim() ? d : null), 600);
    return () => clearTimeout(timer.current);
  }, [d]);
  const isReply = !!d.replyTo;
  const send = async () => {
    if (sending || !d.body.trim()) return;
    setSending(true);
    try {
      const r = await api.scholar.mailSend({ ...d, draftKey: d.key });
      if (r.sent) {
        toast('Sent through your class site.', 'success');
        onSent();
      } else toast(r.why || 'Your class site is open with the message filled in: check it and press Send there.', 'info');
    } catch (err: any) {
      toast(err?.message || 'Kea couldn’t send it.', 'error');
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="ml-compose" onKeyDown={(e) => (e.ctrlKey || e.metaKey) && e.key === 'Enter' && send()}>
      <div className="ml-compose-head">
        <b>{isReply ? 'Reply' : 'New message'}</b>
        <button className="icon-btn sm" title="Close (the draft is kept)" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      {!isReply && (
        <>
          <label className="ml-field">
            <span>Class</span>
            <select value={d.course} onChange={(e) => setD({ ...d, course: e.target.value })}>
              <option value="">Choose a class</option>
              {courses.map((c) => (
                <option key={c.id} value={c.code}>
                  {c.code} · {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="ml-field">
            <span>To</span>
            <input value={d.to || ''} onChange={(e) => setD({ ...d, to: e.target.value })} placeholder="Name or email, as your class site's message tool takes it" />
          </label>
          <label className="ml-field">
            <span>Subject</span>
            <input value={d.subject || ''} onChange={(e) => setD({ ...d, subject: e.target.value })} />
          </label>
        </>
      )}
      <textarea ref={area} className="ml-body" value={d.body} onChange={(e) => setD({ ...d, body: e.target.value })} placeholder={isReply ? 'Write your reply…' : 'Write your message…'} rows={10} />
      <div className="ml-compose-foot">
        <span className="muted">{sending ? 'Sending through your class site…' : 'Ctrl+Enter to send · drafts save as you type'}</span>
        <button
          className="btn sm"
          onClick={() => {
            api.scholar.mailDraft(d.key, null);
            onClose();
          }}
        >
          <Trash2 size={13} /> Discard
        </button>
        <button className="btn primary sm" disabled={sending || !d.body.trim() || (!isReply && (!d.course || !d.to?.trim()))} onClick={send}>
          {sending ? <Loader2 size={14} className="spin" /> : <Send size={14} />} Send
        </button>
      </div>
    </div>
  );
}

export function MessagesView({ courses, openId }: { courses: ScholarCourse[]; openId?: string }) {
  const [mail, reload] = useMail();
  const [box, setBox] = useState<Box>('inbox');
  const [open, setOpen] = useState<string | null>(openId || null);
  const [syncing, setSyncing] = useState(false);
  // The class site's whole mailbox, read again when this page opens (if it's been a few minutes) or on Refresh.
  const sync = (quiet = false) => {
    setSyncing(true);
    api.scholar
      .mailSync()
      .then((r) => {
        reload();
        if (!quiet && r?.unreadable) toast('Kea couldn’t read your class site’s message list this time; it kept what it had.', 'error');
      })
      .catch((err) => !quiet && toast(err?.message || 'Kea couldn’t reach your class site’s messages.', 'error'))
      .finally(() => setSyncing(false));
  };
  const checkedOnce = useRef(false);
  useEffect(() => {
    if (!mail || checkedOnce.current) return;
    checkedOnce.current = true;
    if (!mail.checked || Date.now() - new Date(mail.checked).getTime() > 5 * 60e3) sync(true);
  }, [mail]);
  useEffect(() => {
    if (openId) {
      setBox('inbox');
      setOpen(openId);
    }
  }, [openId]);
  const [full, setFull] = useState<Record<string, string>>({});
  const [reading, setReading] = useState(false);
  const [compose, setCompose] = useState<Compose | null>(null);
  const msg = mail?.messages.find((m) => m.id === open) || null;
  const sent = mail?.sent.find((m) => m.id === open) || null;
  const draft = mail?.drafts.find((m) => m.key === open) || null;

  // A message opens in full, read from the class site (kept after the first time).
  const readFull = (id: string, refresh = false) => {
    const m = mail?.messages.find((x) => x.id === id);
    if (!m) return;
    if (m.full && !refresh) return setFull((f) => ({ ...f, [id]: m.full! }));
    setReading(true);
    api.scholar
      .mailRead(id, refresh)
      .then((r) => setFull((f) => ({ ...f, [id]: r.text || m.preview })))
      .catch((err) => toast(err?.message || 'Kea couldn’t open that message.', 'error'))
      .finally(() => setReading(false));
  };
  useEffect(() => {
    if (open && box === 'inbox') {
      readFull(open);
      api.scholar.markInboxRead([open]).catch(() => {});
    }
  }, [open]);

  const list = useMemo(() => {
    if (!mail) return [];
    if (box === 'inbox') return mail.messages.map((m) => ({ id: m.id, who: [m.from, m.course].filter(Boolean).join(' · ') || 'Class site', title: m.title, sub: m.preview, at: m.at, unread: !m.read, mark: null as any }));
    if (box === 'sent') return mail.sent.map((m) => ({ id: m.id, who: [m.fromSite ? m.to : '', m.course].filter(Boolean).join(' · '), title: m.subject || '(reply)', sub: m.body, at: m.at, unread: false, mark: m.fromSite ? null : m.confirmed ? 'sent' : 'check' }));
    return mail.drafts.map((d) => ({ id: d.key, who: d.course || '', title: d.subject || (d.replyTo ? 'Reply' : 'New message'), sub: d.body, at: d.at, unread: false, mark: 'draft' }));
  }, [mail, box]);

  // A new draft starts with the signature under it (like Gmail), on replies too unless that's turned off.
  const signature = String(useSetting<string>('scholar.mailSignature') || '').trim();
  const signReplies = useSetting<boolean>('scholar.mailSignatureReplies') !== false;
  const signed = (reply: boolean) => (signature && (!reply || signReplies) ? `\n\n${signature}` : '');
  const [editSig, setEditSig] = useState<string | null>(null);
  const replyTo = (m: NonNullable<typeof msg>) => {
    const key = `reply:${m.id}`;
    const saved = mail?.drafts.find((d) => d.key === key);
    setCompose({ key, course: m.course, replyTo: m.id, subject: m.title, body: saved?.body || signed(true) });
  };

  return (
    <div className="sch-page ml-page">
      <div className="ml-top">
        <h1 className="sch-title">Messages</h1>
        <button className="btn sm" onClick={() => sync()} disabled={syncing} title={mail?.checked ? `Last read from your class site ${when(mail.checked)}` : 'Read your class site’s messages now'}>
          {syncing ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Refresh
        </button>
        <button className="btn sm" onClick={() => setEditSig(editSig === null ? signature : null)} title="The signature added under your messages">
          <FileText size={13} /> Signature
        </button>
        <button className="btn primary sm" onClick={() => setCompose({ key: `new:${Date.now().toString(36)}`, course: courses[0]?.code || '', to: '', subject: '', body: signed(false) })}>
          <PenSquare size={14} /> New message
        </button>
      </div>
      {editSig !== null && (
        <div className="ml-sig">
          <textarea value={editSig} onChange={(e) => setEditSig(e.target.value)} rows={4} placeholder={'Kaden Walsh\nStudent, CHE1011'} autoFocus />
          <label className="ml-sig-opt">
            <input type="checkbox" checked={signReplies} onChange={(e) => useSettings.getState().set({ 'scholar.mailSignatureReplies': e.target.checked })} /> Add it to replies too
          </label>
          <div className="ml-sig-btns">
            <button className="btn sm" onClick={() => setEditSig(null)}>
              Cancel
            </button>
            <button
              className="btn primary sm"
              onClick={() => {
                useSettings.getState().set({ 'scholar.mailSignature': editSig.trim() });
                setEditSig(null);
                toast('Signature saved: new messages start with it.', 'success');
              }}
            >
              Save signature
            </button>
          </div>
        </div>
      )}
      <p className="sch-sub">Your class-site messages, read and answered here. Kea sends what you write through your class site, the same as pressing Reply and Send there, and marks it sent once the site confirms.</p>
      <div className="ml-wrap">
        <aside className="ml-list">
          <div className="st-seg ml-boxes">
            {(
              [
                ['inbox', 'Inbox', Inbox, mail?.messages.filter((m) => !m.read).length || 0],
                ['sent', 'Sent', Send, 0],
                ['drafts', 'Drafts', FileText, mail?.drafts.length || 0]
              ] as const
            ).map(([b, label, Icon, n]) => (
              <button key={b} className={box === b ? 'on' : ''} onClick={() => (setBox(b), setOpen(null))}>
                <Icon size={13} /> {label}
                {n ? <span className="ml-count">{n}</span> : null}
              </button>
            ))}
          </div>
          {!mail ? (
            <div className="spinner" />
          ) : !list.length ? (
            <div className="sch-empty">
              <Mail size={22} />
              <div>{box === 'inbox' ? (syncing ? 'Reading your class site’s messages…' : 'No class-site messages yet.') : box === 'sent' ? 'Nothing sent yet.' : 'No drafts.'}</div>
            </div>
          ) : (
            list.map((m) => (
              <button key={m.id} className={`ml-row ${open === m.id ? 'on' : ''} ${m.unread ? 'unread' : ''}`} onClick={() => setOpen(m.id)}>
                <div className="ml-row-top">
                  <span className="ml-who">{m.who}</span>
                  {m.mark === 'sent' && <CheckCircle2 size={13} className="ml-ok" />}
                  {m.mark === 'check' && <Clock size={13} className="ml-warn" />}
                  <span className="muted ml-at">{m.at ? when(m.at) : ''}</span>
                </div>
                <div className="ml-title">{m.title}</div>
                <div className="muted ml-sub">{m.sub.slice(0, 120)}</div>
              </button>
            ))
          )}
        </aside>
        <section className="ml-read">
          {compose && (
            <Composer
              key={compose.key}
              draft={compose}
              courses={courses}
              onClose={() => (setCompose(null), reload())}
              onSent={() => (setCompose(null), reload(), setBox('sent'))}
            />
          )}
          {compose?.replyTo && (() => {
            const orig = mail?.messages.find((m) => m.id === compose.replyTo);
            return orig ? (
              <div className="ml-quoted">
                <div className="muted">Replying to {orig.title}</div>
                <div className="ml-text">{full[orig.id] || orig.full || orig.preview}</div>
              </div>
            ) : null;
          })()}
          {!compose && msg && box === 'inbox' && (
            <article className="ml-msg">
              <div className="ml-msg-head">
                <h2>{msg.title}</h2>
                <div className="muted">
                  {[msg.from, msg.course || 'Class site'].filter(Boolean).join(' · ')} · {isNaN(new Date(msg.at).getTime()) ? msg.at : new Date(msg.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
                </div>
              </div>
              <div className="ml-actions">
                <button className="btn primary sm" disabled={!msg.canOpen && !msg.url} title={msg.canOpen || msg.url ? '' : 'This message has no link on the class site to reply through'} onClick={() => replyTo(msg)}>
                  <Reply size={14} /> Reply
                </button>
                <button className="btn sm" onClick={() => readFull(msg.id, true)} disabled={reading || (!msg.canOpen && !msg.url)}>
                  <RefreshCw size={13} /> Reload
                </button>
                {msg.url && (
                  <button className="btn sm" onClick={() => api.scholar.openLink(msg.url)}>
                    Open on class site
                  </button>
                )}
              </div>
              {reading && !full[msg.id] ? <div className="spinner" /> : <div className="ml-text">{full[msg.id] || msg.preview}</div>}
            </article>
          )}
          {!compose && sent && box === 'sent' && (
            <article className="ml-msg">
              <div className="ml-msg-head">
                <h2>{sent.subject || 'Reply'}</h2>
                <div className="muted">
                  {sent.course}
                  {sent.to ? ` · to ${sent.to}` : ''} · {isNaN(new Date(sent.at).getTime()) ? sent.at : new Date(sent.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
                </div>
              </div>
              <div className={`ml-status ${sent.confirmed ? 'ok' : 'warn'}`}>
                {sent.fromSite ? (
                  <>
                    <CheckCircle2 size={14} /> In your class site’s Sent folder.
                    {sent.url && (
                      <button className="btn sm" onClick={() => api.scholar.openLink(sent.url!)}>
                        Open on class site
                      </button>
                    )}
                  </>
                ) : sent.confirmed ? (
                  <>
                    <CheckCircle2 size={14} /> Your class site confirmed it was sent.
                  </>
                ) : (
                  <>
                    <Clock size={14} /> Not confirmed: {sent.why || 'check your class site’s Sent folder.'}
                  </>
                )}
              </div>
              <div className="ml-text">{sent.body}</div>
            </article>
          )}
          {!compose && draft && box === 'drafts' && (
            <article className="ml-msg">
              <div className="ml-msg-head">
                <h2>{draft.subject || (draft.replyTo ? 'Reply' : 'New message')}</h2>
                <div className="muted">Draft · {draft.course}</div>
              </div>
              <div className="ml-actions">
                <button className="btn primary sm" onClick={() => setCompose({ ...draft })}>
                  <PenSquare size={14} /> Keep writing
                </button>
              </div>
              <div className="ml-text">{draft.body}</div>
            </article>
          )}
          {!compose && !msg && !sent && !draft && (
            <div className="sch-empty ml-empty">
              <Mail size={26} />
              <div>Pick a message, or write a new one.</div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
