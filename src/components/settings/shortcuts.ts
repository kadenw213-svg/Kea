/** Keyboard shortcuts shown in Settings. Keep in sync with the handlers in App.tsx and each editor. */
export const SHORTCUTS: { group: string; items: [string, string][] }[] = [
  {
    group: 'Everywhere',
    items: [
      ['Ctrl+S', 'Save'],
      ['Ctrl+Shift+S', 'Save as'],
      ['Ctrl+O', 'Open a file'],
      ['Ctrl+N', 'New file (type set in Settings → General)'],
      ['Ctrl+W', 'Close tab'],
      ['Ctrl+P', 'Print'],
      ['Ctrl+Tab / Ctrl+Shift+Tab', 'Next / previous tab'],
      ['Ctrl+,', 'Settings'],
      ['Ctrl+Shift+P / Alt+/', 'Command palette: run anything, find files, search inside files'],
      ['Ctrl+Shift+H', 'Version history'],
      ['Ctrl+J', 'Show or hide Look up'],
      ['Ctrl+Alt+V', 'Voice typing: talk and Slate types (Esc stops)'],
      ['Ctrl+\\', 'Split view: two tabs side by side (again to close)']
    ]
  },
  {
    group: 'Look up',
    items: [
      ['Alt+1', 'Explain'],
      ['Alt+2', 'Dictionary']
    ]
  },
  {
    group: 'Documents',
    items: [
      ['Ctrl+B / Ctrl+I / Ctrl+U', 'Bold / italic / underline'],
      ['Ctrl+F', 'Find'],
      ['Ctrl+H', 'Find and replace'],
      ['Ctrl+K', 'Insert link'],
      ['Ctrl+Alt+C', 'Insert citation'],
      ['Ctrl+Alt+F', 'Insert footnote'],
      ['Ctrl+Alt+M', 'Comment on the selection'],
      ['Alt+=', 'Insert equation'],
      ['Ctrl+Alt+R', 'Read aloud (selection, or from the cursor)'],
      ['Ctrl+Enter', 'Page break'],
      ['Ctrl+= / Ctrl+-', 'Zoom in / out'],
      ['Ctrl+0', 'Reset zoom'],
      ['Ctrl+Z / Ctrl+Y', 'Undo / redo']
    ]
  },
  {
    group: 'Spreadsheets',
    items: [
      ['Enter / Tab', 'Move down / right'],
      ['F2', 'Edit cell'],
      ['Ctrl+D', 'Fill down'],
      ['Ctrl+;', "Insert today's date"],
      ['Ctrl+A', 'Select all'],
      ['Ctrl+End', 'Go to last used cell'],
      ['Ctrl+F', 'Find'],
      ['Delete', 'Clear cells']
    ]
  },
  {
    group: 'Presentations',
    items: [
      ['F5', 'Present'],
      ['Ctrl+M', 'New slide'],
      ['Ctrl+D', 'Duplicate selection'],
      ['Arrow keys', 'Nudge selection (Shift for bigger steps)'],
      ['Enter', 'Edit text in the selected box'],
      ['Esc', 'Stop editing / exit presentation'],
      ['S', 'While presenting: switch between slides and speaker view'],
      ['→ / ←', 'While presenting: next / previous slide']
    ]
  },
  {
    group: 'PDFs',
    items: [
      ['V', 'Select and move'],
      ['E', 'Edit existing text'],
      ['T', 'Add text'],
      ['H / U / K', 'Highlight / underline / strike out'],
      ['D', 'Draw'],
      ['R / O', 'Rectangle / ellipse'],
      ['L / A', 'Line / arrow'],
      ['W', 'Whiteout (covers only)'],
      ['X', 'Redact (permanently removes on save)'],
      ['N', 'Comment'],
      ['Ctrl+= / Ctrl+-', 'Zoom in / out']
    ]
  }
];
