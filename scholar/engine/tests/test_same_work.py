"""Two pieces of work must never merge into one row (2026-10-24 audit), and rows stored under the old fingerprint rule
must be updated in place, not duplicated or orphaned."""

from __future__ import annotations

import uuid
from datetime import date

import pytest
from sqlalchemy import select

from academic_sync.db import repository
from academic_sync.db.orm import AcademicItemRow
from academic_sync.models.domain import AcademicItem
from academic_sync.models.enums import ItemStatus, ItemType
from academic_sync.reconciliation.fingerprint import (
    _hash,
    compute_fingerprint,
    legacy_canonicalize_title,
)

DIFFERENT = [
    ("assignment", "Ch 5 Problem Set Part 1", "Ch 5 Problem Set Part 2"),
    ("discussion", "Chapter 4 Discussion Initial Post", "Chapter 4 Discussion Replies"),
    ("assignment", "Homework Chapter 2 Section 3", "Homework Chapter 2 Section 4"),
    ("quiz", "Quiz 4 (Ch 7-8)", "Ch 4 Quiz"),
]
SAME = [
    ("quiz", "Quiz 4", "Quiz 4 – Chapter 7"),
    ("lab", "Lab 3 Report", "Lab 3: Report"),
    ("quiz", "Online Quiz 4", "Quiz #4 (Chapters 9-10)"),
    ("quiz", "Quiz #4 (Chapters 9-10)", "Online Quiz 4 (Ch. 9-10)"),
    ("assignment", "HW: 1.3", "HW Section 1.3"),
    ("discussion", "Discussion 3 Initial Post", "Discussion 3: Initial Post (due 10/14)"),
]


@pytest.mark.parametrize("kind,a,b", DIFFERENT)
def test_different_work_is_never_the_same_title(kind, a, b):
    assert not repository.same_work_title(a, b)
    assert not repository.same_work_title(b, a)


@pytest.mark.parametrize("kind,a,b", SAME)
def test_rewordings_are_still_the_same_title(kind, a, b):
    assert repository.same_work_title(a, b)
    assert repository.same_work_title(b, a)


@pytest.mark.parametrize("kind,a,b", DIFFERENT[:3])
def test_part_section_reply_get_their_own_fingerprint(kind, a, b):
    assert compute_fingerprint("c", kind, a) != compute_fingerprint("c", kind, b)


@pytest.mark.parametrize("kind,a,b", SAME[:3])
def test_rewordings_keep_one_fingerprint(kind, a, b):
    assert compute_fingerprint("c", kind, a) == compute_fingerprint("c", kind, b)


def _item(course_id, kind, title, fp, day=date(2026, 11, 3)):
    return AcademicItem(
        id=uuid.uuid4().hex, course_id=course_id, item_type=kind, title=title, date=day,
        status=ItemStatus.CLEAR, fingerprint=fp,
    )


def _rows(session, course_id):
    return session.execute(select(AcademicItemRow).where(AcademicItemRow.course_id == course_id)).scalars().all()


@pytest.mark.parametrize("kind,a,b", DIFFERENT)
def test_second_item_never_overwrites_the_first(session, make_course, kind, a, b):
    course = make_course()
    t = ItemType(kind)
    repository.upsert_academic_item(session, _item(course.id, t, a, compute_fingerprint(course.id, kind, a)))
    repository.upsert_academic_item(session, _item(course.id, t, b, compute_fingerprint(course.id, kind, b), date(2026, 11, 10)))
    assert sorted(r.title for r in _rows(session, course.id)) == sorted([a, b])


def test_row_stored_under_old_fingerprint_is_updated_and_rekeyed(session, make_course):
    course = make_course()
    title = "Module 5 Discussion 3: Reflection (Initial Post)"
    old_fp = _hash(course.id, legacy_canonicalize_title(title, "discussion"), None)
    new_fp = compute_fingerprint(course.id, "discussion", title)
    assert old_fp != new_fp
    stored = _item(course.id, ItemType.DISCUSSION, title, old_fp)
    repository.upsert_academic_item(session, stored)

    # The same work comes back under the new rule (date moved): one row, re-keyed, same id.
    again = _item(course.id, ItemType.DISCUSSION, title, new_fp, date(2026, 11, 5))
    repository.upsert_academic_item(session, again)
    rows = _rows(session, course.id)
    assert len(rows) == 1
    assert rows[0].id == stored.id and rows[0].fingerprint == new_fp and rows[0].date == date(2026, 11, 5)

    # Its reply deadline (same old key) becomes its own item, never an overwrite of the first post.
    reply = "Module 5 Discussion 3: Reflection (Replies)"
    repository.upsert_academic_item(session, _item(course.id, ItemType.DISCUSSION, reply, compute_fingerprint(course.id, "discussion", reply)))
    assert sorted(r.title for r in _rows(session, course.id)) == sorted([title, reply])


def test_legacy_row_of_other_work_is_not_taken(session, make_course):
    course = make_course()
    first = "Module 5 Discussion 3: Reflection (Initial Post)"
    reply = "Module 5 Discussion 3: Reflection (Replies)"
    # Only the first post is stored, under the old key both titles shared.
    repository.upsert_academic_item(session, _item(course.id, ItemType.DISCUSSION, first, _hash(course.id, legacy_canonicalize_title(first, "discussion"), None)))
    repository.upsert_academic_item(session, _item(course.id, ItemType.DISCUSSION, reply, compute_fingerprint(course.id, "discussion", reply)))
    assert sorted(r.title for r in _rows(session, course.id)) == sorted([first, reply])
