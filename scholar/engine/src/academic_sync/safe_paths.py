"""Where the engine may read and write: the workspace's own data folder, and nothing else.

Every path a command is given comes, in the end, from Claude (a scan or study run), and Claude reads course material
that anyone who can post in a class can write into. So a path argument is never trusted: it must resolve (symlinks and
`..` followed) inside the workspace's data folder, and file names the engine builds from words (a course code, an
image's name) are checked or cleaned first.
"""

from __future__ import annotations

import re
from pathlib import Path

from academic_sync.config import REPO_ROOT, get_db_path

# A course code as Kea and the engine use it in folder names: letters, digits, spaces, dots, underscores and hyphens,
# 1-40 characters, never "..". The same rule is in Kea (electron/scholar/safePaths.cjs).
CODE_RE = re.compile(r"^[A-Za-z0-9 ._-]{1,40}$")


class UnsafePath(ValueError):
    """A path or name that would reach outside the workspace's data folder."""


def data_roots() -> list[Path]:
    """The folders paths may resolve into: the workspace's data/ (and the database's own folder, which is the same
    one unless a test points the database somewhere else)."""
    roots = [(REPO_ROOT / "data").resolve()]
    db_parent = get_db_path().parent.resolve()
    if db_parent not in roots:
        roots.append(db_parent)
    return roots


def _inside(path: Path, root: Path) -> bool:
    return path == root or root in path.parents


def inside_data(path: Path | str, *, what: str = "That file") -> Path:
    """The path, resolved, when it's inside the data folder; raises UnsafePath otherwise."""
    p = Path(path)
    resolved = p.resolve()
    for root in data_roots():
        if _inside(resolved, root):
            return resolved
    raise UnsafePath(f"{what} must be inside this workspace's data folder ({p} isn't).")


def inside(path: Path | str, root: Path | str, *, what: str = "That file") -> Path:
    """The path, resolved, when it's inside `root`; raises UnsafePath otherwise."""
    resolved = Path(path).resolve()
    if not _inside(resolved, Path(root).resolve()):
        raise UnsafePath(f"{what} must be inside {root}.")
    return resolved


def valid_code(code: str | None) -> bool:
    """Whether a course code is safe to use as a folder name."""
    return bool(code) and bool(CODE_RE.fullmatch(code or "")) and ".." not in (code or "") and (code or "").strip(" .") != ""


def safe_code(code: str | None) -> str:
    """The course code, when it's safe as a folder name; raises UnsafePath otherwise."""
    if not valid_code(code):
        raise UnsafePath(f"The course code {code!r} can't be used as a folder name (letters, digits, spaces, '.', '_' "
                         "and '-' only, at most 40, and never '..').")
    return code  # type: ignore[return-value]


def safe_stem(name: str | None, *, fallback: str = "file") -> str:
    """A plain file name stem: lowercase letters, digits and hyphens only, at most 60 characters."""
    stem = re.sub(r"[^a-z0-9-]+", "-", (name or "").lower()).strip("-")[:60].strip("-")
    return stem or fallback
