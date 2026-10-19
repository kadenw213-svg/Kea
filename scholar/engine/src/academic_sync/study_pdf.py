"""Weekly study PDFs (CLAUDE.md invariant 41).

When a course's weekly banner is about to start, Claude writes a 10-15
page textbook-style study text for that week (Typst source, rendered with
the shared `study_pdf_template.typ`) and it lands in a Desktop folder,
one subfolder per course, named after the chapters it covers.

This module holds everything deterministic about that: which banners are
due a PDF, the data bundle the writer works from, the filename rule, the
vocabulary coverage check that gates a build, compiling, recording, and
fetching freely licensed images from Wikimedia Commons. The writing itself
is the `/weekly-study-pdf` skill's job.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import date, time, timedelta
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from academic_sync.chapter_topics import canonicalize_chapter_label, split_chapter_segments
from academic_sync.config import REPO_ROOT
from academic_sync.db import repository
from academic_sync.db.orm import AcademicItemRow, CourseRow, StudyPdfRow
from academic_sync.models.domain import AcademicItem, ChapterTopic, Course
from academic_sync.models.enums import ItemStatus, ItemType

TEMPLATE_PATH = Path(__file__).with_name("study_pdf_template.typ")
WORK_ROOT = REPO_ROOT / "data" / "study_pdfs"
OUTPUT_FOLDER_NAME = "Weekly Study PDFs"
MIN_PAGES = 8
MAX_PAGES = 20

_INACTIVE = {ItemStatus.SUPERSEDED.value, ItemStatus.CANCELLED.value}
_SKIP_TYPES = {ItemType.WEEKLY_READING, ItemType.READING, ItemType.BREAK}


def default_output_dir() -> Path:
    """Where study PDFs go. Kea sets `KEA_TEXTBOOK_DIR` to the profile's textbook folder (one subfolder
    per class); otherwise `Desktop/Weekly Study PDFs`, using the OneDrive-redirected Desktop when
    Windows has one."""
    if os.environ.get("KEA_TEXTBOOK_DIR"):
        return Path(os.environ["KEA_TEXTBOOK_DIR"])
    home = Path.home()
    desktop = home / "OneDrive" / "Desktop"
    if not desktop.is_dir():
        desktop = home / "Desktop"
    return desktop / OUTPUT_FOLDER_NAME


# ---- naming ------------------------------------------------------------------

_UNSAFE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_DATE_RANGE = re.compile(r"\s*\([^)]*\d+/\d+[^)]*\)")


def _short_label(label: str) -> str:
    """'Chapter 23' -> 'Ch 23'; 'Module 4' stays as is."""
    return re.sub(r"(?i)^chapter\s+", "Ch ", label.strip())


Segments = list[tuple[str | None, str]]


def chapter_names(segments: Segments, topics: dict[str, ChapterTopic]) -> list[str]:
    """One display name per chapter, e.g. 'Ch 32 An Overview of Animal
    Diversity' -- the segment's own topic text, else the saved chapter
    title, minus any '(10/7 - 10/28)' date range."""
    names: list[str] = []
    for label, text in segments:
        if label is None:
            names.append(_DATE_RANGE.sub("", text).strip())
            continue
        topic = topics.get(canonicalize_chapter_label(label))
        title = _DATE_RANGE.sub("", text or (topic.title if topic and topic.title else "")).strip()
        names.append(f"{_short_label(label)} {title}".strip())
    return [n for n in names if n]


def pdf_filename(segments: Segments, topics: dict[str, ChapterTopic]) -> str:
    """The PDF is named for the chapters it covers. More than three
    chapters (a cumulative review week) collapses to a range."""
    names = chapter_names(segments, topics)
    if len(names) > 3:
        labels = [label for label, _ in segments if label]
        nums = [re.sub(r"\D", "", lb) for lb in labels]
        name = f"Ch {nums[0]}-{nums[-1]} Review" if nums and all(nums) else "Review"
    else:
        name = " + ".join(names) or "Week"
    name = _UNSAFE.sub("", name).strip(" .")
    return name[:150] + ".pdf"


# ---- coverage ----------------------------------------------------------------


def vocab_terms(topic: ChapterTopic) -> list[str]:
    """Every vocabulary term saved for a chapter (sourced and added),
    split on the source's own delimiters, minus parenthetical glosses."""
    terms: list[str] = []
    for raw in (topic.vocabulary, topic.added_vocabulary):
        if not raw:
            continue
        for part in re.split(r"[;,\n]|\s\u2022\s", raw):
            term = re.sub(r"\([^)]*\)", "", part).strip(" .:-\u2022\t")
            if term and len(term) <= 60 and term.lower() not in {t.lower() for t in terms}:
                terms.append(term)
    return terms


def _norm(text: str) -> str:
    text = text.lower()
    for a, b in (("\u2019", "'"), ("\u2013", "-"), ("\u2014", "-")):
        text = text.replace(a, b)
    text = re.sub(r"#\w+\[|[\[\]*_]", " ", text)  # Typst markup around terms
    return re.sub(r"\s+", " ", text)


def _term_variants(term: str) -> list[str]:
    t = _norm(term).strip()
    variants = {t}
    if t.endswith("ies"):
        variants.add(t[:-3] + "y")
    if t.endswith("es"):
        variants.add(t[:-2])
    if t.endswith("s"):
        variants.add(t[:-1])
    return [v for v in variants if v]


def missing_terms(source_text: str, terms: list[str]) -> list[str]:
    """Terms that never appear in the PDF's text (case-insensitive,
    singular/plural tolerant). The build refuses while any are missing,
    so 'cover every term' is checked, not just promised."""
    text = _norm(source_text)
    return [t for t in terms if not any(v in text for v in _term_variants(t))]


# ---- due banners + bundle --------------------------------------------------------


def _active_courses():  # type: ignore[no-untyped-def]
    """Only classes still being taken get textbooks (an old class set inactive gets none)."""
    return select(CourseRow.id).where(CourseRow.status == "active")


def due_banners(session: Session, today: date, lookahead_days: int = 3,
                lookback_days: int = 2) -> list[AcademicItem]:
    """Banners starting in [today - lookback, today + lookahead] that have
    no `study_pdfs` row yet (built or deliberately skipped)."""
    done = set(session.scalars(select(StudyPdfRow.banner_item_id)))
    ids = session.scalars(
        select(AcademicItemRow.id).where(
            AcademicItemRow.item_type == ItemType.WEEKLY_READING.value,
            AcademicItemRow.date >= today - timedelta(days=lookback_days),
            AcademicItemRow.date <= today + timedelta(days=lookahead_days),
            AcademicItemRow.status.not_in(_INACTIVE),
            AcademicItemRow.course_id.in_(_active_courses()),
        ).order_by(AcademicItemRow.date)
    ).all()
    items = [repository.get_academic_item(session, i) for i in ids if i not in done]
    return [i for i in items if i is not None]


def chapters_in_pdfs(session: Session, course_id: str) -> dict[str, list[str]]:
    """Every chapter that already has a built study PDF, any week, with the
    file names it's in."""
    out: dict[str, list[str]] = {}
    for row in session.scalars(select(StudyPdfRow).where(
            StudyPdfRow.course_id == course_id, StudyPdfRow.file_path.is_not(None))):
        for label in row.chapters_json:
            out.setdefault(canonicalize_chapter_label(label), []).append(Path(row.file_path or "").name)
    return out


def missing_banners(session: Session, course_id: str | None = None) -> list[tuple[AcademicItem, list[str]]]:
    """Kea: every saved chapter with no study PDF yet, whatever its date, as
    the first unbuilt banner that teaches it -- (banner, chapters to write).
    A chapter spanning several weeks is claimed by its first week only, so
    each chapter is written once."""
    done = set(session.scalars(select(StudyPdfRow.banner_item_id)))
    query = select(AcademicItemRow.id).where(
        AcademicItemRow.item_type == ItemType.WEEKLY_READING.value,
        AcademicItemRow.status.not_in(_INACTIVE),
        AcademicItemRow.date.is_not(None),
        AcademicItemRow.course_id.in_(_active_courses()),
    )
    if course_id:
        query = query.where(AcademicItemRow.course_id == course_id)
    out: list[tuple[AcademicItem, list[str]]] = []
    claimed: dict[str, set[str]] = {}
    built: dict[str, dict[str, list[str]]] = {}
    for item_id in session.scalars(query.order_by(AcademicItemRow.date)).all():
        if item_id in done:
            continue
        banner = repository.get_academic_item(session, item_id)
        if banner is None:
            continue
        cid = banner.course_id
        if cid not in built:
            built[cid] = chapters_in_pdfs(session, cid)
            claimed[cid] = set()
        topics = _topics_by_label(session, cid)
        new: list[str] = []
        for label, _ in week_segments(session, banner):
            key = canonicalize_chapter_label(label) if label else None
            if key and key in topics and key not in built[cid] and key not in claimed[cid] and label not in new:
                new.append(label)
        if new:
            claimed[cid].update(canonicalize_chapter_label(x) for x in new)
            out.append((banner, new))
    return out



def rewrite_banners(session: Session, course_id: str | None, labels: list[str]) -> list[tuple[AcademicItem, str]]:
    """Kea's rewrite: for each chapter, the banner of the PDF that teaches it
    alone (else any PDF with it, else the first week that teaches it), so
    the new PDF replaces the old one in place."""
    rows = session.scalars(select(StudyPdfRow).where(
        StudyPdfRow.file_path.is_not(None),
        *([StudyPdfRow.course_id == course_id] if course_id else []))).all()
    out: list[tuple[AcademicItem, str]] = []
    for label in labels:
        key = canonicalize_chapter_label(label)
        has = [r for r in rows if key in {canonicalize_chapter_label(x) for x in r.chapters_json}]
        has.sort(key=lambda r: len(r.chapters_json))
        banner = repository.get_academic_item(session, has[0].banner_item_id) if has else None
        if banner is None and course_id:
            for item_id in session.scalars(select(AcademicItemRow.id).where(
                    AcademicItemRow.item_type == ItemType.WEEKLY_READING.value,
                    AcademicItemRow.course_id == course_id,
                    AcademicItemRow.date.is_not(None)).order_by(AcademicItemRow.date)):
                b = repository.get_academic_item(session, item_id)
                if b and any(lb and canonicalize_chapter_label(lb) == key for lb, _ in week_segments(session, b)):
                    banner = b
                    break
        if banner is not None:
            out.append((banner, label))
    return out


ONLY_FILE = "kea-only.json"


def remember_only(work: Path, labels: list[str]) -> None:
    """Kea: the chapters this week's PDF writes (the week's others already
    have PDFs), so check/build/record use them even when called without
    --only."""
    work.mkdir(parents=True, exist_ok=True)
    (work / ONLY_FILE).write_text(json.dumps(labels), encoding="utf-8")


def remembered_only(work: Path) -> list[str] | None:
    try:
        labels = json.loads((work / ONLY_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return [str(x) for x in labels] if isinstance(labels, list) and labels else None


def topic_summary(session: Session, course_id: str, label: str) -> str | None:
    row = repository.find_chapter_topic(session, course_id, label)
    return getattr(row, "summary", None) if row else None


def set_topic_summary(session: Session, course_id: str, label: str, summary: str) -> bool:
    row = repository.find_chapter_topic(session, course_id, label)
    if row is None:
        return False
    row.summary = summary.strip()
    session.flush()
    return True


def _topics_by_label(session: Session, course_id: str) -> dict[str, ChapterTopic]:
    return {
        canonicalize_chapter_label(t.chapter_label): t
        for t in repository.list_chapter_topics_for_course(session, course_id)
    }


def _active(i: AcademicItem) -> bool:
    return i.status.value not in _INACTIVE and i.date is not None


_CONT = re.compile(r",?\s*cont(inued)?\.?$", re.IGNORECASE)


def week_segments(session: Session, banner: AcademicItem) -> Segments:
    """The week's chapters: the banner's own list, plus any saved chapter
    a lecture/lab that week is titled with ("Chapter 33: Invertebrates,
    cont.") that the banner doesn't list -- the PDF covers what the
    week's classes actually teach, not a week behind them."""
    segments: Segments = list(split_chapter_segments(banner.title or ""))
    topics = _topics_by_label(session, banner.course_id)
    seen = {canonicalize_chapter_label(label) for label, _ in segments if label}
    for item in _week_items(session, banner):
        if not item.item_type.is_routine_meeting:
            continue
        for label, text in split_chapter_segments(item.title):
            key = canonicalize_chapter_label(label) if label else None
            if key and key in topics and key not in seen:
                seen.add(key)
                segments.append((label, _CONT.sub("", text).strip()))
    return segments


def _week_items(session: Session, banner: AcademicItem) -> list[AcademicItem]:
    start, end = banner.date, banner.date_range_end or banner.date
    assert start is not None and end is not None
    return sorted(
        (i for i in repository.list_items_for_course(session, banner.course_id)
         if _active(i) and i.item_type not in _SKIP_TYPES
         and i.date is not None and start <= i.date <= end),
        key=lambda i: (i.date, i.start_time or i.due_time or time.min),
    )


def _upcoming_tests(session: Session, banner: AcademicItem, days: int = 21) -> list[AcademicItem]:
    end = banner.date_range_end or banner.date
    assert end is not None
    return sorted(
        (i for i in repository.list_items_for_course(session, banner.course_id)
         if _active(i) and i.item_type.is_assessment
         and i.date is not None and end < i.date <= end + timedelta(days=days)),
        key=lambda i: i.date or date.min,
    )


def _item_dict(i: AcademicItem) -> dict[str, Any]:
    return {
        "title": i.title, "type": i.item_type.value,
        "date": i.date.isoformat() if i.date else None,
        "start_time": i.start_time.isoformat() if i.start_time else None,
        "due_time": i.due_time.isoformat() if i.due_time else None,
        "module": i.module_label, "description": i.description,
        "covered_chapters": i.covered_chapters, "study_focus": i.study_focus,
        "is_optional": i.is_optional,
    }


def earlier_pdfs(session: Session, course_id: str, before: date) -> list[StudyPdfRow]:
    return list(session.scalars(
        select(StudyPdfRow).where(
            StudyPdfRow.course_id == course_id,
            StudyPdfRow.week_start < before,
            StudyPdfRow.file_path.is_not(None),
        ).order_by(StudyPdfRow.week_start)
    ))


def work_dir(course: Course, banner: AcademicItem) -> Path:
    assert banner.date is not None
    return WORK_ROOT / course.course_code / banner.date.isoformat()


def week_display(banner: AcademicItem) -> str:
    start, end = banner.date, banner.date_range_end or banner.date
    assert start is not None and end is not None
    if start.month == end.month:
        return f"{start:%b} {start.day} - {end.day}, {end.year}"
    return f"{start:%b} {start.day} - {end:%b} {end.day}, {end.year}"


def build_bundle(session: Session, banner: AcademicItem,
                 write_only: list[str] | None = None) -> dict[str, Any]:
    """Everything the writer needs for one week, as plain JSON. With
    `write_only` (Kea's missing-chapters mode), only those chapters are
    written: the others already have PDFs, from any week."""
    course = repository.get_course(session, banner.course_id)
    assert course is not None and banner.date is not None
    topics = _topics_by_label(session, course.id)
    covered: dict[str, list[str]] = {}
    for row in earlier_pdfs(session, course.id, banner.date):
        for done_label in row.chapters_json:
            covered.setdefault(canonicalize_chapter_label(done_label), []).append(
                Path(row.file_path or "").name
            )
    segments = week_segments(session, banner)
    # What the syllabus says each chapter must teach (and what every chapter carries), and how the class tests.
    from academic_sync import curriculum as curriculum_mod

    outcomes = curriculum_mod.outcomes_for(session, course.id)
    chapters = []
    for label, text in segments:
        topic = topics.get(canonicalize_chapter_label(label)) if label else None
        chapters.append({
            "label": label, "banner_text": text,
            "title": topic.title if topic else None,
            "sections": topic.sections if topic else [],
            "vocabulary_terms": vocab_terms(topic) if topic else [],
            "objectives": topic.objectives if topic else [],
            "added_objectives": topic.added_objectives if topic else [],
            "reading_url": topic.reading_url if topic else None,
            "already_in_pdfs": covered.get(canonicalize_chapter_label(label), []) if label else [],
            "summary": topic_summary(session, course.id, label) if label else None,
            # Where it is in the student's own book, when the class numbers chapters differently.
            "textbook_ref": topic.textbook_ref if topic else None,
            "syllabus_outcomes": next((v for k, v in outcomes.items() if label and canonicalize_chapter_label(k) == canonicalize_chapter_label(label)), []),
        })
    if write_only is not None:
        remember_only(work_dir(course, banner), write_only)
        keep = {canonicalize_chapter_label(x) for x in write_only}
        chapters = [c for c in chapters if c["label"] and canonicalize_chapter_label(c["label"]) in keep]
        segments = [(label, text) for label, text in segments
                    if label and canonicalize_chapter_label(label) in keep]
    filename = pdf_filename(segments, topics)
    wd = work_dir(course, banner)
    return {
        "banner_id": banner.id,
        "course": {"code": course.course_code, "name": course.name,
                   "is_synthetic": course.is_synthetic},
        "week": {"start": banner.date.isoformat(),
                 "end": (banner.date_range_end or banner.date).isoformat(),
                 "display": week_display(banner)},
        "chapters": chapters,
        "links": [link.model_dump() for link in banner.weekly_links],
        "due_this_week": [_item_dict(i) for i in _week_items(session, banner)],
        "tests_next_3_weeks": [_item_dict(i) for i in _upcoming_tests(session, banner)],
        "pdf_title": filename[:-4],
        "output_path": str(default_output_dir() / course.course_code / filename),
        "work_dir": str(wd),
        "source_path": str(wd / "main.typ"),
        # Kea: a week already over gets no "This Week" section (its dates are history).
        "week_is_past": (banner.date_range_end or banner.date) < date.today(),
        "write_only": write_only,
        # Outcomes every chapter serves (significant figures, reading graphs) and the class's testing guidelines.
        "course_outcomes": outcomes.get("all", []),
        "guidelines": [g.get("text") for g in (repository.get_preference(session, "study_guidelines", course_id=course.id, default=[]) or []) if isinstance(g, dict)],
    }


def week_terms(session: Session, banner: AcademicItem,
               only: list[str] | None = None) -> list[str]:
    """Every vocabulary term saved for the banner's chapters (or just
    `only`, the chapters this week's PDF writes)."""
    topics = _topics_by_label(session, banner.course_id)
    keep = {canonicalize_chapter_label(x) for x in only} if only else None
    terms: list[str] = []
    for label, _ in week_segments(session, banner):
        if keep is not None and (not label or canonicalize_chapter_label(label) not in keep):
            continue
        topic = topics.get(canonicalize_chapter_label(label)) if label else None
        if topic:
            terms.extend(t for t in vocab_terms(topic) if t not in terms)
    return terms


# ---- build -----------------------------------------------------------------------


@dataclass
class BuildResult:
    output: Path
    pages: int


def compile_pdf(source: Path, output: Path) -> int:
    """Compile `source` (with the shared template copied beside it) to
    `output`; returns the page count."""
    import pymupdf
    import typst

    shutil.copyfile(TEMPLATE_PATH, source.parent / "template.typ")
    output.parent.mkdir(parents=True, exist_ok=True)
    tmp = source.parent / "build.pdf"
    typst.compile(str(source), output=str(tmp), root=str(source.parent))
    with pymupdf.open(tmp) as doc:
        pages = int(doc.page_count)
    shutil.copyfile(tmp, output)
    return pages


def get_record(session: Session, banner_id: str) -> StudyPdfRow | None:
    return session.scalar(select(StudyPdfRow).where(StudyPdfRow.banner_item_id == banner_id))


def record(session: Session, banner: AcademicItem, *, file_path: Path | None,
           source_path: Path | None, pages: int | None, skipped_reason: str | None,
           chapters: list[str] | None = None) -> None:
    assert banner.date is not None
    row = get_record(session, banner.id)
    if row is None:
        row = StudyPdfRow(course_id=banner.course_id, banner_item_id=banner.id,
                          week_start=banner.date)
        session.add(row)
    row.chapters_json = chapters or [label for label, _ in week_segments(session, banner) if label]
    row.file_path = str(file_path) if file_path else None
    row.source_path = str(source_path) if source_path else None
    row.page_count = pages
    row.skipped_reason = skipped_reason


# ---- Wikimedia Commons images ------------------------------------------------------

_COMMONS_API = "https://commons.wikimedia.org/w/api.php"
_UA = "academic-sync-study-pdf/1.0 (personal study tool)"
_OK_LICENSES = ("cc by", "cc-by", "cc0", "public domain", "pd", "no restrictions")


class RateLimited(Exception):
    pass


def _open(url: str, timeout: int) -> bytes:
    """GET with Wikimedia's required User-Agent, backing off on 429/503
    (Commons rate-limits bursts of searches)."""
    import time
    import urllib.error

    for attempt in range(3):
        req = urllib.request.Request(url, headers={"User-Agent": _UA})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                body: bytes = resp.read()
                return body
        except urllib.error.HTTPError as exc:
            if exc.code not in (429, 503):
                raise
            raw = exc.headers.get("Retry-After") if exc.headers else None
            wait = int(raw) if raw and raw.isdigit() else 5 * (attempt + 1)
            if wait > 30 or attempt == 2:
                raise RateLimited(
                    f"Wikimedia is rate-limiting downloads; try again in about "
                    f"{max(wait // 60, 1)} minute(s), and space downloads out."
                ) from exc
            time.sleep(wait)
    raise RuntimeError("unreachable")


def _commons_get(params: dict[str, str]) -> dict[str, Any]:
    url = _COMMONS_API + "?" + urllib.parse.urlencode({**params, "format": "json"})
    data: dict[str, Any] = json.loads(_open(url, 30))
    return data


def _strip_html(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", text or "")).strip()


def _image_info(page: dict[str, Any]) -> dict[str, Any] | None:
    info = (page.get("imageinfo") or [{}])[0]
    meta = info.get("extmetadata") or {}
    license_name = _strip_html(meta.get("LicenseShortName", {}).get("value", ""))
    if not license_name.lower().startswith(_OK_LICENSES):
        return None
    artist = _strip_html(meta.get("Artist", {}).get("value", "")) or "Unknown author"
    return {
        "file": page.get("title"),
        "license": license_name,
        "artist": artist[:120],
        "description": _strip_html(meta.get("ImageDescription", {}).get("value", ""))[:300],
        "thumb_url": info.get("thumburl"),
        "page_url": info.get("descriptionurl"),
        "credit": f"{artist[:80]}, {license_name}, via Wikimedia Commons",
    }


def commons_search(query: str, limit: int = 8) -> list[dict[str, Any]]:
    """Freely licensed (CC BY / BY-SA / CC0 / public domain) image files
    on Wikimedia Commons matching `query`, with credit lines."""
    data = _commons_get({
        "action": "query", "generator": "search", "gsrnamespace": "6",
        "gsrsearch": f"{query} filetype:bitmap|drawing", "gsrlimit": str(limit * 2),
        "prop": "imageinfo", "iiprop": "url|extmetadata", "iiurlwidth": "1280",
    })
    pages = sorted((data.get("query") or {}).get("pages", {}).values(),
                   key=lambda p: p.get("index", 0))
    found = [info for p in pages if (info := _image_info(p))]
    return found[:limit]


def commons_fetch(file_title: str, dest_dir: Path, name: str | None = None) -> dict[str, Any]:
    """Download one Commons file into `dest_dir` as a 1280px raster (a
    standard Wikimedia thumbnail step -- other widths get rate-limited);
    refuses anything not freely licensed."""
    if not file_title.startswith("File:"):
        file_title = "File:" + file_title
    data = _commons_get({
        "action": "query", "titles": file_title, "prop": "imageinfo",
        "iiprop": "url|extmetadata", "iiurlwidth": "1280",
    })
    page: dict[str, Any] = next(iter((data.get("query") or {}).get("pages", {}).values()), {})
    info = _image_info(page)
    if info is None or not info.get("thumb_url"):
        raise ValueError(f"{file_title}: not found or not freely licensed")
    ext = Path(urllib.parse.urlparse(info["thumb_url"]).path).suffix.lower() or ".png"
    stem = name or re.sub(r"[^a-z0-9]+", "-", file_title[5:].rsplit(".", 1)[0].lower()).strip("-")
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"{stem[:60]}{ext}"
    dest.write_bytes(_open(info["thumb_url"], 60))
    info["path"] = str(dest)
    return info