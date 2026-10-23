import { CanvasSink } from 'mediabunny';
import type { Clip } from './model';
import { mediaOf, projectDuration, sourceTime, trackOf, speedAt } from './model';
import type { Store } from './state';
import { renderFrame, frameTime, Drawable, FrameGetter } from './compositor';
import { ClipFx } from './effects';
import { AudioEngine, audibleTracks, clipGainAt } from './audio';
import { clipWindow } from './transitions';
import { playUrl } from './host';
import { mediaKey, imageNow, useMediaCache, videoTrackOf } from './media';

/*
 * Live preview. Each clip near the playhead gets its own <video>/<audio> element that is kept
 * in step with a wall clock; sound is routed through Web Audio for per-clip gain and pan.
 * Files the browser's player can't open fall back to mediabunny decoding (slower, picture only).
 */

interface Slot {
  el: HTMLMediaElement;
  key: string;
  audio: boolean;
  broken: boolean;
  /** Last used, for evicting idle elements. */
  used: number;
}

const LOOKAHEAD = 1.5;
const MAX_IDLE = 6;

export class Player {
  private store: Store;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  readonly fx = new ClipFx();
  readonly audio = new AudioEngine();
  private slots = new Map<string, Slot>();
  private fallback = new Map<string, { t: number; frame: Drawable | null; busy: boolean; sink?: Promise<CanvasSink | null> }>();
  private raf = 0;
  private renderQueued = 0;
  private clock = { wall: 0, t: 0, rate: 1, end: Infinity, start: 0 };
  private lastSet = -1;
  private unsub: () => void;
  private unsubCache: () => void;

  constructor(store: Store) {
    this.store = store;
    let prev = store.getState();
    this.unsub = store.subscribe((s) => {
      if (s.project !== prev.project) {
        // New or changed clips need their media elements lined up.
        if (!s.playing) this.sync(s.playhead, false);
        this.requestRender();
      }
      if (s.playhead !== prev.playhead && s.playhead !== this.lastSet) {
        // Someone scrubbed: follow along (and keep playing from there if we were).
        if (s.playing) this.clock = { ...this.clock, wall: performance.now(), t: s.playhead };
        this.sync(s.playhead, s.playing);
        this.requestRender();
      }
      prev = s;
    });
    this.unsubCache = useMediaCache.subscribe(() => this.requestRender());
  }

  attach(canvas: HTMLCanvasElement | null) {
    this.canvas = canvas;
    this.ctx = canvas ? canvas.getContext('2d') : null;
    this.sync(this.store.getState().playhead, false);
    this.requestRender();
  }

  dispose() {
    this.unsub();
    this.unsubCache();
    cancelAnimationFrame(this.raf);
    cancelAnimationFrame(this.renderQueued);
    for (const s of this.slots.values()) this.drop(s);
    this.slots.clear();
    this.audio.close();
  }

  /* ---------- Transport ---------- */

  get playing() {
    return this.store.getState().playing;
  }

  /** Start playing at `rate` (negative = backwards). With `range`, plays the in–out range. */
  play(rate = 1, range = false) {
    const s = this.store.getState();
    const p = s.project;
    const total = projectDuration(p);
    let t = s.playhead;
    let start = 0;
    let end = total;
    if (range && p.inPoint !== null && p.outPoint !== null && p.outPoint > p.inPoint) {
      start = p.inPoint;
      end = p.outPoint;
      if (t < start || t >= end - 0.01) t = start;
    } else if (rate > 0 && t >= total - 0.01) t = 0;
    this.audio.resume();
    this.clock = { wall: performance.now(), t, rate, end, start };
    this.setPlayhead(t);
    s.set({ playing: true, rate });
    cancelAnimationFrame(this.raf);
    const tick = () => {
      const st = this.store.getState();
      if (!st.playing) return;
      const c = this.clock;
      let now = c.t + ((performance.now() - c.wall) / 1000) * c.rate;
      if (c.rate > 0 && now >= c.end) {
        if (st.loop) {
          this.clock = { ...c, wall: performance.now(), t: c.start };
          now = c.start;
        } else {
          this.setPlayhead(c.end);
          return this.pause();
        }
      }
      if (c.rate < 0 && now <= 0) {
        this.setPlayhead(0);
        return this.pause();
      }
      this.setPlayhead(now);
      this.sync(now, true);
      this.renderNow();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  pause() {
    cancelAnimationFrame(this.raf);
    const s = this.store.getState();
    const fps = s.project.settings.fps;
    // Land on a whole frame.
    this.setPlayhead(Math.round(s.playhead * fps) / fps);
    s.set({ playing: false, rate: 1 });
    for (const sl of this.slots.values()) sl.el.pause();
    this.sync(this.store.getState().playhead, false);
    this.requestRender();
  }

  toggle(range = false) {
    if (this.playing) this.pause();
    else this.play(1, range);
  }

  /** J / K / L: each press of L or J doubles the speed in that direction; K stops. */
  shuttle(key: 'j' | 'k' | 'l') {
    const s = this.store.getState();
    if (key === 'k') return this.pause();
    const dir = key === 'l' ? 1 : -1;
    let rate = dir;
    if (s.playing && Math.sign(s.rate) === dir) rate = Math.max(-8, Math.min(8, s.rate * 2));
    this.play(rate);
  }

  step(frames: number) {
    if (this.playing) this.pause();
    const s = this.store.getState();
    const fps = s.project.settings.fps;
    s.seek(Math.max(0, Math.round(s.playhead * fps + frames) / fps));
  }

  private setPlayhead(t: number) {
    this.lastSet = Math.max(0, t);
    this.store.getState().seek(this.lastSet);
  }

  /* ---------- Rendering ---------- */

  requestRender() {
    if (this.renderQueued) return;
    this.renderQueued = requestAnimationFrame(() => {
      this.renderQueued = 0;
      this.renderNow();
    });
  }

  renderNow() {
    const ctx = this.ctx;
    const c = this.canvas;
    if (!ctx || !c) return;
    const s = this.store.getState();
    renderFrame(ctx, { project: s.project, t: s.playhead, scale: c.width / s.project.settings.width, getFrame: this.getFrame, fx: this.fx });
  }

  /** Draw the current frame into another canvas (snapshots). */
  renderTo(ctx: CanvasRenderingContext2D, scale: number) {
    const s = this.store.getState();
    renderFrame(ctx, { project: s.project, t: s.playhead, scale, getFrame: this.getFrame, fx: this.fx });
  }

  readonly getFrame: FrameGetter = (clip, srcT) => {
    const p = this.store.getState().project;
    const m = mediaOf(p, clip);
    if (!m) return 'offline';
    const key = mediaKey(m);
    if (useMediaCache.getState().missing[key]) return 'offline';
    if (m.kind === 'image') return imageNow(key, () => this.requestRender()) || null;
    const slot = this.slots.get(clip.id);
    if (slot && !slot.broken) {
      // While seeking the element keeps showing its previous frame, which beats flashing black.
      const v = slot.el as HTMLVideoElement;
      return v.videoWidth > 0 && v.readyState >= 1 ? v : null;
    }
    return this.fallbackFrame(clip, key, srcT, !!slot?.broken);
  };

  /** Decode a frame with mediabunny when the <video> element can't (or hasn't yet). */
  private fallbackFrame(clip: Clip, key: string, srcT: number, decode: boolean): Drawable | null {
    let f = this.fallback.get(clip.id);
    if (!f) {
      f = { t: -1, frame: null, busy: false };
      this.fallback.set(clip.id, f);
    }
    if (decode && !f.busy && Math.abs(f.t - srcT) > 0.5 / this.store.getState().project.settings.fps) {
      f.busy = true;
      const entry = f;
      entry.sink ||= videoTrackOf(key).then((vt) => (vt ? new CanvasSink(vt, { height: Math.min(1080, this.canvas?.height || 720) }) : null));
      entry.sink
        .then((sink) => sink?.getCanvas(srcT))
        .then((w) => {
          entry.t = srcT;
          if (w) entry.frame = w.canvas;
        })
        .catch(() => {})
        .finally(() => {
          entry.busy = false;
          this.requestRender();
        });
    }
    return f.frame;
  }

  /* ---------- Keeping media elements in step ---------- */

  private sync(t: number, playing: boolean) {
    const s = this.store.getState();
    const p = s.project;
    const rate = playing ? s.rate : 0;
    const wanted = new Set<string>();
    const audible = new Set(audibleTracks(p).map((x) => x.id));
    for (const c of p.clips) {
      if (c.kind !== 'media') continue;
      const m = mediaOf(p, c);
      if (!m || m.kind === 'image') continue;
      const tr = trackOf(p, c);
      if (!tr || (tr.kind === 'video' && tr.hidden)) continue;
      const [a, b] = clipWindow(p, c);
      const active = t >= a && t < b;
      const soon = !active && rate >= 0 && a > t && a - t < LOOKAHEAD * Math.max(1, rate);
      if (!active && !soon) continue;
      wanted.add(c.id);
      const isAudio = tr.kind === 'audio';
      const slot = this.slotFor(c, mediaKey(m), isAudio);
      slot.used = performance.now();
      const el = slot.el;
      if (slot.broken) continue;
      const target = active ? frameTime(p, c, t) : sourceTime(c, c.start);
      const atEdge = active && Math.abs(target - sourceTime(c, t)) > 1e-3;
      if (isAudio) {
        const g = active && audible.has(tr.id) && Math.abs(rate) <= 4 ? clipGainAt(p, c, t, tr) : 0;
        this.audio.set(el, g, c.props.pan / 100);
      }
      const forward = playing && active && rate > 0 && !c.reverse && !atEdge;
      if (forward) {
        const pr = Math.min(16, speedAt(c, t) * rate);
        if (Math.abs(el.playbackRate - pr) > 1e-3) el.playbackRate = pr;
        el.preservesPitch = c.keepPitch;
        if (el.paused) {
          el.currentTime = target;
          el.play().catch(() => {});
        } else if (Math.abs(el.currentTime - target) > 0.25 * Math.max(1, pr)) el.currentTime = target;
      } else {
        if (!el.paused) el.pause();
        const fps = mediaOf(p, c)?.fps || 30;
        if (!el.seeking && Math.abs(el.currentTime - target) > 0.5 / fps) el.currentTime = target;
      }
    }
    // Pause what's no longer needed and free elements that have been idle the longest.
    const idle: [string, Slot][] = [];
    for (const [id, sl] of this.slots) {
      if (wanted.has(id)) continue;
      if (!sl.el.paused) sl.el.pause();
      if (sl.audio) this.audio.set(sl.el, 0, 0);
      idle.push([id, sl]);
    }
    idle.sort((x, y) => x[1].used - y[1].used);
    while (idle.length > MAX_IDLE) {
      const [id, sl] = idle.shift()!;
      this.drop(sl);
      this.slots.delete(id);
    }
    for (const id of this.fallback.keys()) if (!wanted.has(id)) this.fallback.delete(id);
  }

  private slotFor(c: Clip, key: string, audio: boolean): Slot {
    let s = this.slots.get(c.id);
    if (s && s.key === key && s.audio === audio) return s;
    if (s) this.drop(s);
    const el = document.createElement(audio ? 'audio' : 'video');
    el.preload = 'auto';
    el.crossOrigin = 'anonymous';
    if (!audio) {
      el.muted = true;
      (el as HTMLVideoElement).playsInline = true;
    }
    const slot: Slot = { el, key, audio, broken: false, used: performance.now() };
    // A freshly loaded element may only have a drawable frame a moment after it says it's ready.
    const redraw = () => {
      this.requestRender();
      setTimeout(() => this.requestRender(), 60);
    };
    el.addEventListener('seeked', redraw);
    el.addEventListener('canplay', redraw);
    el.addEventListener('loadeddata', () => {
      this.sync(this.store.getState().playhead, this.playing);
      redraw();
    });
    el.addEventListener('error', () => {
      slot.broken = true;
      this.requestRender();
    });
    if (audio) this.audio.attach(el);
    playUrl(key).then(
      (u) => {
        el.src = u;
      },
      () => {
        useMediaCache.getState().set({ missing: { [key]: true } });
      }
    );
    this.slots.set(c.id, slot);
    return slot;
  }

  private drop(s: Slot) {
    s.el.pause();
    s.el.removeAttribute('src');
    s.el.load();
  }

  /** Clip the monitor shows for a project: re-sync when media is relinked. */
  reset() {
    for (const s of this.slots.values()) this.drop(s);
    this.slots.clear();
    this.fallback.clear();
    this.sync(this.store.getState().playhead, false);
    this.requestRender();
  }
}

