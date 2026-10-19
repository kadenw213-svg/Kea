---
name: daily-overview
description: The daily check of each real course: new announcements, newly graded work and feedback, missed and due-today deadlines, sent as one Kea notification per course, plus new-class-shell detection (which runs /academic-import) and small calendar upkeep. Kea runs it on its schedule.
user-invocable: true
---

# /daily-overview -- the course shell, relayed as Kea notifications

> **In Kea:** read `CLAUDE.md` → "Running inside Kea" first. It replaces Chrome with Kea's `mcp__kea__d2l_*` tools,
> Google Calendar with `record-sync ... --calendar-id kea`, and email with `mcp__kea__kea_notify`, and runs are
> unattended (no questions, no approval gates).
>
> **In Kea there is no Daily Overview message.** Everything below about what the email contains now becomes separate
> Inbox messages, one per thing (see `CLAUDE.md` → "Email, Gmail and Drive"): Kea already posts announcements, D2L
> grades, D2L feedback and D2L messages itself, so you send only `needs_you`, `attention`, `missed`, and grades or
> feedback from outside platforms, each with its links as buttons. No current-grade header, no "Coming up", no "Due
> today", no portal-link footer. Crawl, ingest and record as written; just don't send the rendered overview.

Arguments passed: `$ARGUMENTS` (may be empty, a course code, or `--date
YYYY-MM-DD` for a manual re-run of a specific day).

The goal (user-directed 2026-10-05): **the user never has to open a course
shell to find out what changed.** Each morning, every real course is
checked, and anything new arrives as one email per course, with every item
linked straight to the page where they act on it. Read CLAUDE.md first,
especially invariants 1, 23, 30, 37, 38 and 39.

**This usually runs unattended.** `scripts/daily_overview.ps1` starts it
headless at 5:00am (`claude -p "/daily-overview" --chrome`). Nobody is
watching. Never stop to ask a question. When something can't be resolved,
put it under "Needs you" in that course's email and keep going.

**Working directory:** repo root. All local work goes through `uv run
academic-sync ...`.

**Live tools:** Chrome (`claude-in-chrome`) for D2L and external platforms;
Gmail `send_message` (to the `digest_email_to` preference only); Google
Calendar for upkeep.

## What the email contains, and what it never contains

Built by `digest-render` (`src/academic_sync/sync/email_payload.py`). Don't
hand-write the HTML. Subject: `Daily Overview <CODE>`. In order:

1. **Current grade** in bold at the top, with its trend since about a week
   ago.
2. **Needs attention.** Only *new* triggers: a real zero, a major
   assessment under 60%, 2+ missing items, or a 10+ point weekly drop.
   Each is reported once, not every morning.
3. **Newly graded.** Each item gets its link, the exact score as D2L shows
   it, the instructor's comment **verbatim**, and an "Open feedback" link.
4. **New announcements.** Title, link, and short **verbatim** excerpts.
5. **Missed yesterday.** Each one says whether it's still open (with a
   submit link) or closed.
6. **Due today**, plus **Coming up** for the next 3 days as context.
7. **Calendar updated** (what this run changed) and **Needs you**.
8. A footer of the course's portal links.

**No readings.** The weekly banner is the reading list. **No email on a
quiet day.** No email for synthetic (self-study) courses. Advice
(`advice` in the crawl JSON) is optional, clearly labeled, written by you,
and only given when the grade moved or new work was graded. Never repeat
the same grade warning daily.

## Step 0: orient (fast)

1. `uv run academic-sync courses`. In scope: every `active`, non-synthetic
   course (or just `$ARGUMENTS`' course).
2. `uv run academic-sync prefs get digest_email_to`. If unset, still crawl
   and ingest, but nothing can send. Say so in the run's output.
3. `uv run academic-sync portal-link-list --course <CODE> --json` per
   course. **If a course is missing its core links** (home, grades,
   announcements, content, dropbox, quizzes, and the external gradebook for
   any external platform), discover them once:
   - Open each area from the course's own navbar and save the URL that
     actually loaded with `portal-link-set --course <CODE> --kind <kind>
     --url "<url>" [--label "..."]`.
   - Save only a URL you opened and saw load the right page (invariant 38).
   - From then on, navigate straight to saved links; don't click through
     the shell.

## Step 1: check the D2L session (invariant 39 -- you never sign in)

1. Open the `d2l_base_url` preference.
2. If it lands on the D2L homepage, you're logged in. Continue.
3. If it redirects to the sign-in page, wait about 10 seconds: LastPass
   Autologin normally signs in by itself.
4. Still on the sign-in page? Make **one nudge**: click once into the
   **username field** (only focusing it), wait about 10 seconds, and check
   again. This wakes up LastPass when it fills the page but freezes
   before submitting. **Never** click Sign In, never open LastPass's
   icon/menu, never type anything (invariant 39).
5. Still not in? **Stop the run here** (user-directed 2026-10-09: emails
   built without a real crawl are rubbish). Don't crawl, ingest, render,
   send, or touch Calendar. Print `login failed -- nothing sent` and end.
   - If someone is watching (an interactive run), ask the user to click
     Sign In themselves, then continue from Step 1b once they're in.
   - Never write a `login_failed: true` crawl. (`digest-render` refuses
     to send one anyway, as a backstop.)
   - Nothing is lost: the next real run picks up everything that was
     never emailed.

## Step 1b: new class shells → automatic first-time import

1. From the D2L home page, `fetch('/d2l/api/lp/1.50/enrollments/myenrollments/?orgUnitTypeId=3')`.
   Save the JSON to `data/digests/enrollments-<date>.json`.
2. Run `uv run academic-sync shells-check --file <that file>`. It prints
   every accessible, real class shell that isn't imported yet. Orientation,
   cross-listed, non-class and past-term shells are already filtered out.
3. For each new shell, register it (`course add` with its code, section,
   term, `--d2l-id <ou>` and `--d2l-url <home url>`), then run the **full first-time
   import** from `/academic-import` in **unattended mode**:
   - Do the full scrape, required finds included.
   - Build every week's banner in the current format (READING → SLIDES &
     RESOURCES → TOPIC DETAIL, no PACING).
   - Give every exam and practical its study guides and its submission
     links.
   - **Skip the approval gate:** sync every CLEAR item straight to
     Calendar. Ambiguous or conflicting items go into that class's email
     under "Needs you".
   - Save its portal links.
   - Do this even if the shell is still mostly empty. Each later morning's
     run fills in newly posted weeks, tests and study guides.
4. Then continue with every other class as usual. The new class gets its
   own email that morning, summarizing what was added (as
   `calendar_changes`), and is baselined like any first run.

## Step 2: crawl each course (bounded: aim for no more than about 10 page loads per course)

Use D2L's REST API through in-page `fetch` from the logged-in tab
(`javascript_tool`). It returns structured JSON in one call per area, the
same technique as the content TOC API in `docs/d2l_discovery.md`. Find the
versions first with `fetch('/d2l/api/versions/')` and use the newest
`le`/`lp`.

- **Announcements:** `GET /d2l/api/le/<v>/<ou>/news/`.
  - `id` = the news item Id.
  - `title`, `posted_on`.
  - `highlights` = 1–4 short verbatim excerpts. Always include any
    sentence that states a date, deadline, room change, or "submit"
    instruction.
  - `url` = that announcement's own page, or the saved announcements
    link.
- **Grades:** `GET /d2l/api/le/<v>/<ou>/grades/values/myGradeValues/` for
  items, and `.../grades/final/values/myGradeValue` for the overall grade.
  - `id` = grade object id.
  - `score_text` exactly as displayed, e.g. "36 / 50", plus
    `score_percent`.
  - `comment` = the Comments text verbatim; omit it if empty.
  - `graded_on` from the last-modified date when present.
  - `item_url` = the item's own page (from the local item's
    `reference_url` when the titles match).
  - `feedback_url` = the page where that feedback is read: the Dropbox
    "View Feedback" page for dropbox items, otherwise the saved grades
    link.
  - `is_major` and `chapter_label` come from the matching local item
    (exam, final or project type; its module/chapter). If you can't match
    one, leave them unset.
- **External platforms** (ALEKS, Connect, ...): open the saved
  `external_gradebook` link and read its **gradebook**, never the
  dashboard (invariant 23). Add those scores to `grades`, with
  `id = "<platform>:<item name>"`.
- **Deadline status:** run `uv run academic-sync digest-deadlines --course
  <CODE>`. For each `yesterday`/`today` item, check whether it was
  submitted: a dropbox submission, a quiz attempt, or a platform gradebook
  status.
  - Report `submitted` true/false/null (null = couldn't confirm).
  - Report `window_open`: does the folder or quiz still accept a
    submission now?
  - Set `missing_count` from D2L's or the platform's own missing count
    when it shows one.
- **Study materials for every upcoming test (every run).** For each
  exam, quiz and practical in the next ~3 weeks, check for newly posted
  study material:
  - study guides, review slides, practice exams, review assignments;
  - course-specific equivalents (CHE's funsheets and keys, BIO's chapter
    objectives sheets, MAT's section worksheets and the ALEKS chapter
    review);
  - announcements that mention a study guide.
  New finds get added with `render <test_id> --links '[...]' --save`
  (keep the existing links in the list) plus `update_event`, and become a
  `calendar_changes` line ("Added the Exam 3 study guide to the Oct 25
  exam").
  A new study guide or review also updates that test's EXAM CONCEPTS
  (CLAUDE.md invariant 40): read it and pass its emphasized concepts and
  terms verbatim as `--study-focus '[...]'` (and `--covered-chapters` if it
  states them) on the same `render --save`. Study-guide material always
  leads the list.
- **Calendar upkeep (small, same rules as `/academic-sync`):**
  - If a new announcement states a new or changed date, run it through
    `extract` (source type `d2l_announcements`), then `plan`. Push only
    CLEAR CREATE/UPDATE entries via `render` → `create_event`/
    `update_event` → `record-sync`.
  - Run `uv run academic-sync needs-link-refresh --course <CODE>` and fill
    any newly unlocked links (`render --reference-url ... --save`, then
    `update_event`).
  - Every change you make becomes a `calendar_changes` line, with a link
    where one exists.
  - Anything ambiguous or conflicting, or anything that would take a big
    crawl, becomes a `needs_you` line, not a guess (invariants 1, 9, 34).

## Step 2b: D2L messages

1. On the D2L home page (`d2l_base_url`), open the envelope (message
   alerts) dropdown and read the list.
2. Open each message newer than the last run and read its sender,
   subject, date and body. The inbox itself is
   `/d2l/p/le/email/<home ou>`.
3. Sort each one:
   - **Automated "Submission receipt" messages** aren't reported. Use them
     as proof of submission in `deadline_status`.
   - **Spam and college advertising** (marketing, event promos, surveys
     unrelated to a class) get dropped.
   - **A class message** goes in that class's crawl JSON `messages`:
     `{id, subject, sender, received_on, excerpt, url}`. The class is the
     one the sender teaches (match instructor names on each course), or
     failing that, the class the subject or body clearly refers to. The
     `excerpt` is a short verbatim quote.
   - **Everything else that's real** (advising, registrar,
     financial-aid deadlines, college notices that need action) goes into
     a separate crawl for course `MESSAGES` (an inactive pseudo-course).
     Ingest and render it like a class; its email is titled "Daily
     Overview Messages" and has no grade line. It's sent only on days it
     has something.

## Step 2c: hidden graded work

When Kea's pre-check reasons for a class include `Hidden graded work: ...` (a grade category counting more points
than the items the student can see), find out what that work is: the course schedule, the syllabus's grading table,
and any outside platform the class uses. Every piece must be on the calendar (`coverage --course <CODE>`, then
`extract`). Then send one `needs_you` notice that names the pieces that look missed (due and not handed in), whether
they can still be handed in late, and what to do. Don't guess at zeros you can't see: say which items you found and
which the instructor needs to confirm.

## Step 3: ingest

1. Write the crawl to `data/digests/<CODE>/<YYYY-MM-DD>.json`, matching
   `digest.DigestCrawl`:
   ```json
   {"course": "MAT1340", "captured_on": "2026-10-06", "login_failed": false,
    "overall_percent": 43.1, "letter_grade": "F", "missing_count": 0,
    "announcements": [{"id": "...", "title": "...", "posted_on": "2026-10-05",
                       "url": "...", "highlights": ["verbatim ..."]}],
    "grades": [{"id": "...", "title": "...", "score_percent": 72, "score_text": "36 / 50",
                "comment": "verbatim ...", "item_url": "...", "feedback_url": "...",
                "graded_on": "2026-10-05", "is_major": true, "chapter_label": "Chapter 3"}],
    "deadline_status": [{"item_id": "...", "submitted": false, "window_open": true}],
    "calendar_changes": [{"text": "Added Exam 3 (Oct 20)", "url": "..."}],
    "needs_you": [{"text": "...", "url": "..."}],
    "advice": null}
   ```
   Always include every current announcement and grade you saw. Dedupe is
   automatic: anything already emailed with unchanged content is never
   re-sent, and a regrade or new feedback resurfaces as "updated". On a
   course's very first run, older history is baselined automatically.
2. Run `uv run academic-sync digest-ingest --file <path>`. It prints counts.
   Ignore its `signal_candidates` output: the GPT quiz system was abandoned
   2026-10-07, so nothing writes weakness signals to Drive anymore.

## Step 4: render and send

1. Run `uv run academic-sync digest-render --course <CODE>`.
2. If `should_send` is true, call `send_message`:
   - `to`: the printed `to`
   - `subject`: the printed `subject`
   - `htmlBody`: the printed `html`, verbatim
   - `body`: the printed `text`
   Then record it: `uv run academic-sync digest-record-sent --course <CODE>
   --message-id <id from the send result>`.
3. If `has_news` is false (a quiet day), run `digest-record-sent --course
   <CODE> --skipped`.
4. If `already_sent` is true, do nothing. Re-running a morning never
   double-sends.
5. Send only to `digest_email_to`, from the connected account. Never add
   cc or bcc, and never send to anyone else.

## After running

Print one line per course: sent / skipped (quiet) / login failed / error.
When headless, this goes to `data/logs/daily_overview_<date>.log`.

## Rules (CLAUDE.md is authoritative)

- Scores, comments, announcement text, and dates are copied verbatim from
  the real page. Never paraphrase them into something they didn't say,
  and never invent them.
- Never fabricate a date or link. Calendar writes follow every existing
  invariant: no guests, no Meet links, idempotent.
- One email per course per day.
- If you're about to hand-write dedupe, trend math, or email HTML, stop.
  That's `digest.py` / `email_payload.py`.
