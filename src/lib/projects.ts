// Projects: a named folder of files (documents, sheets, PDFs, images, notes) that Claude uses together, like a Claude
// Project. A class's papers, syllabus and rubrics; a work team's contact sheet, availability sheet and schedule template.
// A project is an ordinary folder (on this PC, in Kea cloud or a synced drive) with a small `.kea-project.json` in it:
//   { "name": "ENG 102", "kind": "class" | "work" | "personal", "course"?: "ENG 102", "exclude": ["old draft.docx"] }
// Any file opened from inside the folder (or a subfolder) is "in the project": the Claude sidebar shows it, and Claude
// gets two tools, list_project_files and read_project_file, which always read the file as it is now on disk, so a
// changed availability sheet is picked up at once. The chat shows which files Claude read, and the project's panel
// has a switch per file to leave it out.
import { create } from 'zustand';
import { api } from './api';
import { useTabs, type AssistantTool } from '../store';
import { useSettings } from './settings';

export interface Project {
  dir: string;
  name: string;
  kind: 'class' | 'work' | 'personal';
  course?: string;
  exclude: string[];
  /** Google Docs, Sheets and Slides that are part of the project (read live through the Drive connection). */
  links?: { kind: 'doc' | 'sheet' | 'slides'; id: string; name: string }[];
  /** Files kept where they are (on this PC, a drive or Kea cloud) and read live from there (Kea 0.101.2). */
  refs?: { path: string; name: string }[];
  /** Claude may look people up in Google Contacts (work projects). */
  contacts?: boolean;
  /**
   * An organization's shared folder kept on this PC (electron/teamFoldersCore.cjs writes this; Kea 0.99). `off`: the
   * files the folder or file setting keeps from Claude, decided by whoever manages it; they're never used, whatever
   * this PC's own `exclude` says.
   */
  shared?: { src: string; orgId: string; orgName: string; folderId: string; folderName: string; access: 'view' | 'edit' | 'manage'; claude: boolean; off: string[] };
}

export const PROJECT_FILE = '.kea-project.json';
const sepOf = (p: string) => (p.includes('\\') ? '\\' : '/');
const parentOf = (p: string) => p.replace(/[\\/][^\\/]*$/, '');
const join = (dir: string, name: string) => `${dir.replace(/[\\/]+$/, '')}${sepOf(dir)}${name}`;
export const relPath = (p: Project, full: string) => full.slice(p.dir.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');

/** Projects found for the folders of open files (null: looked, none). */
export const useProjects = create<{ byDir: Record<string, Project | null>; version: number }>(() => ({ byDir: {}, version: 0 }));

function parse(dir: string, text: string): Project | null {
  try {
    const j = JSON.parse(text);
    const kind = ['class', 'work', 'personal'].includes(j?.kind) ? j.kind : 'personal';
    return { dir, name: String(j?.name || dir.split(/[\\/]/).pop() || 'Project').slice(0, 80), kind, ...(j?.course ? { course: String(j.course) } : {}), exclude: Array.isArray(j?.exclude) ? j.exclude.map(String) : [], links: Array.isArray(j?.links) ? j.links.filter((l: any) => l && /^[\w-]{20,}$/.test(String(l.id))).map((l: any) => ({ kind: ['doc', 'sheet', 'slides'].includes(l.kind) ? l.kind : 'doc', id: String(l.id), name: String(l.name || 'Google file').slice(0, 120) })) : [], ...(Array.isArray(j?.refs) ? { refs: j.refs.filter((r: any) => r && typeof r.path === 'string' && r.path).map((r: any) => ({ path: String(r.path), name: String(r.name || String(r.path).split(/[\\/]/).pop()).slice(0, 160) })) } : {}), ...(j?.contacts ? { contacts: true } : {}), ...(j?.shared && typeof j.shared === 'object' && j.shared.orgId ? { shared: { src: String(j.shared.src || ''), orgId: String(j.shared.orgId), orgName: String(j.shared.orgName || 'Organization'), folderId: String(j.shared.folderId || ''), folderName: String(j.shared.folderName || ''), access: ['view', 'edit', 'manage'].includes(j.shared.access) ? j.shared.access : 'view', claude: j.shared.claude !== false, off: Array.isArray(j.shared.off) ? j.shared.off.map(String) : [] } } : {}) };
  } catch {
    return null;
  }
}
const decode = (b: Uint8Array) => new TextDecoder().decode(b);

/** The project a folder is in: that folder or up to four folders above it. */
export async function findProject(dir: string): Promise<Project | null> {
  let d = dir;
  for (let i = 0; i < 5 && d && /[\\/]/.test(d); i++) {
    const f = join(d, PROJECT_FILE);
    if (await api.fileExists(f).catch(() => false)) {
      const e = await api.readFile(f).catch(() => null);
      const p = e ? parse(d, decode(e.data)) : null;
      if (p) return p;
    }
    const up = parentOf(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

/** The project of an open tab's file (from what's been looked up; null when it isn't in one or isn't known yet). */
export function projectOfTab(tabId: string): Project | null {
  const t = useTabs.getState().tabs.find((x) => x.id === tabId);
  const dir = t?.path ? parentOf(t.path) : t?.folder || null;
  return dir ? useProjects.getState().byDir[dir] ?? null : null;
}

async function look(dir: string) {
  const p = await findProject(dir);
  useProjects.setState((s) => ({ byDir: { ...s.byDir, [dir]: p }, version: s.version + 1 }));
  if (p) rememberProject(p);
}

/** A context folder Kea knows, for Home's Ask Claude bar (setting `projects.known`, newest first). */
export interface KnownProject {
  dir: string;
  name: string;
  kind: Project['kind'];
  at: number;
}
export const knownProjects = (): KnownProject[] => (Array.isArray(useSettings.getState().values['projects.known']) ? useSettings.getState().values['projects.known'] : []);

/** Remember a project (made, opened or found) so Home's bar lists it. At most 40, the most recently used first. */
export function rememberProject(p: Pick<Project, 'dir' | 'name' | 'kind'>, used = false) {
  const list = knownProjects();
  const old = list.find((k) => k.dir.toLowerCase() === p.dir.toLowerCase());
  if (old && !used && old.name === p.name && old.kind === p.kind) return;
  const next = [{ dir: p.dir, name: p.name, kind: p.kind, at: used || !old ? Date.now() : old.at }, ...list.filter((k) => k !== old)].sort((a, b) => b.at - a.at).slice(0, 40);
  useSettings.getState().set({ 'projects.known': next });
}

/** Forget a context folder (Home's bar; the folder and its files stay as they are). */
export function forgetProject(dir: string) {
  useSettings.getState().set({ 'projects.known': knownProjects().filter((k) => k.dir !== dir) });
}

/** Look a folder up now (the Ask Claude bar, before a chat about it opens). */
export async function loadProject(dir: string) {
  const p = await findProject(dir);
  useProjects.setState((s) => ({ byDir: { ...s.byDir, [dir]: p }, version: s.version + 1 }));
  return p;
}
// Every open file's folder is looked up once (and again after its project file changes through Kea).
useTabs.subscribe((s, prev) => {
  if (s.tabs === prev.tabs) return;
  const known = useProjects.getState().byDir;
  for (const t of s.tabs) {
    const dir = t.path ? parentOf(t.path) : t.folder;
    if (dir && !(dir in known)) look(dir).catch(() => {});
  }
});

/** Make a folder a project (or rename it): writes its `.kea-project.json`. */
export async function saveProject(p: Project): Promise<Project> {
  const body = { name: p.name, kind: p.kind, ...(p.course ? { course: p.course } : {}), exclude: p.exclude, ...(p.links?.length ? { links: p.links } : {}), ...(p.refs?.length ? { refs: p.refs } : {}), ...(p.contacts ? { contacts: true } : {}), ...(p.shared ? { shared: p.shared } : {}) };
  await api.writeFile(join(p.dir, PROJECT_FILE), new TextEncoder().encode(JSON.stringify(body, null, 2)));
  useProjects.setState((s) => ({ byDir: Object.fromEntries(Object.entries({ ...s.byDir, [p.dir]: p }).map(([d, v]) => [d, v && v.dir === p.dir ? p : v])), version: s.version + 1 }));
  rememberProject(p, true);
  return p;
}

const READABLE = /\.(docx|doc|md|txt|csv|tsv|xlsx|xls|pdf|pptx|json|html?)$/i;
const IMAGES = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
const MEDIA = /\.(mp4|mov|m4v|webm|mkv|avi|mp3|wav|m4a|aac|flac|ogg)$/i;
const AUDIO = /\.(mp3|wav|m4a|aac|flac|ogg)$/i;
/** What a file is, in a word, when Claude can't read it as text: "video", "audio", "image" or "file" ('' if it can). */
export const kindWord = (name: string) => (IMAGES.test(name) ? 'image' : AUDIO.test(name) ? 'audio' : MEDIA.test(name) ? 'video' : READABLE.test(name) ? '' : 'file');

/** The project's files, in it and its subfolders (two levels), with whether Claude may use each. */
/** A shared folder's own setting keeps this file from Claude (whoever manages the folder decides). */
export const sharedOff = (p: Project, rel: string) => !!p.shared && p.shared.off.includes(rel);
export async function projectFiles(p: Project): Promise<{ path: string; rel: string; size: number; mtime: number; used: boolean; image: boolean; locked?: boolean }[]> {
  const out: { path: string; rel: string; size: number; mtime: number; used: boolean; image: boolean; locked?: boolean }[] = [];
  const walk = async (dir: string, depth: number) => {
    const list = await api.listDir(dir, { allTypes: true }).catch(() => []);
    for (const e of list) {
      if (e.name.startsWith('.') || e.name.startsWith('~$')) continue;
      if (e.dir) {
        if (depth < 2) await walk(e.path, depth + 1);
        continue;
      }
      const rel = relPath(p, e.path);
      out.push({ path: e.path, rel, size: e.size, mtime: e.mtime, used: !p.exclude.includes(rel) && !sharedOff(p, rel), image: IMAGES.test(e.name), ...(sharedOff(p, rel) ? { locked: true } : {}) });
      if (out.length >= 300) return;
    }
  };
  await walk(p.dir, 0);
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  // Files linked where they are, named "Linked: <name>".
  for (const r of p.refs || []) {
    const rel = `Linked: ${r.name}`;
    out.push({ path: r.path, rel, size: 0, mtime: Date.now(), used: !p.exclude.includes(rel), image: IMAGES.test(r.name) });
  }
  // Linked Google files come last, named "Google: <name>".
  for (const l of p.links || []) {
    const rel = `Google: ${l.name}`;
    out.push({ path: `google:${l.id}`, rel, size: 0, mtime: Date.now(), used: !p.exclude.includes(rel), image: false });
  }
  return out;
}

const LIMIT = 60_000;
const stripHtml = (h: string) =>
  h
    .replace(/<(br|\/p|\/h\d|\/li|\/tr)[^>]*>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** A project file's text, read from disk now (documents, sheets as tab-separated rows, PDFs, slides, notes). */
export async function readProjectText(full: string): Promise<string> {
  const e = await api.readFile(full);
  const bytes = e.data;
  const ext = (full.match(/\.([^.\\/]+)$/)?.[1] || '').toLowerCase();
  let text = '';
  if (['md', 'txt', 'csv', 'tsv', 'json'].includes(ext)) text = decode(bytes);
  else if (ext === 'html' || ext === 'htm') text = stripHtml(decode(bytes));
  else if (ext === 'docx' || ext === 'doc') text = stripHtml(await (await import('../editors/doc/docxImport')).docxToHtml(bytes));
  else if (ext === 'xlsx' || ext === 'xls') {
    const wb: any = await (await import('../editors/sheet/io')).readWorkbook(full.split(/[\\/]/).pop()!, bytes);
    text = (wb.sheets || [])
      .map((sh: any) => {
        const cells = sh.cells || {};
        const keys = Object.keys(cells);
        let rows = 0;
        let cols = 0;
        const at = (k: string) => k.split(',').map(Number);
        for (const k of keys) {
          const [r, c] = at(k);
          rows = Math.max(rows, r + 1);
          cols = Math.max(cols, c + 1);
        }
        const lines: string[] = [];
        for (let r = 0; r < Math.min(rows, 2000); r++) {
          const row: string[] = [];
          for (let c = 0; c < Math.min(cols, 60); c++) row.push(String(cells[`${r},${c}`]?.v ?? (cells[`${r},${c}`]?.f ? `=${cells[`${r},${c}`].f}` : '')).replace(/\s+/g, ' '));
          lines.push(row.join('\t').replace(/\t+$/, ''));
        }
        return `## Sheet: ${sh.name || ''}\n${lines.join('\n').trim()}`;
      })
      .join('\n\n');
  } else if (ext === 'pptx') {
    const deck: any = await (await import('../editors/slides/pptxImport')).readPptx(bytes);
    text = (deck.slides || [])
      .map((s: any, i: number) => `## Slide ${i + 1}\n${[...(s.els || []).map((el: any) => stripHtml(String(el.text || el.html || ''))), s.notes ? `Speaker notes: ${s.notes}` : ''].filter(Boolean).join('\n')}`)
      .join('\n\n');
  } else if (ext === 'pdf') {
    const doc = await (await import('../editors/pdf/pdfjs')).loadPdf(bytes);
    const parts: string[] = [];
    for (let i = 1; i <= Math.min(doc.numPages, 80); i++) {
      const page = await doc.getPage(i);
      const c = await page.getTextContent();
      parts.push(`## Page ${i}\n${c.items.map((x: any) => x.str).join(' ')}`);
    }
    text = parts.join('\n\n');
  } else return '(Kea can’t read this kind of file as text.)';
  return text.length > LIMIT ? `${text.slice(0, LIMIT)}\n\n[The rest (${text.length - LIMIT} more characters) was cut off.]` : text || '(The file is empty.)';
}

/** Claude's tools for the project a tab's file is in (none when it isn't in one). */
export function projectTools(tabId: string): AssistantTool[] {
  const p = projectOfTab(tabId);
  if (!p) return [];
  const contacts: AssistantTool[] = p.contacts
    ? [
        {
          name: 'search_contacts',
          description: 'Look people up in the student’s Google Contacts (name, emails, phones, organization), for this work project: e.g. to find how to reach the people on a sheet. Every word of `query` must match; leave it empty to list everyone (up to 50).',
          input_schema: { type: 'object', properties: { query: { type: 'string' } } },
          async run({ query }) {
            const list = await api.contacts.search(String(query || ''));
            if (!list.length) return 'No one in Google Contacts matches that.';
            return list.map((c) => `- ${c.name || '(no name)'}${c.org ? ` · ${c.org}` : ''}${c.emails.length ? ` · ${c.emails.join(', ')}` : ''}${c.phones.length ? ` · ${c.phones.join(', ')}` : ''}`).join('\n');
          }
        }
      ]
    : [];
  return [
    ...contacts,
    {
      name: 'list_project_files',
      description: `List the files in the project "${p.name}" that this file belongs to (a ${p.kind === 'class' ? 'class: its syllabus, rubrics, instructions, earlier papers and feedback' : p.kind === 'work' ? 'work project: its sheets, contacts, schedules and templates' : 'folder of related files'}). Use it when the student refers to other files ("using the contact sheet", "build on my Essay 1", "the images in this folder") instead of asking them to attach anything.`,
      input_schema: { type: 'object', properties: {} },
      async run() {
        const files = (await projectFiles(p)).filter((f) => f.used);
        if (!files.length) return `The project "${p.name}" has no other files Kea can read.`;
        return `Project "${p.name}" (${files.length} files; read one with read_project_file):\n${files
          .map((f) => {
            const k = kindWord(f.rel);
            const what = k ? ` (${k}${k === 'video' || k === 'audio' ? ': open it in the video editor with open_file' : ''})` : '';
            return `- ${f.rel}${what}${/^(Google|Linked): /.test(f.rel) ? '' : ` · changed ${new Date(f.mtime).toLocaleDateString()}`}`;
          })
          .join('\n')}`;
      }
    },
    {
      name: 'read_project_file',
      description: `Read one file of the project "${p.name}" as it is right now (documents, sheets as tab-separated rows, PDFs, slides, notes). \`file\` is its name as list_project_files gives it.`,
      input_schema: { type: 'object', properties: { file: { type: 'string', description: 'The file, as list_project_files lists it (e.g. "Contacts.xlsx" or "Week 3/notes.md")' } }, required: ['file'] },
      async run({ file }) {
        const rel = String(file || '').replace(/\\/g, '/').replace(/^\/+/, '');
        if (!rel || rel.split('/').includes('..')) throw new Error('Name a file from list_project_files.');
        if (p.exclude.includes(rel)) throw new Error(`The student left "${rel}" out of what Claude may use.`);
        if (sharedOff(p, rel)) throw new Error(`${p.shared!.orgName} doesn’t let Claude use "${rel}".`);
        const ref = (p.refs || []).find((r) => `Linked: ${r.name}` === rel);
        if (ref) {
          if (kindWord(ref.name) && kindWord(ref.name) !== 'file') return `"${rel}" is ${kindWord(ref.name) === 'image' ? 'an image' : kindWord(ref.name) === 'audio' ? 'an audio file' : 'a video'} at ${ref.path}.`;
          return `# ${rel} (read where it is: ${ref.path})\n${await readProjectText(ref.path).catch(() => '(It isn’t there any more.)')}`;
        }
        const link = (p.links || []).find((l) => `Google: ${l.name}` === rel);
        if (link) {
          const g = await api.google.exportText(link.id);
          const text = g.text.length > LIMIT ? `${g.text.slice(0, LIMIT)}\n\n[The rest was cut off.]` : g.text;
          return `# ${rel} (Google ${link.kind === 'sheet' ? 'Sheet, first tab as CSV' : link.kind === 'slides' ? 'Slides' : 'Doc'}, read now)\n${text}`;
        }
        const full = join(p.dir, rel.split('/').join(sepOf(p.dir)));
        if (IMAGES.test(rel)) return `"${rel}" is an image. To use it in the file, place it with an image tool's path input: ${full}`;
        if (MEDIA.test(rel)) return `"${rel}" is ${AUDIO.test(rel) ? 'an audio file' : 'a video'} at ${full}. Open it in the video editor with open_file (Kea transcribes it there, with word timings).`;
        return `# ${rel}\n${await readProjectText(full)}`;
      }
    }
  ];
}
