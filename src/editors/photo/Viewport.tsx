import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Engine } from './engine';
import { transformCorners } from './engine';
import type { Pt } from './types';
import * as T from './tools';
import { antsPath } from './selection';
import { pickColor } from './ops';
import { cssFont, textBox, renderText, traceShape } from './vector';
import { rectOf } from './canvas';

/**
 * The canvas area: draws the composite at the current zoom over a checkerboard,
 * plus overlays (marching ants, crop box, transform handles, brush outline, grid,
 * rulers), and turns pointer/wheel input into tool calls.
 */

const RULER = 18;

export function Viewport({ engine: e, active }: { engine: Engine; active: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [cursor, setCursor] = useState('default');
  const hover = useRef<{ sx: number; sy: number; inside: boolean }>({ sx: -1, sy: -1, inside: false });
  const space = useRef(false);
  const ants = useRef(0);
  const [, force] = useState(0);
  const checker = useRef<CanvasPattern | null>(null);

  // ---------- Drawing ----------
  const draw = () => {
    const cv = canvasRef.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const g = cv.getContext('2d')!;
    const comp = e.flush();
    const { zoom, panX, panY } = e.view;
    const W = cv.width / dpr,
      H = cv.height / dpr;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = '#161718';
    g.fillRect(0, 0, W, H);
    const dw = e.doc.w * zoom,
      dh = e.doc.h * zoom;
    // Checkerboard shows through transparent areas.
    if (!checker.current) {
      const p = document.createElement('canvas');
      p.width = p.height = 16;
      const pg = p.getContext('2d')!;
      pg.fillStyle = '#ffffff';
      pg.fillRect(0, 0, 16, 16);
      pg.fillStyle = '#d6d6d6';
      pg.fillRect(0, 0, 8, 8);
      pg.fillRect(8, 8, 8, 8);
      checker.current = g.createPattern(p, 'repeat');
    }
    g.save();
    g.shadowColor = 'rgba(0,0,0,0.5)';
    g.shadowBlur = 18;
    g.fillStyle = '#fff';
    g.fillRect(panX, panY, dw, dh);
    g.restore();
    g.save();
    g.beginPath();
    g.rect(panX, panY, dw, dh);
    g.clip();
    g.translate(panX, panY);
    g.fillStyle = checker.current!;
    g.fillRect(0, 0, dw, dh);
    g.restore();
    g.imageSmoothingEnabled = zoom < 2;
    g.imageSmoothingQuality = zoom < 1 ? 'high' : 'low';
    g.drawImage(comp, panX, panY, dw, dh);
    drawOverlays(g, W, H);
  };

  const docToScreenTransform = (g: CanvasRenderingContext2D) => {
    const dpr = window.devicePixelRatio || 1;
    g.setTransform(dpr * e.view.zoom, 0, 0, dpr * e.view.zoom, dpr * e.view.panX, dpr * e.view.panY);
  };

  const drawOverlays = (g: CanvasRenderingContext2D, W: number, H: number) => {
    const dpr = window.devicePixelRatio || 1;
    const z = e.view.zoom;
    const scr = (p: Pt) => e.toScreen(p);
    // Grid
    if (e.showGrid && e.gridSize * z >= 4) {
      g.save();
      g.strokeStyle = 'rgba(120,170,255,0.35)';
      g.lineWidth = 1;
      g.beginPath();
      for (let x = 0; x <= e.doc.w; x += e.gridSize) {
        const s = Math.round(scr({ x, y: 0 }).x) + 0.5;
        g.moveTo(s, e.view.panY);
        g.lineTo(s, e.view.panY + e.doc.h * z);
      }
      for (let y = 0; y <= e.doc.h; y += e.gridSize) {
        const s = Math.round(scr({ x: 0, y }).y) + 0.5;
        g.moveTo(e.view.panX, s);
        g.lineTo(e.view.panX + e.doc.w * z, s);
      }
      g.stroke();
      g.restore();
    }
    // Selection (marching ants)
    if (e.selection && e.showSelection && !e.transform) {
      g.save();
      docToScreenTransform(g);
      const path = antsPath(e.selection);
      g.lineWidth = 1 / z;
      g.strokeStyle = '#fff';
      g.stroke(path);
      g.setLineDash([4 / z, 4 / z]);
      g.lineDashOffset = -ants.current / z;
      g.strokeStyle = '#000';
      g.stroke(path);
      g.restore();
    }
    // Tool overlays in progress
    const ov = e.overlay;
    if (ov) {
      g.save();
      const pts = ov.pts.map(scr);
      g.lineWidth = 1;
      const dashed = () => {
        g.strokeStyle = '#fff';
        g.setLineDash([]);
        g.stroke();
        g.strokeStyle = '#000';
        g.setLineDash([4, 4]);
        g.stroke();
      };
      g.beginPath();
      if (ov.kind === 'rect') {
        const r = rectOf(pts[0], pts[1]);
        g.rect(Math.round(r.x) + 0.5, Math.round(r.y) + 0.5, Math.round(r.w), Math.round(r.h));
        dashed();
      } else if (ov.kind === 'ellipse') {
        const r = rectOf(pts[0], pts[1]);
        g.ellipse(r.x + r.w / 2, r.y + r.h / 2, Math.max(0.5, r.w / 2), Math.max(0.5, r.h / 2), 0, 0, Math.PI * 2);
        dashed();
      } else if (ov.kind === 'lasso' || ov.kind === 'poly') {
        pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
        dashed();
        if (ov.kind === 'poly') {
          g.setLineDash([]);
          g.fillStyle = '#fff';
          g.fillRect(pts[0].x - 3, pts[0].y - 3, 6, 6);
        }
      } else if (ov.kind === 'line') {
        g.moveTo(pts[0].x, pts[0].y);
        g.lineTo(pts[1].x, pts[1].y);
        dashed();
        g.setLineDash([]);
        for (const p of pts) {
          g.beginPath();
          g.arc(p.x, p.y, 4, 0, Math.PI * 2);
          g.fillStyle = '#fff';
          g.fill();
          g.strokeStyle = '#000';
          g.stroke();
        }
      } else if (ov.kind === 'shape') {
        const o = e.opts.shape;
        docToScreenTransform(g);
        g.lineWidth = 1 / z;
        traceShape(g, { type: o.type, x1: ov.pts[0].x, y1: ov.pts[0].y, x2: ov.pts[1].x, y2: ov.pts[1].y, sides: o.sides, radius: o.radius, fill: null, stroke: null, strokeWidth: 1 });
        g.globalAlpha = 0.35;
        if (o.type !== 'line' && o.fillOn) {
          g.fillStyle = e.fg;
          g.fill();
        }
        g.globalAlpha = 1;
        g.strokeStyle = '#7cacf8';
        g.stroke();
      }
      g.restore();
    }
    // Crop box
    if (e.crop && e.tool === 'crop') {
      const a = scr({ x: e.crop.x, y: e.crop.y }),
        b = scr({ x: e.crop.x + e.crop.w, y: e.crop.y + e.crop.h });
      g.save();
      g.fillStyle = 'rgba(0,0,0,0.55)';
      g.beginPath();
      g.rect(0, 0, W, H);
      g.rect(a.x, a.y, b.x - a.x, b.y - a.y);
      g.fill('evenodd');
      g.strokeStyle = '#fff';
      g.lineWidth = 1;
      g.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(b.x - a.x), Math.round(b.y - a.y));
      g.strokeStyle = 'rgba(255,255,255,0.4)';
      g.beginPath();
      for (let k = 1; k < 3; k++) {
        const x = a.x + ((b.x - a.x) * k) / 3,
          y = a.y + ((b.y - a.y) * k) / 3;
        g.moveTo(x, a.y);
        g.lineTo(x, b.y);
        g.moveTo(a.x, y);
        g.lineTo(b.x, y);
      }
      g.stroke();
      handles(g, [a.x, (a.x + b.x) / 2, b.x].flatMap((x) => [a.y, (a.y + b.y) / 2, b.y].map((y) => ({ x, y }))).filter((_, i) => i !== 4));
      g.fillStyle = 'rgba(0,0,0,0.7)';
      const label = `${e.crop.w} × ${e.crop.h}`;
      g.font = '12px Inter, sans-serif';
      const tw = g.measureText(label).width;
      g.fillRect(a.x, b.y + 6, tw + 12, 20);
      g.fillStyle = '#fff';
      g.fillText(label, a.x + 6, b.y + 20);
      g.restore();
    }
    // Free transform box
    if (e.transform && !e.transform.moveOnly) {
      const cs = transformCorners(e.transform).map(scr);
      g.save();
      g.strokeStyle = '#7cacf8';
      g.lineWidth = 1;
      g.beginPath();
      cs.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
      g.closePath();
      g.stroke();
      const mids = cs.map((p, i) => ({ x: (p.x + cs[(i + 1) % 4].x) / 2, y: (p.y + cs[(i + 1) % 4].y) / 2 }));
      handles(g, [...cs, ...mids]);
      const c = scr({ x: e.transform.cx, y: e.transform.cy });
      g.beginPath();
      g.arc(c.x, c.y, 4, 0, Math.PI * 2);
      g.strokeStyle = '#fff';
      g.stroke();
      g.restore();
    }
    // Clone source marker
    if (e.tool === 'clone' && e.cloneSource) {
      const p = scr(e.cloneSource);
      g.save();
      g.strokeStyle = '#fff';
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(p.x - 8, p.y);
      g.lineTo(p.x + 8, p.y);
      g.moveTo(p.x, p.y - 8);
      g.lineTo(p.x, p.y + 8);
      g.stroke();
      g.restore();
    }
    // Brush outline
    const size = T.brushSizeOf(e);
    if (size && hover.current.inside && !space.current) {
      const r = Math.max(1, (size * z) / 2);
      const { sx, sy } = hover.current;
      g.save();
      g.lineWidth = 1;
      g.beginPath();
      g.arc(sx, sy, r, 0, Math.PI * 2);
      g.strokeStyle = 'rgba(0,0,0,0.6)';
      g.stroke();
      g.beginPath();
      g.arc(sx, sy, r + 1, 0, Math.PI * 2);
      g.strokeStyle = 'rgba(255,255,255,0.8)';
      g.stroke();
      if (r < 4) {
        g.beginPath();
        g.moveTo(sx - 6, sy);
        g.lineTo(sx + 6, sy);
        g.moveTo(sx, sy - 6);
        g.lineTo(sx, sy + 6);
        g.stroke();
      }
      g.restore();
    }
    if (e.showRulers) drawRulers(g, W, H);
    void dpr;
  };

  const handles = (g: CanvasRenderingContext2D, pts: Pt[]) => {
    g.save();
    g.setLineDash([]);
    g.fillStyle = '#fff';
    g.strokeStyle = '#1a73e8';
    g.lineWidth = 1;
    for (const p of pts) {
      g.fillRect(Math.round(p.x) - 4, Math.round(p.y) - 4, 8, 8);
      g.strokeRect(Math.round(p.x) - 3.5, Math.round(p.y) - 3.5, 7, 7);
    }
    g.restore();
  };

  const drawRulers = (g: CanvasRenderingContext2D, W: number, H: number) => {
    const z = e.view.zoom;
    g.save();
    g.fillStyle = '#232426';
    g.fillRect(0, 0, W, RULER);
    g.fillRect(0, 0, RULER, H);
    g.strokeStyle = '#6f7275';
    g.fillStyle = '#9aa0a6';
    g.font = '9px Inter, sans-serif';
    g.lineWidth = 1;
    // Pick a tick step that leaves ~60px between labels.
    const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
    const step = steps.find((s) => s * z >= 60) || 10000;
    g.beginPath();
    const x0 = Math.floor(e.toDoc(RULER, 0).x / step) * step;
    for (let x = x0; e.toScreen({ x, y: 0 }).x < W; x += step / 5) {
      const s = Math.round(e.toScreen({ x, y: 0 }).x) + 0.5;
      if (s < RULER) continue;
      const major = Math.abs(x % step) < 1e-6;
      g.moveTo(s, RULER);
      g.lineTo(s, major ? 2 : RULER - 5);
      if (major) g.fillText(String(Math.round(x)), s + 3, 10);
    }
    const y0 = Math.floor(e.toDoc(0, RULER).y / step) * step;
    for (let y = y0; e.toScreen({ x: 0, y }).y < H; y += step / 5) {
      const s = Math.round(e.toScreen({ x: 0, y }).y) + 0.5;
      if (s < RULER) continue;
      const major = Math.abs(y % step) < 1e-6;
      g.moveTo(RULER, s);
      g.lineTo(major ? 2 : RULER - 5, s);
      if (major) {
        g.save();
        g.translate(10, s + 3);
        g.rotate(-Math.PI / 2);
        g.fillText(String(Math.round(y)), -20, 0);
        g.restore();
      }
    }
    g.stroke();
    // Cursor position markers.
    if (hover.current.inside) {
      g.strokeStyle = '#7cacf8';
      g.beginPath();
      g.moveTo(hover.current.sx + 0.5, 0);
      g.lineTo(hover.current.sx + 0.5, RULER);
      g.moveTo(0, hover.current.sy + 0.5);
      g.lineTo(RULER, hover.current.sy + 0.5);
      g.stroke();
    }
    g.fillStyle = '#2c2d30';
    g.fillRect(0, 0, RULER, RULER);
    g.restore();
  };

  useEffect(() => {
    e.onRender = draw;
    e.invalidate();
    return () => {
      if (e.onRender === draw) e.onRender = null;
    };
  });

  // ---------- Size ----------
  useLayoutEffect(() => {
    const host = hostRef.current!;
    const cv = canvasRef.current!;
    const update = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = host.clientWidth,
        h = host.clientHeight;
      if (!w || !h) return;
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      cv.style.width = `${w}px`;
      cv.style.height = `${h}px`;
      const first = e.viewport.w === 800 && e.viewport.h === 600 && e.view.fit;
      e.viewport = { w, h };
      if (e.view.fit || first) e.fitView();
      else e.requestFrame();
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  // Marching ants animation.
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => {
      if (!e.selection && e.overlay?.kind !== 'poly') return;
      ants.current = (ants.current + 1) % 8;
      e.requestFrame();
    }, 120);
    return () => clearInterval(id);
  }, [active]);

  // ---------- Input ----------
  const info = (ev: React.PointerEvent | PointerEvent, dbl = false): T.PtrInfo => {
    const r = canvasRef.current!.getBoundingClientRect();
    const sx = ev.clientX - r.left,
      sy = ev.clientY - r.top;
    const p = e.toDoc(sx, sy);
    const pressure = ev.pointerType === 'pen' ? Math.max(0.01, ev.pressure || 0.01) : 1;
    return { x: p.x, y: p.y, sx, sy, pressure, shift: ev.shiftKey, alt: ev.altKey, ctrl: ev.ctrlKey || ev.metaKey, button: space.current ? 1 : ev.button, dbl };
  };

  const lastDown = useRef({ t: 0, x: 0, y: 0 });
  const onDown = (ev: React.PointerEvent) => {
    if (ev.button === 2) return;
    try {
      (ev.target as HTMLElement).setPointerCapture(ev.pointerId);
    } catch {
      /* pointer already gone */
    }
    (document.activeElement as HTMLElement)?.blur?.();
    const now = performance.now();
    const dbl = now - lastDown.current.t < 350 && Math.hypot(ev.clientX - lastDown.current.x, ev.clientY - lastDown.current.y) < 6;
    lastDown.current = { t: now, x: ev.clientX, y: ev.clientY };
    ev.preventDefault();
    T.pointerDown(e, info(ev, dbl));
    setCursor(T.cursorFor(e, info(ev).sx, info(ev).sy));
  };
  const onMove = (ev: React.PointerEvent) => {
    const p = info(ev);
    hover.current = { sx: p.sx, sy: p.sy, inside: true };
    if (T.isDragging()) {
      const native = ev.nativeEvent;
      const list = native.getCoalescedEvents ? native.getCoalescedEvents() : [];
      if (list.length > 1) for (const c of list) T.pointerMove(e, info(c));
      else T.pointerMove(e, p);
    } else {
      T.pointerMove(e, p);
      setCursor(space.current ? 'grab' : T.cursorFor(e, p.sx, p.sy));
    }
    if (T.brushSizeOf(e) || e.showRulers) e.requestFrame();
    updateCursorInfo(p);
  };
  const onUp = (ev: React.PointerEvent) => {
    T.pointerUp(e, info(ev));
    setCursor(T.cursorFor(e, info(ev).sx, info(ev).sy));
  };
  const onLeave = () => {
    hover.current = { ...hover.current, inside: false };
    e.cursor = { ...e.cursor, inside: false };
    e.emitCursor();
    e.requestFrame();
  };

  const cursorFrame = useRef(0);
  const updateCursorInfo = (p: T.PtrInfo) => {
    if (cursorFrame.current) return;
    cursorFrame.current = requestAnimationFrame(() => {
      cursorFrame.current = 0;
      const inside = p.x >= 0 && p.y >= 0 && p.x < e.doc.w && p.y < e.doc.h;
      e.cursor = { x: Math.floor(p.x), y: Math.floor(p.y), inside, color: inside && !T.isDragging() ? pickColor(e, p.x, p.y, 1, true) : e.cursor.color };
      e.emitCursor();
    });
  };

  useEffect(() => {
    const host = hostRef.current!;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const r = host.getBoundingClientRect();
      const sx = ev.clientX - r.left,
        sy = ev.clientY - r.top;
      if (ev.ctrlKey || ev.metaKey || ev.altKey) {
        const k = Math.exp(-ev.deltaY * (ev.deltaMode === 1 ? 0.05 : 0.0018));
        e.zoomTo(e.view.zoom * k, sx, sy);
      } else {
        const dx = ev.shiftKey && !ev.deltaX ? ev.deltaY : ev.deltaX;
        const dy = ev.shiftKey && !ev.deltaX ? 0 : ev.deltaY;
        e.view = { ...e.view, panX: e.view.panX - dx, panY: e.view.panY - dy, fit: false };
        e.requestFrame();
      }
    };
    host.addEventListener('wheel', onWheel, { passive: false });
    return () => host.removeEventListener('wheel', onWheel);
  }, []);

  // Space bar: temporary hand tool.
  useEffect(() => {
    if (!active) return;
    const down = (ev: KeyboardEvent) => {
      if (ev.code !== 'Space' || isTyping(ev)) return;
      ev.preventDefault();
      if (!space.current) {
        space.current = true;
        setCursor('grab');
        e.requestFrame();
      }
    };
    const up = (ev: KeyboardEvent) => {
      if (ev.code !== 'Space') return;
      space.current = false;
      setCursor(T.cursorFor(e, hover.current.sx, hover.current.sy));
      e.requestFrame();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [active]);

  useEffect(() => e.subscribe(() => force((n) => n + 1)), []);

  return (
    <div className="ph-stage" ref={hostRef}>
      <canvas
        ref={canvasRef}
        className="ph-canvas"
        style={{ cursor }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onPointerLeave={onLeave}
        onContextMenu={(ev) => ev.preventDefault()}
      />
      {e.textEditing && <TextOverlay key={e.textEditing} engine={e} />}
      {e.busy && (
        <div className="ph-busy">
          <div className="spinner" />
          <span>{e.busy}…</span>
        </div>
      )}
    </div>
  );
}

export function isTyping(ev: KeyboardEvent) {
  const t = ev.target as HTMLElement;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

/** Invisible textarea over a text layer: typing updates the layer live (the canvas shows the real text). */
function TextOverlay({ engine: e }: { engine: Engine }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [, force] = useState(0);
  const f = e.find(e.textEditing);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  if (!f || f.layer.kind !== 'text') return null;
  const l = f.layer;
  const t = l.text;
  const b = textBox(t);
  const z = e.view.zoom;
  const tl = e.toScreen({ x: b.x, y: b.y });
  const minW = Math.max(40, t.size * z * 2);
  const w = Math.max(minW, b.w * z + t.size * z);
  const left = t.align === 'center' ? tl.x + (b.w * z) / 2 - w / 2 : t.align === 'right' ? tl.x + b.w * z - w : tl.x;
  return (
    <textarea
      ref={ref}
      className="ph-text-input"
      spellCheck={false}
      value={t.text}
      style={{
        left,
        top: tl.y,
        width: w,
        height: Math.max(b.h * z, t.size * t.leading * z) + 4,
        font: cssFont(t, z),
        lineHeight: `${t.size * t.leading * z}px`,
        textAlign: t.align,
        caretColor: t.color
      }}
      onChange={(ev) => {
        l.text = { ...l.text, text: ev.target.value };
        renderText(l);
        e.invalidate();
        force((n) => n + 1);
      }}
      onKeyDown={(ev) => {
        ev.stopPropagation();
        if (ev.key === 'Escape') {
          ev.preventDefault();
          T.endText(e, true);
        } else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
          ev.preventDefault();
          T.endText(e);
        }
      }}
    />
  );
}
