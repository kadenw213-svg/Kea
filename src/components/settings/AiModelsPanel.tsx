import { useEffect, useState } from 'react';
import { Download, Pause } from 'lucide-react';
import { api, type AiModel, type EngineStatus } from '../../lib/api';
import { useSettings } from '../../lib/settings';
import { formatBytes } from '../../lib/util';

/** Settings → AI image tools: download/manage the on-device background-removal models, pick which one to use. */
/** Settings: the face finder used for face-tracked reframing in the video editor. */
function FaceModels() {
  const [models, setModels] = useState<AiModel[]>([]);
  const refresh = () => api.models.state('faces').then(setModels);
  useEffect(() => {
    refresh();
    return api.models.onDownload((x) => {
      if (x.type !== 'faces') return;
      setModels((ms) => ms.map((y) => (y.id === x.id ? x : y)));
    });
  }, []);
  if (!models.length) return null;
  return (
    <>
      <div className="sgroup-title">Face finder</div>
      {models.map((m) => (
        <div key={m.id} className="voice-model">
          <span>
            <b>{m.label}</b> · {formatBytes(m.size)} · {m.license}
            <div className="muted">{m.blurb}</div>
          </span>
          {m.installed ? (
            <button className="btn sm" onClick={() => api.models.remove('faces', m.id).then(refresh)}>
              Delete
            </button>
          ) : m.download && m.download.status === 'downloading' ? (
            <button className="btn sm" onClick={() => api.models.pause('faces', m.id)}>
              <Pause size={13} /> {Math.round((m.download.received / Math.max(1, m.download.total)) * 100)}%
            </button>
          ) : (
            <button className="btn sm" onClick={() => api.models.download('faces', m.id)}>
              <Download size={13} /> {m.download ? 'Resume' : 'Download'}
            </button>
          )}
        </div>
      ))}
    </>
  );
}

export function AiModelsPanel() {
  const [models, setModels] = useState<AiModel[]>([]);
  const sel = useSettings((s) => (s.values['ai.segmentModel'] as string) || '');
  const refresh = () => api.models.state('segmentation').then(setModels);
  useEffect(() => {
    refresh();
    return api.models.onDownload((x) => {
      if (x.type !== 'segmentation') return;
      setModels((ms) => ms.map((y) => (y.id === x.id ? x : y)));
    });
  }, []);
  const chosen = sel || models.find((m) => m.default)?.id || models[0]?.id;
  const [engine, setEngine] = useState<EngineStatus | null>(null);
  useEffect(() => {
    api.engine?.status().then(setEngine);
  }, []);

  return (
    <div className="voice-models">
      <p className="muted" style={{ marginTop: 0 }}>
        These models run entirely on this computer and are downloaded once. They power <b>Remove background</b> and <b>Select subject</b> in the image editor (Layer and Select menus), <b>Remove background (AI)</b> on video clips, or ask Claude.
      </p>
      {engine && (
        <p className="muted" style={{ fontSize: 12 }}>
          Kea engine:{' '}
          {engine.gpuCrashed
            ? 'running on the processor (the graphics driver crashed once). '
            : engine.lastDevice
              ? `last ran on the ${engine.lastDevice === 'gpu' ? 'graphics card' : 'processor'} (${engine.lastMs} ms per image). `
              : engine.gpuSupported
                ? 'uses the graphics card (DirectML) when available. '
                : 'runs natively on the processor. '}
          {engine.gpuCrashed && (
            <button className="btn sm" onClick={() => api.engine!.resetGpu().then(setEngine)}>
              Try the graphics card again
            </button>
          )}
        </p>
      )}
      <div className="sgroup-title">Background removal</div>
      {models.map((m) => (
        <div key={m.id} className={`voice-model ${chosen === m.id ? 'on' : ''}`}>
          <label>
            <input type="radio" name="segment-model" checked={chosen === m.id} onChange={() => useSettings.getState().set({ 'ai.segmentModel': m.id })} />
            <span>
              <b>{m.label}</b> · {formatBytes(m.size)} · {m.license}
              <div className="muted">{m.blurb}</div>
            </span>
          </label>
          {m.installed ? (
            <button className="btn sm" onClick={() => api.models.remove('segmentation', m.id).then(refresh)}>
              Delete
            </button>
          ) : m.download && m.download.status === 'downloading' ? (
            <button className="btn sm" onClick={() => api.models.pause('segmentation', m.id)}>
              <Pause size={13} /> {Math.round((m.download.received / Math.max(1, m.download.total)) * 100)}%
            </button>
          ) : (
            <button className="btn sm" onClick={() => api.models.download('segmentation', m.id)}>
              <Download size={13} /> {m.download ? 'Resume' : 'Download'}
            </button>
          )}
        </div>
      ))}
      <FaceModels />
      {models.some((m) => m.download?.status === 'error') && <p className="muted" style={{ color: 'var(--danger)', fontSize: 12 }}>{models.find((m) => m.download?.status === 'error')?.download?.error}</p>}
    </div>
  );
}
