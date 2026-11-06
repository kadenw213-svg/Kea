from __future__ import annotations

from academic_sync.reconciliation.fingerprint import canonicalize_title, compute_fingerprint


def test_same_numbered_item_different_wording_same_fingerprint():
    a = compute_fingerprint("course-1", "quiz", "Online Quiz 4")
    b = compute_fingerprint("course-1", "quiz", "Quiz #4 (Chapters 9-10)")
    assert a == b


def test_different_numbers_different_fingerprint():
    a = compute_fingerprint("course-1", "quiz", "Quiz 3")
    b = compute_fingerprint("course-1", "quiz", "Quiz 4")
    assert a != b


def test_different_courses_different_fingerprint():
    a = compute_fingerprint("course-1", "quiz", "Quiz 4")
    b = compute_fingerprint("course-2", "quiz", "Quiz 4")
    assert a != b


def test_date_is_not_part_of_identity_for_numbered_items():
    # A revised due date must NOT change the fingerprint of a numbered item --
    # otherwise a date correction would look like a brand new item (breaks
    # UPDATE-not-CREATE idempotency).
    identity_a = canonicalize_title("Quiz 4", "quiz")
    identity_b = canonicalize_title("Quiz 4 (due later)", "quiz")
    assert identity_a == identity_b


def test_point_value_does_not_collide_with_sequence_number():
    # Regression: "Syllabus Quiz 5 pts" (5 = point value) must not
    # canonicalize the same as "Online Quiz 5" (5 = sequence number) --
    # that collision previously caused upsert_academic_item to silently
    # overwrite one quiz's row with the other's data.
    a = compute_fingerprint("course-1", "quiz", "Online Quiz 5")
    b = compute_fingerprint("course-1", "quiz", "Syllabus Quiz 5 pts")
    assert a != b


def test_decimal_section_numbers_do_not_collide():
    # Regression: "HW: 1.3" and "HW: 1.4" both used to reduce to identity
    # "assignment-1" because the cleaning step stripped the decimal point,
    # silently collapsing distinct weekly homework deadlines into one.
    fp_1_3 = compute_fingerprint("course-1", "assignment", "HW: 1.3")
    fp_1_4 = compute_fingerprint("course-1", "assignment", "HW: 1.4")
    fp_2_3 = compute_fingerprint("course-1", "assignment", "HW: 2.3")
    assert len({fp_1_3, fp_1_4, fp_2_3}) == 3


def test_hyphenated_duration_does_not_collide_different_deadlines():
    # Regression: "Last day to drop any 15-week course" and "Last day to
    # withdraw from any 15-week course" both mention "15-week" -- that must
    # not make them fingerprint identically and silently overwrite each other.
    drop_fp = compute_fingerprint(
        "course-1", "administrative_deadline", "Last day to drop any 15-week course"
    )
    withdraw_fp = compute_fingerprint(
        "course-1", "administrative_deadline", "Last day to withdraw from any 15-week course"
    )
    assert drop_fp != withdraw_fp


def test_point_value_variants_all_avoid_collision():
    sequence_fp = compute_fingerprint("course-1", "quiz", "Quiz 5")
    for phrase in ["Quiz worth 5 points", "Quiz 5 pt", "Quiz 5%"]:
        assert compute_fingerprint("course-1", "quiz", phrase) != sequence_fp


def test_disambiguator_separates_unnumbered_items():
    a = compute_fingerprint("course-1", "reading", "Reading", disambiguator="Week 1")
    b = compute_fingerprint("course-1", "reading", "Reading", disambiguator="Week 2")
    assert a != b
