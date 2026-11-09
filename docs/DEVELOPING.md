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
| Compatibility with KeaS and KeaC, current and previous releases (needs `../KeaS` and `../KeaC`) | `npm run test:compat` |
| Phone screens at phone size, for checking layouts | `cd mobile && npx vite build`, then `npx electron mobile/test/shots.cjs <out> <kea-data.json> <unpacked library>` |

## Shipping an update

1. Bump `"version"` in `package.json`.
2. Commit.
3. Run `npm run release`. It uses your `gh` login to publish the installer and the Android app to GitHub Releases.
   Installed copies find the update through **Check for updates**.

## Releasing one app on its own

Kea (PC and phone), KeaS and KeaC are released separately, and each release must keep working with the other apps'
versions still in use (`docs/protocol.md` section 0 in KeaS and KeaC is the contract).

- **Add, don't change.** A new field, route or `features` entry is fine at any time: older apps ignore it. Read new
  fields as optional, because the other side may be a release older.
- **Never drop support for the previous release in the same version.** A route or field an older app uses stays until
  a later release, after the apps that use it have updated (check the version the servers see in their logs).
- **Raise `minClients` only when a break is unavoidable**, and only to a version that's already released and has had
  time to update itself (the defaults are in `clients.mjs`: KeaC `server/lib/`, KeaS `hub/lib/`; keep the two files
  the same). Apps below it get a plain 426 telling them to update, never a half-working answer. The owner can also
  change it under Advanced without a release.
- **Raise `protocol` only for a break no older app can follow** (it's one integer for the whole contract). Ship the
  apps that understand the new protocol first, then the server that needs it.
- **Run the compatibility matrix before releasing:** `npm run test:compat` (also part of the normal test run). It
  runs the current app against the current and previous servers, and the previous app against the current server
  (the previous releases are read with `git show` from the sibling repos: Kea 0.84.0, KeaS 0.8.0, KeaC 0.3.0 and
  0.2.0). When you release, move the pinned "previous" commits in `test/compat/harness.mjs` forward in all three
  repos.
- **Kea itself never goes stale quietly** (`electron/updateHealth.cjs`, shown by `src/lib/updateState.ts`
  `staleness`): update checks failing 3 times in a row for 2 days, or an update found or downloaded and not installed
  after 3 days, show in the title-bar pill and Settings → About with the last check time. A server's `latest.kea`
  shows "Update available" even when GitHub can't be reached, and a 426 shows "Update Kea to keep using your Kea
  account" with an Update button (title bar, the account page). The record is `update-health.json` in Kea's profile
  folder. The phone does the same in `mobile/src/update.ts` (`behind`), also comparing with the PC's version in
  `kea-data.json` (`keaVersion`).
- Kea sends `X-Kea-Client: Kea/<version>` to every server, and the phone `Kea-Phone/<version>` (Hub.java).

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

## Built-in sign-in clients (Google, Microsoft)

"Sign in with Google / Microsoft" and Google Drive (Docs, Sheets, Slides) use Kea's own OAuth clients. Their ids are
never in this repo. The build reads them from a file on the owner's PC, outside the repo:

`%LOCALAPPDATA%\KeaBuild\oauth-clients.json` (or the path in `KEA_OAUTH_CLIENTS`)

```json
{ "google": { "desktopClientId": "…", "desktopClientSecret": "…", "androidClientId": "…" }, "microsoft": { "clientId": "…" } }
```

- `npm run build`, `npm start`, `npm run dist` and `npm run release` run `scripts/oauth-clients.cjs` first. It writes
  `electron/buildConfig.json` (git-ignored, packaged with the app) with the desktop Google client and Microsoft's.
- The phone app's build (`mobile/vite.config.mjs`, so also `scripts/mobile-apk.cjs`) gets `VITE_KEA_GOOGLE_CLIENT_ID`
  (the Android client) and `VITE_KEA_MICROSOFT_CLIENT_ID` from the same file. Ones already in the environment win.
- At run time Kea on the computer uses, first found: `hub.googleClientId` / `hub.googleClientSecret` /
  `hub.microsoftClientId` in settings.json, then `KEA_GOOGLE_CLIENT_ID` / `KEA_GOOGLE_CLIENT_SECRET` /
  `KEA_MICROSOFT_CLIENT_ID`, then `electron/buildConfig.json`.
- Without the file the build still works and prints a warning: that build has no sign-in (Kea says so plainly) and
  Google files open in the browser.
- A Google "Desktop app" client secret isn't confidential for installed apps (Google says so), but it still never goes
  in this public repo.
- Until Google reviews Kea for the Drive scope, only the test users listed on the OAuth consent screen can connect
  Drive; everyone else is told plainly and offered "Open in browser instead".
