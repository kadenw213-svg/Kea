// Objective design checks, measured on the real page instead of judged from a screenshot: things a careful
// designer would never ship (text spilling out of its box, text on text, unreadable contrast, near-miss alignment,
// fonts that aren't installed, too many sizes). Never taste: the layout itself stays Claude's call.
import { availableFonts } from './guide';

export interface Issue {
  severity: 'fix' | 'consider';
  text: string;
}

const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'system-ui', 'inherit', '']);

/** "#abc" / "rgb(…)" → [r, g, b] (0–255), or null. */
export function parseColour(c: string | null | undefined): [number, number, number] | null {
  if (!c) return null;
  const s = c.trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return m[1].split('').map((h) => parseInt(h + h, 16)) as [number, number, number];
  m = /^#([0-9a-f]{6})/i.exec(s);
  if (m) return [0, 2, 4].map((i) => parseInt(m![1].slice(i, i + 2), 16)) as [number, number, number];
  m = /rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/i.exec(s);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return null;
}
const lum = ([r, g, b]: [number, number, number]) => {
  const f = (v: number) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
/** WCAG contrast ratio of two colours. */
export const contrast = (a: [number, number, number], b: [number, number, number]) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

/** The average colour of an image's pixels inside a box (box in the image's own 0–1 coordinates). */
export async function sampleImage(src: string, box: { x: number; y: number; w: number; h: number }): Promise<[number, number, number] | null> {
  try {
    const img = new Image();
    img.src = src;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = c.height = 16;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    const sx = Math.max(0, box.x) * img.naturalWidth,
      sy = Math.max(0, box.y) * img.naturalHeight;
    const sw = Math.max(1, Math.min(1, box.x + box.w) * img.naturalWidth - sx),
      sh = Math.max(1, Math.min(1, box.y + box.h) * img.naturalHeight - sy);
    g.drawImage(img, sx, sy, sw, sh, 0, 0, 16, 16);
    const d = g.getImageData(0, 0, 16, 16).data;
    let r = 0,
      gg = 0,
      b = 0,
      n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 128) continue; // transparent: what's under the image shows there
      r += d[i];
      gg += d[i + 1];
      b += d[i + 2];
      n++;
    }
    return n > 64 ? [r / n, gg / n, b / n] : null;
  } catch {
    return null;
  }
}

/** Fonts used that this computer doesn't have (they'd silently fall back). */
export function missingFonts(fonts: string[]): string[] {
  const have = new Set(availableFonts().map((f) => f.toLowerCase()));
  const out = new Set<string>();
  for (const f of fonts) {
    const first = (f || '').split(',')[0].replace(/['"]/g, '').trim();
    if (!GENERIC.has(first.toLowerCase()) && !have.has(first.toLowerCase())) {
      // A family not on Kea's checklist may still be installed: measure it directly.
      const g = document.createElement('canvas').getContext('2d')!;
      const w = (font: string) => ((g.font = `40px ${font}`), g.measureText('mmmlliWW@#0123').width);
      if (['monospace', 'serif', 'sans-serif'].every((fb) => w(`"${first}", ${fb}`) === w(fb))) out.add(first);
    }
  }
  return [...out];
}

export const formatIssues = (issues: Issue[], what: string) =>
  issues.length
    ? `${issues.filter((i) => i.severity === 'fix').length} to fix, ${issues.filter((i) => i.severity === 'consider').length} to consider on ${what}:\n${issues.map((i) => `- ${i.severity === 'fix' ? 'FIX' : 'consider'}: ${i.text}`).join('\n')}`
    : `No problems found on ${what}: text fits its boxes, nothing collides, contrast is readable, fonts are installed.`;
