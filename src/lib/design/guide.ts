// The design knowledge Claude works from when it designs in any editor (fliers, posters, slides, title pages,
// handouts, social posts): layout, typography, colour, a catalogue of art directions, pro detailing, format templates,
// the psychology of attention, and vector-art techniques. Researched guides live as Markdown beside this file; Claude
// reads the topics it needs with the design_guide tool rather than carrying all of it in every message.
import type { AssistantTool } from '../../store';
import { api } from '../api';
import { setting } from '../settings';
import craft from './craft.md?raw';
import psychology from './psychology.md?raw';
import vector from './vector.md?raw';
import video from './video.md?raw';
import brand from './brand.md?raw';

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
const B = sections(brand);
const pick = (src: Map<number, string>, ns: number[]) => ns.map((n) => src.get(n)).filter(Boolean).join('\n\n');

// Design follows the job, not one house look: an essay isn't an ad, and an ad is allowed to be one.
const PURPOSE = `## Design for the purpose
Decide first what the piece is for, then let that set the tone. The topics are a library to learn from, not a style to copy everywhere.
- School work (essays, reports, lab write-ups, study guides, title pages): clean, academic, readable. Follow the format the class asks for (APA/MLA, margins, fonts) before anything else; restrained colour, clear headings, no decoration that competes with the content.
- Work and information (handouts, proposals, data, slides that teach): calm and competent. Grid, one accent, real charts and diagrams, generous space; one idea per slide.
- Events and causes (fliers, posters, invitations): warm and inviting; one strong visual idea, the key facts findable in three seconds, real character in the artwork.
- Kids, community, celebrations: playful but still organised: friendlier shapes and colour, still a grid and one focal point.
- Ads, social posts, thumbnails, promo video: here hooks, attention and conversion matter most. Read the brand and video topics, which collect what is well received.
Whatever the purpose: original and specific to this subject, never a generic template look.`;

const WHEN_GUIDES_DIFFER = `## When advice differs between topics
The user's own guidelines win. Otherwise follow the art direction you chose (styles topic) for its signature devices, and default to restraint: one focal point, one accent, specific content over decoration. Effects listed as clichés in the video topic (glowing orbs, lens flares, glass panels, sparkles) are only for a direction that genuinely calls for them.`;

// The quality bar when the request says little ("make a flier for the bake sale").
const VAGUE = `## When the request is short or vague
Don't ask for details you can infer, and never fall back to a plain or placeholder layout. Infer the audience, purpose and setting from the words and the open file, choose the art direction that fits best (styles topic), and deliver a finished, polished piece: real hierarchy, a deliberate palette, rich artwork (vector topics), every detail considered. Write any missing copy yourself, short and specific (a strong headline, the key facts, a clear next step), and mark only facts you can't know, like a date or room, as [placeholders] the user can fill in. Then say in one line what direction you chose, so they can steer.`;

export const DESIGN_TOPICS: Record<string, { about: string; text: () => string | Promise<string> }> = {
  start: { about: 'the user’s own guidelines (if any), the working method, defaults for vague requests, the fonts installed here, and the self-critique checklists (read first, every design)', text: async () => [await myGuidelines(false), PURPOSE, VAGUE, WHEN_GUIDES_DIFFER, pick(C, [0]), installedFonts(), pick(C, [7])].filter(Boolean).join('\n\n') },
  mine: { about: 'the user’s own design guidelines and house style in full (they override the rest)', text: async () => (await myGuidelines(true)) || 'The user hasn’t set any guidelines of their own (Settings → Claude Assistant → Design). Use Kea’s guide.' },
  video: { about: 'video quality: hooks and pacing, b-roll choice, motion graphics and kinetic type, captions, grade, transitions, explaining visually, platform specs and safe zones, making generated visuals look designed', text: () => video },
  brand: { about: 'ideas from well-received promotional design: logos and visual identity, thumbnails and covers, keeping a set of slides/posts consistent (design tokens), social media sizes, a default direction for promotional work', text: () => pick(B, [1, 2, 3, 4, 5]) },
  layout: { about: 'grids, margins, spacing scale, alignment, focal point, scanning patterns, Gestalt spacing', text: () => [pick(C, [1]), pick(P, [2, 3])].join('\n\n') },
  typography: { about: 'type scales, sizes per format, font pairings, tracking, leading, line length, pro details', text: () => pick(C, [2]) },
  colour: { about: 'palettes, contrast, harmonies, palette from a reference image, gradients, mood, colour psychology', text: () => [pick(C, [3]), pick(P, [7])].join('\n\n') },
  styles: { about: '19 art directions (Swiss, editorial, gradient, brutalism, luxury, retro, riso, Bauhaus, duotone, collage, neon…) with recipes, plus pro detailing', text: () => pick(C, [4, 5]) },
  formats: { about: 'templates with coordinates for fliers, A4, posters, slides, social, title pages, handouts, infographics; legibility at distance; what event fliers must say; slides that teach', text: () => [pick(C, [6]), pick(P, [5, 6, 8, 10])].join('\n\n') },
  psychology: { about: 'what people notice first, contrast and isolation, cognitive load, trust and memorability, and an attention audit to run on a render', text: () => pick(P, [1, 4, 5, 9, 11]) },
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

// ---------- The user's own guidelines (Settings → Claude Assistant → Design): they come first and win ----------
const MINE_LIMIT = 150_000;
/** The user's guideline files (Markdown / text in their chosen folder, one level of subfolders), joined. */
async function myGuidelineFiles(): Promise<{ name: string; text: string }[]> {
  const dir = String(setting('design.guidelinesFolder') || '').trim();
  if (!dir) return [];
  const out: { name: string; text: string }[] = [];
  const walk = async (d: string, depth: number) => {
    const entries = await api.listDir(d).catch(() => []);
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.dir && depth < 1) await walk(e.path, depth + 1);
      else if (!e.dir && /\.(md|markdown|txt)$/i.test(e.name) && e.size < 2_000_000) {
        const f = await api.readFile(e.path).catch(() => null);
        if (f) out.push({ name: e.path.slice(dir.length + 1) || e.name, text: new TextDecoder().decode(f.data) });
      }
    }
  };
  await walk(dir, 0);
  return out;
}
async function myGuidelines(full: boolean): Promise<string> {
  const style = String(setting('design.style') || '').trim();
  const files = await myGuidelineFiles();
  if (!style && !files.length) return '';
  const lines = ['## The user’s own design guidelines (these override everything else in this guide)'];
  if (style) lines.push(`House style: ${style}`);
  if (files.length) {
    const total = files.reduce((n, f) => n + f.text.length, 0);
    if (full || total < 20_000) {
      let used = 0;
      for (const f of files) {
        const room = MINE_LIMIT - used;
        if (room <= 0) {
          lines.push(`[${files.length - files.indexOf(f)} more file(s) not shown: the guidelines are longer than ${MINE_LIMIT / 1000}k characters.]`);
          break;
        }
        lines.push(`### ${f.name}
${f.text.length > room ? `${f.text.slice(0, room)}
[cut off]` : f.text}`);
        used += Math.min(room, f.text.length);
      }
    } else lines.push(`Guideline files (${files.length}, ${Math.round(total / 1000)}k characters): ${files.map((f) => f.name).join(', ')}. Read them with design_guide topic "mine" before designing.`);
  }
  return lines.join('\n\n');
}

export const designGuideTool: AssistantTool = {
  name: 'design_guide',
  description: `Professional design knowledge to apply whenever you design or restyle anything visual (flier, poster, slide, title page, handout, social post, infographic, layout of a page). Read "start" first, then the topics the job needs. Topics: ${Object.entries(DESIGN_TOPICS)
    .map(([k, v]) => `${k} (${v.about})`)
    .join('; ')}.`,
  input_schema: { type: 'object', properties: { topic: { type: 'string', enum: Object.keys(DESIGN_TOPICS) } }, required: ['topic'] },
  run: async ({ topic }) => {
    const t = DESIGN_TOPICS[topic];
    if (!t) throw new Error(`Topics: ${Object.keys(DESIGN_TOPICS).join(', ')}.`);
    return t.text();
  }
};
