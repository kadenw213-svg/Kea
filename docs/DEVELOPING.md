# Developing Slate Office

## Run and build

| What | Command |
|---|---|
| Install dependencies (first time) | `npm install` |
| Develop with hot reload | `npm run dev` |
| Run from source (production build) | `npm start` |
| Type-check | `npm run typecheck` |
| Build the Windows installer | `npm run dist` → `release/Slate Office Setup <version>.exe` |
| Build **and publish** an update | `npm run release` |

## Shipping an update

1. Bump `"version"` in `package.json`.
2. Commit and push.
3. Run `npm run release`. It uses your `gh` login to publish to GitHub Releases. Installed copies find the update
   through **S logo → Check for updates**.

## Project layout

```
electron/            main process: window, files, printing, AI engine (llama.cpp), speech models, updates
src/App.tsx          tabs, split view, global shortcuts, drag & drop
src/components/      Home, settings, AI sidebar, command palette, voice typing
src/editors/pdf      PDF viewer/editor (pdf.js render, pdf-lib save, OCR, passwords)
src/editors/doc      document editor (TipTap) + docx import/export, comments, citations
src/editors/sheet    spreadsheet grid, formula engine, charts, xlsx/csv io
src/editors/slides   presentation editor + pptx import/export, presenting
src/editors/code     text/code editor (CodeMirror)
src/editors/image    image viewer
src/lib/ai.ts        AI prompts, depth, Wikipedia references, long-file handling
scripts/             release, licences, bundled assets, icon (build/logo.svg → build/icon.png)
```
