"""Stable fingerprinting for deduplication.

The fingerprint identifies a *logical* obligation (course + type + canonical
name), deliberately independent of wording that might shift between a first
pass and a revised syllabus ("Quiz 4" vs "Online Quiz #4" vs "Quiz 4 (Ch.
9-10)"). Two extractions of the same logical item must fingerprint the same
so a wording/date change becomes an UPDATE, never a second CREATE.
"""

from __future__ import annotations

import hashlib
import re

_SEQUENCE_PATTERN = re.compile(r"\b(\d+)\b")
_NOISE_WORDS = {
    "the", "a", "an", "due", "is", "will", "be", "online", "in", "class",
    "assignment", "for",
}
# A number immediately followed by one of these is a quantity (points,
# minutes, a percentage), not a sequence identifier -- "Syllabus Quiz 5 pts"
# must not canonicalize to the same identity as "Online Quiz 5". Getting
# this wrong causes a silent fingerprint collision: upsert_academic_item
# would overwrite one logical item with an unrelated one under the same row.
# Matched against the ORIGINAL (lowercased, unstripped) title so a
# no-space "%" suffix is still caught before punctuation stripping would
# separate it into its own token.
_UNIT_SUFFIX_PATTERN = re.compile(
    r"\b(\d+)\s*%|\b(\d+)\s*(?:pts?\.?|points?|minutes?|mins?|percent|pct\.?)\b",
    re.IGNORECASE,
)
# A number directly hyphenated to a following word ("15-week course",
# "3-credit", "100-point") is a compound-adjective quantity, not a sequence
# identifier -- same failure mode as above but via a different real syllabus
# pattern ("Last day to drop [any 15-week course]" vs "...to withdraw [from
# any 15-week course]" collided into one fingerprint before this existed).
# General on purpose (any hyphenated word, not a fixed list) since this
# pattern recurs with different words each time.
_HYPHENATED_MODIFIER_PATTERN = re.compile(r"\b(\d+)-[a-zA-Z]")

# A decimal section number ("HW: 1.3" vs "HW: 1.4") must survive as ONE
# token, not get its fractional part stripped by the generic punctuation
# cleanup below -- "1.3" and "1.4" collapsing to the same identity "1"
# silently destroyed ~30 distinct homework deadlines down to a handful in
# practice. The placeholder must itself be a \w character (letters/digits/
# underscore) or the punctuation-stripping regex below would strip *it* too
# -- a null byte was tried first and silently failed exactly that way.
_DECIMAL_POINT = re.compile(r"(?<=\d)\.(?=\d)")
_DECIMAL_PLACEHOLDER = "0decimalpoint0"
_NUMBER_TOKEN = re.compile(r"^\d+(?:\.\d+)?$")


def _numbers_used_as_quantities(lowered_title: str) -> set[str]:
    excluded: set[str] = set()
    for m in _UNIT_SUFFIX_PATTERN.finditer(lowered_title):
        excluded.add(m.group(1) or m.group(2))
    for m in _HYPHENATED_MODIFIER_PATTERN.finditer(lowered_title):
        excluded.add(m.group(1))
    return excluded


def canonicalize_title(title: str, item_type_value: str) -> str:
    """Reduce a title to a stable identity string.

    Strategy: lowercase, strip punctuation, then prefer a
    "<item_type>-<sequence_number>" identity when a number is present that
    isn't immediately followed by a unit word (this is what actually
    distinguishes "Quiz 3" from "Quiz 4", while not being fooled by a point
    value like "5 pts"); otherwise fall back to the full cleaned title with
    noise words dropped.
    """
    lowered = title.lower()
    quantity_numbers = _numbers_used_as_quantities(lowered)

    protected = _DECIMAL_POINT.sub(_DECIMAL_PLACEHOLDER, lowered)
    cleaned = re.sub(r"[^\w\s]", " ", protected).replace(_DECIMAL_PLACEHOLDER, ".")
    raw_tokens = cleaned.split()

    numbers = [
        t
        for t in raw_tokens
        if _NUMBER_TOKEN.match(t) and t.split(".")[0] not in quantity_numbers
    ]
    if numbers:
        return f"{item_type_value}-{numbers[0]}"

    tokens = [t for t in raw_tokens if t not in _NOISE_WORDS]
    words = [t for t in tokens if not _NUMBER_TOKEN.match(t)]
    return f"{item_type_value}-" + "-".join(words) if words else item_type_value


def compute_fingerprint(
    course_id: str,
    item_type_value: str,
    title: str,
    *,
    disambiguator: str | None = None,
) -> str:
    """disambiguator: use for items whose canonical title alone is ambiguous
    across occurrences (e.g. weekly "Discussion Post" -- pass the module/week
    label or a stable sequence key so each week's post gets its own
    fingerprint instead of colliding into one)."""
    identity = canonicalize_title(title, item_type_value)
    parts = [course_id, identity]
    if disambiguator:
        parts.append(disambiguator.lower().strip())
    raw = "|".join(parts)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def compute_calendar_fingerprint(fingerprint: str) -> str:
    """Value stored in the Google Calendar event's extended private
    properties so a re-scan can recognize "this event is ours" even if local
    state were ever lost -- see docs/architecture.md#idempotency."""
    return fingerprint[:32]
