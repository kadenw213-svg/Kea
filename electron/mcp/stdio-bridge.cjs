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
  maybeExit();
});
