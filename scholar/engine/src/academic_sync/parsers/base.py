"""Parser interfaces.

A parser turns a raw file (HTML, PDF, or a plain-text D2L page dump) into a
ParsedDocument: plain text for downstream extraction, plus whatever
structure (headings, tables, links) survived and is worth keeping. Parsers
must be deterministic and must not make network calls -- fetching is the
caller's job (the import skill, using browser tools).
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field

PARSER_VERSION = "1.1.0"


@dataclass
class ParsedLink:
    text: str
    href: str


@dataclass
class ParsedTable:
    headers: list[str]
    rows: list[list[str]]


@dataclass
class ParsedDocument:
    text: str
    title: str | None = None
    headings: list[str] = field(default_factory=list)
    links: list[ParsedLink] = field(default_factory=list)
    tables: list[ParsedTable] = field(default_factory=list)
    parser_version: str = PARSER_VERSION

    @property
    def content_hash(self) -> str:
        return hashlib.sha256(self.text.encode("utf-8")).hexdigest()


class ParseError(Exception):
    pass
