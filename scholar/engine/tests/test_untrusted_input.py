"""Everything a scan's Claude hands the engine is untrusted: class content anyone in a class can write reaches it.

- Figures are JSON specs drawn by the engine; no script Claude writes is ever run (the old figure-script checker was
  bypassed with `from os import system`, `import os as o; o.spawnl(...)`, `startfile`, `plt.imsave(path)` and
  `savefig(fname=...)`).
- Every path argument resolves inside the workspace's data folder, and names and course codes used in paths are
  checked or cleaned.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import pytest
from typer.testing import CliRunner

from academic_sync import figure_spec, safe_paths, study_pdf
from academic_sync.cli import app

runner = CliRunner()


@pytest.fixture()
def data(tmp_path, monkeypatch):
    """A workspace data folder (tmp_path/data, with the database in it) and a folder outside it."""
    from academic_sync.config import clear_caches
    from academic_sync.db.migrations import run_migrations
    from academic_sync.db.session import get_engine, reset_engine_cache

    d = tmp_path / "data"
    d.mkdir()
    reset_engine_cache()
    monkeypatch.setenv("ACADEMIC_SYNC_DB_PATH", str(d / "test.db"))
    monkeypatch.setenv("KEA_ENGINE_DATA_DIR", str(d))
    clear_caches()
    run_migrations(get_engine(f"sqlite:///{(d / 'test.db').as_posix()}"))
    monkeypatch.setattr(study_pdf, "WORK_ROOT", d / "study_pdfs")
    outside = tmp_path / "outside"
    outside.mkdir()
    yield d, outside
    clear_caches()
    reset_engine_cache()


# ---------- Figures: no code runs ----------
POC_SCRIPTS = {
    "from os import system": "from os import system\nsystem('cmd /c echo pwned > {marker}')\n",
    "import os as o; o.spawnl": "import os as o\no.spawnl(o.P_WAIT, 'C:/Windows/System32/cmd.exe', 'cmd', '/c', 'echo pwned > {marker}')\n",
    "startfile": "import os as o\no.startfile('C:/Windows/System32/calc.exe')\nopen(r'{marker}', 'w').write('x')\n",
    "plt.imsave anywhere": "import numpy as np\nimport matplotlib.pyplot as plt\nplt.imsave(r'{marker}', np.zeros((2, 2)))\n",
    "savefig(fname=...)": "import matplotlib.pyplot as plt\nplt.plot([1])\nplt.savefig(fname=r'{marker}')\n",
}


@pytest.mark.parametrize("name", list(POC_SCRIPTS))
def test_old_plot_command_never_runs_a_script(data, name):
    d, outside = data
    work = d / "study_pdfs" / "BIO1010" / "2026-11-09"
    work.mkdir(parents=True)
    marker = outside / "pwned.png"
    script = work / "fig.py"
    script.write_text(POC_SCRIPTS[name].format(marker=marker), encoding="utf-8")
    result = runner.invoke(app, ["study-pdf-plot", str(script)])
    assert result.exit_code == 1
    assert "no longer runs scripts" in result.stdout
    time.sleep(0.2)
    assert not marker.exists()
    assert not (work / "img").exists()


@pytest.mark.parametrize("name", list(POC_SCRIPTS))
def test_script_text_in_a_spec_is_refused_not_run(data, name):
    d, outside = data
    work = d / "study_pdfs" / "BIO1010" / "2026-11-09"
    work.mkdir(parents=True)
    marker = outside / "pwned.png"
    code = POC_SCRIPTS[name].format(marker=marker)
    spec = work / "figures.json"
    # The script's text everywhere a spec takes a string: a formula, a label, the file name.
    spec.write_text(json.dumps({"figures": [
        {"file": "a.png", "items": [{"type": "function", "expr": code, "domain": [0, 1]}]},
        {"file": "b.png", "items": [{"type": "function", "expr": "x", "domain": [0, 1], "vars": {"k": code}}]},
        {"file": code, "items": []},
        {"file": "../../../outside/pwned.png", "items": []},
        {"file": str(marker), "items": []},
    ]}), encoding="utf-8")
    result = runner.invoke(app, ["study-pdf-figure", str(spec)])
    assert result.exit_code == 1
    out = json.loads(result.stdout)
    assert out["saved"] == [] and len(out["errors"]) == 5
    assert not marker.exists()
    assert list(outside.iterdir()) == []


@pytest.mark.parametrize("expr", [
    "__import__('os').system('calc')",
    "().__class__.__bases__[0].__subclasses__()",
    "x.__class__",
    "open('C:/Windows/win.ini')",
    "eval('1')",
    "(lambda: 1)()",
    "[c for c in ()]",
    "'text'",
    "sin.__self__",
    "getattr(x, 'y')",
    "exp(x, out=x)",
    "x if x else 1",
    "x[0]",
    "x := 1",
])
def test_formulas_only_know_arithmetic_and_math_functions(expr):
    with pytest.raises(figure_spec.SpecError):
        figure_spec.evaluate(expr, "expr", {"x": __import__("numpy").linspace(0, 1, 5)}, [])


def test_huge_powers_overflow_instead_of_hanging():
    import numpy as np

    start = time.monotonic()
    y = figure_spec.evaluate("9**9**9**9 + x", "expr", {"x": np.linspace(0, 1, 5)}, [])
    assert time.monotonic() - start < 2
    assert np.isnan(y).all()  # (infinity becomes a gap in the curve)


def test_spec_draws_into_its_own_img_folder(data):
    d, _ = data
    work = d / "study_pdfs" / "CHE1011" / "2026-11-09"
    work.mkdir(parents=True)
    spec = work / "figures.json"
    spec.write_text(json.dumps({"figures": [
        {"file": "titration.png", "xlabel": "Volume (mL)", "ylabel": "pH", "ylim": [0, 14], "items": [
            {"type": "function", "domain": [0, 50], "vars": {"c": "(2.5 - 0.1*x)/(25 + x)"},
             "expr": "where(c > 0, -log10(abs(c)), 14 + log10(abs(c)))"},
            {"type": "hspan", "from": 8.2, "to": 10, "color": "#d9534f"},
            {"type": "arrow", "from": [33, 4.6], "to": [25, 7], "text": "Equivalence point"},
        ]},
        {"file": "conics.svg", "layout": [1, 2], "panels": [
            {"aspect": "equal", "frame": "cross", "items": [
                {"type": "parametric", "x": "4*cos(t)", "y": "3*sin(t)", "t": [0, 6.3]},
                {"type": "implicit", "expr": "x^2/4 - y^2/9 - 1", "x": [-6, 6], "y": [-6, 6]}]},
            {"frame": "off", "items": [{"type": "circle", "center": [0, 0], "radius": 1, "fill": "navy", "alpha": 0.3},
                                       {"type": "text", "at": [0, 0], "text": "$\\Delta H$", "ha": "center"}]},
        ]},
    ]}), encoding="utf-8")
    result = runner.invoke(app, ["study-pdf-figure", str(spec)])
    assert result.exit_code == 0, result.stdout
    out = json.loads(result.stdout)
    assert [s["typst_path"] for s in out["saved"]] == ["img/titration.png", "img/conics.svg"]
    assert (work / "img" / "titration.png").stat().st_size > 1000
    assert (work / "img" / "conics.svg").is_file()


def test_spec_outside_the_study_pdf_folder_is_refused(data):
    d, outside = data
    for place in (outside, d):  # (inside data/ but not data/study_pdfs/ is refused too)
        spec = place / "figures.json"
        spec.write_text(json.dumps({"file": "x.png", "items": []}), encoding="utf-8")
        result = runner.invoke(app, ["study-pdf-figure", str(spec)])
        assert result.exit_code == 1
        assert not (place / "img").exists()


def test_unknown_fields_and_types_are_refused():
    for bad in ({"file": "x.png", "items": [{"type": "exec", "code": "1"}]},
                {"file": "x.png", "items": [{"type": "function", "expr": "x", "domain": [0, 1], "url": "file:///c:/"}]},
                {"file": "x.png", "usetex": True},
                {"file": "x.png", "items": [{"type": "text", "at": [0, 0], "text": "x", "color": "javascript:alert(1)"}]}):
        with pytest.raises(figure_spec.SpecError):
            figure_spec.render(bad, Path("unused"))


def test_matplotlib_never_reads_a_matplotlibrc_from_the_current_folder(tmp_path, monkeypatch):
    (tmp_path / "matplotlibrc").write_text("text.usetex: True\n", encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    plt = figure_spec._safe_matplotlib()
    assert plt.rcParams["text.usetex"] is False
    assert Path(os.environ["MATPLOTLIBRC"]).name == "matplotlibrc"
    assert Path(os.environ["MATPLOTLIBRC"]).parent != tmp_path


# ---------- Paths stay in data/ ----------
def _write(p: Path, text: str = "x") -> Path:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")
    return p


def test_extract_reads_only_files_in_data(data):
    d, outside = data
    add = runner.invoke(app, ["course", "add", "--code", "BIO1010", "--name", "Bio", "--term", "Fall 2026"])
    course_id = add.stdout.strip().split("id=")[-1]
    secret = _write(outside / "secret.txt", "Online Quiz 1\nDue on Aug 30, 2026 23:59\n")
    r = runner.invoke(app, ["extract", str(secret), "--course", course_id, "--source-type", "d2l_quizzes"])
    assert r.exit_code == 1 and "data folder" in r.stdout
    # (A `..` path that starts inside data/ and climbs out is the same thing.)
    sneaky = d / "downloads" / ".." / ".." / "outside" / "secret.txt"
    r = runner.invoke(app, ["extract", str(sneaky), "--course", course_id, "--source-type", "d2l_quizzes"])
    assert r.exit_code == 1
    inside = _write(d / "downloads" / "BIO1010" / "quizzes.txt", "Online Quiz 1\nDue on Aug 30, 2026 23:59\n")
    r = runner.invoke(app, ["extract", str(inside), "--course", course_id, "--source-type", "d2l_quizzes"])
    assert r.exit_code == 0, r.stdout


def test_doc_text_reads_and_writes_only_in_data(data):
    d, outside = data
    import docx

    doc = docx.Document()
    doc.add_paragraph("Syllabus text")
    doc.save(str(outside / "notes.docx"))
    r = runner.invoke(app, ["doc-text", str(outside / "notes.docx")])
    assert r.exit_code == 1
    assert not (outside / "notes.docx.txt").exists()
    # A path that doesn't exist outside answers the same as one that does (no way to probe the disk).
    r2 = runner.invoke(app, ["doc-text", str(outside / "nope.docx")])
    assert r2.exit_code == 1 and "data folder" in r2.stdout
    (d / "downloads").mkdir()
    doc.save(str(d / "downloads" / "notes.docx"))
    r = runner.invoke(app, ["doc-text", str(d / "downloads" / "notes.docx")])
    assert r.exit_code == 0, r.stdout
    assert (d / "downloads" / "notes.docx.txt").read_text(encoding="utf-8").strip() == "Syllabus text"


@pytest.mark.parametrize("args", [
    ["practice-check", "{f}"],
    ["shells-check", "--file", "{f}"],
    ["digest-ingest", "--file", "{f}"],
    ["export", "--output", "{f}"],
    ["d2l-reconcile", "--course", "BIO1010", "--dir", "{d}"],
])
def test_other_path_arguments_stay_in_data(data, args):
    d, outside = data
    runner.invoke(app, ["course", "add", "--code", "BIO1010", "--name", "Bio", "--term", "Fall 2026"])
    f = _write(outside / "x.json", "[]")
    r = runner.invoke(app, [a.format(f=f, d=outside) for a in args])
    assert r.exit_code == 1
    assert "data folder" in r.stdout
    assert f.read_text(encoding="utf-8") == "[]"


def test_study_pdf_source_must_be_in_the_study_pdf_folder(data):
    d, outside = data
    from academic_sync import cli

    typ = _write(outside / "main.typ", "= Hi")
    with pytest.raises(Exception) as err:
        cli._study_source(None, None, typ)
    assert getattr(err.value, "exit_code", None) == 1
    assert not (outside / "template.typ").exists()


@pytest.mark.parametrize("name,stem", [
    ("../../../../evil", "evil"),
    ("..\\..\\evil", "evil"),
    ("C:/Windows/evil", "c-windows-evil"),
    ("ok-name", "ok-name"),
    ("", "file"),
    ("....", "file"),
])
def test_names_become_plain_file_stems(name, stem):
    assert safe_paths.safe_stem(name) == stem


def test_commons_image_name_never_leaves_the_img_folder(tmp_path, monkeypatch):
    monkeypatch.setattr(study_pdf, "_commons_get", lambda params: {"query": {"pages": {"1": {"title": "File:X.png"}}}})
    monkeypatch.setattr(study_pdf, "_image_info", lambda page: {"thumb_url": "https://upload.example/a/b/x.png/../../.bat"})
    monkeypatch.setattr(study_pdf, "_open", lambda url, timeout: b"img")
    dest = tmp_path / "week" / "img"
    for name in ("../../../evil", "..\\..\\evil", None):
        info = study_pdf.commons_fetch("File:../../evil.png" if name is None else "File:X.png", dest, name)
        saved = Path(info["path"])
        assert saved.parent == dest
        assert saved.suffix == ".png"
    files = [p for p in tmp_path.rglob("*") if p.is_file()]
    assert files and all(p.parent == dest for p in files)


def test_study_pdf_image_get_name_is_sanitized(data, monkeypatch):
    seen = {}

    def fake_fetch(title, dest, name):
        seen["name"] = name
        raise ValueError("stop here")

    monkeypatch.setattr(study_pdf, "commons_fetch", fake_fetch)
    from academic_sync import cli

    monkeypatch.setattr(cli, "_banner_or_exit", lambda session, banner: type("B", (), {"course_id": "c"})())
    monkeypatch.setattr(cli.repository, "get_course", lambda session, cid: type("C", (), {"course_code": "BIO1010"})())
    monkeypatch.setattr(study_pdf, "work_dir", lambda course, item: Path("unused"))
    runner.invoke(app, ["study-pdf-image", "get", "File:X.png", "--banner", "b", "--name", "..\\..\\..\\evil"])
    assert seen["name"] == "evil"


@pytest.mark.parametrize("code,ok", [
    ("BIO1010", True), ("BIO 1010", True), ("MAT-1340.01_A", True),
    ("BIO1010\\..\\..\\x", False), ("BIO1010/../../x", False), ("..", False), ("a..b", False), ("", False),
    ("x" * 41, False), ("BIO:1010", False), (" . ", False), ("CON", False),
])
def test_course_codes_used_in_paths(code, ok):
    assert safe_paths.valid_code(code) is ok


def test_study_pdf_folders_refuse_a_traversing_course_code(tmp_path):
    from datetime import date

    course = type("C", (), {"course_code": "BIO1010\\..\\..\\x"})()
    banner = type("B", (), {"date": date(2026, 11, 9)})()
    with pytest.raises(safe_paths.UnsafePath):
        study_pdf.work_dir(course, banner)
