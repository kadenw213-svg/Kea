// Version history (earlier copies of files, kept before they're overwritten) and crash recovery
// (hidden copies of unsaved work, restored on the next start if Slate didn't close normally).
const { app, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const settings = require('./settings.cjs');

const historyRoot = () => path.join(app.getPath('userData'), 'history');
const recoveryRoot = () => path.join(app.getPath('userData'), 'recovery');
const keyFor = (p) => crypto.createHash('sha1').update(path.resolve(p).toLowerCase()).digest('hex');
const dirFor = (p) => path.join(historyRoot(), keyFor(p));
const extOf = (p) => path.extname(p).slice(1).toLowerCase() || 'bin';
const safeId = (id) => String(id).replace(/[^a-z0-9_-]/gi, '');

function readMeta(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  } catch {
    return { versions: [] };
  }
}
function writeMeta(dir, meta) {
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 1));
}

function prune(dir, meta) {
  const max = Math.max(1, Number(settings.get('files.versionMax', 50)));
  const days = Math.max(1, Number(settings.get('files.versionDays', 90)));
  const cutoff = Date.now() - days * 864e5;
  // Named versions are kept until deleted by hand.
  const keep = [];
  let unnamed = 0;
  for (const v of meta.versions.sort((a, b) => b.ts - a.ts)) {
    const ok = v.label || (v.ts >= cutoff && unnamed < max);
    if (!v.label && ok) unnamed++;
    if (ok) keep.push(v);
    else fs.rm(path.join(dir, v.file), { force: true }, () => {});
  }
  meta.versions = keep;
}

/** Copy the file's current contents into its history. */
function snapshot(p, { force = false, label } = {}) {
  if (!force && !settings.get('files.versions', true)) return null;
  let st;
  try {
    st = fs.statSync(p);
    if (!st.isFile()) return null;
  } catch {
    return null;
  }
  const dir = dirFor(p);
  fs.mkdirSync(dir, { recursive: true });
  const meta = readMeta(dir);
  meta.path = p;
  meta.name = path.basename(p);
  const latest = meta.versions.reduce((a, v) => Math.max(a, v.ts), 0);
  const every = Math.max(0, Number(settings.get('files.versionEvery', 10))) * 60e3;
  if (!force && latest && Date.now() - latest < every) return null;
  // Skip if identical to the newest stored version.
  const newest = meta.versions.find((v) => v.ts === latest);
  if (!force && newest && newest.size === st.size && newest.mtime === st.mtimeMs) return null;
  const ts = Date.now();
  const file = `${ts}.${extOf(p)}`;
  fs.copyFileSync(p, path.join(dir, file));
  const v = { id: String(ts), ts, file, size: st.size, mtime: st.mtimeMs, ...(label ? { label } : {}) };
  meta.versions.push(v);
  prune(dir, meta);
  writeMeta(dir, meta);
  return v;
}

function list(p) {
  const meta = readMeta(dirFor(p));
  return meta.versions.sort((a, b) => b.ts - a.ts).map(({ id, ts, size, label }) => ({ id, ts, size, label }));
}

function dirSize(dir) {
  let total = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      total += e.isDirectory() ? dirSize(f) : fs.statSync(f).size;
    }
  } catch {}
  return total;
}

function register({ log }) {
  ipcMain.handle('history:list', (_e, p) => list(p));
  ipcMain.handle('history:read', (_e, p, id) => {
    const meta = readMeta(dirFor(p));
    const v = meta.versions.find((x) => x.id === String(id));
    if (!v) throw new Error('That version no longer exists.');
    return new Uint8Array(fs.readFileSync(path.join(dirFor(p), v.file)));
  });
  ipcMain.handle('history:snapshot', (_e, p, label) => snapshot(p, { force: true, label }));
  ipcMain.handle('history:label', (_e, p, id, label) => {
    const dir = dirFor(p);
    const meta = readMeta(dir);
    const v = meta.versions.find((x) => x.id === String(id));
    if (v) {
      if (label) v.label = String(label).slice(0, 100);
      else delete v.label;
      writeMeta(dir, meta);
    }
    return list(p);
  });
  ipcMain.handle('history:delete', (_e, p, id) => {
    const dir = dirFor(p);
    const meta = readMeta(dir);
    const v = meta.versions.find((x) => x.id === String(id));
    if (v) {
      fs.rmSync(path.join(dir, v.file), { force: true });
      meta.versions = meta.versions.filter((x) => x !== v);
      writeMeta(dir, meta);
    }
    return list(p);
  });
  ipcMain.handle('history:usage', () => dirSize(historyRoot()));
  ipcMain.handle('history:clear', () => {
    fs.rmSync(historyRoot(), { recursive: true, force: true });
    return true;
  });
  ipcMain.handle('history:open-folder', () => {
    fs.mkdirSync(historyRoot(), { recursive: true });
    return shell.openPath(historyRoot());
  });

  // ---------- Crash recovery ----------
  ipcMain.handle('recovery:put', (_e, meta, data) => {
    const id = safeId(meta.tabId);
    fs.mkdirSync(recoveryRoot(), { recursive: true });
    fs.writeFileSync(path.join(recoveryRoot(), id + '.bin.tmp'), Buffer.from(data));
    fs.renameSync(path.join(recoveryRoot(), id + '.bin.tmp'), path.join(recoveryRoot(), id + '.bin'));
    fs.writeFileSync(path.join(recoveryRoot(), id + '.json'), JSON.stringify({ ...meta, tabId: id, savedAt: Date.now(), pid: process.pid }));
    return true;
  });
  ipcMain.handle('recovery:drop', (_e, tabId) => {
    const id = safeId(tabId);
    fs.rmSync(path.join(recoveryRoot(), id + '.bin'), { force: true });
    fs.rmSync(path.join(recoveryRoot(), id + '.json'), { force: true });
    return true;
  });
  // Entries left by an earlier run (this run's own entries are excluded by process id).
  ipcMain.handle('recovery:list', () => {
    try {
      return fs
        .readdirSync(recoveryRoot())
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
          try {
            return JSON.parse(fs.readFileSync(path.join(recoveryRoot(), f), 'utf8'));
          } catch {
            return null;
          }
        })
        .filter((m) => m && m.pid !== process.pid && fs.existsSync(path.join(recoveryRoot(), m.tabId + '.bin')))
        .sort((a, b) => b.savedAt - a.savedAt);
    } catch {
      return [];
    }
  });
  ipcMain.handle('recovery:read', (_e, tabId) => new Uint8Array(fs.readFileSync(path.join(recoveryRoot(), safeId(tabId) + '.bin'))));
}

module.exports = { register, snapshot };
