// A stand-in for Electron's main-process API, so Kea's main-process modules load under plain Node in tests. Every
// unknown property is a harmless no-op; tests replace what they need (app.getPath, Notification, ...).
const os = require('os');

const deep = () => new Proxy(function () {}, { get: (t, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => '' : deep()), apply: () => deep(), construct: () => deep() });
const shown = [];
class Notification {
  constructor(opts) {
    this.opts = opts;
  }
  static isSupported() {
    return true;
  }
  show() {
    shown.push(this.opts);
  }
  close() {}
}
const paths = { userData: os.tmpdir(), appData: os.tmpdir() };
const stub = {
  app: { getPath: (k) => paths[k] || os.tmpdir(), getVersion: () => '0.0.0', getAppPath: () => process.cwd(), isPackaged: false, on() {}, exit() {}, whenReady: () => Promise.resolve() },
  ipcMain: { on() {}, handle() {} },
  BrowserWindow: { getAllWindows: () => [] },
  Notification,
  session: deep(),
  net: { fetch: (...a) => fetch(...a) },
  shell: deep(),
  safeStorage: { isEncryptionAvailable: () => false },
  webContents: deep(),
  _shown: shown,
  _paths: paths
};
const id = require.resolve('electron');
require.cache[id] = { id, filename: id, loaded: true, exports: stub };
module.exports = stub;
