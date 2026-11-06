from __future__ import annotations

import json
import os
from pathlib import Path

from typer.testing import CliRunner

from academic_sync.cli import app
from academic_sync.db import repository
from academic_sync.db.migrations import run_migrations
from academic_sync.db.session import get_engine, reset_engine_cache, session_scope

runner = CliRunner()


def _isolated_db(tmp_path: Path) -> None:
    reset_engine_cache()
    os.environ["ACADEMIC_SYNC_DB_PATH"] = str(tmp_path / "test.db")
    from academic_sync.config import clear_caches

    clear_caches()
    run_migrations(get_engine(f"sqlite:///{(tmp_path / 'test.db').as_posix()}"))


def _make_course(tmp_path: Path) -> str:
    add_result = runner.invoke(
        app, ["course", "add", "--code", "BIO112", "--name", "Bio", "--term", "Fall 2026"]
    )
    return add_result.stdout.strip().split("id=")[-1]


def _make_course_with_item(tmp_path: Path) -> str:
    add_result = runner.invoke(
        app, ["course", "add", "--code", "BIO112", "--name", "Bio", "--term", "Fall 2026"]
    )
    course_id = add_result.stdout.strip().split("id=")[-1]

    src = tmp_path / "quiz_list.txt"
    src.write_text("Online Quiz 1\nDue on Aug 30, 2026 23:59\n", encoding="utf-8")
    runner.invoke(app, ["extract", str(src), "--course", course_id, "--source-type", "d2l_quizzes"])

    with session_scope() as session:
        items = repository.list_items_for_course(session, course_id)
    assert items, "extraction should have produced at least one item"
    return items[0].id


def test_render_produces_summary_and_uncorrupted_fingerprint_tag(tmp_path):
    _isolated_db(tmp_path)
    item_id = _make_course_with_item(tmp_path)

    result = runner.invoke(app, ["render", item_id])
    assert result.exit_code == 0
    # Regression: Rich's console.print interprets "[...]" as its own markup
    # and will silently strip the fingerprint tag's brackets/content unless
    # the dynamic description text is escaped before printing -- this is
    # exactly the bug found and fixed in this command on 2026-08-18. Assert
    # the full, real tag text survives, not just that something printed.
    # (Whitespace normalized first -- Rich wraps long lines in captured
    # test output at a fixed column width, which could otherwise split the
    # tag text across a line break inside the assertion strings below.)
    normalized = " ".join(result.stdout.split())
    assert "[academic-sync:fp:" in normalized
    assert "<small>[academic-sync:fp:" in normalized
    assert "</small>" in normalized
    assert "<small>[academic-sync:fp:]</small>" not in normalized
    assert "<small></small>" not in normalized


def test_render_overrides_are_preview_only_without_save(tmp_path):
    _isolated_db(tmp_path)
    item_id = _make_course_with_item(tmp_path)

    result = runner.invoke(
        app, ["render", item_id, "--points", "25", "--details", "Preview only detail."]
    )
    assert result.exit_code == 0
    # Rich wraps long lines in the captured test output at a fixed column
    # width -- normalize whitespace before substring checks (same pattern
    # as the existing extract-versioning CLI tests).
    normalized = " ".join(result.stdout.split())
    # --points is still accepted/persistable (data capture didn't go away),
    # but no longer renders numerically -- see CLAUDE.md invariant 27.
    assert "25 pts" not in normalized
    assert "Preview only detail." in normalized

    with session_scope() as session:
        item = repository.get_academic_item(session, item_id)
    assert item.points is None
    assert item.is_optional is False


def test_render_with_save_persists_overrides(tmp_path):
    _isolated_db(tmp_path)
    item_id = _make_course_with_item(tmp_path)

    result = runner.invoke(
        app,
        [
            "render", item_id, "--points", "10", "--optional",
            "--reference-url", "https://example.com/a", "--reference-url-label", "Assignment",
            "--save",
        ],
    )
    assert result.exit_code == 0
    normalized = " ".join(result.stdout.split())
    # --optional now renders as the top-of-description UNGRADED tag, not a
    # numeric POINTS/STATUS line -- see CLAUDE.md invariant 27.
    assert "UNGRADED" in normalized
    assert "10 pts" not in normalized

    with session_scope() as session:
        item = repository.get_academic_item(session, item_id)
    assert item.points == 10
    assert item.is_optional is True
    assert item.reference_url == "https://example.com/a"
    assert item.reference_url_label == "Assignment"


def test_render_nesting_persists_via_module_label_and_defaults_next_time(tmp_path):
    # Regression: --nesting used to be render-time-only -- it was never
    # written to item.module_label (the actually-persisted nesting field),
    # so a later `render` call without --nesting silently dropped it even
    # though module_label is real DB state. See CLAUDE.md invariant 17.
    _isolated_db(tmp_path)
    item_id = _make_course_with_item(tmp_path)

    first = runner.invoke(
        app, ["render", item_id, "--nesting", "Week 3", "--save"]
    )
    assert first.exit_code == 0
    assert "Week 3" in " ".join(first.stdout.split())

    with session_scope() as session:
        item = repository.get_academic_item(session, item_id)
    assert item.module_label == "Week 3"

    second = runner.invoke(app, ["render", item_id])
    assert second.exit_code == 0
    assert "Week 3" in " ".join(second.stdout.split())


def test_render_inferred_date_requires_a_rule(tmp_path):
    _isolated_db(tmp_path)
    item_id = _make_course_with_item(tmp_path)

    result = runner.invoke(app, ["render", item_id, "--inferred-date", "--save"])
    assert result.exit_code == 1
    assert "requires --date-inference-rule" in result.stdout

    with session_scope() as session:
        item = repository.get_academic_item(session, item_id)
    assert item.is_inferred_date is False


def test_render_inferred_date_with_rule_persists_and_renders_tag(tmp_path):
    _isolated_db(tmp_path)
    item_id = _make_course_with_item(tmp_path)

    result = runner.invoke(
        app,
        [
            "render", item_id, "--inferred-date",
            "--date-inference-rule", "every quiz is due the Friday after its chapter",
            "--save",
        ],
    )
    assert result.exit_code == 0, result.stdout
    normalized = " ".join(result.stdout.split())
    assert "(Inferred Date)" in normalized
    # The rule text is for local audit only -- never rendered.
    assert "every quiz is due the Friday" not in normalized

    with session_scope() as session:
        item = repository.get_academic_item(session, item_id)
    assert item.is_inferred_date is True
    assert item.date_inference_rule == "every quiz is due the Friday after its chapter"


def test_render_unknown_item_errors(tmp_path):
    _isolated_db(tmp_path)
    _make_course_with_item(tmp_path)

    result = runner.invoke(app, ["render", "not-a-real-item-id"])
    assert result.exit_code == 1


def test_render_details_blocks_renders_labeled_sub_groups(tmp_path):
    _isolated_db(tmp_path)
    item_id = _make_course_with_item(tmp_path)

    blocks = (
        '[{"label": "Vocabulary", "text": "microevolution, genetic drift"}, '
        '{"label": "Objectives", "items": ["Explain X", "Distinguish Y"]}]'
    )
    result = runner.invoke(app, ["render", item_id, "--details-blocks", blocks])
    assert result.exit_code == 0
    normalized = " ".join(result.stdout.split())
    assert "<b>Vocabulary:</b> microevolution, genetic drift" in normalized
    assert "<b>Objectives:</b><br>• Explain X<br>• Distinguish Y" in normalized


def test_render_details_blocks_overrides_plain_details(tmp_path):
    _isolated_db(tmp_path)
    item_id = _make_course_with_item(tmp_path)

    result = runner.invoke(
        app,
        [
            "render", item_id,
            "--details", "This should be overridden.",
            "--details-blocks", '[{"text": "This should win."}]',
        ],
    )
    assert result.exit_code == 0
    normalized = " ".join(result.stdout.split())
    assert "This should win." in normalized
    assert "This should be overridden." not in normalized


def test_render_details_blocks_malformed_json_errors_cleanly(tmp_path):
    _isolated_db(tmp_path)
    item_id = _make_course_with_item(tmp_path)

    result = runner.invoke(app, ["render", item_id, "--details-blocks", "[not json"])
    assert result.exit_code == 1
    assert "not valid JSON" in result.stdout


def test_render_details_blocks_non_array_errors_cleanly(tmp_path):
    _isolated_db(tmp_path)
    item_id = _make_course_with_item(tmp_path)

    result = runner.invoke(app, ["render", item_id, "--details-blocks", '{"label": "x"}'])
    assert result.exit_code == 1
    assert "must be a JSON array" in result.stdout


def test_render_details_blocks_unknown_key_errors_cleanly(tmp_path):
    _isolated_db(tmp_path)
    item_id = _make_course_with_item(tmp_path)

    result = runner.invoke(app, ["render", item_id, "--details-blocks", '[{"foo": "bar"}]'])
    assert result.exit_code == 1


def _make_weekly_reading_item(tmp_path: Path, course_id: str, chapters: str) -> str:
    result = runner.invoke(
        app,
        [
            "weekly-reading-add", "--course", course_id,
            "--week-start", "2026-08-24", "--week-end", "2026-08-30",
            "--chapters", chapters,
        ],
    )
    assert result.exit_code == 0, result.stdout
    with session_scope() as session:
        items = repository.list_items_for_course(session, course_id)
    weekly = [i for i in items if i.title == chapters]
    assert weekly, f"expected a WEEKLY_READING item with title {chapters!r}"
    return weekly[0].id


def test_chapter_topic_add_is_idempotent_and_saves(tmp_path):
    _isolated_db(tmp_path)
    course_id = _make_course(tmp_path)

    first = runner.invoke(
        app,
        [
            "chapter-topic-add", "--course", course_id, "--chapter", "Chapter 23",
            "--title", "Evolution of Populations",
            "--vocabulary", "microevolution, genetic drift",
            "--objective", "Explain X", "--objective", "Distinguish Y",
        ],
    )
    assert first.exit_code == 0, first.stdout

    second = runner.invoke(
        app,
        [
            "chapter-topic-add", "--course", course_id, "--chapter", "chapter  23",
            "--objective", "Explain X", "--objective", "Distinguish Y", "--objective", "State Z",
        ],
    )
    assert second.exit_code == 0, second.stdout

    with session_scope() as session:
        topics = repository.list_chapter_topics_for_course(session, course_id)
    assert len(topics) == 1
    assert topics[0].objectives == ["Explain X", "Distinguish Y", "State Z"]


def test_chapter_topic_add_exhaustive_flag_defaults_false_and_persists_true(tmp_path):
    _isolated_db(tmp_path)
    course_id = _make_course(tmp_path)

    runner.invoke(
        app,
        [
            "chapter-topic-add", "--course", course_id, "--chapter", "Chapter 1",
            "--objective", "A",
        ],
    )
    with session_scope() as session:
        default_topic = repository.get_chapter_topic(session, course_id, "Chapter 1")
    assert default_topic is not None
    assert default_topic.is_exhaustive is False

    confirmed = runner.invoke(
        app,
        [
            "chapter-topic-add", "--course", course_id, "--chapter", "Chapter 2",
            "--objective", "A", "--exhaustive",
        ],
    )
    assert confirmed.exit_code == 0, confirmed.stdout
    with session_scope() as session:
        confirmed_topic = repository.get_chapter_topic(session, course_id, "Chapter 2")
    assert confirmed_topic is not None
    assert confirmed_topic.is_exhaustive is True


def test_render_weekly_reading_keeps_saved_topic_depth_off_banner(tmp_path):
    _isolated_db(tmp_path)
    course_id = _make_course(tmp_path)
    runner.invoke(
        app,
        [
            "chapter-topic-add", "--course", course_id, "--chapter", "Chapter 23",
            "--vocabulary", "microevolution, genetic drift",
            "--objective", "Explain the major processes that generate genetic variation",
        ],
    )
    item_id = _make_weekly_reading_item(
        tmp_path, course_id, "Chapter 23: Evolution of Populations; Chapter 26: Phylogeny and Classification"
    )

    result = runner.invoke(app, ["render", item_id])
    assert result.exit_code == 0
    normalized = " ".join(result.stdout.split())
    # Saved topic depth stays off the banner (links only, 2026-10-16) --
    # it feeds the weekly study PDF instead.
    assert "Chapter 23 — Evolution of Populations" in normalized
    assert "microevolution" not in normalized
    # Chapter 26 has no saved topic yet -- falls back to a bare header, not fabricated.
    assert "Chapter 26 — Phylogeny and Classification" in normalized


def test_weekly_reading_add_and_render_links_list(tmp_path):
    _isolated_db(tmp_path)
    course_id = _make_course(tmp_path)
    links_json = (
        '[{"label": "Lecture video - Ch 23", "url": "https://video.example/w2"},'
        ' {"label": "Textbook - Ch 23", "url": "https://textbook.example/ch23"},'
        ' {"label": "Course Syllabus", "url": "https://d2l.example/syllabus"}]'
    )
    add = runner.invoke(
        app,
        [
            "weekly-reading-add", "--course", course_id,
            "--week-start", "2026-08-24", "--week-end", "2026-08-30",
            "--chapters", "Chapter 23: Evolution of Populations",
            "--links", links_json,
        ],
    )
    assert add.exit_code == 0, add.stdout
    with session_scope() as session:
        items = repository.list_items_for_course(session, course_id)
    item_id = items[0].id

    result = runner.invoke(app, ["render", item_id, "--json"])
    assert result.exit_code == 0, result.stdout
    description = json.loads(result.stdout)["description"]
    assert '<a href="https://video.example/w2">Lecture video - Ch 23</a>' in description
    assert '<a href="https://textbook.example/ch23">Textbook - Ch 23</a>' in description
    # Syllabus link is dropped even though it was passed.
    assert "syllabus" not in description.lower()


def test_render_links_on_a_quiz_become_study_guides(tmp_path):
    _isolated_db(tmp_path)
    item_id = _make_course_with_item(tmp_path)  # an extracted online quiz

    result = runner.invoke(
        app,
        ["render", item_id, "--json", "--links", '[{"label": "Quiz 1 Study Guide", "url": "https://x.example"}]'],
    )
    assert result.exit_code == 0, result.stdout
    assert "Ignoring --links" not in result.stdout
    description = json.loads(result.stdout)["description"]
    assert '<b>STUDY GUIDES</b><br><a href="https://x.example">Quiz 1 Study Guide</a>' in description


def test_render_weekly_reading_falls_back_to_bare_topic_line_with_no_saved_topics(tmp_path):
    _isolated_db(tmp_path)
    course_id = _make_course(tmp_path)
    item_id = _make_weekly_reading_item(
        tmp_path, course_id, "Chapter 23: Evolution of Populations; Chapter 26: Phylogeny and Classification"
    )

    result = runner.invoke(app, ["render", item_id])
    assert result.exit_code == 0
    normalized = " ".join(result.stdout.split())
    # Nothing saved: READING still lists every chapter by name, no TOPIC DETAIL.
    assert "<b>Chapter 23 — Evolution of Populations</b>" in normalized
    assert "<b>Chapter 26 — Phylogeny and Classification</b>" in normalized
    assert "TOPIC DETAIL" not in normalized


def test_chapter_topic_reading_link_renders_in_banner(tmp_path):
    _isolated_db(tmp_path)
    course_id = _make_course(tmp_path)
    added = runner.invoke(
        app,
        [
            "chapter-topic-add", "--course", course_id, "--chapter", "Chapter 23",
            "--section", "23.1 Genetic Variation", "--section", "23.2 Hardy-Weinberg",
            "--reading-url", "https://ebook.example/ch23",
            "--reading-label", "Textbook — Ch 23 reading",
        ],
    )
    assert added.exit_code == 0, added.stdout
    # A later objectives-only pass must not blank the saved reading link/sections.
    runner.invoke(
        app,
        ["chapter-topic-add", "--course", course_id, "--chapter", "Chapter 23", "--objective", "A"],
    )
    item_id = _make_weekly_reading_item(tmp_path, course_id, "Chapter 23: Evolution of Populations")

    result = runner.invoke(app, ["render", item_id, "--json"])
    assert result.exit_code == 0, result.stdout
    description = json.loads(result.stdout)["description"]
    assert "Big topics" not in description  # banner is links only (2026-10-16)
    assert '→ <a href="https://ebook.example/ch23">Textbook — Ch 23 reading</a>' in description
    assert "• A" not in description


def test_links_rejects_unknown_kind(tmp_path):
    _isolated_db(tmp_path)
    course_id = _make_course(tmp_path)
    item_id = _make_weekly_reading_item(tmp_path, course_id, "Chapter 23: Evolution of Populations")
    result = runner.invoke(
        app, ["render", item_id, "--links", '[{"label": "X", "url": "https://x", "kind": "podcast"}]'],
    )
    assert result.exit_code == 1


def test_render_submission_url_saved_and_rendered(tmp_path):
    _isolated_db(tmp_path)
    item_id = _make_course_with_item(tmp_path)
    result = runner.invoke(
        app,
        ["render", item_id, "--submission-url", "https://d2l.example/dropbox/9", "--save", "--json"],
    )
    assert result.exit_code == 0, result.stdout
    description = json.loads(result.stdout)["description"]
    assert '<a href="https://d2l.example/dropbox/9">Submit Work</a>' in description
    with session_scope() as session:
        item = repository.get_academic_item(session, item_id)
    assert item is not None and item.submission_url == "https://d2l.example/dropbox/9"


def test_reading_link_only_pass_keeps_objectives_and_title(tmp_path):
    _isolated_db(tmp_path)
    course_id = _make_course(tmp_path)
    runner.invoke(app, ["chapter-topic-add", "--course", course_id, "--chapter", "Chapter 5",
                        "--title", "Gases", "--objective", "A", "--objective", "B", "--exhaustive"])
    runner.invoke(app, ["chapter-topic-add", "--course", course_id, "--chapter", "Chapter 5",
                        "--section", "5.1 The Gaseous State", "--reading-url", "https://tb.example/5"])
    with session_scope() as session:
        topic = repository.get_chapter_topic(session, course_id, "Chapter 5")
    assert topic is not None
    assert topic.title == "Gases" and topic.objectives == ["A", "B"] and topic.is_exhaustive
    assert topic.sections == ["5.1 The Gaseous State"] and topic.reading_url == "https://tb.example/5"


def test_render_colors_tests_yellow_by_default(tmp_path):
    # User-directed 2026-10-15 (CLAUDE.md invariant 40): every test --
    # exam, final, practical, quiz -- renders with assessment_color_id
    # (default 5 = yellow/Banana) instead of the school color.
    _isolated_db(tmp_path)
    item_id = _make_course_with_item(tmp_path)
    with session_scope() as session:
        assert repository.get_academic_item(session, item_id).item_type.is_assessment

    result = runner.invoke(app, ["render", item_id, "--json"])
    assert result.exit_code == 0
    assert json.loads(result.stdout)["colorId"] == "5"


def test_render_saves_covered_chapters_and_study_focus_for_a_test(tmp_path):
    _isolated_db(tmp_path)
    item_id = _make_course_with_item(tmp_path)
    result = runner.invoke(app, [
        "render", item_id, "--covered-chapters", '["Chapter 5"]',
        "--study-focus", '["Boyle\'s law"]', "--save", "--json",
    ])
    assert result.exit_code == 0
    assert "EXAM CONCEPTS" in json.loads(result.stdout)["description"]
    with session_scope() as session:
        stored = repository.get_academic_item(session, item_id)
    assert stored.covered_chapters == ["Chapter 5"]
    assert stored.study_focus == ["Boyle's law"]
