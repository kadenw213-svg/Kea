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
function log(...parts) {
  try {
    if (require('./settings.cjs').get('privacy.log', true) === false) return;
    const file = path.join(app.getPath('userData'), 'slate.log');
    const line = `[${new Date().toISOString()}] ${parts.map((p) => (p instanceof Error ? p.stack : typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}
`;
    if (fs.existsSync(file) && fs.statSync(file).size > 512 * 1024) fs.renameSync(file, file + '.old');
    fs.appendFileSync(file, line);
  } catch {}
}
process.on('uncaughtException', (err) => log('uncaughtException', err));
process.on('unhandledRejection', (err) => log('unhandledRejection', err));


protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

// Developer aid: SLATE_USERDATA runs a separate profile (and lock), so tests don't touch a running copy.
if (process.env.SLATE_USERDATA) app.setPath('userData', process.env.SLATE_USERDATA);
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
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
    sendOpen(files);
  });
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
  else mainWindow.loadURL('app://slate/index.html');

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
  });

  // Developer aid: SLATE_CAPTURE=path.png captures a screenshot after load, then exits.
  if (process.env.SLATE_CAPTURE) {
    mainWindow.webContents.once('did-finish-load', () => {
      // Background windows don't run CSS animations, so turn them off for captures.
      mainWindow.webContents.insertCSS('*,*::before,*::after{transition:none!important;animation:none!important}');
      setTimeout(async () => {
        if (process.env.SLATE_EVAL) {
          try {
            const out = await mainWindow.webContents.executeJavaScript(fs.readFileSync(process.env.SLATE_EVAL, 'utf8'));
            if (out !== undefined) console.log('[eval]', typeof out === 'string' ? out : JSON.stringify(out));
          } catch (err) {
            console.log('[eval error]', err.message);
          }
        }
        const img = await mainWindow.webContents.capturePage();
        fs.writeFileSync(process.env.SLATE_CAPTURE, img.toPNG());
        allowClose = true;
        app.quit();
      }, Number(process.env.SLATE_CAPTURE_DELAY || 4000));
    });
    mainWindow.webContents.on('console-message', (_e, level, message, line, source) => {
      if (level >= 2) console.log(`[renderer] ${message} (${source}:${line})`);
    });
  }
}

app.whenReady().then(() => {
  log('start', app.getVersion(), process.argv.slice(1));
  require('./ai.cjs').register({ log, getWindow: () => mainWindow });
  require('./files.cjs').register({ log, getWindow: () => mainWindow });
  settings.register();
  require('./history.cjs').register({ log });
  require('./google.cjs').register({ log });
  require('./cite.cjs').register({ log });
  const applySpell = () => session.defaultSession.setSpellCheckerEnabled(settings.get('general.spellcheck', true) !== false);
  applySpell();
  settings.onChange(applySpell);
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const filePath = path.normalize(path.join(DIST, rel));
    if (!filePath.startsWith(DIST)) return new Response('Forbidden', { status: 403 });
    const res = await net.fetch(pathToFileURL(filePath).toString());
    // WebAssembly (the offline grammar checker) must be served with its proper type.
    if (filePath.endsWith('.wasm')) return new Response(res.body, { status: res.status, headers: { 'Content-Type': 'application/wasm' } });
    if (!filePath.endsWith('.html')) return res;
    // Lock the renderer down: only our own code, no remote content.
    const headers = new Headers(res.headers);
    headers.set(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self' data: blob:; object-src 'none'; base-uri 'none'"
    );
    return new Response(res.body, { status: res.status, headers });
  });

  createWindow();

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
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
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
  return res.filePaths.map(readFileEntry);
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
  const tmp = p + '.slate-tmp';
  const buf = Buffer.from(data);
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
    const tmp = path.join(app.getPath('temp'), `slate-print-${Date.now()}.html`);
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
