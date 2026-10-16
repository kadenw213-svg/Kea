"""Stage 2: semantic classification of extracted text into candidate obligation types."""

from __future__ import annotations

import re

from academic_sync.models.enums import ItemType

# Ordered most-specific-first: a line matching "final exam" must classify as
# FINAL_EXAM, not the more general EXAM; "pre-lab quiz" must not fall through
# to QUIZ; "lab handout" must not fall through to LAB.
_TYPE_KEYWORDS: list[tuple[ItemType, list[str]]] = [
    (ItemType.PRE_LAB_QUIZ, ["pre-lab quiz", "prelab quiz", "pre lab quiz"]),
    (ItemType.LAB_PRACTICAL, ["lab practical", "practical exam"]),
    (ItemType.LAB_HANDOUT, ["lab handout", "lab report"]),
    (ItemType.FINAL_EXAM, ["final exam"]),
    (ItemType.ADMINISTRATIVE_DEADLINE, [
        "drop deadline", "withdrawal deadline", "withdraw deadline",
        "registration deadline", "add/drop", "last day to withdraw",
        "last day to drop",
    ]),
    (ItemType.PEER_REVIEW, ["peer review"]),
    (ItemType.PRESENTATION, ["presentation"]),
    (ItemType.RECITATION, ["recitation"]),
    (ItemType.SEMINAR, ["seminar"]),
    (ItemType.DISCUSSION, ["discussion"]),
    (ItemType.PROJECT, ["project"]),
    (ItemType.DRAFT, ["draft"]),
    (ItemType.PAPER, ["paper", "essay"]),
    (ItemType.QUIZ, ["quiz"]),
    (ItemType.EXAM, ["midterm", "exam"]),
    (ItemType.LAB, ["lab", "laboratory"]),
    (ItemType.ASSIGNMENT, ["assignment", "homework", "hw"]),
    (ItemType.BREAK, ["break", "holiday"]),
    (ItemType.NO_CLASS, ["no class"]),
    (ItemType.READING, ["reading", "read chapter"]),
    (ItemType.LECTURE, ["lecture"]),
    # Weak fallback, deliberately last: a bare "chapter" mention is much
    # weaker evidence of a reading assignment than any of the type-specific
    # keywords above -- it commonly just appears as background content
    # inside a lecture topic line ("Chapter 29: Seedless Plants"). Real
    # incident, 2026-08-19: with "chapter" checked ahead of "lecture", every
    # BIO1112 lecture-schedule line classified as READING instead of
    # LECTURE, silently producing untimed all-day reading events for the
    # whole semester while never generating a single real (timed,
    # located) lecture meeting beyond the handful created by an earlier,
    # separate manual pass. Only reached when nothing above matched, so an
    # explicit "reading"/"read chapter" line, or any line mentioning
    # lecture/lab/quiz/exam/etc., still wins over a bare chapter reference.
    (ItemType.READING, ["chapter"]),
]

# Word-boundary matching, not naive substring `in` checks -- otherwise
# "exam" false-positives inside "example.edu", "hw" inside "homework" is
# fine but "hw" inside some unrelated word would not be, etc. Each keyword
# (which may itself be a multi-word phrase) is compiled with \b at both ends.
_TYPE_KEYWORD_PATTERNS: list[tuple[ItemType, list[re.Pattern]]] = [
    (
        item_type,
        [re.compile(r"\b" + re.escape(kw) + r"\b", re.IGNORECASE) for kw in keywords],
    )
    for item_type, keywords in _TYPE_KEYWORDS
]

_DEADLINE_KEYWORDS = re.compile(
    r"\bdue\b|\bdeadline\b|\bsubmit(ted)? by\b|\bturn in\b|\bclose(s)? at\b",
    re.IGNORECASE,
)


def classify_item_type(text: str) -> ItemType | None:
    for item_type, patterns in _TYPE_KEYWORD_PATTERNS:
        if any(p.search(text) for p in patterns):
            return item_type
    return None


def is_deadline_phrasing(text: str) -> bool:
    return bool(_DEADLINE_KEYWORDS.search(text))


def find_reference_phrases(text: str, phrases: list[str]) -> list[str]:
    """Case-insensitive substring match. Returns the configured phrases that
    appear in text, in the order they were configured (not text order) --
    callers care about *which* phrases fired, not where."""
    lowered = text.lower()
    return [p for p in phrases if p.lower() in lowered]
