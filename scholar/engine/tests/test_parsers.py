from __future__ import annotations

from pathlib import Path

from academic_sync.parsers.html_parser import parse_html
from academic_sync.parsers.pdf_parser import _strip_page_breaks

FIXTURE = Path(__file__).parent.parent / "fixtures" / "d2l_pages" / "sample_content_page.html"


def test_html_parser_strips_nav_and_script():
    html = FIXTURE.read_text(encoding="utf-8")
    doc = parse_html(html)
    assert "D2L navigation chrome" not in doc.text
    assert "console.log" not in doc.text


def test_html_parser_extracts_title():
    html = FIXTURE.read_text(encoding="utf-8")
    doc = parse_html(html)
    assert doc.title == "Week 4 - Genetics"


def test_html_parser_extracts_headings():
    html = FIXTURE.read_text(encoding="utf-8")
    doc = parse_html(html)
    assert "Week 4" in doc.headings


def test_html_parser_extracts_table():
    html = FIXTURE.read_text(encoding="utf-8")
    doc = parse_html(html)
    assert len(doc.tables) == 1
    table = doc.tables[0]
    assert table.headers == ["Date", "Topic", "Assignment"]
    assert table.rows == [["9/19/26", "Genetics review", "Online Quiz 3 due"]]


def test_html_parser_preserves_line_breaks_between_blocks():
    html = "<p>Lecture: Mendelian Genetics 9/15/26</p><p>Lab: Punnett Square Practice 9/17/26</p>"
    doc = parse_html(html)
    lines = [ln for ln in doc.text.splitlines() if ln.strip()]
    assert any("Lecture" in ln for ln in lines)
    assert any("Lab" in ln for ln in lines)
    # The two paragraphs must not be glued into a single line, or downstream
    # per-line date/classification extraction would misattribute the lab's
    # date to the lecture line (or vice versa).
    assert not any("Lecture" in ln and "Lab" in ln for ln in lines)


def test_strip_page_breaks_collapses_footer_and_surrounding_blanks():
    # Regression: a "Page N of M" PDF footer used to leave a blank-line gap
    # that severed a list item from its own due-date line on the next page
    # (they landed in different extraction "blocks").
    text = "Online Quiz 3: Chapters 25, 19, 27 & 28 \nPage 10 of 34\n\n\n◦ Due by midnight Sunday, 9/27/26 \n"
    cleaned = _strip_page_breaks(text)
    assert "Page 10 of 34" not in cleaned
    lines = [ln for ln in cleaned.splitlines() if ln.strip()]
    assert len(lines) == 2  # no blank line between them anymore


def test_strip_page_breaks_leaves_unrelated_text_untouched():
    text = "Some content.\n\nMore content on the next paragraph.\n"
    assert _strip_page_breaks(text) == text


def test_content_page_table_feeds_pipeline_extraction():
    from academic_sync.extraction.pipeline import ExtractionContext, extract_from_document
    from academic_sync.models.enums import ItemType

    html = FIXTURE.read_text(encoding="utf-8")
    doc = parse_html(html)
    ctx = ExtractionContext(course_id="c1", source_id="s1", reference_year=2026)
    result = extract_from_document(doc, ctx)

    quizzes = [i for i in result.items if i.item_type == ItemType.QUIZ]
    assert any(q.title == "Online Quiz 3 due" or "Quiz 3" in q.title for q in quizzes)
