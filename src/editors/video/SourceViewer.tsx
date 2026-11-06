import { useEffect, useRef, useState, MutableRefObject } from 'react';
import { Play, Pause, ArrowRightFromLine, ArrowLeftToLine, ListPlus, Replace, StepBack, StepForward, Music } from 'lucide-react';
import { toast } from '../../store';
import { timecode } from './model';
import { useVE, useVEStore } from './state';
import { playUrl } from './host';
import { mediaKey, useMediaCache } from './media';
import { STILL_LENGTH } from './ops';
import { DND_MEDIA } from './Timeline';
import * as act from './actions';

/* Source viewer: preview one piece of media, mark in/out, then insert or overwrite it into the timeline. */

export interface SourceControls {
  toggle(): void;
  step(frames: number): void;
  shuttle(key: 'j' | 'k' | 'l'): void;
  mark(which: 'in' | 'out' | 'clear'): void;
  send(mode: 'insert' | 'overwrite'): void;
}

export function SourceViewer({ controls }: { controls: MutableRefObject<SourceControls | null> }) {
  const store = useVEStore();
  const source = useVE((s) => s.source);
  const media = useVE((s) => s.project.media.find((m) => m.id === s.source?.mediaId));
  const fps = useVE((s) => s.project.settings.fps);
  const thumb = useMediaCache((s) => (media ? s.thumbs[mediaKey(media)] : undefined));
  const peaks = useMediaCache((s) => (media ? s.peaks[mediaKey(media)] : undefined));
  const elRef = useRef<HTMLVideoElement | null>(null);
  const [url, setUrl] = useState('');
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const back = useRef({ raf: 0, rate: 0 });
  const waveRef = useRef<HTMLCanvasElement>(null);

  const dur = media ? (media.kind === 'image' ? STILL_LENGTH : media.duration) : 0;
  const mIn = source?.in ?? null;
  const mOut = source?.out ?? null;

  useEffect(() => {
    setUrl('');
    setT(source?.t ?? 0);
    if (!media) return;
    let live = true;
    playUrl(mediaKey(media)).then(
      (u) => live && setUrl(u),
      () => toast(`Couldn't open ${media.name}`, 'error')
    );
    return () => {
      live = false;
    };
  }, [media?.id, media?.path]);

  // Keep the store's copy of the source playhead (restored when switching tabs).
  useEffect(() => {
    const s = store.getState().source;
    if (s && Math.abs(s.t - t) > 1e-3) store.setState({ source: { ...s, t } });
  }, [t]);

  useEffect(() => {
    const cv = waveRef.current;
    if (!cv || !peaks || media?.hasVideo) return;
    const w = (cv.width = cv.clientWidth || 400);
    const h = (cv.height = cv.clientHeight || 120);
    const ctx = cv.getContext('2d')!;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#81c995';
    const per = peaks.data.length / w;
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let i = Math.floor(x * per); i < Math.floor((x + 1) * per); i++) v = Math.max(v, peaks.data[i] || 0);
      const hh = v * (h / 2 - 4);
      ctx.fillRect(x, h / 2 - hh, 1, hh * 2 || 1);
    }
  }, [peaks, media?.id]);

  const stopBack = () => {
    cancelAnimationFrame(back.current.raf);
    back.current.rate = 0;
  };
  const seek = (v: number) => {
    v = Math.max(0, Math.min(dur, v));
    setT(v);
    if (elRef.current) elRef.current.currentTime = v;
  };
  const pause = () => {
    stopBack();
    elRef.current?.pause();
    setPlaying(false);
  };
  const play = (rate = 1) => {
    const el = elRef.current;
    if (!el || media?.kind === 'image') return;
    stopBack();
    if (rate > 0) {
      el.playbackRate = rate;
      el.play().catch(() => {});
      setPlaying(true);
      return;
    }
    // Backwards: the browser can't, so step the picture back on each frame.
    el.pause();
    back.current.rate = rate;
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      const v = Math.max(0, el.currentTime + ((now - last) / 1000) * back.current.rate);
      last = now;
      el.currentTime = v;
      setT(v);
      if (v <= 0) return pause();
      back.current.raf = requestAnimationFrame(tick);
    };
    setPlaying(true);
    back.current.raf = requestAnimationFrame(tick);
  };

  const mark = (which: 'in' | 'out' | 'clear') => {
    const s = store.getState().source;
    if (!s) return;
    const v = Math.round(t * fps) / fps;
    if (which === 'clear') store.setState({ source: { ...s, in: null, out: null } });
    else if (which === 'in') store.setState({ source: { ...s, in: v, out: s.out !== null && s.out <= v ? null : s.out } });
    else store.setState({ source: { ...s, out: v, in: s.in !== null && s.in >= v ? null : s.in } });
  };
  const send = (mode: 'insert' | 'overwrite') => {
    if (!media) return;
    const a = mIn ?? 0;
    const b = mOut ?? dur;
    if (b - a < 1 / fps) return toast('The in point must come before the out point');
    act.placeMedia(store, media, store.getState().playhead, { mode, in: media.kind === 'image' ? undefined : a, out: media.kind === 'image' ? b - a : b });
  };

  const fnRef = useRef({ play, pause, seek, mark, send });
  fnRef.current = { play, pause, seek, mark, send };
  useEffect(() => {
    controls.current = {
      toggle: () => (elRef.current && !elRef.current.paused) || back.current.rate ? fnRef.current.pause() : fnRef.current.play(1),
      step: (n) => {
        fnRef.current.pause();
        fnRef.current.seek((elRef.current?.currentTime ?? 0) + n / fps);
      },
      shuttle: (k) => {
        if (k === 'k') return fnRef.current.pause();
        const el = elRef.current;
        const cur = back.current.rate || (el && !el.paused ? el.playbackRate : 0);
        const dir = k === 'l' ? 1 : -1;
        fnRef.current.play(Math.sign(cur) === dir ? Math.max(-8, Math.min(8, cur * 2)) : dir);
      },
      mark: (w) => fnRef.current.mark(w),
      send: (m) => fnRef.current.send(m)
    };
    return () => {
      controls.current = null;
      stopBack();
    };
  }, [fps]);

  if (!media)
    return (
      <div className="ve-source empty">
        <p className="empty-note">Double-click something in the media bin to preview it here, mark the part you want, then add it to the timeline.</p>
      </div>
    );

  const pct = (v: number) => `${(v / Math.max(dur, 1e-6)) * 100}%`;
  const scrub = (e: React.PointerEvent) => {
    const bar = e.currentTarget as HTMLElement;
    pause();
    const go = (x: number) => {
      const r = bar.getBoundingClientRect();
      seek(((x - r.left) / r.width) * dur);
    };
    go(e.clientX);
    const move = (ev: PointerEvent) => go(ev.clientX);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div className="ve-source" onPointerDown={() => store.getState().set({ focus: 'source' })}>
      <div
        className="ve-source-view"
        draggable
        title="Drag to the timeline"
        onDragStart={(e) => {
          e.dataTransfer.setData(DND_MEDIA, `${media.id}|${mIn ?? ''}|${mOut ?? ''}`);
          e.dataTransfer.effectAllowed = 'copy';
        }}
      >
        {media.kind === 'image' ? (
          url && <img src={url} alt={media.name} draggable={false} />
        ) : media.hasVideo ? (
          url && (
            <video
              ref={elRef}
              src={url}
              preload="auto"
              onTimeUpdate={(e) => !back.current.rate && setT(e.currentTarget.currentTime)}
              onPause={() => !back.current.rate && setPlaying(false)}
              onEnded={() => setPlaying(false)}
              onLoadedData={(e) => (e.currentTarget.currentTime = t)}
            />
          )
        ) : (
          <>
            {thumb ? <img src={thumb} alt="" /> : <Music size={42} className="ve-source-icon" />}
            <canvas ref={waveRef} className="ve-source-wave" />
            {url && (
              <audio
                ref={(el) => void (elRef.current = el as unknown as HTMLVideoElement)}
                src={url}
                preload="auto"
                onTimeUpdate={(e) => !back.current.rate && setT(e.currentTarget.currentTime)}
                onPause={() => !back.current.rate && setPlaying(false)}
                onEnded={() => setPlaying(false)}
              />
            )}
          </>
        )}
      </div>
      <div className="ve-source-bar" onPointerDown={scrub}>
        {(mIn !== null || mOut !== null) && <div className="ve-source-range" style={{ left: pct(mIn ?? 0), width: `calc(${pct((mOut ?? dur) - (mIn ?? 0))})` }} />}
        <div className="ve-source-head" style={{ left: pct(t) }} />
      </div>
      <div className="ve-transport small">
        <span className="ve-tc">{timecode(t, fps)}</span>
        <div className="tb-spacer" />
        <button className="icon-btn sm" title="Mark in (I)" onClick={() => mark('in')}>
          <ArrowRightFromLine size={15} />
        </button>
        <button className="icon-btn sm" title="Back one frame" onClick={() => (pause(), seek(t - 1 / fps))}>
          <StepBack size={15} />
        </button>
        <button className="icon-btn sm" title={playing ? 'Pause (Space)' : 'Play (Space)'} disabled={media.kind === 'image'} onClick={() => (playing ? pause() : play(1))}>
          {playing ? <Pause size={17} /> : <Play size={17} />}
        </button>
        <button className="icon-btn sm" title="Forward one frame" onClick={() => (pause(), seek(t + 1 / fps))}>
          <StepForward size={15} />
        </button>
        <button className="icon-btn sm" title="Mark out (O)" onClick={() => mark('out')}>
          <ArrowLeftToLine size={15} />
        </button>
        <div className="tb-spacer" />
        <span className="ve-tc dim">{timecode((mOut ?? dur) - (mIn ?? 0), fps)}</span>
      </div>
      <div className="ve-source-actions">
        <button className="btn tonal sm" title="Insert at the playhead, pushing later clips along (,)" onClick={() => send('insert')}>
          <ListPlus size={15} /> Insert
        </button>
        <button className="btn tonal sm" title="Overwrite at the playhead (.)" onClick={() => send('overwrite')}>
          <Replace size={15} /> Overwrite
        </button>
      </div>
      <div className="ve-source-name" title={media.path}>
        {media.name}
      </div>
    </div>
  );
}
