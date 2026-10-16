from __future__ import annotations

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


def _make_course_with_item(tmp_path: Path) -> tuple[str, str]:
    add_result = runner.invoke(
        app, ["course", "add", "--code", "BIO112", "--name", "Bio", "--term", "Fall 2026"]
    )
    course_id = add_result.stdout.strip().split("id=")[-1]

    src = tmp_path / "assignment.txt"
    src.write_text("Your Inner Fish\nDue on Sep 20, 2026 23:59\n", encoding="utf-8")
    runner.invoke(app, ["extract", str(src), "--course", course_id, "--source-type", "d2l_dropbox"])

    with session_scope() as session:
        items = repository.list_items_for_course(session, course_id)
    assert items, "extraction should have produced at least one item"
    return course_id, items[0].id


def test_resource_url_only_item_still_reports_missing_reference_url(tmp_path):
    """CLAUDE.md invariant 17 (amended): reference_url (the submission/
    turn-in link) and resource_url (supplementary material) are
    independently required -- a printout-only item (resource_url set,
    reference_url unset) must still surface as an unlinked gap, not be
    silently treated as complete."""
    _isolated_db(tmp_path)
    course_id, item_id = _make_course_with_item(tmp_path)

    render_result = runner.invoke(
        app,
        [
            "render",
            item_id,
            "--resource-url",
            "https://d2l.example/content/printout.pdf",
            "--resource-url-label",
            "Printout",
            "--save",
        ],
    )
    assert render_result.exit_code == 0

    with session_scope() as session:
        (item,) = [
            i for i in repository.list_items_for_course(session, course_id) if i.id == item_id
        ]
    assert item.resource_url is not None
    assert item.reference_url is None

    completeness_result = runner.invoke(app, ["completeness", "--course", course_id])
    assert completeness_result.exit_code == 0
    assert "missing a reference_url" in completeness_result.stdout
    assert "INCOMPLETE" in completeness_result.stdout
