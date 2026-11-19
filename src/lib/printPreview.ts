import { create } from 'zustand';

/** What a print request carries: the page to print, how it is laid out, and the name to save a PDF under. */
export interface PrintRequest {
  id: number;
  html: string;
  opts?: { noMargins?: boolean; pageSize?: string };
  /** File name for "Save as PDF" (no extension). */
  name: string;
  resolve(printed: boolean): void;
}

export const usePrintPreview = create<{ req: PrintRequest | null }>(() => ({ req: null }));

let next = 1;

/**
 * Opens Kea's print preview: the pages exactly as they will print, with Print and Save as PDF.
 * Resolves true once the page was sent to the printer, false if the person closed the preview.
 * Every editor prints through this, so there is one preview and one place where printing is set up.
 */
export function showPrint(html: string, opts?: PrintRequest['opts'], name = 'Document'): Promise<boolean> {
  return new Promise((resolve) => {
    // A second request replaces the first (the first one counts as closed).
    usePrintPreview.getState().req?.resolve(false);
    usePrintPreview.setState({ req: { id: next++, html, opts, name, resolve } });
  });
}
