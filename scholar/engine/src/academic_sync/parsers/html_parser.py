"""HTML parsing (D2L pages, syllabus pages rendered as HTML)."""

from __future__ import annotations

from bs4 import BeautifulSoup, NavigableString, Tag

from academic_sync.parsers.base import ParsedDocument, ParsedLink, ParsedTable

_NOISE_TAGS = {"script", "style", "nav", "footer", "noscript", "svg"}
_HEADING_TAGS = {"h1", "h2", "h3", "h4", "h5", "h6"}


def parse_html(html: str, *, base_title: str | None = None) -> ParsedDocument:
    soup = BeautifulSoup(html, "lxml")

    for tag in soup.find_all(list(_NOISE_TAGS)):
        tag.decompose()

    title = base_title
    if soup.title and soup.title.string:
        title = soup.title.string.strip()

    headings = [
        h.get_text(" ", strip=True)
        for h in soup.find_all(list(_HEADING_TAGS))
        if h.get_text(strip=True)
    ]

    links: list[ParsedLink] = []
    for a in soup.find_all("a", href=True):
        text = a.get_text(" ", strip=True)
        href = str(a["href"]).strip()
        if text and href and not href.startswith("javascript:"):
            links.append(ParsedLink(text=text, href=href))

    tables: list[ParsedTable] = []
    for table in soup.find_all("table"):
        headers = [th.get_text(" ", strip=True) for th in table.find_all("th")]
        rows = []
        for tr in table.find_all("tr"):
            cells = tr.find_all("td")
            if cells:
                rows.append([td.get_text(" ", strip=True) for td in cells])
        if rows:
            tables.append(ParsedTable(headers=headers, rows=rows))

    text = _extract_readable_text(soup)

    return ParsedDocument(text=text, title=title, headings=headings, links=links, tables=tables)


def _extract_readable_text(soup: BeautifulSoup) -> str:
    """Block-aware text extraction: preserves line breaks between block
    elements so downstream regex (dates, "due" sentences) doesn't glue
    unrelated lines together, which plain get_text() would do."""
    lines: list[str] = []

    def walk(node: Tag) -> None:
        for child in node.children:
            if isinstance(child, NavigableString):
                s = str(child).strip()
                if s:
                    lines.append(s)
            elif isinstance(child, Tag):
                if child.name in _NOISE_TAGS:
                    continue
                walk(child)
                if child.name in {
                    "p", "div", "li", "tr", "br", "h1", "h2", "h3", "h4", "h5", "h6",
                }:
                    if lines and lines[-1] != "":
                        lines.append("")

    body = soup.body or soup
    walk(body)

    out_lines: list[str] = []
    for line in lines:
        if line == "" and (not out_lines or out_lines[-1] == ""):
            continue
        out_lines.append(line)
    return "\n".join(out_lines).strip()
