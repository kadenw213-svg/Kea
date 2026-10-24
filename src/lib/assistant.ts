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
import { contentBlock, describeAttachment, type Attachment } from './attachments';

const MAX_STEPS = 40;

const SYSTEM = `You are Claude, working inside Kea, the student's office and study app, in a sidebar next to the file they have open (a document, PDF, spreadsheet, presentation, code file, image or video). You can read it and change it with the tools you're given, the way Claude Code works in a project.

How to work:
- Read the file (read_document) before answering questions about it or editing it; don't guess its content. For pictures, video and slides, use look to see them.
- Make the change the student asks for with the editor's tools, then say briefly what you did. Every change is one undo step (Ctrl+Z) for them, so act rather than asking permission for ordinary edits; ask first only before replacing most of the file or when the request is unclear.
- Keep edits precise: change the passage that needs it, not the whole file. Copy quotes exactly from the latest text.
- If a tool fails, read its message, fix the input (re-read the file if the text changed) and try again, or explain what's in the way.
- Answers are shown in a narrow panel: short paragraphs, plain Markdown, no big headings. Don't paste the whole file back.
- For schoolwork, help the student understand and improve their own work; explain why when you correct something.

Attachments and design:
- The student may attach images or PDFs (a flier, a sketch, concept art, a brief, designs they like). Each is named in the message with an id like a1. Study them closely: layout, palette, type, mood, details.
- "Make this" / "design it like this" / "use this as a reference" means build it in the open file with the editor's own tools, matching or improving on the reference's style. An attached image can be placed directly (attachment: "a1") when the student wants the picture itself in the file.
- Design to a professional standard, never a basic one. Before designing anything visual, read design_guide "start" and the topics the job needs (styles, typography, colour, formats, brand; video for anything on a timeline; vector before writing artwork). Commit to one art direction, a grid, a type scale and a small palette (taken from the reference when there is one) before placing anything.
- Plain rectangles and circles look amateur. Make the visuals rich with vector artwork you write as SVG (the image tools' svg input): layered gradients, grain, patterns, organic shapes, illustrations, badges, ornaments, depth and light. Keep text in real text boxes so it stays editable and sharp, and use only installed fonts.
- A short or vague request still gets a finished, professional result: infer the audience and purpose, pick the direction yourself, write any missing copy, and say in one line what you chose. The student's own guidelines (shown in design_guide "start") always win over the defaults.
- After building, look at the result and run the guide's checklists: hierarchy, alignment, spacing, contrast, overlaps, text overflow, and whether it looks generic. Fix what fails and look again before saying you're done.`;

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
// Bumped by clear(): a loop still running for the old conversation must not add to the new one.
const generation = new Map<string, number>();

/** Send what the student typed and let Claude work until it's done (or is stopped). */
export async function ask(tabId: string, text: string, opts: { look?: boolean; attachments?: Attachment[] } = {}) {
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
  const files = opts.attachments || [];
  for (const a of files) content.push(await contentBlock(a));
  const named = files.map(describeAttachment).join('\n');
  content.push({ type: 'text', text: `${context(tabId, hooks)}${named ? `\n${named}` : ''}\n\n${text || 'Here are the files.'}` });
  addItem(tabId, { kind: 'user', text, image: shown, files: files.map((a) => ({ name: a.name, thumb: a.mime.startsWith('image/') ? a.dataUrl : undefined })) });
  stopped.delete(tabId);
  const gen = generation.get(tabId) || 0;
  const live = () => (generation.get(tabId) || 0) === gen;
  if (setting('assistant.provider') !== 'api') return askPlan(tabId, content, live);
  patchChat(tabId, (c) => ({ messages: [...c.messages, { role: 'user', content }], busy: true, via: 'api' }));

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
      if (!live()) break;
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
        // Every tool_use needs a tool_result, or the next message in this chat is refused.
        const cut = uses.map((u: any) => ({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: 'Not run: the answer was cut off (max_tokens) before this call was complete.' }));
        patchChat(tabId, (c) => ({ messages: [...c.messages, { role: 'user', content: cut }] }));
        addItem(tabId, { kind: 'error', text: 'Claude’s answer was too long and got cut off. Ask for a smaller step.' });
        break;
      }
      // Tools run one at a time (they change the same file), and all their results go back together.
      const results: any[] = [];
      for (const u of uses) results.push(await runTool(tabId, tools, u));
      if (!live()) break;
      patchChat(tabId, (c) => ({ messages: [...c.messages, { role: 'user', content: results }] }));
    }
  } finally {
    if (live()) patchChat(tabId, { busy: false, reqId: undefined });
  }
}

/**
 * The same conversation on the student's Claude plan: Claude Code runs the turn (calling this file's tools over Kea's
 * private MCP connection) and we show what it streams: text and reasoning as they arrive, each tool step with its
 * result. Follow-up messages continue the same Claude Code session.
 */
async function askPlan(tabId: string, content: any[], live: () => boolean) {
  const reqId = uid();
  patchChat(tabId, { busy: true, reqId, via: 'plan' });
  const steps = new Map<string, string>(); // tool_use id -> panel item id
  const streamedMsgs = new Set<string>();
  let msgId = '';
  let textItem = '';
  let thinkItem = '';
  const showThinking = setting('assistant.showThinking') !== false;
  const resultText = (c: any): { text: string; image?: string } => {
    if (typeof c === 'string') return { text: c };
    const parts = Array.isArray(c) ? c : [];
    const img = parts.find((p: any) => p.type === 'image' && p.source?.data);
    return { text: parts.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n'), image: img ? `data:${img.source.media_type || 'image/png'};base64,${img.source.data}` : undefined };
  };
  const off = api.assistant.onPlanEvent(({ id, ev }) => {
    if (id !== reqId || !live()) return;
    if (ev.type === 'stream_event') {
      const e = ev.event;
      if (e.type === 'message_start') {
        msgId = e.message?.id || '';
        textItem = thinkItem = '';
      } else if (e.type === 'content_block_start') textItem = thinkItem = '';
      else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
        streamedMsgs.add(msgId);
        if (!textItem) textItem = addItem(tabId, { kind: 'assistant', text: '' });
        patchItem(tabId, textItem, (i) => ({ text: i.text + e.delta.text }));
      } else if (e.type === 'content_block_delta' && e.delta?.type === 'thinking_delta' && showThinking) {
        streamedMsgs.add(msgId);
        if (!thinkItem) thinkItem = addItem(tabId, { kind: 'thinking', text: '' });
        patchItem(tabId, thinkItem, (i) => ({ text: i.text + e.delta.thinking }));
      }
    } else if (ev.type === 'assistant') {
      const m = ev.message || {};
      for (const b of m.content || []) {
        if (b.type === 'tool_use') {
          if (!steps.has(b.id)) steps.set(b.id, addItem(tabId, { kind: 'tool', name: String(b.name).replace(/^mcp__kea__/, ''), text: summary(b.input) }));
        } else if (!streamedMsgs.has(m.id)) {
          // Not streamed (older Claude Code): show the finished blocks.
          if (b.type === 'text' && b.text) addItem(tabId, { kind: 'assistant', text: b.text });
          else if (b.type === 'thinking' && b.thinking && showThinking) addItem(tabId, { kind: 'thinking', text: b.thinking });
        }
      }
    } else if (ev.type === 'user') {
      for (const b of ev.message?.content || []) {
        if (b.type !== 'tool_result') continue;
        const item = steps.get(b.tool_use_id);
        if (!item) continue;
        const r = resultText(b.content);
        patchItem(tabId, item, { ok: !b.is_error, result: r.text.length > 300 ? `${r.text.slice(0, 300)}…` : r.text, ...(r.image ? { image: r.image } : {}) });
      }
    } else if (ev.type === 'result' && ev.usage) {
      const u = ev.usage;
      patchChat(tabId, (c) => ({ usage: { input: c.usage.input + (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0), output: c.usage.output + (u.output_tokens || 0), cached: c.usage.cached + (u.cache_read_input_tokens || 0) } }));
    }
  });
  try {
    const r = await api.assistant.planSend(reqId, {
      tabId,
      content,
      session: chatOf(tabId).planSession,
      model: setting('assistant.model') || 'claude-opus-5-5',
      effort: setting('assistant.effort') || 'medium',
      system: SYSTEM
    });
    if (!live()) return;
    if (r.session) patchChat(tabId, { planSession: r.session });
    // Steps that never got a result (stopped mid-way) aren't left spinning.
    for (const item of steps.values()) patchItem(tabId, item, (i) => (i.ok === undefined ? { ok: false, result: 'Not finished.' } : {}));
    if (r.error) addItem(tabId, { kind: 'error', text: r.error });
  } finally {
    off();
    if (live()) patchChat(tabId, { busy: false, reqId: undefined });
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
  const { reqId: id, via } = chatOf(tabId);
  if (id) via === 'plan' ? api.assistant.planStop(id) : api.assistant.stop(id);
}

export function clear(tabId: string) {
  stop(tabId);
  generation.set(tabId, (generation.get(tabId) || 0) + 1);
  patchChat(tabId, { messages: [], items: [], busy: false, usage: { input: 0, output: 0, cached: 0 }, planSession: undefined });
}

// For Kea's own end-to-end tests (driven over the DevTools protocol), like window.__kea in store.ts.
(window as any).__keaAssistant = { ask, stop, clear, chatOf, setting };
