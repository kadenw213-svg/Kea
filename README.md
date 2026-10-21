<p align="center">
  <img src="build/icon.png" width="96" alt="Kea logo">
</p>

<h1 align="center">Kea</h1>

<p align="center">
  Your classes, textbooks and study tools, with a free, private office suite, in one window.<br>
  For Windows, with a companion app for Android.
</p>

<p align="center">
  <a href="https://github.com/kadenw213-svg/kea/releases/latest"><b>⬇ Download Kea</b></a>
</p>

---

## Scholar: your classes in one place

Connect your class website (D2L Brightspace) and Kea keeps every class organized for you:

- **One calendar for everything.** Assignments, quizzes, exams, labs, discussions and readings, with due dates,
  open dates, and what's handed in or graded.
- **Every assignment has its links in one place.** Its instructions and documents, the outside site it's done on
  (ALEKS, Science Interactive and others), and the folder, quiz or discussion to turn it in. You don't have to dig
  through the class site.
- **Week by week.** What's due, what to read and what's coming up, for this week and every week of the term.
- **Textbook chapters written for your class.** They follow the syllabus and what each test covers, and they're
  ready before you need them.
- **Practice the way you're tested.** Exam-style question banks for every chapter, flashcards, matching, picture
  questions for lab practicals and identification, and spaced review. When you miss a question, the reading that
  teaches it opens beside it.
- **Listens to your instructors.** When an announcement or message says what a test will focus on, your practice
  focuses on it too.
- **Messages and announcements** from your class site, cleaned up and easy to read and answer.
- **Scan and submit.** Scan handwritten work into clean PDFs and turn it in from the assignment it belongs to.

Scholar's writing and checking run on your own [Claude Code](https://claude.com/claude-code) plan. Kea talks to
your class site directly, so routine checks don't use Claude at all.

## The office suite

Kea opens and edits the files you already use, each in its own tab. It's free and works without the internet.

- **Documents** (.docx, .odt, .rtf): page layout, headers and footers, comments, tracked changes, citations
  (MLA, APA, Chicago), tables of contents, equations, and spelling and grammar checks.
- **Spreadsheets** (.xlsx, .csv, .ods): 140+ formulas, charts, filters, dropdowns, conditional formatting and
  pivot summaries.
- **Presentations** (.pptx): themes, transitions, speaker view, and presenting on a second screen.
- **PDFs**: edit text, highlight, draw, sign, fill in forms, redact, merge, compress, password-protect, make
  scanned pages searchable, and convert to Word.
- **Encyclopedia** (**Ctrl+J**): highlight something you don't know. You get Wikipedia's own explanation and a
  built-in dictionary that works offline. Nothing is written by AI.
- **Voice typing** (**Ctrl+Alt+V**), **read aloud**, **split view**, a **command palette** (**Ctrl+Shift+P**),
  **version history**, autosave and crash recovery.

## Kea on your phone

The Android app works with Kea on your computer. Read your textbooks, take practice exams, study flashcards,
check your calendar, and scan and submit work. Progress syncs both ways through your own OneDrive or Google
Drive. There's no Kea server.

## Private by design

- **Your files stay on your computer.** There's no Kea account and nothing is uploaded to Kea.
- **Your phone syncs through your own cloud drive**, not through anyone else's server.
- **Encyclopedia lookups send only the search words**, never your document.
- **Voice typing runs on your computer** with a small speech model, downloaded the first time you use it.
- **Every feature has settings.** Sensible defaults are on, and **Settings → Advanced** shows every option.

## Install

**Windows**

1. Download **`Kea-Setup-….exe`** from the [latest release](https://github.com/kadenw213-svg/kea/releases/latest).
2. Run it. Windows may say "Windows protected your PC" because Kea isn't code-signed yet. Click
   **More info → Run anyway**.
3. Kea can then open your files when you double-click them.

Kea updates itself. Click the Kea logo at the top left and choose **Check for updates**. A dot on the logo means
an update is ready.

**Android**

Download **`Kea-Android.apk`** from the same release and open it on your phone. You may need to allow installing
apps from your browser or file manager.

**Requirements:** Windows 10 or 11 (64-bit) with 8 GB of RAM or more; Android 6 or later for the phone app.
Scholar needs a Claude Code plan for writing textbooks and questions.

## Feedback

Found a bug or have an idea? In Kea, open **Settings → Feedback**, or
[open an issue](https://github.com/kadenw213-svg/kea/issues).

---

Kea is open source under the [MIT licence](LICENSE). Explanations come from Wikipedia (CC BY-SA), the dictionary
is WordNet 3.1 (Princeton University), picture questions use freely licensed images from Wikimedia Commons, the
optional picking models are Llama 3.2 (Llama 3.2 Community License) and Qwen2.5 (Apache 2.0), and voice typing
uses OpenAI Whisper (MIT). To build Kea from source, see [docs/DEVELOPING.md](docs/DEVELOPING.md).
