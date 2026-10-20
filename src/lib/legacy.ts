// What Kea wrote under its earlier name (before 0.45: the app was renamed at 0.19, its file markers at 0.45), still
// recognized when reading files and settings saved that way, so nothing made before then is lost. Nothing is written
// with these any more; every writer uses the Kea names next to them.
const OLD = 'Slate';
const old = OLD.toLowerCase();

export const LEGACY = {
  /** A Word document's Kea data part (namespace), and its file name. */
  docxDataNs: `urn:${old}-office:data`,
  docxDataPart: `${old}Data.xml`,
  /** Word styles Kea's citations, bibliography and contents used ("SlateCitation" → "KeaCitation"). */
  docxStyle: (kea: string) => kea.replace(/^Kea/, OLD),
  /** An equation's picture description. */
  mathPrefix: `${old}-math:`,
  /** Kea's settings inside a saved .html document. */
  docMeta: `${old}-doc`,
  /** A spreadsheet's hidden data sheet. */
  sheetData: `_${old}_data`,
  /** The AI assistant's name on comments. */
  aiAuthor: `${OLD} AI`,
  /** A browser-storage key on this computer ("slate.signatures"). */
  storageKey: (name: string) => `${old}.${name}`
};

/** Read a browser-storage value saved under Kea's name, or (once, moving it across) under the earlier one. */
export function storageGet(name: string): string | null {
  try {
    const now = localStorage.getItem(`kea.${name}`);
    if (now !== null) return now;
    const before = localStorage.getItem(LEGACY.storageKey(name));
    if (before !== null) {
      localStorage.setItem(`kea.${name}`, before);
      localStorage.removeItem(LEGACY.storageKey(name));
    }
    return before;
  } catch {
    return null;
  }
}
