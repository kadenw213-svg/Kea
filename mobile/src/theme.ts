// How Kea looks on the phone, all of it the student's choice: the theme (dark by default, true black for reading in bed,
// dim, light, sepia), the accent colour, the text size, and the reader's own page colour and voice. Kept on the phone
// and applied as the colour variables every screen already uses.
import { useEffect, useState } from 'react';

export type ThemeId = 'dark' | 'black' | 'dim' | 'light' | 'sepia';
export type AccentId = 'silver' | 'blue' | 'teal' | 'green' | 'purple' | 'pink' | 'orange' | 'yellow';
export type PageId = 'match' | 'white' | 'sepia' | 'dark' | 'black';
export interface Look {
  theme: ThemeId;
  accent: AccentId;
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
  /** Documents and books (Word, EPUB…): text size, font and line spacing. */
  docScale: number;
  docFont: 'sans' | 'serif' | 'mono';
  docLeading: number;
}
const DEFAULT: Look = { theme: 'dark', accent: 'silver', scale: 1, page: 'match', voice: '', rate: 1, follow: true, highlight: 'fill', docScale: 1, docFont: 'serif', docLeading: 1.6 };
const KEY = 'kea.look';

const THEMES: Record<ThemeId, { label: string; dark: boolean; c: Record<string, string> }> = {
  dark: { label: 'Dark', dark: true, c: { bg: '#131314', surface: '#1b1c1e', 'surface-2': '#222326', 'surface-3': '#2c2e31', 'surface-4': '#36373a', border: '#2f3134', 'border-strong': '#444649', hover: '#26282b', text: '#e3e4e6', 'text-2': '#c4c7c5', 'text-3': '#8e9196' } },
  black: { label: 'Black', dark: true, c: { bg: '#000000', surface: '#0e0e0f', 'surface-2': '#151516', 'surface-3': '#1f2022', 'surface-4': '#2a2b2d', border: '#232426', 'border-strong': '#38393c', hover: '#18191a', text: '#e3e4e6', 'text-2': '#bfc2c0', 'text-3': '#86898e' } },
  dim: { label: 'Dim', dark: true, c: { bg: '#1a1f27', surface: '#222833', 'surface-2': '#29303c', 'surface-3': '#323a47', 'surface-4': '#3c4553', border: '#353d4a', 'border-strong': '#4a5363', hover: '#2c3340', text: '#e4e8ee', 'text-2': '#c3c9d3', 'text-3': '#8d96a5' } },
  light: { label: 'Light', dark: false, c: { bg: '#f6f7f9', surface: '#ffffff', 'surface-2': '#f0f1f4', 'surface-3': '#e5e7eb', 'surface-4': '#d9dce1', border: '#dfe1e6', 'border-strong': '#c4c8cf', hover: '#eceef1', text: '#1b1c1e', 'text-2': '#3c4043', 'text-3': '#6b7076' } },
  sepia: { label: 'Sepia', dark: false, c: { bg: '#f4ecd8', surface: '#faf4e4', 'surface-2': '#efe5cc', 'surface-3': '#e6dabd', 'surface-4': '#dacdab', border: '#e0d3b3', 'border-strong': '#c9b98f', hover: '#ece1c5', text: '#3b2f20', 'text-2': '#5b4a35', 'text-3': '#86735a' } }
};
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
  const l = { ...getLook(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(l));
  } catch {}
  applyLook(l);
  subs.forEach((f) => f(l));
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

export function applyLook(l: Look = getLook()) {
  const t = THEMES[l.theme] || THEMES.dark;
  const a = ACCENTS[l.accent] || ACCENTS.silver;
  const s = document.documentElement.style;
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
}
