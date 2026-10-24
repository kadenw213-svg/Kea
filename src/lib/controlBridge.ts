// The renderer half of the MCP control platform. The server lives in the main process (electron/mcp), but the editor
// tools and state live here, so the server forwards every tools/call and resources/read to this bridge over one call
// id, and we answer with the exact same machinery the Claude sidebar uses (src/lib/editorTools.ts). A connected
// outside app therefore drives the identical tools — no second code path, no feature-specific buttons.
import { api } from './api';
import { useTabs, editorRegistry } from '../store';
import { listTabs, toolsFor, runToolHeadless, picture, hooksForTab, activeTabId } from './editorTools';
import { openPaths } from './open';
import { jobStatus, cancelJob } from './jobs';

const DOC_LIMIT = 400_000;

/** Tools that act on the workspace itself (pick/open a file), on top of the active editor's own tools. */
const GLOBAL_TOOLS = [
  { name: 'kea_list_tabs', description: 'List the files open in Kea: each with its id, name, kind, whether it offers tools, and which one is active. Also readable, with no turn cost, as the resource kea://workspace/tabs.', input_schema: { type: 'object', properties: {} } },
  { name: 'kea_focus_tab', description: 'Make a tab the active editor, so the editor tools (and the look picture) act on it. Pass the id from kea_list_tabs.', input_schema: { type: 'object', properties: { tab: { type: 'string' } }, required: ['tab'] } },
  { name: 'kea_open_file', description: 'Open a file from disk in Kea (absolute path) and make it the active editor. The file opens in the right editor for its type.', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  {
    name: 'kea_batch',
    description: 'Run several tool calls in order as one request — e.g. to apply an edit plan. Stops at the first failure and reports each step. Each call is {name, input}. (Each call is still its own undo step.)',
    input_schema: { type: 'object', properties: { calls: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, input: { type: 'object' } }, required: ['name'] } } }, required: ['calls'] }
  },
  {
    name: 'kea_jobs_status',
    description: 'Check long-running work started by a tool (indexing a clip, exporting a video). With a jobId, returns that job; otherwise lists recent jobs. Each has status (running/done/error/canceled), progress 0–1, a note, and — when done — a small result. Poll until done.',
    input_schema: { type: 'object', properties: { jobId: { type: 'string' } } }
  },
  { name: 'kea_jobs_cancel', description: 'Cancel a running job.', input_schema: { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'] } }
];

const stripRun = (t: { name: string; description: string; input_schema: any }) => ({ name: t.name, description: t.description, input_schema: t.input_schema });

/** The full text of a tab's document (sections joined), truncated like read_document. */
async function documentText(tabId: string): Promise<string> {
  const hooks = hooksForTab(tabId);
  if (!hooks) throw new Error('That view has no readable document.');
  const d = await hooks.getDocument();
  const text = d.sections.length > 1 ? d.sections.map((s) => `### ${s.label}\n${s.text}`).join('\n\n') : d.full;
  return text.length > DOC_LIMIT ? `${text.slice(0, DOC_LIMIT)}\n\n[cut off: ${text.length - DOC_LIMIT} more characters]` : text;
}

/** The MCP resources currently available, built from the open tabs (generic ones plus each editor's own). */
function resourceList() {
  const resources: { uri: string; name: string; mimeType: string; description?: string }[] = [{ uri: 'kea://workspace/tabs', name: 'Open tabs', mimeType: 'application/json', description: 'The files open in Kea right now.' }];
  for (const t of listTabs()) {
    if (!t.tools) continue;
    resources.push({ uri: `kea://tab/${t.id}/document`, name: `${t.name} (text)`, mimeType: 'text/plain', description: `The ${t.noun || 'file'} "${t.name}" as text.` });
    resources.push({ uri: `kea://tab/${t.id}/image`, name: `${t.name} (picture)`, mimeType: 'image/png', description: `What "${t.name}" looks like right now.` });
    // Resources the editor contributes itself (e.g. a video's transcript, scene index, project JSON).
    try {
      for (const r of hooksForTab(t.id)?.resources?.() || []) resources.push(r);
    } catch {
      /* an editor still loading its resources isn't fatal */
    }
  }
  return {
    resources,
    templates: [
      { uriTemplate: 'kea://tab/{tabId}/document', name: 'Tab document (text)', mimeType: 'text/plain' },
      { uriTemplate: 'kea://tab/{tabId}/image', name: 'Tab picture', mimeType: 'image/png' }
    ]
  };
}

async function readResource(uri: string): Promise<{ text?: string; blob?: string; mimeType: string }> {
  if (uri === 'kea://workspace/tabs') return { text: JSON.stringify(listTabs(), null, 1), mimeType: 'application/json' };
  const m = /^kea:\/\/tab\/([^/]+)\/(document|image)$/.exec(uri);
  if (m) {
    const [, tabId, what] = m;
    if (!useTabs.getState().tabs.some((t) => t.id === tabId)) throw new Error('That tab is not open.');
    if (what === 'document') return { text: await documentText(tabId), mimeType: 'text/plain' };
    const img = await picture(tabId);
    if (!img) throw new Error('That tab can’t produce a picture right now.');
    return { blob: img.dataUrl.split(',')[1], mimeType: 'image/png' };
  }
  // Otherwise ask each editor whether this is one of its own resources.
  for (const t of useTabs.getState().tabs) {
    const got = await hooksForTab(t.id)?.readResource?.(uri);
    if (got) return got;
  }
  throw new Error(`Unknown resource "${uri}".`);
}

/** Run a workspace-level global tool, or the active editor's tool (or, for a Claude-tab run, its own tab's). */
async function callTool(name: string, input: any, pinned?: string): Promise<{ ok: boolean; text: string; image?: { dataUrl: string } }> {
  if (pinned) {
    const hooks = editorRegistry.get(pinned)?.ai;
    if (!hooks) return { ok: false, text: 'That file was closed.' };
    return runToolHeadless(pinned, toolsFor(hooks), { name, input });
  }
  if (name === 'kea_list_tabs') return { ok: true, text: JSON.stringify(listTabs(), null, 1) };
  if (name === 'kea_focus_tab') {
    const tab = useTabs.getState().tabs.find((t) => t.id === input?.tab);
    if (!tab) return { ok: false, text: 'No tab with that id. Call kea_list_tabs for the ids.' };
    useTabs.getState().setActive(tab.id);
    return { ok: true, text: `Focused "${tab.name}".` };
  }
  if (name === 'kea_open_file') {
    if (!input?.path) return { ok: false, text: 'Give a file path.' };
    try {
      await openPaths([String(input.path)]);
      return { ok: true, text: `Opened "${String(input.path)}".` };
    } catch (err: any) {
      return { ok: false, text: `Couldn’t open it: ${err?.message || err}` };
    }
  }
  if (name === 'kea_jobs_status') return { ok: true, text: JSON.stringify(jobStatus(input?.jobId), null, 1) };
  if (name === 'kea_jobs_cancel') {
    const done = cancelJob(String(input?.jobId || ''));
    return { ok: done, text: done ? 'Canceled.' : 'No running job with that id.' };
  }
  if (name === 'kea_batch') {
    const calls = Array.isArray(input?.calls) ? input.calls : [];
    const lines: string[] = [];
    for (let i = 0; i < calls.length; i++) {
      const c = calls[i] || {};
      if (c.name === 'kea_batch') return { ok: false, text: `Step ${i + 1}: a batch can’t contain another batch.` };
      const r = await callTool(c.name, c.input || {});
      lines.push(`${i + 1}. ${c.name}: ${r.ok ? 'ok' : 'FAILED'} — ${r.text}`);
      if (!r.ok) return { ok: false, text: lines.join('\n') };
    }
    return { ok: true, text: lines.join('\n') || 'Nothing to do.' };
  }
  const tabId = activeTabId();
  const hooks = editorRegistry.get(tabId)?.ai;
  if (!hooks) return { ok: false, text: 'No editor is active (open or focus a file first). kea_list_tabs shows what’s open.' };
  return runToolHeadless(tabId, toolsFor(hooks), { name, input });
}

let started = false;
/** Wire the renderer to the main-process control server. Call once at app start. */
export function startControlBridge() {
  if (started) return;
  started = true;
  api.control.onRequest(async (req) => {
    const done = (result: any) => api.control.respond(req.callId, { ok: true, result });
    const fail = (error: string) => api.control.respond(req.callId, { ok: false, error });
    try {
      switch (req.kind) {
        case 'tools_list': {
          // A Claude-tab run sees only its own file's tools; outside apps also get the workspace tools.
          const tools = req.tabId ? toolsFor(editorRegistry.get(req.tabId)?.ai).map(stripRun) : [...GLOBAL_TOOLS, ...toolsFor(editorRegistry.get(activeTabId())?.ai).map(stripRun)];
          return done({ tools });
        }
        case 'tools_call':
          return done(await callTool(req.name, req.input || {}, req.tabId));
        case 'list_tabs':
          return done({ tabs: listTabs() });
        case 'resources_list':
          return done(resourceList());
        case 'resource_read':
          return done(await readResource(req.uri));
        default:
          return fail(`Unknown control request "${req.kind}".`);
      }
    } catch (err: any) {
      fail(String(err?.message || err));
    }
  });
}
