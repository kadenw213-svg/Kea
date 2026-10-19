---
name: kea-steps
description: Write a worked, step-by-step solution for each saved practice question of one chapter that doesn't have one, so a student who misses a question sees exactly how to solve it. Kea runs it chapter by chapter.
user-invocable: true
---

# /kea-steps: step-by-step solutions for a chapter's questions

> **In Kea:** the run is unattended: never ask, never wait. Be fast: Kea already gathered everything.

Arguments: `$ARGUMENTS` = Kea's brief (`data/study/steps/<CODE>/<Chapter N>.md`), then the output file
(`…/<Chapter N>.steps.json`), optionally followed by `resume`.

The brief lists each question that has no worked solution yet, with its key `k`, the question, its choices, the
correct answer and its current explanation. Read the brief once. Open nothing else unless you must check one fact
(then only the chapter's notes, `data/study/notes/<CODE>/<Chapter N>.md`, with Grep).

## Write the steps

For every question, a worked solution a student who got it wrong can follow to solve it (and the next one like it):

- **Calculations** (`num`, and any question with arithmetic): 3 to 8 steps.
  1. What's asked and what's given, with units ("Find the final volume V₂. Given: V₁ = 5.60 L, P₁ = 745 mmHg …").
  2. The formula, by name, and what every symbol stands for with its unit ("Combined gas law: P₁V₁/T₁ = P₂V₂/T₂,
     where P is pressure, V volume and T temperature in kelvin").
  3. Unit conversions first, each with why ("Temperatures must be in kelvin: 25 °C + 273 = 298 K").
  4. Rearrange for the unknown, then substitute, then compute, each its own step, with the numbers.
  5. Last step: the answer with units and significant figures, and a quick check that it makes sense.
- **Concepts** (`mc`, `multi`, `tf`, `blank`): 2 to 5 steps of reasoning: the rule or idea that decides it, how it
  applies to this case, and why the tempting wrong choice fails ("Step 3: B is wrong because …").
- Each step is one or two plain sentences. Unicode for math (x², H₂O, Na⁺, Δ, →, ≈); `^(…)` and `_(…)` for longer
  exponents and subscripts (`(1.00375)^(72)`, `log_(b)(x)`); never LaTeX. Don't number the steps yourself (Kea does).
- Every number must agree with the stored answer. If you find the stored answer is wrong, still write the correct
  steps and add `"wrong_answer": true` to that entry (Kea flags it).

## Save

Write the output file as JSON, in parts of about 15 questions (Write the first part as a complete file, then Edit to
append each next part, so a stop keeps what's written), and call `mcp__kea__kea_progress` after each part:

```json
[ { "k": "6cd50486cb5c", "steps": ["Find the density d. Given: mass m = 31.5 g, volume V = 25.0 mL.", "Density is mass per volume: d = m/V, where d is in g/mL, m in grams and V in mL.", "Substitute: d = 31.5 g ÷ 25.0 mL = 1.26 g/mL.", "Both values have 3 significant figures, so the answer keeps 3: 1.26 g/mL. A density a little above water's (1.00) fits a dense liquid."] } ]
```

With `resume`: keep the entries already in the output file and add only the questions still missing.

One summary line: how many questions got steps, and any stored answers you found wrong.
