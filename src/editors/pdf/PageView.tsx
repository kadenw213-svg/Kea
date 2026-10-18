import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { pdfjsLib, PDFDocumentProxy } from './pdfjs';
import type { Annotation, Box, PageRef, TextAnn, Tool } from './types';
import { annBox, normBox, resizeAnn, translateAnn, FONT_CSS, LINE_HEIGHT } from './geometry';
import { uid } from '../../lib/util';
import { MessageSquare } from 'lucide-react';
import { scheduleRender, distanceFromView } from './renderQueue';

export interface ToolStyle {
  color: string;
  fill: string | null;
  strokeWidth: number;
  opacity: number;
  fontSize: number;
  font: TextAnn['font'];
  bold: boolean;
  italic: boolean;
}

interface Props {
  doc: PDFDocumentProxy | null;
  pageRef: PageRef;
  pageNumber: number;
  width: number; // viewport points, current rotation
  height: number;
  rotation: number; // effective rotation for pdf.js
  scale: number; // CSS px per point
  darkPages: boolean;
  annots: Annotation[];
  tool: Tool;
  style: ToolStyle;
  selectedId: string | null;
  editingId: string | null;
  searchRects: { rect: Box; active: boolean }[];
  scrollRoot: HTMLElement | null;
  onSelect(id: string | null): void;
  onBeginChange(): void;
  onLive(a: Annotation): void;
  onCreate(a: Annotation, opts?: { edit?: boolean }): void;
  onEditing(id: string | null): void;
  onEditExisting(pageId: string, x: number, y: number): void;
  onCanvas(pageId: string, canvas: HTMLCanvasElement | null, pxPerPt: number): void;
  onPageEl(pageId: string, el: HTMLDivElement | null): void;
}

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
type Handle = (typeof HANDLES)[number] | 'p1' | 'p2';

const measureCtx = document.createElement('canvas').getContext('2d')!;
export function measureTextAnn(a: Pick<TextAnn, 'text' | 'fontSize' | 'font' | 'bold' | 'italic'>) {
  measureCtx.font = `${a.italic ? 'italic ' : ''}${a.bold ? 'bold ' : ''}${a.fontSize}px ${FONT_CSS[a.font]}`;
  const lines = a.text.split('\n');
  return {
    width: Math.max(...lines.map((l) => measureCtx.measureText(l || ' ').width)),
    height: Math.max(1, lines.length) * a.fontSize * LINE_HEIGHT
  };
}

function PageViewInner(p: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [rendered, setRendered] = useState<{ scale: number; rotation: number } | null>(null);
  const [draft, setDraft] = useState<Annotation | null>(null);
  const drag = useRef<any>(null);

  const cssW = p.width * p.scale;
  const cssH = p.height * p.scale;

  useEffect(() => {
    p.onPageEl(p.pageRef.id, wrapRef.current);
    return () => p.onPageEl(p.pageRef.id, null);
  }, [p.pageRef.id]);

  // Only render pages near the viewport.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      const e = entries[entries.length - 1];
      setVisible(e.isIntersecting);
    }, { root: p.scrollRoot, rootMargin: '1000px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [p.scrollRoot]);

  // Canvas render (debounced so zooming stays smooth).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!visible) {
      canvas.width = 0;
      canvas.height = 0;
      setRendered(null);
      p.onCanvas(p.pageRef.id, null, 0);
      return;
    }
    if (!p.doc) {
      // Blank page
      setRendered({ scale: p.scale, rotation: p.rotation });
      return;
    }
    let task: any = null;
    let cancelled = false;
    let cancelJob: (() => void) | null = null;
    // Wait for zooming to settle, then queue the render by distance from the viewport.
    const t = setTimeout(
      () => {
        if (cancelled) return;
        cancelJob = scheduleRender(distanceFromView(wrapRef.current, p.scrollRoot), async () => {
          if (cancelled) return;
          try {
            const page = await p.doc!.getPage(p.pageRef.index + 1);
            if (cancelled) return;
            // The bitmap is exactly as many pixels as the page covers on screen (rounded, never floored), and pdf.js
            // stretches its drawing to fill it, so the browser never rescales it (rescaling by even one pixel blurs
            // the whole page at zooms like 75%, 125% or fit width). Very large zooms are capped to keep memory sane.
            const dpr = window.devicePixelRatio || 1;
            let rs = p.scale * dpr;
            const maxPixels = 25_000_000;
            if (p.width * p.height * rs * rs > maxPixels) rs = Math.sqrt(maxPixels / (p.width * p.height));
            const vp = page.getViewport({ scale: rs, rotation: p.rotation });
            const off = document.createElement('canvas');
            const capped = rs < p.scale * dpr - 1e-6;
            off.width = capped ? Math.round(vp.width) : Math.round(cssW * dpr);
            off.height = capped ? Math.round(vp.height) : Math.round(cssH * dpr);
            task = page.render({
              canvasContext: off.getContext('2d', { willReadFrequently: false })!,
              viewport: vp,
              transform: [off.width / vp.width, 0, 0, off.height / vp.height, 0, 0]
            });
            await task.promise;
            if (cancelled) return;
            // Hand the finished bitmap to the visible canvas without another copy.
            const bitmap = await createImageBitmap(off);
            if (cancelled) return bitmap.close();
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            (canvas.getContext('bitmaprenderer') as ImageBitmapRenderingContext).transferFromImageBitmap(bitmap);
            setRendered({ scale: p.scale, rotation: p.rotation });
            p.onCanvas(p.pageRef.id, off, rs);
          } catch (err: any) {
            if (err?.name !== 'RenderingCancelledException') console.error(err);
          }
        });
      },
      rendered ? 140 : 0
    );
    return () => {
      cancelled = true;
      clearTimeout(t);
      cancelJob?.();
      task?.cancel();
    };
  }, [visible, p.doc, p.pageRef.index, p.scale, p.rotation]);

  // Selectable text layer.
  useEffect(() => {
    const container = textLayerRef.current;
    if (!container || !visible || !p.doc) return;
    let layer: any = null;
    let cancelled = false;
    const t = setTimeout(async () => {
      const page = await p.doc!.getPage(p.pageRef.index + 1);
      if (cancelled) return;
      container.replaceChildren();
      const vp = page.getViewport({ scale: p.scale, rotation: p.rotation });
      layer = new pdfjsLib.TextLayer({ textContentSource: page.streamTextContent(), container, viewport: vp });
      try {
        await layer.render();
      } catch {}
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
      layer?.cancel?.();
    };
  }, [visible, p.doc, p.pageRef.index, p.scale, p.rotation]);

  const toPt = (e: { clientX: number; clientY: number }) => {
    const r = wrapRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / p.scale, y: (e.clientY - r.top) / p.scale };
  };
  const clampPt = (pt: { x: number; y: number }) => ({ x: Math.max(0, Math.min(p.width, pt.x)), y: Math.max(0, Math.min(p.height, pt.y)) });

  const startShapeDraft = (e: React.PointerEvent, type: Tool, pt: { x: number; y: number }) => {
    const s = p.style;
    const id = uid();
    let a: Annotation;
    switch (type) {
      case 'ink':
        a = { id, pageId: p.pageRef.id, type: 'ink', points: [pt.x, pt.y], color: s.color, width: s.strokeWidth, opacity: s.opacity };
        break;
      case 'line':
      case 'arrow':
        a = { id, pageId: p.pageRef.id, type, x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y, color: s.color, width: s.strokeWidth, opacity: s.opacity };
        break;
      case 'highlight':
      case 'underline':
      case 'strike':
        a = { id, pageId: p.pageRef.id, type, rects: [{ x: pt.x, y: pt.y, w: 0, h: 0 }], color: s.color, opacity: type === 'highlight' ? 0.4 : 1 };
        break;
      case 'whiteout':
      case 'redact':
        a = { id, pageId: p.pageRef.id, type, x: pt.x, y: pt.y, w: 0, h: 0, stroke: null, fill: s.fill || (type === 'redact' ? '#000000' : '#ffffff'), strokeWidth: 0, opacity: 1 };
        break;
      default:
        a = { id, pageId: p.pageRef.id, type: type as 'rect' | 'ellipse', x: pt.x, y: pt.y, w: 0, h: 0, stroke: s.color, fill: s.fill, strokeWidth: s.strokeWidth, opacity: s.opacity };
    }
    drag.current = { mode: 'draw', start: pt, ann: a };
    setDraft(a);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    const pt = toPt(e);
    const handleEl = target.closest('[data-handle]') as HTMLElement | null;
    const annEl = target.closest('[data-ann-id]') as HTMLElement | null;

    if (handleEl && p.selectedId) {
      const a = p.annots.find((x) => x.id === p.selectedId);
      if (!a) return;
      e.preventDefault();
      e.stopPropagation();
      p.onBeginChange();
      drag.current = { mode: 'resize', handle: handleEl.dataset.handle as Handle, start: pt, orig: a, box: annBox(a) };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }

    if (annEl && p.tool === 'text') {
      const a = p.annots.find((x) => x.id === annEl.dataset.annId);
      if (a?.type === 'text') {
        if (a.id === p.editingId) return;
        e.preventDefault();
        p.onSelect(a.id);
        p.onEditing(a.id);
        return;
      }
    }

    if (annEl && p.tool === 'select') {
      const id = annEl.dataset.annId!;
      if (id === p.editingId) return; // clicks inside the active text box are for the caret
      e.preventDefault();
      p.onEditing(null);
      p.onSelect(id);
      const a = p.annots.find((x) => x.id === id);
      if (!a) return;
      drag.current = { mode: 'move', start: pt, orig: a, moved: false };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }

    switch (p.tool) {
      case 'select':
        if (p.editingId) p.onEditing(null);
        p.onSelect(null);
        return; // let the text layer handle selection
      case 'highlight':
      case 'underline':
      case 'strike':
        if (target.closest('.textLayer span')) return; // native text selection → markup on mouseup
        e.preventDefault();
        startShapeDraft(e, p.tool, pt);
        return;
      case 'edittext':
        e.preventDefault();
        p.onEditExisting(p.pageRef.id, pt.x, pt.y);
        return;
      case 'text': {
        e.preventDefault();
        const s = p.style;
        const a: TextAnn = {
          id: uid(),
          pageId: p.pageRef.id,
          type: 'text',
          x: pt.x,
          y: pt.y - s.fontSize * 0.6,
          w: 40,
          h: s.fontSize * LINE_HEIGHT,
          text: '',
          fontSize: s.fontSize,
          font: s.font,
          bold: s.bold,
          italic: s.italic,
          color: s.color,
          align: 'left',
          auto: true
        } as TextAnn;
        p.onCreate(a, { edit: true });
        return;
      }
      case 'note':
        e.preventDefault();
        p.onCreate({ id: uid(), pageId: p.pageRef.id, type: 'note', x: pt.x - 11, y: pt.y - 11, text: '', color: p.style.color }, { edit: true });
        return;
      default:
        e.preventDefault();
        startShapeDraft(e, p.tool, clampPt(pt));
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const pt = toPt(e);
    if (d.mode === 'draw') {
      const c = clampPt(pt);
      let a = d.ann as Annotation;
      switch (a.type) {
        case 'ink': {
          const last = a.points.length;
          const lx = a.points[last - 2],
            ly = a.points[last - 1];
          if (Math.hypot(c.x - lx, c.y - ly) < 0.8) return;
          a = { ...a, points: [...a.points, c.x, c.y] };
          break;
        }
        case 'line':
        case 'arrow': {
          let x2 = c.x,
            y2 = c.y;
          if (e.shiftKey) {
            // Snap to 45° increments.
            const ang = Math.round(Math.atan2(y2 - a.y1, x2 - a.x1) / (Math.PI / 4)) * (Math.PI / 4);
            const len = Math.hypot(x2 - a.x1, y2 - a.y1);
            x2 = a.x1 + len * Math.cos(ang);
            y2 = a.y1 + len * Math.sin(ang);
          }
          a = { ...a, x2, y2 };
          break;
        }
        case 'highlight':
        case 'underline':
        case 'strike':
          a = { ...a, rects: [normBox(d.start.x, d.start.y, c.x, c.y)] };
          break;
        default: {
          let b = normBox(d.start.x, d.start.y, c.x, c.y);
          if (e.shiftKey) {
            const s = Math.max(b.w, b.h);
            b = { x: c.x < d.start.x ? d.start.x - s : d.start.x, y: c.y < d.start.y ? d.start.y - s : d.start.y, w: s, h: s };
          }
          a = { ...(a as any), ...b };
        }
      }
      d.ann = a;
      setDraft(a);
    } else if (d.mode === 'move') {
      const dx = pt.x - d.start.x,
        dy = pt.y - d.start.y;
      if (!d.moved) {
        if (Math.hypot(dx, dy) * p.scale < 3) return;
        d.moved = true;
        p.onBeginChange();
      }
      p.onLive(translateAnn(d.orig, dx, dy));
    } else if (d.mode === 'resize') {
      const a = d.orig as Annotation;
      if ((a.type === 'line' || a.type === 'arrow') && (d.handle === 'p1' || d.handle === 'p2')) {
        p.onLive(d.handle === 'p1' ? { ...a, x1: pt.x, y1: pt.y } : { ...a, x2: pt.x, y2: pt.y });
        return;
      }
      const b: Box = d.box;
      let x1 = b.x,
        y1 = b.y,
        x2 = b.x + b.w,
        y2 = b.y + b.h;
      const h: string = d.handle;
      if (h.includes('w')) x1 = pt.x;
      if (h.includes('e')) x2 = pt.x;
      if (h.includes('n')) y1 = pt.y;
      if (h.includes('s')) y2 = pt.y;
      let nb = normBox(x1, y1, x2, y2);
      const keepAspect = (a.type === 'image') !== e.shiftKey && h.length === 2;
      if (keepAspect && b.w && b.h) {
        const ratio = b.w / b.h;
        if (nb.w / nb.h > ratio) nb.w = nb.h * ratio;
        else nb.h = nb.w / ratio;
        if (h.includes('w')) nb.x = b.x + b.w - nb.w;
        if (h.includes('n')) nb.y = b.y + b.h - nb.h;
      }
      nb.w = Math.max(nb.w, 4);
      nb.h = Math.max(nb.h, 4);
      let out = resizeAnn(a, b, nb) as Annotation;
      if (out.type === 'text') {
        out = { ...out, auto: false, h: Math.max(nb.h, measureTextAnn(out).height) } as TextAnn;
      }
      p.onLive(out);
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}
    if (!d) return;
    if (d.mode === 'draw') {
      setDraft(null);
      const a = d.ann as Annotation;
      const b = annBox(a);
      const tiny = b.w < 3 && b.h < 3;
      if (a.type === 'ink') {
        p.onCreate(a);
      } else if (!tiny) {
        p.onCreate(a);
      }
    } else if (d.mode === 'move' && !d.moved) {
      const a = d.orig as Annotation;
      if (a.type === 'text' && e.detail >= 2) p.onEditing(a.id);
    }
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const annEl = (e.target as HTMLElement).closest('[data-ann-id]') as HTMLElement | null;
    if (!annEl) return;
    const a = p.annots.find((x) => x.id === annEl.dataset.annId);
    if (a && (a.type === 'text' || a.type === 'note')) {
      p.onSelect(a.id);
      p.onEditing(a.id);
    }
  };

  const textLayerActive = p.tool === 'select' || p.tool === 'highlight' || p.tool === 'underline' || p.tool === 'strike';
  const interactive = p.tool === 'select';
  const all = draft ? [...p.annots, draft] : p.annots;
  const selected = p.annots.find((a) => a.id === p.selectedId) || null;

  return (
    <div
      ref={wrapRef}
      className={`pdf-page tool-${p.tool}`}
      data-page-id={p.pageRef.id}
      style={{ width: cssW, height: cssH, ['--scale-factor' as any]: p.scale }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
    >
      <canvas
        ref={canvasRef}
        className={`pdf-canvas ${p.darkPages ? 'dark' : ''}`}
        style={{
          width: cssW,
          height: cssH,
          opacity: rendered || !p.doc ? 1 : 0
        }}
      />
      {!rendered && p.doc && visible && <div className="page-loading" />}
      <div ref={textLayerRef} className="textLayer" style={{ pointerEvents: textLayerActive ? 'auto' : 'none' }} />

      <div className="ann-layer" style={{ width: p.width, height: p.height, transform: `scale(${p.scale})` }}>
        <svg className="ann-svg" width={p.width} height={p.height} viewBox={`0 0 ${p.width} ${p.height}`}>
          {p.searchRects.map((s, i) => (
            <rect key={i} x={s.rect.x - 1} y={s.rect.y - 1} width={s.rect.w + 2} height={s.rect.h + 2} rx={2} className={s.active ? 'search-hit active' : 'search-hit'} />
          ))}
          {all.map((a) => (
            <SvgAnn key={a.id} a={a} interactive={interactive} />
          ))}
        </svg>
        {all.map((a) =>
          a.type === 'text' || a.type === 'image' || a.type === 'note' ? (
            <HtmlAnn key={a.id} a={a} interactive={interactive || (p.tool === 'text' && a.type === 'text')} editing={p.editingId === a.id} onLive={p.onLive} onDone={() => p.onEditing(null)} pageW={p.width} />
          ) : null
        )}
        {selected && !draft && <Selection a={selected} scale={p.scale} />}
      </div>
    </div>
  );
}

function SvgAnn({ a, interactive }: { a: Annotation; interactive: boolean }) {
  const pe = interactive ? 'all' : 'none';
  switch (a.type) {
    case 'redact':
      // Shown with a red dashed outline so it's clear this area will be removed on save.
      return (
        <g data-ann-id={a.id} style={{ pointerEvents: pe as any }}>
          <rect x={a.x} y={a.y} width={a.w} height={a.h} fill={a.fill || '#000'} />
          <rect x={a.x} y={a.y} width={a.w} height={a.h} fill="none" stroke="#f28b82" strokeWidth={1.2} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
        </g>
      );
    case 'rect':
    case 'whiteout':
      return (
        <rect
          data-ann-id={a.id}
          x={a.x}
          y={a.y}
          width={a.w}
          height={a.h}
          fill={a.fill || 'transparent'}
          stroke={a.stroke || 'none'}
          strokeWidth={a.stroke ? a.strokeWidth : 0}
          opacity={a.opacity}
          style={{ pointerEvents: pe as any }}
        />
      );
    case 'ellipse':
      return (
        <ellipse
          data-ann-id={a.id}
          cx={a.x + a.w / 2}
          cy={a.y + a.h / 2}
          rx={a.w / 2}
          ry={a.h / 2}
          fill={a.fill || 'transparent'}
          stroke={a.stroke || 'none'}
          strokeWidth={a.strokeWidth}
          opacity={a.opacity}
          style={{ pointerEvents: pe as any }}
        />
      );
    case 'highlight':
      return (
        <g data-ann-id={a.id} style={{ pointerEvents: pe as any, mixBlendMode: 'multiply' }}>
          {a.rects.map((r, i) => (
            <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} fill={a.color} opacity={a.opacity} />
          ))}
        </g>
      );
    case 'underline':
    case 'strike':
      return (
        <g data-ann-id={a.id} style={{ pointerEvents: pe as any }}>
          {a.rects.map((r, i) => {
            const t = Math.max(0.8, r.h * 0.07);
            const y = a.type === 'underline' ? r.y + r.h - t / 2 : r.y + r.h * 0.55;
            return (
              <g key={i}>
                <rect x={r.x} y={r.y} width={r.w} height={r.h} fill="transparent" />
                <line x1={r.x} y1={y} x2={r.x + r.w} y2={y} stroke={a.color} strokeWidth={t} opacity={a.opacity} />
              </g>
            );
          })}
        </g>
      );
    case 'ink': {
      let d = '';
      for (let i = 0; i < a.points.length; i += 2) d += `${i ? 'L' : 'M'}${a.points[i]} ${a.points[i + 1]}`;
      if (a.points.length === 2) d += `L${a.points[0] + 0.01} ${a.points[1]}`;
      return (
        <g data-ann-id={a.id} style={{ pointerEvents: pe as any }}>
          <path d={d} stroke="transparent" strokeWidth={Math.max(a.width, 10)} fill="none" strokeLinecap="round" strokeLinejoin="round" />
          <path d={d} stroke={a.color} strokeWidth={a.width} fill="none" strokeLinecap="round" strokeLinejoin="round" opacity={a.opacity} />
        </g>
      );
    }
    case 'line':
    case 'arrow': {
      const ang = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
      const len = Math.max(8, a.width * 4);
      const head =
        a.type === 'arrow'
          ? `M${a.x2} ${a.y2} L${a.x2 - len * Math.cos(ang - 0.45)} ${a.y2 - len * Math.sin(ang - 0.45)} L${a.x2 - len * Math.cos(ang + 0.45)} ${a.y2 - len * Math.sin(ang + 0.45)} Z`
          : '';
      return (
        <g data-ann-id={a.id} style={{ pointerEvents: pe as any }} opacity={a.opacity}>
          <line x1={a.x1} y1={a.y1} x2={a.x2} y2={a.y2} stroke="transparent" strokeWidth={Math.max(10, a.width)} />
          <line x1={a.x1} y1={a.y1} x2={a.x2} y2={a.y2} stroke={a.color} strokeWidth={a.width} strokeLinecap="round" />
          {head && <path d={head} fill={a.color} />}
        </g>
      );
    }
    default:
      return null;
  }
}

function HtmlAnn({
  a,
  interactive,
  editing,
  onLive,
  onDone,
  pageW
}: {
  a: Annotation;
  interactive: boolean;
  editing: boolean;
  onLive(a: Annotation): void;
  onDone(): void;
  pageW: number;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (editing && taRef.current) {
      taRef.current.focus();
      const len = taRef.current.value.length;
      taRef.current.setSelectionRange(len, len);
    }
  }, [editing]);

  if (a.type === 'image') {
    return (
      <img
        data-ann-id={a.id}
        src={a.dataUrl}
        draggable={false}
        style={{ position: 'absolute', left: a.x, top: a.y, width: a.w, height: a.h, pointerEvents: interactive ? 'auto' : 'none' }}
      />
    );
  }
  if (a.type === 'note') {
    return (
      <div data-ann-id={a.id} className="note-ann" style={{ left: a.x, top: a.y, pointerEvents: interactive || editing ? 'auto' : 'none' }}>
        <MessageSquare size={22} fill={a.color} color="#3c3c3c" strokeWidth={1.4} />
        {editing && (
          <div className="note-pop" onPointerDown={(e) => e.stopPropagation()}>
            <textarea
              autoFocus
              value={a.text}
              placeholder="Add a comment…"
              onChange={(e) => onLive({ ...a, text: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Escape') onDone();
              }}
            />
            <button className="btn sm primary" onClick={onDone}>
              Done
            </button>
          </div>
        )}
        {!editing && a.text && <div className="note-tip">{a.text}</div>}
      </div>
    );
  }
  if (a.type !== 'text') return null;
  const t = a as TextAnn & { auto?: boolean };
  const style: React.CSSProperties = {
    position: 'absolute',
    left: t.x,
    top: t.y,
    width: t.w,
    minHeight: t.h,
    fontFamily: FONT_CSS[t.font],
    fontSize: t.fontSize,
    fontWeight: t.bold ? 700 : 400,
    fontStyle: t.italic ? 'italic' : 'normal',
    color: t.color,
    textAlign: t.align,
    lineHeight: LINE_HEIGHT,
    background: t.bg || 'transparent',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
    padding: 0,
    margin: 0,
    border: 'none'
  };
  if (editing) {
    return (
      <textarea
        ref={taRef}
        data-ann-id={a.id}
        className="text-ann editing"
        style={{ ...style, height: t.h, resize: 'none', outline: 'none', overflow: 'hidden' }}
        value={t.text}
        spellCheck
        onPointerDown={(e) => e.stopPropagation()}
        onChange={(e) => {
          const text = e.target.value;
          let next: any = { ...t, text };
          const m = measureTextAnn(next);
          if (t.auto) next.w = Math.min(Math.max(m.width + 2, 20), Math.max(20, pageW - t.x));
          next.h = m.height;
          onLive(next);
          // Wrapped lines make the box taller than the line count suggests.
          requestAnimationFrame(() => {
            const el = taRef.current;
            if (el && el.scrollHeight > next.h + 1) onLive({ ...next, h: el.scrollHeight });
          });
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onDone();
          }
          e.stopPropagation();
        }}
        onBlur={onDone}
      />
    );
  }
  return (
    <div data-ann-id={a.id} className="text-ann" style={{ ...style, pointerEvents: interactive ? 'auto' : 'none' }}>
      {t.text || '​'}
    </div>
  );
}

function Selection({ a, scale }: { a: Annotation; scale: number }) {
  const b = annBox(a);
  const hs = 9 / scale; // handle size in points so it stays 9px on screen
  if (a.type === 'line' || a.type === 'arrow') {
    return (
      <>
        {(['p1', 'p2'] as const).map((h) => {
          const x = h === 'p1' ? a.x1 : a.x2;
          const y = h === 'p1' ? a.y1 : a.y2;
          return <div key={h} data-handle={h} className="sel-handle" style={{ left: x - hs / 2, top: y - hs / 2, width: hs, height: hs, borderWidth: 1.5 / scale }} />;
        })}
      </>
    );
  }
  const resizable = !(a.type === 'highlight' || a.type === 'underline' || a.type === 'strike' || a.type === 'note');
  const pad = 2 / scale;
  return (
    <div className="sel-box" style={{ left: b.x - pad, top: b.y - pad, width: b.w + 2 * pad, height: b.h + 2 * pad, borderWidth: 1.5 / scale }}>
      {resizable &&
        HANDLES.map((h) => {
          const left = h.includes('w') ? -hs / 2 : h.includes('e') ? b.w + 2 * pad - hs / 2 : (b.w + 2 * pad) / 2 - hs / 2;
          const top = h.includes('n') ? -hs / 2 : h.includes('s') ? b.h + 2 * pad - hs / 2 : (b.h + 2 * pad) / 2 - hs / 2;
          return <div key={h} data-handle={h} className={`sel-handle h-${h}`} style={{ left: left - 1.5 / scale, top: top - 1.5 / scale, width: hs, height: hs, borderWidth: 1.5 / scale }} />;
        })}
    </div>
  );
}

export const PageView = memo(PageViewInner);
