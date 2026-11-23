// Kea's modules for Claude (Kea 0.101). A Claude page (Home's "Ask Claude" bar, src/components/ClaudePage.tsx) has no
// file of its own: it works the way the person does, by making and opening files and using each editor's own tools.
// Every editor is a module: a document, a spreadsheet, slides, a PDF, a photo, a video project, code. Claude makes or
// opens one beside the chat (the window splits: the chat on the left, the file on the right), lists that editor's
// tools, runs them, and saves into the context folder. The files are ordinary Kea files the person can take over at any
// moment, with the editor's own undo. Pipelines (plans/kea/studio-and-modules.md) will run their steps through these
// same tools.
import { api } from './api';
import { editorRegistry, useTabs, type AssistantTool, type Tab } from '../store';
import { toolsFor, runToolHeadless, summary } from './editorTools';
import { safeFileName } from './fileNames';
import { projectOfTab } from './projects';
import { uid } from './util';
import { patchChat } from '../components/assistant/assistantStore';

type Made = 'doc' | 'sheet' | 'slides' | 'video' | 'code';
const KIND_NAME: Record<Made, string> = { doc: 'document', sheet: 'spreadsheet', slides: 'presentation', video: 'video project', code: 'text or code file' };
const PLACES = new Set(['home', 'scholar', 'work', 'audit', 'claude']);

// The file each Claude page last made or opened: when Claude finishes, the chat hands off to it (ClaudePage.tsx).
const lastFile = new Map<string, string>();
/** The file a chat should continue in, if Claude made or opened one (taken once). */
export function takeHandoff(chatId: string): string | null {
  const id = lastFile.get(chatId) || null;
  lastFile.delete(chatId);
  return id && useTabs.getState().tabs.some((t) => t.id === id) ? id : null;
}

/** Kea's modules, as Claude is told about them. */
export const MODULES: { id: string; name: string; what: string }[] = [
  { id: 'doc', name: 'Documents', what: 'Word-style documents: write, format, headings, tables, images, comments, citations and a bibliography. Opens .docx, .odt, .md, .txt.' },
  { id: 'sheet', name: 'Spreadsheets', what: 'Excel-style sheets: cells, formulas, formatting, charts, conditional formats. Opens .xlsx, .csv.' },
  { id: 'slides', name: 'Presentations', what: 'PowerPoint-style slides: text boxes, shapes, images, backgrounds, layout checks. Opens .pptx.' },
  { id: 'pdf', name: 'PDFs', what: 'Mark up, comment, redact, fill forms, add text and images, rotate, move, insert and delete pages.' },
  { id: 'image', name: 'Photo editor', what: 'Layers, selections, remove a background, adjustments, filters, text, shapes, crop and resize.' },
  {
    id: 'video',
    name: 'Video editor',
    what: 'A full timeline editor. Import clips (index_media transcribes speech with word timings, finds silences and scene cuts), cut and trim, edit_plan for a whole edit at once (B-roll, titles, captions, music, sound effects, transitions, J/L cuts), cut_to_script, captions (karaoke style), reframe to 9:16, speed ramps, punch-ins, LUTs, loudness, ducking music under speech, noise reduction, and export. Cut on pauses between words, never through one.'
  },
  { id: 'code', name: 'Code and text', what: 'Plain text, Markdown, code, JSON, CSV as text.' }
];

/** Wait until a tab's editor has loaded and offers its tools. */
async function hooksOf(id: string, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const h = editorRegistry.get(id)?.ai;
    if (h) return h;
    if (!useTabs.getState().tabs.some((t) => t.id === id)) break;
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error('That file didn’t finish opening. Try open_file again.');
}

/** Show a file beside the chat (chat on the left), if the person is looking at the chat; otherwise leave them be. */
function showBeside(chatId: string, fileId: string, wasActive: string) {
  const s = useTabs.getState();
  const chatVisible = wasActive === chatId || (!!s.split && (s.split.left === chatId || s.split.right === chatId));
  if (!chatVisible) return useTabs.setState({ activeId: wasActive });
  useTabs.setState({ activeId: chatId });
  useTabs.getState().openSplit(fileId);
}

/** A file Claude refers to: a tab id, or the name of an open file. */
function tabOf(ref: string): Tab {
  const tabs = useTabs.getState().tabs.filter((t) => !PLACES.has(t.kind));
  const r = String(ref || '').trim();
  const t = tabs.find((x) => x.id === r) || tabs.find((x) => x.name.toLowerCase() === r.toLowerCase()) || tabs.find((x) => x.name.toLowerCase().startsWith(r.toLowerCase()) && r.length > 2);
  if (!t) throw new Error(`No open file matches “${r}”. Use list_open_files.`);
  return t;
}

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Where files Claude makes go when the chat has no context folder: the person's Documents folder. */
async function defaultFolder() {
  const known = await api.knownFolders().catch(() => []);
  return known.find((k) => k.id === 'documents')?.path || known[0]?.path || '';
}

export function workspaceTools(chatId: string): AssistantTool[] {
  const folderOf = () => useTabs.getState().tabs.find((t) => t.id === chatId)?.folder || projectOfTab(chatId)?.dir || '';
  return [
    {
      name: 'kea_modules',
      description: 'What Kea can do: its modules (documents, spreadsheets, presentations, PDFs, photos, video, code), each driven through its editor. Read this before planning work that makes or changes files.',
      input_schema: { type: 'object', properties: {} },
      run: () =>
        `Kea's modules (each is an editor; make or open a file, then editor_tools and use_editor):\n${MODULES.map((m) => `- ${m.name} (${m.id}): ${m.what}`).join('\n')}\n\nWork the way the person would: create_file or open_file (it opens beside this chat so they can watch), editor_tools to see that editor's tools, use_editor to run them (several at once with its apply_edits tool), then save_file. Files you make go into ${folderOf() ? 'the context folder' : 'their Documents folder'}.`
    },
    {
      name: 'list_open_files',
      description: 'The files open in Kea right now (id, name, kind, and whether its editor is ready).',
      input_schema: { type: 'object', properties: {} },
      run() {
        const tabs = useTabs.getState().tabs.filter((t) => !PLACES.has(t.kind));
        if (!tabs.length) return 'No files are open.';
        return tabs.map((t) => `- ${t.id}: ${t.name} (${t.kind}${t.path ? `, ${t.path}` : ', not saved yet'}${t.dirty ? ', unsaved changes' : ''})${editorRegistry.get(t.id)?.ai ? '' : ' [still opening]'}`).join('\n');
      }
    },
    {
      name: 'create_file',
      description: 'Make a new file in Kea and open it beside the chat: a document, spreadsheet, presentation, video project or text file. Returns its file id for editor_tools and use_editor. It is saved into the context folder with save_file.',
      input_schema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['doc', 'sheet', 'slides', 'video', 'code'] },
          name: { type: 'string', description: 'The file name without extension, e.g. "Missing availability"' }
        },
        required: ['kind', 'name']
      },
      async run({ kind, name }) {
        const k = (Object.keys(KIND_NAME) as Made[]).includes(kind) ? (kind as Made) : 'doc';
        const was = useTabs.getState().activeId;
        const folder = folderOf() || (await defaultFolder());
        const title = safeFileName(String(name || '')) || `New ${KIND_NAME[k]}`;
        const id = useTabs.getState().addTab({ kind: k, name: k === 'code' && !/\.\w+$/.test(title) ? `${title}.txt` : title, path: null, data: null, ...(folder ? { folder } : {}) });
        showBeside(chatId, id, was);
        lastFile.set(chatId, id);
        await hooksOf(id);
        return `Made a new ${KIND_NAME[k]} “${title}” (file id ${id}), open beside the chat. Next: editor_tools with file "${id}".`;
      }
    },
    {
      name: 'open_file',
      description: 'Open a file in Kea beside the chat so you can work on it: a file of the context folder (its name as list_project_files gives it) or a full path. Returns its file id.',
      input_schema: { type: 'object', properties: { file: { type: 'string', description: 'e.g. "Availability.xlsx", "Week 3/notes.md" or C:\\…\\clip.mp4' } }, required: ['file'] },
      async run({ file }) {
        const f = String(file || '').trim();
        const p = projectOfTab(chatId);
        let path = f;
        const ref = p && f.startsWith('Linked: ') ? (p.refs || []).find((r) => `Linked: ${r.name}` === f) : null;
        if (f.startsWith('Google: ')) throw new Error('Google files are read with read_project_file; Kea opens local files.');
        if (ref) path = ref.path;
        else if (!/^([a-z]:[\\/]|\/|\\\\)/i.test(f)) {
          if (!p) throw new Error('Give the full path (this chat has no context folder).');
          const rel = f.replace(/\\/g, '/').replace(/^\/+/, '');
          if (rel.split('/').includes('..')) throw new Error('Name a file inside the context folder.');
          const sep = p.dir.includes('\\') ? '\\' : '/';
          path = `${p.dir.replace(/[\\/]+$/, '')}${sep}${rel.split('/').join(sep)}`;
        }
        const same = (t: Tab) => !!t.path && t.path.toLowerCase() === path.toLowerCase();
        const was = useTabs.getState().activeId;
        let tab = useTabs.getState().tabs.find(same);
        if (!tab) {
          const { openPaths } = await import('./open');
          await openPaths([path]);
          tab = useTabs.getState().tabs.find(same);
        }
        if (!tab) throw new Error(`Kea couldn’t open ${f}.`);
        showBeside(chatId, tab.id, was);
        lastFile.set(chatId, tab.id);
        const h = await hooksOf(tab.id);
        return `Opened “${tab.name}” (file id ${tab.id}, a ${h.noun}) beside the chat. Next: editor_tools with file "${tab.id}".`;
      }
    },
    {
      name: 'editor_tools',
      description: 'The tools an open file’s editor offers (what each does and its input). Without `tool`: every tool with a short description. With `tool`: that one’s full description and input schema.',
      input_schema: { type: 'object', properties: { file: { type: 'string', description: 'File id (or open file name)' }, tool: { type: 'string' } }, required: ['file'] },
      async run({ file, tool }) {
        const t = tabOf(file);
        const tools = toolsFor(await hooksOf(t.id), t.id).filter((x) => x.name !== 'look');
        if (tool) {
          const one = tools.find((x) => x.name === tool);
          if (!one) throw new Error(`The ${t.kind} editor has no tool “${tool}”.`);
          return `${one.name}: ${one.description}\nInput: ${JSON.stringify(one.input_schema)}`;
        }
        return `Tools for “${t.name}” (use_editor with file "${t.id}"; ask for one tool to see its exact input):\n${tools.map((x) => `- ${x.name}(${Object.keys(x.input_schema.properties).join(', ')}): ${short(x.description.replace(/\s+/g, ' '), 160)}`).join('\n')}`;
      }
    },
    {
      name: 'use_editor',
      description: 'Run one of an open file’s editor tools (from editor_tools), exactly as if the person did it: e.g. {file, tool: "set_cells", input: {...}}. For several edits at once use the editor’s apply_edits tool.',
      input_schema: { type: 'object', properties: { file: { type: 'string' }, tool: { type: 'string' }, input: { type: 'object' } }, required: ['file', 'tool'] },
      async run({ file, tool, input }) {
        const t = tabOf(file);
        const hooks = await hooksOf(t.id);
        if (tool === 'look') throw new Error('Pictures aren’t available through use_editor; use the editor’s describe or check tools.');
        const out = await runToolHeadless(t.id, toolsFor(hooks, t.id), { name: String(tool), input: input || {} });
        if (!out.ok) throw new Error(`${tool} on “${t.name}”: ${out.text}`);
        return `${t.name} · ${tool}${input ? ` (${short(summary(input), 80)})` : ''}: ${out.text}`;
      }
    },
    {
      name: 'search_contacts',
      description: 'Look people up in the person’s Google Contacts (name, emails, phones, organization): e.g. to find how to reach the people on a sheet. Every word of `query` must match; leave it empty to list everyone (up to 50).',
      input_schema: { type: 'object', properties: { query: { type: 'string' } } },
      async run({ query }) {
        if (!(await api.contacts.status()).connected) throw new Error('Google Contacts isn’t connected. Tell the person they can connect it in the context folder’s files window (Look people up in Google Contacts) or Settings → Google; meanwhile use emails from the folder’s files.');
        const list = await api.contacts.search(String(query || ''));
        if (!list.length) return 'No one in Google Contacts matches that.';
        return list.map((c) => `- ${c.name || '(no name)'}${c.org ? ` · ${c.org}` : ''}${c.emails.length ? ` · ${c.emails.join(', ')}` : ''}${c.phones.length ? ` · ${c.phones.join(', ')}` : ''}`).join('\n');
      }
    },
    {
      name: 'draft_message',
      description:
        'Draft an email to one or more people for the person to approve. It appears in the chat with the message and every recipient; NOTHING is sent until they press Send (each person gets their own email; they can edit it first). Use it whenever they ask you to message, email, remind or contact people. Find addresses in the folder’s files or search_contacts first; never guess an address. `{first}` in the subject or body becomes each person’s first name.',
      input_schema: {
        type: 'object',
        properties: {
          subject: { type: 'string' },
          body: { type: 'string', description: 'Plain text, signed as the person would sign it' },
          recipients: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, email: { type: 'string' } }, required: ['email'] } }
        },
        required: ['subject', 'body', 'recipients']
      },
      run({ subject, body, recipients }) {
        const people = (Array.isArray(recipients) ? recipients : [])
          .map((r: any) => ({ name: String(r?.name || '').trim(), email: String(r?.email || '').trim() }))
          .filter((r) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email));
        if (!people.length) throw new Error('Give at least one recipient with a real email address.');
        const unique = people.filter((r, i) => people.findIndex((x) => x.email.toLowerCase() === r.email.toLowerCase()) === i).slice(0, 200);
        patchChat(chatId, (c) => ({ items: [...c.items, { id: uid(), kind: 'draft', text: '', draft: { subject: String(subject || ''), body: String(body || ''), recipients: unique } }] }));
        return `The draft is shown to the person with its ${unique.length} recipient${unique.length === 1 ? '' : 's'}. Nothing has been sent: they review it and press Send themselves. Tell them it's ready to check; don't say it was sent.`;
      }
    },
    {
      name: 'save_file',
      description: 'Save an open file. A new file goes into the context folder (or Documents) under its name; returns where it was saved.',
      input_schema: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] },
      async run({ file }) {
        const t = tabOf(file);
        const h = editorRegistry.get(t.id);
        if (!h) throw new Error('That file is still opening.');
        const ok = await h.save(false);
        const now = useTabs.getState().tabs.find((x) => x.id === t.id);
        if (!ok || !now?.path) throw new Error('It wasn’t saved (the person may have cancelled, or the folder can’t be written).');
        return `Saved: ${now.path}`;
      }
    }
  ];
}

// For Kea's own end-to-end checks (the screenshot harness).
(window as any).__keaWorkspace = { workspaceTools };
