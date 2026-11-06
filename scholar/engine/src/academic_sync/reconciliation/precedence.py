"""Evidence-based source precedence for conflicting dates.

Deliberately not a single global ranking. Per spec: a later explicit revision
overrides an older syllabus; a direct D2L assignment page overrides a generic
syllabus mention of the same deliverable; an instructor announcement
explicitly changing a date overrides the earlier one. Anything else that
disagrees is a genuine conflict -- return None and let a human resolve it.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from academic_sync.models.enums import SourceType

# Direct "operational" pages represent the actual deliverable, so they beat a
# generic mention of the same deliverable in a syllabus.
_DIRECT_OPERATIONAL_TYPES = {
    SourceType.D2L_DROPBOX,
    SourceType.D2L_QUIZZES,
    SourceType.D2L_CALENDAR,
    SourceType.D2L_SCHEDULE_PAGE,
    SourceType.D2L_DISCUSSIONS,
}


@dataclass
class DateCandidate:
    value: Any
    source_type: SourceType
    retrieved_at: datetime
    source_id: str


@dataclass
class PrecedenceResult:
    resolved_value: Any | None
    reason: str
    is_conflict: bool
    losing_candidates: list[DateCandidate]


def resolve(candidates: list[DateCandidate]) -> PrecedenceResult:
    if not candidates:
        return PrecedenceResult(None, "No candidates.", False, [])

    distinct_values = {c.value for c in candidates}
    if len(distinct_values) == 1:
        return PrecedenceResult(candidates[0].value, "All sources agree.", False, [])

    announcements = [c for c in candidates if c.source_type == SourceType.D2L_ANNOUNCEMENTS]
    if len(announcements) == 1:
        winner = announcements[0]
        return PrecedenceResult(
            winner.value,
            f"Instructor announcement (source {winner.source_id}) explicitly overrides earlier date.",
            False,
            [c for c in candidates if c is not winner],
        )
    if len(announcements) > 1:
        newest = max(announcements, key=lambda c: c.retrieved_at)
        if len({c.value for c in announcements}) > 1:
            return PrecedenceResult(
                None,
                "Multiple conflicting instructor announcements found for the same item.",
                True,
                candidates,
            )
        return PrecedenceResult(newest.value, "Announcements agree.", False, [])

    same_type = {c.source_type for c in candidates}
    if len(same_type) == 1:
        newest = max(candidates, key=lambda c: c.retrieved_at)
        return PrecedenceResult(
            newest.value,
            f"Same source type re-scanned; most recently retrieved "
            f"({winner_desc(newest)}) treated as a revision.",
            False,
            [c for c in candidates if c is not newest],
        )

    direct = [c for c in candidates if c.source_type in _DIRECT_OPERATIONAL_TYPES]
    syllabus = [c for c in candidates if c.source_type == SourceType.SYLLABUS]
    if len(direct) >= 1 and syllabus and (len(candidates) - len(direct) - len(syllabus)) == 0:
        distinct_direct_values = {c.value for c in direct}
        if len(distinct_direct_values) == 1:
            winner = direct[0]
            return PrecedenceResult(
                winner.value,
                f"Direct D2L source ({winner.source_type.value}) represents the actual "
                "deliverable and overrides the generic syllabus mention.",
                False,
                syllabus,
            )

    return PrecedenceResult(
        None,
        "Conflicting dates from sources with no clear revision relationship; requires review.",
        True,
        candidates,
    )


def winner_desc(candidate: DateCandidate) -> str:
    return f"{candidate.source_type.value} retrieved {candidate.retrieved_at.isoformat()}"
