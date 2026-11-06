# D2L/Brightspace discovery guide

This describes how the `academic-import` skill should navigate D2L using
Claude Code's browser control (`claude-in-chrome`). It's guidance for that
skill's behavior, not code -- there is no D2L API client in this repo (see
`docs/architecture.md` for why).

## This must generalize -- to new courses, new terms, and other LMSs

Everything below except `#institution-context` is written as *methodology*,
not as instructions specific to one institution or to D2L Brightspace. The user
will add classes in future terms, and possibly at a different institution
or on a different LMS (Canvas, Blackboard, Moodle, etc.) entirely -- the
skill needs to work then too, not just for the three courses this guide's
examples are drawn from. When reading a rule below that names a specific
D2L tool, URL pattern, or vendor term (Content/Modules, Dropbox, "Simple
Syllabus," the institution's D2L host), treat the *pattern* as the requirement
and the *name* as an example of what it looked like on this one deployment:

- "Both the course Calendar and Content/Modules must be opened" generalizes
  to: **both the LMS's own dated-calendar tool and its main content/
  materials area must be opened**, whatever they're called on this
  platform (Canvas calls the equivalent areas "Calendar" and "Modules";
  Blackboard "Calendar" and "Content"; a bespoke course site might have
  neither and put everything in one syllabus page -- the requirement is
  "don't stop after one area," not "these two exact tab labels exist").
- "Read the actual course nav before assuming a fixed list of areas" is the
  general antidote to platform differences -- don't hardcode an expectation
  of what tools exist; look at what this specific course/LMS actually
  offers and reason about where dated obligations and topic/unit material
  would plausibly live.
- The concrete D2L URL shapes under `#calendar-titles-and-descriptions`
  (`viewContent/<topicId>/View`) are the *example* of "a stable per-item
  deep link with a numeric ID, not a session token." On another LMS the
  URL will look completely different -- the test for whether to trust it as
  `reference_url` is the same regardless: does it point at this specific
  item, and does it still resolve when revisited later in the same
  logged-in session (not a redirect to a generic dashboard)?
- `#orientation-pass----do-this-first-for-every-course-before-the-deep-crawl`
  and `#required-finds` are the two sections most worth re-reading on a new
  LMS: "determine delivery format, then locate the textbook/materials
  access point, the module/week breakdown, and the primary tool URLs
  before extracting individual items" is a platform-independent workflow.
  Only the *names* of the areas you're looking in (Canvas Modules vs. D2L
  Content, Canvas Assignments vs. D2L Dropbox, Canvas's own "Syllabus" tool
  vs. a D2L "Simple Syllabus" LTI) change; the three categories of thing
  you're required to find do not.
- `#getting-unstuck-without-stopping-to-ask-and-without-burning-tokens-on-it`
  is written generically on purpose (a hung cross-origin embed is a
  property of browser automation against *any* LMS, not a D2L quirk) --
  the escalation ladder there (one retry, then a fresh tab, then move on
  after two total failed attempts) applies unchanged regardless of
  platform.

### Working with an unfamiliar LMS or page format

When you hit a page, embed, or link structure you haven't seen before
(a new institution's LMS, a courseware tool that isn't D2L's "Simple
Syllabus," a link domain you don't recognize), don't guess or skip it --
apply the same general strategy that was used to figure out this D2L
deployment:

0. Run the orientation pass first
   (`#orientation-pass----do-this-first-for-every-course-before-the-deep-crawl`)
   even though its example wording is D2L-flavored -- delivery format,
   real course nav, and the three required-finds categories are the first
   things to establish on *any* LMS, before you've even worked out its
   specific page/embed quirks. Everything below this point is about
   reading an individual unfamiliar page once you already know it's one
   you need.
1. Try reading it inline first (`get_page_text`/`read_page`). Most
   same-origin HTML content works this way.
2. If the real content lives in a cross-origin embed/iframe (common for
   LTI-launched tools -- gradebooks, adaptive courseware, third-party
   syllabus tools) and `get_page_text` comes back with only chrome/nav
   text, screenshot and scroll it instead -- see `#what-to-download-vs-read-inline`.
   Mechanically, on this kind of embedded content: `computer` `scroll`
   at a coordinate over the embed is the first thing to try; if that
   produces no visible movement across a couple of attempts, click on a
   plain (non-interactive) line of body text inside the embed first, then
   send repeated `Down` arrow-key presses -- clicking a link, button, or
   accordion header instead of plain text can steal keyboard focus and
   make Down do nothing. If scroll/Down both appear to do nothing even
   after that, before concluding the page is broken, check whether
   there's simply no more content: toggle the current collapsible
   section closed once (if the content sits inside one) -- seeing what
   heading appears immediately after it confirms whether you already had
   everything, without more failed scroll attempts. Real incident,
   2026-08-25: this cost several wasted round trips on a MAT1340 section
   that turned out to have no video list at all -- the "stuck" screenshot
   was accurate, not a bug.
3. If a whole page or widget hangs, see
   `#getting-unstuck-without-stopping-to-ask-and-without-burning-tokens-on-it`
   -- don't stop and ask the user just because the format is new to you.
4. Before trusting any link as a durable `reference_url`/`resource_url`,
   confirm it's a specific, stable deep link (see the test above), not a
   generic entry point that happens to work right now because of an active
   session/launch context.
5. Record what you learn about the new format in that course's
   `raw_notes.md` so a later pass (by you or a future session) doesn't have
   to rediscover it from scratch.

### Field fallbacks: omit unless there's a real substitute

The general rule for any optional field with no data: **omit it entirely**
-- no placeholder text, no "Not provided," no guessed value. There is
exactly one deliberate exception already established in this project:

- **Online courses and `location`, meetings only**: when a course's own
  materials state it's delivered online (not just "no room was ever
  mentioned" -- the source has to actually say so) and an item is a real
  fixed-time *meeting* that would otherwise have a room (a synchronous
  lecture/lab/exam-with-a-room), set the location to `"Online"` rather than
  leaving it blank. This is a substitution, not an omission, because for
  such a meeting a blank location is ambiguous (unresolved vs. genuinely
  online), while `"Online"` is an accurate, positive statement of fact.
  Save it as a course-scoped `delivery_format` preference too so a re-scan
  doesn't have to re-detect it (see `academic-import`'s SKILL.md). This
  does **not** extend to deadline-type items (quizzes, exams-as-async-
  windows, assignments, discussions) -- CLAUDE.md invariant 21 restricts
  the Calendar event's `location` field to genuine physical meetings only
  (`sync/calendar_payload.py::build_event_payload` enforces this), after a
  real incident where `"Online"` had been applied to dozens of deadline
  items across two courses, which is trivially true and displaced more
  useful information. A deadline's "where to actually go for this" belongs
  in the MODULE line of the description (see
  `#calendar-titles-and-descriptions`), never in `location`.

Every other field (topic, details, points, required resources,
reference_url, resource_url, contact, nesting) follows the plain omit
rule: if you don't have it, leave the section out. Don't invent a parallel
"Unknown"/"TBD" convention for any of them. (Source provenance is a
different case again -- not omit-when-missing, but never rendered at all,
by design; see `#calendar-titles-and-descriptions`.)

## Institution context

This deployment's institution, D2L host, and SSO details live in
`config/personal.local.md` (gitignored; template `config/personal.example.md`)
-- read it before a scan. The rules below hold for any institution.

- **Real, bookmarkable D2L home URL**: `d2l_home_url` in
  `config/personal.local.md`, also saved as the `d2l_base_url` preference.
  Navigate here directly; do not
  use a `*.tenants.brightspace.com` URL copied from a SAML redirect link --
  those are SAML relying-party identifiers (federation metadata), not
  browsable addresses, and will not resolve as a normal page load.
- **SSO**: see `sso_notes` in `config/personal.local.md` (typically an
  interactive username + password form) -- no MFA bypass is
  needed or attempted. The user's own Chrome has these credentials
  saved via its normal autofill, so the login form is typically pre-filled;
  the skill must still let the user click "Sign In" themselves rather than
  doing it on their behalf.
- **Session reuse**: because this all happens in the user's real,
  persistent Chrome profile (not an ephemeral automation browser), the SSO
  session cookie set on a successful login is retained by Chrome itself
  across skill invocations, the same as if the user browsed manually.
  Future runs will often skip the login screen entirely and land straight
  on the D2L homepage, until the institution's own session timeout expires
  and a fresh interactive login is needed again. Nothing in this project
  needs to persist that session -- it's already Chrome's job.

## Login flow

1. Navigate to the D2L base URL (or a specific course URL if resuming).
2. If redirected to Banner CAS SSO (or the institution's equivalent), stop
   and tell the user: "Please log in to D2L in the browser tab I opened."
   Wait for navigation back to a `d2l.brightspace.com`-family URL before
   continuing.
3. Never enter a password on the user's behalf. Never attempt to detect or
   bypass MFA -- if a second-factor prompt appears, that's the user's step
   to complete, not the skill's.
4. Do not persist any session/cookie state to disk from this skill; rely on
   the user's own already-authenticated Chrome session for reuse across
   runs (that's an ordinary browser session, not something this project
   manages).

## Course enumeration

D2L's course selector / "My Courses" widget is the starting point. For each
active course in the target term, capture what's visible without deep
navigation yet:

- Course code, section, title
- D2L course offering ID (usually visible in the URL, e.g. `/d2l/home/NNNN`)
- Term
- Canonical course URL

Register each with `academic-sync course add` (or, more precisely, the
skill should call the equivalent library function --
`academic_sync.db.repository.upsert_course` -- directly rather than
shelling out per course, but `course add` is available for manual/CLI use
too).

## Orientation pass -- do this first, for every course, before the deep crawl

A pattern runs through nearly every discovery gap found in this project so
far (the BIO1112 lecture miss that produced `#mandatory-minimum-crawl`, the
90+ items with no module nesting and 100+ with no resource link that
produced `#required-finds`, CHE1011's online schedule almost being treated
as "this course just doesn't have that kind of page"): each one was a case
of not checking early enough whether a category of content existed at all,
which meant it never got looked for, which meant it was silently missing
by the time anything downstream (completeness, a human skim) might have
caught it. The fix in every case was the same shape -- stop and answer a
structural question before doing detail work. So answer these for every
new course, in this order, before opening a single Content module or
Dropbox item:

1. **What is this course's delivery format?** Read the syllabus/course-info
   page for an explicit statement (Online, Hybrid, HyFlex, Classroom
   Based/In-Person). Save it immediately as a course-scoped `delivery_format`
   preference -- don't infer it later from the absence of a meeting time.
   This single fact changes what you're looking for next:
   - **In-person component present** -- the crawl isn't done until you've
     found a recurring meeting pattern (days/time/room) for lecture and, if
     applicable, lab. See the sanity check below.
   - **Online or async component present** -- the crawl isn't done until
     you've found that course's equivalent of a lecture schedule: a
     week-by-week or module-by-module page stating what happens/is due each
     week, even though there's no room or meeting time attached to it. Do
     not treat "no physical meeting" as "nothing to look for here" -- an
     online course still has a page playing the same structural role;
     finding it is exactly as mandatory as finding an in-person meeting
     pattern is for a classroom course. (This is what
     `#calendar-titles-and-descriptions`'s MODULE section and
     `#required-finds`'s per-item nesting ultimately get populated from.)
2. **What does the actual course navigation offer?** Read it
   (`get_page_text`/`read_page`), don't assume a fixed list of tool names --
   see `#enumerate-the-actual-course-nav----dont-guess-from-a-fixed-list`.
   This tells you what to call the areas in step 3 below on *this*
   course/LMS.
3. **Where do the required-finds categories actually live?** Before
   pulling individual dated items, locate (don't fully read yet, just
   locate) all six: the textbook/course-materials access point; the
   module/chapter list that per-item nesting will come from; the primary
   tool URLs (quiz list, discussion list, any third-party homework
   platform launch link); instructor-authored per-chapter study material
   (objectives doc/study guide, or the platform-specific equivalent for a
   self-paced course); each module's stated start/stop dates or the
   syllabus's week<->topic table (what a course's `WEEKLY_READING` blocks
   get built from); and where each chapter/unit's own real topic
   breakdown lives (what `chapter-topic-add` gets its content from -- see
   the per-course-type examples under finding 6). See `#required-finds`
   for the full detail on each. Knowing where these live *before* you
   start extracting items means every item you create can be enriched as
   you go, instead of requiring a second pass later to retrofit
   nesting/links/weekly-banner-content onto items that already exist.

Getting these three questions answered is genuinely fast -- it's usually
2-4 page loads (syllabus, course home/nav, one Content-area skim) -- and it
is what turns "required finds" from a late completeness-report surprise
into just the normal first few minutes of working a new course. Skipping
straight to "find the dated items" without this pass is exactly how a
course ends up with real dated items and zero nesting/links: the items
were never wrong, the orientation that would have connected them to their
module/link context just never happened.

## Mandatory minimum crawl -- do not skip this

A real gap surfaced in production use of this system: three courses were
synced to Calendar after only 1-2 source types had actually been opened per
course (e.g. syllabus + quizzes for one course, only the calendar PDF for
another). Nothing was fabricated -- every invariant in CLAUDE.md held -- but
whole categories of real, existing information were simply **never
fetched**: BIO1112's lecture meeting schedule, and the weekly/unit topic
outline and per-assignment special instructions for all three courses. The
completeness report correctly said `INCOMPLETE` and listed which source
types were never scanned every single time, but a scan was still treated as
"done enough" without actually reading that field. That must stop.

**Before a course's discovery pass counts as done, you must have actually
opened all three of these, not just listed them in a plan:**

1. **The course Calendar** (D2L's own calendar tool for that course, if one
   exists) -- separate from a syllabus's own schedule table.
2. **Content / Modules**, walked module-by-module -- this is where
   Brightspace courses most often host the week-by-week or unit-by-unit
   topic outline ("Unit 3: Rational Expressions," "Week 5: Chapter 6 --
   Chemical Reactions") and any per-assignment special instructions
   (submission method, attempt limits, format requirements, rubric notes).
   A course that has homework/exam *dates* but no visible topic/unit
   material anywhere is not evidence the course lacks that material -- it
   is near-certain evidence Content/Modules was never actually opened.
3. **Announcements, every post, in full (expand each one, don't trust the
   list-view preview text).** Added 2026-08-18 after the same failure shape
   hit a third area: a CHE1011 announcement titled "See new syllabus
   uplade..." contained a corrected lab schedule revealing that Lab Safety,
   Getting Started, and Lab #1 -- a whole category of real assignments --
   had never been captured at all, because they existed only in that one
   announcement, not in the syllabus, Calendar, or Content. The same pass
   also found a BIO1112 welcome announcement stating Week 1's lab met in a
   *different room* than every other week -- a real, source-confirmed
   exception that a uniform `lab_room` preference had been silently
   overriding on the one week it didn't apply. Neither of these was
   fabricated, and neither would have been caught by Calendar or Content --
   an instructor can and does put real schedule-changing information only
   in an Announcement, especially on a re-scan (announcements are
   effectively an instructor's "what changed" channel; syllabus/Calendar/
   Content are not always kept in sync with them). Register each
   announcement via `extract --source-type d2l_announcements` even when it
   produces zero new items -- that's what makes `completeness` stop listing
   `d2l_announcements` under `Never scanned:`, which is itself information
   (see the next paragraph).

Do not stop at the syllabus. Do not stop once you have "enough items to
look plausible." Run `academic-sync completeness --course <id>` and look at
the `Never scanned:` line -- if it lists `d2l_calendar`, `d2l_content`, or
`d2l_announcements`, the course is not done, full stop, regardless of how
many items are already in the database. Only skip an area if you can
positively confirm it does not exist for this course (e.g. the course nav
has no Calendar/Content/Announcements at all) -- "I didn't check" and "it
doesn't exist" are different findings and must be recorded differently in
the raw notes (see below).

**On a re-scan** (not a course's first-ever pass), re-check Announcements
even if nothing else changed -- it's the one area whose whole purpose is
new information since last time, and `content_hash` dedup means a truly
identical announcements page costs nothing to re-extract, so there's no
efficiency argument for skipping it on a repeat run.

## Recurring runs -- light crawl

User-directed, 2026-08-30: once a course has already been through a full
first-time scan (mandatory-minimum-crawl above, required finds below, and
its gaps closed per CLAUDE.md invariant 31), a *later* re-invocation of
`/academic-sync` for that same course does not need to repeat the whole
crawl to stay current -- but it must never silently go stale either
(`/academic-import` handles only the first-time scan itself; every later
run on an already-scanned course, including this light crawl, is
`/academic-sync`'s job). Every recurring run for a course with prior sync
history:

1. **Always re-opens Announcements in full and the course Calendar**, same
   as the "On a re-scan" rule above -- this is not optional or judgment-
   dependent, it runs every single time regardless of what else this run
   touches, because these two are the areas most likely to carry a genuine
   change (a moved date, a new assignment, a room exception) since the last
   pass.
2. **Extends Content/Modules crawling only as far as the next not-yet-built
   `WEEKLY_READING` week** for that course -- find the earliest real week
   (per required find #5) that doesn't have a `weekly-reading-add` row yet,
   open that week's module/content page, and run `weekly-reading-add` +
   `chapter-topic-add` for it (same evidentiary bar as a first-time scan,
   see CLAUDE.md invariants 22/25/26 -- nothing about a recurring run
   relaxes what counts as real, sourced content). Don't re-walk modules
   already fully captured in a prior session just to double-check them --
   Announcements is what's supposed to surface a genuine change to
   already-captured material (see point 1), not a redundant re-crawl of
   settled content.
3. **Still resolves any open gaps a fresh Announcements/Calendar read
   surfaces** -- a new announcement moving a date, a newly-unlocked
   assignment (see `/academic-sync`'s link refresh step), a newly-added
   week -- using the same "go look, don't just report" default as CLAUDE.md
   invariants 32/34.

This does not apply to a course with no prior sync history at all -- that
course always gets the full mandatory-minimum-crawl and required-finds
treatment below, every time, regardless of how many other courses in the
same run are recurring.

## Weekly grade diagnostic crawl

User-directed, 2026-09-16 (event layout amended 2026-09-17 -- see CLAUDE.md
invariant 37): `/academic-sync`'s Step 3 produces one Calendar event **per
course** every week, "`<CODE>` Previous Week Diagnostic," covering that
course's actual grades -- not just content and dates. Every real
(non-`is_synthetic`) active course gets its own event, independently
colored Red/Yellow/Green. This is a separate crawl from the light-crawl
re-scan above (Content/Modules/Announcements), driven by a different part
of D2L/ALEKS entirely: the **Grades** tool.

1. **Open D2L's Grades tool every diagnostic run -- not just Content.**
   This is the authoritative score record, same "read the real full view,
   not the dashboard" rule invariant 23 already established for ALEKS's
   Gradebook vs. its "Working Toward" widget (see
   `#external-courseware-platforms----detect-the-link-not-the-tool-name`
   step 6) -- it applies here just as much: D2L's own Grades tool can have
   a summary view and a full gradebook view, and the full view is the one
   that matters.
2. **For external courseware (ALEKS and similar), its own Gradebook is the
   score source**, same platform already detected during the course's
   original scan (`#external-courseware-platforms`) -- don't assume D2L's
   own Grades tool mirrors an external platform's scores; it usually
   doesn't reflect them at all until an instructor manually syncs them.
   Check the external platform's own gradebook independently even when
   D2L Grades already shows *some* real scores for that course (e.g. exams
   recorded directly in D2L while homework mastery lives only in ALEKS) --
   one having data is never a reason to skip the other.
3. **A blank/dash cell on the Grades page is ambiguous -- it means either
   "not yet graded" or "never submitted," and Grades alone can't tell you
   which.** Real incident, 2026-09-16: BIO1112's Grades page showed a bare
   `-` for Labs 2-4 exactly like it would for a lab that had been submitted
   and was just waiting on grading. The real answer -- genuinely
   `Not Submitted`, confirmed against the actual due dates already having
   passed -- only existed on D2L's own **Assignments/Dropbox** completion
   -status page (`Course Home -> Assignments`, or the Dropbox tool by
   whatever name the course nav uses), which shows a real per-item
   `Completion Status` column (`Not Submitted` / `N Submission(s), N
   File(s)` / etc.) distinct from the Grades page's score column. **This
   is the authoritative source for whether an item is genuinely missing,
   not a blank Grades cell** -- for any item without a real score, check
   the Dropbox/Assignments completion status before recording
   `--missing`, rather than inferring it from an absent grade alone.
4. **Feedback/comments live in different places depending on how the item
   is graded -- check the pattern that matches the item type, not one
   universal location:**
   - A **Dropbox/assignment-type item** shows an `Evaluation Status`
     column on the Assignments/Dropbox completion-status page (step 3
     above) -- `Feedback: Unread`/`Read` with a `View Feedback` link opens
     the real instructor comment (which may be empty -- a real, correctly-
     graded zero with no comment is common and not a gap to fill).
   - A **rubric-graded item** on the Grades page itself often has an
     inline `View Graded Rubric` link that expands the item's own real
     `Overall Feedback` text directly on the Grades page -- no navigation
     needed. Clicking one such link was observed, once, to also reveal an
     already-graded neighboring item's feedback inline on the same page
     pass -- don't assume this always happens, but do glance at the whole
     visible page after expanding one rather than immediately navigating
     away.
   - A **quiz-type item** has its own `View Quiz Attempts` link (D2L's
     quiz tool, not the Dropbox) -- open it if the score alone doesn't
     explain enough and a written comment might exist there.
   - A scanned/handwritten "Show Work" submission (common for math/science
     exams) may only have **inline PDF annotation feedback** (a `View
     Inline Feedback for <file>.pdf`-style link) -- this is not reliably
     machine-readable; it's fine to note that real feedback exists there
     and point the user at it directly in D2L rather than attempting to
     transcribe handwritten annotations from a screenshot every time.
   **Never invent feedback that isn't there** -- the overwhelming majority
   of items will have no instructor comments at all, and that's the
   expected, correct result, not a gap to fill with a guess.
5. **If a due/availability date shown live on the Dropbox/Assignments page
   conflicts with what's stored locally, the live page is authoritative --
   flag it, and fix it through the real extraction pipeline** (feed the
   live-observed text through `extract`, per invariant 1 -- never hand
   -edit `AcademicItem.date`), not just noted and left stale. Real
   incident, 2026-09-16: a locally-stored Sep 12 due date for CHE1011's
   "Lab Kit Authentication" turned out to be Sep 19 on the live Dropbox
   page -- checking the live page during this crawl is what caught it;
   trusting the locally-stored date would have wrongly counted it as
   overdue-and-missing a week early.
6. **Match each gradebook row to a local `AcademicItem` by title**,
   best-effort -- gradebook naming can differ slightly from D2L Content
   naming (e.g. "Ch. 3 Quiz" in Grades vs. "Quiz 3: Cell Biology" in
   Content). If nothing matches confidently, still record the
   `GradeSnapshot` against the course (no `--item-id`) rather than dropping
   it -- same "capture over silence" instinct as invariant 32.
7. **Re-open Announcements for the diagnosed week** (already mandated for
   every recurring run by the light-crawl section above) and keep whatever
   is new for the diagnostic's own announcement-highlights section -- this
   is a second, diagnostic-specific USE of that same crawl, not a second
   crawl of it.
8. **Upcoming big deadlines** (exam/final_exam/project/paper/presentation/
   lab_practical items due within 21 days) come entirely from already
   -synced local `AcademicItem` data -- no extra browsing needed, just a
   date-range query the skill runs via the Python package.
9. **Evidentiary bar**: a score or a quoted feedback string must trace to
   real D2L/ALEKS page content, same as every other sourced field in this
   project (CLAUDE.md invariant 1's bar, extended to grade data). The
   **corrective plan/recommendation text the diagnostic banner shows is
   explicitly Claude's own generated advice**, not sourced fact -- this
   does not relax invariant 22 (which governs curriculum *content*); it's
   the same "recommend a course of action" the user asked for when this
   feature was designed. A missing-work warning or a "you're behind pace"
   note is likewise Claude's own synthesis from real, sourced facts
   (missing flags, scores, dates), not itself something that needs to
   trace to a literal sentence in D2L.

See `.claude/skills/academic-sync/SKILL.md` Step 3 for the actual command
sequence (`grade-snapshot-add` -> `course-grade-snapshot-add` ->
`diagnostic-compute` -> `diagnostic-render` -> `create_event`/`update_event`
-> `diagnostic-record-sync`) and Step 4 for the Google Drive weakness-signal
write that piggybacks on a RED result tied to identifiable chapter coverage.

## Required finds -- what "done" means beyond just having items

A second gap surfaced after the one above was fixed: a real sync on
2026-08-18 opened both the Calendar and Content/Modules for all three
courses, created real dated items for all of them, and `completeness`
reported `COMPLETE_FOR_DATED_ITEMS` -- and every single item still had
`module_label`, `reference_url`, and `resource_url` all `None`. The
per-item content was correct; the per-item *enrichment* had simply never
been attempted, and nothing checked for that, because "was this item ever
connected to the module/link that actually contains it" is a different
question from "does this item exist." `completeness/analyzer.py` now
tracks this directly (`unnested_item_count`/`unlinked_item_count`, folded
into INCOMPLETE -- see CLAUDE.md invariant 17), but the analyzer can only
count what discovery already tried to find. These three finds are
**required**, not enrichment, for any course with real module/chapter
structure in D2L:

1. **The textbook/course-materials access point.** Look for a "Textbook"
   or "Course Materials" module in Content (or a syllabus's own "Course
   Materials Information" section). Prefer the *actual outbound
   destination* over the D2L page that merely contains the link -- follow
   the launch through when it resolves cleanly (most LTI launches redirect
   in one or two hops to a stable page: a publisher's book viewer, a
   bookstore/VitalSource entry, ALEKS's own materials page) and capture
   *that* URL, even if it lands on a login/paywall -- reaching the real
   destination is still worth it even when it's not freely accessible,
   since it removes a navigation step for the user either way. Only fall
   back to linking the D2L launch page itself when following through turns
   into the kind of flaky/hanging tool interaction "Getting unstuck" below
   describes -- don't fight one balky LTI redirect indefinitely just to
   shave off a hop. Either way, capture whatever real URL you end up with
   even if the page itself says the link isn't working yet (that's real,
   current information; put it in `AcademicItem`'s rendered DETAILS as a
   caveat, don't discard it and don't silently treat "the link might not
   work" as "there is no link"). Never fabricate a URL you didn't actually
   land on.

2. **The real per-topic/per-chapter breakdown for every module a dated
   item falls under**, not just the module's top-level title. Brightspace
   modules nest -- "Chapter 1: Prerequisite Review Topics (8/17 - 8/30)"
   is the module title, but the actual per-assignment study page is a
   sub-topic underneath it ("1.3 Complex Numbers," "1.4 Quadratic
   Equations"). Open the module and read its topic list; that list is
   what feeds both `AcademicItem.module_label` (the module's own title,
   including any date range D2L itself states) and `resource_url` (the
   specific sub-topic page matching that item, when one exists with a
   matching number/name). **If the module/week heading itself doesn't
   state a date range but two adjacent real headings in the same schedule
   do** (e.g. a syllabus's "Week 2" row has no dates printed on it, but
   "Week 1" and "Week 3" both do), derive it from those two -- same
   "auditable derivation rule applied to two other literal dates"
   allowance CLAUDE.md invariant 1 already permits elsewhere -- and
   include it in `module_label` too, so a course whose schedule format
   happens to omit the date on one row doesn't end up looking less
   detailed than a course whose format states it directly (real
   inconsistency this caused, CLAUDE.md invariant 28: BIO1112 stayed a
   bare `"Week 2"` while MAT1340/CHE1011 showed
   `"...(8/17 - 8/30)"`/`"Week 2: 8/24-8/30"` for the equivalent week,
   purely because of how each course's own table happened to be laid
   out). If no range is stated *or* derivable, the bare label is still
   correct -- don't invent one.

3. **The primary tool URLs**, captured once per course and reused across
   every matching item: the Quizzes list page, the Discussions list page,
   and any third-party homework platform's launch link (ALEKS, a
   McGraw-Hill/Pearson/etc. "basic launch" topic). These are real, stable
   D2L URLs (`/d2l/lms/quizzing/quizzing.d2l?ou=<id>`,
   `/d2l/le/<id>/discussions/List`, or a `viewContent` link to the launch
   topic) obtainable from the course nav or Content tree -- grab each once
   and reuse it as `reference_url`/`resource_url` for every item of that
   kind, rather than re-deriving it per item. This includes each individual
   Discussions **topic**, not just the List page -- a discussion item's
   `reference_url` should be the specific topic thread
   (`/d2l/le/<id>/discussions/topics/<topicId>/View`) when you can get it,
   the List page only as a fallback (real incident, 2026-08-21: a MAT1340
   discussion item had a correct date but no link at all, because it was
   only ever noticed via the Calendar's availability-end display -- nobody
   had actually opened Discussions to get the topic's own URL).

4. **Instructor-authored per-chapter study material AND per-lecture
   materials, when the course has any** -- a "Chapter Objectives," "Study
   Guide," or "Lecture Slides/Materials" module in Content, and any
   handout / in-class activity / worksheet / podcast guide / review-slides
   file that goes with a specific lecture. Real incident, 2026-08-21:
   BIO1112's Content tree has one objectives document per chapter (Word/
   PDF, written by the instructor) sitting right next to the Lecture
   Slides folder -- exactly the material a student would actually study
   from -- and it had never been looked at; lecture DETAILS were a generic
   logistics note instead. Extended 2026-09-01: the same "Lecture
   Materials" area also holds per-lecture handouts and activities (e.g. a
   "Hardy-Weinberg Practice Problems" doc, a "Reading Tree Diagrams"
   worksheet, a "Radiolab Fungi" podcast guide, "Review Slides for
   Midterm") -- enumerate them (the content-TOC API makes this one call)
   and match each to its lecture by topic. This is a required find on the
   same footing as 1-3:
   - (a) put each lecture's real materials in its **`--links` list**
     (CLAUDE.md invariant 25's second amendment): that lecture's specific
     slide deck(s), its handout/activity, a professor recording if one
     exists, and the chapter's textbook reading -- never the syllabus,
     never the textbook's bare table of contents. See
     `#every-lecture-links-its-own-real-materials----not-the-syllabus-not-the-textbooks-bare-table-of-contents`
     below.
   - (b) pull the real per-chapter breakdown from the objectives/study-
     guide document into that lecture's DETAILS -- see
     `#content-depth----link-and-quote-instructor-material-never-synthesize`
     below for the format and the never-synthesize rule.
   If a course has nothing like this beyond the schedule's own chapter-
   level titles, that's a real, sourced answer too -- DETAILS just stays
   at whatever depth genuinely exists, and `--links` just carries the
   textbook; don't invent a breakdown or a handout to fill the section.

5. **Each module's stated start/stop dates, and/or the syllabus's own
   week<->topic table, for every course** -- this is what a course's
   `WEEKLY_READING` blocks (see
   `#weekly-reading-blocks` below and CLAUDE.md invariant 25) get derived
   from. A Brightspace module's title or metadata often already states its
   real date range (e.g. "Chapter 1: Prerequisite Review Topics (8/17 -
   8/30)" -- finding #2 above already captures this string into
   `module_label`, but it's also the literal evidence for that week's
   reading block's start/end); a syllabus's topical outline table often
   states the same thing in a "Week N: <dates> -- <topics>" row instead.
   Capture whichever the course actually has. If neither states a real
   date range for a stretch of reading, don't force a `WEEKLY_READING`
   block for it -- same "don't fabricate" bar as every other date (CLAUDE.md
   invariant 1).

6. **Every chapter/unit's own real, complete topic/subtopic breakdown --
   full lists, not a representative sample -- saved via `academic-sync
   chapter-topic-add`, for every chapter/unit the course has, not just
   ones near a current dated item.** See CLAUDE.md invariant 26. This is
   what makes a weekly reading block an actual study overview instead of
   a bare chapter-list line: once saved, `render` on a `WEEKLY_READING`
   item auto-pulls each week's chapters' real vocabulary/objectives into
   THIS WEEK. Source is the same material finding #4 already locates
   (chapter objectives doc, study guide) for lecture courses; for a
   self-paced/online course (ALEKS, etc.) it's that platform's own
   topic/objective breakdown per chapter -- same requirement either way,
   there's no "online courses skip this" carve-out (same reasoning as
   invariant 25 retiring the old online-async carve-out for reading
   items). **Never stop at a coarse category label** -- a Pie slice name,
   "Chapter 1," a module title -- always find and capture the real list
   underneath it. `completeness` gates on this two ways: `missing_
   chapter_topic_count` (once a course has any `WEEKLY_READING` items, a
   chapter with no saved row at all) and `partial_chapter_topic_count` (a
   row exists but hasn't been confirmed exhaustive -- see
   `chapter-topic-add --exhaustive` below) -- a course scan isn't done
   while either count is nonzero.

   **A platform's personalized/adaptive "what's next for you" view is
   never a substitute for its real, stable, complete structure.** This
   applies to any platform, not just one -- whenever a tool offers both a
   progress-dependent recommendation queue (changes based on what the
   user has already done -- ALEKS's "Ready to Learn" panel is one real
   instance of this shape, not the only possible one) and a stable
   structural view (a syllabus, table of contents, objectives report, or
   a toggle like ALEKS's own **View All Topics**), use the stable one.
   When it's unclear which view is which, reload it or check back later:
   the one that doesn't change is the structural one. Only pass
   `chapter-topic-add --exhaustive` once you've actually confirmed the
   captured list came from that stable view and is genuinely complete --
   leave it unset (the default) if capture might still be partial, so
   `completeness`'s `partial_chapter_topic_count` flags it for a future
   pass rather than it looking indistinguishable from a verified-complete
   chapter.

   **Where to actually find this, per course type** (real examples, all
   three courses in this project's own data, 2026-08-24 -- the ALEKS
   guidance below was itself revised 2026-08-25 after under-capturing
   MAT1340 this way; see CLAUDE.md invariant 26):
   - **A lecture course with a Chapter Objectives/study guide module**
     (BIO1112): already covered by required find #4 above -- open that
     module, pull the real, complete objectives/vocabulary list per
     chapter.
   - **A lecture course with slide decks but no separate objectives/study
     guide document** -- user-directed 2026-08-30, generalizing the same
     evidentiary allowance CLAUDE.md invariant 22 already makes for a
     lecture's own DETAILS ("lecture slide section titles" is explicitly
     listed there as valid source text) to `chapter-topic-add` as well:
     open that chapter's lecture slide deck (already located as part of
     required find #4/the "every lecture should link its slide deck"
     rule) and use its real section headers/slide titles as the chapter's
     `--objective` values. This is the fallback specifically for when no
     dedicated objectives doc exists -- if one does exist, prefer it (it's
     usually more complete than a slide outline); use the slide deck only
     when it's genuinely the best real source available, not as a shortcut
     when an objectives doc was just never looked for.
   - **An online/self-paced course with a per-module "Useful Links"
     page** (CHE1011): Content nav has a module per chapter-pair (e.g.
     "Module 1 Chapters 1-2"), and inside it a "Useful Links to
     understanding chapter content" sub-page with one expandable section
     per chapter -- each has a short instructor-written blurb plus a list
     of real, specifically-named videos/links (e.g. "Interactive Unit
     Conversions," "Sig figs and zeros," "Emission Spectrum of Hydrogen
     and Electron Energy Transitions"). Those link/video titles *are* the
     chapter's real topic list -- use every one of them as `--objective`
     values, don't just note "8 videos exist" or stop after a few.
   - **An ALEKS-based course** (MAT1340): launch ALEKS from its D2L
     "basic launch" link (`#external-courseware-platforms` below), open
     the **ALEKS Pie** view, click **ALEKS Pie Detail**, select a slice
     (e.g. "Algebra and Geometry Review"). **Don't use Ready to Learn** --
     it's the personalized/adaptive queue described above, and even a
     larger sample from it wouldn't fix that (it's progress-dependent, not
     the platform's stable structure). Instead use the Pie Detail page's
     own **View All Topics** toggle (or an Objectives/syllabus report if
     the course has one) to see the slice's real, complete, stable topic
     list -- capture the full list as `--objective` values, and capture
     any sub-grouping the view itself provides (a slice's own named
     sub-categories, if it organizes topics that way) as separate
     `chapter-topic-add` rows or as structure within the objectives rather
     than flattening everything to one undifferentiated list. Only pass
     `--exhaustive` once you've confirmed via View All Topics (or
     equivalent) that the captured list really is complete, not just
     larger than before. Matching an ALEKS slice to a D2L-stated chapter
     is a judgment call based on name similarity (e.g. D2L's
     "Prerequisite Review Topics" chapter -> ALEKS's "Algebra and Geometry
     Review" slice) -- state that mapping in the saved vocabulary text
     (e.g. `"ALEKS Pie slice A: Algebra and Geometry Review"`) so a future
     session can see exactly what was matched and why, rather than
     presenting it as an official D2L-stated fact. Note:
     `#quiz-exam-coverage----unit-summary-vs-specific-breakdown` below
     still legitimately allows a compact per-unit summary -- but only for
     a *rendered quiz/exam description*'s own coverage note, never as
     license to sample what gets captured here.

**Getting the D2L-side `href` without launching an LTI tool.** Before
deciding whether following a "Textbook"/"ALEKS"/similar External Learning
Tool link through is worth it, use `find` to locate the anchor element,
then `read_page` with that element's `ref_id` and `filter: "all"` -- the
tool returns the anchor's real `href` (the D2L launch URL) without
navigating the page at all. That's the fallback link (see finding #1
above). Actually clicking through is still worth attempting when you also
want the real outbound destination or need to read what's actually on the
far side (due dates, guidelines, topic sequence -- see "External
courseware platforms" below) -- just don't fight a hang indefinitely (see
"Getting unstuck" below) when all you needed was the link.

## External courseware platforms -- detect the link, not the tool name

A real incident, 2026-08-21: MAT1340's actual homework due dates and topic
progression lived entirely inside ALEKS. D2L Content listed it as a plain
nav item -- "Welcome: Start Here, ALEKS, Course Information..." -- with no
sentence anywhere saying "check ALEKS for due dates." Discovery saw it,
assumed "not date-bearing" from the tool's name alone, and never opened it.
See CLAUDE.md invariant 20 for the full incident and the architecture this
drives.

**Don't build or consult a list of known platform names.** ALEKS,
MyMathLab, WebAssign, Cengage, and whatever else existed at the time this
was written are not an exhaustive set, and a course using something not on
that list would silently recreate the exact same gap. Instead:

1. **While enumerating course nav/tools (part of the orientation pass
   above), notice any link whose destination leaves the LMS's own domain.**
   This is directly observable while browsing -- you can see the href, same
   as the "getting the real href" technique above -- and needs no name
   matching at all.
2. **Decide whether it's worth opening, using what's actually on the
   page**, not the tool's name: does the surrounding D2L text say or imply
   assignment/graded content lives there ("your homework is completed in
   ALEKS," a grade-category name matching the tool, a "Getting Started"
   walkthrough for it)? If the page context gives no clear signal either
   way, default to opening it anyway rather than skipping it -- a missed
   assignment platform is a worse failure than a few minutes spent on a
   page that turns out to be supplementary. Reserve asking the user for
   when it's still genuinely unclear *after* you've actually looked (e.g.
   it's login-walled with no D2L context at all about what it's for).
3. **If it's a plain external resource** (a textbook publisher's marketing
   page, a video platform, a general "about this tool" page) rather than
   somewhere assignments/due dates/grades live, it doesn't need crawling --
   note that finding in `raw_notes.md` and move on. This is a live judgment
   call, made once per tool per course, not a permanent rule to encode.
4. **If it hits a login wall, stop and tell the user**, the same
   stop-and-wait pattern already used for D2L's own SSO -- "This course
   uses `<tool>` for homework -- please log in in the opened tab" -- then
   wait. Some tools ride the LMS's SSO transparently and need no separate
   login; only interrupt the user when an actual credential prompt appears.
5. **Record the finding immediately, before you've necessarily crawled
   it**, via `uv run academic-sync unresolved-add --course <id> --kind
   external_reference_uninspected --description "..." --source-wording
   "<tool name as it appears in the source>"` -- this is what lets
   `completeness` gate on it (same tier as an unopened D2L area) instead of
   depending on this session remembering to mention it. Once you've
   actually opened and crawled it, record it as a real `Source` with
   `--source-type external_courseware --title "<tool name>"` -- adding that
   Source auto-resolves the matching `unresolved-add` finding (matched by
   title, see `db/repository.py::_auto_resolve_external_reference_
   uninspected`) as long as the title you use matches the `--source-wording`
   you recorded in step 5, so use the same name in both. If you determine
   it's not assignment-bearing (step 3), resolve it manually instead:
   `uv run academic-sync unresolved-resolve <ref_id> --note "opened, it's
   just <what it actually is>"`.
6. **Crawl it like any other source** -- due dates, guidelines/instructions
   text, topic sequence -- through the normal `extract --source-type
   external_courseware` path, same as any D2L page. Capture what you find
   in `raw_notes.md` too, same as everything else.
   **Find the tool's full list/table view, not just its dashboard.** Real
   incident, 2026-08-21: ALEKS's own Home dashboard shows a "Working
   Toward" widget of only the next few items -- reading just that widget
   would have missed two items entirely and mis-dated others, because it
   isn't the complete record. The Gradebook (18 rows) was the actual
   authoritative list, and cross-checking it against what was already
   synced surfaced two items dated a full week wrong, two off by a day, and
   one graded item (due tomorrow at the time) that had never been captured
   at all. Any tool with both a "what's coming up" summary and a full
   list/table/gradebook view: read the full view, and if anything is
   already synced for that course, diff the two rather than trusting
   either one blind.
   **A domain-permission failure on one action doesn't mean the domain is
   unreadable.** `computer`'s screenshot action came back "Permission
   denied" on aleks.com the first time it was tried, but `get_page_text`
   worked fine on the same page with no extra permission needed -- try text
   extraction before concluding a new domain is inaccessible.
7. **Deep-link into the platform; don't stop at its launch link.** This
   rule was added in the 2026-10-05 redesign and supersedes the older "a
   platform only exposes one generic launch URL, so link that" stance. The
   user should never have to navigate a platform to find the lesson,
   reading, or assignment. For every platform (ALEKS, McGraw Hill
   Connect, Pearson, and any you haven't seen before), find the **most
   specific stable URL** for each thing a banner, lecture, or deadline
   points at:
   - **Per-assignment LTI links in D2L Content.** Many courses add each
     platform assignment as its own D2L content item, a deep-linked LTI
     launch. That item's `viewContent` URL is stable and opens straight
     into that assignment. Prefer it to the generic platform tile.
   - **Per-lesson / per-topic / per-chapter URLs inside the platform:**
     ALEKS objective or topic pages, Connect/SmartBook chapter
     assignments, eBook chapter pages.
   - **Stability test (required):** open the URL in a fresh tab. It
     counts as stable only if it lands on that same specific page,
     possibly after the normal SSO hop. A URL with a session token, a
     one-time launch nonce, or a timestamp parameter is never stable. Use
     the next level up instead.
   - **When nothing deeper is stable,** link the most specific stable
     entry point and name the exact target in the label. Examples:
     `"ALEKS — Objective 4: Exponents (open from your ALEKS home)"`, or
     `"Connect — Ch 23 SmartBook assignment"`.
   - **Session-locked readers stop here.** Verified 2026-10-05 on
     MAT1340's McGraw Hill eBook, opened from ALEKS (Menu → Textbook →
     E-Book). It opens in a pop-up at
     `prod.reader-ui.prod.mheducation.com/epub/sn_<book>/data-uuid-<id>`,
     which looks per-location, but the same URL returns **401 "You do not
     have access to your eBook"** when opened in any fresh tab. Only the
     window ALEKS launches gets the access pass. ALEKS's own pages are
     one-time `Isl.exe/<token>` URLs. A reader like this can't be
     deep-linked, so the chapter's `--reading-url` is the platform's D2L
     launch item, labeled with the click path (e.g. `"ALEKS eBook — Ch 4
     (in ALEKS: Menu → Textbook → E-Book)"`). Add section page numbers to
     the label or `--section` values only if you can read them
     autonomously. Don't spend more than a couple of attempts, and never
     ask the user to do manual steps for this (user-directed: "just
     linking to the textbook in a situation like this is the best").
     Other platforms (Connect, Pearson, OpenStax) still get the full
     search and fresh-tab test.
   - Save what you find where it belongs:
     - a chapter's reading → `chapter-topic-add --reading-url`
     - lessons and objectives → banner `--links` with `"kind":
       "platform"`
     - an assignment's own launch → that item's `reference_url`
     - the platform's gradebook → `portal-link-set --kind
       external_gradebook`, used by `/daily-overview`

## Enumerate the actual course nav -- don't guess from a fixed list

D2L course navbars are configured per-course and don't always use the same
labels. Before working the crawl-priority list below, open the course home
page and read its actual navigation menu (`get_page_text` or `read_page`) to
see what areas really exist for *this* course -- "Content," "Course
Schedule," "Weekly Modules," "Lessons," and "Modules" are all names the same
underlying area might have. Treat the priority list as the areas to look
for, not literal link text to pattern-match against.

## Raw notes file -- write down everything before extracting

For each course, before running `academic-sync extract`, maintain
`data/downloads/<COURSE_CODE>/raw_notes.md`: a running, human-readable
transcript of everything found in each area, in prose, grouped by source
type. This is deliberately broader than what `extract` can turn into a
dated `AcademicItem` -- it exists so that topic outlines, special
instructions, policy notes ("no late work accepted"), and anything else
that doesn't cleanly become a calendar event is still captured somewhere,
not silently dropped because the extraction pipeline had nowhere to put it.
Update it as you go; don't try to reconstruct it from memory afterward.

For each area, record explicitly whether it was **opened and had content**,
**opened and was empty/unused**, or **not found in this course's nav at
all** -- three different findings, not one "nothing here."

When you later extract structured items, pass the relevant slice of these
raw notes as `source_wording` / the `details` argument to
`build_deadline_description` (see CLAUDE.md's "Calendar description
format" note and `#calendar-titles-and-descriptions` below) so the topic
and any special instructions actually reach the Calendar description --
not just the bare item title. Then use `academic-sync render <item_id>`
(see `#step-5-sync` in the skill / the CLI's own `--help`) to see the
*exact* text that will sync, rather than hand-typing the HTML template
from memory.

## Scanned/image documents -- 0 extracted characters is not "nothing there"

Some syllabi are scanned images with no text layer; `pdf_parser.parse_pdf`
will return 0 characters for these, and `extract` will correctly find 0
items -- but that is a parser limitation, not evidence the document is
empty. Before accepting 0 items from a downloaded PDF, check its extracted
character count. If it's 0 (or clearly implausibly low for the page count),
view the PDF as an image / screenshot it and transcribe it visually into
`data/downloads/<COURSE_CODE>/<source_type>/<filename>.transcribed.txt`,
then feed that transcription through `extract` as a plain-text source
instead of relying on the PDF parse.

**Word/PowerPoint instructor materials (chapter objectives, study guides,
lecture slides) -- the project has no `.docx`/`.pptx` parser yet.** Only
PDF and HTML are handled by `academic_sync.parsers` today. Downloading one
of these files requires the user's explicit permission first (state the
filename, source, and size, and wait for a clear yes -- this is a real,
general rule, not specific to this project). Once permission is given and
the file is downloaded: try opening it through a viewer that renders real
text you can read with `get_page_text` (D2L's own inline preview if it
offers one, or a web-based Office/Google Docs viewer) before falling back
to a visual screenshot transcription. Either way, save whatever text you
recover as a sibling `<filename>.transcribed.txt` next to the download and
feed *that* through `extract` as a plain-text source, same as the scanned-
PDF case above -- don't attempt to add real `.docx` parsing inline in the
skill; if this becomes frequent enough to be worth a real parser, that
belongs in `src/academic_sync/parsers/` as a proper, tested module, not
ad-hoc extraction logic invented at scan time.

## Sanity check before calling a course's scan final

After crawling, before treating a course as ready for `plan`/`sync`, ask the
question that matches this course's `delivery_format` (see
`#orientation-pass----do-this-first-for-every-course-before-the-deep-crawl`):

- **In-person or hybrid component**: does raw_notes actually contain a
  recurring lecture (and lab, if applicable) meeting pattern with
  days/time/room? If items were extracted but that pattern is nowhere in
  raw_notes, that's the same shape of gap as the BIO1112 lecture miss.
- **Online or async component**: does raw_notes actually contain that
  course's week-by-week/module-by-module schedule equivalent -- and does
  every dated item from that period carry a `module_label` sourced from it?
  A course with real dated items but no such schedule ever located in
  raw_notes, or items with a date but no nesting even though the schedule
  *was* found, is the same shape of gap, just in the async case (see
  `#required-finds`). "This course doesn't meet in person" is not a reason
  to skip this check -- it's the reason to ask the online-specific version
  of it instead of skipping it.

Either way, if the answer is no, go back to Content/Modules and the
Calendar before calling the scan done, even if `completeness` already
reports a plausible-looking item count.

## Per-course crawl priority

Not every linked page is worth opening. Prioritize, in roughly this order:

1. **Syllabus** (often a Content topic, sometimes a standalone link) --
   almost always the highest-density source of dated obligations and the
   best place to find instructor contact info, meeting patterns, and grading
   policy context.
2. **Course Calendar** (D2L's own calendar tool, if the instructor uses it)
   -- when populated, this is usually the most reliable, structured date
   source available and should be treated as a direct/operational source in
   precedence terms (see `docs/architecture.md#reconciliation-and-precedence`).
3. **Content / Modules** -- walk module-by-module; look for schedule pages,
   handouts, and any module explicitly named "Schedule," "Course Info," or
   similar.
4. **Dropbox (Assignments)** -- each assignment's own page usually has the
   authoritative due date/time, which should win over a vaguer syllabus
   mention of the same deliverable.
5. **Quizzes** -- same reasoning as Dropbox; also where pre-lab-quiz
   evidence actually lives (see CLAUDE.md invariant 7 -- don't fabricate
   these from a syllabus generality).
6. **Discussions** -- check for due dates on discussion topics if the
   syllabus references graded discussion participation.
7. **Announcements** -- scan recent announcements for explicit date changes
   ("the midterm has been moved to..."); these carry the highest precedence
   for a date they explicitly override (see `reconciliation/precedence.py`).
8. **Checklists** -- if present, often mirror assignment/quiz due dates;
   useful as corroboration, lower priority to crawl first.

Follow course-internal links liberally within these areas. Do **not**
recursively download every linked file sitewide -- skip navigation chrome,
unrelated course-tool configuration pages, and anything not plausibly
containing scheduling information (see the keyword list in the original
project brief: syllabus, schedule, assignments, quiz, exam, midterm, final,
lab, due, deadline, module, week, unit, handout, etc. -- if a link's text
matches none of these and isn't an obvious content page, it's probably not
worth opening).

## Be thorough about *where* you look, efficient about *how much* you open

These pull in opposite directions and both matter -- don't over-correct
either way:

- **Thorough**: don't stop at the first source that "looks complete enough."
  See `#mandatory-minimum-crawl` above -- Calendar and Content/Modules must
  both actually be opened, not assumed absent.
- **Efficient**: within a course, prefer the handful of pages that are
  *information-dense* over opening every individual item. A single syllabus
  schedule table or a "Course Schedule(s)" page giving date+topic for every
  week in one screen is worth far more than clicking into 25 individual
  per-lecture Content topics that just restate the same dates one at a
  time. If a Content module lists N sub-topics but a schedule/syllabus page
  elsewhere already gives date+topic for all N, that's a signal you've
  already got the information -- opening the N pages individually is not a
  more-thorough version of the same crawl, it's redundant per-item digging
  that burns turns for no new data. Note in raw_notes.md when you made this
  call and why (e.g. "did not open the 27 individual Lecture Materials
  topics -- the syllabus schedule table already gives date+topic for each").
- When a page turns out to be paginated/tabular and information-rich (a
  full-term schedule, a reading list), read the *whole* table before moving
  on -- that single page is exactly the kind of source worth spending a few
  extra scroll+screenshot round trips on, in exchange for not needing to
  open dozens of smaller pages afterward.

## Getting unstuck without stopping to ask (and without burning tokens on it)

This is not a D2L-specific problem, even though every concrete example
below happens to be from D2L: **any** LMS's embedded/cross-origin content
(LTI-launched tools, iframed courseware, a "gradebook" or "syllabus" widget
that's really a third-party app rendered inside the page) can leave a
browser tab's script execution hung -- `get_page_text`/screenshot/scroll
calls start timing out with "page still loading" or "script injection
timed out" even after waiting, and they keep failing until the tab itself
is abandoned. Treat this as a standing hazard of browser-controlled LMS
work in general, not a one-off fluke tied to this institution. Don't stall
on it and don't stop to ask the user for help over a hung page -- resolve
it yourself, and resolve it *cheaply*:

1. **One retry, not several**: `navigate` to the exact same URL again (a
   fresh load sometimes breaks the stuck script). If that one retry still
   times out, stop retrying the same tab -- don't alternate between
   screenshot/get_page_text/wait hoping a different tool will somehow
   succeed where the others failed. They share the same underlying page
   process; if one is hung, they all are, and cycling through them one at
   a time just spends tool calls to learn the same fact repeatedly.
2. **Straight to a fresh tab**: open a brand-new tab (`tabs_create_mcp`)
   and navigate there instead of the same URL -- a tab's state can degrade
   (especially after several LTI/iframe launches) in a way a reload alone
   doesn't clear. Close the old tab once the new one is confirmed working.
   This is the fast path; don't treat it as a last resort after many
   retries -- one failed retry is enough justification to jump straight
   here.
3. **Prevent the hang instead of recovering from it, when you can**: if all
   you actually need is a link's destination (not to read that
   destination's content), don't click through an External-Learning-Tool-
   style link at all -- `find` the anchor and `read_page(ref_id,
   filter:"all")` to read its real `href` without navigating anywhere (see
   `#required-finds`). This sidesteps the hang risk entirely rather than
   triggering it and then recovering, and is both faster and cheaper.
4. **A page that renders visually but stays invisible to `get_page_text`/
   `read_page`/`find` is the same failure, not a different one** -- treat
   it as hung and apply the same ladder above. Real incident, 2026-08-21:
   MAT1340's Simple Syllabus "Topical Outline" page visibly rendered a real
   layout on screenshot (sidebar, headings, content) but `get_page_text`
   returned only chrome/nav boilerplate, `find` couldn't locate its own
   sidebar links, and clicks/scrolls inside it had no effect at all --
   across a reload retry *and* a fresh tab. That's still "two failed
   attempts, move on," even though nothing ever technically timed out.
   Don't keep trying more tools against a page like this hoping one will
   somehow read it; the accessibility tree being disconnected from the
   visible pixels is itself the hang.
5. If a specific widget/page is hanging on *every* attempt (one retry +
   one fresh-tab attempt) and isn't the actual mandatory-crawl target (e.g.
   a flaky "Simple Syllabus" iframe when you already have the data you
   need from elsewhere), it's fine to move on and note the gap in
   raw_notes.md rather than keep fighting it -- exhaustiveness is about not
   skipping *areas*, not about guaranteeing every individual page renders
   on the first pass. Two failed attempts total (not two *per tool*) is
   the right threshold to stop and move on.
6. A course-selector/waffle-menu dropdown reachable from a *working* page
   is more reliable for finding a course's D2L id than the org-level
   homepage dashboard, which was the most consistently flaky page observed.

## Going faster on a large remaining scrape: content API, real hyperlinks, parallel windows

Efficiency techniques for cutting wasted round trips once you already know
*where* you need to look -- none of them relaxes anything above (still
never construct/guess a URL, still open every required area).

- **Read the whole Content tree in one call via D2L's own API** (added
  2026-09-01, after a lecture/banner resource-link pass). Brightspace
  exposes the full table of contents as JSON at
  `/d2l/api/le/1.<x>/<orgUnitId>/content/toc` (e.g.
  `/d2l/api/le/1.60/665290/content/toc`) -- run it with
  `javascript_tool` (`await fetch(url, {headers:{Accept:'application/json'}})`)
  from any page on that course. It returns every module and topic with
  `Title`, `TopicId`, `ModuleId`, and `TypeIdentifier` (`File` / `Link` /
  `ContentService` / `WebPage` ...), recursively -- so one call replaces
  dozens of SPA clicks when you need to enumerate slide decks, handouts,
  chapter objectives, guided readings, lecture-video sub-modules, etc.
  Each topic's stable URL is
  `https://<host>/d2l/le/content/<orgUnitId>/viewContent/<TopicId>/View`;
  a whole module deep-links as
  `.../content/<orgUnitId>/Home?itemIdentifier=D2L.LE.Content.ContentObject.ModuleCO-<ModuleId>`.
  These *are* URLs read off real markup (the API response), not
  constructed guesses -- the id comes from D2L, only the fixed
  `viewContent/.../View` and `ModuleCO-` wrappers are boilerplate. A
  `Link`-type topic's own external target is often redacted by the
  browser tool's security layer; link the D2L `viewContent` page for it
  instead (it presents/redirects to the target), or open it once and read
  where it lands. Still open the actual pages you need the *content* of --
  this only replaces the enumeration crawl, not reading.

Two more techniques, added 2026-08-25 after a live MAT1340 chapter-topic
re-capture spent most of its time on `find`-Next-click-wait cycles and
sequential single-tab navigation:

- **Navigate by real hyperlink, not by clicking Next.** Once you've opened
  a course's Table of Contents (or any other index page) and read it via
  `read_page` (not `get_page_text`, which drops `href`s), you have every
  remaining content item's real `viewContent/<id>/View` URL up front.
  Prefer `navigate`-ing straight to that URL over the `find`-the-Next-
  arrow -> click -> wait -> re-`find` dance for each subsequent page --
  it's fewer tool calls per page and sidesteps the stale-ref failure mode
  (a `Next` link ref captured before an intervening navigation silently
  no-ops on click, see the incident log below `#required-finds`). The
  hard rule this doesn't relax: only ever navigate to a URL you actually
  read off the page's own markup -- **never construct or guess one**, even
  when sibling IDs look sequential. If the index page doesn't give you a
  direct link (some LMSs really don't), fall back to Next-arrow clicking
  as before.
- **Split independent remaining work across parallel browser
  windows/tabs -- but verify tab isolation before trusting anything a
  `computer` action captures.** When a scrape has multiple remaining
  chunks that don't depend on each other (e.g. three more chapters of the
  same course, or three different courses), don't work them in one long
  sequential chain in a single tab. Hand each chunk to its own `Agent`
  fork (forks share your conversation context, so a fork doesn't need the
  scraping methodology re-explained, only the concrete URLs/scope for its
  chunk and the exact local save command to run when done) working in the
  background while you continue with another chunk.

  **Real incident, 2026-08-25**: this extension's browser tabs are not
  hard-isolated per agent. `tabs_create_mcp`/`tabs_context_mcp` can hand
  back a tabId whose underlying tab has been silently reassigned to (or
  clobbered by) a *different* concurrently-running fork, and -- more
  importantly -- `computer` actions that operate on pixels (`screenshot`,
  `left_click`, keyboard `key` presses) act on whatever tab currently has
  real OS-level focus, not necessarily the tabId the calling agent thinks
  it's addressing. Two agents (the coordinator and a fork, or two forks)
  scrolling/screenshotting around the same time can silently steal each
  other's focus -- a screenshot can come back showing a completely
  different section's page than the one just navigated to. This was
  caught only because the visible chapter/section breadcrumb in the
  screenshot didn't match what was expected -- it would NOT have been
  caught by anything tabId-based, since the tool happily reports success
  against a tabId whose content no longer matches what that agent
  navigated it to.

  Mitigations, all required when running more than one browser-driving
  agent concurrently:
  1. Each agent should call `tabs_context_mcp({createIfEmpty: true})`
     itself before starting its chunk, to request its own group, and
     should treat any tabId as unverified after any gap in activity
     (another tool round, a wait, anything that could let a different
     agent act in between) -- re-open `tabs_context_mcp` and cross-check
     the returned title/URL against what's expected before trusting a
     `computer` action's result.
  2. After every `screenshot`, confirm the visible page breadcrumb/title
     actually matches the section you intended before recording anything
     from it as real content -- never assume a successful tool call means
     it hit the intended tab.
  3. `navigate` is genuinely tabId-addressed and safe to use freely even
     with multiple agents active. **Text-extraction tools are a different
     story -- don't write them into guidance as something to expect to
     work.** `get_page_text`/`read_page`/`find` are worth one cheap try
     per page (they're fast when they do work), but whether they reach a
     given page's real content is inconsistent across sites and even
     across pages on the same site -- confirmed failing, same session,
     same course: `get_page_text` on a MAT1340 `viewContent` page
     returned only chrome/nav boilerplate, not the iframed lesson content,
     for every section tried. A same-origin `javascript_tool` read of the
     iframe's own DOM (`document.querySelector('iframe').contentDocument
     .body.innerText`) was also tried as a workaround and is a dead end,
     not a fallback to reach for: the returned string got blocked outright
     by a content-safety filter on this specific tool (unrelated to
     whether the technique itself is sound) -- don't spend a future
     session's turns re-attempting it. The only technique confirmed
     reliable across every rendering mode seen so far is the pixel-based
     one documented earlier (`#working-with-an-unfamiliar-lms-or-page-format`):
     screenshot, then scroll/click/arrow-key through the visible page,
     re-screenshotting to confirm real content appeared. Try a text tool
     first since a hit is cheap, but verify the returned text is actually
     page content (not just nav chrome) before trusting it, and fall back
     to the pixel-based method immediately rather than retrying the same
     text tool or investing time in a DOM-read workaround.
  4. Before any `chapter-topic-add`-equivalent save, if more than one
     browser-driving agent was active around the same time, re-verify the
     content about to be saved against a fresh, isolated re-read of the
     source page rather than trusting anything captured mid-collision.
  Give each fork a disjoint set of pages regardless, so there's no risk of
  two streams re-deriving (and possibly disagreeing on) the same chapter.
  This is purely a wall-clock optimization -- every other rule in this
  document (exhaustive capture, real hyperlinks only, no fabrication)
  applies identically inside a fork.

## What to download vs. read inline

- HTML pages: read the rendered text directly (`read_page`/`get_page_text`)
  rather than downloading; then hand the text to
  `academic_sync.parsers.html_parser.parse_html` (or, more simply, wrap it
  as `ParsedDocument(text=..., ...)` if it's already plain text) before
  calling `extraction.pipeline.extract_from_document`.
- Linked PDFs (syllabi, handouts): download to
  `data/downloads/<COURSE_CODE>/<source_type>/<filename>` (gitignored) --
  one subfolder per course, and within it one subfolder per source type
  (`syllabus/`, `quizzes/`, `calendar/`, `schedule/`, `dropbox/`, etc.),
  e.g. `data/downloads/BIO1112/syllabus/Bio1112 Syllabus.pdf`. Use the
  human-readable course code (`BIO1112`), not the opaque course id, so the
  folder tree is browsable on its own. Then run
  `academic_sync.parsers.pdf_parser.parse_pdf` on it, or just call
  `academic-sync extract <path> --course <id> --source-type <type>` from
  the CLI (the CLI command still takes the course *id*, not the code --
  only the folder path uses the code).
- Always record retrieval timestamp, and the D2L page's own "last modified"
  timestamp if D2L exposes one for that content type, so `Source` provenance
  is complete.

## Calendar titles and descriptions

Information-dense, cleanly structured, never padded. `build_title`/
`build_deadline_description`/`build_meeting_description` in
`sync/calendar_payload.py` are the single source of truth for this shape --
don't hand-roll a different format when constructing a `create_event` call
by hand; match these exactly.

### Titles

- **In-person meetings**: `CODE (Section N) Label — Topic`, e.g.
  `BIO1112 (Section 175) Lecture — Chapter 22: Descent with Modification`.
  Matches the user's own pre-existing convention (their real
  "BIO 1111 (Sections 151/152) Lecture — Chapters 2 and 3: ..." events).
  Section is included whenever the course has one (a student juggling
  multiple sections needs it at a glance); the em dash separates the topic
  rather than trailing parens. **Every lecture/lab/recitation/seminar
  meeting must carry a topic when one exists in the source** -- if
  discovery found a schedule with per-session topics (the common case, see
  `#mandatory-minimum-crawl`), every meeting event should have one; a
  meeting with no topic string should be the exception (a session the
  source genuinely didn't name), not the default.
- **Deadlines**: `CODE Title Due`.
- **Optional/extra-credit items**: append ` (Optional)` to the end of the
  title (after "Due" for deadlines, after the topic for meetings) -- see
  `AcademicItem.is_optional` below.

### Weekly reading blocks

User-directed change, 2026-08-24: reading/topic content no longer syncs as
a per-day standalone all-day item at all (that mechanism -- `ItemType.
READING` syncing directly, one event per source line -- is retired; see
CLAUDE.md invariant 25). It now reaches Calendar two ways, both required,
neither optional:

1. **Fold same-day matches into the covering lecture's own DETAILS.**
   Unchanged from before: when a lecture and a same-day reading genuinely
   cover the same chapter(s), the reading's content belongs in that
   lecture's TOPIC/MODULE/DETAILS, not a second entry. Real feedback,
   2026-08-21: BIO1112 was syncing both a lecture event *and* a same-day
   all-day "Chapter 22: Descent with Modification, cont" reading item --
   pure duplication, since the lecture's own title already said exactly
   that.
2. **Everything for that course that week -- lined up with a lecture or
   not -- also goes into that course's `WEEKLY_READING` block.** One
   all-day event per course per real reading week, spanning
   `[week_start, week_end]` (see required find #5 above for where those
   dates come from), titled `"<CODE> Weekly Overview"` (superseded
   2026-08-25 -- previously `"<CODE> Readings (<date range>)"`; the date
   range now lives in the description's own DATES section instead, the
   last section, right before the fingerprint tag). Build it with:

   ```
   academic-sync weekly-reading-add --course CODE \
     --week-start YYYY-MM-DD --week-end YYYY-MM-DD \
     --chapters "Chapter 12: Cellular Respiration; Chapter 13: Photosynthesis" \
     [--reference-url ... --reference-url-label ...] \
     [--resource-url ... --resource-url-label ...]
   ```

   `--chapters` is the exact chapter/topic content for that week -- same
   "trace to real instructor material" bar as a lecture's DETAILS (CLAUDE.md
   invariant 22), same `"Chapter N: Topic"` shape a multi-chapter lecture
   title already uses. Then run `render <item_id>` (same command/flow as
   any other item) to get the exact Calendar payload.

   **The banner is the course shell for that week -- user-directed
   redesign, 2026-10-05.** GPT teaching mode was retired. The student now
   learns from the real curriculum, so the banner has to list every
   reading for the week and link straight to each one. Layout (built by
   `render`; never hand-typed):

   ```
   BIO1112 - General Biology II
   READING
     Chapter 23 — Evolution of Populations
     Big topics: 23.1 Genetic Variation · 23.2 Hardy-Weinberg · 23.3 Drift
     → Textbook — Ch 23 reading            (chapter-specific link)
     (next chapter ...)
   SLIDES & RESOURCES                       (slides → video → handouts → platform → other)
   TOPIC DETAIL                             (every saved objective + vocabulary, never summarized)
   CONTACT · DATES
   ```

   **What discovery must capture for every chapter** (required find #6
   plus this redesign). All of it is saved once with `chapter-topic-add`,
   and every banner and lecture covering that chapter reuses it:

   - `--section` (repeatable): the chapter's **real section headings**
     (textbook "23.1 Genetic Variation", a module page's own
     sub-headings, ALEKS objective names). These become the "Big topics"
     line. They are structure taken from the source, never a summary you
     wrote (invariant 22).
   - `--reading-url` / `--reading-label`: the **chapter-specific reading**
     -- the eBook's chapter page, a D2L content topic holding that
     chapter's reading, the publisher's per-chapter assignment link, or
     the OpenStax chapter.
     - Search deeper than the course's "Textbook" launch link: open the
       eBook or platform, navigate to the chapter, and confirm the URL
       reopens that chapter in a fresh tab (see
       `#external-courseware-platforms----detect-the-link-not-the-tool-name`
       step 7).
     - Only when no per-chapter URL exists after a real search, put the
       platform's entry point on the banner as a textbook-kind
       `weekly_links` entry. Its label names the chapter, e.g. `"Connect
       eBook — open Ch 23"`.
   - `--objective` / `--vocabulary`: unchanged. The full list renders
     under TOPIC DETAIL, and the GPT quiz system builds its question pool
     from it. A long list is truncated at the line level with a visible
     note; the full capture always stays local.

   **`--links` carries everything else for the week**, each with a
   `kind`:

   ```
   --links '[
     {"label": "Lecture video - Ch 23", "url": "https://...", "kind": "video"},
     {"label": "Slides - Ch 23", "url": "https://...", "kind": "slides"},
     {"label": "Hardy-Weinberg worksheet", "url": "https://...", "kind": "handout"},
     {"label": "ALEKS — Objective 4: Exponents", "url": "https://...", "kind": "platform"},
     {"label": "Textbook - Ch 24", "url": "https://...", "kind": "textbook", "chapter": "Chapter 24"}
   ]'
   ```

   - `kind` is one of `textbook | slides | video | handout | platform |
     other`.
   - `textbook` links render under READING. One with a matching
     `chapter` goes under that chapter when the chapter has no saved
     `reading_url`.
   - Every other kind renders under SLIDES & RESOURCES, grouped in that
     order.
   - Links saved before 2026-10-05 have no `kind`, so they are
     classified from their label (`calendar_payload.link_kind`).
   - Set links with `weekly-reading-add --links` or `render <id> --links
     '[...]' --save`.

   **Never a syllabus link.** A syllabus states *that* a chapter is due,
   not the reading itself. Its URL stays internal (a `Source` row), and a
   syllabus link is dropped at render time even if one slips in
   (`_looks_like_syllabus`). An absent resource is an honest gap; don't
   pad it with a course-home link.

   There is **no PACING section** (removed 2026-10-07). List the whole
   week's material, including anything the instructor marks "work ahead".
   `render` adds DATES automatically.
   Then do create_event/update_event + `record-sync`, the same Step 5 flow
   as any other item. Changing a `ChapterTopic` doesn't flag already-synced
   banners for re-push by itself (chapter topics aren't item fields), so
   after updating chapter data, re-render and push the banners that cover
   it.

This does **not** relax CLAUDE.md invariant 15's "don't miss anything" --
every course, including an online/async one with no meetings at all, still
gets its reading content on the calendar; it's just one week-spanning block
per course instead of a same-day standalone item per reading. Because the
weekly block already covers every course unconditionally, the old
online-async/non-meeting-day/diverging-pace carve-outs for keeping a
standalone item no longer apply -- there is no case where a plain `READING`
item syncs on its own anymore (`sync/calendar_payload.py::
build_event_payload` raises if you try).

When you do consolidate, the reading item's chapter/topic content becomes
part of the lecture's own DETAILS breakdown (see
`#content-depth----link-and-quote-instructor-material-never-synthesize`
below) rather than disappearing -- and no separate `AcademicItem` gets
created for it in the first place, so there's nothing to later reconcile
away.

### Calendar description length budget

Google Calendar's event `description` field has a real limit, roughly
**8,192 characters**
([Nylas: Event Description Limits](https://support.nylas.com/hc/en-us/articles/10571467644957-Event-Description-Limits-in-Google-Calendar-and-Microsoft-Exchange)).
Required find #6's exhaustive chapter-topic capture (above) has no cap --
`ChapterTopic.objectives` stores everything real that was found, however
long -- but a single Calendar description can't always hold all of it once
a chapter genuinely has hundreds of real topics (an ALEKS slice, for
instance).

`sync/calendar_payload.py::DESCRIPTION_CHAR_BUDGET` handles this
automatically -- you don't need to do anything differently at capture or
render time. If a rendered description would exceed the budget, only the
large, variable-length content block (THIS WEEK for a `WEEKLY_READING`
item, DETAILS for anything else) gets truncated, at a safe boundary,
with a visible note stating how many real captured lines were left out
(e.g. `"+140 more captured line(s) not shown here for length -- full list
saved locally (chapter-topic-add / academic-sync render)."`). The small,
always-wanted sections -- header, MODULE, CONTACT, LINKS, DATES -- are
never the thing sacrificed; they're always fully included. This is never silent and never a fabricated summary standing in for the
cut content -- the full exhaustive list still exists in the local
`chapter_topics` table exactly as saved via `chapter-topic-add`, it's
just `render`'s own printed/Calendar-bound description that gets
truncated, not the underlying capture. If you notice a description got
truncated, that's expected and fine -- it doesn't mean capture was
insufficient, it means capture was thorough enough to hit a real platform
wall.

### Descriptions

**Calendar event descriptions are real HTML** (confirmed by directly
creating a test event and inspecting both the raw API response and the
rendered popup in the Calendar UI on 2026-08-18) -- `<b>`, `<br>`, and
`<a href="...">text</a>` all render correctly: bold headers, real line
breaks, and clickable labeled links instead of bare URLs. `_section()` in
`sync/calendar_payload.py` builds each header as `<b>LABEL</b><br>value`;
literal `\n` characters do **not** reliably produce line breaks once the
field is being interpreted as HTML, so always join with `<br>`/`<br><br>`,
never bare newlines, if you're constructing a description by hand instead
of calling the builder functions.

One shared shape from both description builders: an optional `UNGRADED`
tag (see below), then a plain header line, then bold-headed sections in a
fixed order, each included **only** when the source actually had that
information. `TOPIC` and `MODULE` come first,
deliberately repeating information already in the title/nesting -- see
CLAUDE.md invariant 17/18 for why (2026-08-18: items were syncing with no
nesting shown anywhere because nesting used to live only in a header
parenthetical that most call sites never populated):

```
UNGRADED             <- only when the source explicitly marked this item
                         optional/extra-credit/ungraded/for-practice
                         (AcademicItem.is_optional) -- the ONE thing that
                         can precede the header. Nothing at all for the
                         ordinary graded case (CLAUDE.md invariant 27).

CODE - Course Name

TOPIC               <- both builders; the item's own title, repeated here
HW: 1.3                 so the description reads standalone (e.g. in an
                         agenda view where the title isn't shown alongside
                         it) -- deliberate redundancy with the summary/title

MODULE               <- both builders, when a real module/chapter is known;
D2L — Chapter 1...       this is `nesting`, sourced from `item.module_label`
                         by default (see CLAUDE.md invariant 18) -- a
                         required find per #required-finds above, not
                         optional context. Prefixed with where it actually
                         lives -- "D2L" or the real external tool's own
                         name (see `#external-courseware-platforms----
                         detect-the-link-not-the-tool-name`) -- computed
                         from the item's Source via
                         `platform_label_for_source`, never assumed to be
                         D2L (CLAUDE.md invariant 20). Omitted entirely
                         (bare nesting, no prefix) when the source is one
                         `platform_label_for_source` can't resolve to a
                         known platform.

DETAILS             <- real special instructions actually found (submission
Submit via ...          method, attempt limits, format requirements) or a
                         brief one-line summary of what the item covers --
                         never generic filler like "read the chapter" or
                         "see D2L for details" when nothing real was found

LOCATION             <- meetings only, when known
E112

REQUIRED RESOURCES    <- deadlines only, when known
Calculator required

CONTACT
Instructor Name — email

LINKS               <- clickable labeled links, see #links below -- never
Assignment            raw URLs
Textbook (Ch. 6)
```

(Each label above is bold and its value is on the next line; blank lines
separate sections, per `<br><br>` between blocks.) **No SOURCE section** --
provenance (`source_wording`, the `Source` table row(s)) stays in the local
database for the pipeline's own validation that a real source backs every
item; the user explicitly does not want it cluttering the visible event, so
it is deliberately never rendered. If you want to double-check that an item
is well-sourced, query the database (`Source`/`source_ids`), don't put it
in the Calendar description.

A missing field is an **omitted section**, never a placeholder like "Not
provided" and never a guessed value. This replaces an earlier, messier
style seen in some already-synced events -- literal D2L navigation
breadcrumbs ("D2L (MyCourses) -> BIO1111 section -> Assignments
(Drop-box)...", "Submission/Pathways: D2L -> Quizzes") -- that was verbose
without being more useful; a labeled `reference_url` link that goes
straight to the actual page replaces that entirely.

### Content depth -- link and quote instructor material, never synthesize

The user's explicit goal for this level of detail: enough real substance in
each event that they (or a study tool they build on top of it later) can
know exactly what to review without opening D2L again. That means DETAILS
content has to trace back to something an instructor actually wrote --
a chapter objectives document, a study guide, a syllabus topical outline,
lecture slide section titles -- the exact same evidentiary standard
CLAUDE.md invariant 1 already applies to dates, now applied to *content*:
if you can't point to the literal text a real instructor-authored source
gave, don't put it in DETAILS. Never generate a plausible-sounding summary
of what a chapter "probably covers" from general subject knowledge -- that
is fabrication with better prose, not enrichment, and it's exactly the
kind of content a student can't trust enough to actually study from.

**TOPIC format -- spaced, one block per chapter, matching the user's own
edited example** (a real BIO1112 lecture event, edited by hand on
2026-08-21 to demonstrate the wanted shape):

```
TOPIC
Chapter 22:
Descent with Modification, cont.;

Chapter 26:
Phylogeny and Classification
```

i.e. `"Chapter N:<br>Topic name;<br><br>"` per chapter (semicolon after the
topic name, blank line between chapters), not one run-on sentence. This
comes from `_topic_line` in `sync/calendar_payload.py` automatically
whenever `item.title` itself uses the `"Chapter N: Topic; Chapter M: Topic"`
shape -- nothing to hand-type here.

**DETAILS format -- labeled sub-groups via `render --details-blocks`, not
hand-typed HTML.** Superseded 2026-08-24: this section previously showed a
hand-typed `"- bullet"` example for `--details` directly; that's exactly
the kind of formatting logic CLAUDE.md says belongs in tested code, not a
skill hand-typing HTML per call (the same reasoning `render` itself exists
for). Use `--details-blocks` with a JSON array of
`{"label": ..., "text": ...}` / `{"label": ..., "items": [...]}` objects
(`sync/calendar_payload.py::DetailsBlock`/`format_details_blocks`) --
each real, distinct piece of content (a vocabulary list, an objectives
sentence, a per-chapter breakdown, an in-class activity note) becomes its
own labeled block, with `items` rendering as one "•" bullet line each
instead of a semicolon-chained run-on sentence:

```
academic-sync render <item_id> --details-blocks '[
  {"label": "Vocabulary", "text": "microevolution, genetic variation, ..."},
  {"label": "Objectives", "items": [
    "Explain the major processes that generate genetic variation",
    "State the Hardy-Weinberg theorem of genetic equilibrium"
  ]},
  {"text": "Activity: Reading Evolutionary Tree Diagrams"}
]'
```

A lecture spanning multiple chapters, each with its own real objectives,
gets one block per chapter (`{"label": "Chapter 22: Descent with
Modification", "items": [...]}`, `{"label": "Chapter 26: ...", "items":
[...]}`) -- same effect as the old per-chapter shape, just built by tested
code instead of hand-typed. Prefer an em dash over a colon inside a
chapter-label used this way (`"Chapter 22 — Descent with Modification"`)
since `format_details_blocks` already appends its own trailing colon after
the label.

Every `items`/`text` value must still trace to real instructor-authored
text (a chapter objectives document, a study guide, lecture slide section
titles) -- `--details-blocks` only changes *presentation* (splitting the
source's own delimiters into bullet lines), never what counts as
real content. Never generate a plausible-sounding summary of what a
chapter "probably covers" from general subject knowledge -- that is
fabrication with better prose, not enrichment, and it's exactly the kind
of content a student can't trust enough to actually study from. Plain
`--details` (a single string, no JSON) is still fine for a short
single-paragraph case that doesn't need sub-grouping.

If no instructor-authored breakdown exists for a chapter (nothing beyond
the schedule's own chapter-level title), DETAILS for that chapter stays at
whatever depth is genuinely available -- a one-line real description (a
plain `--details` string, or a single label-less block) is still correct;
an invented multi-bullet breakdown is not. Record in `raw_notes.md` when a
chapter has no deeper source available, so a later pass knows that's a
confirmed absence, not an unchecked gap.

### Every lecture links its own real materials -- not the syllabus, not the textbook's bare table of contents

User-directed 2026-09-01 (CLAUDE.md
invariant 25, second amendment): a lecture event is not limited to the two
`reference_url`/`resource_url` slots -- it uses the same `weekly_links`
list a weekly banner does. Once you've located the course's Lecture
Slides/Materials module and any handout/activity area (`#required-finds`,
finding 4), pass `render <id> --links '[{"label","url"},...]' --save` a
JSON array of that session's own resources, in priority order:

- its **specific slide deck(s)** for that lecture's chapter(s) -- the
  per-session file when one exists, otherwise the per-chapter deck;
- any **handout / in-class activity / worksheet** tied to that lecture
  (e.g. a "Hardy-Weinberg Practice Problems" doc for the Ch. 23 lecture,
  a "Radiolab Fungi" listening guide for the Ch. 31 lecture) -- label it
  `"Handout: <name>"` or `"In-class activity: <name>"`;
- a **professor recording** for that session if the course has one
  (Panopto/Zoom/Kaltura -- many in-person courses have none, that's a
  real absence, not a gap to pad);
- the **textbook reading** for that lecture's chapter(s): reuse the same
  URL saved on the chapter (`chapter-topic-add --reading-url`, which the
  weekly banner also links), with `"kind": "textbook"`. Fall back to the
  textbook's general access point, with the chapter number in the label,
  only when no per-chapter URL exists after a real search.

Omit any of these that genuinely doesn't exist. NEVER the syllabus, and
never the textbook's front-matter/table-of-contents page as a stand-in
for the actual chapter (a syllabus-labeled link is stripped at render
time regardless). Deadline-type items (assignments/quizzes/exams) don't
use this list. They have fixed slots: `reference_url`, `resource_url`, and
(since 2026-10-05) `submission_url` for a separate turn-in location (see
`#links`).

### Quiz/exam coverage -- unit summary vs. specific breakdown

Same never-synthesize rule as above, applied to assessments, with the
level of detail matched to how broad the assessment actually is (pull the
distinction from what the syllabus/quiz description itself states about
scope, don't infer it from the assessment's name alone):

- **Broad-coverage assessments** (a midterm/final spanning multiple
  units/chapters): a compact per-unit summary line is enough --
  `"Units covered: Unit 1 (Algebra & Geometry Review, Equations &
  Inequalities); Unit 2 (Graphs & Functions)"` -- naming each unit and its
  real topic areas, not every sub-topic exhaustively. This mirrors ALEKS's
  own Pie-slice naming (`A. Algebra and Geometry Review`, `B. Equations and
  Inequalities`, ...) when that's the real source; use whatever the actual
  course's own unit/topic names are elsewhere.
- **Narrow-coverage assessments** (a single-chapter quiz, e.g. "Quiz 4"):
  the exact chapters/sections it covers, as specific as the source states
  -- `"Covers: Ch. 4.1-4.3 (Exponential and Logarithmic Functions)"`, not a
  generic unit name when a syllabus/quiz description already gives the
  precise chapters.

Both go in DETAILS using the same real-source-only rule as lecture content
above -- a quiz whose actual coverage isn't stated anywhere in the source
gets no invented coverage line, same as any other missing field.

**This section governs a rendered assessment's own coverage note only --
not `chapter-topic-add` capture depth.** A compact per-unit summary is a
legitimate, still-correct choice for *this* purpose (a broad exam's
description shouldn't list every sub-topic across three units). It is not
license to sample what gets saved into the `ChapterTopic` knowledge base
itself -- required-find #6 above requires the full, complete list there
regardless of how compactly any one assessment's coverage note
summarizes it.

### Study depth, EXAM CONCEPTS, homework videos (CLAUDE.md invariant 40)

User-directed 2026-10-15. These are required finds for every course, on
the same footing as the links above.

**Per chapter (`chapter-topic-add`):**
- `--vocabulary`: every key term, taken from the textbook's end-of-chapter
  Key Terms/glossary list, the instructor's objectives sheet, or the study
  guide.
- `--objective` (repeat): every learning goal/concept as its own line.
  Sources: the textbook's chapter-opening Learning Goals/Objectives, the
  instructor objectives sheets (BIO), FunSheets (CHE), ALEKS View All
  Topics (MAT), module learning outcomes (ENG).
- Never a section heading: those go in `--section` only.
- Then compare against the chapter's sections. Where a section's concepts
  or terms aren't covered by any real source, fill only that gap with
  `--added-vocab`/`--added-objective`. It renders as a separate block
  labeled "Added (not from instructor)".
- Worked example of the target format (BIO1112 Ch 32's real objectives
  sheet): `Vocabulary: Tissue, cleavage, blastula, gastrula, ...` followed
  by bullets like "Distinguish between protostomes and deuterostomes and
  state which animal phyla are which".

**Per test (`render <id> --covered-chapters '[...]' --study-focus '[...]'
--save`):**
- `covered_chapters`: only chapters the exam page, syllabus, announcement,
  or study guide says the test covers.
- `study_focus`: the study guide / review deck / practice exam's own
  emphasized items, verbatim, one per entry. Favor these heavily: open
  every review resource the test has (study guide, review slides, practice
  exam, FunSheets for that chapter, ALEKS chapter review) before writing
  it.
- EXAM CONCEPTS renders at the bottom: study guide focus first, then each
  covered chapter's Vocabulary + concepts.

**Per homework (`render <id> --video-url <url> --video-label "Video —
<topic>" --save`):**
- First choice is the instructor's own recording for that topic, then the
  platform's video (ALEKS "Explain"/eBook/Connect).
- Otherwise use a specific video from a trusted educational source (Khan
  Academy, The Organic Chemistry Tutor, Professor Leonard, Amoeba Sisters,
  Crash Course).
- Open it and confirm it teaches that assignment's topic. Never use a
  search-results or channel URL.

**Color:** tests render with `assessment_color_id` (default 5, yellow)
automatically. Nothing to set per item.

### Points and optional/extra-credit (`AcademicItem.points`, `.is_optional`)

- `is_optional`: true only when the source **explicitly** says so --
  "optional," "extra credit," "for practice," "not graded," "ungraded,"
  bonus-point language, etc. Default is `False` (assume graded) even for
  item types that sync without a hard due time (a plain textbook reading
  is expected work, not "optional," even though it renders as an
  informational all-day event per CLAUDE.md invariant 15 -- don't conflate
  "no due time" with "not required"). This never demotes CLAUDE.md's
  coverage requirements: an optional/extra-credit item still syncs, it's
  just labeled. When true, `render` puts a plain `<b>UNGRADED</b>` tag as
  the very first thing in the description -- before even the course
  header -- so it's unmissable, not a mid-description STATUS line.
- `points`: superseded 2026-08-25 -- this project briefly required
  actively hunting down and capturing an exact point value for every
  graded item (a `missing_points_count` completeness gate, now removed),
  after an audit found only 3 items across three courses had ever had one
  captured. The user reconsidered: exact numbers aren't actually needed,
  only the graded/ungraded distinction above. `points` still exists as a
  field (and `render --points N` still accepts one, for whoever wants to
  jot a number down for their own reference) but **no longer renders
  anywhere** and is not a required find -- don't reintroduce a POINTS
  section or gate on it.

### Inferred dates (`AcademicItem.is_inferred_date`, `.date_inference_rule`)

User-authorized 2026-08-25 (CLAUDE.md invariant 29) -- a narrow, explicit
exception to "never fabricate a date," not a general license to guess:

- **The bar**: only after real, exhaustive search across every relevant
  source for this specific item found no literal date, AND there's a
  stated, one-sentence, auditable pattern rule backed by real adjacent
  evidence already found (e.g. "every other homework in this course is due
  exactly N days after the prior chapter exam, and that holds for every
  one of the N already-confirmed items"). If you can't state the rule in
  one sentence, don't infer -- leave the item undated and open an
  `unresolved` reference instead, same as ever.
- **Setting it**: `render --inferred-date --date-inference-rule "<the
  rule>" --save`. `--inferred-date` refuses to run without a rule string.
  The rule text is stored (`date_inference_rule`) for local audit only --
  it never renders into the visible description, same treatment as
  `source_wording`.
- **What actually shows**: a quiet `<i>(Inferred Date)</i>` tag, same
  top-of-description slot as the `UNGRADED` tag above (before even the
  course header), independently conditional -- an item can show neither,
  either, or both (`UNGRADED` first when both apply).
- **Self-clearing**: the moment a genuinely different date lands on the
  same item via a real re-extraction, `db/repository.py::
  upsert_academic_item` clears `is_inferred_date`/`date_inference_rule`
  automatically -- a later literal-sourced correction never leaves a
  stale tag behind. No manual cleanup step needed.

### Links (`AcademicItem.reference_url`/`.reference_url_label`, `.resource_url`/`.resource_url_label`)

Rendered as real, clickable, labeled links (`<a href="url">label</a>`), not
raw URLs -- the label is what the user sees and clicks, so choose it to be
accurate about what it actually points to. Defaults exist ("D2L",
"Textbook") but prefer a specific label whenever you know more:

**`reference_url` / `reference_url_label` -- the item's own actionable
link, prefer the most specific thing you can honestly link to:**

1. **Best: the actual turn-in/submission location** (a Dropbox folder, Quiz
   attempt page, discussion thread to post in). Label it `"Assignment"` (or
   similarly direct, e.g. `"Submit Here"`) -- this is what the user asked
   for: "link me to the turn-in location if possible."
2. **Next best: the item's own read-only page** (a Content topic showing
   the assignment description, a syllabus schedule entry) if you didn't
   confirm the exact submission page. Label it by what it is, e.g.
   `"D2L"` or `"Assignment Details"`.
3. **Fallback: a general area** (the course's Content home, Assignments
   list) when nothing more specific was captured. Label it with a short
   path hint so the user knows where to go once they land there, e.g.
   `"D2L (Content -> Assignments -> HW 1.3)"` or
   `"D2L (Assignments tab)"` -- this is the one case where a short
   navigation hint belongs in the link text itself (not as a separate
   description line -- see the retired "Submission/Pathways" style above).

Always use a deep link with a stable numeric ID over a generic one when you
have the choice (see `#working-with-an-unfamiliar-lms-or-page-format` for
what "stable" means on an unfamiliar platform) -- capture the exact URL
while browsing to that item's page during discovery. This is normally
available for anything you actually opened -- there's no reason to skip it.

**`reference_url` and `resource_url` are not either/or -- capture both when
both exist.** Real incident: "Your Inner Fish" got a `resource_url` link to
its printout/handout but no `reference_url` to its actual D2L Dropbox
submission page, even though that link was sitting right there in
Assignments the whole time -- completeness didn't catch it because the gate
originally accepted either URL as "linked." If a D2L-native assignment has
*both* a separate handout/printout *and* its own Dropbox/Quiz submission
page, capture both: the handout goes in `resource_url`, the Dropbox/Quiz
page goes in `reference_url` per the ladder above -- one is never a
substitute for the other, and `reference_url` (the submission link) is the
one `completeness` actually gates on (CLAUDE.md invariant 17). The one
real exception: external courseware (ALEKS-style) where the "go do the
work" link *is* the submission mechanism -- `reference_url` alone is
correct there and there's normally no separate `resource_url` to find.

**`submission_url` / `submission_url_label` -- a separate turn-in location
(added 2026-10-05).** Real example: an exam's own page said the work had to
be submitted separately to a Dropbox folder. That folder was a real graded
deliverable, but nothing on the calendar linked it. Rules:

- **Open every exam's and quiz's own instructions page**, not just its
  listing row. Any "submit your work", "upload your scratch work", or
  "turn in your written solutions" language makes finding that dropbox a
  **required find** (invariant 17). If you can't locate it, record it with
  `unresolved-add`.
- Set it on the exam: `render <exam_id> --submission-url "<dropbox url>"
  [--submission-url-label "Submit Work"] --save`. It renders as its own
  **Submit Work** link, alongside the exam's `reference_url`.
- **Also give the submission its own deadline event.** Run the dropbox
  folder's real text (name + due date) through `extract --source-type
  d2l_dropbox`, so the date is sourced and the item gets its own
  fingerprint. Then `render <new_id> --reference-url "<dropbox url>"
  --reference-url-label "Submit Here" --save`. If the dropbox states no due
  date, the companion item stays in the unresolved queue like any other
  undated item (invariant 1).

**Study guides for every test (added 2026-10-07).** Each exam, quiz, or
practical gets its real study material, rendered under **STUDY GUIDES**
after the test's own LINKS. This is a required find:
- Look in the test's own instructions page, the course's exam-resources
  or review module, the chapter module, announcements about the test, and
  the external platform. Examples: ALEKS "Review: Chapter N", a "Practice
  Exam" file, a midterm review guide, review videos.
- Save them on the test item: `render <test_id> --links '[{"label":
  "Ch 4 Study Guide", "url": "..."}, {"label": "Practice Exam", "url":
  "..."}]' --save`.
- Only links you opened. Never a syllabus. If a test genuinely has none,
  it has none; don't pad.

**`resource_url` / `resource_url_label` -- external material, almost
always a textbook:**

- Only ever populate this with a URL the source itself gave you (an
  explicit link in the syllabus/content page, or a platform confirmed to
  expose stable per-chapter/per-section URLs, e.g. some open-textbook
  platforms). **Never construct or guess one**; a guessed URL is worse
  than no URL. But don't assume a platform has *no* per-chapter address
  until you've actually looked (per-assignment LTI items in D2L Content,
  the eBook's chapter pages): see
  `#external-courseware-platforms----detect-the-link-not-the-tool-name`
  step 7.
- If the URL is genuinely chapter/section-specific, say so in the label,
  e.g. `"Textbook (Ch. 6)"`. If it's only the textbook's general home/
  launch page, label it plainly (`"Textbook"`) -- **and make sure the
  chapter/section number is stated somewhere else in the event** (the
  DETAILS section, or the title) so clicking a general textbook link still
  tells the user exactly what to read. A deadline for "read Chapter 2" with
  only a general textbook link and no chapter number anywhere in the event
  text is not acceptable -- the chapter number costs nothing to include and
  is exactly the kind of information the link alone can't supply.
- Before trusting *any* URL as `resource_url`, open it and confirm it
  actually resolves to the specific page (not a generic dashboard, login
  wall, or launch screen) -- a URL that only works when re-derived through
  an LTI launch isn't stable. If you can't confirm a specific page's URL is
  real and stable, leave `resource_url` unset rather than approximate it --
  linking the general textbook (correctly labeled, chapter stated in
  DETAILS) is the fallback, not a fabricated deep link.

**When neither link is findable because the item is genuinely locked --
`link_available_date`:** if reference_url/resource_url can't be found not
because you didn't look, but because D2L shows the item as locked with an
explicit "Available on <date>" marker (common for lab kit tools, adaptive
courseware, and content released on a schedule), capture that date instead
of leaving the gap silent: `render <item_id> --link-available-date
YYYY-MM-DD --save`. This renders as `Link opens <date> -- not yet available
in D2L` under the LINKS heading instead of omitting the section entirely --
still not a guessed URL, just a sourced fact about *when* the real one will
exist. It's also what feeds the periodic link-refresh pass (academic-sync
SKILL.md's link refresh step, driven by `academic-sync needs-link-refresh`,
run weekly), which re-checks these items both after their stated date (in case
nobody's revisited since) and a bit before it (in case D2L's date was
conservative and the item unlocked early) and replaces the note with the
real link once found. Never invent an availability date D2L didn't
actually display -- if the item is just locked with no stated date, leave
both the URL and `link_available_date` unset, same as any other unfound
link.

### The fingerprint tag: can't hide it, can shrink it (`<small>`)

The user asked whether the `[academic-sync:fp:...]` idempotency tag
(`embed_fingerprint_tag`/`extract_fingerprint_tag`) could be made
invisible, or at least de-emphasized, while still working as the
Calendar-side dedup backstop (searchable via `list_events(fullText=...)`,
see CLAUDE.md's extendedProperties note). Tested directly on 2026-08-18
with real create_event + list_events(fullText=...) + rendered-popup round
trips before landing on an answer -- three attempts, in order:

1. **Hiding it in an HTML comment** (`<!-- academic-sync:fp:... -->`)
   renders invisibly, but `list_events(fullText=...)` **does not match text
   inside an HTML comment** -- confirmed by creating an event with a
   comment-hidden marker and searching for it: zero results, while the same
   search against visible text in the same event succeeded. This breaks
   the backstop entirely -- never hide it this way.
2. **Shrinking/fading it via inline CSS** (`<span style="font-size:10px;
   color:#999999">`) is stripped by Calendar's HTML sanitizer -- the
   rendered popup showed the tag at normal size and color despite the
   `style` attribute round-tripping through the API response unchanged.
   No visual de-emphasis achieved.
3. **Wrapping it in the semantic `<small>` tag** (no inline styling, just
   the tag itself) **works**: the rendered popup showed it visibly smaller
   than the surrounding text, and `list_events(fullText=...)` still found
   it -- confirmed by both a screenshot comparison and a real search
   round-trip. `<small>` is preserved by the sanitizer where a `style=`
   attribute isn't; there's no obvious rule for which HTML survives (`<b>`,
   `<br>`, `<a href>`, and `<small>` all do; inline `style=` doesn't), so
   don't assume -- test.

`embed_fingerprint_tag` therefore wraps the tag in `<small>...</small>`
before appending it (`<br><br>` before it, per the HTML-description note
above). This is the best achievable balance: the tag is still there and
still searchable, just visually quiet rather than shouting at the bottom
of every event. If a future session wants to try something else here
(fully invisible while still searchable), re-run the same empirical test
before trusting it -- don't assume a new trick works without verifying it
the same way these three were.

## Rate limiting

Navigate at a human-reasonable pace -- there is no need to hammer D2L with
rapid sequential requests. A few seconds between page loads within a course
crawl is plenty; there's no fixed-interval requirement enforced in code
(this is a live, human-supervised session, not an unattended scraper), but
don't fire off dozens of navigations back-to-back either.

## Detecting "this course needs another pass"

While crawling, watch for the same reference phrases the completeness
engine looks for (`config/default.yaml: completeness.reference_phrases`) --
if a syllabus says "see D2L" and you haven't yet actually opened the area it
points to, that's exactly the incompleteness signal the system is designed
to surface. Don't consider a course's syllabus-only pass sufficient; continue
into Content/Dropbox/Quizzes before calling a course's completeness report
final for that run.
