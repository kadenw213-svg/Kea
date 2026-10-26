// App-wide settings, stored as flat "section.key" values in settings.json. The renderer owns the
// schema and defaults; the main process only reads the few values it needs (with its own fallbacks).
const { app, ipcMain, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const file = () => path.join(app.getPath('userData'), 'settings.json');
let cache = null;
const listeners = new Set();

function all() {
  if (!cache) {
    try {
      cache = JSON.parse(fs.readFileSync(file(), 'utf8')) || {};
    } catch {
      // A damaged file (a crash mid-save): the last good copy, never an empty start that would save over everything.
      try {
        cache = JSON.parse(fs.readFileSync(`${file()}.bak`, 'utf8')) || {};
      } catch {
        cache = {};
      }
    }
  }
  return cache;
}

function get(key, fallback) {
  const v = all()[key];
  return v === undefined ? fallback : v;
}

function set(patch) {
  // The theme carries the time it was picked, so the phone and the PC keep the newer choice when they sync.
  if (patch && patch['appearance.theme'] && patch['appearance.theme'] !== all()['appearance.theme'] && !patch['appearance.themeAt']) patch = { ...patch, 'appearance.themeAt': new Date().toISOString() };
  const next = { ...all() };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === null || v === undefined) delete next[k];
    else next[k] = v;
  }
  cache = next;
  try {
    // Written beside it and swapped in, with the previous good copy kept, so a crash mid-save loses nothing.
    const tmp = `${file()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    if (fs.existsSync(file())) fs.copyFileSync(file(), `${file()}.bak`);
    fs.renameSync(tmp, file());
  } catch {}
  for (const fn of listeners) {
    try {
      fn(next);
    } catch {}
  }
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('settings:changed', next);
  return next;
}

function register() {
  ipcMain.handle('settings:get', () => all());
  ipcMain.handle('settings:set', (_e, patch) => set(patch));
}

const onChange = (fn) => listeners.add(fn);

module.exports = { register, get, set, all, onChange };
