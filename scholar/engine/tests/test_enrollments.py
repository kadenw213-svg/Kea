from __future__ import annotations

from datetime import date

from academic_sync.enrollments import find_new_shells


def _item(ou, code, can=True, active=True, name="X"):
    return {"OrgUnit": {"Id": ou, "Code": code, "Name": name},
            "Access": {"CanAccess": can, "IsActive": active, "StartDate": "2027-01-20T00:00:00Z"}}


def test_new_accessible_class_shell_is_found_and_others_skipped():
    items = [
        _item(665290, "S_PPCC_BIO1112175_202720"),            # already imported
        _item(700001, "S_PPCC_BIO2101N1_202730", name="BIO2101 Anatomy"),  # new!
        _item(700002, "S_CCCS_ORNT1101_202730"),              # orientation
        _item(521295, "S_PPCC_BIO1111175_202620", can=False),  # past term
        _item(504294, "MyCourses Roadmap - Your Digital Backpack"),
        _item(533735, "S_PPCC_XLC15627_crosslisted"),
    ]
    shells = find_new_shells(items, {"665290"})
    assert [(s.org_unit_id, s.course_code, s.section, s.term_code) for s in shells] == [
        ("700001", "BIO2101", "N1", "202730")]
    assert shells[0].home_url_path == "/d2l/home/700001"


def test_finished_class_still_open_is_not_new():
    # An "Incomplete" role keeps a finished class open (CanAccess true) long after it ended.
    old = _item(452415, "S_PPCC_EMS1070EM6_202530")
    old["Access"].update({"StartDate": "2025-03-16T06:00:00.000Z", "EndDate": "2025-05-26T06:00:00.000Z"})
    coming = _item(700003, "S_PPCC_CHE1012N1_202730")
    coming["Access"]["EndDate"] = "2027-05-10T06:00:00.000Z"
    shells = find_new_shells([old, coming], set(), today=date(2026, 10, 17))
    assert [s.org_unit_id for s in shells] == ["700003"]
