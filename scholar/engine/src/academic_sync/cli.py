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
import os
import re
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


def _set_event_context(reason: str | None = None) -> None:
    """Who is writing, for the database's history triggers: Kea's run id (KEA_RUN_ID, set by Kea for every run and
    check; a manual or developer session otherwise), the command, and the reason when one is given. Applied inside each
    write transaction (db.session.EVENT_CONTEXT), so concurrent commands can't take each other's credit."""
    import sys

    from academic_sync.db.session import EVENT_CONTEXT

    run_id = os.environ.get("KEA_RUN_ID") or f"manual-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
    task = os.environ.get("KEA_TASK")
    EVENT_CONTEXT.update({"run_id": f"{task}:{run_id}" if task else run_id, "command": " ".join(sys.argv[1:])[:400], "reason": reason})


@app.callback()
def _every_command() -> None:
    _set_event_context()
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
    if suffix == ".docx":
        import docx

        d = docx.Document(str(path))
        lines = [para.text for para in d.paragraphs]
        for table in d.tables:
            for row in table.rows:
                lines.append(" | ".join(cell.text.strip().replace("\n", " ") for cell in row.cells))
        return ParsedDocument(text="\n".join(lines).strip(), title=title)
    if suffix == ".pptx":
        return ParsedDocument(text=pptx_text(path), title=title)
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
# coverage: dated work written down in a course's documents but not on the calendar
# --------------------------------------------------------------------------
# Why this exists: CHE1011's lab schedule (Lab reports #1-#10, done on an outside
# lab platform) was found during the first scan, transcribed into
# data/downloads/CHE1011/lab_handout/ and summarized in raw_notes.md -- and never
# extracted, so none of it reached the calendar. The submission folders were
# hidden until a lab kit was verified, so no later D2L check could see them
# either. Notes are not the calendar: every dated piece of graded work in any
# downloaded course document must be an item, or be dismissed with a reason.
# This check runs the same deterministic extraction over every downloaded file
# (without saving anything) and reports what isn't there.

_COVERAGE_SUFFIXES = {".txt", ".md", ".html", ".htm", ".pdf", ".docx", ".pptx"}


def pptx_text(path: Path) -> str:
    """A PowerPoint deck's text, slide by slide (no extra library: a .pptx is a zip of XML): each slide's title marked
    TITLE (lecture decks put their section headings there, "Concept 22.1: ..."), then its text, then the speaker
    notes."""
    import zipfile
    from xml.etree import ElementTree as ET

    ns = {"a": "http://schemas.openxmlformats.org/drawingml/2006/main", "p": "http://schemas.openxmlformats.org/presentationml/2006/main"}
    num = lambda n: int(re.search(r"(\d+)\.xml$", n).group(1))  # noqa: E731
    parts = []
    with zipfile.ZipFile(path) as z:
        names = set(z.namelist())
        slides = sorted((n for n in names if re.match(r"ppt/slides/slide\d+\.xml$", n)), key=num)
        for n in slides:
            root = ET.fromstring(z.read(n))
            title, body = [], []
            for sp in root.iter(f"{{{ns['p']}}}sp"):
                ph = sp.find(".//p:nvPr/p:ph", ns)
                is_title = ph is not None and ph.get("type") in ("title", "ctrTitle")
                for para in sp.iter(f"{{{ns['a']}}}p"):
                    line = "".join(t.text or "" for t in para.iter(f"{{{ns['a']}}}t")).strip()
                    if line:
                        (title if is_title else body).append(line)
            notes_name = f"ppt/notesSlides/notesSlide{num(n)}.xml"
            notes = []
            if notes_name in names:
                for para in ET.fromstring(z.read(notes_name)).iter(f"{{{ns['a']}}}p"):
                    line = "".join(t.text or "" for t in para.iter(f"{{{ns['a']}}}t")).strip()
                    if line and not line.isdigit():
                        notes.append(line)
            block = [f"--- slide {num(n)} ---"]
            if title:
                block.append("TITLE: " + " ".join(title))
            block += body
            if notes:
                block.append("Notes: " + " ".join(notes))
            parts.append("\n".join(block))
    return "\n\n".join(parts)
# (Not class meetings: lectures and lab sessions repeat every week and aren't handed in.)
_COVERAGE_TYPES = {ItemType.EXAM, ItemType.FINAL_EXAM, ItemType.LAB_PRACTICAL}
_TITLE_STOP = {
    "due", "the", "and", "for", "with", "from", "report", "reports", "lab", "labs", "assignment",
    "online", "chapter", "week", "post", "posts", "initial", "response", "submit", "submission",
    "pdf", "only", "folder", "part", "your", "this", "that", "complete", "other", "deadline",
}
# Words that name the same thing.
_SAME_WORD = {"test": "exam", "tests": "exam", "exams": "exam", "midterm": "exam", "hw": "homework"}
# Kinds of work that are never each other: a lab report, a lab practical, an exam. Everything else (homework, quizzes,
# discussions, papers, "other deadline") is one kind here, since schedules name the same homework quiz or discussion
# reply all three ways ("Chapter 1 HW" is a D2L quiz; "OA 1 response posts" is a discussion).
_FAMILY = {
    ItemType.LAB_HANDOUT: "lab", ItemType.LAB: "lab", ItemType.LAB_PRACTICAL: "practical",
    ItemType.EXAM: "exam", ItemType.FINAL_EXAM: "exam",
}
# Items that aren't on the calendar for real (left out when deciding whether a piece of work is there).
_NOT_THERE = {ItemStatus.CANCELLED, ItemStatus.UNRESOLVED, ItemStatus.DRAFT, ItemStatus.SUPERSEDED}


def _numbers(title: str) -> list[str]:
    """The numbers in a name, whole: "HW: 4.6" is 4.6 (never 4 and 6); years aren't identifiers."""
    import re

    return [n for n in re.findall(r"\d+(?:\.\d+)*", title or "") if not re.fullmatch(r"(19|20)\d\d", n)]


_NUMBER_WORDS = {"one": "1", "two": "2", "three": "3", "four": "4", "five": "5", "six": "6", "seven": "7", "eight": "8",
                 "nine": "9", "ten": "10", "eleven": "11", "twelve": "12", "i": "1", "ii": "2", "iii": "3", "iv": "4",
                 "v": "5", "vi": "6", "vii": "7", "viii": "8", "ix": "9", "x": "10"}
_KIND = (r"lab(?:oratory)?(?:\s+report)?|report|quiz|exam|test|hw|homework|assignment|module|discussion|oa|unit|project|"
         r"paper|essay|worksheet|problem set|handout|practical|activity|chapter|ch")


def _ident_kind(title: str) -> tuple[str | None, str | None]:
    """A piece of work's own number and the word naming it: the first number that follows a word naming work ("Lab
    report #6", "Online Quiz 3: Ch 25", "HW: 4.6", "OA 7", "Practice Exam Three", "Lab Practical I", "Chapter 2 HW"),
    never a time or a points value ("by 11:59 pm", "200 points")."""
    import re

    m = re.search(
        rf"\b({_KIND})\s*[:#.]?\s*#?\s*(\d+(?:\.\d+)*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|i{{1,3}}|iv|vi{{0,3}}|ix|x)\b|#\s*(\d+)\b",
        title or "",
        re.IGNORECASE,
    )
    if not m:
        return None, None
    if m.group(3):
        return m.group(3), None
    raw = m.group(2)
    if re.fullmatch(r"[ivxIVX]+", raw) and (raw != raw.upper() or (m.end() < len(title) and title[m.end()].isalpha())):
        return None, None
    num = raw.lower()
    kind = re.sub(r"\s+report$", "", m.group(1).lower())
    kind = {"ch": "chapter", "homework": "hw", "laboratory": "lab", "test": "exam"}.get(kind, kind)
    num = _NUMBER_WORDS.get(num, num)
    # A chapter is its whole number ("Chapter 1.3 - 1.4" is Chapter 1); homework sections stay exact (4.5 is not 4.6).
    if kind == "chapter":
        num = num.split(".")[0]
    return num, kind


def _ident(title: str) -> str | None:
    return _ident_kind(title)[0]


def _title_words(title: str) -> set[str]:
    import re

    words = set()
    for w in re.findall(r"[a-z]+", (title or "").lower()):
        w = _SAME_WORD.get(w, w)
        if len(w) < 4 or w in _TITLE_STOP:
            continue
        # Plurals are the same word ("Prerequisites", "prerequisite").
        words.add(w[:-1] if len(w) > 4 and w.endswith("s") and not w.endswith("ss") else w)
    return words


def _same_work(candidate: AcademicItem, existing: AcademicItem) -> bool:
    """Whether an existing calendar item is this piece of work: the same day, the same kind of work, the same
    number and the same name. Strict on purpose: calling two different pieces of work "the same" hides a gap, which
    is the dangerous mistake (a false alarm only costs a coverage-dismiss). Rules that came from real misses:
    "HW: 4.6" is never "HW: 4.5"; "Lab 5 report" is never "HW Quiz 5"; "Lab Practical 2" is never "Lab 2 Handout";
    a lab report is never the discussion on the same topic due that day; a different day is a different item (a
    stored date that's a day off is itself a gap to fix)."""
    if candidate.fingerprint and candidate.fingerprint == existing.fingerprint:
        return True
    if candidate.date is None or existing.date is None or candidate.date != existing.date:
        return False
    family = _FAMILY.get(candidate.item_type, "work")
    same_family = family == _FAMILY.get(existing.item_type, "work")
    ia, ib = _ident(candidate.title), _ident(existing.title)
    if ia and ib and ia != ib:
        return False
    a, b = _title_words(candidate.title), _title_words(existing.title)
    # A class has one exam on a day: an exam line on an exam day is that exam (a practice exam is its own thing).
    if family == "exam" and same_family and ("practice" in a) == ("practice" in b):
        return True
    # The same numbered piece of the same kind ("Online Assignment 6" under a new name).
    if same_family and ia and ia == ib:
        return True
    # A nameless line ("Due on Oct 14", "Lab report (SI PDF only)") only counts as the same kind of work that day.
    if not a:
        return same_family and not (ia and not ib)
    if not b:
        return False
    if same_family:
        # Measured against the shorter name, so a longer description of the same work still matches.
        return len(a & b) / min(len(a), len(b)) >= 0.6
    # Different kinds of work are separate unless this one's whole name (two words at least) is in the other's.
    return len(a) >= 2 and a <= b and ia == ib


def _same_undated(candidate: AcademicItem, existing: AcademicItem) -> bool:
    """A numbered piece of work found with no date: the same kind and number, and the same name, at any date."""
    if _FAMILY.get(candidate.item_type, "work") != _FAMILY.get(existing.item_type, "work"):
        return False
    if _ident(candidate.title) != _ident(existing.title):
        return False
    a, b = _title_words(candidate.title), _title_words(existing.title)
    return not a or not b or len(a & b) / min(len(a), len(b)) >= 0.5


def _coverage_key(item: AcademicItem) -> str:
    ident = _ident(item.title) or ""
    return f"{item.date.isoformat() if item.date else ''}|{ident} {' '.join(sorted(_title_words(item.title)))}".rstrip()


def course_documents(course: Course) -> list[Path]:
    """Every downloaded file for this course (folders named after its code, e.g. CHE1011, CHE10111)."""
    from academic_sync.config import get_db_path

    root = get_db_path().parent / "downloads"
    if not root.is_dir():
        return []
    code = (course.course_code or "").lower()
    out: list[Path] = []
    for folder in root.iterdir():
        if folder.is_dir() and code and folder.name.lower().startswith(code):
            # (consolidated_events is Kea's own listing of the calendar and raw_notes a scan's own notes, not course
            # documents: what they summarize is saved as its own file. A PDF's or Word
            # file's `.txt` copy is read as the file itself.)
            out.extend(
                p for p in folder.rglob("*")
                if p.is_file() and p.suffix.lower() in _COVERAGE_SUFFIXES and not p.name.startswith(("consolidated_events", "raw_notes"))
                and not p.name.lower().endswith((".pdf.txt", ".docx.txt", ".pptx.txt"))
            )
    return sorted(out)


def _coverage_documents(session, course: Course) -> tuple[list[tuple[str, ParsedDocument]], list[str]]:
    """Every document to check: the downloaded files and the saved text of every source (announcements and pages
    read live, whose files may be gone). Returns (documents, files that couldn't be read)."""
    from sqlalchemy import text as sql

    docs: list[tuple[str, ParsedDocument]] = []
    unreadable: list[str] = []
    for path in course_documents(course):
        try:
            doc = _load_document(path, path.name)
        except Exception as err:  # noqa: BLE001
            unreadable.append(f"{path} ({type(err).__name__})")
            continue
        if path.suffix.lower() in (".pdf", ".docx") and len((doc.text or "").strip()) < 40:
            # A scanned handout: there may be dates in it that no text can show.
            unreadable.append(f"{path} (no text: scanned or image-only)")
        docs.append((str(path), doc))
    rows = session.execute(
        sql("SELECT title, raw_text FROM sources WHERE course_id = :c AND raw_text IS NOT NULL AND length(raw_text) > 40"),
        {"c": course.id},
    ).all()
    for title, raw in rows:
        docs.append((f"source: {title}", ParsedDocument(text=raw, title=title)))
    return docs, unreadable


def coverage_findings(session, course: Course) -> tuple[list[tuple[str, AcademicItem]], list[str]]:
    """Graded work written in this course's documents with no matching calendar item (dated ones on their day,
    numbered ones found with no date at all), and documents that couldn't be read. Dismissed lines are left out."""
    existing = [i for i in repository.list_items_for_course(session, course.id) if not i.superseded_by_id and i.status not in _NOT_THERE]
    everything = [i for i in repository.list_items_for_course(session, course.id) if not i.superseded_by_id]
    dismissed = set(repository.get_preference(session, "coverage_dismissed", course_id=course.id, default=[]) or [])
    config = get_config()
    reference_year = course.start_date.year if course.start_date else datetime.now().year
    # The term: the course's own dates, else the span of what's already on its calendar.
    dated = sorted(i.date for i in existing if i.date)
    start = course.start_date or (dated[0] if dated else None)
    end = course.end_date or (dated[-1] if dated else None)
    found: list[tuple[str, AcademicItem]] = []
    seen: set[str] = set()
    docs, unreadable = _coverage_documents(session, course)
    for where, document in docs:
        is_pdf = where.lower().endswith(".pdf")
        ctx = ExtractionContext(
            course_id=course.id,
            source_id="coverage-check",
            reference_year=reference_year,
            term_start=course.start_date,
            term_end=course.end_date,
            reference_phrases=config.completeness.reference_phrases,
            # Schedules are grids of bare dates ("9/14"); the term gives the year.
            allow_bare_dates=True,
        )
        try:
            result = extract_from_document(document, ctx)
        except Exception as err:  # noqa: BLE001
            unreadable.append(f"{where} (couldn't be read: {type(err).__name__})")
            continue
        for item in result.items:
            if not (item.item_type.is_deadline or item.item_type in _COVERAGE_TYPES):
                continue
            if item.date is None:
                # No date found: still reported when it's a numbered piece of work ("Lab report #3") that isn't
                # on the calendar under any date, so a schedule Kea can't read doesn't hide it.
                if not _ident(item.title) or item.title[:1].islower():
                    continue
                key = _coverage_key(item)
                if key in seen or key in dismissed or any(_same_undated(item, e) for e in everything):
                    continue
                seen.add(key)
                found.append((where, item))
                continue
            # Policy prose in a PDF picks up whatever date heading came before it ("Each quiz will..."):
            # only a line that names its own date, or a dated grid in a page or text file, counts.
            if is_pdf and "date heading" in (item.source_wording or "") and not _ident(item.title):
                continue
            if is_pdf and item.title[:1].islower():
                continue
            if start and item.date < start - timedelta(days=14):
                continue
            if end and item.date > end + timedelta(days=14):
                continue
            key = _coverage_key(item)
            if key in seen or key in dismissed or any(_same_work(item, e) for e in existing):
                continue
            seen.add(key)
            found.append((where, item))
    return found, unreadable


def uncovered_document_items(session, course: Course) -> list[tuple[str, AcademicItem]]:
    """Graded work written in this course's documents with no matching calendar item (see coverage_findings)."""
    return coverage_findings(session, course)[0]


@app.command("coverage")
def coverage_cmd(
    course: Annotated[str, typer.Option("--course")],
    as_json: Annotated[bool, typer.Option("--json")] = False,
) -> None:
    """List graded work written in this course's documents that isn't on the calendar (dated ones, and numbered
    ones with no date found), and documents that couldn't be read. Each item must be added (extract the file, or
    create the item) or dismissed with coverage-dismiss and a reason; each unreadable file must be read another way."""
    with session_scope() as session:
        c = _resolve_course_or_exit(session, course)
        code = c.course_code
        found, unreadable = coverage_findings(session, c)
        rows = [
            {
                "file": where,
                "date": i.date.isoformat() if i.date else None,
                "type": i.item_type.value,
                "title": i.title,
                "key": _coverage_key(i),
            }
            for where, i in found
        ]
    if as_json:
        print(json.dumps({"course": code, "uncovered": rows, "unreadable": unreadable}, indent=1))
        return
    if not rows and not unreadable:
        console.print(f"{code}: every piece of graded work in its documents is on the calendar.")
        return
    if rows:
        console.print(f"[red]{code}: {len(rows)} item(s) in its documents aren't on the calendar:[/red]")
        for r in rows:
            console.print(f"  {r['date'] or 'no date found'}  {escape(r['title'])}  [dim]({r['type']}; {escape(r['file'])})[/dim]")
    if unreadable:
        console.print(f"[yellow]{len(unreadable)} document(s) couldn't be read (check them another way):[/yellow]")
        for u in unreadable:
            console.print(f"  {escape(u)}")


# --------------------------------------------------------------------------
# d2l-reconcile: every graded thing D2L itself lists, matched to the calendar
# --------------------------------------------------------------------------
# The coverage check reads documents; this reads D2L's own lists (assignment folders, quizzes, discussion topics,
# graded content topics, grade items), as saved by Kea's daily pre-check, and finds each one on the calendar. Anything
# D2L lists that the calendar doesn't have, or has on another day, is reported, every day, until it's added, fixed or
# dismissed with a reason (coverage-dismiss --key d2l:<kind>:<id>). Kea's own snapshots only noticed what *changed*,
# so anything missing from the first scan stayed missing forever (CHE1011's Practice Final, OA #6 quiz, Exam Work).

def _local_day(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone().date()
    except ValueError:
        return None


def _rich(v) -> str:
    """D2L rich text ({Text, Html}, {Text: {Text, Html}, IsDisplayed} or a string) as plain text."""
    while isinstance(v, dict) and isinstance(v.get("Text"), dict):
        v = v["Text"]
    if isinstance(v, dict):
        v = v.get("Text") or re.sub(r"<[^>]+>", " ", v.get("Html") or "")
    return re.sub(r"[ \t]+", " ", re.sub(r"\n{3,}", "\n\n", str(v or ""))).strip()


def _folder_instructions(f: dict) -> str:
    """An assignment folder's instructions, attachments and rubric, as the student would read them in D2L."""
    parts = []
    text = _rich(f.get("CustomInstructions"))
    if text:
        parts.append(text)
    files = [a.get("FileName") for a in (f.get("Attachments") or []) if isinstance(a, dict) and a.get("FileName")]
    if files:
        parts.append("Attached: " + ", ".join(files))
    links = [a.get("LinkName") or a.get("Href") for a in (f.get("LinkAttachments") or []) if isinstance(a, dict)]
    if [x for x in links if x]:
        parts.append("Links: " + ", ".join(x for x in links if x))
    rules = []
    if f.get("AllowableFileType") not in (None, 0):
        rules.append("specific file types only")
    if f.get("SubmissionType") == 0 or f.get("SubmissionType") == "File":
        rules.append("file submission")
    for r in ((f.get("Assessment") or {}).get("Rubrics") or []):
        lines = [f"Rubric: {r.get('Name', '')}"]
        for g in r.get("CriteriaGroups") or []:
            for c in g.get("Criteria") or []:
                cells = c.get("Cells") or []
                top = max((x.get("Points") or 0 for x in cells), default=0)
                best = next((x.get("Description") for x in cells if (x.get("Points") or 0) == top and x.get("Description")), "")
                lines.append(f"- {c.get('Name', '')} ({top:g} pts){': ' + _rich(best)[:240] if best else ''}")
        parts.append("\n".join(lines))
    denom = (f.get("Assessment") or {}).get("ScoreDenominator")
    if denom:
        parts.append(f"Worth {denom:g} points." + (f" ({', '.join(rules)})" if rules else ""))
    return "\n\n".join(p for p in parts if p).strip()[:8000]


def _d2l_objects(folder: Path, code: str) -> list[dict]:
    """D2L's graded things for a class, from a pre-check folder: {kind, id, title, day, has_date, grade_id}."""
    def load(area):
        try:
            return json.loads((folder / f"{code}-{area}.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    out: list[dict] = []
    for f in load("dropbox") or []:
        if f.get("IsHidden"):
            continue
        due = f.get("DueDate") or (f.get("Availability") or {}).get("EndDate")
        out.append({"kind": "dropbox", "id": str(f.get("Id")), "title": f.get("Name", ""), "day": _local_day(due),
                    "grade_id": str(f.get("GradeItemId") or "") or None, "instructions": _folder_instructions(f)})
    quizzes = load("quizzes") or {}
    for q in (quizzes.get("Objects") if isinstance(quizzes, dict) else quizzes) or []:
        if q.get("IsActive") is False:
            continue
        due = q.get("DueDate") or q.get("EndDate")
        out.append({"kind": "quiz", "id": str(q.get("QuizId")), "title": q.get("Name", ""), "day": _local_day(due),
                    "grade_id": str(q.get("GradeItemId") or "") or None,
                    "instructions": _rich(q.get("Instructions")) or _rich(q.get("Description"))})
    for t in load("discussions") or []:
        due = t.get("DueDate") or t.get("EndDate") or t.get("UnlockEndDate")
        graded = (t.get("ScoreOutOf") or 0) > 0 or t.get("GradeItemId")
        if t.get("IsHidden") or not (due or graded):
            continue
        out.append({"kind": "discussion", "id": str(t.get("TopicId")), "title": f"{t.get('Name', '')}",
                    "day": _local_day(due), "grade_id": str(t.get("GradeItemId") or "") or None,
                    "instructions": _rich(t.get("Description"))})
    toc = load("content") or {}

    def walk(mods):
        for m in mods or []:
            if m.get("IsHidden"):
                continue
            for t in m.get("Topics") or []:
                if t.get("IsHidden"):
                    continue
                # (Only a due date is compared: a topic's end date is often the late window closing.)
                due = t.get("DueDate")
                if t.get("GradeItemId") or t.get("DueDate"):
                    out.append({"kind": "content", "id": str(t.get("TopicId") or t.get("Identifier")), "title": t.get("Title", ""),
                                "day": _local_day(due), "grade_id": str(t.get("GradeItemId") or "") or None})
            walk(m.get("Modules"))

    walk(toc.get("Modules") if isinstance(toc, dict) else None)
    linked = {o["grade_id"] for o in out if o.get("grade_id")}
    for g in load("grades") or []:
        if g.get("GradeObjectType") == 9 or "category" in str(g.get("GradeObjectTypeName", "")).lower():
            continue
        gid = str(g.get("GradeObjectIdentifier"))
        if gid in linked:
            continue  # already checked through the folder, quiz or topic it grades
        out.append({"kind": "grade", "id": gid, "title": g.get("GradeObjectName", ""), "day": None, "grade_id": gid})
    return [o for o in out if str(o.get("title") or "").strip()]


_WORK_KINDS = {"discussion", "assignment", "review", "quiz", "exam", "lab", "practical", "essay", "paper", "project", "hw", "worksheet", "handout"}


def _kinds(title: str) -> dict[str, str]:
    """Every (kind -> number) a name carries: "Module 4 Assignment 2" is {module: 4, assignment: 2}."""
    out: dict[str, str] = {}
    for m in re.finditer(rf"\b({_KIND})\s*[:#.]?\s*#?\s*(\d+(?:\.\d+)*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b", title or "", re.IGNORECASE):
        kind = re.sub(r"\s+report$", "", m.group(1).lower())
        kind = {"ch": "chapter", "homework": "hw", "laboratory": "lab", "test": "exam", "oa": "assignment"}.get(kind, kind)
        num = _NUMBER_WORDS.get(m.group(2).lower(), m.group(2).lower())
        out.setdefault(kind, num.split(".")[0] if kind == "chapter" else num)
    return out


def _work_words(title: str) -> set[str]:
    # ("the assignment folder" is where work goes, not what it is.)
    t = re.sub(r"assignment (submission )?folders?", "", (title or "").lower())
    found = {k for k in _WORK_KINDS if re.search(rf"\b{k}s?\b", t)}
    if re.search(r"\bhomework\b|\bhw\b", t):
        found.add("hw")
    if re.search(r"\boa\b|\bonline assignment", t):
        found.add("assignment")
    if "test" in t.split():
        found.add("exam")
    return found


def _reconcile_score(obj: dict, item: AcademicItem):
    """How well an item fits a D2L object (higher is better), or None when they're different work."""
    ka, kb = _kinds(obj["title"]), _kinds(item.title)
    for k in set(ka) & set(kb):
        if ka[k] != kb[k]:
            return None
    wa, wb = _work_words(obj["title"]), _work_words(item.title)
    # Different kinds of work (a discussion and an assignment of the same module) are never each other.
    if wa and wb and not (wa & wb):
        return None
    # (A handout and the folder it's turned in to are the same work, so "handout" isn't one of these.)
    for mark in ("practice", "work", "review"):
        if (re.search(rf"\b{mark}\b", obj["title"].lower()) is None) != (re.search(rf"\b{mark}\b", item.title.lower()) is None):
            return None
    a, b = _title_words(obj["title"]), _title_words(item.title)
    shared_kinds = len(set(ka) & set(kb))
    # Measured against the shorter name, unless only one of them carries a number (then against the longer: "Review:
    # Chapter 3" is not "HW: Final Review" just for sharing "review").
    one_numbered = bool(ka) != bool(kb)
    overlap = len(a & b) / (max if one_numbered else min)(len(a), len(b)) if a and b else 0.0
    if overlap < 0.5 and not (shared_kinds and (not a or not b)) and not (shared_kinds >= 2):
        if not (shared_kinds and wa & wb):
            return None
    return overlap * 2 + shared_kinds


def _reconcile_match(obj: dict, items: list[AcademicItem], taken: set | None = None):
    """(matched item, days apart) for a D2L object, best fit first (words, then kinds, then the nearest date); an
    item already matched to another dated object isn't used twice. None when nothing fits."""
    best = None
    for i in items:
        if taken is not None and i.id in taken:
            continue
        score = _reconcile_score(obj, i)
        if score is None:
            continue
        gap = abs((i.date - obj["day"]).days) if (i.date and obj["day"]) else 999
        key = (score, -gap)
        if best is None or key > best[2]:
            best = (i, gap, key)
    return (best[0], best[1]) if best else None


def reconcile_findings(session, course: Course, folder: Path | None = None) -> dict:
    """Unmatched D2L objects and date drift for a course, from the newest pre-check folder that has its files."""
    from academic_sync.config import get_db_path

    root = get_db_path().parent / "digests" / "kea-precheck"
    if folder is None:
        days = sorted((d for d in root.iterdir() if d.is_dir() and any(d.glob(f"{course.course_code}-*.json"))), reverse=True) if root.is_dir() else []
        folder = days[0] if days else None
    if folder is None:
        return {"folder": None, "unmatched": [], "drift": [], "_matched": []}
    # (Graded work only: a reading week, a lecture or a break is never the thing D2L grades.)
    not_work = {ItemType.WEEKLY_READING, ItemType.READING, ItemType.LECTURE, ItemType.BREAK, ItemType.NO_CLASS, ItemType.RECITATION, ItemType.SEMINAR}
    items = [i for i in repository.list_items_for_course(session, course.id) if not i.superseded_by_id and i.status not in (ItemStatus.CANCELLED, ItemStatus.SUPERSEDED) and i.item_type not in not_work]
    dismissed = set(repository.get_preference(session, "coverage_dismissed", course_id=course.id, default=[]) or [])
    # Items taken off the calendar (replaced, folded into a reading week, cancelled), any kind: when D2L lists graded
    # work that matches only one of these, it was hidden by mistake (real case: MAT1340's graded ALEKS reviews, read
    # as readings in August and folded into their reading weeks).
    hidden_items = [i for i in repository.list_items_for_course(session, course.id) if i.superseded_by_id or i.status in (ItemStatus.CANCELLED, ItemStatus.SUPERSEDED)]
    unmatched, drift, matched, hidden = [], [], [], []
    taken: set = set()
    hidden_taken: set = set()
    # Dated objects first (they're the surest), each item matched to one dated object at most.
    objects = sorted(_d2l_objects(folder, course.course_code), key=lambda o: (o["day"] is None, o["kind"] == "grade"))
    for o in objects:
        key = f"d2l:{o['kind']}:{o['id']}"
        hit = _reconcile_match(o, items, taken if o["day"] else None)
        if hit is not None:
            matched.append((o, hit[0]))
            if o["day"]:
                taken.add(hit[0].id)
        if key in dismissed:
            continue
        row = {"key": key, "kind": o["kind"], "id": o["id"], "title": o["title"], "d2l_date": o["day"].isoformat() if o["day"] else None}
        gone = _reconcile_match(o, hidden_items, hidden_taken) if hit is None else None
        if gone is not None:
            hidden_taken.add(gone[0].id)
            hidden.append({**row, **_hidden_how(session, gone[0])})
        elif hit is None:
            unmatched.append(row)
        elif o["day"] and hit[0].date and hit[1] > 0:
            # On the calendar on a different day than D2L says (D2L wins; a day off often means a time-zone slip).
            drift.append({**row, "item_id": hit[0].id, "item_title": hit[0].title, "item_date": hit[0].date.isoformat()})
    # Graded-looking work folded into a reading week or lecture that D2L doesn't list (yet: future reviews often have
    # no grade item until they open). Code can't tell a graded "Review: Chapter 2" from a reading week called "Review
    # Ch. 1-2", so each goes to the daily check to judge once: put it back, or dismiss it (key hidden:<id>) saying why.
    suspects = []
    hidden_ids = {h["item_id"] for h in hidden}
    graded = re.compile(r"\b(review|quiz|exam|test|homework|hw|assignment|lab|discussion|essay|paper|project|practical|worksheet|report|aleks)\b", re.IGNORECASE)
    for i in hidden_items:
        if i.id in hidden_ids or not i.superseded_by_id or f"hidden:{i.id}" in dismissed:
            continue
        by = next((x for x in repository.list_items_for_course(session, course.id) if x.id == i.superseded_by_id), None) if graded.search(i.title or "") else None
        # (Not a suspect when the same work is already on the calendar under another name, within a day: "Review:
        # Chapter 5 & 7" folded away while "HW: Ch 5 & 7 Review" is there.)
        words = lambda t: set(re.findall(r"[a-z]+|\d+", (t or "").lower().replace("chapter", "ch"))) - {"ch", "the", "and", "of", "hw", "due"}  # noqa: E731
        twin = any(i.date and x.date and abs((x.date - i.date).days) <= 1 and words(i.title) and len(words(i.title) & words(x.title)) >= 0.6 * len(words(i.title))
                   for x in items)
        if by is not None and not twin and by.item_type in not_work and i.item_type in not_work | {ItemType.OTHER_DEADLINE}:
            suspects.append({"key": f"hidden:{i.id}", "item_id": i.id, "title": i.title, "date": i.date.isoformat() if i.date else None,
                             **{k: v for k, v in _hidden_how(session, i).items() if k in ("how", "replaced_by")}})
    return {"folder": str(folder), "unmatched": unmatched, "drift": drift, "hidden": hidden, "suspects": suspects, "_matched": matched}


def _hidden_how(session, item: AcademicItem) -> dict:
    """How and when an item was taken off the calendar: what replaced it, and the history entry that did it (or that it
    happened before Kea kept history)."""
    from sqlalchemy import text as sql

    by = session.execute(sql("SELECT title, item_type FROM academic_items WHERE id = :i"), {"i": item.superseded_by_id}).first() if item.superseded_by_id else None
    ev = session.execute(
        sql("SELECT ts, run_id, reason FROM item_events WHERE row_id = :i AND op IN ('supersede', 'cancel') ORDER BY ts DESC LIMIT 1"), {"i": item.id}
    ).first()
    first = session.execute(sql("SELECT first_seen FROM academic_items WHERE id = :i"), {"i": item.id}).scalar()
    status = "cancelled" if item.status == ItemStatus.CANCELLED else "superseded"
    if ev is not None:
        when = f"{status} {str(ev[0])[:10]} by run {ev[1]}" + (f" ({ev[2]})" if ev[2] else "")
    else:
        when = f"{status} before Kea kept history (the item was first seen {str(first)[:10]})"
    return {"item_id": item.id, "item_title": item.title, "item_type": item.item_type.value, "status": status,
            "replaced_by": by[0] if by else None, "replaced_by_type": by[1] if by else None, "how": when}


@app.command("d2l-reconcile")
def d2l_reconcile_cmd(
    course: Annotated[str, typer.Option("--course")],
    folder: Annotated[Path | None, typer.Option("--dir", help="A pre-check folder (default: the newest one).")] = None,
    as_json: Annotated[bool, typer.Option("--json")] = False,
    fill_instructions: Annotated[bool, typer.Option("--fill-instructions", help="Copy each matched item's D2L instructions and rubric into its details.")] = False,
    restore_hidden: Annotated[bool, typer.Option("--restore-hidden", help="Put back graded work D2L lists that had been "
                                                 "replaced (superseded) by mistake, as graded work; cancelled items are only reported.")] = False,
) -> None:
    """Every graded thing D2L lists for this course (assignment folders, quizzes, discussion topics, graded content,
    grade items) matched to the calendar: lists what's missing and what's on a different day. Each one must be added,
    corrected, or dismissed with coverage-dismiss --key d2l:<kind>:<id> and the reason. With --fill-instructions, the
    instructions, attachments and rubric D2L shows for each matched item become its details (the student sees them in
    Kea), and are kept up to date when the instructor edits them."""
    filled = 0
    with session_scope() as session:
        c = _resolve_course_or_exit(session, course)
        code = c.course_code
        r = reconcile_findings(session, c, folder)
        if fill_instructions:
            from academic_sync.db.orm import AcademicItemRow

            _set_event_context("Instructions copied from D2L")
            for o, item in r["_matched"]:
                text = (o.get("instructions") or "").strip()
                if len(text) < 20 or text.startswith("{'Text'"):
                    row = session.get(AcademicItemRow, item.id)
                    # (Undo the unreadable text an earlier version copied in from an empty quiz description.)
                    if row is not None and (row.description or "").startswith("From D2L") and "{'Text'" in (row.description or ""):
                        row.description = None
                        filled += 1
                    continue
                row = session.get(AcademicItemRow, item.id)
                header = f"From D2L ({o['kind']} \"{o['title']}\"):\n"
                current = row.description or "" if row is not None else ""
                if row is not None and current.strip() != (header + text).strip():
                    # The same D2L object always refreshes it (an instructor's edit, even a shorter one); another
                    # object matching the same item (a folder and its quiz) replaces it only with longer text.
                    if not current or current.startswith(header) or not current.startswith("From D2L") or len(header + text) > len(current):
                        row.description = header + text
                        filled += 1
        restored = []
        if restore_hidden and r["hidden"]:
            from sqlalchemy import text as sql

            from academic_sync.db.session import EVENT_CONTEXT

            kinds = {"quiz": "quiz", "discussion": "discussion", "dropbox": "assignment", "grade": "assignment", "content": "assignment"}
            for h in r["hidden"]:
                if h["status"] != "superseded":
                    continue
                # (Each change credited with its own reason in the item's history.)
                EVENT_CONTEXT["reason"] = (f"D2L lists it as graded work ({h['kind']} \"{h['title']}\"), so it goes back on the calendar; it had been "
                                           f"{h['how']}" + (f", folded into \"{h['replaced_by']}\"" if h['replaced_by'] else ""))
                session.execute(sql("UPDATE event_context SET reason = :r WHERE id = 1"), {"r": EVENT_CONTEXT["reason"]})
                not_work = ("weekly_reading", "reading", "lecture", "break", "no_class", "recitation", "seminar")
                session.execute(
                    sql("UPDATE academic_items SET superseded_by_id = NULL, status = 'clear', item_type = CASE WHEN item_type IN ('weekly_reading', 'reading', 'lecture', 'break', 'no_class', 'recitation', 'seminar') THEN :t ELSE item_type END WHERE id = :i"),
                    {"i": h["item_id"], "t": kinds.get(h["kind"], "assignment")},
                )
                restored.append({**h, "retyped": h["item_type"] in not_work})
        r["restored"] = restored
    r.pop("_matched", None)
    r["instructions_filled"] = filled
    if as_json:
        print(json.dumps({"course": code, **r}, indent=1, default=str))
        return
    for h in r["hidden"]:
        done = any(x["item_id"] == h["item_id"] for x in r.get("restored", []))
        console.print(f"[magenta]{'Put back' if done else 'Hidden'}:[/magenta] {h['kind']} {escape(h['title'])}: it was {escape(h['how'])}"
                      + (f", folded into {escape(h['replaced_by'])}" if h["replaced_by"] else "") + f"  [dim]{h['key']}[/dim]")
    if not r["unmatched"] and not r["drift"]:
        console.print(f"{code}: everything D2L lists is on the calendar, on D2L's day." + ("" if r["folder"] else " (No pre-check data yet.)"))
        for sp in r["suspects"]:
            console.print(f"[yellow]Check:[/yellow] {escape(sp['title'])} ({sp['date']}) looks like graded work but was folded into "
                          f"{escape(sp['replaced_by'] or '?')}: item-restore it as graded work, or coverage-dismiss --key {sp['key']} --note \"not graded: ...\"")
        return
    for u in r["unmatched"]:
        console.print(f"[red]Not on the calendar:[/red] {u['kind']} {escape(u['title'])} ({u['d2l_date'] or 'no date in D2L'})  [dim]{u['key']}[/dim]")
    for d in r["drift"]:
        console.print(f"[yellow]Different day:[/yellow] {escape(d['title'])}: D2L {d['d2l_date']}, calendar {d['item_date']} ({escape(d['item_title'])})  [dim]{d['key']}[/dim]")


# --------------------------------------------------------------------------
# item history: when, why and by which run every item changed
# --------------------------------------------------------------------------
def _events(session, where: str, params: dict, limit: int = 2000) -> list[dict]:
    from sqlalchemy import text as sql

    rows = session.execute(sql(f"SELECT ts, run_id, command, reason, op, table_name, row_id, course_id, changes_json FROM item_events WHERE {where} ORDER BY ts, id LIMIT {int(limit)}"), params).all()
    out = []
    for ts, run_id, command, reason, op, table, row_id, course_id, ch in rows:
        try:
            changes = json.loads(ch) if ch else None
        except ValueError:
            changes = ch
        out.append({"ts": ts, "run": run_id, "command": command, "reason": reason, "op": op, "table": table, "id": row_id, "course_id": course_id, "changes": changes})
    return out


@app.command("item-history")
def item_history_cmd(
    item_id: Annotated[str, typer.Argument(help="The item's id (or its first 8 characters).")],
    as_json: Annotated[bool, typer.Option("--json")] = False,
) -> None:
    """Everything that ever happened to one calendar item: created (from which source), each change (old -> new, per
    field), superseded, cancelled, restored, unsynced; with the time, the Kea run and command, and the reason."""
    from sqlalchemy import text as sql

    with session_scope() as session:
        full = session.execute(sql("SELECT id FROM academic_items WHERE id = :i OR id LIKE :p LIMIT 2"), {"i": item_id, "p": f"{item_id}%"}).all()
        if len(full) != 1:
            console.print("[red]No single item matches that id.[/red]")
            raise typer.Exit(1)
        iid = full[0][0]
        events = _events(session, "row_id = :i", {"i": iid})
        item = session.execute(sql("SELECT title, date, status, source_ids_json, superseded_by_id FROM academic_items WHERE id = :i"), {"i": iid}).one()
        try:
            src_ids = json.loads(item[3] or "[]")
        except ValueError:
            src_ids = []
        sources = [dict(zip(("id", "title", "source_type", "url", "local_path", "retrieved_at"), r)) for r in session.execute(
            sql("SELECT id, title, source_type, url, local_path, retrieved_at FROM sources WHERE id IN (SELECT value FROM json_each(:j))"), {"j": json.dumps(src_ids)}).all()]
    out = {"id": iid, "title": item[0], "date": item[1], "status": item[2], "superseded_by": item[4], "sources": sources, "events": events}
    if as_json:
        print(json.dumps(out, indent=1, default=str))
        return
    console.print(f"[bold]{escape(item[0])}[/bold] ({item[1] or 'no date'}, {item[2]})")
    for e in events:
        what = e["changes"] if e["op"] != "create" else "created"
        if isinstance(what, dict) and e["op"] not in ("create", "baseline"):
            what = "; ".join(f"{k}: {v[0]!r} -> {v[1]!r}" for k, v in what.items() if isinstance(v, list) and len(v) == 2)
        console.print(f"  {e['ts'][:19]}  {e['op']:<9} {escape(str(what))[:300]}  [dim]{e['run'] or ''} · {escape(e['command'] or '')[:80]}{' · ' + escape(e['reason']) if e['reason'] else ''}[/dim]")


@app.command("changes")
def changes_cmd(
    course: Annotated[str | None, typer.Option("--course")] = None,
    since: Annotated[str | None, typer.Option("--since", help="YYYY-MM-DD (default: 7 days ago).")] = None,
    run: Annotated[str | None, typer.Option("--run", help="Only this Kea run.")] = None,
    as_json: Annotated[bool, typer.Option("--json")] = False,
) -> None:
    """What changed on the calendar: items added, moved, renamed, superseded, cancelled, dismissed, since a date (or
    in one run), with the reasons."""
    from sqlalchemy import text as sql

    start = since or (date.today() - timedelta(days=7)).isoformat()
    with session_scope() as session:
        where, params = "ts >= :s AND op <> 'baseline'", {"s": start}
        if course:
            where += " AND course_id = :c"
            params["c"] = _resolve_course_or_exit(session, course).id
        if run:
            where += " AND run_id LIKE :r"
            params["r"] = f"%{run}%"
        events = _events(session, where, params, limit=5000)
        titles = dict(session.execute(sql("SELECT id, title FROM academic_items")).all())
        codes = dict(session.execute(sql("SELECT id, course_code FROM courses")).all())
        # (Chapter notes by their chapter, syllabus outcomes by their number.)
        chapters = dict(session.execute(sql("SELECT id, chapter_label || ' notes' FROM chapter_topics")).all())
        outcomes = dict(session.execute(sql("SELECT id, 'Syllabus ' || kind || ' ' || ref FROM course_outcomes")).all())
    for e in events:
        e["title"] = {"academic_items": titles, "chapter_topics": chapters, "course_outcomes": outcomes}.get(e["table"], {}).get(e["id"])
        e["course"] = codes.get(e["course_id"])
    if as_json:
        print(json.dumps({"since": start, "events": events}, indent=1, default=str))
        return
    for e in events:
        console.print(f"{e['ts'][:16]}  {e['course'] or '':<8} {e['op']:<9} {escape(e['title'] or e['id'] or '')[:70]}  [dim]{escape(e['reason'] or '')[:120]}[/dim]")


def _item_status_change(item_id: str, reason: str, *, by: str | None = None, cancel: bool = False, restore: bool = False, as_type: str | None = None) -> None:
    from sqlalchemy import text as sql

    if len(reason.strip()) < 8:
        console.print("[red]Give the real reason in --reason.[/red]")
        raise typer.Exit(1)
    _set_event_context(reason.strip())
    with session_scope() as session:
        row = session.execute(sql("SELECT id, status FROM academic_items WHERE id = :i OR id LIKE :p"), {"i": item_id, "p": f"{item_id}%"}).all()
        if len(row) != 1:
            console.print("[red]No single item matches that id.[/red]")
            raise typer.Exit(1)
        iid = row[0][0]
        if restore:
            session.execute(sql("UPDATE academic_items SET superseded_by_id = NULL, status = CASE WHEN status IN ('superseded', 'cancelled') THEN 'clear' ELSE status END WHERE id = :i"), {"i": iid})
            if as_type:
                session.execute(sql("UPDATE academic_items SET item_type = :t WHERE id = :i"), {"t": ItemType(as_type).value, "i": iid})
        elif cancel:
            session.execute(sql("UPDATE academic_items SET status = 'cancelled' WHERE id = :i"), {"i": iid})
        else:
            other = session.execute(sql("SELECT id FROM academic_items WHERE id = :b OR id LIKE :p"), {"b": by, "p": f"{by}%"}).all()
            if len(other) != 1:
                console.print("[red]--by must name exactly one item.[/red]")
                raise typer.Exit(1)
            session.execute(sql("UPDATE academic_items SET superseded_by_id = :b, status = 'superseded' WHERE id = :i"), {"b": other[0][0], "i": iid})
    console.print("Done; the reason is in the item's history.")


@app.command("item-supersede")
def item_supersede_cmd(
    item_id: Annotated[str, typer.Argument()],
    by: Annotated[str, typer.Option("--by", help="The item that replaces it.")],
    reason: Annotated[str, typer.Option("--reason", help="Why (e.g. 'duplicate of the dropbox listing', 'moved by the 9/2 announcement').")],
) -> None:
    """Replace an item by another one (a duplicate, or a moved/renamed version), with the reason. Nothing is deleted."""
    _item_status_change(item_id, reason, by=by)


@app.command("item-cancel")
def item_cancel_cmd(
    item_id: Annotated[str, typer.Argument()],
    reason: Annotated[str, typer.Option("--reason", help="Why, quoting the source that says so.")],
) -> None:
    """Mark an item cancelled (the class site says it no longer applies), with the reason. Nothing is deleted."""
    _item_status_change(item_id, reason, cancel=True)


@app.command("item-restore")
def item_restore_cmd(
    item_id: Annotated[str, typer.Argument()],
    reason: Annotated[str, typer.Option("--reason")],
    as_type: Annotated[str | None, typer.Option("--as-type", help="Its real kind, when it had been read as the wrong one "
                                                "(a graded review read as a reading): assignment, quiz, exam, discussion, lab...")] = None,
) -> None:
    """Bring back a superseded or cancelled item, with the reason."""
    _item_status_change(item_id, reason, restore=True, as_type=as_type)


# --------------------------------------------------------------------------
# course-rules: the rules a class grades by, wherever they're written
# --------------------------------------------------------------------------
# Late policies, "no work, no credit", upload windows, exam-environment rules, participation rules: sentences in the
# syllabus, announcements and course pages that can cost points. They were never kept anywhere (the coverage check
# even dismissed two late-policy sentences as "not work"), so they're gathered here, deterministically, every time.
_RULE = re.compile(
    r"\b(must|required|requirement|zero|no credit|no work|late|deduct\w*|penalt\w*|will not be accepted|not be accepted|"
    r"within \d+ (?:minutes?|hours?|days?)|full credit|fail(?:ing|ure)?|plagiari\w*|academic (?:dis)?honesty|lockdown|"
    r"respondus|webcam|make-?ups?|extensions?|dropped from|attendance|participation|on different days|at least \d+|"
    r"no retakes?|not be dropped|cannot be dropped|single file|numbered)\b",
    re.IGNORECASE,
)
_RULE_STRONG = re.compile(r"\b(zero|no credit|will not be accepted|not be accepted|fail\w*|within \d+|must|required|deduct\w*|penalt\w*)\b", re.IGNORECASE)


def course_rules(session, course: Course) -> list[dict]:
    """[{text, where, strength}] rule sentences for a course, strongest first, de-duplicated."""
    seen: set[str] = set()
    out: list[dict] = []
    docs, _ = _coverage_documents(session, course)
    # Announcements and assignment/discussion text Kea saved from D2L, too.
    from academic_sync.config import get_db_path

    root = get_db_path().parent / "digests" / "kea-precheck"
    days = sorted((d for d in root.iterdir() if d.is_dir()), reverse=True)[:1] if root.is_dir() else []
    for d in days:
        try:
            news = json.loads((d / f"{course.course_code}-news.json").read_text(encoding="utf-8"))
            for n in news or []:
                body = _rich(n.get("Body"))
                if body:
                    docs.append((f"announcement: {n.get('Title', '')}", ParsedDocument(text=body, title=n.get("Title", ""))))
        except (OSError, ValueError):
            pass
    for where, doc in docs:
        # (Study material isn't rules: guided readings, FunSheets, worksheets and keys say "must" about chemistry.)
        name = Path(where).name if not where.startswith(("source:", "announcement:")) else where
        if re.search(r"guided|fun ?sheet|worksheet|answer|\bkey\b|review|objectives|study ?guide|textbook|^ch ?\d|chapter \d", name, re.IGNORECASE):
            continue
        # PDFs often repeat each line (headings drawn twice): keep one of each.
        lines, prev = [], None
        for ln in (doc.text or "").splitlines():
            if ln.strip() and ln.strip() == prev:
                continue
            prev = ln.strip()
            lines.append(ln)
        text = re.sub(r"[ \t]+", " ", "\n".join(lines))
        for sentence in re.split(r"(?<=[.!?])\s+|\n{2,}|\n(?=[-•*\d])", text):
            sentence = re.sub(r"\s+", " ", sentence.strip(" -•*\t\n"))
            if not (25 <= len(sentence) <= 420) or not _RULE.search(sentence):
                continue
            # Not a rule: a due-date line ("Sunday, August 23, 2026 11:59 PM: ... due"), a fill-in exercise, a page
            # footer, a book listing, an objective.
            if re.match(r"^(mon|tues|wednes|thurs|fri|satur|sun)day, \w+ \d", sentence, re.IGNORECASE) or "___" in sentence:
                continue
            if re.search(r"p a g e|\(CLO \d|^(subtitle|authors?|isbn|required or recomm)", sentence, re.IGNORECASE):
                continue
            # (Kea's own transcription notes repeat what the class wrote; the original sentence is kept instead.)
            if re.match(r"^(transcribed from|derived from|source:|re-checked)", sentence, re.IGNORECASE):
                continue
            norm = re.sub(r"[^a-z0-9]+", " ", sentence.lower()).strip()
            if norm in seen or sum(c.isalpha() for c in sentence) < 15:
                continue
            seen.add(norm)
            out.append({"text": sentence, "where": name, "strength": len(_RULE_STRONG.findall(sentence)) * 2 + len(_RULE.findall(sentence))})
    out.sort(key=lambda r: -r["strength"])
    return out[:80]


@app.command("course-rules")
def course_rules_cmd(
    course: Annotated[str, typer.Option("--course")],
    as_json: Annotated[bool, typer.Option("--json")] = False,
) -> None:
    """The rules this class grades by (late work, required uploads, exam environment, participation), gathered from
    its syllabus, announcements and pages, strongest first, with where each was found."""
    with session_scope() as session:
        c = _resolve_course_or_exit(session, course)
        code = c.course_code
        rules = course_rules(session, c)
    if as_json:
        print(json.dumps({"course": code, "rules": rules}, indent=1))
        return
    for r in rules:
        console.print(f"- {escape(r['text'])}  [dim]({escape(r['where'])})[/dim]")


@app.command("coverage-dismiss")
def coverage_dismiss_cmd(
    course: Annotated[str, typer.Option("--course")],
    key: Annotated[str, typer.Option("--key", help="The item's key from `coverage --json`.")],
    note: Annotated[str, typer.Option("--note", help="Why it isn't a separate piece of work.")],
) -> None:
    """Mark one `coverage` finding as not separate work (e.g. the same lab already
    on the calendar under another name), with the reason, so it stops being reported."""
    if len(note.strip()) < 8:
        console.print("[red]Give the real reason in --note.[/red]")
        raise typer.Exit(1)
    _set_event_context(f"Dismissed {key}: {note.strip()}")
    with session_scope() as session:
        c = _resolve_course_or_exit(session, course)
        current = list(repository.get_preference(session, "coverage_dismissed", course_id=c.id, default=[]) or [])
        if key not in current:
            current.append(key)
        repository.set_preference(session, key="coverage_dismissed", value=current, category="coverage", scope="course", course_id=c.id)
        repository.log_audit_event(
            session, event_type="coverage_dismissed", course_id=c.id, summary=f"Dismissed {key}: {note.strip()}", details={"key": key, "note": note.strip()}
        )
    console.print(f"Dismissed: {key}")


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
                uncovered_document_items=[
                    f"{i.date.isoformat() if i.date else 'no date found'} {i.title} ({Path(str(p)).name})"
                    for p, i in ([] if c.is_synthetic else uncovered_document_items(session, c))
                ],
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
    textbook_ref: Annotated[
        str | None,
        typer.Option("--textbook-ref", help="Where this chapter is in the student's own textbook, when the class "
                     "numbers chapters differently from the book: \"Brooker, Biology (2025 Release), Ch. 31: Plants "
                     "and the Conquest of Land\". Checked against the publisher's contents, never guessed."),
    ] = None,
    source: Annotated[
        str | None,
        typer.Option("--source", help="Where the notes came from (a document path or page address)."),
    ] = None,
    append: Annotated[
        bool,
        typer.Option("--append", help="Add the given --objective/--section/--added-objective values to the saved ones "
                     "(no repeats) instead of replacing the lists: for filling a gap without retyping the chapter."),
    ] = False,
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
        if append:
            old = repository.find_chapter_topic(session, resolved_course_id, chapter)
            if old is not None:
                merge = lambda have, new: list(dict.fromkeys([*(have or []), *(new or [])]))  # noqa: E731
                objective = merge(old.objectives_json, objective)
                section = merge(old.sections_json, section)
                added_objective = merge(old.added_objectives_json, added_objective)
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
            textbook_ref=textbook_ref,
            source_wording=source,
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

            if output is not None and REPO_ROOT.resolve() not in output.resolve().parents:
                console.print("[red]--output must be inside this workspace.[/red]")
                raise typer.Exit(code=1)
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


@app.command("kea-brief")
def kea_brief_cmd(
    course: Annotated[str, typer.Option("--course")],
    horizon: Annotated[int, typer.Option("--horizon", help="Days ahead weekly banners should reach.")] = 13,
) -> None:
    """Kea: one JSON answer with everything a recurring run starts from, so it
    doesn't need status/plan/needs-link-refresh/portal-link-list one by one:
    the course, its saved links, items whose link may have unlocked, items to
    record (CREATE/UPDATE, with ids), items that need the student
    (CONFLICT/REVIEW), how far its weekly banners reach, and whether the next
    week's banner still needs building. Kea's own pre-check uses it to skip a
    run when there's nothing to do."""
    today = date.today()
    with session_scope() as session:
        c = _resolve_course_or_exit(session, course)
        items = repository.list_items_for_course(session, c.id)
        plan = compute_plan(session, c.id, items)
        refresh = repository.list_items_needing_link_recheck(session, course_id=c.id,
                                                            lookback_days=14, lookahead_days=14)
        links = repository.list_portal_links(session, c.id)
        unresolved = repository.list_unresolved_references(session, c.id)
        banners = [i for i in items if i.item_type == ItemType.WEEKLY_READING
                   and i.status.value not in study_pdf_mod._INACTIVE and i.date]
        through = max((i.date_range_end or i.date for i in banners), default=None)
        reach = today + timedelta(days=horizon)
        if c.end_date:
            reach = min(reach, c.end_date)
        running = c.end_date is None or today <= c.end_date

        def entry(e):  # type: ignore[no-untyped-def]
            return {"item_id": e.item.id, "action": e.action.value, "title": e.item.title,
                    "date": e.item.date.isoformat() if e.item.date else None, "reason": e.reason}

        out = {
            "course": {"code": c.course_code, "name": c.name, "start": str(c.start_date or ""),
                       "end": str(c.end_date or ""), "d2l_url": c.d2l_url},
            "portal_links": [{"kind": x.kind, "label": x.label, "url": x.url} for x in links],
            "needs_link_refresh": [{"item_id": i.id, "title": i.title, "date": str(i.date or ""),
                                    "link_available_date": str(i.link_available_date or "")} for i in refresh],
            "to_record": [entry(e) for e in plan.entries if e.action in (SyncAction.CREATE, SyncAction.UPDATE)],
            "needs_you": [entry(e) for e in plan.entries if e.action in (SyncAction.CONFLICT, SyncAction.REVIEW)],
            "banners_through": through.isoformat() if through else None,
            "next_banner_needed": running and (through is None or through < reach),
            "unresolved_open": len(unresolved),
            # Dated graded work written in the course's documents with no item (see `coverage`): each
            # gets added, or dismissed with coverage-dismiss and the reason.
            "not_on_calendar": [
                {"title": i.title, "date": i.date.isoformat() if i.date else None, "type": i.item_type.value, "file": str(p), "key": _coverage_key(i)}
                for p, i in ([] if c.is_synthetic else uncovered_document_items(session, c))
            ],
        }
    print(json.dumps(out, indent=1))


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
                stable_hash=digest_mod.stable_hash,
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
    missing: Annotated[bool, typer.Option("--missing", help="Kea: every chapter with no PDF yet, any "
                                          "date, as the first unbuilt week that teaches it.")] = False,
    course: Annotated[str | None, typer.Option("--course", help="With --missing: one course.")] = None,
    only: Annotated[str | None, typer.Option("--only", help="With --banner: comma-separated chapter "
                                             "labels to write (the rest already have PDFs).")] = None,
    rewrite: Annotated[str | None, typer.Option("--rewrite", help="Kea: with --course, comma-separated "
                                                "chapter labels to write again, each as the week it was "
                                                "first written in.")] = None,
) -> None:
    """JSON list of weekly banners that need a study PDF -- starting within
    [today - lookback, today + lookahead] with no PDF built or skipped yet --
    each with the full bundle the writer works from (chapters with saved
    sections/vocabulary/objectives, the week's links, everything due that
    week, tests in the next 3 weeks, earlier PDFs per chapter, and the
    output path/filename). See .claude/skills/weekly-study-pdf/SKILL.md."""
    day = date.fromisoformat(on) if on else date.today()
    with session_scope() as session:
        if missing:
            cid = _resolve_course_or_exit(session, course).id if course else None
            bundles = [study_pdf_mod.build_bundle(session, b, new)
                       for b, new in study_pdf_mod.missing_banners(session, cid)]
            print(json.dumps(bundles, indent=1))
            return
        if rewrite:
            cid = _resolve_course_or_exit(session, course).id if course else None
            labels = [x.strip() for x in rewrite.split(",") if x.strip()]
            bundles = [study_pdf_mod.build_bundle(session, b, [label])
                       for b, label in study_pdf_mod.rewrite_banners(session, cid, labels)]
            print(json.dumps(bundles, indent=1))
            return
        if banner:
            banners = [_banner_or_exit(session, banner)]
        else:
            banners = study_pdf_mod.due_banners(session, day, lookahead, lookback)
        write_only = [x.strip() for x in only.split(",") if x.strip()] if only else None
        bundles = [study_pdf_mod.build_bundle(session, b, write_only) for b in banners]
    print(json.dumps(bundles, indent=1))


def _calc_value(expr: str) -> float:
    """The value of a plain arithmetic expression (numbers, + - * / ** and parentheses, e notation, and log/ln/sqrt/
    exp), evaluated safely: how a calculation question's answer is worked out rather than typed from memory."""
    import ast
    import math

    funcs = {"log": math.log10, "log10": math.log10, "ln": math.log, "sqrt": math.sqrt, "exp": math.exp, "abs": abs}
    tree = ast.parse(str(expr).replace("^", "**").replace("×", "*"), mode="eval")

    def ev(n):
        if isinstance(n, ast.Expression):
            return ev(n.body)
        if isinstance(n, ast.Constant) and isinstance(n.value, (int, float)):
            return float(n.value)
        if isinstance(n, ast.UnaryOp) and isinstance(n.op, (ast.USub, ast.UAdd)):
            return -ev(n.operand) if isinstance(n.op, ast.USub) else ev(n.operand)
        if isinstance(n, ast.BinOp) and isinstance(n.op, (ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Pow)):
            a, b = ev(n.left), ev(n.right)
            if isinstance(n.op, ast.Pow) and abs(b) > 100:
                raise ValueError("exponent too large")
            if isinstance(n.op, ast.Add):
                return a + b
            if isinstance(n.op, ast.Sub):
                return a - b
            if isinstance(n.op, ast.Mult):
                return a * b
            if isinstance(n.op, ast.Div):
                return a / b if b else float("nan")
            return a ** b
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id in funcs and len(n.args) == 1:
            return float(funcs[n.func.id](ev(n.args[0])))
        raise ValueError("only numbers, + - * / ^ ( ) and log, ln, sqrt, exp")

    return ev(tree)


# A formula in an explanation: a symbol (or two run together, PV) set equal to an expression with letters in it.
# (Not the unknowns of an algebra step, "x = (−b ± …)": x, y and z are what is being solved for.)
_FORMULA = re.compile(r"(?<![\w.])(?![xyz]\s*=)([A-Za-zΔλρμ][A-Za-z₀-₉ₐ-ₜ]{0,3})\s*=\s*[^=,.;]*?[A-Za-zΔλρμ√(]")
_DEFINES = re.compile(r"\bwhere\b|\bstands? for\b|\brepresents?\b|\bmeans\b|\bis the\b|\bare the\b|\bis (?:its|their|your)\b|\(the\b", re.IGNORECASE)
_LATEX = re.compile(r"\\(?:frac|times|cdot|text|mathrm|sqrt|Delta|left|right|le|ge)\b|\$[^$\d][^$]*\$|\*\*")


def _explain_problems(q: dict, explain: str) -> list[str]:
    """What's wrong with a question's explanation as teaching: math written as code, a formula whose symbols are never
    said, or a bare result with no reasoning."""
    out = []
    every = " ".join(str(q.get(k, "")) for k in ("q", "answer", "explain")) + " " + " ".join(map(str, q.get("choices") or []))
    if _LATEX.search(every):
        out.append("math written as LaTeX or code (\\frac, $...$, **): use Unicode, and ^(…)/_(…) for longer exponents")
    formula = _FORMULA.search(explain)
    if formula and not _DEFINES.search(explain):
        out.append(f"the explanation uses a formula ({formula.group(0).strip()[:40]}) without saying what its symbols stand for: add \"where …\" with each symbol's meaning and unit")
    # A calculation needs its worked steps (shown when the student misses it).
    steps = q.get("steps")
    if q.get("type") == "num" and not (isinstance(steps, list) and len([s for s in steps if str(s).strip()]) >= 3):
        out.append("a calculation needs `steps`: its worked solution, 3 to 8 short steps")
    # A calculation or a reasoning question needs more than the result.
    if (q.get("type") == "num" or str(q.get("level", "")).lower() in ("apply", "multistep")) and len(explain) < 90:
        out.append("the explanation is too thin to learn from: say why each step is taken (2 to 5 sentences)")
    return out


@app.command("practice-check")
def practice_check_cmd(
    path: Annotated[Path, typer.Argument(help="The practice set JSON (data/study/out/<id>.json).")],
    count: Annotated[int | None, typer.Option("--count", help="How many were asked for.")] = None,
) -> None:
    """Kea: check a practice exam or flashcard set before finishing -- every
    question has a usable answer, choices are shuffle-safe, no duplicates.
    Prints the problems as JSON (exit 1 when there are any)."""
    problems: list[str] = []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as err:
        print(json.dumps({"ok": False, "problems": [f"not readable JSON: {err}"]}))
        raise typer.Exit(code=1) from None
    seen: set[str] = set()
    bad_choice = ("all of the above", "none of the above", "both a and b", "a and b", "b and c",
                  "a and c", "a, b", "a, b, and c")
    if "cards" in data:
        items = data["cards"] if isinstance(data["cards"], list) else []
        for n, c in enumerate(items, 1):
            front = str(c.get("front", "")).strip() if isinstance(c, dict) else ""
            back = str(c.get("back", "")).strip() if isinstance(c, dict) else ""
            if not front or not back:
                problems.append(f"card {n}: needs a front and a back")
            elif front.lower() in seen:
                problems.append(f"card {n}: duplicate front")
            seen.add(front.lower())
    else:
        items = data.get("questions") if isinstance(data.get("questions"), list) else []
        for n, q in enumerate(items, 1):
            if not isinstance(q, dict):
                problems.append(f"question {n}: not an object")
                continue
            kind, stem = q.get("type"), str(q.get("q", "")).strip()
            where = f"question {n} ({kind})"
            if not stem:
                problems.append(f"{where}: empty stem")
            elif stem.lower() in seen:
                problems.append(f"{where}: duplicate stem")
            seen.add(stem.lower())
            explain = str(q.get("explain", "")).strip()
            if not explain:
                problems.append(f"{where}: no explanation")
            else:
                problems.extend(f"{where}: {p}" for p in _explain_problems(q, explain))
            if kind in ("mc", "multi"):
                choices = q.get("choices")
                if not isinstance(choices, list) or len(choices) < 3 or not all(str(c).strip() for c in choices):
                    problems.append(f"{where}: needs 3-6 non-empty choices")
                    continue
                if len({str(c).strip().lower() for c in choices}) != len(choices):
                    problems.append(f"{where}: repeated choice")
                for c in choices:
                    low = str(c).strip().lower().rstrip(".")
                    if low in bad_choice or low.startswith(("both ", "all of", "none of", "neither ")):
                        problems.append(f"{where}: choice '{c}' breaks when Kea shuffles choices")
                ans = q.get("answer")
                answers = [ans] if kind == "mc" else ans if isinstance(ans, list) else []
                if (kind == "mc" and not isinstance(ans, int)) or not answers or any(
                        not isinstance(a, int) or not 0 <= a < len(choices) for a in answers):
                    problems.append(f"{where}: answer must be a choice index (0-based)"
                                    + (" list" if kind == "multi" else ""))
            elif kind == "tf":
                if not isinstance(q.get("answer"), bool):
                    problems.append(f"{where}: answer must be true or false")
            elif kind == "num":
                try:
                    value = float(q.get("answer"))
                except (TypeError, ValueError):
                    problems.append(f"{where}: answer must be a number")
                    value = None
                # The answer, worked out: `calc` is the arithmetic that gives it, and it must agree.
                calc = q.get("calc")
                if not calc:
                    problems.append(f"{where}: needs calc, the arithmetic that gives the answer (e.g. \"745/760*5.60/2.10\")")
                elif value is not None:
                    try:
                        got = _calc_value(calc)
                        tol = max(abs(float(q.get("tolerance") or 0)), abs(value) * 0.01, 1e-9)
                        if not abs(got - value) <= tol:
                            problems.append(f"{where}: calc {calc} gives {got:.6g}, not the answer {value:g}")
                    except Exception as err:  # noqa: BLE001
                        problems.append(f"{where}: calc can't be worked out ({err})")
            elif kind == "short":
                if not str(q.get("answer", "")).strip():
                    problems.append(f"{where}: needs a model answer")
            elif kind == "blank":
                ans = str(q.get("answer", "")).strip()
                if not ans or len(ans.split()) > 3:
                    problems.append(f"{where}: a blank's answer is one to three words")
                if "__" not in stem:
                    problems.append(f"{where}: a blank needs ____ in the question where the answer goes")
                if "accept" in q and not isinstance(q["accept"], list):
                    problems.append(f"{where}: accept must be a list of other forms that count")
            else:
                problems.append(f"{where}: type must be mc, multi, tf, num, short or blank")
    if count and len(items) < count * 0.9:
        problems.append(f"only {len(items)} of the {count} asked for")
    # Exam level, checked rather than hoped for: every question says how hard it is, and a set leans hard.
    if "questions" in data and items:
        levels = [str(q.get("level", "")).lower() for q in items if isinstance(q, dict)]
        missing = sum(1 for lv in levels if lv not in ("recall", "apply", "multistep"))
        if missing:
            problems.append(f"{missing} question(s) have no level (recall, apply or multistep)")
        if len(items) >= 15:
            share = lambda lv: sum(1 for x in levels if x == lv) / len(items)  # noqa: E731
            blanks = sum(1 for q in items if isinstance(q, dict) and q.get("type") == "blank") / len(items)
            if share("recall") > 0.35:
                problems.append(f"{share('recall'):.0%} are recall: at most 35%; make more of them apply or multistep, like the exams")
            if share("multistep") < 0.2:
                problems.append(f"only {share('multistep'):.0%} are multistep: at least 20% should chain steps (conversions, two concepts, a calculation feeding another)")
            if blanks > 0.15:
                problems.append(f"{blanks:.0%} are fill-in-the-blank: at most 15% (more only when the class's tests use blanks)")
    print(json.dumps({"ok": not problems, "count": len(items), "problems": problems[:80]}, indent=1))
    if problems:
        raise typer.Exit(code=1)


# --------------------------------------------------------------------------
# The curriculum held to the syllabus (Kea): outcomes, guidelines, the textbook
# --------------------------------------------------------------------------

def _doc_text(p: Path) -> str:
    """A document's text: its saved `.txt` copy when Kea made one (doc-text), else read now."""
    side = p.with_name(p.name + ".txt")
    if side.is_file():
        return side.read_text(encoding="utf-8", errors="replace")
    return _load_document(p, p.name).text or ""


def _curriculum_report(session, c: Course) -> dict:
    from academic_sync import curriculum as cur

    paths = course_documents(c)
    docs = cur.syllabus_docs(paths, _doc_text)
    report = cur.check(session, c, docs)
    # A syllabus that is only pictures (a scanned PDF) can't be checked until it's read: its pages are images.
    dismissed = set(repository.get_preference(session, "curriculum_dismissed", course_id=c.id, default=[]) or [])
    for p in paths:
        if p.suffix.lower() == ".pdf" and re.search(r"syllab", p.name, re.IGNORECASE):
            try:
                text = _doc_text(p)
            except Exception:  # noqa: BLE001
                text = ""
            key = f"syllabus_unreadable:{p.name}"
            try:
                import pymupdf

                with pymupdf.open(str(p)) as pdf:
                    pages = len(pdf)
            except Exception:  # noqa: BLE001
                pages = 1
            # (Under about 300 characters a page is a scan with a few stray words, not a readable syllabus.)
            if len(text.strip()) < 300 * max(1, pages) * 0.5 and key not in dismissed:
                report["problems"].append({"key": key, "severity": "fix", "text": f"{p.name} is pictures, not text: "
                                           "read its page images (doc-text lists them) and save its outcomes and guidelines."})
                report["ok"] = False
    return report


@app.command("curriculum")
def curriculum_cmd(
    course: Annotated[str, typer.Option("--course")],
    as_json: Annotated[bool, typer.Option("--json")] = False,
) -> None:
    """Kea: check a class's chapters against its syllabus -- every required outcome, module outcome and topical-outline
    item taught by a chapter whose notes carry it, every chapter the syllabus names has complete notes (title,
    sections, objectives, summary, reading link), the textbook recorded with each chapter's place in it when the
    class numbers chapters differently, and the class's testing guidelines recorded. Problems marked "fix" are what
    the curriculum run closes."""
    with session_scope() as session:
        c = _resolve_course_or_exit(session, course)
        report = _curriculum_report(session, c)
    if as_json:
        print(json.dumps(report, indent=1, default=str))
        return
    console.print(f"[bold]{report['course']}[/bold]: {len(report['chapters'])} chapters, {len(report['outcomes'])} outcomes, "
                  f"{len(report['guidelines'])} guidelines")
    for p in report["problems"]:
        colour = "red" if p["severity"] == "fix" else "yellow"
        console.print(f"[{colour}]{p['severity']}[/{colour}] {escape(p['key'])}: {escape(p['text'])}")
    if report["ok"]:
        console.print("[green]Nothing to fix.[/green]")


@app.command("outcome-add")
def outcome_add_cmd(
    course: Annotated[str, typer.Option("--course")],
    kind: Annotated[str, typer.Option("--kind", help="course (a required course learning outcome), module (a module "
                                      "outcome), outline (a required topical-outline item) or recommended (a "
                                      "recommended topical-outline item).")],
    ref: Annotated[str, typer.Option("--ref", help='Its number as the syllabus gives it: "3", "Module 2.4", "F.1.b".')],
    text: Annotated[str, typer.Option("--text", help="The syllabus's own words, verbatim.")],
    chapter: Annotated[list[str] | None, typer.Option("--chapter", help='Repeatable: a chapter that teaches it ("Chapter '
                                                      '5"), or "all" for a skill every chapter uses.')] = None,
    not_tested: Annotated[str | None, typer.Option("--not-tested", help="Only when no study set can test it (a lab "
                                                   "procedure, a speaking skill): why. An empty value clears it.")] = None,
    source: Annotated[str | None, typer.Option("--source", help="The document it's from (path under data/downloads, "
                                               "or the address of the published course outline).")] = None,
) -> None:
    """Save (or update) one syllabus outcome or topical-outline item and the chapters that teach it. Idempotent by
    (course, kind, ref). Never deleted: one that no study set can test is marked --not-tested with the reason."""
    from academic_sync import curriculum as cur

    if kind not in cur.KINDS:
        console.print(f"[red]--kind must be one of {', '.join(cur.KINDS)}[/red]")
        raise typer.Exit(code=1)
    _set_event_context(f"Syllabus {kind} {ref}")
    with session_scope() as session:
        c = _resolve_course_or_exit(session, course)
        known = {canonicalize_chapter_label(t.chapter_label): t.chapter_label for t in repository.list_chapter_topics_for_course(session, c.id)}
        labels = []
        for ch in chapter or []:
            if ch.strip().lower() == "all":
                labels.append("all")
            elif canonicalize_chapter_label(ch) in known:
                labels.append(known[canonicalize_chapter_label(ch)])
            else:
                console.print(f"[red]{c.course_code} has no notes for {ch}.[/red] Save the chapter first (chapter-topic-add).")
                raise typer.Exit(code=1)
        cur.save_outcome(session, c.id, kind, ref.strip(), text.strip(), labels, not_tested, source)
    console.print(f"Saved {kind} {ref} for {course}" + (f" -> {', '.join(labels)}" if labels else ""))


@app.command("guideline-add")
def guideline_add_cmd(
    course: Annotated[str, typer.Option("--course")],
    text: Annotated[str, typer.Option("--text", help="One guideline for how the class is tested or what to study, in "
                                      "plain words: \"Exams 1-4: essay, multiple choice and calculations; written work "
                                      "uploaded within 30 minutes\".")],
    source: Annotated[str, typer.Option("--source", help="Where it's written (the document or page).")],
    chapter: Annotated[list[str] | None, typer.Option("--chapter", help="Repeatable: only for these chapters.")] = None,
) -> None:
    """Save a guideline the textbook writer and practice sets must follow (exam formats and question types, what exams
    draw on, allowed sheets or calculators, sections the class skips). The same text again replaces it."""
    _set_event_context(f"Study guideline: {text.strip()[:120]}")
    with session_scope() as session:
        c = _resolve_course_or_exit(session, course)
        current = [g for g in (repository.get_preference(session, "study_guidelines", course_id=c.id, default=[]) or [])
                   if isinstance(g, dict) and g.get("text", "").strip().lower() != text.strip().lower()]
        current.append({"text": text.strip(), "source": source.strip(), "chapters": chapter or []})
        repository.set_preference(session, key="study_guidelines", value=current, category="curriculum", scope="course", course_id=c.id)
    console.print(f"Saved guideline for {course} ({len(current)} in all).")


@app.command("guideline-remove")
def guideline_remove_cmd(
    course: Annotated[str, typer.Option("--course")],
    text: Annotated[str, typer.Option("--text", help="The guideline's text as saved.")],
    reason: Annotated[str, typer.Option("--reason", help="Why it no longer holds (kept in the history).")],
) -> None:
    """Remove a guideline that no longer holds (the instructor changed the rule), with the reason."""
    _set_event_context(f"Removed study guideline ({reason.strip()}): {text.strip()[:120]}")
    with session_scope() as session:
        c = _resolve_course_or_exit(session, course)
        current = repository.get_preference(session, "study_guidelines", course_id=c.id, default=[]) or []
        keep = [g for g in current if not (isinstance(g, dict) and g.get("text", "").strip().lower() == text.strip().lower())]
        if len(keep) == len(current):
            console.print("[red]No guideline with that text.[/red]")
            raise typer.Exit(code=1)
        repository.set_preference(session, key="study_guidelines", value=keep, category="curriculum", scope="course", course_id=c.id)
    console.print("Removed.")


@app.command("course-textbook")
def course_textbook_cmd(
    course: Annotated[str, typer.Option("--course")],
    title: Annotated[str | None, typer.Option("--title", help='The book the class uses, as the syllabus names it: '
                                              '"Brooker, Widmaier, Graham, Stiling: Biology (2025 Release), McGraw Hill".')] = None,
    numbering: Annotated[str, typer.Option("--numbering", help="same: the class's chapter numbers are the book's. "
                                           "different: they aren't (every chapter then needs --textbook-ref).")] = "same",
    none: Annotated[str | None, typer.Option("--none", help="The class has no textbook: why (\"modules only\").")] = None,
    source: Annotated[str | None, typer.Option("--source")] = None,
) -> None:
    """Record the class's textbook and whether its chapter numbers match the class's."""
    if not none and not title:
        console.print("[red]Give --title, or --none with the reason.[/red]")
        raise typer.Exit(code=1)
    if numbering not in ("same", "different"):
        console.print("[red]--numbering is same or different.[/red]")
        raise typer.Exit(code=1)
    value = {"none": none.strip()} if none else {"title": title.strip(), "numbering": numbering, "source": source}
    _set_event_context(f"Textbook: {none or title}")
    with session_scope() as session:
        c = _resolve_course_or_exit(session, course)
        repository.set_preference(session, key="textbook", value=value, category="curriculum", scope="course", course_id=c.id)
    console.print(f"Saved the textbook for {course}.")


@app.command("curriculum-dismiss")
def curriculum_dismiss_cmd(
    course: Annotated[str, typer.Option("--course")],
    key: Annotated[str, typer.Option("--key", help="The problem's key, as `curriculum` printed it.")],
    reason: Annotated[str, typer.Option("--reason", help="Why it isn't a real gap (kept in the history).")],
) -> None:
    """Dismiss a curriculum problem that isn't a real gap (the syllabus's "Chapter 1" is another book's), with why."""
    if len(reason.strip()) < 8:
        console.print("[red]Say why (a real reason, kept in the history).[/red]")
        raise typer.Exit(code=1)
    _set_event_context(f"Dismissed {key}: {reason.strip()}")
    with session_scope() as session:
        c = _resolve_course_or_exit(session, course)
        current = list(repository.get_preference(session, "curriculum_dismissed", course_id=c.id, default=[]) or [])
        if key not in current:
            current.append(key)
        repository.set_preference(session, key="curriculum_dismissed", value=current, category="curriculum", scope="course", course_id=c.id)
        repository.log_audit_event(session, event_type="curriculum_dismissed", course_id=c.id, summary=f"Dismissed {key}: {reason.strip()}",
                                   details={"key": key, "reason": reason.strip()})
    console.print(f"Dismissed: {key}")


# --------------------------------------------------------------------------
# Depth: Claude's review of each chapter at exam level (Kea)
# --------------------------------------------------------------------------

def _depth_rows(session, c: Course) -> list[dict]:
    """Every chapter with what a depth review reads (its textbook chapter's source, its next test) and whether one is
    due: never reviewed; its textbook was (re)written since; or a test on it is within 21 days and the last review is
    over 10 days old; or the last review found gaps and the textbook has changed since."""
    from sqlalchemy import text as sql

    today = date.today()
    tests = session.execute(sql(
        "SELECT title, date, covered_chapters_json FROM academic_items WHERE course_id = :c AND item_type IN "
        "('exam', 'final_exam', 'midterm', 'lab_practical', 'quiz') AND status NOT IN ('superseded', 'cancelled') AND date >= :d ORDER BY date"),
        {"c": c.id, "d": today.isoformat()}).all()
    pdfs = session.execute(sql("SELECT chapters_json, source_path, built_at FROM study_pdfs WHERE course_id = :c AND source_path IS NOT NULL"), {"c": c.id}).all()
    out = []
    for t in sorted(repository.list_chapter_topics_for_course(session, c.id), key=lambda t: int((re.findall(r"\d+", t.chapter_label) or ["999"])[0])):
        key = canonicalize_chapter_label(t.chapter_label)
        row = repository.find_chapter_topic(session, c.id, t.chapter_label)
        nxt = next(((title, d) for title, d, cov in tests if any(canonicalize_chapter_label(x) == key for x in (json.loads(cov) if isinstance(cov, str) else cov or []))), None)
        mine = [(json.loads(ch) if isinstance(ch, str) else ch, src, built) for ch, src, built in pdfs]
        pdf = max(((src, built) for ch, src, built in mine if any(canonicalize_chapter_label(x) == key for x in ch or [])), key=lambda x: str(x[1]), default=(None, None))
        reviewed = row.depth_reviewed_at
        built = datetime.fromisoformat(str(pdf[1])) if pdf[1] else None
        days_to_test = (date.fromisoformat(str(nxt[1])[:10]) - today).days if nxt else None
        why = None
        if reviewed is None:
            why = "never reviewed"
        elif built and built > reviewed:
            why = "its textbook chapter changed since the last review"
        elif days_to_test is not None and days_to_test <= 21 and (datetime.now() - reviewed).days > 10:
            why = f"{nxt[0]} is in {days_to_test} days"
        out.append({"label": t.chapter_label, "title": t.title, "textbook_source": pdf[0], "next_test": {"title": nxt[0], "date": str(nxt[1])[:10]} if nxt else None,
                    "verdict": row.depth_verdict, "note": row.depth_note, "reviewed_at": reviewed.isoformat() if reviewed else None,
                    "due": why is not None and pdf[0] is not None, "why": why})
    return out


@app.command("depth-due")
def depth_due_cmd(
    course: Annotated[str, typer.Option("--course")],
    as_json: Annotated[bool, typer.Option("--json")] = False,
) -> None:
    """Kea: each chapter's depth review -- the last verdict and whether a review is due (never reviewed, its textbook
    changed, or a test on it within 21 days), with its textbook chapter's source and its next test."""
    with session_scope() as session:
        rows = _depth_rows(session, _resolve_course_or_exit(session, course))
    if as_json:
        print(json.dumps(rows, indent=1, default=str))
        return
    for r in rows:
        console.print(f"{r['label']:<11} {r['verdict'] or '-':<5} {'DUE: ' + r['why'] if r['due'] else ''}")


@app.command("depth-review")
def depth_review_cmd(
    course: Annotated[str, typer.Option("--course")],
    chapter: Annotated[str, typer.Option("--chapter")],
    verdict: Annotated[str, typer.Option("--verdict", help="ok: the notes, the textbook chapter and the question bank teach "
                                         "and test every outcome and test-focus line at exam depth. gaps: something is "
                                         "missing or too shallow (say what in --note).")],
    note: Annotated[str, typer.Option("--note", help="What is missing or shallow, specifically (each outcome, problem type "
                                      "or test-focus line, and where: notes, textbook, questions), or for ok what was checked.")],
) -> None:
    """Save a chapter's depth review. A "gaps" verdict makes Kea rewrite the chapter's textbook and write a harder
    question top-up aimed at the note."""
    if verdict not in ("ok", "gaps"):
        console.print("[red]--verdict is ok or gaps.[/red]")
        raise typer.Exit(code=1)
    if len(note.strip()) < 20:
        console.print("[red]Say specifically what you checked or what's missing.[/red]")
        raise typer.Exit(code=1)
    _set_event_context(f"Depth review of {chapter}: {verdict}")
    with session_scope() as session:
        c = _resolve_course_or_exit(session, course)
        row = repository.find_chapter_topic(session, c.id, chapter)
        if row is None:
            console.print(f"[red]{c.course_code} has no notes for {chapter}.[/red]")
            raise typer.Exit(code=1)
        row.depth_verdict = verdict
        row.depth_note = note.strip()
        row.depth_reviewed_at = datetime.now()
    console.print(f"Saved: {chapter} {verdict}.")


@app.command("chapter-summary-set")
def chapter_summary_set_cmd(
    course: Annotated[str, typer.Option("--course")],
    chapter: Annotated[str, typer.Option("--chapter", help='e.g. "Chapter 5" or "Module 2".')],
    summary: Annotated[str, typer.Option("--summary", help="Two or three plain sentences: what the "
                                         "chapter teaches and why it matters in the course.")],
) -> None:
    """Kea: save the short chapter description students see (instead of the
    vocabulary and objective lists, which stay internal)."""
    with session_scope() as session:
        cid = _resolve_course_or_exit(session, course).id
        if not study_pdf_mod.set_topic_summary(session, cid, chapter, summary):
            console.print(f"[red]No saved chapter '{chapter}' for {course}.[/red]")
            raise typer.Exit(code=1)
    print(json.dumps({"ok": True, "chapter": chapter}))


def _study_work(session, banner_item) -> Path:  # type: ignore[no-untyped-def]
    course = repository.get_course(session, banner_item.course_id)
    assert course is not None
    return study_pdf_mod.work_dir(course, banner_item)


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
        only = study_pdf_mod.remembered_only(_study_work(session, item))
        terms = study_pdf_mod.week_terms(session, item, only)
    source_text = path.read_text(encoding="utf-8")
    missing = study_pdf_mod.missing_terms(source_text, terms)
    problems = study_pdf_mod.forbidden_parts(source_text)
    print(json.dumps({"terms": len(terms), "missing": missing, "problems": problems}))
    if missing or problems:
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
        # Kea's missing-chapters mode: only the chapters chosen for this week
        # (remembered by study-pdf-due --only) are named, checked and recorded.
        only = study_pdf_mod.remembered_only(_study_work(session, item))
        terms = study_pdf_mod.week_terms(session, item, only)
        missing = study_pdf_mod.missing_terms(path.read_text(encoding="utf-8"), terms)
        if missing and not allow_missing:
            print(json.dumps({"built": False, "missing": missing}))
            raise typer.Exit(code=1)
        problems = study_pdf_mod.forbidden_parts(path.read_text(encoding="utf-8"))
        if problems:
            print(json.dumps({"built": False, "problems": problems}))
            raise typer.Exit(code=1)
        bundle = study_pdf_mod.build_bundle(session, item, only)
        output = Path(bundle["output_path"])
        try:
            pages = study_pdf_mod.compile_pdf(path, output)
        except Exception as exc:  # typst.TypstError carries the compiler diagnostics
            print(json.dumps({"built": False, "error": str(exc)}))
            raise typer.Exit(code=1) from exc
        study_pdf_mod.record(session, item, file_path=output, source_path=path,
                             pages=pages, skipped_reason=None, chapters=only)
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


# Figure scripts are written by Claude from course material, which can carry instructions planted by anyone who can
# post in a class (a discussion reply, a linked page). So a script is read before it runs: only drawing is allowed.
_PLOT_IMPORTS = {"math", "numpy", "matplotlib", "matplotlib.pyplot", "matplotlib.patches", "matplotlib.lines",
                 "matplotlib.ticker", "matplotlib.colors", "matplotlib.path", "matplotlib.transforms", "matplotlib.text",
                 "matplotlib.collections", "matplotlib.gridspec", "mpl_toolkits.mplot3d", "fractions", "statistics",
                 "random", "datetime", "os"}
_PLOT_BANNED_NAMES = {"open", "exec", "eval", "compile", "__import__", "globals", "locals", "vars", "getattr",
                      "setattr", "delattr", "input", "breakpoint", "help", "memoryview", "sys", "subprocess",
                      "socket", "shutil", "pathlib", "importlib", "builtins", "ctypes", "pickle", "marshal"}


def _plot_script_problem(code: str) -> str | None:
    """Why a figure script mustn't run, or None when it only draws."""
    import ast
    import re

    try:
        tree = ast.parse(code)
    except SyntaxError as err:
        return f"it doesn't parse ({err.msg})"
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                if a.name not in _PLOT_IMPORTS:
                    return f"it imports {a.name}"
        elif isinstance(node, ast.ImportFrom):
            if (node.module or "") not in _PLOT_IMPORTS or node.level:
                return f"it imports from {node.module}"
        elif isinstance(node, ast.Name) and node.id in _PLOT_BANNED_NAMES:
            return f"it uses {node.id}"
        elif isinstance(node, ast.Attribute):
            if node.attr.startswith("_"):
                return f"it reaches into {node.attr}"
            # From os, only making the img/ folder (and joining a path for it).
            if isinstance(node.value, ast.Name) and node.value.id == "os" and node.attr not in ("makedirs", "path"):
                return f"it uses os.{node.attr}"
            if (isinstance(node.value, ast.Attribute) and node.value.attr == "path" and isinstance(node.value.value, ast.Name)
                    and node.value.value.id == "os" and node.attr not in ("join", "exists")):
                return f"it uses os.path.{node.attr}"
            # numpy and matplotlib calls that read or write files other than the figure itself.
            if node.attr in {"load", "loadtxt", "genfromtxt", "fromfile", "tofile", "save", "savez", "savetxt",
                             "memmap", "imread", "system", "popen", "DataSource", "ctypeslib", "lib"}:
                return f"it calls {node.attr}"
        elif isinstance(node, ast.Call) and getattr(node.func, "attr", None) == "makedirs":
            for arg in node.args[:1]:
                if not (isinstance(arg, ast.Constant) and isinstance(arg.value, str) and re.fullmatch(r"[\w\-]+", arg.value)):
                    return "it makes a folder other than a plain one next to it (like img)"
        elif isinstance(node, ast.Call) and getattr(node.func, "attr", None) == "savefig":
            for arg in node.args[:1]:
                if not (isinstance(arg, ast.Constant) and isinstance(arg.value, str)
                        and re.fullmatch(r"(img/)?[\w\- .]+\.(png|svg|pdf)", arg.value) and ".." not in arg.value):
                    return "it saves a figure somewhere other than a plain file name in its folder or img/"
    return None


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
    problem = _plot_script_problem(path.read_text(encoding="utf-8", errors="replace"))
    if problem:
        console.print(f"[red]Not run: {problem}. A figure script may only import math, numpy and matplotlib, draw, and "
                      "save images into its own folder.[/red]")
        raise typer.Exit(code=1)
    # A bare environment: no inherited secrets or paths, so the script only draws.
    env = {k: v for k, v in os.environ.items() if k.upper() in ("SYSTEMROOT", "TEMP", "TMP", "PATH", "MPLBACKEND", "WINDIR")}
    env["MPLBACKEND"] = "Agg"
    (path.parent / "img").mkdir(exist_ok=True)
    proc = subprocess.run([sys.executable, "-I", str(path)], cwd=path.parent,
                          capture_output=True, text=True, timeout=300, env=env)
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
    """Write a downloaded PDF's, Word file's or PowerPoint deck's text next to it as `<file>.txt`,
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
    elif suffix == ".pptx":
        text = pptx_text(path)
        pages = text.count("--- slide ")
        out.write_text(text, encoding="utf-8")
    else:
        console.print("[red]doc-text reads .pdf, .docx and .pptx files.[/red]")
        raise typer.Exit(code=1)
    text = out.read_text(encoding="utf-8")
    print(json.dumps({"text_file": str(out), "pages": pages, "chars": len(text), "pages_without_text": images}))


if __name__ == "__main__":
    app()
