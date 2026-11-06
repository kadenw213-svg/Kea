import type { Project, Clip, TransitionType, TransitionDir } from './model';
import { clipEnd, neighbours, DIRECTIONAL } from './model';

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
  dir: TransitionDir;
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
    return { role: 'B', type: c.trIn!.type, dir: c.trIn!.dir || DIRECTIONAL[c.trIn!.type] || 'left', p: (t - inSpan[0]) / (inSpan[1] - inSpan[0]), lone: !prev };
  }
  const outSpan = transitionSpan(p, c, 'out');
  if (outSpan && t >= outSpan[0] && t < outSpan[1]) {
    const { next } = neighbours(p, c);
    const tr = (next?.trIn || c.trOut)!;
    return { role: 'A', type: tr.type, dir: tr.dir || DIRECTIONAL[tr.type] || 'left', p: (t - outSpan[0]) / (outSpan[1] - outSpan[0]), lone: !next };
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
  /** Visible part of the frame, as fractions of the height [from, to]. */
  clipY?: [number, number];
  /** Visible circle around the centre, as a fraction of the half-diagonal (iris). */
  iris?: number;
  /** Vertical offset (project px). */
  dy?: number;
  /** Extra blur (project px). */
  blur?: number;
  /** Colour dip drawn over the track (alpha 0..1). */
  dip?: { color: string; alpha: number };
  hidden?: boolean;
}

const smooth = (x: number) => x * x * (3 - 2 * x);

export function layerMod(s: TrState | null, frameW: number, frameH = (frameW * 9) / 16): LayerMod {
  const m: LayerMod = { alpha: 1, dx: 0, scale: 1 };
  if (!s) return m;
  const { role, p, lone, dir } = s;
  const e = smooth(p);
  // Unit vector of the movement: 'left' means things move leftwards (the new shot enters from the right).
  const vx = dir === 'left' ? -1 : dir === 'right' ? 1 : 0;
  const vy = dir === 'up' ? -1 : dir === 'down' ? 1 : 0;
  const push = (k: number) => {
    // Both shots move together; k = 0..1 progress.
    if (role === 'B') {
      m.dx = -vx * frameW * (1 - k);
      m.dy = -vy * frameH * (1 - k);
    } else {
      m.dx = vx * frameW * k;
      m.dy = vy * frameH * k;
    }
  };
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
    case 'wipe': {
      // The edge travels in the direction of movement, revealing the new shot behind it.
      const fwd = vx > 0 || vy > 0;
      const r: [number, number] | null = role === 'B' ? (fwd ? [0, e] : [1 - e, 1]) : lone ? (fwd ? [e, 1] : [0, 1 - e]) : null;
      if (r) {
        if (vx) m.clipX = r;
        else m.clipY = r;
      }
      break;
    }
    case 'slide':
      push(e);
      break;
    case 'cover':
      // Only the new shot moves, sliding in over the old one.
      if (role === 'B') {
        m.dx = -vx * frameW * (1 - e);
        m.dy = -vy * frameH * (1 - e);
      } else if (lone) m.alpha = 1 - p;
      break;
    case 'whip': {
      const k = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
      push(k);
      m.blur = Math.sin(Math.PI * p) * frameW * 0.03;
      break;
    }
    case 'blur':
      if (role === 'B') {
        m.alpha = p;
        m.blur = (1 - e) * frameW * 0.02;
      } else {
        m.blur = e * frameW * 0.02;
        if (lone) m.alpha = 1 - p;
      }
      break;
    case 'iris':
      if (role === 'B') m.iris = e;
      else if (lone) m.iris = 1 - e;
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
