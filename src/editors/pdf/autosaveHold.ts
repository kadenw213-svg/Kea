/**
 * When a PDF must wait for an explicit Save instead of being autosaved.
 * Autosave only writes changes that can't lose anything the user didn't ask to lose:
 *  - redactions turn the page into a picture and delete what is under the boxes, for good;
 *  - moving, adding or removing pages rebuilds the file, which drops its bookmarks and fillable fields.
 * Kept free of imports so it can be tested on its own.
 */
export interface HoldInput {
  annots: { type: string }[];
  pages: { src: number; index: number }[];
  /** Pages in the original file (null while it is still loading). */
  originalPageCount: number | null;
  hasForm: boolean;
  hasOutline: boolean;
}

export const REDACT_HOLD = 'Redactions are applied when you press Save.';
export const REBUILD_HOLD = "Page changes are saved when you press Save (they drop this PDF's bookmarks and form fields).";

export function hasRedactions(annots: { type: string }[]) {
  return annots.some((a) => a.type === 'redact');
}

/** True when the saved file keeps the original's pages in their original order (so it is edited in place). */
export function keepsOriginalPages(pages: { src: number; index: number }[], originalPageCount: number | null) {
  return originalPageCount != null && pages.length === originalPageCount && pages.every((p, i) => p.src === 0 && p.index === i);
}

/** Why this PDF must not be autosaved right now, or null when autosave is safe. */
export function pdfAutosaveHold(o: HoldInput): string | null {
  if (hasRedactions(o.annots)) return REDACT_HOLD;
  if (!keepsOriginalPages(o.pages, o.originalPageCount) && (o.hasForm || o.hasOutline)) return REBUILD_HOLD;
  return null;
}
