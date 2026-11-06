# Architecture

## Why this isn't a standalone OAuth + Playwright app

The original design brief for this system assumed a fully standalone Python
app: its own Google OAuth client, its own Playwright-driven browser
automation, its own persisted session cookies. That's a reasonable design
*in isolation*, but this system is being built and operated from inside
Claude Code, which already has:

- **Live, authorized Google Calendar access** for this user's account (the
  `mcp__claude_ai_Google_Calendar__*` connector), and
- **Live browser control** over the user's actual Chrome session
  (`claude-in-chrome`), which can navigate to D2L, wait for the user to
  complete SSO/MFA interactively, and read the resulting pages.

Building a parallel OAuth-token-refresh pipeline and a parallel headless
browser stack to do the *same two things* Claude Code can already do live
would be pure duplicated surface area: two credential stores to secure
instead of zero, two places browser automation can silently drift from the
site's real markup, and no benefit in return. So the architecture pushes
those two responsibilities to the two Claude Code skills, and keeps the
Python package to the parts that must be deterministic, replayable, and
unit-tested: parsing, extraction, completeness analysis, deduplication, and
local persistence.

The trade-off, stated plainly: this design cannot run as a fully headless
cron job with zero human present, because D2L login may require interactive
MFA. See "Scheduled sync" below for what that means in practice. If a truly
headless mode is ever needed, "Standalone mode" below describes what would
have to be added -- but that is out of scope unless explicitly requested,
since it reintroduces the credential-management surface this design
deliberately avoided.

## Pipeline stages

```
SCAN -> EXTRACT -> NORMALIZE -> AUDIT -> PLAN -> SYNC
```

- **SCAN** (skill): browser-navigate D2L, identify course areas worth
  reading (content, syllabus, calendar, dropbox, quizzes, discussions,
  checklists, announcements, schedule pages, linked PDFs), download/read
  them.
- **EXTRACT** (`academic_sync.parsers` + `academic_sync.extraction`): turn a
  raw file into a `ParsedDocument` (HTML/PDF parsers), then run the
  deterministic pipeline (`extraction/pipeline.py`) that classifies lines
  and table rows into candidate `AcademicItem`s and flags reference phrases
  as `UnresolvedReference`s.
- **NORMALIZE** (`academic_sync.reconciliation.fingerprint`): every
  candidate item gets a stable fingerprint independent of exact wording, so
  the same logical obligation extracted twice (once from a syllabus, once
  from a revised D2L page) is recognized as the same item.
- **AUDIT** (`academic_sync.completeness`): per course, determine
  `COMPLETE` / `COMPLETE_FOR_DATED_ITEMS` / `INCOMPLETE` / `CONFLICTED` /
  `UNKNOWN`, and produce the list of open unresolved references.
- **PLAN** (`academic_sync.sync.planner` + `reconciliation.engine`): compare
  each candidate item against whatever is already stored under the same
  fingerprint (and its `SyncRecord`), producing a `CREATE` / `UPDATE` /
  `UNCHANGED` / `CONFLICT` / `REVIEW` / `IGNORE` / `CANCELLED_BY_SOURCE`
  decision per item -- without writing anything.
- **SYNC** (skill, using `sync.calendar_payload` to build the payload): on
  user approval, call the Google Calendar connector for each CREATE/UPDATE,
  then call `academic-sync record-sync` to persist the resulting event ID
  and mark the item `SYNCED`.

## Why the CLI's `extract` command computes the plan itself

`sync.planner.compute_plan` needs to compare a *freshly extracted* item
against whatever was stored *before* this extraction, to tell CREATE from
UPDATE from UNCHANGED correctly. If extraction immediately overwrote the
canonical `academic_items` row (via `upsert_academic_item`) before that
comparison happened, the "before" state would already be gone by the time
anyone asked for a plan -- reconciliation would always see `existing ==
incoming` and never detect a real change.

So `cli.py::extract_cmd` sequences it correctly in one pass: parse -> run
extraction -> **compute the plan against current stored state** -> persist
unresolved references -> **then** upsert the extracted items. A standalone
`academic-sync plan` invocation (not immediately following an `extract`)
necessarily just reflects current sync status (CREATE for anything without a
Calendar event yet, UNCHANGED for anything that has one) since there's no
"incoming vs. existing" delta to compute outside of an actual re-extraction.
This is intentional, not a missing feature -- the meaningful diff only
exists at the moment of re-extraction, which is exactly when the
`academic-import` skill will show it to the user before applying anything.

## Data model

See `src/academic_sync/models/domain.py` (Pydantic, in-memory/transport) and
`src/academic_sync/db/orm.py` (SQLAlchemy, persisted) for the authoritative
field lists. Summary of the entities and why each exists:

- **Course**: identity + term + instructor + meeting metadata. Reconciled
  from D2L metadata and syllabus metadata; conflicts between the two are
  stored, not silently resolved (no UI for that reconciliation exists yet in
  this MVP -- it surfaces as an unresolved reference).
- **Source**: provenance record for every document/page read. `content_hash`
  drives change detection (re-scans of identical content are a no-op);
  `raw_text` is retained so the extraction pipeline can be re-run offline
  without re-fetching.
- **AcademicItem**: the normalized obligation. Carries `fingerprint` (stable
  identity), `status` (draft/clear/unresolved/conflicted/superseded/
  cancelled/synced), `confidence`, `is_tentative`, and full provenance
  (`source_ids`, `source_wording`, `source_hash`).
- **UnresolvedReference**: anything the system deliberately declined to
  resolve, with a `kind` (missing date, ambiguous location, external
  reference uninspected, conflicting sources, derived-date-broken-by-holiday,
  unconfirmed recurrence) and a human-readable reason.
- **Preference**: reusable, explicitly-set configuration, global or
  course-scoped (course-scoped wins).
- **SyncRecord**: the one-to-one link between an `AcademicItem` and the
  Google Calendar event it produced, plus the fingerprint that was live at
  last sync -- this is what lets reconciliation tell UPDATE from UNCHANGED.
- **AuditLog**: append-only record of source discovery, extraction,
  Calendar writes, preference changes, and conflicts.

## Fingerprinting and idempotency

See `reconciliation/fingerprint.py`. The identity used for a fingerprint is
`(course_id, item_type, canonical_title)`, where `canonical_title` prefers a
sequence number extracted from the title ("Quiz 4" and "Online Quiz #4 (Ch.
9-10)" both canonicalize to `quiz-4`) and falls back to a cleaned full title
plus an optional disambiguator (module/week label) when no number is
present. Deliberately, **the date is never part of the fingerprint** for
numbered items -- a corrected due date must produce an UPDATE, not a new
CREATE, which would be the failure mode if date were part of identity.

The fingerprint (truncated) is also written into the Google Calendar event's
`extendedProperties.private` when the event is created, so a re-scan could
in principle recognize "this event is ours" even if local state were lost --
though the primary idempotency mechanism is the local `SyncRecord` table,
not a Calendar search.

## Completeness

See `completeness/analyzer.py`. The rule that matters most: a course with
only a syllabus scanned is `INCOMPLETE`, `COMPLETE_FOR_DATED_ITEMS`, or
`UNKNOWN` -- never `COMPLETE` -- unless every "typical" source type
(`TYPICAL_SOURCE_TYPES`) has actually been inspected and nothing in the text
pointed elsewhere. `COMPLETE_FOR_DATED_ITEMS` covers the common real case: no
open references to uninspected material, no undated graded work, but not
every D2L area was scanned (maybe the course genuinely doesn't use
Discussions). `safe_to_sync_clear_subset` is true in the normal case
regardless of course-level status -- item-level `status` is the actual sync
gate (see CLAUDE.md invariant 8).

## Reconciliation and precedence

`reconciliation/engine.py::decide_action` is the single place that turns
"here's an incoming item, here's what's stored, here's its sync record" into
one of `CREATE/UPDATE/UNCHANGED/CONFLICT/REVIEW/IGNORE/CANCELLED_BY_SOURCE`.
`reconciliation/precedence.py::resolve` is a separate, narrower piece:
*when two sources disagree on a date for what's evidently the same
deliverable*, it decides whether there's a defensible resolution (an
announcement overrides a syllabus; a direct D2L operational page overrides a
generic syllabus mention; a same-source-type re-scan is treated as a
revision) or whether it's a genuine conflict requiring review. It does not
attempt a single global precedence ranking, on purpose -- see the spec
section this was built against and CLAUDE.md invariant 9.

## Calendar payload construction

`sync/calendar_payload.py` builds the dict handed to the Calendar
connector's `create_event`/`update_event` call. It is pure data
construction -- no network calls -- which is what makes
`tests/test_calendar_payload.py` able to assert things like "no `attendees`
key ever appears" without mocking a client. See `docs/calendar_rules.md` for
the title/description/timing rules it implements.

## Standalone mode (not built, here for context if ever requested)

If a fully headless, Claude-independent deployment were ever needed:

- Add a Google OAuth installed-app flow (`google-auth-oauthlib`), store
  refresh tokens outside git (`.env`/`token.json`, already gitignored).
- Add a Playwright-based D2L adapter with a persisted storage-state file
  (also gitignored), with an interactive first-login step to capture SSO/MFA
  once, then session reuse until expiry.
- Everything else -- parsers, extraction, completeness, reconciliation,
  preferences, the CLI -- stays as-is; only the two "live tool" boundaries
  (D2L access, Calendar access) would need real network clients behind the
  same interfaces the skills currently call into directly.

This is explicitly not built because it reintroduces credential-management
risk for no benefit while Claude Code is the operating environment. Don't
build it speculatively; build it if and when headless operation is actually
requested.
