import { useEffect, useState } from 'react';
import { Copy, Trash2, ExternalLink, Check } from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../store';
import './control.css';

type Status = { enabled: boolean; url: string | null; clients: { id: string; name: string; createdAt: string; lastUsed: string | null }[] };

/** Settings → Connect an app: turn the MCP control server on, mint/revoke per-app keys, see the ready-to-paste config. */
export function ControlPanel() {
  const [st, setSt] = useState<Status | null>(null);
  const [name, setName] = useState('');
  const [config, setConfig] = useState('');
  const [configStdio, setConfigStdio] = useState('');
  const [mode, setMode] = useState<'http' | 'stdio'>('http');
  const [copied, setCopied] = useState(false);

  const refresh = () => api.control.status().then(setSt);
  useEffect(() => {
    refresh();
  }, []);
  if (!st) return null;

  const toggle = async (on: boolean) => {
    await api.control.setEnabled(on);
    if (!on) setConfig('');
    refresh();
  };
  const add = async () => {
    const r = await api.control.addClient(name.trim() || 'App');
    setName('');
    setConfig(r.config);
    setConfigStdio(r.configStdio);
    refresh();
  };
  const revoke = async (id: string) => {
    await api.control.revokeClient(id);
    refresh();
  };
  const shown = mode === 'http' ? config : configStdio;
  const copy = () => {
    navigator.clipboard.writeText(shown).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'never used');

  return (
    <div className="control-panel">
      <label className="toggle big">
        <input type="checkbox" checked={st.enabled} onChange={(e) => toggle(e.target.checked)} />
        <span>Allow connected apps to control Kea</span>
      </label>
      {st.enabled && st.url && (
        <div className="muted small control-url">
          Running on <code>{st.url}</code> (this computer only)
        </div>
      )}

      <div className="control-section-title">Connected apps</div>
      {st.clients.length === 0 && <p className="muted small">None yet. Add one to get a key and a ready-to-paste setup.</p>}
      {st.clients.map((c) => (
        <div className="control-client" key={c.id}>
          <div>
            <div className="control-client-name">{c.name}</div>
            <div className="muted small">Added {new Date(c.createdAt).toLocaleDateString()} · last used {when(c.lastUsed)}</div>
          </div>
          <button className="icon-btn sm" title="Revoke this app’s key" onClick={() => revoke(c.id)}>
            <Trash2 size={15} />
          </button>
        </div>
      ))}

      <div className="control-add">
        <input className="input" placeholder="New app’s name (e.g. My video pipeline)" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
        <button className="btn primary sm" onClick={add}>
          Add a connection
        </button>
      </div>

      {config && (
        <div className="control-config">
          <div className="control-config-head">
            <div className="seg">
              <button className={mode === 'http' ? 'on' : ''} onClick={() => setMode('http')}>
                HTTP (Claude Code, your app)
              </button>
              <button className={mode === 'stdio' ? 'on' : ''} onClick={() => setMode('stdio')}>
                stdio (Claude Desktop, OpenAI)
              </button>
            </div>
            <button className="btn sm tonal" onClick={copy}>
              {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <pre className="control-config-box">{shown}</pre>
          <div className="muted small">
            The key is shown once — copy it now.{' '}
            {mode === 'http' ? (
              <>
                For Claude Code, save it and run with <code>--mcp-config &lt;file&gt; --strict-mcp-config</code>; or add the <code>kea</code> server to any app that speaks HTTP MCP.
              </>
            ) : (
              <>Add the <code>kea</code> server to the app’s MCP settings. It launches a small bridge (needs Node). Keep Kea open with this turned on.</>
            )}
          </div>
        </div>
      )}

      <p className="muted small control-foot">
        <ExternalLink size={12} /> A connected app can read the file you have open and change it with the editor’s tools — each change one Ctrl+Z. It never runs on its own: you turn this on, and you can revoke any app or press Stop on the banner at any time. The Claude sidebar and the Encyclopedia are unaffected.
      </p>
    </div>
  );
}
