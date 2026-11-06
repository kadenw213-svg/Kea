from __future__ import annotations

from academic_sync.cli import _strip_get_page_text_header


def test_strips_get_page_text_header():
    text = (
        "Title: Quiz List - BIO1112175 GenBioII:EcoI Organism/Lab:SC1 (Jane Doe) FA26\n"
        "URL: https://d2l.example.edu/d2l/lms/quizzing/user/quizzes_list.d2l?ou=665290\n"
        "Source element: <div>\n"
        "---\n"
        "Quiz List\n"
        "\n"
        "Online Quiz 1\n"
        "Due on Aug 30, 2026 23:59\n"
    )
    cleaned, title = _strip_get_page_text_header(text)
    assert title == "Quiz List - BIO1112175 GenBioII:EcoI Organism/Lab:SC1 (Jane Doe) FA26"
    assert "Title:" not in cleaned
    assert "Source element:" not in cleaned
    assert "Online Quiz 1" in cleaned


def test_leaves_plain_text_untouched_without_header_shape():
    text = "Online Quiz 1\nDue on Aug 30, 2026 23:59\n"
    cleaned, title = _strip_get_page_text_header(text)
    assert cleaned == text
    assert title is None


def test_leaves_text_untouched_when_title_present_but_no_separator():
    text = "Title: Something\nJust some other content, no --- separator.\n"
    cleaned, title = _strip_get_page_text_header(text)
    assert cleaned == text
    assert title is None
