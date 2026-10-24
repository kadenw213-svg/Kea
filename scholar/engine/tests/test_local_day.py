"""D2L due dates land on the class's day (config timezone), whatever zone the computer is set to."""

from __future__ import annotations

import os
import time
from datetime import date

import pytest

from academic_sync import cli


@pytest.fixture
def machine_in_tokyo():
    if not hasattr(time, "tzset"):
        yield  # (Windows can't change the process zone; the configured zone is used either way.)
        return
    old = os.environ.get("TZ")
    os.environ["TZ"] = "Asia/Tokyo"
    time.tzset()
    yield
    if old is None:
        os.environ.pop("TZ", None)
    else:
        os.environ["TZ"] = old
    time.tzset()


def test_late_evening_due_date_is_that_day_in_denver(machine_in_tokyo):
    # 11:59 PM Mountain on Nov 3 is 06:59 UTC on Nov 4.
    assert cli._local_day("2026-11-04T06:59:00.000Z", cli._class_zone("America/Denver")) == date(2026, 11, 3)


def test_default_uses_configured_zone(monkeypatch):
    class Cfg:
        timezone = "America/Denver"

    monkeypatch.setattr(cli, "get_config", lambda: Cfg())
    assert cli._local_day("2026-11-04T06:59:00.000Z") == date(2026, 11, 3)
    # Daylight saving time: 11:59 PM MDT on Oct 20 is 05:59 UTC on Oct 21.
    assert cli._local_day("2026-10-21T05:59:00Z") == date(2026, 10, 20)


def test_no_zone_set_falls_back_to_machine(monkeypatch):
    class Cfg:
        timezone = ""

    monkeypatch.setattr(cli, "get_config", lambda: Cfg())
    assert cli._class_zone() is None
    from datetime import datetime

    expected = datetime.fromisoformat("2026-11-04T06:59:00+00:00").astimezone().date()
    assert cli._local_day("2026-11-04T06:59:00Z") == expected


def test_bad_values():
    assert cli._local_day(None) is None
    assert cli._local_day("not a date") is None
