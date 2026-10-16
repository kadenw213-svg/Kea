"""Red/Yellow/Green classification for the weekly grade diagnostic.

Pure functions only -- no DB access, no network. `db/repository.py` supplies
the snapshots; `.claude/skills/academic-sync/SKILL.md`'s Step 3 is the only
caller. See CLAUDE.md's grade-diagnostic invariant for the rule's rationale
and the user-directed thresholds this implements.
"""

from __future__ import annotations

from collections.abc import Iterable

from academic_sync.models.domain import CourseGradeSnapshot, GradeSnapshot
from academic_sync.models.enums import DiagnosticStatus

DEFAULT_A_CUTOFF = 90.0
"""A course below this overall percent is Yellow at minimum, even with
nothing else wrong -- the user's explicit "anything less than an A" rule.
No per-course grading scale is captured anywhere in this codebase yet, so
this is a flat default, not derived from a real source per course."""

RED_ZERO_SCORE = 0.0
RED_MAJOR_ASSESSMENT_FLOOR = 60.0
RED_MISSING_COUNT = 2
RED_OVERALL_FLOOR = 70.0
RED_DROP_POINTS = 10.0

YELLOW_MISSING_COUNT = 1
YELLOW_LOW_SCORE_FLOOR = 60.0


def classify_course(
    *,
    current: CourseGradeSnapshot | None,
    previous: CourseGradeSnapshot | None,
    item_snapshots: Iterable[GradeSnapshot],
    major_assessment_item_ids: frozenset[str] = frozenset(),
    a_cutoff: float = DEFAULT_A_CUTOFF,
) -> DiagnosticStatus:
    """Classify one course's status for the current diagnostic week.

    `major_assessment_item_ids` -- the `AcademicItem.id`s of this course's
    EXAM/FINAL_EXAM/PROJECT-type items, resolved by the caller (this module
    deliberately doesn't import `ItemType` or take an `AcademicItem`, to
    stay a small, independently testable classifier) -- a low score on one
    of these is Red at a higher score floor than an ordinary item.

    Rule (see CLAUDE.md): Red is reserved for things that actively threaten
    success; Yellow is the default "room to improve" state -- any course
    below an A, or any single missing item, is Yellow at minimum; Green
    requires an A-range grade *and* zero missing work.
    """
    item_snapshots = list(item_snapshots)
    missing_count = sum(1 for s in item_snapshots if s.is_missing)

    drop_points: float | None = None
    if current is not None and previous is not None:
        if current.overall_percent is not None and previous.overall_percent is not None:
            drop_points = previous.overall_percent - current.overall_percent

    # --- Red -----------------------------------------------------------
    has_real_zero = any(
        not s.is_missing and s.score_percent is not None and s.score_percent <= RED_ZERO_SCORE
        for s in item_snapshots
    )
    has_bombed_major_assessment = any(
        s.academic_item_id in major_assessment_item_ids
        and s.score_percent is not None
        and s.score_percent < RED_MAJOR_ASSESSMENT_FLOOR
        for s in item_snapshots
    )
    has_multiple_missing = missing_count >= RED_MISSING_COUNT
    overall_failing = (
        current is not None
        and current.overall_percent is not None
        and current.overall_percent < RED_OVERALL_FLOOR
    )
    steep_drop = drop_points is not None and drop_points >= RED_DROP_POINTS

    if has_real_zero or has_bombed_major_assessment or has_multiple_missing or overall_failing or steep_drop:
        return DiagnosticStatus.RED

    # --- Yellow ----------------------------------------------------------
    below_a = (
        current is not None
        and current.overall_percent is not None
        and current.overall_percent < a_cutoff
    )
    single_missing = missing_count == YELLOW_MISSING_COUNT
    has_low_score = any(
        not s.is_missing
        and s.score_percent is not None
        and YELLOW_LOW_SCORE_FLOOR <= s.score_percent < a_cutoff
        for s in item_snapshots
    )
    any_drop = drop_points is not None and drop_points > 0

    have_enough_data_for_green = (
        current is not None and current.overall_percent is not None
    )

    if below_a or single_missing or has_low_score or any_drop or not have_enough_data_for_green:
        return DiagnosticStatus.YELLOW

    # --- Green -------------------------------------------------------------
    # Reached only when we have a real current overall grade at/above the
    # A cutoff, no missing work at all, and nothing else tripped Yellow/Red.
    if missing_count == 0:
        return DiagnosticStatus.GREEN
    return DiagnosticStatus.YELLOW


_STATUS_SEVERITY = {
    DiagnosticStatus.GREEN: 0,
    DiagnosticStatus.YELLOW: 1,
    DiagnosticStatus.RED: 2,
}


def overall_status(course_statuses: Iterable[DiagnosticStatus]) -> DiagnosticStatus:
    """The cross-course banner's own status is the worst of any course's
    status. Defaults to GREEN for an empty input (no active real courses to
    diagnose) rather than raising -- callers should already have excluded
    that case, but this stays well-defined either way."""
    statuses = list(course_statuses)
    if not statuses:
        return DiagnosticStatus.GREEN
    return max(statuses, key=lambda s: _STATUS_SEVERITY[s])
