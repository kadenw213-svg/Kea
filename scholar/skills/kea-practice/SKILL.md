---
name: kea-practice
description: Write a practice exam (a bank of exam-style questions with answers and explanations) or a flashcard deck for a class topic, all at once, as one JSON file Kea saves, shuffles and grades itself. Kea runs it when the student asks for one.
user-invocable: true
---

# /kea-practice: a practice exam or flashcard deck

> **In Kea:** read `CLAUDE.md` first. This run is unattended: never ask, never wait. Everything comes from the
> request, the files it names, and at most the review sheets the test links to (step 1). No web.

Arguments: `$ARGUMENTS` = the request file (`data/study/requests/<id>.json`), optionally followed by `resume`.

You write the **whole set in one go**. Kea saves it, shuffles question order and choice order every time the student
takes it, samples shorter practice exams from it, and grades it itself. Students re-take sets many times with no
Claude, so every question must stand on its own and grade correctly by its stored answer alone.

## 1. Read the request and its sources

The request (Read it) has:
- `kind`: `exam` (questions) or `cards` (flashcards); `count`: how many to write.
- `course`, and `item` when the set is for a specific test or assignment: its `title`, `type`, `study_focus` (what the
  instructor said the test covers) and `review_links`.
- `chapters`: each with `summary`, `sections`, `objectives`, `vocabulary`, and `textbook_source`, the Typst source of
  Kea's textbook chapter (plain text: Read it).
- `class_files`: text copies of the class's downloaded files (review sheets, FunSheets, study guides, handouts,
  syllabus) under `data/downloads/<CODE>/`.
- `output`: where to write the set.

Then read what the questions come from, in this order of authority:
1. **The test's own review material.** Every `study_focus` line. Every class file whose name matches a review link
   label, a chapter, or words like review, FunSheet, guided reading, study guide, practice, objectives, worksheet.
   A file marked `needs_text` has no text copy yet: run `uv run academic-sync doc-text <path>` and read the `.txt` it
   writes. If the item's `review_links` name a review sheet or its answer key ("Chapter 5 FunSheet", "… key", a
   study guide or practice test) that isn't among `class_files`, download it once with `mcp__kea__d2l_download`
   (`path` = `<CODE>/review/<label>.pdf`) and read the `text_file` it returns. A content link like
   `/d2l/le/content/<ou>/viewContent/<topicId>/View` is D2L's viewer page; download the file itself from
   `/d2l/le/content/<ou>/topics/files/download/<topicId>/DirectFileTopicDownload`. Skip links to
   pages that aren't documents (quiz lists, the class home) and reference sheets (periodic table, conversion chart).
   Never open other class-site pages. **Use 100% of this material:** every problem type and topic on a review sheet
   becomes at least one question, in the same style and difficulty, and answer keys are used to check your answers.
2. **Each chapter's objectives and vocabulary.** Every objective is tested by at least one question (for a set of 50
   or more), and key vocabulary is tested in context, not as bare definitions.
3. **The textbook chapter source**, for accurate facts, worked-example style and the course's notation.
4. `data/downloads/<CODE>/raw_notes.md`, if present, for how the instructor tests (format, emphasis).

The student never sees the vocabulary and objective lists. This set is where they're used.

## 2. Exam-style questions (`kind: exam`)

Write questions the way the course's real exams ask them. Mix the types the course uses (from `study_focus`, raw
notes and review sheets: "multiple choice, calculation problems and short essays"):
- `mc`: one correct choice of 4 (3 to 6 allowed). Distractors are wrong answers students really give: sign or unit
  slips, a confused look-alike term, a reversed relationship. Never "all/none of the above", "both A and B" or a
  choice that refers to other choices: Kea shuffles them.
- `multi`: "Select all that apply", 4 to 6 choices, 2 or more correct.
- `tf`: only where the course uses true/false; prefer `mc`.
- `num`: a calculation with a numeric answer: `answer` (number), `tolerance` (absolute; fit it to sensible
  rounding, such as 0.01 for an answer of 2.45), `unit`. The stem gives every value needed. Chemistry, math and
  physics sets should be at least 30% `num` when the course's tests are calculation-heavy.
- `short`: a short written answer or explanation (essay-style courses, "explain why"). `answer` is a model answer
  in 1 to 4 sentences, with the points a grader would look for. The student marks their own answer against it.

Every question has:
- `explain`: why the answer is right, in 1 to 3 sentences. For calculations, the worked solution, each step. For
  `mc`, also why the most tempting wrong choice is wrong.
- `chapter`: the chapter label it tests ("Chapter 5"); `topic`: the section or objective in a few words.
- `source`: where it came from: "FunSheet Ch 5", "Study focus", "Objective", "Textbook 5.3".

Balance and difficulty:
- Spread questions across the chapters in proportion to what the test covers (study focus first). For one chapter,
  cover every section.
- About 30% recall and recognition, 50% application (calculate, classify, predict, interpret), 20% harder multi-step
  or comparison questions, the hardest type the review sheets show.
- Each question tests one thing and doesn't give away another question's answer. No duplicates or near-duplicates
  (the same question with new numbers is fine for calculation types if you change what's asked).
- Plain text only, no LaTeX or Markdown. Use Unicode: x², x³, √, ≤, ≥, ≠, ±, π, Δ, →, ⇌, °, subscripts like H₂O and
  CO₂, superscripts like Na⁺ and SO₄²⁻, and fractions like (x + 1)/(x − 2).
- Be accurate: check every answer by working it, and keep the explanation's numbers consistent with the answer.

## 3. Flashcards (`kind: cards`)

- `front`: a term, a concept prompt ("What happens to a gas's volume when its temperature doubles at constant
  pressure?"), a structure, a formula's name, or a problem type ("How do you find the limiting reactant?").
- `back`: the answer in 1 to 3 sentences, or a short procedure. Include the key fact the exam asks.
- `chapter` on each card.
- Cover every vocabulary term and every objective of the chapters, plus every item on the test's review sheets. Mix
  term cards with how and why cards. No duplicates.

## 4. Write the file and check it

Write `output` (inside `data/`) as JSON:

```json
{ "questions": [
  { "type": "mc", "q": "…", "choices": ["…", "…", "…", "…"], "answer": 2, "explain": "…", "chapter": "Chapter 5", "topic": "Boyle's law", "source": "FunSheet Ch 5" },
  { "type": "multi", "q": "Select all that apply: …", "choices": ["…", "…", "…", "…", "…"], "answer": [0, 3], "explain": "…", "chapter": "…", "topic": "…", "source": "…" },
  { "type": "tf", "q": "…", "answer": false, "explain": "…", "chapter": "…", "topic": "…", "source": "…" },
  { "type": "num", "q": "…", "answer": 2.45, "tolerance": 0.02, "unit": "atm", "explain": "…", "chapter": "…", "topic": "…", "source": "…" },
  { "type": "short", "q": "…", "answer": "…", "explain": "…", "chapter": "…", "topic": "…", "source": "…" }
] }
```

or, for flashcards, `{ "cards": [ { "front": "…", "back": "…", "chapter": "Chapter 5" } ] }`. `answer` indexes are
0-based. For a large set, write it in parts (Write the first part, then Edit to append), not one huge write.

Then run `uv run academic-sync practice-check <output> --count <count>` and fix every problem it lists, until it says
`"ok": true`. Call `mcp__kea__kea_progress` at the start ("Writing 50 practice questions for CHE1011 Chapters 5–6")
and when you check the file.

With `resume`: if `output` already exists, keep its questions, add the rest, and check again.

## 5. Report

One line: how many questions or cards, the chapters covered, and which review sheets were used (or that none were
found).
