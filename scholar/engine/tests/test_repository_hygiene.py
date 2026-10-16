from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta

from academic_sync.db import repository
from academic_sync.models.domain import (
    AcademicItem,
    ChapterTopic,
    Source,
    UnresolvedReference,
    WeeklyLink,
)
from academic_sync.models.enums import ItemStatus, ItemType, SourceType, UnresolvedReferenceKind
from academic_sync.reconciliation.fingerprint import compute_fingerprint


def test_missing_date_reference_auto_resolves_once_item_gets_a_date(session, make_course):
    course = make_course()
    fp = compute_fingerprint(course.id, "quiz", "Online Quiz 1")

    ref = UnresolvedReference(
        id=uuid.uuid4().hex,
        course_id=course.id,
        kind=UnresolvedReferenceKind.MISSING_DATE,
        description="Quiz is known to exist but has no confirmed date.",
        source_wording="Online Quiz 1",
        resolved=False,
    )
    repository.add_unresolved_reference(session, ref)
    assert len(repository.list_unresolved_references(session, course.id)) == 1

    # A later (or fixed) extraction pass now finds the date.
    dated_item = AcademicItem(
        id=uuid.uuid4().hex,
        course_id=course.id,
        item_type=ItemType.QUIZ,
        title="Online Quiz 1",
        date=date(2026, 8, 30),
        status=ItemStatus.CLEAR,
        fingerprint=fp,
    )
    repository.upsert_academic_item(session, dated_item)

    assert repository.list_unresolved_references(session, course.id) == []
    resolved = repository.list_unresolved_references(session, course.id, include_resolved=True)
    assert len(resolved) == 1
    assert resolved[0].resolved is True


def test_missing_date_reference_for_different_title_is_untouched(session, make_course):
    course = make_course()
    fp = compute_fingerprint(course.id, "quiz", "Online Quiz 2")

    ref = UnresolvedReference(
        id=uuid.uuid4().hex,
        course_id=course.id,
        kind=UnresolvedReferenceKind.MISSING_DATE,
        description="Quiz is known to exist but has no confirmed date.",
        source_wording="Online Quiz 2",
        resolved=False,
    )
    repository.add_unresolved_reference(session, ref)

    dated_item = AcademicItem(
        id=uuid.uuid4().hex,
        course_id=course.id,
        item_type=ItemType.QUIZ,
        title="Online Quiz 1",
        date=date(2026, 8, 30),
        status=ItemStatus.CLEAR,
        fingerprint=fp,
    )
    repository.upsert_academic_item(session, dated_item)

    assert len(repository.list_unresolved_references(session, course.id)) == 1


def test_needs_link_recheck_only_includes_recently_opened_and_still_unlinked(session, make_course):
    course = make_course()
    today = date.today()

    def _item(title: str, link_available_date, reference_url=None):
        return AcademicItem(
            id=uuid.uuid4().hex,
            course_id=course.id,
            item_type=ItemType.OTHER_DEADLINE,
            title=title,
            date=date(2026, 9, 12),
            status=ItemStatus.UNRESOLVED,
            fingerprint=compute_fingerprint(course.id, "other_deadline", title),
            link_available_date=link_available_date,
            reference_url=reference_url,
        )

    # Opened 2 days ago, still no link -- should surface (lookback).
    recently_opened = _item("Lab Kit Auth", today - timedelta(days=2))
    # Opened 2 months ago and never revisited -- outside the lookback window,
    # should NOT resurface forever.
    stale = _item("Old Locked Item", today - timedelta(days=60))
    # Opened yesterday but already has a real link -- already handled.
    already_linked = _item(
        "Getting Started", today - timedelta(days=1),
        reference_url="https://d2l.example.edu/d2l/le/content/1/View",
    )
    # Officially opens in 5 days, but D2L's stated date can be conservative
    # -- worth checking a bit early (lookahead), not waiting until the
    # exact date passes.
    opening_soon = _item("Getting Started Redo", today + timedelta(days=5))
    # Opens in 2 months -- far too early to bother checking yet.
    far_future = _item("Final Project Kickoff", today + timedelta(days=60))

    for item in (recently_opened, stale, already_linked, opening_soon, far_future):
        repository.upsert_academic_item(session, item)

    candidates = repository.list_items_needing_link_recheck(
        session, course.id, lookback_days=14, lookahead_days=14
    )
    titles = {c.title for c in candidates}
    assert titles == {"Lab Kit Auth", "Getting Started Redo"}


def test_upsert_does_not_silently_downgrade_confirmed_date_to_none(session, make_course):
    # Real incident, 2026-08-19: two MAT1340 assignments had genuine,
    # already-synced Calendar events with correct due dates, but a later
    # re-extraction of the same source (missing --allow-bare-dates) matched
    # the same fingerprint (date is deliberately not part of item identity)
    # and found no date this time -- upsert_academic_item silently
    # overwrote date=None, status=UNRESOLVED onto an already-CLEAR row,
    # even though the live Calendar event still had the real date. The
    # local database silently became less correct than reality.
    course = make_course()
    title = "HW 2.2 & 7.1"
    fp = compute_fingerprint(course.id, "assignment", title)

    confirmed = AcademicItem(
        id=uuid.uuid4().hex, course_id=course.id, item_type=ItemType.ASSIGNMENT,
        title=title, date=date(2026, 11, 11), status=ItemStatus.CLEAR, fingerprint=fp,
    )
    repository.upsert_academic_item(session, confirmed)

    # A worse re-extraction of "the same" logical item (same fingerprint)
    # that failed to find a date this time.
    regressed = AcademicItem(
        id=uuid.uuid4().hex, course_id=course.id, item_type=ItemType.ASSIGNMENT,
        title=title, date=None, status=ItemStatus.UNRESOLVED, fingerprint=fp,
    )
    repository.upsert_academic_item(session, regressed)

    stored = repository.get_academic_item(session, confirmed.id)
    assert stored.date == date(2026, 11, 11)
    assert stored.status == ItemStatus.CLEAR

    refs = repository.list_unresolved_references(session, course.id)
    assert any(r.kind == UnresolvedReferenceKind.CONFLICTING_SOURCES for r in refs)


def test_upsert_allows_deliberate_downgrade_when_explicitly_requested(session, make_course):
    course = make_course()
    title = "HW 9.9"
    fp = compute_fingerprint(course.id, "assignment", title)

    confirmed = AcademicItem(
        id=uuid.uuid4().hex, course_id=course.id, item_type=ItemType.ASSIGNMENT,
        title=title, date=date(2026, 11, 11), status=ItemStatus.CLEAR, fingerprint=fp,
    )
    repository.upsert_academic_item(session, confirmed)

    corrected = AcademicItem(
        id=uuid.uuid4().hex, course_id=course.id, item_type=ItemType.ASSIGNMENT,
        title=title, date=None, status=ItemStatus.UNRESOLVED, fingerprint=fp,
    )
    repository.upsert_academic_item(session, corrected, allow_downgrade=True)

    stored = repository.get_academic_item(session, confirmed.id)
    assert stored.date is None
    assert stored.status == ItemStatus.UNRESOLVED


def test_upsert_does_not_silently_erase_enrichment_fields(session, make_course):
    # Real incident, 2026-08-19: re-extracting a MAT1340 calendar source
    # that had already been manually enriched (topic-name titles,
    # module_label, reference_url applied via `render --save`) silently
    # blanked out module_label/reference_url on 23 already-enriched items,
    # because the raw re-extraction doesn't know about enrichment applied
    # outside the extraction pipeline and unconditionally overwrote these
    # fields with the unenriched (blank) extracted value.
    course = make_course()
    title = "HW: 1.4"
    fp = compute_fingerprint(course.id, "assignment", title)

    enriched = AcademicItem(
        id=uuid.uuid4().hex, course_id=course.id, item_type=ItemType.ASSIGNMENT,
        title=title, date=date(2026, 8, 20), status=ItemStatus.CLEAR, fingerprint=fp,
        module_label="Chapter 1: Prerequisite Review Topics (8/17 - 8/30)",
        reference_url="https://d2l.example.edu/d2l/le/content/1/View",
        reference_url_label="D2L (1.4 Quadratic Equations)", points=10,
    )
    repository.upsert_academic_item(session, enriched)

    # A raw re-extraction of the same logical item that never carried
    # module/link/points info in the first place.
    raw_reextraction = AcademicItem(
        id=uuid.uuid4().hex, course_id=course.id, item_type=ItemType.ASSIGNMENT,
        title=title, date=date(2026, 8, 20), status=ItemStatus.CLEAR, fingerprint=fp,
    )
    repository.upsert_academic_item(session, raw_reextraction)

    stored = repository.get_academic_item(session, enriched.id)
    assert stored.module_label == "Chapter 1: Prerequisite Review Topics (8/17 - 8/30)"
    assert stored.reference_url == "https://d2l.example.edu/d2l/le/content/1/View"
    assert stored.reference_url_label == "D2L (1.4 Quadratic Equations)"
    assert stored.points == 10


def test_upsert_does_not_silently_erase_link_available_date(session, make_course):
    # Same family as the enrichment-fields test above: link_available_date
    # is written out-of-band by `render --link-available-date` (never by
    # the extraction pipeline itself, see cli.py's render_cmd), so it must
    # follow the same never-let-a-falsy-incoming-value-clear-a-real-value
    # rule as module_label/reference_url -- otherwise a later raw
    # re-extraction of the same source silently erases it.
    course = make_course()
    title = "Lab Kit Auth"
    fp = compute_fingerprint(course.id, "other_deadline", title)

    enriched = AcademicItem(
        id=uuid.uuid4().hex, course_id=course.id, item_type=ItemType.OTHER_DEADLINE,
        title=title, date=date(2026, 9, 12), status=ItemStatus.UNRESOLVED, fingerprint=fp,
        link_available_date=date(2026, 9, 1),
    )
    repository.upsert_academic_item(session, enriched)

    raw_reextraction = AcademicItem(
        id=uuid.uuid4().hex, course_id=course.id, item_type=ItemType.OTHER_DEADLINE,
        title=title, date=date(2026, 9, 12), status=ItemStatus.UNRESOLVED, fingerprint=fp,
    )
    repository.upsert_academic_item(session, raw_reextraction)

    stored = repository.get_academic_item(session, enriched.id)
    assert stored.link_available_date == date(2026, 9, 1)


def test_upsert_preserves_inferred_date_flag_on_raw_reextraction(session, make_course):
    # Same enrichment-preservation family: is_inferred_date/date_inference_rule
    # are set out-of-band by `render --inferred-date --save` (see CLAUDE.md
    # invariant 29), never by the extraction pipeline itself -- a raw
    # re-extraction that found the same date again must not silently drop
    # the inferred-date flag/rule.
    course = make_course()
    title = "HW: 4.1"
    fp = compute_fingerprint(course.id, "assignment", title)

    inferred = AcademicItem(
        id=uuid.uuid4().hex, course_id=course.id, item_type=ItemType.ASSIGNMENT,
        title=title, date=date(2026, 10, 7), status=ItemStatus.CLEAR, fingerprint=fp,
        is_inferred_date=True, date_inference_rule="every HW due 3 days after the prior one",
    )
    repository.upsert_academic_item(session, inferred)

    raw_reextraction = AcademicItem(
        id=uuid.uuid4().hex, course_id=course.id, item_type=ItemType.ASSIGNMENT,
        title=title, date=date(2026, 10, 7), status=ItemStatus.CLEAR, fingerprint=fp,
    )
    repository.upsert_academic_item(session, raw_reextraction)

    stored = repository.get_academic_item(session, inferred.id)
    assert stored.is_inferred_date is True
    assert stored.date_inference_rule == "every HW due 3 days after the prior one"


def test_upsert_clears_inferred_date_flag_when_a_real_different_date_arrives(session, make_course):
    # A genuinely different date supersedes an earlier pattern-rule
    # inference -- the "(Inferred Date)" tag must not keep showing once a
    # real, literally-sourced correction lands on the same item. See
    # CLAUDE.md invariant 29 and sync/calendar_payload.py::_inferred_date_tag.
    course = make_course()
    title = "HW: 4.1"
    fp = compute_fingerprint(course.id, "assignment", title)

    inferred = AcademicItem(
        id=uuid.uuid4().hex, course_id=course.id, item_type=ItemType.ASSIGNMENT,
        title=title, date=date(2026, 10, 7), status=ItemStatus.CLEAR, fingerprint=fp,
        is_inferred_date=True, date_inference_rule="every HW due 3 days after the prior one",
    )
    repository.upsert_academic_item(session, inferred)

    real_correction = AcademicItem(
        id=uuid.uuid4().hex, course_id=course.id, item_type=ItemType.ASSIGNMENT,
        title=title, date=date(2026, 10, 9), status=ItemStatus.CLEAR, fingerprint=fp,
    )
    repository.upsert_academic_item(session, real_correction)

    stored = repository.get_academic_item(session, inferred.id)
    assert stored.date == date(2026, 10, 9)
    assert stored.is_inferred_date is False
    assert stored.date_inference_rule is None


def test_upsert_does_not_silently_erase_date_range_end(session, make_course):
    # Same family as the two tests above, for the WEEKLY_READING-only
    # date_range_end field added alongside it (CLAUDE.md invariant 25) --
    # must be listed in upsert_academic_item's enrichment-preservation loop
    # or a later re-run with no incoming value silently blanks it.
    course = make_course()
    fp = compute_fingerprint(
        course.id, "weekly_reading", "Readings", disambiguator="2026-09-07",
    )

    enriched = AcademicItem(
        id=uuid.uuid4().hex, course_id=course.id, item_type=ItemType.WEEKLY_READING,
        title="Chapter 5: Cell Division", date=date(2026, 9, 7),
        date_range_end=date(2026, 9, 13), status=ItemStatus.CLEAR, fingerprint=fp,
    )
    repository.upsert_academic_item(session, enriched)

    raw_rewrite = AcademicItem(
        id=uuid.uuid4().hex, course_id=course.id, item_type=ItemType.WEEKLY_READING,
        title="Chapter 5: Cell Division", date=date(2026, 9, 7),
        status=ItemStatus.CLEAR, fingerprint=fp,
    )
    repository.upsert_academic_item(session, raw_rewrite)

    stored = repository.get_academic_item(session, enriched.id)
    assert stored.date_range_end == date(2026, 9, 13)


def test_upsert_round_trips_and_preserves_weekly_links(session, make_course):
    # weekly_links (WEEKLY_READING-only, CLAUDE.md invariant 25) is set
    # out-of-band via `render --links --save` / `weekly-reading-add
    # --links`, never by extraction -- so it must round-trip through the
    # ORM's separate weekly_links_json column AND survive a later raw
    # re-run that carries no links, same rule as date_range_end above.
    course = make_course()
    fp = compute_fingerprint(
        course.id, "weekly_reading", "Readings", disambiguator="2026-08-24",
    )
    enriched = AcademicItem(
        id=uuid.uuid4().hex, course_id=course.id, item_type=ItemType.WEEKLY_READING,
        title="Chapter 23: Evolution of Populations", date=date(2026, 8, 24),
        date_range_end=date(2026, 8, 30), status=ItemStatus.CLEAR, fingerprint=fp,
        weekly_links=[
            WeeklyLink(label="Lecture video - Ch 23", url="https://video.example/w2"),
            WeeklyLink(label="Textbook - Ch 23", url="https://textbook.example/ch23"),
        ],
    )
    repository.upsert_academic_item(session, enriched)

    stored = repository.get_academic_item(session, enriched.id)
    assert [(link.label, link.url) for link in stored.weekly_links] == [
        ("Lecture video - Ch 23", "https://video.example/w2"),
        ("Textbook - Ch 23", "https://textbook.example/ch23"),
    ]

    raw_rewrite = AcademicItem(
        id=uuid.uuid4().hex, course_id=course.id, item_type=ItemType.WEEKLY_READING,
        title="Chapter 23: Evolution of Populations", date=date(2026, 8, 24),
        date_range_end=date(2026, 8, 30), status=ItemStatus.CLEAR, fingerprint=fp,
    )
    repository.upsert_academic_item(session, raw_rewrite)

    still_stored = repository.get_academic_item(session, enriched.id)
    assert len(still_stored.weekly_links) == 2


def test_weekly_links_change_is_detected_as_update_after_sync(session, make_course):
    # A banner enriched with weekly_links AFTER its first sync must be
    # caught as UPDATE, not UNCHANGED -- same drift class as reference_url
    # (CLAUDE.md invariant 5 amendment). Exercises weekly_links being in
    # _COMPARED_FIELDS and snapshot_compared_fields' string encoding.
    from academic_sync.models.domain import SyncRecord
    from academic_sync.models.enums import SyncAction
    from academic_sync.reconciliation.engine import (
        decide_action,
        snapshot_compared_fields,
    )

    course = make_course()
    fp = compute_fingerprint(
        course.id, "weekly_reading", "Readings", disambiguator="2026-08-24",
    )
    synced = AcademicItem(
        id=uuid.uuid4().hex, course_id=course.id, item_type=ItemType.WEEKLY_READING,
        title="Chapter 23: Evolution of Populations", date=date(2026, 8, 24),
        date_range_end=date(2026, 8, 30), status=ItemStatus.SYNCED, fingerprint=fp,
    )
    record = SyncRecord(
        id=uuid.uuid4().hex, academic_item_id=synced.id, google_event_id="evt1",
        google_calendar_id="cal1", last_synced_fields=snapshot_compared_fields(synced),
    )

    enriched = synced.model_copy(update={
        "weekly_links": [WeeklyLink(label="Lecture video", url="https://video.example/w2")],
    })
    entry = decide_action(enriched, synced, record)
    assert entry.action == SyncAction.UPDATE
    assert "weekly_links" in entry.reason


def test_weekly_reading_add_is_idempotent_by_course_and_week_start(session, make_course):
    # Re-deriving the same week (same course, same week-start disambiguator)
    # must UPDATE/UNCHANGED the same row, never CREATE a duplicate -- the
    # same idempotency discipline CLAUDE.md invariant 5 requires of every
    # item path.
    from academic_sync.reconciliation.engine import decide_action

    course = make_course()
    fp = compute_fingerprint(
        course.id, "weekly_reading", "Readings", disambiguator="2026-09-07",
    )
    first = AcademicItem(
        id=uuid.uuid4().hex, course_id=course.id, item_type=ItemType.WEEKLY_READING,
        title="Chapter 5: Cell Division", date=date(2026, 9, 7),
        date_range_end=date(2026, 9, 13), status=ItemStatus.CLEAR, fingerprint=fp,
        is_derived=True, derivation_rule="weekly_reading_aggregation",
    )
    repository.upsert_academic_item(session, first)

    identical_rerun = AcademicItem(
        id=uuid.uuid4().hex, course_id=course.id, item_type=ItemType.WEEKLY_READING,
        title="Chapter 5: Cell Division", date=date(2026, 9, 7),
        date_range_end=date(2026, 9, 13), status=ItemStatus.CLEAR, fingerprint=fp,
        is_derived=True, derivation_rule="weekly_reading_aggregation",
    )
    existing_row = repository.find_item_by_fingerprint(session, course.id, fp)
    existing = repository.get_academic_item(session, existing_row.id)
    entry = decide_action(identical_rerun, existing, sync_record=None)
    # Not synced yet (no sync_record) -- CREATE is correct here; a second,
    # truly-unchanged pass after a sync_record exists is what UNCHANGED
    # covers (see test_reconciliation.py for that general-purpose case).
    assert entry.action.value == "CREATE"

    changed_week_end = AcademicItem(
        id=uuid.uuid4().hex, course_id=course.id, item_type=ItemType.WEEKLY_READING,
        title="Chapter 5: Cell Division", date=date(2026, 9, 7),
        date_range_end=date(2026, 9, 14), status=ItemStatus.CLEAR, fingerprint=fp,
    )
    entry = decide_action(changed_week_end, existing, sync_record=None)
    assert entry.action.value == "CREATE"
    repository.upsert_academic_item(session, changed_week_end)

    all_items = repository.list_items_for_course(session, course.id)
    assert len(all_items) == 1
    assert all_items[0].date_range_end == date(2026, 9, 14)


def test_upsert_does_not_silently_regress_synced_status_to_clear(session, make_course):
    # Third related incident, same root cause: a raw re-extraction always
    # computes status from what it found this pass (never SYNCED -- only
    # record-sync legitimately sets that), so re-extracting an
    # already-synced item silently regressed its status back to CLEAR,
    # corrupting `academic-sync status`'s reporting even though the real
    # duplicate-prevention signal (SyncRecord) was untouched.
    course = make_course()
    title = "HW: 1.4"
    fp = compute_fingerprint(course.id, "assignment", title)

    item = AcademicItem(
        id=uuid.uuid4().hex, course_id=course.id, item_type=ItemType.ASSIGNMENT,
        title=title, date=date(2026, 8, 20), status=ItemStatus.CLEAR, fingerprint=fp,
    )
    repository.upsert_academic_item(session, item)
    stored = repository.get_academic_item(session, item.id)
    stored.status = ItemStatus.SYNCED
    repository.upsert_academic_item(session, stored)

    reextracted = AcademicItem(
        id=uuid.uuid4().hex, course_id=course.id, item_type=ItemType.ASSIGNMENT,
        title=title, date=date(2026, 8, 20), status=ItemStatus.CLEAR, fingerprint=fp,
    )
    repository.upsert_academic_item(session, reextracted)

    assert repository.get_academic_item(session, item.id).status == ItemStatus.SYNCED


def test_upsert_still_applies_a_real_enrichment_update(session, make_course):
    # The guard above must not freeze enrichment fields forever -- a
    # genuine new/different value should still apply normally.
    course = make_course()
    title = "HW: 1.4"
    fp = compute_fingerprint(course.id, "assignment", title)

    first = AcademicItem(
        id=uuid.uuid4().hex, course_id=course.id, item_type=ItemType.ASSIGNMENT,
        title=title, date=date(2026, 8, 20), status=ItemStatus.CLEAR, fingerprint=fp,
        module_label="Old Module", points=5,
    )
    repository.upsert_academic_item(session, first)

    updated = AcademicItem(
        id=uuid.uuid4().hex, course_id=course.id, item_type=ItemType.ASSIGNMENT,
        title=title, date=date(2026, 8, 20), status=ItemStatus.CLEAR, fingerprint=fp,
        module_label="New Module", points=10,
    )
    repository.upsert_academic_item(session, updated)

    stored = repository.get_academic_item(session, first.id)
    assert stored.module_label == "New Module"
    assert stored.points == 10


def test_unresolved_resolve_marks_it_resolved_with_note(session, make_course):
    course = make_course()
    ref = UnresolvedReference(
        id=uuid.uuid4().hex, course_id=course.id,
        kind=UnresolvedReferenceKind.EXTERNAL_REFERENCE_UNINSPECTED,
        description="Course shell links to ALEKS; not yet opened.",
        source_wording="ALEKS", resolved=False,
    )
    repository.add_unresolved_reference(session, ref)

    ok = repository.resolve_unresolved_reference(session, ref.id, "Opened it, crawled it.")
    assert ok is True

    resolved = repository.list_unresolved_references(session, course.id, include_resolved=True)
    assert resolved[0].resolved is True
    assert resolved[0].resolution_note == "Opened it, crawled it."


def test_unresolved_resolve_returns_false_for_unknown_id(session):
    assert repository.resolve_unresolved_reference(session, "no-such-id", "note") is False


def test_unresolved_resolve_returns_false_if_already_resolved(session, make_course):
    course = make_course()
    ref = UnresolvedReference(
        id=uuid.uuid4().hex, course_id=course.id,
        kind=UnresolvedReferenceKind.EXTERNAL_REFERENCE_UNINSPECTED,
        description="x", source_wording="ALEKS", resolved=False,
    )
    repository.add_unresolved_reference(session, ref)
    assert repository.resolve_unresolved_reference(session, ref.id, "first") is True
    assert repository.resolve_unresolved_reference(session, ref.id, "second") is False


def test_external_reference_auto_resolves_when_matching_source_is_added(session, make_course):
    # Live discovery flagged a shell link off the LMS's own domain (recorded
    # via `unresolved-add`, no name list involved) before it had actually
    # been opened. Once it IS opened and recorded as a real Source with a
    # matching title, the finding should clear itself -- no separate
    # "resolve" step for a session to remember.
    course = make_course()
    ref = UnresolvedReference(
        id=uuid.uuid4().hex, course_id=course.id,
        kind=UnresolvedReferenceKind.EXTERNAL_REFERENCE_UNINSPECTED,
        description="Course shell links to ALEKS; not yet opened.",
        source_wording="ALEKS", resolved=False,
    )
    repository.add_unresolved_reference(session, ref)
    assert len(repository.list_unresolved_references(session, course.id)) == 1

    source = Source(
        id=uuid.uuid4().hex, course_id=course.id, source_type=SourceType.EXTERNAL_COURSEWARE,
        title="ALEKS", content_hash="h1", parser_version="1", retrieved_at=datetime(2026, 8, 21),
    )
    repository.add_source(session, source)

    assert repository.list_unresolved_references(session, course.id) == []
    resolved = repository.list_unresolved_references(session, course.id, include_resolved=True)
    assert resolved[0].resolved is True
    assert "ALEKS" in resolved[0].resolution_note


def test_external_reference_untouched_by_unrelated_source(session, make_course):
    course = make_course()
    ref = UnresolvedReference(
        id=uuid.uuid4().hex, course_id=course.id,
        kind=UnresolvedReferenceKind.EXTERNAL_REFERENCE_UNINSPECTED,
        description="Course shell links to ALEKS; not yet opened.",
        source_wording="ALEKS", resolved=False,
    )
    repository.add_unresolved_reference(session, ref)

    unrelated = Source(
        id=uuid.uuid4().hex, course_id=course.id, source_type=SourceType.D2L_CONTENT,
        title="Course Information", content_hash="h2", parser_version="1",
        retrieved_at=datetime(2026, 8, 21),
    )
    repository.add_source(session, unrelated)

    assert len(repository.list_unresolved_references(session, course.id)) == 1


def test_upsert_chapter_topic_is_idempotent_by_course_and_canonical_label(session, make_course):
    course = make_course()
    first = ChapterTopic(
        id=uuid.uuid4().hex, course_id=course.id, chapter_label="Chapter 23",
        title="Evolution of Populations", vocabulary="microevolution, genetic drift",
        objectives=["Explain X"],
    )
    repository.upsert_chapter_topic(session, first)

    # Re-running with a differently-cased/spaced label (real-world: typed
    # slightly differently on a later scan) must update the same row, not
    # create a second one.
    second = ChapterTopic(
        id=uuid.uuid4().hex, course_id=course.id, chapter_label="chapter  23",
        title="Evolution of Populations", vocabulary="microevolution, genetic drift",
        objectives=["Explain X", "Distinguish Y"],
    )
    repository.upsert_chapter_topic(session, second)

    all_topics = repository.list_chapter_topics_for_course(session, course.id)
    assert len(all_topics) == 1
    assert all_topics[0].objectives == ["Explain X", "Distinguish Y"]


def test_get_chapter_topic_returns_none_when_not_saved(session, make_course):
    course = make_course()
    assert repository.get_chapter_topic(session, course.id, "Chapter 99") is None


def test_get_chapter_topic_round_trips_objectives_and_source_ids(session, make_course):
    course = make_course()
    topic = ChapterTopic(
        id=uuid.uuid4().hex, course_id=course.id, chapter_label="Chapter 5",
        objectives=["A", "B", "C"], source_ids=["src1", "src2"],
    )
    repository.upsert_chapter_topic(session, topic)

    fetched = repository.get_chapter_topic(session, course.id, "Chapter 5")
    assert fetched is not None
    assert fetched.objectives == ["A", "B", "C"]
    assert fetched.source_ids == ["src1", "src2"]


def test_chapter_topic_is_exhaustive_defaults_false_and_round_trips_true(session, make_course):
    course = make_course()
    default_topic = ChapterTopic(
        id=uuid.uuid4().hex, course_id=course.id, chapter_label="Chapter 6", objectives=["A"],
    )
    repository.upsert_chapter_topic(session, default_topic)
    fetched_default = repository.get_chapter_topic(session, course.id, "Chapter 6")
    assert fetched_default is not None
    assert fetched_default.is_exhaustive is False

    confirmed_topic = ChapterTopic(
        id=uuid.uuid4().hex, course_id=course.id, chapter_label="Chapter 7",
        objectives=["A"], is_exhaustive=True,
    )
    repository.upsert_chapter_topic(session, confirmed_topic)
    fetched_confirmed = repository.get_chapter_topic(session, course.id, "Chapter 7")
    assert fetched_confirmed is not None
    assert fetched_confirmed.is_exhaustive is True


def test_upsert_course_persists_is_synthetic_flag(session, make_course):
    # Real incident-shaped bug, 2026-08-27: upsert_course assigns
    # CourseRow fields explicitly field-by-field, the same pattern
    # upsert_academic_item is already warned about in CLAUDE.md -- adding
    # a new Course field and forgetting to add it to that assignment list
    # silently drops it on every write, no error raised. This guards the
    # is_synthetic field added for the custom-curriculum skill (CLAUDE.md
    # invariant 35) the same way test_chapter_topic_is_exhaustive_defaults_
    # false_and_round_trips_true guards ChapterTopic.is_exhaustive above.
    default_course = make_course(code="REAL101")
    fetched_default = repository.get_course(session, default_course.id)
    assert fetched_default is not None
    assert fetched_default.is_synthetic is False

    synthetic_course = make_course(code="Linear Algebra Fundamentals", is_synthetic=True)
    fetched_synthetic = repository.get_course(session, synthetic_course.id)
    assert fetched_synthetic is not None
    assert fetched_synthetic.is_synthetic is True


def test_upsert_round_trips_and_preserves_study_depth_fields(session, make_course):
    # CLAUDE.md invariant 40's new item fields are set out-of-band by
    # `render --save`, so they must round-trip and survive a raw re-run.
    course = make_course()
    fp = compute_fingerprint(course.id, "exam", "Exam 2")
    enriched = AcademicItem(
        id=uuid.uuid4().hex, course_id=course.id, item_type=ItemType.EXAM, title="Exam 2",
        date=date(2026, 10, 20), status=ItemStatus.CLEAR, fingerprint=fp,
        covered_chapters=["Chapter 5", "Chapter 6"], study_focus=["Boyle's law"],
        video_url="https://v.example/1", video_url_label="Video",
    )
    repository.upsert_academic_item(session, enriched)
    raw = AcademicItem(
        id=uuid.uuid4().hex, course_id=course.id, item_type=ItemType.EXAM, title="Exam 2",
        date=date(2026, 10, 20), status=ItemStatus.CLEAR, fingerprint=fp,
    )
    repository.upsert_academic_item(session, raw)
    stored = repository.get_academic_item(session, enriched.id)
    assert stored.covered_chapters == ["Chapter 5", "Chapter 6"]
    assert stored.study_focus == ["Boyle's law"]
    assert stored.video_url == "https://v.example/1"
    assert stored.video_url_label == "Video"


def test_upsert_chapter_topic_round_trips_and_preserves_added_content(session, make_course):
    course = make_course()
    repository.upsert_chapter_topic(session, ChapterTopic(
        id=uuid.uuid4().hex, course_id=course.id, chapter_label="Chapter 6",
        added_vocabulary="colligative property", added_objectives=["Explain osmosis"],
    ))
    repository.upsert_chapter_topic(session, ChapterTopic(
        id=uuid.uuid4().hex, course_id=course.id, chapter_label="Chapter 6",
        objectives=["Define a solution"],
    ))
    stored = repository.get_chapter_topic(session, course.id, "Chapter 6")
    assert stored.added_vocabulary == "colligative property"
    assert stored.added_objectives == ["Explain osmosis"]
    assert stored.objectives == ["Define a solution"]
