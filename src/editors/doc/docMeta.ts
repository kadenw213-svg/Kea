/**
 * Document-level settings that live outside the text itself: page size and margins, headers and
 * footers, default formatting, citation sources, comments and the word-count goal. They're saved
 * inside .docx files (page setup, headers/footers and styles natively; the rest as a custom property)
 * so a round trip through Word keeps them.
 */

export interface HeaderFooter {
  left: string;
  center: string;
  right: string;
}

export interface Source {
  id: string;
  type: 'book' | 'website' | 'journal' | 'article' | 'video' | 'chapter' | 'report' | 'other';
  authors: { first: string; last: string }[];
  /** Organisation as author (used when there are no people). */
  org?: string;
  title: string;
  container?: string; // journal, website name, book title for chapters
  publisher?: string;
  year?: string;
  month?: string;
  day?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  url?: string;
  doi?: string;
  accessed?: string; // YYYY-MM-DD
  edition?: string;
  city?: string;
}

export interface CommentReply {
  id: string;
  author: string;
  text: string;
  at: number;
}
export interface CommentThread {
  id: string;
  author: string;
  text: string;
  at: number;
  resolved?: boolean;
  replies: CommentReply[];
}

export interface DocMeta {
  page: {
    size: 'letter' | 'a4' | 'legal' | 'a5' | 'custom';
    width: number; // inches (portrait)
    height: number;
    landscape: boolean;
    margins: { top: number; right: number; bottom: number; left: number }; // inches
    headerDistance: number; // inches from top edge
    footerDistance: number;
  };
  header: HeaderFooter;
  footer: HeaderFooter;
  firstHeader?: HeaderFooter | null; // different first page
  firstFooter?: HeaderFooter | null;
  pageNumberStart: number;
  defaults: {
    font: string;
    sizePt: number;
    lineHeight: number; // Word line multiple (1 = single, 2 = double)
    spaceAfterPt: number;
    firstLineIn: number; // first-line indent for body paragraphs
  };
  citationStyle: 'apa' | 'mla' | 'chicago';
  sources: Source[];
  comments: CommentThread[];
  wordGoal?: number | null;
  pageless?: boolean;
}

export const PAGE_SIZES: Record<string, { label: string; w: number; h: number }> = {
  letter: { label: 'Letter (8.5 × 11 in)', w: 8.5, h: 11 },
  a4: { label: 'A4 (8.27 × 11.69 in)', w: 8.27, h: 11.69 },
  legal: { label: 'Legal (8.5 × 14 in)', w: 8.5, h: 14 },
  a5: { label: 'A5 (5.83 × 8.27 in)', w: 5.83, h: 8.27 }
};

export const emptyHF = (): HeaderFooter => ({ left: '', center: '', right: '' });

export function defaultMeta(overrides: Partial<DocMeta> = {}): DocMeta {
  return {
    page: { size: 'letter', width: 8.5, height: 11, landscape: false, margins: { top: 1, right: 1, bottom: 1, left: 1 }, headerDistance: 0.5, footerDistance: 0.5 },
    header: emptyHF(),
    footer: emptyHF(),
    firstHeader: null,
    firstFooter: null,
    pageNumberStart: 1,
    defaults: { font: 'Arial', sizePt: 11, lineHeight: 1.15, spaceAfterPt: 6, firstLineIn: 0 },
    citationStyle: 'apa',
    sources: [],
    comments: [],
    wordGoal: null,
    pageless: false,
    ...overrides
  };
}

/** CSS line-height for a Word line multiple (Word's "single" is about 1.15× the font size). */
export const cssLineHeight = (multiple: number) => Math.round(multiple * 1.15 * 1000) / 1000;

/** Page geometry in CSS pixels (96 per inch), with orientation applied. */
export function pageBox(m: DocMeta) {
  const w = (m.page.landscape ? m.page.height : m.page.width) * 96;
  const h = (m.page.landscape ? m.page.width : m.page.height) * 96;
  const mg = m.page.margins;
  return {
    w,
    h,
    mt: mg.top * 96,
    mb: mg.bottom * 96,
    ml: mg.left * 96,
    mr: mg.right * 96,
    hd: m.page.headerDistance * 96,
    fd: m.page.footerDistance * 96,
    contentW: w - (mg.left + mg.right) * 96,
    contentH: h - (mg.top + mg.bottom) * 96
  };
}

/** Header/footer for a page, or null if it's empty. */
export function hfFor(m: DocMeta, which: 'header' | 'footer', pageIndex: number): HeaderFooter | null {
  const first = which === 'header' ? m.firstHeader : m.firstFooter;
  const hf = pageIndex === 0 && first ? first : m[which];
  return hf.left || hf.center || hf.right ? hf : null;
}

/** Replace {PAGE}, {PAGES}, {TITLE}, {DATE} and {AUTHOR}-style fields with their values. */
export function expandFields(text: string, ctx: { page: number; pages: number; title: string; author?: string }) {
  return text
    .replace(/\{PAGE\}/gi, String(ctx.page))
    .replace(/\{PAGES\}/gi, String(ctx.pages))
    .replace(/\{TITLE\}/gi, ctx.title)
    .replace(/\{AUTHOR\}/gi, ctx.author || '')
    .replace(/\{DATE\}/gi, new Date().toLocaleDateString());
}

/** Kea-only data that Word doesn't have a place for, stored as a custom document property. */
export function metaExtras(m: DocMeta) {
  return {
    v: 1,
    citationStyle: m.citationStyle,
    sources: m.sources,
    comments: m.comments,
    wordGoal: m.wordGoal ?? null,
    pageless: !!m.pageless,
    defaults: m.defaults,
    header: m.header,
    footer: m.footer,
    firstHeader: m.firstHeader ?? null,
    firstFooter: m.firstFooter ?? null,
    pageNumberStart: m.pageNumberStart
  };
}
