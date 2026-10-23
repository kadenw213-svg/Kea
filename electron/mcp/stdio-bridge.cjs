#!/usr/bin/env node
// Bridges a stdio MCP client (Claude Desktop, the OpenAI Agents SDK — anything that spawns a process and speaks
// newline-delimited JSON-RPC on stdin/stdout) to Kea's local HTTP control server. Kea must be running with "Connect
// an app" on. Config comes from the environment Kea generates for you:
//   KEA_MCP_TOKEN    the connection's bearer token (required)
//   KEA_MCP_ENDPOINT path to Kea's mcp-endpoint.json (preferred — survives a port change), or
//   KEA_MCP_URL      the full http://127.0.0.1:<port>/mcp URL
const http = require('http');
const fs = require('fs');

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const TOKEN = process.env.KEA_MCP_TOKEN || arg('--token') || '';

function currentUrl() {
  if (process.env.KEA_MCP_URL) return process.env.KEA_MCP_URL;
  const ep = process.env.KEA_MCP_ENDPOINT || arg('--endpoint');
  if (ep) {
    try {
      return JSON.parse(fs.readFileSync(ep, 'utf8')).url;
    } catch {
      /* fall through */
    }
  }
  return 'http://127.0.0.1:4849/mcp';
}

function forward(message) {
  return new Promise((resolve) => {
    const url = currentUrl();
    let u;
    try {
      u = new URL(url);
    } catch {
      return resolve(rpcError(message, 'Kea’s address is not known. Is Kea running with Connect an app turned on?'));
    }
    const data = JSON.stringify(message);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Authorization: `Bearer ${TOKEN}` } },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => {
          if (res.statusCode === 401) return resolve(rpcError(message, 'Kea rejected the key. Re-add this connection in Kea → Settings → Connect an app.'));
          resolve(b ? safeParse(b) : null); // 202 (notification) -> no reply
        });
      }
    );
    req.on('error', () => resolve(rpcError(message, 'Couldn’t reach Kea. Make sure Kea is open and Connect an app is on.')));
    req.end(data);
  });
}
const safeParse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};
/** A JSON-RPC error reply for a request (null for a notification, which gets no reply). */
const rpcError = (message, text) => (message && message.id !== undefined && message.id !== null ? { jsonrpc: '2.0', id: message.id, error: { code: -32011, message: text } } : null);

// Read newline-delimited JSON-RPC from stdin; forward each message; write each reply (if any) as one line.
// Don't exit on stdin end until in-flight requests have been answered, or their replies would be lost.
let buf = '';
let inflight = 0;
let ended = false;
const maybeExit = () => {
  if (ended && inflight === 0) process.exit(0);
};
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = safeParse(line);
    if (!msg) continue;
    if (msg.method === 'notifications/initialized') watchLists();
    inflight++;
    forward(msg)
      .then((reply) => {
        if (reply) process.stdout.write(JSON.stringify(reply) + '\n');
      })
      .finally(() => {
        inflight--;
        maybeExit();
      });
  }
});
process.stdin.on('end', () => {
  ended = true;
  clearInterval(watcher);
  maybeExit();
});

// Kea's tools and resources follow the active tab (a document's tools, the video editor's…). Its HTTP server only
// answers requests, so the bridge checks the lists every two seconds and tells the client when they change
// (the listChanged capability Kea advertises).
let watcher = null;
function watchLists() {
  if (watcher) return;
  const last = {};
  let n = 0;
  const check = async (method, key, note) => {
    const r = await forward({ jsonrpc: '2.0', id: `kea-bridge-${++n}`, method });
    const items = r && r.result && r.result[key];
    if (!Array.isArray(items)) return;
    const sig = items.map((x) => x.name || x.uri).sort().join('\n');
    if (last[key] !== undefined && last[key] !== sig) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: note }) + '\n');
    last[key] = sig;
  };
  let busy = false;
  const tick = async () => {
    if (busy || ended) return;
    busy = true;
    await check('tools/list', 'tools', 'notifications/tools/list_changed').catch(() => {});
    await check('resources/list', 'resources', 'notifications/resources/list_changed').catch(() => {});
    busy = false;
  };
  tick();
  watcher = setInterval(tick, 2000);
}
