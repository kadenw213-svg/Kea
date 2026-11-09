// Which text colour reads on a highlight. Pure (no imports), so tests run it directly.
//
// A highlight keeps the colour the person chose (it is saved as is); only the text drawn on it changes: dark text on
// a light highlight, light text on a dark one. On a white page the document's own text colour stays, unless the
// highlight is dark.

/** The colour new highlights get unless the person picks another: a muted yellow that reads on white and dark pages. */
export const DEFAULT_HIGHLIGHT = '#f2e2a0';

/** Highlight swatches: soft colours first (easy on the eyes), then the classic bright ones. */
export const HIGHLIGHT_SWATCHES = [
  '#f2e2a0', '#cfe6c3', '#c5dcf2', '#f2cfe0', '#f5d3b5', '#dcd2ef', '#d4e9e6', '#e3e3e3',
  '#ffff00', '#00ff00', '#00ffff', '#ff00ff', '#fce5cd', '#fff2cc', '#d9ead3', '#cfe2f3'
];

const NAMED: Record<string, string> = {
  yellow: '#ffff00', lime: '#00ff00', green: '#008000', cyan: '#00ffff', aqua: '#00ffff', magenta: '#ff00ff', fuchsia: '#ff00ff',
  red: '#ff0000', blue: '#0000ff', black: '#000000', white: '#ffffff', gray: '#808080', grey: '#808080', silver: '#c0c0c0',
  orange: '#ffa500', pink: '#ffc0cb', purple: '#800080', navy: '#000080', teal: '#008080', maroon: '#800000', olive: '#808000',
  darkblue: '#00008b', darkred: '#8b0000', darkgreen: '#006400', darkcyan: '#008b8b', darkmagenta: '#8b008b', darkyellow: '#808000',
  darkgray: '#a9a9a9', darkgrey: '#a9a9a9', lightgray: '#d3d3d3', lightgrey: '#d3d3d3'
};

/** A CSS colour (#rgb, #rrggbb, #rrggbbaa, rgb()/rgba(), a common name) as [r, g, b, alpha 0–1], or null. */
export function parseCssColour(c: string | null | undefined): [number, number, number, number] | null {
  if (!c) return null;
  let s = String(c).trim().toLowerCase();
  if (NAMED[s]) s = NAMED[s];
  let m = s.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((x) => x + x).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/);
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return [+m[1], +m[2], +m[3], Math.max(0, Math.min(1, a))];
  }
  return null;
}

/** WCAG relative luminance of an sRGB colour (0 black … 1 white). */
export function luminance([r, g, b]: [number, number, number, number?]): number {
  const lin = (v: number) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
const DARK_INK = '#202124';
const LIGHT_INK = '#ffffff';

/**
 * The ink that reads on this highlight: 'dark' or 'light', whichever has more contrast with it. A see-through
 * highlight is judged over `page` (the page colour behind it). Unknown colours count as light (most highlights are).
 */
export function highlightInk(colour: string | null | undefined, page: string = '#ffffff'): 'dark' | 'light' {
  const c = parseCssColour(colour);
  if (!c) return 'dark';
  const p = parseCssColour(page) || [255, 255, 255, 1];
  const a = c[3];
  const mix: [number, number, number, number] = [c[0] * a + p[0] * (1 - a), c[1] * a + p[1] * (1 - a), c[2] * a + p[2] * (1 - a), 1];
  const L = luminance(mix);
  return contrast(L, luminance(parseCssColour(DARK_INK)!)) >= contrast(L, luminance(parseCssColour(LIGHT_INK)!)) ? 'dark' : 'light';
}

/**
 * The text colour to draw on a highlight, or null to keep the document's own. On a light page the document's text
 * (dark) stays on light highlights; on a dark page its light text is swapped for dark ink on light highlights.
 */
export function inkOnHighlight(colour: string | null | undefined, paper: 'light' | 'dark'): string | null {
  const ink = highlightInk(colour);
  if (paper === 'light') return ink === 'dark' ? null : LIGHT_INK;
  return ink === 'dark' ? DARK_INK : null;
}
