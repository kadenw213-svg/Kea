---
name: academic-import
description: Discover a D2L/Brightspace course's obligations for the FIRST time and run them through the local extraction, completeness and reconciliation pipeline into Kea Calendar. Use for a brand-new course (Kea runs it unattended when a new class shell appears). For a course already scanned, use /academic-sync.
user-invocable: true
---

# /academic-import -- first-time D2L -> Kea Calendar scan

> **In Kea:** read `CLAUDE.md` → "Running inside Kea" first. It replaces Chrome with Kea's `mcp__kea__d2l_*` tools,
> Google Calendar with `record-sync ... --calendar-id kea`, and email with `mcp__kea__kea_notify`, and runs are
> unattended (no questions, no approval gates). Everything else below applies as written.

Arguments passed: `$ARGUMENTS` (may be empty, a term like "Fall 2026", a
course code, or a subcommand hint like "plan" / "sync" / "status").

This skill drives the SCAN -> EXTRACT -> NORMALIZE -> AUDIT -> PLAN -> SYNC
pipeline described in `docs/architecture.md` for a course's **first-ever**
scan. Read `CLAUDE.md` before your first run in a session if you haven't
already -- its invariants (never fabricate dates/nesting/locations/guests,
idempotency, completeness rules) apply to every step below, not just to the
Python code.

**Unattended mode (invoked by `/daily-overview` for a newly opened class
shell):** run every step below with no questions and no approval gate.
Sync CLEAR items directly, and send anything that would normally be asked
or approved to that class's email "Needs you" list instead. A shell that's
still mostly empty is fine; the daily run keeps filling it in.

**This skill is for first-time discovery only.** Recurring maintenance on a
course already scanned before -- light-crawl re-scans and link refresh --
lives in `/academic-sync` instead, and daily grade/announcement/feedback
news lives in `/daily-overview`. Step 0 below tells you
how to recognize which case you're in.

**Working directory**: this skill operates on the `academic-sync` project at
the repository root. All CLI commands below are `uv run academic-sync ...`
run from that directory via Bash.

**Live tools this skill uses directly** (not through the Python package,
which has no network client for either):
- Chrome browser control (`claude-in-chrome`) for D2L navigation/reading.
- `mcp__claude_ai_Google_Calendar__*` for the actual Calendar reads/writes.

## Step 0: orient

**Whose data is this?** This skill has no login/account concept of its own
-- "who you're running it for" is entirely a function of two things, and by
default both already point at the current user:

- **The local database** (`data/academic_sync.db` by default) holds
  courses, items, preferences (including `d2l_base_url`), and sync
  records. `academic-sync courses`/`status` below always read *this* file.
  It holds the owner's courses and their `d2l_base_url` preference; who
  the owner is and their institution/D2L home URL are recorded in
  `config/personal.local.md` (gitignored; template
  `config/personal.example.md`).
- **The Calendar connector's authenticated Google account** decides which
  calendar actually receives writes. `target_calendar_id` defaults to the
  string `"primary"` -- not a specific email -- so it already means
  "whichever Google account this chat's Calendar connector is signed in
  as," with zero config needed. If this chat is authenticated as the
  owner's Google account, syncing already goes to their calendar; if it's
  authenticated as someone else's, it already goes to theirs.

**To run this for the owner in a fresh chat**: do nothing special -- just
start at step 1 below. Their D2L url and calendar target are already the
defaults.

**To run this for a different person** (a friend, a different school entirely):
do **not** reuse the owner's database -- their courses, preferences, and sync
history must not mix in the same SQLite file. Before the first
`academic-sync` command of the session, set `ACADEMIC_SYNC_DB_PATH` (env
var, e.g. `ACADEMIC_SYNC_DB_PATH=data/academic_sync_<name>.db`, or add it to
a `.env` file -- see `.env.example`) to a path that doesn't exist yet; the
schema and migrations are created automatically on first use, giving that
person a completely separate, empty set of courses/preferences/sync
records. Two more things fall out of that automatically and need no further
setup: the Calendar connector's authenticated account (see above) already
targets *their* calendar as long as this chat session is signed into their
Google account, not the owner's; and if `D2L_BASE_URL` is set in their
environment (or `.env`) it pre-fills the `d2l_base_url` preference on first
read, so `academic-sync prefs get d2l_base_url` doesn't come back empty
before their first SCAN -- otherwise just ask them for their institution's
D2L/Brightspace base URL once and save it with
`academic-sync prefs set d2l_base_url <url>` (Step 1 does this automatically
if it's unset). Everything else in this skill (course registration, D2L
crawl, extraction, sync) behaves identically regardless of whose database
it's pointed at -- there is no other per-person code path.

1. `uv run academic-sync courses` -- see what's already registered. If this
   is unexpectedly empty (or shows the wrong person's courses) for what you
   expect this session to be, stop and check `ACADEMIC_SYNC_DB_PATH` before
   registering anything -- don't add a new person's courses into what turns
   out to be someone else's database.
2. `uv run academic-sync status` -- see current item/unresolved/synced
   counts per course.
3. If `$ARGUMENTS` names a specific course or term, scope subsequent steps
   to it. Otherwise ask the user which term to scan if it's genuinely
   ambiguous (more than one term has active-looking courses) -- don't guess
   which term "now" means.
4. **First-time scan vs. recurring run.** Check `uv run academic-sync status`
   and `completeness --course <id>` for each course in scope. If a course
   already has synced items and an `Inspected:` list covering the mandatory
   areas from a prior session, this is a **recurring run**, not a
   first-time scan -- stop here, tell the user this course was already
   scanned, and point them at `/academic-sync` instead (light-crawl
   re-scan and link refresh live there; daily grades and feedback live in
   `/daily-overview`). A course with no prior sync history gets the full first-time crawl
   below, every time -- that's the only case this skill still handles.

## Step 1: SCAN (D2L, live)

For each course to scan:

1. If no D2L session looks active, navigate to the D2L base URL (stored as
   the `d2l_base_url` preference -- `uv run academic-sync prefs get
   d2l_base_url`; ask the user for it once if unset, then save it with
   `uv run academic-sync prefs set d2l_base_url <url>`).
2. If redirected to an SSO login page, **stop and tell the user** to log in
   in the browser tab you opened. Wait for them. Never enter credentials
   yourself. See `docs/d2l_discovery.md` for this institution's specific
   login flow (Banner CAS -> Brightspace tenant).
3. Enumerate active courses for the target term. For each course not
   already registered, extract course_code/section/name/term/instructor/
   dates/D2L id/URL and register it:
   `uv run academic-sync course add --code ... --name ... --term ... [--section ...] [--instructor ...] [--start ...] [--end ...] [--d2l-id ...] [--d2l-url ...]`
   (capture the printed course id -- you'll need it for every subsequent
   command for this course).
4. **Before crawling anything else, run the orientation pass**
   (`docs/d2l_discovery.md#orientation-pass----do-this-first-for-every-course-before-the-deep-crawl`):
   determine and save this course's `delivery_format` preference, read its
   real course nav, and locate (not yet fully read) where all six
   `#required-finds` live: the textbook/materials access point; the
   module/week breakdown; the primary tool URLs (Quizzes/Discussions/any
   homework platform); **any instructor-authored chapter objectives/
   study-guide/lecture-slides material** (finding 4) -- drives real
   DETAILS content in Step 5, not just link capture; **each module's
   stated start/stop dates or the syllabus's week<->topic table**
   (finding 5) -- what a course's `WEEKLY_READING` weekly banners get
   built from (CLAUDE.md invariant 25, required for every week of the
   term, not just the current one); and **where each chapter/unit's real,
   complete topic/subtopic breakdown lives** (finding 6) -- what
   `chapter-topic-add` pulls from, so a weekly banner's READING (section
   headings + the chapter's own reading link) and TOPIC DETAIL can
   auto-show real depth instead of a bare chapter list (CLAUDE.md
   invariant 26, amended 2026-08-25 -- capture must be exhaustive, and
   never from a platform's personalized/adaptive "what's next" view; see
   `docs/d2l_discovery.md#required-finds` finding 6 for per-platform
   specifics, including where to find ALEKS's real stable structure
   instead of its Ready to Learn queue). This is what lets
   every item you extract in the steps below get real nesting/links/
   content as you go, instead of needing a second retrofit pass later --
   see CLAUDE.md invariants 17/18/22/25/26.
5. **Read `docs/d2l_discovery.md#mandatory-minimum-crawl` before crawling
   any course and follow it exactly.** A real gap happened from treating a
   syllabus-plus-one-other-area scan as "done" -- it is not. Concretely:
   - Open the course home page and read its actual nav menu first; don't
     pattern-match against a fixed list of link names (courses name areas
     differently).
   - **The course Calendar, Content/Modules, and every Announcement (each
     expanded in full, not just the list-view preview) must all be opened**
     for every course before its scan counts as finished, not just listed
     in a plan. Confirm via `academic-sync completeness --course <id>` --
     if `Never scanned:` still lists `d2l_calendar`, `d2l_content`, or
     `d2l_announcements`, you are not done. Announcements matters even when
     it looks like just a "Welcome" post -- see
     `docs/d2l_discovery.md#mandatory-minimum-crawl----do-not-skip-this`
     for the real incident (a whole category of CHE1011 lab assignments,
     plus a BIO1112 room exception, existed only in an announcement) that
     made this a hard requirement, not a nice-to-have.
   - Maintain `data/downloads/<COURSE_CODE>/raw_notes.md` as you go: a
     prose transcript of everything found (topic/unit outlines, per-
     assignment special instructions, policy notes), not just what
     `extract` can turn into a dated item. Feed relevant slices of this
     into `source_wording`/`details` at extraction/sync time so
     descriptions carry real content, not just a bare title.
   - Read HTML pages inline; download PDFs to
     `data/downloads/<COURSE_CODE>/<source_type>/` (e.g.
     `data/downloads/BIO1112/syllabus/`) -- one subfolder per course, one
     subfolder per source type within it. Create directories as needed.
   - If a downloaded PDF parses to 0 (or implausibly few) characters, it's
     almost certainly a scanned image -- don't accept "0 items" as the
     answer. Screenshot/view it and transcribe it visually into a sibling
     `.transcribed.txt` file, then extract from that instead.
   - Before calling a course's scan final, sanity-check per
     `docs/d2l_discovery.md#sanity-check-before-calling-a-courses-scan-final`:
     in-person/hybrid courses need a recurring lecture/lab meeting pattern
     somewhere in raw_notes; online/async courses need that course's
     week-by-week schedule equivalent found *and* reflected as
     `module_label` on the items from that period. Missing either is the
     same shape of gap as the BIO1112 lecture miss -- go back to
     Content/Modules and Calendar, don't stop.
6. **Be thorough about where you look, efficient about how much you open**
   -- see `docs/d2l_discovery.md#be-thorough-about-where-you-look-efficient-about-how-much-you-open`.
   Prefer one information-dense page (a full syllabus schedule table, a
   "Course Schedule(s)" page) over opening many individual per-item pages
   that just restate the same dates one at a time -- don't open N Content
   sub-topics when a schedule table elsewhere already gives date+topic for
   all N.
7. **If a page hangs**, don't stop and ask for help -- see
   `docs/d2l_discovery.md#getting-unstuck-without-stopping-to-ask-and-without-burning-tokens-on-it`
   (one reload retry, then straight to a fresh tab, then move on and note
   the gap if a non-critical page still won't cooperate after that -- two
   failed attempts total, not two per tool). This applies on any LMS, not
   just D2L.
8. **Watch for links that leave the LMS's own domain while doing any of the
   above** -- a third-party courseware/homework platform can hold due dates
   and topic sequencing that exist nowhere else in D2L. Recognize it live,
   off the link's actual destination and the surrounding page's context --
   **never from a list of known tool names** (an unlisted platform would
   silently recreate the same gap). See
   `docs/d2l_discovery.md#external-courseware-platforms----detect-the-link-not-the-tool-name`
   for the full procedure (a real incident: MAT1340's actual homework due
   dates lived entirely inside ALEKS, linked from D2L Content as a plain
   nav item with no surrounding text -- discovery assumed "not date-bearing"
   from the name alone and never opened it). Record what you find right
   away with `academic-sync unresolved-add`/`unresolved-resolve` -- don't
   just make a mental note, since that's exactly the failure mode this
   closes.
9. **If an assignment/quiz/dropbox page is locked/not-yet-available** and
   D2L shows an explicit "Available on <date>" marker, don't leave that as a
   silent blank -- note the item and its stated availability date in
   `raw_notes.md` so Step 2 can record it as `link_available_date` (see
   below) instead of just having no link and no explanation. This is a real
   fact from the source, not a guess: never invent an availability date that
   D2L didn't actually display.

**Collect first, process second -- for the whole run, not per-course.**
Finish Step 1 (every course, every area in the mandatory-minimum-crawl,
`raw_notes.md` written for each) *before* running a single `extract` call in
Step 2. Save every page's text/HTML to `data/downloads/<COURSE_CODE>/` as
you go (already required above) specifically so this split is possible --
Step 2 then reads back from those saved files rather than needing the
browser tab still open. Interleaving scan-and-extract per course is how a
real session on this project missed an entire course's Content area and
every course's Announcements: a course got marked "done" once *something*
had been extracted from it, before the rest of the crawl list was actually
checked. Running all of Step 1 to completion first, with nothing extracted
yet, removes that failure mode -- there's no partially-processed course to
mistake for a finished one. Only once every course's collection is verified
against `docs/d2l_discovery.md#mandatory-minimum-crawl` (and, for a re-run,
this being a first-time scan, so link refresh doesn't apply here -- see
`/academic-sync` for that on later runs) should Step 2
begin, and then it can run straight through for every course in one pass.

## Step 2: EXTRACT + NORMALIZE (local, deterministic)

For each page/document read or downloaded, feed it through the pipeline:

```bash
uv run academic-sync extract <path-or-a-temp-file-with-the-page-text> \
  --course <course_id> --source-type <syllabus|d2l_content|d2l_calendar|d2l_dropbox|d2l_quizzes|d2l_discussions|d2l_checklist|d2l_announcements|d2l_schedule_page|linked_pdf|linked_doc|lab_handout|external_courseware|other> \
  [--title "..."] [--url "..."] [--tentative]
```

For inline HTML page text (not a downloaded file), write it to a scratch
`.txt` or `.html` file first (your scratchpad directory), then run
`extract` against that path -- the CLI's `_load_document` picks the parser
by extension (`.pdf`, `.html`/`.htm`, else plain text).

This command prints a plan summary (CREATE/UPDATE/UNCHANGED/REVIEW counts)
for what it found *before* writing to the local database, and then persists
the extracted items and unresolved references. Watch its output -- a
sudden jump in REVIEW items or unresolved references is worth a sentence to
the user, not silent.

Identical content re-extracted (same `content_hash`) is automatically
skipped -- you'll see "Identical content already ingested... skipping."
That's expected and correct on a re-scan of unchanged pages.

## Step 3: AUDIT (completeness)

After scanning a course's readily-available areas:

```bash
uv run academic-sync completeness --course <course_id>
uv run academic-sync unresolved --course <course_id>
```

Report the completeness status plainly to the user (COMPLETE /
COMPLETE_FOR_DATED_ITEMS / INCOMPLETE / CONFLICTED / UNKNOWN) with the
notes shown. If it's INCOMPLETE because of open references ("see D2L",
"additional details will be provided," etc.), that's a signal to go back
and inspect the referenced area in Step 1 if you haven't yet -- don't treat
INCOMPLETE as a stopping point if there's an obvious next page to check.

**Check the `Never scanned:` line specifically.** Per
`docs/d2l_discovery.md#mandatory-minimum-crawl`, if it still lists
`d2l_calendar` or `d2l_content`, go back to Step 1 and open them -- this is
not optional and is not the same judgment call as the general "reasonably
exhausted the crawl list" allowance below. Only treat their absence from
`Never scanned:` as acceptable if you positively confirmed in Step 1 that
the course's own nav has no such area (record that in raw_notes.md), not
because you didn't get to it.

**Close every gap now -- this is not a separate later cleanup phase.**
User-directed 2026-08-25 (CLAUDE.md invariant 31), after a real session
where exhaustive chapter-topic capture, unresolved-reference resolution,
module nesting, and reference/resource link discovery ended up spread
across several separate later passes instead of happening here. A course's
first scan is expected to drive `completeness`'s numbers to zero wherever
real evidence exists to close them:

- **Open unresolved references**: for each `MISSING_DATE` reference, check
  whether the item's real due date lives somewhere not yet opened --
  critically, for any adaptive/external courseware platform (ALEKS and
  similar), its own **Assignments list or Gradebook** (the real, stable,
  complete view -- see invariant 23, this is *not* optional, and is very
  often where the bulk of a course's individual per-item dates actually
  live, not the syllabus at all). Feed real found text through `extract`
  (never hand-type a date into the database), then resolve the stale
  reference via `unresolved-resolve --note "..."` once its item has a real
  date (auto-resolution only fires on an exact title-text match; a
  paraphrased title needs the manual call). For `EXTERNAL_REFERENCE_
  UNINSPECTED`, actually open the link and resolve with what you found.
  Genuinely can't find something after real effort across every relevant
  source? Say so and leave it open -- that's an honest result, not a
  failure to fix.
- **Missing module/chapter nesting**: once a course's real module/chapter
  date ranges are known (from Step 1's `#required-finds`), derive nesting
  for any dated item whose date clearly falls inside one -- this needs no
  new browsing, just `render --nesting "<real range>" --save` applied
  per item. Don't force a chapter label onto something that genuinely
  isn't chapter content (an administrative deadline, a holiday, a course
  survey) just to clear the count -- leave those and note why.
- **Missing reference/resource links**: for each unlinked graded item,
  find and set its real turn-in page or platform link (`render
  --reference-url`/`--resource-url ... --save`) -- never construct or
  guess a URL, only ones actually navigated to and read off the page.
- **Confidently-identified duplicates** (same real obligation, same date,
  different title phrasing across two sources -- e.g. a syllabus's coarse
  "Ch 1 Exam" and the platform's own "Online Exam: Chapter 1.3-1.4 &
  1.6-1.7," both due the same day): mark the less-informative one
  superseded per CLAUDE.md invariant 30, don't leave both live. If the
  redundant one already has its own live Calendar event, **`delete_event`
  it** (`notificationLevel: NONE`) and remove its `SyncRecord` -- amended
  2026-09-01, no per-instance confirmation needed for a confident
  duplicate's redundant Calendar event. Genuinely ambiguous cases still
  get flagged, not deleted.
- **A date search that comes up genuinely empty after exhausting every
  relevant source** may use CLAUDE.md invariant 29's narrow inference
  path -- only with a stated, one-sentence, auditable pattern rule, via
  `render --inferred-date --date-inference-rule "..." --save`. This is
  not a shortcut around searching; it's what's left after searching.

Once you've reasonably exhausted the crawl-priority list, satisfied the
mandatory-minimum-crawl requirement above, *and* driven the gaps above to
zero (or to an honestly-reported "checked everywhere, genuinely
unresolved" state), an INCOMPLETE status is fine to report as final for
this run -- but it should reflect real remaining unknowns, not deferred
cleanup work.

## Step 4: PLAN (dry run, no writes)

```bash
uv run academic-sync plan --course <course_id> --verbose
```

Show the user a **concise** summary first (counts by action), and offer to
show the detailed list if they want it -- don't dump every item by default
for a large course. Call out anything in CONFLICT or REVIEW by name; those
need the user's attention, not just a count.

**Do not proceed to Step 5 without the user's go-ahead**, especially on a
course's first-ever sync. This matches the "first run must support dry-run"
requirement -- a plan is not an action.

## Step 5: SYNC (real Google Calendar writes, on approval)

**Weekly reading blocks, once per course for EVERY identified reading week
covering the whole term -- do this before the per-item loop below.** This
is a **required, non-optional step of every full course scan**, on the
same footing as the required finds in `docs/d2l_discovery.md#required-finds`
-- not something done only when specifically asked about "this week." A
course scan that syncs graded items but skips building the term's weekly
banners is not a complete scan. For every real week you found evidence for
during SCAN -- a module's stated start/stop dates, or a syllabus
week<->topic table (`docs/d2l_discovery.md#required-finds`, finding 5) --
run:

```
uv run academic-sync weekly-reading-add --course CODE \
  --week-start YYYY-MM-DD --week-end YYYY-MM-DD \
  --chapters "Chapter 12: Cellular Respiration; Chapter 13: Photosynthesis" \
  --links '[{"label": "Lecture video - Ch 12-13", "url": "https://..."},
            {"label": "Slides - Week of ...", "url": "https://..."},
            {"label": "Textbook - Ch 12-13", "url": "https://..."}]'
```

`--chapters` must trace to real instructor material, same bar as a
lecture's DETAILS (CLAUDE.md invariant 22) -- never a generated paraphrase.
This is idempotent by (course, week-start): re-running it for a week
already synced updates the same item, never duplicates (CLAUDE.md
invariant 25) -- so it's always safe to run for every week on every scan,
not just newly-discovered ones.

**`--links` = the week's real resources, never the syllabus** (user-directed
2026-09-01, CLAUDE.md invariant 25). A weekly banner isn't limited to two
link slots -- pass `--links` a JSON array of every resource a student
actually needs for that week's material, and omit whatever you didn't
find:
- that week's **lecture video(s)** -- the actual recording(s) (e.g.
  BIO1112's "Lecture Materials" area, a Panopto/Zoom cloud recording);
- that week's **slide deck** -- the same per-chapter slide-deck link that
  week's lecture events also carry in their `--links`;
- the **textbook reading** for the week's chapters -- the specific online
  chapter/section page, or the textbook's general access point if there's
  no per-chapter URL. Put the chapter numbers in the label.

**Never a syllabus link.** A syllabus says *that* a chapter is due, not
the reading itself; its URL stays internal (the `Source` row), and a
syllabus-labeled link is dropped at render time even if one slips in.
Omitting a link beats a syllabus link; an absent resource is a real gap,
not something to pad. The older `--reference-url`/`--resource-url` slots
still work as a fallback but `--links` is the way now. Can also be set
later with `render <item_id> --links '[...]' --save`.

Use `--details` for a simple pacing note,
e.g. "Ch. 12 by Wednesday, Ch. 13 by Friday" (omit entirely when the
source doesn't differentiate timing within the week) -- this is the only
thing `--details` means for a weekly reading item now (see the next
paragraph for READING / TOPIC DETAIL's actual content, and
`docs/d2l_discovery.md#weekly-reading-blocks` for the 2026-10-05 banner
layout: READING first, then SLIDES & RESOURCES, then TOPIC DETAIL).

**Before `render`-ing a weekly reading item, make sure `chapter-topic-add`
has been run for its chapters -- this is also a required, non-optional
step of every full course scan** (CLAUDE.md invariant 26,
`docs/d2l_discovery.md#required-finds` finding 6), not just for the weeks
you happen to be syncing right now:

```
uv run academic-sync chapter-topic-add --course CODE --chapter "Chapter 23" \
  --title "Evolution of Populations" \
  --vocabulary "microevolution, genetic variation, ..." \
  --objective "Explain the major processes that generate genetic variation" \
  --objective "State the Hardy-Weinberg theorem of genetic equilibrium" \
  --section "23.1 Genetic Variation Makes Evolution Possible" \
  --section "23.2 The Hardy-Weinberg Equation" \
  --reading-url "<the chapter's own reading page, opened and confirmed stable>" \
  --reading-label "Textbook — Ch 23 reading" \
  --exhaustive
```

`--section` (the chapter's real section headings, rendered as the "Big
topics" line) and `--reading-url` (the chapter-specific reading) are
required finds for every chapter, same as objectives. Search inside the
eBook or platform rather than stopping at its launch tile; see
`docs/d2l_discovery.md#external-courseware-platforms----detect-the-link-not-the-tool-name`
step 7.

Every `--vocabulary`/`--objective` value must trace to real
instructor-authored material (chapter objectives doc, study guide, that
chapter's own lecture slide deck when no separate objectives doc exists --
see `docs/d2l_discovery.md#required-finds` finding 6 -- or, for a
self-paced/online course, that platform's own topic breakdown, e.g.
ALEKS's per-topic objectives), same bar as invariant 22 -- never a
generated summary. **Capture the full, real list, not a representative
sample** -- amended 2026-08-25 after MAT1340's ALEKS data was under-
captured this way; see `docs/d2l_discovery.md#required-finds` finding 6
for the corrected per-platform guidance, including the general rule that
a platform's personalized/adaptive "what's next for you" view (e.g.
ALEKS's Ready to Learn) is never a substitute for its real stable
structure (e.g. ALEKS's View All Topics). **Only pass `--exhaustive` once
you've actually confirmed the list is complete and came from that stable
structure** -- leave it off (the default) if capture might still be
partial; `completeness` distinguishes the two
(`missing_chapter_topic_count` for no row at all,
`partial_chapter_topic_count` for a saved-but-unconfirmed row) so an
unconfirmed chapter still gets flagged for a follow-up pass instead of
looking done. Idempotent by (course, chapter label), same as
`weekly-reading-add`. Once saved, `render` on that course's weekly reading
item **automatically pulls it in** -- section headings and the reading
link under READING, real vocabulary and bulleted objectives under TOPIC
DETAIL, instead of a bare chapter-list line,
nothing else to do (a very large capture may get truncated in the
rendered description against Google Calendar's real length limit -- see
`docs/d2l_discovery.md#calendar-description-length-budget` -- the full
capture is unaffected either way). A chapter with no saved topic yet still
renders (bare name, no depth) rather than being blocked, but
`completeness` will flag it until `chapter-topic-add` is run for it --
don't leave either gate red across a full scan.

The printed item id then goes through the exact same `render` ->
`create_event`/`update_event` -> `record-sync` flow as any other item
(step 1 below handles it: `render` dispatches on `item_type`
automatically). See `docs/d2l_discovery.md#weekly-reading-blocks` for the
full mechanism.

For each item the user approved (typically all CREATE/UPDATE entries,
excluding anything they flagged):

1. **Run `uv run academic-sync render <item_id>` to get the exact
   summary/description/location/start/end this item should sync with --
   don't hand-type the HTML template from memory.** This is the single
   biggest source of drift risk in the whole skill: the title/description
   shape is a fiddly HTML template (bold headers, `<br>` separators,
   labeled links, an omit-if-missing rule for a dozen different optional
   sections), and reconstructing it from the prose description below,
   by hand, in every single `create_event` call, is exactly the kind of
   mechanical step that silently drifts (wrong separator, a forgotten
   `<br>`, a mislabeled link) without ever tripping a "never fabricate"
   invariant -- the text would just be *wrong*, not fabricated. `render`
   calls the actual tested `build_title`/`build_deadline_description`/
   `build_meeting_description`/`build_event_payload` functions and prints
   their real output, so copying it is guaranteed to match the documented
   format exactly.
   - Look up any saved location preference for this course/room first and
     pass it as `--location "<resolved string>"` **only for a real
     fixed-time meeting item** (`render` doesn't resolve location
     preferences itself -- that lookup stays the skill's job, see CLAUDE.md
     invariant 3). Don't pass `--location` for a deadline-type item at all
     -- `render` will warn and drop it if you do (CLAUDE.md invariant 21);
     where the work actually happens belongs in `--nesting` instead.
   - `render` automatically computes and prepends "D2L" or the real
     external platform's name to the MODULE line from the item's own
     `Source` (`platform_label_for_source`, CLAUDE.md invariant 20) -- you
     don't need to type that into `--nesting` yourself, just pass the
     chapter/week text as before.
   - Pass whatever discovery already found for this item via flags:
     `--details "..."` or `--details-blocks '[...]'` (topic + real special
     instructions), `--nesting "..."`, `--required-resources "..."`,
     `--points N`, `--optional`, `--reference-url`/`--reference-url-label`,
     `--resource-url`/`--resource-url-label`. See below for how to choose
     these. Add `--save` to persist them onto the item row for next time
     (e.g. a later `update_event` re-sync); without `--save` it's a pure
     preview and the database is untouched (`--details`/`--details-blocks`
     are never persisted either way -- always supplied fresh at render
     time, same as before).
   - **Use `--details-blocks` (not plain `--details`, not hand-typed HTML)
     whenever DETAILS has real multi-point structure** -- a lecture's
     vocabulary list + objectives, a per-chapter breakdown, a quiz's
     multi-unit coverage. It's a JSON array of labeled sub-groups
     (`sync/calendar_payload.py::DetailsBlock`/`format_details_blocks`)
     that renders each as `"Label: text"` or `"Label:"` followed by one "•"
     bullet line per item -- consistently, by tested code, instead of a
     hand-typed run-on paragraph that drifts session to session. Content
     rule is unchanged either way (CLAUDE.md invariant 22): every value
     still has to trace to real instructor-authored material -- a chapter
     objectives document, a study guide, lecture slide section titles --
     never a generated summary. See
     `docs/d2l_discovery.md#content-depth----link-and-quote-instructor-material-never-synthesize`
     for the exact shape and a worked example, and
     `#quiz-exam-coverage----unit-summary-vs-specific-breakdown` for how
     much detail a quiz/exam's DETAILS should carry (broad assessment: a
     compact per-unit summary block; narrow assessment: the exact
     chapters/sections). Plain `--details` is still fine for a short
     single-paragraph case that doesn't need sub-grouping.
   - **`--links` on a lecture/lab meeting (user-directed 2026-09-01,
     CLAUDE.md invariant 25):** a lecture isn't limited to the two
     `--reference-url`/`--resource-url` slots either -- pass `render
     <id> --links '[{"label","url"},...]' --save` a JSON array of that
     session's own real resources, in priority order: its specific slide
     deck(s), any handout / in-class activity / worksheet for that
     lecture, a professor recording if one exists, and the chapter's
     textbook reading. NEVER the syllabus or the textbook's bare
     table-of-contents as a stand-in for the real chapter (a syllabus-
     labeled link is dropped at render time regardless). Omit what
     doesn't exist. Deadline-type items (assignments/quizzes/exams) still
     use the two fixed `--reference-url`/`--resource-url` slots.
   - **A plain `READING` item never syncs as its own event, full stop** --
     `build_event_payload` raises if you try (CLAUDE.md invariants 24/25).
     Its content goes two places, both required: fold a same-day match into
     the covering lecture's own DETAILS (as before), and separately make
     sure it's represented in that course's `WEEKLY_READING` block for the
     week -- see `docs/d2l_discovery.md#weekly-reading-blocks` and Step 5's
     `weekly-reading-add` note below. This applies to every course,
     including online/async ones with no meetings -- there's no more
     "still gets the standalone item" carve-out.
   - Copy the printed `summary`/`description`/`location`/`startTime`/
     `endTime`/`timeZone`/`allDay`/`colorId` fields directly into the
     `create_event`/`update_event` call -- see the mapping table below for
     which live-tool parameter each corresponds to.
   - (Under the hood, if you ever need to understand *why* the output
     looks the way it does rather than just using it:
     `academic_sync.sync.calendar_payload` builds the title via
     `build_title`, the description via `build_deadline_description`/
     `build_meeting_description`, then embeds the fingerprint tag via
     `embed_fingerprint_tag` -- all three get called for you by
     `build_event_payload`, which is what `render` wraps. **Descriptions
     are real HTML** -- `<b>`/`<br>`/`<a href>`/`<small>` all render
     correctly in Calendar, confirmed by testing directly against the live
     connector -- so if you ever do need to construct one by hand instead
     of using `render`, join lines with `<br>`, never a bare `\n`.)
   - See `docs/d2l_discovery.md#calendar-titles-and-descriptions` for the
     exact title shape (`CODE (Section N) Label — Topic` for meetings --
     every meeting should carry a topic when the source gave one) and the
     structured, bold-headed description shape (`TOPIC`, `DETAILS`,
     `POINTS`/`STATUS`, `LOCATION`, `REQUIRED RESOURCES`, `CONTACT`,
     `LINKS` -- each included only when real, never padded with invented
     filler, and **no SOURCE section** -- provenance stays in the local DB,
     never in the visible event; the user found it cluttering).
   - **Set `item.is_optional` only when the source explicitly says
     extra-credit/optional/ungraded/for-practice** (never inferred from
     item type) -- see
     `docs/d2l_discovery.md#points-and-optionalextra-credit-academicitempoints-isoptional`.
     When true, `render` puts a plain `UNGRADED` tag at the very top of the
     description automatically -- nothing else to do. **Exact point values
     are not required or rendered** (CLAUDE.md invariant 27, superseded
     2026-08-25 -- an earlier version of this step required actively
     hunting down and capturing a number for every graded item; the user
     simplified this away) -- `--points` still exists if you want to jot
     one down, but don't spend time hunting for it and don't expect it to
     show up anywhere.
   - Set `item.reference_url`/`.reference_url_label` to the item's own
     actionable link -- **prefer the actual turn-in/submission page**
     labeled `"Assignment"` when you found it; fall back to a general area
     labeled with a short path hint (e.g. `"D2L (Content -> Assignments ->
     HW 1.3)"`) when you only have that. Set `item.resource_url`/
     `.resource_url_label` only when the source gave a real, stable
     external link (e.g. a textbook section) -- label it `"Textbook (Ch.
     6)"` when chapter-specific, or plain `"Textbook"` when it's only the
     general textbook home (and in that case, make sure the chapter/section
     number is stated in DETAILS or the title -- a general textbook link
     alone doesn't tell the user what to read). Never construct or guess
     either URL. **These are not either/or** -- if an assignment has both a
     separate handout/printout link and its own Dropbox/Quiz submission
     page, capture both (printout -> `resource_url`, Dropbox/Quiz ->
     `reference_url`); finding one is not a reason to stop looking for the
     other, and `completeness` gates on `reference_url` specifically
     (CLAUDE.md invariant 17). Full policy: `docs/d2l_discovery.md#links-academicitemreferenceurlreferenceurllabel-academicitemresourceurlresourceurllabel`.
   - **Every test gets its study guides:** study guide, practice exam,
     review assignment, exam-resource page. Save them with `render
     <test_id> --links '[...]' --save`; they render under STUDY GUIDES (see
     `docs/d2l_discovery.md#links`).
   - **Study depth (CLAUDE.md invariant 40):**
     - every chapter gets real Vocabulary + concept objectives (never
       section headings), plus labeled `--added-*` gap fill only where
       real material falls short;
     - every test gets `--covered-chapters` + `--study-focus` (study-guide
       emphasis, verbatim);
     - every homework gets a verified `--video-url`.

     See `docs/d2l_discovery.md#study-depth-exam-concepts-homework-videos-claudemd-invariant-40`.
   - **Exams and quizzes: open each one's own instructions page.** If it
     says the work is submitted separately (a "Show Work" or scratch-work
     dropbox), that dropbox is a required find. Set it as the exam's
     `--submission-url` (it renders as **Submit Work**). Also extract the
     dropbox's real name and due date so it becomes its own deadline item
     and event (see the `submission_url` part of `docs/d2l_discovery.md#links`).
   - Working with a course structure or LMS that doesn't match D2L's
     layout (a future term, a different institution)? See
     `docs/d2l_discovery.md#working-with-an-unfamiliar-lms-or-page-format` --
     the same discovery methodology applies, just the concrete tool names
     and URL shapes will differ.

2. **The live `create_event`/`update_event` tools do not accept a raw
   payload dict or an `extendedProperties` field.** `render`'s printed
   `summary`/`description`/`location`/`startTime`/`endTime`/`timeZone`/
   `allDay`/`colorId` fields already use the live tool's own parameter
   names (copy them straight across); this table is the rest of the
   mapping plus the fields that are always the same regardless of item:

   | field | tool parameter |
   |---|---|
   | `render`'s `startTime`/`endTime` | pass as-is; for an all-day item (`allDay: true`) these are bare `YYYY-MM-DD` dates, not datetimes |
   | *(always)* | leave `attendees` unset -- never pass any |
   | *(always)* | leave `addGoogleMeetUrl`/`googleMeetUrl` unset |
   | *(always)* | `overrideReminders: []` (empty list disables default reminders) |
   | `calendarId` | the `target_calendar_id` preference -- `render` prints this too (default: omit for primary) |

3. **Before creating**, do a cheap Calendar-side duplicate check as a
   backstop on top of the local `SyncRecord` check `plan` already did: call
   `mcp__claude_ai_Google_Calendar__list_events` with `fullText` set to the
   fingerprint tag text (e.g. `[academic-sync:fp:` + the first chars you
   expect) over a date window around the item's date. If a match with the
   same tag already exists, treat it as UNCHANGED/UPDATE instead of
   creating a second one, and tell the user local state was out of sync
   with Calendar.

4. Call `create_event` (CREATE) or `update_event` (UPDATE, using the
   `google_event_id` from the existing `SyncRecord`) against the calendar
   in the `target_calendar_id` preference.

5. **Immediately** record the result:
   ```bash
   uv run academic-sync record-sync <item_id> --event-id <returned_event_id> --calendar-id <calendar_id>
   ```
   Do this right after each successful write, not batched at the end --
   if something fails partway through, already-recorded items must not be
   re-created on retry.

6. For CONFLICT/REVIEW items: do not write anything. Tell the user what's
   blocking each one (the `reason` field from the plan).

**That's the end of a first-time scan.** Recurring maintenance on this
course from here on -- light-crawl re-scans, link refresh, and the weekly
grade diagnostic -- is `/academic-sync`'s job, not this skill's. Once this
course has a full first-time scan on record, set up the weekly trigger
event for it (once per course, not every run) by following
`/academic-sync`'s SKILL.md, which also tells you how to word that event so
it covers both link refresh and the grade diagnostic in one weekly nudge.

## After syncing

Print a short summary: N created, N updated, N unchanged, N left in
review/conflict, and remind the user they can check `unresolved`/`plan`
again any time. Do not re-print the full item list unless asked.

## Rules that apply throughout (see CLAUDE.md for the authoritative list)

- Never fabricate a date, a course nesting/module label, or a location.
  If you don't have it from a source or a saved preference, leave it
  unresolved.
- Never add attendees/guests or create a Google Meet link.
- If two rooms exist and it's unclear which is lecture vs. lab, combine them
  into one location string rather than guessing which is which (e.g. "E112 &
  W201") -- see `docs/calendar_rules.md#locations`. Ask the user only if they
  want it split.
- If a course states it's delivered `Online` (syllabus says so directly),
  set `Course.delivery_format = "Online"`. `platform_location = "Online"`
  applies **only to real fixed-time meeting items that would otherwise have
  a room** (a synchronous lecture/lab/exam-with-a-room) -- never to
  deadline-type items (quizzes, exams-as-async-windows, assignments,
  discussions). `sync/calendar_payload.py::build_event_payload` now
  enforces this at the payload level regardless (see CLAUDE.md invariant
  21), but don't rely on that backstop -- don't pass `--location` for a
  deadline-type item's `render` call in the first place, and don't set
  `item.platform_location` on one. Where a deadline-type item's work
  actually happens (D2L vs. an external tool) belongs in `--nesting`
  instead -- see the MODULE-line platform-naming note under Step 5. Save
  `delivery_format` as a course-scoped preference so a re-scan doesn't have
  to redetect it.
- Never delete a Calendar event just because a source item disappeared on
  re-scan -- flag it, don't delete it, unless the source explicitly says
  it was cancelled and the user has enabled a deletion policy (none exists
  yet in this codebase).
- If you're about to write logic that parses dates, classifies text, or
  computes a fingerprint by hand instead of calling into
  `src/academic_sync/`, stop -- that logic belongs in the Python package,
  not inline in this skill.
