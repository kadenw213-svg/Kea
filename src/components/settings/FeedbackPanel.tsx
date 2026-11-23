import { useEffect, useState } from 'react';
import { Bug, Lightbulb, MessageSquare, Send, Copy } from 'lucide-react';
import { api } from '../../lib/api';
import { toast, useTabs } from '../../store';
import { NeedsOnline } from '../account/NeedsOnline';
import { loadLocal, refreshHub, useHubStatus } from '../account/hubStore';
import { feedbackContext } from '../../lib/activity';
import { setting } from '../../lib/settings';

const REPO = 'https://github.com/kadenw213-svg/kea';
// Browsers and GitHub cut off very long links; longer reports go through the clipboard instead.
const MAX_URL = 7500;
// What the Kea account server keeps (docs/protocol.md in KeaC, Feedback).
const MAX_SUMMARY = 120;
const MAX_DETAILS = 10_000;
const MAX_INFO = 1000;
const MAX_LOG = 8000;

type Kind = 'bug' | 'idea' | 'other';
const KINDS: { id: Kind; label: string; icon: JSX.Element; title: string; placeholder: string }[] = [
  { id: 'bug', label: 'Report a bug', icon: <Bug size={16} />, title: 'What went wrong?', placeholder: 'What did you do, what did you expect, and what happened instead? Steps to make it happen again help a lot.' },
  { id: 'idea', label: 'Request a feature', icon: <Lightbulb size={16} />, title: 'What would you like Kea to do?', placeholder: 'Describe the feature and how you would use it.' },
  { id: 'other', label: 'Something else', icon: <MessageSquare size={16} />, title: 'Your feedback', placeholder: 'Anything you want to tell us.' }
];

const timeOf = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/**
 * Settings → Feedback. Signed in to a Kea account, a report goes straight to Kea's developer through the Kea account
 * server (POST /v1/feedback). Not signed in, or a server too old for it (404): the report opens as a pre-filled issue
 * on Kea's GitHub page instead, and nothing is sent until you press "Submit" there.
 */
export function FeedbackPanel() {
  const [kind, setKind] = useState<Kind>('bug');
  const [summary, setSummary] = useState('');
  const [details, setDetails] = useState('');
  const [withInfo, setWithInfo] = useState(true);
  const [withLog, setWithLog] = useState(false);
  // What they were doing (Kea 0.101): where they were and their last screens and tools. Settings → Privacy sets the default.
  const [withDoing, setWithDoing] = useState(setting('feedback.includeActivity') !== false);
  const [showDoing, setShowDoing] = useState(false);
  const [sending, setSending] = useState(false);
  // A plain line under the buttons: the limit was reached, or the report went to GitHub instead.
  const [note, setNote] = useState<{ text: string; warn?: boolean } | null>(null);
  const [info, setInfo] = useState<Awaited<ReturnType<typeof api.sysinfo>> | null>(null);
  const status = useHubStatus();
  const signedIn = !!status?.signedIn;
  useEffect(() => {
    api.sysinfo().then(setInfo).catch(() => {});
    if (!status) loadLocal();
  }, []);
  const k = KINDS.find((x) => x.id === kind)!;
  const activeKind = useTabs.getState().tabs.find((t) => t.id === useTabs.getState().activeId)?.kind;

  const infoLine = () => (info ? `Kea ${info.version} · ${info.os} · ${info.cpu} · ${info.ramGb} GB RAM · Electron ${info.electron}${activeKind ? ` · open: ${activeKind}` : ''}` : '');
  const includeLog = kind === 'bug' && withLog && !!info?.logTail;
  const body = () => {
    let b = details.trim() || '_No details given._';
    if (withInfo && info) b += `\n\n---\n**Kea** ${infoLine()}`;
    if (includeLog) b += `\n\n<details><summary>Troubleshooting log (last lines)</summary>\n\n\`\`\`\n${info!.logTail}\n\`\`\`\n</details>`;
    return b;
  };
  const title = () => `${kind === 'bug' ? '[Bug] ' : kind === 'idea' ? '[Feature] ' : ''}${summary.trim()}`;
  const copy = async () => {
    await navigator.clipboard.writeText(`${title()}\n\n${body()}`);
    toast('Report copied', 'success');
  };
  /** The old way: a pre-filled issue on Kea's GitHub page, opened in the browser. */
  const openGithub = async () => {
    const labels = kind === 'bug' ? 'bug' : kind === 'idea' ? 'enhancement' : '';
    const make = (b: string) => `${REPO}/issues/new?title=${encodeURIComponent(title())}&body=${encodeURIComponent(b)}${labels ? `&labels=${labels}` : ''}`;
    let url = make(body());
    if (url.length > MAX_URL) {
      await navigator.clipboard.writeText(body());
      url = make('_The full report is on the clipboard: press Ctrl+V here to paste it._');
      toast('Your report is long, so it was copied. Paste it into the page that opens (Ctrl+V).');
    }
    window.open(url);
  };
  const doing = () =>
    feedbackContext({
      version: info?.version,
      os: info?.os,
      settings: { theme: String(setting('appearance.theme') || 'dark'), backdrop: String(setting('appearance.backdrop') || 'photos'), provider: String(setting('assistant.provider') || 'plan') }
    });
  const send = async () => {
    setSending(true);
    setNote(null);
    try {
      const r = await api.hub.feedback({
        kind,
        summary: summary.trim(),
        details: details.trim(),
        info: withInfo && info ? infoLine().slice(0, MAX_INFO) : undefined,
        // (The end of the log: the newest lines.)
        log: includeLog ? info!.logTail!.slice(-MAX_LOG) : undefined,
        context: withDoing ? doing() : undefined
      });
      if (r.ok) {
        toast('Sent. Thanks — the developer reads every report.', 'success');
        setSummary('');
        setDetails('');
        setWithLog(false);
        return;
      }
      if (r.status === 404) {
        // (A Kea account server from before reports: the GitHub page, as before.)
        setNote({ text: 'Your Kea account server can’t take reports yet, so this one opened on Kea’s GitHub page instead. Press Submit there to send it.' });
        await openGithub();
        return;
      }
      if (r.status === 429) {
        const until = typeof r.data?.until === 'number' ? r.data.until : null;
        const text = `${r.error}${until ? ` You can send again at ${timeOf(until)}.` : ''}`;
        setNote({ text, warn: true });
        toast(text, 'error');
        return;
      }
      if (r.status === 401) refreshHub();
      toast(r.error, r.status === 0 ? 'info' : 'error');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="feedback">
      <p className="sblurb">
        Found a bug, or have an idea or request? Write it here and press <b>Send</b>. It goes straight to Kea’s developer, with your Kea account’s name and email so they know who sent it.
      </p>
      <div className="fb-kinds">
        {KINDS.map((x) => (
          <button key={x.id} className={`fb-kind ${kind === x.id ? 'on' : ''}`} onClick={() => setKind(x.id)}>
            {x.icon} {x.label}
          </button>
        ))}
      </div>
      <label className="fb-label">Summary</label>
      <input className="input" value={summary} maxLength={MAX_SUMMARY} placeholder={kind === 'bug' ? 'e.g. The Insert button doesn’t work in spreadsheets' : 'One line'} onChange={(e) => setSummary(e.target.value)} />
      <label className="fb-label">{k.title}</label>
      <textarea className="input fb-text" rows={7} value={details} maxLength={MAX_DETAILS} placeholder={k.placeholder} onChange={(e) => setDetails(e.target.value)} />
      <label className="fb-check">
        <input type="checkbox" checked={withInfo} onChange={(e) => setWithInfo(e.target.checked)} /> Include Kea version and PC details
        {info && <span className="muted"> ({info.version}, {info.os}, {info.ramGb} GB RAM)</span>}
      </label>
      <label className="fb-check">
        <input type="checkbox" checked={withDoing} onChange={(e) => setWithDoing(e.target.checked)} /> Include what I was doing in Kea
        <span className="muted">
          {' '}
          (where you were and your last screens and tools; never file names or contents){' '}
          <a href="#" onClick={(e) => (e.preventDefault(), setShowDoing(!showDoing))}>
            {showDoing ? 'Hide' : 'See it'}
          </a>
        </span>
      </label>
      {showDoing && <pre className="fb-doing">{JSON.stringify(doing(), null, 2)}</pre>}
      {kind === 'bug' && (
        <label className="fb-check">
          <input type="checkbox" checked={withLog} onChange={(e) => setWithLog(e.target.checked)} /> Include the troubleshooting log
          <span className="muted"> (recent errors; may contain file names, so check it before sending)</span>
        </label>
      )}
      {!signedIn && <NeedsOnline what="Sending feedback to Kea’s developer" />}
      <div className="fb-actions">
        {signedIn && (
          <button className="btn primary" disabled={!summary.trim() || sending} onClick={send}>
            <Send size={14} /> {sending ? 'Sending…' : 'Send'}
          </button>
        )}
        <button className="btn" disabled={!summary.trim() && !details.trim()} onClick={copy}>
          <Copy size={14} /> Copy report
        </button>
        <span style={{ flex: 1 }} />
        {!signedIn && (
          <button className="link-btn" disabled={!summary.trim()} onClick={openGithub}>
            Or open it on GitHub
          </button>
        )}
      </div>
      {note && <p className={`fb-note ${note.warn ? 'warn' : ''}`}>{note.text}</p>}
    </div>
  );
}
