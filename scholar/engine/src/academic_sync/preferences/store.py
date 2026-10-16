"""Preference store.

Thin, validated wrapper over db.repository's preference functions. Exists so
the CLI and the academic-import skill share one place that knows what a
given preference key means, its category, and its default -- rather than
scattering magic strings across callers.

Preferences are only ever written here in response to an explicit
`prefs set` call (or an explicit user confirmation relayed by a skill) --
never inferred from casual text in a syllabus. See CLAUDE.md.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy.orm import Session

from academic_sync.config import get_settings
from academic_sync.db import repository
from academic_sync.models.enums import PreferenceCategory


@dataclass
class PreferenceSpec:
    key: str
    category: PreferenceCategory
    default: object
    description: str


KNOWN_PREFERENCES: dict[str, PreferenceSpec] = {
    "target_calendar_id": PreferenceSpec(
        "target_calendar_id", PreferenceCategory.CALENDAR, "primary",
        "Google Calendar id events are written to.",
    ),
    "calendar_color_id": PreferenceSpec(
        "calendar_color_id", PreferenceCategory.CALENDAR, "10",
        "Google Calendar colorId for school events (default 10 = dark green/Basil).",
    ),
    "assessment_color_id": PreferenceSpec(
        "assessment_color_id", PreferenceCategory.CALENDAR, "5",
        "Google Calendar colorId for tests -- exams, finals, lab practicals, quizzes "
        "(default 5 = yellow/Banana). CLAUDE.md invariant 40.",
    ),
    "default_reminders_enabled": PreferenceSpec(
        "default_reminders_enabled", PreferenceCategory.CALENDAR, False,
        "Whether created events use Calendar's default reminders.",
    ),
    "invite_guests": PreferenceSpec(
        "invite_guests", PreferenceCategory.CALENDAR, False,
        "Whether instructor/classmates are ever added as event guests (should stay False).",
    ),
    "create_meet_links": PreferenceSpec(
        "create_meet_links", PreferenceCategory.CALENDAR, False,
        "Whether Google Meet links are auto-attached to created events.",
    ),
    "timezone": PreferenceSpec(
        "timezone", PreferenceCategory.TIMING, "America/Denver",
        "IANA timezone used to localize all dates/times.",
    ),
    "default_due_time": PreferenceSpec(
        "default_due_time", PreferenceCategory.TIMING, "23:59",
        "Time of day used when a source gives a due date but no due time.",
    ),
    "include_topic_in_class_titles": PreferenceSpec(
        "include_topic_in_class_titles", PreferenceCategory.TITLES, True,
        "Whether class-meeting event titles include a parenthetical topic when known.",
    ),
    "administrative_dates_calendarize": PreferenceSpec(
        "administrative_dates_calendarize", PreferenceCategory.ADMINISTRATIVE, True,
        "Whether drop/withdrawal/registration deadlines become Calendar events.",
    ),
    "d2l_base_url": PreferenceSpec(
        "d2l_base_url", PreferenceCategory.D2L_ALIAS, None,
        "Institution D2L/Brightspace base URL, used to pre-fill navigation.",
    ),
    "digest_email_to": PreferenceSpec(
        "digest_email_to", PreferenceCategory.OTHER, None,
        "Address the Daily Overview emails go to (sent from the connected Gmail "
        "account). No email is sent while unset.",
    ),
    "diagnostic_color_red": PreferenceSpec(
        "diagnostic_color_red", PreferenceCategory.CALENDAR, "11",
        "Google Calendar colorId for a RED 'Previous Week Diagnostic' banner "
        "(default 11 = Tomato).",
    ),
    "diagnostic_color_yellow": PreferenceSpec(
        "diagnostic_color_yellow", PreferenceCategory.CALENDAR, "5",
        "Google Calendar colorId for a YELLOW 'Previous Week Diagnostic' banner "
        "(default 5 = Banana).",
    ),
    "diagnostic_color_green": PreferenceSpec(
        "diagnostic_color_green", PreferenceCategory.CALENDAR, "2",
        "Google Calendar colorId for a GREEN 'Previous Week Diagnostic' banner "
        "(default 2 = Sage) -- deliberately distinct from calendar_color_id's "
        "default dark green so the banner never reads as an ordinary class event.",
    ),
}


class UnknownPreferenceError(ValueError):
    pass


def set_pref(
    session: Session,
    key: str,
    value: object,
    *,
    course_id: str | None = None,
    source: str = "user_confirmed",
    allow_unknown: bool = False,
) -> None:
    spec = KNOWN_PREFERENCES.get(key)
    if spec is None and not allow_unknown:
        raise UnknownPreferenceError(
            f"Unknown preference key '{key}'. Use --force/allow_unknown to set it anyway, "
            f"or check `academic-sync prefs list --known` for valid keys."
        )
    category = spec.category.value if spec else PreferenceCategory.OTHER.value
    repository.set_preference(
        session,
        key=key,
        value=value,
        category=category,
        scope="course" if course_id else "global",
        course_id=course_id,
        source=source,
    )


def get_pref(session: Session, key: str, course_id: str | None = None) -> object:
    spec = KNOWN_PREFERENCES.get(key)
    default = spec.default if spec else None
    # .env.example documents D2L_BASE_URL as pre-filling this preference for
    # a fresh install/new user -- honor that here rather than falling
    # straight through to the hardcoded None default, so a new user (a
    # different D2L institution entirely, e.g. a friend running this skill
    # from their own ACADEMIC_SYNC_DB_PATH -- see SKILL.md Step 0) can set
    # one env var instead of always needing an explicit `prefs set` before
    # their first scan. An explicit `prefs set d2l_base_url ...` still wins
    # once it exists, since repository.get_preference only falls back to
    # `default` when nothing is stored.
    if key == "d2l_base_url" and default is None:
        default = get_settings().d2l_base_url
    return repository.get_preference(session, key, course_id=course_id, default=default)


def unset_pref(session: Session, key: str, course_id: str | None = None) -> bool:
    return repository.unset_preference(session, key, course_id=course_id)


def list_prefs(session: Session):
    return repository.list_preferences(session)
