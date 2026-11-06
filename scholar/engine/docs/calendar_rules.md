# Calendar semantics reference

This documents the rules implemented in `sync/calendar_payload.py` and
enforced by `tests/test_calendar_payload.py`. If you change behavior here,
update both the code and this doc together.

## Global defaults

| Setting | Default | Preference key |
|---|---|---|
| Timezone | `America/Denver` | `timezone` |
| Target calendar | primary calendar | `target_calendar_id` |
| Event color | colorId `10` (dark green / Basil) | `calendar_color_id` |
| Default reminders | off | `default_reminders_enabled` |
| Guests invited | never | `invite_guests` (should stay `False`) |
| Google Meet links | never created | `create_meet_links` (should stay `False`) |
| Default due time (date-only source) | `23:59` | `default_due_time` |

Every payload sets `reminders: {useDefault: false, overrides: []}` and
`guestsCanInviteOthers: false`, and never includes an `attendees` key or a
`conferenceData` block. This is a hard invariant, not a default that gets
overridden by preference -- see CLAUDE.md.

## Titles

**Superseded 2026-08-18** -- this section previously described a format
(`<Course Code> - <Meeting Label>[ (<Topic>)]` for meetings, no
course-code prefix on other deadlines) that no longer matches the code.
**`docs/d2l_discovery.md#calendar-titles-and-descriptions` is now the
authoritative spec** for titles (and descriptions) -- read it there, not
here, to avoid this file drifting out of sync with the code again the way
it just did. Quick orientation so this file still stands alone for the
parts below that *are* current:

- **Fixed-time meetings**: `CODE (Section N) Label — Topic` (em dash, not
  parenthetical; section included when the course has one).
- **Deadlines** (including administrative deadlines): `CODE Title Due` /
  `CODE Title Deadline` -- **do** carry a course-code prefix now (this
  file previously said the opposite).
- **Optional/extra-credit items** (`AcademicItem.is_optional`): ` (Optional)`
  appended at the end of the title.
- **Breaks**: the extracted title, verbatim (e.g. `Thanksgiving Break`).

No checkbox characters, ever. A leading word redundant with the meeting
label itself (e.g. a topic string that still starts with "Lecture") is
stripped so titles don't read "Lecture — Lecture: Evolution".

## Timing

- **Meetings**: `start`/`end` as `dateTime` using `item.start_time`/
  `item.end_time` when both are known; if only a start time is known, end
  defaults to start + `default_meeting_duration_minutes` (50). A meeting
  item with no `start_time` at all is never synced -- see
  `AcademicItem.is_ready_to_sync()`, which fixed-time meetings fail without
  one, producing a `REVIEW` plan entry instead of `CREATE`.
- **Deadlines**: `start`/`end` as `dateTime` using `item.due_time` (falls
  back to 23:59 if somehow unset at payload-build time, though extraction
  should have already resolved it), with a 1-minute duration
  (`no_meaningful_duration_minutes`). This uses full `datetime` arithmetic
  (not bare `time`-of-day math) so a 23:59 due time correctly rolls its
  1-minute event into 00:00 the *next* calendar day rather than wrapping
  back onto the same day and producing an end time before the start time --
  see the regression test `test_deadline_event_uses_due_time_and_short_duration`.
- **Breaks**: all-day (`start`/`end` as `date`, not `dateTime`).
- **A plain `READING` item**: never synced as its own event, at any
  `due_time` value -- `build_event_payload` raises `ValueError`
  unconditionally for `ItemType.READING` (CLAUDE.md invariant 25, superseded
  2026-08-24; this file previously described readings as syncing as their
  own all-day/timed event, which is no longer true). A graded item with an
  explicit due time (e.g. a reading-response quiz) is extracted as its own
  graded `ItemType` instead -- `QUIZ`/`ASSIGNMENT`/etc., not `READING` --
  and syncs normally as a timed deadline like any other graded item.
- **`WEEKLY_READING`**: multi-day all-day (`start`/`end` as `date`, exclusive
  end = `item.date_range_end + 1 day` -- `item.date` is the week's start).
  One per course per real reading week; this is now the sole vehicle for
  non-graded reading/topic content reaching Calendar (alongside folding a
  same-day match into a covering lecture's own DETAILS) -- see
  `docs/d2l_discovery.md#weekly-reading-blocks`. Optional/extra-credit
  items follow the general rule regardless of type -- include them, note
  "(Optional)"/"(Extra Credit)" in the title or description when the source
  says so, never drop them.

## Due-time normalization

Implemented in `extraction/dates.py::normalize_due_datetime`. Precedence:

1. An explicit stated time ("due at 5:00 PM") wins outright.
2. "Due before class" uses that class's own start time, if known.
3. "Midnight" / "end of day" phrasing maps to 23:59.
4. Otherwise, the configured `default_due_time` (23:59 out of the box).

Never invents a date -- this function only ever resolves the time-of-day
component for a date that was already found in the source text.

## Locations

`sync/calendar_payload.py::LocationInfo.google_location_string()` builds:

```
[Venue/Campus], [Street Address], [City], [State] [ZIP], [Room]
```

using only the parts actually known -- an online/platform location string
(e.g. "Zoom -- see D2L for link"), if set, is used as-is instead. A course
with two rooms and no clear lecture/lab mapping does not get a guessed
location; both rooms are combined into one string (e.g. "Example Campus Main Hall
Campus, E112 & W201") rather than assigning one room to lecture and the
other to lab, which becomes an unresolved reference
(`UnresolvedReferenceKind.AMBIGUOUS_LOCATION`) until the user resolves it
(then it's saved as a location preference/mapping, reusable across future
scans).

**Online courses**: when a course's `delivery_format` is `Online` (stated
directly in its syllabus, e.g. "MAT 1340 Online" or "...w/Lab ONLINE!"),
default every item's `platform_location` to the literal string `"Online"`
rather than leaving location blank or unresolved -- there is no ambiguity to
flag, the course genuinely has no physical room. Set both the course record
(`Course.delivery_format = "Online"`) and a course-scoped `platform_location`
preference so future re-scans of that course apply it automatically without
re-asking. A `Classroom Based` course keeps normal room/campus handling.

## Descriptions

**Superseded 2026-08-18** -- see
`docs/d2l_discovery.md#calendar-titles-and-descriptions` for the current,
authoritative shape (real HTML, an optional top-of-description `UNGRADED`
tag -- and, independently, an optional `(Inferred Date)` tag in the same
slot per CLAUDE.md invariant 29, see
`docs/d2l_discovery.md#inferred-dates-academicitemis_inferred_date-date_inference_rule`
-- then bold-headed `TOPIC`/`DETAILS`/`LOCATION`/`REQUIRED RESOURCES`/
`CONTACT`/`LINKS` sections, no `SOURCE` section, labeled clickable links via
`AcademicItem.reference_url`/`.resource_url`). The one constant that hasn't
changed: only sections with actual data are included; nothing is invented
to fill one. Use `uv run academic-sync render <item_id>` to see the exact
computed output for a real item rather than reconstructing the template by
hand from prose (see the `academic-import` SKILL.md, Step 5). A large
DETAILS/THIS WEEK block (exhaustive chapter-topic capture, CLAUDE.md
invariant 26) may get truncated at render time against Google Calendar's
real ~8,192-char description limit -- see
`docs/d2l_discovery.md#calendar-description-length-budget`.

## Idempotency payload fields

`build_event_payload` includes an `extendedProperties.private` block
(`academic_sync_fingerprint`, `academic_sync_item_id`) in the dict it
returns, but **the live Google Calendar connector used by the
`academic-import` skill
(`mcp__claude_ai_Google_Calendar__create_event`/`update_event`) has no
`extendedProperties` parameter** -- that part of the payload is inert
against the real tool and only documents what a raw Google Calendar API
call (standalone mode, see `docs/architecture.md#standalone-mode`) would
carry.

What the skill can actually rely on, in order:

1. **The local `SyncRecord` table** -- the real, primary idempotency
   mechanism. Every applied CREATE/UPDATE is recorded via
   `academic-sync record-sync` immediately after the write succeeds --
   including `last_synced_fields` (added 2026-08-25,
   `reconciliation/engine.py::snapshot_compared_fields`), a real snapshot
   of the compared fields at that exact moment. This is what lets `plan`
   correctly classify UPDATE vs UNCHANGED for an item enriched directly
   via `render --save` *after* its first sync (module_label,
   reference_url, etc.) -- comparing current state against this snapshot
   instead of against the row's own current state, which would trivially
   never show a diff in standalone `plan` mode. See CLAUDE.md invariant 5's
   2026-08-25 amendment for the real incident this closes.
2. **A fingerprint tag embedded in the visible event description**
   (`embed_fingerprint_tag`/`extract_fingerprint_tag`, e.g.
   `[academic-sync:fp:<hex>]` appended after the human-readable description
   text, wrapped in `<small>` for visual de-emphasis without hiding it --
   see `docs/d2l_discovery.md#the-fingerprint-tag-cant-hide-it-can-shrink-it-small`
   for why it can't be fully hidden) -- a Calendar-side backstop the skill
   can search for via `list_events(fullText=...)` before creating, in case
   local state and Calendar ever drift out of sync (e.g. local DB was
   reset but Calendar wasn't).
