"""Builds Google Calendar event payload dicts.

This module only constructs data structures -- it never calls a network API.
The academic-import skill takes the resulting dict and passes it to Claude's
Google Calendar connector (create_event/update_event). Keeping payload
construction here, decoupled from any Google client, is what makes it
unit-testable (see tests/test_calendar_payload.py).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from typing import Any

from academic_sync.chapter_topics import (
    ADDED_LABEL,
    ReadingEntry,
    added_items,
    build_reading_entries,
    canonicalize_chapter_label,
    split_chapter_segments,
    study_items,
)
from academic_sync.models.domain import AcademicItem, ChapterTopic, Course, Source, WeeklyLink
from academic_sync.models.enums import DiagnosticStatus, ItemType, SourceType
from academic_sync.reconciliation.fingerprint import compute_calendar_fingerprint

# source_type values that mean "this item's home is the LMS itself" -- the
# MODULE line names these "D2L" rather than something more granular (e.g.
# "D2L Dropbox"), since that's the platform the user actually navigates to,
# not the internal category. Anything not in this set and not
# EXTERNAL_COURSEWARE (documents, PDFs, etc.) has no clear "platform" to
# name, so the MODULE line omits the prefix rather than guess one.
_D2L_SOURCE_TYPES = {
    SourceType.D2L_CONTENT,
    SourceType.D2L_CALENDAR,
    SourceType.D2L_DROPBOX,
    SourceType.D2L_QUIZZES,
    SourceType.D2L_DISCUSSIONS,
    SourceType.D2L_CHECKLIST,
    SourceType.D2L_ANNOUNCEMENTS,
    SourceType.D2L_SCHEDULE_PAGE,
    SourceType.D2L_HOME,
}


def platform_label_for_source(source: Source | None) -> str | None:
    """What to call the place this item actually lives, for the MODULE line
    (see CLAUDE.md invariant on external courseware). Deliberately generic:
    D2L source types are labeled "D2L"; an EXTERNAL_COURSEWARE source is
    labeled with its own real title (whatever it is -- "ALEKS", "Pearson
    MyLab", something not yet seen in this codebase -- never a hardcoded
    name list, since discovery finds these live by following a shell link
    off the LMS's own domain, not by matching a known name). Anything else
    (syllabus, a linked PDF/doc, a lab handout) has no single "platform" to
    name truthfully, so this returns None and the caller omits the prefix."""
    if source is None:
        return None
    if source.source_type in _D2L_SOURCE_TYPES:
        return "D2L"
    if source.source_type == SourceType.EXTERNAL_COURSEWARE:
        return source.title
    return None

FINGERPRINT_PRIVATE_KEY = "academic_sync_fingerprint"
ITEM_ID_PRIVATE_KEY = "academic_sync_item_id"

# The live Google Calendar connector available to the academic-import skill
# (mcp__claude_ai_Google_Calendar__create_event / update_event) does NOT
# expose extendedProperties -- there is no private-metadata channel on that
# tool. `extendedProperties` below is kept in the payload dict for
# documentation/standalone-mode purposes (see docs/architecture.md#standalone-mode),
# but the skill cannot actually send it. The fingerprint tag embedded in the
# *description* text (FINGERPRINT_TAG_PREFIX/SUFFIX) is what the skill can
# actually rely on as a Calendar-side defense-in-depth check (via
# list_events fullText search) on top of the primary idempotency mechanism,
# the local SyncRecord table.
#
# This tag must stay in VISIBLE text -- confirmed empirically (session
# 2026-08-18) that Google Calendar's fullText search does not index text
# inside an HTML comment (<!-- ... -->), so hiding the tag that way breaks
# the backstop it exists for. Two shrink/de-emphasis approaches were then
# tried: inline `style="font-size:...;color:..."` on a <span> is stripped
# by Calendar's sanitizer (rendered at normal size/color, confirmed by
# inspecting the popup) -- but wrapping in the semantic `<small>` tag
# *is* preserved (visibly smaller text in the rendered popup) and remains
# fullText-searchable (confirmed by creating a real event and searching for
# the tag content). So the tag is wrapped in `<small>` -- smaller, but not
# hidden, which is the best achievable balance between "the idempotency
# backstop still works" and "not visually shouting at the bottom of every
# event." If a future session wants to try something else here, re-verify with a
# real create_event + list_events(fullText=...) round trip first -- don't
# assume a new trick works without testing it the same way; sanitizer
# behavior isn't documented and doesn't follow an obvious rule (tag-based
# `<small>` survives, attribute-based `style=` doesn't).
FINGERPRINT_TAG_PREFIX = "[academic-sync:fp:"
FINGERPRINT_TAG_SUFFIX = "]"


def embed_fingerprint_tag(description: str, fingerprint: str | None) -> str:
    """Append a short, searchable fingerprint tag to an event description,
    wrapped in `<small>` so it's visually de-emphasized without being
    hidden (hiding it, e.g. in an HTML comment, breaks fullText search --
    see the comment above). Uses an HTML line break (descriptions are HTML
    now, see `_section`) so the tag visibly starts on its own line rather
    than running into the last sentence -- a bare "\\n\\n" would collapse
    under HTML rendering."""
    if not fingerprint:
        return description
    tag = f"{FINGERPRINT_TAG_PREFIX}{compute_calendar_fingerprint(fingerprint)}{FINGERPRINT_TAG_SUFFIX}"
    small_tag = f"<small>{tag}</small>"
    return f"{description}<br><br>{small_tag}" if description else small_tag


def extract_fingerprint_tag(description: str) -> str | None:
    """Inverse of embed_fingerprint_tag -- used when re-checking an existing
    Calendar event's description against local state."""
    if FINGERPRINT_TAG_PREFIX not in description:
        return None
    start = description.index(FINGERPRINT_TAG_PREFIX) + len(FINGERPRINT_TAG_PREFIX)
    end = description.index(FINGERPRINT_TAG_SUFFIX, start)
    return description[start:end]

_MEETING_LABELS: dict[ItemType, str] = {
    ItemType.LECTURE: "Lecture",
    ItemType.LAB: "Lab",
    ItemType.RECITATION: "Recitation",
    ItemType.SEMINAR: "Seminar",
    ItemType.EXAM: "Exam",
    ItemType.FINAL_EXAM: "Final Exam",
    ItemType.LAB_PRACTICAL: "Lab Practical",
    ItemType.PRESENTATION: "Presentation",
}

# Leading words redundant with the meeting label itself, stripped from a
# topic string so we don't render "BIO 1112 - Lecture (Lecture: Evolution)".
_REDUNDANT_LEADING_WORDS = {"lecture", "lab", "recitation", "seminar", "exam", "presentation"}


@dataclass
class LocationInfo:
    campus: str | None = None
    building: str | None = None
    room: str | None = None
    street_address: str | None = None
    city: str | None = None
    state: str | None = None
    zip_code: str | None = None
    platform_location: str | None = None

    def google_location_string(self) -> str | None:
        if self.platform_location:
            return self.platform_location
        parts = [p for p in [self.campus, self.street_address, self.city] if p]
        if self.state and self.zip_code:
            parts.append(f"{self.state} {self.zip_code}")
        if self.room:
            parts.append(self.room)
        return ", ".join(parts) if parts else None


def _strip_redundant_leading_word(topic: str, item_type: ItemType) -> str:
    words = topic.split()
    if words and words[0].lower().strip(":") in _REDUNDANT_LEADING_WORDS:
        words = words[1:]
    return " ".join(words).strip(" :-")


def _topic_line(topic: str) -> str:
    """A lecture spanning multiple chapters gets one spaced block per
    chapter ("Chapter N:<br>Topic name;") instead of a single run-on
    sentence -- see CLAUDE.md invariant 22 and docs/d2l_discovery.md's
    content-depth section, matching a real event the user hand-edited to
    demonstrate the wanted shape. Only reshapes when the title actually
    splits into multiple "; "-separated segments with at least one
    "Chapter N: ..." segment among them -- a single-topic title (the
    overwhelming majority of meetings) is returned unchanged, so this can
    never regress an already-correct simple TOPIC line.

    Segment-splitting itself is `chapter_topics.split_chapter_segments` --
    the same parser `chapter_topics.build_chapter_topic_blocks` uses for a
    weekly reading block's THIS WEEK content, so there's one canonical
    "Chapter N: Topic" parser in the codebase, not two."""
    segments = split_chapter_segments(topic)
    if len(segments) < 2 or not any(label is not None for label, _ in segments):
        return topic
    blocks = []
    for label, text in segments:
        if label is None:
            blocks.append(f"{text};")
        elif text:
            blocks.append(f"{label}:<br>{text};")
        else:
            # A bare "Chapter N" segment with no topic text (e.g. CHE1011's
            # real chapter labels never carry a title) -- omit the empty
            # "<br>;" that would otherwise follow.
            blocks.append(f"{label};")
    return "<br><br>".join(blocks)


def _optional_suffix(item: AcademicItem) -> str:
    """" (Optional)" when the source explicitly marked this item as extra
    credit / ungraded practice -- never inferred from item_type alone (a
    plain reading isn't "optional" just because it syncs as an informational
    all-day event; see CLAUDE.md invariant 15)."""
    return " (Optional)" if item.is_optional else ""


def _format_date_range(start: Any, end: Any) -> str:
    """"Aug 31 - Sep 6" across a month boundary, "Sep 7 - 13" within one --
    used for a WEEKLY_READING item's DATES section (see
    build_weekly_reading_description). Deliberately
    avoids strftime's "%-d"/"%#d" no-leading-zero flags -- "%-d" is a
    glibc-only extension that raises on Windows' C runtime, and this
    project runs there (see CLAUDE.md's platform notes)."""
    if start.month == end.month:
        return f"{start.strftime('%b')} {start.day} - {end.day}"
    return f"{start.strftime('%b')} {start.day} - {end.strftime('%b')} {end.day}"


def build_title(item: AcademicItem, course: Course, *, include_topic: bool = True) -> str:
    code = course.course_code

    # A fixed-time-meeting-typed item that carries a due_time is an
    # async/online exam window (see extraction/pipeline.py) -- it gets
    # deadline-style title formatting ("Exam 2 Due"), not meeting-style
    # ("CODE - Exam"), since there's no classroom slot to name.
    if item.item_type.is_fixed_time_meeting and item.due_time is None:
        label = _MEETING_LABELS.get(item.item_type, item.item_type.value.replace("_", " ").title())
        topic = _strip_redundant_leading_word(item.title or "", item.item_type)
        # "CODE (Section N) Label — Topic" -- matches the user's own
        # existing in-person event naming convention (see e.g. their real
        # "BIO 1111 (Sections 151/152) Lecture — Chapters 2 and 3: ..."
        # events). Section called out for in-person meetings specifically
        # since a student juggling multiple sections needs it at a glance;
        # an em dash before the topic reads cleaner than trailing parens
        # once a section is already parenthesized.
        section = f" (Section {course.section})" if course.section else ""
        suffix = f" — {topic}" if include_topic and topic else ""
        return f"{code}{section} {label}{suffix}{_optional_suffix(item)}"

    if item.item_type == ItemType.ADMINISTRATIVE_DEADLINE:
        title = item.title.strip()
        if not title.lower().endswith("deadline"):
            title = f"{title} Deadline"
        return f"{code} {title}"

    if item.item_type == ItemType.BREAK:
        return item.title.strip()

    if item.item_type == ItemType.WEEKLY_READING:
        if item.date is None or item.date_range_end is None:
            raise ValueError("Cannot build a title for a weekly reading block with no date range.")
        # User-directed, 2026-08-25: no date range in the title -- the
        # title is just "<CODE> Weekly Overview"; the real date range moves
        # into the description's own DATES section instead (see
        # build_weekly_reading_description).
        return f"{code} Weekly Overview"

    base = item.title.strip()
    if not base.lower().endswith("due"):
        base = f"{base} Due"
    return f"{code} {base}{_optional_suffix(item)}"


DESCRIPTION_CHAR_BUDGET = 8192
"""Google Calendar's real event-description length limit. See
https://support.nylas.com/hc/en-us/articles/10571467644957-Event-Description-Limits-in-Google-Calendar-and-Microsoft-Exchange.
Exhaustive chapter/unit capture (CLAUDE.md invariant 26) can legitimately
produce hundreds of real objective lines for one chapter -- this caps how
much of that ends up in one Calendar description without ever capping how
much gets *captured* locally (`ChapterTopic.objectives` has no cap)."""

_BUDGET_RESERVE = 300
"""Headroom subtracted from DESCRIPTION_CHAR_BUDGET before truncation
kicks in -- covers the fingerprint tag `build_event_payload` appends after
this module hands back a description (see `embed_fingerprint_tag`, ~70-90
chars in practice) plus `_truncate_html_block`'s own truncation note
(~130 chars). Deliberately generous rather than exact -- this is a soft
safety margin under a real hard limit, not a tight bound."""


def _truncate_html_block(html: str, budget: int) -> str:
    """Cuts `html` (a run of "<br>"-joined segments, as every section this
    module builds is) at the last complete segment that fits within
    `budget`, never mid-tag -- splitting on the literal "<br>" substring is
    safe and exactly reversible for this module's own output (a bullet
    list's items, or `<b>Label:</b><br>` followed by its content) since
    nothing else here ever contains that substring. When content had to be
    dropped, appends a visible note stating how many real captured lines
    were left out -- never silent, and never a fabricated summary standing
    in for what was cut; the full capture still exists locally
    (`chapter-topic-add` / `academic-sync render`), just not inline in
    this one event description. May render slightly over `budget` to fit
    that note -- callers should pass a budget with headroom (see
    `_BUDGET_RESERVE`), not the hard limit itself."""
    if len(html) <= budget:
        return html
    if budget <= 0:
        segments = [s for s in html.split("<br>") if s.strip()]
        return (
            f"<i>+{len(segments)} more captured line(s) not shown here for length -- "
            "full list saved locally (chapter-topic-add / academic-sync render).</i>"
        )
    segments = html.split("<br>")
    kept: list[str] = []
    total = 0
    for i, seg in enumerate(segments):
        sep_cost = len("<br>") if kept else 0
        if total + sep_cost + len(seg) > budget:
            remaining = len([s for s in segments[i:] if s.strip()])
            note = (
                f"<br><i>+{remaining} more captured line(s) not shown here for length -- "
                "full list saved locally (chapter-topic-add / academic-sync render).</i>"
            )
            return "<br>".join(kept) + note
        kept.append(seg)
        total += sep_cost + len(seg)
    return "<br>".join(kept)


_MIN_FLEXIBLE_CHARS = 1000
"""Space a banner's TOPIC DETAIL keeps (when it has that much) before its
resource list is allowed to use the rest of the budget."""

_LINES_NOTE = (
    "more captured line(s) not shown here for length -- full list saved locally "
    "(chapter-topic-add / academic-sync render)."
)
_LINKS_NOTE = "more link(s) not shown here for length -- open the chapter module in D2L for the rest."
_EXAM_LINES_NOTE = (
    "more concept line(s) not shown here for length -- each chapter's weekly overview "
    "event has its full list."
)


def _assemble_within_budget(
    blocks: list[str], flexible_index: int, secondary_index: int | None = None
) -> str:
    """Joins `blocks` with this module's standard "<br><br>" separator,
    truncating only `blocks[flexible_index]` -- the one caller-supplied,
    potentially-large content block (a DETAILS or THIS WEEK section built
    from exhaustive chapter-topic capture) -- if the full join would
    exceed Calendar's real description limit. Every other section (header,
    MODULE, CONTACT, LINKS, DATES, etc.) is always small and always
    wanted, so it's never the one sacrificed to make room."""
    joined = "<br><br>".join(blocks)
    if len(joined) <= DESCRIPTION_CHAR_BUDGET - _BUDGET_RESERVE:
        return joined
    separator_cost = len("<br><br>") * (len(blocks) - 1)
    blocks = list(blocks)
    other_cost = sum(len(b) for i, b in enumerate(blocks) if i != flexible_index)
    remaining = DESCRIPTION_CHAR_BUDGET - _BUDGET_RESERVE - separator_cost - other_cost
    want = min(len(blocks[flexible_index]), _MIN_FLEXIBLE_CHARS)
    if secondary_index is not None and remaining < want:
        # A long resource list must not crowd out the topic detail entirely
        # (the quiz GPT reads it): trim the resources first so the detail
        # block keeps at least `_MIN_FLEXIBLE_CHARS`.
        target = max(len(blocks[secondary_index]) - (want - remaining), 0)
        blocks[secondary_index] = _truncate_html_block(blocks[secondary_index], target).replace(
            _LINES_NOTE, _LINKS_NOTE
        )
        other_cost = sum(len(b) for i, b in enumerate(blocks) if i != flexible_index)
        remaining = DESCRIPTION_CHAR_BUDGET - _BUDGET_RESERVE - separator_cost - other_cost
    blocks[flexible_index] = _truncate_html_block(blocks[flexible_index], max(remaining, 0))
    joined = "<br><br>".join(blocks)
    hard_limit = DESCRIPTION_CHAR_BUDGET - 120  # room left for the fingerprint tag
    if secondary_index is not None and len(joined) > hard_limit:
        # Still over the real limit even with the main block cut: trim the
        # secondary block (a banner's resource list) at the line level, with
        # a visible note.
        over = len(joined) - hard_limit
        target = max(len(blocks[secondary_index]) - over - 120, 0)
        blocks[secondary_index] = _truncate_html_block(blocks[secondary_index], target).replace(
            _LINES_NOTE, _LINKS_NOTE
        )
        joined = "<br><br>".join(blocks)
    return joined


def _section(label: str, value: str) -> str:
    """A bold header line followed by its content -- only ever called with a
    real value. Never pad a missing field with filler like "Not provided";
    the caller omits the whole section instead (see CLAUDE.md /
    docs/d2l_discovery.md). Descriptions are HTML (confirmed working,
    including real hyperlinks -- see `_reference_lines`), so a literal
    "\\n" here would collapse under rendering; `<br>` is required."""
    return f"<b>{label}</b><br>{value}"


@dataclass
class DetailsBlock:
    """One labeled sub-group within a DETAILS section -- e.g. "Vocabulary:
    <comma list>" (a `text` block) or "Objectives:" followed by one bullet
    line per item (an `items` block). Exactly one of `text`/`items` should
    be set; `format_details_blocks` doesn't enforce this itself (a caller
    building blocks programmatically may reasonably always set both to
    None/empty and skip appending the block instead)."""

    label: str | None = None
    text: str | None = None
    items: list[str] | None = None


def format_details_blocks(blocks: list[DetailsBlock]) -> str:
    """Renders a DETAILS section as labeled sub-groups instead of one
    run-on paragraph -- e.g. a lecture's real vocabulary list and
    objectives sentence, split into scannable pieces. This is a pure
    *presentation* transform: callers must only ever pass real source
    content (splitting on delimiters the source itself already used, e.g.
    a semicolon-chained objectives sentence becoming one bullet per
    clause), never invented structure or content -- CLAUDE.md invariant 22
    applies to this exactly as it does to a plain DETAILS string.

    The bullet marker is the plain Unicode "•" character, not an HTML list
    tag -- confirmed-safe since it's just text, unlike `<ul>`/`<li>` which
    Calendar's sanitizer is not confirmed to preserve (see the tag-safety
    notes above FINGERPRINT_TAG_PREFIX for the empirical-testing precedent
    this follows).

    A `text` block renders "<b>Label:</b> text" (bare `text` if no label);
    an `items` block renders "<b>Label:</b><br>" followed by one "• item"
    per line, joined with `<br>`; a label-less `items` block omits the
    `<b>` header line entirely. Blocks are joined with `<br><br>`, same
    separator every other multi-part section in this module uses."""
    rendered = []
    for block in blocks:
        if block.items:
            bullets = "<br>".join(f"• {item}" for item in block.items)
            rendered.append(f"<b>{block.label}:</b><br>{bullets}" if block.label else bullets)
        elif block.text:
            rendered.append(f"<b>{block.label}:</b> {block.text}" if block.label else block.text)
    return "<br><br>".join(rendered)


def _contact_line(course: Course) -> str | None:
    if not course.instructor:
        return None
    if course.instructor_contact:
        return f"{course.instructor} — {course.instructor_contact}"
    return course.instructor


def _ungraded_tag(item: AcademicItem) -> str | None:
    """A single, prominent "UNGRADED" tag -- the very first thing in the
    description, before even the course header -- for an item the source
    explicitly marked optional/extra-credit/ungraded/for-practice
    (`AcademicItem.is_optional`, never inferred from item type). Superseded
    2026-08-25: this replaces the old numeric `POINTS`/`STATUS` mid-
    description section -- CLAUDE.md invariant 27 originally required
    actively capturing an exact point value and gated `completeness` on it,
    but the user simplified this: exact point values aren't needed, only a
    clear, unmissable signal for the (comparatively rare) genuinely
    ungraded item. The ordinary graded case (the default -- no explicit
    ungraded/optional/extra-credit language in the source) gets nothing
    added at all -- no flag, no required capture, no gate."""
    return "<b>UNGRADED</b>" if item.is_optional else None


def _inferred_date_tag(item: AcademicItem) -> str | None:
    """A quiet, non-intrusive '(Inferred Date)' note -- same top-of-
    description slot as `_ungraded_tag` (before even the course header),
    independently conditional on `AcademicItem.is_inferred_date`. User-
    authorized 2026-08-25 exception to "never fabricate a date": set only
    after exhaustive real search found no literal date, backed by a
    stated, one-sentence, auditable pattern rule (`date_inference_rule`,
    stored for local audit but never rendered here -- same treatment as
    source_wording). See CLAUDE.md invariant 29. Self-clears
    (`db/repository.py::upsert_academic_item`) the moment a genuinely
    different date supersedes the inferred one, so this tag never
    outlives its own accuracy."""
    return "<i>(Inferred Date)</i>" if item.is_inferred_date else None


def _synthesized_tag(course: Course) -> str | None:
    """Top-of-description tag -- same slot as `_ungraded_tag`/
    `_inferred_date_tag` -- marking an event as belonging to a
    self-directed, AI-authored curriculum with no real D2L/instructor
    source (`Course.is_synthetic`). Makes the invariant-35 carve-out
    visible on the synced event itself, not just in local state, so it's
    never mistaken for real instructor material at a glance."""
    return "<b>SYNTHESIZED CURRICULUM</b>" if course.is_synthetic else None


def _reference_lines(item: AcademicItem) -> list[str]:
    """Clickable, labeled links (not raw URLs) for an item's own page and/or
    a confirmed-stable external resource (e.g. a textbook chapter/section).
    The label is chosen by the caller at sync time -- `reference_url_label`
    should be "Assignment" (or similar) when the URL is the actual turn-in
    location, or a short "D2L (Content -> Assignments -> HW 1.3)"-style path
    hint when only a general area is available; `resource_url_label`
    defaults to "Textbook". Never fabricate either URL -- only include what
    was actually captured from the source (see CLAUDE.md /
    docs/d2l_discovery.md).

    When neither URL is known yet but discovery found an explicit D2L
    "Available on <date>" marker (item.link_available_date -- e.g. the
    assignment is locked until its release date, not simply unlooked-at),
    render that fact instead of silently omitting the section. This is not
    a guess: the date itself came from the source, same as any other field.
    A periodic re-check pass (see academic-import SKILL.md's "link refresh"
    step) is what actually replaces this note with the real link once the
    item opens."""
    lines = []
    if item.reference_url:
        label = item.reference_url_label or "D2L"
        lines.append(f'<a href="{item.reference_url}">{label}</a>')
    if item.submission_url:
        label = item.submission_url_label or "Submit Work"
        lines.append(f'<a href="{item.submission_url}">{label}</a>')
    if item.video_url:
        label = item.video_url_label or "Video"
        lines.append(f'<a href="{item.video_url}">{label}</a>')
    if item.resource_url:
        label = item.resource_url_label or "Textbook"
        lines.append(f'<a href="{item.resource_url}">{label}</a>')
    if not lines and item.link_available_date:
        lines.append(f"Link opens {item.link_available_date.isoformat()} -- not yet available in D2L")
    return lines


def _looks_like_syllabus(text: str) -> bool:
    """A WEEKLY_READING banner or a lecture/lab event must never feature a
    syllabus link -- a syllabus states *that* a chapter is due, not the
    material itself, so its URL stays internal (a `Source` row), never in
    a rendered event. Discovery is not supposed to put one on either
    (CLAUDE.md invariant 25), but an older synced event may still carry
    one in `reference_url`/`resource_url` -- drop it here so a re-render
    cleans it up. User-directed 2026-09-01."""
    return "syllabus" in text.lower()


def _supplemental_link_lines(item: AcademicItem) -> list[str]:
    """LINKS content for a WEEKLY_READING banner or a fixed-time meeting
    (lecture/lab/recitation/seminar). Prefers the arbitrary-length
    `weekly_links` list -- for a banner, that week's lecture video(s),
    slide deck, and textbook chapter reading; for a lecture, that
    session's own slide deck, any handout/in-class activity, a professor
    recording, and the chapter's textbook reading -- whatever discovery
    actually found, in priority order. Falls back to the shared
    `reference_url`/`resource_url` pair when it's empty (an older event,
    or an item with only one or two links). Syllabus links are always
    dropped -- see `_looks_like_syllabus`."""
    if item.weekly_links:
        return [
            f'<a href="{link.url}">{link.label}</a>'
            for link in item.weekly_links
            if not _looks_like_syllabus(f"{link.label} {link.url}")
        ]
    return [line for line in _reference_lines(item) if not _looks_like_syllabus(line)]


def _module_line(nesting: str | None, platform_label: str | None) -> str | None:
    """Combines the where (platform_label: "D2L" / the external tool's real
    name / omitted if unknown) with the what (nesting: chapter/week text) so
    the MODULE line always says where to actually go, not just what it's
    called there. Still gated entirely on nesting being present -- a bare
    "D2L" with no chapter/week text would be filler (CLAUDE.md: never pad a
    missing field), so an item with a known platform but no nesting still
    omits the MODULE section, same as before this existed."""
    if not nesting:
        return None
    return f"{platform_label} — {nesting}" if platform_label else nesting


def build_deadline_description(
    item: AcademicItem,
    course: Course,
    *,
    nesting: str | None,
    details: str | None,
    required_resources: str | None,
    platform_label: str | None = None,
    chapter_topics: dict[str, ChapterTopic] | None = None,
    compact: bool = False,
) -> str:
    """A short header line, then TOPIC (the item's own title, repeated
    deliberately -- see build_meeting_description's docstring), MODULE (the
    real chapter/week nesting -- see CLAUDE.md invariant 17, this is a
    required find once a course has module structure, not a nice-to-have),
    then the remaining labeled sections, each included only when the source
    actually had that information. Never pad a missing field with filler
    ("Not provided", a guessed generic instruction like "read the
    chapter"/"see D2L for details") -- omit the section instead. No SOURCE
    section -- provenance (source_wording, Source rows) stays in the local
    DB for the pipeline's own validation, it's just not rendered into the
    visible Calendar event, which the user found cluttering. `compact` no
    longer changes the shape of the output; it stays as a parameter because
    callers already pass it uniformly for real syncs (see CLAUDE.md's
    compact-description note) and dropping it would be pure churn."""
    del compact  # kept for call-site compatibility; shape is unconditional now
    header = f"{course.course_code} - {course.name}"

    blocks = []
    ungraded_tag = _ungraded_tag(item)
    if ungraded_tag:
        blocks.append(ungraded_tag)
    inferred_tag = _inferred_date_tag(item)
    if inferred_tag:
        blocks.append(inferred_tag)
    blocks.append(header)
    topic = item.title or ""
    if topic:
        blocks.append(_section("TOPIC", _topic_line(topic)))
    module_line = _module_line(nesting, platform_label)
    if module_line:
        blocks.append(_section("MODULE", module_line))
    # `details` carries any real special instructions (submission method,
    # attempt limits, format requirements, etc.) pulled from source_wording.
    # Also the one section that can legitimately grow large (an exhaustive
    # chapter-topic capture folded in) -- flexible_index marks it so
    # _assemble_within_budget truncates only this block, never the small,
    # always-wanted ones below it, if the real Calendar length limit would
    # otherwise be exceeded. See DESCRIPTION_CHAR_BUDGET.
    flexible_index: int | None = None
    if details:
        flexible_index = len(blocks)
        blocks.append(_section("DETAILS", details))
    if required_resources:
        blocks.append(_section("REQUIRED RESOURCES", required_resources))
    contact = _contact_line(course)
    if contact:
        blocks.append(_section("CONTACT", contact))
    ref_lines = _reference_lines(item)
    if ref_lines:
        blocks.append(_section("LINKS", "<br>".join(ref_lines)))
    study_lines = _study_guide_lines(item)
    if study_lines:
        blocks.append(_section("STUDY GUIDES", "<br>".join(study_lines)))
    # EXAM CONCEPTS goes last, like a banner's TOPIC DETAIL, so the links
    # stay at the top; it is the block the length budget may truncate.
    concepts = _exam_concepts_section(item, chapter_topics)
    if concepts:
        flexible_index = len(blocks)
        blocks.append(concepts)
    if flexible_index is None:
        return "<br><br>".join(blocks)
    joined = _assemble_within_budget(blocks, flexible_index)
    return joined.replace(_LINES_NOTE, _EXAM_LINES_NOTE) if concepts else joined


def _exam_concepts_section(
    item: AcademicItem, chapter_topics: dict[str, ChapterTopic] | None
) -> str | None:
    """EXAM CONCEPTS for a test (user-directed 2026-10-15, CLAUDE.md
    invariant 40), in priority order so the length budget only ever cuts
    the least essential tail:

    1. "Study guide focus" -- the study guide / exam review's emphasis,
       verbatim (exam prep is favored heavily);
    2. every covered chapter's key terms (`Vocabulary`), one block each --
       a multi-chapter exam still shows all of its terms;
    3. every covered chapter's concepts, then any labeled gap fill.

    `chapter_topics` maps `canonicalize_chapter_label` -> saved
    ChapterTopic (the caller has DB access). A covered chapter with
    nothing saved still shows by name."""
    if not item.item_type.is_assessment:
        return None
    blocks: list[DetailsBlock] = []
    if item.study_focus:
        blocks.append(DetailsBlock(label="Study guide focus", items=list(item.study_focus)))
    topics = chapter_topics or {}
    chapters: list[tuple[str, ChapterTopic | None]] = []
    for label, text in split_chapter_segments("; ".join(item.covered_chapters)):
        if label is None:
            chapters.append((text, None))
            continue
        topic = topics.get(canonicalize_chapter_label(label))
        name = text or (topic.title if topic and topic.title else "")
        chapters.append((f"{label} — {name}" if name else label, topic))
    concept_blocks: list[DetailsBlock] = []
    for header, topic in chapters:
        if topic is None:
            blocks.append(DetailsBlock(text=f"<b>{header}</b>"))
            continue
        items = study_items(topic)
        terms = [i for i in items if i.startswith("Vocabulary: ")]
        concepts = [i for i in items if not i.startswith("Vocabulary: ")]
        extra = added_items(topic)
        if terms:
            blocks.append(DetailsBlock(label=f"{header} — key terms",
                                       text=terms[0].removeprefix("Vocabulary: ")))
        elif topic.added_vocabulary:
            # Terms lead even when only gap-fill terms exist -- still visibly
            # labeled, and pulled out of the trailing added block.
            blocks.append(DetailsBlock(label=f"{header} — key terms, {ADDED_LABEL.lower()}",
                                       text=topic.added_vocabulary))
            extra = [i for i in extra if not i.startswith("Vocabulary: ")]
        elif not concepts:
            blocks.append(DetailsBlock(text=f"<b>{header}</b>"))
        if concepts:
            concept_blocks.append(DetailsBlock(label=f"{header} — concepts", items=concepts))
        if extra:
            concept_blocks.append(DetailsBlock(label=f"{header} — {ADDED_LABEL}", items=extra))
    blocks.extend(concept_blocks)
    if not blocks:
        return None
    return _section("EXAM CONCEPTS", format_details_blocks(blocks))


def _study_guide_lines(item: AcademicItem) -> list[str]:
    """A test's study material -- study guides, practice exams, review
    assignments, exam-resource pages -- stored in `weekly_links` on the
    test item and rendered under STUDY GUIDES, after the test's own LINKS
    (take it / submit work). User-directed 2026-10-07. Only real links
    discovery opened; syllabus links dropped like everywhere else."""
    if not item.item_type.is_assessment:
        return []
    return [
        f'<a href="{link.url}">{link.label}</a>'
        for link in item.weekly_links
        if not _looks_like_syllabus(f"{link.label} {link.url}")
    ]


def build_meeting_description(
    item: AcademicItem,
    course: Course,
    *,
    location: LocationInfo | None,
    nesting: str | None = None,
    details: str | None = None,
    platform_label: str | None = None,
    chapter_topics: dict[str, ChapterTopic] | None = None,
    compact: bool = False,
) -> str:
    """Same structured shape as `build_deadline_description` (see its
    docstring for the SOURCE-section, MODULE-section, and HTML notes). The
    topic is repeated here (as its own TOPIC section) even though it's also
    in the event title/summary -- a description that's read on its own
    (e.g. in an agenda view) should still say what's being covered, not
    rely on the title being visible alongside it."""
    del compact  # kept for call-site compatibility; shape is unconditional now
    topic = _strip_redundant_leading_word(item.title or "", item.item_type)
    loc_str = location.google_location_string() if location else None
    header = f"{course.course_code} - {course.name}"

    blocks = []
    ungraded_tag = _ungraded_tag(item)
    if ungraded_tag:
        blocks.append(ungraded_tag)
    inferred_tag = _inferred_date_tag(item)
    if inferred_tag:
        blocks.append(inferred_tag)
    blocks.append(header)
    if topic:
        blocks.append(_section("TOPIC", _topic_line(topic)))
    module_line = _module_line(nesting, platform_label)
    if module_line:
        blocks.append(_section("MODULE", module_line))
    # See build_deadline_description's matching comment -- DETAILS is the
    # one section that can grow large enough to need the length budget.
    flexible_index: int | None = None
    if details:
        flexible_index = len(blocks)
        blocks.append(_section("DETAILS", details))
    if loc_str:
        blocks.append(_section("LOCATION", loc_str))
    contact = _contact_line(course)
    if contact:
        blocks.append(_section("CONTACT", contact))
    # Meetings honor the arbitrary-length `weekly_links` list too (this
    # session's own slide deck / handout / activity / recording +
    # textbook), falling back to reference_url/resource_url -- and a stray
    # syllabus link is dropped either way. See _supplemental_link_lines
    # and CLAUDE.md invariant 25 (amended 2026-09-01). A timed in-person
    # test renders here too: its weekly_links are study guides, so they go
    # under STUDY GUIDES and its own reference/submission links under LINKS.
    if item.item_type.is_assessment:
        ref_lines = _reference_lines(item)
    else:
        ref_lines = _supplemental_link_lines(item)
    if ref_lines:
        blocks.append(_section("LINKS", "<br>".join(ref_lines)))
    study_lines = _study_guide_lines(item)
    if study_lines:
        blocks.append(_section("STUDY GUIDES", "<br>".join(study_lines)))
    # EXAM CONCEPTS goes last, like a banner's TOPIC DETAIL, so the links
    # stay at the top; it is the block the length budget may truncate.
    concepts = _exam_concepts_section(item, chapter_topics)
    if concepts:
        flexible_index = len(blocks)
        blocks.append(concepts)
    if flexible_index is None:
        return "<br><br>".join(blocks)
    joined = _assemble_within_budget(blocks, flexible_index)
    return joined.replace(_LINES_NOTE, _EXAM_LINES_NOTE) if concepts else joined


_KIND_KEYWORDS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("slides", ("slide", "powerpoint", "ppt", "deck")),
    ("video", ("video", "youtube", "recording", "lecture capture", "panopto")),
    ("handout", ("handout", "worksheet", "activity", "practice")),
    ("textbook", ("textbook", "reading", "ebook", "e-book", "openstax", "libretexts", "chapter text")),
)

_RESOURCE_KIND_ORDER = ("slides", "video", "handout", "platform", "other")


def link_kind(link: WeeklyLink) -> str:
    """A link's resource kind: its explicit `kind` when set, otherwise
    classified from its label/URL (links saved before 2026-10-05 have no
    `kind`). Pure presentation grouping -- never changes which links
    exist, only where on the banner they render."""
    if link.kind:
        return link.kind
    text = f"{link.label} {link.url}".lower()
    for kind, words in _KIND_KEYWORDS:
        if any(w in text for w in words):
            return kind
    return "other"


def _reading_section(entries: list[ReadingEntry], textbook_links: list[WeeklyLink]) -> str | None:
    """READING: one block per chapter -- bold header, then its
    chapter-specific reading link. (The "Big topics" line was removed
    2026-10-16: the banner is links only; study depth lives in the weekly
    study PDF -- CLAUDE.md invariant 41.) A chapter with no saved `reading_url` takes a textbook
    link whose `chapter` matches it; textbook links not tied to any
    listed chapter (e.g. a general eBook access point) follow the
    chapters. Never padded: a chapter with no link simply has none."""
    remaining = list(textbook_links)
    blocks: list[str] = []
    for entry in entries:
        lines = [f"<b>{entry.header}</b>"]
        url, label = entry.reading_url, entry.reading_label
        if url is None and entry.chapter_label:
            key = canonicalize_chapter_label(entry.chapter_label)
            for link in remaining:
                if link.chapter and canonicalize_chapter_label(link.chapter) == key:
                    url, label = link.url, link.label
                    remaining.remove(link)
                    break
        if url:
            lines.append(f'→ <a href="{url}">{label or "Reading — " + entry.header}</a>')
        blocks.append("<br>".join(lines))
    extra = [f'→ <a href="{link.url}">{link.label}</a>' for link in remaining]
    if extra:
        blocks.append("<br>".join(extra))
    return "<br><br>".join(blocks) if blocks else None


def build_weekly_reading_description(
    item: AcademicItem,
    course: Course,
    *,
    chapter_topics: dict[str, ChapterTopic] | None = None,
    pacing: str | None = None,
) -> str:
    """The weekly banner is the week's link list (user-directed
    2026-10-05, slimmed 2026-10-16 -- CLAUDE.md invariants 25/41):

    1. READING -- every chapter due that week, each with its
       chapter-specific reading link (`ChapterTopic.reading_url`, or a
       textbook-kind `weekly_links` entry tagged with that chapter).
    2. SLIDES & RESOURCES -- every non-textbook `weekly_links` entry,
       grouped slides → video → handout → platform → other.
    3. CONTACT, then DATES last (before the fingerprint tag).

    No "Big topics", PACING or TOPIC DETAIL: what to study now lives in
    the weekly study PDF (`study_pdf.py`), not the event description.

    `item.title` holds the week's "Chapter N: Topic; Chapter M: Topic"
    list (`chapter_topics.split_chapter_segments`). `chapter_topics` maps
    `canonicalize_chapter_label` -> saved `ChapterTopic` -- passed in by
    the caller, which has DB access this module deliberately doesn't (it
    supplies titles for bare labels and per-chapter reading links).
    Syllabus links are always dropped (`_looks_like_syllabus`). When the
    item has no `weekly_links`, its legacy reference_url/resource_url pair
    renders under SLIDES & RESOURCES instead."""
    topics = chapter_topics or {}
    header = f"{course.course_code} - {course.name}"
    segments = split_chapter_segments(item.title) if item.title else []

    links = [
        link for link in item.weekly_links
        if not _looks_like_syllabus(f"{link.label} {link.url}")
    ]
    textbook_links = [link for link in links if link_kind(link) == "textbook"]
    resource_lines: list[str] = []
    for kind in _RESOURCE_KIND_ORDER:
        resource_lines.extend(
            f'<a href="{link.url}">{link.label}</a>'
            for link in links
            if link_kind(link) == kind
        )
    if not item.weekly_links:
        resource_lines = [
            line for line in _reference_lines(item) if not _looks_like_syllabus(line)
        ]

    blocks = []
    synthesized_tag = _synthesized_tag(course)
    if synthesized_tag:
        blocks.append(synthesized_tag)
    inferred_tag = _inferred_date_tag(item)
    if inferred_tag:
        blocks.append(inferred_tag)
    blocks.append(header)
    reading = _reading_section(build_reading_entries(segments, topics), textbook_links)
    if reading:
        blocks.append(_section("READING", reading))
    resources_index: int | None = None
    if resource_lines:
        resources_index = len(blocks)
        blocks.append(_section("SLIDES &amp; RESOURCES", "<br>".join(resource_lines)))
    del pacing  # accepted for call-site compatibility; never rendered
    contact = _contact_line(course)
    if contact:
        blocks.append(_section("CONTACT", contact))
    if item.date is not None and item.date_range_end is not None:
        blocks.append(_section("DATES", _format_date_range(item.date, item.date_range_end)))
    if resources_index is not None:
        return _assemble_within_budget(blocks, resources_index).replace(_LINES_NOTE, _LINKS_NOTE)
    return "<br><br>".join(blocks)


def build_event_payload(
    item: AcademicItem,
    course: Course,
    *,
    timezone: str,
    color_id: str,
    include_topic_in_titles: bool = True,
    description: str = "",
    location: LocationInfo | None = None,
    no_meaningful_duration_minutes: int = 1,
    default_meeting_duration_minutes: int = 50,
) -> dict[str, Any]:
    """Build the payload dict handed to the Calendar connector's
    create_event/update_event call. Never includes attendees or a
    conferenceData block -- see CLAUDE.md (no guests, no Meet links)."""
    if item.date is None:
        raise ValueError("Cannot build a Calendar event payload for an item with no date.")
    if item.item_type == ItemType.READING:
        # A plain READING item is provenance-only and never becomes its own
        # Calendar event -- its content must already have been folded into
        # a covering lecture's DETAILS or a course's WEEKLY_READING block by
        # the time sync runs. See CLAUDE.md invariant 25.
        raise ValueError(
            "READING items never sync as their own event -- fold this item's content into "
            "the covering lecture's DETAILS or the course's WEEKLY_READING block instead."
        )

    title = build_title(item, course, include_topic=include_topic_in_titles)
    description = embed_fingerprint_tag(description, item.fingerprint)

    routine_meeting_untimed = (
        item.item_type.is_routine_meeting
        and item.start_time is None
        and item.due_time is None
    )
    if item.item_type == ItemType.WEEKLY_READING:
        if item.date_range_end is None:
            raise ValueError(
                "Cannot build a Calendar event payload for a weekly reading block with no date_range_end."
            )
        # Multi-day all-day event -- same EXCLUSIVE end-date convention as
        # the single-day all-day branch below, just spanning the real week.
        payload: dict[str, Any] = {
            "summary": title,
            "description": description,
            "start": {"date": item.date.isoformat()},
            "end": {"date": (item.date_range_end + timedelta(days=1)).isoformat()},
        }
    elif item.item_type == ItemType.BREAK or routine_meeting_untimed:
        # Google Calendar all-day events use an EXCLUSIVE end date -- a
        # single-day event needs end = start + 1 day, not the same date
        # (some clients auto-correct this, but the live connector used here
        # rejects start == end outright).
        payload = {
            "summary": title,
            "description": description,
            "start": {"date": item.date.isoformat()},
            "end": {"date": (item.date + timedelta(days=1)).isoformat()},
        }
    elif item.item_type.is_fixed_time_meeting and item.due_time is None:
        start_dt = datetime.combine(item.date, item.start_time or time(0, 0))
        end_dt = (
            datetime.combine(item.date, item.end_time)
            if item.end_time
            else start_dt + timedelta(minutes=default_meeting_duration_minutes)
        )
        payload = {
            "summary": title,
            "description": description,
            "start": {"dateTime": start_dt.isoformat(), "timeZone": timezone},
            "end": {"dateTime": end_dt.isoformat(), "timeZone": timezone},
        }
    else:
        # Using full datetime (not bare time-of-day) math here is required so a
        # deadline due at 23:59 rolls its 1-minute "event" over to 00:00 the
        # *next* calendar day rather than wrapping back to the same day and
        # producing an end time before the start time.
        start_dt = datetime.combine(item.date, item.due_time or time(23, 59))
        end_dt = start_dt + timedelta(minutes=no_meaningful_duration_minutes)
        payload = {
            "summary": title,
            "description": description,
            "start": {"dateTime": start_dt.isoformat(), "timeZone": timezone},
            "end": {"dateTime": end_dt.isoformat(), "timeZone": timezone},
        }

    # The Calendar event's native `location` field is reserved for a real
    # physical meeting -- lecture/lab/exam with a room, or an explicit
    # "Online" statement about a *meeting* that would otherwise have one
    # (see docs/d2l_discovery.md's field-fallbacks section). A deadline-type
    # item (quiz/assignment/discussion/exam-window/etc.) has no meeting
    # location to state; where to go and do the work belongs in the MODULE
    # line of the description instead, not this field -- a real production
    # run set platform_location="Online" on dozens of deadline items across
    # multiple courses before this guard existed, which is meaningless
    # (every deadline in an online course is trivially "online") and pushed
    # out the actually useful DETAILS/MODULE information. Guarded on the
    # same predicate build_title uses to distinguish meeting-style items.
    is_physical_meeting = item.item_type.is_fixed_time_meeting and item.due_time is None
    loc_str = location.google_location_string() if (location and is_physical_meeting) else None
    if loc_str:
        payload["location"] = loc_str

    payload["colorId"] = color_id
    payload["reminders"] = {"useDefault": False, "overrides": []}
    payload["guestsCanInviteOthers"] = False
    payload["extendedProperties"] = {
        "private": {
            FINGERPRINT_PRIVATE_KEY: compute_calendar_fingerprint(item.fingerprint or ""),
            ITEM_ID_PRIVATE_KEY: item.id,
        }
    }
    return payload


# --------------------------------------------------------------------------
# Weekly grade diagnostic ("Previous Week Diagnostic")
# --------------------------------------------------------------------------
#
# Deliberately separate from AcademicItem/build_event_payload above -- a
# diagnostic isn't a real academic obligation. One event per course
# (user-directed 2026-09-17, superseding an earlier single cross-course
# banner design) -- each independently colored Red/Yellow/Green so a
# struggling course's own event stands out rather than being buried inside
# a combined list. See CLAUDE.md's grade-diagnostic invariant and
# docs/d2l_discovery.md#weekly-grade-diagnostic-crawl.


@dataclass
class DiagnosticAssignment:
    """One item graded/submitted during the diagnosed week. `score_percent`
    and `commentary` must trace to real D2L/ALEKS content -- `commentary`
    is either the literal instructor feedback, that feedback blended with
    Claude's own suggested corrective action, or (if no instructor feedback
    exists) Claude's own assessment alone; the latter is explicitly
    generated advice, not sourced fact, same distinction CLAUDE.md invariant
    22 draws between curriculum content and a recommended course of
    action. Callers should leave `commentary` unset for a score at/above
    the course's A cutoff with no real instructor notes -- name+score
    alone is the correct, undecorated render for that case."""

    title: str
    score_percent: float | None = None
    is_missing: bool = False
    commentary: str | None = None


@dataclass
class DiagnosticCourseSection:
    """The data for one course's own "<CODE> Previous Week Diagnostic"
    event. `previous_grade_label`/`current_grade_label` are pre-formatted
    strings like "82.4% B-" -- this module does no grade-scale math, only
    rendering. `status` drives the event's `colorId` (see
    `build_weekly_diagnostic_payload`) rather than being spelled out in the
    text -- user-directed 2026-09-17, since the event's own color already
    carries that signal once every course gets its own event.
    `missed_deadlines` is sourced fact (state whether a deadline's
    submission window is still open or already closed); `plan` is always
    Claude's own generated corrective/maintenance text, never sourced --
    both render together under one Plan section (see
    `_diagnostic_plan_block`), missed-deadline facts first."""

    course_code: str
    status: DiagnosticStatus
    previous_grade_label: str | None = None
    current_grade_label: str | None = None
    assignments: list[DiagnosticAssignment] = field(default_factory=list)
    announcements: list[str] = field(default_factory=list)
    missed_deadlines: list[str] = field(default_factory=list)
    upcoming_deadlines: list[str] = field(default_factory=list)
    plan: list[str] = field(default_factory=list)


def _diagnostic_header_block(section: DiagnosticCourseSection) -> str:
    """Two bold lines: the course name, then the grade change -- no status
    word in the text (the event's own colorId carries that now that each
    course gets its own event). User-directed 2026-09-17."""
    name_line = f"<b>{section.course_code}</b>"
    change: str | None
    if section.previous_grade_label and section.current_grade_label:
        change = f"{section.previous_grade_label} → {section.current_grade_label}"
    else:
        change = section.current_grade_label
    return f"{name_line}<br><b>{change}</b>" if change else name_line


def _diagnostic_assignment_block(a: DiagnosticAssignment) -> str:
    """One assignment as its own small block: a single bold "Name - score"
    line, then (only when real commentary/feedback exists) a second,
    unbolded line carrying it. User-directed 2026-09-17: name and score
    share one bold line rather than two separate lines."""
    if a.is_missing:
        status = "Missing"
    elif a.score_percent is not None:
        status = f"{a.score_percent:g}%"
    else:
        status = "—"
    header = f"<b>{a.title} - {status}</b>"
    return f"{header}<br>{a.commentary}" if a.commentary else header


def _bulleted(label: str, lines: list[str]) -> str | None:
    if not lines:
        return None
    bullets = "<br>".join(f"• {line}" for line in lines)
    return f"<b>{label}:</b><br>{bullets}"


def _diagnostic_plan_block(section: DiagnosticCourseSection) -> str | None:
    """Missed-deadline facts (sourced -- state plainly whether the
    submission window is still open or already closed) followed by
    Claude's own numbered corrective plan, together under one "Plan"
    header. User-directed 2026-09-17: a missed deadline is presented as
    part of the plan, not a separate section -- the reader sees the
    problem and the recommended response in the same place."""
    lines = [f"• {m}" for m in section.missed_deadlines]
    lines += [f"{i}) {p}" for i, p in enumerate(section.plan, start=1)]
    if not lines:
        return None
    return "<b>Plan:</b><br>" + "<br>".join(lines)


def build_weekly_diagnostic_description(section: DiagnosticCourseSection) -> str:
    """One course's own description, in this order: name + grade change,
    every assignment graded/submitted this week, announcement highlights,
    upcoming big deadlines (next 3 weeks), then the plan (missed-deadline
    facts folded in, see `_diagnostic_plan_block`) -- user-directed
    2026-09-17. No SOURCE section, same rule as every other description
    builder in this module."""
    blocks = [_diagnostic_header_block(section)]
    flexible_index: int | None = None
    if section.assignments:
        flexible_index = len(blocks)
        blocks.append(
            "<br><br>".join(_diagnostic_assignment_block(a) for a in section.assignments)
        )
    announcements_block = _bulleted("Announcements this week", section.announcements)
    if announcements_block:
        blocks.append(announcements_block)
    upcoming_block = _bulleted("Upcoming Deadlines (Next 3 Weeks)", section.upcoming_deadlines)
    if upcoming_block:
        blocks.append(upcoming_block)
    plan_block = _diagnostic_plan_block(section)
    if plan_block:
        blocks.append(plan_block)
    if flexible_index is None:
        return "<br><br>".join(blocks)
    return _assemble_within_budget(blocks, flexible_index)


def build_weekly_diagnostic_payload(
    course_code: str,
    week_start: date,
    description: str,
    *,
    fingerprint: str,
    record_id: str,
    color_id: str,
) -> dict[str, Any]:
    """Build the payload dict for one course's "<CODE> Previous Week
    Diagnostic" event -- a single all-day event dated the Monday of the
    week just completed (not a multi-day span). Never includes attendees
    or a conferenceData block, same as `build_event_payload`."""
    full_description = embed_fingerprint_tag(description, fingerprint)
    return {
        "summary": f"{course_code} Previous Week Diagnostic",
        "description": full_description,
        "start": {"date": week_start.isoformat()},
        "end": {"date": (week_start + timedelta(days=1)).isoformat()},
        "colorId": color_id,
        "reminders": {"useDefault": False, "overrides": []},
        "guestsCanInviteOthers": False,
        "extendedProperties": {
            "private": {
                FINGERPRINT_PRIVATE_KEY: compute_calendar_fingerprint(fingerprint),
                "academic_sync_diagnostic_record_id": record_id,
            }
        },
    }
