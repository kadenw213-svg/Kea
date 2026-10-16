from __future__ import annotations

import uuid
from datetime import date, datetime, time

import pytest

from academic_sync.chapter_topics import canonicalize_chapter_label
from academic_sync.models.domain import AcademicItem, ChapterTopic, Course, Source, WeeklyLink
from academic_sync.models.enums import CourseStatus, DiagnosticStatus, ItemStatus, ItemType, SourceType
from academic_sync.reconciliation.fingerprint import compute_calendar_fingerprint
from academic_sync.sync.calendar_payload import (
    DESCRIPTION_CHAR_BUDGET,
    FINGERPRINT_PRIVATE_KEY,
    DetailsBlock,
    DiagnosticAssignment,
    DiagnosticCourseSection,
    LocationInfo,
    _truncate_html_block,
    build_deadline_description,
    build_event_payload,
    build_meeting_description,
    build_title,
    build_weekly_diagnostic_description,
    build_weekly_diagnostic_payload,
    build_weekly_reading_description,
    embed_fingerprint_tag,
    extract_fingerprint_tag,
    format_details_blocks,
    link_kind,
    platform_label_for_source,
)

COURSE = Course(
    id="c1", course_code="BIO 1112", name="General Biology II", term="Fall 2026",
    status=CourseStatus.ACTIVE, instructor="Jane Doe",
)


def _item(**kwargs) -> AcademicItem:
    defaults = dict(
        id=uuid.uuid4().hex, course_id="c1", status=ItemStatus.CLEAR,
        fingerprint="fp-" + uuid.uuid4().hex,
    )
    defaults.update(kwargs)
    return AcademicItem(**defaults)


def test_lecture_title_format():
    item = _item(item_type=ItemType.LECTURE, title="Evolution of Populations", date=date(2026, 9, 3))
    assert build_title(item, COURSE) == "BIO 1112 Lecture — Evolution of Populations"


def test_lecture_title_includes_section_when_present():
    course = COURSE.model_copy(update={"section": "175"})
    item = _item(item_type=ItemType.LECTURE, title="Evolution of Populations", date=date(2026, 9, 3))
    assert build_title(item, course) == "BIO 1112 (Section 175) Lecture — Evolution of Populations"


def test_lab_title_format():
    item = _item(item_type=ItemType.LAB, title="Evidence of Evolution", date=date(2026, 9, 4))
    assert build_title(item, COURSE) == "BIO 1112 Lab — Evidence of Evolution"


def test_midterm_exam_title_no_topic_needed():
    item = _item(item_type=ItemType.EXAM, title="", date=date(2026, 10, 15))
    assert build_title(item, COURSE) == "BIO 1112 Exam"


def test_lab_practical_title():
    item = _item(item_type=ItemType.LAB_PRACTICAL, title="", date=date(2026, 11, 1))
    assert build_title(item, COURSE) == "BIO 1112 Lab Practical"


def test_quiz_deadline_title_has_due_suffix_no_checkbox():
    item = _item(
        item_type=ItemType.QUIZ, title="Online Quiz 1", date=date(2026, 9, 10), due_time=time(23, 59)
    )
    title = build_title(item, COURSE)
    assert title == "BIO 1112 Online Quiz 1 Due"
    assert "[" not in title and "]" not in title and "☐" not in title


def test_reading_deadline_title():
    item = _item(item_type=ItemType.ASSIGNMENT, title="Your Inner Fish Chapter 4", date=date(2026, 9, 12))
    assert build_title(item, COURSE) == "BIO 1112 Your Inner Fish Chapter 4 Due"


def test_administrative_deadline_title_includes_course_code():
    item = _item(item_type=ItemType.ADMINISTRATIVE_DEADLINE, title="Drop", date=date(2026, 9, 1))
    assert build_title(item, COURSE) == "BIO 1112 Drop Deadline"


def test_async_exam_with_due_time_gets_deadline_title_and_shape():
    item = _item(
        item_type=ItemType.EXAM, title="Exam 2 (Chapters 3-4)", date=date(2026, 10, 4),
        due_time=time(23, 59), start_time=None,
    )
    title = build_title(item, COURSE)
    assert title == "BIO 1112 Exam 2 (Chapters 3-4) Due"
    payload = build_event_payload(item, COURSE, timezone="America/Denver", color_id="10")
    assert payload["start"]["dateTime"] == "2026-10-04T23:59:00"
    assert payload["end"]["dateTime"] == "2026-10-05T00:00:00"


def test_in_person_exam_with_start_time_keeps_meeting_title_and_shape():
    item = _item(
        item_type=ItemType.EXAM, title="Cumulative Midterm", date=date(2026, 10, 14),
        start_time=time(10, 0), end_time=time(10, 50),
    )
    title = build_title(item, COURSE)
    assert title == "BIO 1112 Exam — Cumulative Midterm"
    payload = build_event_payload(item, COURSE, timezone="America/Denver", color_id="10")
    assert payload["start"]["dateTime"].endswith("10:00:00")


def test_payload_has_no_guests_no_meet_no_default_reminders():
    item = _item(item_type=ItemType.QUIZ, title="Quiz 1", date=date(2026, 9, 10), due_time=time(23, 59))
    payload = build_event_payload(item, COURSE, timezone="America/Denver", color_id="10")
    assert "attendees" not in payload
    assert "conferenceData" not in payload
    assert payload["reminders"] == {"useDefault": False, "overrides": []}
    assert payload["guestsCanInviteOthers"] is False


def test_payload_carries_fingerprint_for_idempotency():
    item = _item(
        item_type=ItemType.QUIZ, title="Quiz 1", date=date(2026, 9, 10),
        due_time=time(23, 59), fingerprint="abc123",
    )
    payload = build_event_payload(item, COURSE, timezone="America/Denver", color_id="10")
    assert FINGERPRINT_PRIVATE_KEY in payload["extendedProperties"]["private"]


def test_deadline_event_uses_due_time_and_short_duration():
    item = _item(item_type=ItemType.QUIZ, title="Quiz 1", date=date(2026, 9, 10), due_time=time(23, 59))
    payload = build_event_payload(item, COURSE, timezone="America/Denver", color_id="10")
    assert payload["start"]["dateTime"] == "2026-09-10T23:59:00"
    # 1 minute after 23:59 rolls into the next calendar day -- must not wrap
    # back to the same day and end before it starts.
    assert payload["end"]["dateTime"] == "2026-09-11T00:00:00"


def test_reading_never_syncs_as_its_own_event_without_due_time():
    # CLAUDE.md invariant 25: a plain READING item is provenance-only --
    # its content must be folded into a covering lecture's DETAILS or a
    # course's WEEKLY_READING block, never synced as its own event.
    item = _item(
        item_type=ItemType.READING, title="Chapter 22: Descent with Modification",
        date=date(2026, 8, 19),
    )
    with pytest.raises(ValueError, match="never sync"):
        build_event_payload(item, COURSE, timezone="America/Denver", color_id="10")


def test_reading_never_syncs_as_its_own_event_with_due_time():
    item = _item(
        item_type=ItemType.READING, title="Reading Response 1", date=date(2026, 8, 19),
        due_time=time(23, 59),
    )
    with pytest.raises(ValueError, match="never sync"):
        build_event_payload(item, COURSE, timezone="America/Denver", color_id="10")


def test_compact_deadline_description_includes_details():
    item = _item(item_type=ItemType.ASSIGNMENT, title="HW: 1.3", date=date(2026, 8, 20))
    description = build_deadline_description(
        item, COURSE, nesting="Week 1", details="Section 1.3: Linear Equations. Submit via WebAssign.",
        required_resources=None, compact=True,
    )
    assert "Section 1.3: Linear Equations. Submit via WebAssign." in description
    assert "Week 1" in description


def test_compact_deadline_description_omits_details_line_when_absent():
    item = _item(item_type=ItemType.ASSIGNMENT, title="HW: 1.3", date=date(2026, 8, 20))
    description = build_deadline_description(
        item, COURSE, nesting=None, details=None, required_resources=None, compact=True,
    )
    assert description == (
        "BIO 1112 - General Biology II<br><br>"
        "<b>TOPIC</b><br>HW: 1.3<br><br>"
        "<b>CONTACT</b><br>Jane Doe"
    )
    assert "MODULE" not in description
    assert "DETAILS" not in description


def test_deadline_description_has_no_source_section():
    item = _item(item_type=ItemType.ASSIGNMENT, title="HW: 1.3", date=date(2026, 8, 20))
    description = build_deadline_description(
        item, COURSE, nesting=None, details="Some real detail.", required_resources=None, compact=True,
    )
    assert "SOURCE" not in description


def test_compact_meeting_description_format():
    item = _item(item_type=ItemType.LECTURE, title="Evolution", date=date(2026, 9, 3))
    description = build_meeting_description(item, COURSE, location=LocationInfo(room="E112"))
    assert "<b>TOPIC</b><br>Evolution" in description
    assert "E112" in description
    assert "SOURCE" not in description


def test_deadline_description_topic_precedes_module_precedes_links():
    # User-requested structure: repeat the title as TOPIC, then MODULE
    # (nesting), then the rest -- with LINKS always last. Some redundancy
    # with the event summary/title is intentional (a description read on
    # its own should still say what it's for).
    item = _item(
        item_type=ItemType.ASSIGNMENT, title="HW: 1.3", date=date(2026, 8, 20),
        reference_url="https://d2l.example.edu/d2l/le/content/1/View",
    )
    description = build_deadline_description(
        item, COURSE, nesting="Chapter 1: Prerequisite Review Topics (8/17 - 8/30)",
        details=None, required_resources=None,
    )
    topic_pos = description.index("<b>TOPIC</b>")
    module_pos = description.index("<b>MODULE</b>")
    links_pos = description.index("<b>LINKS</b>")
    assert topic_pos < module_pos < links_pos
    assert "HW: 1.3" in description
    assert "Chapter 1: Prerequisite Review Topics (8/17 - 8/30)" in description


def test_meeting_description_shows_module_section_when_nesting_given():
    item = _item(item_type=ItemType.LECTURE, title="Evolution", date=date(2026, 9, 3))
    description = build_meeting_description(
        item, COURSE, location=LocationInfo(room="E112"), nesting="Week 3",
    )
    topic_pos = description.index("<b>TOPIC</b>")
    module_pos = description.index("<b>MODULE</b>")
    assert topic_pos < module_pos
    assert "Week 3" in description


def test_meeting_description_omits_module_section_without_nesting():
    item = _item(item_type=ItemType.LECTURE, title="Evolution", date=date(2026, 9, 3))
    description = build_meeting_description(item, COURSE, location=LocationInfo(room="E112"))
    assert "MODULE" not in description


def test_lecture_weekly_links_render_and_drop_syllabus():
    # A lecture event carries its own multi-link list (slides, handout,
    # activity, textbook) -- same mechanism as a weekly banner. A stray
    # syllabus link is dropped. See CLAUDE.md invariant 25 (amended
    # 2026-09-01).
    item = _item(
        item_type=ItemType.LECTURE, title="Evolution of Populations", date=date(2026, 8, 24),
        start_time=time(10, 0),
        weekly_links=[
            WeeklyLink(label="Lecture Slides — Ch 23 (Part I)", url="https://d2l.example/slides23"),
            WeeklyLink(label="Handout: Hardy-Weinberg Practice", url="https://d2l.example/hw"),
            WeeklyLink(label="Lecture Schedule (Syllabus)", url="https://d2l.example/syllabus"),
            WeeklyLink(label="Textbook — Ch 23", url="https://d2l.example/tb23"),
        ],
    )
    description = build_meeting_description(item, COURSE, location=LocationInfo(room="E112"))
    links_block = description.split("<b>LINKS</b><br>")[1].split("<br><br>")[0]
    assert links_block == (
        '<a href="https://d2l.example/slides23">Lecture Slides — Ch 23 (Part I)</a><br>'
        '<a href="https://d2l.example/hw">Handout: Hardy-Weinberg Practice</a><br>'
        '<a href="https://d2l.example/tb23">Textbook — Ch 23</a>'
    )
    assert "syllabus" not in description.lower()


def test_lecture_syllabus_reference_url_dropped_on_render():
    item = _item(
        item_type=ItemType.LECTURE, title="Descent with Modification", date=date(2026, 8, 17),
        start_time=time(10, 0),
        reference_url="https://d2l.example/content/lecture-schedule",
        reference_url_label="Syllabus - Lecture Schedule",
    )
    description = build_meeting_description(item, COURSE, location=LocationInfo(room="E112"))
    assert "<b>LINKS</b>" not in description
    assert "syllabus" not in description.lower()


def test_meeting_description_never_shows_numeric_points():
    # Superseded 2026-08-25: numeric POINTS was dropped in favor of a
    # simple UNGRADED tag -- a graded item (points known or not) gets no
    # special section at all, "leave it simple" per the user's direction.
    item = _item(
        item_type=ItemType.EXAM, title="Cumulative Midterm", date=date(2026, 10, 14),
        start_time=time(17, 30), end_time=time(19, 20), points=200,
    )
    description = build_meeting_description(item, COURSE, location=LocationInfo(room="E112"))
    assert "POINTS" not in description
    assert "UNGRADED" not in description


def test_deadline_description_never_shows_numeric_points():
    item = _item(item_type=ItemType.ASSIGNMENT, title="HW: 1.3", date=date(2026, 8, 20), points=25)
    description = build_deadline_description(
        item, COURSE, nesting=None, details=None, required_resources=None, compact=True,
    )
    assert "POINTS" not in description
    assert "25 pts" not in description


def test_optional_item_gets_title_suffix_and_top_of_description_ungraded_tag():
    item = _item(
        item_type=ItemType.ASSIGNMENT, title="Extra Practice Set", date=date(2026, 8, 20),
        is_optional=True,
    )
    assert build_title(item, COURSE) == "BIO 1112 Extra Practice Set Due (Optional)"
    description = build_deadline_description(
        item, COURSE, nesting=None, details=None, required_resources=None, compact=True,
    )
    # The tag is the very first thing -- before even the course header.
    assert description.startswith("<b>UNGRADED</b><br><br>BIO 1112 - General Biology II")
    assert "STATUS" not in description
    assert "POINTS" not in description


def test_optional_item_with_points_still_gets_ungraded_tag_not_numeric_points():
    item = _item(
        item_type=ItemType.ASSIGNMENT, title="Bonus Quiz", date=date(2026, 8, 20),
        points=5, is_optional=True,
    )
    description = build_deadline_description(
        item, COURSE, nesting=None, details=None, required_resources=None, compact=True,
    )
    assert description.startswith("<b>UNGRADED</b>")
    assert "POINTS" not in description
    assert "5 pts" not in description


def test_meeting_description_optional_item_also_gets_top_ungraded_tag():
    item = _item(
        item_type=ItemType.LAB_PRACTICAL, title="Optional Practice Practical",
        date=date(2026, 10, 14), start_time=time(17, 30), is_optional=True,
    )
    description = build_meeting_description(item, COURSE, location=None)
    assert description.startswith("<b>UNGRADED</b><br><br>BIO 1112 - General Biology II")


def test_no_points_or_optional_means_no_tag_at_all():
    item = _item(item_type=ItemType.ASSIGNMENT, title="HW: 1.3", date=date(2026, 8, 20))
    description = build_deadline_description(
        item, COURSE, nesting=None, details=None, required_resources=None, compact=True,
    )
    assert "POINTS" not in description
    assert "STATUS" not in description
    assert "UNGRADED" not in description
    assert not description.startswith("<b>")


def test_inferred_date_item_gets_top_of_description_tag():
    # User-authorized 2026-08-25 exception to "never fabricate a date" --
    # CLAUDE.md invariant 29. Same top-of-description slot as UNGRADED,
    # independently conditional.
    item = _item(
        item_type=ItemType.ASSIGNMENT, title="HW: 4.1", date=date(2026, 10, 7),
        is_inferred_date=True, date_inference_rule="every HW is due 3 days after the prior one",
    )
    description = build_deadline_description(
        item, COURSE, nesting=None, details=None, required_resources=None, compact=True,
    )
    assert description.startswith("<i>(Inferred Date)</i><br><br>BIO 1112 - General Biology II")
    # The rule text is for local audit only -- never rendered.
    assert "every HW is due 3 days" not in description


def test_meeting_description_inferred_date_item_also_gets_top_tag():
    item = _item(
        item_type=ItemType.LECTURE, title="Evolution", date=date(2026, 9, 3),
        start_time=time(17, 30), is_inferred_date=True, date_inference_rule="weekly cadence",
    )
    description = build_meeting_description(item, COURSE, location=None)
    assert description.startswith("<i>(Inferred Date)</i><br><br>BIO 1112 - General Biology II")


def test_optional_and_inferred_date_tags_can_both_appear_ungraded_first():
    item = _item(
        item_type=ItemType.ASSIGNMENT, title="Extra Practice Set", date=date(2026, 8, 20),
        is_optional=True, is_inferred_date=True, date_inference_rule="weekly cadence",
    )
    description = build_deadline_description(
        item, COURSE, nesting=None, details=None, required_resources=None, compact=True,
    )
    assert description.startswith("<b>UNGRADED</b><br><br><i>(Inferred Date)</i><br><br>BIO 1112")


def test_no_inferred_date_flag_means_no_tag():
    item = _item(item_type=ItemType.ASSIGNMENT, title="HW: 1.3", date=date(2026, 8, 20))
    description = build_deadline_description(
        item, COURSE, nesting=None, details=None, required_resources=None, compact=True,
    )
    assert "Inferred Date" not in description


def test_reference_and_resource_urls_render_as_labeled_links():
    item = _item(
        item_type=ItemType.ASSIGNMENT, title="Chapter 6 Reading", date=date(2026, 9, 3),
        reference_url="https://d2l.example.edu/d2l/le/content/665290/viewContent/1/View",
        reference_url_label="Assignment",
        resource_url="https://openstax.org/books/biology-2e/pages/6-1",
        resource_url_label="Textbook (Ch. 6)",
    )
    description = build_deadline_description(
        item, COURSE, nesting=None, details=None, required_resources=None, compact=True,
    )
    assert (
        '<a href="https://d2l.example.edu/d2l/le/content/665290/viewContent/1/View">Assignment</a>'
        in description
    )
    assert '<a href="https://openstax.org/books/biology-2e/pages/6-1">Textbook (Ch. 6)</a>' in description


def test_reference_url_falls_back_to_default_label():
    item = _item(
        item_type=ItemType.ASSIGNMENT, title="Chapter 6 Reading", date=date(2026, 9, 3),
        reference_url="https://d2l.example.edu/d2l/le/content/665290/viewContent/1/View",
    )
    description = build_deadline_description(
        item, COURSE, nesting=None, details=None, required_resources=None, compact=True,
    )
    assert (
        '<a href="https://d2l.example.edu/d2l/le/content/665290/viewContent/1/View">D2L</a>'
        in description
    )


def test_no_reference_url_means_no_link_lines():
    item = _item(item_type=ItemType.ASSIGNMENT, title="Chapter 6 Reading", date=date(2026, 9, 3))
    description = build_deadline_description(
        item, COURSE, nesting=None, details=None, required_resources=None, compact=True,
    )
    assert "<a href" not in description


def test_link_available_date_shown_when_no_url_yet():
    item = _item(
        item_type=ItemType.ASSIGNMENT, title="Lab Kit Authentication", date=date(2026, 9, 12),
        link_available_date=date(2026, 9, 7),
    )
    description = build_deadline_description(
        item, COURSE, nesting=None, details=None, required_resources=None, compact=True,
    )
    assert "<b>LINKS</b>" in description
    assert "2026-09-07" in description
    assert "<a href" not in description


def test_real_url_takes_priority_over_link_available_date():
    item = _item(
        item_type=ItemType.ASSIGNMENT, title="Lab Kit Authentication", date=date(2026, 9, 12),
        link_available_date=date(2026, 9, 7),
        reference_url="https://d2l.example.edu/d2l/le/content/1/View", reference_url_label="Assignment",
    )
    description = build_deadline_description(
        item, COURSE, nesting=None, details=None, required_resources=None, compact=True,
    )
    assert "2026-09-07" not in description
    assert '<a href="https://d2l.example.edu/d2l/le/content/1/View">Assignment</a>' in description


def test_routine_meeting_without_start_time_is_all_day():
    item = _item(item_type=ItemType.LAB, title="Prokaryotes", date=date(2026, 9, 14))
    title = build_title(item, COURSE)
    assert title == "BIO 1112 Lab — Prokaryotes"
    payload = build_event_payload(item, COURSE, timezone="America/Denver", color_id="10")
    assert "date" in payload["start"]
    assert "dateTime" not in payload["start"]


def test_routine_meeting_with_start_time_is_still_timed():
    item = _item(
        item_type=ItemType.LAB, title="Prokaryotes", date=date(2026, 9, 14),
        start_time=time(9, 0), end_time=time(10, 50),
    )
    payload = build_event_payload(item, COURSE, timezone="America/Denver", color_id="10")
    assert "dateTime" in payload["start"]


def test_break_is_all_day_event():
    item = _item(item_type=ItemType.BREAK, title="Thanksgiving Break", date=date(2026, 11, 26))
    payload = build_event_payload(item, COURSE, timezone="America/Denver", color_id="10")
    assert "date" in payload["start"]
    assert "dateTime" not in payload["start"]


def test_meeting_uses_start_and_end_time():
    item = _item(
        item_type=ItemType.LECTURE, title="Genetics", date=date(2026, 9, 3),
        start_time=time(10, 0), end_time=time(10, 50),
    )
    payload = build_event_payload(item, COURSE, timezone="America/Denver", color_id="10")
    assert payload["start"]["dateTime"].endswith("10:00:00")
    assert payload["end"]["dateTime"].endswith("10:50:00")


def test_location_string_uses_venue_when_no_street_address():
    loc = LocationInfo(campus="Centennial Hall", room="204")
    assert loc.google_location_string() == "Centennial Hall, 204"


def test_location_string_none_when_nothing_known():
    loc = LocationInfo()
    assert loc.google_location_string() is None


def test_description_carries_fingerprint_tag_for_calendars_without_extended_properties():
    # The live Google Calendar connector this project actually uses has no
    # extendedProperties field -- the description-embedded tag is the real
    # Calendar-side idempotency signal available to the import skill.
    item = _item(
        item_type=ItemType.QUIZ, title="Quiz 1", date=date(2026, 9, 10),
        due_time=time(23, 59), fingerprint="abc123",
    )
    payload = build_event_payload(
        item, COURSE, timezone="America/Denver", color_id="10", description="Some details."
    )
    tag = extract_fingerprint_tag(payload["description"])
    assert tag is not None
    assert "Some details." in payload["description"]


def test_embed_and_extract_fingerprint_tag_roundtrip():
    tagged = embed_fingerprint_tag("Original text.", "fp-xyz")
    assert extract_fingerprint_tag(tagged) == compute_calendar_fingerprint("fp-xyz")
    assert "Original text." in tagged


def test_fingerprint_tag_is_wrapped_in_small_for_visual_de_emphasis():
    # <small> is preserved by Calendar's HTML sanitizer (confirmed by a
    # real create_event + rendered-popup check, see the comment above
    # FINGERPRINT_TAG_PREFIX) while staying fullText-searchable, unlike an
    # HTML comment (invisible but unsearchable) or inline style (stripped).
    tagged = embed_fingerprint_tag("Original text.", "fp-xyz")
    assert "<small>[academic-sync:fp:" in tagged
    assert tagged.endswith("</small>")
    assert extract_fingerprint_tag(tagged) == compute_calendar_fingerprint("fp-xyz")


def test_embed_fingerprint_tag_noop_without_fingerprint():
    assert embed_fingerprint_tag("Original text.", None) == "Original text."
    assert embed_fingerprint_tag("Original text.", "") == "Original text."


def test_color_id_applied():
    item = _item(item_type=ItemType.QUIZ, title="Quiz 1", date=date(2026, 9, 10), due_time=time(23, 59))
    payload = build_event_payload(item, COURSE, timezone="America/Denver", color_id="10")
    assert payload["colorId"] == "10"


# -- platform_label_for_source / MODULE line ---------------------------------


def _source(**kwargs) -> Source:
    defaults = dict(
        id=uuid.uuid4().hex, course_id="c1", title="D2L Content", content_hash="h",
        parser_version="1", retrieved_at=datetime(2026, 8, 1),
    )
    defaults.update(kwargs)
    return Source(**defaults)


def test_platform_label_is_d2l_for_any_d2l_source_type():
    src = _source(source_type=SourceType.D2L_DROPBOX, title="Dropbox")
    assert platform_label_for_source(src) == "D2L"


def test_platform_label_is_the_tool_name_for_external_courseware():
    # Deliberately not a known-name check -- ANY title works, since discovery
    # finds these live by following a shell link off the LMS's own domain,
    # not by matching a hardcoded platform list (see CLAUDE.md).
    src = _source(source_type=SourceType.EXTERNAL_COURSEWARE, title="ALEKS")
    assert platform_label_for_source(src) == "ALEKS"

    src2 = _source(source_type=SourceType.EXTERNAL_COURSEWARE, title="Some Brand New Tool")
    assert platform_label_for_source(src2) == "Some Brand New Tool"


def test_platform_label_none_for_unresolvable_source_types():
    assert platform_label_for_source(_source(source_type=SourceType.LINKED_PDF)) is None
    assert platform_label_for_source(_source(source_type=SourceType.SYLLABUS)) is None
    assert platform_label_for_source(None) is None


def test_module_line_names_platform_when_known():
    item = _item(
        item_type=ItemType.ASSIGNMENT, title="HW 3.2", date=date(2026, 9, 10), due_time=time(23, 59),
    )
    description = build_deadline_description(
        item, COURSE, nesting="Chapter 3: Polynomial and Rational Functions",
        details=None, required_resources=None, platform_label="ALEKS",
    )
    assert "<b>MODULE</b><br>ALEKS — Chapter 3: Polynomial and Rational Functions" in description


def test_module_line_omits_platform_prefix_when_unknown():
    item = _item(item_type=ItemType.ASSIGNMENT, title="HW 3.2", date=date(2026, 9, 10), due_time=time(23, 59))
    description = build_deadline_description(
        item, COURSE, nesting="Chapter 3", details=None, required_resources=None,
    )
    assert "<b>MODULE</b><br>Chapter 3" in description
    assert "—" not in description


def test_module_section_omitted_when_no_nesting_even_with_known_platform():
    # A bare "D2L" with nothing after it would be filler (CLAUDE.md: never
    # pad a missing field) -- MODULE stays gated on real nesting text.
    item = _item(item_type=ItemType.ASSIGNMENT, title="HW 3.2", date=date(2026, 9, 10), due_time=time(23, 59))
    description = build_deadline_description(
        item, COURSE, nesting=None, details=None, required_resources=None, platform_label="D2L",
    )
    assert "MODULE" not in description


# -- location restricted to physical meetings --------------------------------


def test_deadline_item_never_gets_native_location_even_if_passed():
    # A real production run set platform_location="Online" on dozens of
    # deadline items across multiple courses -- meaningless (every deadline
    # in an online course is trivially "online") and it displaced the
    # actually useful MODULE/DETAILS info. The native Calendar `location`
    # field is reserved for a real physical meeting from here on.
    item = _item(
        item_type=ItemType.QUIZ, title="Quiz 1", date=date(2026, 9, 10), due_time=time(23, 59),
    )
    payload = build_event_payload(
        item, COURSE, timezone="America/Denver", color_id="10",
        location=LocationInfo(platform_location="Online"),
    )
    assert "location" not in payload


def test_async_exam_with_due_time_never_gets_native_location():
    # is_fixed_time_meeting is True for EXAM, but a due_time means this is an
    # async window, not a room -- same guard applies.
    item = _item(
        item_type=ItemType.EXAM, title="Exam 1", date=date(2026, 9, 10), due_time=time(23, 59),
    )
    payload = build_event_payload(
        item, COURSE, timezone="America/Denver", color_id="10",
        location=LocationInfo(platform_location="Online"),
    )
    assert "location" not in payload


def test_multi_chapter_meeting_gets_spaced_topic_blocks():
    item = _item(
        item_type=ItemType.LECTURE,
        title="Chapter 22: Descent with Modification, cont.; Chapter 26: Phylogeny and Classification",
        date=date(2026, 8, 19), start_time=time(17, 30),
    )
    description = build_meeting_description(item, COURSE, location=None)
    assert (
        "<b>TOPIC</b><br>Chapter 22:<br>Descent with Modification, cont.;<br><br>"
        "Chapter 26:<br>Phylogeny and Classification;" in description
    )


def test_mixed_admin_and_chapter_topic_still_splits():
    item = _item(
        item_type=ItemType.LECTURE,
        title="Syllabus and Orientation; Chapter 22: Descent with Modification",
        date=date(2026, 8, 17), start_time=time(17, 30),
    )
    description = build_meeting_description(item, COURSE, location=None)
    assert (
        "<b>TOPIC</b><br>Syllabus and Orientation;<br><br>"
        "Chapter 22:<br>Descent with Modification;" in description
    )


def test_single_topic_lecture_topic_line_is_unchanged():
    item = _item(
        item_type=ItemType.LECTURE, title="Evidence of Evolution",
        date=date(2026, 9, 4), start_time=time(17, 30),
    )
    description = build_meeting_description(item, COURSE, location=None)
    assert "<b>TOPIC</b><br>Evidence of Evolution<br>" in description


def test_bare_chapter_labels_with_no_topic_text_split_without_trailing_colon():
    # CHE1011's real chapters are only ever "Chapter 1"/"Chapter 2" -- no
    # colon+topic. _topic_line must not render "Chapter 1:<br>;" (empty
    # topic after the colon) -- see chapter_topics.split_chapter_segments,
    # which _topic_line is now built on.
    item = _item(
        item_type=ItemType.LECTURE, title="Chapter 1; Chapter 2",
        date=date(2026, 8, 24), start_time=time(17, 30),
    )
    description = build_meeting_description(item, COURSE, location=None)
    assert "<b>TOPIC</b><br>Chapter 1;<br><br>Chapter 2;" in description
    assert "<br>;" not in description


def test_physical_meeting_still_gets_native_location():
    item = _item(
        item_type=ItemType.LECTURE, title="Genetics", date=date(2026, 9, 3), start_time=time(10, 0),
    )
    payload = build_event_payload(
        item, COURSE, timezone="America/Denver", color_id="10",
        location=LocationInfo(room="E112"),
    )
    assert payload["location"] == "E112"


def test_weekly_reading_title_is_just_weekly_overview():
    # User-directed, 2026-08-25: no date range in the title -- it moved to
    # the description's DATES section instead (see the description tests
    # below).
    item = _item(
        item_type=ItemType.WEEKLY_READING, title="Chapter 5: Cell Division",
        date=date(2026, 9, 7), date_range_end=date(2026, 9, 13),
    )
    assert build_title(item, COURSE) == "BIO 1112 Weekly Overview"


def test_weekly_reading_payload_is_multi_day_all_day():
    item = _item(
        item_type=ItemType.WEEKLY_READING, title="Chapter 5: Cell Division",
        date=date(2026, 9, 7), date_range_end=date(2026, 9, 13),
    )
    payload = build_event_payload(item, COURSE, timezone="America/Denver", color_id="10")
    assert payload["start"] == {"date": "2026-09-07"}
    # Exclusive end date -- the last real day (13th) plus one.
    assert payload["end"] == {"date": "2026-09-14"}


def test_weekly_reading_without_date_range_end_never_ready_to_sync():
    item = _item(
        item_type=ItemType.WEEKLY_READING, title="Chapter 5: Cell Division",
        date=date(2026, 9, 7),
    )
    assert item.is_ready_to_sync() is False


def _topic(label: str, **kwargs) -> ChapterTopic:
    defaults = dict(id=uuid.uuid4().hex, course_id="c1", chapter_label=label)
    defaults.update(kwargs)
    return ChapterTopic(**defaults)


def _topics(*topics: ChapterTopic) -> dict[str, ChapterTopic]:
    return {canonicalize_chapter_label(t.chapter_label): t for t in topics}


def test_weekly_reading_lists_every_chapter_under_reading_with_legacy_links_as_resources():
    item = _item(
        item_type=ItemType.WEEKLY_READING,
        title="Chapter 12: Cellular Respiration; Chapter 13: Photosynthesis",
        date=date(2026, 10, 5), date_range_end=date(2026, 10, 11),
        reference_url="https://d2l.example/content/module9", reference_url_label="D2L (Module 9)",
        resource_url="https://textbook.example/ch12", resource_url_label="Textbook",
    )
    description = build_weekly_reading_description(item, COURSE)
    assert (
        "<b>READING</b><br><b>Chapter 12 — Cellular Respiration</b><br><br>"
        "<b>Chapter 13 — Photosynthesis</b>" in description
    )
    assert "THIS WEEK" not in description
    assert "PACING" not in description
    assert "TOPIC DETAIL" not in description  # nothing captured -> no empty section
    resources = description.split("<b>SLIDES &amp; RESOURCES</b><br>")[1].split("<br><br>")[0]
    assert resources == (
        '<a href="https://d2l.example/content/module9">D2L (Module 9)</a><br>'
        '<a href="https://textbook.example/ch12">Textbook</a>'
    )
    assert "<b>CONTACT</b><br>Jane Doe" in description


def test_reading_section_is_header_then_chapter_reading_link_only():
    # Links only (2026-10-16): no "Big topics" line, no TOPIC DETAIL --
    # study depth lives in the weekly study PDF.
    item = _item(
        item_type=ItemType.WEEKLY_READING, title="Chapter 23: Evolution of Populations",
        date=date(2026, 8, 24), date_range_end=date(2026, 8, 30),
    )
    topics = _topics(_topic(
        "Chapter 23",
        sections=["23.1 Genetic Variation", "23.2 Hardy-Weinberg"],
        objectives=["Explain drift"], vocabulary="allele",
        reading_url="https://ebook.example/ch23", reading_label="Textbook — Ch 23 reading",
    ))
    description = build_weekly_reading_description(item, COURSE, chapter_topics=topics)
    reading = description.split("<b>READING</b><br>")[1].split("<br><br><b>")[0]
    assert reading == (
        "<b>Chapter 23 — Evolution of Populations</b><br>"
        '→ <a href="https://ebook.example/ch23">Textbook — Ch 23 reading</a>'
    )
    assert "Big topics" not in description
    assert "TOPIC DETAIL" not in description
    assert "Explain drift" not in description
    assert "allele" not in description


def test_banner_section_order_is_reading_resources_contact_dates():
    item = _item(
        item_type=ItemType.WEEKLY_READING, title="Chapter 23: Evolution of Populations",
        date=date(2026, 8, 24), date_range_end=date(2026, 8, 30),
        weekly_links=[WeeklyLink(label="Slides - Ch 23", url="https://slides.example/23")],
    )
    topics = _topics(_topic("Chapter 23", objectives=["Explain drift"], vocabulary="allele"))
    description = build_weekly_reading_description(item, COURSE, chapter_topics=topics)
    order = [
        description.index("<b>READING</b>"),
        description.index("<b>SLIDES &amp; RESOURCES</b>"),
        description.index("<b>CONTACT</b>"),
        description.index("<b>DATES</b>"),
    ]
    assert order == sorted(order)


def test_bare_chapter_label_uses_saved_title():
    # CHE1011-style bare "Chapter 1" banner title -- the saved topic's own
    # title fills in the header.
    item = _item(
        item_type=ItemType.WEEKLY_READING, title="Chapter 1",
        date=date(2026, 8, 17), date_range_end=date(2026, 8, 23),
    )
    topics = _topics(_topic("Chapter 1", title="Matter and Measurement", objectives=["X"]))
    description = build_weekly_reading_description(item, COURSE, chapter_topics=topics)
    assert "<b>Chapter 1 — Matter and Measurement</b>" in description


def test_textbook_links_go_under_their_chapter_and_other_kinds_group_in_resources():
    item = _item(
        item_type=ItemType.WEEKLY_READING,
        title="Chapter 23: Evolution of Populations; Chapter 24: Origin of Species",
        date=date(2026, 8, 24), date_range_end=date(2026, 8, 30),
        weekly_links=[
            WeeklyLink(label="Textbook - Ch 24", url="https://tb.example/24", kind="textbook",
                       chapter="Chapter 24"),
            WeeklyLink(label="Hardy-Weinberg worksheet", url="https://d2l.example/hw", kind="handout"),
            WeeklyLink(label="Lecture video - Ch 23", url="https://video.example/23"),
            WeeklyLink(label="Slides - Ch 23", url="https://slides.example/23"),
            WeeklyLink(label="McGraw Hill Connect (eBook)", url="https://connect.example",
                       kind="textbook"),
        ],
    )
    description = build_weekly_reading_description(item, COURSE)
    reading = description.split("<b>READING</b><br>")[1].split("<br><br><b>SLIDES")[0]
    assert reading == (
        "<b>Chapter 23 — Evolution of Populations</b><br><br>"
        "<b>Chapter 24 — Origin of Species</b><br>"
        '→ <a href="https://tb.example/24">Textbook - Ch 24</a><br><br>'
        '→ <a href="https://connect.example">McGraw Hill Connect (eBook)</a>'
    )
    resources = description.split("<b>SLIDES &amp; RESOURCES</b><br>")[1].split("<br><br>")[0]
    assert resources == (
        '<a href="https://slides.example/23">Slides - Ch 23</a><br>'
        '<a href="https://video.example/23">Lecture video - Ch 23</a><br>'
        '<a href="https://d2l.example/hw">Hardy-Weinberg worksheet</a>'
    )


def test_unkinded_legacy_textbook_link_is_classified_into_reading():
    item = _item(
        item_type=ItemType.WEEKLY_READING, title="Chapter 23: Evolution of Populations",
        date=date(2026, 8, 24), date_range_end=date(2026, 8, 30),
        weekly_links=[WeeklyLink(label="Textbook - Ch 23", url="https://textbook.example/ch23")],
    )
    description = build_weekly_reading_description(item, COURSE)
    assert '→ <a href="https://textbook.example/ch23">Textbook - Ch 23</a>' in description
    assert "SLIDES &amp; RESOURCES" not in description


def test_link_kind_explicit_wins_over_label():
    assert link_kind(WeeklyLink(label="Slides", url="u", kind="other")) == "other"
    assert link_kind(WeeklyLink(label="Power Point Slides", url="u")) == "slides"
    assert link_kind(WeeklyLink(label="Guided Reading Ch 3", url="u")) == "textbook"
    assert link_kind(WeeklyLink(label="ALEKS", url="u")) == "other"


def test_weekly_links_take_precedence_over_reference_and_resource_url():
    item = _item(
        item_type=ItemType.WEEKLY_READING, title="Chapter 23: Evolution of Populations",
        date=date(2026, 8, 24), date_range_end=date(2026, 8, 30),
        reference_url="https://d2l.example/old", reference_url_label="D2L (old)",
        resource_url="https://textbook.example/old", resource_url_label="Textbook (old)",
        weekly_links=[WeeklyLink(label="Lecture video", url="https://video.example/w2")],
    )
    description = build_weekly_reading_description(item, COURSE)
    assert '<a href="https://video.example/w2">Lecture video</a>' in description
    assert "d2l.example/old" not in description
    assert "textbook.example/old" not in description


def test_weekly_links_syllabus_entry_is_dropped():
    item = _item(
        item_type=ItemType.WEEKLY_READING, title="Chapter 23: Evolution of Populations",
        date=date(2026, 8, 24), date_range_end=date(2026, 8, 30),
        weekly_links=[
            WeeklyLink(label="Course Syllabus", url="https://d2l.example/syllabus"),
            WeeklyLink(label="Textbook - Ch 23", url="https://textbook.example/ch23"),
        ],
    )
    description = build_weekly_reading_description(item, COURSE)
    assert "syllabus" not in description.lower()
    assert '<a href="https://textbook.example/ch23">Textbook - Ch 23</a>' in description


def test_weekly_banner_syllabus_reference_url_dropped_on_render():
    # An older banner synced with a syllabus link in reference_url gets it
    # stripped at render time so a re-render cleans it up.
    item = _item(
        item_type=ItemType.WEEKLY_READING, title="Chapter 5: Cell Division",
        date=date(2026, 9, 7), date_range_end=date(2026, 9, 13),
        reference_url="https://d2l.example/content/syllabus", reference_url_label="Syllabus",
    )
    description = build_weekly_reading_description(item, COURSE)
    assert "SLIDES &amp; RESOURCES" not in description
    assert "syllabus" not in description.lower()


def test_weekly_reading_description_dates_section_is_last():
    item = _item(
        item_type=ItemType.WEEKLY_READING, title="Chapter 5: Cell Division",
        date=date(2026, 9, 7), date_range_end=date(2026, 9, 13),
        reference_url="https://d2l.example/content/module9", reference_url_label="D2L (Module 9)",
    )
    description = build_weekly_reading_description(item, COURSE)
    assert description.endswith("<b>DATES</b><br>Sep 7 - 13")
    assert description.index("<b>CONTACT</b>") < description.index("<b>DATES</b>")


def test_weekly_reading_description_dates_section_omitted_without_date_range_end():
    item = _item(
        item_type=ItemType.WEEKLY_READING, title="Chapter 5: Cell Division",
        date=date(2026, 9, 7),
    )
    description = build_weekly_reading_description(item, COURSE)
    assert "DATES" not in description


def test_weekly_reading_description_never_has_pacing_section():
    item = _item(
        item_type=ItemType.WEEKLY_READING, title="Chapter 2: Cell Structure",
        date=date(2026, 9, 14), date_range_end=date(2026, 9, 20),
    )
    description = build_weekly_reading_description(
        item, COURSE, pacing="Ch. 2 by Wednesday, quiz covers through Ch. 2 by Friday",
    )
    assert "PACING" not in description and "by Wednesday" not in description


def test_format_details_blocks_text_block_with_label():
    blocks = [DetailsBlock(label="Vocabulary", text="microevolution, genetic drift")]
    assert format_details_blocks(blocks) == "<b>Vocabulary:</b> microevolution, genetic drift"


def test_format_details_blocks_items_block_with_label():
    blocks = [DetailsBlock(label="Objectives", items=["Explain X", "Distinguish Y"])]
    assert format_details_blocks(blocks) == (
        "<b>Objectives:</b><br>• Explain X<br>• Distinguish Y"
    )


def test_truncate_html_block_no_op_under_budget():
    html = "<b>Chapter 1:</b><br>• A<br>• B"
    assert _truncate_html_block(html, 1000) == html


def test_truncate_html_block_cuts_at_segment_boundary_with_note():
    html = "<b>Chapter 1:</b><br>" + "<br>".join(f"• topic {i}" for i in range(200))
    truncated = _truncate_html_block(html, 200)
    assert len(truncated) < len(html)
    # Never cuts mid-segment -- every "<br>"-delimited piece before the
    # note is either a complete original segment or the note itself.
    assert "more captured line(s) not shown here for length" in truncated
    assert "full list saved locally" in truncated
    # A segment is either fully present or fully absent, never chopped mid-word.
    for seg in truncated.split("<br>")[:-1]:
        assert seg == "<b>Chapter 1:</b>" or seg.startswith("• topic ")


def test_truncate_html_block_zero_budget_still_notes_all_lines():
    html = "<br>".join(f"• topic {i}" for i in range(5))
    truncated = _truncate_html_block(html, 0)
    assert "+5 more captured line(s)" in truncated


def test_weekly_reading_description_stays_under_budget_with_exhaustive_topic_list():
    # An exhaustively-captured chapter (CLAUDE.md invariant 26) can have
    # hundreds of objective lines -- none of them reach the banner anymore
    # (links only, 2026-10-16), so it stays small and every section survives.
    item = _item(
        item_type=ItemType.WEEKLY_READING, title="Chapter 23: Evolution of Populations",
        date=date(2026, 9, 7), date_range_end=date(2026, 9, 13),
        reference_url="https://d2l.example/content/module9", reference_url_label="D2L (Module 9)",
    )
    topics = _topics(_topic(
        "Chapter 23",
        sections=["23.1 Genetic Variation", "23.2 Hardy-Weinberg"],
        reading_url="https://ebook.example/ch23", reading_label="Textbook — Ch 23",
        objectives=[f"Real objective number {i} about population genetics" for i in range(300)],
    ))
    description = build_weekly_reading_description(item, COURSE, chapter_topics=topics)
    assert len(description) <= DESCRIPTION_CHAR_BUDGET
    assert "Big topics" not in description
    assert '<a href="https://ebook.example/ch23">Textbook — Ch 23</a>' in description
    assert "<b>CONTACT</b><br>Jane Doe" in description
    assert '<a href="https://d2l.example/content/module9">D2L (Module 9)</a>' in description
    assert description.endswith("<b>DATES</b><br>Sep 7 - 13")
    assert "Real objective number" not in description

    # The fingerprint tag build_event_payload appends afterward must still
    # fit -- confirm the full payload path also stays under budget.
    payload = build_event_payload(item, COURSE, timezone="America/Denver", color_id="10",
                                   description=description)
    assert len(payload["description"]) <= DESCRIPTION_CHAR_BUDGET
    assert "[academic-sync:fp:" in payload["description"]


def test_synthetic_course_weekly_reading_gets_top_of_description_tag():
    # CLAUDE.md invariant 35 -- a course flagged Course.is_synthetic
    # (custom-curriculum skill) must render a visible SYNTHESIZED
    # CURRICULUM tag so its events are never mistaken for real instructor
    # material at a glance. Same top-of-description slot as UNGRADED/
    # (Inferred Date), before even the course header.
    synthetic_course = COURSE.model_copy(
        update={"is_synthetic": True, "instructor": None, "instructor_contact": None}
    )
    item = _item(
        item_type=ItemType.WEEKLY_READING, title="Chapter 1: Vectors and Vector Spaces",
        date=date(2026, 9, 7), date_range_end=date(2026, 9, 13),
    )
    description = build_weekly_reading_description(item, synthetic_course)
    assert description.startswith("<b>SYNTHESIZED CURRICULUM</b><br><br>BIO 1112")
    assert "<b>CONTACT</b>" not in description


def test_non_synthetic_course_weekly_reading_gets_no_synthesized_tag():
    item = _item(
        item_type=ItemType.WEEKLY_READING, title="Chapter 5: Cell Division",
        date=date(2026, 9, 7), date_range_end=date(2026, 9, 13),
    )
    description = build_weekly_reading_description(item, COURSE)
    assert "SYNTHESIZED CURRICULUM" not in description


def test_synthetic_and_inferred_date_tags_can_both_appear_synthesized_first():
    synthetic_course = COURSE.model_copy(
        update={"is_synthetic": True, "instructor": None, "instructor_contact": None}
    )
    item = _item(
        item_type=ItemType.WEEKLY_READING, title="Chapter 1: Vectors and Vector Spaces",
        date=date(2026, 9, 7), date_range_end=date(2026, 9, 13),
        is_inferred_date=True, date_inference_rule="weekly cadence from the approved outline",
    )
    description = build_weekly_reading_description(item, synthetic_course)
    assert description.startswith(
        "<b>SYNTHESIZED CURRICULUM</b><br><br><i>(Inferred Date)</i><br><br>BIO 1112"
    )


def test_deadline_description_details_truncated_leaves_other_sections_intact():
    huge_details = "<br>".join(f"Instruction line {i} with real submission detail" for i in range(400))
    item = _item(
        item_type=ItemType.ASSIGNMENT, title="Lab Report 3", date=date(2026, 9, 10),
        due_time=time(23, 59),
        reference_url="https://d2l.example/dropbox/lab3", reference_url_label="D2L (Dropbox)",
    )
    description = build_deadline_description(
        item, COURSE, nesting=None, details=huge_details, required_resources=None,
    )
    assert len(description) <= DESCRIPTION_CHAR_BUDGET
    assert '<a href="https://d2l.example/dropbox/lab3">D2L (Dropbox)</a>' in description
    assert "<b>CONTACT</b><br>Jane Doe" in description
    assert "more captured line(s) not shown here for length" in description


def test_format_details_blocks_label_less_blocks_omit_bold_header():
    assert format_details_blocks([DetailsBlock(text="Plain paragraph")]) == "Plain paragraph"
    assert format_details_blocks([DetailsBlock(items=["a", "b"])]) == "• a<br>• b"


def test_format_details_blocks_multiple_blocks_join_with_blank_line():
    blocks = [
        DetailsBlock(label="Vocabulary", text="microevolution, genetic drift"),
        DetailsBlock(label="Objectives", items=["Explain X", "Distinguish Y"]),
        DetailsBlock(text="Activity: Reading Evolutionary Tree Diagrams"),
    ]
    assert format_details_blocks(blocks) == (
        "<b>Vocabulary:</b> microevolution, genetic drift<br><br>"
        "<b>Objectives:</b><br>• Explain X<br>• Distinguish Y<br><br>"
        "Activity: Reading Evolutionary Tree Diagrams"
    )


def test_format_details_blocks_matches_approved_bio1112_example():
    blocks = [
        DetailsBlock(
            label="Vocabulary",
            text="microevolution, genetic variation, population, gene pool, "
            "adaptive evolution, genetic drift, founder effect, bottleneck "
            "effect, gene flow, relative fitness, directional/disruptive/"
            "stabilizing/sexual/intrasexual/intersexual selection",
        ),
        DetailsBlock(
            label="Objectives",
            items=[
                "Explain the major processes that generate genetic variation",
                "Distinguish gene vs. allele, genome vs. gene pool, genotype "
                "vs. phenotype, allele vs. genotype frequencies",
                "State the Hardy-Weinberg theorem of genetic equilibrium",
                "Define genetic drift and explain how it occurs in small populations",
                "Define gene flow and relate it to immigration/emigration",
                "Describe the three ways natural selection alters trait "
                "frequency distribution",
            ],
        ),
        DetailsBlock(text="Activity: Reading Evolutionary Tree Diagrams"),
    ]
    description = build_meeting_description(
        _item(
            item_type=ItemType.LECTURE,
            title="Chapter 23: Evolution of Populations; In-Class Hardy-Weinberg Activity",
            date=date(2026, 8, 24), start_time=time(17, 30),
        ),
        COURSE, location=None, details=format_details_blocks(blocks),
    )
    assert (
        "<b>DETAILS</b><br><b>Vocabulary:</b> microevolution, genetic variation, "
        "population, gene pool, adaptive evolution, genetic drift, founder "
        "effect, bottleneck effect, gene flow, relative fitness, directional/"
        "disruptive/stabilizing/sexual/intrasexual/intersexual selection<br><br>"
        "<b>Objectives:</b><br>"
        "• Explain the major processes that generate genetic variation<br>"
        "• Distinguish gene vs. allele, genome vs. gene pool, genotype vs. "
        "phenotype, allele vs. genotype frequencies<br>"
        "• State the Hardy-Weinberg theorem of genetic equilibrium<br>"
        "• Define genetic drift and explain how it occurs in small populations<br>"
        "• Define gene flow and relate it to immigration/emigration<br>"
        "• Describe the three ways natural selection alters trait frequency "
        "distribution<br><br>"
        "Activity: Reading Evolutionary Tree Diagrams<br><br><b>CONTACT</b>"
        in description
    )


# --------------------------------------------------------------------------
# Weekly grade diagnostic ("Previous Week Diagnostic")
# --------------------------------------------------------------------------

def test_diagnostic_description_basic_shape():
    section = DiagnosticCourseSection(
        course_code="BIO 1112", status=DiagnosticStatus.YELLOW,
        previous_grade_label="82.4% B-", current_grade_label="85.1% B",
        assignments=[
            DiagnosticAssignment(title="Quiz 3", score_percent=92.0),
            DiagnosticAssignment(
                title="Lab Report 2", score_percent=74.0,
                commentary='"Missing citations" — cite your sources next time.',
            ),
        ],
        plan=["Review Chapter 9 vocabulary", "Resubmit Lab Report 2 if regrade is allowed"],
    )
    description = build_weekly_diagnostic_description(section)
    # Two bold lines -- course name, then grade change -- no status word in
    # the text (the event's own colorId carries that now that each course
    # gets its own event), per the user's 2026-09-17 layout.
    assert description.startswith("<b>BIO 1112</b><br><b>82.4% B- → 85.1% B</b><br><br>")
    # Each assignment is one bold "Name - score" line, then real commentary
    # (if any) as a second, unbolded line -- never two separate lines for
    # name and score.
    assert "<b>Quiz 3 - 92%</b><br><br><b>Lab Report 2 - 74%</b><br>" in description
    assert '"Missing citations" — cite your sources next time.' in description
    # Plan is the very last section, missed-deadline facts (none here) would
    # come first inside it, then the numbered generated plan.
    assert description.endswith(
        "<b>Plan:</b><br>1) Review Chapter 9 vocabulary<br>2) Resubmit Lab Report 2 if regrade is allowed"
    )
    # No announcements/upcoming supplied -- those sections must be omitted
    # entirely, same "never pad a missing field" rule as everywhere else in
    # this module.
    assert "Announcements" not in description
    assert "Upcoming Deadlines" not in description


def test_diagnostic_description_missing_item_shows_missing_not_a_percent():
    section = DiagnosticCourseSection(
        course_code="MAT 1340", status=DiagnosticStatus.RED,
        current_grade_label="61.0% D-",
        assignments=[DiagnosticAssignment(title="Homework 4.2", is_missing=True)],
    )
    description = build_weekly_diagnostic_description(section)
    assert "<b>Homework 4.2 - Missing</b>" in description
    assert description.startswith("<b>MAT 1340</b><br><b>61.0% D-</b>")


def test_diagnostic_description_no_grade_change_available_omits_dash():
    section = DiagnosticCourseSection(course_code="CHE 1011", status=DiagnosticStatus.GREEN)
    description = build_weekly_diagnostic_description(section)
    assert description == "<b>CHE 1011</b>"


def test_diagnostic_description_missed_deadlines_fold_into_plan_not_own_section():
    section = DiagnosticCourseSection(
        course_code="CHE 1011", status=DiagnosticStatus.RED,
        current_grade_label="63.42% D",
        missed_deadlines=[
            "Laboratory Safety/Getting Started (due Sep 5, window closed Sep 7) — never "
            "submitted; the window is now closed, so this needs an instructor exception."
        ],
        plan=["Email the instructor about the missed Lab Safety assignment."],
    )
    description = build_weekly_diagnostic_description(section)
    assert "Missed deadlines" not in description
    # Missed-deadline facts render as bullets first, directly under the
    # same Plan header, immediately before the numbered generated plan --
    # user-directed 2026-09-17.
    assert (
        "<b>Plan:</b><br>• Laboratory Safety/Getting Started (due Sep 5, window closed Sep 7)"
        in description
    )
    assert description.endswith(
        "1) Email the instructor about the missed Lab Safety assignment."
    )


def test_diagnostic_description_upcoming_deadlines_label_says_next_3_weeks():
    section = DiagnosticCourseSection(
        course_code="MAT 1340", status=DiagnosticStatus.YELLOW,
        upcoming_deadlines=["Midterm Survey — Sep 29", "Online Exam: Chapter 3 — Oct 4"],
    )
    description = build_weekly_diagnostic_description(section)
    assert "<b>Upcoming Deadlines (Next 3 Weeks):</b><br>• Midterm Survey" in description


def test_diagnostic_description_stays_under_budget_with_huge_assignment_list():
    # One course with a huge real week of assignments -- confirm the
    # description stays under Google Calendar's real length limit and the
    # small always-wanted sections (header/plan) survive intact rather than
    # being the thing truncated.
    section = DiagnosticCourseSection(
        course_code="BIO 1112", status=DiagnosticStatus.YELLOW,
        previous_grade_label="80.0% B-", current_grade_label="81.0% B-",
        assignments=[
            DiagnosticAssignment(
                title=f"Assignment {i}", score_percent=85.0,
                commentary="Solid work, keep it up with real detail padding the line out.",
            )
            for i in range(200)
        ],
        plan=["Keep up the consistent effort."],
    )
    description = build_weekly_diagnostic_description(section)
    assert len(description) <= DESCRIPTION_CHAR_BUDGET
    assert description.startswith("<b>BIO 1112</b><br><b>80.0% B- → 81.0% B-</b><br><br>")
    assert description.endswith("<b>Plan:</b><br>1) Keep up the consistent effort.")
    assert "more captured line(s) not shown here for length" in description


def test_diagnostic_payload_is_single_all_day_monday_event_titled_per_course():
    description = build_weekly_diagnostic_description(
        DiagnosticCourseSection(course_code="BIO 1112", status=DiagnosticStatus.GREEN)
    )
    payload = build_weekly_diagnostic_payload(
        "BIO 1112", date(2026, 9, 14), description, fingerprint="diagnostic-fp-abc123",
        record_id="rec-1", color_id="2",
    )
    assert payload["summary"] == "BIO 1112 Previous Week Diagnostic"
    assert payload["start"] == {"date": "2026-09-14"}
    assert payload["end"] == {"date": "2026-09-15"}
    assert payload["colorId"] == "2"
    assert "attendees" not in payload
    assert "conferenceData" not in payload
    assert payload["guestsCanInviteOthers"] is False
    assert compute_calendar_fingerprint("diagnostic-fp-abc123") in payload["description"]
    assert payload["extendedProperties"]["private"]["academic_sync_diagnostic_record_id"] == "rec-1"


def test_deadline_submission_url_renders_as_separate_submit_work_link():
    item = _item(
        item_type=ItemType.EXAM, title="Exam 3", date=date(2026, 10, 20), due_time=time(23, 59),
        reference_url="https://d2l.example/quiz/3", reference_url_label="Exam",
        submission_url="https://d2l.example/dropbox/77",
        resource_url="https://tb.example/ch5", resource_url_label="Textbook (Ch. 5)",
    )
    description = build_deadline_description(
        item, COURSE, nesting=None, details=None, required_resources=None,
    )
    links = description.split("<b>LINKS</b><br>")[1]
    assert links == (
        '<a href="https://d2l.example/quiz/3">Exam</a><br>'
        '<a href="https://d2l.example/dropbox/77">Submit Work</a><br>'
        '<a href="https://tb.example/ch5">Textbook (Ch. 5)</a>'
    )


def test_test_items_render_study_guides_after_links():
    item = _item(
        item_type=ItemType.EXAM, title="Exam 2", date=date(2026, 10, 20), due_time=time(23, 59),
        reference_url="https://d2l.example/quiz/2", reference_url_label="Take the exam",
        weekly_links=[
            WeeklyLink(label="Exam 2 Study Guide", url="https://d2l.example/sg2.pdf"),
            WeeklyLink(label="Practice Exam 2", url="https://d2l.example/practice2"),
            WeeklyLink(label="Syllabus", url="https://d2l.example/syllabus"),
        ],
    )
    description = build_deadline_description(item, COURSE, nesting=None, details=None,
                                             required_resources=None)
    assert description.index("<b>LINKS</b>") < description.index("<b>STUDY GUIDES</b>")
    study = description.split("<b>STUDY GUIDES</b><br>")[1]
    assert study == (
        '<a href="https://d2l.example/sg2.pdf">Exam 2 Study Guide</a><br>'
        '<a href="https://d2l.example/practice2">Practice Exam 2</a>'
    )


def test_timed_exam_meeting_keeps_take_link_and_study_guides_separate():
    item = _item(
        item_type=ItemType.EXAM, title="Midterm", date=date(2026, 10, 20), start_time=time(9, 0),
        reference_url="https://d2l.example/exam-info", reference_url_label="Exam details",
        weekly_links=[WeeklyLink(label="Midterm Review", url="https://d2l.example/review")],
    )
    description = build_meeting_description(item, COURSE, location=None)
    assert '<b>LINKS</b><br><a href="https://d2l.example/exam-info">Exam details</a>' in description
    assert '<b>STUDY GUIDES</b><br><a href="https://d2l.example/review">Midterm Review</a>' in description


def test_non_test_deadline_never_renders_study_guides():
    item = _item(item_type=ItemType.ASSIGNMENT, title="HW 1", date=date(2026, 10, 20),
                 due_time=time(23, 59), weekly_links=[WeeklyLink(label="X", url="https://x")])
    description = build_deadline_description(item, COURSE, nesting=None, details=None,
                                             required_resources=None)
    assert "STUDY GUIDES" not in description


def test_banner_with_huge_resource_list_still_fits_calendar_limit():
    item = _item(
        item_type=ItemType.WEEKLY_READING, title="Chapter 1: A; Chapter 2: B",
        date=date(2026, 8, 24), date_range_end=date(2026, 8, 30),
        weekly_links=[
            WeeklyLink(label=f"Worksheet {i} with a long descriptive label",
                       url=f"https://example.edu/very/long/path/file-{i}.pdf", kind="handout")
            for i in range(120)
        ],
    )
    topics = _topics(_topic("Chapter 1", objectives=[f"Objective {i} text" for i in range(50)]))
    description = build_weekly_reading_description(item, COURSE, chapter_topics=topics)
    assert len(description) <= DESCRIPTION_CHAR_BUDGET
    assert "more link(s) not shown here for length" in description
    assert description.endswith("<b>DATES</b><br>Aug 24 - 30")


def test_assemble_keeps_minimum_detail_when_resources_are_long():
    from academic_sync.sync.calendar_payload import (
        _MIN_FLEXIBLE_CHARS,
        _assemble_within_budget,
    )

    resources = "<b>SLIDES</b><br>" + "<br>".join(f'<a href="https://x/{i}">link {i}</a>' for i in range(400))
    detail = "<b>TOPIC DETAIL</b><br>" + "<br>".join(f"• objective {i}" for i in range(400))
    out = _assemble_within_budget(["header", resources, detail, "<b>DATES</b>"], 2, 1)
    assert len(out) <= DESCRIPTION_CHAR_BUDGET
    kept_detail = out.split("<br><br>")[2]
    assert kept_detail.startswith("<b>TOPIC DETAIL</b>")
    assert len(kept_detail) >= _MIN_FLEXIBLE_CHARS - 150
    assert "more link(s) not shown" in out


def _ch_topic(label: str, **kwargs) -> ChapterTopic:
    return ChapterTopic(id=uuid.uuid4().hex, course_id="c1", chapter_label=label, **kwargs)


def test_exam_concepts_lead_with_study_focus_then_all_terms_then_concepts():
    # User-directed 2026-10-15 (CLAUDE.md invariant 40): a test lists the
    # concepts/terms of every chapter it covers: study-guide emphasis first,
    # then every chapter's key terms, then concepts (so a length cut only
    # drops trailing concepts), at the bottom so the links stay on top.
    item = _item(
        item_type=ItemType.EXAM, title="Exam 2", date=date(2026, 10, 20), due_time=time(23, 59),
        reference_url="https://d2l.example/quiz/2", reference_url_label="Take the exam",
        covered_chapters=["Chapter 5", "Chapter 6"],
        study_focus=["Know Boyle's law", "Molarity calculations"],
    )
    topics = {
        canonicalize_chapter_label("Chapter 5"): _ch_topic(
            "Chapter 5", title="States of Matter", vocabulary="pressure", objectives=["State Boyle's law"],
        ),
    }
    description = build_deadline_description(item, COURSE, nesting=None, details=None,
                                             required_resources=None, chapter_topics=topics)
    assert description.index("<b>LINKS</b>") < description.index("<b>EXAM CONCEPTS</b>")
    concepts = description.split("<b>EXAM CONCEPTS</b><br>")[1]
    assert concepts == (
        "<b>Study guide focus:</b><br>• Know Boyle's law<br>• Molarity calculations<br><br>"
        "<b>Chapter 5 — States of Matter — key terms:</b> pressure<br><br>"
        "<b>Chapter 6</b><br><br>"
        "<b>Chapter 5 — States of Matter — concepts:</b><br>• State Boyle's law"
    )


def test_non_test_never_renders_exam_concepts():
    item = _item(item_type=ItemType.ASSIGNMENT, title="HW 1", date=date(2026, 10, 20),
                 due_time=time(23, 59), covered_chapters=["Chapter 5"], study_focus=["x"])
    description = build_deadline_description(item, COURSE, nesting=None, details=None,
                                             required_resources=None)
    assert "EXAM CONCEPTS" not in description


def test_homework_video_link_renders_right_after_assignment_link():
    item = _item(
        item_type=ItemType.ASSIGNMENT, title="HW 6.3", date=date(2026, 10, 20), due_time=time(23, 59),
        reference_url="https://aleks.example/hw63", reference_url_label="Assignment",
        resource_url="https://book.example/ch6", resource_url_label="Textbook",
        video_url="https://www.khanacademy.org/molarity", video_url_label="Video — Molarity",
    )
    description = build_deadline_description(item, COURSE, nesting=None, details=None,
                                             required_resources=None)
    assert (
        '<b>LINKS</b><br><a href="https://aleks.example/hw63">Assignment</a><br>'
        '<a href="https://www.khanacademy.org/molarity">Video — Molarity</a><br>'
        '<a href="https://book.example/ch6">Textbook</a>'
    ) in description


def test_exam_concepts_lead_with_labeled_added_terms_when_no_sourced_vocabulary():
    item = _item(item_type=ItemType.EXAM, title="Exam", date=date(2026, 10, 28), due_time=time(23, 59),
                 covered_chapters=["Chapter 4"])
    topics = {canonicalize_chapter_label("Chapter 4"): _ch_topic(
        "Chapter 4", title="Logs", objectives=["Solve log equations"], added_vocabulary="logarithm",
    )}
    description = build_deadline_description(item, COURSE, nesting=None, details=None,
                                             required_resources=None, chapter_topics=topics)
    concepts = description.split("<b>EXAM CONCEPTS</b><br>")[1]
    assert concepts.startswith(
        "<b>Chapter 4 — Logs — key terms, added (not from instructor):</b> logarithm<br><br>"
        "<b>Chapter 4 — Logs — concepts:</b><br>• Solve log equations"
    )
