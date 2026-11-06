"""What a scan's Claude can write (files under data/) never changes where the engine reads and writes.

A run may write data/**, and `cd data && uv run academic-sync ...` starts the engine from that folder. A `.env` there used
to set ACADEMIC_SYNC_DB_PATH, and the database's folder used to count as an allowed root, so one file reached the whole
computer. Now settings come from the process environment only, and the allowed root doesn't depend on settings at all.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from academic_sync import safe_paths
from academic_sync.config import REPO_ROOT, Settings, clear_caches, get_db_path


@pytest.fixture()
def planted(tmp_path, monkeypatch):
    """A folder with a planted .env, as the current folder, and a folder outside the workspace it points at."""
    victim = tmp_path / "victim"
    victim.mkdir()
    folder = tmp_path / "workspace" / "data"
    folder.mkdir(parents=True)
    (folder / ".env").write_text(
        f"ACADEMIC_SYNC_DB_PATH={victim / 'x.db'}\nACADEMIC_SYNC_CONFIG_PATH={victim / 'c.yaml'}\nD2L_BASE_URL=https://evil.example/\n",
        encoding="utf-8",
    )
    monkeypatch.chdir(folder)
    monkeypatch.delenv("ACADEMIC_SYNC_DB_PATH", raising=False)
    monkeypatch.delenv("ACADEMIC_SYNC_CONFIG_PATH", raising=False)
    monkeypatch.delenv("D2L_BASE_URL", raising=False)
    monkeypatch.delenv(safe_paths.DATA_DIR_ENV, raising=False)
    clear_caches()
    yield victim
    clear_caches()


def test_a_dotenv_in_the_current_folder_is_never_read(planted):
    s = Settings()
    assert s.academic_sync_db_path is None
    assert s.academic_sync_config_path is None
    assert s.d2l_base_url is None
    assert planted not in get_db_path().parents


def test_a_dotenv_never_widens_the_allowed_folder(planted):
    assert safe_paths.data_roots() == [(REPO_ROOT / "data").resolve()]
    for p in [planted / "secret.txt", planted / "Startup" / "evil.cmd"]:
        with pytest.raises(safe_paths.UnsafePath):
            safe_paths.inside_data(p)


def test_where_the_database_is_never_widens_the_allowed_folder(planted, monkeypatch):
    # Even the real environment variable: it moves the database, not what paths may reach.
    monkeypatch.setenv("ACADEMIC_SYNC_DB_PATH", str(planted / "x.db"))
    clear_caches()
    assert get_db_path() == planted / "x.db"
    assert safe_paths.data_roots() == [(REPO_ROOT / "data").resolve()]
    with pytest.raises(safe_paths.UnsafePath):
        safe_paths.inside_data(planted / "secret.txt")


def test_only_kea_names_another_data_folder(planted, monkeypatch, tmp_path):
    other = tmp_path / "other"
    other.mkdir()
    monkeypatch.setenv(safe_paths.DATA_DIR_ENV, str(other))
    assert safe_paths.data_roots() == [other.resolve()]
    assert safe_paths.inside_data(other / "a.txt") == (other / "a.txt").resolve()
    with pytest.raises(safe_paths.UnsafePath):
        safe_paths.inside_data(REPO_ROOT / "data" / "a.txt")
    # (A relative one is ignored: it would depend on the current folder.)
    monkeypatch.setenv(safe_paths.DATA_DIR_ENV, "elsewhere")
    assert safe_paths.data_roots() == [(REPO_ROOT / "data").resolve()]
    # (And a .env can't name it: it's read from the process environment only.)
    monkeypatch.delenv(safe_paths.DATA_DIR_ENV)
    Path(".env").write_text(f"{safe_paths.DATA_DIR_ENV}={planted}\n", encoding="utf-8")
    assert safe_paths.data_roots() == [(REPO_ROOT / "data").resolve()]


@pytest.mark.parametrize(
    "code",
    ["CON", "con", "Prn", "AUX", "nul", "COM1", "com9", "LPT1", "lpt9", "CON.txt", "nul.tar.gz", "Aux.", "CON .txt", "BIO1010.", "BIO1010 "],
)
def test_windows_device_names_and_a_final_dot_or_space_are_refused(code):
    assert not safe_paths.valid_code(code)
    with pytest.raises(safe_paths.UnsafePath):
        safe_paths.safe_code(code)


@pytest.mark.parametrize("code", ["BIO1010", "BIO 1010", "CHEM 1110-002", "MAT1340.01", "ENG_1022", "CON 101", "CONX", "COM10", "AUX1010"])
def test_ordinary_codes_stay_valid(code):
    assert safe_paths.safe_code(code) == code
