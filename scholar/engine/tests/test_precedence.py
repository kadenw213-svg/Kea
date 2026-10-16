from __future__ import annotations

from datetime import date, datetime

from academic_sync.models.enums import SourceType
from academic_sync.reconciliation.precedence import DateCandidate, resolve


def test_agreement_no_conflict():
    candidates = [
        DateCandidate(date(2026, 10, 5), SourceType.SYLLABUS, datetime(2026, 8, 1), "s1"),
        DateCandidate(date(2026, 10, 5), SourceType.D2L_DROPBOX, datetime(2026, 8, 5), "s2"),
    ]
    result = resolve(candidates)
    assert result.is_conflict is False
    assert result.resolved_value == date(2026, 10, 5)


def test_announcement_overrides_syllabus():
    candidates = [
        DateCandidate(date(2026, 10, 5), SourceType.SYLLABUS, datetime(2026, 8, 1), "s1"),
        DateCandidate(date(2026, 10, 12), SourceType.D2L_ANNOUNCEMENTS, datetime(2026, 9, 20), "s2"),
    ]
    result = resolve(candidates)
    assert result.is_conflict is False
    assert result.resolved_value == date(2026, 10, 12)


def test_direct_d2l_source_overrides_generic_syllabus_mention():
    candidates = [
        DateCandidate(date(2026, 10, 5), SourceType.SYLLABUS, datetime(2026, 8, 1), "s1"),
        DateCandidate(date(2026, 10, 8), SourceType.D2L_DROPBOX, datetime(2026, 8, 1), "s2"),
    ]
    result = resolve(candidates)
    assert result.is_conflict is False
    assert result.resolved_value == date(2026, 10, 8)


def test_same_source_type_rescan_treats_newer_as_revision():
    candidates = [
        DateCandidate(date(2026, 10, 5), SourceType.SYLLABUS, datetime(2026, 8, 1), "s1"),
        DateCandidate(date(2026, 10, 12), SourceType.SYLLABUS, datetime(2026, 9, 1), "s2"),
    ]
    result = resolve(candidates)
    assert result.is_conflict is False
    assert result.resolved_value == date(2026, 10, 12)


def test_unrelated_conflicting_sources_require_review():
    candidates = [
        DateCandidate(date(2026, 10, 5), SourceType.D2L_CALENDAR, datetime(2026, 8, 1), "s1"),
        DateCandidate(date(2026, 10, 12), SourceType.D2L_QUIZZES, datetime(2026, 8, 1), "s2"),
    ]
    result = resolve(candidates)
    assert result.is_conflict is True
    assert result.resolved_value is None
