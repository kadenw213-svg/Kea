---
name: kea-steps
description: Write a worked, step-by-step solution (a full walkthrough for calculations) for each saved practice question of one chapter that needs one, so a student who misses a question sees exactly how to solve it. Kea runs it chapter by chapter.
user-invocable: true
---

# /kea-steps: step-by-step solutions for a chapter's questions

> **In Kea:** the run is unattended: never ask, never wait. Be fast: Kea already gathered everything.

Arguments: `$ARGUMENTS` = Kea's brief (`data/study/steps/<CODE>/<Chapter N>.md`), then the output file
(`…/<Chapter N>.steps.json`), optionally followed by `resume`.

The brief lists each question that needs its walkthrough (none yet, or only plain lines of text), with its key `k`, the question, its choices, the correct answer and its current explanation. Read the brief
once. Open nothing else unless you must check one fact (then only the chapter's notes,
`data/study/notes/<CODE>/<Chapter N>.md`, with Grep).

## Who it's for and how it sounds

A student who got the question wrong and doesn't yet see how to start. Explain it slowly and completely, as a
patient tutor would to someone meeting the idea for the first time: say what each number means and where it comes
from, and why each step is taken. Plain, calm, professional: no emojis, no exclamation marks, no slang, no "Great
question". Short sentences. Never skip a step because it seems obvious.

## Calculations and multi-step questions: a walkthrough

For `num` questions, and any question at level `apply` or `multistep` that involves arithmetic or a chain of ideas,
write an entry with `asks`, `steps` (objects) and `final`:

- `asks`: what the question is really asking, in one or two plain sentences, and what it gives you, with units
  ("You have 500 g of water and want it to freeze at −5 °C instead of 0 °C. How many grams of NaCl must you add?").
- `steps`: 3 to 8 steps, each `{ "title", "text", "math", "terms" }` (only the fields it needs):
  - `title`: a short heading naming what the step does ("Understand the formula", "Put the numbers in",
    "Find the moles of salt", "Convert moles to grams").
  - `text`: the explanation in plain sentences (Unicode is fine: H₂O, Na⁺, °C). Say why the step is taken, and after
    a result, what it means ("1.344 mol per kilogram of water. But we only have 0.500 kg, so …").
  - `math`: the formula or the line of working in **LaTeX** (`\Delta T_f = i K_f m`, `m = \frac{5}{3.72} = 1.344`).
    One equation or one short chain per step. Units inside `\text{}` (`58.44\ \text{g/mol}`).
  - `terms` (on the formula step): every symbol in the formula, each `{ "sym", "means", "value", "why" }`: `sym` in
    LaTeX, `means` what it actually is in plain words ("how much the freezing point drops"), `value` the number it
    takes here with its unit, `why` where that number comes from ("water normally freezes at 0 °C and we want −5 °C",
    "NaCl splits into two ions, Na⁺ and Cl⁻", "given for water; you don't calculate it", "not known yet: this is
    what we solve for").
  The usual order: understand the formula (with `terms`), then conversions first, each with why, then substitute,
  then solve, one algebra move per step with its reason, then interpret the result, then convert to what the
  question asks for.
- `final`: `{ "math": "39.3\ \text{g NaCl}", "text": "one sentence: the answer, and a quick check that its size makes sense" }`.
  Kea draws `final.math` in a box. Significant figures as the data allow.

## Concept questions

For `mc`, `multi`, `tf`, `blank` and `match` that are recall or reasoning without arithmetic, the same walkthrough
form, shorter (the student sees it at once on "I don't know", so it teaches on its own): `asks` (what the question
is really asking, in plain words), then 2 to 5 step objects with a `title` and `text` (the rule or idea that decides
it, how it applies to this case, why the tempting wrong choice fails; `math` and `terms` only where there's a
formula), then `final` `{ "text" }`: the answer and the one-line reason.

## Rules for both

- LaTeX only in `math`, `sym` and `final.math`. Everywhere else plain text with Unicode; never `$…$`, `**` or
  Markdown. Don't number the steps yourself (Kea does).
- Every number must agree with the stored answer. If you find the stored answer is wrong, still write the correct
  walkthrough and add `"wrong_answer": true` to that entry (Kea flags it).

## Save

Write the output file as JSON, in parts of about 15 questions (Write the first part as a complete file, then Edit to
append each next part, so a stop keeps what's written), and call `mcp__kea__kea_progress` after each part:

```json
[
 {
  "k": "6cd50486cb5c",
  "asks": "You have 500 g of water and want it to freeze at −5 °C instead of 0 °C. How many grams of NaCl must you dissolve in it?",
  "steps": [
   {
    "title": "Understand the formula",
    "text": "Freezing point depression connects how far the freezing point drops to how much solute is dissolved.",
    "math": "\\Delta T_f = i\\,K_f\\,m",
    "terms": [
     {
      "sym": "\\Delta T_f",
      "means": "how much the freezing temperature changes",
      "value": "5 °C",
      "why": "water normally freezes at 0 °C and we want −5 °C"
     },
     {
      "sym": "i",
      "means": "how many particles each formula unit breaks into",
      "value": "2",
      "why": "NaCl splits into Na⁺ and Cl⁻"
     },
     {
      "sym": "K_f",
      "means": "the freezing point depression constant of the solvent",
      "value": "1.86 °C·kg/mol",
      "why": "given for water; you don't calculate it"
     },
     {
      "sym": "m",
      "means": "molality: moles of solute per kilogram of solvent",
      "why": "not known yet: this is what we solve for first"
     }
    ]
   },
   {
    "title": "Put the numbers in",
    "text": "Replace each letter with the value we know, then multiply the known numbers together.",
    "math": "5 = (2)(1.86)\\,m \\;\\Rightarrow\\; 5 = 3.72\\,m"
   },
   {
    "title": "Solve for molality",
    "text": "Divide both sides by 3.72. This means 1.344 mol of NaCl is needed for every kilogram of water. But we only have 500 g, which is 0.500 kg.",
    "math": "m = \\frac{5}{3.72} = 1.344\\ \\text{mol/kg}"
   },
   {
    "title": "Find the moles of salt",
    "text": "Molality is per kilogram, so multiply by the kilograms of water we actually have.",
    "math": "1.344\\ \\text{mol/kg} \\times 0.500\\ \\text{kg} = 0.672\\ \\text{mol}"
   },
   {
    "title": "Convert moles to grams",
    "text": "The question asks for grams, not moles. One mole of NaCl has a mass of 58.44 g.",
    "math": "0.672\\ \\text{mol} \\times 58.44\\ \\text{g/mol} = 39.3\\ \\text{g}"
   }
  ],
  "final": {
   "math": "39.3\\ \\text{g NaCl}",
   "text": "About 39 g of salt in half a kilogram of water, a sensible amount for a 5 °C drop."
  }
 },
 {
  "k": "a1b2c3d4e5f6",
  "steps": [
   "Boyle's law says that at constant temperature, pressure and volume change in opposite directions.",
   "Here the volume is halved while the temperature stays the same, so the pressure must double.",
   "B is the tempting wrong choice: it halves the pressure, which would only happen if the volume doubled."
  ]
 }
]
```

With `resume`: keep the entries already in the output file and add only the questions still missing.

One summary line: how many questions got walkthroughs or steps, and any stored answers you found wrong.
