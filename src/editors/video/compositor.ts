import type { Project, Clip, TextStyle, ShapeStyle } from './model';
import { clipDuration, mediaOf, propAt, sourceTime, trackClips } from './model';
import { clipWindow, layerMod, transitionAt, LayerMod } from './transitions';
import { ClipFx, needsFx, cssColourFilter } from './effects';
import { mediaKey } from './media';
import { maskAt } from './segmentMask';

/*
 * The compositor draws one frame of the project onto a 2D canvas. The program monitor,
 * stills ("Export frame"), the assistant's snapshot and the offline export all use it, so
 * what you see is what you export. Frames come from `getFrame`, which the caller backs with
 * <video> elements (preview) or mediabunny decoders (export).
 */

export type Drawable = HTMLVideoElement | HTMLCanvasElement | OffscreenCanvas | ImageBitmap | HTMLImageElement;
/** A frame to draw, 'offline' if the media is missing, or null if it isn't ready yet. */
export type FrameGetter = (clip: Clip, srcTime: number) => Drawable | 'offline' | null;

export interface RenderOptions {
  project: Project;
  t: number;
  /** Canvas pixels per project pixel. */
  scale: number;
  getFrame: FrameGetter;
  fx: ClipFx;
}

export function sizeOf(d: Drawable): [number, number] {
  if (d instanceof HTMLVideoElement) return [d.videoWidth, d.videoHeight];
  if (d instanceof HTMLImageElement) return [d.naturalWidth, d.naturalHeight];
  return [d.width, d.height];
}

/** Picture clips visible at `t`, bottom track first, each with its transition state. */
export function visibleLayers(p: Project, t: number) {
  const out: { clip: Clip; mod: LayerMod }[][] = [];
  for (const tr of p.tracks) {
    if (tr.kind !== 'video' || tr.hidden) continue;
    const layers: { clip: Clip; mod: LayerMod }[] = [];
    for (const c of trackClips(p, tr.id)) {
      const [a, b] = clipWindow(p, c);
      if (t < a || t >= b) continue;
      layers.push({ clip: c, mod: layerMod(transitionAt(p, c, t), p.settings.width, p.settings.height) });
    }
    out.push(layers);
  }
  return out;
}

/** Where in the source a clip plays at `t`, held at the source's ends (used past the edges during transitions). */
export function frameTime(p: Project, c: Clip, t: number) {
  const m = mediaOf(p, c);
  const s = sourceTime(c, t);
  if (!m || m.kind !== 'video') return s;
  return Math.max(0, Math.min(m.duration - 1 / Math.max(1, m.fps), s));
}

export function renderFrame(ctx: CanvasRenderingContext2D, o: RenderOptions) {
  const { project: p, t, scale } = o;
  const W = p.settings.width;
  const H = p.settings.height;
  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.filter = 'none';
  ctx.fillStyle = p.settings.background || '#000';
  ctx.fillRect(0, 0, W, H);
  for (const layers of visibleLayers(p, t)) {
    let dip: LayerMod['dip'];
    for (const { clip, mod } of layers) {
      if (mod.dip) dip = mod.dip;
      if (mod.hidden) continue;
      drawClip(ctx, o, clip, mod);
    }
    if (dip && dip.alpha > 0) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, dip.alpha);
      ctx.fillStyle = dip.color;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
  }
  ctx.restore();
}

function drawClip(ctx: CanvasRenderingContext2D, o: RenderOptions, c: Clip, mod: LayerMod) {
  const { project: p, t, scale } = o;
  const W = p.settings.width;
  const H = p.settings.height;
  let alpha = (propAt(c, 'opacity', t) / 100) * mod.alpha;
  const rel = t - c.start;
  // Text animations change position, size and opacity on top of the clip's own transform.
  let tdx = 0;
  let tdy = 0;
  let tscale = 1;
  let chars = Infinity;
  if (c.kind === 'text' && c.text) {
    const a = textAnim(c.text, rel, clipDuration(c), W);
    alpha *= a.alpha;
    tdx = a.dx;
    tdy = a.dy;
    tscale = a.scale;
    chars = a.chars;
  }
  if (alpha <= 0.001) return;

  ctx.save();
  if (mod.clipX || mod.clipY) {
    const [x0, x1] = mod.clipX || [0, 1];
    const [y0, y1] = mod.clipY || [0, 1];
    ctx.beginPath();
    ctx.rect(W * x0, H * y0, W * (x1 - x0), H * (y1 - y0));
    ctx.clip();
  }
  if (mod.iris !== undefined) {
    if (mod.iris <= 0.001) {
      ctx.restore();
      return;
    }
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, (mod.iris * Math.hypot(W, H)) / 2, 0, Math.PI * 2);
    ctx.clip();
  }
  ctx.globalAlpha = Math.min(1, alpha);
  ctx.globalCompositeOperation = c.blend === 'normal' ? 'source-over' : c.blend;
  const x = propAt(c, 'x', t);
  const y = propAt(c, 'y', t);
  const s = (propAt(c, 'scale', t) / 100) * mod.scale * tscale;
  const rot = propAt(c, 'rotation', t);
  const blur = propAt(c, 'blur', t) + (mod.blur || 0);
  ctx.translate(W / 2 + x + mod.dx + tdx, H / 2 + y + (mod.dy || 0) + tdy);
  if (rot) ctx.rotate((rot * Math.PI) / 180);
  ctx.scale(s * (c.props.flipH ? -1 : 1), s * (c.props.flipV ? -1 : 1));
  const filters: string[] = [];
  if (blur > 0.05) filters.push(`blur(${(blur * scale * Math.abs(s)).toFixed(2)}px)`);

  if (c.kind === 'text' && c.text) {
    if (filters.length) ctx.filter = filters.join(' ');
    drawText(ctx, c.text, chars, scale * Math.abs(s));
  } else if (c.kind === 'shape' && c.shape) {
    if (filters.length) ctx.filter = filters.join(' ');
    drawShape(ctx, c.shape, W, H);
  } else {
    drawMedia(ctx, o, c, filters, s);
  }
  ctx.restore();
}

function drawMedia(ctx: CanvasRenderingContext2D, o: RenderOptions, c: Clip, filters: string[], s: number) {
  const { project: p, t, scale } = o;
  const W = p.settings.width;
  const H = p.settings.height;
  const m = mediaOf(p, c);
  const frame = o.getFrame(c, frameTime(p, c, t));
  const [mw, mh] = m && m.width ? [m.width, m.height] : [W, H];
  const fit = Math.min(W / mw, H / mh);
  const dw = mw * fit;
  const dh = mh * fit;
  if (frame === 'offline' || !frame) {
    if (frame === 'offline') {
      ctx.fillStyle = '#5c1d1a';
      ctx.fillRect(-dw / 2, -dh / 2, dw, dh);
      ctx.fillStyle = '#f9dedc';
      ctx.font = `600 ${Math.round(H / 18)}px Inter, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Media offline', 0, 0);
    }
    return;
  }
  const [sw, sh] = sizeOf(frame);
  if (!sw || !sh) return;
  const cr = c.crop;
  const l = cr.left / 100;
  const r = cr.right / 100;
  const tp = cr.top / 100;
  const b = cr.bottom / 100;
  if (l + r >= 1 || tp + b >= 1) return;
  let img: CanvasImageSource = frame as CanvasImageSource;
  let iw = sw;
  let ih = sh;
  if (needsFx(c)) {
    // Process at no more than the size it ends up on screen.
    const k = Math.min(1, (dw * Math.abs(s) * scale) / sw);
    const mask = c.removeBg?.enabled && m ? maskAt(mediaKey(m), frameTime(p, c, t)) : null;
    const out = o.fx.process(frame as TexImageSource, sw * k, sh * k, c.colour, c.key, mask);
    if (out) {
      img = out;
      iw = out.width;
      ih = out.height;
    } else filters.push(cssColourFilter(c.colour));
  }
  if (filters.length) ctx.filter = filters.filter(Boolean).join(' ') || 'none';
  ctx.drawImage(img, iw * l, ih * tp, iw * (1 - l - r), ih * (1 - tp - b), -dw / 2 + dw * l, -dh / 2 + dh * tp, dw * (1 - l - r), dh * (1 - tp - b));
}

function drawShape(ctx: CanvasRenderingContext2D, sh: ShapeStyle, W: number, H: number) {
  const w = sh.shape === 'matte' ? W : sh.w;
  const h = sh.shape === 'matte' ? H : sh.h;
  ctx.beginPath();
  if (sh.shape === 'ellipse') ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
  else if (sh.radius > 0 && sh.shape === 'rect') ctx.roundRect(-w / 2, -h / 2, w, h, Math.min(sh.radius, w / 2, h / 2));
  else ctx.rect(-w / 2, -h / 2, w, h);
  ctx.fillStyle = sh.fill;
  if (sh.fill) ctx.fill();
  if (sh.stroke && sh.strokeWidth > 0) {
    ctx.lineWidth = sh.strokeWidth;
    ctx.strokeStyle = sh.stroke;
    ctx.stroke();
  }
}

/* ---------- Text ---------- */

const easeOut = (x: number) => 1 - Math.pow(1 - x, 3);
const easeBack = (x: number) => 1 + 2.2 * Math.pow(x - 1, 3) + 1.2 * Math.pow(x - 1, 2);

function textAnim(st: TextStyle, rel: number, len: number, W: number) {
  const d = Math.max(0.05, Math.min(st.animDuration, len / 2));
  const a = { alpha: 1, dx: 0, dy: 0, scale: 1, chars: Infinity };
  const apply = (kind: TextStyle['animIn'], x: number, entering: boolean) => {
    if (kind === 'none' || x >= 1) return;
    const e = easeOut(Math.max(0, x));
    switch (kind) {
      case 'fade':
        a.alpha *= e;
        break;
      case 'slideUp':
        a.alpha *= e;
        a.dy += (1 - e) * st.size * (entering ? 1.2 : -1.2);
        break;
      case 'slideLeft':
        a.alpha *= e;
        a.dx += (1 - e) * W * (entering ? 0.25 : -0.25);
        break;
      case 'typewriter':
        if (entering) a.chars = Math.floor(st.text.length * Math.max(0, x));
        else a.alpha *= e;
        break;
      case 'pop':
        a.alpha *= Math.min(1, x * 2);
        a.scale *= entering ? Math.max(0.01, easeBack(Math.max(0, x))) : 0.7 + 0.3 * e;
        break;
    }
  };
  // Typewriter types across a longer stretch so it reads naturally.
  const inLen = st.animIn === 'typewriter' ? Math.min(len * 0.6, Math.max(d, st.text.length * 0.05)) : d;
  apply(st.animIn, rel / inLen, true);
  apply(st.animOut, (len - rel) / d, false);
  return a;
}

export function textFont(st: TextStyle) {
  return `${st.italic ? 'italic ' : ''}${st.bold ? 700 : 400} ${st.size}px "${st.font}", Inter, sans-serif`;
}

/** Size of a text clip's box (used for selection outlines on the monitor). */
export function measureText(ctx: CanvasRenderingContext2D, st: TextStyle) {
  ctx.save();
  ctx.font = textFont(st);
  const lines = st.text.split('\n');
  const w = Math.max(1, ...lines.map((l) => ctx.measureText(l).width));
  ctx.restore();
  const lh = st.size * st.lineHeight;
  const pad = st.box ? st.boxPadding : 0;
  return { w: w + pad * 2, h: lines.length * lh + pad * 2, lines, lh, textW: w };
}

/** Draw text centred on the origin. `px` is how many canvas pixels one text pixel becomes (for shadows). */
function drawText(ctx: CanvasRenderingContext2D, st: TextStyle, chars: number, px: number) {
  const { w, h, lines, lh, textW } = measureText(ctx, st);
  if (st.box) {
    ctx.save();
    ctx.globalAlpha *= st.boxOpacity / 100;
    ctx.fillStyle = st.box;
    ctx.beginPath();
    ctx.roundRect(-w / 2, -h / 2, w, h, Math.min(st.boxRadius, h / 2));
    ctx.fill();
    ctx.restore();
  }
  ctx.font = textFont(st);
  ctx.textBaseline = 'middle';
  ctx.textAlign = st.align;
  ctx.lineJoin = 'round';
  const x = st.align === 'left' ? -textW / 2 : st.align === 'right' ? textW / 2 : 0;
  let left = chars;
  lines.forEach((line, i) => {
    if (left <= 0) return;
    const shown = line.slice(0, Math.max(0, left));
    left -= line.length + 1;
    const y = -((lines.length - 1) * lh) / 2 + i * lh;
    if (st.outline && st.outlineWidth > 0) {
      ctx.save();
      ctx.strokeStyle = st.outline;
      ctx.lineWidth = st.outlineWidth * 2;
      if (st.shadow && st.shadowBlur + st.shadowY > 0) setShadow(ctx, st, px);
      ctx.strokeText(shown, x, y);
      ctx.restore();
    }
    ctx.save();
    if (st.shadow && !(st.outline && st.outlineWidth > 0) && st.shadowBlur + st.shadowY > 0) setShadow(ctx, st, px);
    ctx.fillStyle = st.color;
    ctx.fillText(shown, x, y);
    ctx.restore();
  });
}

function setShadow(ctx: CanvasRenderingContext2D, st: TextStyle, px: number) {
  // Shadows ignore the canvas transform, so scale them by hand.
  ctx.shadowColor = st.shadow;
  ctx.shadowBlur = st.shadowBlur * px;
  ctx.shadowOffsetY = st.shadowY * px;
}

/** The clip on top at a point of the frame (for clicking on the monitor). */
export function hitTest(p: Project, t: number, fx: number, fy: number, measure: CanvasRenderingContext2D): Clip | null {
  const W = p.settings.width;
  const H = p.settings.height;
  const layers = visibleLayers(p, t).flat().reverse();
  for (const { clip: c } of layers) {
    const b = clipBox(p, c, t, measure);
    if (!b) continue;
    const s = propAt(c, 'scale', t) / 100;
    const rot = (-propAt(c, 'rotation', t) * Math.PI) / 180;
    let dx = fx - (W / 2 + propAt(c, 'x', t));
    let dy = fy - (H / 2 + propAt(c, 'y', t));
    [dx, dy] = [dx * Math.cos(rot) - dy * Math.sin(rot), dx * Math.sin(rot) + dy * Math.cos(rot)];
    if (Math.abs(dx) <= (b.w * s) / 2 && Math.abs(dy) <= (b.h * s) / 2) return c;
  }
  return null;
}

/** Unscaled size of a clip's picture in project pixels. */
export function clipBox(p: Project, c: Clip, _t: number, measure: CanvasRenderingContext2D): { w: number; h: number } | null {
  const W = p.settings.width;
  const H = p.settings.height;
  if (c.kind === 'text' && c.text) {
    const m = measureText(measure, c.text);
    return { w: m.w, h: m.h };
  }
  if (c.kind === 'shape' && c.shape) return c.shape.shape === 'matte' ? { w: W, h: H } : { w: c.shape.w, h: c.shape.h };
  const m = mediaOf(p, c);
  if (!m || !m.width) return { w: W, h: H };
  const fit = Math.min(W / m.width, H / m.height);
  return { w: m.width * fit, h: m.height * fit };
}

