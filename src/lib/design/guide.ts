// The design knowledge Claude works from when it designs in any editor (fliers, posters, slides, title pages,
// handouts, social posts): layout, typography, colour, a catalogue of art directions, pro detailing, format templates,
// the psychology of attention, and vector-art techniques. Researched guides live as Markdown beside this file; Claude
// reads the topics it needs with the design_guide tool rather than carrying all of it in every message.
import type { AssistantTool } from '../../store';
import craft from './craft.md?raw';
import psychology from './psychology.md?raw';
import vector from './vector.md?raw';

/** "## N. Title" sections of a guide, by number. */
function sections(md: string): Map<number, string> {
  const out = new Map<number, string>();
  const parts = md.split(/^(?=## \d+\.)/m);
  for (const p of parts) {
    const m = p.match(/^## (\d+)\./);
    if (m) out.set(Number(m[1]), p.trim());
  }
  return out;
}
const C = sections(craft);
const P = sections(psychology);
const V = sections(vector);
const pick = (src: Map<number, string>, ns: number[]) => ns.map((n) => src.get(n)).filter(Boolean).join('\n\n');

export const DESIGN_TOPICS: Record<string, { about: string; text: () => string }> = {
  start: { about: 'the working method, the fonts installed here, and the self-critique checklists (read first, every design)', text: () => [pick(C, [0]), installedFonts(), pick(C, [7]), pick(P, [11])].join('\n\n') },
  layout: { about: 'grids, margins, spacing scale, alignment, focal point, scanning patterns, Gestalt spacing', text: () => [pick(C, [1]), pick(P, [2, 3])].join('\n\n') },
  typography: { about: 'type scales, sizes per format, font pairings, tracking, leading, line length, pro details', text: () => pick(C, [2]) },
  colour: { about: 'palettes, contrast, harmonies, palette from a reference image, gradients, mood, colour psychology', text: () => [pick(C, [3]), pick(P, [7])].join('\n\n') },
  styles: { about: '19 art directions (Swiss, editorial, gradient, brutalism, luxury, retro, riso, Bauhaus, duotone, collage, neon…) with recipes, plus pro detailing', text: () => pick(C, [4, 5]) },
  formats: { about: 'templates with coordinates for fliers, A4, posters, slides, social, title pages, handouts, infographics; legibility at distance; what event fliers must say; slides that teach', text: () => [pick(C, [6]), pick(P, [5, 6, 8, 10])].join('\n\n') },
  psychology: { about: 'what people notice first, contrast and isolation, cognitive load, trust and memorability', text: () => pick(P, [1, 4, 5, 9]) },
  vector: { about: 'how to write SVG artwork that renders well here: ground rules, composing art layers behind text, common mistakes (read before any vector-* topic)', text: () => pick(V, [0, 1, 7, 8]) },
  'vector-backgrounds': { about: 'SVG recipes: mesh gradients, blobs, aurora, grain, paper, halftone, patterns, contours, waves, sunburst, confetti, bokeh', text: () => pick(V, [2]) },
  'vector-shapes': { about: 'SVG recipes: organic blobs, dividers, torn paper, seals and badges, ribbons, arrows, brush strokes; shadows, glow, glass, isometric, landscapes', text: () => pick(V, [3, 4]) },
  'vector-illustration': { about: 'SVG recipes: flat illustration, icon sets, low-poly, retro sun, florals, Bauhaus/Memphis, image frames, masks, duotone and scrims', text: () => pick(V, [5, 6]) }
};

// Fonts the guides recommend, checked against what this computer actually has (a missing font silently falls back).
const CANDIDATES = ['Segoe UI', 'Segoe UI Black', 'Segoe UI Semibold', 'Segoe UI Light', 'Segoe UI Variable Display', 'Bahnschrift', 'Bahnschrift Condensed', 'Bahnschrift SemiCondensed', 'Georgia', 'Sitka Display', 'Sitka Heading', 'Sitka Text', 'Cambria', 'Constantia', 'Corbel', 'Candara', 'Calibri', 'Calibri Light', 'Franklin Gothic Medium', 'Franklin Gothic Demi', 'Franklin Gothic Heavy', 'Trebuchet MS', 'Gabriola', 'Segoe Script', 'Consolas', 'Arial', 'Arial Black', 'Impact', 'Times New Roman', 'Helvetica Neue', 'Avenir Next', 'Futura', 'Gill Sans', 'Didot', 'Baskerville', 'Optima', 'Menlo', 'SF Pro Display', 'Inter', 'Roboto'];
let fontCache: string[] | null = null;
export function availableFonts(): string[] {
  if (fontCache) return fontCache;
  const g = document.createElement('canvas').getContext('2d')!;
  const sample = 'mmmmmmmmmlliWW@#0123 Quick Brown';
  const width = (font: string) => {
    g.font = `40px ${font}`;
    return g.measureText(sample).width;
  };
  const base = ['monospace', 'serif', 'sans-serif'].map((f) => [f, width(f)] as const);
  // A font is there if text set in it differs from every generic fallback.
  fontCache = CANDIDATES.filter((name) => base.some(([fb, w]) => width(`"${name}", ${fb}`) !== w));
  return fontCache;
}
function installedFonts() {
  const have = availableFonts();
  return `## Fonts installed on this computer\nUse only these for text boxes and SVG text (anything else falls back to a default and ruins the design): ${have.join(', ')}.\nPDF text boxes only have Helvetica, Times and Courier: for display type on a PDF page, set it as SVG artwork (add_image with svg and <text font-family="…">) using an installed font.`;
}

export const designGuideTool: AssistantTool = {
  name: 'design_guide',
  description: `Professional design knowledge to apply whenever you design or restyle anything visual (flier, poster, slide, title page, handout, social post, infographic, layout of a page). Read "start" first, then the topics the job needs. Topics: ${Object.entries(DESIGN_TOPICS)
    .map(([k, v]) => `${k} (${v.about})`)
    .join('; ')}.`,
  input_schema: { type: 'object', properties: { topic: { type: 'string', enum: Object.keys(DESIGN_TOPICS) } }, required: ['topic'] },
  run: ({ topic }) => {
    const t = DESIGN_TOPICS[topic];
    if (!t) throw new Error(`Topics: ${Object.keys(DESIGN_TOPICS).join(', ')}.`);
    return t.text();
  }
};
