---
name: kea-lookup
description: Find one thing about the student's class work that Kea doesn't have yet (a lab's procedure on Science Interactive, an essay's prompt, a rubric in a linked file, a reading's pages), by reading the class site and its outside platforms, and write it up faithfully for the student's Claude tab. Read-only. Kea runs it when the student asks while writing.
user-invocable: true
---

# /kea-lookup: go and read one thing for the student

> **In Kea:** the run is unattended. Never ask questions and never wait. The student is waiting in a document, so be quick and exact: find the thing, copy it faithfully, stop.

**Arguments** (`$ARGUMENTS`): Kea's request file, `data/lookups/<id>/request.md`. It holds:
- what the student asked;
- the class;
- what Kea already has on it, sometimes;
- where the class's content outline and outside platforms are;
- where to write the answer (`data/lookups/<id>/answer.md`).

## 1. Look in what Kea has first

Before opening anything online, look through what Kea already keeps:
- **Its downloaded files:** `data/downloads/<CODE>/**` (handouts, lists, platform pages it read before). Use Grep.
- **The guides:** `data/guides/<CODE>/`.
- **Earlier lookups:** `data/lookups/*/answer.md`.
- **The class's content outline:** named in the request.

If the answer is complete there, write it up (step 3) and stop.

## 2. Go and read it

Open the class site's own link to the page or platform with `d2l_open`: the outline's link, or the platform link in the request. Outside platforms such as Science Interactive, ALEKS and McGraw Hill open through the class's own launch link, so the student's sign-in carries over.

Inside a platform:
- Use `page_click` to open the tab, section or "Next" page that holds what was asked: the Experimentation tab for a lab's procedure, the instructions panel, a collapsed section.
- Read every page of it. A procedure that runs across several pages or tabs is read to the end.
- `d2l_fetch` and `d2l_download` read files the pages link to, such as a PDF handout or a rubric.

**Read-only, always:**
- Never start, submit, save or answer anything: no quiz attempts, no "Check answer", no posts, no uploads, no "Mark complete". `page_click` refuses those buttons anyway; don't look for ways around that.
- If what was asked is behind something only the student can do (a quiz to unlock it, a platform sign-in, a purchase), say exactly that in the answer, with the direct link. Write up whatever you could read.
- If a platform asks for its own sign-in, the answer says the student needs to sign in to it once in Kea's class-site window, with the link.

Use `kea_progress` now and then with a short line ("Opening Lab 9 on Science Interactive…") so the student sees where you are.

## 3. Write the answer

Write `answer.md` in this exact shape, so every lookup reads the same:

```
# <What it is, named as the class names it>
**Class:** <CODE> · **From:** <where you read it, e.g. "Science Interactive, Lab 9: Using Buffers, Experimentation tab"> (<url>)

<The content>

**Not found:** <anything asked for that you couldn't read, and why>   (only when something is missing)
```

**The content is faithful, not summarized:**
- **Procedures:** a numbered list, step for step, in the platform's order, with its section headings ("Part 1: Preparing the buffer"). Every amount, unit, concentration, time, temperature, safety note and photo requirement is kept exactly. Wording may be tightened only where nothing is lost.
- **Tables:** stay Markdown tables, with the same columns.
- **Questions the platform asks:** listed as written, never answered.
- **Rubrics and prompts:** copied in full, criteria and point values intact.
- **Long material:** if the request is broad ("all of Lab 9"), keep the parts asked for and list the rest by heading with its link.

Never invent a step, amount or requirement. Never fill a gap from general knowledge. Put it under **Not found** instead.

End with one line for Kea in your final message: what you found and where.
