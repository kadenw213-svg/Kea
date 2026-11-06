from __future__ import annotations

import json
import os
import uuid
from datetime import date, time
from pathlib import Path

from typer.testing import CliRunner

from academic_sync.cli import app
from academic_sync.db import repository
from academic_sync.db.migrations import run_migrations
from academic_sync.db.session import get_engine, reset_engine_cache, session_scope
from academic_sync.digest import DailyOverview, DeadlineLine, DigestCrawl, attention_entries
from academic_sync.models.domain import AcademicItem, CourseGradeSnapshot
from academic_sync.models.enums import ItemStatus, ItemType
from academic_sync.sync.email_payload import build_daily_overview_email, email_subject

runner = CliRunner()
TODAY = date(2026, 10, 6)


def _isolated_db(tmp_path: Path) -> None:
    reset_engine_cache()
    os.environ["ACADEMIC_SYNC_DB_PATH"] = str(tmp_path / "test.db")
    from academic_sync.config import clear_caches

    clear_caches()
    run_migrations(get_engine(f"sqlite:///{(tmp_path / 'test.db').as_posix()}"))


def _setup(tmp_path: Path) -> str:
    _isolated_db(tmp_path)
    out = runner.invoke(app, ["course", "add", "--code", "MAT1340", "--name", "Calc", "--term", "Fall 2026"])
    course_id = out.stdout.strip().split("id=")[-1]
    runner.invoke(app, ["prefs", "set", "digest_email_to", "student@example.com"])
    return course_id


def _add_item(course_id: str, title: str, due: date, **kwargs) -> str:
    item = AcademicItem(
        id=uuid.uuid4().hex, course_id=course_id, item_type=kwargs.pop("item_type", ItemType.ASSIGNMENT),
        title=title, date=due, due_time=kwargs.pop("due_time", time(23, 59)), status=ItemStatus.CLEAR,
        fingerprint="fp-" + uuid.uuid4().hex, **kwargs,
    )
    with session_scope() as session:
        return repository.upsert_academic_item(session, item).id


def _ingest(tmp_path: Path, crawl: dict) -> dict:
    path = tmp_path / f"crawl-{uuid.uuid4().hex}.json"
    path.write_text(json.dumps(crawl), encoding="utf-8")
    result = runner.invoke(app, ["digest-ingest", "--file", str(path)])
    assert result.exit_code == 0, result.stdout
    return json.loads(result.stdout)


def _render(day: date = TODAY) -> dict:
    result = runner.invoke(app, ["digest-render", "--course", "MAT1340", "--date", day.isoformat()])
    assert result.exit_code == 0, result.stdout
    return json.loads(result.stdout)


def test_first_ingest_baselines_old_history_and_keeps_recent_news(tmp_path):
    _setup(tmp_path)
    counts = _ingest(tmp_path, {
        "course": "MAT1340", "captured_on": TODAY.isoformat(), "overall_percent": 43.0,
        "announcements": [
            {"id": "a-old", "title": "Welcome", "posted_on": "2026-08-17"},
            {"id": "a-new", "title": "Exam 3 moved", "posted_on": "2026-10-05",
             "url": "https://d2l.example/news/2", "highlights": ["Exam 3 is now Oct 20."]},
        ],
        "grades": [
            {"id": "g-old", "title": "HW 1.1", "score_percent": 100, "graded_on": "2026-08-25"},
            {"id": "g-new", "title": "Exam 2", "score_percent": 72, "score_text": "36 / 50",
             "comment": "Review chain rule.", "item_url": "https://d2l.example/q/2",
             "feedback_url": "https://d2l.example/q/2/feedback", "graded_on": "2026-10-05"},
        ],
    })
    assert counts["baseline"] == 2 and counts["new"] == 2

    rendered = _render()
    assert rendered["should_send"] is True
    assert rendered["subject"] == "Daily Overview MAT1340"
    assert rendered["to"] == "student@example.com"
    html = rendered["html"]
    assert "Current grade: 43%" in html
    assert "Exam 3 moved" in html and "Exam 3 is now Oct 20." in html
    assert "“Review chain rule.”" in html
    assert '<a href="https://d2l.example/q/2/feedback">Open feedback</a>' in html
    assert "Welcome" not in html and "HW 1.1" not in html


def test_reingest_unchanged_is_seen_and_changed_feedback_resurfaces(tmp_path):
    _setup(tmp_path)
    grade = {"id": "g1", "title": "Exam 2", "score_percent": 72, "graded_on": TODAY.isoformat()}
    _ingest(tmp_path, {"course": "MAT1340", "captured_on": TODAY.isoformat(), "grades": [grade]})
    sent = _render()
    assert sent["should_send"] is True
    runner.invoke(app, ["digest-record-sent", "--course", "MAT1340", "--date", TODAY.isoformat(),
                        "--message-id", "m1"])

    tomorrow = date(2026, 10, 7)
    again = _ingest(tmp_path, {"course": "MAT1340", "captured_on": tomorrow.isoformat(), "grades": [grade]})
    assert again["seen"] == 1 and again["new"] == 0
    assert _render(tomorrow)["should_send"] is False  # quiet day

    grade_with_comment = {**grade, "comment": "See me in office hours."}
    changed = _ingest(tmp_path, {"course": "MAT1340", "captured_on": tomorrow.isoformat(),
                                 "grades": [grade_with_comment]})
    assert changed["updated"] == 1
    html = _render(tomorrow)["html"]
    assert "See me in office hours." in html and "(updated)" in html


def test_rewording_old_news_is_not_an_update(tmp_path):
    # A later run quotes other highlights, trims a long comment with "…" and changes spacing: nothing really changed.
    _setup(tmp_path)
    day = TODAY.isoformat()
    long = "Good work on the derivations. Next time show every step of the chain rule so I can give partial credit."
    _ingest(tmp_path, {"course": "MAT1340", "captured_on": day,
                       "announcements": [{"id": "a1", "title": "Exam 3 moved", "posted_on": day, "highlights": ["Exam 3 is now Oct 20."]}],
                       "grades": [{"id": "g1", "title": "Exam 2", "score_percent": 72, "comment": long, "graded_on": day}]})
    tomorrow = date(2026, 10, 7).isoformat()
    again = _ingest(tmp_path, {"course": "MAT1340", "captured_on": tomorrow,
                               "announcements": [{"id": "a1", "title": "Exam 3  moved", "posted_on": day, "highlights": ["Now on October 20."]}],
                               "grades": [{"id": "g1", "title": "Exam 2", "score_percent": 72, "comment": long[:90] + "…", "graded_on": day}]})
    assert again["updated"] == 0 and again["seen"] == 2
    regraded = _ingest(tmp_path, {"course": "MAT1340", "captured_on": tomorrow,
                                  "grades": [{"id": "g1", "title": "Exam 2", "score_percent": 80, "comment": long, "graded_on": day}]})
    assert regraded["updated"] == 1


def test_record_sent_prevents_double_send_same_day(tmp_path):
    _setup(tmp_path)
    _ingest(tmp_path, {"course": "MAT1340", "captured_on": TODAY.isoformat(),
                       "announcements": [{"id": "a1", "title": "Hi", "posted_on": TODAY.isoformat()}]})
    assert _render()["should_send"] is True
    runner.invoke(app, ["digest-record-sent", "--course", "MAT1340", "--date", TODAY.isoformat(),
                        "--message-id", "m1"])
    again = _render()
    assert again["should_send"] is False and again["already_sent"] is True


def test_missed_yesterday_and_due_today_respect_submission_status(tmp_path):
    course_id = _setup(tmp_path)
    missed = _add_item(course_id, "HW 4.1", date(2026, 10, 5),
                       reference_url="https://d2l.example/hw41",
                       submission_url="https://d2l.example/dropbox/41")
    done = _add_item(course_id, "HW 4.2", date(2026, 10, 5))
    _add_item(course_id, "HW 4.3", TODAY, reference_url="https://d2l.example/hw43")
    _add_item(course_id, "Lecture 9", TODAY, item_type=ItemType.LECTURE, due_time=None,
              start_time=time(9, 0))
    _ingest(tmp_path, {
        "course": "MAT1340", "captured_on": TODAY.isoformat(),
        "deadline_status": [
            {"item_id": missed, "submitted": False, "window_open": True},
            {"item_id": done, "submitted": True},
        ],
    })
    rendered = _render()
    html = rendered["html"]
    assert rendered["should_send"] is True
    assert "Missed yesterday" in html
    assert '<a href="https://d2l.example/dropbox/41">HW 4.1</a>' in html  # submit slot wins
    assert "still open" in html
    assert "HW 4.2" not in html
    assert "Due today" in html and "HW 4.3" in html and "11:59 PM" in html
    assert "Lecture 9" not in html


def test_digest_deadlines_lists_yesterday_today_upcoming(tmp_path):
    course_id = _setup(tmp_path)
    _add_item(course_id, "HW A", date(2026, 10, 5))
    _add_item(course_id, "HW B", TODAY)
    _add_item(course_id, "HW C", date(2026, 10, 8))
    _add_item(course_id, "HW far", date(2026, 10, 30))
    result = runner.invoke(app, ["digest-deadlines", "--course", "MAT1340", "--date", TODAY.isoformat()])
    rows = json.loads(result.stdout)
    assert [(r["when"], r["title"]) for r in rows] == [
        ("yesterday", "HW A"), ("today", "HW B"), ("upcoming", "HW C"),
    ]


def test_login_failed_never_sends(tmp_path):
    course_id = _setup(tmp_path)
    _add_item(course_id, "HW due tonight", TODAY)  # would be news on a real crawl
    _ingest(tmp_path, {"course": "MAT1340", "captured_on": TODAY.isoformat(), "login_failed": True})
    rendered = _render()
    assert rendered["should_send"] is False
    assert rendered["has_news"] is False


def test_no_crawl_today_never_sends(tmp_path):
    _setup(tmp_path)
    rendered = _render()
    assert rendered["should_send"] is False


def test_attention_reported_once_not_daily(tmp_path):
    _setup(tmp_path)
    zero = {"id": "g9", "title": "Lab 3", "score_percent": 0, "graded_on": TODAY.isoformat()}
    _ingest(tmp_path, {"course": "MAT1340", "captured_on": TODAY.isoformat(), "grades": [zero]})
    assert "Lab 3 was graded 0%." in _render()["html"]
    runner.invoke(app, ["digest-record-sent", "--course", "MAT1340", "--date", TODAY.isoformat(),
                        "--message-id", "m1"])
    tomorrow = date(2026, 10, 7)
    _ingest(tmp_path, {"course": "MAT1340", "captured_on": tomorrow.isoformat(), "grades": [zero]})
    assert _render(tomorrow)["should_send"] is False


def test_attention_rules_major_and_drop():
    crawl = DigestCrawl(
        course="X", captured_on=TODAY, overall_percent=50.0, missing_count=2,
        grades=[{"id": "e", "title": "Exam 3", "score_percent": 40, "is_major": True}],
    )
    week_ago = CourseGradeSnapshot(id="s", course_id="c", week_start=date(2026, 9, 29),
                                   captured_at=date(2026, 9, 29), overall_percent=65.0)
    texts = [e.payload["text"] for e in attention_entries(crawl, week_ago=week_ago)]
    assert "Exam 3 scored 40% (under 60%)." in texts
    assert "2 assignments are marked missing." in texts
    assert any(t.startswith("Overall grade dropped 15.0 points") for t in texts)


def test_grade_trend_and_portal_footer_render():
    overview = DailyOverview(
        course_code="BIO1112", course_name="Bio II", digest_date=TODAY,
        overall_percent=87.4, letter_grade="B", trend_points=1.2, trend_since=date(2026, 9, 29),
        due_today=[DeadlineLine("i", "Lab 5", TODAY, time(23, 59), "https://d2l.example/lab5")],
        portal_links=[("Grades", "https://d2l.example/grades")],
    )
    msg = build_daily_overview_email(overview)
    assert msg.subject == email_subject("BIO1112") == "Daily Overview BIO1112"
    assert "Current grade: 87.4% (B)" in msg.html and "+1.2 since Sep 29" in msg.html
    assert '<a href="https://d2l.example/grades">Grades</a>' in msg.html
    assert "Lab 5" in msg.text


def test_quiet_day_has_no_news_even_with_upcoming():
    overview = DailyOverview(
        course_code="BIO1112", course_name="Bio II", digest_date=TODAY, overall_percent=40.0,
        upcoming=[DeadlineLine("i", "Lab 6", date(2026, 10, 8), None, None)],
    )
    assert overview.has_news is False


def test_portal_link_set_and_course_code_resolution(tmp_path):
    _setup(tmp_path)
    ok = runner.invoke(app, ["portal-link-set", "--course", "mat 1340", "--kind", "grades",
                             "--url", "https://d2l.example/grades"])
    assert ok.exit_code == 0, ok.stdout
    bad = runner.invoke(app, ["portal-link-set", "--course", "MAT1340", "--kind", "nope",
                              "--url", "https://x"])
    assert bad.exit_code == 1
    listed = json.loads(runner.invoke(app, ["portal-link-list", "--course", "MAT1340", "--json"]).stdout)
    assert listed == [{"kind": "grades", "label": "", "url": "https://d2l.example/grades"}]


def test_exam_without_due_time_still_counts_as_actionable(tmp_path):
    course_id = _setup(tmp_path)
    _add_item(course_id, "Online Exam: Chapter 3", date(2026, 10, 5),
              item_type=ItemType.EXAM, due_time=None)
    out = runner.invoke(app, ["digest-deadlines", "--course", "MAT1340", "--date", TODAY.isoformat()])
    rows = json.loads(out.stdout)
    assert [r["title"] for r in rows if r["when"] == "yesterday"] == ["Online Exam: Chapter 3"]


def test_first_run_does_not_flag_old_bad_grades(tmp_path):
    _setup(tmp_path)
    _ingest(tmp_path, {"course": "MAT1340", "captured_on": TODAY.isoformat(), "grades": [
        {"id": "old", "title": "Exam 1", "score_percent": 20, "is_major": True, "graded_on": "2026-09-01"},
        {"id": "new", "title": "Exam 3", "score_percent": 15, "is_major": True,
         "graded_on": TODAY.isoformat()},
    ]})
    html = _render()["html"]
    assert "Exam 3 scored 15%" in html and "Exam 1 scored" not in html


def test_class_message_and_general_messages_email(tmp_path):
    _setup(tmp_path)
    runner.invoke(app, ["course", "add", "--code", "MESSAGES", "--name", "D2L messages",
                        "--term", "system"])
    _ingest(tmp_path, {"course": "MAT1340", "captured_on": TODAY.isoformat(), "messages": [
        {"id": "m1", "subject": "Exam 3 retake", "sender": "Ann Cushman",
         "received_on": TODAY.isoformat(), "excerpt": "You may retake Exam 3 by Friday."}]})
    html = _render()["html"]
    assert "New messages" in html and "You may retake Exam 3 by Friday." in html

    _ingest(tmp_path, {"course": "MESSAGES", "captured_on": TODAY.isoformat(), "messages": [
        {"id": "g1", "subject": "Registration opens Nov 2", "sender": "Advising",
         "received_on": TODAY.isoformat()}]})
    out = runner.invoke(app, ["digest-render", "--course", "MESSAGES", "--date", TODAY.isoformat()])
    general = json.loads(out.stdout)
    assert general["subject"] == "Daily Overview Messages"
    assert general["should_send"] is True
    assert "Current grade" not in general["html"] and "Registration opens Nov 2" in general["html"]
