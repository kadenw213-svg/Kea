// How Kea looks on the phone, all of it the student's choice: the theme (dark by default, true black for reading in bed,
// dim, light, sepia), the accent colour, the text size, and the reader's own page colour and voice. Kept on the phone
// and applied as the colour variables every screen already uses.
import { useEffect, useState } from 'react';
import { THEMES, ThemeId } from '../../src/lib/themes';

export type { ThemeId };
export type AccentId = 'silver' | 'blue' | 'teal' | 'green' | 'purple' | 'pink' | 'orange' | 'yellow';
export type PageId = 'match' | 'white' | 'sepia' | 'dark' | 'black';
export interface Look {
  theme: ThemeId;
  /** When the theme was last picked (here or on the PC): the newer choice wins when they sync. */
  themeAt?: string;
  accent: AccentId;
  /** Class sites and publisher pages (ALEKS, Pearson…) opened from Kea take these colours. */
  siteColors: boolean;
  /** Size of everything, as a share of normal. */
  scale: number;
  /** The book's pages: as the theme, or a paper colour of their own. */
  page: PageId;
  voice: string;
  rate: number;
  /** While reading aloud, scroll to the page being read. */
  follow: boolean;
  /** How the sentence being read is marked on the page. */
  highlight: 'fill' | 'underline' | 'off';
  /** Scanned pages take the page colour too (off: scans stay as they were photographed, on white paper). */
  darkScans?: boolean;
  /** Documents and books (Word, EPUB…): text size, font and line spacing. */
  docScale: number;
  docFont: 'sans' | 'serif' | 'mono';
  docLeading: number;
}
const DEFAULT: Look = { theme: 'dark', accent: 'silver', siteColors: true, scale: 1, page: 'match', voice: '', rate: 1, follow: true, highlight: 'fill', docScale: 1, docFont: 'serif', docLeading: 1.6 };
const KEY = 'kea.look';

// (The themes themselves are shared with Kea on the PC: src/lib/themes.ts.)
// Each accent, for dark themes and for light ones.
const ACCENTS: Record<AccentId, { label: string; dark: string; light: string }> = {
  silver: { label: 'Classic (silver and blue)', dark: '#a8c7fa', light: '#0b57d0' },
  blue: { label: 'Blue', dark: '#8ab4f8', light: '#1a73e8' },
  teal: { label: 'Teal', dark: '#78d9d0', light: '#00796b' },
  green: { label: 'Green', dark: '#81c995', light: '#188038' },
  purple: { label: 'Purple', dark: '#c58af9', light: '#8430ce' },
  pink: { label: 'Pink', dark: '#f9a8d4', light: '#c2185b' },
  orange: { label: 'Orange', dark: '#fcad70', light: '#c5501b' },
  yellow: { label: 'Yellow', dark: '#fdd663', light: '#a06500' }
};
export const PAGES: Record<PageId, { label: string; bg: string; filter: string }> = {
  match: { label: 'As the theme', bg: '', filter: '' },
  white: { label: 'White', bg: '#ffffff', filter: 'none' },
  sepia: { label: 'Sepia', bg: '#f4ecd8', filter: 'sepia(0.35) brightness(0.97)' },
  dark: { label: 'Dark', bg: '#1b1c1e', filter: 'invert(0.9) hue-rotate(180deg)' },
  black: { label: 'Black', bg: '#000000', filter: 'invert(1) hue-rotate(180deg)' }
};
export const THEME_LIST = Object.entries(THEMES).map(([id, t]) => ({ id: id as ThemeId, label: t.label, bg: t.c.bg, surface: t.c.surface, text: t.c.text }));
export const ACCENT_LIST = Object.entries(ACCENTS).map(([id, a]) => ({ id: id as AccentId, label: a.label, color: a.dark, light: a.light }));

export function getLook(): Look {
  try {
    return { ...DEFAULT, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return DEFAULT;
  }
}
const subs = new Set<(l: Look) => void>();
export function setLook(patch: Partial<Look>) {
  const before = getLook();
  // A theme picked here is newer than the PC's; one that came from the PC keeps the PC's time.
  if (patch.theme && patch.theme !== before.theme && !patch.themeAt) patch = { ...patch, themeAt: new Date().toISOString() };
  const l = { ...before, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(l));
  } catch {}
  applyLook(l);
  subs.forEach((f) => f(l));
  if (patch.theme && patch.theme !== before.theme) themeListeners.forEach((f) => f(l));
}
/** Told when the theme changes (to send it to the PC and to the shared screens' settings). */
const themeListeners = new Set<(l: Look) => void>();
export const onThemeChange = (f: (l: Look) => void) => (themeListeners.add(f), () => themeListeners.delete(f));
/** Pages turned light or dark in a reader: the app's theme follows (as on the PC), keeping the page colour as the theme. */
export function setPageTheme(id: PageId) {
  const theme: ThemeId = id === 'white' ? 'light' : id === 'sepia' ? 'sepia' : id === 'black' ? 'black' : id === 'dark' ? (THEMES[getLook().theme]?.dark ? getLook().theme : 'dark') : getLook().theme;
  setLook({ theme, page: 'match' });
}
export function useLook(): Look {
  const [l, setL] = useState(getLook);
  useEffect(() => {
    subs.add(setL);
    return () => {
      subs.delete(setL);
    };
  }, []);
  return l;
}

const hexA = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};
/** The page colour the reader uses, from the look (the theme's own when it's "as the theme"). */
export function pageOf(l: Look) {
  if (l.page !== 'match') return PAGES[l.page];
  const t = THEMES[l.theme];
  return l.theme === 'black' ? PAGES.black : t.dark ? PAGES.dark : l.theme === 'sepia' ? PAGES.sepia : PAGES.white;
}
/** A scan from Kea's scanner (kept in its scans folder). */
export const isScan = (file: string) => /[\/]scans[\/]/.test(file);
/** The page colour for one file: a scan keeps its own paper unless the student turned on dark scans. */
export const pageFor = (l: Look, file: string) => (isScan(file) && !l.darkScans ? PAGES.white : pageOf(l));

export function applyLook(l: Look = getLook()) {
  const t = THEMES[l.theme] || THEMES.dark;
  const a = ACCENTS[l.accent] || ACCENTS.silver;
  const s = document.documentElement.style;
  // (Every colour the screens use, the state colours too: red and green that read on this theme.)
  for (const [k, v] of Object.entries(t.c)) s.setProperty(`--${k}`, v);
  const accent = t.dark ? a.dark : a.light;
  s.setProperty('--accent', accent);
  s.setProperty('--accent-strong', accent);
  s.setProperty('--accent-soft', hexA(accent, t.dark ? 0.16 : 0.12));
  s.setProperty('--on-accent', t.dark ? '#111214' : '#ffffff');
  s.setProperty('--active', t.dark ? 'rgba(232, 234, 237, 0.12)' : 'rgba(0, 0, 0, 0.08)');
  // Main buttons: silver on silver (the original look), or the accent colour.
  s.setProperty('--primary', l.accent === 'silver' ? t.c.text : accent);
  s.setProperty('--on-primary', l.accent === 'silver' ? t.c.bg : t.dark ? '#111214' : '#ffffff');
  s.setProperty('color-scheme', t.dark ? 'dark' : 'light');
  // (Everything bigger or smaller together, so nothing is left out of step.)
  s.setProperty('zoom', String(l.scale));
  document.documentElement.dataset.theme = t.dark ? 'dark' : 'light';
  const meta = document.querySelector('meta[name=theme-color]') || document.head.appendChild(Object.assign(document.createElement('meta'), { name: 'theme-color' }));
  meta.setAttribute('content', t.c.bg);
  // Class sites opened from Kea: dark themes darken the page to these exact colours; light ones keep the page light.
  // Either way the site's own brand colour (its buttons, links and tabs) becomes the accent.
  const site = { on: l.siteColors !== false, match: true, invert: t.dark, header: true, docs: false, sites: {}, offHosts: [], theme: { surface: t.c.surface, text: t.c.text, accent, onAccent: t.dark ? '#111214' : '#ffffff' } };
  import('./kea').then(({ Kea }) => Kea.siteTheme?.({ json: JSON.stringify(site) })).catch(() => {});
}
