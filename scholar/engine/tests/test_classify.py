from __future__ import annotations

from academic_sync.extraction.classify import classify_item_type, find_reference_phrases
from academic_sync.models.enums import ItemType


def test_final_exam_beats_generic_exam():
    assert classify_item_type("Final Exam covers chapters 1-12.") == ItemType.FINAL_EXAM


def test_pre_lab_quiz_beats_generic_quiz():
    assert classify_item_type("Complete the pre-lab quiz before lab begins.") == ItemType.PRE_LAB_QUIZ


def test_lab_handout_beats_generic_lab():
    assert classify_item_type("Lab handout is due next week.") == ItemType.LAB_HANDOUT


def test_lecture_vs_lab_differentiation():
    assert classify_item_type("Lecture: Evolution of Populations") == ItemType.LECTURE
    assert classify_item_type("Lab: Evidence of Evolution") == ItemType.LAB


def test_lecture_beats_bare_chapter_mention():
    # Real incident, 2026-08-19: "chapter" (a weak, generic reading signal)
    # was checked before "lecture", so any lecture-topic line mentioning a
    # chapter number -- the overwhelming majority of them -- misclassified
    # as READING instead of LECTURE, silently producing untimed all-day
    # reading events instead of real timed/located lecture meetings for an
    # entire semester.
    assert classify_item_type("Lecture: Chapter 29: Seedless Plants") == ItemType.LECTURE
    bare = "Chapter 29: Seedless Plants, cont.; Chapter 30: Seed Plants"
    assert classify_item_type(bare) != ItemType.LECTURE


def test_bare_chapter_mention_still_classifies_as_reading():
    # The fix above must not stop a genuine reading-only line (no other
    # type keyword at all) from still classifying as READING.
    assert classify_item_type("Chapter 6: Cell Structure") == ItemType.READING


def test_explicit_reading_phrasing_still_wins_even_mentioning_lecture():
    # "read chapter"/"reading" stay in their original, higher-priority slot
    # -- a line that's clearly a reading assignment but happens to mention
    # "lecture" as context must not flip to LECTURE.
    assert classify_item_type("Reading due before Wednesday's lecture") == ItemType.READING
    assert classify_item_type("Read Chapter 5 before lecture") == ItemType.READING


def test_administrative_deadline():
    assert classify_item_type("Last day to withdraw from the course.") == ItemType.ADMINISTRATIVE_DEADLINE


def test_no_match_returns_none():
    assert classify_item_type("Please review the course policies.") is None


def test_exam_does_not_false_positive_inside_example():
    # "example.edu" contains the substring "exam" -- must not classify as EXAM.
    assert classify_item_type("Instructor: Jane Doe (jane.doe@example.edu)") is None


def test_hw_does_not_false_positive_inside_unrelated_word():
    assert classify_item_type("Somewhat difficult material this week.") is None


def test_find_reference_phrases_see_d2l():
    phrases = ["see d2l", "additional details will be provided"]
    found = find_reference_phrases("For the full schedule, see D2L.", phrases)
    assert found == ["see d2l"]


def test_find_reference_phrases_additional_details():
    phrases = ["see d2l", "additional details will be provided"]
    text = "Two review assignments are planned. Additional details will be provided in class."
    found = find_reference_phrases(text, phrases)
    assert "additional details will be provided" in found


def test_find_reference_phrases_none_when_absent():
    phrases = ["see d2l"]
    assert find_reference_phrases("Everything you need is in this syllabus.", phrases) == []
