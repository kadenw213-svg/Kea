from __future__ import annotations

from datetime import date

from academic_sync.extraction.rules import derive_lab_handout_due_date, should_create_pre_lab_quiz


def test_lab_handout_derived_due_date_confident_when_lecture_confirmed():
    lab_date = date(2026, 9, 8)  # Tuesday
    lecture_date = date(2026, 9, 15)  # Tuesday, one week later
    result = derive_lab_handout_due_date(
        lab_date,
        days_after=7,
        known_lecture_dates={lecture_date},
        no_class_dates=set(),
    )
    assert result.confident is True
    assert result.date == lecture_date


def test_lab_handout_derived_due_date_blocked_by_holiday():
    lab_date = date(2026, 9, 1)
    holiday = date(2026, 9, 8)  # Labor Day breaks the naive +7 pattern
    result = derive_lab_handout_due_date(
        lab_date,
        days_after=7,
        known_lecture_dates={date(2026, 9, 10)},
        no_class_dates={holiday},
    )
    assert result.confident is False
    assert result.date is None
    assert "holiday" in result.reason.lower()


def test_lab_handout_derived_due_date_unconfirmed_lecture_date():
    lab_date = date(2026, 9, 1)
    result = derive_lab_handout_due_date(
        lab_date,
        days_after=7,
        known_lecture_dates={date(2026, 9, 15)},  # +7 target (9/8) not in this set
        no_class_dates=set(),
    )
    assert result.confident is False
    assert result.date is None


def test_pre_lab_quiz_created_from_specific_evidence():
    assert should_create_pre_lab_quiz("Lab 6 handout: complete the pre-lab quiz before lab begins.") is True


def test_pre_lab_quiz_not_fabricated_from_generic_frequency_statement():
    # This is the exact dangerous case from the spec: a syllabus-level generic
    # statement must never turn into 12 concrete pre-lab quiz items.
    assert should_create_pre_lab_quiz("Most labs include a pre-lab quiz worth 5 points.") is False


def test_pre_lab_quiz_not_fabricated_various_generic_phrasings():
    for phrase in [
        "Some labs have a pre-lab quiz.",
        "Typically labs include a pre-lab quiz.",
        "Labs generally have a pre-lab quiz component.",
    ]:
        assert should_create_pre_lab_quiz(phrase) is False
