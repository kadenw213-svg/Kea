// Home screen backend: folder listing, file search, previews cache, descriptions and cloud drives.
const { app, ipcMain, shell, net, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

const SHOWN_EXT = new Set([
  'pdf', 'docx', 'docm', 'dotx', 'doc', 'odt', 'rtf', 'html', 'htm',
  'xlsx', 'xlsm', 'xls', 'ods', 'csv', 'tsv',
  'pptx', 'pptm', 'potx', 'ppsx',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg',
  'txt', 'md', 'json', 'xml', 'yaml', 'yml', 'log', 'ini', 'js', 'ts', 'tsx', 'jsx', 'py', 'css',
  // Google Docs shortcuts from Google Drive for desktop (open in the browser).
  'gdoc', 'gsheet', 'gslides'
]);
const SKIP_DIRS = new Set(['node_modules', '$recycle.bin', 'system volume information', 'appdata', '.git', '.tmp.drivedownload', '.tmp.driveupload']);

const userFile = (name) => path.join(app.getPath('userData'), name);
const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};
const writeJson = (file, data) => {
  try {
    fs.writeFileSync(file, JSON.stringify(data));
  } catch {}
};
const extOf = (n) => {
  const i = n.lastIndexOf('.');
  return i < 0 ? '' : n.slice(i + 1).toLowerCase();
};
const exists = (p) => {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
};
const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

// ---------- Listing ----------
function statEntry(dir, name) {
  const full = path.join(dir, name);
  try {
    const st = fs.statSync(full);
    return { path: full, name, dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs };
  } catch {
    return null;
  }
}
const visible = (name) => !name.startsWith('.') && !name.startsWith('~$') && !name.startsWith('$') && name.toLowerCase() !== 'desktop.ini';

/**
 * Windows marks cloud files that aren't downloaded yet ("online-only") with the RECALL_ON_DATA_ACCESS /
 * OFFLINE attributes. Reading those would download them, so previews skip them. Node can't see file
 * attributes, so ask PowerShell once per folder.
 */
function onlineOnlyNames(dir) {
  if (process.platform !== 'win32') return Promise.resolve(new Set());
  const script = "Get-ChildItem -LiteralPath $args[0] -Force -File | ForEach-Object { '{0}|{1}' -f [int]$_.Attributes, $_.Name }";
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `& { ${script} } '${dir.replace(/'/g, "''")}'`],
      { windowsHide: true, timeout: 8000, maxBuffer: 8 << 20 },
      (err, out) => {
        const set = new Set();
        if (!err)
          for (const line of String(out).split(/\r?\n/)) {
            const i = line.indexOf('|');
            if (i < 0) continue;
            const attr = Number(line.slice(0, i));
            if (attr & 0x400000 || attr & 0x40000 || attr & 0x1000) set.add(line.slice(i + 1));
          }
        resolve(set);
      }
    );
  });
}

async function listDir(dir, opts = {}) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    throw new Error(e.code === 'ENOENT' ? 'This folder no longer exists.' : e.code === 'EPERM' || e.code === 'EACCES' ? "Slate doesn't have permission to open this folder." : e.message);
  }
  const entries = [];
  for (const name of names) {
    if (!visible(name)) continue;
    const e = statEntry(dir, name);
    if (!e) continue;
    if (e.dir ? SKIP_DIRS.has(name.toLowerCase()) : !SHOWN_EXT.has(extOf(name))) continue;
    entries.push(e);
  }
  if (opts.cloud) {
    const online = opts.allOnline ? null : await onlineOnlyNames(dir);
    for (const e of entries) if (!e.dir && (!online || online.has(e.name))) e.online = true;
  }
  return entries;
}

/** Name search under a folder (breadth-first, bounded so huge drives stay responsive). */
function searchDir(root, query, limit = 200) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return [];
  const out = [];
  const queue = [{ dir: root, depth: 0 }];
  const deadline = Date.now() + 2500;
  let visited = 0;
  while (queue.length && out.length < limit && Date.now() < deadline && visited < 4000) {
    const { dir, depth } = queue.shift();
    visited++;
    let items;
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const it of items) {
      if (!visible(it.name)) continue;
      if (it.isDirectory()) {
        if (depth < 8 && !SKIP_DIRS.has(it.name.toLowerCase())) queue.push({ dir: path.join(dir, it.name), depth: depth + 1 });
        continue;
      }
      if (!SHOWN_EXT.has(extOf(it.name)) || !it.name.toLowerCase().includes(q)) continue;
      const e = statEntry(dir, it.name);
      if (e) out.push(e);
      if (out.length >= limit) break;
    }
  }
  return out;
}

// ---------- Previews cache ----------
const previewDir = () => path.join(app.getPath('userData'), 'previews');
const previewFile = (p) => path.join(previewDir(), crypto.createHash('sha1').update(p.toLowerCase()).digest('hex') + '.json');

function getPreview(p) {
  try {
    const st = fs.statSync(p);
    const cached = JSON.parse(fs.readFileSync(previewFile(p), 'utf8'));
    if (cached.mtime === st.mtimeMs && cached.size === st.size) return cached.preview;
  } catch {}
  return null;
}
function setPreview(p, preview) {
  try {
    const st = fs.statSync(p);
    fs.mkdirSync(previewDir(), { recursive: true });
    fs.writeFileSync(previewFile(p), JSON.stringify({ path: p, mtime: st.mtimeMs, size: st.size, preview }));
    return true;
  } catch {
    return false;
  }
}

// ---------- Cloud drives ----------
const HOME = os.homedir();
const LOCAL = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
const ROAMING = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
const PF = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);

const PROVIDERS = {
  onedrive: {
    label: 'OneDrive',
    page: 'https://www.microsoft.com/microsoft-365/onedrive/download',
    exe: () => [path.join(LOCAL, 'Microsoft', 'OneDrive', 'OneDrive.exe'), ...PF.map((p) => path.join(p, 'Microsoft OneDrive', 'OneDrive.exe'))].find(exists)
  },
  gdrive: {
    label: 'Google Drive',
    page: 'https://www.google.com/drive/download/',
    installer: { url: 'https://dl.google.com/drive-file-stream/GoogleDriveSetup.exe', file: 'GoogleDriveSetup.exe', signer: 'Google LLC', args: [] },
    exe: () => {
      for (const pf of PF) {
        const base = path.join(pf, 'Google', 'Drive File Stream');
        try {
          const versions = fs.readdirSync(base).filter((v) => /^\d/.test(v)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
          for (const v of versions) {
            const exe = path.join(base, v, 'GoogleDriveFS.exe');
            if (exists(exe)) return exe;
          }
        } catch {}
      }
      return undefined;
    }
  },
  dropbox: {
    label: 'Dropbox',
    page: 'https://www.dropbox.com/install',
    installer: { url: 'https://www.dropbox.com/download?plat=win', file: 'DropboxInstaller.exe', signer: 'Dropbox, Inc', args: [] },
    exe: () => PF.map((p) => path.join(p, 'Dropbox', 'Client', 'Dropbox.exe')).find(exists)
  },
  icloud: {
    label: 'iCloud Drive',
    page: process.platform === 'win32' ? 'ms-windows-store://pdp/?productid=9PKTQ5699M62' : 'https://support.apple.com/guide/icloud/',
    exe: () => (exists(path.join(LOCAL, 'Microsoft', 'WindowsApps', 'AppleInc.iCloud_nzyj5cx40ttqa')) || exists(path.join(HOME, 'iCloudDrive')) ? 'store' : undefined)
  }
};

function cloudStorageDirs() {
  // macOS File Provider locations (OneDrive, Google Drive, Dropbox, Box…).
  const base = path.join(HOME, 'Library', 'CloudStorage');
  try {
    return fs.readdirSync(base).map((n) => ({ name: n, path: path.join(base, n) }));
  } catch {
    return [];
  }
}

function detectDrives() {
  const found = { onedrive: [], gdrive: [], dropbox: [], icloud: [] };
  const add = (id, label, p) => {
    if (!p || !isDir(p)) return;
    if (Object.values(found).some((l) => l.some((a) => a.path.toLowerCase() === p.toLowerCase()))) return;
    found[id].push({ label, path: p });
  };

  if (process.platform === 'win32') {
    const personal = process.env.OneDriveConsumer || '';
    add('onedrive', 'OneDrive', personal);
    const work = process.env.OneDriveCommercial || '';
    if (work) add('onedrive', path.basename(work).replace(/^OneDrive\s*-\s*/, '') || 'Work', work);
    add('onedrive', 'OneDrive', process.env.OneDrive);
    add('onedrive', 'OneDrive', path.join(HOME, 'OneDrive'));

    // Google Drive for desktop mounts a drive letter (usually G:) with "My Drive" inside.
    for (let c = 68; c <= 90; c++) {
      const root = String.fromCharCode(c) + ':\\';
      add('gdrive', 'My Drive', path.join(root, 'My Drive'));
      add('gdrive', 'Shared drives', path.join(root, 'Shared drives'));
    }
    add('gdrive', 'My Drive', path.join(HOME, 'My Drive'));
    add('gdrive', 'Google Drive', path.join(HOME, 'Google Drive'));

    add('icloud', 'iCloud Drive', path.join(HOME, 'iCloudDrive'));
  } else {
    for (const d of cloudStorageDirs()) {
      if (/^OneDrive/i.test(d.name)) add('onedrive', d.name.replace(/^OneDrive-?/, '') || 'OneDrive', d.path);
      else if (/^GoogleDrive/i.test(d.name)) {
        add('gdrive', 'My Drive', path.join(d.path, 'My Drive'));
        add('gdrive', 'Shared drives', path.join(d.path, 'Shared drives'));
      } else if (/^Dropbox/i.test(d.name)) add('dropbox', 'Dropbox', d.path);
    }
    add('icloud', 'iCloud Drive', path.join(HOME, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'));
    add('gdrive', 'Google Drive', path.join(HOME, 'Google Drive'));
  }

  for (const f of [path.join(ROAMING, 'Dropbox', 'info.json'), path.join(LOCAL, 'Dropbox', 'info.json'), path.join(HOME, '.dropbox', 'info.json')]) {
    const info = readJson(f, null);
    if (!info) continue;
    if (info.personal?.path) add('dropbox', 'Dropbox', info.personal.path);
    if (info.business?.path) add('dropbox', 'Dropbox (work)', info.business.path);
  }
  add('dropbox', 'Dropbox', path.join(HOME, 'Dropbox'));

  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id,
    label: p.label,
    installed: found[id].length > 0 || (process.platform === 'win32' && !!p.exe()),
    accounts: found[id]
  }));
}

function knownFolders() {
  const out = [];
  for (const [id, label] of [
    ['desktop', 'Desktop'],
    ['documents', 'Documents'],
    ['downloads', 'Downloads']
  ]) {
    try {
      const p = app.getPath(id);
      if (isDir(p)) out.push({ id, label, path: p });
    } catch {}
  }
  return out;
}

// Signed-installer check: only run a downloaded installer if Windows says it's validly signed by the expected company.
function verifySigner(file, signer) {
  return new Promise((resolve) => {
    const script = "$s = Get-AuthenticodeSignature -LiteralPath $args[0]; '{0}|{1}' -f $s.Status, $s.SignerCertificate.Subject";
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `& { ${script} } '${file.replace(/'/g, "''")}'`], { windowsHide: true, timeout: 20000 }, (err, out) => {
      const [status, subject = ''] = String(out || '').trim().split('|');
      resolve(!err && status === 'Valid' && subject.includes(signer));
    });
  });
}

let installing = null;
async function downloadInstaller(id, inst, send) {
  const dest = path.join(app.getPath('temp'), 'slate-' + inst.file);
  const res = await net.fetch(inst.url);
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const out = fs.createWriteStream(dest);
  let received = 0;
  let last = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
      received += value.length;
      if (Date.now() - last > 200) {
        last = Date.now();
        send({ id, status: 'downloading', received, total });
      }
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  return dest;
}

async function connect(id, send) {
  const p = PROVIDERS[id];
  if (!p) throw new Error('Unknown drive');
  if (process.platform !== 'win32') {
    await shell.openExternal(p.page);
    return { action: 'web' };
  }
  const exe = p.exe();
  if (exe === 'store') {
    // iCloud is a Store app; opening its Store page offers "Open" when installed.
    await shell.openExternal(p.page);
    return { action: 'launched' };
  }
  if (exe) {
    // Starting the sync app shows its own sign-in window if no account is signed in yet.
    spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
    return { action: 'launched' };
  }
  if (!p.installer) {
    await shell.openExternal(p.page);
    return { action: 'web' };
  }
  if (installing) throw new Error('Another drive is already being set up.');
  installing = id;
  try {
    send({ id, status: 'downloading', received: 0, total: 0 });
    const file = await downloadInstaller(id, p.installer, send);
    send({ id, status: 'verifying' });
    if (!(await verifySigner(file, p.installer.signer))) {
      try {
        fs.unlinkSync(file);
      } catch {}
      throw new Error(`The downloaded installer isn't signed by ${p.installer.signer}, so Slate didn't run it.`);
    }
    send({ id, status: 'installing' });
    const err = await shell.openPath(file);
    if (err) throw new Error(err);
    return { action: 'installing' };
  } finally {
    installing = null;
  }
}

function register({ log, getWindow }) {
  const send = (m) => getWindow()?.webContents.send('drives:progress', m);

  ipcMain.handle('fs:list', (_e, dir, opts) => listDir(dir, opts));
  ipcMain.handle('fs:search', (_e, dir, q) => searchDir(dir, q));
  ipcMain.handle('fs:stat-many', (_e, paths) =>
    (paths || []).map((p) => {
      try {
        const st = fs.statSync(p);
        return { path: p, exists: true, size: st.size, mtime: st.mtimeMs };
      } catch {
        return { path: p, exists: false };
      }
    })
  );
  ipcMain.handle('fs:known-folders', () => knownFolders());
  ipcMain.handle('dialog:open-folder', async () => {
    const r = await dialog.showOpenDialog(getWindow(), { title: 'Add a folder to Home', properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0] || null;
  });
  ipcMain.handle('fs:is-dir', (_e, p) => isDir(p));
  ipcMain.handle('shell:open-path', (_e, p) => shell.openPath(p));

  ipcMain.handle('preview:get', (_e, p) => getPreview(p));
  ipcMain.handle('preview:set', (_e, p, preview) => setPreview(p, preview));

  ipcMain.handle('meta:all', () => readJson(userFile('file-meta.json'), {}));
  ipcMain.handle('meta:set', (_e, p, patch) => {
    const all = readJson(userFile('file-meta.json'), {});
    const key = p.toLowerCase();
    const next = { ...(all[key] || {}), ...patch };
    for (const k of Object.keys(next)) if (next[k] === '' || next[k] == null) delete next[k];
    if (Object.keys(next).length) all[key] = next;
    else delete all[key];
    writeJson(userFile('file-meta.json'), all);
    return all;
  });

  ipcMain.handle('home:settings', () => readJson(userFile('home.json'), {}));
  ipcMain.handle('home:set-settings', (_e, patch) => {
    const next = { ...readJson(userFile('home.json'), {}), ...patch };
    writeJson(userFile('home.json'), next);
    return next;
  });

  ipcMain.handle('drives:detect', () => detectDrives());
  ipcMain.handle('drives:connect', async (_e, id) => {
    try {
      return await connect(id, send);
    } catch (err) {
      log('drive connect failed', id, err?.message);
      send({ id, status: 'error', error: err?.message || String(err) });
      throw err;
    }
  });
}

module.exports = { register };
