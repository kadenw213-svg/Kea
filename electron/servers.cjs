// KeaS servers in Kea (serversCore.cjs does the work): the joined servers for the account signed in here, their
// passes and sessions kept sealed with safeStorage, a daily pass renewal in the background while online, and the
// page's calls (list, join, sign in again, remove).
const { app, ipcMain, net, safeStorage, BrowserWindow } = require('electron');
const path = require('path');
const core = require('./serversCore.cjs');
const { timedFetch } = require('./accountCore.cjs');
const { handleApp } = require('./ipcGuard.cjs');

const hub = () => require('./hub.cjs');
const sealOk = () => {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
};

let S = null;
function store() {
  if (S) return S;
  const dir = app.getPath('userData');
  S = core.createServers({
    file: path.join(dir, 'keas-servers.json'),
    secretsFile: path.join(dir, 'keas-secrets.bin'),
    seal: (s) => (sealOk() ? safeStorage.encryptString(s) : Buffer.from(s)),
    unseal: (b) => (sealOk() ? safeStorage.decryptString(b) : b.toString('utf8')),
    fetchFn: (...a) => net.fetch(...a),
    timedFetch,
    // (The Kea account on this computer: each one has its own servers.)
    account: { key: () => hub().current()?.id ?? null, req: (m, p, b) => hub().req(m, p, b) },
    onChange: () => {
      for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('servers:changed');
    },
    client: `Kea/${app.getVersion()}`,
    versions: require('./updateHealth.cjs').health(),
  });
  return S;
}

const list = () => {
  try {
    return store().list();
  } catch {
    return [];
  }
};
const req = (id, method, p, body) => store().req(id, method, p, body);

const wrap = (fn) => async (_e, arg) => {
  try {
    return { ok: true, value: await fn(arg || {}) };
  } catch (e) {
    return { ok: false, error: String(e.message || e), status: e.status ?? null, data: e.data ?? null };
  }
};

let timer = null;
function register() {
  handleApp(ipcMain, 'servers:list', wrap(() => list()));
  handleApp(ipcMain, 'servers:join', wrap(({ link, address, code }) => store().join(link != null ? String(link) : { address, code })));
  handleApp(ipcMain, 'servers:again', wrap(({ serverId }) => store().again(String(serverId))));
  handleApp(ipcMain, 'servers:remove', wrap(({ serverId }) => (store().remove(String(serverId)), list())));
  handleApp(ipcMain, 'servers:parse', wrap(({ text }) => core.parseJoin(String(text ?? ''))));
  if (process.env.KEA_WORKER_JOB) return;
  // Passes renewed once a day (checked every hour, and soon after Kea starts). Offline: nothing happens, and the
  // current pass and sessions keep working.
  const tick = () => store().renew().catch(() => {});
  setTimeout(tick, 30_000);
  timer = setInterval(tick, 3600_000);
}

module.exports = { register, list, req, store, stop: () => clearInterval(timer) };
