// The Claude Assistant's conversation loop. It runs here, in the window, because the tools Claude uses are the open
// editor's own (read the file, replace a passage, apply a filter, split a clip); each request to Claude goes through
// the main process, which holds the API key (electron/assistant.cjs). Claude answers, calls tools, sees what they did,
// and carries on until it's done, the way Claude Code works in a project, but inside the one file you have open.
import { api } from './api';
import { setting } from './settings';
import { uid } from './util';
import { editorRegistry, useTabs, type AiHooks, type AssistantTool } from '../store';
import { useLookup } from '../components/lookup/lookupStore';
import { chatOf, patchChat, type ChatItem } from '../components/assistant/assistantStore';

const MAX_STEPS = 40;
const DOC_LIMIT = 400_000; // characters of the file Claude reads in one go (about 100k tokens)

/** The tools every editor gets from its hooks (reading, inserting, replacing, commenting, looking), plus its own. */
function toolsFor(hooks: AiHooks | undefined): AssistantTool[] {
  if (!hooks) return [];
  const t: AssistantTool[] = [];
  const tracked = <T,>(fn: () => T): T => (setting('assistant.track') && hooks.track ? hooks.track(fn) : fn());
  t.push({
    name: 'read_document',
    description: `Read the whole ${hooks.noun} as plain text, divided into its parts (pages, sheets, slides). Call this before answering questions about its content or editing it; read it again after big edits if you need the current text.`,
    input_schema: { type: 'object', properties: {} },
    async run() {
      const d = await hooks.getDocument();
      const text = d.sections.length > 1 ? d.sections.map((s) => `### ${s.label}\n${s.text}`).join('\n\n') : d.full;
      return text.length > DOC_LIMIT ? `${text.slice(0, DOC_LIMIT)}\n\n[The rest (${text.length - DOC_LIMIT} more characters) was cut off.]` : text || `(The ${hooks.noun} is empty.)`;
    }
  });
  if (hooks.replaceQuote)
    t.push({
      name: 'replace_text',
      description: `Replace a passage of the ${hooks.noun} with new text. \`quote\` must be copied exactly from the current text (a sentence or two is enough to be unique). Use this for edits, corrections and rewrites of specific parts.`,
      input_schema: { type: 'object', properties: { quote: { type: 'string', description: 'The exact text to replace' }, replacement: { type: 'string', description: 'What goes in its place' } }, required: ['quote', 'replacement'] },
      run: ({ quote, replacement }) => {
        if (!tracked(() => hooks.replaceQuote!(quote, replacement))) throw new Error('That text wasn’t found. Read the document again and copy the passage exactly.');
        return 'Replaced.';
      }
    });
  if (hooks.insertText)
    t.push({
      name: 'insert_text',
      description: `Insert text at the student's cursor in the ${hooks.noun} (after their selection, if any). ${hooks.noun === 'document' ? 'Markdown formatting (headings, lists, bold, tables) is turned into real formatting.' : ''} ${hooks.noun === 'spreadsheet' ? 'A formula starting with = goes into the selected cell; tab-separated rows fill cells downward from it.' : ''}`.trim(),
      input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      run: ({ text }) => {
        if (!tracked(() => hooks.insertText!(text))) throw new Error('The editor couldn’t insert there. Ask the student to click where it should go.');
        return 'Inserted.';
      }
    });
  if (hooks.replaceSelection)
    t.push({
      name: 'replace_selection',
      description: `Replace what the student has selected in the ${hooks.noun} with new text.`,
      input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      run: ({ text }) => {
        if (!tracked(() => hooks.replaceSelection!(text))) throw new Error('Nothing is selected in the editor.');
        return 'Replaced the selection.';
      }
    });
  if (hooks.addComment)
    t.push({
      name: 'add_comment',
      description: `Leave a comment on a passage of the ${hooks.noun}, the way a reviewer would, without changing the text. \`quote\` must be copied exactly.`,
      input_schema: { type: 'object', properties: { quote: { type: 'string' }, comment: { type: 'string' } }, required: ['quote', 'comment'] },
      run: ({ quote, comment }) => {
        if (!hooks.addComment!(quote, comment)) throw new Error('That text wasn’t found.');
        return 'Commented.';
      }
    });
  if (hooks.reveal)
    t.push({
      name: 'show_in_document',
      description: `Scroll the ${hooks.noun} to a passage and highlight it for the student. \`quote\` is copied from the text.`,
      input_schema: { type: 'object', properties: { quote: { type: 'string' } }, required: ['quote'] },
      run: ({ quote }) => {
        if (!hooks.reveal!(quote)) throw new Error('That text wasn’t found.');
        return 'Shown.';
      }
    });
  t.push({
    name: 'look',
    description: hooks.getImage
      ? `See the ${hooks.noun} as it looks right now (a picture). Use it to check visual work after making changes.`
      : `See the editor as the student sees it right now (a screenshot of the ${hooks.noun}'s area): layout, formatting, charts, what's on screen.`,
    input_schema: { type: 'object', properties: {} },
    run: () => 'picture' // handled in runTool: the result carries the image
  });
  return [...t, ...(hooks.tools || [])];
}

/** What the open file looks like: the editor's own picture (photo, video frame), else a screenshot of its area. */
async function picture(tabId: string) {
  const own = await editorRegistry.get(tabId)?.ai?.getImage?.().catch(() => null);
  if (own) return own;
  const pane = document.querySelector(`.pane[data-tab="${CSS.escape(tabId)}"]`) as HTMLElement | null;
  if (!pane || pane.hidden) return null;
  const r = pane.getBoundingClientRect();
  const shot = await api.assistant.capture({ x: r.x, y: r.y, width: r.width, height: r.height }).catch(() => null);
  return shot && { ...shot, note: 'A screenshot of the editor as the student sees it.' };
}

/** Checks a tool's input against its schema's top level: required fields there, and the right basic types. */
function invalid(tool: AssistantTool, input: any): string | null {
  if (!input || typeof input !== 'object') return 'The input wasn’t an object.';
  for (const r of tool.input_schema.required || []) if (input[r] === undefined) return `Missing “${r}”.`;
  for (const [k, spec] of Object.entries(tool.input_schema.properties) as [string, any][]) {
    const v = input[k];
    if (v === undefined || !spec?.type) continue;
    const ok = spec.type === 'array' ? Array.isArray(v) : spec.type === 'integer' ? Number.isInteger(v) : spec.type === 'number' ? typeof v === 'number' : spec.type === 'object' ? typeof v === 'object' && !Array.isArray(v) : typeof v === spec.type;
    if (!ok) return `“${k}” should be ${spec.type === 'integer' ? 'a whole number' : `a ${spec.type}`}.`;
  }
  return null;
}

const SYSTEM = `You are Claude, working inside Kea, the student's office and study app, in a sidebar next to the file they have open (a document, PDF, spreadsheet, presentation, code file, image or video). You can read it and change it with the tools you're given, the way Claude Code works in a project.

How to work:
- Read the file (read_document) before answering questions about it or editing it; don't guess its content. For pictures, video and slides, use look to see them.
- Make the change the student asks for with the editor's tools, then say briefly what you did. Every change is one undo step (Ctrl+Z) for them, so act rather than asking permission for ordinary edits; ask first only before replacing most of the file or when the request is unclear.
- Keep edits precise: change the passage that needs it, not the whole file. Copy quotes exactly from the latest text.
- If a tool fails, read its message, fix the input (re-read the file if the text changed) and try again, or explain what's in the way.
- Answers are shown in a narrow panel: short paragraphs, plain Markdown, no big headings. Don't paste the whole file back.
- For schoolwork, help the student understand and improve their own work; explain why when you correct something.`;

/** Context sent with each message: which file, and what the student has selected. */
function context(tabId: string, hooks: AiHooks | undefined) {
  const tab = useTabs.getState().tabs.find((t) => t.id === tabId);
  const sel = useLookup.getState().selections[tabId] || '';
  const lines = [`[Open ${hooks?.noun || 'file'}: ${tab?.name || 'untitled'}]`];
  if (!hooks) lines.push('[This view has no tools: Claude can only talk about it.]');
  if (sel) lines.push(`[Selected: «${sel.slice(0, 2000)}»]`);
  return lines.join('\n');
}

const addItem = (tabId: string, item: Omit<ChatItem, 'id'>) => {
  const it = { id: uid(), ...item };
  patchChat(tabId, (c) => ({ items: [...c.items, it] }));
  return it.id;
};
const patchItem = (tabId: string, id: string, p: Partial<ChatItem> | ((i: ChatItem) => Partial<ChatItem>)) =>
  patchChat(tabId, (c) => ({ items: c.items.map((i) => (i.id === id ? { ...i, ...(typeof p === 'function' ? p(i) : p) } : i)) }));

const stopped = new Set<string>();

/** Send what the student typed and let Claude work until it's done (or is stopped). */
export async function ask(tabId: string, text: string, opts: { look?: boolean } = {}) {
  const hooks = editorRegistry.get(tabId)?.ai;
  const tools = toolsFor(hooks);
  const content: any[] = [];
  let shown: string | undefined;
  // With "Show Claude a picture with each message", visual editors (photo, video) send what they look like right now;
  // the eye button sends a picture of any editor.
  if (opts.look ?? (!!hooks?.getImage && setting('assistant.autoLook') !== false)) {
    const img = await picture(tabId);
    if (img) {
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: img.dataUrl.split(',')[1] } });
      shown = img.dataUrl;
    }
  }
  content.push({ type: 'text', text: `${context(tabId, hooks)}\n\n${text}` });
  patchChat(tabId, (c) => ({ messages: [...c.messages, { role: 'user', content }], busy: true }));
  addItem(tabId, { kind: 'user', text, image: shown });
  stopped.delete(tabId);

  const defs = tools.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
  let retries = 0;
  try {
    for (let step = 0; step < MAX_STEPS && !stopped.has(tabId); step++) {
      const reqId = uid();
      patchChat(tabId, { reqId });
      let textItem = '';
      let thinkItem = '';
      // What streams in is shown as it arrives, then replaced by the finished message (the last few pieces of a stream
      // can reach the window after the turn has ended).
      const streamed: string[] = [];
      const off = api.assistant.onEvent((ev) => {
        if (ev.id !== reqId) return;
        if (ev.type === 'text') {
          if (!textItem) streamed.push((textItem = addItem(tabId, { kind: 'assistant', text: '' })));
          patchItem(tabId, textItem, (i) => ({ text: i.text + ev.text }));
        } else if (ev.type === 'thinking' && setting('assistant.showThinking') !== false) {
          if (!thinkItem) streamed.push((thinkItem = addItem(tabId, { kind: 'thinking', text: '' })));
          patchItem(tabId, thinkItem, (i) => ({ text: i.text + ev.text }));
        } else if (ev.type === 'tool') textItem = '';
      });
      const r = await api.assistant.send(reqId, { model: setting('assistant.model') || 'claude-opus-5-5', effort: setting('assistant.effort') || 'medium', system: SYSTEM, messages: chatOf(tabId).messages, tools: defs }).finally(off);
      if (r.content) patchChat(tabId, (c) => ({ items: c.items.filter((i) => !streamed.includes(i.id)) }));
      for (const b of r.content || []) {
        if (b.type === 'text' && b.text) addItem(tabId, { kind: 'assistant', text: b.text });
        else if (b.type === 'thinking' && b.thinking && setting('assistant.showThinking') !== false) addItem(tabId, { kind: 'thinking', text: b.thinking });
      }
      if (r.retry && retries++ < 2) continue;
      if (r.error || !r.content) {
        if (!r.stopped) addItem(tabId, { kind: 'error', text: r.error || 'Claude didn’t answer.' });
        break;
      }
      retries = 0;
      if (r.usage)
        patchChat(tabId, (c) => ({
          usage: { input: c.usage.input + (r.usage.input_tokens || 0), output: c.usage.output + (r.usage.output_tokens || 0), cached: c.usage.cached + (r.usage.cache_read_input_tokens || 0) }
        }));
      // The answer goes back unchanged (reasoning blocks included), as the API requires.
      patchChat(tabId, (c) => ({ messages: [...c.messages, { role: 'assistant', content: r.content }] }));
      if (r.stop_reason === 'refusal') {
        addItem(tabId, { kind: 'error', text: 'Claude declined this request.' });
        break;
      }
      const uses = r.content.filter((b: any) => b.type === 'tool_use');
      if (!uses.length) break;
      if (r.stop_reason === 'max_tokens') {
        addItem(tabId, { kind: 'error', text: 'Claude’s answer was too long and got cut off. Ask for a smaller step.' });
        break;
      }
      // Tools run one at a time (they change the same file), and all their results go back together.
      const results: any[] = [];
      for (const u of uses) results.push(await runTool(tabId, tools, u));
      patchChat(tabId, (c) => ({ messages: [...c.messages, { role: 'user', content: results }] }));
    }
  } finally {
    patchChat(tabId, { busy: false, reqId: undefined });
  }
}

async function runTool(tabId: string, tools: AssistantTool[], use: { id: string; name: string; input: any }) {
  const tool = tools.find((t) => t.name === use.name);
  const item = addItem(tabId, { kind: 'tool', name: use.name, text: summary(use.input) });
  const fail = (msg: string) => {
    patchItem(tabId, item, { ok: false, result: msg });
    return { type: 'tool_result', tool_use_id: use.id, is_error: true, content: msg };
  };
  if (stopped.has(tabId)) return fail('The student stopped Claude before this ran.');
  if (!tool) return fail(`There's no tool called ${use.name} here.`);
  const bad = invalid(tool, use.input);
  if (bad) return fail(`INVALID_INPUT: ${bad}`);
  try {
    if (use.name === 'look') {
      const img = await picture(tabId);
      if (!img) return fail('The editor couldn’t make a picture right now.');
      patchItem(tabId, item, { ok: true, result: img.note || `${img.width} × ${img.height}`, image: img.dataUrl });
      return {
        type: 'tool_result',
        tool_use_id: use.id,
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: img.dataUrl.split(',')[1] } }, { type: 'text', text: img.note || `${img.width} × ${img.height} px` }]
      };
    }
    const out = String((await tool.run(use.input)) ?? 'Done.');
    patchItem(tabId, item, { ok: true, result: out.length > 300 ? `${out.slice(0, 300)}…` : out });
    return { type: 'tool_result', tool_use_id: use.id, content: out };
  } catch (err: any) {
    return fail(String(err?.message || err));
  }
}

/** A tool call's input in a few words, for the step shown in the panel. */
function summary(input: any): string {
  if (!input || typeof input !== 'object') return '';
  const parts = Object.entries(input).map(([k, v]) => `${k}: ${typeof v === 'string' ? `“${v.length > 60 ? `${v.slice(0, 60)}…` : v}”` : JSON.stringify(v)?.slice(0, 60)}`);
  return parts.join(', ');
}

export function stop(tabId: string) {
  stopped.add(tabId);
  const id = chatOf(tabId).reqId;
  if (id) api.assistant.stop(id);
}

export function clear(tabId: string) {
  stop(tabId);
  patchChat(tabId, { messages: [], items: [], busy: false, usage: { input: 0, output: 0, cached: 0 } });
}
