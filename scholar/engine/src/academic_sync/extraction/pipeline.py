"""Stages 1-3 + 5: deterministic line/table extraction, classification,
relationship resolution, and validation, producing AcademicItem drafts and
UnresolvedReference entries from a single parsed document.

Stage 4 (derived dates, e.g. "lab handout due one week after lab") is
deliberately NOT run generically here -- it requires course-specific
meeting-pattern context that only the caller (the import skill / a
course-aware orchestration layer) has. See extraction.rules for that stage;
it's applied after this pipeline produces the raw LAB items.
"""

from __future__ import annotations

import hashlib
import re
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta

from academic_sync.extraction import dates as date_extract
from academic_sync.extraction.classify import (
    classify_item_type,
    find_reference_phrases,
    is_deadline_phrasing,
)
from academic_sync.extraction.rules import (
    is_generic_frequency_statement,
    should_create_pre_lab_quiz,
)
from academic_sync.models.domain import AcademicItem, UnresolvedReference
from academic_sync.models.enums import ItemStatus, ItemType, UnresolvedReferenceKind
from academic_sync.parsers.base import ParsedDocument
from academic_sync.reconciliation.fingerprint import compute_fingerprint

# Bump whenever extraction logic changes in a way that could change output
# for previously-seen content (not just parsers/base.py's PARSER_VERSION,
# which only covers raw HTML/PDF-to-text conversion). cli.py combines both
# into the stored Source.parser_version so a re-run after a pipeline fix
# re-extracts identical content instead of silently skipping it via the
# content-hash dedup check -- see CLAUDE.md and test_cli_reextracts_on_version_bump.
EXTRACTION_VERSION = "1.14.0"

_MODULE_HEADING = re.compile(r"^\s*(week|module|unit)\s+(\d+)\b", re.IGNORECASE)
_TITLE_NOISE = re.compile(
    r"\b(due|deadline)\b|\bat\s+\d{1,2}(:\d{2})?\s*(am|pm)?\b", re.IGNORECASE
)
# A date-RANGE source line ("Labor Day Break: 9/7/26-09/08/26 -- No Classes")
# only has its first date captured as matched_date_text -- _clean_title's
# literal replace() removes just that first date, leaving a dangling
# "-09/08/26" remnant (the range's hyphen plus end date) in the title, even
# though source_wording (which isn't put through this cleaning) still has
# the full text. Real incident, 2026-08-19: both BREAK items (Labor Day,
# Thanksgiving) synced to Calendar with exactly this mangled title. Strips
# any such leftover "-M/D/YY" fragment after the primary date removal.
_DANGLING_DATE_RANGE_REMNANT = re.compile(r"[-–—]\s*\d{1,2}/\d{1,2}/\d{2,4}\b")
_TRAILING_PUNCT = re.compile(r"^[\s:\-–—.,]+|[\s:\-–—.,]+$")
_TRAILING_FILLER = re.compile(r"\b(is|at|on|was)\s*$", re.IGNORECASE)
# Bullet glyphs: standard bullet characters plus the Private Use Area range
# (U+E000-U+F8FF) that symbol/dingbat fonts commonly map bullet icons to in
# PDF text extraction (e.g. "\uf06f Lab 6" from a Wingdings-style bullet).
_LEADING_BULLET = re.compile(r"^[\u2022\u25e6\u25aa\u2023\ue000-\uf8ff]+\s*")
_WEEKDAY_WORD = re.compile(
    r"\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b", re.IGNORECASE
)


_TERM_DATE_BUFFER_DAYS = 45


def _outside_term_bounds(found_date: date, ctx: ExtractionContext) -> bool:
    """A real course-relevant date should fall within (or very near) the
    term. A date far outside that window is much more likely a parsing
    artifact -- a garbled multi-row merge, a stray number matched as a date
    -- than a genuine obligation. Concretely reproduced 2026-08-18: a
    hand-typed pipe-delimited table with no blank lines between rows got
    merged into one block, producing an item titled with two rows' worth of
    text and a completely fabricated date (2013-07-09) for a course running
    Aug-Dec 2026, marked CLEAR (sync-eligible) since nothing checked
    `term_start`/`term_end` even though ExtractionContext already carried
    them. Buffer accounts for a syllabus mentioning prep work shortly before
    term_start or a late-breaking item just after term_end; only enforced
    when both bounds are known (registered courses always have them, but
    ad-hoc extraction contexts in tests may not)."""
    if ctx.term_start is None or ctx.term_end is None:
        return False
    lo = ctx.term_start - timedelta(days=_TERM_DATE_BUFFER_DAYS)
    hi = ctx.term_end + timedelta(days=_TERM_DATE_BUFFER_DAYS)
    return not (lo <= found_date <= hi)


def _out_of_term_ref(
    ctx: ExtractionContext, line: str, found_date: date, now: datetime
) -> UnresolvedReference:
    assert ctx.term_start is not None and ctx.term_end is not None  # caller already checked
    return UnresolvedReference(
        id=uuid.uuid4().hex,
        course_id=ctx.course_id,
        source_id=ctx.source_id,
        kind=UnresolvedReferenceKind.OTHER,
        description=(
            f"Extracted date {found_date.isoformat()} falls far outside the "
            f"course term ({ctx.term_start.isoformat()} - {ctx.term_end.isoformat()}) "
            "-- flagged as a likely parsing artifact instead of trusted: "
            f'"{line}"'
        ),
        source_wording=line,
        created_at=now,
    )


def _bare_date_heading(
    line: str, reference_year: int, allow_bare_dates: bool = False
) -> date_extract.ExtractedDate | None:
    """Recognize a line that IS a date (optionally with a weekday name) and
    nothing else, e.g. "9/14/26 Monday" -- common in a syllabus's day-by-day
    schedule, where several bullet items below the heading share its date
    without restating it. Such a line establishes context (current_date in
    extract_from_document) rather than becoming an item itself.
    """
    found = date_extract.find_dates(
        line, reference_year=reference_year, allow_bare_dates=allow_bare_dates
    )
    if len(found) != 1:
        return None
    d = found[0]
    remainder = line.replace(d.raw_text, "", 1)
    remainder = _WEEKDAY_WORD.sub("", remainder)
    remainder = remainder.strip(" \t:-–—,")
    return d if not remainder else None


@dataclass
class ExtractionContext:
    course_id: str
    source_id: str
    reference_year: int
    term_start: date | None = None
    term_end: date | None = None
    default_due_time: time = time(23, 59)
    reference_phrases: list[str] = field(default_factory=list)
    is_tentative: bool = False
    allow_bare_dates: bool = False


@dataclass
class ExtractionResult:
    items: list[AcademicItem] = field(default_factory=list)
    unresolved: list[UnresolvedReference] = field(default_factory=list)


_LOOKAHEAD_LINES = 3


def _iter_blocks(text: str) -> list[list[str]]:
    """Group consecutive non-blank lines into blocks, split on blank lines.

    A blank-line-separated block is the natural unit within which a title
    line ("Online Quiz 1") and its attribute lines ("Due on Aug 30, 2026
    23:59", "Available on Aug 24, 2026 00:01") belong together -- a very
    common D2L list-page layout. Lookahead for a date never crosses a block
    boundary, so unrelated adjacent entries can't bleed into each other.
    """
    blocks: list[list[str]] = []
    current: list[str] = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            if current:
                blocks.append(current)
                current = []
            continue
        current.append(line)
    if current:
        blocks.append(current)
    return blocks


def extract_from_document(document: ParsedDocument, ctx: ExtractionContext) -> ExtractionResult:
    result = ExtractionResult()
    now = datetime.now()

    result.unresolved.extend(_scan_reference_phrases(document.text, ctx, now))

    current_module: str | None = None
    current_date: date | None = None
    for block in _iter_blocks(document.text):
        consumed: set[int] = set()
        for i, line in enumerate(block):
            if i in consumed:
                continue

            heading_match = _MODULE_HEADING.match(line)
            if heading_match and len(line) <= 40:
                current_module = f"{heading_match.group(1).title()} {heading_match.group(2)}"
                continue

            bare_date = _bare_date_heading(line, ctx.reference_year, ctx.allow_bare_dates)
            if bare_date is not None:
                current_date = bare_date.value
                continue

            lookahead = _bounded_lookahead(block, i, ctx.reference_year, ctx.allow_bare_dates)
            item, unresolved, consumed_offset = _extract_from_line(
                line, ctx, current_module, now, lookahead, current_date
            )
            if consumed_offset is not None:
                consumed.add(i + 1 + consumed_offset)
            if item is not None:
                result.items.append(item)
            result.unresolved.extend(unresolved)

    for table in document.tables:
        table_items, table_unresolved = _extract_from_table(table, ctx, now)
        result.items.extend(table_items)
        result.unresolved.extend(table_unresolved)

    return result


def _scan_reference_phrases(
    text: str, ctx: ExtractionContext, now: datetime
) -> list[UnresolvedReference]:
    matched = find_reference_phrases(text, ctx.reference_phrases)
    refs = []
    for phrase in matched:
        refs.append(
            UnresolvedReference(
                id=uuid.uuid4().hex,
                course_id=ctx.course_id,
                source_id=ctx.source_id,
                kind=UnresolvedReferenceKind.EXTERNAL_REFERENCE_UNINSPECTED,
                description=f"Source references \"{phrase}\" -- that material has not been inspected yet.",
                source_wording=phrase,
                created_at=now,
                resolved=False,
            )
        )
    return refs


def _clean_title(
    line: str,
    matched_date_text: str,
    matched_time_text: str | None,
    stated_weekday: str | None = None,
) -> str:
    line = _LEADING_BULLET.sub("", line)
    # str.replace("", " ") inserts a space between every character -- guard
    # against empty matches (lines with no date/time) before calling it.
    title = line.replace(matched_date_text, " ") if matched_date_text else line
    title = _DANGLING_DATE_RANGE_REMNANT.sub(" ", title)
    if matched_time_text:
        title = title.replace(matched_time_text, " ")
    if stated_weekday:
        title = re.sub(rf"\b{stated_weekday}\b,?", " ", title, flags=re.IGNORECASE)
    title = _TITLE_NOISE.sub(" ", title)
    title = re.sub(r"\s+", " ", title).strip()
    title = _TRAILING_PUNCT.sub("", title).strip()
    title = _TRAILING_FILLER.sub("", title).strip()
    title = _TRAILING_PUNCT.sub("", title).strip()
    return title


_PROSE_MAX_WORDS = 14


def _looks_like_prose_fragment(line: str) -> bool:
    """Heuristic for "this is a wrapped sentence from running text, not a
    title/list/table entry" -- used only to decide whether an undated line
    is worth flagging as a known-but-undated item. Never applied to a line
    that has an explicit date; those are trusted regardless of shape."""
    stripped = line.strip()
    if not stripped:
        return True
    if stripped[0].islower():
        return True
    word_count = len(stripped.split())
    if word_count > _PROSE_MAX_WORDS and ". " in stripped:
        return True
    return False


def _bounded_lookahead(
    block: list[str], i: int, reference_year: int, allow_bare_dates: bool = False
) -> list[str]:
    """Lookahead lines for line i, truncated *before* the next heading
    (module or bare-date). Without this, a lookahead search from a line just
    before a "Week 5 / 9/14/26 Monday" boundary can reach past it and borrow
    the next week's date for an item that has nothing to do with it -- which
    silently overwrites the correct item (same fingerprint, different date)
    via upsert. A heading always means "new context starts here."
    """
    out: list[str] = []
    for ln in block[i + 1 : i + 1 + _LOOKAHEAD_LINES]:
        if _MODULE_HEADING.match(ln) and len(ln) <= 40:
            break
        if _bare_date_heading(ln, reference_year, allow_bare_dates) is not None:
            break
        out.append(ln)
    return out


def _find_date_in_lookahead(
    lookahead: list[str], reference_year: int, allow_bare_dates: bool = False
) -> tuple[list[date_extract.ExtractedDate], list[date_extract.ExtractedTime], str | None, int | None]:
    """Look for a date on a following line in the same block, preferring a
    line that explicitly states "due"/"deadline" (so an "Available on ..."
    line doesn't win over a "Due on ..." line when both are present).
    Returns the offset (within `lookahead`) of the line that was used, so
    the caller can mark it consumed and skip it as its own independent line
    -- otherwise a donor line like "Due by midnight Sunday, 8/30/26" would
    also get reprocessed on its own and fabricate a second, bogus item.
    """
    due_offset = next((idx for idx, ln in enumerate(lookahead) if is_deadline_phrasing(ln)), None)
    order = [due_offset] if due_offset is not None else list(range(len(lookahead)))
    for idx in order:
        if idx is None:
            continue
        ln = lookahead[idx]
        dates = date_extract.find_dates(
            ln, reference_year=reference_year, allow_bare_dates=allow_bare_dates
        )
        if dates:
            return dates, date_extract.find_times(ln), ln, idx
    return [], [], None, None


def _extract_from_line(
    line: str,
    ctx: ExtractionContext,
    current_module: str | None,
    now: datetime,
    lookahead: list[str] | None = None,
    current_date: date | None = None,
) -> tuple[AcademicItem | None, list[UnresolvedReference], int | None]:
    unresolved: list[UnresolvedReference] = []

    item_type = classify_item_type(line)
    line_dates = date_extract.find_dates(
        line, reference_year=ctx.reference_year, allow_bare_dates=ctx.allow_bare_dates
    )
    line_times = date_extract.find_times(line)
    borrowed_from: str | None = None
    consumed_offset: int | None = None

    if item_type is None and is_deadline_phrasing(line) and not _looks_like_prose_fragment(line):
        # A short, title-like line that explicitly says "due"/"deadline" but
        # doesn't match any specific keyword (e.g. a syllabus's shorthand
        # "Inner Fish CH 1 Due" -- no "assignment"/"chapter" word present)
        # must not be silently dropped just because it isn't one of the
        # named categories. Conservative: still requires explicit deadline
        # wording and non-prose shape, same guards as everywhere else.
        item_type = ItemType.OTHER_DEADLINE

    if item_type is not None and not line_dates and lookahead:
        line_dates, line_times, borrowed_from, consumed_offset = _find_date_in_lookahead(
            lookahead, ctx.reference_year, ctx.allow_bare_dates
        )

    if item_type is not None and not line_dates and current_date is not None:
        # Inherit the date from the most recent bare-date heading line (e.g.
        # a "9/14/26 Monday" heading followed by several undated bullets) --
        # see _bare_date_heading. Synthesized with an empty raw_text/span
        # since there's no literal date text on THIS line to point to.
        line_dates = [
            date_extract.ExtractedDate(value=current_date, raw_text="", span=(0, 0))
        ]
        borrowed_from = f"date heading {current_date.isoformat()}"

    weekday_flags = [d for d in line_dates if d.weekday_consistent is False]
    for bad in weekday_flags:
        unresolved.append(
            UnresolvedReference(
                id=uuid.uuid4().hex,
                course_id=ctx.course_id,
                source_id=ctx.source_id,
                kind=UnresolvedReferenceKind.CONFLICTING_SOURCES,
                description=(
                    f"Stated weekday \"{bad.stated_weekday}\" does not match date "
                    f"{bad.value.isoformat()} ({bad.value.strftime('%A')}) in: \"{line}\""
                ),
                source_wording=line,
                created_at=now,
            )
        )

    if item_type is None:
        return None, unresolved, None

    # Fabrication guard: a pre-lab quiz (or any item) mentioned only via a
    # generic-frequency statement ("most labs include...") must not become
    # a concrete item -- it's already captured as a reference phrase above.
    if item_type == ItemType.PRE_LAB_QUIZ and not should_create_pre_lab_quiz(line):
        return None, unresolved, None
    if is_generic_frequency_statement(line):
        return None, unresolved, None

    # Precision guard for long free-text sources (a full syllabus PDF is
    # mostly policy prose, not a list of obligations): a wrapped sentence
    # fragment that happens to contain a type keyword ("...lab evaluations.
    # Approximately 70% of the course grade is based") must not become a
    # phantom "known but undated" item. A line WITH an explicit date is
    # exempted -- that's strong independent evidence it's a real schedule
    # row (e.g. a topical-outline table row), regardless of its shape.
    if not line_dates and _looks_like_prose_fragment(line):
        return None, unresolved, None

    found_date = line_dates[0].value if line_dates else None
    if found_date is not None and _outside_term_bounds(found_date, ctx):
        unresolved.append(_out_of_term_ref(ctx, line, found_date, now))
        found_date = None
    found_time = line_times[0].value if line_times else None
    matched_date_text = line_dates[0].raw_text if line_dates else ""
    matched_time_text = line_times[0].raw_text if line_times else None

    stated_weekday = line_dates[0].stated_weekday if line_dates else None
    title = (
        _clean_title(line, matched_date_text, matched_time_text, stated_weekday)
        or item_type.value.replace("_", " ").title()
    )

    status = ItemStatus.DRAFT
    due_time = None
    start_time = None

    # A type that's normally a fixed-time meeting (exam, final_exam) but is
    # explicitly phrased as a deadline ("Chapter 1 Exam Due 8/30/26") is an
    # asynchronous/online exam window, not a classroom meeting -- it belongs
    # in the deadline branch (due_time), not the meeting branch (which would
    # otherwise permanently block it on a start_time that doesn't exist for
    # an online exam). A meeting-typed line with no "due"/"deadline" wording
    # (e.g. "Cumulative Midterm ... Taken in class") still requires a real
    # start_time before it's sync-ready -- seeextraction never invents one.
    if item_type.is_fixed_time_meeting and not is_deadline_phrasing(line):
        start_time = found_time
        if found_date is None:
            unresolved.append(
                _missing_date_ref(ctx, line, item_type, now)
            )
            status = ItemStatus.UNRESOLVED
        else:
            status = ItemStatus.CLEAR
    elif item_type.is_deadline or is_deadline_phrasing(line):
        if found_date is None:
            unresolved.append(_missing_date_ref(ctx, line, item_type, now))
            status = ItemStatus.UNRESOLVED
        else:
            midnight = date_extract.has_midnight_phrase(line) or (
                borrowed_from is not None and date_extract.has_midnight_phrase(borrowed_from)
            )
            due_time = date_extract.normalize_due_datetime(
                found_date,
                explicit_time=found_time,
                midnight_phrase=midnight,
                default_due_time=ctx.default_due_time,
            )
            status = ItemStatus.CLEAR
    else:
        if found_date is not None:
            status = ItemStatus.CLEAR

    source_hash = hashlib.sha256(line.encode("utf-8")).hexdigest()
    fingerprint = compute_fingerprint(
        ctx.course_id,
        item_type.value,
        title,
        disambiguator=_fingerprint_disambiguator(item_type, title, found_date, current_module),
    )

    item = AcademicItem(
        id=uuid.uuid4().hex,
        course_id=ctx.course_id,
        source_ids=[ctx.source_id],
        item_type=item_type,
        title=title,
        date=found_date,
        start_time=start_time,
        due_time=due_time,
        module_label=current_module,
        status=status,
        confidence=0.6 if status == ItemStatus.CLEAR else 0.3,
        is_tentative=ctx.is_tentative,
        source_wording=line if borrowed_from is None else f"{line} | {borrowed_from}",
        first_seen=now,
        last_seen=now,
        source_hash=source_hash,
        fingerprint=fingerprint,
    )
    return item, unresolved, consumed_offset


def _has_sequence_number(title: str) -> bool:
    return bool(re.search(r"\d", title))


_TOPIC_SENTENCE_MEETING_TYPES = {ItemType.LECTURE, ItemType.RECITATION, ItemType.SEMINAR}


def _fingerprint_disambiguator(
    item_type: ItemType, title: str, found_date: date | None, module_label: str | None
) -> str | None:
    """Real incident, 2026-08-19: BIO1112 lecture titles like "Chapter 29:
    Seedless Plants" and "Chapter 29: Seedless Plants, cont." (two different
    class days both covering chapter 29) silently collapsed to the same
    fingerprint under the rule below, because `compute_fingerprint` reduces
    any numbered title to just `<type>-<first number>` -- correct for
    "Quiz 3" vs "Quiz 4" (the number IS a stable, unique per-item sequence
    id there), but wrong for a *topic-sentence* meeting title that can
    legitimately reference the same chapter/section number across multiple
    distinct real occurrences.

    First fix scoped this to every `is_fixed_time_meeting` type (LECTURE,
    LAB, RECITATION, SEMINAR, EXAM, FINAL_EXAM, LAB_PRACTICAL,
    PRESENTATION) -- that was wrong and caused a second real incident the
    same day: re-running `extract` on the same BIO1112 syllabus after that
    fix silently created 22 duplicate, unsynced shadow rows for LAB/EXAM/
    LAB_PRACTICAL items that were already correctly synced, because their
    *old* fingerprints (computed under the original None-disambiguator
    rule) no longer matched what the "fixed" pipeline now computed for the
    same real item, and `upsert_academic_item` looks up by fingerprint
    first -- a mismatch there means CREATE, not UPDATE. Caught before any
    of those duplicates reached Calendar (they were review re-runs, not
    live syncs), but this is exactly the kind of silent regression that
    invariant 5 exists to prevent, and it would not have been caught
    without deliberately re-running extraction and diffing -- see
    CLAUDE.md.

    Root cause of the *original* bug wasn't "meeting types," it was titles
    that are free-text topic sentences where the leading number is a
    chapter/section reference, not the item's own identity -- "Lab 4",
    "Lab Practical 2", "Exam 2" all use their leading number AS the stable
    per-occurrence identity (just like "Quiz 3"/"Quiz 4"), so they keep the
    original, correct behavior. Only LECTURE/RECITATION/SEMINAR -- the
    types whose titles are consistently topic descriptions rather than
    short numbered labels -- get the date-based override. Non-meeting
    types (and LAB/EXAM/FINAL_EXAM/LAB_PRACTICAL/PRESENTATION) keep the
    original rule (disambiguator=None when a sequence number is present)
    specifically so reworded-but-same-numbered items like "Online Quiz 4" /
    "Quiz #4 (Chapters 9-10)" keep merging into one logical item across
    re-scans -- see test_fingerprint.py's
    test_same_numbered_item_different_wording_same_fingerprint, which this
    must not break."""
    if item_type in _TOPIC_SENTENCE_MEETING_TYPES:
        return found_date.isoformat() if found_date else module_label
    return None if _has_sequence_number(title) else module_label


def _missing_date_ref(
    ctx: ExtractionContext, line: str, item_type: ItemType, now: datetime
) -> UnresolvedReference:
    return UnresolvedReference(
        id=uuid.uuid4().hex,
        course_id=ctx.course_id,
        source_id=ctx.source_id,
        kind=UnresolvedReferenceKind.MISSING_DATE,
        description=(
            f"{item_type.value.replace('_', ' ').title()} is known to exist "
            f'but has no confirmed date: "{line}"'
        ),
        source_wording=line,
        created_at=now,
    )


def _extract_from_table(
    table, ctx: ExtractionContext, now: datetime
) -> tuple[list[AcademicItem], list[UnresolvedReference]]:
    items: list[AcademicItem] = []
    unresolved: list[UnresolvedReference] = []
    headers_lower = [h.lower() for h in table.headers]

    date_col = _find_col(headers_lower, ["date"])
    title_col = _find_col(headers_lower, ["topic", "assignment", "deliverable", "title"])
    module_col = _find_col(headers_lower, ["week", "module", "unit"])

    for row in table.rows:
        row_text = " | ".join(row)
        item_type = classify_item_type(row_text)
        if item_type is None:
            continue

        date_text = row[date_col] if date_col is not None and date_col < len(row) else row_text
        found_dates = date_extract.find_dates(
            date_text, reference_year=ctx.reference_year, allow_bare_dates=ctx.allow_bare_dates
        )
        if not found_dates:
            continue
        if _outside_term_bounds(found_dates[0].value, ctx):
            unresolved.append(_out_of_term_ref(ctx, row_text, found_dates[0].value, now))
            continue

        title = (
            row[title_col]
            if title_col is not None and title_col < len(row)
            else row_text
        ).strip() or item_type.value.replace("_", " ").title()
        module_label = row[module_col] if module_col is not None and module_col < len(row) else None

        found_time = date_extract.find_times(row_text)
        due_time = None
        start_time = None
        status = ItemStatus.CLEAR
        if item_type.is_fixed_time_meeting:
            start_time = found_time[0].value if found_time else None
        elif item_type.is_deadline:
            due_time = date_extract.normalize_due_datetime(
                found_dates[0].value,
                explicit_time=found_time[0].value if found_time else None,
                midnight_phrase=date_extract.has_midnight_phrase(row_text),
                default_due_time=ctx.default_due_time,
            )

        fingerprint = compute_fingerprint(
            ctx.course_id,
            item_type.value,
            title,
            disambiguator=_fingerprint_disambiguator(
                item_type, title, found_dates[0].value, module_label
            ),
        )
        items.append(
            AcademicItem(
                id=uuid.uuid4().hex,
                course_id=ctx.course_id,
                source_ids=[ctx.source_id],
                item_type=item_type,
                title=title,
                date=found_dates[0].value,
                start_time=start_time,
                due_time=due_time,
                module_label=module_label,
                status=status,
                confidence=0.65,
                is_tentative=ctx.is_tentative,
                source_wording=row_text,
                first_seen=now,
                last_seen=now,
                source_hash=hashlib.sha256(row_text.encode("utf-8")).hexdigest(),
                fingerprint=fingerprint,
            )
        )
    return items, unresolved


def _find_col(headers_lower: list[str], candidates: list[str]) -> int | None:
    for i, h in enumerate(headers_lower):
        if any(c in h for c in candidates):
            return i
    return None
