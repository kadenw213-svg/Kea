"""New-class detection for the daily run.

`/daily-overview` fetches D2L's enrollment list
(`GET /d2l/api/lp/<v>/enrollments/myenrollments/?orgUnitTypeId=3`) and
hands the raw `Items` to `academic-sync shells-check`. This module decides
which of those are real, accessible, not-yet-imported class shells -- the
ones that trigger an automatic first-time import (CLAUDE.md invariant 38,
amended 2026-10-07). Pure functions only.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

# e.g. "S_PPCC_BIO1112175_202720": institution prefix, subject+number,
# section, 6-digit term code. Non-class shells ("MyCourses Roadmap - Your
# Digital Backpack", "PPCC Student Government") never match.
_CLASS_CODE = re.compile(r"^S_[A-Z]+_([A-Z]{3,4})(\d{4})([A-Z0-9]*)_(\d{6})$")

# Subject prefixes that are never real classes worth importing.
_NON_CLASS_SUBJECTS = frozenset({"ORNT"})


@dataclass
class NewShell:
    org_unit_id: str
    course_code: str  # e.g. "BIO1112"
    section: str  # e.g. "175"
    term_code: str  # e.g. "202720"
    name: str
    start_date: str | None
    end_date: str | None
    home_url_path: str  # e.g. "/d2l/home/665290"


def find_new_shells(items: list[dict[str, Any]], registered_ids: set[str]) -> list[NewShell]:
    """Class shells the student can open that aren't imported yet.
    Past-term shells report `CanAccess: false` and are skipped, as are
    orientation/cross-listed/non-class shells."""
    out: list[NewShell] = []
    for item in items:
        org = item.get("OrgUnit") or {}
        access = item.get("Access") or {}
        ou = str(org.get("Id", ""))
        match = _CLASS_CODE.match(org.get("Code") or "")
        if not ou or match is None or ou in registered_ids:
            continue
        subject, number, section, term = match.groups()
        if subject in _NON_CLASS_SUBJECTS or not access.get("CanAccess", False):
            continue
        if not access.get("IsActive", True):
            continue
        out.append(NewShell(
            org_unit_id=ou,
            course_code=f"{subject}{number}",
            section=section,
            term_code=term,
            name=(org.get("Name") or "").strip(),
            start_date=(access.get("StartDate") or "")[:10] or None,
            end_date=(access.get("EndDate") or "")[:10] or None,
            home_url_path=f"/d2l/home/{ou}",
        ))
    return out
