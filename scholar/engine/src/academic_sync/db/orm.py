"""SQLAlchemy ORM schema.

One SQLite file is the entire durable state of the system: courses, sources,
academic items, unresolved references, preferences, sync records, and the
audit log. Schema changes go through db/migrations.py, not by editing
existing columns in place -- see that module's docstring.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, time
from datetime import date as _date
from typing import Any

# `date` is imported as `_date` -- AcademicItemRow has a column literally
# named `date`, which shadows a bare `date` import when SQLAlchemy resolves
# `Mapped[...]` annotations against the class namespace. See the matching
# note in models/domain.py for the full explanation.
from sqlalchemy import JSON, Boolean, Date, DateTime, Float, ForeignKey, Time, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def _uuid() -> str:
    return uuid.uuid4().hex


def _now() -> datetime:
    return datetime.now(UTC)


class Base(DeclarativeBase):
    pass


class CourseRow(Base):
    __tablename__ = "courses"

    id: Mapped[str] = mapped_column(primary_key=True, default=_uuid)
    course_code: Mapped[str]
    section: Mapped[str | None] = mapped_column(default=None)
    name: Mapped[str]
    term: Mapped[str]
    instructor: Mapped[str | None] = mapped_column(default=None)
    instructor_contact: Mapped[str | None] = mapped_column(default=None)
    campus: Mapped[str | None] = mapped_column(default=None)
    start_date: Mapped[_date | None] = mapped_column(Date, default=None)
    end_date: Mapped[_date | None] = mapped_column(Date, default=None)
    d2l_identifier: Mapped[str | None] = mapped_column(default=None)
    d2l_url: Mapped[str | None] = mapped_column(default=None)
    delivery_format: Mapped[str | None] = mapped_column(default=None)
    status: Mapped[str] = mapped_column(default="active")
    is_synthetic: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)

    sources: Mapped[list[SourceRow]] = relationship(back_populates="course")
    items: Mapped[list[AcademicItemRow]] = relationship(back_populates="course")


class SourceRow(Base):
    __tablename__ = "sources"

    id: Mapped[str] = mapped_column(primary_key=True, default=_uuid)
    course_id: Mapped[str] = mapped_column(ForeignKey("courses.id"))
    source_type: Mapped[str]
    title: Mapped[str]
    url: Mapped[str | None] = mapped_column(default=None)
    local_path: Mapped[str | None] = mapped_column(default=None)
    retrieved_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    modified_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    content_hash: Mapped[str]
    parser_version: Mapped[str]
    extracted_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    is_tentative: Mapped[bool] = mapped_column(Boolean, default=False)
    superseded_by_id: Mapped[str | None] = mapped_column(default=None)
    raw_text: Mapped[str | None] = mapped_column(default=None)

    course: Mapped[CourseRow] = relationship(back_populates="sources")


class AcademicItemRow(Base):
    __tablename__ = "academic_items"

    id: Mapped[str] = mapped_column(primary_key=True, default=_uuid)
    course_id: Mapped[str] = mapped_column(ForeignKey("courses.id"))
    source_ids_json: Mapped[list[str]] = mapped_column(JSON, default=list)
    item_type: Mapped[str]
    title: Mapped[str]
    description: Mapped[str | None] = mapped_column(default=None)
    date: Mapped[_date | None] = mapped_column(Date, default=None)
    start_time: Mapped[time | None] = mapped_column(Time, default=None)
    end_time: Mapped[time | None] = mapped_column(Time, default=None)
    due_time: Mapped[time | None] = mapped_column(Time, default=None)
    location_id: Mapped[str | None] = mapped_column(ForeignKey("locations.id"), default=None)
    platform_location: Mapped[str | None] = mapped_column(default=None)
    module_label: Mapped[str | None] = mapped_column(default=None)
    parent_item_id: Mapped[str | None] = mapped_column(default=None)
    status: Mapped[str] = mapped_column(default="draft")
    confidence: Mapped[float] = mapped_column(Float, default=0.5)
    is_tentative: Mapped[bool] = mapped_column(Boolean, default=False)
    is_derived: Mapped[bool] = mapped_column(Boolean, default=False)
    derivation_rule: Mapped[str | None] = mapped_column(default=None)
    source_wording: Mapped[str | None] = mapped_column(default=None)
    reference_url: Mapped[str | None] = mapped_column(default=None)
    reference_url_label: Mapped[str | None] = mapped_column(default=None)
    resource_url: Mapped[str | None] = mapped_column(default=None)
    resource_url_label: Mapped[str | None] = mapped_column(default=None)
    submission_url: Mapped[str | None] = mapped_column(default=None)
    submission_url_label: Mapped[str | None] = mapped_column(default=None)
    # WEEKLY_READING / meetings -- JSON list of {"label", "url", "kind", "chapter"} (see
    # domain.WeeklyLink). Empty list for every other item type.
    weekly_links_json: Mapped[list[dict[str, str]]] = mapped_column(JSON, default=list)
    covered_chapters_json: Mapped[list[str]] = mapped_column(JSON, default=list)
    study_focus_json: Mapped[list[str]] = mapped_column(JSON, default=list)
    video_url: Mapped[str | None] = mapped_column(default=None)
    video_url_label: Mapped[str | None] = mapped_column(default=None)
    link_available_date: Mapped[_date | None] = mapped_column(Date, default=None)
    date_range_end: Mapped[_date | None] = mapped_column(Date, default=None)
    points: Mapped[float | None] = mapped_column(Float, default=None)
    is_optional: Mapped[bool] = mapped_column(Boolean, default=False)
    is_inferred_date: Mapped[bool] = mapped_column(Boolean, default=False)
    date_inference_rule: Mapped[str | None] = mapped_column(default=None)
    first_seen: Mapped[datetime] = mapped_column(DateTime, default=_now)
    last_seen: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)
    source_hash: Mapped[str | None] = mapped_column(default=None)
    superseded_by_id: Mapped[str | None] = mapped_column(default=None)
    calendar_event_id: Mapped[str | None] = mapped_column(default=None)
    calendar_fingerprint: Mapped[str | None] = mapped_column(default=None)
    fingerprint: Mapped[str] = mapped_column(index=True)

    course: Mapped[CourseRow] = relationship(back_populates="items")
    location: Mapped[LocationRow | None] = relationship()


class LocationRow(Base):
    __tablename__ = "locations"

    id: Mapped[str] = mapped_column(primary_key=True, default=_uuid)
    campus: Mapped[str | None] = mapped_column(default=None)
    building: Mapped[str | None] = mapped_column(default=None)
    room: Mapped[str | None] = mapped_column(default=None)
    street_address: Mapped[str | None] = mapped_column(default=None)
    city: Mapped[str | None] = mapped_column(default=None)
    state: Mapped[str | None] = mapped_column(default=None)
    zip_code: Mapped[str | None] = mapped_column(default=None)
    platform_location: Mapped[str | None] = mapped_column(default=None)
    aliases_json: Mapped[list[str]] = mapped_column(JSON, default=list)
    resolved: Mapped[bool] = mapped_column(Boolean, default=False)

    def google_location_string(self) -> str | None:
        if self.platform_location:
            return self.platform_location
        parts = [p for p in [self.campus, self.street_address, self.city] if p]
        if self.state and self.zip_code:
            parts.append(f"{self.state} {self.zip_code}")
        if self.room:
            parts.append(self.room)
        return ", ".join(parts) if parts else None


class UnresolvedReferenceRow(Base):
    __tablename__ = "unresolved_references"

    id: Mapped[str] = mapped_column(primary_key=True, default=_uuid)
    course_id: Mapped[str] = mapped_column(ForeignKey("courses.id"))
    item_id: Mapped[str | None] = mapped_column(ForeignKey("academic_items.id"), default=None)
    source_id: Mapped[str | None] = mapped_column(ForeignKey("sources.id"), default=None)
    kind: Mapped[str]
    description: Mapped[str]
    source_wording: Mapped[str | None] = mapped_column(default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    resolved: Mapped[bool] = mapped_column(Boolean, default=False)
    resolution_note: Mapped[str | None] = mapped_column(default=None)


class ChapterTopicRow(Base):
    __tablename__ = "chapter_topics"

    id: Mapped[str] = mapped_column(primary_key=True, default=_uuid)
    course_id: Mapped[str] = mapped_column(ForeignKey("courses.id"))
    chapter_label: Mapped[str]
    title: Mapped[str | None] = mapped_column(default=None)
    vocabulary: Mapped[str | None] = mapped_column(default=None)
    objectives_json: Mapped[list[str]] = mapped_column(JSON, default=list)
    is_exhaustive: Mapped[bool] = mapped_column(Boolean, default=False)
    sections_json: Mapped[list[str]] = mapped_column(JSON, default=list)
    reading_url: Mapped[str | None] = mapped_column(default=None)
    reading_label: Mapped[str | None] = mapped_column(default=None)
    added_vocabulary: Mapped[str | None] = mapped_column(default=None)
    added_objectives_json: Mapped[list[str]] = mapped_column(JSON, default=list)
    source_ids_json: Mapped[list[str]] = mapped_column(JSON, default=list)
    source_wording: Mapped[str | None] = mapped_column(default=None)
    first_seen: Mapped[datetime] = mapped_column(DateTime, default=_now)
    last_seen: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)


class GradeSnapshotRow(Base):
    __tablename__ = "grade_snapshots"

    id: Mapped[str] = mapped_column(primary_key=True, default=_uuid)
    course_id: Mapped[str] = mapped_column(ForeignKey("courses.id"))
    academic_item_id: Mapped[str | None] = mapped_column(
        ForeignKey("academic_items.id"), default=None
    )
    title: Mapped[str]
    week_start: Mapped[_date] = mapped_column(Date, index=True)
    captured_at: Mapped[_date] = mapped_column(Date)
    score_percent: Mapped[float | None] = mapped_column(Float, default=None)
    is_missing: Mapped[bool] = mapped_column(Boolean, default=False)
    instructor_feedback: Mapped[str | None] = mapped_column(default=None)
    source_type: Mapped[str]


class CourseGradeSnapshotRow(Base):
    __tablename__ = "course_grade_snapshots"

    id: Mapped[str] = mapped_column(primary_key=True, default=_uuid)
    course_id: Mapped[str] = mapped_column(ForeignKey("courses.id"), index=True)
    week_start: Mapped[_date] = mapped_column(Date, index=True)
    captured_at: Mapped[_date] = mapped_column(Date)
    overall_percent: Mapped[float | None] = mapped_column(Float, default=None)
    letter_grade: Mapped[str | None] = mapped_column(default=None)


class WeeklyDiagnosticRecordRow(Base):
    """One row per (course, week) -- user-directed 2026-09-17: the weekly
    diagnostic became one Calendar event per course (each independently
    colored Red/Yellow/Green) instead of a single cross-course banner, so
    the idempotency key gained `course_id` alongside `week_start`."""

    __tablename__ = "weekly_diagnostic_records"
    __table_args__ = (UniqueConstraint("course_id", "week_start", name="uq_diagnostic_course_week"),)

    id: Mapped[str] = mapped_column(primary_key=True, default=_uuid)
    course_id: Mapped[str] = mapped_column(ForeignKey("courses.id"), index=True)
    week_start: Mapped[_date] = mapped_column(Date, index=True)
    status: Mapped[str]
    fingerprint: Mapped[str]
    google_event_id: Mapped[str | None] = mapped_column(default=None)
    google_calendar_id: Mapped[str | None] = mapped_column(default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)


class PreferenceRow(Base):
    __tablename__ = "preferences"

    id: Mapped[str] = mapped_column(primary_key=True, default=_uuid)
    key: Mapped[str] = mapped_column(index=True)
    value_json: Mapped[Any] = mapped_column(JSON)
    category: Mapped[str]
    scope: Mapped[str]
    course_id: Mapped[str | None] = mapped_column(ForeignKey("courses.id"), default=None)
    source: Mapped[str] = mapped_column(default="user_confirmed")
    confidence: Mapped[float] = mapped_column(Float, default=1.0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)
    active: Mapped[bool] = mapped_column(Boolean, default=True)


class SyncRecordRow(Base):
    __tablename__ = "sync_records"

    id: Mapped[str] = mapped_column(primary_key=True, default=_uuid)
    academic_item_id: Mapped[str] = mapped_column(
        ForeignKey("academic_items.id"), unique=True, index=True
    )
    google_calendar_id: Mapped[str | None] = mapped_column(default=None)
    google_event_id: Mapped[str | None] = mapped_column(default=None)
    last_synced_fingerprint: Mapped[str | None] = mapped_column(default=None)
    source_modified_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    status: Mapped[str] = mapped_column(default="REVIEW")
    last_synced_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    last_synced_fields: Mapped[dict | None] = mapped_column(JSON, default=None)


class AuditLogRow(Base):
    __tablename__ = "audit_log"

    id: Mapped[str] = mapped_column(primary_key=True, default=_uuid)
    timestamp: Mapped[datetime] = mapped_column(DateTime, default=_now, index=True)
    event_type: Mapped[str] = mapped_column(index=True)
    course_id: Mapped[str | None] = mapped_column(default=None)
    item_id: Mapped[str | None] = mapped_column(default=None)
    source_id: Mapped[str | None] = mapped_column(default=None)
    summary: Mapped[str]
    details_json: Mapped[dict] = mapped_column(JSON, default=dict)


class SchemaVersionRow(Base):
    __tablename__ = "schema_version"

    id: Mapped[int] = mapped_column(primary_key=True, default=1)
    version: Mapped[int]
    applied_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class CoursePortalLinkRow(Base):
    __tablename__ = "course_portal_links"
    __table_args__ = (UniqueConstraint("course_id", "kind", "label", name="uq_portal_link"),)

    id: Mapped[str] = mapped_column(primary_key=True, default=_uuid)
    course_id: Mapped[str] = mapped_column(ForeignKey("courses.id"), index=True)
    kind: Mapped[str]
    label: Mapped[str] = mapped_column(default="")
    url: Mapped[str]
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)


class DigestEntryRow(Base):
    __tablename__ = "digest_entries"
    __table_args__ = (
        UniqueConstraint("course_id", "kind", "external_id", name="uq_digest_entry"),
    )

    id: Mapped[str] = mapped_column(primary_key=True, default=_uuid)
    course_id: Mapped[str] = mapped_column(ForeignKey("courses.id"), index=True)
    kind: Mapped[str]
    external_id: Mapped[str]
    content_hash: Mapped[str]
    payload_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    first_seen: Mapped[datetime] = mapped_column(DateTime, default=_now)
    emailed_on: Mapped[_date | None] = mapped_column(Date, default=None)


class DailyDigestRecordRow(Base):
    __tablename__ = "daily_digest_records"
    __table_args__ = (
        UniqueConstraint("course_id", "digest_date", name="uq_daily_digest_course_date"),
    )

    id: Mapped[str] = mapped_column(primary_key=True, default=_uuid)
    course_id: Mapped[str] = mapped_column(ForeignKey("courses.id"), index=True)
    digest_date: Mapped[_date] = mapped_column(Date, index=True)
    gmail_message_id: Mapped[str | None] = mapped_column(default=None)
    skipped: Mapped[bool] = mapped_column(Boolean, default=False)
    crawl_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class StudyPdfRow(Base):
    """One weekly study PDF per banner (CLAUDE.md invariant 41). A row
    with `file_path` set means the PDF was built; a row with only
    `skipped_reason` means the week was deliberately skipped (e.g. every
    chapter already has a PDF and nothing is tested). Either way the week
    never comes up as "due" again unless the row is removed."""

    __tablename__ = "study_pdfs"
    __table_args__ = (UniqueConstraint("banner_item_id", name="uq_study_pdf_banner"),)

    id: Mapped[str] = mapped_column(primary_key=True, default=_uuid)
    course_id: Mapped[str] = mapped_column(ForeignKey("courses.id"), index=True)
    banner_item_id: Mapped[str] = mapped_column(ForeignKey("academic_items.id"))
    week_start: Mapped[_date] = mapped_column(Date, index=True)
    chapters_json: Mapped[list[str]] = mapped_column(JSON, default=list)
    file_path: Mapped[str | None] = mapped_column(default=None)
    source_path: Mapped[str | None] = mapped_column(default=None)
    page_count: Mapped[int | None] = mapped_column(default=None)
    skipped_reason: Mapped[str | None] = mapped_column(default=None)
    built_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
