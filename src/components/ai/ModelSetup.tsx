import { Download, Pause, Play, Cpu, CheckCircle2 } from 'lucide-react';
import { openSettings } from '../../lib/settings';
import { useAi } from './aiStore';
import { api, AiModelState } from '../../lib/api';

const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;

export function DownloadProgress({ m }: { m: AiModelState }) {
  const d = m.download!;
  const p = d.total ? Math.round((d.received / d.total) * 100) : 0;
  return (
    <div className="dl">
      <div className="progress">
        <div style={{ width: `${d.status === 'verifying' ? 100 : p}%` }} />
      </div>
      <div className="dl-meta">
        {d.status === 'verifying' ? 'Checking the download…' : d.status === 'error' ? <span style={{ color: 'var(--danger)' }}>{d.error}</span> : `${gb(d.received)} of ${gb(d.total)} · ${p}%`}
        {d.status === 'downloading' && (
          <button className="link-btn" onClick={() => api.ai.pauseDownload(m.tier)}>
            <Pause size={12} /> Pause
          </button>
        )}
        {(d.status === 'paused' || d.status === 'error') && (
          <button className="link-btn" onClick={() => api.ai.download(m.tier)}>
            <Play size={12} /> Resume
          </button>
        )}
      </div>
    </div>
  );
}

/** First-run card shown inside the sidebar (no popups). */
export function ModelSetup() {
  const ai = useAi();
  const st = ai.state;
  if (!st) return null;
  const rec = st.models.find((m) => m.tier === st.settings.tier) || st.models[1];
  const hw = st.hardware;
  const busy = st.models.find((m) => m.download && m.download.status !== 'done');
  return (
    <div className="setup">
      <div className="setup-icon">
        <Cpu size={22} />
      </div>
      <h3>AI that runs on your computer</h3>
      <p>
        Slate's AI works offline and never uploads your files. It needs a one-time model download. Based on your PC
        <span className="hw"> ({Math.round(hw.ramTotal / 1024 ** 3)} GB RAM{hw.gpu ? `, ${hw.gpuNames[0] || hw.gpu} graphics` : ''})</span>, we recommend:
      </p>
      <div className="setup-model">
        <div>
          <b>{rec.label}</b> · {rec.model}
          <div className="muted">
            {gb(rec.size)} · {rec.blurb}
          </div>
        </div>
        {rec.installed && <CheckCircle2 size={18} color="var(--success)" />}
      </div>
      {busy?.download ? (
        <>
          <div className="muted" style={{ marginBottom: 6 }}>
            Downloading {busy.label}… you can keep working.
          </div>
          <DownloadProgress m={busy} />
        </>
      ) : (
        <div className="setup-actions">
          <button className="btn primary sm" onClick={() => api.ai.download(rec.tier)}>
            <Download size={14} /> Download {rec.label} ({gb(rec.size)})
          </button>
          <button className="btn sm" onClick={() => openSettings('ai')}>
            Choose another
          </button>
        </div>
      )}
    </div>
  );
}
