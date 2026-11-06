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

// Settings the page may never change through settings:set: where Kea's secrets go and what it runs. Each has its own
// checked IPC (hub:setUrl for the Hub's address) or is Kea's own bookkeeping.
const PROTECTED = new Set(['hub.url', 'hub.ownerKeyFile', 'hub.ownerPort', 'hub.googleClientId', 'hub.googleClientSecret', 'scholar.pcId', 'scholar.lastPrimary', 'app.storageMoved']);
const protectedKey = (k) => PROTECTED.has(k) || /^hub\.(owner|google)/.test(k) || k === '__proto__' || k === 'constructor' || k === 'prototype';
// Settings the page may change, but only to a value of the right shape.
const CHECKED = {
  // The other sync folder: a folder on this PC, never a network share (\\server\share) or a web address.
  'scholar.cloudPath': (v) => v === '' || (typeof v === 'string' && v.length < 1024 && !/[\x00-\x1f]/.test(v) && (/^[a-z]:[\\/]/i.test(v) || (process.platform !== 'win32' && v.startsWith('/') && !v.startsWith('//')))),
  // The student's own Google client: a Google OAuth client id and its secret, nothing else.
  'google.clientId': (v) => v === '' || (typeof v === 'string' && /^[\w-]{1,200}\.apps\.googleusercontent\.com$/.test(v.trim())),
  'google.clientSecret': (v) => v === '' || (typeof v === 'string' && /^[\w-]{1,200}$/.test(v.trim()))
};
/**
 * A change from the page (settings:set): protected keys and badly shaped values are left out (and logged), the rest
 * saved. Refused keys don't fail the whole save, so a page saving many settings at once keeps working.
 */
function setFromRenderer(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return all();
  const ok = {};
  const refused = [];
  for (const [k, v] of Object.entries(patch)) {
    if (protectedKey(k) || (CHECKED[k] && v !== null && v !== undefined && !CHECKED[k](v))) refused.push(k);
    else ok[k] = v;
  }
  if (refused.length) console.warn(`settings: refused a change from the page to ${refused.join(', ')}`);
  return Object.keys(ok).length ? set(ok) : all();
}

function register() {
  const { appOnly } = require('./ipcGuard.cjs');
  ipcMain.handle('settings:get', () => all());
  ipcMain.handle('settings:set', appOnly((_e, patch) => setFromRenderer(patch)));
}

const onChange = (fn) => listeners.add(fn);

module.exports = { register, get, set, all, onChange, setFromRenderer };
