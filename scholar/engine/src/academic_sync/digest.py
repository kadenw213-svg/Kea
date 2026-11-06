"""Daily Overview email: ingest model + pure section logic.

The `/daily-overview` skill crawls each real course every morning (D2L's
REST API via in-page `fetch`, plus any external platform's own gradebook)
and hands the result to `academic-sync digest-ingest` as one JSON document
(`DigestCrawl`). This module turns that crawl, the course's local
deadlines, and the dedupe state in `digest_entries` into one
`DailyOverview` -- which `sync/email_payload.py` renders to HTML.

Pure functions only -- no DB, no network. Scores, comments and
announcement text are sourced (verbatim from D2L / the platform), same bar
as everything else here; the only generated text is the optional `advice`
line, which renders labeled as advice. See CLAUDE.md invariant 38.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from datetime import date, time, timedelta
from typing import Any

from pydantic import BaseModel, Field

from academic_sync.diagnostics import (
    RED_DROP_POINTS,
    RED_MAJOR_ASSESSMENT_FLOOR,
    RED_MISSING_COUNT,
)
from academic_sync.models.domain import AcademicItem, CourseGradeSnapshot, DigestEntry
from academic_sync.models.enums import ItemStatus, ItemType

# --------------------------------------------------------------------------
# Ingest model -- what the crawl hands to `digest-ingest`
# --------------------------------------------------------------------------


class CrawlAnnouncement(BaseModel):
    id: str
    title: str
    posted_on: date | None = None
    url: str | None = None
    # Short verbatim excerpts of the announcement's real text -- never a
    # paraphrase. Dates/deadlines it mentions belong here, quoted.
    highlights: list[str] = Field(default_factory=list)


class CrawlGrade(BaseModel):
    id: str
    title: str
    score_percent: float | None = None
    score_text: str | None = None  # e.g. "36 / 50" exactly as D2L shows it
    comment: str | None = None  # verbatim instructor feedback
    item_url: str | None = None  # the assignment/quiz itself
    feedback_url: str | None = None  # the page where the feedback is read
    graded_on: date | None = None
    is_major: bool = False  # exam / final / project
    chapter_label: str | None = None


class CrawlDeadlineStatus(BaseModel):
    item_id: str
    submitted: bool | None = None  # None = couldn't confirm
    window_open: bool | None = None  # still accepting a late submission?


class CrawlMessage(BaseModel):
    """A D2L internal message (Email tool). Spam and college advertising
    are filtered out by the crawl before it gets here; automated
    "Submission receipt" messages feed `deadline_status` instead of being
    reported."""

    id: str
    subject: str
    sender: str | None = None
    received_on: date | None = None
    excerpt: str | None = None  # short verbatim excerpt of the body
    url: str | None = None


class CrawlLine(BaseModel):
    text: str
    url: str | None = None


class DigestCrawl(BaseModel):
    course: str
    captured_on: date
    login_failed: bool = False
    overall_percent: float | None = None
    letter_grade: str | None = None
    announcements: list[CrawlAnnouncement] = Field(default_factory=list)
    grades: list[CrawlGrade] = Field(default_factory=list)
    deadline_status: list[CrawlDeadlineStatus] = Field(default_factory=list)
    calendar_changes: list[CrawlLine] = Field(default_factory=list)
    needs_you: list[CrawlLine] = Field(default_factory=list)
    messages: list[CrawlMessage] = Field(default_factory=list)
    missing_count: int | None = None  # D2L/platform's own count of missing work
    # Claude-generated, clearly labeled advice. Only given when the grade
    # moved or new work was graded -- never a daily repeat.
    advice: str | None = None


# --------------------------------------------------------------------------
# Dedupe identities
# --------------------------------------------------------------------------

KIND_ANNOUNCEMENT = "announcement"
KIND_GRADE = "grade"
KIND_ATTENTION = "attention"
KIND_CALENDAR_CHANGE = "calendar_change"
KIND_NEEDS_YOU = "needs_you"
KIND_MESSAGE = "message"
KIND_STUDY_GUIDE = "study_guide"

GENERAL_COURSE_CODE = "MESSAGES"
"""Pseudo-course that holds D2L messages not tied to any class -- its
digest goes out as its own "Daily Overview Messages" email."""


def content_hash(data: dict[str, Any]) -> str:
    return hashlib.sha256(
        json.dumps(data, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()[:16]


def _norm(text: Any, keep: int = 80) -> str:
    """Text as a dedupe key that survives rewording around the edges: case,
    spacing, quotes and a trailing "…" cut don't matter, only the first
    `keep` characters do."""
    t = re.sub(r"\s+", " ", str(text or "")).strip().lower()
    t = re.sub(r"(\.\.\.|…)$", "", t).strip(" \"'“”‘’")
    return t[:keep]


def stable_hash(kind: str, payload: dict[str, Any]) -> str | None:
    """What identifies an unchanged announcement, grade or message, from
    the parts that don't depend on how a run worded its excerpts: an
    announcement's title, a grade's score and the start of its feedback, a
    message's subject. Used to compare with what's stored, so a run that
    quotes different highlights (or shortens a long comment) doesn't
    resend old news as "updated". None for kinds without one."""
    if kind == KIND_ANNOUNCEMENT:
        return content_hash({"t": _norm(payload.get("title"), 200)})
    if kind == KIND_GRADE:
        return content_hash({"s": payload.get("score_percent"), "x": _norm(payload.get("score_text"), 40),
                             "c": _norm(payload.get("comment"))})
    if kind == KIND_MESSAGE:
        return content_hash({"s": _norm(payload.get("subject"), 200)})
    return None


@dataclass
class EntryToRecord:
    kind: str
    external_id: str
    content_hash: str
    payload: dict[str, Any]
    dated: date | None  # the item's own date, for the first-run baseline


def entries_from_crawl(crawl: DigestCrawl) -> list[EntryToRecord]:
    """Every dedupe-tracked observation in one crawl. Grades hash only
    their score + comment, so a later re-crawl of an unchanged grade is
    "seen", while a regrade or newly added feedback resurfaces."""
    out: list[EntryToRecord] = []
    for a in crawl.announcements:
        payload = a.model_dump(mode="json")
        out.append(EntryToRecord(
            KIND_ANNOUNCEMENT, a.id,
            content_hash({"title": a.title, "highlights": a.highlights}),
            payload, a.posted_on,
        ))
    for g in crawl.grades:
        payload = g.model_dump(mode="json")
        out.append(EntryToRecord(
            KIND_GRADE, g.id,
            content_hash({"score": g.score_percent, "text": g.score_text, "comment": g.comment}),
            payload, g.graded_on,
        ))
    for m in crawl.messages:
        payload = m.model_dump(mode="json")
        out.append(EntryToRecord(KIND_MESSAGE, m.id,
                                 content_hash({"s": m.subject, "e": m.excerpt}),
                                 payload, m.received_on))
    for line in crawl.calendar_changes:
        data = line.model_dump(mode="json")
        out.append(EntryToRecord(KIND_CALENDAR_CHANGE, content_hash(data), content_hash(data),
                                 data, crawl.captured_on))
    for line in crawl.needs_you:
        data = line.model_dump(mode="json")
        out.append(EntryToRecord(KIND_NEEDS_YOU, content_hash(data), content_hash(data),
                                 data, crawl.captured_on))
    return out


def attention_entries(
    crawl: DigestCrawl,
    *,
    week_ago: CourseGradeSnapshot | None,
) -> list[EntryToRecord]:
    """Needs-attention triggers -- the weekly diagnostic's Red rules
    (`diagnostics.py`), applied daily. Each has a stable key so it is
    reported once, when it first appears, not every morning after."""
    out: list[EntryToRecord] = []
    for g in crawl.grades:
        if g.score_percent is None:
            continue
        if g.score_percent <= 0:
            text = f"{g.title} was graded 0%."
            out.append(EntryToRecord(KIND_ATTENTION, f"zero:{g.id}", content_hash({"t": text}),
                                     {"text": text, "url": g.feedback_url or g.item_url},
                                     g.graded_on or crawl.captured_on))
        elif g.is_major and g.score_percent < RED_MAJOR_ASSESSMENT_FLOOR:
            text = f"{g.title} scored {g.score_percent:g}% (under {RED_MAJOR_ASSESSMENT_FLOOR:g}%)."
            out.append(EntryToRecord(KIND_ATTENTION, f"major:{g.id}", content_hash({"t": text}),
                                     {"text": text, "url": g.feedback_url or g.item_url},
                                     g.graded_on or crawl.captured_on))
    if crawl.missing_count is not None and crawl.missing_count >= RED_MISSING_COUNT:
        text = f"{crawl.missing_count} assignments are marked missing."
        key = f"missing:{crawl.missing_count}"
        out.append(EntryToRecord(KIND_ATTENTION, key, content_hash({"t": text}),
                                 {"text": text}, crawl.captured_on))
    if (
        week_ago is not None
        and week_ago.overall_percent is not None
        and crawl.overall_percent is not None
        and week_ago.overall_percent - crawl.overall_percent >= RED_DROP_POINTS
    ):
        drop = week_ago.overall_percent - crawl.overall_percent
        text = (f"Overall grade dropped {drop:.1f} points in a week "
                f"({week_ago.overall_percent:g}% → {crawl.overall_percent:g}%).")
        iso = crawl.captured_on.isocalendar()
        out.append(EntryToRecord(KIND_ATTENTION, f"drop:{iso.year}-W{iso.week}",
                                 content_hash({"t": text}), {"text": text}, crawl.captured_on))
    return out


# --------------------------------------------------------------------------
# Deadlines (from the local DB)
# --------------------------------------------------------------------------


def is_actionable(item: AcademicItem) -> bool:
    """A real turn-in deadline the user acts on: deadline-type items, plus
    proctored/async exams that carry a due_time. Not lectures, not
    reading banners, not retired/cancelled rows."""
    if item.date is None:
        return False
    if item.status not in (ItemStatus.CLEAR, ItemStatus.SYNCED):
        return False
    if item.item_type in (ItemType.READING, ItemType.WEEKLY_READING):
        return False
    if item.item_type in (ItemType.EXAM, ItemType.FINAL_EXAM, ItemType.LAB_PRACTICAL):
        return True
    return item.item_type.is_deadline or item.due_time is not None


def best_action_url(item: AcademicItem) -> str | None:
    """Where to click to actually do/turn in the item: the separate
    submission slot first, then the item's own page."""
    return item.submission_url or item.reference_url or item.resource_url


@dataclass
class DeadlineLine:
    item_id: str
    title: str
    due_on: date
    due_time: time | None
    url: str | None
    submitted: bool | None = None
    window_open: bool | None = None


def deadline_lines(items: list[AcademicItem], on: date) -> list[DeadlineLine]:
    lines = [
        DeadlineLine(
            item_id=i.id, title=i.title, due_on=on, due_time=i.due_time,
            url=best_action_url(i),
        )
        for i in items
        if is_actionable(i) and i.date == on
    ]
    lines.sort(key=lambda d: (d.due_time or time(23, 59), d.title))
    return lines


def upcoming_lines(items: list[AcademicItem], after: date, days: int) -> list[DeadlineLine]:
    out = []
    for i in items:
        if is_actionable(i) and i.date is not None and 0 < (i.date - after).days <= days:
            out.append(DeadlineLine(i.id, i.title, i.date, i.due_time, best_action_url(i)))
    out.sort(key=lambda d: (d.due_on, d.due_time or time(23, 59), d.title))
    return out


# --------------------------------------------------------------------------
# The assembled overview
# --------------------------------------------------------------------------


@dataclass
class DailyOverview:
    course_code: str
    course_name: str
    digest_date: date
    login_failed: bool = False
    overall_percent: float | None = None
    letter_grade: str | None = None
    trend_points: float | None = None
    trend_since: date | None = None
    advice: str | None = None
    attention: list[dict[str, Any]] = field(default_factory=list)
    graded: list[dict[str, Any]] = field(default_factory=list)
    announcements: list[dict[str, Any]] = field(default_factory=list)
    missed_yesterday: list[DeadlineLine] = field(default_factory=list)
    due_today: list[DeadlineLine] = field(default_factory=list)
    upcoming: list[DeadlineLine] = field(default_factory=list)
    calendar_changes: list[dict[str, Any]] = field(default_factory=list)
    needs_you: list[dict[str, Any]] = field(default_factory=list)
    messages: list[dict[str, Any]] = field(default_factory=list)
    show_grade: bool = True
    portal_links: list[tuple[str, str]] = field(default_factory=list)  # (label, url)

    @property
    def has_news(self) -> bool:
        """Whether this course gets an email today. A quiet day (nothing
        new, nothing missed, nothing due tonight) sends nothing -- the
        upcoming list and grade line alone never justify an email. A
        failed login never sends (user-directed 2026-10-09): without a real
        crawl the email would be built from stale local data only."""
        if self.login_failed:
            return False
        return bool(
            self.attention
            or self.graded
            or self.announcements
            or self.missed_yesterday
            or self.due_today
            or self.calendar_changes
            or self.needs_you
            or self.messages
        )


_PORTAL_FOOTER_ORDER = ("home", "grades", "announcements", "content", "dropbox", "quizzes",
                        "external_home", "external_gradebook")


def build_overview(
    *,
    course_code: str,
    course_name: str,
    digest_date: date,
    login_failed: bool,
    overall_percent: float | None,
    letter_grade: str | None,
    week_ago: CourseGradeSnapshot | None,
    advice: str | None,
    pending: list[DigestEntry],
    items: list[AcademicItem],
    statuses: dict[str, tuple[bool | None, bool | None]],
    portal_links: list[tuple[str, str, str]],  # (kind, label, url)
    upcoming_days: int = 3,
) -> DailyOverview:
    """Assemble one course's overview. `pending` is every not-yet-emailed
    digest entry; `statuses` maps item id -> (submitted, window_open) from
    the morning crawl; `items` is the course's local items."""
    trend_points = None
    trend_since = None
    if (
        week_ago is not None
        and week_ago.overall_percent is not None
        and overall_percent is not None
    ):
        trend_points = overall_percent - week_ago.overall_percent
        trend_since = week_ago.week_start

    def by_kind(kind: str) -> list[dict[str, Any]]:
        return [e.payload for e in pending if e.kind == kind]

    yesterday = digest_date - timedelta(days=1)
    missed: list[DeadlineLine] = []
    for line in deadline_lines(items, yesterday):
        submitted, window_open = statuses.get(line.item_id, (None, None))
        if submitted is True:
            continue
        # submitted is None = couldn't confirm either way; the email says
        # "not confirmed" rather than calling it missed.
        line.submitted, line.window_open = submitted, window_open
        missed.append(line)

    due_today = []
    for line in deadline_lines(items, digest_date):
        submitted, window_open = statuses.get(line.item_id, (None, None))
        if submitted is True:
            continue
        line.submitted, line.window_open = submitted, window_open
        due_today.append(line)

    footer: list[tuple[str, str]] = []
    for kind in _PORTAL_FOOTER_ORDER:
        for k, label, url in portal_links:
            if k == kind:
                footer.append((label or kind.replace("_", " ").title(), url))

    graded = by_kind(KIND_GRADE)
    graded.sort(key=lambda g: (g.get("graded_on") or "", g.get("title") or ""), reverse=True)
    announcements = by_kind(KIND_ANNOUNCEMENT)
    announcements.sort(key=lambda a: a.get("posted_on") or "", reverse=True)

    return DailyOverview(
        course_code=course_code,
        course_name=course_name,
        digest_date=digest_date,
        login_failed=login_failed,
        overall_percent=overall_percent,
        letter_grade=letter_grade,
        trend_points=trend_points,
        trend_since=trend_since,
        advice=advice,
        attention=by_kind(KIND_ATTENTION),
        graded=graded,
        announcements=announcements,
        missed_yesterday=missed,
        due_today=due_today,
        upcoming=upcoming_lines(items, digest_date, upcoming_days),
        calendar_changes=by_kind(KIND_CALENDAR_CHANGE),
        needs_you=by_kind(KIND_NEEDS_YOU),
        messages=by_kind(KIND_MESSAGE),
        show_grade=course_code != GENERAL_COURSE_CODE,
        portal_links=footer,
    )
