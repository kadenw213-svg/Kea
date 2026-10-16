from __future__ import annotations

import uuid
from datetime import datetime

from academic_sync.completeness.analyzer import analyze_completeness
from academic_sync.models.domain import UnresolvedReference
from academic_sync.models.enums import SourceType, UnresolvedReferenceKind


def _ref(kind: UnresolvedReferenceKind, desc: str = "x") -> UnresolvedReference:
    return UnresolvedReference(
        id=uuid.uuid4().hex, course_id="c1", kind=kind, description=desc,
        created_at=datetime.now(), resolved=False,
    )


def test_unknown_when_no_sources_inspected():
    report = analyze_completeness(
        "c1", inspected_source_types=set(), unresolved_references=[],
        conflicting_date_count=0, undated_graded_work_count=0,
    )
    assert report.status.value == "UNKNOWN"


def test_synthetic_course_with_no_sources_reports_complete_not_unknown():
    # CLAUDE.md invariant 35 -- a course flagged Course.is_synthetic
    # (custom-curriculum skill) has zero Source rows and zero
    # ChapterTopic rows by design, since nothing was ever scraped and the
    # skill never calls chapter-topic-add. That's expected and correct,
    # not the same "nobody's looked yet" gap this same empty-sources
    # input means for a real course (see the UNKNOWN test right above).
    report = analyze_completeness(
        "c1", inspected_source_types=set(), unresolved_references=[],
        conflicting_date_count=0, undated_graded_work_count=0,
        missing_chapter_topic_count=0, partial_chapter_topic_count=0,
        is_synthetic=True,
    )
    assert report.status.value == "COMPLETE"
    assert report.safe_to_sync_clear_subset is True


def test_see_d2l_reference_forces_incomplete():
    refs = [
        _ref(UnresolvedReferenceKind.EXTERNAL_REFERENCE_UNINSPECTED, 'References "see D2L" -- not inspected.')
    ]
    report = analyze_completeness(
        "c1",
        inspected_source_types={SourceType.SYLLABUS},
        unresolved_references=refs,
        conflicting_date_count=0,
        undated_graded_work_count=0,
    )
    assert report.status.value == "INCOMPLETE"
    assert report.safe_to_sync_clear_subset is True  # clear items may still sync


def test_additional_details_will_be_provided_forces_incomplete():
    refs = [_ref(
        UnresolvedReferenceKind.EXTERNAL_REFERENCE_UNINSPECTED,
        'References "additional details will be provided" -- not inspected.',
    )]
    report = analyze_completeness(
        "c1", inspected_source_types={SourceType.SYLLABUS}, unresolved_references=refs,
        conflicting_date_count=0, undated_graded_work_count=0,
    )
    assert report.status.value == "INCOMPLETE"


def test_undated_graded_work_forces_incomplete():
    report = analyze_completeness(
        "c1", inspected_source_types={SourceType.SYLLABUS}, unresolved_references=[],
        conflicting_date_count=0, undated_graded_work_count=2,
    )
    assert report.status.value == "INCOMPLETE"


def test_conflicting_dates_forces_conflicted_regardless_of_other_signals():
    report = analyze_completeness(
        "c1", inspected_source_types={SourceType.SYLLABUS, SourceType.D2L_CALENDAR},
        unresolved_references=[], conflicting_date_count=1, undated_graded_work_count=0,
    )
    assert report.status.value == "CONFLICTED"


def test_complete_for_dated_items_when_clean_but_not_every_area_scanned():
    report = analyze_completeness(
        "c1",
        inspected_source_types={
            SourceType.SYLLABUS, SourceType.D2L_CONTENT, SourceType.D2L_CALENDAR,
            SourceType.D2L_DROPBOX, SourceType.D2L_QUIZZES,
        },
        unresolved_references=[], conflicting_date_count=0, undated_graded_work_count=0,
    )
    assert report.status.value == "COMPLETE_FOR_DATED_ITEMS"


def test_complete_when_all_typical_areas_scanned_and_nothing_open():
    from academic_sync.completeness.analyzer import TYPICAL_SOURCE_TYPES

    report = analyze_completeness(
        "c1", inspected_source_types=set(TYPICAL_SOURCE_TYPES),
        unresolved_references=[], conflicting_date_count=0, undated_graded_work_count=0,
    )
    assert report.status.value == "COMPLETE"


def test_unnested_items_force_incomplete():
    """Once a course has real module structure (signaled by the caller via
    a nonzero unnested_item_count), dated items missing that nesting are a
    required find, not optional enrichment -- see CLAUDE.md invariant 17."""
    report = analyze_completeness(
        "c1", inspected_source_types={SourceType.SYLLABUS, SourceType.D2L_CONTENT},
        unresolved_references=[], conflicting_date_count=0, undated_graded_work_count=0,
        unnested_item_count=3,
    )
    assert report.status.value == "INCOMPLETE"
    assert report.unnested_item_count == 3


def test_unlinked_graded_items_force_incomplete():
    report = analyze_completeness(
        "c1", inspected_source_types={SourceType.SYLLABUS, SourceType.D2L_CONTENT},
        unresolved_references=[], conflicting_date_count=0, undated_graded_work_count=0,
        unlinked_item_count=4,
    )
    assert report.status.value == "INCOMPLETE"
    assert report.unlinked_item_count == 4


def test_missing_chapter_topic_forces_incomplete():
    """CLAUDE.md invariant 26: once a course's weekly reading blocks
    reference a chapter/unit, a saved ChapterTopic row is required, same
    footing as unnested_item_count/unlinked_item_count."""
    report = analyze_completeness(
        "c1", inspected_source_types={SourceType.SYLLABUS, SourceType.D2L_CONTENT},
        unresolved_references=[], conflicting_date_count=0, undated_graded_work_count=0,
        missing_chapter_topic_count=2,
    )
    assert report.status.value == "INCOMPLETE"
    assert report.missing_chapter_topic_count == 2


def test_partial_chapter_topic_forces_incomplete():
    """CLAUDE.md invariant 26: a saved ChapterTopic row that hasn't been
    confirmed exhaustive (is_exhaustive=False) is not enough on its own --
    it may still be a partial/sampled capture, distinct from
    missing_chapter_topic_count (no row at all)."""
    report = analyze_completeness(
        "c1", inspected_source_types={SourceType.SYLLABUS, SourceType.D2L_CONTENT},
        unresolved_references=[], conflicting_date_count=0, undated_graded_work_count=0,
        partial_chapter_topic_count=1,
    )
    assert report.status.value == "INCOMPLETE"
    assert report.partial_chapter_topic_count == 1


def test_detailed_syllabus_alone_is_never_complete():
    """The central rule: having ONE detailed source (a syllabus) is not
    enough to call a course COMPLETE if nothing else has been inspected."""
    report = analyze_completeness(
        "c1", inspected_source_types={SourceType.SYLLABUS},
        unresolved_references=[], conflicting_date_count=0, undated_graded_work_count=0,
    )
    assert report.status.value != "COMPLETE"
