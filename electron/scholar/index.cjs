// Kea Scholar: classes, their textbooks and the calendar, for the active profile.
const { ipcMain, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const profiles = require('./profiles.cjs');
const db = require('./db.cjs');
const browser = require('./browser.cjs');
const workspace = require('./workspace.cjs');
const runner = require('./runner.cjs');
const settings = require('../settings.cjs');

// ---------- Kea's own state for a profile (what's checked off) ----------
function readState() {
  try {
    return JSON.parse(fs.readFileSync(profiles.paths().state, 'utf8'));
  } catch {
    return { done: {} };
  }
}
function writeState(s) {
  const p = profiles.paths();
  fs.mkdirSync(p.dir, { recursive: true });
  fs.writeFileSync(p.state, JSON.stringify(s, null, 2));
}

// ---------- Tell the window when a scan changes the classes ----------
let watcher = null;
function watch() {
  watcher?.close();
  watcher = null;
  const dir = path.dirname(profiles.paths().db);
  if (!fs.existsSync(dir)) return;
  let timer = null;
  try {
    watcher = fs.watch(dir, (_e, name) => {
      if (!String(name || '').startsWith('academic_sync.db')) return;
      clearTimeout(timer);
      timer = setTimeout(() => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('scholar:changed')), 800);
    });
  } catch {}
}

/**
 * Bring in classes from an existing Class Calendar Import folder (for people who already ran those skills by hand):
 * its database, downloads and study PDFs are copied into the active profile. The original folder isn't changed.
 */
function importExisting(folder) {
  const src = path.join(folder, 'data', 'academic_sync.db');
  if (!fs.existsSync(src)) throw new Error('That folder has no data\\academic_sync.db. Pick the Class Calendar Import folder itself.');
  const p = profiles.paths();
  fs.mkdirSync(path.dirname(p.db), { recursive: true });
  fs.copyFileSync(src, p.db);
  const downloads = path.join(folder, 'data', 'downloads');
  if (fs.existsSync(downloads)) fs.cpSync(downloads, path.join(p.workspace, 'data', 'downloads'), { recursive: true });
  // Study PDFs: copied into the profile's textbook folder, one subfolder per class (as the engine names them).
  let pdfs = 0;
  for (const base of [path.join(require('os').homedir(), 'OneDrive', 'Desktop', 'Weekly Study PDFs'), path.join(require('os').homedir(), 'Desktop', 'Weekly Study PDFs')]) {
    if (!fs.existsSync(base)) continue;
    for (const cls of fs.readdirSync(base)) {
      const from = path.join(base, cls);
      if (!fs.statSync(from).isDirectory()) continue;
      for (const f of fs.readdirSync(from).filter((x) => x.toLowerCase().endsWith('.pdf'))) {
        fs.mkdirSync(path.join(p.textbooks, cls), { recursive: true });
        fs.copyFileSync(path.join(from, f), path.join(p.textbooks, cls, f));
        pdfs++;
      }
    }
    break;
  }
  watch();
  return { pdfs };
}

// ---------- The daily schedule ----------
const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Whether class scans can run for this profile: Claude signed in, the engine installed, a class site saved. */
async function ready() {
  const c = await workspace.check();
  return !!(c.claude && c.uv && c.account.loggedIn && c.engineReady && browser.schoolInfo().home);
}

/**
 * Once a day after the chosen time (5:00 by default, like the scheduled task it replaces): the daily check (which
 * also imports any new class), then this week's textbook chapters; on the chosen weekday, the weekly update too.
 */
async function tick() {
  try {
    if (settings.get('scholar.autoScan', true) === false || runner.status().running) return;
    const [h, m] = String(settings.get('scholar.scanTime', '05:00')).split(':').map(Number);
    const now = new Date();
    if (now.getHours() * 60 + now.getMinutes() < (h || 0) * 60 + (m || 0)) return;
    const s = readState();
    s.lastRuns = s.lastRuns || {};
    if (s.lastRuns.daily === localDate()) return;
    if (!(await ready())) return;
    s.lastRuns.daily = localDate();
    writeState(s);
    await runner.run('daily', '', 'schedule');
    const weekday = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][now.getDay()];
    if (settings.get('scholar.weeklyDay', 'sunday') === weekday) await runner.run('sync', '', 'schedule');
    if (settings.get('scholar.studyPdfs', true) !== false) await runner.run('study', '', 'schedule');
  } catch (err) {
    console.error('Scholar schedule', err);
  }
}

function register() {
  const p = () => profiles.paths();
  ipcMain.handle('scholar:profiles', () => profiles.all());
  ipcMain.handle('scholar:createProfile', (_e, name) => (profiles.create(name), watch(), profiles.all()));
  ipcMain.handle('scholar:selectProfile', (_e, id) => {
    if (runner.status().running) throw new Error('A class scan is running. Switch profiles when it finishes.');
    profiles.select(id);
    watch();
    return profiles.all();
  });
  ipcMain.handle('scholar:renameProfile', (_e, id, name) => profiles.rename(id, name));
  ipcMain.handle('scholar:status', () => ({ hasData: fs.existsSync(p().db), paths: p() }));
  ipcMain.handle('scholar:courses', () => db.courses(p().db, p().textbooks, readState().done || {}));
  ipcMain.handle('scholar:items', (_e, q) => db.items(p().db, p().textbooks, readState().done || {}, q || {}));
  ipcMain.handle('scholar:course', (_e, id) => db.course(p().db, p().textbooks, readState().done || {}, id));
  ipcMain.handle('scholar:setDone', (_e, id, done) => {
    const s = readState();
    s.done = s.done || {};
    if (done) s.done[id] = new Date().toISOString();
    else delete s.done[id];
    writeState(s);
    return true;
  });
  ipcMain.handle('scholar:importExisting', (_e, folder) => importExisting(folder));

  // The class site and Kea's own sign-in.
  ipcMain.handle('scholar:school', () => browser.schoolInfo());
  ipcMain.handle('scholar:setSchoolHome', (_e, home) => browser.setHome(home));
  ipcMain.handle('scholar:signIn', (_e, remember) => browser.signIn(remember));
  ipcMain.handle('scholar:forgetLogin', () => browser.forgetLogin());
  ipcMain.handle('scholar:siteStatus', () => browser.status());
  ipcMain.on('class-site:login', browser.onLoginSubmitted);
  ipcMain.on('class-site:remembering', browser.remembering);

  // Setup: what's installed, and installing it.
  const lines = (e) => (line) => e.sender.send('scholar:setupLine', line);
  ipcMain.handle('scholar:check', () => workspace.check());
  ipcMain.handle('scholar:installUv', (e) => workspace.installUv(lines(e)));
  ipcMain.handle('scholar:installClaude', (e) => workspace.installClaude(lines(e)));
  ipcMain.handle('scholar:signInClaude', () => workspace.signInClaude());
  ipcMain.handle('scholar:setupEngine', (e) => workspace.setupEngine(browser.schoolInfo().home, lines(e)));

  // Scans.
  ipcMain.handle('scholar:run', (_e, task, arg) => (runner.run(task, arg || '', 'manual'), true));
  ipcMain.handle('scholar:stop', () => (runner.stop(), true));
  ipcMain.handle('scholar:runStatus', () => runner.status());
  ipcMain.handle('scholar:activity', () => runner.activity());
  ipcMain.handle('scholar:news', () => runner.news());
  ipcMain.handle('scholar:markNewsRead', (_e, ids) => runner.markNewsRead(ids));

  // Developer aid (unpackaged builds only): read a page through the class-site browser.
  if (!require('electron').app.isPackaged) ipcMain.handle('scholar:debugOpen', (_e, url) => browser.open(url));

  watch();
  setTimeout(tick, 60000);
  setInterval(tick, 5 * 60000);
}

module.exports = { register };
