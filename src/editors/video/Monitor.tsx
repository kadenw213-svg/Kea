import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Play, Pause, SkipBack, SkipForward, StepBack, StepForward, Repeat, Brackets, ArrowRightFromLine, ArrowLeftToLine, Grid2x2, Activity } from 'lucide-react';
import type { Clip, AnimProp } from './model';
import { projectDuration, propAt, setKey, timecode } from './model';
import { useVE, useVEStore } from './state';
import type { Player } from './player';
import { hitTest, clipBox, visibleLayers } from './compositor';
import { withLinked, isLocked } from './ops';
import * as act from './actions';
import { Scopes } from './ScopesPanel';

/* Program monitor: the composited picture at the playhead, with transport controls. */

const ZOOMS: (number | 'fit')[] = ['fit', 0.25, 0.5, 1, 2];
const measureCtx = document.createElement('canvas').getContext('2d')!;

/** Set a number property, adding a keyframe at the playhead when it's animated. */
export function setAnimated(c: Clip, prop: AnimProp, v: number, playhead: number) {
  if (c.kf[prop]?.length) setKey(c, prop, Math.max(0, playhead - c.start), v);
  else c.props[prop] = v;
}

export function Monitor({ player }: { player: Player }) {
  const store = useVEStore();
  const project = useVE((s) => s.project);
  const playing = useVE((s) => s.playing);
  const rate = useVE((s) => s.rate);
  const loop = useVE((s) => s.loop);
  const sel = useVE((s) => s.sel);
  const playhead = useVE((s) => s.playhead);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [stage, setStage] = useState({ w: 640, h: 360 });
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [safe, setSafe] = useState(false);
  const [scopes, setScopes] = useState(() => {
    try {
      return localStorage.getItem('kea.video.scopesOpen') === '1';
    } catch {
      return false;
    }
  });
  const toggleScopes = (on: boolean) => {
    setScopes(on);
    try {
      localStorage.setItem('kea.video.scopesOpen', on ? '1' : '0');
    } catch {
      /* remembered per viewer only */
    }
  };
  const W = project.settings.width;
  const H = project.settings.height;

  useEffect(() => {
    const el = stageRef.current!;
    const ro = new ResizeObserver(() => setStage({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fit = Math.max(0.01, Math.min((stage.w - 16) / W, (stage.h - 16) / H));
  const scale = zoom === 'fit' ? fit : zoom;
  const dispW = Math.round(W * scale);
  const dispH = Math.round(H * scale);

  // Canvas pixels: the displayed size (sharp on high-DPI screens) but never more than the project.
  useLayoutEffect(() => {
    const c = canvasRef.current!;
    const dpr = window.devicePixelRatio || 1;
    const k = Math.min(1, scale * dpr);
    c.width = Math.max(2, Math.round(W * k));
    c.height = Math.max(2, Math.round(H * k));
    player.attach(c);
  }, [W, H, scale, player]);
  useEffect(() => () => player.attach(null), [player]);

  /* ---------- Clicking and dragging clips in the frame ---------- */

  const toFrame = (clientX: number, clientY: number) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: ((clientX - r.left) / r.width) * W, y: ((clientY - r.top) / r.height) * H };
  };

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const s = store.getState();
    s.set({ focus: 'program' });
    const pt = toFrame(e.clientX, e.clientY);
    const hit = hitTest(s.project, s.playhead, pt.x, pt.y, measureCtx);
    if (!hit) return s.select([]);
    if (!s.sel.includes(hit.id)) s.select(e.altKey ? [hit.id] : withLinked(s.project, [hit.id]));
    if (isLocked(s.project, hit)) return;
    const x0 = propAt(hit, 'x', s.playhead);
    const y0 = propAt(hit, 'y', s.playhead);
    const start = { x: e.clientX, y: e.clientY };
    const k = W / canvasRef.current!.getBoundingClientRect().width;
    let begun = false;
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - start.x) * k;
      const dy = (ev.clientY - start.y) * k;
      if (!begun) {
        if (Math.abs(dx) + Math.abs(dy) < 3 * k) return;
        store.getState().begin('Move in frame');
        begun = true;
      }
      // Shift keeps the move horizontal or vertical; snaps to the centre lines.
      let nx = x0 + dx;
      let ny = y0 + dy;
      if (ev.shiftKey) Math.abs(dx) > Math.abs(dy) ? (ny = y0) : (nx = x0);
      if (Math.abs(nx) < 12 * k) nx = 0;
      if (Math.abs(ny) < 12 * k) ny = 0;
      const t = store.getState().playhead;
      store.getState().liveFrom((p) => {
        const c = p.clips.find((x) => x.id === hit.id);
        if (!c) return;
        setAnimated(c, 'x', Math.round(nx), t);
        setAnimated(c, 'y', Math.round(ny), t);
      });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (begun) store.getState().end();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onWheel = (e: React.WheelEvent) => {
    // Alt+wheel scales the selected clip.
    if (!e.altKey) return;
    const s = store.getState();
    const c = s.project.clips.find((x) => x.id === s.sel[0]);
    if (!c || isLocked(s.project, c)) return;
    const v = Math.max(1, Math.round(propAt(c, 'scale', s.playhead) * (e.deltaY < 0 ? 1.05 : 1 / 1.05)));
    s.commit('Scale', (p) => setAnimated(p.clips.find((x) => x.id === c.id)!, 'scale', v, s.playhead));
  };

  // Outline of the selected picture clip.
  const box = useMemo(() => {
    const visible = new Set(visibleLayers(project, playhead).flat().map((l) => l.clip.id));
    const c = project.clips.find((x) => sel.includes(x.id) && visible.has(x.id));
    if (!c) return null;
    const b = clipBox(project, c, playhead, measureCtx);
    if (!b) return null;
    const s = propAt(c, 'scale', playhead) / 100;
    return { cx: W / 2 + propAt(c, 'x', playhead), cy: H / 2 + propAt(c, 'y', playhead), w: b.w * s, h: b.h * s, rot: propAt(c, 'rotation', playhead) };
  }, [project, playhead, sel]);

  const total = projectDuration(project);
  const fps = project.settings.fps;
  const hasRange = project.inPoint !== null && project.outPoint !== null;

  return (
    <div className="ve-monitor" onPointerDown={() => store.getState().set({ focus: 'program' })}>
      <div className="ve-monitor-stage" ref={stageRef} style={{ overflow: zoom === 'fit' ? 'hidden' : 'auto' }}>
        <div className="ve-monitor-frame" style={{ width: dispW, height: dispH }} onPointerDown={onDown} onWheel={onWheel}>
          <canvas ref={canvasRef} style={{ width: dispW, height: dispH }} />
          {box && (
            <div
              className="ve-monitor-box"
              style={{
                left: (box.cx - box.w / 2) * scale,
                top: (box.cy - box.h / 2) * scale,
                width: box.w * scale,
                height: box.h * scale,
                transform: `rotate(${box.rot}deg)`
              }}
            />
          )}
          {safe && (
            <>
              <div className="ve-safe" style={{ inset: '5%' }} />
              <div className="ve-safe title" style={{ inset: '10%' }} />
              <div className="ve-safe-cross" />
            </>
          )}
        </div>
      </div>
        {scopes && <Scopes player={player} onClose={() => toggleScopes(false)} />}
      <div className="ve-transport">
        <span className="ve-tc big" title="Playhead">
          {timecode(playhead, fps)}
        </span>
        <div className="tb-spacer" />
        <button className="icon-btn sm" title="Mark in (I)" onClick={() => act.setInOut(store, 'in')}>
          <ArrowRightFromLine size={16} />
        </button>
        <button className="icon-btn sm" title="Go to start (Home)" onClick={() => store.getState().seek(0)}>
          <SkipBack size={16} />
        </button>
        <button className="icon-btn sm" title="Back one frame (Left arrow)" onClick={() => player.step(-1)}>
          <StepBack size={16} />
        </button>
        <button className="icon-btn ve-play" title={playing ? 'Pause (Space)' : 'Play (Space)'} onClick={() => player.toggle()}>
          {playing ? <Pause size={20} /> : <Play size={20} />}
        </button>
        <button className="icon-btn sm" title="Forward one frame (Right arrow)" onClick={() => player.step(1)}>
          <StepForward size={16} />
        </button>
        <button className="icon-btn sm" title="Go to end (End)" onClick={() => store.getState().seek(total)}>
          <SkipForward size={16} />
        </button>
        <button className="icon-btn sm" title="Mark out (O)" onClick={() => act.setInOut(store, 'out')}>
          <ArrowLeftToLine size={16} />
        </button>
        <div className="tb-spacer" />
        {playing && rate !== 1 && <span className="ve-rate">{rate > 0 ? `${rate}×` : `◀ ${-rate}×`}</span>}
        <button className="icon-btn sm" title="Play from in to out (Shift+Space)" disabled={!hasRange} onClick={() => player.toggle(true)}>
          <Brackets size={16} />
        </button>
        <button className={`icon-btn sm ${loop ? 'active' : ''}`} title="Loop playback" onClick={() => store.getState().set({ loop: !loop })}>
          <Repeat size={16} />
        </button>
        <button className={`icon-btn sm ${scopes ? 'active' : ''}`} title="Scopes: waveform, RGB parade, vectorscope, histogram" onClick={() => toggleScopes(!scopes)}>
          <Activity size={16} />
        </button>
        <button className={`icon-btn sm ${safe ? 'active' : ''}`} title="Safe margins" onClick={() => setSafe(!safe)}>
          <Grid2x2 size={16} />
        </button>
        <select className="select ve-small-select" value={String(zoom)} title="Monitor zoom" onChange={(e) => setZoom(e.target.value === 'fit' ? 'fit' : Number(e.target.value))}>
          {ZOOMS.map((z) => (
            <option key={String(z)} value={String(z)}>
              {z === 'fit' ? 'Fit' : `${z * 100}%`}
            </option>
          ))}
        </select>
        <span className="ve-tc dim" title="Duration">
          {timecode(total, fps)}
        </span>
      </div>
    </div>
  );
}
