"""Weekly study PDFs (CLAUDE.md invariant 41): naming, vocabulary
coverage, due-banner selection, and build/record idempotency."""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import pytest
from test_cli_render import _isolated_db, _make_course, _make_weekly_reading_item
from typer.testing import CliRunner

from academic_sync import study_pdf
from academic_sync.chapter_topics import split_chapter_segments
from academic_sync.cli import app
from academic_sync.db.session import session_scope
from academic_sync.models.domain import AcademicItem, ChapterTopic
from academic_sync.models.enums import ItemType

runner = CliRunner()


def _topic(label: str, **kw: object) -> ChapterTopic:
    return ChapterTopic(id="t", course_id="c", chapter_label=label, **kw)  # type: ignore[arg-type]


def test_filename_names_the_chapters_and_drops_date_ranges():
    topics = {"chapter-6": _topic("Chapter 6", title="Solutions")}
    segments = split_chapter_segments(
        "Chapter 4: Exponential and Logarithmic Functions (10/7 - 10/28); Chapter 6"
    )
    assert study_pdf.pdf_filename(segments, topics) == (
        "Ch 4 Exponential and Logarithmic Functions + Ch 6 Solutions.pdf"
    )


def test_filename_for_cumulative_review_week_is_a_range():
    segments = split_chapter_segments("; ".join(f"Chapter {n}" for n in range(1, 10)))
    assert study_pdf.pdf_filename(segments, {}) == "Ch 1-9 Review.pdf"


def test_filename_strips_characters_windows_rejects():
    segments = split_chapter_segments("Module 1: Introduction to Research: Finding the Conversation")
    assert study_pdf.pdf_filename(segments, {}) == (
        "Module 1 Introduction to Research Finding the Conversation.pdf"
    )


def test_vocab_terms_split_and_include_added_terms():
    topic = _topic("Chapter 5", vocabulary="pressure (P); Boyle's law, kinetic molecular theory",
                   added_vocabulary="vapor pressure")
    assert study_pdf.vocab_terms(topic) == [
        "pressure", "Boyle's law", "kinetic molecular theory", "vapor pressure",
    ]


def test_missing_terms_is_case_plural_and_markup_tolerant():
    text = "A #term[Coelom] forms ... both *protostomes* and deuterostome embryos. Boyle\u2019s Law."
    missing = study_pdf.missing_terms(
        text, ["coelom", "protostome", "deuterostomes", "Boyle's law", "blastopore"]
    )
    assert missing == ["blastopore"]


def _setup(tmp_path: Path) -> str:
    _isolated_db(tmp_path)
    course_id = _make_course(tmp_path)
    runner.invoke(app, ["chapter-topic-add", "--course", course_id, "--chapter", "Chapter 23",
                        "--vocabulary", "allele, genetic drift"])
    return _make_weekly_reading_item(tmp_path, course_id, "Chapter 23: Evolution of Populations")


def test_due_lists_banner_until_built_and_build_requires_every_term(tmp_path, monkeypatch):
    banner_id = _setup(tmp_path)
    monkeypatch.setattr(study_pdf, "WORK_ROOT", tmp_path / "work")
    monkeypatch.setattr(study_pdf, "default_output_dir", lambda: tmp_path / "out")

    due = runner.invoke(app, ["study-pdf-due", "--date", "2026-08-22"])
    bundles = json.loads(due.stdout)
    assert [b["banner_id"] for b in bundles] == [banner_id]
    assert bundles[0]["chapters"][0]["vocabulary_terms"] == ["allele", "genetic drift"]
    assert bundles[0]["output_path"].endswith("Ch 23 Evolution of Populations.pdf")

    source = Path(bundles[0]["source_path"])
    source.parent.mkdir(parents=True)
    source.write_text(
        '#import "template.typ": *\n'
        '#show: textbook.with(course: "BIO112", course-name: "Bio", title: "Ch 23", week: "Aug")\n'
        "= Chapter 23\nAn #term[allele] is a gene variant.\n",
        encoding="utf-8",
    )
    refused = runner.invoke(app, ["study-pdf-build", "--banner", banner_id])
    assert refused.exit_code == 1
    assert json.loads(refused.stdout)["missing"] == ["genetic drift"]

    source.write_text(source.read_text(encoding="utf-8") + "Genetic drift is chance.\n",
                      encoding="utf-8")
    built = runner.invoke(app, ["study-pdf-build", "--banner", banner_id])
    assert built.exit_code == 0, built.stdout
    result = json.loads(built.stdout)
    assert result["built"] is True and Path(result["output"]).is_file()

    # Built once -> never due again; a rebuild updates the same record.
    again = runner.invoke(app, ["study-pdf-due", "--date", "2026-08-22"])
    assert json.loads(again.stdout) == []
    runner.invoke(app, ["study-pdf-build", "--banner", banner_id])
    listed = json.loads(runner.invoke(app, ["study-pdf-list"]).stdout)
    assert len(listed) == 1 and listed[0]["chapters"] == ["Chapter 23"]


def test_skip_records_week_so_it_is_not_due(tmp_path):
    banner_id = _setup(tmp_path)
    runner.invoke(app, ["study-pdf-skip", "--banner", banner_id, "--reason", "already covered"])
    assert json.loads(runner.invoke(app, ["study-pdf-due", "--date", "2026-08-22"]).stdout) == []


def test_banner_outside_window_is_not_due(tmp_path):
    _setup(tmp_path)
    assert json.loads(runner.invoke(app, ["study-pdf-due", "--date", "2026-08-01"]).stdout) == []


def test_plot_refuses_scripts_outside_work_root(tmp_path):
    script = tmp_path / "evil.py"
    script.write_text("print('x')", encoding="utf-8")
    result = runner.invoke(app, ["study-pdf-plot", str(script)])
    assert result.exit_code == 1


@pytest.mark.parametrize("license_name,ok", [
    ("CC BY-SA 4.0", True), ("Public domain", True), ("CC0", True), ("Fair use", False), ("", False),
])
def test_commons_license_filter(license_name, ok):
    page = {"title": "File:X.png", "imageinfo": [{
        "thumburl": "https://upload.example/x.png",
        "extmetadata": {"LicenseShortName": {"value": license_name},
                        "Artist": {"value": "<a>Jane</a>"}},
    }]}
    info = study_pdf._image_info(page)
    assert (info is not None) is ok
    if info:
        assert info["credit"] == f"Jane, {license_name}, via Wikimedia Commons"

def test_week_includes_saved_chapters_the_lectures_teach(tmp_path):
    from academic_sync.db import repository
    from academic_sync.models.enums import ItemStatus

    banner_id = _setup(tmp_path)
    with session_scope() as session:
        banner = repository.get_academic_item(session, banner_id)
        assert banner is not None
        course_id = banner.course_id
    runner.invoke(app, ["chapter-topic-add", "--course", course_id, "--chapter", "Chapter 24",
                        "--vocabulary", "speciation"])
    with session_scope() as session:
        for title, ch in (("Chapter 24: Origin of Species, cont.", 24), ("Chapter 99: Nothing", 99)):
            repository.upsert_academic_item(session, AcademicItem(
                id=f"lec{ch}", course_id=course_id, item_type=ItemType.LECTURE, title=title,
                date=date(2026, 8, 26), status=ItemStatus.CLEAR, fingerprint=f"lec{ch}",
            ))
    with session_scope() as session:
        banner = repository.get_academic_item(session, banner_id)
        assert banner is not None
        segments = study_pdf.week_segments(session, banner)
        terms = study_pdf.week_terms(session, banner)
    # Chapter 99 has no saved topic, so it isn't pulled in.
    assert segments == [("Chapter 23", "Evolution of Populations"), ("Chapter 24", "Origin of Species")]
    assert "speciation" in terms
