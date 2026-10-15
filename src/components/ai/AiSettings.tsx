import { InstructionsBox } from './AiSidebar';
import { DEPTHS, Depth } from '../../lib/ai';
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
          <div className="set-label">How answers are written</div>
          <div className="muted" style={{ marginBottom: 8 }}>Default depth for Explain, Summarize and questions (also switchable in the AI sidebar).</div>
          <DepthPicker />
          <div style={{ marginTop: 12 }}>
            <InstructionsBox />
          </div>
          <WikiSettings />
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

function DepthPicker() {
  const depth = useSettings((s) => (s.values['ai.depth'] as Depth) || 'standard');
  return (
    <div className="depth-list">
      {DEPTHS.map((d) => (
        <label key={d.id} className={`depth-opt ${depth === d.id ? 'on' : ''}`}>
          <input type="radio" name="ai-depth" checked={depth === d.id} onChange={() => useSettings.getState().set({ 'ai.depth': d.id })} />
          <span>
            <b>{d.label}</b>
            <span className="muted"> · {d.help}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

/** Settings → AI → Wikipedia. On by default; only the search words leave this PC, and offline it quietly answers locally. */
function WikiSettings() {
  const v = useSettings((s) => s.values);
  const set = (k: string, val: any) => useSettings.getState().set({ [k]: val });
  const on = v['ai.wikipedia'] !== false;
  const amount = (k: string, def: string) => (
    <select className="select" value={v[k] || def} onChange={(e) => set(k, e.target.value)}>
      <option value="intro">Introduction only (fastest)</option>
      <option value="medium">Medium</option>
      <option value="long">Long (most detail, slower)</option>
    </select>
  );
  const use = (k: string, def: boolean, label: string) => (
    <label className="wiki-use">
      <input type="checkbox" checked={v[k] === undefined ? def : !!v[k]} onChange={(e) => set(k, e.target.checked)} /> {label}
    </label>
  );
  return (
    <div className="wiki-settings">
      <label className="depth-opt">
        <input type="checkbox" checked={on} onChange={(e) => set('ai.wikipedia', e.target.checked)} />
        <span>
          <b>Check Wikipedia for up-to-date facts</b>
          <span className="muted">
            {' '}
            · The AI on this PC reads the matching Wikipedia article before answering and links it under the answer. Only the search words are sent, never your file. With no internet it simply answers on its own.
          </span>
        </span>
      </label>
      {on && (
        <div className="wiki-grid">
          <label>Use for</label>
          <span className="wiki-uses">
            {use('ai.wikiExplain', true, 'Explain')}
            {use('ai.wikiAsk', true, 'Questions')}
            {use('ai.wikiSummarize', false, 'Summarize')}
          </span>
          <label>Brief and Standard answers read</label>
          {amount('ai.wikiAmountQuick', 'intro')}
          <label>Deep answers read</label>
          {amount('ai.wikiAmountDeep', 'medium')}
          <label>Expert answers read</label>
          {amount('ai.wikiAmountExpert', 'long')}
          <label>Finding the article</label>
          <select className="select" value={v['ai.wikiFind'] || 'fast'} onChange={(e) => set('ai.wikiFind', e.target.value)}>
            <option value="fast">Fast: search your words directly</option>
            <option value="accurate">Accurate: the AI picks the topic first (about 2 s slower)</option>
          </select>
          <label>Articles to read</label>
          <select className="select" value={v['ai.wikiArticles'] || 1} onChange={(e) => set('ai.wikiArticles', Number(e.target.value))}>
            <option value={1}>1 (fastest)</option>
            <option value={2}>2</option>
            <option value={3}>3 (broadest)</option>
          </select>
          <label>Wikipedia language</label>
          <select className="select" value={v['ai.wikiLang'] || 'en'} onChange={(e) => set('ai.wikiLang', e.target.value)}>
            {[['en', 'English'], ['simple', 'Simple English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'], ['pt', 'Portuguese'], ['nl', 'Dutch'], ['pl', 'Polish'], ['ru', 'Russian'], ['ja', 'Japanese'], ['zh', 'Chinese'], ['ar', 'Arabic']].map(([c, l]) => (
              <option key={c} value={c}>
                {l}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
