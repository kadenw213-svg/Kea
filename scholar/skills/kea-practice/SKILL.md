---
name: kea-practice
description: Write a practice exam (a bank of exam-style questions with answers and explanations) or a flashcard deck for a class topic, all at once, as one JSON file Kea saves, shuffles and grades itself. Kea runs it when the student asks for one.
user-invocable: true
---

# /kea-practice: a practice exam or flashcard deck

> **In Kea:** this run is unattended: never ask, never wait. **Be fast.** The student is watching a progress bar and
> expects about a minute or two. Kea has already done all the reading for you.

Arguments: `$ARGUMENTS` = Kea's brief (`data/study/requests/<id>.md`), optionally followed by `resume`.

You write the **whole set in one go**. Kea saves it, shuffles question order and choice order every time the student
takes it, samples shorter practice exams from it, and grades it itself. Students re-take sets many times with no
Claude, so every question must stand on its own and grade correctly by its stored answer alone.

## 1. Read the brief, and only the brief

Read the brief (one Read; it's short). It has the kind and count, the output file, what the test covers, every
chapter's objectives and vocabulary, and the text of the class's review material for those chapters (guided
readings, review sheets, FunSheets, study guides, the instructor's notes), already converted and trimmed by Kea.

That is enough. Do **not** open the class files, the request JSON, the textbook sources or the class site, and don't
browse or search. The only exceptions:
- Open a textbook source (path in the brief) only to check one fact you are genuinely unsure of, and read only the
  part you need (Grep it).
- If the set is for a test and the brief says no review material was found, but its review links name a review
  sheet or answer key, you may download that one file with `mcp__kea__d2l_download` (`path` =
  `<CODE>/review/<label>.pdf`) and read the `text_file` it returns. At most two downloads.

Call `mcp__kea__kea_progress` once after reading, with `percent` 20 ("Writing 25 questions on Chapters 5–6").

How to use the material, in this order of authority: the test's study focus and review material (every problem type
and topic on a review sheet becomes a question in the same style and difficulty), then each chapter's objectives
(each objective tested at least once in a set of 50 or more; spread fairly for smaller sets) and vocabulary (tested in
context, not as bare definitions). The student never sees the vocabulary and objective lists. This set is where
they're used.

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

Write `output` (inside `data/`) as JSON, **in one Write** (for more than 60 items, two parts: Write the first half,
then Edit to append the rest, calling `mcp__kea__kea_progress` with `percent` 55 in between):

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
0-based. Work each answer in your head as you write it; don't draft the set twice.

Then call `mcp__kea__kea_progress` with `percent` 90 and run `uv run academic-sync practice-check <output> --count
<count>` once. If it lists problems, fix just those with Edit and check again. Kea drops any malformed item itself, so
never rewrite the whole file.

With `resume`: if `output` already exists, keep its questions, add the rest, and check again.

## 5. Report

One line: how many questions or cards, the chapters covered, and which review material was used.
