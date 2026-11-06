from __future__ import annotations

import os
from pathlib import Path

from typer.testing import CliRunner

from academic_sync.cli import app
from academic_sync.db.migrations import run_migrations
from academic_sync.db.session import get_engine, reset_engine_cache

runner = CliRunner()


def _isolated_db(tmp_path: Path) -> None:
    reset_engine_cache()
    os.environ["ACADEMIC_SYNC_DB_PATH"] = str(tmp_path / "test.db")
    from academic_sync.config import clear_caches

    clear_caches()
    run_migrations(get_engine(f"sqlite:///{(tmp_path / 'test.db').as_posix()}"))


def test_reextracting_unchanged_content_skips_when_version_matches(tmp_path):
    _isolated_db(tmp_path)
    src = tmp_path / "quiz_list.txt"
    src.write_text("Online Quiz 1\nDue on Aug 30, 2026 23:59\n", encoding="utf-8")

    add_result = runner.invoke(
        app, ["course", "add", "--code", "BIO112", "--name", "Bio", "--term", "Fall 2026"]
    )
    course_id = add_result.stdout.strip().split("id=")[-1]

    first = runner.invoke(
        app, ["extract", str(src), "--course", course_id, "--source-type", "d2l_quizzes"]
    )
    assert "candidate item(s)" in first.stdout

    second = runner.invoke(
        app, ["extract", str(src), "--course", course_id, "--source-type", "d2l_quizzes"]
    )
    normalized = " ".join(second.stdout.split())
    assert "Skipping re-extraction" in normalized


def test_reextracting_after_pipeline_version_bump_reprocesses(tmp_path, monkeypatch):
    _isolated_db(tmp_path)
    src = tmp_path / "quiz_list.txt"
    src.write_text("Online Quiz 1\nDue on Aug 30, 2026 23:59\n", encoding="utf-8")

    add_result = runner.invoke(
        app, ["course", "add", "--code", "BIO112", "--name", "Bio", "--term", "Fall 2026"]
    )
    course_id = add_result.stdout.strip().split("id=")[-1]

    first = runner.invoke(
        app, ["extract", str(src), "--course", course_id, "--source-type", "d2l_quizzes"]
    )
    assert "candidate item(s)" in first.stdout

    monkeypatch.setattr("academic_sync.cli.EXTRACTION_VERSION", "9999.0.0")
    second = runner.invoke(
        app, ["extract", str(src), "--course", course_id, "--source-type", "d2l_quizzes"]
    )
    normalized = " ".join(second.stdout.split())
    assert "reprocessing" in normalized
    assert "Skipping re-extraction" not in normalized

    # Regression: two Source rows now share this content_hash (one per
    # pipeline version). A third run at the same (bumped) version must find
    # the latest one and skip cleanly, not crash with MultipleResultsFound.
    third = runner.invoke(
        app, ["extract", str(src), "--course", course_id, "--source-type", "d2l_quizzes"]
    )
    assert third.exit_code == 0
    normalized_third = " ".join(third.stdout.split())
    assert "Skipping re-extraction" in normalized_third
