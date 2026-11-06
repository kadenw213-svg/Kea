from __future__ import annotations

import uuid
from datetime import date, time

from academic_sync.db import repository
from academic_sync.models.domain import AcademicItem
from academic_sync.models.enums import ItemStatus, ItemType, SyncAction
from academic_sync.reconciliation.engine import decide_action, snapshot_compared_fields
from academic_sync.reconciliation.fingerprint import compute_fingerprint
from academic_sync.sync.planner import compute_plan


def _quiz_item(course_id: str, due_date: date, fp: str, title: str = "Online Quiz 4") -> AcademicItem:
    return AcademicItem(
        id=uuid.uuid4().hex,
        course_id=course_id,
        item_type=ItemType.QUIZ,
        title=title,
        date=due_date,
        due_time=time(23, 59),
        status=ItemStatus.CLEAR,
        fingerprint=fp,
    )


def test_no_existing_item_is_create():
    fp = compute_fingerprint("c1", "quiz", "Quiz 4")
    incoming = _quiz_item("c1", date(2026, 10, 5), fp)
    entry = decide_action(incoming, existing=None, sync_record=None)
    assert entry.action == SyncAction.CREATE


def test_existing_unsynced_item_matching_is_still_create():
    fp = compute_fingerprint("c1", "quiz", "Quiz 4")
    existing = _quiz_item("c1", date(2026, 10, 5), fp)
    incoming = _quiz_item("c1", date(2026, 10, 5), fp)
    entry = decide_action(incoming, existing=existing, sync_record=None)
    assert entry.action == SyncAction.CREATE


def test_changed_due_date_after_sync_is_update_not_create(session, make_course):
    course = make_course()
    fp = compute_fingerprint(course.id, "quiz", "Quiz 4")

    original = _quiz_item(course.id, date(2026, 10, 5), fp)
    row = repository.upsert_academic_item(session, original)
    repository.upsert_sync_record(
        session,
        academic_item_id=row.id,
        google_calendar_id="primary",
        google_event_id="evt_123",
        status=SyncAction.UNCHANGED,
        mark_synced=True,
        last_synced_fields=snapshot_compared_fields(original),
    )

    revised = _quiz_item(course.id, date(2026, 10, 12), fp)  # date moved a week later
    plan = compute_plan(session, course.id, [revised])
    assert plan.entries[0].action == SyncAction.UPDATE


def test_standalone_plan_detects_post_sync_enrichment_via_snapshot(session, make_course):
    # This is the actual real-world shape of the 2026-08-25 incident, not
    # just the fresh-extraction-vs-stored-row case above: `plan` run
    # standalone (no fresh extraction, see cli.py::plan_cmd) passes the
    # currently-stored items as `incoming_items`, so `compute_plan` looks
    # up `existing` for each one via its own fingerprint -- resolving to
    # the *same* row. `representation_changed(existing, incoming)` is
    # therefore always False in this mode, no matter how many fields it
    # checks, because both sides are the same stored data. Only a real
    # snapshot of what was actually last pushed (`last_synced_fields`,
    # written by `record_sync_cmd` via `snapshot_compared_fields`) can
    # catch drift here.
    course = make_course()
    fp = compute_fingerprint(course.id, "quiz", "Quiz 4")

    original = _quiz_item(course.id, date(2026, 10, 5), fp)
    row = repository.upsert_academic_item(session, original)
    # Mirrors cli.py::record_sync_cmd's real behavior: snapshot the item
    # exactly as it was at the moment of the real Calendar push.
    repository.upsert_sync_record(
        session, academic_item_id=row.id, google_calendar_id="primary",
        google_event_id="evt_123", status=SyncAction.UNCHANGED, mark_synced=True,
        last_synced_fields=snapshot_compared_fields(original),
    )

    # Enrichment applied directly to the stored row afterward, exactly
    # like `render --module-label ... --save` would -- no fresh
    # extraction involved.
    enriched = repository.get_academic_item(session, row.id)
    enriched.module_label = "Chapter 4 (10/7 - 10/28)"
    enriched.reference_url = "https://d2l.example.edu/d2l/le/quizzes/user/preview/1"
    repository.upsert_academic_item(session, enriched)

    # Standalone `plan`: current stored items ARE the incoming list.
    stored_items = repository.list_items_for_course(session, course.id)
    plan = compute_plan(session, course.id, stored_items)
    assert plan.entries[0].action == SyncAction.UPDATE
    assert "module_label" in plan.entries[0].reason


def test_standalone_plan_is_unchanged_when_nothing_drifted_since_last_push(session, make_course):
    course = make_course()
    fp = compute_fingerprint(course.id, "quiz", "Quiz 4")

    original = _quiz_item(course.id, date(2026, 10, 5), fp)
    row = repository.upsert_academic_item(session, original)
    repository.upsert_sync_record(
        session, academic_item_id=row.id, google_calendar_id="primary",
        google_event_id="evt_123", status=SyncAction.UNCHANGED, mark_synced=True,
        last_synced_fields=snapshot_compared_fields(original),
    )

    stored_items = repository.list_items_for_course(session, course.id)
    plan = compute_plan(session, course.id, stored_items)
    assert plan.entries[0].action == SyncAction.UNCHANGED


def test_enrichment_added_after_sync_is_update_not_unchanged(session, make_course):
    # Real incident, 2026-08-25: an item already synced (has a SyncRecord
    # with a real google_event_id) got module_label/reference_url added
    # later via `render --save` -- the reconciliation engine's compared-
    # fields list didn't include them, so `plan` classified it UNCHANGED
    # even though its rendered Calendar description had materially
    # changed (a new MODULE line, new LINKS). A real sync run would have
    # silently skipped re-pushing that improvement to the live event.
    course = make_course()
    fp = compute_fingerprint(course.id, "quiz", "Quiz 4")

    original = _quiz_item(course.id, date(2026, 10, 5), fp)
    row = repository.upsert_academic_item(session, original)
    repository.upsert_sync_record(
        session, academic_item_id=row.id, google_calendar_id="primary",
        google_event_id="evt_123", status=SyncAction.UNCHANGED, mark_synced=True,
    )

    enriched = _quiz_item(course.id, date(2026, 10, 5), fp)
    enriched.module_label = "Chapter 4 (10/7 - 10/28)"
    enriched.reference_url = "https://d2l.example.edu/d2l/le/quizzes/user/preview/1"
    plan = compute_plan(session, course.id, [enriched])
    assert plan.entries[0].action == SyncAction.UPDATE


def test_same_scan_twice_is_unchanged_not_duplicate(session, make_course):
    course = make_course()
    fp = compute_fingerprint(course.id, "quiz", "Quiz 4")

    item = _quiz_item(course.id, date(2026, 10, 5), fp)
    row = repository.upsert_academic_item(session, item)
    repository.upsert_sync_record(
        session, academic_item_id=row.id, google_calendar_id="primary",
        google_event_id="evt_123", status=SyncAction.UNCHANGED, mark_synced=True,
        last_synced_fields=snapshot_compared_fields(item),
    )

    # Re-extracting the exact same content a second time...
    rescan = _quiz_item(course.id, date(2026, 10, 5), fp)
    plan = compute_plan(session, course.id, [rescan])
    assert plan.entries[0].action == SyncAction.UNCHANGED

    # ...and applying it must not create a second row under the same fingerprint.
    repository.upsert_academic_item(session, rescan)
    all_items = repository.list_items_for_course(session, course.id)
    assert len(all_items) == 1


def test_missing_date_is_review_not_create():
    fp = compute_fingerprint("c1", "assignment", "Review Assignment 1")
    incoming = AcademicItem(
        id=uuid.uuid4().hex, course_id="c1", item_type=ItemType.ASSIGNMENT,
        title="Review Assignment 1", date=None, status=ItemStatus.UNRESOLVED, fingerprint=fp,
    )
    entry = decide_action(incoming, existing=None, sync_record=None)
    assert entry.action == SyncAction.REVIEW


def test_reading_item_is_ignore_not_create_or_update():
    # Real incident, 2026-08-25: `plan` reported 15 plain READING items
    # for one course as real CREATE/UPDATE candidates -- is_ready_to_sync()
    # doesn't exclude them (it's about field presence, not type), but
    # `render`/build_event_payload raises for ItemType.READING regardless
    # (CLAUDE.md invariants 24/25). A sync pass has to skip them either
    # way; IGNORE says so honestly instead of inflating the plan summary
    # with items that were never really actionable.
    fp = compute_fingerprint("c1", "reading", "Chapter 3")
    incoming = AcademicItem(
        id=uuid.uuid4().hex, course_id="c1", item_type=ItemType.READING,
        title="Chapter 3", date=date(2026, 9, 14), status=ItemStatus.CLEAR, fingerprint=fp,
    )
    entry = decide_action(incoming, existing=None, sync_record=None)
    assert entry.action == SyncAction.IGNORE


def test_superseded_item_is_ignore_not_review():
    # Real incident, 2026-08-26: standalone `plan` reported superseded
    # duplicate rows (CLAUDE.md invariant 30 -- confident-duplicate
    # resolution keeps the row instead of deleting it) as REVIEW with a
    # "missing a required field" reason, even for a superseded row that
    # has a real date and every other field filled in. is_ready_to_sync()
    # only accepts CLEAR/SYNCED status, so SUPERSEDED fell through to that
    # generic fallback -- misleading, since nothing here is actually
    # missing or needs attention. IGNORE says so honestly, matching the
    # CANCELLED/READING pattern already established.
    fp = compute_fingerprint("c1", "quiz", "Quiz 4 (old)")
    incoming = AcademicItem(
        id=uuid.uuid4().hex, course_id="c1", item_type=ItemType.QUIZ,
        title="Quiz 4 (old)", date=date(2026, 9, 14), due_time=time(23, 59),
        status=ItemStatus.SUPERSEDED, fingerprint=fp,
    )
    entry = decide_action(incoming, existing=None, sync_record=None)
    assert entry.action == SyncAction.IGNORE


def test_reading_with_date_but_no_due_time_is_sync_ready_as_all_day():
    # User explicitly wants maximal coverage ("don't miss anything") --
    # a reading/topic with a known date syncs as an all-day event even
    # without an explicit due time (see calendar_payload.py for the
    # all-day rendering).
    item = AcademicItem(
        id=uuid.uuid4().hex, course_id="c1", item_type=ItemType.READING,
        title="Chapter 22: Descent with Modification", date=date(2026, 8, 19),
        status=ItemStatus.CLEAR, fingerprint="fp-reading",
    )
    assert item.is_ready_to_sync() is True


def test_routine_meeting_without_start_time_is_still_sync_ready():
    # Lecture/lab meetings without a known clock time still sync (as an
    # all-day placeholder, see calendar_payload.py) -- unlike exams, low
    # stakes if approximate, and the user wants maximal class visibility.
    item = AcademicItem(
        id=uuid.uuid4().hex, course_id="c1", item_type=ItemType.LAB,
        title="Lab 4: Prokaryotes", date=date(2026, 9, 14),
        status=ItemStatus.CLEAR, fingerprint="fp-lab",
    )
    assert item.is_ready_to_sync() is True


def test_exam_without_start_time_still_blocked():
    item = AcademicItem(
        id=uuid.uuid4().hex, course_id="c1", item_type=ItemType.EXAM,
        title="Cumulative Midterm", date=date(2026, 10, 14),
        status=ItemStatus.CLEAR, fingerprint="fp-exam",
    )
    assert item.is_ready_to_sync() is False


def test_reading_with_explicit_due_time_is_sync_ready():
    item = AcademicItem(
        id=uuid.uuid4().hex, course_id="c1", item_type=ItemType.READING,
        title="Chapter 1 reading response", date=date(2026, 8, 19),
        due_time=time(23, 59), status=ItemStatus.CLEAR, fingerprint="fp-reading-2",
    )
    assert item.is_ready_to_sync() is True


def test_conflicted_item_is_conflict_action():
    fp = compute_fingerprint("c1", "exam", "Midterm")
    incoming = AcademicItem(
        id=uuid.uuid4().hex, course_id="c1", item_type=ItemType.EXAM,
        title="Midterm", date=date(2026, 10, 1), status=ItemStatus.CONFLICTED, fingerprint=fp,
    )
    entry = decide_action(incoming, existing=None, sync_record=None)
    assert entry.action == SyncAction.CONFLICT


def test_snapshot_from_before_a_field_was_compared_is_still_unchanged(session, make_course):
    # A snapshot recorded before submission_url (2026-10-05) joined
    # _COMPARED_FIELDS lacks that key entirely. It must read as None, not
    # as drift -- otherwise every previously-synced item would flip to
    # UPDATE the moment a new compared field ships.
    course = make_course()
    fp = compute_fingerprint(course.id, "quiz", "Quiz 6")
    original = _quiz_item(course.id, date(2026, 10, 5), fp)
    row = repository.upsert_academic_item(session, original)
    old_snapshot = snapshot_compared_fields(original)
    old_snapshot.pop("submission_url")
    old_snapshot.pop("submission_url_label")
    repository.upsert_sync_record(
        session, academic_item_id=row.id, google_calendar_id="primary",
        google_event_id="evt_6", status=SyncAction.UNCHANGED, mark_synced=True,
        last_synced_fields=old_snapshot,
    )
    plan = compute_plan(session, course.id, repository.list_items_for_course(session, course.id))
    assert plan.entries[0].action == SyncAction.UNCHANGED

    enriched = repository.get_academic_item(session, row.id)
    enriched.submission_url = "https://d2l.example/dropbox/1"
    repository.upsert_academic_item(session, enriched)
    plan = compute_plan(session, course.id, repository.list_items_for_course(session, course.id))
    assert plan.entries[0].action == SyncAction.UPDATE
    assert "submission_url" in plan.entries[0].reason


def test_unchanged_test_stays_unchanged_and_study_depth_enrichment_is_an_update(session, make_course):
    # CLAUDE.md invariant 40: an old snapshot (no covered_chapters/
    # study_focus/video keys) of an unchanged test is UNCHANGED; adding
    # covered chapters afterward is a real UPDATE, never a CREATE.
    course = make_course()
    fp = compute_fingerprint(course.id, "quiz", "Quiz 7")
    original = _quiz_item(course.id, date(2026, 10, 20), fp, title="Quiz 7")
    row = repository.upsert_academic_item(session, original)
    old_snapshot = snapshot_compared_fields(original)
    for key in ("covered_chapters", "study_focus", "video_url", "video_url_label"):
        old_snapshot.pop(key)
    repository.upsert_sync_record(
        session, academic_item_id=row.id, google_calendar_id="primary",
        google_event_id="evt_7", status=SyncAction.UNCHANGED, mark_synced=True,
        last_synced_fields=old_snapshot,
    )
    plan = compute_plan(session, course.id, repository.list_items_for_course(session, course.id))
    assert plan.entries[0].action == SyncAction.UNCHANGED

    enriched = repository.get_academic_item(session, row.id)
    enriched.covered_chapters = ["Chapter 6"]
    repository.upsert_academic_item(session, enriched)
    plan = compute_plan(session, course.id, repository.list_items_for_course(session, course.id))
    assert plan.entries[0].action == SyncAction.UPDATE
