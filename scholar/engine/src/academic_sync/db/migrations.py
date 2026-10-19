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


def _0020_add_chapter_summary(session: Session) -> None:
    # 2026-10-16 (Kea): a short student-facing chapter description, written
    # with the chapter's study PDF. Additive column only.
    topics = {row[1] for row in session.execute(text("PRAGMA table_info(chapter_topics)"))}
    if "summary" not in topics:
        session.execute(text("ALTER TABLE chapter_topics ADD COLUMN summary VARCHAR"))


def _0021_add_item_history(session: Session) -> None:
    # 2026-10-19 (Kea): an append-only history of every calendar item, kept by the database itself. The student asked
    # to always know exactly why and when anything was changed or lost; until now updates overwrote rows in place
    # (a "Lab 3 Handout" deadline silently replaced the "Lab 3: Classification" lab meeting) and supersessions left no
    # reason. Triggers record every create and every change (old -> new, per field) with the run and command that made
    # it and the reason given, whatever wrote it (engine command, ad-hoc script, raw SQL). Calendar items and sources
    # can't be deleted any more (supersede or cancel them, with a reason), and the history itself can't be edited.
    stmts = [
        """CREATE TABLE IF NOT EXISTS event_context (id INTEGER PRIMARY KEY CHECK (id = 1), run_id TEXT, command TEXT, reason TEXT)""",
        """INSERT OR IGNORE INTO event_context (id, run_id, command, reason) VALUES (1, 'migration', 'db upgrade', NULL)""",
        """CREATE TABLE IF NOT EXISTS item_events (
             id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, run_id TEXT, command TEXT, reason TEXT,
             op TEXT NOT NULL, table_name TEXT NOT NULL, row_id TEXT, course_id TEXT, changes_json TEXT)""",
        """CREATE INDEX IF NOT EXISTS ix_item_events_row ON item_events (row_id, ts)""",
        """CREATE INDEX IF NOT EXISTS ix_item_events_ts ON item_events (ts)""",
        """CREATE TRIGGER IF NOT EXISTS item_events_no_update BEFORE UPDATE ON item_events
             BEGIN SELECT RAISE(ABORT, 'Item history is append-only.'); END""",
        """CREATE TRIGGER IF NOT EXISTS item_events_no_delete BEFORE DELETE ON item_events
             BEGIN SELECT RAISE(ABORT, 'Item history is append-only.'); END""",
        """CREATE TRIGGER IF NOT EXISTS academic_items_history_insert AFTER INSERT ON academic_items BEGIN
             INSERT INTO item_events (ts, run_id, command, reason, op, table_name, row_id, course_id, changes_json)
             VALUES (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), (SELECT run_id FROM event_context WHERE id = 1), (SELECT command FROM event_context WHERE id = 1), (SELECT reason FROM event_context WHERE id = 1), 'create', 'academic_items', NEW.id, NEW.course_id, json_object('title', NEW.title, 'item_type', NEW.item_type, 'date', NEW.date, 'start_time', NEW.start_time, 'end_time', NEW.end_time, 'due_time', NEW.due_time, 'date_range_end', NEW.date_range_end, 'status', NEW.status, 'superseded_by_id', NEW.superseded_by_id, 'points', NEW.points, 'is_optional', NEW.is_optional, 'is_tentative', NEW.is_tentative, 'reference_url', NEW.reference_url, 'submission_url', NEW.submission_url, 'resource_url', NEW.resource_url, 'location_id', NEW.location_id, 'platform_location', NEW.platform_location, 'description', NEW.description, 'covered_chapters_json', NEW.covered_chapters_json, 'study_focus_json', NEW.study_focus_json, 'module_label', NEW.module_label, 'source_ids_json', NEW.source_ids_json));
           END""",
        """CREATE TRIGGER IF NOT EXISTS academic_items_history_update AFTER UPDATE ON academic_items BEGIN
             INSERT INTO item_events (ts, run_id, command, reason, op, table_name, row_id, course_id, changes_json)
             SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), (SELECT run_id FROM event_context WHERE id = 1), (SELECT command FROM event_context WHERE id = 1), (SELECT reason FROM event_context WHERE id = 1),
                    CASE WHEN OLD.superseded_by_id IS NULL AND NEW.superseded_by_id IS NOT NULL THEN 'supersede'
                         WHEN OLD.status IS NOT 'cancelled' AND NEW.status = 'cancelled' THEN 'cancel'
                         WHEN OLD.superseded_by_id IS NOT NULL AND NEW.superseded_by_id IS NULL THEN 'restore'
                         ELSE 'update' END,
                    'academic_items', NEW.id, NEW.course_id, ch
             FROM (SELECT json_group_object(k, json(v)) AS ch FROM (
          SELECT 'title' AS k, json_array(OLD.title, NEW.title) AS v WHERE OLD.title IS NOT NEW.title
          UNION ALL SELECT 'item_type' AS k, json_array(OLD.item_type, NEW.item_type) AS v WHERE OLD.item_type IS NOT NEW.item_type
          UNION ALL SELECT 'date' AS k, json_array(OLD.date, NEW.date) AS v WHERE OLD.date IS NOT NEW.date
          UNION ALL SELECT 'start_time' AS k, json_array(OLD.start_time, NEW.start_time) AS v WHERE OLD.start_time IS NOT NEW.start_time
          UNION ALL SELECT 'end_time' AS k, json_array(OLD.end_time, NEW.end_time) AS v WHERE OLD.end_time IS NOT NEW.end_time
          UNION ALL SELECT 'due_time' AS k, json_array(OLD.due_time, NEW.due_time) AS v WHERE OLD.due_time IS NOT NEW.due_time
          UNION ALL SELECT 'date_range_end' AS k, json_array(OLD.date_range_end, NEW.date_range_end) AS v WHERE OLD.date_range_end IS NOT NEW.date_range_end
          UNION ALL SELECT 'status' AS k, json_array(OLD.status, NEW.status) AS v WHERE OLD.status IS NOT NEW.status
          UNION ALL SELECT 'superseded_by_id' AS k, json_array(OLD.superseded_by_id, NEW.superseded_by_id) AS v WHERE OLD.superseded_by_id IS NOT NEW.superseded_by_id
          UNION ALL SELECT 'points' AS k, json_array(OLD.points, NEW.points) AS v WHERE OLD.points IS NOT NEW.points
          UNION ALL SELECT 'is_optional' AS k, json_array(OLD.is_optional, NEW.is_optional) AS v WHERE OLD.is_optional IS NOT NEW.is_optional
          UNION ALL SELECT 'is_tentative' AS k, json_array(OLD.is_tentative, NEW.is_tentative) AS v WHERE OLD.is_tentative IS NOT NEW.is_tentative
          UNION ALL SELECT 'reference_url' AS k, json_array(OLD.reference_url, NEW.reference_url) AS v WHERE OLD.reference_url IS NOT NEW.reference_url
          UNION ALL SELECT 'submission_url' AS k, json_array(OLD.submission_url, NEW.submission_url) AS v WHERE OLD.submission_url IS NOT NEW.submission_url
          UNION ALL SELECT 'resource_url' AS k, json_array(OLD.resource_url, NEW.resource_url) AS v WHERE OLD.resource_url IS NOT NEW.resource_url
          UNION ALL SELECT 'location_id' AS k, json_array(OLD.location_id, NEW.location_id) AS v WHERE OLD.location_id IS NOT NEW.location_id
          UNION ALL SELECT 'platform_location' AS k, json_array(OLD.platform_location, NEW.platform_location) AS v WHERE OLD.platform_location IS NOT NEW.platform_location
          UNION ALL SELECT 'description' AS k, json_array(OLD.description, NEW.description) AS v WHERE OLD.description IS NOT NEW.description
          UNION ALL SELECT 'covered_chapters_json' AS k, json_array(OLD.covered_chapters_json, NEW.covered_chapters_json) AS v WHERE OLD.covered_chapters_json IS NOT NEW.covered_chapters_json
          UNION ALL SELECT 'study_focus_json' AS k, json_array(OLD.study_focus_json, NEW.study_focus_json) AS v WHERE OLD.study_focus_json IS NOT NEW.study_focus_json
          UNION ALL SELECT 'module_label' AS k, json_array(OLD.module_label, NEW.module_label) AS v WHERE OLD.module_label IS NOT NEW.module_label
          UNION ALL SELECT 'source_ids_json' AS k, json_array(OLD.source_ids_json, NEW.source_ids_json) AS v WHERE OLD.source_ids_json IS NOT NEW.source_ids_json
             )) WHERE ch IS NOT NULL AND ch <> '{}';
           END""",
        """CREATE TRIGGER IF NOT EXISTS academic_items_no_delete BEFORE DELETE ON academic_items
             BEGIN SELECT RAISE(ABORT, 'Calendar items are never deleted: supersede or cancel them with a reason (item-supersede, item-cancel).'); END""",
        """CREATE TRIGGER IF NOT EXISTS sources_history_insert AFTER INSERT ON sources BEGIN
             INSERT INTO item_events (ts, run_id, command, reason, op, table_name, row_id, course_id, changes_json)
             VALUES (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), (SELECT run_id FROM event_context WHERE id = 1), (SELECT command FROM event_context WHERE id = 1), (SELECT reason FROM event_context WHERE id = 1), 'source', 'sources', NEW.id, NEW.course_id,
                     json_object('title', NEW.title, 'source_type', NEW.source_type, 'url', NEW.url, 'local_path', NEW.local_path));
           END""",
        """CREATE TRIGGER IF NOT EXISTS sources_no_delete BEFORE DELETE ON sources
             BEGIN SELECT RAISE(ABORT, 'Sources are never deleted: they are the record of where every item came from.'); END""",
        """CREATE TRIGGER IF NOT EXISTS sync_records_history_delete AFTER DELETE ON sync_records BEGIN
             INSERT INTO item_events (ts, run_id, command, reason, op, table_name, row_id, course_id, changes_json)
             VALUES (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), (SELECT run_id FROM event_context WHERE id = 1), (SELECT command FROM event_context WHERE id = 1), (SELECT reason FROM event_context WHERE id = 1), 'unsync', 'sync_records', OLD.academic_item_id, NULL, json_object('calendar_event_id', OLD.google_event_id));
           END""",
        """CREATE TRIGGER IF NOT EXISTS preferences_history_dismiss AFTER UPDATE ON preferences
             WHEN NEW.key = 'coverage_dismissed' AND OLD.value_json IS NOT NEW.value_json BEGIN
             INSERT INTO item_events (ts, run_id, command, reason, op, table_name, row_id, course_id, changes_json)
             VALUES (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), (SELECT run_id FROM event_context WHERE id = 1), (SELECT command FROM event_context WHERE id = 1), (SELECT reason FROM event_context WHERE id = 1), 'dismiss', 'preferences', NEW.key, NEW.course_id, json_array(OLD.value_json, NEW.value_json));
           END""",
        """CREATE TRIGGER IF NOT EXISTS preferences_history_dismiss_insert AFTER INSERT ON preferences
             WHEN NEW.key = 'coverage_dismissed' BEGIN
             INSERT INTO item_events (ts, run_id, command, reason, op, table_name, row_id, course_id, changes_json)
             VALUES (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), (SELECT run_id FROM event_context WHERE id = 1), (SELECT command FROM event_context WHERE id = 1), (SELECT reason FROM event_context WHERE id = 1), 'dismiss', 'preferences', NEW.key, NEW.course_id, json_array(NULL, NEW.value_json));
           END""",
        # Where every item stands today: the first entry of its history (nothing earlier was recorded).
        """INSERT INTO item_events (ts, run_id, command, reason, op, table_name, row_id, course_id, changes_json)
             SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'migration', 'db upgrade', 'History starts here: the item as it was when Kea began keeping history (first seen ' || COALESCE(first_seen, '?') || ')',
                    'baseline', 'academic_items', id, course_id, json_object('title', title, 'item_type', item_type, 'date', date, 'start_time', start_time, 'end_time', end_time, 'due_time', due_time, 'date_range_end', date_range_end, 'status', status, 'superseded_by_id', superseded_by_id, 'points', points, 'is_optional', is_optional, 'is_tentative', is_tentative, 'reference_url', reference_url, 'submission_url', submission_url, 'resource_url', resource_url, 'location_id', location_id, 'platform_location', platform_location, 'description', description, 'covered_chapters_json', covered_chapters_json, 'study_focus_json', study_focus_json, 'module_label', module_label, 'source_ids_json', source_ids_json)
             FROM academic_items""",
    ]
    for st in stmts:
        session.execute(text(st))


def _0022_add_curriculum(session: Session) -> None:
    # 2026-10-19 (Kea): the curriculum is held to the syllabus. `course_outcomes` (the syllabus's required outcomes,
    # module outcomes and topical outline, each with the chapters that teach it) is a new table (create_all made it);
    # chapters get `textbook_ref` (where the chapter is in the student's own book: BIO1112's lecture chapters are
    # numbered from a different book than the one the class uses). Chapter notes and outcomes get the same
    # append-only history as calendar items, and can't be deleted: an objective or section heading that goes missing
    # can always be traced to the run and command that changed it.
    topics = {row[1] for row in session.execute(text("PRAGMA table_info(chapter_topics)"))}
    if "textbook_ref" not in topics:
        session.execute(text("ALTER TABLE chapter_topics ADD COLUMN textbook_ref VARCHAR"))
    stmts = [
        """CREATE TRIGGER IF NOT EXISTS chapter_topics_history_insert AFTER INSERT ON chapter_topics BEGIN
             INSERT INTO item_events (ts, run_id, command, reason, op, table_name, row_id, course_id, changes_json)
             VALUES (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), (SELECT run_id FROM event_context WHERE id = 1), (SELECT command FROM event_context WHERE id = 1), (SELECT reason FROM event_context WHERE id = 1), 'create', 'chapter_topics', NEW.id, NEW.course_id, json_object('chapter_label', NEW.chapter_label, 'title', NEW.title, 'vocabulary', NEW.vocabulary, 'objectives_json', NEW.objectives_json, 'sections_json', NEW.sections_json, 'reading_url', NEW.reading_url, 'reading_label', NEW.reading_label, 'added_vocabulary', NEW.added_vocabulary, 'added_objectives_json', NEW.added_objectives_json, 'summary', NEW.summary, 'textbook_ref', NEW.textbook_ref));
           END""",
        """CREATE TRIGGER IF NOT EXISTS chapter_topics_history_update AFTER UPDATE ON chapter_topics BEGIN
             INSERT INTO item_events (ts, run_id, command, reason, op, table_name, row_id, course_id, changes_json)
             SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), (SELECT run_id FROM event_context WHERE id = 1), (SELECT command FROM event_context WHERE id = 1), (SELECT reason FROM event_context WHERE id = 1), 'update', 'chapter_topics', NEW.id, NEW.course_id, ch
             FROM (SELECT json_group_object(k, json(v)) AS ch FROM (
          SELECT 'chapter_label' AS k, json_array(OLD.chapter_label, NEW.chapter_label) AS v WHERE OLD.chapter_label IS NOT NEW.chapter_label
          UNION ALL SELECT 'title' AS k, json_array(OLD.title, NEW.title) AS v WHERE OLD.title IS NOT NEW.title
          UNION ALL SELECT 'vocabulary' AS k, json_array(OLD.vocabulary, NEW.vocabulary) AS v WHERE OLD.vocabulary IS NOT NEW.vocabulary
          UNION ALL SELECT 'objectives_json' AS k, json_array(OLD.objectives_json, NEW.objectives_json) AS v WHERE OLD.objectives_json IS NOT NEW.objectives_json
          UNION ALL SELECT 'sections_json' AS k, json_array(OLD.sections_json, NEW.sections_json) AS v WHERE OLD.sections_json IS NOT NEW.sections_json
          UNION ALL SELECT 'reading_url' AS k, json_array(OLD.reading_url, NEW.reading_url) AS v WHERE OLD.reading_url IS NOT NEW.reading_url
          UNION ALL SELECT 'reading_label' AS k, json_array(OLD.reading_label, NEW.reading_label) AS v WHERE OLD.reading_label IS NOT NEW.reading_label
          UNION ALL SELECT 'added_vocabulary' AS k, json_array(OLD.added_vocabulary, NEW.added_vocabulary) AS v WHERE OLD.added_vocabulary IS NOT NEW.added_vocabulary
          UNION ALL SELECT 'added_objectives_json' AS k, json_array(OLD.added_objectives_json, NEW.added_objectives_json) AS v WHERE OLD.added_objectives_json IS NOT NEW.added_objectives_json
          UNION ALL SELECT 'summary' AS k, json_array(OLD.summary, NEW.summary) AS v WHERE OLD.summary IS NOT NEW.summary
          UNION ALL SELECT 'textbook_ref' AS k, json_array(OLD.textbook_ref, NEW.textbook_ref) AS v WHERE OLD.textbook_ref IS NOT NEW.textbook_ref
             )) WHERE ch IS NOT NULL AND ch <> '{}';
           END""",
        """CREATE TRIGGER IF NOT EXISTS chapter_topics_no_delete BEFORE DELETE ON chapter_topics
             BEGIN SELECT RAISE(ABORT, 'Chapter notes are never deleted: correct them with chapter-topic-add.'); END""",
        """CREATE TRIGGER IF NOT EXISTS course_outcomes_history_insert AFTER INSERT ON course_outcomes BEGIN
             INSERT INTO item_events (ts, run_id, command, reason, op, table_name, row_id, course_id, changes_json)
             VALUES (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), (SELECT run_id FROM event_context WHERE id = 1), (SELECT command FROM event_context WHERE id = 1), (SELECT reason FROM event_context WHERE id = 1), 'create', 'course_outcomes', NEW.id, NEW.course_id, json_object('kind', NEW.kind, 'ref', NEW.ref, 'text', NEW.text, 'chapters_json', NEW.chapters_json, 'not_tested', NEW.not_tested, 'source', NEW.source));
           END""",
        """CREATE TRIGGER IF NOT EXISTS course_outcomes_history_update AFTER UPDATE ON course_outcomes BEGIN
             INSERT INTO item_events (ts, run_id, command, reason, op, table_name, row_id, course_id, changes_json)
             SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), (SELECT run_id FROM event_context WHERE id = 1), (SELECT command FROM event_context WHERE id = 1), (SELECT reason FROM event_context WHERE id = 1), 'update', 'course_outcomes', NEW.id, NEW.course_id, ch
             FROM (SELECT json_group_object(k, json(v)) AS ch FROM (
          SELECT 'kind' AS k, json_array(OLD.kind, NEW.kind) AS v WHERE OLD.kind IS NOT NEW.kind
          UNION ALL SELECT 'ref' AS k, json_array(OLD.ref, NEW.ref) AS v WHERE OLD.ref IS NOT NEW.ref
          UNION ALL SELECT 'text' AS k, json_array(OLD.text, NEW.text) AS v WHERE OLD.text IS NOT NEW.text
          UNION ALL SELECT 'chapters_json' AS k, json_array(OLD.chapters_json, NEW.chapters_json) AS v WHERE OLD.chapters_json IS NOT NEW.chapters_json
          UNION ALL SELECT 'not_tested' AS k, json_array(OLD.not_tested, NEW.not_tested) AS v WHERE OLD.not_tested IS NOT NEW.not_tested
          UNION ALL SELECT 'source' AS k, json_array(OLD.source, NEW.source) AS v WHERE OLD.source IS NOT NEW.source
             )) WHERE ch IS NOT NULL AND ch <> '{}';
           END""",
        """CREATE TRIGGER IF NOT EXISTS course_outcomes_no_delete BEFORE DELETE ON course_outcomes
             BEGIN SELECT RAISE(ABORT, 'Syllabus outcomes are never deleted: mark one --not-tested with the reason.'); END""",
        # Study guidelines are a preference: its changes are kept too.
        """CREATE TRIGGER IF NOT EXISTS preferences_history_guidelines AFTER UPDATE ON preferences
             WHEN NEW.key IN ('study_guidelines', 'curriculum_dismissed', 'textbook') AND OLD.value_json IS NOT NEW.value_json BEGIN
             INSERT INTO item_events (ts, run_id, command, reason, op, table_name, row_id, course_id, changes_json)
             VALUES (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), (SELECT run_id FROM event_context WHERE id = 1), (SELECT command FROM event_context WHERE id = 1), (SELECT reason FROM event_context WHERE id = 1), 'update', 'preferences', NEW.key, NEW.course_id, json_array(OLD.value_json, NEW.value_json));
           END""",
        """CREATE TRIGGER IF NOT EXISTS preferences_history_guidelines_insert AFTER INSERT ON preferences
             WHEN NEW.key IN ('study_guidelines', 'curriculum_dismissed', 'textbook') BEGIN
             INSERT INTO item_events (ts, run_id, command, reason, op, table_name, row_id, course_id, changes_json)
             VALUES (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), (SELECT run_id FROM event_context WHERE id = 1), (SELECT command FROM event_context WHERE id = 1), (SELECT reason FROM event_context WHERE id = 1), 'create', 'preferences', NEW.key, NEW.course_id, json_array(NULL, NEW.value_json));
           END""",
        # Where every chapter stands today: the first entry of its history.
        """INSERT INTO item_events (ts, run_id, command, reason, op, table_name, row_id, course_id, changes_json)
             SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'migration', 'db upgrade', 'History starts here: the chapter notes as they were when Kea began keeping their history',
                    'baseline', 'chapter_topics', id, course_id, json_object('chapter_label', chapter_topics.chapter_label, 'title', chapter_topics.title, 'vocabulary', chapter_topics.vocabulary, 'objectives_json', chapter_topics.objectives_json, 'sections_json', chapter_topics.sections_json, 'reading_url', chapter_topics.reading_url, 'reading_label', chapter_topics.reading_label, 'added_vocabulary', chapter_topics.added_vocabulary, 'added_objectives_json', chapter_topics.added_objectives_json, 'summary', chapter_topics.summary, 'textbook_ref', chapter_topics.textbook_ref)
             FROM chapter_topics""",
    ]
    for st in stmts:
        session.execute(text(st))


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
    _0020_add_chapter_summary,
    _0021_add_item_history,
    _0022_add_curriculum,
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
