"""Lightweight forward-only migrations.

Alembic is overkill for a single-user local SQLite file, but "just call
create_all()" silently drifts once real data exists. Instead: each schema
change is a numbered, idempotent function appended to MIGRATIONS. On startup
we compare the stored schema_version against len(MIGRATIONS) and apply
whatever is missing, in order. Never edit an already-shipped migration function
after it has been released -- add a new one instead, the same rule as any
other migration tool.
"""

from __future__ import annotations

from collections.abc import Callable

from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from academic_sync.db.orm import Base, SchemaVersionRow

MigrationFn = Callable[[Session], None]


def _0001_initial_schema(session: Session) -> None:
    # Table creation is handled by Base.metadata.create_all before migrations
    # run, so this migration is a no-op marker for "schema existed at v1".
    pass


def _0002_add_item_reference_urls(session: Session) -> None:
    # reference_url: a stable deep link to the item's own D2L page (content
    # topic, dropbox folder, or quiz), captured during discovery so a synced
    # Calendar event's description can link straight back to it.
    # resource_url: an optional stable link to external material (e.g. a
    # textbook chapter) -- only ever populated when the source gave a real,
    # persistent URL; never constructed/guessed.
    #
    # Base.metadata.create_all (run before migrations, see run_migrations)
    # already creates these columns on a brand-new database, since they're
    # part of the current AcademicItemRow definition -- only a pre-existing
    # database that predates this migration is actually missing them, so
    # this checks first rather than assuming ALTER TABLE is needed.
    existing = {row[1] for row in session.execute(text("PRAGMA table_info(academic_items)"))}
    if "reference_url" not in existing:
        session.execute(text("ALTER TABLE academic_items ADD COLUMN reference_url TEXT"))
    if "resource_url" not in existing:
        session.execute(text("ALTER TABLE academic_items ADD COLUMN resource_url TEXT"))


def _0003_add_item_points_and_optional(session: Session) -> None:
    # points: the item's stated point value, only ever set from an explicit
    # number in the source -- never inferred/estimated.
    # is_optional: true only when the source explicitly marks the item as
    # extra credit / optional / ungraded practice -- default False (assume
    # graded) rather than inferred from item_type, so a plain reading item
    # isn't mislabeled "Optional" just because readings sync as informational
    # all-day events (see CLAUDE.md invariant 15).
    existing = {row[1] for row in session.execute(text("PRAGMA table_info(academic_items)"))}
    if "points" not in existing:
        session.execute(text("ALTER TABLE academic_items ADD COLUMN points REAL"))
    if "is_optional" not in existing:
        session.execute(
            text("ALTER TABLE academic_items ADD COLUMN is_optional BOOLEAN NOT NULL DEFAULT 0")
        )


def _0004_add_item_link_labels(session: Session) -> None:
    # Human-readable labels for reference_url/resource_url, chosen by the
    # skill at sync time based on what kind of page each link actually is
    # (e.g. "Assignment" for a confirmed turn-in/dropbox page vs a more
    # general "D2L (Content -> Assignments -> HW 1.3)" when only a general
    # area is available; "Textbook" or "Textbook (Ch. 6)" for resource_url).
    # Rendered as the clickable text of an <a href> link, not the raw URL.
    existing = {row[1] for row in session.execute(text("PRAGMA table_info(academic_items)"))}
    if "reference_url_label" not in existing:
        session.execute(text("ALTER TABLE academic_items ADD COLUMN reference_url_label TEXT"))
    if "resource_url_label" not in existing:
        session.execute(text("ALTER TABLE academic_items ADD COLUMN resource_url_label TEXT"))


def _0005_add_item_link_available_date(session: Session) -> None:
    # link_available_date: set only when discovery found an explicit D2L
    # "Available on <date>" marker on an item that has no reference_url/
    # resource_url yet (i.e. the item is locked/not yet released, not that
    # nobody looked). Lets the calendar description show a real, sourced
    # "link opens <date>" note instead of just omitting the LINKS section --
    # and lets a periodic refresh pass (see academic-import SKILL.md's
    # "link refresh" step) find exactly the items worth re-checking, instead
    # of re-scanning everything. Cleared once a real link is found.
    existing = {row[1] for row in session.execute(text("PRAGMA table_info(academic_items)"))}
    if "link_available_date" not in existing:
        session.execute(text("ALTER TABLE academic_items ADD COLUMN link_available_date DATE"))


def _0006_add_item_date_range_end(session: Session) -> None:
    # date_range_end: week-end (inclusive) for a WEEKLY_READING item --
    # `date` is reused as the week's start. Lets a single AcademicItem
    # represent a real multi-day span (see sync/calendar_payload.py's
    # WEEKLY_READING branch) instead of the old one-item-per-day model.
    # See CLAUDE.md invariant 25.
    existing = {row[1] for row in session.execute(text("PRAGMA table_info(academic_items)"))}
    if "date_range_end" not in existing:
        session.execute(text("ALTER TABLE academic_items ADD COLUMN date_range_end DATE"))


def _0007_add_chapter_topics_table(session: Session) -> None:
    # chapter_topics is a brand-new table (not a new column on an existing
    # one) -- Base.metadata.create_all (run before migrations, see
    # run_migrations) already creates it automatically since it's part of
    # the current ORM model set. This entry is a no-op marker purely for
    # schema-version history, same reasoning as _0001_initial_schema.
    pass


def _0008_add_chapter_topic_is_exhaustive(session: Session) -> None:
    # is_exhaustive: True only once discovery has confirmed a chapter's
    # saved topics/objectives are the platform's real complete list, not a
    # sample or a personalized adaptive-queue view. See CLAUDE.md
    # invariant 26. Existing rows default False (unconfirmed) rather than
    # being assumed complete.
    existing = {row[1] for row in session.execute(text("PRAGMA table_info(chapter_topics)"))}
    if "is_exhaustive" not in existing:
        session.execute(
            text("ALTER TABLE chapter_topics ADD COLUMN is_exhaustive BOOLEAN DEFAULT 0")
        )


def _0009_add_item_inferred_date(session: Session) -> None:
    # is_inferred_date / date_inference_rule: user-authorized 2026-08-25
    # exception to the "never fabricate a date" rule -- ONLY after real,
    # exhaustive search across every relevant source has turned up no
    # literal date, AND there's a stated, one-sentence, auditable pattern
    # rule backed by real adjacent evidence already found (e.g. "every
    # other homework this course is due exactly N days after the prior
    # chapter exam, and that holds for all N already-confirmed items").
    # See CLAUDE.md invariant 29. `date_inference_rule` records that
    # one-sentence rule for local audit (same "kept local, not rendered"
    # treatment as source_wording); `is_inferred_date` drives the visible
    # "(Inferred Date)" tag in the synced description (see
    # sync/calendar_payload.py::_inferred_date_tag). Both default to the
    # ordinary case (False/None) -- a plain, literally-sourced date gets
    # neither.
    existing = {row[1] for row in session.execute(text("PRAGMA table_info(academic_items)"))}
    if "is_inferred_date" not in existing:
        session.execute(
            text("ALTER TABLE academic_items ADD COLUMN is_inferred_date BOOLEAN NOT NULL DEFAULT 0")
        )
    if "date_inference_rule" not in existing:
        session.execute(text("ALTER TABLE academic_items ADD COLUMN date_inference_rule TEXT"))


def _0010_add_sync_record_last_synced_fields(session: Session) -> None:
    # last_synced_fields: a real JSON snapshot of
    # reconciliation.engine._COMPARED_FIELDS at the moment this item was
    # actually last pushed to Calendar (see
    # reconciliation/engine.py::snapshot_compared_fields). Real incident,
    # 2026-08-25: an item already synced got module_label/reference_url
    # enriched afterward via `render --save`, outside the extraction
    # pipeline -- standalone `plan` compares an item's current stored
    # state against itself (see sync/planner.py::compute_plan), so it
    # could never detect this class of drift no matter which fields were
    # compared; there was nothing else to compare against. This snapshot
    # is what closes that gap. NULL for any SyncRecord written before this
    # migration -- decide_action falls back to the old existing-vs-
    # incoming comparison for those, same as before this existed.
    existing = {row[1] for row in session.execute(text("PRAGMA table_info(sync_records)"))}
    if "last_synced_fields" not in existing:
        session.execute(text("ALTER TABLE sync_records ADD COLUMN last_synced_fields JSON"))


def _0011_add_course_is_synthetic(session: Session) -> None:
    # is_synthetic: True for a self-directed, fully AI-authored curriculum
    # with no real D2L/instructor source at all (see
    # .claude/skills/custom-curriculum/SKILL.md and CLAUDE.md invariant
    # 35). Lives in the same `courses` table as a real scraped course --
    # this flag is what gates invariant 22's "never fabricate content"
    # bar being inapplicable to a course's weekly topic/pacing content.
    # Existing rows default False -- no course before this migration was
    # ever anything else.
    existing = {row[1] for row in session.execute(text("PRAGMA table_info(courses)"))}
    if "is_synthetic" not in existing:
        session.execute(
            text("ALTER TABLE courses ADD COLUMN is_synthetic BOOLEAN NOT NULL DEFAULT 0")
        )


def _0012_add_item_weekly_links(session: Session) -> None:
    # weekly_links_json: WEEKLY_READING banners only -- a JSON list of
    # {"label", "url"} objects (see domain.WeeklyLink). A weekly overview
    # aggregates a whole week, so it can carry more than the two
    # reference_url/resource_url slots: typically that week's lecture
    # video(s), slide deck, and textbook chapter reading -- whichever
    # discovery found, never a syllabus link (user-directed 2026-09-01, see
    # CLAUDE.md invariant 25). When non-empty this list renders under LINKS
    # in place of reference_url/resource_url. Existing rows get NULL, which
    # _item_row_to_domain reads as []. Additive, backward-compatible.
    existing = {row[1] for row in session.execute(text("PRAGMA table_info(academic_items)"))}
    if "weekly_links_json" not in existing:
        session.execute(text("ALTER TABLE academic_items ADD COLUMN weekly_links_json JSON"))


def _0013_add_grade_diagnostic_tables(session: Session) -> None:
    # grade_snapshots / course_grade_snapshots / weekly_diagnostic_records
    # are brand-new tables (not new columns on existing ones) --
    # Base.metadata.create_all (run before migrations, see run_migrations)
    # already creates them automatically since they're part of the current
    # ORM model set. This entry is a no-op marker purely for schema-version
    # history, same reasoning as _0007_add_chapter_topics_table.
    pass


def _0014_weekly_diagnostic_records_per_course(session: Session) -> None:
    # User-directed 2026-09-17: the weekly diagnostic became one Calendar
    # event per course (each independently Red/Yellow/Green) instead of a
    # single cross-course banner, so WeeklyDiagnosticRecordRow gained a
    # required course_id and its unique key changed from (week_start) alone
    # to (course_id, week_start) -- see the ORM class's own docstring.
    # SQLite can't ALTER a UNIQUE constraint in place, and this table went
    # from "just introduced this session" to "redesigned this session"
    # with exactly one real row in local dev use, never shared/production
    # data -- a clean drop+recreate from the current ORM definition is
    # safe and simpler than hand-writing the ALTER sequence a real
    # production migration would need. A table that was never created at
    # all (a fresh DB) is left alone -- Base.metadata.create_all (already
    # run before migrations, see run_migrations) already created it fresh
    # with the current schema in that case.
    existing = {row[1] for row in session.execute(text("PRAGMA table_info(weekly_diagnostic_records)"))}
    if existing and "course_id" not in existing:
        session.execute(text("DROP TABLE weekly_diagnostic_records"))
        # No `tables=` filter -- create_all with none re-creates only the
        # table just dropped and silently skips every other already
        # -existing table, same net effect without fighting SQLAlchemy's
        # FromClause/Table typing on a single-table filter list.
        Base.metadata.create_all(session.get_bind())


def _0015_add_item_mock_spec(session: Session) -> None:
    # RETIRED -- nothing reads or writes mock_spec_json. It was added
    # 2026-09-25 for a mock-quiz feature for synthetic courses that the user
    # reversed the same day, before it shipped (see CLAUDE.md invariant 35).
    # Kept only because it already ran on the local DB: removing it would make
    # the next real migration's number collide with this schema version.
    existing = {row[1] for row in session.execute(text("PRAGMA table_info(academic_items)"))}
    if "mock_spec_json" not in existing:
        session.execute(text("ALTER TABLE academic_items ADD COLUMN mock_spec_json JSON"))


def _0016_add_reading_and_submission_links(session: Session) -> None:
    # 2026-10-05 course-shell redesign: chapter-level reading data
    # (section headings + chapter-specific reading link) on chapter_topics,
    # and a separate "Submit Work" slot on academic_items for exams whose
    # work is turned in to a different dropbox. Additive columns only.
    items = {row[1] for row in session.execute(text("PRAGMA table_info(academic_items)"))}
    for col in ("submission_url", "submission_url_label"):
        if col not in items:
            session.execute(text(f"ALTER TABLE academic_items ADD COLUMN {col} VARCHAR"))
    topics = {row[1] for row in session.execute(text("PRAGMA table_info(chapter_topics)"))}
    if "sections_json" not in topics:
        session.execute(text("ALTER TABLE chapter_topics ADD COLUMN sections_json JSON"))
    for col in ("reading_url", "reading_label"):
        if col not in topics:
            session.execute(text(f"ALTER TABLE chapter_topics ADD COLUMN {col} VARCHAR"))


def _0017_add_daily_digest_tables(session: Session) -> None:
    # course_portal_links / digest_entries / daily_digest_records are
    # brand-new tables -- Base.metadata.create_all (run before migrations)
    # already creates them. No-op marker for schema-version history, same
    # as _0007/_0013.
    pass


def _0018_add_study_depth_fields(session: Session) -> None:
    # 2026-10-15 study-depth redesign (CLAUDE.md invariant 40): tests carry
    # their covered chapters + study-guide focus, homework carries a video
    # link, and chapter topics get a labeled Claude gap-fill list. Additive
    # columns only.
    items = {row[1] for row in session.execute(text("PRAGMA table_info(academic_items)"))}
    for col in ("covered_chapters_json", "study_focus_json"):
        if col not in items:
            session.execute(text(f"ALTER TABLE academic_items ADD COLUMN {col} JSON"))
    for col in ("video_url", "video_url_label"):
        if col not in items:
            session.execute(text(f"ALTER TABLE academic_items ADD COLUMN {col} VARCHAR"))
    topics = {row[1] for row in session.execute(text("PRAGMA table_info(chapter_topics)"))}
    if "added_vocabulary" not in topics:
        session.execute(text("ALTER TABLE chapter_topics ADD COLUMN added_vocabulary VARCHAR"))
    if "added_objectives_json" not in topics:
        session.execute(text("ALTER TABLE chapter_topics ADD COLUMN added_objectives_json JSON"))


def _0019_add_study_pdfs_table(session: Session) -> None:
    # study_pdfs (CLAUDE.md invariant 41) is a brand-new table --
    # Base.metadata.create_all (run before migrations) already creates it.
    # No-op marker for schema-version history, same as _0017.
    pass


MIGRATIONS: list[MigrationFn] = [
    _0001_initial_schema,
    _0002_add_item_reference_urls,
    _0003_add_item_points_and_optional,
    _0004_add_item_link_labels,
    _0005_add_item_link_available_date,
    _0006_add_item_date_range_end,
    _0007_add_chapter_topics_table,
    _0008_add_chapter_topic_is_exhaustive,
    _0009_add_item_inferred_date,
    _0010_add_sync_record_last_synced_fields,
    _0011_add_course_is_synthetic,
    _0012_add_item_weekly_links,
    _0013_add_grade_diagnostic_tables,
    _0014_weekly_diagnostic_records_per_course,
    _0015_add_item_mock_spec,
    _0016_add_reading_and_submission_links,
    _0017_add_daily_digest_tables,
    _0018_add_study_depth_fields,
    _0019_add_study_pdfs_table,
]


def _get_version(session: Session) -> int:
    row = session.get(SchemaVersionRow, 1)
    return row.version if row else 0


def _set_version(session: Session, version: int) -> None:
    row = session.get(SchemaVersionRow, 1)
    if row is None:
        row = SchemaVersionRow(id=1, version=version)
        session.add(row)
    else:
        row.version = version


def run_migrations(engine: Engine) -> int:
    """Create all tables if needed, then apply any pending migrations.

    Returns the resulting schema version.
    """
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        current = _get_version(session)
        for i in range(current, len(MIGRATIONS)):
            MIGRATIONS[i](session)
        _set_version(session, len(MIGRATIONS))
        session.commit()
        return len(MIGRATIONS)


def check_connection(engine: Engine) -> bool:
    with engine.connect() as conn:
        conn.execute(text("SELECT 1"))
    return True
