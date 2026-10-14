import { useEffect, useRef, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChevronLeft, ChevronRight, X, MonitorPlay, Presentation as PresentationIcon, Pause, Play, RotateCcw, Minus, Plus, Monitor } from 'lucide-react';
import type { Deck, Transition } from './model';
import { SlideView, SLIDE_CSS } from './SlideView';
import { api } from '../../lib/api';
import { setting } from '../../lib/settings';

/**
 * Presenting: full-screen slides with transitions, plus a speaker view (notes, next slide, timer)
 * and, when a second screen is connected, an audience window on it while you see the speaker view.
 */

const DEFAULT_T: Transition = { type: 'none', duration: 0.5 };
const fmtTime = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h ? h + ':' : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/** A standalone page that shows one slide at a time with transitions (for the second screen). */
export function audienceHtml(deck: Deck) {
  const slides = deck.slides.map((s) => `<div class="sl">${renderToStaticMarkup(<SlideView slide={s} w={deck.w} h={deck.h} font={deck.font} />)}</div>`).join('');
  // No scripts are allowed in this page; the app drives it from outside (see electron/present.cjs).
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:"><title>Slideshow</title><style>
html,body{margin:0;height:100%;background:#000;overflow:hidden;cursor:none}
#stage{position:absolute;left:50%;top:50%;width:${deck.w}px;height:${deck.h}px;transform-origin:0 0;overflow:hidden}
.sl{position:absolute;inset:0;display:none}.sl.on{display:block}
${SLIDE_CSS}${TRANSITION_CSS}
</style></head><body><div id="stage">${slides}</div></body></html>`;
}

export const TRANSITION_CSS = `
.tr-in,.tr-out{animation-fill-mode:both;animation-timing-function:cubic-bezier(.4,0,.2,1)}
.tr-out{z-index:1}.tr-in{z-index:2}
.tr-in.tr-fade{animation-name:trFadeIn}
.tr-out.tr-fade{animation-name:trFadeOut}
.tr-in.tr-push{animation-name:trPushIn}.tr-out.tr-push{animation-name:trPushOut}
.tr-in.tr-push.back{animation-name:trPushInB}.tr-out.tr-push.back{animation-name:trPushOutB}
.tr-in.tr-wipe{animation-name:trWipe}.tr-in.tr-wipe.back{animation-name:trWipeB}
.tr-out.tr-wipe,.tr-out.tr-cover,.tr-out.tr-zoom{animation-name:trHold}
.tr-in.tr-cover{animation-name:trPushIn}.tr-in.tr-cover.back{animation-name:trPushInB}
.tr-in.tr-zoom{animation-name:trZoom}
@keyframes trFadeIn{from{opacity:0}to{opacity:1}}
@keyframes trFadeOut{from{opacity:1}to{opacity:0}}
@keyframes trPushIn{from{transform:translateX(100%)}to{transform:none}}
@keyframes trPushOut{from{transform:none}to{transform:translateX(-100%)}}
@keyframes trPushInB{from{transform:translateX(-100%)}to{transform:none}}
@keyframes trPushOutB{from{transform:none}to{transform:translateX(100%)}}
@keyframes trWipe{from{clip-path:inset(0 100% 0 0)}to{clip-path:inset(0 0 0 0)}}
@keyframes trWipeB{from{clip-path:inset(0 0 0 100%)}to{clip-path:inset(0 0 0 0)}}
@keyframes trZoom{from{opacity:0;transform:scale(.6)}to{opacity:1;transform:none}}
@keyframes trHold{from{opacity:1}to{opacity:1}}
`;

function Slide({ deck, index, scale, className, style }: { deck: Deck; index: number; scale: number; className?: string; style?: React.CSSProperties }) {
  const slide = deck.slides[index];
  if (!slide) return null;
  return (
    <div className={`pv-slide ${className || ''}`} style={{ width: deck.w * scale, height: deck.h * scale, ...style }}>
      <div style={{ transform: `scale(${scale})`, transformOrigin: '0 0' }}>
        <SlideView slide={slide} w={deck.w} h={deck.h} font={deck.font} />
      </div>
    </div>
  );
}

export function Presenter({ deck, start, onExit }: { deck: Deck; start: number; onExit(i: number): void }) {
  const [i, setI] = useState(start);
  const [prev, setPrev] = useState<{ i: number; dir: number } | null>(null);
  const [mode, setMode] = useState<'audience' | 'speaker'>(() => (setting('slides.presenterView') === 'speaker' ? 'speaker' : 'audience'));
  const [second, setSecond] = useState(false);
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [startAt, setStartAt] = useState(Date.now());
  const [pausedAt, setPausedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [notesSize, setNotesSize] = useState(() => Number(setting('slides.notesSize')) || 20);
  const ref = useRef<HTMLDivElement>(null);
  const iRef = useRef(i);
  iRef.current = i;
  const n = deck.slides.length;
  const tOf = (k: number): Transition => deck.slides[k]?.transition || DEFAULT_T;

  const go = (next: number) => {
    const target = Math.max(0, Math.min(n - 1, next));
    const cur = iRef.current;
    if (target === cur) return;
    const dir = target > cur ? 1 : -1;
    // The incoming slide's transition plays (going back plays the current slide's in reverse).
    const t = tOf(dir > 0 ? target : cur);
    setPrev(t.type === 'none' ? null : { i: cur, dir });
    setI(target);
    if (second) api.present.goto(target, t.type, t.duration, dir);
  };

  useEffect(() => {
    ref.current?.requestFullscreen?.().catch(() => {});
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    const onFs = () => {
      if (!document.fullscreenElement) onExit(iRef.current);
    };
    window.addEventListener('resize', onResize);
    document.addEventListener('fullscreenchange', onFs);
    const tick = setInterval(() => setNow(Date.now()), 500);
    // With two screens, show the slides on the other one and the speaker view here.
    if (setting('slides.useSecondScreen') !== false) {
      api.present.screens().then((count) => {
        if (count > 1) {
          api.present.open(audienceHtml(deck), start).then((ok) => {
            if (ok) {
              setSecond(true);
              setMode('speaker');
            }
          });
        }
      });
    }
    const offClosed = api.present.onClosed(() => setSecond(false));
    return () => {
      window.removeEventListener('resize', onResize);
      document.removeEventListener('fullscreenchange', onFs);
      clearInterval(tick);
      offClosed();
      api.present.close();
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (['ArrowRight', 'ArrowDown', ' ', 'PageDown', 'Enter', 'n', 'N'].includes(e.key)) go(iRef.current + 1);
      else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'p', 'P'].includes(e.key)) go(iRef.current - 1);
      else if (e.key === 'Home') go(0);
      else if (e.key === 'End') go(n - 1);
      else if (e.key === 's' || e.key === 'S') setMode((m) => (m === 'speaker' ? 'audience' : 'speaker'));
      else if (e.key === 'Escape') onExit(iRef.current);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [second]);

  const elapsed = (pausedAt ?? now) - startAt;
  const t = prev ? tOf(prev.dir > 0 ? i : prev.i) : DEFAULT_T;
  const anim = (k: 'in' | 'out') => (prev ? `tr-${k} tr-${t.type}${prev.dir < 0 ? ' back' : ''}` : '');

  if (mode === 'speaker') {
    const big = Math.min((size.w * 0.62) / deck.w, (size.h * 0.6) / deck.h);
    const small = Math.min((size.w * 0.3) / deck.w, (size.h * 0.3) / deck.h);
    const notes = deck.slides[i]?.notes || '';
    return (
      <div ref={ref} className="presenter speaker">
        <style>{TRANSITION_CSS}</style>
        <div className="spk-main">
          <div className="spk-cur">
            <div className="spk-label">Current · {i + 1} of {n}</div>
            <div className="spk-stage" style={{ width: deck.w * big, height: deck.h * big }} onClick={() => go(i + 1)}>
              {prev && <Slide deck={deck} index={prev.i} scale={big} className={anim('out')} style={{ animationDuration: `${t.duration}s` }} />}
              <Slide key={i} deck={deck} index={i} scale={big} className={anim('in')} style={{ animationDuration: `${t.duration}s` }} />
            </div>
          </div>
          <div className="spk-side">
            <div className="spk-label">Next</div>
            {i + 1 < n ? <Slide deck={deck} index={i + 1} scale={small} /> : <div className="spk-end" style={{ width: deck.w * small, height: deck.h * small }}>End of slideshow</div>}
            <div className="spk-timer">
              <div className="spk-time">{fmtTime(elapsed)}</div>
              <div className="spk-timer-btns">
                <button className="icon-btn" title={pausedAt ? 'Resume timer' : 'Pause timer'} onClick={() => (pausedAt ? (setStartAt(startAt + Date.now() - pausedAt), setPausedAt(null)) : setPausedAt(Date.now()))}>
                  {pausedAt ? <Play size={18} /> : <Pause size={18} />}
                </button>
                <button className="icon-btn" title="Restart timer" onClick={() => (setStartAt(Date.now()), setPausedAt(pausedAt ? Date.now() : null))}>
                  <RotateCcw size={18} />
                </button>
              </div>
              <div className="spk-clock">{new Date(now).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</div>
            </div>
          </div>
        </div>
        <div className="spk-notes">
          <div className="spk-notes-head">
            <span className="spk-label">Speaker notes</span>
            <button className="icon-btn sm" title="Smaller text" onClick={() => setNotesSize((s) => Math.max(12, s - 2))}>
              <Minus size={14} />
            </button>
            <button className="icon-btn sm" title="Larger text" onClick={() => setNotesSize((s) => Math.min(48, s + 2))}>
              <Plus size={14} />
            </button>
          </div>
          <div className="spk-notes-text" style={{ fontSize: notesSize }}>
            {notes || <span className="muted">No notes for this slide.</span>}
          </div>
        </div>
        <div className="spk-bar">
          <button className="icon-btn" onClick={() => go(i - 1)} title="Previous (←)">
            <ChevronLeft size={18} />
          </button>
          <button className="icon-btn" onClick={() => go(i + 1)} title="Next (→)">
            <ChevronRight size={18} />
          </button>
          <span className="muted">{second ? <><Monitor size={13} /> Slides are showing on your other screen</> : 'Press S to switch to the audience view'}</span>
          <span style={{ flex: 1 }} />
          <button className="btn sm" onClick={() => setMode('audience')}>
            <MonitorPlay size={14} /> Audience view
          </button>
          <button className="btn sm" onClick={() => onExit(iRef.current)}>
            <X size={14} /> End (Esc)
          </button>
        </div>
      </div>
    );
  }

  const s = Math.min(size.w / deck.w, size.h / deck.h);
  return (
    <div ref={ref} className="presenter" onClick={(e) => (e.clientX < size.w * 0.25 ? go(i - 1) : go(i + 1))}>
      <style>{TRANSITION_CSS}</style>
      <div className="present-stage" style={{ width: deck.w * s, height: deck.h * s }}>
        {prev && <Slide deck={deck} index={prev.i} scale={s} className={anim('out')} style={{ animationDuration: `${t.duration}s` }} />}
        <Slide key={i} deck={deck} index={i} scale={s} className={anim('in')} style={{ animationDuration: `${t.duration}s` }} />
      </div>
      <div className="present-bar" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn sm" onClick={() => go(i - 1)}>
          <ChevronLeft size={16} />
        </button>
        <span>
          {i + 1} / {n}
        </span>
        <button className="icon-btn sm" onClick={() => go(i + 1)}>
          <ChevronRight size={16} />
        </button>
        <span className="present-time">{fmtTime(elapsed)}</span>
        <button className="icon-btn sm" onClick={() => setMode('speaker')} title="Speaker view (S)">
          <PresentationIcon size={16} />
        </button>
        <button className="icon-btn sm" onClick={() => onExit(iRef.current)} title="Exit (Esc)">
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
