// Pictures in a Teach lesson. The tutor can ask for up to two figures with a fenced "figure" block holding JSON:
//   {"search": "heart anterior view labeled diagram", "caption": "The four chambers", "parts": ["right atrium", "left ventricle"]}
// Kea looks the picture up (electron/figures.cjs: a real, openly licensed image with its credit) and shows it where the
// block was. A lesson with no figure block, or one nothing was found for, shows no picture.

export interface FigureRequest {
  search: string;
  caption: string;
  /** The parts the picture should show, in the order the lesson names them (listed under the picture as a legend). */
  parts: string[];
}

/** The figure requests in a lesson's text (at most two), skipping anything that isn't valid. */
export function figuresOf(text: string): FigureRequest[] {
  const out: FigureRequest[] = [];
  for (const m of String(text).matchAll(/```figure\s*([\s\S]*?)```/g)) {
    try {
      const j = JSON.parse(m[1]);
      const search = typeof j.search === 'string' ? j.search.trim().slice(0, 160) : '';
      if (search.length < 3) continue;
      out.push({
        search,
        caption: typeof j.caption === 'string' ? j.caption.trim().slice(0, 200) : '',
        parts: Array.isArray(j.parts) ? j.parts.filter((p: unknown) => typeof p === 'string' && p.trim()).map((p: string) => p.trim().slice(0, 80)).slice(0, 12) : []
      });
    } catch {}
    if (out.length === 2) break;
  }
  return out;
}

/** The lesson without its check and figure blocks (also while it is still being written). */
export const withoutBlocks = (text: string) => text.replace(/```check[\s\S]*?(```|$)/, '').replace(/```figure[\s\S]*?(```|$)/g, '').trim();
