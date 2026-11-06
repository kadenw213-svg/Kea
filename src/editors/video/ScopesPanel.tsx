import { useEffect, useRef, useState } from 'react';
import type { Player } from './player';
import { drawScope, SCOPE_MODES, type ScopeMode } from './scopes';

/* Scopes over the program monitor: waveform, RGB parade, vectorscope or histogram of the picture as it's shown. */

const SAMPLE_W = 320;

export function Scopes({ player, onClose }: { player: Player; onClose(): void }) {
  const [mode, setMode] = useState<ScopeMode>(() => {
    try {
      return (localStorage.getItem('kea.video.scope') as ScopeMode) || 'waveform';
    } catch {
      return 'waveform';
    }
  });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  useEffect(() => {
    try {
      localStorage.setItem('kea.video.scope', mode);
    } catch {
      /* per-viewer convenience only */
    }
  }, [mode]);

  useEffect(() => {
    // Sample the monitor after it draws, at most ~6 times a second (reading pixels back costs a few milliseconds).
    const sample = document.createElement('canvas');
    const sctx = sample.getContext('2d', { willReadFrequently: true })!;
    let last = 0;
    let timer = 0;
    const update = () => {
      timer = 0;
      last = performance.now();
      const src = player.view;
      const out = canvasRef.current;
      if (!src || !out || !src.width) return;
      sample.width = SAMPLE_W;
      sample.height = Math.max(2, Math.round((SAMPLE_W * src.height) / src.width));
      sctx.drawImage(src, 0, 0, sample.width, sample.height);
      const img = sctx.getImageData(0, 0, sample.width, sample.height);
      drawScope(out.getContext('2d')!, img, modeRef.current);
    };
    const off = player.onFrame(() => {
      if (timer) return;
      timer = window.setTimeout(update, Math.max(0, 160 - (performance.now() - last)));
    });
    update();
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [player]);

  useEffect(() => {
    // Redraw straight away when the mode changes.
    player.requestRender();
  }, [mode, player]);

  return (
    <div className="ve-scopes" onPointerDown={(e) => e.stopPropagation()}>
      <div className="ve-scopes-bar">
        <select className="select ve-small-select" value={mode} onChange={(e) => setMode(e.target.value as ScopeMode)} title="Scope">
          {SCOPE_MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <div className="tb-spacer" />
        <button className="icon-btn sm" title="Close scopes" onClick={onClose}>
          ×
        </button>
      </div>
      <canvas ref={canvasRef} width={mode === 'vectorscope' ? 240 : 360} height={mode === 'vectorscope' ? 240 : 200} />
    </div>
  );
}
