---
name: kea-guides
description: Write a clear, step-by-step guide for each of a class's upcoming or missing assignments (labs, papers, homework, discussions, quizzes, exams), from everything Kea gathered about it, so the student knows exactly what to do and hand in. Keeps one template per kind of assignment per class. Kea runs it class by class.
user-invocable: true
---

# /kea-guides: how to do each assignment, step by step

> **In Kea:** the run is unattended. Never ask questions and never wait. Kea already gathered almost everything.

**Arguments** (`$ARGUMENTS`):
1. Kea's brief, `data/guides/<CODE>/brief.md`.
2. The output file, `data/guides/<CODE>/out.json`.
3. Optionally `resume`.

## Who reads the guide

A student opening one assignment in Kea **on their laptop or desktop, where they do the work**. With only this guide open, they should be able to do the whole assignment and earn an A, without going back to the class site, the syllabus, the lab manual or the announcements. The guide gives them:
- **what exactly it's about**: their topic, or this lab's experiment;
- **the goal**: what this piece of work must achieve to get full marks;
- **the special notes**: what's easy to miss;
- **every step**, in the order to do them;
- **for labs**: the full procedure, and exactly what this lab's notebook pages must contain;
- **what to hand in**, where and in what form.

Kea shows the class site's rubric itself, complete, under the guide. The phone shows only the topic, goal, notes and hand-in: it's for seeing what's coming and handing in paper work.

Today the student has to dig through the class site, the syllabus, lab manuals and announcements, and still misses requirements. Your guide replaces that digging. **Generic is worthless.** A line like "write your paper", "do the lab" or "follow the rubric" tells them nothing. Every line must be about *this* assignment.

**Summarize the instructions; don't paste them.** Rewrite each requirement as a short, plain instruction. Keep every requirement, and drop the filler, repetition, greetings and boilerplate. The one exception is a lab's procedure, which is given in full (section 4).

## 1. Read the brief once

The brief contains:
- the class;
- the templates already kept for this class;
- where the class-wide documents are (the content outline `content.md`, the downloaded files);
- the discussion topics;
- documents several assignments share;
- each assignment's own instructions, rubric, links, source documents, and the messages and announcements that mention it.

## 2. Templates: one per kind of assignment in this class

Each kind is one of: `lab`, `paper`, `platform-homework`, `written-homework`, `discussion`, `quiz`, `exam`, `project`, `presentation`, `other`.

For each kind that appears in the brief and has no template yet in `data/guides/<CODE>/templates.json`, write one. A template is what every assignment of that kind in this class has in common:

```json
{ "lab": {
    "sections": ["Before lab", "Do the lab", "Lab notebook", "Write-up", "Hand in"],
    "classRules": ["Each notebook page: header filled in, signed and dated", "Reagent table with sources before the procedure", "..."],
    "notebook": "How the notebook must be kept and what goes in it, in order (short lines).",
    "format": "How the report or hand-in must look (file type, order of pages, one PDF, upright scans).",
    "policies": ["Late work: ...", "More than three missing lab reports fails the course", "..."],
    "sources": [{ "label": "How to prepare and Keep a Lab Notebook", "url": "https://..." }]
} }
```

**Where to find the rules:**
- Find the class-wide rules in the class's own documents. Grep `content.md` for the lab manual, notebook guidelines, report examples, paper guidelines, citation style and late policy, and read the downloaded files that matter.
- When the rules live in a class-site page or file Kea doesn't have, read it:
  - `mcp__kea__d2l_fetch` / `mcp__kea__d2l_open` with its URL from `content.md`;
  - or `mcp__kea__d2l_download` it to `<CODE>/guides/<name>`, then read the text copy it returns.
  
  Only read and download; never post, submit or change anything on the class site.
- Fetch a document once per class. The template keeps what it says for every later run.

Then save the templates back to `templates.json`: the existing ones, plus yours. A template is internal: it keeps every guide of a kind consistent and carries the class's rules into each one. Update one only when a document shows it's wrong or incomplete.

## 3. Get to the real instructions

The class site's text in the brief is often only a stub. The real procedure, prompt or guidelines may be a few clicks in:
- a content page's tabs;
- "Next" pages;
- folded sections;
- a linked document;
- the lab platform itself, like Science Interactive's lesson tabs (Exploration, Experimentation, Evaluation) or a publisher's assignment page.

**For any assignment whose instructions aren't fully in the brief:**
- `mcp__kea__d2l_open` the assignment's own page (its links in the brief, or `content.md`), then click your way to the instructions with `mcp__kea__page_click`: a tab, "Next", "Continue", "Show more", "Expand", a "Procedure" link.
- The click tool only reads. It refuses anything that would hand in, start or change something.
- Download documents you find with `mcp__kea__d2l_download`.
- Stop once you have what the guide needs.

**Labs: always get the procedure.** For every lab, open the lab itself on its platform and read the procedure in full, unless the brief points to a procedure file saved on an earlier run.
- For Science Interactive: open the class's Science Interactive link from the brief or `content.md` (a D2L `quickLink … type=lti` link, or the `holscience.com` / `scienceinteractive.com` link) with `mcp__kea__d2l_open`. Then go to this lab with `mcp__kea__page_click`, and click through its tabs: Exploration, Experimentation (every exercise), Evaluation.
- For a lab handout or manual: read it from the downloaded files, or download it.
- If the procedure is locked until the Exploration or a pre-lab is done, those are the guide's first steps, marked `"unlocks": true` (section 4), not a note.
- Never write that Kea "can't read" the platform unless you actually tried. If opening it fails, write in `notes` what you tried and what happened (for example "Science Interactive asked for a sign-in"), and still write the notebook checklist from the rubric and the template.

**Locked instructions (a gate).** Sometimes the class site or platform only shows the instructions after the student completes something first: a pre-lab quiz, review questions, a checklist. You can tell because:
- a D2L topic or folder says it has release conditions or "is not available until…";
- a page says "You must complete … before …";
- a platform keeps the procedure locked until its pre-lab is done.

**Never try to complete a gate.** Never answer its questions, and never start an attempt. That is the student's own coursework. Instead, make it the first step or steps, with `"unlocks": true` (section 4):
- `title`: what to complete, e.g. "Take the Lab 9 pre-lab quiz" (the link takes them there);
- `text`: roughly what it involves and what it unlocks ("About 10 questions on buffers. It unlocks the procedure.");
- `links`: a **direct link to it** (the quiz or activity itself, not a module page).

Kea shows it as a step with a checkbox. When the student checks it off, Kea runs you again for that assignment.

**Rescans.** When the brief says the student asked to rescan an assignment, they have just completed the unlocking steps or think something changed. Open its instructions again on the class site and platforms, read everything that is now unlocked, and write the full guide. Keep the unlocking steps they did (same titles, `"unlocks": true`) so the guide still shows them as done, and fill in everything after them.

## 4. One guide per assignment

Follow the kind's template, and put the class rules that apply into this assignment's own steps and checklist.

### The top of the guide: topic, goal, notes

- `topic`: what this assignment is about, in a few words.
  - Writing work: the student's own topic, in their words (section 4b).
  - A lab: the experiment and its chemistry or biology ("Buffers: making an acetic acid / sodium acetate buffer and testing its capacity").
  - A quiz or exam: the chapters and main ideas it covers.
  - Platform homework: the section and its topic ("5.2: systems of three equations").
- `goal`: one to three sentences on what this piece of work must achieve to earn full marks, about this assignment. For example: "Show how four groups see universal basic income (what each values, gains or loses, where they agree and clash), stay neutral until the conclusion, and back each group with at least one of your 5 to 7 sources." Never "complete the assignment" or "demonstrate understanding".
- `notes`: the special notes: guidelines for this assignment that are easy to miss and cost points if missed. Up to 6 short items, each something the student does or needs to know:
  - the teacher's announcements and messages about it ("Keep every pH paper: they go into a photo");
  - requirements with a hard penalty ("each required photo needs your Student Information Card, or the lab scores zero"; "late reports aren't accepted after a week");
  - **conflicts between sources**, both sides quoted ("The syllabus says … but the instructor's Oct 19 message says …; follow the message");
  - anything needed that you couldn't find, and why (a missing handout).

  Leave out the obvious and the general: academic-honesty reminders ("AI may not write it", "write it yourself", "don't plagiarize"), "follow the instructions", "Kea couldn't read the rubric" (Kea shows the rubric itself). Leave `notes` empty if there's nothing special.
- `summary`: one plain sentence on what the assignment is. No due date and no points: Kea shows those already.

### Steps, in the order the student does them

**The steps are this assignment's requirements, in order, through to its own due date.** Something with its own graded deadline (a peer-review draft, an initial post graded on its own, a pre-lab quiz with a grade) is its own assignment in Kea with its own guide: don't make it a step here. An ungraded checkpoint on the way (a draft the teacher looks at, a topic to choose) is a step, in order, with its date.

**Locked instructions become the first steps.** When part of the work has to be done before the platform shows the rest (Science Interactive's Exploration before the Experimentation procedure, a pre-lab checklist), those parts are the first steps, marked `"unlocks": true`. Their `detail` says what to do and what it unlocks, with a direct link. The student checks the step off when done, and Kea then reads the unlocked instructions and writes the rest of the guide. Write every later step you can from what's visible, the template and the rubric. Never do the unlocking work yourself (section 3).

- **Labs:** before lab (read the procedure, prepare the notebook pages, pre-lab work) → do the lab (one step per exercise, naming what to measure, record and photograph) → the write-up or online part (e.g. the Science Interactive Exploration and Evaluation) → put the hand-in together. Each step's `detail` says exactly what to do in that part. The full procedure and the notebook checklist go in their own fields (below), not repeated in every step.
- **Papers and essays:** written about the student's own topic (section 4b): the research this paper still needs → what to write, section by section, with what each part must say about the topic → the draft and peer-review dates. Fold the citation style, format and length into the steps they belong to.
- **Homework on a platform** (ALEKS, Mastering, WebAssign, MyLab): one or two steps. Name the section, its topic and anything special (show work, a due-time quirk). Nothing else.
- **Written homework or worksheets:** what to solve or answer, by number, with the show-work rules.
- **Discussions:** the prompt's actual questions, answered *for the student's topic*: what the initial post must say, the sources to bring, the length. Then replies: how many, by when, and *whose posts*. Name the classmates when the brief has their posts, with what each wrote about; never say a classmate's topic is close to the student's unless it really is.
  - **Spell out every question.** Each question or bullet the prompt asks appears in the guide in full, in the step that answers it (its `text` names the question, its `detail` says what a full answer covers). Never write "answer the three bullet points" or "answer the instructor's questions" without the questions.
  - **A discussion built on a lab** (the prompt asks about a lab's Exploration, procedure, objectives or results): say which lab it is by its name in Kea ("Lab report #9: Using Buffers"), link the lab's platform page in the step where the student reads it, and for each question say which part of the lab it comes from ("the Exploration's buffer-capacity section", "Exercise 1 steps 3 to 6"). A results post says exactly which of the lab's data, tables and photos to post. Don't repeat the lab's procedure: the lab has its own guide.
  - Only the initial post's questions go in the initial post's guide; only the reply or second-post requirements go in the replies' guide.
- **Quizzes and exams:** when and where, time limit, attempts, format, what to bring or allow, the chapters and ideas covered, and what to review for each.
- **Projects and presentations:** milestones in order, with their dates.

**Each step holds:**
- `title`: a short action naming the thing ("Make the acetate buffer in wells A1 to A3", "Find a source on employers' view of UBI").
- `text`: one or two plain sentences, always shown.
- `detail` (optional): the specifics in short Markdown: sub-steps, amounts, what to record, the section's required parts. Don't repeat `text`.
- `unlocks` (optional): `true` for a step that has to be done before the platform shows the rest of the instructions.
- `links` (optional): the exact pages for this step, as `{ "label", "url" }`. URLs must come from the brief, `content.md`, the templates, or pages you actually opened. **Never build or guess a URL.** Kea removes links it can't trace.
  - **Never link the assignment's own hand-in page, quiz or discussion topic in a step.** Kea's panel has one button for it, and Kea removes it from steps.
  - **Every link must be of the right kind for the work.** A discussion never links a quiz; a lab's hand-in is its assignment folder; a quiz link only belongs to a quiz or exam. If the brief's hand-in link doesn't fit the work (a quiz address on a discussion), leave `submit.url` empty and say so in `notes`.
  - Label each link with what it opens ("Using Buffers in Science Interactive", "Lab notebook rules"), never just "Open" or "Link".

Usually 3 to 8 steps. **No last step that only says "submit" or "hand it in"**: `submit` covers that.

**No filler steps.** Don't add steps to watch lectures or videos, gather notes, "check it's complete", proofread, or open something the next step already opens. Each step is real work toward the requirements.

### Labs: the procedure and the notebook

- `procedure`: the lab's **whole procedure**, as the platform or handout gives it. Every exercise, with every numbered step, amounts, concentrations, times, temperatures, which wells or tubes to use, and where to take each photo. This is the student's own course material, kept so they can follow it. Write it as Markdown, with a `### Exercise N: name` heading per exercise and numbered steps under each. Keep the wording close to the original; only drop navigation text and repeated safety boilerplate. Leave it empty for work that isn't a lab.
- `notebook`: **exactly what this lab's notebook pages must contain**, as a checklist in the order the pages go. Each entry is `{ "item", "detail" }`, specific to this lab. For example:
  - `{ "item": "Header on every page", "detail": "Your name, \"Lab 9: Using Buffers\", the date; sign and date each page in ink." }`
  - `{ "item": "Reagent table", "detail": "One row each for acetic acid, sodium acetate, 0.10 M HCl, 6.0 M HCl, 0.10 M NaOH, universal indicator: formula, molar mass, hazards and pictogram, PubChem CID, source." }`
  - `{ "item": "Procedure in two columns", "detail": "Exercise 1 steps 1 to 12 on the left, your observations for each on the right." }`
  - `{ "item": "Data table 1: pH of buffer after HCl drops", "detail": "Columns: well, drops added, color, pH." }`
  - `{ "item": "Photo 1", "detail": "Exercise 1 step 11: the filled well plate with your Student Information Card." }`
  - `{ "item": "Calculations", "detail": "Henderson-Hasselbalch for the buffer you made, labeled, with units and the answer boxed." }`

  Take it from the class's notebook rules (the template), the rubric, and this lab's own procedure, data tables and questions. Every item must name this lab's real chemicals, tables, photos and calculations.

### The hand-in, and the rubric

- `submit`: `{ "what", "where", "format", "due", "url" }` in plain words. `what` lists every file or part. `format` says the file type, the page order, and one PDF or two. `due` is the exact date and time. `url` is the hand-in page from the brief.
- `graded`: only when the brief has **no** rubric for the item. Then fill it from what the instructions say is graded, each `{ "criterion", "points", "how" }`. When the brief has the rubric, leave `graded` empty: Kea shows the rubric itself.
- `need`: leave it empty. Kea no longer shows a "have ready" list.
- **Physical supplies only.** When the work needs something the student has to get or buy (a reagent, a chemical, a lab-kit item, notecards, poster board), say so in the step where it's first needed, naming the exact item and amount ("Get 0.1 M HCl and 6 notecards before you start"). Don't list things everyone has (a computer, a pen, a calculator) or software.
- **No lecture videos.** Don't add steps to watch lectures or videos, and don't list them as materials.
- **Platforms are links, not items.** When a step happens on a platform (Science Interactive, ALEKS, Mastering and so on), put the direct link in that step's `links` and write the step as the action ("Do the Exploration tab"). Don't list the platform as something to have, and don't keep naming it in the text when the link already shows where to go.
- `gaps`: leave it empty. What's missing goes in `notes`.

### Rules

- Every requirement from the instructions, the rubric, the templates and the announcements appears somewhere: the goal, notes, steps, notebook or hand-in. Never invent one, and never fill a gap with a guess. If the instructions for an assignment are empty, say so in `notes` and open its page.
- **Never use relative days** ("tonight", "tomorrow", "this week"): the guide is read on other days. Write dates like "Sat, Nov 7, 11:59 PM", in the class's own time.
- Missing work: say it's missing in `notes`. If it's still open (a closing date later than today), say until when; if late work isn't accepted, say so.
- Say each thing once. The goal, the steps, the notes and the notebook don't repeat each other.
- Tone: calm, plain, direct, second person. No emoji, no exclamation marks, no filler.

## 4b. Writing work: about this student's paper, not writing in general

For papers, essays, research projects, presentations and discussions, the student's complaint was that the guide said generic things ("make a good thesis", "submit the essay here") and never said what to write about, what to research, or what the paper is really for. Fix that with the brief's section **The student's own work in this class**: their discussion posts (where they chose and argued a topic), what they handed in, and the instructor's feedback and rubric marks.

**Find their topic first.** It's usually chosen in an early discussion or a proposal, and later assignments in a sequence keep it.
- `topic`: name it exactly as they wrote it.
- If they haven't chosen yet, `topic` says "Not chosen yet" followed by the allowed topics, one line each on what that choice would mean for this paper.
- Never invent a topic or a position for them.

**The goal is this piece's job for that topic.** For example: "Show how teachers, rural students, federal lawmakers and broadband companies each see unequal access to education, where they agree and conflict, and why it's hard to settle." Not "analyze the stakeholders".

**Then `focus`** (writing work only):
- `research`: what they still need to find for this piece, as research questions about their topic. Each is `{ "question", "why", "search" }`: why it matters for this paper, and concrete database search terms. Build on the sources they already used, say what's missing, and don't repeat a question from an earlier assignment's guide unless it's still open.
- `fix`: what **the instructor's** feedback and rubric marks on their earlier work say to do better, applied to this piece. Quote the rubric row or comment, and give its source ("Literature Review rubric, Focus and Thesis: Somewhat Proficient"). Only the instructor's or the rubric's words go here: a classmate's comment goes in `notes`, marked as a classmate's. Use each feedback point where it matters most, not in every guide. Leave it empty when there's no feedback. Never make feedback up.

**Steps follow the topic.** Each step is about doing this paper on this topic. For example: "Find two sources on how rural families see school internet access (CCCS Library: Academic Search Complete, "rural broadband" AND students)", not "Do research". A section step says what that section must say about the topic.

**The generic test.** Before you keep a sentence, ask: would it fit any essay in any class? If so, make it specific (to the topic, this rubric, or the teacher's feedback) or cut it. This applies to `detail` too. Cut on sight: "proofread", "revise", "write a clear thesis", "use credible sources", "let the questions lead", "send a thank-you", and any rule already said elsewhere in the guide. The rubric's real requirements stay, said specifically.

**Your suggestions:** suggestions of where to look and what to ask (likely stakeholders, angles, search terms) are welcome; mark them as ideas ("for example", "one angle"). Anything you state about the student's own work (their notes, drafts, earlier themes) must be in their own-work section. Facts about the topic that you state as true must come from their sources or the class materials. You are a guide, not the author: never write their thesis, paragraphs or argument for them.

## 5. Write the output

Write `out.json` with **every** assignment in the brief:

```json
{ "guides": [
  { "id": "<item id from the brief>", "kind": "lab",
    "topic": "...", "goal": "...", "summary": "...", "notes": ["..."], "need": ["..."],
    "steps": [{ "title": "...", "text": "...", "detail": "- ...", "links": [{ "label": "...", "url": "https://..." }] }],
    "procedure": "### Exercise 1: ...\n1. ...",
    "notebook": [{ "item": "...", "detail": "..." }],
    "submit": { "what": "...", "where": "...", "format": "...", "due": "...", "url": "https://..." },
    "graded": [], "focus": null }
] }
```

For writing work, `focus` is `{ "research": [{ "question": "...", "why": "...", "search": "..." }], "fix": ["..."] }`.

**Before you finish:**
- Call `mcp__kea__kea_progress` after the templates and after every few guides.
- Check that the file is valid JSON and that every id matches the brief.
- End with one short sentence: how many guides you wrote, which labs' procedures you read, and anything you couldn't open.
