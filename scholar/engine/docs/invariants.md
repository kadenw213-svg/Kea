> **Kea note:** these are the engine's design invariants from the original Class Calendar Import project,
> kept as reference for Kea's bundled skills. In Kea, events go to Kea Calendar (not Google Calendar) and
> Kea's guidelines (written into each profile's workspace) take precedence where they differ.

# CLAUDE.md

## First run in a fresh clone -- do this before anything else

If `.venv/` or `config/personal.local.md` is missing, set up silently and
automatically (do the installs yourself; ask the user only for values you
can't detect), then reply with the short skill list below and nothing else:

1. `uv --version`. If missing, install it: Windows `winget install -e --id
   astral-sh.uv` (fallback `powershell -c "irm https://astral.sh/uv/install.ps1 | iex"`);
   macOS/Linux `curl -LsSf https://astral.sh/uv/install.sh | sh`.
2. `uv python install` (reads `.python-version`), then `uv sync --extra dev`.
3. `.env` missing -> copy `.env.example` to `.env` (all values optional).
4. `config/personal.local.md` missing -> copy `config/personal.example.md`,
   then ask once for: institution name, D2L home URL. Save the D2L URL with
   `uv run academic-sync prefs set d2l_base_url <url>`.
5. `uv run academic-sync db-init`.
6. Check connectors: Google Calendar (required), Claude in Chrome (required
   for D2L scans), Google Drive (for `/academic-sync`'s grade signals). Name
   any that are missing, in one line.

Then reply:

> Ready. Skills:
> - `/academic-import` -- first-time scan of a D2L course into Google Calendar
> - `/academic-sync` -- re-scan, build next weeks' banners, link refresh
> - `/daily-overview` -- 5am per-class email: announcements, grades, feedback, deadlines
> - `/weekly-study-pdf` -- textbook-style study PDF for each class's new week
> - `/academic-prefs` -- view/change preferences
> - `/custom-curriculum` -- build a self-directed course on any topic

Personal details (name, institution, D2L host/SSO, calendar IDs) live only
in `config/personal.local.md` (gitignored). Never write them into any
committed file.

---

Permanent engineering invariants for this repository. These are not
suggestions -- a future session (including you, later in this same
conversation) that violates one of these has broken the system's central
promise: it never guesses, and it never duplicates.

## What this project is

A local-first pipeline that turns D2L/Brightspace course material into a
structured academic obligation model, and syncs the *clear* subset into
Google Calendar. It runs as a family of Claude Code skills --
`academic-import` (first-time scan), `academic-sync` (recurring maintenance
and the weekly grade diagnostic), and `academic-prefs` (preferences), plus
`custom-curriculum`/`audio-lectures` for adjacent, non-D2L-sourced study
workflows -- backed by a real, independently tested Python package
(`src/academic_sync/`). D2L access happens live through Claude Code's own
browser control; Calendar writes happen live through Claude Code's Google
Calendar connector. There is no separate OAuth client and no Playwright
dependency in this project -- see `docs/architecture.md` if you're tempted
to add either; that decision was deliberate, not an oversight.

## Non-negotiable invariants

1. **Never fabricate dates.** A date on a Calendar event must trace back to
   literal text in a source, or to an explicit, auditable derivation rule
   (see `extraction/rules.py`) applied to two other literal dates. If you
   can't point to the text, the item's `date` stays `None` and it goes to
   the unresolved queue -- it does not get today's date, a guessed date, or
   a date "close enough."

2. **Never fabricate course nesting/hierarchy.** If a source doesn't state
   which module/week/unit an item belongs to, `module_label` stays `None`
   and the Calendar description simply omits the nesting parenthetical
   entirely (see "Calendar description format" below -- no placeholder
   text like "Nesting not provided," that pattern was retired). Do not
   infer nesting from item ordering or proximity to a heading unless the
   heading is genuinely the nearest preceding structural marker (see
   `extraction/pipeline.py::_MODULE_HEADING`).

3. **Never fabricate locations.** A Calendar `location` field is only ever
   set from an explicit campus/building/room/address the source actually
   stated, or a prior user-confirmed preference (`preferences/store.py`,
   category `location`). Two unmapped rooms become an unresolved reference,
   not a guess about which is lecture vs. lab.

4. **Never add guests, never create Meet links.** `sync/calendar_payload.py`
   must never include an `attendees` key or a `conferenceData` block. This
   is enforced by test coverage (`tests/test_calendar_payload.py`) -- if you
   change payload construction, keep that test passing, don't loosen it.

5. **Idempotency is not optional.** Every academic item has a stable
   `fingerprint` (`reconciliation/fingerprint.py`) independent of wording
   that might change between passes. Reconciliation
   (`reconciliation/engine.py`) decides CREATE vs. UPDATE vs. UNCHANGED by
   comparing against what's already stored *before* any write happens.
   Re-running a scan must never create a duplicate Calendar event. If you
   add a new item type or a new extraction path, make sure it produces a
   fingerprint the same way existing ones do (same course + type + canonical
   identity), and add a test proving a second identical extraction is
   UNCHANGED, not CREATE.

   **Amended 2026-08-25 -- UNCHANGED must mean "matches what was actually
   last pushed," not "matches itself."** Real incident: `academic-import`
   Step 3's own gap-closing (nesting, links via `render --save`) was
   applied directly to already-synced item rows, outside the extraction
   pipeline. Run standalone (`academic-sync plan`, no fresh extraction),
   `compute_plan` passes the currently-stored items as both `incoming` and
   -- via fingerprint lookup -- `existing`, so `representation_changed`
   compared the row against itself and could never detect this class of
   drift no matter which fields were on `_COMPARED_FIELDS`, silently
   reporting 208 already-synced, already-enriched items as UNCHANGED
   across three courses. Fixed with a real snapshot,
   `SyncRecord.last_synced_fields` (migration
   `_0010_add_sync_record_last_synced_fields`,
   `reconciliation/engine.py::snapshot_compared_fields`): `record-sync`
   now records exactly what was true at the moment of the real push;
   `decide_action` compares the item's *current* state against that
   snapshot instead of against `existing`, correctly catching drift
   regardless of whether it came from a fresh extraction or a direct
   `render --save`. A `SyncRecord` with no snapshot (every real sync
   performed before this fix) is treated as UPDATE, not assumed
   unchanged -- see the docstring on `decide_action`'s fallback branch for
   why silently reusing the old self-comparison there would have just
   reproduced the same bug. That one-time backfill push is what populates
   the snapshot going forward, after which drift detection is trustworthy
   again. Don't special-case "no snapshot" back to UNCHANGED to make a
   `plan` output look cleaner -- that's exactly the failure this fixes.

6. **A detailed syllabus is never sufficient for COMPLETE.**
   `completeness/analyzer.py` must keep treating "see D2L," "additional
   details will be provided," "most labs include...," etc. as signals that
   push a course to `INCOMPLETE`, not `COMPLETE`, until the referenced
   material has actually been inspected (a `Source` row of the matching
   type exists) or the reference is explicitly resolved. Don't relax this
   to make completeness reports look better.

7. **Generic frequency statements never fabricate individual items.**
   "Most labs include a pre-lab quiz" must never produce 12 pre-lab quiz
   items. See `extraction/rules.py::should_create_pre_lab_quiz` and
   `is_generic_frequency_statement` -- any new derived-item logic needs the
   same guard.

8. **Course-level incompleteness does not block item-level sync.**
   `CourseCompletenessReport.safe_to_sync_clear_subset` should stay `True`
   in the normal case -- an item's own `status` (CLEAR vs.
   UNRESOLVED/CONFLICTED) is what gates whether *it* syncs, not the course's
   overall completeness. Don't make course-level INCOMPLETE/CONFLICTED
   silently withhold an otherwise-clear item's sync.

9. **Revised sources update existing logical items, never duplicate them.**
   When a source is re-scanned with different content (different
   `content_hash`), re-extraction should update the same fingerprinted item
   (UPDATE), not create a second one. Conflicting dates with no clear
   revision relationship go to `reconciliation/precedence.py` and, if
   unresolved, become a CONFLICT -- never a silent pick.

10. **Never delete Calendar data just because a source item disappeared.**
    If a previously-extracted item no longer appears in a re-scan, that is
    at most a `CANCELLED_BY_SOURCE` candidate requiring the source to have
    *explicitly* said so (cancelled/removed language) -- absence alone is
    not evidence of cancellation. Actual deletion requires an explicit user
    preference opt-in that does not exist yet in this codebase; do not add
    silent auto-delete behavior.

11. **Preferences are only ever set explicitly.** `preferences/store.py`
    must never be written to from a casual mention in extracted text. Only
    an explicit `prefs set` call (CLI or the `academic-prefs` skill) or an
    explicit user confirmation relayed by `academic-import` (e.g. "which
    room is lecture vs. lab?") may write a preference.

12. **Maintain source provenance.** Every `AcademicItem` should be traceable
    to the `Source`(s) it came from (`source_ids`) and retain
    `source_wording` for what literally justified it. Don't strip
    provenance fields to make code "cleaner."

13. **Run tests after touching parsers, extraction, reconciliation, or
    completeness.** `uv run pytest -q`, plus `uv run ruff check src tests`
    and `uv run mypy src`. All three were clean as of this file's writing --
    keep them clean.

14. **Database changes go through `db/migrations.py`.** Don't edit an
    already-shipped migration function; append a new numbered one. Keep
    changes backward-compatible where practical (additive columns with
    defaults, not renames-in-place) since this is a single local SQLite
    file with no rollback tooling.

15. **Coverage is maximal by user direction, not minimal.** The user
    explicitly asked for "don't miss anything": every graded item, reading/
    topic assignment (even ungraded), rough draft, and optional/extra-credit
    item should end up visible somewhere. This does NOT relax invariant 1
    (never fabricate a date) -- an item with no date at all still goes to
    the unresolved queue, it just means "isn't a graded deadline" is no
    longer a reason to drop something. As of invariant 25 below, reading/
    topic content specifically reaches Calendar via a course's
    `WEEKLY_READING` block (or a covering lecture's own DETAILS) rather than
    a per-day standalone event -- the coverage requirement is unchanged,
    only which event carries it.

16. **Discovery must be exhaustive before a course's scan counts as done.**
    A production run synced three courses after only 1-2 source types had
    actually been opened per course, missing BIO1112's lecture schedule
    entirely and every course's topic/unit outline and per-assignment
    special instructions -- nothing was fabricated, but whole categories of
    real information were never fetched, and completeness's `Never
    scanned:` line said so the whole time without anyone acting on it. See
    `docs/d2l_discovery.md#mandatory-minimum-crawl----do-not-skip-this` for
    the concrete rule: the course Calendar, Content/Modules, and every
    Announcement (each expanded in full) must all be opened for every
    course -- Announcements was added to this list 2026-08-18 after a
    CHE1011 announcement turned out to contain a whole category of lab
    assignments (Lab Safety, Getting Started, Lab #1) that existed nowhere
    else, plus a BIO1112 room exception a uniform location preference had
    been silently overriding. A 0-character PDF parse means "transcribe the
    scan visually,"
    not "no items," and a raw prose notes file
    (`data/downloads/<COURSE_CODE>/raw_notes.md`) must capture everything
    found -- including topic/instruction detail that doesn't map to a dated
    item -- before extraction is treated as final for that course. See also
    `docs/d2l_discovery.md#orientation-pass----do-this-first-for-every-course-before-the-deep-crawl`
    -- added 2026-08-18 after invariants 17/18 below surfaced a second,
    deeper instance of this same failure shape (item existence was fine,
    item enrichment wasn't). The orientation pass answers delivery format,
    real course nav, and the three `#required-finds` categories *before*
    any item extraction starts, specifically so this can't recur as a
    late-discovered gap -- don't skip straight to pulling dated items on a
    new course without it.

17. **Module nesting, resource links, and the textbook/tool access point are
    required finds, not optional enrichment.** A real production run on
    2026-08-18 synced ~30 items across three courses whose per-item
    `module_label`/`reference_url`/`resource_url` were all `None`, and
    `completeness` reported COMPLETE_FOR_DATED_ITEMS the whole time --
    nothing in the analyzer had a signal for "this course clearly has
    chapter/module structure in D2L Content, but these dated items were
    never connected to it." This is the same failure shape as invariant
    16's origin incident (a coarse pass-condition hiding a real gap), one
    level down: item-existence was fine, item *enrichment* wasn't checked
    at all. `completeness/analyzer.py::analyze_completeness` now takes
    `unnested_item_count`/`unlinked_item_count` and folds them into
    INCOMPLETE exactly like `undated_graded_work_count` -- a course cannot
    report COMPLETE (or COMPLETE_FOR_DATED_ITEMS) while dated items are
    missing nesting the course demonstrably has elsewhere, or while graded
    items are missing a `reference_url`. See
    `docs/d2l_discovery.md#required-finds` for the concrete checklist this
    drives during Step 1 (SCAN): locate the textbook/course-materials
    access point, open each content module deep enough to capture its real
    per-topic/per-chapter breakdown (not just top-level module titles), and
    capture the primary tool URLs (Quizzes list, Discussions list, any
    homework platform like ALEKS) once per course for reuse as
    `resource_url`/`reference_url` values. Don't relax the new gate to make
    completeness reports look better -- same rule as invariant 6.

    **Amended 2026-09-15 -- `reference_url` and `resource_url` are
    independently required where applicable, not either/or.** Real
    incident: a synced assignment ("Your Inner Fish") got a `resource_url`
    link to its printout but no `reference_url` to its actual D2L Dropbox
    submission page -- readily available in D2L, just never captured --
    and the completeness gate didn't catch it because `unlinked_item_count`
    originally counted an item as linked once *either* URL was set. A
    printout, textbook page, or other supplementary material in
    `resource_url` never substitutes for the item's own turn-in location in
    `reference_url` (see `docs/d2l_discovery.md#links`'s ladder --
    `reference_url` is supposed to be the submission/turn-in link whenever
    one exists). `cli.py::completeness_cmd`'s `unlinked_item_count` now
    checks `reference_url` specifically, regardless of whether
    `resource_url` is already set. The one case where `reference_url` alone
    is correct and no `resource_url` is expected: external courseware
    (ALEKS-style) where the "go do the work" link *is* the submission
    mechanism.

    **Amended 2026-10-05 -- a separate turn-in location gets its own slot
    and its own event.** Real incident: an exam's own page said to submit
    the work separately to a Dropbox folder, but that graded deliverable
    was linked nowhere on the calendar. `AcademicItem.submission_url`/
    `submission_url_label` (migration `_0016`, in `_COMPARED_FIELDS` and
    `upsert_academic_item`'s enrichment-preservation loop) render as a
    **Submit Work** link alongside `reference_url`. The separate
    submission also becomes its own deadline item, extracted from the
    dropbox's real text, so it has a sourced date and its own fingerprint.
    Opening every exam/quiz's own instructions page is part of the scan.
    Any "submit your work separately" language makes that dropbox a
    required find. See `docs/d2l_discovery.md#links`.

    **Amended 2026-10-07 -- tests carry their study guides.** User-directed:
    every exam/quiz/practical event lists its real study material under a
    **STUDY GUIDES** section, after its own LINKS (take it / submit work).
    That material includes study guides, practice exams, review
    assignments (e.g. ALEKS "Review: Chapter N"), exam-resource pages, and
    review videos. They are stored in `weekly_links` on the test item
    (`ItemType.is_assessment` gates it; `render <id> --links '[...]'
    --save`). Finding them is a required find for every test, same tier as
    its submission link. Only links discovery opened, never a syllabus.

18. **A gathered field that isn't wired into the render path doesn't count
    as gathered.** The same 2026-08-18 session found that `render`'s
    `--nesting`/`--details` CLI options were render-time-only -- even after
    `item.module_label` was correctly persisted via `--save`-equivalent
    writes, `render_cmd` never defaulted `nesting` from it, so a second
    `render <item_id>` call without repeating `--nesting` silently produced
    a description with no MODULE section, contradicting the DB state. Fixed
    by making `render_cmd` default `nesting` to `item.module_label` and
    write an explicit `--nesting` back onto `module_label` (see
    `cli.py::render_cmd`). The general rule: if a CLI override has a
    same-named persisted field on `AcademicItem`, the render path must read
    that field by default -- an override that only lives in a function
    argument for one invocation is not "saved" in any sense a future
    session (or this one, next command) can rely on.

19. **A persisted-but-unenforced field is not a safeguard.** A real incident
    2026-08-18: `ExtractionContext.term_start`/`.term_end` were correctly
    populated from the course record on every `extract` call, but nothing in
    `extraction/pipeline.py` ever actually checked an extracted date against
    them. Feeding a hand-typed, non-blank-line-separated pipe table through
    `extract` merged two rows into one garbled item and produced a
    completely fabricated date (`2013-07-09`) for an Aug-Dec 2026 course,
    marked `CLEAR` -- i.e. sync-eligible -- since nothing flagged it as
    implausible. Fixed in `extraction/pipeline.py` (`_outside_term_bounds`/
    `_out_of_term_ref`, applied in both `_extract_from_line` and
    `_extract_from_table`): any extracted date more than 45 days outside
    `[term_start, term_end]` is now dropped (set back to `None`) and flagged
    as an `UnresolvedReferenceKind.OTHER` reference explaining why, rather
    than trusted. This does not replace careful review of ad-hoc extraction
    input -- it's a backstop, not a substitute for feeding `extract` real,
    well-formed source text. The general rule this generalizes from
    invariant 18: a field that's threaded through but never read back is
    exactly as useless as a field that was never wired into render -- check
    both directions when adding context that's supposed to constrain
    behavior, not just supposed to carry data.

20. **External courseware is detected live, off the shell's own link
    structure -- never from a hardcoded tool-name list.** A real incident,
    2026-08-21: MAT1340's actual homework due dates and topic progression
    lived entirely inside ALEKS, linked from D2L Content as a plain nav
    item with no surrounding "see ALEKS for due dates" sentence. Discovery
    saw the link, assumed "not date-bearing" from the tool's name, and
    never opened it -- nothing caught the assumption because the only
    existing detection mechanism (`extraction/classify.py::
    find_reference_phrases`, matched against `config/default.yaml`'s
    `completeness.reference_phrases`) is pure prose-substring matching; a
    bare nav-item link produces no textual signal at all, and a name list
    would only ever catch tools someone already thought to add. The fix is
    architectural, not a bigger list: recognizing that a shell link leaves
    the LMS's own domain, and deciding whether real assignment content is
    behind it, is a live judgment call made while browsing (same category
    as SSO-login detection or room-vs-lab disambiguation) -- it belongs in
    the `academic-import` skill's orientation pass
    (`docs/d2l_discovery.md`), not in the deterministic text pipeline. Two
    things make that judgment call auditable instead of just tribal
    diligence for one session: `SourceType.EXTERNAL_COURSEWARE` (a real,
    honest provenance type once a platform is actually crawled) and the
    `unresolved-add`/`unresolved-resolve` CLI commands
    (`db/repository.py`), which let the skill record "found an unverified
    external link" the moment it's noticed and have it self-clear
    (`_auto_resolve_external_reference_uninspected`) once a matching
    `Source` is later added -- so `completeness` can gate on it the same
    way invariants 16/17 gate on unopened D2L areas, without depending on
    any particular session remembering to mention it. Verification (does
    this link actually lead to assignments, or is it a textbook/publisher
    page that doesn't need tracking) is likewise a live call, defaulting to
    "crawl it" whenever the surrounding page text indicates something is
    there or the link lands on a login wall (log in and crawl, same
    stop-and-wait pattern as D2L's own SSO) -- ask the user only when
    genuinely ambiguous even after opening it, and save that answer so the
    same tool doesn't get re-litigated on every scan.

21. **A Calendar event's native `location` field is for a real physical
    meeting only -- never a stand-in for "where do I find this."** A real
    incident, same session: `platform_location="Online"` had been set on
    dozens of deadline-type items (quizzes, exams, discussions,
    assignments) across MAT1340 and CHE1011, which is true but meaningless
    (every deadline in an online course is trivially "online") and
    displaced the actually useful MODULE/DETAILS information a student
    would want instead. `sync/calendar_payload.py::build_event_payload` now
    only ever sets the payload's `location` key when
    `item.item_type.is_fixed_time_meeting and item.due_time is None` --
    the same predicate `build_title` already used to distinguish a real
    meeting from a deadline -- and `cli.py render_cmd` warns and drops
    `--location` for anything else rather than silently honoring it. The
    one legitimate `"Online"`-as-`location` case from
    `docs/d2l_discovery.md`'s field-fallbacks section still applies, but
    only to a meeting that would otherwise have a room. For a deadline-type
    item, "where do I actually go to do this" belongs in the MODULE line of
    the description instead (see invariant 20's platform-naming point:
    `sync/calendar_payload.py::platform_label_for_source` derives "D2L" or
    the real external tool name from the item's own `Source`, and
    `_module_line` prefixes it onto the nesting text) -- never in
    `location`, physical address or not.

22. **Enrichment content (DETAILS, chapter breakdowns, quiz/exam coverage)
    is held to the same evidentiary standard as dates -- never synthesized.**
    Real feedback, 2026-08-21: the user explicitly wants event DETAILS
    detailed enough to build accurate study prompts from later, and
    explicitly does **not** want that achieved by generating a plausible
    summary of what a chapter probably covers. The rule from invariant 1
    ("if you can't point to the text, it doesn't go in") now applies to
    content depth, not just dates: DETAILS must trace back to literal
    instructor-authored material -- a chapter objectives document, a study
    guide, lecture slide section titles, a syllabus topical outline -- see
    `docs/d2l_discovery.md#content-depth----link-and-quote-instructor-material-never-synthesize`
    for the format (spaced per-chapter blocks, matching a real user-edited
    example event) and `#required-finds`' new finding 4 (locate the
    instructor's own chapter-objectives/study-guide/lecture-slides material
    before writing DETAILS for that chapter). If no such material exists
    for a given chapter, DETAILS stays at whatever real depth is actually
    available -- a thin but true DETAILS section beats an invented one.
    User-directed follow-up, 2026-08-24: DETAILS content that's real but
    still a hand-typed run-on paragraph (a comma-chained vocabulary list, a
    semicolon-chained objectives sentence) is hard to scan. The standard
    way to build DETAILS now is `render --details-blocks` (JSON array of
    labeled sub-groups -> `sync/calendar_payload.py::DetailsBlock`/
    `format_details_blocks`) -- one labeled block per distinct real
    piece of content, with a bulleted-line rendering for `items` instead of
    one run-on sentence. This is a *presentation* transform only (splitting
    on the source's own existing delimiters), not a relaxation of this
    invariant -- every block's `text`/`items` still has to trace to real
    instructor-authored material. Plain `--details` (a single string) is
    still fine for a short single-paragraph case. See
    `docs/d2l_discovery.md#content-depth----link-and-quote-instructor-material-never-synthesize`
    for the exact format and worked example.

23. **A platform's "what's coming up" dashboard is not its authoritative
    record.** Real incident, 2026-08-21: crawling MAT1340's ALEKS, the Home
    dashboard's "Working Toward" widget showed only 4 near-term items;
    ALEKS's own Gradebook (the actual full record) had 18, and cross-
    checking the two against what was already synced found two items dated
    a full week wrong, two off by a day, and one item (due the next day)
    that had never been captured at all -- all invisible from the
    dashboard view alone. Generalizes past ALEKS: any tool that offers both
    a summary/upcoming view and a full list/table/gradebook view, find and
    read the full view before treating that tool as crawled -- see
    `docs/d2l_discovery.md#external-courseware-platforms----detect-the-link-not-the-tool-name`
    step 6.

24. **Don't create a standalone all-day topic/reading item for a day a
    real meeting already covers.** Real feedback, 2026-08-21: BIO1112 (a
    course with actual lectures) was syncing both a lecture event and a
    separate same-day all-day "reading" item repeating that lecture's own
    chapter -- pure duplication. This does not relax invariant 15's
    maximal-coverage rule -- folding the chapter/topic content into the
    lecture's own DETAILS still fully preserves it, it just avoids a second
    calendar entry for information the lecture event already carries. As of
    invariant 25 below, this is no longer a case-by-case judgment call with
    an online/async carve-out -- a plain `READING` item is *never* synced as
    its own event, full stop (enforced in code, not just prose); its
    content lands in a same-day covering lecture's DETAILS, in that
    course's `WEEKLY_READING` block, or (typically) both.

25. **Reading/topic content reaches Calendar as one week-spanning block per
    course, never a per-day standalone event.** User-directed change,
    2026-08-24: the old per-day all-day `READING` event (one per source
    line, invariant 15's original mechanism) was replaced with
    `ItemType.WEEKLY_READING` -- one multi-day all-day event per course per
    real reading week, titled `"<CODE> Weekly Overview"` (superseded
    2026-08-25 -- previously `"<CODE> Readings (<date range>)"`; the date
    range moved out of the title into the description's own DATES section,
    the last section before the fingerprint tag, see below), whose
    description is a heads-up of everything that class covers that
    week: exact chapters/topics (never a vague paraphrase -- same
    "trace to real instructor material" bar as invariant 22's lecture
    DETAILS), links, and -- only when the source states differentiated
    internal timing (e.g. "Ch. 2 by Wednesday") -- that pacing under a
    PACING section, never invented; a DATES section (the real week range,
    e.g. "Aug 24 - 30") always closes the description, after CONTACT/LINKS
    and immediately before the fingerprint tag. `sync/calendar_payload.py::
    build_event_payload` now **raises** for a plain `ItemType.READING` item
    (see invariant 24 above) -- it is provenance-only and must never
    itself become a Calendar event again. `AcademicItem.date_range_end`
    holds the week's last day (inclusive; `date` is the week's start,
    reused rather than adding a second start field), and
    `db/repository.py::upsert_academic_item`'s enrichment-preservation
    loop and `reconciliation/engine.py::_COMPARED_FIELDS` both include it,
    same as every other type-specific field. Fingerprinted via
    `reconciliation/fingerprint.py::compute_fingerprint(course_id,
    "weekly_reading", "Readings", disambiguator=week_start.isoformat())`
    so re-deriving the same week updates the same item instead of
    duplicating. Week boundaries must trace to real source evidence -- D2L
    module start/stop metadata and/or a syllabus week<->topic table --
    never assumed Mon-Sun; a stretch of reading with no such evidence gets
    no block, same "don't fabricate" bar as invariant 1. The CLI entry
    point is `academic-sync weekly-reading-add`, mirrored into a Calendar
    payload by `render` (extended with a `WEEKLY_READING` branch) exactly
    like every other item type -- see
    `docs/d2l_discovery.md#weekly-reading-blocks` and
    `.claude/skills/academic-import/SKILL.md`'s Step 5.

    **Amended 2026-09-01 -- the LINKS section is the week's real resources,
    never the syllabus.** A weekly overview aggregates a whole week, so it
    isn't limited to the two `reference_url`/`resource_url` slots every
    other item type gets: `AcademicItem.weekly_links` (migration `_0012`,
    `list[WeeklyLink]`, ORM column `weekly_links_json`, in
    `upsert_academic_item`'s enrichment-preservation block and
    `_COMPARED_FIELDS` -- same as every other type-specific field) holds an
    arbitrary-length list of that week's real, student-facing resources:
    the lecture video(s), the slide deck, and the textbook chapter
    reading, whichever discovery actually found, each with a chapter/week
    label. Set via `weekly-reading-add --links '[{"label","url"},...]'` or
    `render <id> --links '[...]' --save`; renders under LINKS in place of
    `reference_url`/`resource_url` when non-empty
    (`sync/calendar_payload.py::_weekly_link_lines`). A **syllabus link is
    never featured** -- a syllabus states *that* a chapter is due, not the
    reading itself; its URL stays internal (a `Source` row), and any
    syllabus-labeled link is dropped at render time
    (`_looks_like_syllabus`), for a weekly banner's `weekly_links` *and*
    its fallback `reference_url`/`resource_url` path alike. Omitting a link
    entirely is always better than a syllabus link; an absent resource is
    a real gap, not something to pad with a course-home or second-best
    link.

    **Amended 2026-09-01 (b) -- `weekly_links` applies to lecture/lab
    meetings too, not just weekly banners.** Same user directive, same
    reasoning: a lecture event was linking the syllabus (or nothing)
    instead of the material a student actually needs for that session.
    `build_meeting_description` now renders `weekly_links` via the shared
    `sync/calendar_payload.py::_supplemental_link_lines` (renamed from
    `_weekly_link_lines`) exactly like a banner does, falling back to
    `reference_url`/`resource_url` and dropping any stray syllabus link.
    For a **lecture**, `weekly_links` is that session's own real
    resources, in priority order: its specific slide deck(s), any handout
    or in-class activity/worksheet for that lecture, a professor
    recording if one exists, and the chapter's textbook reading -- never a
    syllabus, never the textbook's bare table-of-contents as a stand-in
    for the actual chapter. `render --links '[...]' --save` /
    `academic-sync render` accept it for `ItemType.is_routine_meeting`
    types (lecture/lab/recitation/seminar) as well as `WEEKLY_READING`;
    deadline-type items are unchanged (still the two fixed
    `reference_url`/`resource_url` slots). The ORM column stays
    `weekly_links_json` (no rename migration -- the field just isn't
    banner-only anymore).

    **Amended 2026-10-05 -- the banner is the course shell.** User-directed:
    GPT teaching mode was retired, so the student learns directly from the
    real curriculum the banner links. `build_weekly_reading_description`
    renders, in this order:
    - **READING** -- every chapter that week. Each gets its real section
      headings (`ChapterTopic.sections`) as a short "Big topics" line,
      then its chapter-specific reading link (`ChapterTopic.reading_url`/
      `reading_label`; migration `_0016`).
    - **SLIDES & RESOURCES** -- every non-textbook `weekly_links` entry,
      grouped by `WeeklyLink.kind`.
    - **No PACING section** (removed 2026-10-07, user-directed): the
      banner lists the whole week's work, work-ahead material included.
      Every banner generated from now on uses this layout.
    - **TOPIC DETAIL** -- the full saved objectives + vocabulary, never
      summarized. The GPT quiz system's question pool comes from it, and
      it is the only block the length budget may truncate.
    - **CONTACT**, then **DATES**.

    Reading links are stored once per chapter so every banner and lecture
    covering it reuses one verified URL. Section headings follow
    invariant 22's bar: the source's own structure, never a summary.
    Finding a per-chapter reading URL means searching inside the
    eBook/platform, not stopping at its launch tile (invariant 20's
    platform section, step 7). `WeeklyLink` gained optional
    `kind`/`chapter`; links saved without a `kind` are classified from
    their label at render time. `snapshot_compared_fields` appends
    kind/chapter only when set, and `decide_action` compares snapshots
    field-by-field with `.get()`, so a newly compared field never shows
    up as spurious drift on items synced before it existed. Changing a
    `ChapterTopic` does not by itself mark synced banners as changed:
    re-render and push the banners covering it.

    **Amended 2026-10-16 -- the banner is links only.** User-directed:
    "remove the weekly descriptions detail entirely ... just basically
    give links to lectures and the slides for the week." The "Big topics"
    line and the whole TOPIC DETAIL section are gone from
    `build_weekly_reading_description`. A banner is now: header, READING
    (each chapter's name + its reading link), SLIDES & RESOURCES, CONTACT,
    DATES. What to study now lives in the weekly study PDF (invariant 41).
    `ChapterTopic` data is unchanged and still feeds tests' EXAM CONCEPTS
    (invariant 40) and the PDFs. Don't put topic depth back on a banner.

26. **Chapter/unit topic breakdowns are a required find, saved as durable
    reference data -- not just typed into one Calendar event's
    description.** User-directed, 2026-08-24: testing invariant 25's
    weekly reading blocks exposed that chapter/unit content depth
    (vocabulary, objectives) only ever existed as text typed into `render
    --details-blocks` at sync time -- nothing durable recorded "what does
    Chapter 23 actually cover," so every event that touched that chapter
    re-derived it independently, with real risk of drift between two
    events covering the same material. `ChapterTopic`
    (`models/domain.py`, table `chapter_topics`) is the fix: a real,
    persisted row per `(course_id, chapter_topics.
    canonicalize_chapter_label(chapter_label))`, saved via `academic-sync
    chapter-topic-add`. **Required during a full course scan for every
    chapter/unit the course has** (not just ones near a current dated
    item) -- same footing as invariants 16/17's required finds -- every
    value still has to trace to real instructor-authored material (chapter
    objectives doc, study guide, ALEKS topic list), never a generated
    summary (same invariant 22 bar). `completeness` gates on it:
    `CourseCompletenessReport.missing_chapter_topic_count` (computed in
    `cli.py::completeness_cmd` by diffing every chapter label referenced
    across a course's `WEEKLY_READING` items against what's actually been
    saved) folds into `INCOMPLETE` exactly like `unnested_item_count`/
    `unlinked_item_count` -- don't relax this gate to make completeness
    reports look better, same rule as invariants 6/17. `render` on a
    `WEEKLY_READING` item now auto-pulls saved chapter topics into THIS
    WEEK (`cli.py::render_cmd`, via `chapter_topics.
    build_chapter_topic_blocks` + `sync/calendar_payload.py::
    format_details_blocks`) -- a chapter with no saved topic yet still
    shows its bare name (thin but true, never blocked), it just doesn't
    get the vocabulary/objectives depth until `chapter-topic-add` is run
    for it. `chapter_topics.py` is the one place the "Chapter N: Topic"
    parsing regex lives (`split_chapter_segments`) --
    `sync/calendar_payload.py::_topic_line` was refactored onto it rather
    than keeping a second copy; don't reintroduce a duplicate regex there.

    **Amended 2026-08-25 -- capture must be exhaustive, not sampled, and a
    thin capture is only acceptable when the source itself is genuinely
    thin.** Real incident: this invariant's own original guidance told the
    skill to sample ALEKS's **Ready to Learn** panel ("pull a handful of
    representative topics... don't enumerate all of them") for MAT1340,
    capturing ~6 of 233 real topics for one slice. Two problems, not one:
    the sampling itself lost real, permanently-discoverable information,
    and the source was wrong regardless of sample size -- Ready to Learn is
    ALEKS's personalized, progress-dependent "what's next for you" queue,
    not its real complete/stable topic structure. **General rule, not
    ALEKS-specific: a platform's adaptive/personalized "next up" view is
    never a substitute for its real, stable, complete structure** (a
    syllabus, table of contents, objectives report, or a toggle like
    ALEKS's own **View All Topics**) -- when a platform offers both, use
    the stable one; when unsure which is which, the one that doesn't
    change on reload is the structural one. See
    `docs/d2l_discovery.md#required-finds` finding #6 for the corrected
    per-platform guidance. `ChapterTopic.objectives` must be the real
    complete list, whatever depth the source's own structure actually has
    -- never stop at a coarse category label (a Pie slice name, "Chapter
    1," a module title).

    To make this an honest, checkable signal rather than only a prose
    expectation, `ChapterTopic.is_exhaustive: bool` (default `False`,
    `chapter-topic-add --exhaustive`) records whether discovery has
    actually confirmed a row's capture came from the platform's stable
    structure and is genuinely complete -- set it only then, not merely
    because a capture pass happened. `CourseCompletenessReport.
    partial_chapter_topic_count` (folds into `INCOMPLETE` exactly like
    `missing_chapter_topic_count`, computed in `cli.py::completeness_cmd`
    as saved rows the course references where `is_exhaustive` is `False`)
    distinguishes "never captured at all" from "captured, but not yet
    confirmed exhaustive" -- don't relax either gate to make completeness
    reports look better, same rule as invariants 6/17.

    **Amended 2026-10-15 -- objectives are concepts, not section
    headings.** CHE1011/MAT1340/ENG1022 had saved their textbook section
    headings as `objectives`, so TOPIC DETAIL repeated the READING list.
    `objectives` holds learning goals/concepts and `vocabulary` holds key
    terms; headings belong in `sections` only. See invariant 40.

    **Render-time length budget is a separate, deliberately decoupled
    concern -- it does not relax the capture-time exhaustiveness
    requirement above.** Google Calendar's description field caps at
    roughly 8,192 real characters (`sync/calendar_payload.py::
    DESCRIPTION_CHAR_BUDGET`; see docs/d2l_discovery.md's "Calendar
    description length budget" section for the citation and full
    behavior). `_assemble_within_budget`/`_truncate_html_block` truncate
    only the one large, variable-length content block (TOPIC DETAIL/DETAILS)
    when a rendered description would exceed it, visibly noting how many
    real captured lines were left out -- the small, always-wanted sections
    (header/MODULE/CONTACT/LINKS/DATES) are never sacrificed, and the full
    capture always stays intact in `chapter_topics` regardless of what any
    one rendered event could fit.

27. **Graded/ungraded status is a single top-of-description tag, never a
    captured point value.** User-directed, 2026-08-25, superseding an
    earlier same-day version of this invariant: auditing a synced week
    found only 3 items across all three of the user's courses had ever had
    a real point value captured into `AcademicItem.points`. The first fix
    attempt required actively hunting down exact numbers and gated
    `completeness` on it (`missing_points_count`) -- but the user
    reconsidered: exact point values were never actually the point.
    `sync/calendar_payload.py::_ungraded_tag` is the real fix -- a plain
    `<b>UNGRADED</b>` block, placed as the very first thing in the
    description (before even the course header), shown only when the
    source explicitly marked the item optional/extra-credit/ungraded/
    for-practice (`AcademicItem.is_optional`, same never-inferred rule as
    always). The ordinary graded case -- the default, no explicit language
    in the source -- gets **nothing added**: no tag, no numeric POINTS
    section, no required capture, no completeness gate. The old numeric
    `POINTS`/`STATUS` mid-description section (`_points_section`) and the
    `missing_points_count` gate are both gone -- don't reintroduce either;
    `AcademicItem.points` and `render --points` still exist for whoever
    wants to record a number for their own reference, they just no longer
    drive any rendered output.

28. **A module/week's stated date range belongs in `module_label` whenever
    the source states one, not just the bare label.** Real incident,
    2026-08-25: MAT1340 and CHE1011's `module_label`s already included
    real date ranges (`"Chapter 1: Prerequisite Review Topics (8/17 -
    8/30)"`, `"Week 2: 8/24-8/30"`) because their own D2L module
    titles/schedule tables state them inline -- but BIO1112's stayed a
    bare `"Week 2"` with no range, because its syllabus schedule table's
    week column doesn't attach one directly to that cell, even though the
    range is real and derivable from adjacent weeks the same table does
    date (Week 1 = Mon 8/17, Week 3 = Mon 8/31, so Week 2 = 8/24-8/30).
    The inconsistency wasn't a fabrication risk in either direction, but it
    made otherwise-identical items across courses look inconsistently
    detailed. When a course's own source states a module/week's date range
    -- directly on the heading, or derivable from two adjacent real dates
    the same source states (same "auditable derivation rule applied to two
    other literal dates" allowance as invariant 1) -- capture it as part of
    `module_label`, not just the bare name. When no such range is stated or
    derivable, the bare label is still correct -- don't invent one.

29. **A date may be pattern-inferred, never blindly guessed -- and it must
    say so.** User-authorized 2026-08-25, a narrow, explicit exception to
    invariant 1's "if you can't point to the text, it stays `None`" rule.
    The bar: only after real, exhaustive search across every relevant
    source for this item has turned up no literal date, AND there is a
    stated, one-sentence, auditable pattern rule backed by real adjacent
    evidence *already found* (e.g. "every other homework in this course is
    due exactly N days after the prior chapter exam, and that holds for
    every one of the N already-confirmed items") -- the same spirit as
    invariant 1's original "derivation rule applied to two other literal
    dates" carve-out, just generalized past pure date-range math to any
    rule that can genuinely be stated in one sentence. A vague hunch,
    "probably around here," or "close enough" is never sufficient --
    exhaust real search first (the ALEKS-Gradebook-not-dashboard lesson of
    invariant 23 generalizes here too: check every real source before
    concluding nothing states it). Set via `render --inferred-date
    --date-inference-rule "<the one-sentence rule>" --save`
    (`AcademicItem.is_inferred_date`/`.date_inference_rule`, migration
    `_0009_add_item_inferred_date`) -- `--inferred-date` refuses to run
    without a rule string. The rule text itself is stored for local audit
    only and never rendered (same treatment as `source_wording`); what
    *does* render is a quiet `<i>(Inferred Date)</i>` tag
    (`sync/calendar_payload.py::_inferred_date_tag`) in the same
    top-of-description slot as the `UNGRADED` tag, independently
    conditional -- both can appear together (`UNGRADED` first). This flag
    self-clears (`db/repository.py::upsert_academic_item`) the instant a
    genuinely different date lands on the same item via a real
    re-extraction, so a later literal-sourced correction never leaves a
    stale "(Inferred Date)" tag behind.

30. **A confidently-identified duplicate item gets marked superseded, never
    deleted.** User-authorized 2026-08-25. When two `AcademicItem` rows
    clearly represent the same real-world obligation -- same real date,
    same course, extracted from two different sources under different
    title phrasing (e.g. a syllabus's coarse "Ch 1 Exam" and ALEKS's own
    "Online Exam: Chapter 1.3 - 1.4 & 1.6 - 1.7", both due the same day) --
    and you're genuinely confident they're the same thing, resolve it
    yourself rather than always leaving both live and asking. Use the
    existing supersession mechanism already established elsewhere in this
    codebase (`AcademicItem.superseded_by_id`/`ItemStatus.SUPERSEDED` --
    see the Lab 2 date-correction case in `db/repository.py`'s
    reconciliation path) on the less-informative/newer duplicate, pointing
    at the row that survives -- never a raw `DELETE`. This is deliberately
    the opposite of invariant 10 (never silently delete a *synced Calendar
    event* because a source item disappeared) -- marking a pre-sync local
    duplicate superseded is reversible, auditable, and specifically
    authorized; a raw delete on local data is a separate, genuinely
    destructive action this project still won't take without explicit
    per-instance confirmation. When confidence is genuinely low (titles
    and dates don't both clearly match, or there's real ambiguity about
    whether they're the same obligation), leave both live and flag it for
    the user instead of guessing.

    **Amended 2026-09-01 -- a confident duplicate's redundant *Calendar
    event* now gets auto-deleted, no per-instance confirmation.** User-
    directed ("if there's ever dupes just delete them automatically"),
    after a session found ~9 stale duplicate Calendar events left over
    from the pre-`WEEKLY_READING` sync (old standalone all-day "Chapter N"
    events that the weekly banners + lecture events now fully cover) plus
    one double-extracted deadline. This is a real, narrow relaxation of
    this invariant's original "never a raw DELETE / requires per-instance
    confirmation" for **Calendar events specifically**: when two items are
    confidently the same real obligation and one is redundant (fully
    covered by the survivor and/or a weekly banner), `delete_event` the
    loser's Calendar event, then mark the local row `SUPERSEDED` pointing
    at the survivor and remove its `SyncRecord` so `plan` doesn't
    re-create it. `notificationLevel: NONE` on the delete (never notify
    anyone). The confidence bar is unchanged -- genuinely ambiguous cases
    still get flagged, not deleted -- and this does **not** touch
    invariant 10 (an item merely *disappearing* from a re-scan is still
    not grounds for deletion; that needs explicit cancelled/removed
    language). Local rows are still superseded, never hard-deleted --
    only the Calendar-side duplicate is removed.

31. **A course's first real scan closes every gap it can, in that same
    pass -- gap-closing is not a separate later cleanup phase.** User-
    directed 2026-08-25, after a session that treated exhaustive
    chapter-topic capture, `unresolved` reference resolution, module
    nesting, and reference/resource link discovery as four separate
    passes across multiple later conversations. Going forward. a course's
    first scan (`academic-import` Step 1-4) is expected to reach the same
    end state that pass eventually did: `academic-sync completeness`
    showing zero open unresolved references, zero missing chapter/unit
    nesting, and zero missing reference/resource links wherever real
    evidence exists to close them (invariants 16/17/20's required-finds
    already establish *what* counts as a mandatory find; this invariant is
    about *when* -- do it now, not "eventually"). This includes going as
    deep as invariant 23 already requires for adaptive courseware (its
    real Gradebook/Assignments-list view, not just its dashboard) since
    that is very often where the bulk of a course's per-item dates
    actually live, not in the syllabus at all. A gap that survives after
    real exhaustive effort (checked every relevant source, still nothing)
    is not a failure to fix immediately -- report it honestly as
    genuinely unresolved (or use invariant 29's inference path if it
    qualifies) rather than blocking the rest of the scan on it.

32. **A discovered gap is a prompt to go look, not a prompt to report.**
    User-directed 2026-08-25, generalizing invariant 31 past "a course's
    first scan" to *any* point a gap surfaces -- mid-conversation, a later
    audit, a follow-up question, not just Step 1-4. Real incident: an
    audit of the weekly-reading rollout found three weeks of a course's
    `raw_notes.md` marked "not captured," and the immediate next action
    was reporting that to the user as a limitation instead of actually
    checking D2L first to see whether it could be resolved right then. The
    default reflex when something is found missing -- a date, a topic, a
    link, a week's content, anything -- is: **try to fill it now**, using
    whatever real source might plausibly have it, *before* telling the
    user it's a gap. Only report something as a genuine limitation after
    that real attempt has actually been made and come up empty. This
    doesn't relax any "never fabricate" invariant -- the fill still has to
    be real, sourced content (or invariant 29's narrow inference path) --
    it's about not skipping straight to "here's what's missing" when
    "let me go check" was the cheaper, more useful first move.

33. **A missing exam/final-exam clock time gets a same-day-lecture or
    proctored-deadline default, never left as an open REVIEW indefinitely.**
    User-directed 2026-08-27. When an EXAM/FINAL_EXAM item has a real date
    but no real time: (a) if the course has a lecture/meeting on that same
    date, attach the exam to that meeting's slot (set `start_time` to that
    lecture's `start_time`) -- the exam is happening in that class period;
    (b) otherwise, if the course already treats its exams as async/proctored
    windows (i.e. its other EXAM items use `due_time` rather than
    `start_time` -- see the "fixed-time-meeting-typed item that carries a
    due_time" pattern in `sync/calendar_payload.py::build_title`), default
    `due_time` to the course's `default_due_time` (23:59) -- the same
    treatment every other proctored "Online Exam" already gets, not a
    special case. Never default an in-person exam's `start_time` to
    midnight; only the proctored/deadline path uses 23:59. Real incident:
    MAT1340's "Final Exam" item had a real 12/4 date but no time and sat in
    REVIEW indefinitely, even though a correctly-formatted 23:59 deadline
    event for it already existed live on Calendar (created in an earlier
    session) -- the local item was never updated to match, so `plan` kept
    flagging it as broken when it wasn't.

34. **A small number of gaps (a handful of D2L page loads, well under
    ~10 tool calls) get filled without asking first.** User-directed
    2026-08-27, sharpening invariant 32's "go look, don't just report" into
    a concrete threshold: for a small, bounded gap -- a missing date, an
    unresolved link, a handful of unresolved-reference items -- just go
    check D2L and fill it, the same way invariant 32 already requires,
    without pausing to ask permission first. Only check in before acting
    when the gap is large enough that resolving it would mean a genuinely
    big task (a full missing week's worth of content, a whole unscanned
    platform section, dozens of live D2L navigations) -- something where the
    user might reasonably want to scope or defer the work, not a routine
    "look, then fix" pass.

35. **A course flagged `Course.is_synthetic` is exempt from invariant 22's
    "never fabricate" bar for its own weekly topic/pacing content -- nothing
    else.** User-directed 2026-08-27. `.claude/skills/custom-curriculum/
    SKILL.md` builds a fully self-directed "class" on a topic the user
    describes, with no real D2L/instructor source to trace anything back to.
    For a course with `is_synthetic = True`, the AI-authored, user-approved
    topic sequence *is* the legitimate source for `weekly-reading-add`'s
    `--chapters` value -- invariant 22's evidentiary bar does not apply to
    that content for this course type. Everything else stays unchanged: no
    invented dates, no guests, no Meet links, idempotency by natural key, no
    CONTACT line (never set `instructor`/`instructor_contact` on a synthetic
    course), and its calendar footprint is `WEEKLY_READING` banners only --
    no fixed-time meetings, no deadline/homework items (comprehension
    checking happens entirely in the separate GPT study-prompt system,
    outside this project). This skill never calls `chapter-topic-add` --
    content stays deliberately short/broad, not an exhaustive capture;
    `ChapterTopic.is_exhaustive` and invariant 26 are about real scraped
    courses and don't apply here. Every synced event from a synthetic course
    must render the `SYNTHESIZED CURRICULUM` tag
    (`sync/calendar_payload.py::_synthesized_tag`) so it's never mistaken
    for real instructor material at a glance. Never set `is_synthetic =
    True` on a real course, and never let this exemption bleed into a course
    that has any real scraped content. `completeness/analyzer.py::
    analyze_completeness`'s `is_synthetic` parameter short-circuits straight
    to `COMPLETE` for these courses -- the absence of Sources and
    ChapterTopic rows is expected and correct for this course type, not a
    gap the normal branch chain should evaluate.

    **Amended 2026-09-25 -- a synthetic course's banners carry a full
    teaching outline; still no assessments of any kind.** User-directed:
    the GPT study system should be able to teach a generated course as a
    complete, coherent class from its banners alone. `custom-curriculum`
    now calls `chapter-topic-add` for **every** chapter (title, 6-12
    objectives in teaching order, 8-15 key terms), authored and
    user-approved like the rest of the outline. `render` auto-pulls them
    into each banner's THIS WEEK, the same mechanism a real course uses,
    and the GPT system parses that into its content structure. This
    replaces the earlier "never calls `chapter-topic-add`" rule. Never pass
    `--exhaustive` for a synthetic course: that flag certifies a real
    platform's complete topic list, and completeness short-circuits these
    courses anyway. **No quizzes, exams, homework, assignments, or
    deadlines for a synthetic course** (a same-day plan for mock quizzes
    was reversed by the user before shipping). Practice comes entirely
    from the GPT system's teaching mode. The GPT system lists synthetic
    courses separately and never includes them in its Automatic mode.
    **Amended 2026-10-05 -- real readings, quiz-only GPT.**
    - GPT teaching mode was retired. The GPT system (`study-prompt-system`
      repo) is now quiz-only: pick a class (self-study courses included),
      get 10 exam-style questions over everything covered so far, and see
      only the misses explained, with a textbook-section link.
    - `custom-curriculum` now **finds real, openly available college
      material on the web** for each chapter (OpenStax, LibreTexts, MIT
      OCW, university course pages) and verifies each page loads before
      saving it:
      - the reading becomes `chapter-topic-add --reading-url`;
      - its own section headings become `--section`;
      - lecture notes/videos become banner `--links`.
    - Those links are real sources, not authored content. The authored
      parts (sequence, objectives) still carry the `SYNTHESIZED
      CURRICULUM` tag.
    - Synthetic courses get no Daily Overview email (invariant 38).

    Migration `_0015_add_item_mock_spec` (and its unused
    `academic_items.mock_spec_json` column) stays in `MIGRATIONS` only
    because it already ran on the local DB: removing it would make the
    next real migration number collide. Nothing reads or writes that column.

36. **`/academic-import` is first-time discovery only; every recurring run
    (light re-scan, link refresh, the weekly grade diagnostic) is
    `/academic-sync`'s job.** User-directed 2026-09-16. Before this split,
    `academic-import/SKILL.md` carried both jobs, branching internally on
    "First-time scan vs. recurring run" -- that branch is gone.
    `academic-import/SKILL.md` Step 0 now stops and points the user at
    `/academic-sync` the moment a course already has synced items and a
    covering `Inspected:` list; it no longer contains a light-crawl or
    link-refresh code path at all. No Python package code moved -- both
    skills call the same `uv run academic-sync ...` CLI from the repo root;
    this is purely a skill-file reorganization. See "Where the skills fit"
    below.

37. **A course's weekly grade diagnostic is held to the same evidentiary
    standard as any other sourced field -- but its corrective plan is
    explicitly Claude-generated advice, not sourced fact.** User-directed
    2026-09-16. `/academic-sync` Step 3 produces one Calendar event **per
    course** every week, "`<CODE>` Previous Week Diagnostic," classifying
    that course Red/Yellow/Green (`diagnostics.py::classify_course`) from
    `GradeSnapshot`/`CourseGradeSnapshot` rows captured live from D2L's
    Grades tool and external courseware's own Gradebook (never its
    dashboard/adaptive "next up" view -- same rule as invariant 23) --
    see `docs/d2l_discovery.md#weekly-grade-diagnostic-crawl`. Every real
    (non-`is_synthetic`) active course is checked; `is_synthetic` courses
    are excluded entirely (no real grades to check -- same carve-out as
    invariant 35). The rule, deliberately stricter than a bare pass/fail:
    **Yellow is the default "room to improve" state** -- any course below
    an A-range grade, or any single missing item, is Yellow at minimum (a
    single missing item is *never* Green, no matter how good the rest of
    the course looks); **Red** is reserved for what actually threatens
    success -- a real zero on a graded item, a bombed major assessment
    (EXAM/FINAL_EXAM/PROJECT scored under 60%), 2+ missing items in one
    course, an overall grade under 70%, or a steep (10+ point) week
    -over-week drop; **Green** requires an A-range grade and zero missing
    work. Scores and any quoted instructor feedback must trace to real
    D2L/ALEKS page content -- never fabricated, same bar as invariant 1.
    The event's corrective plan/recommendation text is different in kind:
    it is explicitly Claude's own generated advice, same as the "recommend
    a course of action" this feature was built for from the start -- this
    is not a relaxation of invariant 22 (which governs curriculum
    *content*, not advice about what to do next). Idempotent via
    `WeeklyDiagnosticRecord` (unique per `(course_id, week_start)`,
    fingerprint + `google_event_id`, mirroring `SyncRecord`'s role for a
    normal item) -- re-running the same course/week updates the existing
    event, never duplicates it.

    **Amended 2026-09-17 -- one event per course, not a single cross
    -course banner; layout and content order also changed.** User-directed:
    each course gets its own independently Red/Yellow/Green-colored event
    (`WeeklyDiagnosticRecordRow` gained `course_id`, unique key changed
    from `week_start` alone to `(course_id, week_start)`, migration
    `_0014_weekly_diagnostic_records_per_course`) so a struggling course's
    detail isn't buried inside a long combined list, and its own event
    color makes the gap visible without opening anything. Since the
    event's color now carries Red/Yellow/Green, **the status word is no
    longer spelled out in the text** -- line 1 is just the bold course
    code, line 2 the bold grade change. Each assignment renders as one
    **bold** `Name - score` line (name and score share a line now,
    previously two separate lines) plus, only when real commentary/
    feedback exists, a second unbolded line. Content order:
    header -> every assignment graded/submitted that week -> announcement
    highlights -> upcoming big deadlines (next 3 weeks) -> **Plan**, at the
    very bottom. **Missed deadlines are no longer their own section** --
    each missed-deadline fact (state plainly whether the submission window
    is still open or already closed -- sourced, not generated) is folded
    directly into the Plan section as its lead-in bullets, immediately
    followed by the numbered generated corrective plan, so the reader sees
    the problem and the recommended response together. `sync/
    calendar_payload.py::build_weekly_diagnostic_description` now takes one
    `DiagnosticCourseSection`, not a list -- `diagnostic-render`/
    `diagnostic-record-sync` both gained a required `--course`. See
    `.claude/skills/academic-sync/SKILL.md` Step 3 for the exact sequence.

    When a course is flagged Red for a reason tied to identifiable chapter
    coverage, `/academic-sync` Step 4 writes a weakness signal into a new
    `[class_slug]__signals` tab in the **same** Google Drive workbook the
    GPT study system (the `study-prompt-system` repo; schema in its
    `engine/memory.md`) already reads for that class -- `signal_id | chapter_key | chapter_label |
    reason | severity | source_week | created_at | status`. This is
    deliberately chapter-scoped, additive-only: the GPT prompt's own
    `quiz_tab`/`reviews_tab` key everything off a `concept_key` that's a
    session-invented opaque token no external system can ever produce, so
    academic-sync never writes into those tables directly, and never edits
    the prompt's existing tab/column structure -- it only ever writes the
    real chapter label the item actually covered, leaving `chapter_key`
    blank for the GPT session to resolve itself via the same
    canonicalization it already uses for exam coverage text. Not every Red
    result gets a signal -- skip it when the cause isn't tied to
    identifiable chapter coverage rather than guessing at one.

    **This write happens through live browser control on sheets.google.com,
    not the Google Drive MCP connector.** Confirmed live, 2026-09-16: the
    Drive connector available to these skills (`mcp__claude_ai_Google_
    Drive__*`) can find and read the workbook (`search_files`,
    `read_file_content`) but has no tool that writes spreadsheet cell
    content -- `update_file` only changes a file's title/parentId, and
    `create_file` only creates brand-new files, neither edits an existing
    sheet's cells. This mirrors the Calendar connector's own
    `extendedProperties` gap documented below (a real tool-availability
    limit discovered by testing, not a design choice) -- the fix is the
    same shape too: fall back to the channel that actually works. See
    `.claude/skills/academic-sync/SKILL.md` Step 4 for the exact browser
    mechanics, including that a literal `\t` inside typed text is *not* a
    real Tab keypress (it types as a space) -- use a separate real `Tab`
    keypress between fields.

    **Amended 2026-10-05 -- the weekly diagnostic event is retired, folded
    into the daily email.** User-directed: the Daily Overview (invariant
    38) reports newly graded work with verbatim feedback every morning,
    plus missed deadlines with open/closed status. Its "Needs attention"
    lines apply this invariant's Red rules daily (`digest.py` reuses
    `diagnostics.py`'s thresholds), each reported once when it first
    appears. That made the weekly "<CODE> Previous Week Diagnostic"
    Calendar event redundant, so `/academic-sync` no longer creates it,
    and the Sunday reminder event is retired too. The `diagnostic-*` CLI
    commands and tables stay for history. The Drive `__signals` write
    remains. `digest-ingest` prints `signal_candidates` (a major
    assessment newly under 60% with a real chapter label), and the
    browser write is the same as before.

    **Amended 2026-10-07 -- the GPT quiz system is abandoned; no more Drive
    signals.** User-directed. Nothing writes to the Drive workbook anymore:
    `/daily-overview` and `/academic-sync` skip the `__signals` write, and
    the 5am task no longer allows Drive tools. `digest-ingest` still prints
    `signal_candidates` (harmless; ignore it). Mentions elsewhere of the GPT
    system reading banners or TOPIC DETAIL are historical -- TOPIC DETAIL
    stays because it's the user's own topic list for the week. The weekly
    Sunday reminder event was deleted from Calendar the same day.

38. **The Daily Overview email relays what changed in the course shell --
    sourced, deduped, deep-linked, never double-sent.** User-directed
    2026-10-05: "remove the need for my interaction with the course
    shell." `/daily-overview` runs at 5:00am every day via Windows Task
    Scheduler (`scripts/daily_overview.ps1`, headless `claude -p
    --chrome` with a narrow `--allowedTools` list).
    - **One email per real course per day** (never synthetic), subject
      `"Daily Overview <CODE>"`, sent only to the `digest_email_to`
      preference from the connected Gmail account. Never cc/bcc, never
      anyone else. The address lives in the preference and
      `config/personal.local.md`, never in a committed file.
    - **Content:**
      - current grade (bold, with a trend);
      - new needs-attention triggers;
      - newly graded items, each with its link, exact score, verbatim
        instructor comment, and feedback-page link;
      - new announcements, with verbatim excerpts;
      - missed-yesterday items (open/closed);
      - due today, plus the next 3 days as context;
      - Calendar changes made, and "needs you" items.
    - **No readings** -- the banner is the reading list.
    - **A quiet day sends nothing.** Neither does a failed login: no
      sign-in means no run (invariant 39).
    - **Scores, comments, and announcement text are verbatim** (invariant
      1's bar). The only generated text is an optional, labeled `advice`
      line, given only when the grade moved or new work was graded --
      never a daily repeat of the same warning.
    - **Dedupe:** `digest_entries` is unique per `(course, kind,
      external_id)` with a content hash. Anything already emailed is
      never re-sent unless its content changed; a regrade or new feedback
      resurfaces as "updated". A course's first ingest baselines anything
      older than 2 days.
    - **No double-send:** `daily_digest_records` is unique per `(course,
      date)`. Entries are marked emailed only after a real send
      (`digest-record-sent --message-id`), so a failed send carries them
      to the next run.
    - **Links:** every item links to where the user acts. A separate
      `submission_url` wins over `reference_url` for deadline links.
      Static course URLs are saved once (`portal-link-set`,
      `course_portal_links`) so the run navigates straight to them. Only
      URLs actually opened are saved, never constructed.
    - **Calendar upkeep:** the daily run may auto-sync CLEAR, fully
      sourced CREATE/UPDATE entries under every existing invariant.
      Anything ambiguous or conflicting goes in the email's "Needs you"
      section instead.
    - Code: `digest.py` (ingest model + section logic),
      `sync/email_payload.py` (HTML), CLI `digest-deadlines` /
      `digest-ingest` / `digest-render` / `digest-record-sent` /
      `portal-link-set` / `portal-link-list`, migration `_0017`.

    **Amended 2026-10-07 -- messages, study materials, new classes.**
    User-directed:
    - **D2L messages:** each run reads the D2L message alerts/inbox.
      - Class messages go in that class's email under **New messages**
        (matched by instructor, otherwise by subject/body).
      - Real non-class messages (advising, registrar, financial aid) go in
        a separate **"Daily Overview Messages"** email, held under the
        inactive pseudo-course `MESSAGES`.
      - Spam and college advertising are dropped.
      - Automated "Submission receipt" messages are evidence for
        `deadline_status`, not reported.
    - **Study materials, every run:** upcoming tests (next ~3 weeks) are
      re-checked for newly posted study guides, review slides, practice
      exams, review assignments and course-specific equivalents (CHE
      funsheets, BIO objectives sheets, MAT worksheets / ALEKS chapter
      review). New finds are added to the test event's STUDY GUIDES.
    - **New class shells:** each run checks D2L enrollments
      (`academic-sync shells-check`, `enrollments.py`). A newly accessible
      real class shell is imported in full right away, unattended:
      `/academic-import` in unattended mode syncs CLEAR items without an
      approval gate and sends ambiguities to that class's email. Later
      mornings keep filling it in as content is posted. Orientation,
      cross-listed, non-class and past-term shells are skipped.
    - **"Previous day" by default:** after a course's first email, each
      email covers only what's new since the last one.
      `digest-ingest --catch-up-days N` widens only a course's first run.

39. **Claude never signs in -- the unattended run rides the user's existing
    Chrome session.** Corrected 2026-10-05. The user asked for Claude to
    click Sign In on the pre-filled SSO page (and even to store the
    password) so the 5am run could be fully autonomous. Claude's own
    safety rules don't allow it to submit a login with a password,
    whoever fills it in or authorizes it. So:
    - Never click Sign In, never open or use a password manager's fill
      menu, never type, store, or log a password. That covers the DB, any
      file, and the public `claude-project/` copy.
    - `/daily-overview` uses whatever D2L session Chrome already has. The
      user turned on LastPass **Autologin** for the SSO page, so LastPass
      itself signs in when the page loads.
    - **One allowed nudge** (user-directed 2026-10-07). LastPass sometimes
      fills the page but freezes before auto-submitting. In that case,
      Claude may click once **into the username field** (just focusing
      it), wait about 10 seconds, and check again. Focusing the field
      makes LastPass re-check the page and run its own autologin. Nothing
      is typed, the Sign In button is never touched, and LastPass's own
      icon/menu is never used.
    - **No sign-in, no run** (user-directed 2026-10-09, replacing the old
      "send anyway with a sign-in warning" fallback, whose emails were
      built from stale local data only). If D2L is still on the sign-in
      page after the nudge, the unattended run stops: no crawl, no ingest,
      no emails, no Calendar changes. It only writes "login failed --
      nothing sent" to its log. In an interactive run, ask the user to
      click Sign In, then continue. As a backstop, a `login_failed` crawl
      (or no crawl at all for that day) never renders `should_send: true`
      (`digest.py::DailyOverview.has_news`). The next real run catches up,
      because dedupe only marks entries as emailed after a real send.
    - Keeping Chrome signed in (the SSO session cookie persists in the
      real Chrome profile until the institution's timeout) is what keeps
      most mornings fully automatic.

40. **Every class gets BIO-style study depth; tests list what's on them;
    homework carries a video; tests are yellow.** User-directed
    2026-10-15. The goal is a review list the user can paste into their
    highlight-to-encyclopedia app, scan in seconds, and trust that
    knowing every line means knowing the class.
    - **TOPIC DETAIL is terms and concepts, never the section list.**
      (Banners stopped rendering TOPIC DETAIL on 2026-10-16 -- see
      invariant 25's last amendment. The capture rules below still apply,
      because the same lists feed EXAM CONCEPTS and the weekly study
      PDFs of invariant 41.)
      Each chapter gets a `Vocabulary:` line (every key term) and then
      every learning objective/concept as its own bullet -- the format
      BIO1112's chapter objectives sheets already have. Section headings
      live only in `ChapterTopic.sections` (READING's "Big topics");
      `chapter_topics.py::_restates_section` drops any objective that only
      restates one, so the CHE-style duplication can't come back. The
      READING list with its links stays at the top, unchanged.
    - **Real first, labeled gap fill second.** Capture from real material
      first: the textbook's own chapter Learning Goals/Objectives and Key
      Terms lists, instructor objectives sheets, FunSheets, study guides,
      ALEKS's topic list, module learning outcomes. Only where that
      material doesn't cover a section the chapter teaches may Claude
      write the missing terms/concepts, via `chapter-topic-add
      --added-vocab/--added-objective`. They render as a separate block
      labeled "Added (not from instructor)" and are never mixed into the
      sourced list. This is a narrow, user-authorized exception to
      invariant 22, and only for these review lists. Dates, links, scores
      and everything else keep the old bar.
    - **Tests carry EXAM CONCEPTS.** Every exam/final/practical/quiz
      (`ItemType.is_assessment`) gets `covered_chapters` (only what a real
      source says it covers) and `study_focus` (the study guide's / exam
      review's / review deck's emphasized concepts and terms, verbatim) via
      `render --covered-chapters '[...]' --study-focus '[...]' --save`.
      EXAM CONCEPTS renders last, after LINKS/STUDY GUIDES. Study guide
      focus comes first, then each covered chapter's saved Vocabulary +
      concepts. **Favor exam-prep material heavily:** when a study guide,
      practice exam or review exists, its concepts lead and are captured
      in full. A newly posted study guide means updating that test's
      `study_focus` and re-rendering (the daily run's study-materials
      check does this).
    - **Every homework gets a video.** Homework-type deadlines
      (assignment, discussion, paper, project) get `video_url`/
      `video_url_label` (`render --video-url --video-label --save`),
      rendered under LINKS right after the assignment link. Use, in order:
      the instructor's own recording for that topic, then the platform's
      video (ALEKS/Connect/eBook), then a specific video from a trusted
      educational source (Khan Academy, The Organic Chemistry Tutor,
      Professor Leonard, Amoeba Sisters, Crash Course, etc.). Always open
      it and confirm it actually teaches that assignment's topic. Never
      use a channel home page or a search-results URL.
    - **Tests are yellow.** `render` colors every `is_assessment` item
      with the `assessment_color_id` preference (default `5` = Banana),
      not `calendar_color_id`.
    - Code: migration `_0018`, `AcademicItem.covered_chapters`/
      `.study_focus`/`.video_url`/`.video_url_label` (all in
      `_COMPARED_FIELDS` and `upsert_academic_item`'s
      enrichment-preservation code), `ChapterTopic.added_vocabulary`/
      `.added_objectives`, `sync/calendar_payload.py::
      _exam_concepts_section`. A `ChapterTopic` change doesn't mark synced
      events as changed (same as invariant 25), so after recapturing a
      chapter, re-render and push the banners and tests that cover it.

41. **Each new week gets a textbook-style study PDF, written by Claude,
    clearly labeled as such.** User-directed 2026-10-16: "when a new
    weekly banner starts ... build a like 10-15 page pdf covering all the
    topics no fluff ... this is the only way i will study." The user reads
    it in Kea, where highlighting a word shows its definition, so
    the PDF spends its words on mechanisms, connections, problem-solving
    and what the tests ask, not on re-defining words.
    - **What triggers it.** `scripts/weekly_study_pdf.ps1` runs daily at
      6:30am (Task Scheduler, `register_weekly_study_pdf_task.ps1`). It
      asks `academic-sync study-pdf-due` first and only starts headless
      Claude (`/weekly-study-pdf`) when a banner starting within 3 days has
      no `study_pdfs` row. No Calendar, email or browser access.
    - **Which chapters.** The banner's chapters, plus any saved chapter a
      lecture/lab that week is titled with (`study_pdf.py::week_segments`),
      so the PDF never trails what class is actually teaching.
    - **Where it goes.** `Desktop/Weekly Study PDFs/<CODE>/<chapters>.pdf`
      (OneDrive Desktop when present), named for the chapters it covers
      (`pdf_filename`; 4+ chapters becomes "Ch 1-9 Review"). Typst source,
      figures and plot scripts stay in `data/study_pdfs/<CODE>/<week>/`.
      One shared template (`src/academic_sync/study_pdf_template.typ`) so
      every PDF looks the same; text is never hyphenated or ligatured so a
      highlight picks up whole words.
    - **This is the one place Claude writes teaching prose.** It's a
      narrow, user-authorized exception to invariant 22, like invariant
      40's gap fill. The cover says it's written by Claude from the
      course's own outline. Everything factual about the course stays
      sourced: due items, dates, test titles and coverage come verbatim
      from the bundle (never invented), and the outline follows the saved
      `sections`/objectives.
    - **Depth is checked, not promised.** `study-pdf-build` refuses while
      any saved vocabulary term for the week's chapters is missing from
      the text (`missing_terms`). The skill also maps every objective to
      the section that teaches it. Don't weaken the check, and never pad
      a bare term list in to pass it.
    - **Images are freely licensed or drawn.** Wikimedia Commons only via
      `study-pdf-image` (CC BY / BY-SA / CC0 / public domain, filtered in
      `_image_info`), always credited in the caption; or matplotlib
      figures run through `study-pdf-plot` (scripts must live under
      `data/study_pdfs/`).
    - **Idempotent.** One `study_pdfs` row per banner (migration `_0019`):
      built or deliberately skipped (`study-pdf-skip`, e.g. every chapter
      already has a PDF and no test is near). A rebuild overwrites the
      same file and row.

A graded item can legitimately have no `reference_url`/`resource_url` for a
reason other than "nobody looked": D2L showed it locked behind an explicit
"Available on `<date>`" marker (lab kit tools and adaptive courseware do
this often). `link_available_date` (migration `_0005_add_item_link_
available_date`) records that date when discovery actually saw it stated --
never invented. `sync/calendar_payload.py::_reference_lines` renders `Link
opens <date> -- not yet available in D2L` under the LINKS heading instead of
silently omitting the section when both URLs are unset but this date is
known. `db/repository.py::list_items_needing_link_recheck` (exposed as
`academic-sync needs-link-refresh`) finds items whose availability date
falls within a window around today -- `lookback_days` (default 14, so a
link that opened months ago and was never revisited doesn't resurface
forever) *and* `lookahead_days` (default 14, so an item whose stated date
is still a week or two out gets checked a bit early too, since D2L's
"Available on" date is sometimes conservative and this only runs weekly --
waiting for the exact date to pass before ever looking would leave a
genuinely-open item unfound for up to another week) -- but that still have
no real URL. The item drops out of that list automatically once a real URL
is set via `render --reference-url ... --save`, no separate field-clearing
step needed. See `.claude/skills/academic-sync/SKILL.md`'s Step 2 (link
refresh) for the full workflow, including the weekly recurring Calendar
reminder event that prompts the user to re-run it -- a real, visible
Calendar event (`recurrenceData: ["RRULE:FREQ=WEEKLY;BYDAY=SU"]`), not a
background job; this project has no autonomous scheduler (invariant 36's
skill split moved this step from `academic-import` to `academic-sync`, no
behavior change).

**Reminder for whoever edits `db/repository.py::upsert_academic_item`
next:** that function assigns every `AcademicItemRow` column explicitly,
field by field -- it does not iterate the domain model generically. Adding
a new `AcademicItem` field (model + ORM column + migration) and forgetting
to also add its assignment line in `upsert_academic_item` silently drops
that field on every write, no error raised. This is exactly the bug this
session hit while adding `link_available_date` -- caught by the repository
test (`test_needs_link_recheck_only_includes_recently_opened_and_still_
unlinked`) failing with an empty result set, not by any type check. Add the
field to a new-field checklist mentally: domain.py, orm.py, migrations.py,
**and** `upsert_academic_item`'s assignment block, in that order, every
time.

## A note on the `date` field / `_date` import alias

`AcademicItem.date` and `AcademicItemRow.date` are fields literally named
`date`. Combined with `from __future__ import annotations`, a bare
`from datetime import date` import gets shadowed by the field itself when
pydantic/SQLAlchemy resolve annotations against the class's own namespace,
crashing with `unsupported operand type(s) for |: 'NoneType' and
'NoneType'`. Both `models/domain.py` and `db/orm.py` import it as
`from datetime import date as _date` for this reason. Don't "clean up" that
alias back to a bare `date` import -- it will reintroduce the crash. This
is not a Python-version quirk; it reproduces on 3.12 and 3.14 alike.

## Where the skills fit

- `.claude/skills/academic-import/SKILL.md` -- a course's **first-time**
  scan only (invariant 36): drives D2L discovery (browser control), calls
  into this Python package's CLI/library functions for parsing/extraction/
  completeness/reconciliation, shows the user a plan, and on approval calls
  the Google Calendar connector directly, then records the result via
  `academic-sync record-sync`. Stops and points at `/academic-sync` the
  moment a course already has prior sync history -- it has no light-crawl
  or link-refresh path of its own anymore.
- `.claude/skills/academic-sync/SKILL.md` -- everything recurring on a
  course `/academic-import` already scanned at least once (invariant 36):
  the light-crawl re-scan (`docs/d2l_discovery.md#recurring-runs----light-crawl`),
  link refresh, and the Drive weakness-signal write. The weekly diagnostic
  event and Sunday reminder were retired 2026-10-05; daily grade, feedback,
  and announcement news moved to `/daily-overview` (invariants 37/38).
- `.claude/skills/daily-overview/SKILL.md` -- the 5am unattended run
  (invariant 38). It crawls each real course (D2L REST API via in-page
  `fetch`, plus external gradebooks), ingests the crawl, and sends one
  "Daily Overview <CODE>" email per course with news. It also does small
  Calendar upkeep: CLEAR items and link refresh. Scheduled by
  `scripts/register_daily_overview_task.ps1`.
- `.claude/skills/weekly-study-pdf/SKILL.md` -- writes each new week's
  textbook-style study PDF per class (invariant 41). Run daily at 6:30am
  by `scripts/weekly_study_pdf.ps1`; never touches Calendar.
- `.claude/skills/academic-prefs/SKILL.md` -- thin wrapper over
  `academic-sync prefs`.
- `.claude/skills/custom-curriculum/SKILL.md` -- builds a fully synthetic,
  self-directed "class" on a topic the user describes (no real D2L source),
  using the same `Course`/`AcademicItem` model and Calendar-rendering
  pipeline as a real course, flagged `Course.is_synthetic` -- see invariant
  35. Its footprint is `WEEKLY_READING` banners linking real readings
  found online, plus a full per-chapter objectives outline
  (`chapter-topic-add`) that the GPT quiz system tests from. Synced to
  Calendar. No assessments.



The three academic-sync skills should never reimplement logic that belongs
in `src/academic_sync/` -- if you find yourself writing date-parsing or
fingerprinting logic inside a SKILL.md, it belongs in the Python package
instead, where it can be tested.

## The live Google Calendar connector has no `extendedProperties`

`mcp__claude_ai_Google_Calendar__create_event`/`update_event` (the tools
actually available to these skills) do not expose an `extendedProperties`
field, unlike the raw Google Calendar API. `sync/calendar_payload.py` still
documents that field (for standalone-mode purposes) but it is inert against
the live connector. The real idempotency signal available on the Calendar
side is a short fingerprint tag embedded directly in the event
**description** text (`embed_fingerprint_tag`/`extract_fingerprint_tag`),
searchable via `list_events(fullText=...)`. The primary idempotency
mechanism remains the local `SyncRecord` table for `academic-import`.

## Calendar description format: one structured template, no bloat

`build_deadline_description`/`build_meeting_description` in
`sync/calendar_payload.py` produce ONE format for those two item shapes
(a third builder, `build_weekly_reading_description`, exists for
`WEEKLY_READING` items specifically -- see invariant 25 -- with its own
smaller section set, `READING`/`SLIDES & RESOURCES`/`CONTACT`/`DATES`
(links only since 2026-10-16, invariant 25), since
LOCATION/REQUIRED RESOURCES don't apply to a non-graded weekly block; it
still follows every rule below -- HTML, omit-don't-pad, no SOURCE
section). It's real HTML (Calendar
descriptions accept `<b>`/`<br>`/`<a href>` and render them -- confirmed by
creating a live test event and inspecting both the API response and the
rendered popup): an optional `UNGRADED` tag (see invariant 27 -- the only
thing that can precede the header, when the item is confirmed ungraded),
then a plain course-context header line, then bold-headed sections in a
fixed order -- `TOPIC`, `MODULE`, `DETAILS`,
`LOCATION` (meetings only), `REQUIRED RESOURCES` (deadlines only),
`CONTACT`, `LINKS` -- each included only when the source actually had that
information, joined with `<br>`/`<br><br>` (a bare `\n` does not reliably
produce a line break once the field is HTML). `TOPIC` and `MODULE` were
added 2026-08-18 at the user's explicit request for a specific redundant
structure -- Title (repeats `item.title`, already visible in the event
summary), then Module (the real chapter/week nesting, previously folded
into the header as a parenthetical -- now its own section instead), then
the rest, ending in Links. The redundancy between the event summary and the
TOPIC section is intentional, not an oversight: a description read on its
own (e.g. an agenda view) should still say what it's for. `MODULE` is
populated from `nesting`, which both description builders now source from
`item.module_label` by default (see invariant 18) -- don't reintroduce a
path where nesting is computed only at render time and never lands on the
item row. **No `SOURCE` section** -- provenance
(`source_wording`, `Source` rows) stays in the local DB for the pipeline's
own validation, deliberately never rendered into the visible event; the
user found it cluttering. Never pad a missing field with filler ("Not
provided", a guessed generic instruction like "read the chapter" or "see
D2L for details", or the old "Submission/Pathways" D2L-navigation-
breadcrumb style seen in some early-session events) -- omit the section
instead. See `docs/d2l_discovery.md#calendar-titles-and-descriptions` for
the full field-by-field spec, including `AcademicItem.points`/`.is_optional`
(optional/extra-credit/ungraded items get a title suffix and the
top-of-description `UNGRADED` tag -- never inferred from item_type, only
from an explicit signal in the source; `points` itself no longer renders
anywhere, see invariant 27) and `.reference_url`/`.reference_url_label`/`.resource_url`/
`.resource_url_label` (real clickable labeled links -- prefer linking the
actual assignment turn-in page over a general area, never construct or
guess a URL; see `docs/d2l_discovery.md#links-academicitemreferenceurlreferenceurllabel-academicitemresourceurlresourceurllabel`
for the specificity ladder). The fingerprint tag itself is wrapped in
`<small>` (visually de-emphasized, still fullText-searchable) -- see
`docs/d2l_discovery.md#the-fingerprint-tag-cant-hide-it-can-shrink-it-small`
for the three things that were actually tried (hiding in an HTML comment
breaks search; inline `style=` is stripped by the sanitizer; `<small>`
survives) -- don't re-attempt any of this without re-running the same
empirical create_event + list_events(fullText=...) test.

The `compact: bool` parameter on both functions no longer changes the
output shape -- it's kept only so existing call sites don't need editing.
Earlier in this project a `compact=True` mode existed specifically to trim
token cost (the live connector echoes the description back in its tool-call
response, so a bloated description cost roughly 2x per event) by dropping
section labels entirely; that traded away readability the user later asked
to have back. The fix wasn't to keep two formats -- it was to make the one
format lean enough (short headers, zero filler, no redundant boilerplate)
that it doesn't need a "cheap" alternative. If a future token-cost concern
comes up again, tighten the shared template further; don't reintroduce a
second, less-readable code path to switch between.
