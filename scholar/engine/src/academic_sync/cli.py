"""CLI entry point.

This CLI is the deterministic half of the system: parsing, extraction,
completeness, reconciliation, preferences, and the local database. It does
not talk to D2L or Google Calendar on its own -- see README.md and
docs/architecture.md for why that's handled live by the academic-import
skill instead. `plan`/`sync` here operate purely on already-ingested local
state.
"""

from __future__ import annotations

import json
import uuid
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Annotated

import typer
from pydantic import ValidationError
from rich.console import Console
from rich.markup import escape
from rich.table import Table

from academic_sync import completeness as completeness_mod
from academic_sync import diagnostics as diagnostics_mod
from academic_sync import digest as digest_mod
from academic_sync import enrollments as enrollments_mod
from academic_sync import preferences as prefs_mod
from academic_sync import study_pdf as study_pdf_mod
from academic_sync.chapter_topics import (
    canonicalize_chapter_label,
    split_chapter_segments,
)
from academic_sync.config import REPO_ROOT, get_config
from academic_sync.db import repository
from academic_sync.db.migrations import run_migrations
from academic_sync.db.session import get_engine, session_scope
from academic_sync.extraction.pipeline import (
    EXTRACTION_VERSION,
    ExtractionContext,
    extract_from_document,
)
from academic_sync.models.domain import (
    PORTAL_LINK_KINDS,
    WEEKLY_LINK_KINDS,
    AcademicItem,
    ChapterTopic,
    Course,
    CourseGradeSnapshot,
    CoursePortalLink,
    GradeSnapshot,
    Source,
    UnresolvedReference,
    WeeklyLink,
)
from academic_sync.models.enums import (
    CourseStatus,
    DiagnosticStatus,
    ItemStatus,
    ItemType,
    SourceType,
    SyncAction,
    UnresolvedReferenceKind,
)
from academic_sync.parsers.base import ParsedDocument
from academic_sync.parsers.html_parser import parse_html
from academic_sync.parsers.pdf_parser import parse_pdf
from academic_sync.reconciliation.engine import snapshot_compared_fields
from academic_sync.reconciliation.fingerprint import compute_fingerprint
from academic_sync.reporting.formatters import (
    format_completeness_report,
    format_course_export,
    format_plan_detail,
    format_plan_summary,
    format_unresolved,
)
from academic_sync.sync.calendar_payload import (
    DetailsBlock,
    DiagnosticAssignment,
    DiagnosticCourseSection,
    LocationInfo,
    build_deadline_description,
    build_event_payload,
    build_meeting_description,
    build_weekly_diagnostic_description,
    build_weekly_diagnostic_payload,
    build_weekly_reading_description,
    format_details_blocks,
    platform_label_for_source,
)
from academic_sync.sync.email_payload import build_daily_overview_email
from academic_sync.sync.planner import compute_plan

app = typer.Typer(help="academic-sync: D2L -> normalized academic model -> Google Calendar.")
course_app = typer.Typer(help="Manage known courses.")
prefs_app = typer.Typer(help="Manage reusable preferences.")
app.add_typer(course_app, name="course")
app.add_typer(prefs_app, name="prefs")

console = Console()


# --------------------------------------------------------------------------
# db
# --------------------------------------------------------------------------

@app.command("db-init")
def db_init() -> None:
    """Create/upgrade the local SQLite database."""
    version = run_migrations(get_engine())
    console.print(f"[green]Database ready.[/green] Schema version {version}.")


# --------------------------------------------------------------------------
# courses
# --------------------------------------------------------------------------

@course_app.command("add")
def course_add(
    code: Annotated[str, typer.Option("--code")],
    name: Annotated[str, typer.Option("--name")],
    term: Annotated[str, typer.Option("--term")],
    section: Annotated[str | None, typer.Option("--section")] = None,
    instructor: Annotated[str | None, typer.Option("--instructor")] = None,
    instructor_contact: Annotated[str | None, typer.Option("--instructor-contact")] = None,
    campus: Annotated[str | None, typer.Option("--campus")] = None,
    start: Annotated[str | None, typer.Option("--start", help="YYYY-MM-DD")] = None,
    end: Annotated[str | None, typer.Option("--end", help="YYYY-MM-DD")] = None,
    d2l_id: Annotated[str | None, typer.Option("--d2l-id")] = None,
    d2l_url: Annotated[str | None, typer.Option("--d2l-url")] = None,
    delivery: Annotated[str | None, typer.Option("--delivery")] = None,
    synthetic: Annotated[
        bool,
        typer.Option(
            "--synthetic",
            help="Flag this as a self-directed, fully AI-authored curriculum with no real "
            "D2L/instructor source -- see CLAUDE.md invariant 35 and "
            ".claude/skills/custom-curriculum/SKILL.md. Never set this for a real scraped "
            "course.",
        ),
    ] = False,
) -> None:
    """Register a course discovered during D2L scanning."""
    course = Course(
        id=uuid.uuid4().hex,
        course_code=code,
        section=section,
        name=name,
        term=term,
        instructor=instructor,
        instructor_contact=instructor_contact,
        campus=campus,
        start_date=date.fromisoformat(start) if start else None,
        end_date=date.fromisoformat(end) if end else None,
        d2l_identifier=d2l_id,
        d2l_url=d2l_url,
        delivery_format=delivery,
        status=CourseStatus.ACTIVE,
        is_synthetic=synthetic,
    )
    with session_scope() as session:
        row = repository.upsert_course(session, course)
        repository.log_audit_event(
            session, event_type="course_registered", course_id=row.id,
            summary=f"Registered {code} ({term})",
        )
    console.print(f"[green]Course registered.[/green] id={row.id}")


@app.command("courses")
def list_courses_cmd(term: Annotated[str | None, typer.Option("--term")] = None) -> None:
    with session_scope() as session:
        courses = repository.list_courses(session, term=term)
    if not courses:
        console.print("No courses registered yet. Use `academic-sync course add`.")
        return
    table = Table(show_header=True)
    for col in ["id", "code", "section", "name", "term", "status", "synthetic"]:
        table.add_column(col)
    for c in courses:
        table.add_row(
            c.id[:8], c.course_code, c.section or "-", c.name, c.term, c.status.value,
            "yes" if c.is_synthetic else "-",
        )
    console.print(table)


# --------------------------------------------------------------------------
# extract
# --------------------------------------------------------------------------

def _strip_get_page_text_header(text: str) -> tuple[str, str | None]:
    """Strip claude-in-chrome's get_page_text metadata header if present.

    That tool prefixes its output with `Title: ...` / `URL: ...` /
    `Source element: ...` lines followed by a bare `---` separator before
    the actual page content. If the academic-import skill saves that raw
    output straight to a scratch file for `extract`, the title line (e.g.
    "Title: Quiz List - BIO1112...") would otherwise get classified as an
    obligation with no date on every single course scan -- a real,
    recurring false positive, not a one-off. Leaves text untouched if the
    header shape isn't present.
    """
    lines = text.splitlines()
    if not lines or not lines[0].startswith("Title:"):
        return text, None
    title = lines[0][len("Title:") :].strip()
    for i, line in enumerate(lines[1:6], start=1):
        if line.strip() == "---":
            return "\n".join(lines[i + 1 :]), title
    return text, None


def _load_document(path: Path, title: str | None) -> ParsedDocument:
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        return parse_pdf(str(path), base_title=title)
    if suffix in (".html", ".htm"):
        return parse_html(path.read_text(encoding="utf-8", errors="replace"), base_title=title)
    text = path.read_text(encoding="utf-8", errors="replace")
    cleaned_text, extracted_title = _strip_get_page_text_header(text)
    return ParsedDocument(text=cleaned_text, title=title or extracted_title)


@app.command("extract")
def extract_cmd(
    path: Annotated[Path, typer.Argument(exists=True)],
    course: Annotated[str, typer.Option("--course", help="Course id")],
    source_type: Annotated[SourceType, typer.Option("--source-type")],
    title: Annotated[str | None, typer.Option("--title")] = None,
    url: Annotated[str | None, typer.Option("--url")] = None,
    tentative: Annotated[bool, typer.Option("--tentative")] = False,
    allow_bare_dates: Annotated[
        bool,
        typer.Option(
            "--allow-bare-dates",
            help="Also match year-less M/D dates (e.g. '8/17') using the course's "
            "reference year. Only use for sources you know are a dated grid/calendar "
            "for this course -- bare M/D is ambiguous in general prose.",
        ),
    ] = False,
) -> None:
    """Parse + extract one downloaded file (syllabus PDF, D2L page dump, etc.)
    into candidate academic items, and store them.

    Computes a plan (CREATE/UPDATE/UNCHANGED/...) against whatever was
    already stored under the same fingerprints *before* writing the new
    extraction, so a revised source correctly produces UPDATEs rather than
    silently overwriting history.
    """
    with session_scope() as session:
        resolved_course_id = repository.resolve_course_id(session, course)
        if resolved_course_id is None:
            console.print(f"[red]No such course id: {course}[/red]")
            raise typer.Exit(1)
        course = resolved_course_id
        course_obj = repository.get_course(session, course)
        if course_obj is None:
            console.print(f"[red]No such course id: {course}[/red]")
            raise typer.Exit(1)

        document = _load_document(path, title or path.name)
        content_hash = document.content_hash
        # Combines the raw parser version with the extraction pipeline
        # version so a code fix to either one invalidates the dedup check --
        # otherwise re-running `extract` on unchanged content after a
        # pipeline bug fix would silently keep the old (wrong) extraction.
        processing_version = f"{document.parser_version}+{EXTRACTION_VERSION}"

        existing_source = repository.find_source_by_hash(session, course, content_hash)
        if existing_source is not None and existing_source.parser_version == processing_version:
            console.print(
                f"[yellow]Identical content already ingested and processed with the current "
                f"pipeline version as source {existing_source.id[:8]} "
                f"({existing_source.retrieved_at}). Skipping re-extraction.[/yellow]"
            )
            return
        if existing_source is not None:
            console.print(
                f"[yellow]Content unchanged since source {existing_source.id[:8]}, but the "
                "extraction pipeline has changed since then -- reprocessing.[/yellow]"
            )

        source = Source(
            id=uuid.uuid4().hex,
            course_id=course,
            source_type=source_type,
            title=title or path.name,
            url=url,
            local_path=str(path),
            retrieved_at=datetime.now(UTC),
            content_hash=content_hash,
            parser_version=processing_version,
            extracted_at=datetime.now(UTC),
            is_tentative=tentative,
        )
        source_row = repository.add_source(session, source, raw_text=document.text)

        config = get_config()
        reference_year = (
            course_obj.start_date.year if course_obj.start_date else datetime.now().year
        )
        stored_default_due = repository.get_preference(
            session, "default_due_time", default=config.deadlines.default_due_time
        )
        default_due_time = _parse_time(str(stored_default_due))
        ctx = ExtractionContext(
            course_id=course,
            source_id=source_row.id,
            reference_year=reference_year,
            term_start=course_obj.start_date,
            term_end=course_obj.end_date,
            default_due_time=default_due_time,
            reference_phrases=config.completeness.reference_phrases,
            is_tentative=tentative,
            allow_bare_dates=allow_bare_dates,
        )
        result = extract_from_document(document, ctx)

        plan = compute_plan(session, course, result.items)
        console.print(format_plan_summary(course, plan.entries))

        for item in result.items:
            repository.upsert_academic_item(session, item)
        for ref in result.unresolved:
            repository.add_unresolved_reference(session, ref)

        repository.log_audit_event(
            session,
            event_type="source_extracted",
            course_id=course,
            source_id=source_row.id,
            summary=f"Extracted {len(result.items)} item(s), "
            f"{len(result.unresolved)} unresolved reference(s) from {source.title}",
            details={"item_count": len(result.items), "unresolved_count": len(result.unresolved)},
        )

    console.print(
        f"[green]Done.[/green] {len(result.items)} candidate item(s), "
        f"{len(result.unresolved)} unresolved reference(s)."
    )


def _parse_time(value: str):
    from datetime import time

    hh, mm = value.split(":")
    return time(int(hh), int(mm))


# --------------------------------------------------------------------------
# completeness / unresolved / plan / audit / status
# --------------------------------------------------------------------------

def _resolve_course_or_exit(session, course_id: str) -> Course:
    """Accept either a full course id or the truncated 8-char prefix shown
    by `academic-sync courses`. Exits with a clear error instead of letting
    callers silently filter on an id that matches nothing."""
    resolved = repository.resolve_course_id(session, course_id)
    course = repository.get_course(session, resolved) if resolved else None
    if course is None:
        console.print(
            f"[red]No course found matching '{course_id}'.[/red] "
            "Run `academic-sync courses` to see valid ids."
        )
        raise typer.Exit(code=1)
    return course


@app.command("completeness")
def completeness_cmd(course: Annotated[str | None, typer.Option("--course")] = None) -> None:
    with session_scope() as session:
        courses = [_resolve_course_or_exit(session, course)] if course else repository.list_courses(session)
        for c in courses:
            sources = repository.list_sources_for_course(session, c.id)
            items = repository.list_items_for_course(session, c.id)
            unresolved = repository.list_unresolved_references(session, c.id)
            # A course "has modules" once any item was actually given a
            # module_label -- proof that per-chapter/per-module content
            # pages exist and are reachable in D2L, not just that they
            # might. Only then does a dated item lacking one count as a
            # gap (see CLAUDE.md invariant 17 / d2l_discovery.md#required-finds).
            course_has_modules = any(i.module_label for i in items)
            synced_or_clear = {ItemStatus.CLEAR, ItemStatus.SYNCED}
            unnested_item_count = (
                sum(
                    1 for i in items
                    if i.date is not None and i.status in synced_or_clear and not i.module_label
                )
                if course_has_modules else 0
            )
            # CLAUDE.md invariant 17 (amended): reference_url (the
            # submission/turn-in link) and resource_url (supplementary
            # material, e.g. a printout) are independently required where
            # applicable, not either/or -- an item with only a resource_url
            # still hasn't had its actual turn-in location captured.
            unlinked_item_count = sum(
                1 for i in items
                if i.date is not None and i.status in synced_or_clear
                and (i.item_type.is_deadline or i.item_type in (ItemType.EXAM, ItemType.FINAL_EXAM))
                and not i.reference_url
            )
            # CLAUDE.md invariant 26: every chapter/unit this course's
            # weekly reading blocks reference must have a saved
            # ChapterTopic row -- collect the referenced labels from every
            # WEEKLY_READING item's title (same "Chapter N: Topic; ..."
            # shape chapter_topics.split_chapter_segments already parses),
            # subtract what's actually been saved.
            known_chapter_labels = {
                canonicalize_chapter_label(label)
                for i in items if i.item_type == ItemType.WEEKLY_READING
                for label, _text in split_chapter_segments(i.title)
                if label is not None
            }
            saved_chapter_topics = repository.list_chapter_topics_for_course(session, c.id)
            saved_chapter_labels = {
                canonicalize_chapter_label(t.chapter_label) for t in saved_chapter_topics
            }
            missing_chapter_topic_count = len(known_chapter_labels - saved_chapter_labels)
            # CLAUDE.md invariant 26: a saved row isn't enough on its own --
            # it also has to be confirmed exhaustive (real complete/stable
            # structure, not a sample or an adaptive "what's next" view).
            # A row the course doesn't actually reference doesn't count
            # against it either way.
            partial_chapter_topic_count = sum(
                1 for t in saved_chapter_topics
                if canonicalize_chapter_label(t.chapter_label) in known_chapter_labels
                and not t.is_exhaustive
            )
            report = completeness_mod.analyze_completeness(
                c.id,
                inspected_source_types={s.source_type for s in sources},
                unresolved_references=unresolved,
                conflicting_date_count=sum(1 for i in items if i.status == ItemStatus.CONFLICTED),
                undated_graded_work_count=sum(
                    1 for i in items if i.status == ItemStatus.UNRESOLVED and i.item_type.is_deadline
                ),
                unnested_item_count=unnested_item_count,
                unlinked_item_count=unlinked_item_count,
                missing_chapter_topic_count=missing_chapter_topic_count,
                partial_chapter_topic_count=partial_chapter_topic_count,
                is_synthetic=c.is_synthetic,
            )
            console.print(f"\n[bold]{c.course_code} {c.section or ''} -- {c.name}[/bold]")
            console.print(format_completeness_report(report))


@app.command("unresolved")
def unresolved_cmd(
    course: Annotated[str | None, typer.Option("--course")] = None,
    show_all: Annotated[bool, typer.Option("--all")] = False,
) -> None:
    with session_scope() as session:
        resolved_course_id = _resolve_course_or_exit(session, course).id if course else None
        refs = repository.list_unresolved_references(session, course_id=resolved_course_id)
    limit = len(refs) if show_all else 20
    console.print(format_unresolved(refs, limit=limit))


@app.command("unresolved-add")
def unresolved_add_cmd(
    course: Annotated[str, typer.Option("--course")],
    description: Annotated[str, typer.Option("--description")],
    kind: Annotated[
        str,
        typer.Option(
            "--kind",
            help=f"One of: {', '.join(k.value for k in UnresolvedReferenceKind)}. "
            "Use external_reference_uninspected for a shell link off the LMS's own "
            "domain that hasn't been opened/verified yet -- see "
            "docs/d2l_discovery.md's external-courseware section.",
        ),
    ] = UnresolvedReferenceKind.EXTERNAL_REFERENCE_UNINSPECTED.value,
    source_wording: Annotated[str | None, typer.Option("--source-wording")] = None,
) -> None:
    """Record a live discovery finding that isn't something the deterministic
    `extract` pipeline can see on its own -- most commonly: "this course's
    shell has a link/nav item leaving the LMS's own domain, and the
    surrounding text/context says real assignment content is behind it, but
    it hasn't been opened and crawled yet." Recognizing that link is a live
    judgment call made while browsing (a name list of known platforms would
    just recreate the same blind spot for the next unlisted one -- see
    CLAUDE.md); this command is how that judgment call gets turned into
    something `completeness` can actually gate on, instead of depending on
    a session remembering to mention it. Cleared automatically once a
    Source is later added whose title matches --source-wording (see
    db.repository.add_source), or manually via `unresolved-resolve`.
    """
    try:
        kind_enum = UnresolvedReferenceKind(kind)
    except ValueError:
        console.print(f"[red]Unknown kind: {kind}[/red]")
        raise typer.Exit(1) from None
    with session_scope() as session:
        resolved_course_id = _resolve_course_or_exit(session, course).id
        ref = UnresolvedReference(
            id=uuid.uuid4().hex,
            course_id=resolved_course_id,
            kind=kind_enum,
            description=description,
            source_wording=source_wording,
        )
        repository.add_unresolved_reference(session, ref)
        console.print(f"[green]Recorded[/green] unresolved reference {ref.id} for {course}.")


@app.command("unresolved-resolve")
def unresolved_resolve_cmd(
    reference_id: Annotated[str, typer.Argument()],
    note: Annotated[str, typer.Option("--note")],
) -> None:
    """Mark one unresolved reference resolved, with a note explaining what
    was actually found -- use after live discovery opens a flagged link and
    determines what it is (a real courseware source worth crawling, or just
    a supplementary/marketing page that doesn't need tracking). See
    `unresolved-add`."""
    with session_scope() as session:
        ok = repository.resolve_unresolved_reference(session, reference_id, note)
    if not ok:
        console.print(f"[red]No open unresolved reference with id {reference_id}.[/red]")
        raise typer.Exit(1)
    console.print(f"[green]Resolved[/green] {reference_id}: {note}")


_WEEKLY_LINKS_HELP = (
    'JSON array of this item\'s real resource links, e.g. '
    '\'[{"label": "Lecture Slides - Ch 23", "url": "https://...", "kind": "slides"}, '
    '{"label": "Handout: Hardy-Weinberg Practice", "url": "https://...", "kind": "handout"}, '
    '{"label": "Textbook - Ch 23", "url": "https://...", "kind": "textbook", '
    '"chapter": "Chapter 23"}]\'. Optional "kind" is one of textbook/slides/video/'
    "handout/platform/other (a banner renders textbook links under READING and "
    "the rest under SLIDES & RESOURCES; unset kinds are classified from the "
    'label); optional "chapter" ties a textbook link to its chapter. Add whatever '
    "discovery actually found -- for a weekly banner: that week's video / "
    "slide deck / textbook reading; for a lecture: that session's own "
    "slides / handout / in-class activity / professor recording / "
    "textbook chapter -- and omit what it didn't. NEVER a syllabus link "
    "(see CLAUDE.md invariant 25). Replaces reference_url/resource_url on "
    "the LINKS line when given. WEEKLY_READING and lecture/lab meeting "
    "items only (deadline-type items keep the two fixed URL slots)."
)


def _parse_str_list(raw: str, option: str) -> list[str]:
    """Parse a JSON array of strings (e.g. `render --covered-chapters`),
    exiting with a clear message on malformed input."""
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        console.print(f"[red]{option} is not valid JSON: {exc}[/red]")
        raise typer.Exit(1) from None
    if not isinstance(parsed, list) or not all(isinstance(v, str) for v in parsed):
        console.print(f"[red]{option} must be a JSON array of strings.[/red]")
        raise typer.Exit(1)
    return [v.strip() for v in parsed if v.strip()]


def _parse_weekly_links(raw: str | None) -> list[WeeklyLink]:
    """Parse a `--links` JSON-array string into WeeklyLink objects, exiting
    with a clear message on malformed input -- same error-handling shape
    as `render --details-blocks`."""
    if raw is None:
        return []
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        console.print(f"[red]--links is not valid JSON: {exc}[/red]")
        raise typer.Exit(1) from None
    if not isinstance(parsed, list):
        console.print("[red]--links must be a JSON array of {label, url} objects.[/red]")
        raise typer.Exit(1)
    try:
        result = [WeeklyLink(**obj) for obj in parsed]
    except (TypeError, ValidationError) as exc:
        console.print(f"[red]--links: {exc}[/red]")
        raise typer.Exit(1) from None
    for link in result:
        if link.kind is not None and link.kind not in WEEKLY_LINK_KINDS:
            console.print(
                f"[red]--links: kind {link.kind!r} must be one of "
                f"{', '.join(WEEKLY_LINK_KINDS)}.[/red]"
            )
            raise typer.Exit(1)
    return result


@app.command("weekly-reading-add")
def weekly_reading_add_cmd(
    course: Annotated[str, typer.Option("--course")],
    week_start: Annotated[
        str, typer.Option("--week-start", help="YYYY-MM-DD, the first day of the reading week.")
    ],
    week_end: Annotated[
        str,
        typer.Option(
            "--week-end", help="YYYY-MM-DD, the last day of the reading week (inclusive)."
        ),
    ],
    chapters: Annotated[
        str,
        typer.Option(
            "--chapters",
            help='The week\'s chapter/topic content, e.g. "Chapter 12: Cellular '
            'Respiration; Chapter 13: Photosynthesis" -- the same "Chapter N: Topic" '
            "shape a multi-chapter lecture title already uses, semicolon-separated. "
            "Must trace to real instructor material (module page, syllabus topic "
            "table, etc.) -- never a generated paraphrase, see CLAUDE.md invariant 22. "
            "For a --synthetic course, this is instead a short, AI-authored topic/pacing "
            "label -- see CLAUDE.md invariant 35.",
        ),
    ],
    reference_url: Annotated[str | None, typer.Option("--reference-url")] = None,
    reference_url_label: Annotated[str | None, typer.Option("--reference-url-label")] = None,
    resource_url: Annotated[str | None, typer.Option("--resource-url")] = None,
    resource_url_label: Annotated[str | None, typer.Option("--resource-url-label")] = None,
    links: Annotated[str | None, typer.Option("--links", help=_WEEKLY_LINKS_HELP)] = None,
) -> None:
    """Create or refresh a course's weekly reading block -- one all-day event
    spanning [--week-start, --week-end] that's a heads-up of everything that
    class will cover that week (see CLAUDE.md invariant 25 and
    docs/d2l_discovery.md's weekly-reading section). This replaces the old
    per-day standalone READING event entirely -- a plain READING item can no
    longer sync as its own event (sync/calendar_payload.py raises for it).

    Week boundaries must trace to real D2L module start/stop metadata or a
    syllabus week<->topic table -- never assumed Mon-Sun. Idempotent by
    (course, week-start): re-running this for the same week updates the same
    item instead of creating a duplicate (same fingerprint mechanism as
    every other item type -- see reconciliation/fingerprint.py).

    After this, run `render <item_id> --details "..."` to get the exact
    Calendar payload -- `--details` is where any real, source-stated
    internal pacing (e.g. "Ch. 12 by Wednesday, Ch. 13 by Friday") goes,
    same never-persisted, supplied-at-render-time convention `render`
    already uses for a lecture's DETAILS; omit it entirely when the source
    doesn't differentiate timing within the week. Then
    create_event/update_event + `record-sync`, same Step 5 flow as any
    other item.
    """
    with session_scope() as session:
        resolved_course_id = _resolve_course_or_exit(session, course).id
        start = date.fromisoformat(week_start)
        end = date.fromisoformat(week_end)
        if end < start:
            console.print("[red]--week-end is before --week-start.[/red]")
            raise typer.Exit(1)
        weekly_links = _parse_weekly_links(links)

        fingerprint = compute_fingerprint(
            resolved_course_id,
            ItemType.WEEKLY_READING.value,
            "Readings",
            disambiguator=start.isoformat(),
        )
        item = AcademicItem(
            id=uuid.uuid4().hex,
            course_id=resolved_course_id,
            item_type=ItemType.WEEKLY_READING,
            title=chapters,
            date=start,
            date_range_end=end,
            status=ItemStatus.CLEAR,
            is_derived=True,
            derivation_rule="weekly_reading_aggregation",
            reference_url=reference_url,
            reference_url_label=reference_url_label,
            resource_url=resource_url,
            resource_url_label=resource_url_label,
            weekly_links=weekly_links,
            fingerprint=fingerprint,
        )

        plan = compute_plan(session, resolved_course_id, [item])
        console.print(format_plan_summary(resolved_course_id, plan.entries))

        row = repository.upsert_academic_item(session, item)
        console.print(f"[green]Saved[/green] weekly reading block {row.id} for {course}.")


@app.command("chapter-topic-add")
def chapter_topic_add_cmd(
    course: Annotated[str, typer.Option("--course")],
    chapter: Annotated[
        str, typer.Option("--chapter", help='e.g. "Chapter 23" or "Unit 2" -- the same '
                           '"Chapter N"/"Unit N" label a weekly reading block\'s --chapters '
                           "or a lecture's multi-chapter title uses. This is the lookup key "
                           "(canonicalized) render auto-pulls from for a weekly banner's "
                           "THIS WEEK content -- see CLAUDE.md invariant 26."),
    ],
    title: Annotated[str | None, typer.Option("--title", help='e.g. "Evolution of Populations"')] = None,
    vocabulary: Annotated[
        str | None,
        typer.Option("--vocabulary", help="Comma-separated real vocabulary terms from the "
                     "course's own chapter objectives/study-guide material."),
    ] = None,
    objective: Annotated[
        list[str] | None,
        typer.Option("--objective", help="Repeatable -- one real objective per flag, e.g. "
                     '--objective "Explain X" --objective "Distinguish Y". Every value must '
                     "trace to real instructor-authored material -- never a generated "
                     "summary (CLAUDE.md invariant 22). Must be the platform's real, complete "
                     "topic/subtopic list, not a representative sample -- see CLAUDE.md "
                     "invariant 26."),
    ] = None,
    exhaustive: Annotated[
        bool,
        typer.Option("--exhaustive", help="Set only once you've actually confirmed this is the "
                     "platform's real, complete, stable topic list for this chapter -- e.g. "
                     "ALEKS's own \"View All Topics\" view, not its personalized \"Ready to "
                     "Learn\" queue. Leave unset (default False) if capture might still be "
                     "partial or was pulled from an adaptive/progress-dependent view -- "
                     "`completeness` flags unconfirmed rows separately from missing ones "
                     "(`partial_chapter_topic_count`) so they get revisited."),
    ] = False,
    section: Annotated[
        list[str] | None,
        typer.Option("--section", help="Repeatable -- one real section heading per flag, "
                     'e.g. --section "23.1 Genetic Variation" --section "23.2 Hardy-Weinberg". '
                     "Rendered as the short 'Big topics' line under the chapter in a weekly "
                     "banner's READING section. Must be the source's own structure (textbook "
                     "section titles, module sub-headings) -- never a generated summary."),
    ] = None,
    reading_url: Annotated[
        str | None,
        typer.Option("--reading-url", help="The chapter-specific reading link (eBook chapter "
                     "page, OpenStax chapter, D2L content topic) -- opened and confirmed "
                     "stable during discovery, never constructed. Every banner covering this "
                     "chapter links it under READING."),
    ] = None,
    reading_label: Annotated[
        str | None,
        typer.Option("--reading-label", help='e.g. "Textbook — Ch 23 reading".'),
    ] = None,
    added_vocab: Annotated[
        str | None,
        typer.Option("--added-vocab", help="Comma-separated terms Claude adds where the real "
                     "material doesn't cover a section -- rendered in a separate block labeled "
                     "'Added (not from instructor)'. CLAUDE.md invariant 40."),
    ] = None,
    added_objective: Annotated[
        list[str] | None,
        typer.Option("--added-objective", help="Repeatable -- a concept Claude adds to fill a "
                     "real gap; same visible label as --added-vocab."),
    ] = None,
) -> None:
    """Save (or refresh) a course's real chapter/unit topic breakdown --
    the durable source of truth `render` auto-pulls from for a weekly
    reading block's THIS WEEK content, and (going forward) a lecture's own
    DETAILS, instead of hand-typed content that only ever lived in one
    Calendar event's description. Required during a full course scan for
    every chapter/unit the course has, not just ones near a current dated
    item -- see CLAUDE.md invariant 26 and docs/d2l_discovery.md's
    required-finds. Idempotent by (course, chapter label): re-running this
    for the same chapter updates the same row instead of duplicating."""
    with session_scope() as session:
        resolved_course_id = _resolve_course_or_exit(session, course).id
        topic = ChapterTopic(
            id=uuid.uuid4().hex,
            course_id=resolved_course_id,
            chapter_label=chapter,
            title=title,
            vocabulary=vocabulary,
            objectives=objective or [],
            is_exhaustive=exhaustive,
            sections=section or [],
            reading_url=reading_url,
            reading_label=reading_label,
            added_vocabulary=added_vocab,
            added_objectives=added_objective or [],
        )
        row = repository.upsert_chapter_topic(session, topic)
        exhaustive_note = "" if exhaustive else " [yellow](not yet confirmed exhaustive)[/yellow]"
        console.print(
            f"[green]Saved[/green] chapter topic {row.id} ({chapter}) for {course}.{exhaustive_note}"
        )


@app.command("needs-link-refresh")
def needs_link_refresh_cmd(
    course: Annotated[str | None, typer.Option("--course")] = None,
    lookback_days: Annotated[int, typer.Option("--lookback-days")] = 14,
    lookahead_days: Annotated[int, typer.Option("--lookahead-days")] = 14,
) -> None:
    """List items whose link_available_date falls within the last
    --lookback-days or the next --lookahead-days, and that still have no
    reference_url/resource_url -- i.e. discovery found them locked behind a
    release date, and that date has either already passed (worth a re-check
    now) or is coming up soon (worth checking a bit early, since D2L's
    stated date is sometimes conservative and an item can be unlocked
    before it). Meant to run weekly -- see the recurring Sunday-evening
    Calendar reminder academic-import sets up, and its Step 6 for the full
    workflow. Drives the academic-import skill's periodic "link refresh"
    pass -- see CLAUDE.md and .claude/skills/academic-import/SKILL.md.
    Prints nothing extra when the list is empty; that's the common case on
    any given week.
    """
    with session_scope() as session:
        resolved_course_id = _resolve_course_or_exit(session, course).id if course else None
        items = repository.list_items_needing_link_recheck(
            session, course_id=resolved_course_id,
            lookback_days=lookback_days, lookahead_days=lookahead_days,
        )
        if not items:
            console.print("[green]Nothing needs a link refresh right now.[/green]")
            return
        console.print(f"{len(items)} item(s) whose link is worth checking:")
        codes = {c.id: c.course_code for c in repository.list_courses(session)}
        today = date.today()
        for item in sorted(items, key=lambda i: (i.date is None, i.date)):
            course_code = codes.get(item.course_id, item.course_id)
            when = "opened" if (item.link_available_date and item.link_available_date <= today) else "opens"
            console.print(
                f"  [{course_code}] {item.title} ({item.date}) -- "
                f"{when} {item.link_available_date} -- item_id {item.id}"
            )


@app.command("plan")
def plan_cmd(
    course: Annotated[str | None, typer.Option("--course")] = None,
    verbose: Annotated[bool, typer.Option("--verbose")] = False,
) -> None:
    """Show what a sync would do right now, using currently stored items.

    Superseded 2026-08-25: this used to say standalone `plan` could only
    ever report UNCHANGED for an already-synced item, since it has no
    fresh extraction to diff against. That's no longer true --
    `decide_action` now compares each item's current state against
    `SyncRecord.last_synced_fields`, a real snapshot of what was actually
    last pushed (see `reconciliation/engine.py::snapshot_compared_fields`
    and CLAUDE.md invariant 5's 2026-08-25 amendment), so drift from
    enrichment applied directly via `render --save` (module_label,
    reference_url, etc.) after an item's first sync now correctly shows as
    UPDATE even with no fresh extraction involved. A `SyncRecord` from
    before this fix has no snapshot to compare against and is reported as
    UPDATE unconditionally (a one-time backfill push, not a sign something
    is actually wrong) -- `record-sync` populates the snapshot the moment
    that push happens, after which this command's UNCHANGED becomes
    trustworthy again for that item.
    """
    with session_scope() as session:
        courses = [_resolve_course_or_exit(session, course)] if course else repository.list_courses(session)
        for c in courses:
            items = repository.list_items_for_course(session, c.id)
            plan = compute_plan(session, c.id, items)
            console.print(f"\n[bold]{c.course_code}[/bold]")
            console.print(format_plan_summary(c.id, plan.entries))
            if verbose:
                console.print(format_plan_detail(plan.entries))


@app.command("export")
def export_cmd(
    course: Annotated[str | None, typer.Option("--course")] = None,
    output: Annotated[Path | None, typer.Option("--output")] = None,
) -> None:
    """Write a consolidated, human-and-agent-readable text file of every
    known item for a course (sync-ready, needs-review, undated, and open
    unresolved references) to
    data/downloads/<COURSE_CODE>/consolidated_events.txt (or --output).
    Run this after any extract pass so the course's folder always reflects
    current state -- a future session (or you) can read this one file
    instead of re-deriving from raw source documents.
    """
    with session_scope() as session:
        courses = [_resolve_course_or_exit(session, course)] if course else repository.list_courses(session)
        for c in courses:
            items = repository.list_items_for_course(session, c.id)
            unresolved = repository.list_unresolved_references(session, c.id)
            text = format_course_export(c, items, unresolved)

            out_path = output or (
                REPO_ROOT / "data" / "downloads" / c.course_code / "consolidated_events.txt"
            )
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_text(text, encoding="utf-8")
            console.print(f"[green]Wrote[/green] {out_path} ({len(items)} items)")


@app.command("audit")
def audit_cmd(limit: Annotated[int, typer.Option("--limit")] = 50) -> None:
    with session_scope() as session:
        entries = repository.list_audit_log(session, limit=limit)
    for e in entries:
        console.print(f"[dim]{e.timestamp.isoformat()}[/dim] [{e.event_type}] {e.summary}")


@app.command("status")
def status_cmd() -> None:
    with session_scope() as session:
        courses = repository.list_courses(session)
        table = Table(show_header=True)
        for col in ["course", "term", "items", "unresolved", "synced"]:
            table.add_column(col)
        for c in courses:
            items = repository.list_items_for_course(session, c.id)
            unresolved = repository.list_unresolved_references(session, c.id)
            synced = sum(1 for i in items if i.status == ItemStatus.SYNCED)
            table.add_row(c.course_code, c.term, str(len(items)), str(len(unresolved)), str(synced))
        console.print(table)


@app.command("record-sync")
def record_sync_cmd(
    item_id: Annotated[str, typer.Argument()],
    event_id: Annotated[str, typer.Option("--event-id")],
    calendar_id: Annotated[str, typer.Option("--calendar-id")],
) -> None:
    """Record that the import skill actually wrote a Calendar event for this
    item. Called by the skill immediately after a successful
    create_event/update_event -- never called speculatively."""
    with session_scope() as session:
        item = repository.get_academic_item(session, item_id)
        if item is None:
            console.print(f"[red]No such item: {item_id}[/red]")
            raise typer.Exit(1)
        repository.upsert_sync_record(
            session,
            academic_item_id=item_id,
            google_calendar_id=calendar_id,
            google_event_id=event_id,
            last_synced_fields=snapshot_compared_fields(item),
            status=SyncAction.UNCHANGED,
            mark_synced=True,
        )
        item.status = ItemStatus.SYNCED
        item.calendar_event_id = event_id
        repository.upsert_academic_item(session, item)
        repository.log_audit_event(
            session, event_type="calendar_event_synced", item_id=item_id,
            summary=f"Recorded Calendar sync for {item.title}",
            details={"event_id": event_id, "calendar_id": calendar_id},
        )
    console.print("[green]Recorded.[/green]")


@app.command("render")
def render_cmd(
    item_id: Annotated[str, typer.Argument()],
    reference_url: Annotated[str | None, typer.Option("--reference-url")] = None,
    reference_url_label: Annotated[str | None, typer.Option("--reference-url-label")] = None,
    resource_url: Annotated[str | None, typer.Option("--resource-url")] = None,
    resource_url_label: Annotated[str | None, typer.Option("--resource-url-label")] = None,
    submission_url: Annotated[
        str | None,
        typer.Option("--submission-url", help="A separate turn-in location distinct from the "
                     "item's own page -- e.g. the Dropbox an exam says to submit your work to. "
                     "Renders as its own 'Submit Work' link. Only a URL discovery actually "
                     "opened."),
    ] = None,
    submission_url_label: Annotated[str | None, typer.Option("--submission-url-label")] = None,
    links: Annotated[str | None, typer.Option("--links", help=_WEEKLY_LINKS_HELP)] = None,
    covered_chapters: Annotated[
        str | None,
        typer.Option("--covered-chapters", help='Tests only: JSON array of chapter labels the '
                     """test covers, e.g. '["Chapter 5","Chapter 6"]' -- each one's saved """
                     "chapter topic renders under EXAM CONCEPTS. Only chapters a real source "
                     "(exam page, syllabus, study guide, announcement) says are covered."),
    ] = None,
    study_focus: Annotated[
        str | None,
        typer.Option("--study-focus", help="Tests only: JSON array of the study guide / exam "
                     "review's emphasized concepts and terms, verbatim -- listed first under "
                     "EXAM CONCEPTS. CLAUDE.md invariant 40."),
    ] = None,
    video_url: Annotated[
        str | None,
        typer.Option("--video-url", help="Homework-type items: a video teaching the "
                     "assignment's topic (instructor/platform first, else a verified "
                     "trusted-web video). Renders as a Video link under LINKS."),
    ] = None,
    video_url_label: Annotated[str | None, typer.Option("--video-url-label")] = None,
    link_available_date: Annotated[
        str | None,
        typer.Option("--link-available-date", help="YYYY-MM-DD -- only when D2L showed an "
                     "explicit 'Available on' date for a still-locked item; see the "
                     "academic-import SKILL.md link-refresh step."),
    ] = None,
    points: Annotated[float | None, typer.Option("--points")] = None,
    optional: Annotated[bool, typer.Option("--optional")] = False,
    inferred_date: Annotated[
        bool,
        typer.Option(
            "--inferred-date",
            help="Mark this item's date as pattern-inferred rather than literally "
            "sourced -- only after exhaustive real search found nothing, per a "
            "stated one-sentence rule (see --date-inference-rule). Renders a "
            "visible '(Inferred Date)' tag. See CLAUDE.md invariant 29.",
        ),
    ] = False,
    date_inference_rule: Annotated[
        str | None,
        typer.Option(
            "--date-inference-rule",
            help="The one-sentence auditable pattern rule that justified "
            "--inferred-date (e.g. 'every other HW this course is due exactly "
            "N days after the prior chapter exam'). Stored for local audit only "
            "-- never rendered into the visible description.",
        ),
    ] = None,
    details: Annotated[str | None, typer.Option("--details")] = None,
    details_blocks: Annotated[
        str | None,
        typer.Option(
            "--details-blocks",
            help='JSON array of labeled sub-groups for DETAILS, e.g. '
            '\'[{"label": "Vocabulary", "text": "..."}, {"label": "Objectives", '
            '"items": ["...", "..."]}]\' -- renders labeled sub-groups with one '
            "bullet line per items entry instead of a single run-on paragraph. "
            "Takes precedence over --details when both are given. Use this "
            "whenever DETAILS has real vocabulary/objectives/multi-point "
            "structure; plain --details is still fine for a single short "
            "paragraph. Every item/text value must still trace to real source "
            "content -- see CLAUDE.md invariant 22.",
        ),
    ] = None,
    nesting: Annotated[str | None, typer.Option("--nesting")] = None,
    required_resources: Annotated[str | None, typer.Option("--required-resources")] = None,
    location: Annotated[
        str | None,
        typer.Option("--location", help="Pre-resolved location string (room/Online/etc) -- "
                     "this command doesn't resolve location preferences itself."),
    ] = None,
    save: Annotated[
        bool,
        typer.Option("--save", help="Persist the --reference-url/--points/etc. overrides "
                     "onto the item row, not just use them for this render."),
    ] = False,
    as_json: Annotated[
        bool,
        typer.Option("--json", help="Print the computed payload as one JSON object "
                     "(summary/description/location/allDay/startTime/endTime/timeZone/"
                     "colorId/calendarId/itemId) instead of the human-readable field "
                     "dump -- for scripted batch rendering ahead of many live "
                     "create_event/update_event calls (see academic-import SKILL.md "
                     "Step 5). Same computed values either way; this only changes "
                     "output formatting."),
    ] = False,
) -> None:
    """Compute the EXACT summary/description/location/start/end this item
    would sync with, using the same build_title/build_*_description/
    build_event_payload functions CLAUDE.md and docs/d2l_discovery.md
    document as the single source of truth for that format.

    Run this before every live create_event/update_event call during Step 5
    of the academic-import skill and copy its output directly into the tool
    call -- don't hand-type the HTML template from memory of the prose
    rules. That's exactly the kind of mechanical step where a fresh session
    (or this one, hours in) can silently drift from the documented format
    (wrong separator, missing <br>, mislabeled link) without ever running
    afoul of the "never fabricate" invariants -- this command removes that
    risk by making the tested code the thing that actually produces the
    text, not a description of it.

    Use --details-blocks instead of plain --details whenever DETAILS has
    real vocabulary/objectives/multi-point structure -- it renders labeled
    sub-groups with one bullet line per point instead of a hand-typed
    run-on paragraph, and (like --details) is never persisted, always
    supplied fresh at render time.

    --reference-url/--resource-url/--points/--optional/etc. let you supply
    metadata gathered during discovery that isn't on the item row yet
    (extraction doesn't currently detect these automatically -- see
    docs/d2l_discovery.md#links and #points-and-optionalextra-credit).
    Pass --save to persist them for next time; without it, this is a
    pure preview and the item row is untouched.
    """
    with session_scope() as session:
        item = repository.get_academic_item(session, item_id)
        if item is None:
            console.print(f"[red]No such item: {item_id}[/red]")
            raise typer.Exit(1)
        if item.date is None:
            console.print(f"[red]Item {item_id} has no date -- cannot render a Calendar payload.[/red]")
            raise typer.Exit(1)
        if item.item_type == ItemType.WEEKLY_READING and item.date_range_end is None:
            console.print(
                f"[red]Item {item_id} is a weekly reading block with no date_range_end -- "
                "cannot render a Calendar payload.[/red]"
            )
            raise typer.Exit(1)
        if item.item_type == ItemType.READING:
            console.print(
                f"[red]Item {item_id} is a plain READING item -- these never sync as their own "
                "event. Fold its content into the covering lecture's DETAILS or the course's "
                "weekly reading block instead (see CLAUDE.md invariant 25).[/red]"
            )
            raise typer.Exit(1)
        course = repository.get_course(session, item.course_id)
        if course is None:
            console.print(f"[red]Item {item_id} references a missing course.[/red]")
            raise typer.Exit(1)

        if reference_url is not None:
            item.reference_url = reference_url
        if reference_url_label is not None:
            item.reference_url_label = reference_url_label
        if resource_url is not None:
            item.resource_url = resource_url
        if resource_url_label is not None:
            item.resource_url_label = resource_url_label
        if submission_url is not None:
            item.submission_url = submission_url
        if submission_url_label is not None:
            item.submission_url_label = submission_url_label
        if links is not None:
            if (
                item.item_type == ItemType.WEEKLY_READING
                or item.item_type.is_routine_meeting
                or item.item_type.is_assessment
            ):
                item.weekly_links = _parse_weekly_links(links)
            else:
                console.print(
                    f"[yellow]Ignoring --links for item {item_id}[/yellow]: only "
                    "WEEKLY_READING banners, lecture/lab meetings, and tests (study "
                    "guides) use the multi-link list; other deadline items use "
                    "--reference-url/--resource-url/--submission-url."
                )
        if covered_chapters is not None or study_focus is not None:
            if not item.item_type.is_assessment:
                console.print(
                    f"[yellow]Ignoring --covered-chapters/--study-focus for item {item_id}"
                    "[/yellow]: only tests (exam/final/practical/quiz) carry EXAM CONCEPTS."
                )
            else:
                if covered_chapters is not None:
                    item.covered_chapters = _parse_str_list(covered_chapters, "--covered-chapters")
                if study_focus is not None:
                    item.study_focus = _parse_str_list(study_focus, "--study-focus")
        if video_url is not None:
            item.video_url = video_url
        if video_url_label is not None:
            item.video_url_label = video_url_label
        if link_available_date is not None:
            item.link_available_date = date.fromisoformat(link_available_date)
        if points is not None:
            item.points = points
        if optional:
            item.is_optional = True
        if inferred_date:
            if not date_inference_rule:
                console.print(
                    "[red]--inferred-date requires --date-inference-rule (the "
                    "one-sentence auditable rule) -- see CLAUDE.md invariant 29.[/red]"
                )
                raise typer.Exit(1)
            item.is_inferred_date = True
            item.date_inference_rule = date_inference_rule

        # `item.module_label` is the persisted nesting field -- an explicit
        # --nesting overrides it (and is written back so it isn't lost
        # next render), but absent that, module_label is the real source
        # of truth. Previously --nesting was render-time-only and
        # module_label was silently ignored unless --nesting happened to
        # be re-typed identically every time -- see CLAUDE.md invariant 17.
        if nesting is not None:
            item.module_label = nesting
        else:
            nesting = item.module_label

        if save:
            repository.upsert_academic_item(session, item)

        config = get_config()
        color_id = str(
            repository.get_preference(session, "calendar_color_id", default=config.calendar.color_id)
        )
        if item.item_type.is_assessment:
            # Tests stand out in yellow (CLAUDE.md invariant 40).
            color_id = str(repository.get_preference(session, "assessment_color_id", default="5"))
        calendar_id = str(
            repository.get_preference(
                session, "target_calendar_id", default=config.calendar.target_calendar_id
            )
        )
        timezone = str(repository.get_preference(session, "timezone", default=config.timezone))

        is_physical_meeting = item.item_type.is_fixed_time_meeting and item.due_time is None
        if location and not is_physical_meeting:
            console.print(
                f"[yellow]Ignoring --location for item {item_id}[/yellow]: "
                f"{item.item_type.value} items aren't a physical meeting -- "
                "location is reserved for lecture/lab/exam-with-a-room. Put "
                "where the work actually happens in --nesting instead "
                "(e.g. \"ALEKS\" or \"D2L\")."
            )
            location = None
        location_info = LocationInfo(platform_location=location) if location else None

        primary_source = (
            repository.get_source(session, item.source_ids[0]) if item.source_ids else None
        )
        platform_label = platform_label_for_source(primary_source)

        if details_blocks is not None:
            try:
                raw_blocks = json.loads(details_blocks)
            except json.JSONDecodeError as exc:
                console.print(f"[red]--details-blocks is not valid JSON: {exc}[/red]")
                raise typer.Exit(1) from None
            if not isinstance(raw_blocks, list):
                console.print("[red]--details-blocks must be a JSON array of objects.[/red]")
                raise typer.Exit(1)
            try:
                blocks = [DetailsBlock(**b) for b in raw_blocks]
            except TypeError as exc:
                console.print(f"[red]--details-blocks: {exc}[/red]")
                raise typer.Exit(1) from None
            details = format_details_blocks(blocks)

        if item.item_type == ItemType.WEEKLY_READING:
            # Auto-pull saved chapter topics (CLAUDE.md invariant 26) --
            # THIS WEEK becomes the real vocabulary/objectives breakdown
            # for any chapter that's been captured via `chapter-topic-add`,
            # instead of the bare chapter-list line. Only switches to the
            # richer rendering once at least one real chapter topic is
            # found; with none found, this_week stays None and
            # build_weekly_reading_description falls back to its original
            # bare _topic_line(item.title) behavior unchanged.
            segments = split_chapter_segments(item.title) if item.title else []
            topics_by_label: dict[str, ChapterTopic] = {}
            for label, _text in segments:
                if label is None:
                    continue
                topic = repository.get_chapter_topic(session, item.course_id, label)
                if topic is not None:
                    topics_by_label[canonicalize_chapter_label(label)] = topic
            description = build_weekly_reading_description(
                item, course, chapter_topics=topics_by_label, pacing=details,
            )
        else:
            covered_topics: dict[str, ChapterTopic] = {}
            for label, _text in split_chapter_segments("; ".join(item.covered_chapters)):
                if label is None:
                    continue
                topic = repository.get_chapter_topic(session, item.course_id, label)
                if topic is not None:
                    covered_topics[canonicalize_chapter_label(label)] = topic
            if is_physical_meeting:
                description = build_meeting_description(
                    item, course, location=location_info, nesting=nesting, details=details,
                    platform_label=platform_label, chapter_topics=covered_topics,
                )
            else:
                description = build_deadline_description(
                    item, course, nesting=nesting, details=details,
                    required_resources=required_resources,
                    platform_label=platform_label, chapter_topics=covered_topics,
                )

        payload = build_event_payload(
            item, course, timezone=timezone, color_id=color_id,
            description=description, location=location_info,
        )

    # The description contains literal "[academic-sync:fp:...]" text (the
    # idempotency tag) -- Rich's console.print interprets square brackets as
    # its own markup syntax by default and will silently mangle/strip that
    # tag unless every dynamic value is escaped. This command's whole point
    # is "copy this output verbatim," so getting this wrong would be worse
    # than not having the command at all -- always escape(), never
    # interpolate a payload value into console.print raw.
    if as_json:
        is_all_day = "date" in payload["start"]
        out = {
            "itemId": item.id,
            "summary": payload["summary"],
            "description": payload["description"],
            "location": payload.get("location"),
            "allDay": is_all_day,
            "startTime": payload["start"]["date"] if is_all_day else payload["start"]["dateTime"],
            "endTime": payload["end"]["date"] if is_all_day else payload["end"]["dateTime"],
            "timeZone": None if is_all_day else payload["start"]["timeZone"],
            "colorId": payload["colorId"],
            "calendarId": calendar_id,
        }
        print(json.dumps(out))
        return

    def _field(label: str, value: str) -> None:
        console.print(f"[bold]{label}[/bold]\n{escape(value)}\n")

    _field("summary", payload["summary"])
    _field("description", payload["description"])
    _field("location", str(payload.get("location", "(none)")))
    if "date" in payload["start"]:
        _field("allDay", "true")
        _field("startTime", payload["start"]["date"])
        _field("endTime", payload["end"]["date"])
    else:
        _field("allDay", "false")
        _field("startTime", payload["start"]["dateTime"])
        _field("endTime", payload["end"]["dateTime"])
        _field("timeZone", payload["start"]["timeZone"])
    _field("colorId", payload["colorId"])
    _field("calendarId (target_calendar_id preference)", calendar_id)


# --------------------------------------------------------------------------
# grade diagnostics
# --------------------------------------------------------------------------

_DIAGNOSTIC_COLOR_PREF_KEYS = {
    DiagnosticStatus.RED: "diagnostic_color_red",
    DiagnosticStatus.YELLOW: "diagnostic_color_yellow",
    DiagnosticStatus.GREEN: "diagnostic_color_green",
}

_MAJOR_ASSESSMENT_TYPES = {ItemType.EXAM, ItemType.FINAL_EXAM, ItemType.PROJECT}


@app.command("grade-snapshot-add")
def grade_snapshot_add_cmd(
    course: Annotated[str, typer.Option("--course")],
    title: Annotated[str, typer.Option("--title")],
    week_start: Annotated[
        str, typer.Option("--week-start", help="YYYY-MM-DD, the Monday of the diagnosed week.")
    ],
    item_id: Annotated[
        str | None,
        typer.Option("--item-id", help="The matching AcademicItem id, if the gradebook row "
                     "maps cleanly to one. Leave unset rather than guessing."),
    ] = None,
    score_percent: Annotated[float | None, typer.Option("--score-percent")] = None,
    missing: Annotated[bool, typer.Option("--missing")] = False,
    feedback: Annotated[
        str | None,
        typer.Option("--feedback", help="Literal instructor feedback text, if D2L/ALEKS showed "
                     "any -- never invented. Omit if there's no real feedback."),
    ] = None,
    source_type: Annotated[str, typer.Option("--source-type")] = SourceType.D2L_QUIZZES.value,
) -> None:
    """Record one graded/missing item observed during a weekly
    grade-diagnostic crawl (see
    docs/d2l_discovery.md#weekly-grade-diagnostic-crawl). Idempotent by
    (course, title, week-start): re-running this for the same item/week
    updates the same snapshot instead of duplicating."""
    with session_scope() as session:
        resolved_course_id = _resolve_course_or_exit(session, course).id
        snapshot = GradeSnapshot(
            id=uuid.uuid4().hex,
            course_id=resolved_course_id,
            academic_item_id=item_id,
            title=title,
            week_start=date.fromisoformat(week_start),
            captured_at=datetime.now(UTC).date(),
            score_percent=score_percent,
            is_missing=missing,
            instructor_feedback=feedback,
            source_type=SourceType(source_type),
        )
        row = repository.add_grade_snapshot(session, snapshot)
        console.print(f"[green]Saved[/green] grade snapshot {row.id} ({title}) for {course}.")


@app.command("course-grade-snapshot-add")
def course_grade_snapshot_add_cmd(
    course: Annotated[str, typer.Option("--course")],
    week_start: Annotated[str, typer.Option("--week-start")],
    overall_percent: Annotated[float | None, typer.Option("--overall-percent")] = None,
    letter_grade: Annotated[str | None, typer.Option("--letter-grade")] = None,
) -> None:
    """Record a course's overall grade as of a diagnosed week -- the
    week-over-week comparison basis for `diagnostic-compute`. Idempotent by
    (course, week-start)."""
    with session_scope() as session:
        resolved_course_id = _resolve_course_or_exit(session, course).id
        snapshot = CourseGradeSnapshot(
            id=uuid.uuid4().hex,
            course_id=resolved_course_id,
            week_start=date.fromisoformat(week_start),
            captured_at=datetime.now(UTC).date(),
            overall_percent=overall_percent,
            letter_grade=letter_grade,
        )
        row = repository.add_course_grade_snapshot(session, snapshot)
        console.print(f"[green]Saved[/green] course grade snapshot {row.id} for {course}.")


@app.command("diagnostic-compute")
def diagnostic_compute_cmd(
    week_start: Annotated[str, typer.Option("--week-start")],
) -> None:
    """Classify every active, real (non-synthetic) course's Red/Yellow/Green
    status for the given diagnosed week -- read-only, writes nothing. Run
    this after recording every course's snapshots for the week, before
    building each course's own event with `diagnostic-render` -- each
    course gets its own "<CODE> Previous Week Diagnostic" event now
    (user-directed 2026-09-17), so there is no single cross-course
    status/fingerprint at this step."""
    week_start_date = date.fromisoformat(week_start)
    with session_scope() as session:
        courses = [c for c in repository.list_courses(session) if not c.is_synthetic]
        table = Table(show_header=True)
        for col in ["course", "status", "previous %", "current %", "missing", "existing event"]:
            table.add_column(col)
        for c in courses:
            current = repository.get_course_grade_snapshot(session, c.id, week_start_date)
            previous = repository.get_previous_course_grade_snapshot(
                session, c.id, before=week_start_date
            )
            item_snapshots = repository.list_grade_snapshots_for_week(session, c.id, week_start_date)
            items = repository.list_items_for_course(session, c.id)
            major_ids = frozenset(i.id for i in items if i.item_type in _MAJOR_ASSESSMENT_TYPES)
            status = diagnostics_mod.classify_course(
                current=current, previous=previous, item_snapshots=item_snapshots,
                major_assessment_item_ids=major_ids,
            )
            missing_count = sum(1 for s in item_snapshots if s.is_missing)
            existing = repository.get_weekly_diagnostic_record(session, c.id, week_start_date)
            table.add_row(
                c.course_code,
                status.value,
                f"{previous.overall_percent:g}%"
                if previous and previous.overall_percent is not None else "-",
                f"{current.overall_percent:g}%"
                if current and current.overall_percent is not None else "-",
                str(missing_count),
                existing.google_event_id if existing and existing.google_event_id else "none (CREATE)",
            )
    console.print(table)


@app.command("diagnostic-render")
def diagnostic_render_cmd(
    course: Annotated[str, typer.Option("--course")],
    week_start: Annotated[str, typer.Option("--week-start")],
    section: Annotated[
        str,
        typer.Option("--section", help="JSON object for this course's diagnostic section -- see "
                     "academic-sync SKILL.md Step 3.4 for the exact shape (course_code, status, "
                     "previous_grade_label, current_grade_label, assignments[], announcements[], "
                     "missed_deadlines[], upcoming_deadlines[], plan[])."),
    ],
    as_json: Annotated[bool, typer.Option("--json")] = False,
) -> None:
    """Build the exact title/description/start/end/colorId for one course's
    own "<CODE> Previous Week Diagnostic" event -- don't hand-type the HTML
    template, same reasoning as `render` for a normal item. One event per
    course, each independently colored Red/Yellow/Green (user-directed
    2026-09-17). Prints the fingerprint and any existing google_event_id so
    the caller knows CREATE vs. UPDATE."""
    week_start_date = date.fromisoformat(week_start)
    try:
        raw_section = json.loads(section)
    except json.JSONDecodeError as exc:
        console.print(f"[red]--section is not valid JSON: {exc}[/red]")
        raise typer.Exit(1) from None
    if not isinstance(raw_section, dict):
        console.print("[red]--section must be a JSON object.[/red]")
        raise typer.Exit(1)
    try:
        course_section = DiagnosticCourseSection(
            course_code=raw_section["course_code"],
            status=DiagnosticStatus(raw_section["status"]),
            previous_grade_label=raw_section.get("previous_grade_label"),
            current_grade_label=raw_section.get("current_grade_label"),
            assignments=[DiagnosticAssignment(**a) for a in raw_section.get("assignments", [])],
            announcements=raw_section.get("announcements", []),
            missed_deadlines=raw_section.get("missed_deadlines", []),
            upcoming_deadlines=raw_section.get("upcoming_deadlines", []),
            plan=raw_section.get("plan", []),
        )
    except (TypeError, KeyError, ValueError) as exc:
        console.print(f"[red]--section: {exc}[/red]")
        raise typer.Exit(1) from None

    description = build_weekly_diagnostic_description(course_section)
    with session_scope() as session:
        resolved_course = _resolve_course_or_exit(session, course)
        fingerprint = compute_fingerprint(
            resolved_course.id, "weekly_diagnostic", "Previous Week Diagnostic",
            disambiguator=week_start_date.isoformat(),
        )
        existing = repository.get_weekly_diagnostic_record(
            session, resolved_course.id, week_start_date
        )
        color_key = _DIAGNOSTIC_COLOR_PREF_KEYS[course_section.status]
        color_id = str(prefs_mod.get_pref(session, color_key))
    record_id = existing.id if existing else uuid.uuid4().hex
    payload = build_weekly_diagnostic_payload(
        course_section.course_code, week_start_date, description, fingerprint=fingerprint,
        record_id=record_id, color_id=color_id,
    )

    if as_json:
        print(json.dumps({
            "recordId": record_id,
            "courseId": resolved_course.id,
            "summary": payload["summary"],
            "description": payload["description"],
            "startTime": payload["start"]["date"],
            "endTime": payload["end"]["date"],
            "colorId": payload["colorId"],
            "status": course_section.status.value,
            "fingerprint": fingerprint,
            "existingEventId": existing.google_event_id if existing else None,
        }))
        return

    def _field(label: str, value: str) -> None:
        console.print(f"[bold]{label}[/bold]\n{escape(value)}\n")

    _field("status", course_section.status.value)
    _field("summary", payload["summary"])
    _field("description", payload["description"])
    _field("allDay", "true")
    _field("startTime", payload["start"]["date"])
    _field("endTime", payload["end"]["date"])
    _field("colorId", payload["colorId"])
    _field(
        "existingEventId (update this instead of creating, if set)",
        existing.google_event_id if existing and existing.google_event_id else "(none -- CREATE)",
    )


@app.command("diagnostic-record-sync")
def diagnostic_record_sync_cmd(
    course: Annotated[str, typer.Option("--course")],
    week_start: Annotated[str, typer.Option("--week-start")],
    event_id: Annotated[str, typer.Option("--event-id")],
    status: Annotated[str, typer.Option("--status")],
    calendar_id: Annotated[str | None, typer.Option("--calendar-id")] = None,
) -> None:
    """Record that the skill actually wrote this course's own "<CODE>
    Previous Week Diagnostic" Calendar event for this week -- called
    immediately after a successful create_event/update_event, mirrors
    `record-sync` for a normal item."""
    week_start_date = date.fromisoformat(week_start)
    with session_scope() as session:
        resolved_course_id = _resolve_course_or_exit(session, course).id
        fingerprint = compute_fingerprint(
            resolved_course_id, "weekly_diagnostic", "Previous Week Diagnostic",
            disambiguator=week_start_date.isoformat(),
        )
        repository.upsert_weekly_diagnostic_record(
            session, course_id=resolved_course_id, week_start=week_start_date,
            status=DiagnosticStatus(status), fingerprint=fingerprint,
            google_event_id=event_id, google_calendar_id=calendar_id,
        )
        repository.log_audit_event(
            session, event_type="diagnostic_synced", course_id=resolved_course_id,
            summary=f"Recorded Previous Week Diagnostic for {week_start} ({status})",
            details={"event_id": event_id, "week_start": week_start},
        )
    console.print("[green]Recorded.[/green]")


@app.command("shells-check")
def shells_check_cmd(
    file: Annotated[
        Path, typer.Option("--file", help="JSON of D2L myenrollments `Items` (or the whole response).")
    ],
) -> None:
    """Print (as JSON) every accessible class shell that isn't imported yet
    -- the daily run starts a full first-time import for each one. Matching
    against registered courses uses `Course.d2l_identifier` (the org unit
    id)."""
    raw = json.loads(file.read_text(encoding="utf-8"))
    items = raw.get("Items", raw) if isinstance(raw, dict) else raw
    with session_scope() as session:
        registered = {c.d2l_identifier for c in repository.list_courses(session) if c.d2l_identifier}
    shells = enrollments_mod.find_new_shells(items, {str(r) for r in registered})
    print(json.dumps([s.__dict__ for s in shells]))


# --------------------------------------------------------------------------
# Daily Overview email (CLAUDE.md invariant 38)
# --------------------------------------------------------------------------


@app.command("portal-link-set")
def portal_link_set_cmd(
    course: Annotated[str, typer.Option("--course")],
    kind: Annotated[str, typer.Option("--kind", help=f"One of: {', '.join(PORTAL_LINK_KINDS)}.")],
    url: Annotated[str, typer.Option("--url", help="A URL discovery actually opened -- never built.")],
    label: Annotated[str, typer.Option("--label", help='e.g. "ALEKS Gradebook".')] = "",
) -> None:
    """Save a static, bookmarkable URL into one of a course's areas (home,
    grades, announcements, content, dropbox list, an external platform's
    gradebook...) so the daily run goes straight there. Idempotent by
    (course, kind, label)."""
    if kind not in PORTAL_LINK_KINDS:
        console.print(f"[red]--kind must be one of {', '.join(PORTAL_LINK_KINDS)}.[/red]")
        raise typer.Exit(1)
    with session_scope() as session:
        course_id = _resolve_course_or_exit(session, course).id
        repository.upsert_portal_link(session, CoursePortalLink(
            id=uuid.uuid4().hex, course_id=course_id, kind=kind, url=url, label=label,
        ))
    console.print(f"[green]Saved[/green] {kind} link for {course}.")


@app.command("portal-link-list")
def portal_link_list_cmd(
    course: Annotated[str, typer.Option("--course")],
    as_json: Annotated[bool, typer.Option("--json")] = False,
) -> None:
    """List a course's saved portal links."""
    with session_scope() as session:
        course_id = _resolve_course_or_exit(session, course).id
        links = repository.list_portal_links(session, course_id)
    if as_json:
        print(json.dumps([{"kind": x.kind, "label": x.label, "url": x.url} for x in links]))
        return
    for x in links:
        console.print(f"{x.kind:<20} {escape(x.label):<24} {escape(x.url)}")


@app.command("digest-deadlines")
def digest_deadlines_cmd(
    course: Annotated[str, typer.Option("--course")],
    on: Annotated[str | None, typer.Option("--date", help="YYYY-MM-DD (default: today).")] = None,
) -> None:
    """JSON list of this course's actionable items due yesterday and today
    (plus the next 3 days), each with its best action link -- the morning
    crawl checks each one's submission status and reports it back in
    `digest-ingest`'s `deadline_status`."""
    day = date.fromisoformat(on) if on else date.today()
    with session_scope() as session:
        course_id = _resolve_course_or_exit(session, course).id
        items = repository.list_items_for_course(session, course_id)
    out: list[dict[str, str | None]] = []
    for when, lines in (
        ("yesterday", digest_mod.deadline_lines(items, day - timedelta(days=1))),
        ("today", digest_mod.deadline_lines(items, day)),
        ("upcoming", digest_mod.upcoming_lines(items, day, 3)),
    ):
        out.extend(
            {
                "when": when, "item_id": d.item_id, "title": d.title,
                "due_on": d.due_on.isoformat(),
                "due_time": d.due_time.isoformat() if d.due_time else None, "url": d.url,
            }
            for d in lines
        )
    print(json.dumps(out))


@app.command("digest-ingest")
def digest_ingest_cmd(
    file: Annotated[Path, typer.Option("--file", help="Path to the crawl JSON (digest.DigestCrawl).")],
    catch_up_days: Annotated[
        int,
        typer.Option("--catch-up-days", help="First run for a course only: how many days back "
                     "still count as news (default 2; e.g. 7 for a one-time 'past week' catch-up). "
                     "Anything older is stored as already reported."),
    ] = 2,
) -> None:
    """Record one course's morning crawl: new/changed announcements and
    grades (deduped -- something already emailed is never re-sent unless
    its content changed), needs-attention triggers, the day's overall grade
    snapshot, and the per-day facts `digest-render` needs.

    First run for a course: anything dated more than --catch-up-days (default
    2) before the crawl (or undated) is stored as already reported, so the
    first email isn't flooded with the whole term's history. After that, each
    email carries only what's new since the last one -- in daily use, the
    previous day."""
    try:
        crawl = digest_mod.DigestCrawl.model_validate_json(file.read_text(encoding="utf-8"))
    except (OSError, ValidationError) as exc:
        console.print(f"[red]Could not read crawl JSON: {exc}[/red]")
        raise typer.Exit(1) from None
    with session_scope() as session:
        course = _resolve_course_or_exit(session, crawl.course)
        existing = repository.get_daily_digest_record(session, course.id, crawl.captured_on)
        if existing is not None and existing.sent:
            console.print(f"[yellow]Already sent/skipped for {crawl.captured_on}; "
                          "recording the crawl, but nothing new will email today.[/yellow]")
        baseline_before = None
        if repository.count_digest_entries(session, course.id) == 0:
            baseline_before = crawl.captured_on - timedelta(days=catch_up_days)
        week_ago = repository.get_course_grade_snapshot_on_or_before(
            session, course.id, crawl.captured_on - timedelta(days=7)
        )
        counts = {"new": 0, "updated": 0, "seen": 0, "baseline": 0}
        signal_candidates = []
        entries = digest_mod.entries_from_crawl(crawl)
        if not crawl.login_failed:
            entries += digest_mod.attention_entries(crawl, week_ago=week_ago)
        for entry in entries:
            is_baseline = baseline_before is not None and (
                entry.dated is None or entry.dated < baseline_before
            )
            result = repository.record_digest_entry(
                session, course_id=course.id, kind=entry.kind, external_id=entry.external_id,
                content_hash=entry.content_hash, payload=entry.payload,
                already_reported_on=crawl.captured_on if is_baseline else None,
            )
            counts["baseline" if is_baseline and result == "new" else result] += 1
            if (
                entry.kind == digest_mod.KIND_GRADE and result in ("new", "updated")
                and not is_baseline and entry.payload.get("is_major")
                and entry.payload.get("score_percent") is not None
                and entry.payload["score_percent"] < diagnostics_mod.RED_MAJOR_ASSESSMENT_FLOOR
                and entry.payload.get("chapter_label")
            ):
                signal_candidates.append(
                    {"title": entry.payload["title"], "chapter_label": entry.payload["chapter_label"],
                     "score_percent": entry.payload["score_percent"]}
                )
        if crawl.overall_percent is not None and not crawl.login_failed:
            repository.add_course_grade_snapshot(session, CourseGradeSnapshot(
                id=uuid.uuid4().hex, course_id=course.id, week_start=crawl.captured_on,
                captured_at=crawl.captured_on, overall_percent=crawl.overall_percent,
                letter_grade=crawl.letter_grade,
            ))
        repository.upsert_daily_digest_record(
            session, course_id=course.id, digest_date=crawl.captured_on,
            crawl=crawl.model_dump(mode="json"),
        )
    print(json.dumps({"course": course.course_code, **counts,
                      "signal_candidates": signal_candidates}))


@app.command("digest-render")
def digest_render_cmd(
    course: Annotated[str, typer.Option("--course")],
    on: Annotated[str | None, typer.Option("--date", help="YYYY-MM-DD (default: today).")] = None,
) -> None:
    """Print this course's Daily Overview email as JSON: {should_send,
    already_sent, to, subject, html, text}. `should_send` is false on a
    quiet day (nothing new, missed, or due today) or when today's email
    already went out. Run after `digest-ingest`; pass the html/text
    verbatim to Gmail's send_message, then `digest-record-sent`."""
    day = date.fromisoformat(on) if on else date.today()
    with session_scope() as session:
        c = _resolve_course_or_exit(session, course)
        record = repository.get_daily_digest_record(session, c.id, day)
        crawl = digest_mod.DigestCrawl.model_validate(
            record.crawl if record and record.crawl
            else {"course": c.course_code, "captured_on": day.isoformat(), "login_failed": True}
        )
        week_ago = repository.get_course_grade_snapshot_on_or_before(
            session, c.id, day - timedelta(days=7)
        ) or repository.get_previous_course_grade_snapshot(session, c.id, before=day)
        overview = digest_mod.build_overview(
            course_code=c.course_code, course_name=c.name, digest_date=day,
            login_failed=crawl.login_failed, overall_percent=crawl.overall_percent,
            letter_grade=crawl.letter_grade, week_ago=week_ago, advice=crawl.advice,
            pending=repository.list_pending_digest_entries(session, c.id),
            items=repository.list_items_for_course(session, c.id),
            statuses={s.item_id: (s.submitted, s.window_open) for s in crawl.deadline_status},
            portal_links=[(x.kind, x.label, x.url) for x in repository.list_portal_links(session, c.id)],
        )
        to = repository.get_preference(session, "digest_email_to", default=None)
    message = build_daily_overview_email(overview)
    already_sent = bool(record and record.sent)
    print(json.dumps({
        "course": c.course_code,
        "should_send": overview.has_news and not already_sent and bool(to),
        "already_sent": already_sent,
        "has_news": overview.has_news,
        "to": to,
        "subject": message.subject,
        "html": message.html,
        "text": message.text,
    }))


@app.command("digest-record-sent")
def digest_record_sent_cmd(
    course: Annotated[str, typer.Option("--course")],
    on: Annotated[str | None, typer.Option("--date", help="YYYY-MM-DD (default: today).")] = None,
    message_id: Annotated[str | None, typer.Option("--message-id")] = None,
    skipped: Annotated[bool, typer.Option("--skipped", help="Quiet day -- nothing sent.")] = False,
) -> None:
    """Record today's outcome for one course. With --message-id (the Gmail
    send result), every pending digest entry is marked emailed. With
    --skipped (a quiet day), entries stay pending -- nothing was shown."""
    if not message_id and not skipped:
        console.print("[red]Pass --message-id (sent) or --skipped (quiet day).[/red]")
        raise typer.Exit(1)
    day = date.fromisoformat(on) if on else date.today()
    with session_scope() as session:
        course_id = _resolve_course_or_exit(session, course).id
        marked = repository.mark_digest_entries_emailed(session, course_id, day) if message_id else 0
        repository.upsert_daily_digest_record(
            session, course_id=course_id, digest_date=day,
            gmail_message_id=message_id, skipped=skipped,
        )
    console.print(f"[green]Recorded[/green] {course} {day}: "
                  + (f"sent ({marked} entries marked emailed)" if message_id else "skipped (quiet day)"))

# --------------------------------------------------------------------------
# preferences
# --------------------------------------------------------------------------

@prefs_app.command("list")
def prefs_list(known: Annotated[bool, typer.Option("--known")] = False) -> None:
    if known:
        for spec in prefs_mod.KNOWN_PREFERENCES.values():
            console.print(
                f"[bold]{spec.key}[/bold] ({spec.category.value}) "
                f"default={spec.default!r} -- {spec.description}"
            )
        return
    with session_scope() as session:
        prefs = prefs_mod.list_prefs(session)
    if not prefs:
        console.print("No preferences set yet.")
        return
    table = Table(show_header=True)
    for col in ["key", "value", "scope", "course_id", "source"]:
        table.add_column(col)
    for p in prefs:
        table.add_row(p.key, json.dumps(p.value), p.scope.value, p.course_id or "-", p.source)
    console.print(table)


@prefs_app.command("set")
def prefs_set(
    key: Annotated[str, typer.Argument()],
    value: Annotated[str, typer.Argument()],
    course: Annotated[str | None, typer.Option("--course")] = None,
    force: Annotated[bool, typer.Option("--force", help="Allow setting an unknown key.")] = False,
) -> None:
    parsed_value: object = value
    for cast in (int, float):
        try:
            parsed_value = cast(value)
            break
        except ValueError:
            continue
    if value.lower() in ("true", "false"):
        parsed_value = value.lower() == "true"
    with session_scope() as session:
        prefs_mod.set_pref(session, key, parsed_value, course_id=course, allow_unknown=force)
        repository.log_audit_event(
            session, event_type="preference_set", course_id=course,
            summary=f"Set preference {key}={parsed_value!r}",
        )
    console.print(f"[green]Set[/green] {key} = {parsed_value!r}")


@prefs_app.command("get")
def prefs_get(
    key: Annotated[str, typer.Argument()],
    course: Annotated[str | None, typer.Option("--course")] = None,
) -> None:
    with session_scope() as session:
        value = prefs_mod.get_pref(session, key, course_id=course)
    console.print(json.dumps(value))


@prefs_app.command("unset")
def prefs_unset(
    key: Annotated[str, typer.Argument()],
    course: Annotated[str | None, typer.Option("--course")] = None,
) -> None:
    with session_scope() as session:
        found = prefs_mod.unset_pref(session, key, course_id=course)
    console.print("[green]Unset.[/green]" if found else "[yellow]No such active preference.[/yellow]")


# ---- weekly study PDFs (CLAUDE.md invariant 41) ------------------------------


def _banner_or_exit(session, banner_id: str):  # type: ignore[no-untyped-def]
    banner = repository.get_academic_item(session, banner_id)
    if banner is None or banner.item_type != ItemType.WEEKLY_READING:
        console.print(f"[red]No weekly banner with id '{banner_id}'.[/red]")
        raise typer.Exit(code=1)
    return banner


@app.command("study-pdf-due")
def study_pdf_due_cmd(
    on: Annotated[str | None, typer.Option("--date", help="YYYY-MM-DD (default: today).")] = None,
    lookahead: Annotated[int, typer.Option("--lookahead", help="Days ahead a banner may start.")] = 3,
    lookback: Annotated[int, typer.Option("--lookback", help="Days back a banner may have started.")] = 2,
    banner: Annotated[str | None, typer.Option("--banner", help="Just this banner, due or not.")] = None,
) -> None:
    """JSON list of weekly banners that need a study PDF -- starting within
    [today - lookback, today + lookahead] with no PDF built or skipped yet --
    each with the full bundle the writer works from (chapters with saved
    sections/vocabulary/objectives, the week's links, everything due that
    week, tests in the next 3 weeks, earlier PDFs per chapter, and the
    output path/filename). See .claude/skills/weekly-study-pdf/SKILL.md."""
    day = date.fromisoformat(on) if on else date.today()
    with session_scope() as session:
        if banner:
            banners = [_banner_or_exit(session, banner)]
        else:
            banners = study_pdf_mod.due_banners(session, day, lookahead, lookback)
        bundles = [study_pdf_mod.build_bundle(session, b) for b in banners]
    print(json.dumps(bundles, indent=1))


def _study_source(session, banner_item, source: Path | None) -> Path:  # type: ignore[no-untyped-def]
    if source is not None:
        return source
    course = repository.get_course(session, banner_item.course_id)
    assert course is not None
    return study_pdf_mod.work_dir(course, banner_item) / "main.typ"


@app.command("study-pdf-check")
def study_pdf_check_cmd(
    banner: Annotated[str, typer.Option("--banner")],
    source: Annotated[
        Path | None, typer.Option("--source", help="Default: the banner's work_dir/main.typ.")
    ] = None,
) -> None:
    """Vocabulary coverage: every saved term for the week's chapters must
    appear somewhere in the PDF's text. Prints the missing ones as JSON."""
    with session_scope() as session:
        item = _banner_or_exit(session, banner)
        path = _study_source(session, item, source)
        terms = study_pdf_mod.week_terms(session, item)
    missing = study_pdf_mod.missing_terms(path.read_text(encoding="utf-8"), terms)
    print(json.dumps({"terms": len(terms), "missing": missing}))
    if missing:
        raise typer.Exit(code=1)


@app.command("study-pdf-build")
def study_pdf_build_cmd(
    banner: Annotated[str, typer.Option("--banner")],
    source: Annotated[
        Path | None, typer.Option("--source", help="Default: the banner's work_dir/main.typ.")
    ] = None,
    allow_missing: Annotated[
        bool, typer.Option("--allow-missing", help="Build even if saved vocabulary terms are absent.")
    ] = False,
) -> None:
    """Compile the week's Typst source with the shared template into
    Desktop/Weekly Study PDFs/<CODE>/<chapters>.pdf and record it, so the
    week is never 'due' again. Refuses while saved vocabulary terms are
    missing from the text (unless --allow-missing)."""
    with session_scope() as session:
        item = _banner_or_exit(session, banner)
        path = _study_source(session, item, source)
        terms = study_pdf_mod.week_terms(session, item)
        missing = study_pdf_mod.missing_terms(path.read_text(encoding="utf-8"), terms)
        if missing and not allow_missing:
            print(json.dumps({"built": False, "missing": missing}))
            raise typer.Exit(code=1)
        bundle = study_pdf_mod.build_bundle(session, item)
        output = Path(bundle["output_path"])
        try:
            pages = study_pdf_mod.compile_pdf(path, output)
        except Exception as exc:  # typst.TypstError carries the compiler diagnostics
            print(json.dumps({"built": False, "error": str(exc)}))
            raise typer.Exit(code=1) from exc
        study_pdf_mod.record(session, item, file_path=output, source_path=path,
                             pages=pages, skipped_reason=None)
    warning = None
    if pages < study_pdf_mod.MIN_PAGES or pages > study_pdf_mod.MAX_PAGES:
        warning = f"{pages} pages; target is 10-15"
    print(json.dumps({"built": True, "output": str(output), "pages": pages,
                      "missing": missing, "warning": warning}))


@app.command("study-pdf-skip")
def study_pdf_skip_cmd(
    banner: Annotated[str, typer.Option("--banner")],
    reason: Annotated[str, typer.Option("--reason")],
) -> None:
    """Record that a week deliberately gets no PDF (e.g. every chapter
    already has one and nothing is tested that week)."""
    with session_scope() as session:
        item = _banner_or_exit(session, banner)
        study_pdf_mod.record(session, item, file_path=None, source_path=None,
                             pages=None, skipped_reason=reason)
    console.print("[green]Skipped.[/green]")


@app.command("study-pdf-image")
def study_pdf_image_cmd(
    action: Annotated[str, typer.Argument(help="'search' or 'get'.")],
    query: Annotated[str, typer.Argument(help="Search words, or the Commons file title for 'get'.")],
    banner: Annotated[
        str | None, typer.Option("--banner", help="'get': save into this banner's work_dir/img.")
    ] = None,
    name: Annotated[str | None, typer.Option("--name", help="'get': file name stem.")] = None,
    limit: Annotated[int, typer.Option("--limit")] = 8,
) -> None:
    """Freely licensed images from Wikimedia Commons (CC BY/BY-SA/CC0/
    public domain only). 'search' lists candidates with credit lines;
    'get' downloads one into the week's img/ folder and prints its path
    and the credit to pass to #fig(..., credit: ...)."""
    if action == "search":
        try:
            print(json.dumps(study_pdf_mod.commons_search(query, limit), indent=1))
        except study_pdf_mod.RateLimited as exc:
            console.print(f"[red]{exc}[/red]")
            raise typer.Exit(code=1) from exc
        return
    if action != "get" or banner is None:
        console.print("[red]Use 'search <words>' or 'get <File:...> --banner <id>'.[/red]")
        raise typer.Exit(code=1)
    with session_scope() as session:
        item = _banner_or_exit(session, banner)
        course = repository.get_course(session, item.course_id)
        assert course is not None
        dest = study_pdf_mod.work_dir(course, item) / "img"
    try:
        info = study_pdf_mod.commons_fetch(query, dest, name)
    except (ValueError, study_pdf_mod.RateLimited) as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(code=1) from exc
    info["typst_path"] = "img/" + Path(info["path"]).name
    print(json.dumps(info, indent=1))


@app.command("study-pdf-plot")
def study_pdf_plot_cmd(
    script: Annotated[Path, typer.Argument(help="A matplotlib script inside data/study_pdfs/.")],
) -> None:
    """Run a figure-drawing script (matplotlib) that lives inside
    data/study_pdfs/, with its own folder as the working directory, so
    graphs/diagrams drawn for a PDF save next to its main.typ."""
    import subprocess
    import sys

    path = script.resolve()
    if study_pdf_mod.WORK_ROOT.resolve() not in path.parents or path.suffix != ".py":
        console.print("[red]Only .py scripts inside data/study_pdfs/ can run here.[/red]")
        raise typer.Exit(code=1)
    proc = subprocess.run([sys.executable, "-I", str(path)], cwd=path.parent,
                          capture_output=True, text=True, timeout=300)
    print(proc.stdout + proc.stderr)
    if proc.returncode:
        raise typer.Exit(code=proc.returncode)


@app.command("study-pdf-list")
def study_pdf_list_cmd(
    course: Annotated[str | None, typer.Option("--course")] = None,
) -> None:
    """Every study PDF built or skipped so far, oldest week first."""
    from sqlalchemy import select

    from academic_sync.db.orm import StudyPdfRow

    with session_scope() as session:
        stmt = select(StudyPdfRow).order_by(StudyPdfRow.week_start)
        if course:
            stmt = stmt.where(StudyPdfRow.course_id == _resolve_course_or_exit(session, course).id)
        rows = [
            {"banner_id": r.banner_item_id, "week_start": r.week_start.isoformat(),
             "chapters": r.chapters_json, "file": r.file_path, "pages": r.page_count,
             "skipped": r.skipped_reason}
            for r in session.scalars(stmt)
        ]
    print(json.dumps(rows, indent=1))

@app.command("study-pdf-preview")
def study_pdf_preview_cmd(
    banner: Annotated[str, typer.Option("--banner")],
    pages: Annotated[
        str, typer.Option("--pages", help="Comma list of 1-based pages (e.g. 1,4,9), or 'all' "
                          "for one contact sheet of every page.")
    ] = "all",
) -> None:
    """Render the week's last build to PNGs in work_dir/preview/ -- a
    contact sheet of every page (layout, whitespace, figure placement) or
    chosen pages at reading size -- to look at before calling it done."""
    import pymupdf
    from PIL import Image

    with session_scope() as session:
        item = _banner_or_exit(session, banner)
        course = repository.get_course(session, item.course_id)
        assert course is not None
        wd = study_pdf_mod.work_dir(course, item)
    pdf = wd / "build.pdf"
    if not pdf.is_file():
        console.print("[red]Nothing built yet -- run study-pdf-build first.[/red]")
        raise typer.Exit(code=1)
    out = wd / "preview"
    out.mkdir(exist_ok=True)
    paths = []
    with pymupdf.open(pdf) as doc:
        if pages.strip().lower() == "all":
            thumbs = []
            for page in doc:
                pix = page.get_pixmap(dpi=40)
                thumbs.append(Image.frombytes("RGB", (pix.width, pix.height), pix.samples))
            w, h = thumbs[0].size
            cols = 6
            sheet = Image.new("RGB", (w * cols, h * ((len(thumbs) + cols - 1) // cols)), "white")
            for i, im in enumerate(thumbs):
                sheet.paste(im, ((i % cols) * w, (i // cols) * h))
            path = out / "sheet.png"
            sheet.save(path)
            print(json.dumps([str(path)]))
            return
        for n in (int(p) for p in pages.split(",") if p.strip()):
            if 1 <= n <= doc.page_count:
                path = out / f"page-{n:02d}.png"
                doc[n - 1].get_pixmap(dpi=80).save(path)
                paths.append(str(path))
    print(json.dumps(paths))


@app.command("doc-text")
def doc_text_cmd(
    path: Annotated[Path, typer.Argument(exists=True, dir_okay=False)],
) -> None:
    """Write a downloaded PDF's or Word file's text next to it as `<file>.txt`,
    one `--- page N ---` marker per PDF page, and print a JSON summary. Read
    that text file instead of the PDF: reading a PDF directly sends every page
    as a picture, which is many times larger. Pages with no text (a scanned
    handout) are rendered to `<file>.page-N.png`, the only pages worth
    viewing as images."""
    suffix = path.suffix.lower()
    out = path.with_name(path.name + ".txt")
    images: list[str] = []
    pages = 0
    if suffix == ".pdf":
        import pymupdf

        parts = []
        with pymupdf.open(path) as doc:
            pages = doc.page_count
            for i, page in enumerate(doc, start=1):
                text = page.get_text("text").strip()
                if len(text) < 20:
                    img = path.with_name(f"{path.name}.page-{i}.png")
                    page.get_pixmap(dpi=110).save(img)
                    images.append(str(img))
                    text = f"(no text on this page: view {img.name})"
                parts.append(f"--- page {i} ---\n{text}")
        out.write_text("\n\n".join(parts), encoding="utf-8")
    elif suffix == ".docx":
        import docx

        d = docx.Document(str(path))
        lines = [p.text for p in d.paragraphs]
        for table in d.tables:
            for row in table.rows:
                cells = [c.text.strip().replace("\n", " ") for c in row.cells]
                lines.append(" | ".join(cells))
        out.write_text("\n".join(lines).strip(), encoding="utf-8")
    else:
        console.print("[red]doc-text reads .pdf and .docx files.[/red]")
        raise typer.Exit(code=1)
    text = out.read_text(encoding="utf-8")
    print(json.dumps({"text_file": str(out), "pages": pages, "chars": len(text), "pages_without_text": images}))


if __name__ == "__main__":
    app()
