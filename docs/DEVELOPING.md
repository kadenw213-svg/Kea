# Developing Kea

## Run and build

| What | Command |
|---|---|
| Install dependencies (first time) | `npm install` |
| Develop with hot reload | `npm run dev` |
| Run from source (production build) | `npm start` |
| Type-check | `npm run typecheck` |
| Build the Windows installer | `npm run dist` → `release/Kea Setup <version>.exe` |
| Build the Android app | `node scripts/mobile-apk.cjs` → `Kea.apk` |
| Build **and publish** an update (PC and phone) | `npm run release` |
| Scholar engine tests | `cd scholar/engine` then `.venv/Scripts/python -m pytest -q` |
| Phone study code on real data | `node mobile/test/run.cjs <kea-data.json> <study folder>` |
| Canvas reader, end to end (no Canvas school needed) | `node test/canvas/run.cjs` |
| Phone screens at phone size, for checking layouts | `cd mobile && npx vite build`, then `npx electron mobile/test/shots.cjs <out> <kea-data.json> <unpacked library>` |

## Shipping an update

1. Bump `"version"` in `package.json`.
2. Commit.
3. Run `npm run release`. It uses your `gh` login to publish the installer and the Android app to GitHub Releases.
   Installed copies find the update through **Check for updates**.

## Project layout

```
electron/            main process: window, files, printing, local AI (llama.cpp), speech models, updates
electron/scholar/    Scholar: class-site browser (D2L, and Canvas through canvas.cjs), daily checks, Claude Code runs, calendar and study data, sync
                     to the phone and other computers (cloud.cjs, devices.cjs), study sets (study.cjs)
scholar/engine/      the academic_sync engine (Python): class database, calendar extraction, textbooks
scholar/skills/      the Claude Code skills Scholar runs (class scans, weekly updates, study material)
src/App.tsx          tabs, split view, global shortcuts, drag & drop
src/components/      Home, settings, Scholar screens, Encyclopedia panel, command palette, voice typing
src/editors/pdf      PDF viewer/editor (pdf.js render, pdf-lib save, OCR, passwords)
src/editors/doc      document editor (TipTap) + docx import/export, comments, citations
src/editors/sheet    spreadsheet grid, formula engine, charts, xlsx/csv io
src/editors/slides   presentation editor + pptx import/export, presenting
src/editors/code     text/code editor (CodeMirror)
src/editors/image    image viewer
src/lib/legacy.ts    names Kea's files used before 0.45, still recognized when reading them
mobile/              the Android app (Capacitor): it runs Scholar's study screens and study.cjs from this repo
scripts/             release, licences, bundled assets, icon (build/logo.svg → build/icon.png), Android build
```
