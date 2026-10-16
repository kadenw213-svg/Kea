from __future__ import annotations

import uuid
from datetime import date

from academic_sync.diagnostics import classify_course, overall_status
from academic_sync.models.domain import CourseGradeSnapshot, GradeSnapshot
from academic_sync.models.enums import DiagnosticStatus, SourceType

WEEK = date(2026, 9, 14)
PREV_WEEK = date(2026, 9, 7)


def _course_snapshot(overall_percent: float | None, *, week_start: date = WEEK) -> CourseGradeSnapshot:
    return CourseGradeSnapshot(
        id=uuid.uuid4().hex, course_id="c1", week_start=week_start,
        captured_at=week_start, overall_percent=overall_percent,
    )


def _item_snapshot(
    title: str,
    score_percent: float | None = None,
    *,
    is_missing: bool = False,
    academic_item_id: str | None = None,
) -> GradeSnapshot:
    return GradeSnapshot(
        id=uuid.uuid4().hex, course_id="c1", academic_item_id=academic_item_id,
        title=title, week_start=WEEK, captured_at=WEEK,
        score_percent=score_percent, is_missing=is_missing,
        source_type=SourceType.D2L_QUIZZES,
    )


def test_all_a_grades_zero_missing_is_green():
    status = classify_course(
        current=_course_snapshot(95.0), previous=_course_snapshot(94.0, week_start=PREV_WEEK),
        item_snapshots=[_item_snapshot("Quiz 3", 95.0)],
    )
    assert status == DiagnosticStatus.GREEN


def test_single_missing_item_is_yellow_even_with_a_grade():
    status = classify_course(
        current=_course_snapshot(95.0), previous=_course_snapshot(95.0, week_start=PREV_WEEK),
        item_snapshots=[_item_snapshot("Homework 4", is_missing=True)],
    )
    assert status == DiagnosticStatus.YELLOW


def test_below_a_cutoff_with_nothing_else_wrong_is_yellow():
    status = classify_course(
        current=_course_snapshot(85.0), previous=_course_snapshot(85.0, week_start=PREV_WEEK),
        item_snapshots=[_item_snapshot("Quiz 3", 85.0)],
    )
    assert status == DiagnosticStatus.YELLOW


def test_real_zero_on_graded_item_is_red():
    status = classify_course(
        current=_course_snapshot(88.0), previous=_course_snapshot(90.0, week_start=PREV_WEEK),
        item_snapshots=[_item_snapshot("Quiz 3", 0.0)],
    )
    assert status == DiagnosticStatus.RED


def test_bombed_major_assessment_is_red_even_above_60_overall():
    status = classify_course(
        current=_course_snapshot(82.0), previous=_course_snapshot(88.0, week_start=PREV_WEEK),
        item_snapshots=[_item_snapshot("Exam 1", 30.0, academic_item_id="item-1")],
        major_assessment_item_ids=frozenset({"item-1"}),
    )
    assert status == DiagnosticStatus.RED


def test_low_score_on_non_major_item_is_only_yellow():
    status = classify_course(
        current=_course_snapshot(88.0), previous=_course_snapshot(89.0, week_start=PREV_WEEK),
        item_snapshots=[_item_snapshot("Homework 4", 65.0)],
    )
    assert status == DiagnosticStatus.YELLOW


def test_two_missing_items_is_red():
    status = classify_course(
        current=_course_snapshot(92.0), previous=_course_snapshot(92.0, week_start=PREV_WEEK),
        item_snapshots=[
            _item_snapshot("Homework 4", is_missing=True),
            _item_snapshot("Homework 5", is_missing=True),
        ],
    )
    assert status == DiagnosticStatus.RED


def test_overall_grade_below_70_is_red():
    status = classify_course(
        current=_course_snapshot(65.0), previous=_course_snapshot(72.0, week_start=PREV_WEEK),
        item_snapshots=[],
    )
    assert status == DiagnosticStatus.RED


def test_steep_week_over_week_drop_is_red():
    status = classify_course(
        current=_course_snapshot(80.0), previous=_course_snapshot(92.0, week_start=PREV_WEEK),
        item_snapshots=[],
    )
    assert status == DiagnosticStatus.RED


def test_small_week_over_week_drop_is_yellow_not_red():
    status = classify_course(
        current=_course_snapshot(90.0), previous=_course_snapshot(93.0, week_start=PREV_WEEK),
        item_snapshots=[],
    )
    assert status == DiagnosticStatus.YELLOW


def test_no_current_snapshot_defaults_to_yellow_not_green():
    # Insufficient data to certify Green -- never silently Green without
    # a real current-week overall grade on record.
    status = classify_course(current=None, previous=None, item_snapshots=[])
    assert status == DiagnosticStatus.YELLOW


def test_overall_status_is_worst_of_courses():
    assert overall_status([DiagnosticStatus.GREEN, DiagnosticStatus.YELLOW]) == DiagnosticStatus.YELLOW
    assert overall_status(
        [DiagnosticStatus.GREEN, DiagnosticStatus.YELLOW, DiagnosticStatus.RED]
    ) == DiagnosticStatus.RED
    assert overall_status([DiagnosticStatus.GREEN]) == DiagnosticStatus.GREEN
    assert overall_status([]) == DiagnosticStatus.GREEN
