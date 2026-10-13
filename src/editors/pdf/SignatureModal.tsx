import { useEffect, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { bytesToDataUrl } from '../../lib/util';
import { mimeFor } from '../../lib/pdfTools';

const SAVED_KEY = 'slate.signatures';
const INKS = ['#000000', '#1a3d8f', '#0b57d0'];
const SCRIPT_FONTS = ['"Segoe Script"', '"Lucida Handwriting"', '"Brush Script MT"', '"Ink Free"'];

function loadSaved(): string[] {
  try {
    return JSON.parse(localStorage.getItem(SAVED_KEY) || '[]');
  } catch {
    return [];
  }
}
function storeSaved(list: string[]) {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(list.slice(0, 6)));
  } catch {}
}

/** Crop a canvas to its non-transparent pixels and return a PNG data URL. */
function trimCanvas(c: HTMLCanvasElement): string | null {
  const ctx = c.getContext('2d')!;
  const { width, height } = c;
  const data = ctx.getImageData(0, 0, width, height).data;
  let minX = width,
    minY = height,
    maxX = -1,
    maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const pad = 6;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad);
  maxY = Math.min(height - 1, maxY + pad);
  const out = document.createElement('canvas');
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext('2d')!.drawImage(c, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

export function SignatureModal({ onDone, onCancel }: { onDone(dataUrl: string): void; onCancel(): void }) {
  const [mode, setMode] = useState<'draw' | 'type' | 'upload'>('draw');
  const [ink, setInk] = useState(INKS[0]);
  const [typed, setTyped] = useState('');
  const [font, setFont] = useState(SCRIPT_FONTS[0]);
  const [saved, setSaved] = useState<string[]>(loadSaved);
  const [hasInk, setHasInk] = useState(false);
  const [uploaded, setUploaded] = useState<string | null>(null);
  const [remember, setRemember] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = 2;
    c.width = c.clientWidth * dpr;
    c.height = c.clientHeight * dpr;
    const ctx = c.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }, [mode]);

  const pos = (e: React.PointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const finish = (url: string | null) => {
    if (!url) return;
    if (remember && !saved.includes(url)) storeSaved([url, ...saved]);
    onDone(url);
  };

  const create = () => {
    if (mode === 'draw') finish(trimCanvas(canvasRef.current!));
    else if (mode === 'type') {
      if (!typed.trim()) return;
      const c = document.createElement('canvas');
      c.width = 1400;
      c.height = 300;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = ink;
      ctx.font = `120px ${font}, cursive`;
      ctx.textBaseline = 'middle';
      ctx.fillText(typed, 30, 150);
      finish(trimCanvas(c));
    } else finish(uploaded);
  };

  const upload = async () => {
    const [f] = await api.openDialog({ title: 'Choose signature image', filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }] });
    if (f) setUploaded(await bytesToDataUrl(f.data, mimeFor(f.name)));
  };

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="dialog sig-dialog">
        <h2>Add signature</h2>
        {saved.length > 0 && (
          <div className="sig-saved">
            {saved.map((s) => (
              <div key={s} className="sig-saved-item" onClick={() => onDone(s)} title="Use this signature">
                <img src={s} />
                <button
                  className="icon-btn sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    const next = saved.filter((x) => x !== s);
                    setSaved(next);
                    storeSaved(next);
                  }}
                  title="Forget"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="seg">
          {(['draw', 'type', 'upload'] as const).map((m) => (
            <button key={m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>
              {m === 'draw' ? 'Draw' : m === 'type' ? 'Type' : 'Upload'}
            </button>
          ))}
        </div>

        {mode === 'draw' && (
          <div className="sig-pad">
            <canvas
              ref={canvasRef}
              onPointerDown={(e) => {
                (e.target as HTMLElement).setPointerCapture(e.pointerId);
                drawing.current = pos(e);
                const ctx = canvasRef.current!.getContext('2d')!;
                ctx.strokeStyle = ink;
                ctx.fillStyle = ink;
                ctx.beginPath();
                ctx.arc(drawing.current.x, drawing.current.y, 1.2, 0, Math.PI * 2);
                ctx.fill();
                setHasInk(true);
              }}
              onPointerMove={(e) => {
                if (!drawing.current) return;
                const p = pos(e);
                const ctx = canvasRef.current!.getContext('2d')!;
                const speed = Math.hypot(p.x - drawing.current.x, p.y - drawing.current.y);
                ctx.lineWidth = Math.max(1.4, 3.2 - speed * 0.08);
                ctx.beginPath();
                ctx.moveTo(drawing.current.x, drawing.current.y);
                ctx.lineTo(p.x, p.y);
                ctx.stroke();
                drawing.current = p;
              }}
              onPointerUp={() => (drawing.current = null)}
            />
            <div className="sig-line" />
            {!hasInk && <div className="sig-hint">Sign here</div>}
            <button
              className="btn sm sig-clear"
              onClick={() => {
                const c = canvasRef.current!;
                c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
                setHasInk(false);
              }}
            >
              Clear
            </button>
          </div>
        )}
        {mode === 'type' && (
          <div>
            <input className="input" placeholder="Type your name" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
            <div className="sig-fonts">
              {SCRIPT_FONTS.map((f) => (
                <button key={f} className={`sig-font ${font === f ? 'on' : ''}`} style={{ fontFamily: `${f}, cursive`, color: ink }} onClick={() => setFont(f)}>
                  {typed || 'Your Name'}
                </button>
              ))}
            </div>
          </div>
        )}
        {mode === 'upload' && (
          <div className="sig-upload" onClick={upload}>
            {uploaded ? <img src={uploaded} /> : <span>Click to choose an image of your signature</span>}
          </div>
        )}

        <div className="sig-foot">
          {mode !== 'upload' && (
            <div className="sig-inks">
              {INKS.map((c) => (
                <button key={c} className="swatch" style={{ background: c, outline: ink === c ? '2px solid var(--accent)' : undefined }} onClick={() => setInk(c)} />
              ))}
            </div>
          )}
          <label className="check">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember
          </label>
        </div>
        <div className="dialog-actions">
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn primary" onClick={create}>
            Place signature
          </button>
        </div>
      </div>
    </div>
  );
}
