const { app, BrowserWindow, ipcMain, dialog, protocol, net, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const DIST = path.join(__dirname, '..', 'dist');
const RECENT_FILE = () => path.join(app.getPath('userData'), 'recent.json');
const MAX_RECENT = 30;

let mainWindow = null;
let allowClose = false;
let pendingOpen = collectFileArgs(process.argv);

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

// Single instance: opening a file from Explorer while the app runs sends it to the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const files = collectFileArgs(argv);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      if (files.length) mainWindow.webContents.send('app:open-paths', files);
    }
  });
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

  mainWindow.once('ready-to-show', () => mainWindow.show());

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

  mainWindow.on('closed', () => (mainWindow = null));

  // Developer aid: SLATE_CAPTURE=path.png captures a screenshot after load, then exits.
  if (process.env.SLATE_CAPTURE) {
    mainWindow.webContents.once('did-finish-load', () => {
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
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const filePath = path.normalize(path.join(DIST, rel));
    if (!filePath.startsWith(DIST)) return new Response('Forbidden', { status: 403 });
    const res = await net.fetch(pathToFileURL(filePath).toString());
    if (!filePath.endsWith('.html')) return res;
    // Lock the renderer down: only our own code, no remote content.
    const headers = new Headers(res.headers);
    headers.set(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self' data: blob:; object-src 'none'; base-uri 'none'"
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
  if (mainWindow) mainWindow.webContents.send('app:open-paths', [filePath]);
  else pendingOpen.push(filePath);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------- Recent files ----------
function readRecent() {
  try {
    return JSON.parse(fs.readFileSync(RECENT_FILE(), 'utf8'));
  } catch {
    return [];
  }
}
function writeRecent(list) {
  try {
    fs.writeFileSync(RECENT_FILE(), JSON.stringify(list.slice(0, MAX_RECENT), null, 2));
  } catch {}
}

function readFileEntry(p) {
  const data = fs.readFileSync(p);
  const stat = fs.statSync(p);
  return { path: p, name: path.basename(p), data: new Uint8Array(data), size: stat.size };
}

// ---------- IPC ----------
ipcMain.handle('app:get-pending-open', () => {
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
    defaultPath: opts.defaultPath,
    filters: opts.filters
  });
  return res.canceled ? null : res.filePath;
});

ipcMain.handle('file:read', (_e, p) => readFileEntry(p));

ipcMain.handle('file:write', (_e, p, data) => {
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

ipcMain.handle('print:html', (_e, html) =>
  withHiddenWindow(
    html,
    (win) =>
      new Promise((resolve) => {
        win.webContents.print({ silent: false, printBackground: true }, (ok) => resolve(ok));
      })
  )
);

ipcMain.handle('export:pdf-from-html', (_e, html, opts = {}) =>
  withHiddenWindow(html, async (win) => {
    const buf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: opts.pageSize || 'Letter',
      preferCSSPageSize: true
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
  autoUpdater.on('error', (err) => send({ status: 'error', message: friendlyUpdateError(err) }));
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
    await getUpdater().checkForUpdates();
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
  setImmediate(() => getUpdater().quitAndInstall(false, true));
});
