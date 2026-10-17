// Kea Scholar: classes, their textbooks and the calendar, for the active profile.
const { ipcMain, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const profiles = require('./profiles.cjs');
const db = require('./db.cjs');
const browser = require('./browser.cjs');
const workspace = require('./workspace.cjs');
const runner = require('./runner.cjs');
const precheck = require('./precheck.cjs');
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

/**
 * Check an item off (or not). Every change is logged with its time, so the PC and the phone can merge their
 * checkmarks: whichever change is newer wins.
 */
function setDone(s, id, on, at = new Date().toISOString()) {
  s.done = s.done || {};
  s.doneLog = s.doneLog || {};
  s.doneLog[id] = { on: !!on, at };
  if (on) s.done[id] = at;
  else delete s.done[id];
}

// ---------- The copy in the student's cloud drive (for Kea on their phone) ----------
const cloud = require('./cloud.cjs');

/**
 * Bring in what the phone changed (phone.json in the drive folder): checkmarks, newest change winning, and Inbox
 * items read on the phone. Returns true when something changed here.
 */
let phoneSeen = 0;
function mergePhone() {
  const dir = cloud.target();
  if (!dir) return false;
  const file = path.join(dir, 'phone.json');
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return false;
  }
  if (st.mtimeMs === phoneSeen) return false;
  phoneSeen = st.mtimeMs;
  let phone;
  try {
    phone = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
  const s = readState();
  let changed = false;
  for (const [id, e] of Object.entries(phone.done || {})) {
    const cur = (s.doneLog || {})[id];
    if (e && e.at && (!cur || e.at > cur.at)) {
      setDone(s, id, e.on, e.at);
      changed = true;
    }
  }
  if (changed) writeState(s);
  const read = (phone.read || []).filter(Boolean);
  if (read.length) {
    const unread = new Set(precheck.readInbox().items.filter((i) => !i.read).map((i) => i.id));
    const scanUnread = new Set(runner.news().filter((n) => !n.read).map((n) => `scan:${n.id}`));
    const mine = read.filter((id) => unread.has(id));
    const scans = read.filter((id) => scanUnread.has(id)).map((id) => id.slice(5));
    if (mine.length) precheck.markInboxRead(mine);
    if (scans.length) runner.markNewsRead(scans);
    if (mine.length || scans.length) changed = true;
  }
  // Deleted on the phone (by content, since the phone's own checks name messages differently).
  const deletedKeys = (phone.deleted || []).filter((k) => typeof k === 'string');
  if (deletedKeys.length) {
    const known = new Set(precheck.readInbox().deletedKeys || []);
    const fresh = deletedKeys.filter((k) => !known.has(k));
    if (fresh.length) {
      runner.deleteNews([], fresh);
      precheck.deleteInbox([], fresh);
      changed = true;
    }
  }
  if (changed) BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('scholar:changed'));
  return changed;
}

/** What a scan sent (kea_notify) as an Inbox item. Older scan messages (daily overviews) have no kind: "news". */
const scanItem = (n) => ({ id: `scan:${n.id}`, kind: n.kind || 'news', course: n.course || '', title: n.title, body: n.body || '', at: n.at, url: n.links?.[0]?.url || '', links: n.links || [], read: !!n.read });

/** Everything the phone shows, in one object. Textbook paths become relative to the drive folder's Textbooks/. */
async function snapshot() {
  const P = profiles.paths();
  const done = readState().done || {};
  const day = (n) => localDate(new Date(Date.now() + n * 864e5));
  const courses = await db.courses(P.db, P.textbooks, done);
  const items = await db.items(P.db, P.textbooks, done, { from: day(-28), to: day(150) });
  const details = (await Promise.all(courses.map((c) => db.course(P.db, P.textbooks, done, c.id)))).filter(Boolean);
  const grades = {};
  for (const c of courses) grades[c.code] = precheck.readGrades().byCourse[c.code] || (await db.gradesFromChecks(P.db, c.id));
  // The Inbox as the phone shows it: Kea's own items and what scans found, with what's been read on either side.
  const inbox = [
    ...precheck.readInbox().items,
    ...runner.news().map(scanItem)
  ]
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, 300);
  const doneLog = readState().doneLog || {};
  // A PC path means nothing on the phone: textbook PDFs become their copy in the drive folder (Textbooks/<class>/<file>,
  // the same layout Kea mirrors), and any other path is left out.
  const fix = (v) => {
    if (typeof v === 'string' && /^[a-z]:[\\/]/i.test(v)) return /\.pdf$/i.test(v) ? `Textbooks/${path.basename(path.dirname(v))}/${path.basename(v)}` : null;
    if (Array.isArray(v)) return v.map(fix);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fix(x)]));
    return v;
  };
  // What was deleted on the PC, so the phone also hides its own copies.
  const inboxDeleted = (precheck.readInbox().deletedKeys || []).slice(-1500);
  return fix({ kea: 1, synced: new Date().toISOString(), profile: profiles.all().list.find((x) => x.id === profiles.active())?.name || '', home: browser.schoolInfo().home, courses, items, details, grades, inbox, inboxDeleted, doneLog });
}
const syncSoon = (delay) => cloud.schedule(snapshot, delay);

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
      timer = setTimeout(() => {
        BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('scholar:changed'));
        syncSoon();
      }, 800);
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
let lastInbox = 0;
async function tick() {
  // What the phone changed (checkmarks, read messages) comes in through the drive folder.
  try {
    if (mergePhone()) syncSoon(5000);
  } catch (err) {
    console.error('Phone merge', err);
  }
  // New announcements, every half hour or so (plain requests, no Claude), while nothing else is running.
  const every = Number(settings.get('scholar.inboxMinutes', 30)) || 0;
  if (every && !runner.status().running && Date.now() - lastInbox >= every * 60000 - 30000) {
    lastInbox = Date.now();
    precheck
      .pollAnnouncements()
      .then((ok) => ok && syncSoon(5000))
      .catch((err) => console.error('Inbox check', err));
  }
  try {
    if (settings.get('scholar.autoScan', true) === false || runner.status().running) return;
    // A run paused by a usage limit continues first, once the limit has reset; nothing else starts until then.
    const waiting = runner.pending();
    if (waiting) {
      if (new Date(waiting.until) <= new Date() && (await ready())) runner.resume();
      return;
    }
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
    setDone(s, id, done);
    writeState(s);
    syncSoon(5000);
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
  ipcMain.handle('scholar:pending', () => runner.pending());

  // The Inbox: announcements (from D2L directly) and what scans found (messages, grades, deadlines).
  ipcMain.handle('scholar:inbox', () => {
    const own = precheck.readInbox().items;
    const scans = runner.news().map(scanItem);
    return [...own, ...scans].sort((a, b) => String(b.at).localeCompare(String(a.at)));
  });
  ipcMain.handle('scholar:markInboxRead', (_e, ids) => {
    precheck.markInboxRead(ids ? ids.filter((i) => !i.startsWith('scan:')) : null);
    runner.markNewsRead(ids ? ids.filter((i) => i.startsWith('scan:')).map((i) => i.slice(5)) : null);
    syncSoon(5000);
    return true;
  });
  ipcMain.handle('scholar:deleteInbox', (_e, ids) => {
    const list = Array.isArray(ids) ? ids.map(String) : [];
    // What scans reported is remembered by its content too, so the phone hides its own copy of it.
    const scanKeys = runner.deleteNews(list.filter((i) => i.startsWith('scan:')).map((i) => i.slice(5)));
    precheck.deleteInbox(list.filter((i) => !i.startsWith('scan:')), scanKeys);
    syncSoon(5000);
    return true;
  });
  ipcMain.handle('scholar:checkInbox', () => precheck.pollAnnouncements());
  // Handing in a file: the folders it can go to, then D2L's own hand-in page with the file in its upload box.
  ipcMain.handle('scholar:handInTargets', async () => {
    let t = await precheck.handInTargets();
    // Nothing known yet: take a quick look at the class site first (no Claude).
    if (!t.some((c) => c.folders.length)) {
      await precheck.pollAnnouncements().catch(() => false);
      t = await precheck.handInTargets();
    }
    return t;
  });
  ipcMain.handle('scholar:handIn', (_e, ou, folderId, file) => browser.handIn(ou, folderId, file));
  // Grades: Kea's own check of the class site, or what the daily checks recorded before that ran.
  ipcMain.handle('scholar:grades', async (_e, courseId, code) => precheck.readGrades().byCourse[code] || (await db.gradesFromChecks(p().db, courseId)));
  // Links: class-site pages open in Kea's signed-in window; everything else in the web browser.
  ipcMain.handle('scholar:openLink', (_e, url) => {
    if (!/^https?:\/\//i.test(String(url))) return false;
    if (browser.isClassSite(url)) return browser.show(url);
    require('electron').shell.openExternal(url);
    return true;
  });
  // Study materials: practice exams and flashcards, made by Claude only when asked, then taken offline.
  const study = require('./study.cjs');
  ipcMain.handle('scholar:studyList', () => {
    const running = runner.status();
    const busy = new Set([running.running, ...running.queued].filter((j) => j && j.task === 'practice').map((j) => String(j.arg).split(/\s+/)[0]));
    study.settle((id) => busy.has(id));
    return study.list();
  });
  ipcMain.handle('scholar:studyGet', (_e, id) => study.get(id));
  ipcMain.handle('scholar:studyMake', async (_e, req) => {
    const id = await study.request(req);
    runner.run('practice', id, 'manual').then(() => {
      const e = study.list().find((x) => x.id === id);
      if (!e) return;
      const { Notification } = require('electron');
      const body = e.status === 'ready' ? `${e.count} ${e.kind === 'exam' ? 'questions' : 'cards'}, ready in My resources.` : e.error || 'It didn’t work. Try again.';
      if (Notification.isSupported()) new Notification({ title: e.status === 'ready' ? e.title : `Couldn’t make ${e.title}`, body }).show();
      BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('scholar:changed'));
    });
    return id;
  });
  ipcMain.handle('scholar:studyDelete', (_e, id) => study.remove(id));
  ipcMain.handle('scholar:studyAttempt', (_e, id, a) => study.saveAttempt(id, a));
  ipcMain.handle('scholar:studyKnown', (_e, id, known) => study.setKnown(id, known));
  ipcMain.handle('scholar:resume', (_e, task) => (runner.pending() ? runner.resume() : runner.resumeLast(task || 'import')));

  // Developer aid (unpackaged builds only): read a page through the class-site browser.
  if (!require('electron').app.isPackaged) {
    ipcMain.handle('scholar:debugOpen', (_e, url) => browser.open(url));
    // The pre-check on its own, without starting Claude or saving a new baseline.
    ipcMain.handle('scholar:debugPrecheck', async () => {
      const r = await precheck.run();
      const { commit, ...rest } = r;
      return rest;
    });
  }

  watch();
  try {
    runner.adoptStopped();
  } catch {}
  ipcMain.handle('scholar:cloudDrives', () => ({ drives: cloud.drives(), target: cloud.target() }));
  ipcMain.handle('scholar:syncNow', () => cloud.sync(snapshot));
  syncSoon(90000);
  // Phone changes arrive within about a minute of OneDrive bringing them down.
  setInterval(() => {
    try {
      if (mergePhone()) syncSoon(5000);
    } catch {}
  }, 60000);
  setTimeout(tick, 60000);
  setInterval(tick, 5 * 60000);
}

module.exports = { register };
