// The Claude Assistant's conversation loop. It runs here, in the window, because the tools Claude uses are the open
// editor's own (read the file, replace a passage, apply a filter, split a clip); each request to Claude goes through
// the main process, which holds the API key (electron/assistant.cjs). Claude answers, calls tools, sees what they did,
// and carries on until it's done, the way Claude Code works in a project, but inside the one file you have open.
// The tools themselves live in src/lib/editorTools.ts, shared with the MCP control server so an outside app drives
// the exact same tools.
import { api } from './api';
import { setting } from './settings';
import { uid } from './util';
import { editorRegistry, useTabs, type AiHooks, type AssistantTool } from '../store';
import { useLookup } from '../components/lookup/lookupStore';
import { chatOf, patchChat, type ChatItem } from '../components/assistant/assistantStore';
import { toolsFor, picture, summary, runToolHeadless } from './editorTools';

const MAX_STEPS = 40;

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

/** Run one tool for the sidebar: show the step in the panel, then shape the result as an Anthropic tool_result. */
async function runTool(tabId: string, tools: AssistantTool[], use: { id: string; name: string; input: any }) {
  const item = addItem(tabId, { kind: 'tool', name: use.name, text: summary(use.input) });
  const out = await runToolHeadless(tabId, tools, use, () => stopped.has(tabId));
  if (!out.ok) {
    patchItem(tabId, item, { ok: false, result: out.text });
    return { type: 'tool_result', tool_use_id: use.id, is_error: true, content: out.text };
  }
  if (out.image) {
    patchItem(tabId, item, { ok: true, result: out.text, image: out.image.dataUrl });
    return {
      type: 'tool_result',
      tool_use_id: use.id,
      content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: out.image.dataUrl.split(',')[1] } }, { type: 'text', text: out.text }]
    };
  }
  patchItem(tabId, item, { ok: true, result: out.text.length > 300 ? `${out.text.slice(0, 300)}…` : out.text });
  return { type: 'tool_result', tool_use_id: use.id, content: out.text };
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
