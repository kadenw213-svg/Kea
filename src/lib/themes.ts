// Kea's colour themes, shared by the PC and the phone (and the window frame in electron/main.cjs): one choice colours
// every screen, from menus and the calendar to quizzes and the pages of a textbook.
import THEMES_JSON from '../../electron/themes.json';

export type ThemeId = 'dark' | 'black' | 'dim' | 'light' | 'sepia';
export interface Theme {
  label: string;
  dark: boolean;
  /** CSS variables, without the leading "--". */
  c: Record<string, string>;
}
export const THEMES = THEMES_JSON as Record<ThemeId, Theme>;
export const themeOf = (id: string | null | undefined): Theme => THEMES[id as ThemeId] || THEMES.dark;
export const THEME_IDS = Object.keys(THEMES) as ThemeId[];

/** An accent made for dark backgrounds, as a colour that reads on light ones. */
export const LIGHT_ACCENTS: Record<string, string> = {
  blue: '#0b57d0',
  silver: '#0b57d0',
  purple: '#8430ce',
  teal: '#00796b',
  green: '#188038',
  orange: '#c5501b',
  pink: '#c2185b',
  yellow: '#a06500'
};

const rgb = (hex: string) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0x8ab4f8;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const hex = (r: number, g: number, b: number) => '#' + [r, g, b].map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('');

/**
 * A colour picked for dark backgrounds (the pastel kinds of item, class colours), as one that reads on a light page:
 * the same hue, darker and a little more saturated. Unchanged on dark themes.
 */
export function ink(color: string, dark: boolean) {
  if (dark || !/^#[0-9a-f]{6}$/i.test(color)) return color;
  const [r, g, b] = rgb(color).map((x) => x / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  // Grey stays grey; everything else to about 36% lightness.
  const L = s < 0.12 ? 0.4 : 0.36;
  const S = s < 0.12 ? s : Math.min(1, s * 1.1 + 0.1);
  const C = (1 - Math.abs(2 * L - 1)) * S;
  const X = C * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = L - C / 2;
  const [R, G, B] = h < 60 ? [C, X, 0] : h < 120 ? [X, C, 0] : h < 180 ? [0, C, X] : h < 240 ? [0, X, C] : h < 300 ? [X, 0, C] : [C, 0, X];
  return hex((R + m) * 255, (G + m) * 255, (B + m) * 255);
}

/** A grade's colour, from A (dark green) through B (yellow-green), C (yellow) and D (orange) to F (red). */
export function gradeColor(percent: number | null | undefined, dark: boolean): string | undefined {
  if (percent == null || !Number.isFinite(percent)) return undefined;
  const band = percent >= 90 ? 0 : percent >= 80 ? 1 : percent >= 70 ? 2 : percent >= 60 ? 3 : 4;
  return (dark ? ['#4caf6a', '#a8c64a', '#e8c547', '#f29a4a', '#f28b82'] : ['#137333', '#5c8a0e', '#9a7400', '#c25e00', '#c5221f'])[band];
}
