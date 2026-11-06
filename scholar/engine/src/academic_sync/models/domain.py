"""Pydantic domain models.

These are the in-memory/transport shapes used by the extraction, completeness,
and reconciliation engines. They mirror the ORM tables in db/orm.py but stay
decoupled from SQLAlchemy so parsers/extractors can be unit tested without a
database. db/repository.py is responsible for converting between the two.
"""

from __future__ import annotations

from datetime import date as _date
from datetime import datetime, time
from typing import Any

# NOTE: `date` is imported as `_date` because AcademicItem has a field
# literally named `date`. With `from __future__ import annotations`,
# pydantic resolves annotations using the class's own namespace (which by
# then contains that field), so a bare `date` import would be shadowed by
# the field itself when resolving ITS OWN annotation -- causing a
# "unsupported operand type(s) for |: 'NoneType' and 'NoneType'" error.
from pydantic import BaseModel, ConfigDict, Field

from academic_sync.models.enums import (
    CompletenessStatus,
    CourseStatus,
    DiagnosticStatus,
    ItemStatus,
    ItemType,
    PreferenceCategory,
    PreferenceScope,
    SourceType,
    SyncAction,
    UnresolvedReferenceKind,
)


class Course(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    course_code: str
    section: str | None = None
    name: str
    term: str
    instructor: str | None = None
    instructor_contact: str | None = None
    campus: str | None = None
    start_date: _date | None = None
    end_date: _date | None = None
    d2l_identifier: str | None = None
    d2l_url: str | None = None
    delivery_format: str | None = None
    status: CourseStatus = CourseStatus.ACTIVE
    is_synthetic: bool = False
    created_at: datetime | None = None
    updated_at: datetime | None = None


class Source(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    course_id: str
    source_type: SourceType
    title: str
    url: str | None = None
    local_path: str | None = None
    retrieved_at: datetime
    modified_at: datetime | None = None
    content_hash: str
    parser_version: str
    extracted_at: datetime | None = None
    is_tentative: bool = False
    superseded_by_id: str | None = None
    raw_text: str | None = None


class WeeklyLink(BaseModel):
    """One labeled hyperlink on a WEEKLY_READING banner or a fixed-time
    meeting (lecture/lab/recitation/seminar). Both aggregate more material
    than the two (`reference_url`/`resource_url`) slots every other item
    type gets: a weekly banner carries that week's lecture video(s), slide
    deck, and textbook chapter reading; a lecture carries that session's
    own slide deck, any handout/in-class activity, a professor recording,
    and the chapter's textbook reading -- whichever discovery actually
    found. Omit what isn't found; NEVER include a syllabus link (a
    syllabus states *that* a chapter is due, not the material itself --
    its URL stays internal, on a `Source` row). See CLAUDE.md invariant 25
    and docs/d2l_discovery.md#weekly-reading-blocks."""

    model_config = ConfigDict(from_attributes=True)

    label: str
    url: str
    # Optional resource kind -- one of WEEKLY_LINK_KINDS. Drives grouping on
    # a weekly banner (textbook readings render under READING, everything
    # else under SLIDES & RESOURCES) and lets the quiz GPT match a link to a
    # chapter. `None` on links saved before 2026-10-05; those are
    # classified from their label at render time (see
    # `sync/calendar_payload.py::link_kind`).
    kind: str | None = None
    # Optional chapter/unit label this link belongs to (e.g. "Chapter 23"),
    # when discovery knows it -- lets a banner place a textbook link under
    # its own chapter in READING instead of in a generic list.
    chapter: str | None = None


WEEKLY_LINK_KINDS = ("textbook", "slides", "video", "handout", "platform", "other")


class AcademicItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    course_id: str
    source_ids: list[str] = Field(default_factory=list)
    item_type: ItemType
    title: str
    description: str | None = None
    date: _date | None = None
    start_time: time | None = None
    end_time: time | None = None
    due_time: time | None = None
    location_id: str | None = None
    platform_location: str | None = None
    module_label: str | None = None
    parent_item_id: str | None = None
    status: ItemStatus = ItemStatus.DRAFT
    confidence: float = 0.5
    is_tentative: bool = False
    is_derived: bool = False
    derivation_rule: str | None = None
    source_wording: str | None = None
    reference_url: str | None = None
    reference_url_label: str | None = None
    resource_url: str | None = None
    resource_url_label: str | None = None
    # A separate turn-in location distinct from the item's own page --
    # e.g. an exam whose instructions say "submit your work separately"
    # to a Dropbox folder. Renders as its own "Submit Work" link under
    # LINKS. Never constructed or guessed -- only a URL discovery actually
    # opened. See CLAUDE.md invariant 17 (amended 2026-10-05).
    submission_url: str | None = None
    submission_url_label: str | None = None
    # WEEKLY_READING and fixed-time meeting items: an arbitrary-length list
    # of that item's real resource links (a banner's lecture video / slide
    # deck / textbook reading; a lecture's own slides / handout / activity /
    # recording / textbook), rendered under LINKS in place of
    # reference_url/resource_url when non-empty. Deadline-type items ignore
    # this and keep using the two fixed URL slots above. See WeeklyLink and
    # CLAUDE.md invariant 25.
    weekly_links: list[WeeklyLink] = Field(default_factory=list)
    # Tests (`ItemType.is_assessment`) only: the chapter labels the test
    # covers ("Chapter 5", "Module 2") -- render pulls each one's saved
    # ChapterTopic into an EXAM CONCEPTS section -- and the study guide /
    # exam-review emphasis, verbatim, listed first in that section.
    # User-directed 2026-10-15, CLAUDE.md invariant 40.
    covered_chapters: list[str] = Field(default_factory=list)
    study_focus: list[str] = Field(default_factory=list)
    # Homework-type deadlines: a video that teaches the assignment's topic
    # (instructor/platform video first, else a verified trusted-web video).
    # Renders as a "Video" line under LINKS. Invariant 40.
    video_url: str | None = None
    video_url_label: str | None = None
    # Set only when discovery found an explicit "Available on <date>" marker
    # on an item with no reference_url/resource_url yet -- the item is
    # locked/not-yet-released, not simply unlooked-at. See CLAUDE.md's link
    # refresh workflow. Cleared once a real link is found.
    link_available_date: _date | None = None
    # Week end (inclusive) for a WEEKLY_READING item only -- `date` is
    # reused as the week's start. Ignored by every other item type. See
    # CLAUDE.md invariant 25.
    date_range_end: _date | None = None
    points: float | None = None
    is_optional: bool = False
    # User-authorized 2026-08-25 exception to "never fabricate a date" --
    # set True only after exhaustive real search found no literal date AND
    # a stated, one-sentence, auditable pattern rule (backed by real
    # adjacent evidence) justifies the value. See CLAUDE.md invariant 29.
    # date_inference_rule records that one-sentence rule for local audit
    # (never rendered -- same treatment as source_wording); is_inferred_date
    # drives the visible "(Inferred Date)" tag in the synced description.
    is_inferred_date: bool = False
    date_inference_rule: str | None = None
    first_seen: datetime | None = None
    last_seen: datetime | None = None
    source_hash: str | None = None
    superseded_by_id: str | None = None
    calendar_event_id: str | None = None
    calendar_fingerprint: str | None = None
    fingerprint: str | None = None

    def is_ready_to_sync(self) -> bool:
        if self.status not in (ItemStatus.CLEAR, ItemStatus.SYNCED):
            return False
        if self.date is None:
            return False
        if (
            self.item_type.is_fixed_time_meeting
            and not self.item_type.is_routine_meeting
            and self.start_time is None
            and self.due_time is None
        ):
            # An async/online exam window carries a due_time instead of a
            # start_time (see extraction/pipeline.py) -- either is
            # sufficient evidence of a real, non-fabricated time. Routine
            # meetings (lecture/lab/recitation/seminar) are exempted from
            # this gate entirely -- see ItemType.is_routine_meeting.
            return False
        if self.item_type == ItemType.WEEKLY_READING and self.date_range_end is None:
            # A weekly reading block is meaningless without a real week-end
            # date -- both ends of the span must be sourced, never just the
            # start. See CLAUDE.md invariant 25.
            return False
        # NOTE: readings/topics with a date but no due_time are intentionally
        # NOT blocked here -- the user explicitly wants maximal coverage
        # ("don't miss anything"), including non-graded reading/topic
        # mentions. A plain READING item is never synced as its own event
        # though (see sync/calendar_payload.py::build_event_payload, which
        # raises for ItemType.READING) -- its content is required to land in
        # a covering lecture's DETAILS or a WEEKLY_READING block instead. A
        # WEEKLY_READING item itself syncs as a multi-day all-day event.
        return True


class UnresolvedReference(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    course_id: str
    item_id: str | None = None
    source_id: str | None = None
    kind: UnresolvedReferenceKind
    description: str
    source_wording: str | None = None
    created_at: datetime | None = None
    resolved: bool = False
    resolution_note: str | None = None


class ChapterTopic(BaseModel):
    """A course's saved, real chapter/unit topic breakdown -- vocabulary
    and objectives captured from real instructor-authored material
    (chapter objectives doc, study guide, ALEKS topic list, etc.), never a
    generated summary. See CLAUDE.md invariant 26. Identity for lookup/
    upsert is `(course_id, chapter_topics.canonicalize_chapter_label(
    chapter_label))`, not this row's own id -- see db/repository.py.

    `objectives` must be the platform's real, complete topic/subtopic list
    for this chapter, not a representative sample -- see CLAUDE.md
    invariant 26 and docs/d2l_discovery.md's required-find #6. `is_exhaustive`
    is set `True` only once discovery has actually confirmed that (found
    the platform's stable structural view -- e.g. ALEKS's "View All
    Topics" -- rather than a personalized/adaptive "what's next" queue);
    it defaults `False` so a partial/uncertain capture is never silently
    indistinguishable from a verified-complete one."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    course_id: str
    chapter_label: str
    title: str | None = None
    vocabulary: str | None = None
    objectives: list[str] = Field(default_factory=list)
    is_exhaustive: bool = False
    # The chapter's real section headings (e.g. textbook "23.1 Genetic
    # Variation", or a module page's own sub-headings) -- rendered as the
    # short "Big topics" line under the chapter in a banner's READING
    # section. Same evidentiary bar as `objectives`: real structure from
    # the source, never a generated summary (CLAUDE.md invariant 22).
    sections: list[str] = Field(default_factory=list)
    # The chapter-specific reading link (eBook chapter page, OpenStax
    # chapter, D2L content topic) -- stored once on the chapter so every
    # banner and lecture covering it reuses the same verified URL.
    reading_url: str | None = None
    reading_label: str | None = None
    # Claude-authored gap fill for concepts/terms the real material doesn't
    # cover -- always rendered under a visible "Added (not from instructor)"
    # label, never mixed into the sourced lists above. User-authorized
    # 2026-10-15, CLAUDE.md invariant 40.
    added_vocabulary: str | None = None
    added_objectives: list[str] = Field(default_factory=list)
    # The chapter in the student's own textbook, when the class numbers chapters differently from the book.
    textbook_ref: str | None = None
    # The short description the student sees (written with the chapter's textbook; read-only here).
    summary: str | None = None
    source_ids: list[str] = Field(default_factory=list)
    source_wording: str | None = None
    first_seen: datetime | None = None
    last_seen: datetime | None = None


class GradeSnapshot(BaseModel):
    """One graded/missing item observed during a weekly grade-diagnostic
    crawl of D2L's Grades tool or an external courseware platform's own
    Gradebook (see docs/d2l_discovery.md#weekly-grade-diagnostic-crawl).
    `academic_item_id` is nullable -- a gradebook row doesn't always
    cleanly match a local `AcademicItem` by title; when it doesn't, the
    snapshot is still recorded against the course rather than dropped.
    `score_percent`/`instructor_feedback` must trace to real D2L/ALEKS page
    content, same evidentiary bar as everywhere else in this project --
    never fabricated. See CLAUDE.md's grade-diagnostic invariant."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    course_id: str
    academic_item_id: str | None = None
    title: str
    week_start: _date
    captured_at: _date
    score_percent: float | None = None
    is_missing: bool = False
    instructor_feedback: str | None = None
    source_type: SourceType


class CourseGradeSnapshot(BaseModel):
    """One course's overall grade as of a given diagnostic week -- the
    week-over-week comparison basis for `diagnostics.py::classify_course`.
    Identity for lookup/upsert is `(course_id, week_start)`."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    course_id: str
    week_start: _date
    captured_at: _date
    overall_percent: float | None = None
    letter_grade: str | None = None


class WeeklyDiagnosticRecord(BaseModel):
    """The idempotency row for one course's "<CODE> Previous Week
    Diagnostic" Calendar event for a given week -- deliberately its own
    small table rather than an `AcademicItem` row, since a diagnostic isn't
    a real academic obligation. Plays the same role `SyncRecord` plays for
    a normal item: `fingerprint` + `google_event_id` is what makes
    re-running the same course/week update the existing event instead of
    duplicating it. One event per course (each independently colored
    Red/Yellow/Green) -- user-directed 2026-09-17, superseding the
    original single cross-course banner design."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    course_id: str
    week_start: _date
    status: DiagnosticStatus
    fingerprint: str
    google_event_id: str | None = None
    google_calendar_id: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class CoursePortalLink(BaseModel):
    """A static, bookmarkable URL into one of a course's own areas (home,
    grades, announcements, content, dropbox list, an external platform's
    gradebook...). Saved once so the daily run navigates straight to each
    page instead of clicking through the course shell. Identity for upsert
    is `(course_id, kind, label)`. Only URLs discovery actually opened --
    never constructed. See CLAUDE.md invariant 38."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    course_id: str
    kind: str
    url: str
    label: str = ""
    updated_at: datetime | None = None


PORTAL_LINK_KINDS = (
    # course areas
    "home", "grades", "announcements", "content", "dropbox", "quizzes",
    "discussions", "calendar", "external_home", "external_gradebook",
    # individual objects (the URL registry: anything scraped once gets its
    # direct URL saved, so later runs load it instead of clicking through)
    "assignment", "quiz", "content_topic", "grade_item", "module", "other",
)


class DigestEntry(BaseModel):
    """One thing the Daily Overview email has reported or will report: a
    new announcement, a newly graded item (or a grade whose score/feedback
    changed), a needs-attention trigger, a Calendar change, or something
    that needs the user. Identity is `(course_id, kind, external_id)`;
    `content_hash` detects a changed grade/feedback so it resurfaces as an
    update. `emailed_on` is `None` while pending -- set by
    `digest-record-sent` only after the email actually went out, so a
    failed send carries the entry into the next run instead of losing it.
    `payload` holds the sourced fields the email renders (title, url,
    score, verbatim comment...) -- see `digest.py`."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    course_id: str
    kind: str
    external_id: str
    content_hash: str
    payload: dict[str, Any] = Field(default_factory=dict)
    first_seen: datetime | None = None
    emailed_on: _date | None = None


class DailyDigestRecord(BaseModel):
    """Idempotency row for one course's Daily Overview email on one date --
    unique per `(course_id, digest_date)`, so re-running the same morning
    never double-sends. `skipped` marks a quiet day that sent nothing."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    course_id: str
    digest_date: _date
    gmail_message_id: str | None = None
    skipped: bool = False
    # The morning crawl as ingested (`digest.DigestCrawl` JSON) -- the
    # per-day facts (grade, submission statuses, login result, advice)
    # `digest-render` needs that aren't dedupe-tracked entries.
    crawl: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime | None = None

    @property
    def sent(self) -> bool:
        return self.gmail_message_id is not None or self.skipped


class Preference(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    key: str
    value: Any
    category: PreferenceCategory
    scope: PreferenceScope
    course_id: str | None = None
    source: str = "user_confirmed"
    confidence: float = 1.0
    created_at: datetime | None = None
    updated_at: datetime | None = None
    active: bool = True


class SyncRecord(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    academic_item_id: str
    google_calendar_id: str | None = None
    google_event_id: str | None = None
    last_synced_fingerprint: str | None = None
    source_modified_at: datetime | None = None
    status: SyncAction = SyncAction.REVIEW
    last_synced_at: datetime | None = None
    # A real snapshot of `reconciliation.engine._COMPARED_FIELDS` at the
    # moment this item was actually last pushed to Calendar (see
    # `reconciliation/engine.py::snapshot_compared_fields`) -- lets `plan`
    # detect drift from enrichment applied directly via `render --save`
    # (module_label, reference_url, etc.), not just drift a fresh
    # re-extraction would surface. `None` for a SyncRecord written before
    # this field existed; `decide_action` falls back to the old
    # existing-vs-incoming comparison in that case.
    last_synced_fields: dict[str, str | bool | None] | None = None


class CourseCompletenessReport(BaseModel):
    course_id: str
    status: CompletenessStatus
    inspected_source_types: list[SourceType] = Field(default_factory=list)
    missing_source_types: list[SourceType] = Field(default_factory=list)
    unresolved_reference_count: int = 0
    possible_hidden_obligations: list[str] = Field(default_factory=list)
    conflicting_date_count: int = 0
    undated_graded_work_count: int = 0
    unnested_item_count: int = 0
    unlinked_item_count: int = 0
    missing_chapter_topic_count: int = 0
    partial_chapter_topic_count: int = 0
    safe_to_sync_clear_subset: bool = True
    notes: list[str] = Field(default_factory=list)


class AuditLogEntry(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    timestamp: datetime
    event_type: str
    course_id: str | None = None
    item_id: str | None = None
    source_id: str | None = None
    summary: str
    details: dict[str, Any] = Field(default_factory=dict)
