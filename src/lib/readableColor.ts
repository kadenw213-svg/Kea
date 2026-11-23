// Readable cell colours (Kea 0.103). A spreadsheet's fills and text colours are made for white paper: a pale blue
// header fill (#e8f0fe) with no text colour shows Kea's light dark-mode text on a light fill, and dark text with no
// fill disappears into the dark grid. This works out what to show, at display time only (the file keeps its own
// colours): in dark mode light fills become a dark tint of the same hue, and any text colour that would be hard to
// read on its fill is moved to a lighter or darker shade of itself, the way Office's dark mode does.
import { useEffect, useState } from 'react';

type RGB = [number, number, number];

function parse(c: string | undefined): RGB | null {
  if (!c) return null;
  const s = c.trim().toLowerCase();
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split('').map((x) => x + x).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(s);
  if (m) return [+m[1], +m[2], +m[3]];
  if (s === 'white') return [255, 255, 255];
  if (s === 'black') return [0, 0, 0];
  return null;
}

const lin = (v: number) => {
  const x = v / 255;
  return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
};
const lum = ([r, g, b]: RGB) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
export const contrast = (a: RGB, b: RGB) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

function toHsl([r, g, b]: RGB): [number, number, number] {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return [h / 6, s, l];
}
function fromHsl(h: number, s: number, l: number): RGB {
  if (!s) return [l, l, l].map((v) => Math.round(v * 255)) as RGB;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)].map((v) => Math.round(v * 255)) as RGB;
}
const hex = (c: RGB) => `#${c.map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')}`;

// What the grid and its default text look like in each mode (redesign.css .sheet-editor, light.css).
const GRID = { dark: [38, 41, 45] as RGB, light: [255, 255, 255] as RGB };
const TEXT = { dark: [230, 231, 232] as RGB, light: [32, 33, 36] as RGB };
const MIN = 4.5;

/** A fill as dark mode shows it: a light fill becomes a dark tint of the same hue; dark and mid fills stay. */
export function darkFill(bg: RGB): RGB {
  if (lum(bg) <= 0.4) return bg;
  const [h, s] = toHsl(bg);
  return s < 0.08 ? [52, 56, 61] : fromHsl(h, Math.min(s, 0.45), 0.26);
}

/** A text colour moved just far enough lighter or darker (keeping its hue) to read on `on`. */
function readableText(color: RGB, on: RGB): RGB {
  if (contrast(color, on) >= MIN) return color;
  const [h, s] = toHsl(color);
  const lighter = lum(on) < 0.3;
  for (let i = 1; i <= 20; i++) {
    const l = lighter ? 0.5 + i * 0.025 : 0.5 - i * 0.025;
    const c = fromHsl(h, Math.min(s, 0.85), l);
    if (contrast(c, on) >= MIN) return c;
  }
  return lighter ? [245, 246, 247] : [20, 20, 22];
}

const cache = new Map<string, { bg?: string; color?: string }>();

/**
 * What a cell shows for its fill and text colour. `bg`/`color`: the cell's own (or conditional format's) colours;
 * `dark`: whether Kea is in a dark theme. Unknown colour formats are left as they are.
 */
export function cellColors(bg: string | undefined, color: string | undefined, dark: boolean): { bg?: string; color?: string } {
  if (!bg && !color) return {};
  const k = `${bg}|${color}|${dark ? 1 : 0}`;
  const hit = cache.get(k);
  if (hit) return hit;
  const mode = dark ? 'dark' : 'light';
  const b = parse(bg);
  const c = parse(color);
  let showBg = bg;
  let eff = GRID[mode];
  if (b) {
    const shown = dark ? darkFill(b) : b;
    if (dark && shown !== b) showBg = hex(shown);
    eff = shown;
  }
  let showColor = color;
  if (c) {
    const r = readableText(c, eff);
    if (r !== c) showColor = hex(r);
  } else if (!color || !c) {
    // No text colour of its own (or one we can't read): the default text, unless it's hard to read on this fill.
    if (!color && contrast(TEXT[mode], eff) < MIN) showColor = contrast(TEXT.dark, eff) >= contrast(TEXT.light, eff) ? hex(TEXT.dark) : hex(TEXT.light);
  }
  const out = { bg: showBg, color: showColor };
  if (cache.size > 4000) cache.clear();
  cache.set(k, out);
  return out;
}

/** Whether Kea is showing a dark theme right now (follows Settings → Look & feel as it changes). */
export function useDarkTheme() {
  const read = () => document.documentElement.dataset.theme !== 'light';
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const o = new MutationObserver(() => setDark(read()));
    o.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => o.disconnect();
  }, []);
  return dark;
}

/** A border colour as shown: on dark, black and near-black lines become a light grey of the same hue (3:1). */
export function lineColor(color: string, dark: boolean): string {
  if (!dark) return color;
  const c = parse(color);
  if (!c || contrast(c, GRID.dark) >= 3) return color;
  const [h, s] = toHsl(c);
  for (let i = 1; i <= 20; i++) {
    const t = fromHsl(h, Math.min(s, 0.5), 0.4 + i * 0.025);
    if (contrast(t, GRID.dark) >= 3) return hex(t);
  }
  return '#8a9099';
}
