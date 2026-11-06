"""PDF parsing via PyMuPDF, with an OCR fallback hook for scanned pages.

OCR is intentionally not implemented as a hard dependency -- see
docs/architecture.md. If a PDF yields near-zero extractable text, we flag it
rather than silently returning an empty document, so completeness analysis
can tell the difference between "no obligations in this PDF" and "we
couldn't read this PDF."
"""

from __future__ import annotations

import re

import pymupdf as fitz

from academic_sync.parsers.base import ParsedDocument, ParseError

MIN_CHARS_PER_PAGE_BEFORE_OCR_FLAG = 20

# A "Page N of M" footer sitting between two pages of a PDF creates a blank-
# line gap in the extracted text that has nothing to do with the document's
# actual structure -- but extraction/pipeline.py treats blank-line runs as
# block boundaries (see _iter_blocks), so an unstripped page break can
# silently sever a list item from its own due-date line just because they
# landed on different PDF pages. Collapsed to a single newline, not removed
# entirely, so real content on either side still gets its own line.
_PAGE_BREAK = re.compile(r"\n\s*Page\s+\d+\s+of\s+\d+\s*\n+", re.IGNORECASE)


def _strip_page_breaks(text: str) -> str:
    return _PAGE_BREAK.sub("\n", text)


def parse_pdf(path: str, *, base_title: str | None = None) -> ParsedDocument:
    try:
        doc = fitz.open(path)
    except Exception as exc:  # pragma: no cover - fitz raises various backends
        raise ParseError(f"Could not open PDF {path}: {exc}") from exc

    try:
        page_texts = [doc[i].get_text("text") for i in range(len(doc))]
        title = base_title or (doc.metadata.get("title") or None)
        headings = _extract_heading_like_lines(page_texts)
    finally:
        doc.close()

    text = _strip_page_breaks("\n\n".join(page_texts).strip())

    avg_chars_per_page = len(text) / max(len(page_texts), 1)
    likely_scanned = avg_chars_per_page < MIN_CHARS_PER_PAGE_BEFORE_OCR_FLAG

    parsed = ParsedDocument(text=text, title=title, headings=headings)
    if likely_scanned:
        parsed.headings.insert(0, "__OCR_FALLBACK_RECOMMENDED__")
    return parsed


def _extract_heading_like_lines(page_texts: list[str], max_len: int = 80) -> list[str]:
    """Heuristic heading detection for plain-text PDF extraction (no font
    metadata used here to keep this fast and dependency-light): short lines,
    title-cased or all-caps, not ending in typical sentence punctuation."""
    headings: list[str] = []
    for text in page_texts:
        for line in text.splitlines():
            stripped = line.strip()
            if not stripped or len(stripped) > max_len:
                continue
            if stripped.endswith((".", ",", ";")):
                continue
            if stripped.isupper() or (stripped[:1].isupper() and stripped.count(" ") <= 8):
                headings.append(stripped)
    return headings
