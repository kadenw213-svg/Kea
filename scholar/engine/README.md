# Kea Scholar engine (`academic_sync`)

The deterministic half of Kea Scholar's class scans: HTML/PDF parsing, date extraction, completeness
analysis, de-duplication and reconciliation, the study-PDF builder, and local storage (SQLite).

Kea copies this folder into each profile's workspace and runs it with `uv`. Claude Code, started by Kea
in the background with Kea's bundled skills, does the parts that need live browsing and judgment, and
calls this package's CLI (`uv run academic-sync ...`) for everything that must be exact and testable.

It comes from the Class Calendar Import project. `docs/invariants.md` keeps that project's design rules,
which the bundled skills follow.

```bash
uv sync --extra dev        # install
uv run pytest              # tests
uv run academic-sync --help
```
