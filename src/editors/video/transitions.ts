import type { Project, Clip, TransitionType } from './model';
import { clipEnd, neighbours } from './model';

/*
 * Transition timing. A transition at a cut is stored on the incoming clip (`trIn`) and is
 * centred on the cut: the outgoing clip keeps playing past its out point and the incoming one
 * starts before its in point (using spare source when there is some, else holding the edge frame).
 * A transition at a clip's free start/end (nothing touching) fades from / to nothing inside the clip.
 */

/** Where a transition sits on the timeline, or null if the clip has none at that edge. */
export function transitionSpan(p: Project, c: Clip, edge: 'in' | 'out'): [number, number] | null {
  const { prev, next } = neighbours(p, c);
  if (edge === 'in') {
    if (!c.trIn) return null;
    const d = c.trIn.duration;
    return prev ? [c.start - d / 2, c.start + d / 2] : [c.start, c.start + d];
  }
  const end = clipEnd(c);
  if (next) {
    if (!next.trIn) return null;
    const d = next.trIn.duration;
    return [end - d / 2, end + d / 2];
  }
  if (!c.trOut) return null;
  return [end - c.trOut.duration, end];
}

/** The time range in which a clip is seen or heard, including overlap into neighbouring transitions. */
export function clipWindow(p: Project, c: Clip): [number, number] {
  const a = transitionSpan(p, c, 'in');
  const b = transitionSpan(p, c, 'out');
  return [Math.min(c.start, a ? a[0] : c.start), Math.max(clipEnd(c), b ? b[1] : clipEnd(c))];
}

export interface TrState {
  /** A = the outgoing clip, B = the incoming one. */
  role: 'A' | 'B';
  type: TransitionType;
  /** 0..1 through the transition. */
  p: number;
  /** No clip on the other side: fading from / to nothing. */
  lone: boolean;
}

/** The transition affecting a clip at time `t`, if any. */
export function transitionAt(p: Project, c: Clip, t: number): TrState | null {
  const inSpan = transitionSpan(p, c, 'in');
  if (inSpan && t >= inSpan[0] && t < inSpan[1]) {
    const { prev } = neighbours(p, c);
    return { role: 'B', type: c.trIn!.type, p: (t - inSpan[0]) / (inSpan[1] - inSpan[0]), lone: !prev };
  }
  const outSpan = transitionSpan(p, c, 'out');
  if (outSpan && t >= outSpan[0] && t < outSpan[1]) {
    const { next } = neighbours(p, c);
    return { role: 'A', type: (next?.trIn || c.trOut)!.type, p: (t - outSpan[0]) / (outSpan[1] - outSpan[0]), lone: !next };
  }
  return null;
}

/** How a transition changes a picture layer. */
export interface LayerMod {
  alpha: number;
  dx: number;
  scale: number;
  /** Visible part of the frame, as fractions of the width [from, to]. */
  clipX?: [number, number];
  /** Colour dip drawn over the track (alpha 0..1). */
  dip?: { color: string; alpha: number };
  hidden?: boolean;
}

const smooth = (x: number) => x * x * (3 - 2 * x);

export function layerMod(s: TrState | null, frameW: number): LayerMod {
  const m: LayerMod = { alpha: 1, dx: 0, scale: 1 };
  if (!s) return m;
  const { role, p, lone } = s;
  const e = smooth(p);
  switch (s.type) {
    case 'dissolve':
      // The incoming clip fades in over the outgoing one; alone, a clip fades from / to nothing.
      if (role === 'B') m.alpha = p;
      else if (lone) m.alpha = 1 - p;
      break;
    case 'dipBlack':
    case 'dipWhite': {
      const color = s.type === 'dipBlack' ? '#000000' : '#ffffff';
      if (lone) m.dip = { color, alpha: role === 'B' ? 1 - p : p };
      else {
        m.hidden = role === 'A' ? p >= 0.5 : p < 0.5;
        m.dip = { color, alpha: p < 0.5 ? p * 2 : (1 - p) * 2 };
      }
      break;
    }
    case 'wipe':
      if (role === 'B') m.clipX = [0, e];
      else if (lone) m.clipX = [e, 1];
      break;
    case 'slide':
      m.dx = role === 'B' ? frameW * (1 - e) : -frameW * e;
      break;
    case 'zoom':
      if (role === 'B') {
        m.scale = 0.5 + 0.5 * e;
        m.alpha = Math.min(1, p * 1.6);
      } else {
        m.scale = 1 + 0.4 * e;
        if (lone) m.alpha = 1 - p;
      }
      break;
  }
  return m;
}

/** Audio gain from a transition: equal-power crossfade at cuts, a plain fade at free edges. */
export function transitionGain(s: TrState | null) {
  if (!s) return 1;
  const x = s.role === 'B' ? s.p : 1 - s.p;
  return s.lone ? x : Math.sin((x * Math.PI) / 2);
}
