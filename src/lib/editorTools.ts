// The editor tool layer, shared by the in-app Claude sidebar (src/lib/assistant.ts) and the MCP control server
// (electron/mcp + src/lib/controlBridge.ts), so an outside app drives exactly the same tools the sidebar does.
// Every open editor registers `AiHooks` (src/store.ts); from those we build the tools (read, insert, replace,
// comment, look, plus each editor's own) and run them against the live editor. Nothing here touches the chat UI.
import { api } from './api';
import { setting } from './settings';
import { editorRegistry, useTabs, type AiHooks, type AssistantTool, type Tab } from '../store';

const DOC_LIMIT = 400_000; // characters of the file read in one go (about 100k tokens)

/** The tools an editor offers from its hooks (reading, inserting, replacing, commenting, looking), plus its own. */
export function toolsFor(hooks: AiHooks | undefined): AssistantTool[] {
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
      description: `Insert text at the cursor in the ${hooks.noun} (after the selection, if any). ${hooks.noun === 'document' ? 'Markdown formatting (headings, lists, bold, tables) is turned into real formatting.' : ''} ${hooks.noun === 'spreadsheet' ? 'A formula starting with = goes into the selected cell; tab-separated rows fill cells downward from it.' : ''}`.trim(),
      input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      run: ({ text }) => {
        if (!tracked(() => hooks.insertText!(text))) throw new Error('The editor couldn’t insert there. Click where it should go first.');
        return 'Inserted.';
      }
    });
  if (hooks.replaceSelection)
    t.push({
      name: 'replace_selection',
      description: `Replace what is selected in the ${hooks.noun} with new text.`,
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
      description: `Scroll the ${hooks.noun} to a passage and highlight it. \`quote\` is copied from the text.`,
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
      : `See the editor as it looks right now (a screenshot of the ${hooks.noun}'s area): layout, formatting, charts, what's on screen.`,
    input_schema: { type: 'object', properties: {} },
    run: () => 'picture' // handled in runToolHeadless: the result carries the image
  });
  return [...t, ...(hooks.tools || [])];
}

/** What the open file looks like: the editor's own picture (photo, video frame), else a screenshot of its area. */
export async function picture(tabId: string) {
  const own = await editorRegistry.get(tabId)?.ai?.getImage?.().catch(() => null);
  if (own) return own;
  const pane = document.querySelector(`.pane[data-tab="${CSS.escape(tabId)}"]`) as HTMLElement | null;
  if (!pane || pane.hidden) return null;
  const r = pane.getBoundingClientRect();
  const shot = await api.assistant.capture({ x: r.x, y: r.y, width: r.width, height: r.height }).catch(() => null);
  return shot && { ...shot, note: 'A screenshot of the editor as it looks now.' };
}

/** Checks a tool's input against its schema's top level: required fields there, and the right basic types. */
export function invalid(tool: AssistantTool, input: any): string | null {
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

/** One tool call's input in a few words, for a step shown in the panel or the control log. */
export function summary(input: any): string {
  if (!input || typeof input !== 'object') return '';
  return Object.entries(input)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? `“${v.length > 60 ? `${v.slice(0, 60)}…` : v}”` : JSON.stringify(v)?.slice(0, 60)}`)
    .join(', ');
}

export interface ToolOutcome {
  ok: boolean;
  /** A short result (or the error message when !ok). */
  text: string;
  /** Present only for `look`: the picture, as a PNG data URL plus its size. */
  image?: { dataUrl: string; width: number; height: number; note?: string };
}

/**
 * Run one tool against the editor in `tabId` and return a provider-neutral outcome. Shared by the sidebar (which then
 * builds chat items + Anthropic content) and the MCP server (which maps it to MCP content). `isStopped` lets a caller
 * cancel a plan mid-run.
 */
export async function runToolHeadless(tabId: string, tools: AssistantTool[], use: { name: string; input: any }, isStopped?: () => boolean): Promise<ToolOutcome> {
  if (isStopped?.()) return { ok: false, text: 'Stopped before this ran.' };
  const tool = tools.find((t) => t.name === use.name);
  if (!tool) return { ok: false, text: `There's no tool called ${use.name} here.` };
  const bad = invalid(tool, use.input);
  if (bad) return { ok: false, text: `INVALID_INPUT: ${bad}` };
  try {
    if (use.name === 'look') {
      const img = await picture(tabId);
      if (!img) return { ok: false, text: 'The editor couldn’t make a picture right now.' };
      return { ok: true, text: img.note || `${img.width} × ${img.height} px`, image: img };
    }
    const out = String((await tool.run(use.input)) ?? 'Done.');
    return { ok: true, text: out };
  } catch (err: any) {
    return { ok: false, text: String(err?.message || err) };
  }
}

// ---------- Enumerating the open editors (for the control bridge) ----------

export const activeTabId = () => useTabs.getState().activeId;

/** The open tabs, each with whether it currently offers tools (an editor with AiHooks). */
export function listTabs(): { id: string; name: string; kind: Tab['kind']; noun?: string; active: boolean; tools: boolean }[] {
  const { tabs, activeId } = useTabs.getState();
  return tabs.map((t) => {
    const hooks = editorRegistry.get(t.id)?.ai;
    return { id: t.id, name: t.name, kind: t.kind, noun: hooks?.noun, active: t.id === activeId, tools: !!hooks };
  });
}

export const hooksForTab = (tabId: string) => editorRegistry.get(tabId)?.ai;
export const toolsForTab = (tabId: string) => toolsFor(editorRegistry.get(tabId)?.ai);
