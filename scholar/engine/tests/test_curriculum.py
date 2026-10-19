from __future__ import annotations

import uuid

from academic_sync import curriculum
from academic_sync.db import repository
from academic_sync.models.domain import ChapterTopic


def _topic(course, label, **kw):
    return ChapterTopic(id=uuid.uuid4().hex, course_id=course.id, chapter_label=label, **kw)


def test_stems_join_word_forms():
    assert curriculum.stems("isolation") == curriculum.stems("isolating") == curriculum.stems("isolated")
    # Short terms count only when written as terms.
    assert "ph" in curriculum.stems("pH scale")
    assert "dna" in curriculum.stems("DNA replication")
    assert not curriculum.stems("the and of to")


def test_syllabus_chapters_ranges_lists_and_other_books():
    docs = [("syllabus.txt", "Online Quiz 3: Chapters 25, 19, 27 & 28\nQuiz 2: Chapters 23–24\n"
                             "• Inner Fish CH 3 Due\n◦ Covers Chapters 19 and 22–24\nWeek 4 Chapter 30: Seed Plants")]
    found = curriculum.syllabus_chapters(docs, "Chapter")
    assert set(found) == {f"Chapter {n}" for n in (19, 22, 23, 24, 25, 27, 28, 30)}
    # "Inner Fish CH 3" is another book's chapter.
    assert "Chapter 3" not in found


def test_check_maps_outcomes_and_finds_gaps(session, make_course):
    course = make_course()
    repository.upsert_chapter_topic(session, _topic(course, "Chapter 24", title="Origin of Species",
                                                    objectives=["Describe prezygotic and postzygotic barriers"],
                                                    sections=["24.1 Species"], summary="s", reading_url="u"))
    repository.upsert_chapter_topic(session, _topic(course, "Chapter 53", title="Population Ecology",
                                                    objectives=["Describe logistic population growth and carrying capacity"],
                                                    sections=[], summary="s", reading_url="u"))
    from academic_sync.study_pdf import set_topic_summary

    set_topic_summary(session, course.id, "Chapter 24", "s")
    set_topic_summary(session, course.id, "Chapter 53", "s")
    curriculum.save_outcome(session, course.id, "outline", "VII.A", "Ecology: Populations", [], None, "syl")
    curriculum.save_outcome(session, course.id, "module", "1.4", "Compare the biological, morphological, and ecological species concepts",
                            ["Chapter 24"], None, "syl")
    curriculum.save_outcome(session, course.id, "course", "3", "Perform lab procedures safely", [], "lab skill", "syl")
    curriculum.save_outcome(session, course.id, "outline", "IX", "Marine mammal migration", [], None, "syl")
    r = curriculum.check(session, course, [("syl.txt", "Chapter 24 and Chapter 53, then Chapter 99")])
    keys = {p["key"] for p in r["problems"]}
    # Matched by its words.
    assert next(o for o in r["outcomes"] if o["ref"] == "VII.A")["chapters"] == ["Chapter 53"]
    # Given a chapter whose notes don't carry it.
    assert "outcome_thin:module:1.4" in keys
    # Taught by nothing.
    assert "outcome_unmapped:outline:IX" in keys
    # Not tested, not a gap.
    assert not any("course:3" in k for k in keys)
    assert "chapter_missing:Chapter 53" in keys  # no sections
    assert "chapter_missing:Chapter 24" not in keys
    assert "syllabus_chapter:Chapter 99" in keys
    assert "no_textbook" in keys and "no_guidelines" in keys
    assert r["ok"] is False


def test_textbook_numbering_and_reading_label(session, make_course):
    course = make_course()
    repository.set_preference(session, key="textbook", value={"title": "Brooker", "numbering": "different"},
                              category="curriculum", scope="course", course_id=course.id)
    repository.upsert_chapter_topic(session, _topic(course, "Chapter 29", title="Seedless plants", objectives=["x"],
                                                    sections=["a"], summary="s", reading_url="u",
                                                    reading_label="Textbook: go to Ch 29: Plants",
                                                    textbook_ref="Brooker, Biology, Ch. 31: Plants and the Conquest of Land"))
    repository.upsert_chapter_topic(session, _topic(course, "Chapter 30", title="Seed plants", objectives=["x"],
                                                    sections=["a"], summary="s", reading_url="u"))
    keys = {p["key"] for p in curriculum.check(session, course, [])["problems"]}
    assert "reading_wrong_chapter:Chapter 29" in keys
    assert "chapter_missing:Chapter 30" in keys  # no textbook chapter


def test_save_outcome_keeps_chapters_when_saved_again(session, make_course):
    course = make_course()
    curriculum.save_outcome(session, course.id, "outline", "A.1", "Classification of matter", ["Chapter 1"], None, "s")
    row = curriculum.save_outcome(session, course.id, "outline", "A.1", "Classification of matter", [], None, None)
    assert row.chapters_json == ["Chapter 1"] and row.source == "s"
