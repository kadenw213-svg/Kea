"""Where the engine may read and write: the workspace's own data folder, and nothing else.

Every path a command is given comes, in the end, from Claude (a scan or study run), and Claude reads course material
that anyone who can post in a class can write into. So a path argument is never trusted: it must resolve (symlinks and
`..` followed) inside the workspace's data folder, and file names the engine builds from words (a course code, an
image's name) are checked or cleaned first.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

from academic_sync.config import REPO_ROOT

# A course code as Kea and the engine use it in folder names: letters, digits, spaces, dots, underscores and hyphens,
# 1-40 characters, never "..", never a Windows device name (CON, NUL, COM1...: with or without an extension, any case)
# and never ending in a dot or space (Windows drops those, so "BIO1010." would be the folder "BIO1010"). The same rule
# is in Kea (electron/scholar/safePaths.cjs).
CODE_RE = re.compile(r"^[A-Za-z0-9 ._-]{1,40}$")
RESERVED_RE = re.compile(r"^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9]) *(\..*)?$", re.IGNORECASE)
# Set by Kea (or a test) in the engine's own environment: the data folder, when it isn't the workspace's data/. Read
# from the process environment only, never from a file in a folder a scan can write.
DATA_DIR_ENV = "KEA_ENGINE_DATA_DIR"


class UnsafePath(ValueError):
    """A path or name that would reach outside the workspace's data folder."""


def data_roots() -> list[Path]:
    """The folder paths may resolve into: the workspace's data/, fixed by where the engine itself is installed (or the
    folder Kea names in KEA_ENGINE_DATA_DIR). Never the database's folder: where the database is can be changed by
    settings, and settings must never widen where the engine reads and writes."""
    explicit = os.environ.get(DATA_DIR_ENV, "").strip()
    if explicit and Path(explicit).is_absolute():
        return [Path(explicit).resolve()]
    return [(REPO_ROOT / "data").resolve()]


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
    c = code if isinstance(code, str) else ""
    return (
        bool(CODE_RE.fullmatch(c))
        and ".." not in c
        and c.strip(" .") != ""
        and not c.endswith((".", " "))
        and not RESERVED_RE.fullmatch(c.strip())
    )


def safe_code(code: str | None) -> str:
    """The course code, when it's safe as a folder name; raises UnsafePath otherwise."""
    if not valid_code(code):
        raise UnsafePath(f"The course code {code!r} can't be used as a folder name (letters, digits, spaces, '.', '_' "
                         "and '-' only, at most 40, never '..', never a Windows device name like CON or NUL, and not "
                         "ending in a dot or space).")
    return code  # type: ignore[return-value]


def safe_stem(name: str | None, *, fallback: str = "file") -> str:
    """A plain file name stem: lowercase letters, digits and hyphens only, at most 60 characters."""
    stem = re.sub(r"[^a-z0-9-]+", "-", (name or "").lower()).strip("-")[:60].strip("-")
    return stem or fallback
