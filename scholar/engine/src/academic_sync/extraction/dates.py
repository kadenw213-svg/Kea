"""Date/time extraction and normalization.

Explicit literal dates/times are handled here. Relative/derived rules like
"one week after lab" or "before class" are NOT resolved in this module --
they're recognized as derivation rules in extraction/rules.py and only
resolved once the anchor (a lab date, a class meeting time) is known and
unambiguous. This module only ever returns values it can point to literal
text for, and it flags -- never silently discards -- weekday/date
contradictions.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, datetime, time, tzinfo
from zoneinfo import ZoneInfo

from dateutil import parser as dateutil_parser

WEEKDAYS = [
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
]

_DATE_PATTERNS: list[re.Pattern] = [
    re.compile(r"\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b"),                 # 8/17/26, 08-17-2026
    re.compile(r"\b\d{1,2}-[A-Za-z]{3,9}-\d{2,4}\b"),                  # 17-AUG-26
    re.compile(r"\b[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{2,4}\b"),         # September 14, 2026
]

# Bare M/D with no year -- common in grid-style "Course Calendar" documents
# where the year is only stated once in a page header (e.g. MAT1340's weekly
# calendar: "8/17", "9/2 Drop Date"). Genuinely ambiguous in general prose
# (a fraction like "3/4 majority"), so this is opt-in only (allow_bare_dates)
# for callers who know the source is a dated grid, never a default pattern.
# Negative lookahead avoids double-matching the M/D prefix of a full M/D/Y
# date already caught by the pattern above.
_BARE_MONTH_DAY_PATTERN = re.compile(r"\b(\d{1,2})/(\d{1,2})\b(?!/\d)")
_DAYS_IN_MONTH = {1: 31, 2: 29, 3: 31, 4: 30, 5: 31, 6: 30, 7: 31, 8: 31, 9: 30, 10: 31, 11: 30, 12: 31}

_WEEKDAY_NAME = re.compile(
    r"\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b", re.IGNORECASE
)

_TIME_PATTERN = re.compile(
    r"\b(\d{1,2}):(\d{2})\s*(am|pm|AM|PM)?\b|\b(\d{1,2})\s*(am|pm|AM|PM)\b"
)

MIDNIGHT_PHRASE = re.compile(r"\bmidnight\b", re.IGNORECASE)
END_OF_DAY_PHRASE = re.compile(r"\bend of day\b|\beod\b", re.IGNORECASE)
BEFORE_CLASS_PHRASE = re.compile(r"\bbefore class\b", re.IGNORECASE)

_WEEKDAY_LOOKBACK_CHARS = 20


@dataclass
class ExtractedDate:
    value: date
    raw_text: str
    span: tuple[int, int]
    stated_weekday: str | None = None
    weekday_consistent: bool | None = None  # None = no weekday stated to check


@dataclass
class ExtractedTime:
    value: time
    raw_text: str
    span: tuple[int, int]


def _find_preceding_weekday(preceding_text: str) -> str | None:
    matches = list(_WEEKDAY_NAME.finditer(preceding_text))
    return matches[-1].group(1).lower() if matches else None


def find_dates(
    text: str, *, reference_year: int | None = None, allow_bare_dates: bool = False
) -> list[ExtractedDate]:
    """Find explicit calendar dates in text.

    reference_year fills in a default when a date string omits the year
    (rare in practice for syllabi, but dateutil requires *some* default).

    allow_bare_dates: also match year-less "M/D" (e.g. "8/17") using
    reference_year as the implied year. Off by default -- see
    _BARE_MONTH_DAY_PATTERN's docstring for why this must stay opt-in.
    """
    default_dt = datetime(reference_year or datetime.now().year, 1, 1)
    results: list[ExtractedDate] = []
    seen_spans: set[tuple[int, int]] = set()

    patterns = list(_DATE_PATTERNS)
    if allow_bare_dates:
        patterns.append(_BARE_MONTH_DAY_PATTERN)

    for pattern in patterns:
        for m in pattern.finditer(text):
            span = m.span()
            if span in seen_spans:
                continue
            raw = m.group(0)
            if pattern is _BARE_MONTH_DAY_PATTERN and not _valid_bare_month_day(m):
                continue
            lookback_start = max(0, m.start() - _WEEKDAY_LOOKBACK_CHARS)
            stated_weekday = _find_preceding_weekday(text[lookback_start : m.start()])
            try:
                parsed = dateutil_parser.parse(raw, fuzzy=True, default=default_dt)
            except (ValueError, OverflowError):
                continue
            value = parsed.date()
            weekday_consistent: bool | None = None
            if stated_weekday:
                weekday_consistent = WEEKDAYS[value.weekday()] == stated_weekday
            seen_spans.add(span)
            results.append(
                ExtractedDate(
                    value=value,
                    raw_text=raw,
                    span=span,
                    stated_weekday=stated_weekday,
                    weekday_consistent=weekday_consistent,
                )
            )
    return results


def _valid_bare_month_day(m: re.Match) -> bool:
    month, day = int(m.group(1)), int(m.group(2))
    if not (1 <= month <= 12):
        return False
    return 1 <= day <= _DAYS_IN_MONTH[month]


def find_times(text: str) -> list[ExtractedTime]:
    results: list[ExtractedTime] = []
    for m in _TIME_PATTERN.finditer(text):
        raw = m.group(0)
        try:
            parsed = dateutil_parser.parse(raw, fuzzy=True)
        except (ValueError, OverflowError):
            continue
        results.append(ExtractedTime(value=parsed.time(), raw_text=raw, span=m.span()))
    return results


def has_midnight_phrase(text: str) -> bool:
    return bool(MIDNIGHT_PHRASE.search(text) or END_OF_DAY_PHRASE.search(text))


def has_before_class_phrase(text: str) -> bool:
    return bool(BEFORE_CLASS_PHRASE.search(text))


def normalize_due_datetime(
    due_date: date,
    *,
    explicit_time: time | None = None,
    midnight_phrase: bool = False,
    before_class_time: time | None = None,
    default_due_time: time = time(23, 59),
) -> time:
    """Resolve the due *time* for a date-only or loosely-worded deadline.

    Precedence: explicit stated time > "before class" (uses the class's own
    start time, if known) > "midnight"/"end of day" phrasing -> 23:59 >
    configured default due time. Never invents a date; this function only
    ever resolves the time-of-day component.
    """
    if explicit_time is not None:
        return explicit_time
    if before_class_time is not None:
        return before_class_time
    if midnight_phrase:
        return time(23, 59)
    return default_due_time


def localize(d: date, t: time, tz: tzinfo | str) -> datetime:
    zone = ZoneInfo(tz) if isinstance(tz, str) else tz
    return datetime.combine(d, t, tzinfo=zone)
