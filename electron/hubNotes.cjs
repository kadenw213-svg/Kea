// Notifications from the Kea Hub for this account: Kea's creator changed its storage or shared-Claude limits, an
// organization or a request to join one was decided, a parent signed off, a scan finished, course material arrived.
//
// The main process asks the Hub every few minutes (and right away when the account status says there's something
// new), shows each new one once as a Windows notification, and tells the page so the account panel's list and unread
// count stay current. What Kea last saw is kept in userData/hub-notifications.json for when the Hub is offline.
const { app, ipcMain, BrowserWindow, Notification } = require('electron');
const fs = require('fs');
const path = require('path');
const settings = require('./settings.cjs');

const DAY = 86400_000;

// ---------- Pure helpers (tested in test/hubaccount) ----------

/**
 * Which notifications to show as Windows notifications now. Each one once: only ids above `shownUpTo`, unread ones.
 * The first time for an account (shownUpTo null) only the newest few from the last few days, so signing in on a new
 * computer doesn't bring a flood of old notices.
 */
function toShow(list, shownUpTo, { nowMs = Date.now(), firstMax = 3, firstDays = 3 } = {}) {
  const fresh = (list || []).filter((n) => !n.readAt && (shownUpTo == null ? nowMs - n.createdAt <= firstDays * DAY : n.id > shownUpTo));
  fresh.sort((a, b) => a.id - b.id);
  return shownUpTo == null ? fresh.slice(-firstMax) : fresh;
}

/** The highest id seen (what's been dealt with), never going down. */
const highest = (list, was) => Math.max(was ?? 0, ...(list || []).map((n) => n.id));

/** Kinds that change what the account panel shows (storage, supporter, shared-Claude limits): refresh the account. */
const refreshesAccount = (list) => (list || []).some((n) => ['storage', 'supporter', 'claude', 'parent_signoff', 'account', 'hosting'].includes(n.kind));

/** A Windows notification's text: the title, then the body and the creator's note. */
function toastText(n) {
  const body = [n.body, n.note ? `“${n.note}”` : ''].filter(Boolean).join('\n');
  return { title: n.title, body: body.length > 240 ? `${body.slice(0, 237)}…` : body };
}

// ---------- What Kea last saw ----------
const file = () => path.join(app.getPath('userData'), 'hub-notifications.json');
let state = null;
function load() {
  if (state) return state;
  try {
    state = JSON.parse(fs.readFileSync(file(), 'utf8')) || {};
  } catch {
    state = {};
  }
  return state;
}
function save() {
  try {
    fs.writeFileSync(file() + '.tmp', JSON.stringify(state));
    fs.renameSync(file() + '.tmp', file());
  } catch {}
}
/** This account's record; another account (or none) starts fresh. */
function mine() {
  const id = require('./hub.cjs').cached()?.id || null;
  const s = load();
  if (s.account !== id) {
    state = { account: id, shownUpTo: null, list: [], unread: 0 };
    save();
  }
  return state;
}

function broadcast(channel, ...args) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, ...args);
}
const out = (s) => ({ notifications: s.list || [], unread: s.unread || 0 });

const shown = [];
function showToasts(list) {
  if (settings.get('hub.notifyDesktop', true) === false || !Notification.isSupported()) return;
  let silent = false;
  try {
    silent = require('./scholar/notify.cjs').silent();
  } catch {}
  for (const n of list) {
    const t = toastText(n);
    const note = new Notification({ title: t.title, body: t.body, silent });
    note.on('click', () => {
      const w = BrowserWindow.getAllWindows()[0];
      if (!w) return;
      if (w.isMinimized()) w.restore();
      w.focus();
      w.webContents.send('hub:openAccount');
    });
    note.show();
    shown.push(note);
    shown.splice(0, Math.max(0, shown.length - 20));
  }
}

// ---------- Polling ----------
let timer = null, busy = false;
async function poll() {
  const hub = require('./hub.cjs');
  if (!hub.signedIn() || busy) return null;
  busy = true;
  try {
    const s = mine();
    const r = await hub.req('GET', '/v1/me/notifications?limit=100');
    const before = new Set((s.list || []).map((n) => `${n.id}:${n.readAt || ''}`));
    const fresh = toShow(r.notifications, s.shownUpTo);
    s.list = r.notifications;
    s.unread = r.unread;
    const newOnes = r.notifications.filter((n) => s.shownUpTo == null || n.id > s.shownUpTo);
    s.shownUpTo = highest(r.notifications, s.shownUpTo);
    save();
    showToasts(fresh);
    if (refreshesAccount(newOnes)) hub.refreshStatus().catch(() => {});
    if (r.notifications.some((n) => !before.has(`${n.id}:${n.readAt || ''}`)) || r.notifications.length !== before.size) broadcast('hub:notifications', out(s));
    return out(s);
  } catch {
    return null; // offline, signed out, or new terms to agree to: try again next time
  } finally {
    busy = false;
  }
}
function schedule(ms) {
  clearTimeout(timer);
  const every = Math.max(1, Number(settings.get('hub.notifyEveryMinutes', 2)) || 2) * 60_000;
  timer = setTimeout(() => poll().finally(() => schedule(every)), ms ?? every);
  timer.unref?.(); // (never what keeps Kea, or a test, running)
}
/** The account status said there's a newer notification than Kea has: ask now. */
function seen(latest) {
  const s = mine();
  if (latest && latest > (s.shownUpTo ?? 0)) schedule(200);
}

const wrap = (fn) => async (_e, arg) => {
  try {
    return { ok: true, value: await fn(arg || {}) };
  } catch (e) {
    return { ok: false, error: String(e.message || e), status: e.status ?? null, data: e.data ?? null };
  }
};

function register() {
  const hub = require('./hub.cjs');
  ipcMain.handle('hub:notifications', wrap(async () => (await poll()) || out(mine())));
  ipcMain.handle('hub:notificationsRead', wrap(async ({ ids, all }) => {
    await hub.req('POST', '/v1/me/notifications/read', all ? { all: true } : { ids: (ids || []).map(Number) });
    return (await poll()) || out(mine());
  }));
  ipcMain.handle('hub:notificationsDelete', wrap(async ({ ids, all }) => {
    await hub.req('POST', '/v1/me/notifications/delete', all ? { all: true } : { ids: (ids || []).map(Number) });
    return (await poll()) || out(mine());
  }));
  if (process.env.KEA_WORKER_JOB) return;
  schedule(10_000);
}

module.exports = { register, poll, seen, _test: { toShow, highest, refreshesAccount, toastText } };
