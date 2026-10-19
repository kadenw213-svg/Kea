---
name: kea-practice
description: Write a practice exam (a bank of exam-style questions with answers and explanations) or a flashcard deck for a class topic, all at once, as one JSON file Kea saves, shuffles and grades itself. Kea runs it when the student asks for one.
user-invocable: true
---

# /kea-practice: a practice exam or flashcard deck

> **In Kea:** this run is unattended: never ask, never wait. **Be fast.** The student is watching a progress bar and
> expects about a minute or two. Kea has already done all the reading for you.

**Question banks.** When the brief's title says "Question bank", the set is that chapter's standing bank (Quiz me
beside its textbook, the questions practice exams draw on): cover every section of the chapter, every objective and
every review-sheet problem type, not just the test focus.

Arguments: `$ARGUMENTS` = Kea's brief (`data/study/requests/<id>.md`), optionally followed by `resume`.

You write the **whole set in one go**. Kea saves it, shuffles question order and choice order every time the student
takes it, samples shorter practice exams from it, and grades it itself. Students re-take sets many times with no
Claude, so every question must stand on its own and grade correctly by its stored answer alone.

## 1. Read the brief, and only the brief

Read the brief (one Read; it's short). Kea built it from what the scans learned, in this order:
1. **What the real tests cover**: each test on these chapters with the instructor's study focus, scraped from the
   class site (format, allowed sheets, the exact problem types on each FunSheet).
2. Each chapter's internal notes: summary, sections, objectives and vocabulary.
3. The review material for those chapters, already converted and trimmed by Kea: FunSheets and their answer keys,
   study guides, guided readings, past quiz notes.

That is enough. Do **not** open the class files, the request JSON, the notes files, the textbook sources or the class
site, and don't browse or search. The only exception: open a textbook source (path in the brief) only to check one
fact you are genuinely unsure of, and read only the part you need (Grep it).

Call `mcp__kea__kea_progress` once after reading, with `percent` 20 ("Writing 25 questions on Chapters 5–6").

**Aim a little above the course.** Questions match the real tests' style and are at their difficulty or slightly
harder (an extra step, a unit conversion, a reversed question), so the real exam feels easy. Explanations teach the
method or reason, not just the answer, so a missed question is learned.

**Write for the real exam.** What the scans found about the tests is what will actually be on them, so it drives
the set:
- **At least 60% of the questions come straight from the tests' study focus and review sheets.** Every study-focus
  line and every problem type on a FunSheet or study guide gets at least one question (for a set too small for all of
  them, take the most exam-heavy ones first: calculations and the topics the focus repeats). Match their style,
  numbers and difficulty, and check your answers against the answer keys when they're in the brief.
- **Use the test's format.** If the focus says "essay, multiple choice, and calculation problems", mix exactly those
  types in about that balance; if a test is matching or multiple choice only, write those.
- When a set is for one test (the brief marks it "the test this set is for"), that test's focus comes first; other
  tests on the same chapters fill in.
- The rest (up to 40%) covers each chapter's objectives (each one at least once in a set of 50 or more) and vocabulary,
  tested in context, not as bare definitions. With no test information in the brief, the objectives and review
  material drive the whole set.
- Set `source` on every question to where it came from ("FunSheet Ch 5", "Exam 3 focus", "Objective"), so the
  balance can be checked.

**Saved questions.** Kea keeps every question the student has had, and a new set reuses some of them. The brief
ends with "Already saved for these chapters": write the number of **new** items in the title line, all different
from those (other problems, other numbers and angles, topics and problem types the saved ones miss). Don't
rewrite a saved question in new words; Kea drops repeats. **Calculations are the exception:** a saved
calculation's format with new numbers (and a new answer) is a new question, and a good one, since the exam tests
the method. Vary the numbers enough that the answer can't be remembered, and where you can, change which quantity
is asked for too.

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
  rounding, such as 0.01 for an answer of 2.45), `unit`, and `calc`: the plain arithmetic that gives the answer,
  with the numbers from the stem (`"745/760*5.60/2.10"`; `^` for powers, `log`, `ln`, `sqrt`, `exp`, e-notation).
  `practice-check` works `calc` out and refuses an answer it doesn't match, so every answer is computed, never
  typed from memory. The stem gives every value needed. Chemistry, math and physics sets should be at least 30%
  `num` when the course's tests are calculation-heavy.
- `blank`: fill in the blank. The stem has `____` where the answer goes, and the answer is one or two words (a term,
  a name, a symbol, a short number with its unit): `answer`, plus `accept`, a list of other forms a teacher would take
  ("NaCl" for "sodium chloride", "ATP" for "adenosine triphosphate", a common synonym). Kea forgives spelling
  slips, capitals and plurals itself and has a local model judge the rest, so list only real alternatives. The stem
  must make one answer clearly right. Blanks are recall: at most 15% of a set (`practice-check` enforces it), and
  only for terms a test really asks for, never a trivial definition. More only when the class's own tests use
  fill-in-the-blank; none when they're multiple choice only.
- `short`: a short written answer or explanation (essay-style courses, "explain why"). `answer` is a model answer
  in 1 to 4 sentences, with the points a grader would look for. The student marks their own answer against it.

Every question has:
- `explain`: why the answer is right, in 1 to 3 sentences. For calculations, the worked solution, each step. For
  `mc`, also why the most tempting wrong choice is wrong.
- `chapter`: the chapter label it tests ("Chapter 5"); `topic`: the idea it tests in a few words, using the
  textbook's own term ("Boyle's law", "molarity").
- `section`: the textbook section that teaches the answer, exactly as the chapter's `Sections:` line in the brief
  writes it ("5.1 The Gaseous State"). Kea opens the textbook there when the student taps the book icon, so pick the
  section a student should read to answer it.
- `source`: where it came from: "FunSheet Ch 5", "Study focus", "Objective", "Textbook 5.3".
- `level`: how hard it is: `recall` (remember a term or fact), `apply` (use one idea: calculate, classify, predict,
  interpret), or `multistep` (chain two or more steps or concepts: a unit conversion before a gas law, grams of an
  electrolyte → particles → ΔT, % m/m with density → molarity, ranking several compounds by two properties).

Balance and difficulty:
- Spread questions across the chapters in proportion to what the tests' focus covers. For one chapter, cover every
  section.
- At most 35% `recall`, about 45% `apply`, and at least 20% `multistep` (`practice-check` enforces the limits). The
  multistep ones are the hardest type the review sheets and practice exams show, and a bit harder: exams combine
  ideas, so practice must too. No giveaways: a choice set where only one option could possibly fit, or a stem that
  names the answer, is recall at best.
- Every objective, every section and every problem type on the review sheets gets questions; in your summary,
  name any you couldn't cover and why.
- Each question tests one thing and doesn't give away another question's answer. No duplicates or near-duplicates,
  except calculations: the same problem format with new numbers is fine (better still if what's asked changes too).
- Plain text only, no LaTeX or Markdown. Use Unicode: x², x³, √, ≤, ≥, ≠, ±, π, Δ, →, ⇌, °, subscripts like H₂O and
  CO₂, superscripts like Na⁺ and SO₄²⁻, and fractions like (x + 1)/(x − 2).
- Be accurate: check every answer by working it, and keep the explanation's numbers consistent with the answer.

## 3. Flashcards (`kind: cards`)

- `front`: a term, a concept prompt ("What happens to a gas's volume when its temperature doubles at constant
  pressure?"), a structure, a formula's name, or a problem type ("How do you find the limiting reactant?").
- `back`: the answer in 1 to 3 sentences, or a short procedure. Include the key fact the exam asks.
- `chapter`, `section` (as for questions: from the chapter's `Sections:` line) and `topic` on each card.
- Start with what the tests will ask: a card for every study-focus point and every item on the review sheets
  (formulas, problem types as "How do you…" cards, the facts the FunSheets drill). Then every vocabulary term and
  objective of the chapters. Mix term cards with how and why cards. No duplicates.

## 4. Write the file and check it

Write `output` (inside `data/`) as JSON, **in one Write** (for more than 60 items, two parts: Write the first half,
then Edit to append the rest, calling `mcp__kea__kea_progress` with `percent` 55 in between):

```json
{ "questions": [
  { "type": "mc", "q": "…", "choices": ["…", "…", "…", "…"], "answer": 2, "level": "apply", "explain": "…", "chapter": "Chapter 5", "section": "5.1 The Gaseous State", "topic": "Boyle's law", "source": "FunSheet Ch 5" },
  { "type": "multi", "q": "Select all that apply: …", "choices": ["…", "…", "…", "…", "…"], "answer": [0, 3], "explain": "…", "chapter": "…", "topic": "…", "source": "…" },
  { "type": "tf", "q": "…", "answer": false, "explain": "…", "chapter": "…", "topic": "…", "source": "…" },
  { "type": "num", "q": "…", "answer": 2.45, "tolerance": 0.02, "unit": "atm", "calc": "745/760*5.60/2.24", "level": "multistep", "explain": "…", "chapter": "…", "topic": "…", "source": "…" },
  { "type": "blank", "q": "The pressure of a gas is inversely proportional to its volume at constant temperature; this is ____ law.", "answer": "Boyle's", "accept": ["Boyle"], "explain": "…", "chapter": "…", "topic": "…", "source": "…" },
  { "type": "short", "q": "…", "answer": "…", "explain": "…", "chapter": "…", "topic": "…", "source": "…" }
] }
```

or, for flashcards, `{ "cards": [ { "front": "…", "back": "…", "chapter": "Chapter 5", "section": "5.1 The Gaseous State", "topic": "Boyle's law" } ] }`. `answer` indexes are
0-based. Work each answer in your head as you write it; don't draft the set twice.

Then call `mcp__kea__kea_progress` with `percent` 90 and run `uv run academic-sync practice-check <output> --count
<count>` once. If it lists problems, fix just those with Edit and check again. Kea drops any malformed item itself, so
never rewrite the whole file.

With `resume`: if `output` already exists, keep its questions, add the rest, and check again.

## 5. Report

One line: how many questions or cards, the chapters covered, and which review material was used.
