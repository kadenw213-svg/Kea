// Kea's app-level MCP control server: a local, opt-in HTTP endpoint (127.0.0.1) that lets an outside app — the user's
// own Claude-skills app, Claude Code/Desktop, an OpenAI agent — drive Kea's open editors over MCP. It runs in the main
// process; the tools and state live in the renderer, reached over a correlation-id IPC round-trip (built on the
// browser.cjs fillLogin idiom). Off by default; each connected app gets its own bearer token, stored encrypted.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { app, ipcMain, safeStorage } = require('electron');
const jsonrpc = require('./jsonrpc.cjs');

const PREFERRED_PORT = 4849; // a stable port so saved client configs keep working; falls back to ephemeral if taken.
const CALL_TIMEOUT = 60_000;

let getWindow = () => null;
let server = null;
let url = null;
let state = { enabled: false, clients: [] }; // clients: { id, name, token, createdAt, lastUsed }
const pending = new Map(); // callId -> { resolve, reject, timer }

const stateFile = () => path.join(app.getPath('userData'), 'control-clients.bin');
const endpointFile = () => path.join(app.getPath('userData'), 'mcp-endpoint.json');

function loadState() {
  try {
    const raw = fs.readFileSync(stateFile());
    state = JSON.parse(safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8'));
  } catch {
    state = { enabled: false, clients: [] };
  }
  if (!Array.isArray(state.clients)) state.clients = [];
}
function saveState() {
  const json = JSON.stringify(state);
  fs.writeFileSync(stateFile(), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : Buffer.from(json, 'utf8'));
}

// ---------- The renderer round-trip (run a tool / read a resource over there) ----------
function invokeRenderer(kind, payload) {
  return new Promise((resolve, reject) => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return reject(new Error('Kea has no open window to act on.'));
    const callId = crypto.randomUUID();
    const timer = setTimeout(() => {
      pending.delete(callId);
      reject(new Error('Kea didn’t answer in time (is a file open?).'));
    }, CALL_TIMEOUT);
    pending.set(callId, { resolve, reject, timer, sender: win.webContents });
    win.webContents.send('kea-control:req', { callId, kind, ...payload });
  });
}

// ---------- Activity → the "controlling Kea" chip ----------
let busyTimer = null;
function activity(clientName, kind, name, ok) {
  const win = getWindow();
  if (!win || win.isDestroyed()) return;
  clearTimeout(busyTimer);
  win.webContents.send('control:activity', { client: clientName, kind, name, ok, active: true });
  busyTimer = setTimeout(() => {
    if (win && !win.isDestroyed()) win.webContents.send('control:activity', { client: clientName, kind, name, ok, active: false });
  }, 1500);
}

// ---------- HTTP transport ----------
function clientForToken(auth) {
  const m = /^Bearer\s+(.+)$/.exec(auth || '');
  if (!m) return null;
  return state.clients.find((c) => c.token === m[1]) || null;
}

function httpHandler(req, res) {
  if (req.method !== 'POST') return res.writeHead(405).end();
  const client = clientForToken(req.headers.authorization);
  if (!client) return res.writeHead(401).end();
  let body = '';
  let tooBig = false;
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 4_000_000) {
      tooBig = true;
      req.destroy();
    }
  });
  req.on('end', async () => {
    if (tooBig) return;
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      return res.writeHead(400).end();
    }
    client.lastUsed = new Date().toISOString();
    saveState();
    const ctx = {
      renderer: async (kind, payload) => {
        const out = await invokeRenderer(kind, payload);
        if (kind === 'tools_call') activity(client.name, 'tools/call', payload && payload.name, out && out.ok);
        return out;
      }
    };
    const batch = Array.isArray(msg);
    const answers = (await Promise.all((batch ? msg : [msg]).map((m) => jsonrpc.handle(m, ctx)))).filter(Boolean);
    if (!answers.length) return res.writeHead(202).end();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(batch ? answers : answers[0]));
  });
}

function startServer() {
  return new Promise((resolve) => {
    if (server) return resolve(url);
    const srv = http.createServer(httpHandler);
    const onListening = () => {
      server = srv;
      url = `http://127.0.0.1:${srv.address().port}/mcp`;
      try {
        fs.writeFileSync(endpointFile(), JSON.stringify({ url }, null, 1));
      } catch {}
      resolve(url);
    };
    srv.once('error', (e) => {
      if (e.code === 'EADDRINUSE') srv.listen(0, '127.0.0.1', onListening);
      else resolve(null);
    });
    srv.listen(PREFERRED_PORT, '127.0.0.1', onListening);
  });
}
function stopServer() {
  if (server) server.close();
  server = null;
  url = null;
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new Error('Kea’s control server stopped.'));
  }
  pending.clear();
  try {
    fs.rmSync(endpointFile(), { force: true });
  } catch {}
}

/** The ready-to-paste MCP config for a client with this token. */
const configFor = (token) => JSON.stringify({ mcpServers: { kea: { type: 'http', url: url || `http://127.0.0.1:${PREFERRED_PORT}/mcp`, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);

/** Mint and persist a new connected-app token; returns what the UI shows (and the raw token for tests). */
function mintClient(name) {
  const client = { id: crypto.randomUUID(), name: String(name || 'App').slice(0, 60), token: crypto.randomBytes(24).toString('hex'), createdAt: new Date().toISOString(), lastUsed: null };
  state.clients.push(client);
  state.enabled = true;
  saveState();
  return { id: client.id, name: client.name, token: client.token, config: configFor(client.token) };
}

function register(opts) {
  getWindow = (opts && opts.getWindow) || (() => null);
  loadState();

  // The single renderer reply listener (one per response, matched by call id + sender).
  ipcMain.on('kea-control:res', (e, msg) => {
    const p = pending.get(msg && msg.callId);
    if (!p || e.sender !== p.sender) return;
    pending.delete(msg.callId);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error || 'The editor reported an error.'));
  });

  ipcMain.handle('control:status', () => ({
    enabled: state.enabled,
    url: server ? url : null,
    clients: state.clients.map((c) => ({ id: c.id, name: c.name, createdAt: c.createdAt, lastUsed: c.lastUsed }))
  }));
  ipcMain.handle('control:set-enabled', async (_e, on) => {
    state.enabled = !!on;
    saveState();
    if (state.enabled) await startServer();
    else stopServer();
    return { enabled: state.enabled, url: server ? url : null };
  });
  ipcMain.handle('control:add-client', async (_e, name) => {
    if (!server) await startServer();
    return mintClient(name);
  });
  ipcMain.handle('control:revoke-client', (_e, id) => {
    state.clients = state.clients.filter((c) => c.id !== id);
    saveState();
    return true;
  });

  // Test only (env-gated, like KEA_CAPTURE/KEA_DRY_RUN): auto-enable with a fixed token so a harness can connect
  // without the Settings UI. Never set in production.
  if (process.env.KEA_CONTROL_TEST) {
    startServer().then(() => {
      state.clients.push({ id: 'test', name: 'Test', token: process.env.KEA_CONTROL_TEST, createdAt: new Date().toISOString(), lastUsed: null });
      state.enabled = true;
    });
  } else if (state.enabled) startServer();
  app.on('before-quit', stopServer);
}

module.exports = { register, stop: stopServer, _test: { startServer, stopServer, mintClient, url: () => url } };
