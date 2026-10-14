import { useEffect, useState } from 'react';
import { Download, Trash2, CheckCircle2, Gauge, RotateCcw, Cpu, MonitorSmartphone } from 'lucide-react';
import { useAi } from './aiStore';
import { useSetting, useSettings } from '../../lib/settings';
import { api, AiSettings as Settings, AiTier } from '../../lib/api';
import { DownloadProgress } from './ModelSetup';
import { toast, ask } from '../../store';

const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;
const SLIDER_LABELS = ['Fastest', 'Fast', 'Balanced', 'High quality', 'Best quality'];

/** AI section of the Settings window. */
export function AiSettingsPanel() {
  const ai = useAi();
  const [bench, setBench] = useState<{ loadMs: number; tokensPerSecond: number } | null>(null);
  const [benching, setBenching] = useState(false);
  const advanced = useSetting<boolean>('ui.showAdvanced');
  const setAdvanced = (fn: (a: boolean) => boolean) => useSettings.getState().set({ 'ui.showAdvanced': fn(!!advanced) });

  useEffect(() => {
    api.ai.state().then((state) => ai.set({ state }));
  }, []);

  if (!ai.state) return <div className="muted">Loading…</div>;
  const st = ai.state;
  const s = st.settings;
  const update = async (patch: Partial<Settings>) => {
    const settings = await api.ai.setSettings(patch);
    ai.set({ state: { ...st, settings } });
    setBench(null);
  };
  const hw = st.hardware;
  const ramGb = hw.ramTotal / 1024 ** 3;

  const runBench = async () => {
    setBenching(true);
    try {
      setBench(await api.ai.benchmark());
    } catch (err: any) {
      toast(err.message?.includes('NO_MODEL') ? 'Download the selected model first.' : `Benchmark failed: ${err.message}`, 'error');
    } finally {
      setBenching(false);
    }
  };

  return (
    <div className="ai-settings embedded">
      <div>

        <div className="hw-card">
          <MonitorSmartphone size={18} />
          <div>
            <div>{hw.cpuName || 'This PC'}</div>
            <div className="muted">
              {Math.round(ramGb)} GB RAM · {hw.cpuThreads} threads · {hw.gpu ? `${hw.gpuNames[0] || 'GPU'} (${String(hw.gpu).toUpperCase()}${hw.unified ? ', shared memory' : hw.vramTotal ? `, ${gb(hw.vramTotal)}` : ''})` : 'no GPU acceleration'}
            </div>
          </div>
        </div>

        <div className="set-section">
          <div className="set-label">
            Speed ⟷ quality <span className="muted">· recommended for this PC: {SLIDER_LABELS[st.recommended.slider]}</span>
          </div>
          <input type="range" min={0} max={4} step={1} value={s.custom ? -1 : s.slider} onChange={(e) => update({ slider: +e.target.value, custom: false })} className="quality" />
          <div className="quality-labels">
            {SLIDER_LABELS.map((l, i) => (
              <span key={l} className={!s.custom && s.slider === i ? 'on' : ''}>
                {l}
              </span>
            ))}
          </div>
          <div className="muted" style={{ marginTop: 6 }}>
            Higher quality uses a bigger model and reads more of long documents at once, but answers take longer.
            {s.custom && ' (Custom settings in use.)'}
          </div>
        </div>

        <div className="set-section">
          <div className="set-label">Models</div>
          {st.models.map((m) => (
            <div key={m.tier} className={`model-row ${s.tier === m.tier ? 'sel' : ''}`}>
              <div className="model-info">
                <div>
                  <b>{m.label}</b> · {m.model} {s.tier === m.tier && <span className="ai-badge">in use</span>}
                </div>
                <div className="muted">
                  {gb(m.size)} · {m.blurb} {ramGb < m.minRam ? `· needs ${m.minRam} GB RAM` : ''}
                </div>
                {m.download && m.download.status !== 'done' && <DownloadProgress m={m} />}
              </div>
              <div className="model-actions">
                {m.installed ? (
                  <>
                    {s.tier !== m.tier && (
                      <button className="btn sm tonal" onClick={() => update({ tier: m.tier as AiTier, custom: true })}>
                        Use
                      </button>
                    )}
                    <CheckCircle2 size={16} color="var(--success)" />
                    <button
                      className="icon-btn sm"
                      title="Delete model"
                      onClick={async () => {
                        const ok = await ask(`Delete ${m.label} model?`, `This frees ${gb(m.size)}. You can download it again later.`, [
                          { id: 'cancel', label: 'Cancel' },
                          { id: 'del', label: 'Delete', danger: true, primary: true }
                        ]);
                        if (ok === 'del') {
                          await api.ai.deleteModel(m.tier);
                          ai.set({ state: await api.ai.state() });
                        }
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </>
                ) : (
                  !m.download && (
                    <button className="btn sm tonal" onClick={() => api.ai.download(m.tier)}>
                      <Download size={13} /> {gb(m.size)}
                    </button>
                  )
                )}
              </div>
            </div>
          ))}
          <div className="muted" style={{ fontSize: 11.5 }}>
            Models come from Hugging Face and are checked after download. Licenses: Qwen (Apache-2.0), Llama 3.2 (Llama Community License).
          </div>
        </div>

        <div className="set-section">
          <div className="set-row">
            <button className="btn sm tonal" onClick={runBench} disabled={benching}>
              <Gauge size={14} /> {benching ? 'Testing…' : 'Test speed'}
            </button>
            {bench && (
              <span className="muted">
                {bench.tokensPerSecond.toFixed(1)} words-ish/sec · a summary takes about {Math.max(2, Math.round(350 / Math.max(1, bench.tokensPerSecond)))} s · model loaded in {(bench.loadMs / 1000).toFixed(1)} s
              </span>
            )}
          </div>
        </div>

        <button className="link-btn" style={{ padding: 0, marginBottom: 8 }} onClick={() => setAdvanced((a) => !a)}>
          {advanced ? 'Hide' : 'Show'} advanced settings
        </button>
        {advanced && (
          <div className="set-section adv">
            <label className="set-row">
              <span>
                <Cpu size={13} /> GPU acceleration
              </span>
              <input type="checkbox" checked={s.gpu} onChange={(e) => update({ gpu: e.target.checked, custom: true })} />
            </label>
            <label className="set-row">
              <span>GPU layers</span>
              <select className="select" value={String(s.gpuLayers)} disabled={!s.gpu} onChange={(e) => update({ gpuLayers: e.target.value === 'auto' ? 'auto' : +e.target.value, custom: true })}>
                <option value="auto">Automatic</option>
                {[0, 8, 16, 24, 32, 99].map((n) => (
                  <option key={n} value={n}>
                    {n === 99 ? 'All' : n}
                  </option>
                ))}
              </select>
            </label>
            <label className="set-row">
              <span>CPU threads</span>
              <select className="select" value={s.threads} onChange={(e) => update({ threads: +e.target.value, custom: true })}>
                <option value={0}>Automatic</option>
                {[2, 4, 6, 8, 12, 16].filter((n) => n <= hw.cpuThreads).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label className="set-row">
              <span>Context length (how much it reads at once)</span>
              <select className="select" value={s.contextSize} onChange={(e) => update({ contextSize: +e.target.value, custom: true })}>
                {[2048, 4096, 8192, 16384, 32768].map((n) => (
                  <option key={n} value={n}>
                    {n / 1024}k tokens
                  </option>
                ))}
              </select>
            </label>
            <label className="set-row">
              <span>Longest answer</span>
              <select className="select" value={s.maxTokens} onChange={(e) => update({ maxTokens: +e.target.value, custom: true })}>
                {[256, 512, 768, 1024, 1536, 2048].map((n) => (
                  <option key={n} value={n}>
                    {n} tokens
                  </option>
                ))}
              </select>
            </label>
            <label className="set-row">
              <span>Creativity</span>
              <input type="range" min={0} max={1} step={0.05} value={s.temperature} onChange={(e) => update({ temperature: +e.target.value, custom: true })} />
              <span className="muted" style={{ width: 32 }}>
                {s.temperature.toFixed(2)}
              </span>
            </label>
            <label className="set-row">
              <span>Keep model in memory (faster answers, uses RAM)</span>
              <input type="checkbox" checked={s.keepLoaded} onChange={(e) => update({ keepLoaded: e.target.checked })} />
            </label>
          </div>
        )}

        <div className="dialog-actions">
          <button
            className="btn"
            onClick={async () => {
              const settings = await api.ai.resetSettings();
              ai.set({ state: { ...st, settings } });
            }}
          >
            <RotateCcw size={14} /> Reset to recommended
          </button>
        </div>
      </div>
    </div>
  );
}
