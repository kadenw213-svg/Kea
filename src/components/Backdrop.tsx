// The background behind the whole window (Settings → Look & feel → Background), since Kea 0.100: one picture, or Kea's
// photos fading slowly from one to the next (a change of scenery every few minutes helps people stay with their work).
// Two layers: the next photo loads into the hidden one, then it fades in over `fade` ms. Nothing changes while the
// window is hidden, and "Reduce motion" makes the change a cut. The scrim over it (the theme's background, see-through
// by "how much it shows") keeps text readable. settings.ts applyBackground decides what's shown, through useBackdrop.
import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';

export interface BackdropState {
  /** The pictures to show (one: no fading). Empty: no picture (a solid colour, or none). */
  images: string[];
  /** How long each photo stays, in ms. */
  every: number;
  /** How long the fade takes, in ms (0: a cut). */
  fade: number;
  shuffle: boolean;
  blur: number;
}
export const useBackdrop = create<BackdropState>(() => ({ images: [], every: 5 * 60_000, fade: 20_000, shuffle: false, blur: 0 }));

const START_KEY = 'kea.backdrop.at';
const readStart = () => {
  try {
    return Number(localStorage.getItem(START_KEY)) || 0;
  } catch {
    return 0;
  }
};
const saveStart = (i: number) => {
  try {
    localStorage.setItem(START_KEY, String(i));
  } catch {}
};
const load = (src: string) =>
  new Promise<void>((ok) => {
    const im = new Image();
    im.onload = () => ok();
    im.onerror = () => ok();
    im.src = src;
  });

export function Backdrop() {
  const { images, every, fade, shuffle, blur } = useBackdrop();
  // Two layers: [front, back]; `front` says which one is on top and visible.
  const [layers, setLayers] = useState<[string, string]>(['', '']);
  const [front, setFront] = useState<0 | 1>(0);
  const frontRef = useRef<0 | 1>(0);
  const at = useRef(0);
  const key = images.join('|');

  // A new list (another backdrop chosen): show its first (or the one we'd got to) at once.
  useEffect(() => {
    if (!images.length) return setLayers(['', '']);
    at.current = images.length > 1 ? readStart() % images.length : 0;
    const first = images[at.current];
    load(first).then(() => {
      setLayers(frontRef.current === 0 ? [first, ''] : ['', first]);
    });
  }, [key]);

  // Fading on to the next photo every `every` ms (only with more than one, and only while the window is shown).
  useEffect(() => {
    if (images.length < 2) return;
    let stop = false;
    const tick = async () => {
      if (stop || document.hidden) return;
      const next = shuffle ? (at.current + 1 + Math.floor(Math.random() * (images.length - 1))) % images.length : (at.current + 1) % images.length;
      const src = images[next];
      await load(src);
      if (stop) return;
      at.current = next;
      saveStart(next);
      const back: 0 | 1 = frontRef.current === 0 ? 1 : 0;
      setLayers((l) => (back === 0 ? [src, l[1]] : [l[0], src]));
      // (Two frames later, so the new layer is painted before it fades in.)
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          frontRef.current = back;
          setFront(back);
        })
      );
    };
    const t = setInterval(tick, Math.max(30_000, every));
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [key, every, shuffle]);

  if (!images.length) return null;
  const reduce = document.documentElement.classList.contains('reduce-motion') || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const style = (i: 0 | 1) => ({
    backgroundImage: layers[i] ? `url("${layers[i]}")` : 'none',
    opacity: front === i ? 1 : 0,
    transition: reduce ? 'none' : `opacity ${Math.max(0, fade)}ms ease-in-out`,
    filter: blur ? `blur(${blur}px)` : undefined,
    inset: blur ? `${-2 * blur}px` : 0
  });
  return (
    <div className="backdrop" aria-hidden>
      <div className="backdrop-layer" style={style(0)} />
      <div className="backdrop-layer" style={style(1)} />
      <div className="backdrop-scrim" />
    </div>
  );
}
