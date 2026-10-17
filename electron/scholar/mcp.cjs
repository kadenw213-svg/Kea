// The Kea Connector: the tools Claude Code uses during a class scan, served by Kea itself as a small MCP server
// (Streamable HTTP, JSON responses) on this computer only, with a fresh secret token for every run.
// Tools: read pages and files of the class site through Kea's own browser, and report progress and news to Kea.
const http = require('http');
const crypto = require('crypto');
const browser = require('./browser.cjs');

const PROTOCOL = '2025-06-18';

const TOOLS = [
  {
    name: 'd2l_open',
    description:
      "Open a page of the class site (D2L/Brightspace) in Kea's browser and read it: title, final address, visible text (including Brightspace's components and content frames) and its links. Kea handles signing in. Long pages come in parts: call again with the offset it gives.",
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'Full https address on the class site. Omit for the class site home.' }, offset: { type: 'integer', minimum: 0 } } }
  },
  {
    name: 'd2l_fetch',
    description:
      "GET an address with the class site's signed-in session and return the response text (for D2L's REST API under /d2l/api/..., JSON, HTML or text files). JSON comes trimmed: rich text as plain text with links as [text](address), relative links made absolute, and empty or false fields left out. Long answers come in parts: call again with the offset it gives.",
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, offset: { type: 'integer', minimum: 0 } }, required: ['url'] }
  },
  {
    name: 'd2l_download',
    description: "Save a file from the class site (a syllabus PDF, a handout, a .docx) into this workspace, under data/downloads/. 'path' is relative to data/downloads, e.g. 'BIO1112/syllabus.pdf'. Returns where it was saved; for a PDF or .docx also the path of its extracted text (read that, never the PDF) and images of any pages that have no text.",
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, path: { type: 'string' } }, required: ['url', 'path'] }
  },
  {
    name: 'd2l_status',
    description: 'Whether a class site is set up in Kea and whether Kea is signed in to it right now.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'kea_progress',
    description: 'Tell the user, in one short plain sentence, what the scan is doing now (shown quietly in Kea), e.g. "Reading BIO1112\'s Week 9 module".',
    inputSchema: { type: 'object', properties: { message: { type: 'string', maxLength: 200 }, percent: { type: 'number', minimum: 0, maximum: 100, description: 'Roughly how far through the whole task you are (fills the progress bar), e.g. 40 after 2 of 5 modules.' } }, required: ['message'] }
  },
  {
    name: 'kea_notify',
    description:
      "Send the student ONE message about ONE thing, shown in Kea's Inbox (colored by kind) and as a notification. Never a daily summary or a list of unrelated things: send one message per thing. Announcements, D2L grades, D2L feedback and D2L messages reach the Inbox from Kea itself, so never send those. 'course' is the course code. Keep 'body' short plain text with no addresses in it: put each link in 'links' (shown as buttons).",
    inputSchema: {
      type: 'object',
      properties: {
        course: { type: 'string' },
        kind: { type: 'string', enum: ['needs_you', 'attention', 'missed', 'grade', 'feedback', 'message', 'update'], description: "needs_you: something only the student can do or decide. attention: a warning (a zero, a major test under 60%, a steep drop), once. missed: work past due and not handed in (say whether it's still open). grade/feedback: only from outside platforms (e.g. ALEKS) that D2L doesn't show. message/update: anything else worth knowing." },
        title: { type: 'string', maxLength: 120, description: 'What happened, e.g. "Exam 2 graded: 56%" or "Discussion 3 reply missed (still open)".' },
        body: { type: 'string', maxLength: 1500 },
        links: { type: 'array', maxItems: 4, items: { type: 'object', properties: { label: { type: 'string', maxLength: 40, description: 'Button text, e.g. "Open feedback", "Submit", "Open discussion".' }, url: { type: 'string' } }, required: ['label', 'url'] } }
      },
      required: ['title', 'kind']
    }
  }
];

/**
 * Start a server for one run. `hooks.progress(message)` and `hooks.notify({course, title, body})` report to Kea.
 * Resolves to { url, token, close() }.
 */
function start(hooks) {
  const token = crypto.randomBytes(24).toString('hex');
  const call = async (name, a = {}) => {
    switch (name) {
      case 'd2l_open':
        return browser.open(a.url, a.offset || 0);
      case 'd2l_fetch':
        return browser.fetchText(a.url, a.offset || 0);
      case 'd2l_download': {
        const saved = await browser.download(a.url, a.path);
        // PDFs and Word files come with their text, so the file itself never has to be read as page pictures.
        if (/\.(pdf|docx)$/i.test(saved.saved) && hooks.docText) {
          try {
            const t = await hooks.docText(saved.saved);
            if (t) {
              saved.text_file = t.text_file;
              saved.pages = t.pages;
              saved.chars = t.chars;
              saved.read = `Read ${t.text_file} for this file's text (PDFs can't be read directly).`;
              if (t.pages_without_text?.length) saved.pages_without_text = t.pages_without_text;
            }
          } catch {}
        }
        return saved;
      }
      case 'd2l_status':
        return browser.status();
      case 'kea_progress':
        hooks.progress?.(String(a.message || '').slice(0, 200), Number(a.percent));
        return { ok: true };
      case 'kea_notify':
        hooks.notify?.({
          course: a.course || '',
          kind: ['needs_you', 'attention', 'missed', 'grade', 'feedback', 'message', 'update'].includes(a.kind) ? a.kind : 'update',
          title: String(a.title || '').slice(0, 120),
          body: String(a.body || '').slice(0, 1500),
          links: (Array.isArray(a.links) ? a.links : []).filter((l) => l && /^https?:\/\//i.test(l.url)).slice(0, 4).map((l) => ({ label: String(l.label || 'Open').slice(0, 40), url: String(l.url) }))
        });
        return { ok: true };
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  };

  const handle = async (msg) => {
    const { id, method, params } = msg || {};
    if (id === undefined || id === null) return null; // a notification: nothing to answer
    const ok = (result) => ({ jsonrpc: '2.0', id, result });
    try {
      if (method === 'initialize') return ok({ protocolVersion: params?.protocolVersion || PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'kea', version: '1.0.0' } });
      if (method === 'ping') return ok({});
      if (method === 'tools/list') return ok({ tools: TOOLS });
      if (method === 'tools/call') {
        try {
          const out = await call(params?.name, params?.arguments || {});
          return ok({ content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 1) }] });
        } catch (err) {
          return ok({ content: [{ type: 'text', text: String(err?.message || err) }], isError: true });
        }
      }
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
    } catch (err) {
      return { jsonrpc: '2.0', id, error: { code: -32603, message: String(err?.message || err) } };
    }
  };

  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) return res.writeHead(401).end();
    if (req.method !== 'POST') return res.writeHead(405, { Allow: 'POST' }).end();
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 4e6) req.destroy();
    });
    req.on('end', async () => {
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        return res.writeHead(400).end();
      }
      const batch = Array.isArray(msg);
      const answers = (await Promise.all((batch ? msg : [msg]).map(handle))).filter(Boolean);
      if (!answers.length) return res.writeHead(202).end();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(batch ? answers : answers[0]));
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}/mcp`, token, close: () => server.close() });
    });
  });
}

module.exports = { start, TOOLS };
