from __future__ import annotations

from datetime import date, time

from academic_sync.extraction import dates


def test_parses_slash_date():
    found = dates.find_dates("Assignment due 8/17/26.", reference_year=2026)
    assert found[0].value == date(2026, 8, 17)


def test_parses_full_slash_date():
    found = dates.find_dates("Due 08/17/2026 at noon.", reference_year=2026)
    assert found[0].value == date(2026, 8, 17)


def test_parses_dash_month_abbrev():
    found = dates.find_dates("Exam on 17-AUG-26.", reference_year=2026)
    assert found[0].value == date(2026, 8, 17)


def test_parses_month_name_date():
    found = dates.find_dates("Project due September 14, 2026.", reference_year=2026)
    assert found[0].value == date(2026, 9, 14)


def test_weekday_consistency_flagged_when_wrong():
    # 9/27/26 is a Sunday; claiming Monday is a contradiction that must be flagged, not silently fixed.
    found = dates.find_dates("Reading due Monday, 9/27/26.", reference_year=2026)
    assert found[0].value == date(2026, 9, 27)
    assert found[0].weekday_consistent is False


def test_weekday_consistency_true_when_correct():
    found = dates.find_dates("Reading due Sunday, 9/27/26.", reference_year=2026)
    assert found[0].weekday_consistent is True


def test_no_weekday_stated_is_none_not_false():
    found = dates.find_dates("Reading due 9/27/26.", reference_year=2026)
    assert found[0].weekday_consistent is None


def test_bare_month_day_off_by_default():
    # Ambiguous in general prose (a fraction like "3/4 majority") -- must
    # stay off unless explicitly requested.
    found = dates.find_dates("Classes start 8/17.", reference_year=2026)
    assert found == []


def test_bare_month_day_when_explicitly_allowed():
    found = dates.find_dates("8/17 Classes Start", reference_year=2026, allow_bare_dates=True)
    assert len(found) == 1
    assert found[0].value == date(2026, 8, 17)


def test_bare_month_day_does_not_double_match_full_date():
    # "8/17/26" must be caught once by the full M/D/Y pattern, not also
    # partially matched as a bare "8/17" by the opt-in pattern.
    found = dates.find_dates("Due 8/17/26 at noon.", reference_year=2026, allow_bare_dates=True)
    assert len(found) == 1
    assert found[0].value == date(2026, 8, 17)


def test_bare_month_day_rejects_invalid_month_or_day():
    found = dates.find_dates("Section 13/45 of the handbook.", reference_year=2026, allow_bare_dates=True)
    assert found == []


def test_find_times():
    found = dates.find_times("Lab starts at 9:00 AM sharp.")
    assert found[0].value == time(9, 0)


def test_midnight_phrase_detected():
    assert dates.has_midnight_phrase("Due by midnight Sunday.")
    assert not dates.has_midnight_phrase("Due at 5:00 PM.")


def test_normalize_due_datetime_midnight_maps_to_2359():
    result = dates.normalize_due_datetime(
        date(2026, 9, 27), midnight_phrase=True, default_due_time=time(23, 59)
    )
    assert result == time(23, 59)


def test_normalize_due_datetime_explicit_time_wins():
    result = dates.normalize_due_datetime(
        date(2026, 9, 27), explicit_time=time(17, 0), midnight_phrase=True
    )
    assert result == time(17, 0)


def test_normalize_due_datetime_before_class_uses_class_start():
    result = dates.normalize_due_datetime(
        date(2026, 9, 27), before_class_time=time(10, 0), default_due_time=time(23, 59)
    )
    assert result == time(10, 0)


def test_normalize_due_datetime_default_fallback():
    result = dates.normalize_due_datetime(date(2026, 9, 27), default_due_time=time(23, 59))
    assert result == time(23, 59)
