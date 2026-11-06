"""Concise, human-first text formatting for CLI/skill output.

Per spec: don't dump enormous raw tables by default. These formatters
summarize first and let the caller opt into detail (e.g. --verbose) rather
than always printing everything.
"""

from __future__ import annotations

from datetime import datetime

from academic_sync.models.domain import AcademicItem, Course, CourseCompletenessReport, UnresolvedReference
from academic_sync.reconciliation.engine import PlanEntry


def format_completeness_report(report: CourseCompletenessReport) -> str:
    lines = [f"Course {report.course_id}: {report.status.value}"]
    if report.inspected_source_types:
        lines.append(f"  Inspected: {', '.join(t.value for t in report.inspected_source_types)}")
    if report.missing_source_types:
        lines.append(f"  Never scanned: {', '.join(t.value for t in report.missing_source_types)}")
    if report.unresolved_reference_count:
        lines.append(f"  Open unresolved references: {report.unresolved_reference_count}")
    if report.conflicting_date_count:
        lines.append(f"  Conflicting dates: {report.conflicting_date_count}")
    if report.undated_graded_work_count:
        lines.append(f"  Undated graded work: {report.undated_graded_work_count}")
    if report.unnested_item_count:
        lines.append(f"  Missing module/chapter nesting: {report.unnested_item_count}")
    if report.unlinked_item_count:
        lines.append(f"  Missing a resource/reference link: {report.unlinked_item_count}")
    if report.missing_chapter_topic_count:
        lines.append(f"  Missing saved chapter/unit topic: {report.missing_chapter_topic_count}")
    if report.partial_chapter_topic_count:
        lines.append(f"  Unconfirmed-exhaustive chapter/unit topic: {report.partial_chapter_topic_count}")
    lines.append(f"  Safe to sync clear subset: {report.safe_to_sync_clear_subset}")
    for note in report.notes:
        lines.append(f"  - {note}")
    return "\n".join(lines)


def format_unresolved(refs: list[UnresolvedReference], limit: int = 20) -> str:
    if not refs:
        return "No open unresolved references."
    lines = [f"{len(refs)} unresolved reference(s):"]
    for r in refs[:limit]:
        lines.append(f"  [{r.kind.value}] {r.description}")
    if len(refs) > limit:
        lines.append(f"  ... and {len(refs) - limit} more (use --all to see everything).")
    return "\n".join(lines)


def format_plan_summary(course_id: str, entries: list[PlanEntry]) -> str:
    counts: dict[str, int] = {}
    for e in entries:
        counts[e.action.value] = counts.get(e.action.value, 0) + 1
    parts = ", ".join(f"{k}: {v}" for k, v in sorted(counts.items()))
    return f"Plan for {course_id} -- {len(entries)} item(s). {parts}"


def format_plan_detail(entries: list[PlanEntry], limit: int = 30) -> str:
    lines = []
    for e in entries[:limit]:
        date_str = e.item.date.isoformat() if e.item.date else "no-date"
        lines.append(f"  [{e.action.value}] {e.item.title} ({date_str}) -- {e.reason}")
    if len(entries) > limit:
        lines.append(f"  ... and {len(entries) - limit} more.")
    return "\n".join(lines) if lines else "Nothing to do."


def format_course_export(
    course: Course,
    items: list[AcademicItem],
    unresolved: list[UnresolvedReference],
) -> str:
    """Consolidated, human-and-agent-readable dump of everything known about
    one course: every item (sync-ready, needs-review, and undated-unresolved),
    plus open unresolved references. Written to
    data/downloads/<COURSE_CODE>/consolidated_events.txt by
    `academic-sync export` -- the single file a future session (or the user)
    can read instead of re-deriving from raw source documents each time.
    """
    lines = [
        f"{course.course_code} {course.section or ''} -- {course.name}".strip(),
        f"Term: {course.term}"
        + (f" | Instructor: {course.instructor}" if course.instructor else "")
        + (f" <{course.instructor_contact}>" if course.instructor_contact else ""),
        f"Generated: {datetime.now().isoformat(timespec='seconds')}",
        "",
    ]

    ready = sorted(
        (i for i in items if i.is_ready_to_sync()), key=lambda i: (i.date, i.title)
    )
    needs_review = sorted(
        (i for i in items if not i.is_ready_to_sync() and i.date is not None),
        key=lambda i: (i.date, i.title),
    )
    undated = sorted(
        (i for i in items if i.date is None), key=lambda i: i.title
    )

    lines.append(f"=== SYNC-READY ({len(ready)}) ===")
    for i in ready:
        t = i.due_time or i.start_time
        time_str = t.strftime("%H:%M") if t else "all-day"
        lines.append(f"{i.date} {time_str:>7}  [{i.item_type.value}]  {i.title}")
    lines.append("")

    lines.append(f"=== HAS A DATE BUT NEEDS REVIEW ({len(needs_review)}) ===")
    for i in needs_review:
        lines.append(f"{i.date}          [{i.item_type.value}]  {i.title}  ({i.status.value})")
    lines.append("")

    lines.append(f"=== KNOWN BUT UNDATED ({len(undated)}) ===")
    for i in undated:
        lines.append(f"  [{i.item_type.value}]  {i.title}  ({i.status.value})")
    lines.append("")

    open_refs = [r for r in unresolved if not r.resolved]
    lines.append(f"=== OPEN UNRESOLVED REFERENCES ({len(open_refs)}) ===")
    for r in open_refs:
        lines.append(f"  [{r.kind.value}] {r.description}")

    return "\n".join(lines) + "\n"
