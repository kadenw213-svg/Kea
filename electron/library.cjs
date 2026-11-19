// The school library, in its own Kea window: sign in with the school's account, search, and bring sources back to the
// paper. It is a separate signed-in session (never the class site's), https only, and asks for no device permissions.
// The address is the student's own (Settings → Scholar → School library).
const { BrowserWindow, ipcMain, session, shell, Menu } = require('electron');
const { handleApp } = require('./ipcGuard.cjs');
const settings = require('./settings.cjs');

const PARTITION = 'persist:school-library';
let win = null;

/** The library address from Settings, made into an https address; null when it isn't one. */
function address() {
  let u = String(settings.get('library.url', '') || '').trim();
  if (!u) return null;
  if (!/^[a-z]+:\/\//i.test(u)) u = `https://${u}`;
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && url.hostname.includes('.') ? url.href : null;
  } catch {
    return null;
  }
}

function open() {
  const url = address();
  if (!url) throw new Error('Add your school library’s web address first: Settings → Scholar → School library.');
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    return { ok: true };
  }
  const ses = session.fromPartition(PARTITION);
  // A library page asks for nothing from the computer (camera, location, notifications...).
  ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
  win = new BrowserWindow({ width: 1100, height: 820, title: 'Kea: school library', webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const wc = win.webContents;
  // Links stay in this window; anything that isn't https (or a file, a protocol handler) goes nowhere.
  wc.setWindowOpenHandler(({ url: to }) => {
    if (/^https:\/\//i.test(to)) wc.loadURL(to).catch(() => {});
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, to) => {
    if (!/^https:\/\//i.test(to)) e.preventDefault();
  });
  const nav = wc.navigationHistory;
  win.setMenu(
    Menu.buildFromTemplate([
      { label: '← Back', accelerator: 'Alt+Left', click: () => nav.canGoBack() && nav.goBack() },
      { label: 'Forward →', accelerator: 'Alt+Right', click: () => nav.canGoForward() && nav.goForward() },
      { label: 'Reload', accelerator: 'F5', click: () => wc.reload() },
      { label: 'Library home', click: () => wc.loadURL(address() || url).catch(() => {}) },
      { label: 'Open in your browser', click: () => /^https:\/\//i.test(wc.getURL()) && shell.openExternal(wc.getURL()) }
    ])
  );
  require('./windowAgent.cjs').track(win, 'school library');
  win.on('closed', () => (win = null));
  wc.loadURL(url).catch(() => {});
  return { ok: true };
}

function register() {
  handleApp(ipcMain, 'library:open', () => open());
  handleApp(ipcMain, 'library:has', () => !!address());
}

module.exports = { register, address };
