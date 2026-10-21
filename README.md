<p align="center">
  <img src="build/icon.png" width="96" alt="Kea logo">
</p>

<h1 align="center">Kea</h1>

<p align="center">
  A study app and office suite in one, for Windows and Android.
</p>

<p align="center">
  <a href="https://github.com/kadenw213-svg/kea/releases/latest"><b>⬇ Download Kea</b></a>
</p>

---

Kea brings a student's coursework and files into one desktop app. It reads your school's class site and keeps a
local database of every class: assignments, due and open dates, readings, and what's been turned in or graded.
On top of that sits a full office suite for the documents those classes produce, and a phone app that carries
the study tools with you.

## Classes

Kea signs in to your class site in its own browser window and reads it through the site's API, not by scraping
pages. Each class's work is placed on one calendar, linked to the files, outside platforms (ALEKS, Science
Interactive and others) and turn-in pages it belongs to, so nothing has to be found by clicking through the
class site. A daily check catches new work, changed dates, messages and announcements, and handles most of this
without AI.

Where writing is needed, Kea runs [Claude Code](https://claude.com/claude-code) on your own plan. It writes
textbook chapters matched to the syllabus and to what each test covers, plus exam-style question banks,
flashcards and picture-identification sets. Each set is written once and then reshuffled inside Kea, so
practising costs nothing. When an instructor says what a test will focus on, Kea notes it and steers the next
practice set toward it.

Class syncing works with schools that use Canvas or D2L Brightspace.

## Files

Kea opens and saves Word, Excel, PowerPoint, OpenDocument and PDF files directly on your computer, each in its
own tab, and works fully offline. The document editor handles tracked changes, comments, citations and equations.
The spreadsheet has a formula engine with 140+ functions, plus charts. The PDF editor can change existing text,
fill in and sign forms, redact, and make scanned pages searchable with OCR. Highlighting a word looks it up in
Wikipedia and a built-in dictionary, and voice typing runs Whisper on your own machine.

## Phone

The Android app runs the same study code as the desktop app, so textbooks, practice exams and flashcards behave
the same on both. It also shows your calendar and can scan paper homework into a PDF and turn it in. The phone
and computer sync through a few files in your own OneDrive or Google Drive, and study progress from both sides
is merged rather than overwritten. There is no Kea server or account.

## Install

**Windows 10 or 11 (64-bit):** download `Kea-Setup-….exe` from the
[latest release](https://github.com/kadenw213-svg/kea/releases/latest) and run it. The installer isn't
code-signed yet, so Windows may show a warning; choose **More info → Run anyway**. Kea updates itself after that.

**Android 6 or later:** download `Kea-Android.apk` from the same release and open it on your phone.

## Built with

Electron, React and TypeScript, with pdf.js and pdf-lib for PDFs, TipTap for documents, and CodeMirror for
plain text. A Python engine keeps the class database in SQLite. The phone app is built with Capacitor. Voice
typing uses Whisper through Transformers.js, and OCR uses Tesseract. Small local models (llama.cpp) only choose
between Wikipedia articles and never write text. To build Kea from source, see
[docs/DEVELOPING.md](docs/DEVELOPING.md).

## Feedback

Report bugs and ideas through **Settings → Feedback** in Kea, or [open an issue](https://github.com/kadenw213-svg/kea/issues).

---

MIT licensed. Includes content from Wikipedia (CC BY-SA), WordNet (Princeton University) and Wikimedia Commons,
and models under the OpenAI Whisper (MIT), Llama 3.2 Community and Qwen2.5 (Apache 2.0) licences.
