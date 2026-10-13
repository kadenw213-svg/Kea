# Slate Office

A clean, dark, fully offline office suite for Windows (and macOS). One tabbed window for PDFs,
documents, spreadsheets, presentations, text/code files and images. Nothing is uploaded anywhere.

## Install / run

| What | Command |
|---|---|
| Build the Windows installer | `npm run dist` → `release/Slate Office Setup <version>.exe` |
| Build **and publish** an update | `npm run release` |
| Run from source (production build) | `npm start` |
| Develop with hot reload | `npm run dev` |
| Type-check | `npm run typecheck` |

First time only: `npm install`.

## Updates

Installed copies update themselves: click the **S** logo (top-left) → **Check for updates** →
**Download** → **Restart and update**. A blue dot on the logo means a new version is waiting.

To ship a new version:

1. Bump `"version"` in `package.json` (e.g. `0.1.0` → `0.2.0`).
2. Run `npm run release` (uses your `gh` login to publish to
   [GitHub Releases](https://github.com/kadenw213-svg/slate-office/releases)).

## What it does

**PDF editor**
- Fast viewer with thumbnails, zoom (Ctrl+wheel), search (Ctrl+F) and selectable text
- **Edit existing text**: click any line, retype it (matches font size, colour and background)
- Add text, highlight / underline / strikethrough (select text or drag), freehand draw,
  rectangles, ellipses, lines, arrows, whiteout/redaction boxes, sticky-note comments, images
- Signatures: draw, type or upload; remembered for next time
- Pages: rotate, delete, duplicate, reorder by dragging, insert blank pages, insert PDFs or images,
  extract pages to a new PDF
- Fill PDF forms, combine PDFs, turn images into a PDF, print
- "Dark pages" reading mode (view only)

**Presentations (.pptx)**
- Opens PowerPoint files with their layouts, theme colours, backgrounds, placeholders, shapes,
  pictures, bullets and speaker notes; saves back to .pptx
- New decks with themes (Slate, Paper, Midnight, Ember, Mint) and layouts
- Text boxes, shapes, lines, arrows, images; drag, resize, snap-to-centre guides, reorder slides
- Full-screen presenting (F5), export to PDF, print

**Documents (.docx, .doc, .odt, .rtf, .html)**
- Word-style editor on a page: headings, fonts, sizes, colours, highlight, lists, checklists,
  tables (merge/split, add/remove rows & columns), images, links, page breaks, find & replace
- Opens and saves real Word files with formatting kept (own .docx reader/writer)
- Consistent spacing: **Enter** = one new paragraph with a fixed small gap, **Shift+Enter** = line
  break, **Ctrl+Enter** = page break. Blank lines are one line tall. Pasting from Word / Google
  Docs / the web is cleaned up so stacks of empty lines collapse.
- Export to PDF, HTML or plain text; print; dark or light page

**Spreadsheets (.xlsx, .xls, .ods, .csv, .tsv)**
- 80+ functions (SUM, IF, VLOOKUP, XLOOKUP, INDEX/MATCH, SUMIFS, TEXT, dates, …), cross-sheet refs
- Formula autocomplete, click-to-reference while typing a formula, coloured reference outlines
- Fill handle (copies formulas, extends number series), copy/paste with Excel & Google Sheets,
  insert/delete rows & columns (formulas update), sort, freeze panes, merge cells, number formats,
  fonts, colours, column resize / auto-fit, multiple sheets, find & replace
- Saves .xlsx with formatting, plus CSV/TSV/ODS

**Text & code** – syntax highlighting, find/replace, word wrap; keeps CRLF/LF and BOM as found.

**Images** – zoom, rotate, flip, convert between PNG/JPG/WebP, copy, print, turn into a PDF.

## Keyboard

| Shortcut | Action |
|---|---|
| Ctrl+O / Ctrl+N | Open / new document |
| Ctrl+S / Ctrl+Shift+S | Save / save as |
| Ctrl+W, Ctrl+Tab | Close tab, next tab |
| Ctrl+P | Print |
| Ctrl+F | Find |
| PDF tools | V select · E edit text · T add text · H highlight · D draw · R rectangle · W whiteout · N comment · I image · S sign |

## Known limits

- PDF edits are written into the page content when you save; they stay editable until you close the file.
- Encrypted PDFs open for viewing but can't be saved yet.
- Old `.doc` files open with all their text but simplified formatting; `.odt`/`.rtf`/`.doc` save as `.docx`.
- Old binary `.ppt` and OpenDocument presentations (`.odp`) need converting to `.pptx` first.
- PowerPoint charts, SmartArt and animations aren't shown yet; tables appear as text.
- Spreadsheet charts, conditional formatting and cell borders aren't supported yet.

## Project layout

```
electron/        main process (window, file access, printing) + preload bridge
src/App.tsx      tabs, shortcuts, drag & drop
src/editors/pdf  PDF viewer/editor (pdf.js render, pdf-lib save)
src/editors/doc  document editor (TipTap) + docx import/export
src/editors/sheet spreadsheet grid, formula engine, xlsx/csv io
src/editors/slides presentation editor + pptx import/export
src/editors/code text/code editor (CodeMirror)
src/editors/image image viewer
```
