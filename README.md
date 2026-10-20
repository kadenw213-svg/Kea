<p align="center">
  <img src="build/icon.png" width="96" alt="Kea logo">
</p>

<h1 align="center">Kea</h1>

<p align="center">
  Your classes, textbooks and calendar, with a free, private office suite for Windows.<br>
  Documents, spreadsheets, presentations and PDFs in one clean window, an Encyclopedia panel for studying,
  and voice typing that runs on your own computer.
</p>

<p align="center">
  <a href="https://github.com/kadenw213-svg/kea/releases/latest"><b>⬇ Download the latest version</b></a>
</p>

---

## What it is

**Kea Scholar** (coming in 0.20): add your classes and Kea keeps each one's assignments, readings and a weekly
textbook up to date, on a calendar where every assignment opens its reading. See [the roadmap](ideas/kea-roadmap.md).

Kea opens and edits the files you already use: Word, Excel, PowerPoint, PDF, plain text and images.
Everything sits in tabs in one window. It's free and open source, and it works without the internet.

- **Documents** (.docx, .odt, .rtf): page layout, headers and footers, comments, tracked changes, citations
  (MLA/APA/Chicago), table of contents, equations, and grammar checking.
- **Spreadsheets** (.xlsx, .csv, .ods): 140+ formulas, charts, filters, dropdowns, conditional formatting and pivot summaries.
- **Presentations** (.pptx): themes, transitions, speaker view, and presenting on a second screen.
- **PDFs**: edit existing text, highlight, draw, sign, fill forms, redact, merge, compress, password-protect,
  make scanned pages searchable (OCR), and convert to Word.
- **Encyclopedia** (**Ctrl+J**): highlight a word or idea you don't know. **Explain** shows Wikipedia's own explanation
  (the article that fits what you're reading, its definition and the most useful sections, with a link), and
  **Dictionary** gives definitions, examples, synonyms and opposites, even offline. Nothing is written by AI.
- **Spelling and grammar checks** as you type, offline.
- **Voice typing** (**Ctrl+Alt+V**): talk, and Kea types for you anywhere.
- **Read aloud**, **split view**, a **command palette** (**Ctrl+Shift+P**), **version history**, autosave and crash recovery.

## How it works

- **Everything stays on your PC.** Files are opened and saved directly on your computer, and there's no account to make.
  Kea doesn't upload your documents anywhere.
- **The Encyclopedia uses real sources.** Explanations are Wikipedia's text, word for word, and only the search words are sent
  (never your file). The dictionary (WordNet) is built in and works offline. An optional small model on your PC can
  help pick the right article when a word has several meanings; it only chooses and never writes.
- **Voice typing runs locally**, using a small speech model (40–250 MB) downloaded the first time.
- **The citation tool** can look up a DOI or ISBN when you ask it to.
- **Cloud drives** like OneDrive, Google Drive and Dropbox show up on the Home screen through their own desktop sync apps.
- **Every feature has settings.** The basics are on by default, and **Settings → Advanced** shows every option.

## Download and install

1. Go to the [**latest release**](https://github.com/kadenw213-svg/kea/releases/latest) and download
   **`Kea-Setup-x.y.z.exe`**.
2. Run it. Windows may show "Windows protected your PC" because the app isn't code-signed yet: click **More info → Run anyway**.
3. Pick where to install it, and you're done. Kea can open your files directly when you double-click them.

**Updating:** click the **S** logo at the top left, then **Check for updates**. A dot on the logo means a new version is ready.

**Requirements:** Windows 10 or 11 (64-bit), 8 GB of RAM or more.

## Feedback

Found a bug or have an idea? In Kea, open **Settings → Feedback**, or [open an issue](https://github.com/kadenw213-svg/kea/issues).

---

Kea is open source under the [MIT licence](LICENSE). Explanations come from Wikipedia (CC BY-SA), the dictionary
is WordNet 3.1 (Princeton University), the optional picking models are Llama 3.2 (Llama 3.2 Community License) and
Qwen2.5 (Apache 2.0), and voice typing uses OpenAI Whisper (MIT). Building from source: see [docs/DEVELOPING.md](docs/DEVELOPING.md).
