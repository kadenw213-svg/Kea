// Ad and tracker blocking for Kea's class-site browser. uBlock Origin itself can't run in Kea (it needs browser
// extension features Electron doesn't have), so Kea uses Ghostery's open-source blocker, which reads the same filter
// lists (EasyList, EasyPrivacy, uBlock Origin's own) and hides ad spaces the same way. The compiled lists are
// downloaded once and kept for a week in Kea's data folder. Settings → Class sites turns it off.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const settings = require('../settings.cjs');

const cache = () => path.join(app.getPath('userData'), 'adblock-engine.bin');
const WEEK = 7 * 864e5;
let blocker = null;
let loading = null;
const sessions = new Set();

function load() {
  if (blocker) return Promise.resolve(blocker);
  if (!loading) {
    try {
      if (Date.now() - fs.statSync(cache()).mtimeMs > WEEK) fs.rmSync(cache(), { force: true });
    } catch {}
    const { ElectronBlocker } = require('@ghostery/adblocker-electron');
    loading = ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, { path: cache(), read: fs.promises.readFile, write: fs.promises.writeFile })
      .then((b) => (blocker = b))
      .catch((err) => {
        console.error('Ad blocking', err);
        loading = null;
        return null;
      });
  }
  return loading;
}

/** Block ads and trackers in this session (when the setting is on). */
async function enable(ses) {
  sessions.add(ses);
  if (settings.get('sites.adblock', true) === false) return;
  const b = await load();
  if (!b || b.isBlockingEnabled?.(ses)) return;
  try {
    b.enableBlockingInSession(ses);
  } catch (err) {
    console.error('Ad blocking', err);
  }
}

function disable(ses) {
  try {
    if (blocker?.isBlockingEnabled?.(ses)) blocker.disableBlockingInSession(ses);
  } catch {}
}

// Turned on or off in Settings: applied to the open sessions at once.
let last = settings.get('sites.adblock', true) !== false;
settings.onChange(() => {
  const on = settings.get('sites.adblock', true) !== false;
  if (on === last) return;
  last = on;
  for (const ses of sessions) on ? enable(ses) : disable(ses);
});

module.exports = { enable };
