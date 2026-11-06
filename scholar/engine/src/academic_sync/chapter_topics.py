"""Parsing/canonicalization helpers for chapter/unit topic identity.

A "chapter/unit label" (e.g. "Chapter 23", "Unit 2") is how the system
recognizes that a lecture's title, a weekly reading block's title, and a
saved `ChapterTopic` row are all talking about the same real chapter --
independent of exact wording differences between where each label was
typed. This module is the single place that regex lives; `sync/
calendar_payload.py::_topic_line` and `db/repository.py`'s chapter-topic
lookups both build on it rather than each keeping their own copy.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from academic_sync.models.domain import ChapterTopic

# Matches "Chapter N" / "Unit N", optionally followed by ": Topic text".
# The topic text is optional because some real courses (e.g. CHE1011) only
# ever name chapters by number in their source material ("Chapter 1, 2"),
# never with a title -- see CLAUDE.md invariant 25's weekly-reading-blocks
# design and invariant 1 (never fabricate a topic name that isn't there).
# "Chapter 7 and Section 2.2: Conics" also counts as Chapter 7 -- the
# "and ..." qualifier is dropped from the label (MAT1340's real module title).
# "Module N" counts too: ENG1022's course is organized only by numbered modules.
CHAPTER_SEGMENT_PATTERN = re.compile(
    r"^(Chapter\s+\d+|Unit\s+\d+|Module\s+\d+)(?:\s+and\s+[^:]+)?(?:\s*:\s*(.+))?$",
    re.IGNORECASE,
)


def split_chapter_segments(topic: str) -> list[tuple[str | None, str]]:
    """Split a "Chapter N: Topic; Chapter M: Topic" (or bare "Chapter N;
    Chapter M" with no topic text) string into `(label, topic_text)` pairs,
    one per ";"-separated segment. `label` is `None` for a segment that
    doesn't match the chapter/unit pattern at all (e.g. a non-chapter
    administrative segment like "Syllabus and Orientation") -- `topic_text`
    is then the segment verbatim. `topic_text` is `""` when a chapter
    segment has no topic name (the bare "Chapter N" case)."""
    segments = [s.strip() for s in topic.split(";") if s.strip()]
    result: list[tuple[str | None, str]] = []
    for segment in segments:
        match = CHAPTER_SEGMENT_PATTERN.match(segment)
        if match:
            result.append((match.group(1), match.group(2) or ""))
        else:
            result.append((None, segment))
    return result


def canonicalize_chapter_label(label: str) -> str:
    """Stable identity key for a chapter/unit label, independent of exact
    casing/whitespace -- "Chapter 23", "chapter  23" both canonicalize to
    "chapter-23". Falls back to a lowercased/whitespace-collapsed form of
    the whole label for anything that isn't a recognized "Chapter N"/
    "Unit N" shape, so an unusual course-specific label (e.g. a named
    module) still gets a stable, if less structured, key."""
    match = re.match(r"^(chapter|unit|module)\s+(\d+)", label.strip(), re.IGNORECASE)
    if match:
        return f"{match.group(1).lower()}-{match.group(2)}"
    return re.sub(r"\s+", " ", label.strip().lower())


def build_chapter_topic_blocks(
    segments: list[tuple[str | None, str]],
    topics_by_label: dict[str, ChapterTopic],
) -> list[dict[str, Any]]:
    """Builds one block per chapter segment for a weekly reading block's
    THIS WEEK content -- `topics_by_label` is keyed by
    `canonicalize_chapter_label`. A chapter with a saved `ChapterTopic` row
    gets its real vocabulary/objectives as bulleted items; a chapter
    without one yet (not fabricated -- just not captured) falls back to a
    bare labeled line, same visible chapter name as before, just without
    depth. A non-chapter segment (label is `None`) becomes a plain
    label-less text block, same as `_topic_line` already renders it.

    Returns plain dicts shaped like `sync.calendar_payload.DetailsBlock`'s
    fields (label/text/items) rather than `DetailsBlock` instances --
    deliberately, so this module has no dependency on
    `sync.calendar_payload` (which itself depends on this module for
    chapter-segment parsing, via `_topic_line`). Callers construct
    `DetailsBlock(**d)` for each dict, the same pattern `cli.py::
    render_cmd` already uses for `--details-blocks`."""
    blocks: list[dict[str, Any]] = []
    for label, topic_text in segments:
        if label is None:
            blocks.append({"text": topic_text})
            continue
        # Em dash, not a colon -- format_details_blocks appends its own
        # trailing colon after the label, so "Chapter 23: Topic:" would
        # read as an awkward double colon (see docs/d2l_discovery.md's
        # weekly-reading-blocks section).
        topic = topics_by_label.get(canonicalize_chapter_label(label))
        text = topic_text or (topic.title if topic and topic.title else "")
        header = f"{label} — {text}" if text else label
        if topic is None:
            blocks.append({"text": header})
            continue
        items = study_items(topic)
        extra = added_items(topic)
        if not topic.vocabulary and topic.added_vocabulary:
            # Terms lead the chapter even when only gap-fill terms exist --
            # still visibly labeled, so a length cut never drops them first.
            items.insert(0, f"Vocabulary, {ADDED_LABEL.lower()}: {topic.added_vocabulary}")
            extra = [i for i in extra if not i.startswith("Vocabulary: ")]
        if items:
            blocks.append({"label": header, "items": items})
        elif not extra:
            blocks.append({"text": header})
        if extra:
            blocks.append({"label": f"{header} — {ADDED_LABEL}", "items": extra})
    return blocks


ADDED_LABEL = "Added (not from instructor)"


def _restates_section(objective: str, sections: list[str]) -> bool:
    """True when an "objective" is really just a section heading the
    banner's READING list already shows ("6.1 Properties of Solutions" or
    "6.1 Properties of Solutions: Henry's Law") -- the CHE-style
    duplication the user asked to remove (CLAUDE.md invariant 40)."""
    norm = objective.strip().lower()
    for section in sections:
        s = section.strip().lower()
        if not s:
            continue
        if norm == s:
            return True
        if norm.startswith(s + ":"):
            # A sub-heading ("...: Henry's Law") repeats the outline; real
            # content after the colon (a list, a sentence) is kept.
            rest = norm[len(s) + 1:].strip()
            if len(rest.split()) <= 10 and not any(c in rest for c in ",;("):
                return True
    return False


def study_items(topic: ChapterTopic) -> list[str]:
    """One chapter's sourced review list, BIO-style: the "Vocabulary:"
    line, then every concept/objective, minus any that only restate a
    READING section heading. Shared by weekly banners' TOPIC DETAIL and
    tests' EXAM CONCEPTS."""
    items = [f"Vocabulary: {topic.vocabulary}"] if topic.vocabulary else []
    items.extend(o for o in topic.objectives if not _restates_section(o, topic.sections))
    return items


def added_items(topic: ChapterTopic) -> list[str]:
    """The Claude-authored gap fill, rendered as its own visibly labeled
    block right after the chapter's sourced block -- never blended into
    it (CLAUDE.md invariant 40)."""
    items = [f"Vocabulary: {topic.added_vocabulary}"] if topic.added_vocabulary else []
    items.extend(topic.added_objectives)
    return items


@dataclass
class ReadingEntry:
    """One chapter's entry in a weekly banner's READING section: its
    header ("Chapter 23 — Evolution of Populations"), its real section
    headings (the short "Big topics" line), and its chapter-specific
    reading link, when one has been captured. Plain data so this module
    stays free of any `sync.calendar_payload` dependency (see
    `build_chapter_topic_blocks`'s docstring for why)."""

    header: str
    chapter_label: str | None = None
    sections: list[str] = field(default_factory=list)
    reading_url: str | None = None
    reading_label: str | None = None


def build_reading_entries(
    segments: list[tuple[str | None, str]],
    topics_by_label: dict[str, ChapterTopic],
) -> list[ReadingEntry]:
    """One `ReadingEntry` per segment of a weekly banner's chapter list.
    A chapter with a saved `ChapterTopic` contributes its title (when the
    banner's own segment has none), section headings, and reading link;
    one without a saved row still gets a bare header -- thin but true,
    same rule as `build_chapter_topic_blocks`. A non-chapter segment
    (label `None`) becomes a header-only entry with its text verbatim."""
    entries: list[ReadingEntry] = []
    for label, topic_text in segments:
        if label is None:
            entries.append(ReadingEntry(header=topic_text))
            continue
        topic = topics_by_label.get(canonicalize_chapter_label(label))
        text = topic_text or (topic.title if topic and topic.title else "")
        header = f"{label} — {text}" if text else label
        if topic is None:
            entries.append(ReadingEntry(header=header, chapter_label=label))
            continue
        entries.append(ReadingEntry(
            header=header,
            chapter_label=label,
            sections=list(topic.sections),
            reading_url=topic.reading_url,
            reading_label=topic.reading_label,
        ))
    return entries


def build_topic_detail_blocks(
    segments: list[tuple[str | None, str]],
    topics_by_label: dict[str, ChapterTopic],
) -> list[dict[str, Any]]:
    """TOPIC DETAIL content for a weekly banner: the full vocabulary +
    objectives list for every chapter that has a saved `ChapterTopic`
    with real items -- never summarized (the quiz GPT builds its concept
    list from this). Chapters with nothing captured are left out here;
    they already appear by name in READING."""
    return [
        b for b in build_chapter_topic_blocks(segments, topics_by_label)
        if b.get("items")
    ]
