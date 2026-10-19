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


def _item(session, course, title, item_type, d):
    from datetime import date as _d

    from academic_sync.models.domain import AcademicItem
    from academic_sync.models.enums import ItemStatus, ItemType

    it = AcademicItem(id=uuid.uuid4().hex, course_id=course.id, title=title, item_type=ItemType(item_type), date=_d.fromisoformat(d),
                      status=ItemStatus.CLEAR, fingerprint=uuid.uuid4().hex)
    repository.upsert_academic_item(session, it)
    return it


def test_database_refuses_folding_graded_work_into_a_reading_week(session, make_course):
    import pytest
    from sqlalchemy import text

    from academic_sync.db.migrations import _0021_add_item_history, _0023_guard_folding_graded_work

    _0021_add_item_history(session)
    _0023_guard_folding_graded_work(session)
    course = make_course(code="MAT1340")
    week = _item(session, course, "Chapter 2: Functions and Relations", "weekly_reading", "2026-09-07")
    review = _item(session, course, "Review: Chapter 2", "reading", "2026-09-12")
    plain = _item(session, course, "Chapter 2, cont", "reading", "2026-09-09")
    session.flush()
    with pytest.raises(Exception, match="graded work"):
        session.execute(text("UPDATE academic_items SET superseded_by_id = :b, status = 'superseded' WHERE id = :i"), {"b": week.id, "i": review.id})
    session.rollback()
    # A plain reading folds in; graded-looking work only with a reason saying it isn't graded.
    session.execute(text("UPDATE academic_items SET superseded_by_id = :b WHERE id = :i"), {"b": week.id, "i": plain.id})
    session.execute(text("UPDATE event_context SET reason = 'Review week, not graded: the practice exam is its own item' WHERE id = 1"))
    session.execute(text("UPDATE academic_items SET superseded_by_id = :b WHERE id = :i"), {"b": week.id, "i": review.id})


def test_explanations_must_teach():
    from academic_sync.cli import _explain_problems

    bare = {"type": "num", "level": "apply", "q": "Density?", "answer": 1.26}
    assert any("symbols" in p for p in _explain_problems(bare, "d = m/V = 31.5 g / 25.0 mL = 1.26 g/mL, three significant figures kept throughout."))
    good = "Density is mass per volume: d = m/V, where d is the density in g/mL, m the mass in grams and V the volume in mL. 31.5 g / 25.0 mL = 1.26 g/mL."
    assert _explain_problems(bare, good) == []
    assert any("thin" in p for p in _explain_problems(bare, "31.5 / 25.0 = 1.26 g/mL."))
    # Solving for x is algebra, not a formula with symbols to define.
    assert not any("symbols" in p for p in _explain_problems({"type": "mc"}, "Subtract 3 from both sides, then x = (12 - 3)/3 = 3."))
    assert any("LaTeX" in p for p in _explain_problems({"type": "tf", "q": "Is \\frac{1}{2} half?"}, "Yes, one half is 0.5 of the whole."))


def test_textbooks_carry_no_answer_keys():
    from academic_sync.study_pdf import forbidden_parts

    assert forbidden_parts("= Ch 5\n#selfcheck(([Q], [A]))") and forbidden_parts("== Practice test\nWork these")
    assert forbidden_parts("== Gas laws\n#example[...]\n*Answer:* 22.") == []
