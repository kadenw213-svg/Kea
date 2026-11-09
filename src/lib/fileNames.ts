// File-name helpers shared by saving, new files and naming a document after its assignment. Pure (no imports), so
// tests run them directly. save.ts and open.ts re-export the ones they've always offered.

/** Turn a title (a document's first line, a slide's title) into a file name: no characters Windows refuses, at most ~60 long. */
export function safeFileName(title: string) {
  const clean = title.replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  if (clean.length <= 60) return clean;
  const cut = clean.slice(0, 60);
  const sp = cut.lastIndexOf(' ');
  return (sp > 30 ? cut.slice(0, sp) : cut).trim();
}

const UNTITLED: Record<string, [base: string, ext: string]> = {
  doc: ['Untitled document', ''],
  sheet: ['Untitled spreadsheet', ''],
  slides: ['Untitled presentation', ''],
  code: ['Untitled', '.txt'],
  pdf: ['Untitled PDF', ''],
  image: ['Untitled image', '.png'],
  video: ['Untitled video', '.keavideo']
};

/**
 * The name for a new file: numbered per kind, with the number before the extension ("Untitled image 2.png"), using
 * the lowest number no open tab has, so the first spreadsheet is never "Untitled spreadsheet 2".
 */
export function untitledName(kind: string, openNames: string[]) {
  const [base, ext] = UNTITLED[kind] || ['Untitled', ''];
  const nameFor = (n: number) => `${base}${n === 1 ? '' : ` ${n}`}${ext}`;
  const taken = new Set(openNames.map((x) => x.toLowerCase()));
  let n = 1;
  while (taken.has(nameFor(n).toLowerCase())) n++;
  return nameFor(n);
}

/** True for the name a new file of this kind starts with ("Untitled document", "Untitled presentation 3"). */
export function isUntitledName(kind: string, name: string) {
  const [base, ext] = UNTITLED[kind] || ['Untitled', ''];
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${esc(base)}(?: \\d+)?${esc(ext)}$`, 'i').test(name.trim());
}

/** `base`, or "base 2", "base 3"… whichever no name in `taken` already has (compared without case or extension). */
export function uniqueName(base: string, taken: string[]) {
  const stem = (n: string) => n.replace(/\.(docx?|docm|dotx|odt|rtf|html?|md|markdown|txt|pdf|pptx|pptm|potx|ppsx|ppt|odp)$/i, '').trim().toLowerCase();
  const have = new Set(taken.map(stem));
  let n = 1;
  const nameFor = (k: number) => (k === 1 ? base : `${base} ${k}`);
  while (have.has(nameFor(n).toLowerCase())) n++;
  return nameFor(n);
}

/** Slides' layout prompts ("Click to add title") aren't content. */
const PROMPT = /^(click to add (title|subtitle|text)|section title|left column|right column)$/i;

/**
 * True when a file holds nothing the person wrote: no text (a document), or only the starting slide with its
 * "Click to add…" prompts (a presentation). `sections` are the editor's parts (paragraphs, slides).
 */
export function isEmptyContent(kind: string, sections: { text: string }[]) {
  if (kind === 'slides') {
    if (sections.length > 1) return false;
    const lines = (sections[0]?.text || '').split('\n').map((l) => l.trim()).filter((l) => l && !/^slide \d+:$/i.test(l));
    return lines.every((l) => PROMPT.test(l));
  }
  return sections.every((s) => !s.text.trim());
}

/**
 * The name a new, empty, untitled file gets when it's linked to an assignment, or null to leave its name alone (it
 * already has a name, a place on disk, or content). The name is cleaned for file names and never one already taken.
 */
export function nameForAssignment(p: { kind: string; name: string; hasPath: boolean; empty: boolean; title: string; taken: string[] }): string | null {
  if (p.kind !== 'doc' && p.kind !== 'slides') return null;
  if (p.hasPath || !p.empty || !isUntitledName(p.kind, p.name)) return null;
  const clean = safeFileName(p.title || '');
  if (!clean) return null;
  return uniqueName(clean, p.taken);
}
