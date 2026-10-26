import { create } from 'zustand';
import { api } from './api';
import { LIGHT_ACCENTS, themeOf } from './themes';

/**
 * App settings. Every option is declared once here (label, type, default, whether it's "advanced")
 * and the Settings window renders the whole thing from this schema. Values are stored flat
 * ("files.autosave": true) in settings.json by the main process.
 */

export type FieldType = 'toggle' | 'select' | 'number' | 'range' | 'text' | 'color' | 'folder';

export interface Field {
  key: string;
  label: string;
  type: FieldType;
  default: any;
  help?: string;
  advanced?: boolean;
  options?: { value: any; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  /** Needs an app restart to take effect. */
  restart?: boolean;
  /** Only shown when this returns true. */
  when?: (v: Record<string, any>) => boolean;
  /** A heading shown above this field (the start of a group of related settings). */
  group?: string;
}

export interface Section {
  id: string;
  label: string;
  icon: string;
  blurb?: string;
  fields: Field[];
}

const pct = (vals: number[]) => vals.map((v) => ({ value: v, label: `${Math.round(v * 100)}%` }));

export const SECTIONS: Section[] = [
  {
    id: 'general',
    label: 'General',
    icon: 'Settings',
    fields: [
      {
        key: 'general.startup',
        label: 'When Kea starts',
        type: 'select',
        default: 'home',
        options: [
          { value: 'home', label: 'Show Home' },
          { value: 'restore', label: 'Reopen the files I had open' }
        ]
      },
      {
        key: 'general.newKind',
        label: 'Ctrl+N creates a new',
        type: 'select',
        default: 'doc',
        options: [
          { value: 'doc', label: 'Document' },
          { value: 'sheet', label: 'Spreadsheet' },
          { value: 'slides', label: 'Presentation' },
          { value: 'code', label: 'Text file' }
        ]
      },
      { key: 'user.name', label: 'Your name', type: 'text', default: '', help: 'Used for comments, MLA headers and the author of new files. Stays on this PC.' },
      { key: 'general.spellcheck', label: 'Check spelling as you type', type: 'toggle', default: true },
      {
        key: 'general.closeBehavior',
        label: 'Closing a file with unsaved changes',
        type: 'select',
        default: 'save',
        advanced: true,
        options: [
          { value: 'save', label: 'Save it automatically when possible' },
          { value: 'ask', label: 'Always ask' }
        ],
        help: 'New files that have never been saved always ask where to save.'
      },
      {
        key: 'general.tabsCloseToLeft',
        label: 'After closing a tab, go to',
        type: 'select',
        default: 'right',
        advanced: true,
        options: [
          { value: 'right', label: 'The tab to the right' },
          { value: 'left', label: 'The tab to the left' },
          { value: 'home', label: 'Home' }
        ]
      },
      { key: 'general.hardwareAcceleration', label: 'Use the graphics card to draw the app', type: 'toggle', default: true, advanced: true, restart: true, help: 'Turn off if the window flickers or shows blank areas.' },
      { key: 'general.smoothScrolling', label: 'Smooth scrolling', type: 'toggle', default: true, advanced: true, restart: true }
    ]
  },
  {
    id: 'appearance',
    label: 'Appearance',
    icon: 'Palette',
    fields: [
      {
        key: 'appearance.theme',
        label: 'Theme',
        type: 'select',
        default: 'dark',
        options: [
          { value: 'dark', label: 'Dark' },
          { value: 'black', label: 'Black (true black)' },
          { value: 'dim', label: 'Dim (blue-grey)' },
          { value: 'light', label: 'Light' },
          { value: 'sepia', label: 'Sepia (warm paper)' }
        ],
        help: 'Colours all of Kea: menus, the calendar, quizzes and textbook pages. Kea on your phone uses the same theme. Scans and printing stay white.'
      },
      {
        key: 'appearance.accent',
        label: 'Accent colour',
        type: 'select',
        default: 'blue',
        options: [
          { value: 'blue', label: 'Blue' },
          { value: 'purple', label: 'Purple' },
          { value: 'teal', label: 'Teal' },
          { value: 'green', label: 'Green' },
          { value: 'orange', label: 'Orange' },
          { value: 'pink', label: 'Pink' },
          { value: 'custom', label: 'Custom…' }
        ]
      },
      { key: 'appearance.accentCustom', label: 'Custom accent colour', type: 'color', default: '#a8c7fa', when: (v) => v['appearance.accent'] === 'custom' },
      { key: 'appearance.scale', label: 'Size of everything', type: 'select', default: 1, options: pct([0.8, 0.9, 1, 1.1, 1.25, 1.5]) },
      { key: 'appearance.reduceMotion', label: 'Reduce animations', type: 'toggle', default: false },
      {
        key: 'appearance.uiFont',
        label: 'Interface font',
        type: 'select',
        default: 'inter',
        advanced: true,
        options: [
          { value: 'inter', label: 'Inter (default)' },
          { value: 'segoe', label: 'Segoe UI' },
          { value: 'system', label: 'System font' }
        ]
      },
      { key: 'appearance.surfaceContrast', label: 'Panel contrast', type: 'range', default: 0, min: -2, max: 3, step: 1, advanced: true, help: 'Makes panels and cards stand out more (or less) from the background.' },
      { key: 'appearance.radius', label: 'Corner roundness', type: 'range', default: 1, min: 0, max: 1.5, step: 0.25, advanced: true },
      { key: 'appearance.toolbarSize', label: 'Toolbar size', type: 'select', default: 1, advanced: true, options: [{ value: 0.85, label: 'Compact' }, { value: 1, label: 'Normal' }, { value: 1.15, label: 'Large' }, { value: 1.3, label: 'Extra large' }] },
      { key: 'appearance.tabSize', label: 'Tab bar size', type: 'select', default: 1, advanced: true, options: [{ value: 0.85, label: 'Compact' }, { value: 1, label: 'Normal' }, { value: 1.15, label: 'Large' }] },
      { key: 'appearance.menuFont', label: 'Menu text size', type: 'number', default: 13.5, min: 11, max: 20, step: 0.5, unit: 'px', advanced: true },
      { key: 'ai.sidebarWidth', label: 'Encyclopedia panel width', type: 'number', default: 380, min: 300, max: 640, step: 10, unit: 'px', advanced: true, help: 'You can also drag the panel\u2019s left edge.' },
      { key: 'appearance.aiFont', label: 'Encyclopedia text size', type: 'number', default: 13, min: 11, max: 20, step: 0.5, unit: 'px', advanced: true }
    ]
  },
  {
    id: 'files',
    label: 'Files & saving',
    icon: 'Save',
    blurb: 'Autosave, crash recovery and version history keep your work safe.',
    fields: [
      { key: 'files.autosave', label: 'Autosave files that already have a location', type: 'toggle', default: true, help: 'Like Google Docs: changes are written to the file a few seconds after you stop typing. New files still ask where to save the first time.' },
      { key: 'files.autosaveDelay', label: 'Autosave after you stop typing for', type: 'number', default: 3, min: 1, max: 600, unit: 'seconds', advanced: true, when: (v) => v['files.autosave'] },
      { key: 'files.recovery', label: 'Crash recovery', type: 'toggle', default: true, help: 'Keeps a hidden copy of unsaved work (including new, never-saved files) so it can be restored if Kea or Windows crashes.' },
      { key: 'files.recoveryInterval', label: 'Save recovery copies every', type: 'number', default: 15, min: 5, max: 600, unit: 'seconds', advanced: true, when: (v) => v['files.recovery'] },
      { key: 'files.versions', label: 'Version history', type: 'toggle', default: true, help: 'Keeps earlier versions of each file so you can go back. Open it from the S menu → Version history.' },
      { key: 'files.versionEvery', label: 'Keep a version at most every', type: 'number', default: 10, min: 0, max: 1440, unit: 'minutes', advanced: true, when: (v) => v['files.versions'], help: '0 keeps a version on every save.' },
      { key: 'files.versionMax', label: 'Versions to keep per file', type: 'number', default: 50, min: 1, max: 1000, advanced: true, when: (v) => v['files.versions'] },
      { key: 'files.versionDays', label: 'Delete versions older than', type: 'number', default: 90, min: 1, max: 3650, unit: 'days', advanced: true, when: (v) => v['files.versions'] },
      { key: 'files.defaultFolder', label: 'Default folder for new files', type: 'folder', default: '', advanced: true, help: 'Where "Save" suggests putting files that have never been saved. Empty uses Documents.' },
      {
        key: 'files.format.doc',
        label: 'Save new documents as',
        type: 'select',
        default: 'docx',
        advanced: true,
        options: [
          { value: 'docx', label: 'Word (.docx)' },
          { value: 'html', label: 'Web page (.html)' }
        ]
      },
      {
        key: 'files.format.sheet',
        label: 'Save new spreadsheets as',
        type: 'select',
        default: 'xlsx',
        advanced: true,
        options: [
          { value: 'xlsx', label: 'Excel (.xlsx)' },
          { value: 'ods', label: 'OpenDocument (.ods)' },
          { value: 'csv', label: 'CSV (.csv)' }
        ]
      },
      { key: 'files.recentMax', label: 'Recent files to remember', type: 'number', default: 30, min: 0, max: 500, advanced: true }
    ]
  },
  {
    id: 'home',
    label: 'Home',
    icon: 'Home',
    fields: [
      { key: 'scholar.enabled', label: 'Show Scholar (classes, calendar and library)', type: 'toggle', default: true },
      { key: 'home.showStart', label: 'Show "Start new" cards', type: 'toggle', default: true },
      { key: 'home.showTools', label: 'Show quick tools (Combine PDFs, Images to PDF)', type: 'toggle', default: true },
      { key: 'home.greeting', label: 'Show greeting', type: 'toggle', default: true },
      { key: 'home.previews', label: 'Show previews of files', type: 'toggle', default: true },
      {
        key: 'home.cardSize',
        label: 'Card size',
        type: 'select',
        default: 'medium',
        options: [
          { value: 'small', label: 'Small' },
          { value: 'medium', label: 'Medium' },
          { value: 'large', label: 'Large' }
        ]
      },
      { key: 'home.descriptions', label: 'Show descriptions on cards', type: 'toggle', default: true },
      { key: 'home.previewOnline', label: 'Make previews of online-only cloud files', type: 'toggle', default: false, advanced: true, help: 'Downloads those files to this PC to draw their preview.' },
      { key: 'home.showAllTypes', label: 'Show every file type in folders', type: 'toggle', default: false, advanced: true, help: 'Normally Home only lists files Kea can open.' },
      { key: 'home.showHidden', label: 'Show hidden files and folders', type: 'toggle', default: false, advanced: true },
      { key: 'home.previewMaxMb', label: 'Skip previews for files bigger than', type: 'number', default: 80, min: 1, max: 2000, unit: 'MB', advanced: true }
    ]
  },
  {
    id: 'docs',
    label: 'Documents',
    icon: 'FileText',
    blurb: 'Defaults for new documents. Each document can change its own in Page setup.',
    fields: [
      {
        key: 'doc.paper',
        label: 'Page colour while editing',
        type: 'select',
        default: 'match',
        options: [
          { value: 'match', label: 'As the theme' },
          { value: 'dark', label: 'Dark grey (easy on the eyes)' },
          { value: 'light', label: 'White (like paper)' }
        ],
        help: 'Printing and PDFs are always on white.'
      },
      { key: 'doc.replyToClaude', label: 'Replying to Claude’s comments asks Claude', type: 'toggle', default: true, help: 'A reply in the thread of one of Claude’s comments (or one that says “Claude”) goes to Claude, which answers in the thread and makes the small fix you ask for.' },
      { key: 'doc.font', label: 'Font', type: 'select', default: 'Arial', options: ['Arial', 'Calibri', 'Cambria', 'Georgia', 'Garamond', 'Segoe UI', 'Times New Roman', 'Trebuchet MS', 'Verdana'].map((f) => ({ value: f, label: f })) },
      { key: 'doc.size', label: 'Font size', type: 'number', default: 11, min: 6, max: 72, step: 0.5, unit: 'pt' },
      {
        key: 'doc.lineHeight',
        label: 'Line spacing',
        type: 'select',
        default: 1.15,
        options: [
          { value: 1, label: 'Single' },
          { value: 1.15, label: '1.15' },
          { value: 1.5, label: '1.5' },
          { value: 2, label: 'Double' }
        ]
      },
      { key: 'doc.spaceAfter', label: 'Space after paragraphs', type: 'number', default: 6, min: 0, max: 72, unit: 'pt', advanced: true },
      { key: 'doc.firstLine', label: 'Indent the first line of paragraphs', type: 'number', default: 0, min: 0, max: 3, step: 0.25, unit: 'in', advanced: true },
      {
        key: 'doc.pageSize',
        label: 'Paper size',
        type: 'select',
        default: 'letter',
        options: [
          { value: 'letter', label: 'Letter' },
          { value: 'a4', label: 'A4' },
          { value: 'legal', label: 'Legal' },
          { value: 'a5', label: 'A5' }
        ]
      },
      { key: 'doc.margin', label: 'Margins', type: 'number', default: 1, min: 0, max: 4, step: 0.25, unit: 'in', advanced: true },
      { key: 'doc.pageless', label: 'Pageless (one long page, no page breaks)', type: 'toggle', default: false },
      { key: 'doc.zoom', label: 'Zoom', type: 'select', default: 1, options: pct([0.75, 0.9, 1, 1.1, 1.25, 1.5]), advanced: true },
      { key: 'doc.citationStyle', label: 'Citation style', type: 'select', default: 'mla', options: [{ value: 'mla', label: 'MLA 9' }, { value: 'apa', label: 'APA 7' }, { value: 'chicago', label: 'Chicago (author-date)' }] },
      { key: 'doc.statusHints', label: 'Show keyboard hints in the status bar', type: 'toggle', default: true, advanced: true }
    ]
  },
  {
    id: 'writing',
    label: 'Grammar & spelling',
    icon: 'SpellCheck',
    blurb: 'Grammar checking runs entirely on this computer (Harper). Nothing you write is sent anywhere.',
    fields: [
      { key: 'grammar.enabled', label: 'Check grammar and style as you type', type: 'toggle', default: true },
      {
        key: 'grammar.dialect',
        label: 'English',
        type: 'select',
        default: 'American',
        options: [
          { value: 'American', label: 'American' },
          { value: 'British', label: 'British' },
          { value: 'Canadian', label: 'Canadian' },
          { value: 'Australian', label: 'Australian' },
          { value: 'Indian', label: 'Indian' }
        ]
      },
      { key: 'grammar.style', label: 'Style suggestions (wordiness, repetition, word choice)', type: 'toggle', default: true },
      { key: 'grammar.punctuation', label: 'Punctuation and formatting', type: 'toggle', default: true, advanced: true },
      { key: 'grammar.capitalization', label: 'Capitalization', type: 'toggle', default: true, advanced: true },
      { key: 'grammar.spelling', label: 'Spelling (in addition to the red spell-check underline)', type: 'toggle', default: false, advanced: true }
    ]
  },
  {
    id: 'sheets',
    label: 'Spreadsheets',
    icon: 'Sheet',
    fields: [
      { key: 'sheet.gridlines', label: 'Show gridlines', type: 'toggle', default: true },
      {
        key: 'sheet.enterMoves',
        label: 'After pressing Enter, move',
        type: 'select',
        default: 'down',
        options: [
          { value: 'down', label: 'Down' },
          { value: 'right', label: 'Right' },
          { value: 'none', label: "Don't move" }
        ]
      },
      { key: 'sheet.fontSize', label: 'Cell text size on screen', type: 'number', default: 13, min: 9, max: 24, unit: 'px', advanced: true, help: 'Only changes how the grid looks here, not the file.' },
      { key: 'sheet.autocomplete', label: 'Suggest function names while typing a formula', type: 'toggle', default: true, advanced: true },
      { key: 'sheet.stats', label: 'Show sum, average and count of the selection', type: 'toggle', default: true, advanced: true }
    ]
  },
  {
    id: 'voice',
    label: 'Voice typing',
    icon: 'Mic',
    blurb: 'Talk and Kea types for you, in documents, slides, cells and text boxes. Start it with Ctrl+Alt+V. Speech is turned into text on this PC; nothing is uploaded.',
    fields: [
      { key: 'voice.model', label: 'Speech model', type: 'select', default: 'base', options: [{ value: 'tiny', label: 'Fastest (English)' }, { value: 'base', label: 'Balanced (English)' }, { value: 'small', label: 'Most accurate (English)' }, { value: 'base-multi', label: 'Balanced (many languages)' }, { value: 'small-multi', label: 'Most accurate (many languages)' }] },
      { key: 'voice.language', label: 'Language you speak', type: 'select', default: 'auto', options: [{ value: 'auto', label: 'Detect automatically' }, { value: 'english', label: 'English' }, { value: 'spanish', label: 'Spanish' }, { value: 'french', label: 'French' }, { value: 'german', label: 'German' }, { value: 'italian', label: 'Italian' }, { value: 'portuguese', label: 'Portuguese' }, { value: 'dutch', label: 'Dutch' }, { value: 'polish', label: 'Polish' }, { value: 'russian', label: 'Russian' }, { value: 'ukrainian', label: 'Ukrainian' }, { value: 'turkish', label: 'Turkish' }, { value: 'arabic', label: 'Arabic' }, { value: 'hindi', label: 'Hindi' }, { value: 'chinese', label: 'Chinese' }, { value: 'japanese', label: 'Japanese' }, { value: 'korean', label: 'Korean' }, { value: 'vietnamese', label: 'Vietnamese' }, { value: 'indonesian', label: 'Indonesian' }, { value: 'tagalog', label: 'Tagalog' }], when: (v) => String(v['voice.model'] || '').endsWith('-multi') },
      { key: 'voice.commands', label: 'Say "new line" or "new paragraph" to start one', type: 'toggle', default: true },
      { key: 'voice.filterFillers', label: 'Leave out "um" and "uh"', type: 'toggle', default: true },
      { key: 'voice.pause', label: 'Pause that ends a phrase', type: 'number', default: 700, min: 200, max: 3000, step: 50, unit: 'ms', advanced: true, help: 'Your words appear after you pause this long. Longer pauses give the model more context (often more accurate) but text appears later.' },
      { key: 'voice.maxPhrase', label: 'Longest phrase before typing anyway', type: 'number', default: 20, min: 5, max: 30, unit: 'seconds', advanced: true },
      { key: 'voice.sensitivity', label: 'Microphone sensitivity', type: 'range', default: 5, min: 1, max: 10, step: 1, advanced: true, help: 'Raise it if quiet speech is missed; lower it if background noise gets typed.' },
      { key: 'voice.noiseSuppression', label: 'Reduce background noise', type: 'toggle', default: true, advanced: true },
      { key: 'voice.idleStop', label: 'Stop listening after silence of', type: 'number', default: 60, min: 0, max: 3600, unit: 'seconds', advanced: true, help: '0 keeps listening until you stop it.' }
    ]
  },
  {
    id: 'slides',
    label: 'Presentations',
    icon: 'Presentation',
    fields: [
      {
        key: 'slides.presenterView',
        label: 'When presenting on one screen, start in',
        type: 'select',
        default: 'audience',
        options: [
          { value: 'audience', label: 'Full-screen slides' },
          { value: 'speaker', label: 'Speaker view (notes, next slide, timer)' }
        ],
        help: 'Press S while presenting to switch.'
      },
      { key: 'slides.useSecondScreen', label: 'With a second screen, show slides there and the speaker view here', type: 'toggle', default: true },
      { key: 'slides.notesSize', label: 'Speaker notes text size', type: 'number', default: 20, min: 12, max: 48, unit: 'px', advanced: true }
    ]
  },
  {
    id: 'code',
    label: 'Text & code',
    icon: 'FileCode2',
    fields: [
      { key: 'code.fontSize', label: 'Font size', type: 'number', default: 14, min: 8, max: 40, unit: 'px' },
      { key: 'code.wrap', label: 'Wrap long lines', type: 'toggle', default: true },
      { key: 'code.lineNumbers', label: 'Show line numbers', type: 'toggle', default: true },
      { key: 'code.tabSize', label: 'Tab width', type: 'select', default: 2, options: [2, 4, 8].map((n) => ({ value: n, label: `${n} spaces` })), advanced: true },
      { key: 'code.font', label: 'Font', type: 'text', default: "'Cascadia Code', Consolas, monospace", advanced: true },
      { key: 'code.highlightLine', label: 'Highlight the current line', type: 'toggle', default: true, advanced: true }
    ]
  },
  {
    id: 'video',
    label: 'Video editor',
    icon: 'Clapperboard',
    fields: [
      {
        key: 'video.renderer',
        label: 'Picture quality',
        type: 'select',
        default: 'gpu16',
        options: [
          { value: 'gpu16', label: 'Studio: 16-bit on the graphics card (best)' },
          { value: 'basic', label: 'Basic: 8-bit (older computers)' }
        ],
        help: 'Studio grades, resizes, blurs and blends in 16-bit linear light with sharp Lanczos resizing and dithering, so gradients don’t band and edges stay clean. Basic is the simpler 8-bit renderer, for graphics cards that can’t do 16-bit.'
      },
      {
        key: 'video.linearMix',
        label: 'Mix dissolves and opacity in linear light',
        type: 'toggle',
        default: true,
        advanced: true,
        help: 'On: dissolves, fades and see-through layers mix the way light does, with no muddy or dark middle (Premiere’s “composite in linear color”). Off: mix in display colour, the way Resolve and older editors do by default. Resizing and blur always use linear light. Studio quality only.'
      }
    ]
  },
  {
    id: 'pdf',
    label: 'PDFs',
    icon: 'FileType2',
    fields: [
      {
        key: 'pdf.zoom',
        label: 'Zoom when opening a PDF',
        type: 'select',
        default: 'auto',
        options: [
          { value: 'auto', label: 'Fit width (up to 125%)' },
          { value: 'width', label: 'Fit width' },
          { value: 'page', label: 'Whole page' },
          ...pct([0.5, 0.75, 1, 1.25, 1.5, 2])
        ]
      },
      { key: 'pdf.sidebar', label: 'Show page thumbnails', type: 'toggle', default: true },
      {
        key: 'pdf.darkPages',
        label: 'Page colour (view only)',
        type: 'select',
        default: 'match',
        options: [
          { value: 'match', label: 'As the theme' },
          { value: 'light', label: 'Always white' },
          { value: 'dark', label: 'Always dark' }
        ],
        help: 'Textbooks and PDFs take the theme\u2019s colours unless you pick one here. Scans stay white.'
      },
      { key: 'pdf.highlightColor', label: 'Highlighter colour', type: 'color', default: '#ffd400' },
      { key: 'pdf.inkColor', label: 'Pen colour', type: 'color', default: '#1a73e8', advanced: true },
      { key: 'pdf.inkWidth', label: 'Pen thickness', type: 'range', default: 2.5, min: 0.5, max: 12, step: 0.5, advanced: true },
      { key: 'pdf.highlightOpacity', label: 'Highlighter strength', type: 'range', default: 0.4, min: 0.1, max: 1, step: 0.05, advanced: true },
      { key: 'pdf.textSize', label: 'Size of added text', type: 'number', default: 14, min: 6, max: 96, unit: 'pt', advanced: true },
      { key: 'pdf.textColor', label: 'Colour of added text', type: 'color', default: '#000000', advanced: true },
      { key: 'pdf.ocrConfidence', label: 'OCR: skip words recognised with less than', type: 'number', default: 30, min: 0, max: 95, unit: '% confidence', advanced: true, help: 'Higher leaves out more guesses (cleaner, but may miss words).' },
      { key: 'pdf.ocrDpi', label: 'OCR: scan resolution', type: 'select', default: 225, advanced: true, options: [{ value: 150, label: 'Fast (150 dpi)' }, { value: 225, label: 'Standard (225 dpi)' }, { value: 300, label: 'Small print (300 dpi)' }, { value: 400, label: 'Tiny print (400 dpi, slow)' }] },
      { key: 'pdf.compressLightQuality', label: 'Compress (keep quality): photo quality', type: 'range', default: 78, min: 30, max: 95, step: 1, advanced: true },
      { key: 'pdf.compressLightSize', label: 'Compress (keep quality): longest side of photos', type: 'number', default: 2000, min: 400, max: 8000, unit: 'px', advanced: true },
      { key: 'pdf.compressStrongQuality', label: 'Compress (smallest): photo quality', type: 'range', default: 60, min: 20, max: 95, step: 1, advanced: true },
      { key: 'pdf.compressStrongSize', label: 'Compress (smallest): longest side of photos', type: 'number', default: 1200, min: 300, max: 8000, unit: 'px', advanced: true },
      { key: 'pdf.redactMetadata', label: 'Remove title and author when redacting', type: 'toggle', default: true, help: 'Hidden document details can reveal what was redacted.' },
      { key: 'pdf.redactDpi', label: 'Quality of redacted pages', type: 'select', default: 200, advanced: true, options: [{ value: 150, label: '150 dpi (smaller file)' }, { value: 200, label: '200 dpi' }, { value: 300, label: '300 dpi (sharper)' }, { value: 600, label: '600 dpi (print quality)' }], help: 'Redacted pages are saved as images so nothing underneath can be recovered.' }
    ]
  },
  {
    id: 'google',
    label: 'Google account',
    icon: 'Cloud',
    fields: [
      {
        key: 'google.openWith',
        label: 'Open Google Docs, Sheets and Slides',
        type: 'select',
        default: 'kea',
        options: [
          { value: 'kea', label: 'In Kea' },
          { value: 'browser', label: 'In the web browser' }
        ]
      },
      { key: 'google.autosave', label: 'Save changes back to Google Drive automatically', type: 'toggle', default: true },
      { key: 'google.clientId', label: 'OAuth client ID', type: 'text', default: '', advanced: true, help: 'From your own Google Cloud project (see the setup steps above).' },
      { key: 'google.clientSecret', label: 'OAuth client secret', type: 'text', default: '', advanced: true }
    ]
  },
  {
    id: 'scholar',
    label: 'Scholar',
    icon: 'GraduationCap',
    blurb: 'Your classes, their textbooks and calendar. Classes you add from your school are kept up to date by scans that run in the background through your own Claude account.',
    fields: [
      {
        key: 'scholar.scanEvery',
        group: 'Checking your classes',
        label: 'Check my classes',
        type: 'select',
        default: '1',
        options: [['1', 'Every day'], ['2', 'Every 2 days'], ['3', 'Every 3 days'], ['7', 'Once a week'], ['0', 'Only when I ask (Scans → Check my classes now)']].map(([value, label]) => ({ value, label })),
        help: 'Anything that needs you, missed work, and any new class (scanned in full). Kea checks first by itself and only uses your Claude plan for classes where something changed.'
      },
      {
        key: 'scholar.scanTime',
        label: 'Run the checks after',
        type: 'select',
        default: '05:00',
        options: ['03:00', '04:00', '05:00', '06:00', '07:00', '08:00', '12:00', '18:00'].map((t) => ({ value: t, label: new Date(`2000-01-01T${t}`).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) })),
        help: 'If Kea is closed then, the check runs the next time it opens.'
      },
      {
        key: 'scholar.inboxMinutes',
        label: 'Look for new announcements, grades, feedback and messages every',
        type: 'select',
        default: '30',
        options: [['15', '15 minutes'], ['30', '30 minutes'], ['60', 'Hour'], ['180', '3 hours'], ['720', '12 hours'], ['1440', 'Day'], ['0', 'Only with the class check']].map(([value, label]) => ({ value, label })),
        help: 'A quick look done by Kea itself (no Claude usage). Each new thing shows in the Inbox as its own message, with a notification.'
      },
      {
        key: 'scholar.weeklyDay',
        label: 'Update readings, links and class changes',
        type: 'select',
        default: 'daily',
        options: [{ value: 'daily', label: 'Every day' }, ...['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].map((d) => ({ value: d, label: `Every ${d[0].toUpperCase() + d.slice(1)}` }))],
        help: 'Kea compares each class with last time by itself; Claude only reads a class when something moved or next week’s reading needs building, so checking daily rarely costs anything.'
      },
      {
        key: 'scholar.fullCheckDays',
        label: 'Full check (outside platforms like ALEKS) every',
        type: 'select',
        default: '1',
        options: [['1', 'Day'], ['2', '2 days'], ['3', '3 days'], ['7', 'Week']].map(([value, label]) => ({ value, label })),
        help: 'Outside platforms’ gradebooks can’t be checked without Claude, so on the other days only classes with something new are read. Every day uses a little more of your Claude plan.'
      },
      { key: 'scholar.curriculumCheck', label: 'Match chapters to each syllabus', type: 'toggle', default: true, help: 'Every day Kea compares each class’s chapters with its syllabus outcomes and topical outline by itself; Claude only fixes a class when something doesn’t match. Shown under each class → Textbook → Syllabus.' },
      { key: 'scholar.notifyMessages', group: 'Notifications', label: 'Notify me of new messages', type: 'toggle', default: true, help: 'With who sent it and the whole message. Click it to answer in Kea with the reply box open.' },
      { key: 'scholar.notifyAnnouncements', label: 'Notify me of announcements', type: 'toggle', default: true },
      { key: 'scholar.notifyGrades', label: 'Notify me of new grades and feedback', type: 'toggle', default: true },
      { key: 'scholar.notifyQuietClasses', label: 'Classes to keep quiet', type: 'text', default: '', advanced: true, help: 'Class codes, separated by commas (BIO1112, ENG1001). Their news still goes to the Inbox.' },
      { key: 'scholar.notifyQuietFrom', label: 'Quiet hours from', type: 'text', default: '', advanced: true, help: 'Like 22:00. Notifications in the quiet hours come without a sound.' },
      { key: 'scholar.notifyQuietTo', label: 'Quiet hours until', type: 'text', default: '', advanced: true, help: 'Like 07:00.' },
      { key: 'scholar.background', label: 'Keep checking when Kea’s window is closed', type: 'toggle', default: true, help: 'Closing the window leaves Kea in the notification area (by the clock), so the class checks and paused scans still run. Quit from its icon there.' },
      { key: 'scholar.studyPdfs', group: 'Textbooks and study', label: "Write each week's textbook chapters", type: 'toggle', default: true, help: "Each class's chapters for the week ahead, written from what the class covers and its tests." },
      { key: 'scholar.questionBanks', label: 'Keep a question bank for every chapter', type: 'toggle', default: true, help: 'Each chapter with a textbook gets saved practice questions (Quiz me in the textbook), and more are written when you run low. Written once, then free to take on every device.' },
      {
        key: 'scholar.bankSize',
        label: 'Questions per chapter',
        type: 'select',
        default: '25',
        options: ['25', '50', '75', '100'].map((n) => ({ value: n, label: n })),
        advanced: true,
        help: 'How many each chapter starts with. When only 5 are left that you haven’t seen or last got wrong, Kea writes 20 more.'
      },
      { key: 'scholar.instructorHints', label: 'Write practice when the instructor points something out', type: 'toggle', default: true, help: 'When a message or announcement says the test will have problems like something ("practice these, the practical will have more like them"), Kea always keeps it word for word for every practice set it writes for that class. With this on, it also writes 25 questions in that style for the next test right away (at most one set per class every three days).' },
      { key: 'scholar.pictureQuestions', label: 'Picture questions for identification', type: 'toggle', default: true, help: 'Chapters that test recognizing things (lab practicals, specimens, structures, anatomy, glassware, molecular shapes) get a set of questions that show a real picture from Wikimedia Commons and ask what it is. Pictures are saved with the questions, so they work offline.' },
      { key: 'scholar.depthReviews', label: 'Review chapters at exam depth', type: 'toggle', default: true, advanced: true, help: 'When your teacher posts something new for a test within three weeks (a study focus, a review sheet or key), Claude checks those chapters against it and writes a practice set for that test where they fall short. It fixes explanations only on questions you got wrong, and rewrites a textbook chapter only when it’s missing something the test asks. Nothing new from the teacher, no run.' },
      { key: 'scholar.weekStart', group: 'Calendar', label: 'Weeks start on', type: 'select', default: '0', options: [['0', 'Sunday'], ['1', 'Monday'], ['2', 'Tuesday'], ['3', 'Wednesday'], ['4', 'Thursday'], ['5', 'Friday'], ['6', 'Saturday']].map(([value, label]) => ({ value, label })), help: 'The first day of each week in the calendar. Kea on your phone has its own setting (Settings → Calendar).' },
      { key: 'scholar.homeClasses', group: 'Home', label: 'Show my classes as cards on Home', type: 'toggle', default: true, help: 'Each class with its picture, its colour and its grade, under any missing work. Click a card to open the class: Study, Readings and this week’s reading are at the top. Class colours are set under This week → Colours (by class).' },
      {
        key: 'scholar.homeColumns',
        label: 'Class cards',
        type: 'select',
        default: '2',
        options: [['1', 'One per row'], ['2', 'Two across (2×2)'], ['3', 'Three across'], ['4', 'Four across']].map(([value, label]) => ({ value, label })),
        when: (v) => v['scholar.homeClasses'] !== false
      },
      { key: 'scholar.homePictures', label: 'Class pictures from the class site', type: 'toggle', default: true, when: (v) => v['scholar.homeClasses'] !== false, help: 'The picture each class has on D2L or Canvas. A class without one shows its colour.' },
      { key: 'scholar.homeGrades', label: 'Grade on each class', type: 'toggle', default: true, when: (v) => v['scholar.homeClasses'] !== false },
      { key: 'scholar.parallelRuns', group: 'Practice questions', label: 'Question sets written at once', type: 'number', default: 3, min: 1, max: 20, step: 1, help: 'When you write questions for several chapters, this many are written at the same time (each chapter is its own Claude run). More is faster and uses your Claude plan’s limit sooner; the same total either way. Class checks and textbooks still run one at a time.' },
      { key: 'study.mix.mc', group: 'Mix of question kinds', label: 'Multiple choice', type: 'range', default: 5, min: 0, max: 10, advanced: true, help: 'How often each kind of question comes up in a practice exam, compared with the others (0 leaves it out). Kea uses what each chapter has: when there aren’t enough of one kind, the others fill in.' },
      { key: 'study.mix.blank', label: 'Fill in the blank', type: 'range', default: 3, min: 0, max: 10, advanced: true },
      { key: 'study.mix.match', label: 'Matching', type: 'range', default: 2, min: 0, max: 10, advanced: true },
      { key: 'study.mix.multi', label: 'Select all that apply', type: 'range', default: 2, min: 0, max: 10, advanced: true },
      { key: 'study.mix.num', label: 'Calculations', type: 'range', default: 3, min: 0, max: 10, advanced: true, help: 'Only in chapters that have calculations.' },
      { key: 'study.mix.tf', label: 'True or false', type: 'range', default: 1, min: 0, max: 10, advanced: true },
      { key: 'study.mix.short', label: 'Written answers', type: 'range', default: 1, min: 0, max: 10, advanced: true, help: 'You mark these yourself against the model answer.' },
      { key: 'scholar.mailSignature', group: 'Messages', label: 'Message signature', type: 'text', default: '', help: 'Added under every new message you write in Messages (edit it there, under Signature).', advanced: true },
      { key: 'scholar.mailSignatureReplies', label: 'Add the signature to replies too', type: 'toggle', default: true, advanced: true },
      {
        key: 'scholar.cloud',
        group: 'Your devices',
        label: 'Sync your phone and other devices through',
        type: 'select',
        default: 'auto',
        options: [
          { value: 'auto', label: 'Automatic (OneDrive if it’s here, otherwise Google Drive)' },
          { value: 'onedrive', label: 'OneDrive' },
          { value: 'google', label: 'Google Drive' },
          { value: 'custom', label: 'Another folder (below)' },
          { value: 'off', label: 'Don’t sync' }
        ],
        help: 'Everything goes in one “Kea” folder in that drive. Every device must use the same drive and account. Scans → Devices shows each device and which one scans.'
      },
      { key: 'scholar.cloudPath', label: 'Other folder to sync through', type: 'text', default: '', advanced: true },
      {
        key: 'scholar.pcSync',
        label: 'Keep your other computers in step',
        type: 'toggle',
        default: true,
        advanced: true,
        help: 'Kea on another computer with the same drive shows the same classes, checkmarks, Inbox and study sets. Only the primary device (Scans → Devices) ever checks the class site or uses your Claude plan.'
      },
      { key: 'scholar.deviceName', label: 'This device’s name', type: 'text', default: '', advanced: true, help: 'Shown to your other devices. Empty: the computer’s own name.' },
      {
        key: 'scholar.pcTakeover',
        label: 'If the primary hasn’t been on for a while, this device takes over scanning after',
        type: 'select',
        default: '0',
        options: [['0', 'Never (I choose the primary in Scans → Devices)'], ['24', 'A day'], ['48', '2 days'], ['72', '3 days'], ['168', 'A week']].map(([value, label]) => ({ value, label })),
        advanced: true
      }
    ]
  },
  {
    id: 'sites',
    label: 'Class sites',
    icon: 'Globe',
    blurb: 'Kea’s own window for your class site and the pages it links to.',
    fields: [
      { key: 'sites.dark', label: 'Dark mode on class sites', type: 'toggle', default: true, help: 'D2L Brightspace, Canvas, Blackboard, Moodle, Schoology, Google Classroom and publisher sites open dark in Kea’s class-site window. Photos and videos keep their colours; pages that are already dark are left alone. Right-click a page to turn it off for just that site.' },
      { key: 'sites.darkHeader', label: 'Site headers in Kea’s colours', type: 'toggle', default: true, when: (v) => v['sites.dark'] !== false, help: 'The D2L, Canvas and Moodle header bar takes Kea’s background and your accent colour.' },
      { key: 'sites.matchKea', label: 'Pages in Kea’s colours', type: 'toggle', default: true, when: (v) => v['sites.dark'] !== false, help: 'Backgrounds and text take Kea’s exact panel and text colours, and each site’s own brand colour (ALEKS’s blue, Pearson’s teal, buttons, links and tabs) becomes your accent colour. Right and wrong colours (green, red) stay as they are. Off uses the Darkness, Brightness, Contrast and Warmth sliders.' },
      { key: 'sites.darkStrength', label: 'Darkness', type: 'range', default: 0.9, min: 0.7, max: 1, step: 0.02, when: (v) => v['sites.dark'] !== false && v['sites.matchKea'] === false },
      { key: 'sites.darkBrightness', label: 'Brightness', type: 'range', default: 1, min: 0.7, max: 1.3, step: 0.05, when: (v) => v['sites.dark'] !== false && v['sites.matchKea'] === false },
      { key: 'sites.darkContrast', label: 'Contrast', type: 'range', default: 1, min: 0.7, max: 1.4, step: 0.05, when: (v) => v['sites.dark'] !== false && v['sites.matchKea'] === false },
      { key: 'sites.darkWarmth', label: 'Warmth (less blue light)', type: 'range', default: 0, min: 0, max: 0.4, step: 0.05, when: (v) => v['sites.dark'] !== false && v['sites.matchKea'] === false },
      { key: 'sites.darkDocs', label: 'Darken documents and PDFs shown in the page', type: 'toggle', default: false, when: (v) => v['sites.dark'] !== false, help: 'Off keeps handouts and PDFs white, the way they print.' },
      ...([
        ['d2l', 'D2L Brightspace'],
        ['canvas', 'Canvas'],
        ['blackboard', 'Blackboard'],
        ['moodle', 'Moodle'],
        ['schoology', 'Schoology'],
        ['classroom', 'Google Classroom'],
        ['publishers', 'Publisher sites (Pearson, McGraw Hill, Cengage, ALEKS, zyBooks…)'],
        ['other', 'Every other site']
      ] as const).map(([id, label]) => ({ key: `sites.dark.${id}`, label: `Dark: ${label}`, type: 'toggle' as const, default: true, advanced: true, when: (v: any) => v['sites.dark'] !== false })),
      { key: 'sites.adblock', label: 'Block ads and trackers', type: 'toggle', default: true, help: 'Uses the same filter lists as uBlock Origin (EasyList, EasyPrivacy), updated weekly. uBlock Origin itself can’t run inside Kea.' }
    ]
  },
  {
    id: 'lookup',
    label: 'Encyclopedia',
    icon: 'BookOpen',
    blurb: 'Highlight a word or idea and press Ctrl+J. Explain shows Wikipedia’s own words, with a link to the article; Dictionary shows Wiktionary’s entry with its examples (or the offline dictionary when you’re offline).',
    fields: [
      {
        key: 'lookup.lang',
        label: 'Wikipedia language',
        type: 'select',
        default: 'en',
        options: [['en', 'English'], ['simple', 'Simple English (easier words)'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'], ['pt', 'Portuguese'], ['nl', 'Dutch'], ['pl', 'Polish'], ['ru', 'Russian'], ['ja', 'Japanese'], ['zh', 'Chinese'], ['ar', 'Arabic']].map(([value, label]) => ({ value, label }))
      },
      { key: 'lookup.useModel', label: 'Let the local model pick the right article and sections', type: 'toggle', default: true, help: 'Only when a model is downloaded (below). It chooses among Wikipedia’s options and never writes text.' },
      { key: 'lookup.questions', label: 'Answer highlighted questions and fill-in-the-blanks', type: 'toggle', default: true, help: 'Highlight a question and Explain shows only the Wikipedia passages that explain it, word for word with their sources, instead of whole articles. A term on its own (or “What is osmosis?”) is still explained in full.' },
      { key: 'lookup.qBroad', label: '“What is X?” and “Define X” explain X in full', type: 'toggle', default: true, advanced: true },
      {
        key: 'lookup.qUnit',
        label: 'Passage size for questions',
        type: 'select',
        default: 'paragraph',
        advanced: true,
        options: [
          { value: 'paragraph', label: 'Paragraphs (a whole section when its title names what’s asked)' },
          { value: 'section', label: 'Whole sections' }
        ]
      },
      { key: 'lookup.qPassages', label: 'Passages per question part', type: 'number', default: 2, min: 1, max: 4, advanced: true },
      { key: 'lookup.qContinue', label: 'Include the paragraphs that carry a passage on (“This…”)', type: 'toggle', default: true, advanced: true },
      { key: 'lookup.qDedicated', label: 'Prefer an article about the exact process asked about', type: 'toggle', default: true, help: '“Chloride shift” for a question on how chloride helps carry carbon dioxide.', advanced: true },
      { key: 'lookup.qGuesses', label: 'Let the local model suggest what to search for', type: 'toggle', default: true, help: 'It guesses likely answers and the names of the processes involved, only as search words. They’re never shown, and a passage is shown only when Wikipedia’s own wording confirms it.', advanced: true },
      { key: 'lookup.qMarkAnswer', label: 'Underline the sentence that answers each part', type: 'toggle', default: true, advanced: true },
      { key: 'lookup.qLearn', label: 'Learning mode: hide the answering sentence until you click it', type: 'toggle', default: false, advanced: true },
      { key: 'lookup.mendInput', label: 'Fix highlights that cut a word off', type: 'toggle', default: true, help: '“polar dissolves pol” becomes “polar dissolves polar”, using the words in your document (or Wikipedia’s titles, when you type).', advanced: true },
      { key: 'lookup.findPassage', label: 'Find the part of the article about what you highlighted', type: 'toggle', default: true, help: 'When a term is covered inside a bigger article (“saturated solution” in “Solubility”), show the paragraphs about it first.', advanced: true },
      { key: 'lookup.passages', label: 'Paragraphs about the term to show', type: 'number', default: 2, min: 1, max: 5, advanced: true },
      { key: 'lookup.sections', label: 'Article sections to show under the definition', type: 'number', default: 2, min: 0, max: 6, advanced: true },
      {
        key: 'lookup.dictSource',
        label: 'Dictionary',
        type: 'select',
        default: 'wiktionary',
        options: [
          { value: 'wiktionary', label: 'Wiktionary when online (fuller, with examples), offline dictionary otherwise' },
          { value: 'wordnet', label: 'Offline dictionary only (WordNet)' }
        ],
        help: 'Wiktionary is Wikipedia’s dictionary; only the word is sent.'
      },
      { key: 'lookup.dictSenses', label: 'Dictionary meanings per part of speech', type: 'number', default: 12, min: 1, max: 30, advanced: true },
      { key: 'lookup.dictExamples', label: 'Example sentences per meaning', type: 'number', default: 4, min: 0, max: 10, advanced: true },
      { key: 'lookup.dictSubsenses', label: 'Show narrower meanings under each meaning', type: 'toggle', default: true, advanced: true }
    ]
  },
  {
    id: 'assistant',
    label: 'Claude Assistant',
    icon: 'Sparkles',
    blurb: 'Press Ctrl+Shift+J in any file (document, PDF, spreadsheet, slides, code, photo or video) to talk to Claude about it. Claude reads the file and makes the changes you ask for with the editor’s own tools; each change is one Ctrl+Z. It runs on your own Claude plan (through Claude Code) or your own Anthropic API key, kept encrypted on this computer. The Encyclopedia stays Wikipedia only.',
    fields: [
      { key: 'assistant.enabled', label: 'Show the Claude button in editors', type: 'toggle', default: true },
      {
        key: 'assistant.provider',
        label: 'Run Claude on',
        type: 'select',
        default: 'plan',
        options: [
          { value: 'plan', label: 'My Claude plan (Pro / Max, through Claude Code)' },
          { value: 'api', label: 'An Anthropic API key (pay per use)' }
        ],
        help: 'Your plan: uses your Claude subscription’s limits (shown as usage bars in the Claude tab); needs Claude Code, which Kea can install and sign in for you. API key: billed per token by Anthropic.'
      },
      { key: 'assistant.usageBars', label: 'Show my plan’s 5-hour and weekly usage in the Claude tab', type: 'toggle', default: true },
      {
        key: 'design.style',
        group: 'Design',
        label: 'Your house style (optional)',
        type: 'text',
        default: '',
        help: 'A line Claude follows in every design, e.g. “clean editorial, navy and warm orange, Bahnschrift headlines, lots of white space”. Overrides Kea’s defaults; leave empty for Kea’s own high standard.'
      },
      {
        key: 'design.guidelinesFolder',
        group: 'Design',
        label: 'Your own design guidelines',
        type: 'folder',
        default: '',
        help: 'A folder of Markdown or text files (brand rules, style guides, research). Claude reads them before designing and they take priority over Kea’s built-in guide.'
      },
      {
        key: 'assistant.model',
        label: 'Model',
        type: 'select',
        default: 'claude-opus-5-5',
        options: [
          { value: 'claude-opus-5-5', label: 'Claude Opus 5.5 (best for most work)' },
          { value: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (faster, half the price)' },
          { value: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (quickest and cheapest)' },
          { value: 'claude-fable-5-1', label: 'Claude Fable 5.1 (most capable, costs the most)' }
        ]
      },
      {
        key: 'assistant.effort',
        label: 'How hard Claude thinks',
        type: 'select',
        default: 'medium',
        options: [
          { value: 'low', label: 'Low (quick answers, fewest tokens)' },
          { value: 'medium', label: 'Medium' },
          { value: 'high', label: 'High (careful edits and harder problems)' },
          { value: 'xhigh', label: 'Extra high' },
          { value: 'max', label: 'Maximum (slowest, most tokens)' }
        ],
        help: 'More thinking costs more tokens. Medium suits most editing; raise it for hard maths, code or long rewrites.'
      },
      { key: 'assistant.autoLook', label: 'Show Claude a picture of photos, slides and video frames with each message', type: 'toggle', default: true, help: 'Off: Claude looks only when it decides to (or when you press the eye button). Each picture costs about 1,600 tokens.' },
      { key: 'assistant.track', label: 'Make Claude’s document edits as suggestions', type: 'toggle', default: false, help: 'Edits show as tracked changes you accept or reject, instead of changing the text directly.' },
      { key: 'assistant.web', label: 'Let Claude search the web (to find and check sources)', type: 'toggle', default: true, help: 'On your Claude plan, Claude can look things up and open web pages, for example to verify a source before citing it. Searches count toward your plan’s usage.' },
      { key: 'assistant.showThinking', label: 'Show Claude’s reasoning (folded)', type: 'toggle', default: false, advanced: true },
      { key: 'assistant.showSteps', label: 'List every step Claude takes', type: 'toggle', default: false, advanced: true, help: 'Off: the steps fold into one line you can open. On: each step is listed as it happens.' },
      { key: 'assistant.showUsage', label: 'Show tokens used under the conversation', type: 'toggle', default: true, advanced: true }
    ]
  },
  {
    id: 'aimodels',
    label: 'AI image tools',
    icon: 'Wand2',
    blurb: 'Download on-device AI models for the photo and video editors — background removal and subject selection. They run on this computer, on your graphics card where possible; nothing is uploaded.',
    fields: [
      {
        key: 'ai.accel',
        label: 'Run AI on',
        type: 'select',
        default: 'auto',
        options: [
          { value: 'auto', label: 'Graphics card when it works (fastest)' },
          { value: 'gpu', label: 'Graphics card always' },
          { value: 'cpu', label: 'Processor (native)' },
          { value: 'window', label: 'Compatibility mode (slowest)' }
        ],
        help: 'The Kea engine runs AI models natively, on your graphics card through DirectML where it can. If the graphics driver ever crashes, Kea switches to the processor automatically.'
      },
      { key: 'ai.segmentModel', label: 'Background-removal model', type: 'text', default: '', advanced: true, help: 'Which downloaded model to use (set from the list below).' }
    ]
  },
  {
    id: 'control',
    label: 'Connect an app',
    icon: 'Plug',
    blurb:
      'Let another app you trust drive Kea’s editors through MCP (the Model Context Protocol) — the same tools the Claude sidebar uses, but from outside Kea. Claude Code, Claude Desktop, an OpenAI agent, or your own app can read the file you have open and change it, each change one Ctrl+Z. It runs only on this computer, it’s off until you turn it on, and every app you connect gets its own key you can revoke.',
    fields: []
  },
  {
    id: 'updates',
    label: 'Updates',
    icon: 'RefreshCw',
    fields: [
      { key: 'updates.autoCheck', label: 'Check for updates when Kea starts', type: 'toggle', default: true },
      { key: 'updates.autoDownload', label: 'Download updates automatically', type: 'toggle', default: false, advanced: true, help: 'You still choose when to restart and install.' },
      { key: 'updates.prerelease', label: 'Get early test versions', type: 'toggle', default: false, advanced: true }
    ]
  },
  {
    id: 'privacy',
    label: 'Privacy & data',
    icon: 'Shield',
    blurb: 'Kea works offline. It only goes online to check GitHub for updates, to read Wikipedia and Wiktionary when you use the Encyclopedia, to download models you choose, and to set up cloud drives you sign in to.',
    fields: [
      { key: 'privacy.citeLookup', label: 'Allow citation look-ups', type: 'toggle', default: true, help: 'When you click "Look up" in Citations, Kea asks Crossref (DOIs), Open Library (ISBNs) or the web page itself for the details. Nothing is sent otherwise.' },
      { key: 'privacy.log', label: 'Keep a troubleshooting log', type: 'toggle', default: true, advanced: true, help: 'A small local file (kea.log) with errors and file names. Never sent anywhere.' }
    ]
  },
  { id: 'shortcuts', label: 'Keyboard shortcuts', icon: 'Keyboard', fields: [] },
  { id: 'feedback', label: 'Feedback', icon: 'MessageSquarePlus', fields: [] },
  { id: 'about', label: 'About & licenses', icon: 'Info', fields: [] }
];

export const DEFAULTS: Record<string, any> = Object.fromEntries(SECTIONS.flatMap((s) => s.fields.map((f) => [f.key, f.default])));

interface SettingsStore {
  values: Record<string, any>;
  loaded: boolean;
  open: boolean;
  section: string;
  set(patch: Record<string, any>): void;
  ui(patch: Partial<Pick<SettingsStore, 'open' | 'section'>>): void;
}

export const useSettings = create<SettingsStore>((set, get) => ({
  values: { ...DEFAULTS },
  loaded: false,
  open: false,
  section: 'general',
  set(patch) {
    set({ values: { ...get().values, ...patch } });
    // Store only differences from defaults, so changing a default later reaches everyone.
    const stored: Record<string, any> = {};
    for (const [k, v] of Object.entries(patch)) stored[k] = v === DEFAULTS[k] ? null : v;
    api.settings.set(stored);
  },
  ui(patch) {
    set(patch);
  }
}));

/** Read one setting outside React. */
/** Whether the theme is a dark one. */
export const themeDark = (v: Record<string, any> = useSettings.getState().values) => themeOf(v['appearance.theme']).dark;
/** Whether PDF and textbook pages show dark: as the theme, unless always white or always dark is picked. */
export function pagesDark(v: Record<string, any> = useSettings.getState().values) {
  const p = v['pdf.darkPages'];
  return p === 'dark' ? true : p === 'light' ? false : themeDark(v);
}
export const usePagesDark = () => useSettings((s) => pagesDark(s.values));
export const useThemeDark = () => useSettings((s) => themeDark(s.values));
/**
 * Pages turned light or dark from a reader (the textbook, a PDF): the whole app follows, so the book and the quiz
 * beside it always match. A light theme turned dark goes to Dark; a dark one turned light goes to Light (or Sepia
 * stays when it's already light).
 */
export function setPagesDark(dark: boolean) {
  const v = useSettings.getState().values;
  const t = v['appearance.theme'] || 'dark';
  const next = dark ? (themeOf(t).dark ? t : 'dark') : themeOf(t).dark ? 'light' : t;
  useSettings.getState().set({ 'appearance.theme': next, 'appearance.themeAt': new Date().toISOString(), 'pdf.darkPages': 'match' });
}

export function setting<T = any>(key: string): T {
  const v = useSettings.getState().values[key];
  return (v === undefined ? DEFAULTS[key] : v) as T;
}
/** Read one setting in a component (re-renders when it changes). */
export function useSetting<T = any>(key: string): T {
  return useSettings((s) => (s.values[key] === undefined ? DEFAULTS[key] : s.values[key])) as T;
}

export function openSettings(section = 'general') {
  useSettings.getState().ui({ open: true, section });
}

export async function loadSettings() {
  const stored = await api.settings.get();
  useSettings.setState({ values: { ...DEFAULTS, ...stored }, loaded: true });
  applyAppearance();
  api.settings.onChange((all) => {
    useSettings.setState({ values: { ...DEFAULTS, ...all } });
  });
  useSettings.subscribe((s, prev) => {
    if (s.values !== prev.values) applyAppearance();
  });
}

const ACCENTS: Record<string, [string, string, string]> = {
  // accent, stronger, text on accent
  blue: ['#a8c7fa', '#7cacf8', '#062e6f'],
  purple: ['#d0bcff', '#b69df8', '#381e72'],
  teal: ['#80d5cf', '#4fbdb6', '#003734'],
  green: ['#9fd8a8', '#7cc58a', '#0a3816'],
  orange: ['#ffb68a', '#fb9a63', '#4a1f00'],
  pink: ['#ffb0c8', '#f48fb1', '#5e1133']
};

function hexToRgb(h: string) {
  const m = /^#?([0-9a-f]{6})$/i.exec(h.trim());
  if (!m) return [168, 199, 250];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Apply look-and-feel settings to the whole window. */
function applyAppearance() {
  const v = useSettings.getState().values;
  const root = document.documentElement.style;
  const theme = themeOf(v['appearance.theme']);
  for (const [k, val] of Object.entries(theme.c)) root.setProperty(`--${k}`, val);
  root.setProperty('color-scheme', theme.dark ? 'dark' : 'light');
  document.documentElement.dataset.theme = theme.dark ? 'dark' : 'light';
  document.documentElement.dataset.palette = v['appearance.theme'] || 'dark';
  api.setTitleOverlay?.(theme.c.bg, theme.c['text-2']);
  let [accent, strong, on] = ACCENTS[v['appearance.accent']] || ACCENTS.blue;
  if (v['appearance.accent'] === 'custom') {
    accent = v['appearance.accentCustom'] || accent;
  } else if (!theme.dark) accent = LIGHT_ACCENTS[v['appearance.accent']] || LIGHT_ACCENTS.blue;
  if (v['appearance.accent'] === 'custom' || !theme.dark) {
    const [r, g, b] = hexToRgb(accent);
    const k = theme.dark ? 0.85 : 0.82;
    strong = `rgb(${Math.round(r * k)}, ${Math.round(g * k)}, ${Math.round(b * k)})`;
    on = 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#111' : '#fff';
  }
  const [r, g, b] = hexToRgb(accent.startsWith('#') ? accent : '#a8c7fa');
  root.setProperty('--accent', accent);
  root.setProperty('--accent-strong', strong);
  root.setProperty('--on-accent', on);
  root.setProperty('--accent-soft', `rgba(${r}, ${g}, ${b}, 0.14)`);

  // Panel contrast: the theme's own panels, moved away from the background (lighter on dark themes, darker on light).
  const c = Number(v['appearance.surfaceContrast']) || 0;
  if (c) {
    ['surface', 'surface-2', 'surface-3', 'surface-4'].forEach((name, i) => {
      const [r, g, b] = hexToRgb(theme.c[name]);
      const d = c * (3 + i) * (theme.dark ? 1 : -1);
      const ch = (x: number) => Math.max(0, Math.min(255, x + d)).toString(16).padStart(2, '0');
      root.setProperty(`--${name}`, `#${ch(r)}${ch(g)}${ch(b)}`);
    });
  }

  const rad = Number(v['appearance.radius'] ?? 1);
  root.setProperty('--radius-sm', `${6 * rad}px`);
  root.setProperty('--radius', `${10 * rad}px`);
  root.setProperty('--radius-lg', `${16 * rad}px`);
  root.setProperty('--r-scale', String(rad));

  const fonts: Record<string, string> = {
    inter: "'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif",
    segoe: "'Segoe UI', system-ui, -apple-system, sans-serif",
    system: 'system-ui, -apple-system, sans-serif'
  };
  root.setProperty('--font', fonts[v['appearance.uiFont']] || fonts.inter);
  document.documentElement.classList.toggle('reduce-motion', !!v['appearance.reduceMotion']);
  // Sizes of individual parts (Appearance → advanced).
  const num = (k: string, d: number) => (Number.isFinite(Number(v[k])) && v[k] !== '' && v[k] != null ? Number(v[k]) : d);
  root.setProperty('--tb-zoom', String(num('appearance.toolbarSize', 1)));
  root.setProperty('--tab-zoom', String(num('appearance.tabSize', 1)));
  root.setProperty('--menu-font', `${num('appearance.menuFont', 13.5)}px`);
  root.setProperty('--ai-w', `${Math.min(640, Math.max(300, num('ai.sidebarWidth', 380)))}px`);
  root.setProperty('--ai-font', `${num('appearance.aiFont', 13)}px`);
  api.setZoom(Number(v['appearance.scale']) || 1);
}
