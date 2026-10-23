import { useEffect, useRef, useState } from 'react';
import { Download, X } from 'lucide-react';
import type { QualityLevel } from 'mediabunny';
import { api } from '../../lib/api';
import { toast } from '../../store';
import { baseName } from '../../lib/fileTypes';
import type { Project } from './model';
import { projectDuration, timecode, FPS_CHOICES } from './model';
import { encoderSupport, exportProject, EncoderSupport, ExportFormat, ExportCodec, EXPORT_CODECS, Canceled } from './exporter';
import { canStreamWrite } from './host';

/* Export: pick format, size, frame rate, quality and range, then render offline with a progress bar. */

const FORMATS: { id: ExportFormat; label: string; ext: string; filter: string }[] = [
  { id: 'mp4', label: 'MP4 video (H.264 + AAC)', ext: 'mp4', filter: 'MP4 video' },
  { id: 'webm', label: 'WebM video (VP9 + Opus)', ext: 'webm', filter: 'WebM video' },
  { id: 'm4a', label: 'Audio only, M4A (AAC)', ext: 'm4a', filter: 'M4A audio' },
  { id: 'wav', label: 'Audio only, WAV', ext: 'wav', filter: 'WAV audio' }
];
const QUALITIES: { id: QualityLevel; label: string }[] = [
  { id: 'low', label: 'Small file' },
  { id: 'medium', label: 'Good' },
  { id: 'high', label: 'High' },
  { id: 'very-high', label: 'Best' }
];

const LAST = 'kea.video.export';

export function ExportDialog({ project, name, onClose }: { project: Project; name: string; onClose(): void }) {
  const W = project.settings.width;
  const H = project.settings.height;
  const saved = (() => {
    try {
      return JSON.parse(localStorage.getItem(LAST) || '{}');
    } catch {
      return {};
    }
  })();
  const [format, setFormat] = useState<ExportFormat>(saved.format || 'mp4');
  const [height, setHeight] = useState<number>(H);
  const [fps, setFps] = useState<number>(project.settings.fps);
  const [quality, setQuality] = useState<QualityLevel>(saved.quality || 'high');
  const [bitrate, setBitrate] = useState<number>(0);
  const [codec, setCodec] = useState<ExportCodec>(saved.codec || 'auto');
  const [hardware, setHardware] = useState<'auto' | 'on' | 'off'>(saved.hardware || 'auto');
  const hasRange = project.inPoint !== null || project.outPoint !== null;
  const [range, setRange] = useState<'all' | 'inout'>(hasRange ? 'inout' : 'all');
  const [audio, setAudio] = useState(true);
  const [support, setSupport] = useState<EncoderSupport | null>(null);
  const [progress, setProgress] = useState<{ f: number; note: string } | null>(null);
  const [error, setError] = useState('');
  const abort = useRef<AbortController | null>(null);

  const aspect = W / H;
  const sizes = [...new Set([H, 2160, 1440, 1080, 720, 480, 360].filter((h) => h <= Math.max(H, 2160)))].sort((a, b) => b - a);
  const width = Math.round((height * aspect) / 2) * 2;
  const total = projectDuration(project);
  const a = range === 'inout' ? (project.inPoint ?? 0) : 0;
  const b = range === 'inout' ? (project.outPoint ?? total) : total;
  const isAudio = format === 'm4a' || format === 'wav';

  useEffect(() => {
    let live = true;
    setSupport(null);
    encoderSupport(width, Math.round(height / 2) * 2).then((s) => live && setSupport(s));
    return () => {
      live = false;
    };
  }, [width, height]);

  const problem = (() => {
    if (b - a < 0.05) return 'There is nothing to export in that range.';
    if (!support) return '';
    if (format === 'mp4' && !support.avc) return "This computer can't encode H.264 at this size. Choose WebM or a smaller size.";
    if (format === 'webm' && !support.vp9) return "This computer can't encode VP9 at this size. Choose MP4 or a smaller size.";
    if (format === 'm4a' && support.mp4Audio !== 'aac') return "This computer can't encode AAC audio. Choose WAV instead.";
    return '';
  })();
  const note = (() => {
    if (!support || isAudio || !audio) return '';
    if (format === 'mp4' && support.mp4Audio === 'opus') return 'Sound will be Opus inside the MP4 (AAC encoding isn’t available here).';
    if (format === 'mp4' && !support.mp4Audio) return 'Sound can’t be encoded on this computer, so the video will be silent.';
    if (format === 'webm' && !support.webmAudio) return 'Sound can’t be encoded on this computer, so the video will be silent.';
    return '';
  })();

  const start = async () => {
    const f = FORMATS.find((x) => x.id === format)!;
    const path = await api.saveDialog({ title: 'Export', defaultPath: `${baseName(name)}.${f.ext}`, filters: [{ name: f.filter, extensions: [f.ext] }] });
    if (!path) return;
    try {
      localStorage.setItem(LAST, JSON.stringify({ format, quality, codec, hardware }));
    } catch {
      /* not important */
    }
    setError('');
    const ac = new AbortController();
    abort.current = ac;
    setProgress({ f: 0, note: 'Starting…' });
    try {
      const useCodec = EXPORT_CODECS.find((c) => c.id === codec)?.formats.includes(format) ? codec : 'auto';
      await exportProject(project, { format, width, height: Math.round(height / 2) * 2, fps, quality, bitrate, range: [a, b], audio, path, codec: useCodec, hardware }, (fr, n) => setProgress({ f: fr, note: n }), ac.signal);
      const fileName = path.split(/[\\/]/).pop();
      toast(`Exported ${fileName}`, 'success');
      api.addRecent(path).catch(() => {});
      setProgress({ f: 1, note: `Saved ${fileName}` });
      setTimeout(onClose, 600);
    } catch (err: any) {
      if (err instanceof Canceled || err?.name === 'AbortError') {
        setProgress(null);
        toast('Export canceled');
      } else {
        console.error(err);
        setProgress(null);
        setError(err?.message || String(err));
      }
    } finally {
      abort.current = null;
    }
  };

  const busy = !!progress;
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="dialog ve-export" role="dialog" onKeyDown={(e) => e.stopPropagation()}>
        <div className="ve-export-head">
          <h2>Export</h2>
          {!busy && (
            <button className="icon-btn sm" title="Close" onClick={onClose}>
              <X size={16} />
            </button>
          )}
        </div>
        <div className="ve-form">
          <label>Format</label>
          <select className="select ve-field" value={format} disabled={busy} onChange={(e) => setFormat(e.target.value as ExportFormat)}>
            {FORMATS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
          {!isAudio && (
            <>
              <label>Size</label>
              <select className="select ve-field" value={height} disabled={busy} onChange={(e) => setHeight(Number(e.target.value))}>
                {sizes.map((h) => (
                  <option key={h} value={h}>
                    {Math.round((h * aspect) / 2) * 2} × {h}
                    {h === H ? ' (project)' : ''}
                  </option>
                ))}
              </select>
              <label>Frame rate</label>
              <select className="select ve-field" value={fps} disabled={busy} onChange={(e) => setFps(Number(e.target.value))}>
                {[...new Set([project.settings.fps, ...FPS_CHOICES])].sort((x, y) => x - y).map((r) => (
                  <option key={r} value={r}>
                    {r} fps{r === project.settings.fps ? ' (project)' : ''}
                  </option>
                ))}
              </select>
              <label>Quality</label>
              <div className="ve-seg">
                {QUALITIES.map((q) => (
                  <button key={q.id} className={quality === q.id && !bitrate ? 'on' : ''} disabled={busy} onClick={() => (setQuality(q.id), setBitrate(0))}>
                    {q.label}
                  </button>
                ))}
              </div>
              <label title="Leave at 0 to let the quality setting decide">Bitrate</label>
              <div className="ve-inline">
                <input
                  className="num-input"
                  style={{ width: 70 }}
                  type="number"
                  min={0}
                  max={200}
                  step={0.5}
                  disabled={busy}
                  value={bitrate ? bitrate / 1000 : 0}
                  onChange={(e) => setBitrate(Math.max(0, Number(e.target.value) || 0) * 1000)}
                />
                <span className="dim">Mbit/s {bitrate ? '' : '(automatic)'}</span>
              </div>
              <label title="H.264 plays everywhere; HEVC and AV1 make smaller files at the same quality">Codec</label>
              <select className="select ve-field" value={EXPORT_CODECS.find((c) => c.id === codec)?.formats.includes(format) ? codec : 'auto'} disabled={busy} onChange={(e) => setCodec(e.target.value as ExportCodec)}>
                {EXPORT_CODECS.filter((c) => c.formats.includes(format)).map((c) => (
                  <option key={c.id} value={c.id} disabled={c.id !== 'auto' && !!support && !support[c.id as 'avc' | 'hevc' | 'av1' | 'vp9']}>
                    {c.label}
                    {c.id !== 'auto' && support && !support[c.id as 'avc' | 'hevc' | 'av1' | 'vp9'] ? ' — not on this computer' : ''}
                  </option>
                ))}
              </select>
              <label title="Which encoder does the work. Automatic lets this computer choose.">Graphics card</label>
              <select className="select ve-field" value={hardware} disabled={busy} onChange={(e) => setHardware(e.target.value as 'auto' | 'on' | 'off')}>
                <option value="auto">Automatic</option>
                <option value="on">Prefer the graphics card</option>
                <option value="off">Don’t use it (software)</option>
              </select>
            </>
          )}
          <label>Range</label>
          <div className="ve-seg">
            <button className={range === 'all' ? 'on' : ''} disabled={busy} onClick={() => setRange('all')}>
              Whole project
            </button>
            <button className={range === 'inout' ? 'on' : ''} disabled={busy || !hasRange} onClick={() => setRange('inout')} title={hasRange ? '' : 'Mark in (I) and out (O) on the timeline first'}>
              In to out
            </button>
          </div>
          {!isAudio && (
            <>
              <label>Sound</label>
              <label className="ve-check">
                <input type="checkbox" checked={audio} disabled={busy} onChange={(e) => setAudio(e.target.checked)} /> Include sound
              </label>
            </>
          )}
        </div>
        <p className="ve-export-sum">
          {timecode(a, fps)} – {timecode(b, fps)} · {(b - a).toFixed(1)} s{!isAudio ? ` · ${Math.round((b - a) * fps)} frames` : ''}
          {!canStreamWrite() && b - a > 600 ? ' · long exports are kept in memory until they finish' : ''}
        </p>
        {problem && <p className="ve-export-warn">{problem}</p>}
        {note && !problem && <p className="ve-export-note">{note}</p>}
        {error && <p className="ve-export-warn">Export failed: {error}</p>}
        {progress && (
          <div className="ve-export-progress">
            <div className="progress">
              <div style={{ width: `${Math.round(progress.f * 100)}%` }} />
            </div>
            <div className="ve-export-note">
              {Math.round(progress.f * 100)}% · {progress.note}
            </div>
          </div>
        )}
        <div className="dialog-actions">
          {busy ? (
            <button className="btn" onClick={() => abort.current?.abort()} disabled={!abort.current}>
              Cancel export
            </button>
          ) : (
            <>
              <button className="btn" onClick={onClose}>
                Close
              </button>
              <button className="btn primary" disabled={!!problem || !support} onClick={start}>
                <Download size={16} /> Export…
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
