import { readPsd, writePsdUint8Array } from 'ag-psd';
import type { Psd, Layer as PsdLayer, BlendMode as PsdBlend, AdjustmentLayer, Color } from 'ag-psd';
import type { Doc, Layer, LayerBlend, Adjustment, Mask, TextData } from './types';
import { makeCanvas, filledCanvas, rgbToHex, hexToRgb } from './canvas';
import { adjDefaults } from './adjustments';
import { renderText } from './vector';
import { uid } from '../../lib/util';

/**
 * Photoshop files through ag-psd: layers, groups, masks, clipping, blend modes,
 * opacity/fill, adjustment layers and text layers come across both ways.
 * Layer styles, smart objects and vector masks are flattened into pixels on open.
 */

const toOurBlend = (b?: PsdBlend): LayerBlend => {
  if (!b) return 'normal';
  if (b === 'pass through') return 'pass-through';
  const id = b.replace(' ', '-');
  const ok = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'];
  if (ok.includes(id)) return id as LayerBlend;
  // Close relatives of modes the canvas doesn't have.
  if (b === 'linear burn') return 'color-burn';
  if (b === 'linear dodge') return 'color-dodge';
  if (b === 'darker color') return 'darken';
  if (b === 'lighter color') return 'lighten';
  if (b === 'vivid light' || b === 'linear light' || b === 'pin light' || b === 'hard mix') return 'hard-light';
  if (b === 'subtract' || b === 'divide') return 'difference';
  return 'normal';
};
const toPsdBlend = (b: LayerBlend): PsdBlend => (b === 'pass-through' ? 'pass through' : (b.replace('-', ' ') as PsdBlend));

function colorHex(c?: Color): string {
  if (!c) return '#000000';
  const a = c as any;
  if ('r' in a) return rgbToHex(a.r, a.g, a.b);
  if ('fr' in a) return rgbToHex(a.fr * 255, a.fg * 255, a.fb * 255);
  return '#000000';
}
const rgb = (hex: string) => hexToRgb(hex);

// ---------- Adjustments ----------
function fromPsdAdj(a: AdjustmentLayer): Adjustment | null {
  const x: any = a;
  switch (a.type) {
    case 'brightness/contrast':
      return { ...adjDefaults('brightness'), brightness: x.brightness ?? 0, contrast: x.contrast ?? 0 };
    case 'levels': {
      const d = adjDefaults('levels');
      for (const k of ['rgb', 'red', 'green', 'blue']) if (x[k]) d[k] = { ...d[k], ...x[k] };
      return d;
    }
    case 'curves': {
      const d = adjDefaults('curves');
      for (const k of ['rgb', 'red', 'green', 'blue']) if (x[k]?.length) d[k] = x[k].map((p: any) => ({ input: p.input, output: p.output }));
      return d;
    }
    case 'exposure':
      return { ...adjDefaults('exposure'), exposure: x.exposure ?? 0, offset: x.offset ?? 0, gamma: x.gamma ?? 1 };
    case 'vibrance':
      return { ...adjDefaults('vibrance'), vibrance: x.vibrance ?? 0, saturation: x.saturation ?? 0 };
    case 'hue/saturation':
      return { ...adjDefaults('hueSat'), hue: x.master?.hue ?? 0, saturation: x.master?.saturation ?? 0, lightness: x.master?.lightness ?? 0 };
    case 'color balance': {
      const d = adjDefaults('colorBalance');
      for (const k of ['shadows', 'midtones', 'highlights']) if (x[k]) d[k] = { ...d[k], ...x[k] };
      d.preserveLuminosity = x.preserveLuminosity ?? true;
      return d;
    }
    case 'black & white': {
      const d = adjDefaults('bw');
      for (const k of ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas']) if (typeof x[k] === 'number') d[k] = x[k];
      d.useTint = !!x.useTint;
      if (x.tintColor) d.tintColor = colorHex(x.tintColor);
      return d;
    }
    case 'photo filter':
      return { ...adjDefaults('photoFilter'), color: x.color ? colorHex(x.color) : '#ec8a00', density: x.density ?? 25, preserveLuminosity: x.preserveLuminosity ?? true };
    case 'channel mixer': {
      const d = adjDefaults('channelMixer');
      for (const k of ['red', 'green', 'blue', 'gray']) if (x[k]) d[k] = { ...d[k], ...x[k] };
      d.monochrome = !!x.monochrome;
      return d;
    }
    case 'invert':
      return adjDefaults('invert');
    case 'posterize':
      return { ...adjDefaults('posterize'), levels: x.levels ?? 4 };
    case 'threshold':
      return { ...adjDefaults('threshold'), level: x.level ?? 128 };
    case 'gradient map': {
      const d = adjDefaults('gradientMap');
      // ag-psd gives locations as 0–1 (older versions used Photoshop's 0–4096).
      if (x.colorStops?.length) d.stops = x.colorStops.map((s: any) => ({ pos: Math.max(0, Math.min(1, (s.location ?? 0) > 1 ? s.location / 4096 : s.location ?? 0)), color: colorHex(s.color) }));
      d.reverse = !!x.reverse;
      return d;
    }
    case 'selective color': {
      const d = adjDefaults('selectiveColor');
      d.mode = x.mode === 'absolute' ? 'absolute' : 'relative';
      for (const k of ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas', 'whites', 'neutrals', 'blacks']) if (x[k]) d[k] = { ...d[k], ...x[k] };
      return d;
    }
  }
  return null;
}

function toPsdAdj(a: Adjustment): AdjustmentLayer {
  switch (a.type) {
    case 'brightness':
      return { type: 'brightness/contrast', brightness: a.brightness, contrast: a.contrast };
    case 'levels':
      return { type: 'levels', rgb: a.rgb, red: a.red, green: a.green, blue: a.blue };
    case 'curves':
      return { type: 'curves', rgb: a.rgb, red: a.red, green: a.green, blue: a.blue };
    case 'exposure':
      return { type: 'exposure', exposure: a.exposure, offset: a.offset, gamma: a.gamma };
    case 'vibrance':
      return { type: 'vibrance', vibrance: a.vibrance, saturation: a.saturation };
    case 'hueSat':
      return { type: 'hue/saturation', master: { a: 0, b: 0, c: 0, d: 0, hue: a.hue, saturation: a.saturation, lightness: a.lightness } };
    case 'colorBalance':
      return { type: 'color balance', shadows: a.shadows, midtones: a.midtones, highlights: a.highlights, preserveLuminosity: a.preserveLuminosity };
    case 'bw':
      return { type: 'black & white', reds: a.reds, yellows: a.yellows, greens: a.greens, cyans: a.cyans, blues: a.blues, magentas: a.magentas, useTint: a.useTint, tintColor: rgb(a.tintColor) };
    case 'photoFilter':
      return { type: 'photo filter', color: rgb(a.color), density: a.density, preserveLuminosity: a.preserveLuminosity };
    case 'channelMixer':
      return { type: 'channel mixer', monochrome: a.monochrome, red: a.red, green: a.green, blue: a.blue, gray: a.gray };
    case 'invert':
      return { type: 'invert' };
    case 'posterize':
      return { type: 'posterize', levels: a.levels };
    case 'threshold':
      return { type: 'threshold', level: a.level };
    case 'gradientMap':
      return {
        type: 'gradient map',
        gradientType: 'solid',
        reverse: a.reverse,
        smoothness: 1,
        colorStops: a.stops.map((s: any) => ({ color: rgb(s.color), location: s.pos, midpoint: 0.5 })),
        opacityStops: [
          { opacity: 1, location: 0, midpoint: 0.5 },
          { opacity: 1, location: 1, midpoint: 0.5 }
        ]
      };
    case 'selectiveColor':
      return { type: 'selective color', mode: a.mode, reds: a.reds, yellows: a.yellows, greens: a.greens, cyans: a.cyans, blues: a.blues, magentas: a.magentas, whites: a.whites, neutrals: a.neutrals, blacks: a.blacks };
  }
}

// ---------- Read ----------
function readMask(m: PsdLayer['mask']): Mask | null {
  if (!m) return null;
  const outside = m.defaultColor ?? 255;
  const canvas = m.canvas && m.canvas.width > 0 && m.canvas.height > 0 ? m.canvas : filledCanvas(1, 1, outside >= 128 ? '#fff' : '#000');
  return { canvas, x: m.left ?? 0, y: m.top ?? 0, enabled: !m.disabled, linked: true, outside };
}

function readLayer(p: PsdLayer, w: number, h: number): Layer {
  const base = {
    id: uid(),
    name: p.name || 'Layer',
    visible: !p.hidden,
    locked: !!(p.protected?.composite || p.protected?.position),
    opacity: p.opacity ?? 1,
    fill: p.fillOpacity ?? 1,
    blend: toOurBlend(p.blendMode),
    clip: !!p.clipping,
    mask: readMask(p.mask)
  };
  if (p.children) return { ...base, kind: 'group', children: p.children.map((c) => readLayer(c, w, h)), open: !!p.opened };
  if (base.blend === 'pass-through') base.blend = 'normal';
  if (p.adjustment) {
    const adj = fromPsdAdj(p.adjustment);
    if (adj) return { ...base, kind: 'adjust', adj };
  }
  const canvas = p.canvas && p.canvas.width > 0 && p.canvas.height > 0 ? p.canvas : makeCanvas(1, 1);
  if (p.text?.text != null) {
    const st = p.text.style || {};
    const tf = p.text.transform || [1, 0, 0, 1, p.left ?? 0, p.top ?? 0];
    const scale = Math.sqrt(Math.abs(tf[0] * tf[3] - tf[1] * tf[2])) || 1;
    const size = Math.max(1, (st.fontSize || 24) * scale);
    const just = p.text.paragraphStyle?.justification || 'left';
    const align: TextData['align'] = just.includes('center') ? 'center' : just.includes('right') ? 'right' : 'left';
    const text: TextData = {
      text: p.text.text.replace(/\r/g, '\n'),
      font: st.font?.name?.replace(/-.*$/, '').replace(/([a-z])([A-Z])/g, '$1 $2') || 'Arial',
      size,
      color: colorHex(st.fillColor),
      bold: !!st.fauxBold || /bold/i.test(st.font?.name || ''),
      italic: !!st.fauxItalic || /italic/i.test(st.font?.name || ''),
      align,
      leading: st.leading && !st.autoLeading ? st.leading / (st.fontSize || 24) : 1.2,
      x: tf[4],
      y: tf[5] - size * 0.85
    };
    // Keep Photoshop's own rendering until the text is edited.
    return { ...base, kind: 'text', text, canvas, x: p.left ?? 0, y: p.top ?? 0 };
  }
  return { ...base, kind: 'raster', canvas, x: p.left ?? 0, y: p.top ?? 0 };
}

export function readPsdDoc(bytes: Uint8Array): Doc {
  const psd = readPsd(bytes, { skipThumbnail: true });
  const w = psd.width,
    h = psd.height;
  let layers: Layer[] = (psd.children || []).map((c) => readLayer(c, w, h));
  if (!layers.length && psd.canvas) {
    layers = [{ id: uid(), name: 'Background', visible: true, locked: false, opacity: 1, fill: 1, blend: 'normal', clip: false, mask: null, kind: 'raster', canvas: psd.canvas, x: 0, y: 0 }];
  }
  return { w, h, layers };
}

// ---------- Write ----------
function writeMask(m: Mask | null): PsdLayer['mask'] {
  if (!m) return undefined;
  return { canvas: m.canvas, left: m.x, top: m.y, right: m.x + m.canvas.width, bottom: m.y + m.canvas.height, defaultColor: m.outside, disabled: !m.enabled };
}

function writeLayer(l: Layer, withText: boolean): PsdLayer {
  const base: PsdLayer = {
    name: l.name,
    hidden: !l.visible,
    opacity: l.opacity,
    fillOpacity: l.fill,
    blendMode: toPsdBlend(l.blend),
    clipping: l.clip,
    mask: writeMask(l.mask),
    ...(l.locked ? { protected: { transparency: true, composite: true, position: true } } : {})
  };
  if (l.kind === 'group') return { ...base, opened: l.open, children: l.children.map((c) => writeLayer(c, withText)) };
  if (l.kind === 'adjust') return { ...base, adjustment: toPsdAdj(l.adj) };
  const px: PsdLayer = { ...base, canvas: l.canvas, left: l.x, top: l.y };
  if (l.kind === 'text' && withText) {
    const t = l.text;
    if (l.canvas.width <= 1) renderText(l);
    px.text = {
      text: t.text.replace(/\n/g, '\r'),
      transform: [1, 0, 0, 1, t.x, t.y + t.size * 0.85],
      style: { font: { name: t.font.replace(/\s+/g, '') }, fontSize: t.size, fillColor: rgb(t.color), fauxBold: t.bold, fauxItalic: t.italic, autoLeading: false, leading: t.size * t.leading },
      paragraphStyle: { justification: t.align }
    };
    px.canvas = l.canvas;
  }
  return px;
}

/** Write a layered PSD. `composite` is the flattened image (used for previews and by apps that can't read layers). */
export function writePsdDoc(doc: Doc, composite: HTMLCanvasElement): Uint8Array {
  const make = (withText: boolean): Psd => ({ width: doc.w, height: doc.h, children: doc.layers.map((l) => writeLayer(l, withText)), canvas: composite });
  try {
    return writePsdUint8Array(make(true), { generateThumbnail: true, invalidateTextLayers: true, noBackground: true });
  } catch {
    // Text layer data can be picky; fall back to keeping text as pixels.
    return writePsdUint8Array(make(false), { generateThumbnail: true, noBackground: true });
  }
}
