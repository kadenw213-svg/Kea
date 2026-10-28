// Talks to a Kea org server (the Work area: schedule, time clock, timecards, pay runs).
// All network traffic stays in the main process so the window's content security policy stays
// strict. The sign-in token is encrypted with the OS keychain (safeStorage) and never handed to
// the window. Only /v1/ paths on the configured server are reachable through here.
const { app, ipcMain, net, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const settings = require('./settings.cjs');

const DEFAULT_URL = 'http://127.0.0.1:4850';
const METHODS = new Set(['GET', 'POST']);
const tokenFile = () => path.join(app.getPath('userData'), 'work-session.bin');

function serverUrl() {
  const u = String(settings.get('server.url', DEFAULT_URL) || DEFAULT_URL).trim().replace(/\/+$/, '');
  const parsed = new URL(u);
  // Plain http only for this computer; anything else must be https.
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) throw new Error('The server address must start with https:// (http:// is only allowed for this computer).');
  return u;
}

function readSession() {
  try {
    const raw = fs.readFileSync(tokenFile());
    return JSON.parse(safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8'));
  } catch {
    return null;
  }
}

function writeSession(s) {
  if (!s) return fs.rmSync(tokenFile(), { force: true });
  const json = JSON.stringify(s);
  fs.writeFileSync(tokenFile(), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : Buffer.from(json));
}

async function call(method, p, body, { auth = true } = {}) {
  method = String(method || 'GET').toUpperCase();
  if (!METHODS.has(method)) throw new Error('Unsupported request.');
  if (typeof p !== 'string' || !/^\/v1\/[A-Za-z0-9/_\-.?=&%:]*$/.test(p)) throw new Error('Unsupported request.');
  const headers = { accept: 'application/json' };
  const s = auth ? readSession() : null;
  if (s?.token) headers.authorization = `Bearer ${s.token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res;
  try {
    res = await net.fetch(serverUrl() + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    const e = new Error('Can’t reach the work server. Is it running?');
    e.code = 'offline';
    throw e;
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text.slice(0, 200) };
  }
  if (res.status === 401 && auth) writeSession(null);
  // Problems (like a blocked shift) come back as data, so the screen can show them.
  return { ok: res.ok, status: res.status, data };
}

function register() {
  ipcMain.handle('work:call', (_e, { method, path: p, body }) => call(method, p, body));
  ipcMain.handle('work:session', () => {
    const s = readSession();
    return s ? { personId: s.personId, name: s.name, server: (() => { try { return serverUrl(); } catch { return null; } })() } : null;
  });
  ipcMain.handle('work:demoLogin', async (_e, personId) => {
    const r = await call('POST', '/v1/auth/demo-login', { personId: String(personId) }, { auth: false });
    if (!r.ok || !r.data?.token) throw new Error(r.data?.error || 'Sign-in failed.');
    writeSession({ token: r.data.token, personId: r.data.person?.id, name: r.data.person?.name });
    return { personId: r.data.person?.id, name: r.data.person?.name };
  });
  ipcMain.handle('work:signOut', () => (writeSession(null), true));
}

module.exports = { register };
