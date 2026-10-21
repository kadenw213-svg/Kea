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


def test_canvas_and_other_schools_codes_are_read_generically():
    # A Canvas school (Kea translates its courses into the same shape) and other schools' code styles.
    def canvas(cid, code, name, **access):
        return {"OrgUnit": {"Id": cid, "Code": code, "Name": name}, "Access": {"CanAccess": True, "IsActive": True, **access},
                "KeaPlatform": "canvas", "KeaHomePath": f"/courses/{cid}"}

    items = [
        canvas(555, "BIO 1112-175", "General Biology II", EndDate="2026-12-15T06:00:00Z"),
        canvas(556, "Orientation", "Student Orientation"),
        canvas(557, "2026FA-PSY-1001-03", "Intro to Psychology"),
        canvas(558, "", "MATH 1340 01 College Algebra"),
        canvas(559, "LIB 101", "Library Resources"),
        canvas(560, "Fall 2026 CHEM-1011", "Chemistry I"),
    ]
    shells = find_new_shells(items, set(), today=date(2026, 10, 20))
    assert [(s.org_unit_id, s.course_code, s.section, s.platform) for s in shells] == [
        ("555", "BIO1112", "175", "canvas"), ("557", "PSY1001", "03", "canvas"),
        ("558", "MATH1340", "01", "canvas"), ("560", "CHEM1011", "", "canvas")]
    assert shells[0].home_url_path == "/courses/555"


def test_ppcc_d2l_non_class_shells_stay_skipped():
    # PPCC's own D2L shells that aren't classes must not start reading as classes through the generic codes.
    items = [_item(1, "S_PPCC_XLC15627_crosslisted", name="ENG 0094 140 and ENG 1021 140 FA25"),
             _item(2, "State Student Advisory Council", name="State Student Advisory Council"),
             _item(3, "PPCC Student Government", name="Student Government")]
    assert find_new_shells(items, set()) == []
