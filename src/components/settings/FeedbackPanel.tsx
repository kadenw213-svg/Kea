import { useEffect, useState } from 'react';
import { Bug, Lightbulb, MessageSquare, ExternalLink, Copy } from 'lucide-react';
import { api } from '../../lib/api';
import { toast, useTabs } from '../../store';

const REPO = 'https://github.com/kadenw213-svg/slate-office';
// Browsers and GitHub cut off very long links; longer reports go through the clipboard instead.
const MAX_URL = 7500;

type Kind = 'bug' | 'idea' | 'other';
const KINDS: { id: Kind; label: string; icon: JSX.Element; title: string; placeholder: string }[] = [
  { id: 'bug', label: 'Report a bug', icon: <Bug size={16} />, title: 'What went wrong?', placeholder: 'What did you do, what did you expect, and what happened instead? Steps to make it happen again help a lot.' },
  { id: 'idea', label: 'Request a feature', icon: <Lightbulb size={16} />, title: 'What would you like Slate to do?', placeholder: 'Describe the feature and how you would use it.' },
  { id: 'other', label: 'Something else', icon: <MessageSquare size={16} />, title: 'Your feedback', placeholder: 'Anything you want to tell us.' }
];

/**
 * Settings → Feedback. Slate has no servers, so a report becomes a pre-filled issue on the project's GitHub
 * page, opened in your browser. Nothing is sent until you press "Submit" there.
 */
export function FeedbackPanel() {
  const [kind, setKind] = useState<Kind>('bug');
  const [summary, setSummary] = useState('');
  const [details, setDetails] = useState('');
  const [withInfo, setWithInfo] = useState(true);
  const [withLog, setWithLog] = useState(false);
  const [info, setInfo] = useState<Awaited<ReturnType<typeof api.sysinfo>> | null>(null);
  useEffect(() => {
    api.sysinfo().then(setInfo).catch(() => {});
  }, []);
  const k = KINDS.find((x) => x.id === kind)!;
  const activeKind = useTabs.getState().tabs.find((t) => t.id === useTabs.getState().activeId)?.kind;

  const body = () => {
    let b = details.trim() || '_No details given._';
    if (withInfo && info)
      b += `\n\n---\n**Slate** ${info.version} · ${info.os} · ${info.cpu} · ${info.ramGb} GB RAM · Electron ${info.electron}${activeKind ? ` · open: ${activeKind}` : ''}`;
    if (withLog && info?.logTail) b += `\n\n<details><summary>Troubleshooting log (last lines)</summary>\n\n\`\`\`\n${info.logTail}\n\`\`\`\n</details>`;
    return b;
  };
  const title = () => `${kind === 'bug' ? '[Bug] ' : kind === 'idea' ? '[Feature] ' : ''}${summary.trim()}`;
  const copy = async () => {
    await navigator.clipboard.writeText(`${title()}\n\n${body()}`);
    toast('Report copied', 'success');
  };
  const submit = async () => {
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

  return (
    <div className="feedback">
      <p className="sblurb">
        Found a bug or have an idea? Tell us. Your report opens as a pre-filled page on Slate's GitHub, where you can check it and press <b>Submit</b>. It needs a free GitHub account, and nothing is sent until you submit.
      </p>
      <div className="fb-kinds">
        {KINDS.map((x) => (
          <button key={x.id} className={`fb-kind ${kind === x.id ? 'on' : ''}`} onClick={() => setKind(x.id)}>
            {x.icon} {x.label}
          </button>
        ))}
      </div>
      <label className="fb-label">Summary</label>
      <input className="input" value={summary} maxLength={120} placeholder={kind === 'bug' ? 'e.g. The Insert button doesn’t work in spreadsheets' : 'One line'} onChange={(e) => setSummary(e.target.value)} />
      <label className="fb-label">{k.title}</label>
      <textarea className="input fb-text" rows={7} value={details} placeholder={k.placeholder} onChange={(e) => setDetails(e.target.value)} />
      <label className="fb-check">
        <input type="checkbox" checked={withInfo} onChange={(e) => setWithInfo(e.target.checked)} /> Include Slate version and basic PC details
        {info && <span className="muted"> ({info.version}, {info.os}, {info.ramGb} GB RAM)</span>}
      </label>
      {kind === 'bug' && (
        <label className="fb-check">
          <input type="checkbox" checked={withLog} onChange={(e) => setWithLog(e.target.checked)} /> Include the troubleshooting log
          <span className="muted"> (recent errors; may contain file names, so check it before submitting)</span>
        </label>
      )}
      <div className="fb-actions">
        <button className="btn primary" disabled={!summary.trim()} onClick={submit}>
          <ExternalLink size={14} /> Continue on GitHub
        </button>
        <button className="btn" disabled={!summary.trim() && !details.trim()} onClick={copy}>
          <Copy size={14} /> Copy report
        </button>
        <span style={{ flex: 1 }} />
        <a href={`${REPO}/issues`} target="_blank" className="link-btn">
          See existing reports
        </a>
      </div>
    </div>
  );
}
