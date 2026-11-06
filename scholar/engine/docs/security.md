# Security & privacy

## Credentials

- **D2L password**: never seen, never stored, never typed by this system.
  Login happens in the user's own visible Chrome tab; the `academic-import`
  skill waits for the user to complete it (including MFA) and never attempts
  to read, infer, or bypass it. See `docs/d2l_discovery.md`.
- **Google Calendar**: authorized once, outside this project, via Claude
  Code's own Google Calendar connector. This repo contains no OAuth client
  ID/secret, no token file, and no Google API client library dependency.
- **`.env`**: gitignored. The only secret-shaped value it could ever hold is
  `ACADEMIC_SYNC_LLM_API_KEY`, and only if the optional LLM extraction
  adapter is explicitly enabled (off by default -- see below).

## What never leaves the machine

Course documents (syllabi, handouts, D2L page text) are processed entirely
locally: deterministic parsing (`parsers/`), deterministic extraction
(`extraction/`), and local SQLite storage (`data/academic_sync.db`,
gitignored). No course content is sent to any third-party API by default.

The **only** integration point that could send course content off-machine
is an optional, not-yet-wired LLM-assisted extraction adapter
(`config/default.yaml: extraction.llm_assist_enabled`, default `false`). If
this is ever implemented and enabled, it must:

- Be opt-in only (explicit config change, not a default).
- Document exactly what text would be sent and to which provider, in this
  file, before shipping.
- Never be required for the core pipeline to function -- deterministic
  parsing must remain the default and primary path for explicit dates and
  structured data, per the original design brief.

As of this writing, no such adapter is implemented; `llm_assist_enabled`
exists as a config placeholder only.

## What's gitignored and why

See `.gitignore`. Notably:

- `data/*.db` -- the local database contains course schedules, assignment
  details, and instructor contact info extracted from your courses.
- `data/downloads/`, `data/logs/` -- downloaded course PDFs and run logs.
- `.env` -- see above.
- `.browser_state/`, `*.session.json` -- not currently used (no persisted
  browser session in this architecture), ignored defensively in case that
  ever changes.

## Logging

Structured logging (`config/default.yaml: logging`) writes to
`data/audit.log` (gitignored). The audit log
(`db.repository.log_audit_event`) records event types, summaries, and
minimal structured details (counts, IDs) -- it deliberately does not log
full assignment text or credentials. Don't add full-document logging to the
audit trail; if you need that level of detail for debugging, use a local,
gitignored debug log, not the audit table.

## Network integrations, enumerated

1. **Claude Code's Chrome browser control** -- navigates D2L pages using the
   user's own authenticated session. Standard browser traffic to the
   institution's D2L instance.
2. **Claude Code's Google Calendar connector** -- reads/writes events on the
   user's authorized Google account. No other Google API scope is used.
3. **Nothing else**, by default. No analytics, no telemetry, no third-party
   API calls from the Python package itself (check `pyproject.toml`'s
   dependency list if you want to verify this claim stays true -- none of
   `sqlalchemy`, `pydantic`, `typer`, `beautifulsoup4`, `lxml`, `pymupdf`,
   `python-dateutil`, `pyyaml`, or `rich` make outbound network calls).

## If you add a new network integration

Document it here, in this same enumerated list, before merging. State
plainly what data crosses the boundary and under what conditions (default-on
vs. opt-in).
