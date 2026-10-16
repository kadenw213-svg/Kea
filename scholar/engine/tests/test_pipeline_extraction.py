from __future__ import annotations

from datetime import date
from pathlib import Path

from academic_sync.extraction.pipeline import ExtractionContext, extract_from_document
from academic_sync.models.enums import ItemStatus, ItemType, UnresolvedReferenceKind
from academic_sync.parsers.base import ParsedDocument, ParsedTable

FIXTURE = Path(__file__).parent.parent / "fixtures" / "syllabi" / "bio1112_syllabus.txt"

REFERENCE_PHRASES = [
    "see d2l", "additional details will be provided", "pre-lab quiz",
]


def _run_pipeline():
    text = FIXTURE.read_text(encoding="utf-8")
    document = ParsedDocument(text=text, title="BIO 1112 Syllabus")
    ctx = ExtractionContext(
        course_id="c1",
        source_id="src1",
        reference_year=2026,
        reference_phrases=REFERENCE_PHRASES,
        is_tentative=True,
    )
    return extract_from_document(document, ctx)


def test_quiz_deadlines_extracted_with_dates():
    result = _run_pipeline()
    quizzes = [i for i in result.items if i.item_type == ItemType.QUIZ]
    assert any(q.date == date(2026, 9, 10) for q in quizzes)
    assert any(q.date == date(2026, 9, 20) for q in quizzes)


def test_lecture_and_lab_are_differentiated():
    result = _run_pipeline()
    lectures = [i for i in result.items if i.item_type == ItemType.LECTURE]
    labs = [i for i in result.items if i.item_type == ItemType.LAB]
    assert len(lectures) >= 1
    assert len(labs) >= 1
    assert lectures[0].date != labs[0].date or lectures[0].title != labs[0].title


def test_tentative_flag_propagates_to_items():
    result = _run_pipeline()
    assert all(i.is_tentative for i in result.items)


def test_pre_lab_quiz_not_fabricated_from_generic_syllabus_statement():
    result = _run_pipeline()
    pre_lab_quizzes = [i for i in result.items if i.item_type == ItemType.PRE_LAB_QUIZ]
    assert pre_lab_quizzes == []


def test_see_d2l_reference_captured_as_unresolved():
    result = _run_pipeline()
    kinds = [r.kind for r in result.unresolved]
    assert UnresolvedReferenceKind.EXTERNAL_REFERENCE_UNINSPECTED in kinds
    matched_phrases = {r.source_wording for r in result.unresolved}
    assert "see d2l" in matched_phrases


def test_additional_details_will_be_provided_captured_as_unresolved():
    result = _run_pipeline()
    matched_phrases = {r.source_wording for r in result.unresolved}
    assert "additional details will be provided" in matched_phrases


def test_administrative_deadline_extracted():
    result = _run_pipeline()
    admin = [i for i in result.items if i.item_type == ItemType.ADMINISTRATIVE_DEADLINE]
    assert len(admin) == 1
    assert admin[0].date == date(2026, 10, 30)


def test_midterm_and_final_exam_differentiated():
    result = _run_pipeline()
    midterm = [i for i in result.items if i.item_type == ItemType.EXAM]
    assert any(i.date == date(2026, 10, 15) for i in midterm)


def test_instructor_line_does_not_produce_letter_spaced_or_bogus_exam_item():
    # Regression: "example.edu" in the instructor line must not (a) false-match
    # "exam" and (b) if a line has no date, title-cleaning must not degrade to
    # "I n s t r u c t o r : ..." via a str.replace("", " ") bug.
    result = _run_pipeline()
    for item in result.items:
        assert "example.edu" not in item.title
        assert not _looks_letter_spaced(item.title)


def _looks_letter_spaced(title: str) -> bool:
    letters = [c for c in title if c.isalpha()]
    return len(letters) > 6 and all(len(tok) <= 1 for tok in title.split())


def test_title_and_due_date_on_separate_lines_still_resolves():
    # Real D2L quiz-list layout: title on its own line, due date on the next
    # line, an unrelated "Available on ..." date on the line after that.
    # Must pick up the Due date (from the block below), not the Available
    # date, and not leave the item UNRESOLVED for a missing date.
    text = (
        "Online Quiz 1\n"
        "Due on Aug 30, 2026 23:59\n"
        "Available on Aug 24, 2026 00:01\n"
    )
    document = ParsedDocument(text=text, title="Quiz List")
    ctx = ExtractionContext(course_id="c1", source_id="s1", reference_year=2026)
    result = extract_from_document(document, ctx)

    quizzes = [i for i in result.items if i.item_type == ItemType.QUIZ]
    assert len(quizzes) == 1
    assert quizzes[0].date == date(2026, 8, 30)
    assert quizzes[0].status == ItemStatus.CLEAR


def test_prose_fragment_without_date_is_not_fabricated_as_item():
    # Realistic wrapped-sentence fragments from a full syllabus PDF's policy
    # text, which happen to contain "lab"/"lecture" -- must not become
    # phantom "known but undated" items. This is a best-effort heuristic
    # (catches lines starting lowercase, or long multi-clause sentences with
    # a mid-line period) -- it isn't expected to catch every prose fragment
    # regardless of shape, only to meaningfully cut the common cases.
    text = (
        "and lab evaluations. Approximately 70% of the course grade is based\n"
        "lecture assessments and activities, while the remaining 30% is based\n"
        "lab assessments and activities. Grades will be posted in MyCourses D2L\n"
    )
    document = ParsedDocument(text=text, title="Syllabus excerpt")
    ctx = ExtractionContext(course_id="c1", source_id="s1", reference_year=2026)
    result = extract_from_document(document, ctx)
    assert result.items == []


def test_short_undated_list_item_is_still_flagged_unresolved():
    # Contrast case: a genuinely short, title-like undated mention (not a
    # prose fragment) must still be caught as a known-but-undated item.
    text = "Review Assignment 1\n"
    document = ParsedDocument(text=text, title="Syllabus excerpt")
    ctx = ExtractionContext(course_id="c1", source_id="s1", reference_year=2026)
    result = extract_from_document(document, ctx)
    assignments = [i for i in result.items if i.item_type == ItemType.ASSIGNMENT]
    assert len(assignments) == 1
    assert assignments[0].status == ItemStatus.UNRESOLVED


def test_prose_line_with_explicit_date_is_still_trusted():
    # A wordy line that nonetheless carries an explicit date (a topical
    # outline table row wrapped onto one long line) must NOT be suppressed
    # by the prose-fragment guard -- the date is strong independent evidence.
    text = "Week 3 Lab 3: Classification of Organisms and Taxonomic Keys 9/7/26\n"
    document = ParsedDocument(text=text, title="Syllabus excerpt")
    ctx = ExtractionContext(course_id="c1", source_id="s1", reference_year=2026)
    result = extract_from_document(document, ctx)
    labs = [i for i in result.items if i.item_type == ItemType.LAB]
    assert len(labs) == 1
    assert labs[0].date == date(2026, 9, 7)


def test_leading_bullet_glyph_stripped_from_title():
    # PDF text extraction often renders bullet icons as a raw Private-Use-Area
    # codepoint (e.g. a Wingdings-style glyph) or standard bullet characters --
    # these must not end up as the first character of a real Calendar title.
    bullets = [chr(0x2022), chr(0x25E6), chr(0xF06F)]
    for bullet in bullets:
        text = bullet + " Lab 6: Seedless Plants 9/28/26" + "\n"
        document = ParsedDocument(text=text, title="Lab Schedule")
        ctx = ExtractionContext(course_id="c1", source_id="s1", reference_year=2026)
        result = extract_from_document(document, ctx)
        labs = [i for i in result.items if i.item_type == ItemType.LAB]
        assert len(labs) == 1
        assert not labs[0].title.startswith(bullet)
        assert labs[0].title == "Lab 6: Seedless Plants"


def test_date_range_break_title_has_no_dangling_remnant():
    # Real incident, 2026-08-19: a break line phrased as a date RANGE
    # ("Labor Day Break: 9/7/26-09/08/26 -- No Classes") only has its first
    # date matched/removed by _clean_title's literal replace() -- before the
    # fix this left a dangling "-09/08/26" fragment in the synced title
    # ("Labor Day Break: -09/08/26 -- No Classes"), even though
    # source_wording (never cleaned) kept the full text. Both this and the
    # Thanksgiving break event synced with the mangled title in production.
    text = "Labor Day Break: 9/7/26-09/08/26 -- No Classes\n"
    document = ParsedDocument(text=text, title="Course Calendar")
    ctx = ExtractionContext(course_id="c1", source_id="s1", reference_year=2026)
    result = extract_from_document(document, ctx)
    breaks = [i for i in result.items if i.item_type == ItemType.BREAK]
    assert len(breaks) == 1
    assert "09/08/26" not in breaks[0].title
    assert breaks[0].title == "Labor Day Break: -- No Classes"


def test_bare_dates_only_apply_when_context_opts_in():
    text = "Chapter 1 Exam Due 8/30\n"
    document = ParsedDocument(text=text, title="Course Calendar")

    ctx_off = ExtractionContext(course_id="c1", source_id="s1", reference_year=2026)
    result_off = extract_from_document(document, ctx_off)
    assert not any(i.item_type == ItemType.EXAM and i.date is not None for i in result_off.items)

    ctx_on = ExtractionContext(
        course_id="c1", source_id="s1", reference_year=2026, allow_bare_dates=True
    )
    result_on = extract_from_document(document, ctx_on)
    exams = [i for i in result_on.items if i.item_type == ItemType.EXAM]
    assert len(exams) == 1
    assert exams[0].date == date(2026, 8, 30)


def test_async_exam_phrased_as_due_becomes_deadline_not_meeting():
    # An exam explicitly phrased as "Due" (an online/async exam window) must
    # get a due_time, not be stuck requiring an invented classroom start_time.
    text = "Chapter 1 Exam Due 8/30/26\n"
    document = ParsedDocument(text=text, title="Course Calendar")
    ctx = ExtractionContext(course_id="c1", source_id="s1", reference_year=2026)
    result = extract_from_document(document, ctx)
    exams = [i for i in result.items if i.item_type == ItemType.EXAM]
    assert len(exams) == 1
    assert exams[0].due_time is not None
    assert exams[0].start_time is None
    assert exams[0].status == ItemStatus.CLEAR
    assert exams[0].is_ready_to_sync() is True


def test_in_person_exam_without_due_wording_still_requires_start_time():
    text = "Cumulative Midterm 10/14/26\n"
    document = ParsedDocument(text=text, title="Lecture Schedule")
    ctx = ExtractionContext(course_id="c1", source_id="s1", reference_year=2026)
    result = extract_from_document(document, ctx)
    exams = [i for i in result.items if i.item_type == ItemType.EXAM]
    assert len(exams) == 1
    assert exams[0].start_time is None
    assert exams[0].due_time is None
    assert exams[0].is_ready_to_sync() is False


def test_bare_date_heading_applies_to_undated_bullets_below_it():
    # Real syllabus layout: a date+weekday heading, then several bulleted
    # items with no date of their own -- each must inherit the heading's date.
    text = (
        "9/14/26 Monday\n"
        "Inner Fish CH 1 Due\n"
        "Chapter 27: Prokaryotes\n"
    )
    document = ParsedDocument(text=text, title="Lecture Schedule")
    ctx = ExtractionContext(course_id="c1", source_id="s1", reference_year=2026)
    result = extract_from_document(document, ctx)

    fish = [i for i in result.items if i.item_type == ItemType.OTHER_DEADLINE]
    assert len(fish) == 1
    assert fish[0].date == date(2026, 9, 14)
    assert fish[0].status == ItemStatus.CLEAR


def test_bare_date_heading_does_not_apply_across_a_later_heading():
    text = (
        "9/14/26 Monday\n"
        "Inner Fish CH 1 Due\n"
        "9/16/26 Wednesday\n"
        "Chapter 28: Protists\n"
        "Inner Fish CH 2 Due\n"
    )
    document = ParsedDocument(text=text, title="Lecture Schedule")
    ctx = ExtractionContext(course_id="c1", source_id="s1", reference_year=2026)
    result = extract_from_document(document, ctx)

    fish = sorted(
        (i for i in result.items if i.item_type == ItemType.OTHER_DEADLINE), key=lambda i: i.date
    )
    assert [f.date for f in fish] == [date(2026, 9, 14), date(2026, 9, 16)]


def test_generic_deadline_phrase_without_specific_keyword_still_creates_item():
    text = "Inner Fish CH 4 Due 10/5/26\n"
    document = ParsedDocument(text=text, title="Lecture Schedule")
    ctx = ExtractionContext(course_id="c1", source_id="s1", reference_year=2026)
    result = extract_from_document(document, ctx)
    matches = [i for i in result.items if i.item_type == ItemType.OTHER_DEADLINE]
    assert len(matches) == 1
    assert matches[0].date == date(2026, 10, 5)


def test_generic_deadline_fallback_does_not_override_specific_classification():
    # "Quiz" should still classify as QUIZ, not fall through to OTHER_DEADLINE,
    # since classify_item_type already matched something specific.
    text = "Online Quiz 1 due 9/10/26\n"
    document = ParsedDocument(text=text, title="Lecture Schedule")
    ctx = ExtractionContext(course_id="c1", source_id="s1", reference_year=2026)
    result = extract_from_document(document, ctx)
    assert any(i.item_type == ItemType.QUIZ for i in result.items)
    assert not any(i.item_type == ItemType.OTHER_DEADLINE for i in result.items)


def test_lookahead_does_not_cross_blank_line_block_boundary():
    text = (
        "Online Quiz 1\n"
        "\n"
        "Due on Aug 30, 2026 23:59\n"
    )
    document = ParsedDocument(text=text, title="Quiz List")
    ctx = ExtractionContext(course_id="c1", source_id="s1", reference_year=2026)
    result = extract_from_document(document, ctx)

    quizzes = [i for i in result.items if i.item_type == ItemType.QUIZ]
    assert len(quizzes) == 1
    assert quizzes[0].date is None
    assert quizzes[0].status == ItemStatus.UNRESOLVED


def test_date_far_outside_term_is_flagged_not_trusted():
    # Reproduces the 2026-08-18 incident: a garbled/misparsed date wildly
    # outside a Aug-Dec 2026 term (here, 2013) must never become a CLEAR,
    # sync-eligible item -- term_start/term_end were already threaded into
    # ExtractionContext but nothing enforced them before this fix.
    text = "Online Quiz 1 due 7/9/13\n"
    document = ParsedDocument(text=text, title="Lecture Schedule")
    ctx = ExtractionContext(
        course_id="c1",
        source_id="s1",
        reference_year=2026,
        term_start=date(2026, 8, 17),
        term_end=date(2026, 12, 6),
    )
    result = extract_from_document(document, ctx)
    quizzes = [i for i in result.items if i.item_type == ItemType.QUIZ]
    assert len(quizzes) == 1
    assert quizzes[0].date is None
    assert quizzes[0].status == ItemStatus.UNRESOLVED
    assert any(r.kind == UnresolvedReferenceKind.OTHER for r in result.unresolved)


def test_date_near_term_edge_within_buffer_is_still_trusted():
    # A date just outside the literal term dates (e.g. a pre-term prep
    # assignment) should NOT be flagged -- only dates far outside the term
    # are treated as likely parsing artifacts.
    text = "Online Quiz 1 due 8/10/26\n"
    document = ParsedDocument(text=text, title="Lecture Schedule")
    ctx = ExtractionContext(
        course_id="c1",
        source_id="s1",
        reference_year=2026,
        term_start=date(2026, 8, 17),
        term_end=date(2026, 12, 6),
    )
    result = extract_from_document(document, ctx)
    quizzes = [i for i in result.items if i.item_type == ItemType.QUIZ]
    assert len(quizzes) == 1
    assert quizzes[0].date == date(2026, 8, 10)
    assert quizzes[0].status == ItemStatus.CLEAR


def test_repeated_chapter_number_across_different_lecture_days_does_not_collide():
    # Real incident, 2026-08-19: two different BIO1112 class days both
    # covering chapter 29 ("Chapter 29: Seedless Plants" on Monday,
    # "Chapter 29: Seedless Plants, cont." on Wednesday) fingerprinted
    # identically under the old rule, because compute_fingerprint reduces
    # any numbered title to just "<type>-<first number>" -- correct for
    # "Quiz 3" vs "Quiz 4" but wrong for a meeting whose title is a topic
    # description that can reference the same chapter across multiple real
    # occurrences. The second occurrence silently failed to get its own row.
    text = (
        "9/21/26 Monday\n"
        "Lecture: Chapter 29: Seedless Plants\n"
        "\n"
        "9/23/26 Wednesday\n"
        "Lecture: Chapter 29: Seedless Plants, cont.\n"
    )
    document = ParsedDocument(text=text, title="Lecture Schedule")
    ctx = ExtractionContext(course_id="c1", source_id="s1", reference_year=2026)
    result = extract_from_document(document, ctx)
    lectures = [i for i in result.items if i.item_type == ItemType.LECTURE]
    assert len(lectures) == 2
    assert len({i.fingerprint for i in lectures}) == 2
    assert {i.date for i in lectures} == {date(2026, 9, 21), date(2026, 9, 23)}


def test_lab_fingerprint_is_stable_across_rescans_not_date_based():
    # Regression for a second real incident the same day: the first fix
    # above scoped the date-based disambiguator to every
    # is_fixed_time_meeting type, including LAB -- but "Lab 4"/"Lab 5" use
    # their leading number as a genuine stable per-occurrence identity
    # (like "Quiz 3"/"Quiz 4"), not a repeating chapter reference like
    # lecture titles. Re-extracting the same LAB content on a later date
    # (e.g. a syllabus re-scan) must still fingerprint identically so it
    # UPDATEs the existing synced item instead of creating a duplicate,
    # unsynced shadow row -- confirmed happening for real (22 duplicate
    # rows for already-synced BIO1112 labs/exams) before this was scoped
    # down to LECTURE/RECITATION/SEMINAR only.
    doc_a = ParsedDocument(text="9/14/26 Monday\nLab 4: Prokaryotes\n", title="Lab Schedule")
    doc_b = ParsedDocument(text="9/16/26 Wednesday\nLab 4: Prokaryotes\n", title="Lab Schedule")
    ctx = ExtractionContext(course_id="c1", source_id="s1", reference_year=2026)
    result_a = extract_from_document(doc_a, ctx)
    result_b = extract_from_document(doc_b, ctx)
    labs_a = [i for i in result_a.items if i.item_type == ItemType.LAB]
    labs_b = [i for i in result_b.items if i.item_type == ItemType.LAB]
    assert len(labs_a) == 1 and len(labs_b) == 1
    assert labs_a[0].fingerprint == labs_b[0].fingerprint


def test_reworded_same_numbered_quiz_still_merges_across_rescans():
    # The fix above must not break the opposite, intentional behavior for
    # non-meeting types: a reworded mention of the same numbered quiz across
    # a re-scan should still fingerprint identically so it UPDATEs in place
    # rather than duplicating -- see test_fingerprint.py's
    # test_same_numbered_item_different_wording_same_fingerprint.
    doc_a = ParsedDocument(text="Online Quiz 4 due 9/10/26\n", title="Quiz List")
    doc_b = ParsedDocument(text="Quiz #4 (Chapters 9-10) due 9/10/26\n", title="Quiz List")
    ctx = ExtractionContext(course_id="c1", source_id="s1", reference_year=2026)
    result_a = extract_from_document(doc_a, ctx)
    result_b = extract_from_document(doc_b, ctx)
    quizzes_a = [i for i in result_a.items if i.item_type == ItemType.QUIZ]
    quizzes_b = [i for i in result_b.items if i.item_type == ItemType.QUIZ]
    assert len(quizzes_a) == 1 and len(quizzes_b) == 1
    assert quizzes_a[0].fingerprint == quizzes_b[0].fingerprint


def test_table_row_with_date_far_outside_term_is_flagged_not_trusted():
    table = ParsedTable(
        headers=["Date", "Assignment", "Submission Requirements"],
        rows=[["7/9/13", "Quiz due", "1 PDF"]],
    )
    document = ParsedDocument(text="", title="Schedule", tables=[table])
    ctx = ExtractionContext(
        course_id="c1",
        source_id="s1",
        reference_year=2026,
        term_start=date(2026, 8, 17),
        term_end=date(2026, 12, 6),
    )
    result = extract_from_document(document, ctx)
    assert result.items == []
    assert any(r.kind == UnresolvedReferenceKind.OTHER for r in result.unresolved)
