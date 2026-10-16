"""Enumerations for the academic data model.

Keep these as plain str Enums (not IntEnum) so values round-trip cleanly
through SQLite TEXT columns and JSON without a translation layer.
"""

from __future__ import annotations

from enum import StrEnum


class SourceType(StrEnum):
    SYLLABUS = "syllabus"
    D2L_CONTENT = "d2l_content"
    D2L_CALENDAR = "d2l_calendar"
    D2L_DROPBOX = "d2l_dropbox"
    D2L_QUIZZES = "d2l_quizzes"
    D2L_DISCUSSIONS = "d2l_discussions"
    D2L_CHECKLIST = "d2l_checklist"
    D2L_ANNOUNCEMENTS = "d2l_announcements"
    D2L_SCHEDULE_PAGE = "d2l_schedule_page"
    D2L_HOME = "d2l_home"
    LINKED_PDF = "linked_pdf"
    LINKED_DOC = "linked_doc"
    LAB_HANDOUT = "lab_handout"
    # A third-party courseware/homework platform the LMS shell links out to
    # (ALEKS, Pearson MyLab, WebAssign, etc.) -- discovered live by following
    # a shell link off the LMS's own domain, never from a hardcoded tool-name
    # list (an unlisted platform would silently defeat that approach). See
    # docs/d2l_discovery.md's external-courseware section.
    EXTERNAL_COURSEWARE = "external_courseware"
    OTHER = "other"


class ItemType(StrEnum):
    LECTURE = "lecture"
    LAB = "lab"
    RECITATION = "recitation"
    SEMINAR = "seminar"
    EXAM = "exam"
    FINAL_EXAM = "final_exam"
    LAB_PRACTICAL = "lab_practical"
    QUIZ = "quiz"
    ASSIGNMENT = "assignment"
    DISCUSSION = "discussion"
    PROJECT = "project"
    PRESENTATION = "presentation"
    PAPER = "paper"
    DRAFT = "draft"
    PEER_REVIEW = "peer_review"
    LAB_HANDOUT = "lab_handout"
    PRE_LAB_QUIZ = "pre_lab_quiz"
    ADMINISTRATIVE_DEADLINE = "administrative_deadline"
    BREAK = "break"
    NO_CLASS = "no_class"
    READING = "reading"
    OTHER_DEADLINE = "other_deadline"
    # A derived, aggregate item (is_derived=True) synthesized from a course's
    # own reading/module material -- never extracted from a single source
    # line. Spans a real week (AcademicItem.date = week start,
    # .date_range_end = week end), replacing the old per-day standalone
    # READING event entirely. See CLAUDE.md invariant 25.
    WEEKLY_READING = "weekly_reading"

    @property
    def is_fixed_time_meeting(self) -> bool:
        return self in {
            ItemType.LECTURE,
            ItemType.LAB,
            ItemType.RECITATION,
            ItemType.SEMINAR,
            ItemType.EXAM,
            ItemType.FINAL_EXAM,
            ItemType.LAB_PRACTICAL,
            ItemType.PRESENTATION,
        }

    @property
    def is_assessment(self) -> bool:
        """Tests: the item types whose events carry study-guide links
        (`weekly_links`) alongside their own turn-in links -- user-directed
        2026-10-07, see CLAUDE.md invariant 17's amendment."""
        return self in {
            ItemType.EXAM,
            ItemType.FINAL_EXAM,
            ItemType.QUIZ,
            ItemType.LAB_PRACTICAL,
            ItemType.PRE_LAB_QUIZ,
        }

    @property
    def is_routine_meeting(self) -> bool:
        """Meeting types where showing up "sometime that day" without a
        precise time is still useful, low-stakes visibility -- unlike an
        exam/practical/presentation, guessing wrong here has low cost. These
        fall back to an all-day Calendar event when no start_time is known,
        rather than being permanently blocked in the review queue (see
        AcademicItem.is_ready_to_sync / sync/calendar_payload.py). Deliberately
        excludes EXAM/FINAL_EXAM/LAB_PRACTICAL/PRESENTATION -- those stay
        conservative and require a real time before syncing."""
        return self in {
            ItemType.LECTURE,
            ItemType.LAB,
            ItemType.RECITATION,
            ItemType.SEMINAR,
        }

    @property
    def is_deadline(self) -> bool:
        return self in {
            ItemType.QUIZ,
            ItemType.ASSIGNMENT,
            ItemType.DISCUSSION,
            ItemType.PROJECT,
            ItemType.PAPER,
            ItemType.DRAFT,
            ItemType.PEER_REVIEW,
            ItemType.LAB_HANDOUT,
            ItemType.PRE_LAB_QUIZ,
            ItemType.ADMINISTRATIVE_DEADLINE,
            ItemType.OTHER_DEADLINE,
        }


class ItemStatus(StrEnum):
    DRAFT = "draft"                # extracted, not yet validated
    CLEAR = "clear"                # validated, safe to sync
    UNRESOLVED = "unresolved"      # known to exist, missing a required field (usually date)
    CONFLICTED = "conflicted"      # contradictory evidence, needs human review
    SUPERSEDED = "superseded"      # replaced by a newer logical version of itself
    CANCELLED = "cancelled"        # source explicitly says this no longer applies
    SYNCED = "synced"              # has a live corresponding Calendar event


class CompletenessStatus(StrEnum):
    COMPLETE = "COMPLETE"
    COMPLETE_FOR_DATED_ITEMS = "COMPLETE_FOR_DATED_ITEMS"
    INCOMPLETE = "INCOMPLETE"
    CONFLICTED = "CONFLICTED"
    UNKNOWN = "UNKNOWN"


class SyncAction(StrEnum):
    CREATE = "CREATE"
    UPDATE = "UPDATE"
    UNCHANGED = "UNCHANGED"
    CONFLICT = "CONFLICT"
    IGNORE = "IGNORE"
    REVIEW = "REVIEW"
    CANCELLED_BY_SOURCE = "CANCELLED_BY_SOURCE"


class PreferenceScope(StrEnum):
    GLOBAL = "global"
    COURSE = "course"


class PreferenceCategory(StrEnum):
    CALENDAR = "calendar"
    TIMING = "timing"
    TITLES = "titles"
    LOCATION = "location"
    PRECEDENCE = "precedence"
    D2L_ALIAS = "d2l_alias"
    ADMINISTRATIVE = "administrative"
    OTHER = "other"


class CourseStatus(StrEnum):
    ACTIVE = "active"
    INACTIVE = "inactive"
    ARCHIVED = "archived"


class DiagnosticStatus(StrEnum):
    """Red/Yellow/Green classification for a course (or the overall
    cross-course banner, which takes the worst of its courses) in the
    weekly grade diagnostic. See diagnostics.py::classify_course."""

    RED = "RED"
    YELLOW = "YELLOW"
    GREEN = "GREEN"


class UnresolvedReferenceKind(StrEnum):
    MISSING_DATE = "missing_date"
    AMBIGUOUS_LOCATION = "ambiguous_location"
    EXTERNAL_REFERENCE_UNINSPECTED = "external_reference_uninspected"
    CONFLICTING_SOURCES = "conflicting_sources"
    DERIVED_DATE_BROKEN_BY_HOLIDAY = "derived_date_broken_by_holiday"
    UNCONFIRMED_RECURRENCE = "unconfirmed_recurrence"
    OTHER = "other"
