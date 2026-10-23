import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  Lock,
  LockOpen,
  Eye,
  EyeOff,
  Volume2,
  VolumeX,
  Plus,
  Trash2,
  Scissors,
  Link2,
  Unlink2,
  Copy,
  ClipboardPaste,
  Blend,
  ArrowLeftToLine,
  ArrowRightToLine,
  Film,
  Music,
  Type,
  Square,
  CopyPlus,
  Pencil,
  Gauge,
  Flag
} from 'lucide-react';
import { prompt } from '../../store';
import { clamp } from '../../lib/util';
import type { Project, Clip, Track, TransitionType, TextStyle } from './model';
import { clipEnd, clipDuration, mediaOf, projectDuration, snapToFrame, timecode, labelColour, ANIMATABLE, sourceTime, TRANSITIONS } from './model';
import { useVE, useVEStore } from './state';
import { withLinked, trimStart, trimEnd, trimRange, rippleTrim, roll, slip, insert, overwrite, isLocked, splitAt, maxTransition, setTransition, addTrack, removeTrack } from './ops';
import { transitionSpan } from './transitions';
import { useMediaCache, mediaKey } from './media';
import * as act from './actions';

/* The timeline: track headers on the left, a ruler on top, clips laid out by time. */

export const HEAD_W = 172;
const RULER_H = 30;
const ROW_H: Record<Track['kind'], number> = { video: 58, audio: 52 };
const EDGE = 7;
const SNAP_PX = 8;

export const DND_MEDIA = 'application/x-kea-media';
export const DND_TRANSITION = 'application/x-kea-transition';
export const DND_TEXT = 'application/x-kea-text';

/** Tracks top to bottom as shown: highest video track first, then audio tracks. */
export function displayTracks(p: Project) {
  return [...p.tracks.filter((t) => t.kind === 'video').reverse(), ...p.tracks.filter((t) => t.kind === 'audio')];
}

interface MenuItem {
  label?: string;
  icon?: ReactNode;
  kbd?: string;
  disabled?: boolean;
  sep?: boolean;
  run?: () => void;
}

export function ContextMenu({ at, items, onClose }: { at: { x: number; y: number }; items: MenuItem[]; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: at.x, top: at.y });
  useLayoutEffect(() => {
    const r = ref.current!.getBoundingClientRect();
    setPos({ left: Math.min(at.x, window.innerWidth - r.width - 8), top: at.y + r.height > window.innerHeight - 8 ? Math.max(8, at.y - r.height) : at.y });
  }, [at]);
  useEffect(() => {
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', down, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('mousedown', down, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [onClose]);
  return createPortal(
    <div ref={ref} className="popover" style={pos} onContextMenu={(e) => e.preventDefault()}>
      {items.map((it, i) =>
        it.sep ? (
          <div key={i} className="menu-sep" />
        ) : (
          <button
            key={i}
            className="menu-item"
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.run?.();
            }}
          >
            {it.icon} {it.label} {it.kbd && <span className="kbd">{it.kbd}</span>}
          </button>
        )
      )}
    </div>,
    document.body
  );
}

export function Timeline({ onDropFiles }: { onDropFiles(files: File[], at: number, trackId: string | null): void }) {
  const store = useVEStore();
  const project = useVE((s) => s.project);
  const sel = useVE((s) => s.sel);
  const selTransition = useVE((s) => s.selTransition);
  const selMarker = useVE((s) => s.selMarker);
  const zoom = useVE((s) => s.zoom);
  const tool = useVE((s) => s.tool);
  const playing = useVE((s) => s.playing);
  const missing = useMediaCache((s) => s.missing);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  const [viewW, setViewW] = useState(800);
  const [snapLine, setSnapLine] = useState<number | null>(null);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; items: MenuItem[] } | null>(null);
  const [hover, setHover] = useState<string>('');
  const zoomAnchor = useRef<{ t: number; x: number } | null>(null);

  const rows = useMemo(() => displayTracks(project), [project.tracks]);
  const rowTops = useMemo(() => {
    const tops: number[] = [];
    let y = 0;
    for (const r of rows) {
      tops.push(y);
      y += ROW_H[r.kind];
    }
    tops.push(y);
    return tops;
  }, [rows]);
  const total = projectDuration(project);
  const contentW = Math.max(viewW - HEAD_W, (total + 30) * zoom);
  const fps = project.settings.fps;
  const selSet = useMemo(() => new Set(sel), [sel]);

  useEffect(() => {
    const el = scrollRef.current!;
    const ro = new ResizeObserver(() => setViewW(el.clientWidth));
    ro.observe(el);
    setViewW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Keep the time under the pointer still while zooming.
  useLayoutEffect(() => {
    const a = zoomAnchor.current;
    if (!a || !scrollRef.current) return;
    scrollRef.current.scrollLeft = a.t * zoom - a.x;
    zoomAnchor.current = null;
  }, [zoom]);

  // Page along with the playhead while playing.
  useEffect(() => {
    if (!playing) return;
    return store.subscribe((s) => {
      const el = scrollRef.current;
      if (!el) return;
      const x = s.playhead * s.zoom;
      const w = el.clientWidth - HEAD_W;
      if (x < el.scrollLeft || x > el.scrollLeft + w - 20) el.scrollLeft = x - 40;
    });
  }, [playing]);

  useEffect(() => {
    const el = scrollRef.current!;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.altKey) {
        e.preventDefault();
        const r = lanesRef.current!.getBoundingClientRect();
        const s = store.getState();
        const t = (e.clientX - r.left) / s.zoom;
        zoomAnchor.current = { t, x: e.clientX - el.getBoundingClientRect().left - HEAD_W };
        s.set({ zoom: clamp(s.zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2), 2, 2000) });
      } else if (e.shiftKey && !e.deltaX) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  /* ---------- Geometry ---------- */

  const timeAt = (clientX: number) => Math.max(0, (clientX - lanesRef.current!.getBoundingClientRect().left) / store.getState().zoom);
  const rowAt = (clientY: number) => {
    const y = clientY - lanesRef.current!.getBoundingClientRect().top;
    for (let i = 0; i < rows.length; i++) if (y >= rowTops[i] && y < rowTops[i + 1]) return i;
    return y < 0 ? 0 : rows.length - 1;
  };

  /** Snap a time to the playhead, in/out, markers and clip edges (except `skip`). */
  const snapper = (skip: Set<string>) => {
    const s = store.getState();
    const p = s.project;
    const pts = [0, s.playhead, ...p.markers.map((m) => m.t)];
    if (p.inPoint !== null) pts.push(p.inPoint);
    if (p.outPoint !== null) pts.push(p.outPoint);
    for (const c of p.clips) if (!skip.has(c.id)) pts.push(c.start, clipEnd(c));
    return (times: number[]): number => {
      if (!s.snapping) return 0;
      const thr = SNAP_PX / s.zoom;
      let best = 0;
      let bestD = thr;
      let line: number | null = null;
      for (const t of times)
        for (const x of pts) {
          const d = Math.abs(x - t);
          if (d < bestD) {
            bestD = d;
            best = x - t;
            line = x;
          }
        }
      setSnapLine(line);
      return best;
    };
  };

  /** Run a drag: `move` gets the pointer's offset in px; `up` runs once at the end. */
  const drag = (e: React.PointerEvent, move: (dx: number, dy: number, ev: PointerEvent) => void, up?: (moved: boolean, ev: PointerEvent) => void) => {
    const x0 = e.clientX;
    const y0 = e.clientY;
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) < 3) return;
      moved = true;
      // Scroll when dragging past the edges.
      const el = scrollRef.current!;
      const r = el.getBoundingClientRect();
      if (ev.clientX > r.right - 30) el.scrollLeft += 18;
      else if (ev.clientX < r.left + HEAD_W + 30) el.scrollLeft -= 18;
      move(ev.clientX - x0, ev.clientY - y0, ev);
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setSnapLine(null);
      up?.(moved, ev);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  /* ---------- Ruler & playhead ---------- */

  const scrub = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const s = store.getState();
    s.set({ focus: 'timeline' });
    const go = (clientX: number, shift: boolean) => {
      let t = snapToFrame(timeAt(clientX), fps);
      if (shift) {
        const pts = act.editPoints(store);
        const near = pts.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a), pts[0]);
        if (Math.abs(near - t) * store.getState().zoom < 14) t = near;
      }
      store.getState().seek(t);
    };
    go(e.clientX, e.shiftKey);
    drag(e, (_dx, _dy, ev) => go(ev.clientX, ev.shiftKey));
  };

  const markerDown = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    store.setState({ selMarker: id, sel: [], selTransition: null });
    const m0 = store.getState().project.markers.find((m) => m.id === id)!;
    store.getState().begin('Move marker');
    const snap = snapper(new Set());
    drag(
      e,
      (dx) => {
        let t = Math.max(0, m0.t + dx / zoom);
        t += snap([t]);
        store.getState().liveFrom((p) => {
          const m = p.markers.find((x) => x.id === id);
          if (m) m.t = snapToFrame(t, fps);
        });
      },
      (moved) => {
        store.getState().end();
        if (!moved) store.getState().seek(m0.t);
      }
    );
  };

  const renameMarker = async (id: string) => {
    const m = store.getState().project.markers.find((x) => x.id === id);
    if (!m) return;
    const name = await prompt('Rename marker', 'Name', m.name);
    if (name !== null) store.getState().commit('Rename marker', (p) => void (p.markers.find((x) => x.id === id)!.name = name));
  };

  /* ---------- Clips ---------- */

  const clipDown = (e: React.PointerEvent, c: Clip) => {
    e.stopPropagation();
    const s = store.getState();
    s.set({ focus: 'timeline' });
    if (e.button === 2) {
      if (!s.sel.includes(c.id)) s.select(e.altKey ? [c.id] : withLinked(s.project, [c.id]));
      return;
    }
    if (e.button !== 0) return;
    const locked = isLocked(s.project, c);
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const nearStart = e.clientX - r.left < EDGE && r.width > EDGE * 3;
    const nearEnd = r.right - e.clientX < EDGE && r.width > EDGE * 3;
    const t = snapToFrame(timeAt(e.clientX), fps);

    if (tool === 'razor') {
      if (locked) return;
      const ids = e.altKey ? [c.id] : withLinked(s.project, [c.id]);
      let tt = t;
      tt += snapper(new Set())([tt]);
      setSnapLine(null);
      s.commit('Razor', (p) => {
        for (const id of ids) {
          const x = p.clips.find((y) => y.id === id);
          if (x) splitAt(p, tt, [x.id]);
        }
      });
      return;
    }

    // Selection: Shift/Ctrl add or remove; Alt picks one side of a linked pair.
    let nextSel = s.sel;
    const group = e.altKey ? [c.id] : withLinked(s.project, [c.id]);
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      nextSel = s.sel.includes(c.id) ? s.sel.filter((id) => !group.includes(id)) : [...new Set([...s.sel, ...group])];
      s.select(nextSel);
      return;
    }
    if (!s.sel.includes(c.id)) {
      nextSel = group;
      s.select(nextSel);
    }
    if (locked) return;

    if (nearStart || nearEnd) return trimDrag(e, c, nearStart ? 'start' : 'end');
    if (tool === 'slip') return slipDrag(e, c);
    moveDrag(e, c, nextSel);
  };

  const moveDrag = (e: React.PointerEvent, c: Clip, selIds: string[]) => {
    const s = store.getState();
    const p0 = s.project;
    const moving = new Set(e.altKey ? selIds : withLinked(p0, selIds));
    const clips0 = p0.clips.filter((x) => moving.has(x.id) && !isLocked(p0, x));
    if (!clips0.length) return;
    const startRow = rows.findIndex((r) => r.id === c.trackId);
    const kind = rows[startRow].kind;
    const minStart = Math.min(...clips0.map((x) => x.start));
    const snap = snapper(moving);
    s.begin('Move');
    drag(
      e,
      (dx, _dy, ev) => {
        let dt = dx / store.getState().zoom;
        dt = Math.max(-minStart, dt);
        const edges = clips0.flatMap((x) => [x.start + dt, clipEnd(x) + dt]);
        dt += snap(edges);
        dt = Math.max(-minStart, dt);
        const dRow = rowAt(ev.clientY) - startRow;
        const insertMode = ev.ctrlKey;
        store.getState().liveFrom((p) => {
          const ids = new Set(clips0.map((x) => x.id));
          const moved = p.clips.filter((x) => ids.has(x.id));
          p.clips = p.clips.filter((x) => !ids.has(x.id));
          for (const m of moved) {
            m.start = snapToFrame(m.start + dt, fps);
            // Only clips of the grabbed kind change track; the rest keep theirs.
            const i = rows.findIndex((r) => r.id === m.trackId);
            const j = i + dRow;
            if (rows[i].kind === kind && rows[j] && rows[j].kind === kind && !rows[j].locked) m.trackId = rows[j].id;
          }
          if (insertMode) insert(p, moved);
          else overwrite(p, moved);
        });
      },
      (moved) => {
        if (moved) store.getState().end();
        else store.getState().cancelDrag();
      }
    );
  };

  const trimDrag = (e: React.PointerEvent, c: Clip, edge: 'start' | 'end') => {
    const s = store.getState();
    const p0 = s.project;
    const group = e.altKey ? [c.id] : withLinked(p0, [c.id]);
    const list0 = p0.clips.filter((x) => x.trackId === c.trackId).sort((a, b) => a.start - b.start);
    const i = list0.findIndex((x) => x.id === c.id);
    const prev = list0[i - 1];
    const next = list0[i + 1];
    const touching = edge === 'start' ? prev && Math.abs(clipEnd(prev) - c.start) < 1e-3 && prev : next && Math.abs(clipEnd(c) - next.start) < 1e-3 && next;
    const mode = tool === 'ripple' ? 'ripple' : tool === 'roll' && touching ? 'roll' : 'trim';
    const edgeT = edge === 'start' ? c.start : clipEnd(c);
    const snap = snapper(new Set(group));
    s.begin(mode === 'ripple' ? 'Ripple trim' : mode === 'roll' ? 'Roll edit' : 'Trim');
    drag(
      e,
      (dx) => {
        let d = dx / store.getState().zoom;
        d += snap([edgeT + d]);
        d = Math.round(d * fps) / fps;
        store.getState().liveFrom((p) => {
          const cc = p.clips.find((x) => x.id === c.id)!;
          if (mode === 'ripple') return void rippleTrim(p, cc, edge, edge === 'start' ? d : d);
          if (mode === 'roll' && touching) {
            const other = p.clips.find((x) => x.id === touching.id)!;
            return void (edge === 'end' ? roll(p, cc, other, d) : roll(p, other, cc, d));
          }
          // A plain trim stops at the neighbouring clip.
          if (edge === 'start') {
            const lo = prev ? clipEnd(prev) - c.start : -Infinity;
            d = Math.max(d, lo);
          } else {
            const hi = next ? next.start - clipEnd(c) : Infinity;
            d = Math.min(d, hi);
          }
          const [lo, hi] = trimRange(p, cc, edge);
          d = clamp(d, lo, hi);
          for (const id of group) {
            const x = p.clips.find((y) => y.id === id);
            if (!x) continue;
            if (edge === 'start') trimStart(p, x, d);
            else trimEnd(p, x, d);
          }
        });
      },
      (moved) => (moved ? store.getState().end() : store.getState().cancelDrag())
    );
  };

  const slipDrag = (e: React.PointerEvent, c: Clip) => {
    const s = store.getState();
    const group = e.altKey ? [c.id] : withLinked(s.project, [c.id]);
    s.begin('Slip');
    drag(
      e,
      (dx) => {
        const d = -(Math.round((dx / store.getState().zoom) * fps) / fps) * c.speed;
        store.getState().liveFrom((p) => {
          for (const id of group) {
            const x = p.clips.find((y) => y.id === id);
            if (x) slip(p, x, x.reverse ? -d : d);
          }
        });
      },
      (moved) => (moved ? store.getState().end() : store.getState().cancelDrag())
    );
  };

  const transitionDown = (e: React.PointerEvent, clipId: string, edge: 'in' | 'out', handle: -1 | 0 | 1) => {
    e.stopPropagation();
    const s = store.getState();
    store.setState({ selTransition: { clipId, edge }, sel: [], selMarker: null, focus: 'timeline' });
    if (!handle || e.button !== 0) return;
    const c = s.project.clips.find((x) => x.id === clipId)!;
    const tr = edge === 'in' ? c.trIn : c.trOut;
    if (!tr) return;
    const span = transitionSpan(s.project, c, edge)!;
    const centred = Math.abs((span[0] + span[1]) / 2 - (edge === 'in' ? c.start : clipEnd(c))) < 1e-3;
    const max = maxTransition(s.project, c, edge);
    s.begin('Transition length');
    drag(
      e,
      (dx) => {
        const dt = (dx / store.getState().zoom) * handle * (centred ? 2 : 1);
        const d = clamp(tr.duration + dt, 1 / fps, max);
        store.getState().liveFrom((p) => void setTransition(p, clipId, edge, { ...tr, duration: Math.round(d * fps) / fps }));
      },
      (moved) => (moved ? store.getState().end() : store.getState().cancelDrag())
    );
  };

  /* ---------- Empty space ---------- */

  const lanesDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const s = store.getState();
    s.set({ focus: 'timeline' });
    const r = lanesRef.current!.getBoundingClientRect();
    const x0 = e.clientX - r.left;
    const y0 = e.clientY - r.top;
    const additive = e.shiftKey || e.ctrlKey;
    const base = additive ? s.sel : [];
    if (!additive) s.select([]);
    drag(
      e,
      (dx, dy) => {
        const m = { x0, y0, x1: x0 + dx, y1: y0 + dy };
        setMarquee(m);
        const t0 = Math.min(m.x0, m.x1) / zoom;
        const t1 = Math.max(m.x0, m.x1) / zoom;
        const ya = Math.min(m.y0, m.y1);
        const yb = Math.max(m.y0, m.y1);
        const hitRows = rows.filter((_, i) => rowTops[i + 1] > ya && rowTops[i] < yb).map((x) => x.id);
        const p = store.getState().project;
        const hits = p.clips.filter((c) => hitRows.includes(c.trackId) && c.start < t1 && clipEnd(c) > t0 && !isLocked(p, c)).map((c) => c.id);
        store.getState().select([...new Set([...base, ...hits])]);
      },
      (moved) => {
        setMarquee(null);
        if (!moved) store.getState().seek(snapToFrame(timeAt(e.clientX), fps));
      }
    );
  };

  /* ---------- Menus ---------- */

  const clipMenu = (e: React.MouseEvent, c: Clip) => {
    e.preventDefault();
    e.stopPropagation();
    const s = store.getState();
    const linked = !!c.linkId;
    const m = mediaOf(s.project, c);
    const isVideo = rows.find((r) => r.id === c.trackId)?.kind === 'video';
    const tr = (type: TransitionType, edge: 'in' | 'out') => () => act.addTransitionAt(store, c.id, edge, type);
    setMenu({
      at: { x: e.clientX, y: e.clientY },
      items: [
        { label: 'Split at playhead', icon: <Scissors size={16} />, kbd: 'Ctrl+K', run: () => act.splitAtPlayhead(store) },
        { label: 'Copy', icon: <Copy size={16} />, kbd: 'Ctrl+C', run: () => act.copySelection(store) },
        { label: 'Duplicate', icon: <CopyPlus size={16} />, kbd: 'Ctrl+D', run: () => act.duplicateSelection(store) },
        { label: 'Paste at playhead', icon: <ClipboardPaste size={16} />, kbd: 'Ctrl+V', disabled: !s.clipboard, run: () => act.pasteClipboard(store) },
        { sep: true },
        { label: 'Add cross dissolve at start', icon: <ArrowLeftToLine size={16} />, run: tr(isVideo ? 'dissolve' : 'dissolve', 'in') },
        { label: 'Add cross dissolve at end', icon: <ArrowRightToLine size={16} />, run: tr('dissolve', 'out') },
        ...(isVideo ? [{ label: 'Dip to black at end', icon: <Blend size={16} />, run: tr('dipBlack', 'out') }] : []),
        { sep: true },
        linked
          ? { label: 'Unlink picture and sound', icon: <Unlink2 size={16} />, run: () => act.linkSelection(store, false) }
          : { label: 'Link selected clips', icon: <Link2 size={16} />, disabled: s.sel.length < 2, run: () => act.linkSelection(store, true) },
        {
          label: 'Rename…',
          icon: <Pencil size={16} />,
          run: async () => {
            const name = await prompt('Rename clip', 'Name', c.name);
            if (name) store.getState().commit('Rename clip', (p) => void (p.clips.find((x) => x.id === c.id)!.name = name));
          }
        },
        ...(m && m.kind !== 'image'
          ? [
              {
                label: c.speed === 1 ? 'Double speed' : 'Normal speed',
                icon: <Gauge size={16} />,
                run: () =>
                  store.getState().commit('Speed', (p) => {
                    for (const id of withLinked(p, [c.id])) {
                      const x = p.clips.find((y) => y.id === id)!;
                      x.speed = c.speed === 1 ? 2 : 1;
                    }
                  })
              }
            ]
          : []),
        { sep: true },
        { label: 'Delete', icon: <Trash2 size={16} />, kbd: 'Delete', run: () => act.deleteSelection(store, false) },
        { label: 'Ripple delete', icon: <Trash2 size={16} />, kbd: 'Shift+Delete', run: () => act.deleteSelection(store, true) }
      ]
    });
  };

  const laneMenu = (e: React.MouseEvent, track: Track) => {
    e.preventDefault();
    const t = timeAt(e.clientX);
    setMenu({
      at: { x: e.clientX, y: e.clientY },
      items: [
        { label: 'Ripple delete this gap', icon: <ArrowLeftToLine size={16} />, run: () => act.closeGap(store, track.id, t) },
        { label: 'Paste here', icon: <ClipboardPaste size={16} />, disabled: !store.getState().clipboard, run: () => (store.getState().seek(t), act.pasteClipboard(store)) },
        { label: 'Add marker here', icon: <Flag size={16} />, run: () => act.addMarker(store, t) },
        ...(track.kind === 'video' ? [{ label: 'Add text here', icon: <Type size={16} />, run: () => act.addText(store, {}, t) }] : [])
      ]
    });
  };

  const trackMenu = (e: React.MouseEvent, track: Track) => {
    e.preventDefault();
    setMenu({
      at: { x: e.clientX, y: e.clientY },
      items: [
        {
          label: 'Rename track…',
          icon: <Pencil size={16} />,
          run: async () => {
            const name = await prompt('Rename track', 'Name', track.name);
            if (name) store.getState().commit('Rename track', (p) => void (p.tracks.find((x) => x.id === track.id)!.name = name));
          }
        },
        { label: 'Add video track', icon: <Film size={16} />, run: () => store.getState().commit('Add track', (p) => void addTrack(p, 'video')) },
        { label: 'Add audio track', icon: <Music size={16} />, run: () => store.getState().commit('Add track', (p) => void addTrack(p, 'audio')) },
        { sep: true },
        {
          label: 'Delete track',
          icon: <Trash2 size={16} />,
          disabled: project.tracks.filter((x) => x.kind === track.kind).length <= 1,
          run: () => store.getState().commit('Delete track', (p) => void removeTrack(p, track.id))
        }
      ]
    });
  };

  const setTrack = (id: string, patch: Partial<Track>, label: string) => store.getState().commit(label, (p) => Object.assign(p.tracks.find((t) => t.id === id)!, patch));

  /* ---------- Drag and drop from the bin, the transitions list and the desktop ---------- */

  const onDragOver = (e: React.DragEvent) => {
    const types = e.dataTransfer.types;
    if (types.includes(DND_MEDIA) || types.includes(DND_TRANSITION) || types.includes(DND_TEXT) || types.includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      const t = timeAt(e.clientX);
      setHover(types.includes(DND_TRANSITION) ? clipAt(e.clientX, e.clientY)?.id || '' : '');
      setSnapLine(t);
    }
  };
  const clipAt = (clientX: number, clientY: number) => {
    const t = timeAt(clientX);
    const row = rows[rowAt(clientY)];
    return project.clips.find((c) => c.trackId === row?.id && c.start <= t && clipEnd(c) > t);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setSnapLine(null);
    setHover('');
    const s = store.getState();
    const t = snapToFrame(timeAt(e.clientX), fps);
    const row = rows[rowAt(e.clientY)];
    const media = e.dataTransfer.getData(DND_MEDIA);
    const tr = e.dataTransfer.getData(DND_TRANSITION) as TransitionType;
    const text = e.dataTransfer.getData(DND_TEXT);
    if (media) {
      // "id" from the bin, or "id|in|out" from the source viewer.
      const [id, a, b] = media.split('|');
      const m = s.project.media.find((x) => x.id === id);
      if (!m) return;
      const snapT = t + snapper(new Set())([t]);
      setSnapLine(null);
      const range = m.kind === 'image' ? {} : { in: a ? Number(a) : undefined, out: b ? Number(b) : undefined };
      act.placeMedia(store, m, snapT, { vTrack: row?.kind === 'video' ? row.id : undefined, aTrack: row?.kind === 'audio' ? row.id : undefined, mode: e.ctrlKey ? 'insert' : 'overwrite', ...range });
    } else if (tr) {
      const c = clipAt(e.clientX, e.clientY);
      if (!c) return;
      const mid = c.start + clipDuration(c) / 2;
      act.addTransitionAt(store, c.id, t < mid ? 'in' : 'out', tr);
    } else if (text) {
      const style = JSON.parse(text) as Partial<TextStyle> & { y?: number };
      const { y, ...rest } = style;
      act.addText(store, rest, t, 3, y || 0);
    } else if (e.dataTransfer.files.length) {
      onDropFiles([...e.dataTransfer.files], t, row?.id ?? null);
    }
  };

  /* ---------- Render ---------- */

  const tracksH = rowTops[rows.length];
  return (
    <div className="ve-timeline" onContextMenu={(e) => e.preventDefault()}>
      <div className="ve-tl-scroll" ref={scrollRef}>
        <div className="ve-tl-inner" style={{ width: HEAD_W + contentW }}>
          <div className="ve-tl-rulerrow">
            <div className="ve-tl-corner">
              <Timecode />
            </div>
            <Ruler width={contentW} zoom={zoom} onPointerDown={scrub} onMarkerDown={markerDown} onMarkerDbl={renameMarker} selMarker={selMarker} />
          </div>
          <div className="ve-tl-body">
            <div className="ve-tl-heads">
              {rows.map((t) => (
                <div key={t.id} className={`ve-th ${t.kind}`} style={{ height: ROW_H[t.kind] }} onContextMenu={(e) => trackMenu(e, t)}>
                  <span className="ve-th-name" title={t.kind === 'video' ? 'Video track' : 'Audio track'}>
                    {t.name}
                  </span>
                  <button className={`ve-th-btn ${t.locked ? 'on' : ''}`} title={t.locked ? 'Unlock track' : 'Lock track'} onClick={() => setTrack(t.id, { locked: !t.locked }, t.locked ? 'Unlock track' : 'Lock track')}>
                    {t.locked ? <Lock size={14} /> : <LockOpen size={14} />}
                  </button>
                  {t.kind === 'video' ? (
                    <button className={`ve-th-btn ${t.hidden ? 'on' : ''}`} title={t.hidden ? 'Show track' : 'Hide track'} onClick={() => setTrack(t.id, { hidden: !t.hidden }, t.hidden ? 'Show track' : 'Hide track')}>
                      {t.hidden ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  ) : (
                    <>
                      <button className={`ve-th-btn ${t.muted ? 'on' : ''}`} title={t.muted ? 'Unmute track (M)' : 'Mute track (M)'} onClick={() => setTrack(t.id, { muted: !t.muted }, t.muted ? 'Unmute' : 'Mute')}>
                        {t.muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
                      </button>
                      <button className={`ve-th-btn solo ${t.solo ? 'on' : ''}`} title="Solo: hear only this track" onClick={() => setTrack(t.id, { solo: !t.solo }, t.solo ? 'Unsolo' : 'Solo')}>
                        S
                      </button>
                    </>
                  )}
                </div>
              ))}
              <div className="ve-th-add">
                <button className="ve-th-addbtn" title="Add a video track" onClick={() => store.getState().commit('Add track', (p) => void addTrack(p, 'video'))}>
                  <Plus size={13} /> Video
                </button>
                <button className="ve-th-addbtn" title="Add an audio track" onClick={() => store.getState().commit('Add track', (p) => void addTrack(p, 'audio'))}>
                  <Plus size={13} /> Audio
                </button>
              </div>
            </div>
            <div
              className={`ve-tl-lanes tool-${tool}`}
              ref={lanesRef}
              style={{ width: contentW, height: tracksH + 40 }}
              onPointerDown={lanesDown}
              onDragOver={onDragOver}
              onDragLeave={() => (setSnapLine(null), setHover(''))}
              onDrop={onDrop}
            >
              {rows.map((t, i) => (
                <div key={t.id} className={`ve-lane ${t.kind} ${t.locked ? 'locked' : ''} ${t.hidden || t.muted ? 'off' : ''}`} style={{ top: rowTops[i], height: ROW_H[t.kind] }} onContextMenu={(e) => laneMenu(e, t)} />
              ))}
              <InOutShade project={project} zoom={zoom} height={tracksH} />
              {project.markers.map((m) => (
                <div key={m.id} className="ve-marker-line" style={{ left: m.t * zoom, height: tracksH, background: m.color }} />
              ))}
              {project.clips.map((c) => {
                const i = rows.findIndex((r) => r.id === c.trackId);
                if (i < 0) return null;
                const m = mediaOf(project, c);
                return (
                  <ClipView
                    key={c.id}
                    clip={c}
                    project={project}
                    top={rowTops[i]}
                    height={ROW_H[rows[i].kind]}
                    zoom={zoom}
                    selected={selSet.has(c.id)}
                    audio={rows[i].kind === 'audio'}
                    offline={!!m && !!missing[mediaKey(m)]}
                    dropHover={hover === c.id}
                    onPointerDown={clipDown}
                    onContextMenu={clipMenu}
                  />
                );
              })}
              {project.clips.flatMap((c) => {
                const i = rows.findIndex((r) => r.id === c.trackId);
                if (i < 0) return [];
                return (['in', 'out'] as const).map((edge) => {
                  const span = transitionSpan(project, c, edge);
                  // A cut's transition is drawn once, by the incoming clip.
                  if (!span || (edge === 'out' && !c.trOut)) return null;
                  const tr = edge === 'in' ? c.trIn! : c.trOut!;
                  const on = selTransition?.clipId === c.id && selTransition.edge === edge;
                  return (
                    <div
                      key={`${c.id}-${edge}`}
                      className={`ve-trans ${on ? 'on' : ''}`}
                      style={{ left: span[0] * zoom, width: Math.max(8, (span[1] - span[0]) * zoom), top: rowTops[i] + 4, height: ROW_H[rows[i].kind] - 8 }}
                      title={`${TRANSITIONS.find((x) => x.id === tr.type)?.label} · ${tr.duration.toFixed(2)} s`}
                      onPointerDown={(e) => transitionDown(e, c.id, edge, 0)}
                    >
                      <span className="ve-trans-h l" onPointerDown={(e) => transitionDown(e, c.id, edge, -1)} />
                      <span className="ve-trans-label">{TRANSITIONS.find((x) => x.id === tr.type)?.label}</span>
                      <span className="ve-trans-h r" onPointerDown={(e) => transitionDown(e, c.id, edge, 1)} />
                    </div>
                  );
                });
              })}
              {marquee && (
                <div
                  className="ve-marquee"
                  style={{ left: Math.min(marquee.x0, marquee.x1), top: Math.min(marquee.y0, marquee.y1), width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0) }}
                />
              )}
              {snapLine !== null && <div className="ve-snapline" style={{ left: snapLine * zoom, height: tracksH }} />}
              <Playhead height={tracksH} zoom={zoom} />
            </div>
          </div>
        </div>
      </div>
      {menu && <ContextMenu at={menu.at} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

function Timecode() {
  const t = useVE((s) => s.playhead);
  const fps = useVE((s) => s.project.settings.fps);
  return <span className="ve-tc">{timecode(t, fps)}</span>;
}

function Playhead({ height, zoom }: { height: number; zoom: number }) {
  const t = useVE((s) => s.playhead);
  return <div className="ve-playhead" style={{ left: t * zoom, height: height + 40 }} />;
}

function InOutShade({ project, zoom, height }: { project: Project; zoom: number; height: number }) {
  const { inPoint: a, outPoint: b } = project;
  if (a === null && b === null) return null;
  const from = a ?? 0;
  const to = b ?? projectDuration(project);
  return <div className="ve-inout" style={{ left: from * zoom, width: Math.max(0, to - from) * zoom, height }} />;
}

/** Time ruler with ticks that adapt to the zoom level, markers and in/out. */
function Ruler({
  width,
  zoom,
  onPointerDown,
  onMarkerDown,
  onMarkerDbl,
  selMarker
}: {
  width: number;
  zoom: number;
  onPointerDown(e: React.PointerEvent): void;
  onMarkerDown(e: React.PointerEvent, id: string): void;
  onMarkerDbl(id: string): void;
  selMarker: string | null;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const project = useVE((s) => s.project);
  const playhead = useVE((s) => s.playhead);
  const fps = project.settings.fps;
  const [scroll, setScroll] = useState({ left: 0, w: 1200 });

  // Only the visible part is drawn; follow the scroll container.
  useEffect(() => {
    const sc = ref.current?.closest('.ve-tl-scroll') as HTMLElement | null;
    if (!sc) return;
    const on = () => setScroll({ left: sc.scrollLeft, w: sc.clientWidth });
    on();
    sc.addEventListener('scroll', on);
    const ro = new ResizeObserver(on);
    ro.observe(sc);
    return () => {
      sc.removeEventListener('scroll', on);
      ro.disconnect();
    };
  }, []);

  useEffect(() => {
    const c = ref.current!;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.min(width, scroll.w + 40);
    c.width = Math.ceil(w * dpr);
    c.height = RULER_H * dpr;
    c.style.width = `${w}px`;
    c.style.left = `${scroll.left}px`;
    const ctx = c.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, RULER_H);
    // Pick a tick spacing of at least ~70 px.
    const steps = [1 / fps, 2 / fps, 5 / fps, 10 / fps, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
    const major = steps.find((s) => s * zoom >= 70) || 3600;
    const minor = major / (major >= 1 ? 5 : 2);
    const t0 = scroll.left / zoom;
    const t1 = (scroll.left + w) / zoom;
    ctx.strokeStyle = '#5a5d61';
    ctx.fillStyle = '#9aa0a6';
    ctx.font = '10.5px Inter, sans-serif';
    ctx.textBaseline = 'top';
    ctx.beginPath();
    for (let t = Math.floor(t0 / minor) * minor; t <= t1; t += minor) {
      const x = Math.round(t * zoom - scroll.left) + 0.5;
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      ctx.moveTo(x, isMajor ? 14 : 22);
      ctx.lineTo(x, RULER_H);
      if (isMajor) ctx.fillText(major < 1 ? timecode(t, fps).slice(3) : timecode(t, fps).slice(0, 8), x + 4, 3);
    }
    ctx.stroke();
  }, [width, zoom, scroll, fps]);

  return (
    <div className="ve-ruler" style={{ width }} onPointerDown={onPointerDown}>
      <canvas ref={ref} style={{ position: 'absolute', top: 0 }} />
      {project.inPoint !== null && <div className="ve-ruler-in" style={{ left: project.inPoint * zoom }} title="In point (I)" />}
      {project.outPoint !== null && <div className="ve-ruler-out" style={{ left: project.outPoint * zoom }} title="Out point (O)" />}
      {project.markers.map((m) => (
        <div
          key={m.id}
          className={`ve-marker ${selMarker === m.id ? 'on' : ''}`}
          style={{ left: m.t * zoom, color: m.color }}
          title={`${m.name} · ${timecode(m.t, fps)} (double-click to rename)`}
          onPointerDown={(e) => onMarkerDown(e, m.id)}
          onDoubleClick={() => onMarkerDbl(m.id)}
        />
      ))}
      <div className="ve-ruler-head" style={{ left: playhead * zoom }} />
    </div>
  );
}

interface ClipViewProps {
  clip: Clip;
  project: Project;
  top: number;
  height: number;
  zoom: number;
  selected: boolean;
  audio: boolean;
  offline: boolean;
  dropHover: boolean;
  onPointerDown(e: React.PointerEvent, c: Clip): void;
  onContextMenu(e: React.MouseEvent, c: Clip): void;
}

const ClipView = memo(function ClipView({ clip: c, project, top, height, zoom, selected, audio, offline, dropHover, onPointerDown, onContextMenu }: ClipViewProps) {
  const len = clipDuration(c);
  const w = Math.max(2, len * zoom);
  const m = mediaOf(project, c);
  const colour = labelColour(project, c);
  const keys = selected ? ANIMATABLE.flatMap((p) => (c.kf[p] || []).map((k) => k.t)) : [];
  const badges: string[] = [];
  if (c.ramp?.length) badges.push('Ramp');
  else if (c.speed !== 1) badges.push(`${+c.speed.toFixed(2)}×`);
  if (c.reverse) badges.push('Reverse');
  if (c.key.enabled) badges.push('Key');
  return (
    <div
      className={`ve-clip ${audio ? 'audio' : 'video'} ${selected ? 'sel' : ''} ${offline ? 'offline' : ''} ${dropHover ? 'drop' : ''}`}
      style={{ left: c.start * zoom, top: top + 3, width: w, height: height - 6, ['--clip' as any]: colour }}
      onPointerDown={(e) => onPointerDown(e, c)}
      onContextMenu={(e) => onContextMenu(e, c)}
      title={`${c.name}\n${len.toFixed(2)} s${offline ? '\nMedia offline: relink it from the media bin' : ''}`}
    >
      {!audio && m && m.kind !== 'audio' && <Filmstrip clip={c} mediaKeyStr={mediaKey(m)} width={w} height={height - 6} />}
      {audio && m && <Waveform clip={c} mediaKeyStr={mediaKey(m)} width={w} height={height - 6} />}
      {c.kind === 'text' && <span className="ve-clip-icon"><Type size={12} /></span>}
      {c.kind === 'shape' && <span className="ve-clip-icon"><Square size={12} /></span>}
      <div className="ve-clip-label">
        {c.linkId && <Link2 size={11} />}
        <span>{c.kind === 'text' ? c.text?.text.split('\n')[0] || c.name : c.name}</span>
        {badges.map((b) => (
          <span key={b} className="ve-clip-badge">
            {b}
          </span>
        ))}
      </div>
      {(c.props.fadeIn > 0 || c.props.fadeOut > 0) && (
        <svg className="ve-clip-fades" width={w} height={height - 6} preserveAspectRatio="none">
          {c.props.fadeIn > 0 && <path d={`M0 ${height - 6} L${Math.min(w, c.props.fadeIn * zoom)} 0 L0 0 Z`} />}
          {c.props.fadeOut > 0 && <path d={`M${w} ${height - 6} L${Math.max(0, w - c.props.fadeOut * zoom)} 0 L${w} 0 Z`} />}
        </svg>
      )}
      {keys.map((t, i) => (
        <span key={i} className="ve-clip-key" style={{ left: t * zoom }} />
      ))}
      <span className="ve-clip-edge l" />
      <span className="ve-clip-edge r" />
    </div>
  );
});

/** Frames from the media along the clip. */
function Filmstrip({ clip: c, mediaKeyStr, width, height }: { clip: Clip; mediaKeyStr: string; width: number; height: number }) {
  const strip = useMediaCache((s) => s.strips[mediaKeyStr]);
  if (!strip || !strip.length) return null;
  const tileW = Math.max(40, height * 1.6);
  const n = Math.min(80, Math.ceil(width / tileW));
  const len = clipDuration(c);
  const tiles: JSX.Element[] = [];
  for (let i = 0; i < n; i++) {
    const st = sourceTime(c, c.start + ((i + 0.5) * tileW * len) / width);
    const f = strip.reduce((a, b) => (Math.abs(b.t - st) < Math.abs(a.t - st) ? b : a), strip[0]);
    tiles.push(<img key={i} src={f.url} style={{ left: i * tileW, width: tileW, height }} draggable={false} alt="" />);
  }
  return <div className="ve-clip-strip">{tiles}</div>;
}

/** Audio levels between the clip's in and out. */
function Waveform({ clip: c, mediaKeyStr, width, height }: { clip: Clip; mediaKeyStr: string; width: number; height: number }) {
  const peaks = useMediaCache((s) => s.peaks[mediaKeyStr]);
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv || !peaks) return;
    const w = Math.max(1, Math.min(4096, Math.round(width)));
    cv.width = w;
    cv.height = height;
    const ctx = cv.getContext('2d')!;
    ctx.clearRect(0, 0, w, height);
    ctx.fillStyle = 'rgba(20, 60, 35, 0.75)';
    const mid = height / 2;
    const len = clipDuration(c);
    const vol = Math.pow(10, (c.props.volume + c.props.gain) / 20);
    for (let x = 0; x < w; x++) {
      const a = sourceTime(c, c.start + (x / w) * len);
      const b = sourceTime(c, c.start + ((x + 1) / w) * len);
      let i0 = Math.floor(Math.min(a, b) * peaks.rate);
      const i1 = Math.max(i0 + 1, Math.ceil(Math.max(a, b) * peaks.rate));
      let v = 0;
      for (; i0 < i1 && i0 < peaks.data.length; i0++) if (i0 >= 0) v = Math.max(v, peaks.data[i0]);
      const hgt = Math.min(1, v * vol) * (mid - 2);
      ctx.fillRect(x, mid - hgt, 1, hgt * 2 || 1);
    }
  }, [peaks, width, height, c.in, c.out, c.speed, c.reverse, c.props.volume, c.props.gain]);
  return <canvas ref={ref} className="ve-clip-wave" style={{ width: '100%', height: '100%' }} />;
}
