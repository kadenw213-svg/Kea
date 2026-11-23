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
import { chatOf, patchChat, setActivity, doing, focusOf, setFocus, type ChatItem, type Focus } from '../components/assistant/assistantStore';
import { toolsFor, picture, summary, runToolHeadless } from './editorTools';
import { contentBlock, describeAttachment, type Attachment } from './attachments';
import { assignmentOf, assignmentSig, assignmentText } from './assignmentContext';
import { route, routeFor, type Route, type Tier } from './funnel';
import { newPlaceholders, placeholderComment } from './placeholders';
import { projectOfTab } from './projects';

const MAX_STEPS = 40;

/**
 * The models people can pick (the model menu under the message box and on Home's Ask bar). On their own Claude plan
 * every model is there; on an API key (pay per use) Opus is the top choice, and anything above it runs on Opus.
 */
export const MODEL_CHOICES: { id: string; label: string; note: string; planOnly?: boolean }[] = [
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', note: 'Quickest' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', note: 'Fast and capable' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', note: 'Best for most work' },
  { id: 'claude-fable-5-2', label: 'Fable 5.2', note: 'Most capable', planOnly: true }
];
export const onOwnPlan = () => setting('assistant.provider') !== 'api';
/** A model this person may use right now (an older or plan-only model becomes the nearest one they can). */
export function capModel(model: string): string {
  if (/^claude-fable/.test(model)) return onOwnPlan() ? 'claude-fable-5-2' : 'claude-opus-5-5';
  return MODEL_CHOICES.some((m) => m.id === model) ? model : 'claude-opus-5-5';
}

/** Where a run counts in the Usage menu: "assistant.doc", "assistant.video", "home.chat" (a Claude page). */
function featureOf(tabId: string) {
  if (editorRegistry.get(tabId)?.ai?.workspace) return 'home.chat';
  return `assistant.${useTabs.getState().tabs.find((t) => t.id === tabId)?.kind || 'other'}`;
}

// What Claude is told about working in Kea: one file per topic in ./guidelines (core rules, writing feedback, academic
// writing, classes, documents, design), read in this order.
import core from './guidelines/core.md?raw';
import writing from './guidelines/writing.md?raw';
import academic from './guidelines/academic.md?raw';
import classes from './guidelines/classes.md?raw';
import documents from './guidelines/documents.md?raw';
import design from './guidelines/design.md?raw';

export const SYSTEM = [core, writing, academic, classes, documents, design].map((t) => t.trim()).join('\n\n');

/**
 * Context sent with each message: which file, and what the student has selected. A passage sent with "Ask Claude"
 * (the selection menu, Ctrl+Shift+A) is the focus of the message; a selection that's just there is mentioned.
 */
function context(tabId: string, hooks: AiHooks | undefined, focus: Focus | null) {
  const tab = useTabs.getState().tabs.find((t) => t.id === tabId);
  const sel = useLookup.getState().selections[tabId] || '';
  const lines = [hooks?.context ? hooks.context() : `[Open ${hooks?.noun || 'file'}: ${tab?.name || 'untitled'}]`];
  if (!hooks) lines.push('[This view has no tools: Claude can only talk about it.]');
  const folder = hooks && !hooks.workspace ? projectOfTab(tabId) : null;
  if (folder) lines.push(`[This file is in the context folder "${folder.name}" (${folder.dir}). list_project_files and read_project_file read its other files; create_file, open_file, editor_tools and use_editor make or change other files; draft_message drafts messages for the person to approve.]`);
  if (focus) lines.push(`[Focus passage${focus.where ? ` (${focus.where})` : ''}: the student highlighted this and sent it to you; work on exactly this]\n«${focus.text.slice(0, 8000)}»`);
  else if (sel) lines.push(`[Selected: «${sel.slice(0, 2000)}»]`);
  return lines.join('\n');
}

const addItem = (tabId: string, item: Omit<ChatItem, 'id'>) => {
  const it = { id: uid(), ...item };
  patchChat(tabId, (c) => ({ items: [...c.items, it] }));
  return it.id;
};
const patchItem = (tabId: string, id: string, p: Partial<ChatItem> | ((i: ChatItem) => Partial<ChatItem>)) =>
  patchChat(tabId, (c) => ({ items: c.items.map((i) => (i.id === id ? { ...i, ...(typeof p === 'function' ? p(i) : p) } : i)) }));

// The run going on in each tab (one at a time): its own stop flag, so stopping or clearing one run can never be
// undone by the next message.
const runs = new Map<string, { stopped: boolean }>();
// Bumped by clear(): a loop still running for the old conversation must not add to the new one.
const generation = new Map<string, number>();

/**
 * `look`: send a picture of the editor. `attachments`: files to give Claude. `tier`: a button that knows what it needs
 * (one-click suggestions are standard, the pre-submit check is deep) skips the funnel's guess.
 */
export interface AskOpts {
  look?: boolean;
  attachments?: Attachment[];
  tier?: Tier;
  /**
   * Sent by a button (a starter, Suggestions, Review against the rubric): the prompt goes to Claude but isn't shown in
   * the chat, only Claude's answer is (Kea 0.102).
   */
  quiet?: boolean;
}

/** Send what the student typed and let Claude work until it's done (or is stopped). */
export async function ask(tabId: string, text: string, opts: AskOpts = {}) {
  // Taken before anything is awaited, so a double Enter or a double-clicked starter can't start a second run.
  if (runs.has(tabId) || chatOf(tabId).busy) return;
  const run = { stopped: false };
  runs.set(tabId, run);
  patchChat(tabId, { busy: true });
  const gen = generation.get(tabId) || 0;
  const live = () => (generation.get(tabId) || 0) === gen;
  const mine = () => runs.get(tabId) === run;
  // Where the person is right now is Claude's "here" for this request, even if they move on while it works.
  const hooks = editorRegistry.get(tabId)?.ai;
  try {
    hooks?.beginRun?.();
  } catch {}
  try {
    await askRun(tabId, text, opts, run, live);
  } catch (err: any) {
    if (live()) addItem(tabId, { kind: 'error', text: String(err?.message || err) });
  } finally {
    try {
      if (mine()) editorRegistry.get(tabId)?.ai?.endRun?.();
    } catch {}
    if (mine()) {
      runs.delete(tabId);
      setActivity(tabId, undefined);
    }
    if (live()) patchChat(tabId, { busy: false, reqId: undefined });
  }
}

async function askRun(tabId: string, text: string, opts: AskOpts, run: { stopped: boolean }, live: () => boolean) {
  const hooks = editorRegistry.get(tabId)?.ai;
  const tools = toolsFor(hooks, tabId);
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
  // The assignment this file is for, given whole once per conversation (and again when the student picks another).
  const assignment = assignmentOf(tabId);
  const sig = assignment ? assignmentSig(assignment) : '';
  const giving = !!assignment && chatOf(tabId).assignmentSent !== sig;
  if (assignment && giving) {
    content.push({ type: 'text', text: `[The assignment this ${hooks?.noun || 'file'} is for: work against its guidelines and rubric]\n${await assignmentText(assignment)}` });
    patchChat(tabId, { assignmentSent: sig });
  }
  const focus = focusOf(tabId);
  setFocus(tabId, null);
  content.push({ type: 'text', text: `${context(tabId, hooks, focus)}${named ? `\n${named}` : ''}\n\n${text || (focus ? 'Help me with this passage.' : 'Here are the files.')}` });
  // Which model this message needs (the funnel), or the one chosen in Settings when the funnel is off.
  const chosen = capModel(String(setting('assistant.model') || 'claude-opus-5-5'));
  const effort = String(setting('assistant.effort') || 'medium');
  const sel = useLookup.getState().selections[tabId] || '';
  const way: Route =
    setting('assistant.funnel') === false
      ? { tier: 'deep', model: chosen, effort, why: 'The model chosen in Settings' }
      : opts.tier
        ? routeFor(opts.tier, chosen, effort)
        : route({ text, selection: focus ? focus.text.length : sel.length, assignment: !!assignment, attachments: files.length, noun: hooks?.noun || 'file' }, chosen, effort);
  addItem(tabId, {
    kind: 'user',
    ...(opts.quiet ? { hidden: true } : {}),
    text,
    image: shown,
    focus: focus?.text,
    route: setting('assistant.funnel') === false ? undefined : { tier: way.tier, model: way.model, why: way.why },
    files: [...(assignment && giving ? [{ name: `Assignment: ${assignment.label}` }] : []), ...files.map((a) => ({ name: a.name, thumb: a.mime.startsWith('image/') ? a.dataUrl : undefined }))]
  });
  if (run.stopped || !live()) return;
  // What the document said before Claude worked on it, so placeholders Claude adds can be told from the student's own.
  const before = hooks?.noun === 'document' ? await hooks.getDocument().then((d) => d.full).catch(() => null) : null;
  try {
    if (setting('assistant.provider') !== 'api') return await askPlan(tabId, content, live, run, way);
    await askApi(tabId, content, live, run, way);
  } finally {
    if (before !== null && live() && !run.stopped) await sweepPlaceholders(tabId, before).catch(() => {});
  }
}

/**
 * Placeholders Claude left in the document ("[insert source]", "TODO") become margin comments: the guidelines say it
 * never leaves them, and this catches any that slip through. The student's own are left alone.
 */
async function sweepPlaceholders(tabId: string, before: string) {
  const hooks = editorRegistry.get(tabId)?.ai;
  if (!hooks?.addComment || setting('assistant.placeholderComments') === false) return;
  const after = await hooks.getDocument().then((d) => d.full);
  const found = newPlaceholders(before, after).slice(0, 12);
  let n = 0;
  for (const p of found) if (hooks.addComment(p.quote, placeholderComment(p))) n++;
  if (n) addItem(tabId, { kind: 'assistant', text: `I left ${n === 1 ? 'one spot' : `${n} spots`} for you to fill in, marked with ${n === 1 ? 'a comment' : 'comments'} in the margin.` });
}

async function askApi(tabId: string, content: any[], live: () => boolean, run: { stopped: boolean }, way: Route) {
  // Earlier turns' reasoning belongs to the model that wrote it: when the funnel picks another model, it's left out
  // (only the current turn's reasoning has to go back, and that turn stays on one model).
  const strip = (m: any) => (m.role === 'assistant' && Array.isArray(m.content) ? { ...m, content: m.content.filter((b: any) => b.type !== 'thinking' && b.type !== 'redacted_thinking') } : m);
  patchChat(tabId, (c) => ({ messages: [...(c.lastModel && c.lastModel !== way.model ? c.messages.map(strip) : c.messages), { role: 'user', content }], via: 'api', lastModel: way.model }));

  let retries = 0;
  try {
    for (let step = 0; step < MAX_STEPS && !run.stopped; step++) {
      // The editor's tools are rebuilt each render (they read its current state): take the latest every step.
      const tools = toolsFor(editorRegistry.get(tabId)?.ai, tabId);
      const defs = tools.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
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
      const r = await api.assistant.send(reqId, { model: way.model, effort: way.effort, system: SYSTEM, messages: chatOf(tabId).messages, tools: defs }).finally(off);
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
      if (r.usage) {
        const u = r.usage;
        api.usage
          ?.add({ feature: featureOf(tabId), byModel: { [way.model]: { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0 } }, tools: uses.map((x: any) => x.name) })
          .catch(() => {});
      }
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
      for (const u of uses) results.push(await runTool(tabId, tools, u, run));
      if (!live()) break;
      patchChat(tabId, (c) => ({ messages: [...c.messages, { role: 'user', content: results }] }));
    }
  } finally {
    if (live()) patchChat(tabId, { reqId: undefined });
  }
}

/**
 * The same conversation on the student's Claude plan: Claude Code runs the turn (calling this file's tools over Kea's
 * private MCP connection) and we show what it streams: text and reasoning as they arrive, each tool step with its
 * result. Follow-up messages continue the same Claude Code session.
 */
async function askPlan(tabId: string, content: any[], live: () => boolean, run: { stopped: boolean }, way: Route) {
  const reqId = uid();
  patchChat(tabId, { reqId, via: 'plan' });
  const steps = new Map<string, string>(); // tool_use id -> panel item id
  const toolNames: string[] = []; // (for the Usage menu)
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
      if (run.stopped) return;
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
          const name = String(b.name).replace(/^mcp__kea__/, '');
          setActivity(tabId, doing(name));
          if (!steps.has(b.id)) {
            toolNames.push(name);
            steps.set(b.id, addItem(tabId, { kind: 'tool', name, text: summary(b.input) }));
          }
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
      api.usage?.add({ feature: featureOf(tabId), ev, model: way.model, tools: toolNames.splice(0) }).catch(() => {});
      const u = ev.usage;
      patchChat(tabId, (c) => ({ usage: { input: c.usage.input + (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0), output: c.usage.output + (u.output_tokens || 0), cached: c.usage.cached + (u.cache_read_input_tokens || 0) } }));
    }
  });
  try {
    const r = await api.assistant.planSend(reqId, {
      tabId,
      content,
      session: chatOf(tabId).planSession,
      model: way.model,
      effort: way.effort,
      system: SYSTEM,
      web: setting('assistant.web') !== false
    });
    if (!live()) return;
    if (r.session) patchChat(tabId, { planSession: r.session });
    // Steps that never got a result (stopped mid-way) aren't left spinning.
    for (const item of steps.values()) patchItem(tabId, item, (i) => (i.ok === undefined ? { ok: false, result: 'Not finished.' } : {}));
    if (r.error) addItem(tabId, { kind: 'error', text: r.error });
  } finally {
    off();
  }
}

/** Run one tool for the sidebar: show the step in the panel, then shape the result as an Anthropic tool_result. */
async function runTool(tabId: string, tools: AssistantTool[], use: { id: string; name: string; input: any }, run: { stopped: boolean }) {
  setActivity(tabId, doing(use.name));
  const item = addItem(tabId, { kind: 'tool', name: use.name, text: summary(use.input) });
  const out = await runToolHeadless(tabId, tools, use, () => run.stopped);
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
  const run = runs.get(tabId);
  if (run) run.stopped = true;
  const { reqId: id, via } = chatOf(tabId);
  if (id) via === 'plan' ? api.assistant.planStop(id) : api.assistant.stop(id);
}

export function clear(tabId: string) {
  stop(tabId);
  runs.delete(tabId); // the stopped run winds down on its own; a new one may start straight away
  setActivity(tabId, undefined);
  generation.set(tabId, (generation.get(tabId) || 0) + 1);
  patchChat(tabId, { messages: [], items: [], busy: false, usage: { input: 0, output: 0, cached: 0 }, planSession: undefined });
}

// For Kea's own end-to-end tests (driven over the DevTools protocol), like window.__kea in store.ts.
(window as any).__keaAssistant = { ask, stop, clear, chatOf, patchChat, setting };
