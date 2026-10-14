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
      cache = {};
    }
  }
  return cache;
}

function get(key, fallback) {
  const v = all()[key];
  return v === undefined ? fallback : v;
}

function set(patch) {
  const next = { ...all() };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === null || v === undefined) delete next[k];
    else next[k] = v;
  }
  cache = next;
  try {
    fs.writeFileSync(file(), JSON.stringify(next, null, 2));
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
