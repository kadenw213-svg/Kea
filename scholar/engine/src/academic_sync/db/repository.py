"""Repository layer: translates between ORM rows and Pydantic domain models.

Every function here takes an open Session so callers control transaction
boundaries (see db.session.session_scope). Nothing in this module talks to
the network -- that keeps extraction/completeness/reconciliation testable
against a plain in-memory SQLite database.
"""

from __future__ import annotations

import re

import uuid
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from academic_sync.chapter_topics import canonicalize_chapter_label
from academic_sync.db.orm import (
    AcademicItemRow,
    AuditLogRow,
    ChapterTopicRow,
    CourseGradeSnapshotRow,
    CoursePortalLinkRow,
    CourseRow,
    DailyDigestRecordRow,
    DigestEntryRow,
    GradeSnapshotRow,
    LocationRow,
    PreferenceRow,
    SourceRow,
    SyncRecordRow,
    UnresolvedReferenceRow,
    WeeklyDiagnosticRecordRow,
)
from academic_sync.models import domain
from academic_sync.models.enums import (
    DiagnosticStatus,
    ItemStatus,
    PreferenceCategory,
    PreferenceScope,
    SyncAction,
    UnresolvedReferenceKind,
)

# --------------------------------------------------------------------------
# Courses
# --------------------------------------------------------------------------

def upsert_course(session: Session, course: domain.Course) -> CourseRow:
    row = session.get(CourseRow, course.id)
    if row is None:
        existing = session.execute(
            select(CourseRow).where(
                CourseRow.course_code == course.course_code,
                CourseRow.term == course.term,
                CourseRow.section == course.section,
            )
        ).scalar_one_or_none()
        row = existing
    if row is None:
        row = CourseRow(id=course.id)
        session.add(row)
    for field in (
        "course_code",
        "section",
        "name",
        "term",
        "instructor",
        "instructor_contact",
        "campus",
        "start_date",
        "end_date",
        "d2l_identifier",
        "d2l_url",
        "delivery_format",
        "status",
        "is_synthetic",
    ):
        value = getattr(course, field, None)
        if value is not None:
            setattr(row, field, value.value if hasattr(value, "value") else value)
    session.flush()
    return row


def get_course(session: Session, course_id: str) -> domain.Course | None:
    row = session.get(CourseRow, course_id)
    return domain.Course.model_validate(row) if row else None


def resolve_course_id(session: Session, course_id_or_prefix: str) -> str | None:
    """Resolve a full course id or an unambiguous id prefix (the `courses`
    command displays only the first 8 characters) to a full course id.
    Returns None if nothing matches or a prefix matches more than one
    course -- callers should treat that as "not found" rather than guess."""
    if session.get(CourseRow, course_id_or_prefix) is not None:
        return course_id_or_prefix
    matches = session.execute(
        select(CourseRow.id).where(CourseRow.id.like(f"{course_id_or_prefix}%"))
    ).scalars().all()
    if len(matches) == 1:
        return matches[0]
    if matches:
        return None
    # Also accept a course code ("MAT1340", "mat 1340") when exactly one
    # course has it -- the daily run addresses courses by code.
    wanted = course_id_or_prefix.replace(" ", "").lower()
    by_code = [
        row.id for row in session.execute(select(CourseRow)).scalars()
        if row.course_code.replace(" ", "").lower() == wanted
    ]
    return by_code[0] if len(by_code) == 1 else None


def list_courses(session: Session, term: str | None = None) -> list[domain.Course]:
    stmt = select(CourseRow)
    if term:
        stmt = stmt.where(CourseRow.term == term)
    rows = session.execute(stmt).scalars().all()
    return [domain.Course.model_validate(r) for r in rows]


# --------------------------------------------------------------------------
# Sources
# --------------------------------------------------------------------------

def find_source_by_hash(session: Session, course_id: str, content_hash: str) -> SourceRow | None:
    """Most recent source with this content hash, if any.

    More than one row can legitimately share a content_hash: each
    reprocessing pass after an extraction-pipeline version bump adds a new
    Source row rather than mutating history (see cli.py::extract_cmd), so
    this must not assume uniqueness -- ordering by retrieved_at and taking
    the latest is what "is this exact content already ingested with the
    current pipeline" needs to check against.
    """
    return session.execute(
        select(SourceRow)
        .where(
            SourceRow.course_id == course_id,
            SourceRow.content_hash == content_hash,
        )
        .order_by(SourceRow.retrieved_at.desc())
        .limit(1)
    ).scalar_one_or_none()


def add_source(session: Session, source: domain.Source, raw_text: str | None = None) -> SourceRow:
    row = SourceRow(
        id=source.id,
        course_id=source.course_id,
        source_type=source.source_type.value,
        title=source.title,
        url=source.url,
        local_path=source.local_path,
        retrieved_at=source.retrieved_at,
        modified_at=source.modified_at,
        content_hash=source.content_hash,
        parser_version=source.parser_version,
        extracted_at=source.extracted_at,
        is_tentative=source.is_tentative,
        superseded_by_id=source.superseded_by_id,
        raw_text=raw_text if raw_text is not None else source.raw_text,
    )
    session.add(row)
    session.flush()
    _auto_resolve_external_reference_uninspected(session, source)
    return row


def _auto_resolve_external_reference_uninspected(session: Session, source: domain.Source) -> None:
    """A course's open EXTERNAL_REFERENCE_UNINSPECTED references (recorded
    live via `unresolved-add` when discovery found a shell link off the
    LMS's own domain but hadn't opened it yet) are stale once a Source
    actually gets added whose title/url plainly is that same thing -- e.g.
    a reference with source_wording "ALEKS" is satisfied by a newly-added
    Source titled "ALEKS". Matched conservatively (case-insensitive
    substring, either direction) against source_wording only -- never
    against the free-text `description` field, which is written for humans
    and not a safe match target. A missed match just leaves the reference
    open for a human/future session to clear manually via
    `unresolved-resolve`; it never risks resolving the wrong thing."""
    if not source.title:
        return
    candidates = session.execute(
        select(UnresolvedReferenceRow).where(
            UnresolvedReferenceRow.course_id == source.course_id,
            UnresolvedReferenceRow.kind == UnresolvedReferenceKind.EXTERNAL_REFERENCE_UNINSPECTED.value,
            UnresolvedReferenceRow.resolved.is_(False),
        )
    ).scalars().all()
    title_lower = source.title.lower()
    for ref in candidates:
        wording = (ref.source_wording or "").strip().lower()
        if not wording:
            continue
        if wording in title_lower or title_lower in wording:
            ref.resolved = True
            ref.resolution_note = f"Auto-resolved: Source '{source.title}' ({source.id}) was added."


def _source_row_to_domain(row: SourceRow) -> domain.Source:
    data = domain.Source.model_validate(row).model_dump()
    data["raw_text"] = row.raw_text
    return domain.Source.model_validate(data)


def list_sources_for_course(session: Session, course_id: str) -> list[domain.Source]:
    rows = session.execute(
        select(SourceRow).where(SourceRow.course_id == course_id)
    ).scalars().all()
    return [_source_row_to_domain(r) for r in rows]


def get_source(session: Session, source_id: str) -> domain.Source | None:
    row = session.get(SourceRow, source_id)
    return _source_row_to_domain(row) if row else None


# --------------------------------------------------------------------------
# Locations
# --------------------------------------------------------------------------

def find_or_create_location(
    session: Session,
    *,
    campus: str | None = None,
    building: str | None = None,
    room: str | None = None,
    platform_location: str | None = None,
) -> LocationRow:
    stmt = select(LocationRow).where(
        LocationRow.campus == campus,
        LocationRow.building == building,
        LocationRow.room == room,
        LocationRow.platform_location == platform_location,
    )
    row = session.execute(stmt).scalar_one_or_none()
    if row is None:
        row = LocationRow(
            campus=campus, building=building, room=room, platform_location=platform_location
        )
        session.add(row)
        session.flush()
    return row


# --------------------------------------------------------------------------
# Academic items
# --------------------------------------------------------------------------

def find_item_by_fingerprint(
    session: Session, course_id: str, fingerprint: str
) -> AcademicItemRow | None:
    return session.execute(
        select(AcademicItemRow).where(
            AcademicItemRow.course_id == course_id,
            AcademicItemRow.fingerprint == fingerprint,
        )
    ).scalar_one_or_none()



# ---------- Never overwrite one piece of work with another ----------
# Fingerprints are deliberately loose ("quiz" + its number), so a reworded item updates in place. But two different
# pieces of work can share one: on 2026-10-19 "Quiz for OA 6" overwrote "HW Quiz 6", and on 2026-10-17 a "Lab 3
# Handout" deadline overwrote the "Lab 3: Classification" lab meeting. So a fingerprint match only updates when the
# two are recognisably the same work; otherwise the newcomer becomes its own item and the near-miss is recorded.
_GUARD_STOP = {"due", "the", "and", "for", "with", "from", "online", "week", "post", "posts", "initial", "response",
               "submit", "submission", "pdf", "only", "folder", "part", "your", "this", "that", "complete", "chapter",
               "chapters", "requires", "lockdown", "browser", "respondus", "webcam"}
_GUARD_KIND = re.compile(
    r"\b(lab(?:oratory)?|report|quiz|exam|test|hw|homework|assignment|module|discussion|oa|unit|project|paper|essay|"
    r"worksheet|handout|practical|activity)\s*[:#.]?\s*#?\s*(\d+(?:\.\d+)*)\b|#\s*(\d+)\b",
    re.IGNORECASE,
)


def _guard_ident(title: str):
    m = _GUARD_KIND.search(title or "")
    if not m:
        return None, None
    if m.group(3):
        return m.group(3), None
    kind = m.group(1).lower()
    return m.group(2), {"homework": "hw", "laboratory": "lab", "test": "exam"}.get(kind, kind)


def _guard_words(title: str) -> set[str]:
    return {w[:-1] if len(w) > 4 and w.endswith("s") else w for w in re.findall(r"[a-z]+", (title or "").lower()) if len(w) >= 4 and w not in _GUARD_STOP}


def same_work_title(old_title: str, new_title: str) -> bool:
    """Whether two titles can be the same piece of work (a rewording), not two different ones that share a number."""
    if (old_title or "").strip().lower() == (new_title or "").strip().lower():
        return True
    ia, ka = _guard_ident(old_title)
    ib, kb = _guard_ident(new_title)
    if ia and ib and ia != ib:
        return False
    if ka and kb and ka != kb:
        return False
    a, b = _guard_words(old_title), _guard_words(new_title)
    # Words that only one of them has, naming a different kind of thing.
    marks = ("handout", "work", "practice", "review", "quiz", "report", "practical")
    for m in marks:
        if (m in (old_title or "").lower()) != (m in (new_title or "").lower()) and not (m == "quiz" and ka == kb == "quiz"):
            return False
    if not a or not b:
        return True
    return len(a & b) / min(len(a), len(b)) >= 0.34


def upsert_academic_item(
    session: Session, item: domain.AcademicItem, *, allow_downgrade: bool = False
) -> AcademicItemRow:
    """Insert or update-in-place by (course_id, fingerprint).

    Returns the row. Caller is responsible for deciding CREATE vs UPDATE
    semantics upstream (reconciliation.decide_action) -- this function just
    performs the write once that decision has been made.

    **Downgrade guard** (real incident, 2026-08-19): fingerprint identity is
    deliberately independent of `date` (see reconciliation/fingerprint.py's
    module docstring -- a wording/date change should UPDATE, not duplicate).
    But that same property means a *worse* re-extraction of the same
    logical item -- one that fails to find a date this pass, for whatever
    reason (a missing `--allow-bare-dates` flag, a slightly different page
    render, a source temporarily truncated) -- matches the identical
    fingerprint and, before this guard, silently overwrote `date`/
    `due_time`/`start_time`/`end_time`/`status` back to unknown on a row
    that was already CLEAR (or SYNCED, with a real live Calendar event
    already reflecting the correct date). This happened for real to two
    MAT1340 assignments: both had genuine, already-synced Calendar events
    with the correct 11/11 and 11/15 due dates, while the local row had
    regressed to `date=None, status=UNRESOLVED` -- the live Calendar was
    silently more correct than the local database is supposed to
    represent, and nothing surfaced the drift.

    Root cause is structural, not just this one incident: `cli.py`'s
    `extract` command computes a plan (CREATE/UPDATE/CONFLICT/REVIEW) and
    prints it, but the actual write loop calls this function unconditionally
    for every extracted candidate regardless of what the plan says -- the
    plan has been informational only, never a real gate. This guard makes
    the safe behavior the default at the one place every write path (CLI
    extract, ad-hoc scripts, tests) actually funnels through, rather than
    depending on every caller to re-derive "is this actually an improvement"
    correctly every time.

    Default (`allow_downgrade=False`): if the existing row already has
    `status in (CLEAR, SYNCED)` and a confirmed `date`, and the incoming
    item's `date` is `None`, the date/time/status fields are **not**
    overwritten -- the existing (better) values are kept, and an
    `UnresolvedReferenceKind.CONFLICTING_SOURCES` reference is recorded so
    the drift is visible instead of silent. Every other field (title,
    links, points, module_label, etc.) still updates normally -- this only
    guards against *losing* a confirmed date, not against real content
    refinements. Pass `allow_downgrade=True` for a deliberate, reviewed
    correction (e.g. a source that explicitly says the date was wrong)."""
    row = None
    if item.fingerprint:
        row = find_item_by_fingerprint(session, item.course_id, item.fingerprint)
        if row is not None and not same_work_title(row.title, item.title):
            # Different work under the same loose fingerprint: keep both, and leave a note to look at.
            import hashlib

            other = row
            item = item.model_copy(update={"fingerprint": f"{item.fingerprint}~{hashlib.sha1(item.title.encode()).hexdigest()[:8]}"})
            row = find_item_by_fingerprint(session, item.course_id, item.fingerprint)
            if row is None:
                session.add(UnresolvedReferenceRow(
                    id=uuid.uuid4().hex,
                    course_id=item.course_id,
                    item_id=None,
                    source_id=(item.source_ids[0] if item.source_ids else None),
                    kind="conflicting_sources",
                    description=f'Kept separate: "{item.title}" ({item.date}) shares an identity key with "{other.title}" ({other.date}) but is different work, so it was added as its own item instead of replacing it.',
                    source_wording=item.title[:300],
                    created_at=datetime.now(UTC),
                    resolved=False,
                ))
    if row is None and item.id:
        row = session.get(AcademicItemRow, item.id)

    now = datetime.now(UTC)
    if row is None:
        row = AcademicItemRow(id=item.id, course_id=item.course_id, first_seen=now)
        session.add(row)

    existing_confirmed = row.status in ("clear", "synced") and row.date is not None
    would_downgrade = existing_confirmed and item.date is None
    skip_date_fields = would_downgrade and not allow_downgrade

    if skip_date_fields:
        add_unresolved_reference(
            session,
            domain.UnresolvedReference(
                id=uuid.uuid4().hex,
                course_id=item.course_id,
                item_id=row.id,
                kind=UnresolvedReferenceKind.CONFLICTING_SOURCES,
                description=(
                    f'A re-extraction of "{item.title}" found no date, but this item '
                    f"already had a confirmed date ({row.date}) and status {row.status!r} "
                    "-- kept the existing date instead of overwriting it with unknown. "
                    "If this item's date genuinely changed, resolve deliberately "
                    "(upsert_academic_item(..., allow_downgrade=True))."
                ),
                source_wording=item.source_wording,
                created_at=now,
            ),
        )

    row.source_ids_json = item.source_ids
    row.item_type = item.item_type.value
    row.title = item.title
    row.description = item.description
    if not skip_date_fields:
        # A genuinely different incoming date (not the first time this row
        # gets a date) supersedes any earlier pattern-rule inference --
        # clear the "(Inferred Date)" flag/rule so a real, literally-sourced
        # correction doesn't keep showing a now-stale inferred-date tag. See
        # CLAUDE.md invariant 29.
        if row.date is not None and item.date is not None and row.date != item.date:
            row.is_inferred_date = False
            row.date_inference_rule = None
        row.date = item.date
        row.start_time = item.start_time
        row.end_time = item.end_time
        row.due_time = item.due_time
        # Third related incident, same root cause: a raw re-extraction (or
        # any caller building an AcademicItem from scratch) always computes
        # status from what it found this pass, which can never be SYNCED --
        # only record-sync legitimately sets that, after a real
        # create_event/update_event call. Applying it unconditionally
        # regressed already-synced items back to CLEAR purely from being
        # re-extracted, corrupting `academic-sync status`'s reporting (the
        # real duplicate-prevention signal is SyncRecord, not this field,
        # so this was a bookkeeping bug, not a duplicate-Calendar-event
        # risk -- but a confusing one for exactly the "run this for a
        # friend and trust the status output" case this audit is for).
        if row.status == "synced" and item.status != ItemStatus.SYNCED and not allow_downgrade:
            pass
        else:
            row.status = item.status.value
    row.location_id = item.location_id
    row.platform_location = item.platform_location
    # link_available_date joins the enrichment-preservation loop below (not
    # set unconditionally here) for the same reason as module_label/
    # reference_url: it's written out-of-band by `render --link-available-
    # date`, never by the extraction pipeline itself, so an unconditional
    # overwrite here would let a raw re-extraction silently erase it.
    # Enrichment-preservation guard, same family as the date guard above --
    # a second real incident the same day: re-extracting a source that had
    # already been manually enriched (topic-name titles, module_label,
    # reference_url via `render --save`) silently erased all of it, because
    # the raw re-extraction has no knowledge of enrichment applied outside
    # the extraction pipeline and unconditionally overwrote these fields
    # with the unenriched extracted value (often blank/None). This lost
    # `module_label`/`reference_url` on 23 already-enriched MAT1340 HW
    # items in one re-extraction call. Rule: never let an incoming falsy
    # value (None/empty string) clear a field that already holds a real
    # value -- an incoming *non-empty* value still always wins (so a
    # genuine content update/correction still applies normally), this only
    # stops enrichment from being silently blanked out by a source that
    # simply doesn't carry that information.
    for field in (
        "module_label", "reference_url", "reference_url_label",
        "resource_url", "resource_url_label", "submission_url", "submission_url_label",
        "video_url", "video_url_label", "points", "link_available_date",
        "date_range_end", "date_inference_rule",
    ):
        incoming_value = getattr(item, field)
        if incoming_value or not getattr(row, field):
            setattr(row, field, incoming_value)
    # weekly_links joins the same enrichment-preservation rule -- it's set
    # out-of-band by `render --links ... --save` / `weekly-reading-add
    # --links`, never by the extraction pipeline, so a raw re-extraction
    # (empty list) must not blank an already-populated one. Field name
    # differs from the ORM column, so it can't ride the loop above.
    if item.weekly_links or not row.weekly_links_json:
        row.weekly_links_json = [link.model_dump() for link in item.weekly_links]
    # Same rule for the test-only lists (CLAUDE.md invariant 40).
    if item.covered_chapters or not row.covered_chapters_json:
        row.covered_chapters_json = item.covered_chapters
    if item.study_focus or not row.study_focus_json:
        row.study_focus_json = item.study_focus
    row.parent_item_id = item.parent_item_id
    row.confidence = item.confidence
    row.is_tentative = item.is_tentative
    row.is_derived = item.is_derived
    row.derivation_rule = item.derivation_rule
    row.source_wording = item.source_wording
    row.is_optional = item.is_optional or row.is_optional
    row.is_inferred_date = item.is_inferred_date or row.is_inferred_date
    row.last_seen = now
    row.source_hash = item.source_hash
    row.superseded_by_id = item.superseded_by_id
    row.calendar_event_id = item.calendar_event_id
    row.calendar_fingerprint = item.calendar_fingerprint
    row.fingerprint = item.fingerprint or row.fingerprint
    session.flush()

    if item.status == ItemStatus.CLEAR and item.date is not None:
        _auto_resolve_missing_date_references(session, item)

    return row


def _auto_resolve_missing_date_references(session: Session, item: domain.AcademicItem) -> None:
    """A prior extraction pass may have left a MISSING_DATE unresolved
    reference for this same logical item (e.g. before a source added an
    explicit due date, or before a pipeline bug that missed it got fixed).
    Once the item has a confirmed date, that reference is stale -- leaving
    it open would permanently and misleadingly inflate completeness reports.

    Matched conservatively by exact title text (the MISSING_DATE reference's
    source_wording is set to the same cleaned line/title the item's title
    came from -- see extraction/pipeline.py::_missing_date_ref). A missed
    match just leaves a stale reference for a human to clear manually; it
    never risks resolving the wrong one.
    """
    assert item.date is not None  # caller already checked; narrows the type for mypy
    session.execute(
        update(UnresolvedReferenceRow)
        .where(
            UnresolvedReferenceRow.course_id == item.course_id,
            UnresolvedReferenceRow.kind == UnresolvedReferenceKind.MISSING_DATE.value,
            UnresolvedReferenceRow.resolved.is_(False),
            UnresolvedReferenceRow.source_wording == item.title,
        )
        .values(
            resolved=True,
            resolution_note=f"Auto-resolved: item now has a confirmed date ({item.date.isoformat()}).",
        )
    )


def get_academic_item(session: Session, item_id: str) -> domain.AcademicItem | None:
    row = session.get(AcademicItemRow, item_id)
    return _item_row_to_domain(row) if row else None


def list_items_for_course(session: Session, course_id: str) -> list[domain.AcademicItem]:
    rows = session.execute(
        select(AcademicItemRow).where(AcademicItemRow.course_id == course_id)
    ).scalars().all()
    return [_item_row_to_domain(r) for r in rows]


def list_clear_unsynced_items(session: Session, course_id: str | None = None) -> list[domain.AcademicItem]:
    stmt = select(AcademicItemRow).where(AcademicItemRow.status.in_(["clear", "synced"]))
    if course_id:
        stmt = stmt.where(AcademicItemRow.course_id == course_id)
    rows = session.execute(stmt).scalars().all()
    return [_item_row_to_domain(r) for r in rows]


def list_items_needing_link_recheck(
    session: Session,
    course_id: str | None = None,
    lookback_days: int = 14,
    lookahead_days: int = 14,
) -> list[domain.AcademicItem]:
    """Items with a known `link_available_date` that falls within
    [today - lookback_days, today + lookahead_days] and still have neither
    reference_url nor resource_url.

    Two distinct reasons an item belongs in this window, both real:
    - `lookback_days` catches items that should already be unlocked (their
      available date has passed) but haven't been re-checked yet.
    - `lookahead_days` catches items whose *stated* available date is still
      a week or two out but that may already be unlocked in practice --
      D2L's "Available on" date is sometimes conservative/approximate, and
      this runs weekly, so waiting for the exact date to pass before ever
      looking would mean a genuinely-open item sits unfound for up to
      another week. Checking a bit early costs nothing (the item just stays
      a candidate next week if it's still actually locked); checking too
      late is the actual failure mode this exists to prevent.
    An item with no known `link_available_date` at all, or one far outside
    this window in either direction, is not a candidate -- this is a
    targeted re-check list, not a general "everything unlinked" query (that
    already exists via completeness's missing-link count). See
    academic-import SKILL.md's "link refresh" step, which drives this with
    real browser navigation; this function only picks the candidates, never
    touches D2L itself."""
    today = date.today()
    window_start = today - timedelta(days=lookback_days)
    window_end = today + timedelta(days=lookahead_days)
    stmt = select(AcademicItemRow).where(
        AcademicItemRow.link_available_date.is_not(None),
        AcademicItemRow.link_available_date >= window_start,
        AcademicItemRow.link_available_date <= window_end,
        AcademicItemRow.reference_url.is_(None),
        AcademicItemRow.resource_url.is_(None),
    )
    if course_id:
        stmt = stmt.where(AcademicItemRow.course_id == course_id)
    rows = session.execute(stmt).scalars().all()
    return [_item_row_to_domain(r) for r in rows]


def _item_row_to_domain(row: AcademicItemRow) -> domain.AcademicItem:
    data = domain.AcademicItem.model_validate(row).model_dump()
    data["source_ids"] = row.source_ids_json or []
    data["weekly_links"] = row.weekly_links_json or []
    data["covered_chapters"] = row.covered_chapters_json or []
    data["study_focus"] = row.study_focus_json or []
    return domain.AcademicItem.model_validate(data)


# --------------------------------------------------------------------------
# Unresolved references
# --------------------------------------------------------------------------

def add_unresolved_reference(
    session: Session, ref: domain.UnresolvedReference
) -> UnresolvedReferenceRow:
    row = UnresolvedReferenceRow(
        id=ref.id,
        course_id=ref.course_id,
        item_id=ref.item_id,
        source_id=ref.source_id,
        kind=ref.kind.value,
        description=ref.description,
        source_wording=ref.source_wording,
        resolved=ref.resolved,
        resolution_note=ref.resolution_note,
    )
    session.add(row)
    session.flush()
    return row


def resolve_unresolved_reference(
    session: Session, reference_id: str, resolution_note: str
) -> bool:
    """Manually mark one UnresolvedReference resolved -- used when a live
    discovery pass (the academic-import skill) actually opened and checked
    something it had flagged, e.g. an EXTERNAL_REFERENCE_UNINSPECTED finding
    for a courseware link off the LMS's own domain. Unlike
    `_auto_resolve_missing_date_references`, this has no automatic trigger:
    "I looked and it turned out to be nothing" isn't inferrable from any
    other stored field, so it has to be an explicit call. Returns False if
    no such (unresolved) reference exists."""
    row = session.get(UnresolvedReferenceRow, reference_id)
    if row is None or row.resolved:
        return False
    row.resolved = True
    row.resolution_note = resolution_note
    session.flush()
    return True


def list_unresolved_references(
    session: Session, course_id: str | None = None, include_resolved: bool = False
) -> list[domain.UnresolvedReference]:
    stmt = select(UnresolvedReferenceRow)
    if course_id:
        stmt = stmt.where(UnresolvedReferenceRow.course_id == course_id)
    if not include_resolved:
        stmt = stmt.where(UnresolvedReferenceRow.resolved.is_(False))
    rows = session.execute(stmt).scalars().all()
    return [domain.UnresolvedReference.model_validate(r) for r in rows]


# --------------------------------------------------------------------------
# Chapter topics
# --------------------------------------------------------------------------

def find_chapter_topic(
    session: Session, course_id: str, chapter_label: str
) -> ChapterTopicRow | None:
    canonical = canonicalize_chapter_label(chapter_label)
    rows = session.execute(
        select(ChapterTopicRow).where(ChapterTopicRow.course_id == course_id)
    ).scalars().all()
    for row in rows:
        if canonicalize_chapter_label(row.chapter_label) == canonical:
            return row
    return None


def get_chapter_topic(
    session: Session, course_id: str, chapter_label: str
) -> domain.ChapterTopic | None:
    row = find_chapter_topic(session, course_id, chapter_label)
    return _chapter_topic_row_to_domain(row) if row else None


def upsert_chapter_topic(session: Session, topic: domain.ChapterTopic) -> ChapterTopicRow:
    """Insert or update-in-place by (course_id, canonicalize_chapter_label).
    This is reference data, not a syncable obligation -- no reconciliation/
    SyncRecord/fingerprint concepts apply (contrast upsert_academic_item)."""
    row = find_chapter_topic(session, topic.course_id, topic.chapter_label)
    now = datetime.now(UTC)
    if row is None:
        row = ChapterTopicRow(id=topic.id, course_id=topic.course_id, first_seen=now)
        session.add(row)

    row.chapter_label = topic.chapter_label
    # Every field follows the enrichment-preservation rule: a later pass
    # that only adds section headings or a reading link must not blank the
    # title/vocabulary/objectives an earlier pass saved (real incident
    # 2026-10-07: a sections-only call wiped four chapters' objectives).
    if topic.title or not row.title:
        row.title = topic.title
    if topic.vocabulary or not row.vocabulary:
        row.vocabulary = topic.vocabulary
    if topic.objectives or not row.objectives_json:
        row.objectives_json = topic.objectives
    row.is_exhaustive = topic.is_exhaustive or (not topic.objectives and bool(row.is_exhaustive))
    # Section headings / reading link are often captured in a separate pass
    # from objectives -- an incoming empty value never blanks a saved one
    # (same enrichment-preservation rule as upsert_academic_item).
    if topic.sections or not row.sections_json:
        row.sections_json = topic.sections
    if topic.reading_url or not row.reading_url:
        row.reading_url = topic.reading_url
    if topic.reading_label or not row.reading_label:
        row.reading_label = topic.reading_label
    if topic.added_vocabulary or not row.added_vocabulary:
        row.added_vocabulary = topic.added_vocabulary
    if topic.added_objectives or not row.added_objectives_json:
        row.added_objectives_json = topic.added_objectives
    row.source_ids_json = topic.source_ids
    row.source_wording = topic.source_wording
    row.last_seen = now
    session.flush()
    return row


def list_chapter_topics_for_course(session: Session, course_id: str) -> list[domain.ChapterTopic]:
    rows = session.execute(
        select(ChapterTopicRow).where(ChapterTopicRow.course_id == course_id)
    ).scalars().all()
    return [_chapter_topic_row_to_domain(r) for r in rows]


def _chapter_topic_row_to_domain(row: ChapterTopicRow) -> domain.ChapterTopic:
    data = domain.ChapterTopic.model_validate(row).model_dump()
    data["objectives"] = row.objectives_json or []
    data["sections"] = row.sections_json or []
    data["added_objectives"] = row.added_objectives_json or []
    data["source_ids"] = row.source_ids_json or []
    return domain.ChapterTopic.model_validate(data)


# --------------------------------------------------------------------------
# Preferences
# --------------------------------------------------------------------------

def set_preference(
    session: Session,
    *,
    key: str,
    value: object,
    category: str,
    scope: str = "global",
    course_id: str | None = None,
    source: str = "user_confirmed",
    confidence: float = 1.0,
) -> PreferenceRow:
    stmt = select(PreferenceRow).where(
        PreferenceRow.key == key,
        PreferenceRow.scope == scope,
        PreferenceRow.course_id == course_id,
    )
    row = session.execute(stmt).scalar_one_or_none()
    if row is None:
        row = PreferenceRow(key=key, scope=scope, course_id=course_id)
        session.add(row)
    row.value_json = value
    row.category = category
    row.source = source
    row.confidence = confidence
    row.active = True
    session.flush()
    return row


def get_preference(
    session: Session, key: str, course_id: str | None = None, default: object = None
) -> object:
    """Course-scoped preference wins over global if both exist."""
    if course_id:
        stmt = select(PreferenceRow).where(
            PreferenceRow.key == key,
            PreferenceRow.scope == "course",
            PreferenceRow.course_id == course_id,
            PreferenceRow.active.is_(True),
        )
        row = session.execute(stmt).scalar_one_or_none()
        if row is not None:
            return row.value_json
    stmt = select(PreferenceRow).where(
        PreferenceRow.key == key,
        PreferenceRow.scope == "global",
        PreferenceRow.active.is_(True),
    )
    row = session.execute(stmt).scalar_one_or_none()
    return row.value_json if row is not None else default


def _preference_row_to_domain(row: PreferenceRow) -> domain.Preference:
    return domain.Preference(
        id=row.id,
        key=row.key,
        value=row.value_json,
        category=PreferenceCategory(row.category),
        scope=PreferenceScope(row.scope),
        course_id=row.course_id,
        source=row.source,
        confidence=row.confidence,
        created_at=row.created_at,
        updated_at=row.updated_at,
        active=row.active,
    )


def list_preferences(session: Session, category: str | None = None) -> list[domain.Preference]:
    stmt = select(PreferenceRow).where(PreferenceRow.active.is_(True))
    if category:
        stmt = stmt.where(PreferenceRow.category == category)
    rows = session.execute(stmt).scalars().all()
    return [_preference_row_to_domain(r) for r in rows]


def unset_preference(session: Session, key: str, course_id: str | None = None) -> bool:
    scope = "course" if course_id else "global"
    stmt = select(PreferenceRow).where(
        PreferenceRow.key == key, PreferenceRow.scope == scope, PreferenceRow.course_id == course_id
    )
    row = session.execute(stmt).scalar_one_or_none()
    if row is None:
        return False
    row.active = False
    session.flush()
    return True


# --------------------------------------------------------------------------
# Sync records
# --------------------------------------------------------------------------

def get_sync_record(session: Session, academic_item_id: str) -> SyncRecordRow | None:
    return session.execute(
        select(SyncRecordRow).where(SyncRecordRow.academic_item_id == academic_item_id)
    ).scalar_one_or_none()


def upsert_sync_record(
    session: Session,
    *,
    academic_item_id: str,
    google_calendar_id: str | None = None,
    google_event_id: str | None = None,
    last_synced_fingerprint: str | None = None,
    last_synced_fields: dict[str, str | bool | None] | None = None,
    source_modified_at: datetime | None = None,
    status: SyncAction = SyncAction.REVIEW,
    mark_synced: bool = False,
) -> SyncRecordRow:
    row = get_sync_record(session, academic_item_id)
    if row is None:
        row = SyncRecordRow(academic_item_id=academic_item_id)
        session.add(row)
    if google_calendar_id is not None:
        row.google_calendar_id = google_calendar_id
    if google_event_id is not None:
        row.google_event_id = google_event_id
    if last_synced_fingerprint is not None:
        row.last_synced_fingerprint = last_synced_fingerprint
    if last_synced_fields is not None:
        row.last_synced_fields = last_synced_fields
    if source_modified_at is not None:
        row.source_modified_at = source_modified_at
    row.status = status.value
    if mark_synced:
        row.last_synced_at = datetime.now(UTC)
    session.flush()
    return row


# --------------------------------------------------------------------------
# Grade diagnostics
# --------------------------------------------------------------------------

def add_grade_snapshot(session: Session, snapshot: domain.GradeSnapshot) -> GradeSnapshotRow:
    """Insert or update-in-place by (course_id, title, week_start) -- a
    re-run of the same weekly crawl for an already-captured item updates
    its snapshot instead of creating a duplicate, same idempotency spirit
    as upsert_chapter_topic (invariant 5)."""
    stmt = select(GradeSnapshotRow).where(
        GradeSnapshotRow.course_id == snapshot.course_id,
        GradeSnapshotRow.title == snapshot.title,
        GradeSnapshotRow.week_start == snapshot.week_start,
    )
    row = session.execute(stmt).scalar_one_or_none()
    if row is None:
        row = GradeSnapshotRow(
            id=snapshot.id, course_id=snapshot.course_id, week_start=snapshot.week_start
        )
        session.add(row)

    row.academic_item_id = snapshot.academic_item_id
    row.title = snapshot.title
    row.captured_at = snapshot.captured_at
    row.score_percent = snapshot.score_percent
    row.is_missing = snapshot.is_missing
    row.instructor_feedback = snapshot.instructor_feedback
    row.source_type = snapshot.source_type.value
    session.flush()
    return row


def list_grade_snapshots_for_week(
    session: Session, course_id: str, week_start: date
) -> list[domain.GradeSnapshot]:
    rows = session.execute(
        select(GradeSnapshotRow).where(
            GradeSnapshotRow.course_id == course_id,
            GradeSnapshotRow.week_start == week_start,
        )
    ).scalars().all()
    return [domain.GradeSnapshot.model_validate(r) for r in rows]


def add_course_grade_snapshot(
    session: Session, snapshot: domain.CourseGradeSnapshot
) -> CourseGradeSnapshotRow:
    """Insert or update-in-place by (course_id, week_start)."""
    stmt = select(CourseGradeSnapshotRow).where(
        CourseGradeSnapshotRow.course_id == snapshot.course_id,
        CourseGradeSnapshotRow.week_start == snapshot.week_start,
    )
    row = session.execute(stmt).scalar_one_or_none()
    if row is None:
        row = CourseGradeSnapshotRow(
            id=snapshot.id, course_id=snapshot.course_id, week_start=snapshot.week_start
        )
        session.add(row)

    row.captured_at = snapshot.captured_at
    row.overall_percent = snapshot.overall_percent
    row.letter_grade = snapshot.letter_grade
    session.flush()
    return row


def get_course_grade_snapshot(
    session: Session, course_id: str, week_start: date
) -> domain.CourseGradeSnapshot | None:
    row = session.execute(
        select(CourseGradeSnapshotRow).where(
            CourseGradeSnapshotRow.course_id == course_id,
            CourseGradeSnapshotRow.week_start == week_start,
        )
    ).scalar_one_or_none()
    return domain.CourseGradeSnapshot.model_validate(row) if row else None


def get_previous_course_grade_snapshot(
    session: Session, course_id: str, before: date
) -> domain.CourseGradeSnapshot | None:
    """Most recent CourseGradeSnapshot strictly before `before` -- the
    week-over-week comparison basis for diagnostics.py::classify_course."""
    row = session.execute(
        select(CourseGradeSnapshotRow)
        .where(
            CourseGradeSnapshotRow.course_id == course_id,
            CourseGradeSnapshotRow.week_start < before,
        )
        .order_by(CourseGradeSnapshotRow.week_start.desc())
        .limit(1)
    ).scalar_one_or_none()
    return domain.CourseGradeSnapshot.model_validate(row) if row else None


def get_weekly_diagnostic_record(
    session: Session, course_id: str, week_start: date
) -> domain.WeeklyDiagnosticRecord | None:
    row = session.execute(
        select(WeeklyDiagnosticRecordRow).where(
            WeeklyDiagnosticRecordRow.course_id == course_id,
            WeeklyDiagnosticRecordRow.week_start == week_start,
        )
    ).scalar_one_or_none()
    return domain.WeeklyDiagnosticRecord.model_validate(row) if row else None


def upsert_weekly_diagnostic_record(
    session: Session,
    *,
    course_id: str,
    week_start: date,
    status: DiagnosticStatus,
    fingerprint: str,
    google_event_id: str | None = None,
    google_calendar_id: str | None = None,
) -> WeeklyDiagnosticRecordRow:
    row = session.execute(
        select(WeeklyDiagnosticRecordRow).where(
            WeeklyDiagnosticRecordRow.course_id == course_id,
            WeeklyDiagnosticRecordRow.week_start == week_start,
        )
    ).scalar_one_or_none()
    if row is None:
        row = WeeklyDiagnosticRecordRow(course_id=course_id, week_start=week_start)
        session.add(row)

    row.status = status.value
    row.fingerprint = fingerprint
    if google_event_id is not None:
        row.google_event_id = google_event_id
    if google_calendar_id is not None:
        row.google_calendar_id = google_calendar_id
    session.flush()
    return row


# --------------------------------------------------------------------------
# Audit log
# --------------------------------------------------------------------------

def log_audit_event(
    session: Session,
    *,
    event_type: str,
    summary: str,
    course_id: str | None = None,
    item_id: str | None = None,
    source_id: str | None = None,
    details: dict | None = None,
) -> AuditLogRow:
    row = AuditLogRow(
        event_type=event_type,
        summary=summary,
        course_id=course_id,
        item_id=item_id,
        source_id=source_id,
        details_json=details or {},
    )
    session.add(row)
    session.flush()
    return row


def list_audit_log(session: Session, limit: int = 100) -> list[domain.AuditLogEntry]:
    stmt = select(AuditLogRow).order_by(AuditLogRow.timestamp.desc()).limit(limit)
    rows = session.execute(stmt).scalars().all()
    out = []
    for r in rows:
        data = domain.AuditLogEntry.model_validate(r).model_dump()
        data["details"] = r.details_json or {}
        out.append(domain.AuditLogEntry.model_validate(data))
    return out


def get_course_grade_snapshot_on_or_before(
    session: Session, course_id: str, on_or_before: date
) -> domain.CourseGradeSnapshot | None:
    """Most recent CourseGradeSnapshot dated on or before `on_or_before` --
    the Daily Overview's "since last week" trend basis. Daily runs store one
    snapshot per capture date (the `week_start` column holds the capture
    date for those rows)."""
    row = session.execute(
        select(CourseGradeSnapshotRow)
        .where(
            CourseGradeSnapshotRow.course_id == course_id,
            CourseGradeSnapshotRow.week_start <= on_or_before,
        )
        .order_by(CourseGradeSnapshotRow.week_start.desc())
        .limit(1)
    ).scalar_one_or_none()
    return domain.CourseGradeSnapshot.model_validate(row) if row else None


# --------------------------------------------------------------------------
# Daily Overview: portal links, digest entries, daily records
# --------------------------------------------------------------------------

def upsert_portal_link(session: Session, link: domain.CoursePortalLink) -> CoursePortalLinkRow:
    """Insert or update-in-place by (course_id, kind, label)."""
    row = session.execute(
        select(CoursePortalLinkRow).where(
            CoursePortalLinkRow.course_id == link.course_id,
            CoursePortalLinkRow.kind == link.kind,
            CoursePortalLinkRow.label == link.label,
        )
    ).scalar_one_or_none()
    if row is None:
        row = CoursePortalLinkRow(
            id=link.id, course_id=link.course_id, kind=link.kind, label=link.label
        )
        session.add(row)
    row.url = link.url
    row.updated_at = datetime.now(UTC)
    session.flush()
    return row


def list_portal_links(session: Session, course_id: str) -> list[domain.CoursePortalLink]:
    rows = session.execute(
        select(CoursePortalLinkRow)
        .where(CoursePortalLinkRow.course_id == course_id)
        .order_by(CoursePortalLinkRow.kind, CoursePortalLinkRow.label)
    ).scalars().all()
    return [domain.CoursePortalLink.model_validate(r) for r in rows]


def _digest_row_to_domain(row: DigestEntryRow) -> domain.DigestEntry:
    data = domain.DigestEntry.model_validate(row).model_dump()
    data["payload"] = row.payload_json or {}
    return domain.DigestEntry.model_validate(data)


def count_digest_entries(session: Session, course_id: str) -> int:
    return len(session.execute(
        select(DigestEntryRow.id).where(DigestEntryRow.course_id == course_id)
    ).all())


def record_digest_entry(
    session: Session,
    *,
    course_id: str,
    kind: str,
    external_id: str,
    content_hash: str,
    payload: dict[str, object],
    already_reported_on: date | None = None,
    stable_hash: Callable[[str, dict[str, Any]], str | None] | None = None,
) -> str:
    """Record one observed announcement/grade/trigger. Returns "new",
    "updated" (same identity, different content -- e.g. a regraded score
    or new instructor feedback, which resurfaces it as pending), or
    "seen" (identical to what's stored; nothing changes).
    `already_reported_on` stores a brand-new entry as already emailed --
    used for the first-run baseline so years of old announcements don't
    flood the first email."""
    row = session.execute(
        select(DigestEntryRow).where(
            DigestEntryRow.course_id == course_id,
            DigestEntryRow.kind == kind,
            DigestEntryRow.external_id == external_id,
        )
    ).scalar_one_or_none()
    if row is None:
        session.add(DigestEntryRow(
            id=uuid.uuid4().hex, course_id=course_id, kind=kind, external_id=external_id,
            content_hash=content_hash, payload_json=dict(payload),
            emailed_on=already_reported_on,
        ))
        session.flush()
        return "new"
    if row.content_hash == content_hash:
        return "seen"
    # Same news, worded differently by a run (other highlights, a shortened comment): still "seen". The new hash is
    # kept, so the next identical crawl matches outright.
    if stable_hash is not None:
        was = stable_hash(kind, dict(row.payload_json or {}))
        if was is not None and was == stable_hash(kind, dict(payload)):
            row.content_hash = content_hash
            session.flush()
            return "seen"
    row.content_hash = content_hash
    row.payload_json = {**payload, "is_update": True}
    row.emailed_on = None
    session.flush()
    return "updated"


def list_pending_digest_entries(session: Session, course_id: str) -> list[domain.DigestEntry]:
    rows = session.execute(
        select(DigestEntryRow)
        .where(DigestEntryRow.course_id == course_id, DigestEntryRow.emailed_on.is_(None))
        .order_by(DigestEntryRow.first_seen)
    ).scalars().all()
    return [_digest_row_to_domain(r) for r in rows]


def mark_digest_entries_emailed(session: Session, course_id: str, on: date) -> int:
    result = session.execute(
        update(DigestEntryRow)
        .where(DigestEntryRow.course_id == course_id, DigestEntryRow.emailed_on.is_(None))
        .values(emailed_on=on)
    )
    session.flush()
    return int(getattr(result, "rowcount", 0) or 0)


def get_daily_digest_record(
    session: Session, course_id: str, digest_date: date
) -> domain.DailyDigestRecord | None:
    row = session.execute(
        select(DailyDigestRecordRow).where(
            DailyDigestRecordRow.course_id == course_id,
            DailyDigestRecordRow.digest_date == digest_date,
        )
    ).scalar_one_or_none()
    if row is None:
        return None
    data = domain.DailyDigestRecord.model_validate(row).model_dump()
    data["crawl"] = row.crawl_json or {}
    return domain.DailyDigestRecord.model_validate(data)


def upsert_daily_digest_record(
    session: Session,
    *,
    course_id: str,
    digest_date: date,
    gmail_message_id: str | None = None,
    skipped: bool = False,
    crawl: dict[str, object] | None = None,
) -> DailyDigestRecordRow:
    row = session.execute(
        select(DailyDigestRecordRow).where(
            DailyDigestRecordRow.course_id == course_id,
            DailyDigestRecordRow.digest_date == digest_date,
        )
    ).scalar_one_or_none()
    if row is None:
        row = DailyDigestRecordRow(
            id=uuid.uuid4().hex, course_id=course_id, digest_date=digest_date
        )
        session.add(row)
    if crawl is not None:
        row.crawl_json = dict(crawl)
    if gmail_message_id is not None:
        row.gmail_message_id = gmail_message_id
    row.skipped = (skipped or bool(row.skipped)) and row.gmail_message_id is None
    session.flush()
    return row
