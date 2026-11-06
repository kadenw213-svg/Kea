"""Stage 4: derived dates and fabrication guards.

Every function here either returns a confidently-derived answer with an
auditable reason, or returns None with a reason explaining why it refused --
never a guess. Callers must turn a None result into an UnresolvedReference,
not a silently-dropped item.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta

_GENERIC_FREQUENCY_MARKERS = [
    "most labs", "most lab", "some labs", "some lab", "generally",
    "typically", "usually", "in most cases",
]


@dataclass
class DerivationResult:
    date: date | None
    rule: str
    confident: bool
    reason: str


def derive_lab_handout_due_date(
    lab_date: date,
    *,
    days_after: int,
    known_lecture_dates: set[date],
    no_class_dates: set[date],
) -> DerivationResult:
    """Apply a deterministic rule like "handout due at the start of lecture
    N days after the lab." Only returns a confident date when the resulting
    day is an actual, known lecture date and not a suppressed no-class day.
    """
    rule = f"Lab handout due at start of lecture {days_after} day(s) after lab on {lab_date.isoformat()}."
    target = lab_date + timedelta(days=days_after)

    if target in no_class_dates:
        return DerivationResult(
            date=None,
            rule=rule,
            confident=False,
            reason=(
                f"{target.isoformat()} is a no-class/holiday date, so the normal "
                "lecture-based due date does not apply. Needs another source to resolve."
            ),
        )
    if known_lecture_dates and target not in known_lecture_dates:
        return DerivationResult(
            date=None,
            rule=rule,
            confident=False,
            reason=(
                f"{target.isoformat()} is not a confirmed lecture date for this course "
                "(no meeting pattern evidence covers it), so the derived due date is unconfirmed."
            ),
        )
    return DerivationResult(
        date=target,
        rule=rule,
        confident=True,
        reason=f"Derived from lab date {lab_date.isoformat()} plus {days_after} day(s); "
        f"{target.isoformat()} is a confirmed lecture date.",
    )


def should_create_pre_lab_quiz(evidence_text: str) -> bool:
    """A pre-lab quiz item may only be created from specific evidence (the
    lab handout itself, a D2L quiz listing naming that lab) -- never from a
    generic syllabus statement like "most labs include a pre-lab quiz."
    """
    lowered = evidence_text.lower()
    if any(marker in lowered for marker in _GENERIC_FREQUENCY_MARKERS):
        return False
    return "pre-lab quiz" in lowered or "prelab quiz" in lowered or "pre lab quiz" in lowered


def is_generic_frequency_statement(text: str) -> bool:
    lowered = text.lower()
    return any(marker in lowered for marker in _GENERIC_FREQUENCY_MARKERS)
