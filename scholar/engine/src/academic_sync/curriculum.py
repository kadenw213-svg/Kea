"""The curriculum held to the syllabus (Kea, 2026-10-19).

A class's chapters (their sections, objectives and vocabulary) are what every textbook chapter and question bank is
written from, so a topic missing from them is a topic the student is never taught or quizzed on. This module checks a
class's chapters against what the syllabus says the course must teach:

- every required course outcome, module outcome and topical-outline item is taught by at least one chapter (saved by
  `outcome-add` with its chapters, or matched here by its words), and the chapter's notes actually carry it;
- every chapter the syllabus or schedule names has notes, and every chapter's notes are complete (title, sections,
  objectives, summary, reading link);
- the class's textbook is recorded, and when the class numbers chapters differently from the book (BIO1112's lecture
  chapters follow another book than the one the class uses), every chapter says where it is in the student's book and
  no reading link sends them to the wrong chapter;
- the instructor's guidelines for how the class is tested (formats, what exams draw on, allowed sheets) are recorded,
  so practice sets and textbook chapters are written to them.

Each problem has a stable key (dismissable with a reason, like coverage) and a severity: "fix" problems send Kea's
curriculum run to close them; "note" problems are shown but don't start a run.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from academic_sync.chapter_topics import canonicalize_chapter_label
from academic_sync.db import repository
from academic_sync.db.orm import CourseOutcomeRow
from academic_sync.models.domain import ChapterTopic, Course

KINDS = ("course", "module", "outline", "recommended")

_STOP = set(
    """a an and or the of to in on for with by from as at into onto its it this that these those their there be is are
    was were been being has have had do does using use used uses can will may might must should would could such
    including include includes etc e g i ii iii iv v vi vii viii ix x example examples different various other another
    each every all any both between among within without about after before during how what why when where which who
    whom whose student students able learn learning understand understanding knowledge apply applying applied
    describe describing explain explaining define defining list identify identifying discuss compare comparing
    contrast analyze analyzing interpret interpreting evaluate demonstrate demonstrating distinguish distinguishing
    recognize state solve solving perform performing write writing give given relate relating related relationship
    basic major general specific principles principle concepts concept introduction introductory topics topic
    module chapter unit course required recommended outcome outcomes overview terminology terms term new real world
    situations situation problems problem information clearly logically appropriate proper properly""".split()
)


def _stem(word: str) -> str:
    w = word.lower().strip("'’-")
    # (Every form of a word to one stem: isolation, isolating, isolated -> "isol".)
    for suf in ("izations", "ization", "ations", "ation", "ating", "ated", "ates", "ments", "ment", "ness", "ities", "ity",
                "ically", "ical", "ally", "ings", "ing", "ies", "al", "es", "ed", "s"):
        if len(w) > len(suf) + 3 and w.endswith(suf):
            w = w[: -len(suf)]
            break
    return w[:6]


def stems(text: str) -> set[str]:
    out: set[str] = set()
    for raw in re.findall(r"[A-Za-z][A-Za-z'’]+", text or ""):
        low = raw.lower()
        # (Short words count only when they're written as a term: pH, DNA, RNA, ATP.)
        if low in _STOP or (len(low) < 4 and not (raw[0].isupper() and any(c.isupper() for c in raw[1:])) and low != "ph"):
            continue
        out.add(_stem(low))
    return out


def chapter_text(t: ChapterTopic) -> str:
    return " ".join(
        [t.title or "", " ".join(t.sections or []), " ".join(t.objectives or []), " ".join(t.added_objectives or []),
         t.vocabulary or "", t.added_vocabulary or "", getattr(t, "summary", None) or ""]
    )


def _numbers(text: str) -> list[int]:
    return [int(n) for n in re.findall(r"(?:\bch(?:apter)?\.?\s*)(\d{1,3})", text or "", re.IGNORECASE)]


def outcome_rows(session: Session, course_id: str) -> list[CourseOutcomeRow]:
    return list(session.execute(select(CourseOutcomeRow).where(CourseOutcomeRow.course_id == course_id)).scalars())


def save_outcome(session: Session, course_id: str, kind: str, ref: str, text: str, chapters: list[str] | None,
                 not_tested: str | None, source: str | None) -> CourseOutcomeRow:
    row = session.execute(
        select(CourseOutcomeRow).where(CourseOutcomeRow.course_id == course_id, CourseOutcomeRow.kind == kind,
                                       CourseOutcomeRow.ref == ref)
    ).scalar_one_or_none()
    if row is None:
        row = CourseOutcomeRow(course_id=course_id, kind=kind, ref=ref, text=text)
        session.add(row)
    row.text = text
    # (An outcome saved again without chapters keeps the ones it has; "--chapter none" isn't a thing.)
    if chapters:
        row.chapters_json = chapters
    elif row.chapters_json is None:
        row.chapters_json = []
    if not_tested is not None:
        row.not_tested = not_tested.strip() or None
    if source or not row.source:
        row.source = source
    session.flush()
    return row


def _match(o_stems: set[str], corpus: dict[str, set[str]]) -> list[tuple[str, float]]:
    """Chapters whose notes carry an outcome's words: (label, share of the outcome's words found), best first."""
    if not o_stems:
        return []
    scored = sorted(((label, len(o_stems & s) / len(o_stems)) for label, s in corpus.items()), key=lambda x: -x[1])
    best = scored[0][1] if scored else 0
    if best < 0.5:
        return []
    return [(label, sc) for label, sc in scored if sc >= max(0.5, best * 0.8)][:4]


# Words that can come right before a mention of the class's own chapter on a line.
_LEAD = set("""read reading readings lecture lectures covers cover covered quiz quizzes exam exams test tests online review
    reviews textbook text book books start starts begin continue continued cont and of from on in for to see due week
    weeks day days class module unit units homework hw assignment assignments objectives guided funsheet funsheets
    practice notes slides midterm final before after by complete finish wrap up intro introduction topic topics section
    sections pp pages page through also then plus with the a an chapter chapters ch chs unit module modules monday tuesday wednesday thursday friday saturday
    sunday mon tue tues wed thu thur thurs fri sat sun jan feb mar apr may jun jul aug sep sept oct nov dec january
    february march april june july august september october november december""".split())


def syllabus_chapters(docs: list[tuple[str, str]], kind_word: str) -> dict[str, str]:
    """Chapter labels the syllabus and schedule name ("Chapter 23", ranges like "Chapters 23–24" and lists like
    "Chapters 25, 19, 27 & 28"), each with the document it was first seen in."""
    found: dict[str, str] = {}
    word = "modules?" if kind_word == "Module" else "units?" if kind_word == "Unit" else r"chapters?|chs?\.?"
    pat = re.compile(
        rf"\b(?:{word})\s*(\d{{1,2}})((?:\s*(?:[-–—]|to|through)\s*\d{{1,2}})?)((?:\s*(?:,|and|&)\s*\d{{1,2}}\b(?!\s*(?:pm|am|:)))*)",
        re.IGNORECASE,
    )
    for name, text in docs:
        for m in pat.finditer(text or ""):
            # Another book's chapters ("Inner Fish CH 3 Due") aren't the class's: a title word right before the
            # mention means it belongs to that title.
            line_start = (text or "").rfind(chr(10), 0, m.start()) + 1
            lead = re.findall(r"[A-Za-z]+", (text or "")[max(line_start, m.start() - 40):m.start()])[-3:]
            if any(w.lower() not in _LEAD for w in lead):
                continue
            nums = [int(m.group(1))]
            if m.group(2):
                end = int(re.findall(r"\d{1,2}", m.group(2))[0])
                if nums[0] < end <= nums[0] + 15:
                    nums = list(range(nums[0], end + 1))
            nums += [int(x) for x in re.findall(r"\d{1,2}", m.group(3) or "")]
            for n in nums:
                if 0 < n < 100:
                    found.setdefault(f"{kind_word} {n}", name)
    return found


def check(session: Session, course: Course, docs: list[tuple[str, str]]) -> dict[str, Any]:
    """The whole report for one class: chapters, outcomes (with the chapters that teach each), guidelines and
    problems. `docs` are the syllabus and schedule documents as (name, text)."""
    topics = repository.list_chapter_topics_for_course(session, course.id)
    by_key = {canonicalize_chapter_label(t.chapter_label): t for t in topics}
    corpus = {t.chapter_label: stems(chapter_text(t)) for t in topics}
    dismissed = set(repository.get_preference(session, "curriculum_dismissed", course_id=course.id, default=[]) or [])
    textbook = repository.get_preference(session, "textbook", course_id=course.id, default=None)
    guidelines = repository.get_preference(session, "study_guidelines", course_id=course.id, default=[]) or []
    problems: list[dict[str, str]] = []

    def problem(key: str, severity: str, text: str) -> None:
        if key not in dismissed:
            problems.append({"key": key, "severity": severity, "text": text})

    # --- The textbook, and where each chapter is in it ---
    renumbered = isinstance(textbook, dict) and textbook.get("numbering") == "different"
    if not textbook:
        problem("no_textbook", "fix", "The class's textbook isn't recorded (course-textbook): which book, and whether "
                "the class numbers chapters the way the book does.")

    # --- Each chapter's notes ---
    chapters_out = []
    for t in sorted(topics, key=lambda t: (int(re.findall(r"\d+", t.chapter_label)[0]) if re.findall(r"\d+", t.chapter_label) else 999, t.chapter_label)):
        missing = [name for name, val in (("title", t.title), ("sections", t.sections), ("objectives", t.objectives or t.added_objectives),
                                          ("summary", getattr(t, "summary", None)), ("reading link", t.reading_url)) if not val]
        if renumbered and not t.textbook_ref:
            missing.append("textbook chapter")
        if missing:
            problem(f"chapter_missing:{t.chapter_label}", "fix", f"{t.chapter_label} has no {', '.join(missing)}.")
        if not t.vocabulary and not t.added_vocabulary:
            problem(f"chapter_no_vocab:{t.chapter_label}", "note", f"{t.chapter_label} has no vocabulary.")
        # A reading link that names a chapter of the book: it must be the chapter this one really is in the book.
        if t.textbook_ref and t.reading_label:
            want = set(_numbers(t.textbook_ref))
            said = _numbers(t.reading_label)
            if want and said and said[-1] not in want:
                problem(f"reading_wrong_chapter:{t.chapter_label}", "fix",
                        f"{t.chapter_label}'s reading link says Ch. {said[-1]}, but in the textbook it is {t.textbook_ref}.")
        chapters_out.append({"label": t.chapter_label, "title": t.title, "textbook_ref": t.textbook_ref,
                             "sections": len(t.sections or []), "objectives": len(t.objectives or []) + len(t.added_objectives or []),
                             "missing": missing, "outcomes": []})
    by_label = {c["label"]: c for c in chapters_out}

    # --- Chapters the syllabus and schedule name ---
    kinds = {re.match(r"^(chapter|unit|module)", t.chapter_label.strip(), re.IGNORECASE) for t in topics}
    kind_word = next((m.group(1).capitalize() for m in kinds if m), "Chapter")
    named = syllabus_chapters(docs, kind_word)
    for label, where in sorted(named.items(), key=lambda x: int(x[0].split()[-1])):
        if canonicalize_chapter_label(label) not in by_key:
            problem(f"syllabus_chapter:{label}", "fix", f"The syllabus or schedule names {label} ({Path(where).name}), "
                    "but the class has no notes for it.")

    # --- Outcomes ---
    rows = outcome_rows(session, course.id)
    if not rows and docs:
        problem("no_outcomes", "fix", "None of the syllabus's outcomes or topical outline are recorded (outcome-add).")
    outcomes_out = []
    for r in sorted(rows, key=lambda r: (KINDS.index(r.kind) if r.kind in KINDS else 9, r.ref)):
        o_st = stems(r.text)
        chapters = [c for c in (r.chapters_json or [])]
        auto = False
        if not chapters and not r.not_tested:
            chapters = [label for label, _ in _match(o_st, corpus)]
            auto = bool(chapters)
        key = f"{r.kind}:{r.ref}"
        if not r.not_tested:
            if not chapters:
                problem(f"outcome_unmapped:{key}", "fix", f"No chapter teaches {r.kind} {r.ref}: \"{r.text}\".")
            bad = [c for c in chapters if c.lower() != "all" and canonicalize_chapter_label(c) not in by_key]
            if bad:
                problem(f"outcome_bad_chapter:{key}", "fix", f"{r.kind} {r.ref} names {', '.join(bad)}, which the class has no notes for.")
            real = [by_key[canonicalize_chapter_label(c)].chapter_label for c in chapters if canonicalize_chapter_label(c) in by_key]
            # The chapters it's given must carry it in their notes, or nothing is written or asked about it.
            if real and r.kind in ("outline", "recommended", "module") and o_st:
                cover = max(len(o_st & corpus[c]) / len(o_st) for c in real)
                if cover < 0.34:
                    problem(f"outcome_thin:{key}", "fix", f"{', '.join(real)} {'is' if len(real) == 1 else 'are'} given {r.kind} "
                            f"{r.ref} (\"{r.text}\"), but {'its' if len(real) == 1 else 'their'} notes barely mention it.")
            for c in real:
                by_label[c]["outcomes"].append(key)
        outcomes_out.append({"kind": r.kind, "ref": r.ref, "text": r.text, "chapters": chapters, "auto": auto,
                             "not_tested": r.not_tested, "source": r.source})
    if rows:
        for c in chapters_out:
            if not c["outcomes"] and not any((o["chapters"] or []) == ["all"] for o in outcomes_out):
                problem(f"chapter_no_outcome:{c['label']}", "note", f"No syllabus outcome is matched to {c['label']}.")

    # --- How the class is tested ---
    if not guidelines and docs:
        problem("no_guidelines", "fix", "The syllabus's guidelines for how the class is tested (exam formats, what exams "
                "draw on, allowed sheets or calculators, what's skipped) aren't recorded (guideline-add).")

    return {
        "course": course.course_code,
        "textbook": textbook,
        "chapters": chapters_out,
        "outcomes": outcomes_out,
        "guidelines": guidelines,
        "syllabus_chapters": sorted(named, key=lambda x: int(x.split()[-1])),
        "documents": [n for n, _ in docs],
        "problems": problems,
        "ok": not any(p["severity"] == "fix" for p in problems),
    }


def outcomes_for(session: Session, course_id: str) -> dict[str, list[str]]:
    """Each chapter's syllabus outcomes as text (for the textbook writer and question banks): chapter label ->
    ["Topical outline F.1.b: Gas laws (Boyle's, Charles', ...)", ...]. Outcomes for every chapter come under "all"."""
    topics = repository.list_chapter_topics_for_course(session, course_id)
    corpus = {t.chapter_label: stems(chapter_text(t)) for t in topics}
    names = {"course": "Course outcome", "module": "Module outcome", "outline": "Topical outline", "recommended": "Recommended topic"}
    out: dict[str, list[str]] = {}
    for r in outcome_rows(session, course_id):
        if r.not_tested:
            continue
        chapters = r.chapters_json or [label for label, _ in _match(stems(r.text), corpus)]
        line = f"{names.get(r.kind, r.kind)} {r.ref}: {r.text}"
        for c in chapters:
            key = "all" if c.lower() == "all" else next((t.chapter_label for t in topics if canonicalize_chapter_label(t.chapter_label) == canonicalize_chapter_label(c)), c)
            out.setdefault(key, []).append(line)
    return out


def syllabus_docs(paths: list[Path], load: Callable[[Path], str]) -> list[tuple[str, str]]:
    """The syllabus, schedule and calendar documents among a class's files, as (path, text)."""
    out = []
    for p in paths:
        if re.search(r"syllab|schedule|calendar|outline|important_dates", str(p), re.IGNORECASE) and not p.name.startswith("missing_from"):
            try:
                text = load(p)
            except Exception:  # noqa: BLE001
                continue
            if text and len(text.strip()) > 40:
                out.append((str(p), text))
    return out
