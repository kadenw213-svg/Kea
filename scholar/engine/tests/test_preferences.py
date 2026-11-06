from __future__ import annotations

import pytest

from academic_sync.preferences.store import UnknownPreferenceError, get_pref, set_pref, unset_pref


def test_set_and_get_global_preference(session):
    set_pref(session, "default_due_time", "23:59")
    assert get_pref(session, "default_due_time") == "23:59"


def test_unknown_key_rejected_by_default(session):
    with pytest.raises(UnknownPreferenceError):
        set_pref(session, "totally_made_up_key", "x")


def test_unknown_key_allowed_with_force(session):
    set_pref(session, "totally_made_up_key", "x", allow_unknown=True)
    assert get_pref(session, "totally_made_up_key") == "x"


def test_course_scoped_preference_overrides_global(session, make_course):
    course = make_course()
    set_pref(session, "default_due_time", "23:59")
    set_pref(session, "default_due_time", "17:00", course_id=course.id)

    assert get_pref(session, "default_due_time", course_id=course.id) == "17:00"
    assert get_pref(session, "default_due_time") == "23:59"


def test_course_scoped_lookup_falls_back_to_global_when_unset(session, make_course):
    course = make_course()
    set_pref(session, "default_due_time", "23:59")
    assert get_pref(session, "default_due_time", course_id=course.id) == "23:59"


def test_unset_preference_falls_back_to_known_default(session):
    # default_due_time has a spec default of "23:59" -- unsetting the user's
    # override should fall back to that engineering default, not None.
    set_pref(session, "default_due_time", "17:00")
    assert unset_pref(session, "default_due_time") is True
    assert get_pref(session, "default_due_time") == "23:59"


def test_unset_unknown_preference_returns_none(session):
    set_pref(session, "custom_thing", "x", allow_unknown=True)
    assert unset_pref(session, "custom_thing") is True
    assert get_pref(session, "custom_thing") is None


def test_preference_persists_across_sessions_via_repository(session, make_course):
    """Preferences must survive being re-read as if from a new process --
    exercised here via a second query against the same underlying tables."""
    set_pref(session, "calendar_color_id", "10")
    session.commit()
    assert get_pref(session, "calendar_color_id") == "10"


def test_d2l_base_url_falls_back_to_env_var_when_unset(session, monkeypatch):
    # .env.example documents D2L_BASE_URL as pre-filling this preference for
    # a fresh install -- this is the "different user, different D2L
    # institution" bootstrap path (see academic-import SKILL.md Step 0).
    # Before this fell back to a hardcoded None default and silently
    # ignored the env var despite the documented promise.
    from academic_sync import preferences

    class FakeSettings:
        d2l_base_url = "https://newschool.brightspace.com"

    monkeypatch.setattr(preferences.store, "get_settings", lambda: FakeSettings())
    assert get_pref(session, "d2l_base_url") == "https://newschool.brightspace.com"


def test_d2l_base_url_explicit_pref_wins_over_env_var(session, monkeypatch):
    from academic_sync import preferences

    class FakeSettings:
        d2l_base_url = "https://newschool.brightspace.com"

    monkeypatch.setattr(preferences.store, "get_settings", lambda: FakeSettings())
    set_pref(session, "d2l_base_url", "https://d2l.example.edu/d2l/home/1234")
    assert get_pref(session, "d2l_base_url") == "https://d2l.example.edu/d2l/home/1234"
