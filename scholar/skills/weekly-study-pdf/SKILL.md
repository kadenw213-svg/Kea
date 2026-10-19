---
name: weekly-study-pdf
description: Write the week's study textbook: a 10-15 page, textbook-style PDF per class covering every chapter on that week's banner, saved to the class's textbook in Kea and named for its chapters. Kea runs it for banners about to start.
user-invocable: true
---

# /weekly-study-pdf -- the week's reading, as a textbook

> **In Kea:** read `CLAUDE.md` → "Running inside Kea" first. It replaces Chrome with Kea's `mcp__kea__d2l_*` tools,
> Google Calendar with `record-sync ... --calendar-id kea`, and email with `mcp__kea__kea_notify`, and runs are
> unattended (no questions, no approval gates). Everything else below applies as written.

Arguments: `$ARGUMENTS` (optional: a banner id to build/rebuild one week; empty means
"every banner that is due"). CLAUDE.md invariant 41 governs this skill.

This PDF is the user's **only** study material. They read it start to finish, and if they
understand every page they should be ready for that week's assignments and the tests it
feeds. They read it in Kea, where highlighting any word or phrase shows its
definition and Wikipedia's explanation. So spend words on what a lookup can't give:
mechanisms, how things connect, how to solve each problem type, comparisons, and what the
exam asks. Don't spend them re-defining everyday words.

Never touches Calendar, D2L or email. All dates and titles come from the bundle, verbatim.

## 1. What's due

```
uv run academic-sync study-pdf-due            # or: --banner <id> for one week
```

Prints a JSON list of bundles (empty list -> say so and stop). Each bundle has: `course`,
`week`, `chapters` (the banner's chapters plus any saved chapter that week's lectures are
titled with, so the PDF never trails the class; each with label, title, `sections`, `vocabulary_terms`, `objectives`,
`added_objectives`, `already_in_pdfs`), the banner `links`, `due_this_week`,
`tests_next_3_weeks` (with `covered_chapters` / `study_focus`), `pdf_title`, `work_dir`,
`source_path` (where `main.typ` goes) and `output_path`.

**The syllabus.** Each chapter also has `syllabus_outcomes` (the course outcomes, module outcomes and topical-outline
items it must teach: teach every one, by name, with worked examples where it's a skill) and `textbook_ref` (where the
chapter is in the student's own book, when the class numbers chapters differently: cite that, never the same-numbered
chapter of the book). `course_outcomes` are skills every chapter serves (significant figures, reading graphs): use
them in examples and practice. `guidelines` are how the class tests (formats, what exams draw on, allowed sheets):
the chapter's practice questions and "what the exam asks" follow them.

**Kea's chapter notes (read the one for each chapter you write):**
`data/study/notes/<CODE>/<Chapter N>.md`. Kea builds them before this run, from what the scans saved: the
chapter's objectives and vocabulary, the text of its review material (the instructor's **guided reading**, a
fill-in outline of exactly what students must know; **FunSheets** and their answer keys, the problems the exams
copy), and **Tests on this chapter**: every test that covers it, any date, the final included, with the
instructor's study focus. This is what the course will actually ask, so the chapter must teach all of it.

Also read `data/downloads/<CODE>/raw_notes.md` for course context (instructor emphasis,
lab topics, how the course is run).

**Kea's missing-chapters mode.** Kea writes every chapter of a class, not only the coming
week's: `uv run academic-sync study-pdf-due --missing [--course <CODE>]` lists, for every
chapter with no PDF yet, the first unbuilt week that teaches it. Kea then runs this skill as
`/weekly-study-pdf <banner id> only <labels>`. In that case run
`uv run academic-sync study-pdf-due --banner <id> --only "<labels>"`: the bundle's
`chapters` (and `pdf_title`) hold only the chapters to write. The week's other chapters
already have PDFs; don't teach them again (mention them in one line if the new chapter
builds on them). Always build a full PDF in this mode: never a review, never a skip. When the student presses **Rewrite** in Kea,
the chapter's `already_in_pdfs` names its old PDF, which this one replaces: write it fresh to the current guidelines
(you may Read the old `main.typ` in `work_dir` to keep what was good, but meet every rule in this file).

**Continuing a stopped run** (`resume` in the arguments): an earlier run stopped partway. A chapter whose `main.typ`
is already in `work_dir` is half written: Read it, keep what's there and finish it, then check and build as usual.
Never start a written chapter over.

**Weeks already over** (`week_is_past` true): leave out the `= This Week` section and the
`#due` lines (those dates are history). Keep each chapter's exam-style material: tests
still to come that cover it (from `tests_next_3_weeks`, or the course's later exams) go in
`#exam` notes.

## 2. Build, review, or skip

- **New chapters** (any chapter with empty `already_in_pdfs`): build the full PDF.
- **Every chapter already has a PDF** (a chapter running two or three weeks, like MAT1340
  Ch 4) and **a test falls this week or next**: build an exam-review PDF instead, 8-12
  pages. It covers the material the test covers, organized the way the test will ask it,
  with more worked problems and practice questions, and it names the earlier PDFs to reread.
- **Every chapter already has a PDF and no test is near**: skip it:
  `uv run academic-sync study-pdf-skip --banner <id> --reason "Ch 4 already in <file>; no test"`.
- A chapter with no saved topic (no sections, terms or objectives): still teach it, from
  the textbook's own structure for that chapter, and say so in step 7's report.

## 3. Plan the outline (before writing)

- One level-1 heading per chapter (`= Chapter 32 -- An Overview of Animal Diversity`).
- Level-2 headings follow the chapter's real `sections`, numbered the way the textbook numbers
  them (`== 6.3 Concentration Based on Moles`). With no saved sections, use the textbook's
  own concept/section structure for that chapter number.
- Map **every** objective (sourced and added) to the section that teaches it, and every
  vocabulary term to where it is first explained. Nothing may be left unmapped.
- From the chapter notes, map too: every blank and question of the guided reading (a student filling it in from
  this PDF must find every answer, in plain words), every problem type on the FunSheets (each gets a fully worked
  example, solved the way the answer key solves it), and every study-focus line of every test on the chapter
  (taught where it belongs and flagged with `#exam[...]`).
- Pick the week's problem types (MAT/CHE: every type the homework and tests use) and
  plan at least one fully worked example for each.

## 4. Write `main.typ` in `work_dir`

Start with:

```typst
#import "template.typ": *
#show: textbook.with(course: "CHE1011", course-name: "<course name>",
  title: "<pdf_title>", week: "<week.display>")
```

`study-pdf-build` copies the shared template in, so don't write your own styles.
Template pieces (all in `src/academic_sync/study_pdf_template.typ`):

| Piece | Use |
|---|---|
| `#term[...]` | a vocabulary term at the point it's first explained. Every term in `vocabulary_terms` gets one. |
| `#keyidea[...]` | the one idea a section depends on. At most one per section. |
| `#example[title][...]` | a worked problem, every step shown, with the reasoning for each step. |
| `#exam[...]` | what the week's tests/study guide stress here (from `study_focus`, objectives, test titles). |
| `#pitfall[...]` | a mistake students really make (sign errors, unit slips, confused look-alike terms). |
| `#fig("img/x.png", caption: [...], credit: "...")` | a figure. `credit` is required for anything downloaded. |
| `#due([Mon Oct 19, 11:59 pm], [<real title>], kind: "quiz")[note]` | one item in This Week. |
| `#table(...)` | comparisons (phyla traits, gas laws, log rules). Header row first. |

### Structure

1. `= This Week`, about half a page. Everything in `due_this_week` as `#due` lines, with
   real titles, dates and times. Then the tests in `tests_next_3_weeks`, each with what it
   covers and which sections of this PDF to know cold. Copy titles and dates exactly;
   never add an item that isn't in the bundle.
2. One chapter after another. For each section: teach the idea, then show how it works,
   then show how it's tested. End each chapter with a summary table where the material is
   comparative. **No self-check or practice-question section:** Kea keeps a 50-question bank for every chapter
   (the student presses Quiz me beside the textbook), so the pages go to teaching.
3. If a test is this week, finish with `= Exam Prep: <test title>`: what it covers, the
   problem types, and the facts to memorize, as tight lists.

### The quality bar: beat what the course requires, by a margin

The required list (objectives, vocabulary, guided-reading blanks, FunSheet problem types, every test's study focus)
is the floor, not the target. A student who reads only this PDF should be able to answer anything on those lists
*and* the slightly harder versions an instructor writes for an exam. For every required item:
- **Answer it outright, then go one step further:** the why behind it, the condition where it stops being true, and
  how it connects to the item next to it (Henry's law → why divers get the bends; Le Chatelier → why a catalyst
  doesn't shift equilibrium).
- **Every problem type gets two worked examples:** one typical, matching the FunSheet or homework, and one with a
  twist the exam could add (a unit conversion first, a missing value to find, a reversed question, a real-world
  setting). Numbers differ from the review sheets so the student learns the method, not the answer.
- **Every application the course names gets a concrete example** (fermentation, ocean acidification, blood
  buffers, IV solutions…): what happens, written as the chemistry, not just named.
- **Notation the exams use is taught explicitly**, with a line on reading it (phase labels (s), (l), (g), (aq);
  significant figures in each answer; units carried through every step).
- **Final pass:** re-read each chapter as the student the night before the exam. If any question you can imagine
  from the focus lines would send them to another source, add what's missing.

### Depth (the most important part)

- **Teach every objective completely.** For "explain how X leads to Y", give the
  mechanism step by step and say why each step happens. For "compare A and B", give a
  table plus the deciding difference. For "calculate", give the formula, its units, and a
  worked example.
- **Every vocabulary term** is explained in context (enforced by `study-pdf-check`). It
  must be taught in a sentence that uses it. A bare list of terms doesn't count, so never
  pad one in to pass the check.
- **Math and chemistry: worked examples carry the chapter.** Show every algebra step and
  unit conversion. Include a variety: easy, typical, and the hardest type the homework
  asks. Use real Typst math (`$log_b (x y) = log_b x + log_b y$`).
- **Biology:** structures, processes and evolutionary relationships, with the classic
  examples the textbook uses. Phylogenies and body plans get figures or tables.
- **English:** the module's actual skills as procedures (how to find a scholarly
  article, how to evaluate a source, how to build a thesis), with short before/after
  examples, plus what the module's assignments ask for.
- **No fluff:** no "In this chapter we will...", no motivational lines, no restating
  the same summary twice, no history unless the course tests it. Every paragraph
  should teach something.
- **Accuracy:** you are writing for exams. Follow the textbook's standard treatment and
  notation. When unsure of a detail the course might test, check it (WebFetch a reliable
  open source: OpenStax, LibreTexts, the chapter's `reading_url` if public) rather than
  guessing.
- **Length:** 10-15 pages (about 4,500-7,500 words plus figures); a single heavy chapter may run to 18,
  two heavy chapters up to 20. Meeting the quality bar comes first; never pad a thin chapter to reach the target.

### Images (4-8 per PDF, each one earning its place)

1. **Drawn for the PDF.** Graphs, function plots, phase diagrams, titration curves, data
   plots. Write a matplotlib script in `work_dir` (e.g. `fig_exp.py`, saving PNGs at
   200 dpi into `img/`, clean white style, labeled axes), then run
   `uv run academic-sync study-pdf-plot <work_dir>/fig_exp.py`. No credit needed. Kea reads the script before
   running it: import only math, numpy, matplotlib, random and os (for `os.makedirs("img", exist_ok=True)` only),
   and save with a plain literal path, `plt.savefig("img/name.png", dpi=200)`. Anything else is refused.
2. **Wikimedia Commons.** For anatomy, organisms, structures and lab equipment:
   `uv run academic-sync study-pdf-image search "<words>"`, then
   `uv run academic-sync study-pdf-image get "File:<name>" --banner <id> --name <stem>`.
   Only freely licensed files are returned. Pass the printed `credit` to `#fig`.
   - Search with 1-3 words ("coelom", "polyp medusa"); long queries return nothing.
   - OpenStax textbook figures are on Commons with English labels, CC BY 4.0, named
     `Figure <chapter> <section> <n>` (e.g. search "Figure 27 02" for OpenStax Biology
     section 27.2). They're usually the best diagrams available.
   - Commons rate-limits bursts. Leave ~8 seconds between `get` calls. If a call says
     "rate-limiting", wait the minutes it names, or write the text first and come back.
3. **Open every image before using it** (Read the file). It must show what the caption
   says, be legible at page width, and have English labels (a diagram labeled in another
   language is out). Write the caption from what the image actually shows: if it uses
   letters or colors instead of labels, the caption gives the key.
4. Figures float to the top or bottom of a page so they never strand white space; refer to
   them by content ("the cross-sections below"), not "the next figure".

### Typst gotchas

- In prose, escape `#`, `$`, `@`, `<`, `*`, `_` and `\` with a backslash when you mean
  the literal character.
- Chemical formulas: `H#sub[2]O`, `CO#sub[2]`, `Na#super[+]`; or in math,
  `$"H"_2"O"$`. Reactions use `→` / `⇌` directly.
- Math: `$x^2$`, `$frac(a, b)$`, `$sqrt(x)$`, `$log_2 8 = 3$`, `$e^(k t)$`. Put a space
  between single-letter variables (`$k t$`, not `$kt$`).

## 5. Check coverage

```
uv run academic-sync study-pdf-check --banner <id>
```

It lists any saved vocabulary terms the text never uses. Teach each one properly where it
belongs, then re-run until the list is empty. Then re-read your map from step 3 and confirm,
item by item, that each objective, guided-reading blank, FunSheet problem type and test
study-focus line is taught, not just mentioned, to the quality bar in step 4 (problem types with two worked
examples, applications with a concrete example). Fix any gap before building.

## 6. Build and look at it

```
uv run academic-sync study-pdf-build --banner <id>
uv run academic-sync study-pdf-preview --banner <id>            # contact sheet of every page
uv run academic-sync study-pdf-preview --banner <id> --pages 5,9  # chosen pages at reading size
```

- Compile errors come back with line numbers. Fix them and rebuild.
- `warning` set means the page count is outside the target. Fix real gaps (or cut
  repetition) rather than ignoring it.
- Read the contact sheet, then one or two pages at reading size: no half-empty pages
  (shrink a figure's `width` if one won't fit), no overflowing tables or equations, no
  stray markup.

The PDF lands at `output_path` (KEA_TEXTBOOK_DIR/<CODE>/<chapters>.pdf, the class textbook in Kea).
Rebuilding the same banner overwrites it in place.

## 7. Chapter summaries

For each chapter the PDF teaches, save the short description students see in Kea. They
see this, a link to the reading and the class's review documents; never the vocabulary or
objective lists, which stay internal (Kea uses them for flashcards and practice exams).

```
uv run academic-sync chapter-summary-set --course <CODE> --chapter "<label>" --summary "<text>"
```

Two or three plain sentences (at most about 60 words): what the chapter teaches and the
main skills or ideas the course tests from it. No lists of terms, no "In this chapter".
Example: "How gases, liquids and solids differ, and the gas laws that predict pressure,
volume and temperature. Most exam questions are gas-law calculations and choosing which
intermolecular force explains a boiling point."

## 8. Report

One line per PDF: course, file name, pages, figure count, and anything thin (a chapter with
no saved objectives, a figure you couldn't find). Unattended runs end there.