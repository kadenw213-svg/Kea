---
name: academic-sync
description: Recurring maintenance for a course /academic-import already scanned: light re-scan (extending weekly banners) and link refresh, recorded to Kea Calendar.
user-invocable: true
---

# /academic-sync -- recurring course maintenance

> **In Kea:** read `CLAUDE.md` → "Running inside Kea" first. It replaces Chrome with Kea's `mcp__kea__d2l_*` tools,
> Google Calendar with `record-sync ... --calendar-id kea`, and email with `mcp__kea__kea_notify`, and runs are
> unattended (no questions, no approval gates). Everything else below applies as written.

Arguments passed: `$ARGUMENTS` (may be empty, a term, a course code, or a
subcommand hint).

This skill is the standing weekly job for every course `/academic-import`
has already fully scanned at least once. It never handles a brand-new
course's first-time crawl -- see Step 0. Read `CLAUDE.md` before your first
run in a session if you haven't already; its invariants apply here exactly
as they do in `/academic-import`.

**Working directory**: `uv run academic-sync ...` from the repo root, same
as `/academic-import`.

**Live tools this skill uses directly**: Chrome browser control
(`claude-in-chrome`) for D2L/ALEKS navigation, `mcp__claude_ai_Google_
Calendar__*` for Calendar reads/writes.

## Step 0: orient

1. `uv run academic-sync courses` / `status` -- same as `/academic-import`
   Step 0.
2. For each course in scope, confirm it's actually eligible for this skill:
   `completeness --course <id>` should show synced items and an
   `Inspected:` list covering the mandatory areas. If a course has **no**
   prior sync history, this skill is the wrong one -- tell the user and
   point them at `/academic-import` instead. Don't attempt a light crawl on
   a course that's never had a real first-time scan.

## Step 1: light-crawl re-scan

Follow `docs/d2l_discovery.md#recurring-runs----light-crawl` exactly: always
re-open Announcements (in full) and the course Calendar for every course in
scope, extend Content/Modules only as far as the next not-yet-built
`WEEKLY_READING` week (`weekly-reading-add` + `chapter-topic-add` for it),
and resolve any gap a fresh Announcements/Calendar read surfaces using the
same "go look, don't just report" default as CLAUDE.md invariants 32/34.
Then run the same `render` -> `create_event`/`update_event` -> `record-sync`
flow `/academic-import` Step 5 uses for anything new or changed.

Each newly built week also gets the invariant 40 study depth:
- its chapters get Vocabulary + concepts (`chapter-topic-add`);
- its tests get `--covered-chapters`/`--study-focus`;
- its homework gets a verified `--video-url`.

After a chapter topic changes, re-render and push every banner and test
that covers it.

## Step 2: link refresh

Some items are correctly missing `reference_url`/`resource_url` not because
nobody looked, but because the assignment/quiz/dropbox folder was still
locked in D2L behind a release date at scan time (see `link_available_date`
capture, `docs/d2l_discovery.md#links`). This re-checks those items both
after their stated release date and a bit before it (in case D2L's stated
date was conservative) -- this is what keeps the calendar from quietly
going stale on every item that was locked at scan time.

1. `uv run academic-sync needs-link-refresh [--course <id>]` -- lists every
   item whose `link_available_date` falls within the last 14 days *or* the
   next 14 days (`--lookback-days`/`--lookahead-days` to widen either) but
   still has no real link. Prints "Nothing needs a link refresh right now"
   most weeks -- expected, not a failure.
2. For each listed item, navigate to the relevant D2L area and confirm
   whether it's unlocked yet. An "opens" (future) item still locked is not
   an error -- leave it, it's checked again next week. An unlocked item:
   find its real turn-in/content link (prefer the actual submission page).
3. Apply it: `uv run academic-sync render <item_id> --reference-url "..."
   [--reference-url-label "..."] --save` (or `--resource-url`). Saving a
   real URL is enough on its own -- the item stops showing up in
   `needs-link-refresh` once it has one.
4. Re-run `render <item_id>` (no `--save` needed) to get the updated
   payload, push it with `update_event` using the item's existing
   `SyncRecord.google_event_id`.
5. If still locked, leave it alone -- it resurfaces next run inside the
   lookback/lookahead window.

## Step 3: weekly grade diagnostic -- retired 2026-10-05

The weekly "<CODE> Previous Week Diagnostic" Calendar event is retired.
Its job now happens daily in `/daily-overview`: newly graded work with
verbatim feedback, missed deadlines with open/closed status, and the Red
triggers (zero, bombed major assessment, 2+ missing, steep drop) as "Needs
attention" lines. Don't create diagnostic events anymore.
`diagnostics.py`'s thresholds are reused by `digest.py`. Old
`diagnostic-*` commands stay for history only. See CLAUDE.md invariant 37
(amended).

## Step 4: Drive weakness signal -- retired 2026-10-07

The GPT quiz system this fed was abandoned (user-directed). Don't write to
the Drive workbook. `digest-ingest` still prints `signal_candidates`; ignore
them.

## Step 5: weekly reminder event -- retired 2026-10-05

`/daily-overview` runs every morning on Windows Task Scheduler and does
link refresh and grade checking itself, so the recurring Sunday reminder
event is no longer needed. If it still exists on the calendar, ask the
user before deleting it. Never create a new one.

## After running

Print a short summary: what changed per course (light-crawl finds, banners
built, links refreshed), and remind the user
they can check `unresolved`/`plan`/`completeness` any time. Don't re-print
full item lists unless asked.

## Rules that apply throughout (see CLAUDE.md for the authoritative list)

Same rules as `/academic-import` -- never fabricate a date/nesting/
location, never add guests/Meet links, idempotent writes only. If
you're about to hand-write grade-classification logic, date math, or a
fingerprint instead of calling into `src/academic_sync/`, stop -- that
belongs in the Python package.
