import { create } from 'zustand';
import { api } from './api';

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
        label: 'When Slate starts',
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
      { key: 'appearance.radius', label: 'Corner roundness', type: 'range', default: 1, min: 0, max: 1.5, step: 0.25, advanced: true }
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
      { key: 'files.recovery', label: 'Crash recovery', type: 'toggle', default: true, help: 'Keeps a hidden copy of unsaved work (including new, never-saved files) so it can be restored if Slate or Windows crashes.' },
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
      { key: 'home.showAllTypes', label: 'Show every file type in folders', type: 'toggle', default: false, advanced: true, help: 'Normally Home only lists files Slate can open.' },
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
        default: 'dark',
        options: [
          { value: 'dark', label: 'Dark grey (easy on the eyes)' },
          { value: 'light', label: 'White (like paper)' }
        ],
        help: 'Printing and PDFs are always on white.'
      },
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
    id: 'pdf',
    label: 'PDFs',
    icon: 'FileType2',
    fields: [
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
        default: 'slate',
        options: [
          { value: 'slate', label: 'In Slate' },
          { value: 'browser', label: 'In the web browser' }
        ]
      },
      { key: 'google.autosave', label: 'Save changes back to Google Drive automatically', type: 'toggle', default: true },
      { key: 'google.clientId', label: 'OAuth client ID', type: 'text', default: '', advanced: true, help: 'From your own Google Cloud project (see the setup steps above).' },
      { key: 'google.clientSecret', label: 'OAuth client secret', type: 'text', default: '', advanced: true }
    ]
  },
  { id: 'ai', label: 'AI', icon: 'Sparkles', fields: [] },
  {
    id: 'updates',
    label: 'Updates',
    icon: 'RefreshCw',
    fields: [
      { key: 'updates.autoCheck', label: 'Check for updates when Slate starts', type: 'toggle', default: true },
      { key: 'updates.autoDownload', label: 'Download updates automatically', type: 'toggle', default: false, advanced: true, help: 'You still choose when to restart and install.' },
      { key: 'updates.prerelease', label: 'Get early test versions', type: 'toggle', default: false, advanced: true }
    ]
  },
  {
    id: 'privacy',
    label: 'Privacy & data',
    icon: 'Shield',
    blurb: 'Slate works offline. It only goes online to check GitHub for updates, to download AI models you choose, and to set up cloud drives you sign in to.',
    fields: [
      { key: 'privacy.citeLookup', label: 'Allow citation look-ups', type: 'toggle', default: true, help: 'When you click "Look up" in Citations, Slate asks Crossref (DOIs), Open Library (ISBNs) or the web page itself for the details. Nothing is sent otherwise.' },
      { key: 'privacy.log', label: 'Keep a troubleshooting log', type: 'toggle', default: true, advanced: true, help: 'A small local file (slate.log) with errors and file names. Never sent anywhere.' }
    ]
  },
  { id: 'shortcuts', label: 'Keyboard shortcuts', icon: 'Keyboard', fields: [] },
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
  let [accent, strong, on] = ACCENTS[v['appearance.accent']] || ACCENTS.blue;
  if (v['appearance.accent'] === 'custom') {
    accent = v['appearance.accentCustom'] || accent;
    const [r, g, b] = hexToRgb(accent);
    strong = `rgb(${Math.round(r * 0.85)}, ${Math.round(g * 0.85)}, ${Math.round(b * 0.85)})`;
    on = 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#111' : '#fff';
  }
  const [r, g, b] = hexToRgb(accent.startsWith('#') ? accent : '#a8c7fa');
  root.setProperty('--accent', accent);
  root.setProperty('--accent-strong', strong);
  root.setProperty('--on-accent', on);
  root.setProperty('--accent-soft', `rgba(${r}, ${g}, ${b}, 0.14)`);

  const c = Number(v['appearance.surfaceContrast']) || 0;
  if (c) {
    const base = [0x1b, 0x23, 0x2c, 0x36];
    base.forEach((n, i) => {
      const x = Math.max(0, Math.min(255, n + c * (3 + i))).toString(16).padStart(2, '0');
      root.setProperty(i === 0 ? '--surface' : `--surface-${i + 1}`, `#${x}${x}${Math.min(255, parseInt(x, 16) + 2).toString(16).padStart(2, '0')}`);
    });
  } else ['--surface', '--surface-2', '--surface-3', '--surface-4'].forEach((p) => root.removeProperty(p));

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
  api.setZoom(Number(v['appearance.scale']) || 1);
}
