import type { PDFDocumentProxy } from '../editors/pdf/pdfjs';

/** A heading in a PDF's outline (bookmarks): a textbook's chapters and sections. */
export interface OutlineEntry {
  title: string;
  /** 0-based page in the PDF, or -1 when the bookmark doesn't point at a page. */
  page: number;
  depth: number;
}

/** The PDF's outline, flattened to three levels (chapter, section, subsection). */
export async function readOutline(pdf: PDFDocumentProxy): Promise<OutlineEntry[]> {
  const raw = await pdf.getOutline().catch(() => null);
  if (!raw?.length) return [];
  const out: OutlineEntry[] = [];
  const walk = async (items: any[], depth: number) => {
    for (const it of items) {
      let dest = it.dest;
      if (typeof dest === 'string') dest = await pdf.getDestination(dest).catch(() => null);
      let page = -1;
      if (Array.isArray(dest) && dest[0] != null) {
        try {
          page = typeof dest[0] === 'number' ? dest[0] : await pdf.getPageIndex(dest[0]);
        } catch {}
      }
      out.push({ title: String(it.title || '').trim(), page, depth });
      if (it.items?.length && depth < 2) await walk(it.items, depth + 1);
    }
  };
  await walk(raw, 0);
  return out.filter((e) => e.title);
}

/**
 * Where to open a PDF that Scholar asked for ("Chapter 33"): the editor jumps there once the file has loaded.
 * Keyed by file path.
 */
const targets = new Map<string, string>();
export const setPdfTarget = (path: string, chapter: string) => targets.set(path.toLowerCase(), chapter);
export function takePdfTarget(path: string | null) {
  if (!path) return null;
  const k = path.toLowerCase();
  const t = targets.get(k) || null;
  targets.delete(k);
  return t;
}

/** The outline entry for a chapter label: "Chapter 33" matches "Chapter 33 — Invertebrates" (or "33 Invertebrates"). */
export function findChapter(outline: OutlineEntry[], chapter: string) {
  const n = chapter.match(/\d+[A-Za-z]?/)?.[0];
  if (!n) return null;
  const re = new RegExp(`^(?:(?:chapter|ch\\.?|module|unit)\\s*)?${n}(?![\\d])`, 'i');
  return outline.find((e) => e.page >= 0 && e.depth === 0 && re.test(e.title)) || outline.find((e) => e.page >= 0 && re.test(e.title)) || null;
}
