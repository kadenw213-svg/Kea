const { app, BrowserWindow, ipcMain, dialog, protocol, net, shell, Menu, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const DIST = path.join(__dirname, '..', 'dist');
const RECENT_FILE = () => path.join(app.getPath('userData'), 'recent.json');
const MAX_RECENT = () => Math.max(0, Number(require('./settings.cjs').get('files.recentMax', 30)) || 0);

let mainWindow = null;
let allowClose = false;
let rendererReady = false;
let pendingOpen = collectFileArgs(process.argv);

// Small rolling log in the user data folder, for diagnosing problems on real machines.
// Errors from Kea's background work (scans, sync, checks) are kept in kea.log too, so a problem can be found later.
for (const level of ['error', 'warn']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    original(...args);
    if (level === 'error' || /fail|error|couldn/i.test(String(args[0]))) log(level, ...args);
  };
}

function log(...parts) {
  try {
    if (require('./settings.cjs').get('privacy.log', true) === false) return;
    const file = path.join(app.getPath('userData'), 'kea.log');
    const line = `[${new Date().toISOString()}] ${parts.map((p) => (p instanceof Error ? p.stack : typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}
`;
    if (fs.existsSync(file) && fs.statSync(file).size > 512 * 1024) fs.renameSync(file, file + '.old');
    fs.appendFileSync(file, line);
  } catch {}
}
process.on('uncaughtException', (err) => log('uncaughtException', err));
process.on('unhandledRejection', (err) => log('unhandledRejection', err));


protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  require('./media.cjs').SCHEME
]);

// Developer aid: KEA_USERDATA runs a separate profile (and lock), so tests don't touch a running copy.
const devUserData = process.env.KEA_USERDATA;
if (devUserData) app.setPath('userData', devUserData);
// Windows knows Kea by this id (its shortcuts carry the same one), for notifications and the taskbar.
if (process.platform === 'win32') app.setAppUserModelId('com.kea.app');
const settings = require('./settings.cjs');

// Smooth, GPU-accelerated scrolling everywhere (both can be turned off in Settings → General → Advanced).
if (settings.get('general.smoothScrolling', true)) app.commandLine.appendSwitch('enable-smooth-scrolling');
if (settings.get('general.hardwareAcceleration', true)) app.commandLine.appendSwitch('enable-gpu-rasterization');
else app.disableHardwareAcceleration();

// Single instance: opening a file from Explorer while the app runs sends it to the existing window.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', (_e, argv) => {
    const files = collectFileArgs(argv);
    log('second-instance', files);
    // If the window was lost (crash, never shown), bring a fresh one up instead of swallowing the request.
    if (!mainWindow || mainWindow.isDestroyed()) {
      pendingOpen.push(...files);
      if (app.isReady()) createWindow();
      return;
    }
    bringToFront(mainWindow);
    sendOpen(files);
  });
}

/**
 * Show the window and really bring it forward: back onto a screen if it was left on one that's gone, and past
 * Windows' focus-stealing guard (a hidden or background app's focus() is often ignored, so clicking Kea seemed to do
 * nothing: 10/19, fifteen clicks in a minute).
 */
function bringToFront(win) {
  try {
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    const { screen } = require('electron');
    const b = win.getBounds();
    const area = screen.getDisplayMatching(b).workArea;
    const onScreen = b.x < area.x + area.width - 80 && b.x + b.width > area.x + 80 && b.y < area.y + area.height - 80 && b.y + 40 > area.y;
    if (!onScreen) win.setBounds({ x: area.x + 40, y: area.y + 40, width: Math.min(b.width, area.width - 80), height: Math.min(b.height, area.height - 80) });
    win.setAlwaysOnTop(true);
    win.focus();
    app.focus({ steal: true });
    setTimeout(() => !win.isDestroyed() && win.setAlwaysOnTop(false), 300);
  } catch (err) {
    log('bringToFront', err);
  }
}

function sendOpen(files) {
  if (!files.length) return;
  if (mainWindow && !mainWindow.isDestroyed() && rendererReady) mainWindow.webContents.send('app:open-paths', files);
  else pendingOpen.push(...files);
}

function collectFileArgs(argv) {
  return argv
    .slice(1)
    .filter((a) => !a.startsWith('-') && a !== '.' && !a.endsWith('.cjs') && !a.toLowerCase().endsWith('electron.exe'))
    .map((a) => path.resolve(a))
    .filter((p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    });
}

/**
 * The window's address was app://slate until 0.45, and what a page keeps in its browser storage (saved signatures, the
 * open Encyclopedia panel) belongs to its address: once, it's copied to app://kea before the app opens there.
 */
async function moveStorage(win) {
  if (settings.get('app.storageMoved', false)) return;
  try {
    // (Kea's address under its earlier name.)
    const before = 'app://slate/__blank';
    await win.loadURL(before);
    const dump = await win.webContents.executeJavaScript('JSON.stringify(Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)])))');
    await win.loadURL('app://kea/__blank');
    await win.webContents.executeJavaScript(`(() => { const d = ${dump}; for (const k of Object.keys(d)) if (localStorage.getItem(k) === null) localStorage.setItem(k, d[k]); })()`);
    settings.set({ 'app.storageMoved': true });
  } catch (err) {
    console.error('Moving browser storage', err);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#131314',
    show: false,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: process.platform === 'win32' ? { color: '#131314', symbolColor: '#c4c7c5', height: 44 } : undefined,
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true
    }
  });

  Menu.setApplicationMenu(null);

  // Show as soon as there is something to paint, and never leave the window hidden.
  rendererReady = false;
  const win = mainWindow;
  const reveal = () => {
    if (!win.isDestroyed() && !win.isVisible()) win.show();
  };
  win.once('ready-to-show', reveal);
  win.webContents.once('did-finish-load', reveal);
  setTimeout(reveal, 3000);
  win.webContents.on('did-fail-load', (_e, code, desc) => log('did-fail-load', code, desc));
  win.webContents.on('render-process-gone', (_e, details) => {
    log('render-process-gone', details);
    rendererReady = false;
    if (!win.isDestroyed() && details.reason !== 'clean-exit') win.reload();
  });

  if (DEV_URL) mainWindow.loadURL(DEV_URL);
  else moveStorage(mainWindow).then(() => mainWindow.loadURL('app://kea/index.html'));

  // Links open in the system browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (DEV_URL && url.startsWith(DEV_URL)) return;
    if (url.startsWith('app://')) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  mainWindow.webContents.on('context-menu', (_e, params) => {
    const items = [];
    if (params.misspelledWord) {
      for (const s of params.dictionarySuggestions.slice(0, 5)) {
        items.push({ label: s, click: () => mainWindow.webContents.replaceMisspelling(s) });
      }
      if (items.length) items.push({ type: 'separator' });
    }
    if (params.isEditable || params.selectionText) {
      items.push(
        { role: 'cut', enabled: params.isEditable },
        { role: 'copy' },
        { role: 'paste', enabled: params.isEditable },
        { role: 'selectAll' }
      );
      Menu.buildFromTemplate(items).popup();
    }
  });

  // Ask the renderer about unsaved work before closing.
  mainWindow.on('close', (e) => {
    if (allowClose) return;
    e.preventDefault();
    mainWindow.webContents.send('app:before-close');
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    rendererReady = false;
    // Kea's hidden class-site window keeps the app alive, so closing the last window decides here: stay in the
    // notification area for class checks, or quit for real.
    if (backgroundWanted()) ensureTray();
    else app.quit();
  });

  // Developer aid: KEA_CAPTURE=path.png captures a screenshot after load, then exits.
  if (process.env.KEA_CAPTURE) {
    // (After the app's own page: not the empty one moveStorage passes through first.)
    const loaded = () => {
      if (mainWindow.webContents.getURL().includes('/__blank')) return;
      mainWindow.webContents.off('did-finish-load', loaded);
      captureNow();
    };
    mainWindow.webContents.on('did-finish-load', loaded);
    const captureNow = () => {
      // Background windows don't run CSS animations, so turn them off for captures.
      mainWindow.webContents.insertCSS('*,*::before,*::after{transition:none!important;animation:none!important}');
      setTimeout(async () => {
        if (process.env.KEA_EVAL) {
          try {
            const out = await mainWindow.webContents.executeJavaScript(fs.readFileSync(process.env.KEA_EVAL, 'utf8'));
            if (out !== undefined) console.log('[eval]', typeof out === 'string' ? out : JSON.stringify(out));
          } catch (err) {
            console.log('[eval error]', err.message);
          }
        }
        const img = await mainWindow.webContents.capturePage();
        fs.writeFileSync(process.env.KEA_CAPTURE, img.toPNG());
        allowClose = true;
        app.quit();
      }, Number(process.env.KEA_CAPTURE_DELAY || 4000));
    };
    // (Newer Electron passes one details object; older ones passed the parts as arguments.)
    mainWindow.webContents.on('console-message', (e, level, message, line, source) => {
      const d = e && typeof e.message === 'string' ? { level: { warning: 2, error: 3 }[e.level] ?? 0, message: e.message, line: e.lineNumber, source: e.sourceId } : { level, message, line, source };
      if (d.level >= 2) console.log(`[renderer] ${d.message} (${d.source}:${d.line})`);
    });
  }
}

// ---------- Running in the background (class checks while the window is closed) ----------
let tray = null;
const startHidden = process.argv.includes('--background');
/** Stay running after the window closes: only when Scholar's checks are on and a class site is set up. */
function backgroundWanted() {
  if (process.env.KEA_CAPTURE || settings.get('scholar.background', true) === false || settings.get('scholar.enabled', true) === false) return false;
  try {
    return !!require('./scholar/browser.cjs').schoolInfo().home;
  } catch {
    return false;
  }
}
function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return createWindow();
  bringToFront(mainWindow);
}
function ensureTray() {
  if (tray && !tray.isDestroyed()) return;
  const { Tray, nativeImage } = require('electron');
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('Kea: checking your classes in the background');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Kea', click: showWindow },
      { type: 'separator' },
      { label: 'Quit Kea', click: () => app.quit() }
    ])
  );
  tray.on('click', showWindow);
}
/** Start quietly when the user signs in to Windows, so the morning check runs even if Kea wasn't opened. */
function applyLoginItem() {
  if (!app.isPackaged) return;
  const on = backgroundWanted();
  try {
    app.setLoginItemSettings({ openAtLogin: on, args: ['--background'] });
  } catch {}
}

app.whenReady().then(() => {
  log('start', app.getVersion(), process.argv.slice(1));
  require('./ai.cjs').register({ log, getWindow: () => mainWindow });
  require('./files.cjs').register({ log, getWindow: () => mainWindow });
  settings.register();
  require('./history.cjs').register({ log });
  require('./google.cjs').register({ log });
  require('./cite.cjs').register({ log });
  require('./wiki.cjs').register();
  require('./assistant.cjs').register();
  require('./assistantPlan.cjs').register({ getWindow: () => mainWindow });
  require('./fonts.cjs').register();
  require('./media.cjs').register();
  require('./mcp/server.cjs').register({ getWindow: () => mainWindow });
  require('./account.cjs').register();
  require('./scholar/index.cjs').register();
  require('./dict.cjs').register();
  // Quizzes were removed in v0.15.0: clear the per-file quiz progress they kept.
  fs.rm(path.join(app.getPath('userData'), 'study'), { recursive: true, force: true }, () => {});
  require('./present.cjs').register({ log, getWindow: () => mainWindow });
  require('./search.cjs').register();
  require('./tts.cjs').register();
  require('./speech.cjs').register({ log, getWindow: () => mainWindow });
  require('./models.cjs').register({ log, getWindow: () => mainWindow });
  require('./engine.cjs').register({ log });
  const applySpell = () => session.defaultSession.setSpellCheckerEnabled(settings.get('general.spellcheck', true) !== false);
  applySpell();
  settings.onChange(applySpell);
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    // An empty page (for moving browser storage between addresses: moveStorage).
    if (rel === '/__blank') return new Response('<!doctype html><title></title>', { headers: { 'Content-Type': 'text/html' } });
    // Downloaded voice-typing models live in the user's data folder, not inside the app.
    // Cross-origin isolation lets WebAssembly use several CPU cores (voice typing, OCR). "credentialless"
    // doesn't block anything Kea loads; every file comes from the app itself.
    const isoHeaders = (res, extra = {}) => {
      const headers = new Headers(res.headers);
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
      headers.set('Cross-Origin-Resource-Policy', 'same-origin');
      for (const [k, v] of Object.entries(extra)) headers.set(k, v);
      return headers;
    };
    const isolated = (res, extra) => new Response(res.body, { status: res.status, headers: isoHeaders(res, extra) });
    if (rel.startsWith('/__speech/')) {
      const p = require('./speech.cjs').resolveServed(rel.slice('/__speech/'.length));
      if (!p || !fs.existsSync(p)) return new Response('Not found', { status: 404 });
      return isolated(await net.fetch(pathToFileURL(p).toString()));
    }
    if (rel.startsWith('/__aimodels/')) {
      const p = require('./models.cjs').resolveServed(rel.slice('/__aimodels/'.length));
      if (!p || !fs.existsSync(p)) return new Response('Not found', { status: 404 });
      return isolated(await net.fetch(pathToFileURL(p).toString()));
    }
    const filePath = path.normalize(path.join(DIST, rel));
    if (!filePath.startsWith(DIST)) return new Response('Forbidden', { status: 403 });
    const res = await net.fetch(pathToFileURL(filePath).toString());
    // WebAssembly (the offline grammar checker) must be served with its proper type.
    if (filePath.endsWith('.wasm')) return isolated(res, { 'Content-Type': 'application/wasm' });
    if (!filePath.endsWith('.html')) return isolated(res);
    // Lock the renderer down: only our own code, no remote content.
    const headers = isoHeaders(res);
    headers.set(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: kea-media:; media-src 'self' data: blob: kea-media:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self' data: blob: kea-media:; object-src 'none'; base-uri 'none'"
    );
    return new Response(res.body, { status: res.status, headers });
  });

  // Started by Windows at sign-in: stay in the notification area until the user opens Kea.
  if (startHidden && backgroundWanted() && !pendingOpen.length) ensureTray();
  else createWindow();
  applyLoginItem();
  settings.onChange(applyLoginItem);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('open-file', (e, filePath) => {
  // macOS: file opened from Finder / dock.
  e.preventDefault();
  sendOpen([filePath]);
});

// Anything that quits the app (updates, shutdown) must not be blocked by the unsaved-work prompt.
app.on('before-quit', () => {
  allowClose = true;
  // Lets the hidden class-site window close too (it normally only hides).
  global.keaQuitting = true;
  // Don't leave a voice talking after Kea closes.
  require('./tts.cjs').stop();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !backgroundWanted()) app.quit();
});

// ---------- Recent files ----------
function readRecent() {
  try {
    const list = JSON.parse(fs.readFileSync(RECENT_FILE(), 'utf8'));
    return Array.isArray(list) ? list.filter((r) => r && typeof r.path === 'string') : [];
  } catch {
    return [];
  }
}
function writeRecent(list) {
  try {
    fs.writeFileSync(RECENT_FILE(), JSON.stringify(list.slice(0, MAX_RECENT()), null, 2));
  } catch {}
}

function readFileEntry(p) {
  const data = fs.readFileSync(p);
  const stat = fs.statSync(p);
  return { path: p, name: path.basename(p), data: new Uint8Array(data), size: stat.size };
}

// ---------- IPC ----------
ipcMain.handle('app:get-pending-open', () => {
  rendererReady = true;
  const files = pendingOpen;
  pendingOpen = [];
  return files;
});

ipcMain.handle('app:platform', () => process.platform);

ipcMain.handle('dialog:open', async (_e, opts = {}) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: opts.title || 'Open',
    properties: ['openFile', ...(opts.multi ? ['multiSelections'] : [])],
    filters: opts.filters
  });
  if (res.canceled) return [];
  // Video and audio are streamed by the video editor from disk (electron/media.cjs), so only their paths are sent.
  const streamed = /\.(mp4|m4v|mov|webm|mkv|mp3|wav|m4a|aac|ogg|oga|opus|flac)$/i;
  return res.filePaths.map((p) => (streamed.test(p) ? { path: p, name: path.basename(p), data: new Uint8Array(), size: fs.statSync(p).size } : readFileEntry(p)));
});

ipcMain.handle('dialog:save', async (_e, opts = {}) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    title: opts.title || 'Save',
    defaultPath:
      opts.defaultPath && !path.isAbsolute(opts.defaultPath)
        ? path.join(settings.get('files.defaultFolder', '') || app.getPath('documents'), opts.defaultPath)
        : opts.defaultPath,
    filters: opts.filters
  });
  return res.canceled ? null : res.filePath;
});

ipcMain.handle('file:read', (_e, p) => readFileEntry(p));

ipcMain.handle('file:write', (_e, p, data) => {
  // Keep the previous contents in version history before replacing them.
  try {
    require('./history.cjs').snapshot(p);
  } catch (err) {
    log('history snapshot failed', err);
  }
  // Write to a temp file first so a crash mid-save never corrupts the original.
  const tmp = p + '.kea-tmp';
  const buf = Buffer.from(data);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(tmp, buf);
  // OneDrive and antivirus scanners can hold files briefly; retry before giving up.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.renameSync(tmp, p);
      return true;
    } catch (err) {
      if (attempt < 4) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
    }
  }
  try {
    fs.writeFileSync(p, buf);
    return true;
  } catch (err) {
    throw new Error(err.code === 'EBUSY' || err.code === 'EPERM' ? 'The file is open in another program. Close it there and try again.' : err.message);
  } finally {
    fs.rm(tmp, { force: true }, () => {});
  }
});

// Renaming a file in place (a .txt turned into .md): never over another file.
ipcMain.handle('file:rename', (_e, from, to) => {
  if (fs.existsSync(to)) throw new Error(`${path.basename(to)} already exists in that folder.`);
  fs.renameSync(from, to);
  return true;
});

ipcMain.handle('file:exists', (_e, p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
});

ipcMain.handle('shell:show-in-folder', (_e, p) => shell.showItemInFolder(p));

ipcMain.handle('recent:get', () => readRecent());
ipcMain.handle('recent:add', (_e, p) => {
  const list = readRecent().filter((r) => r.path !== p);
  list.unshift({ path: p, name: path.basename(p), openedAt: Date.now() });
  writeRecent(list);
  return list;
});
ipcMain.handle('recent:remove', (_e, p) => {
  const list = readRecent().filter((r) => r.path !== p);
  writeRecent(list);
  return list;
});
ipcMain.handle('recent:clear', () => {
  writeRecent([]);
  return [];
});

function withHiddenWindow(html, fn) {
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
    const tmp = path.join(app.getPath('temp'), `kea-print-${Date.now()}.html`);
    fs.writeFileSync(tmp, html, 'utf8');
    win.loadFile(tmp);
    win.webContents.once('did-finish-load', async () => {
      try {
        resolve(await fn(win));
      } catch (err) {
        reject(err);
      } finally {
        setTimeout(() => {
          if (!win.isDestroyed()) win.destroy();
          fs.rm(tmp, () => {});
        }, 500);
      }
    });
  });
}

ipcMain.handle('print:html', (_e, html, opts = {}) =>
  withHiddenWindow(
    html,
    (win) =>
      new Promise((resolve) => {
        // Documents lay out their own pages (with headers and footers), so they print edge to edge.
        win.webContents.print({ silent: false, printBackground: true, ...(opts.noMargins ? { margins: { marginType: 'none' } } : {}) }, (ok) => resolve(ok));
      })
  )
);

ipcMain.handle('export:pdf-from-html', (_e, html, opts = {}) =>
  withHiddenWindow(html, async (win) => {
    const buf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: opts.pageSize || 'Letter',
      preferCSSPageSize: true,
      ...(opts.noMargins ? { margins: { top: 0, bottom: 0, left: 0, right: 0 } } : {})
    });
    return new Uint8Array(buf);
  })
);

ipcMain.on('app:confirm-close', () => {
  allowClose = true;
  if (mainWindow) mainWindow.close();
});

ipcMain.on('app:set-title-overlay', (_e, color, symbolColor) => {
  if (mainWindow && process.platform === 'win32') {
    try {
      mainWindow.setTitleBarOverlay({ color, symbolColor, height: 44 });
    } catch {}
  }
});

// ---------- Updates (GitHub Releases) ----------
let updater = null;
function getUpdater() {
  if (updater) return updater;
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  const send = (state) => mainWindow && mainWindow.webContents.send('update:state', state);
  autoUpdater.on('checking-for-update', () => send({ status: 'checking' }));
  autoUpdater.on('update-available', (info) => send({ status: 'available', version: info.version, notes: info.releaseNotes || '' }));
  autoUpdater.on('update-not-available', () => send({ status: 'latest' }));
  autoUpdater.on('download-progress', (p) => send({ status: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => send({ status: 'ready', version: info.version }));
  autoUpdater.on('error', (err) => {
    log('updater error', err);
    send({ status: 'error', message: friendlyUpdateError(err) });
  });
  updater = autoUpdater;
  return updater;
}

function friendlyUpdateError(err) {
  const msg = String((err && err.message) || err);
  if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|net::ERR/i.test(msg)) return "Couldn't reach GitHub. Check your internet connection and try again.";
  if (/404|latest\.yml/i.test(msg)) return 'No published releases were found yet.';
  return msg.split('\n')[0].slice(0, 200);
}

ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('update:check', async () => {
  if (!app.isPackaged) return { status: 'dev' };
  try {
    const u = getUpdater();
    u.autoDownload = settings.get('updates.autoDownload', false) === true;
    u.allowPrerelease = settings.get('updates.prerelease', false) === true;
    await u.checkForUpdates();
    return { status: 'started' };
  } catch (err) {
    return { status: 'error', message: friendlyUpdateError(err) };
  }
});
ipcMain.handle('update:download', async () => {
  try {
    await getUpdater().downloadUpdate();
    return true;
  } catch (err) {
    return false;
  }
});
ipcMain.on('update:install', () => {
  // The renderer has already asked about unsaved work.
  allowClose = true;
  log('installing update');
  // Silent install, then relaunch: no installer wizard to get stuck behind.
  setImmediate(() => getUpdater().quitAndInstall(true, true));
});
