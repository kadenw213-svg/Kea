from __future__ import annotations

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
