// Transport-neutral MCP JSON-RPC core for Kea's control server. One `handle(msg, ctx)` that an HTTP adapter (and later
// a stdio bridge) drives. It exposes the open editors' tools and state; the actual work is done in the renderer, which
// `ctx.renderer(kind, payload)` reaches over IPC (see electron/mcp/server.cjs and src/lib/controlBridge.ts).
// Patterned on electron/scholar/mcp.cjs's dispatcher, kept separate so the scan server stays untouched.
const PROTOCOL = '2025-06-18';
const SERVER_INFO = { name: 'kea', version: '1.0.0' };

// Tools that only read (so a client can auto-allow them). Everything else is treated as a mutation.
const READ_ONLY = new Set(['read_document', 'show_in_document', 'look', 'kea_list_tabs', 'design_guide', 'describe_pages', 'describe_slide', 'read_range', 'measure_picture']);

// Kea's own Claude tab: its connection is pinned to one open file (the system prompt carries the rest).
const INSTRUCTIONS_PINNED = 'These tools act on the one file the student has open in Kea, beside this conversation. Each call is one undo step for them.';

// What a connecting app's model is told about working in Kea (the in-app sidebar gets the same guidance).
const INSTRUCTIONS = `Kea is an office suite; its tools act on the file open in the active tab (kea_list_tabs, kea_focus_tab, kea_open_file to choose). Read before editing (read_document; look to see it). Each tool call is one undo step for the user.
When designing or restyling anything visual (flier, poster, slide, title page, handout, social post, or graphics and edits on a video timeline: read design_guide "video" too), work to a professional standard: read design_guide "start" and the topics the job needs first, commit to one art direction, grid, type scale and palette, make visuals rich with SVG artwork through the image tools' svg input rather than plain shapes, keep text in real text boxes with installed fonts, then look at the result and fix what the checklists flag before finishing. Reference images can be placed with an image tool's path input.
In documents: reviewing against a rubric or guidelines means one comment per flagged passage (add_comments), each with criterion, kind, a short comment and an optional rewrite, never highlights as feedback. Fix layout with format_paragraphs, delete_text, join_paragraphs and clean_up_spacing rather than typing spaces or blank lines, and cite through add_source, cite and insert_bibliography (real sources only).`;

/** Map the renderer's provider-neutral tool outcome ({ ok, text, image? }) to an MCP tools/call result. */
function toolResult(out) {
  const content = [];
  if (out.image?.dataUrl) content.push({ type: 'image', data: out.image.dataUrl.split(',')[1], mimeType: 'image/png' });
  content.push({ type: 'text', text: out.text || (out.ok ? 'Done.' : 'Failed.') });
  return { content, isError: !out.ok };
}

/**
 * Handle one JSON-RPC message. `ctx.renderer(kind, payload)` returns a Promise resolving to the renderer's answer.
 * Returns the JSON-RPC response object, or null for a notification (no id).
 */
async function handle(msg, ctx) {
  const id = msg && msg.id;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const err = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (!msg || typeof msg !== 'object' || id === undefined || id === null) return null; // notification or junk
  try {
    switch (msg.method) {
      case 'initialize':
        return ok({
          protocolVersion: (msg.params && msg.params.protocolVersion) || PROTOCOL,
          capabilities: { tools: { listChanged: true }, resources: { listChanged: true, subscribe: false } },
          serverInfo: SERVER_INFO,
          instructions: ctx.pinned ? INSTRUCTIONS_PINNED : INSTRUCTIONS
        });
      case 'ping':
        return ok({});
      case 'tools/list': {
        const { tools } = await ctx.renderer('tools_list', {});
        // MCP names the schema inputSchema (the editors use the Anthropic API's input_schema); clients drop tools without it.
        return ok({ tools: (tools || []).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema || t.input_schema || { type: 'object', properties: {} }, annotations: { readOnlyHint: READ_ONLY.has(t.name), destructiveHint: !READ_ONLY.has(t.name), openWorldHint: false } })) });
      }
      case 'tools/call': {
        const out = await ctx.renderer('tools_call', { name: msg.params && msg.params.name, input: (msg.params && msg.params.arguments) || {} });
        return ok(toolResult(out));
      }
      case 'resources/list': {
        const { resources } = await ctx.renderer('resources_list', {});
        return ok({ resources: resources || [] });
      }
      case 'resources/templates/list': {
        const { templates } = await ctx.renderer('resources_list', {});
        return ok({ resourceTemplates: templates || [] });
      }
      case 'resources/read': {
        const uri = msg.params && msg.params.uri;
        const r = await ctx.renderer('resource_read', { uri });
        const entry = { uri, mimeType: r.mimeType };
        if (r.text !== undefined) entry.text = r.text;
        if (r.blob !== undefined) entry.blob = r.blob;
        return ok({ contents: [entry] });
      }
      default:
        return err(-32601, `Method not found: ${msg.method}`);
    }
  } catch (e) {
    return err(-32603, String((e && e.message) || e));
  }
}

module.exports = { handle, PROTOCOL, SERVER_INFO };
