"""New-class detection for the daily run.

`/daily-overview` fetches D2L's enrollment list
(`GET /d2l/api/lp/<v>/enrollments/myenrollments/?orgUnitTypeId=3`) and
hands the raw `Items` to `academic-sync shells-check`. This module decides
which of those are real, accessible, not-yet-imported class shells -- the
ones that trigger an automatic first-time import (CLAUDE.md invariant 38,
amended 2026-10-07). Pure functions only.

A Canvas school's courses arrive in the same shape (Kea translates them),
marked `KeaPlatform: "canvas"` with their home page in `KeaHomePath`. Any
school's course codes are read the generic way ("BIO 1112-175", "BIO-1112",
"BIO1112.01 Fall 2026") when they aren't PPCC's own D2L codes.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date
from typing import Any

# e.g. "S_PPCC_BIO1112175_202720": institution prefix, subject+number,
# section, 6-digit term code. Non-class shells ("MyCourses Roadmap - Your
# Digital Backpack", "PPCC Student Government") never match.
_CLASS_CODE = re.compile(r"^S_[A-Z]+_([A-Z]{3,4})(\d{4})([A-Z0-9]*)_(\d{6})$")

# Any school's code: a subject (2-5 capitals) and a 3-4 digit number, optionally a letter, then maybe a section
# ("BIO 1112-175", "CHEM-1011", "ENG1021.02", "MATH 1340 01").
_GENERIC_CODE = re.compile(r"(?<![A-Z])([A-Z]{2,5})[ _.-]?(\d{3,4})([A-Z]?)(?![0-9])(?:[ _.-]+([A-Z]?\d{1,4}[A-Z]?))?(?![0-9])")
# Names of course shells that aren't classes (orientation, a sandbox, the library's resources...).
_NOT_A_CLASS = re.compile(r"\b(orientation|sandbox|training|resources?|advising|library|tutoring|student (government|success|life)|practice course|test course|onboarding)\b", re.IGNORECASE)

# Subject prefixes that are never real classes worth importing.
_NON_CLASS_SUBJECTS = frozenset({"ORNT"})
# Words before a number that are a term, year or section, not a subject ("Fall 2026", "SP 2027", "Sec 01").
_NOT_SUBJECTS = frozenset({"FALL", "SPR", "SPRNG", "SUM", "SUMR", "SUMM", "WIN", "WINT", "TERM", "YEAR", "SEM", "FA", "SP", "SU", "WI", "SEC", "CRN", "ID", "PART", "UNIT", "WEEK"})


def _generic_code(code: str, name: str) -> tuple[str, str, str, str] | None:
    """(subject, number, section, term) from any school's course code or, failing that, its name; None when neither
    names a class. The term isn't in a generic code: it's empty."""
    if _NOT_A_CLASS.search(name or "") and not _GENERIC_CODE.search((code or "").upper()):
        return None
    for text in (code or "", name or ""):
        for m in _GENERIC_CODE.finditer(text.upper()):
            subject, number, letter, section = m.groups()
            if subject in _NOT_SUBJECTS:
                continue
            return subject, number + letter, section or "", ""
    return None


@dataclass
class NewShell:
    org_unit_id: str
    course_code: str  # e.g. "BIO1112"
    section: str  # e.g. "175"
    term_code: str  # e.g. "202720"
    name: str
    start_date: str | None
    end_date: str | None
    home_url_path: str  # e.g. "/d2l/home/665290", or "/courses/1234" on Canvas
    platform: str = "d2l"  # "d2l" or "canvas"


def find_new_shells(items: list[dict[str, Any]], registered_ids: set[str],
                    today: date | None = None) -> list[NewShell]:
    """Class shells the student can open that aren't imported yet.
    Past-term shells usually report `CanAccess: false` and are skipped, as
    are orientation/cross-listed/non-class shells. A shell whose end date
    has passed is skipped too, even when it's still open (an "Incomplete"
    role keeps a finished class accessible for months): it's last year's
    class, not a new one."""
    today = today or date.today()
    out: list[NewShell] = []
    for item in items:
        org = item.get("OrgUnit") or {}
        access = item.get("Access") or {}
        ou = str(org.get("Id", ""))
        if not ou or ou in registered_ids:
            continue
        match = _CLASS_CODE.match(org.get("Code") or "")
        if match is not None:
            subject, number, section, term = match.groups()
        else:
            # (PPCC's own D2L codes always start "S_": anything else from its D2L isn't a class shell.)
            generic = None if (org.get("Code") or "").startswith("S_") else _generic_code(org.get("Code") or "", org.get("Name") or "")
            if generic is None or _NOT_A_CLASS.search(org.get("Name") or ""):
                continue
            subject, number, section, term = generic
        if subject in _NON_CLASS_SUBJECTS or not access.get("CanAccess", False):
            continue
        if not access.get("IsActive", True):
            continue
        end = (access.get("EndDate") or "")[:10]
        if end and end < today.isoformat():
            continue
        out.append(NewShell(
            org_unit_id=ou,
            course_code=f"{subject}{number}",
            section=section,
            term_code=term,
            name=(org.get("Name") or "").strip(),
            start_date=(access.get("StartDate") or "")[:10] or None,
            end_date=(access.get("EndDate") or "")[:10] or None,
            home_url_path=item.get("KeaHomePath") or f"/d2l/home/{ou}",
            platform=item.get("KeaPlatform") or "d2l",
        ))
    return out
