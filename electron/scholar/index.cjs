// Kea Scholar: classes, their textbooks and the calendar, for the active profile.
const { ipcMain, BrowserWindow, app } = require('electron');
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
// kea.json is written all-or-nothing with a .bak of the last good copy (profiles.writeJsonSafe): a copy cut short (Kea
// killed mid-write) is read from the .bak, and one that can't be read at all is set aside before anything is saved
// over it, so a damaged file never silently turns into "nothing checked off".
function readState() {
  const { value } = profiles.readJsonSafe(profiles.paths().state, null);
  return value && typeof value === 'object' && !Array.isArray(value) ? value : { done: {} };
}
function writeState(s) {
  profiles.writeJsonSafe(profiles.paths().state, s);
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
const courseImages = require('./courseImages.cjs');

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
  let phone;
  try {
    phone = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // Half downloaded (the drive app still bringing it down): looked at again next time, so no tap is lost.
    return false;
  }
  if (!phone || typeof phone !== 'object') return false;
  // (Marked as seen only once its changes are in: if bringing them in fails, it's tried again next time.)
  const changed = applyMarks({ ...phone, read: freshPhoneReads(phone.read) });
  phoneSeen = st.mtimeMs;
  return changed;
}

/**
 * The phone sends every message it has ever read. Only ids new to that list since the last merge count: an
 * announcement the teacher edits comes back unread here, and an old read on the phone mustn't mark it read again
 * (the same guard as another computer's reads in devices.cjs marksOf). The first merge only notes the list.
 */
function freshPhoneReads(list) {
  const read = (Array.isArray(list) ? list : []).filter((id) => typeof id === 'string');
  const s = readState();
  const first = !Array.isArray(s.phoneReadSeen);
  const seen = new Set(s.phoneReadSeen || []);
  const fresh = first ? [] : read.filter((id) => !seen.has(id));
  const next = [...new Set([...(s.phoneReadSeen || []), ...read])].slice(-3000);
  if (first || fresh.length || next.length !== seen.size) {
    s.phoneReadSeen = next;
    writeState(s);
  }
  return fresh;
}

/**
 * Another device's changes (the phone's phone.json, or another computer's — see devices.cjs): checkmarks, newest change
 * winning, Inbox items read or deleted there, and study progress. Returns true when something changed here.
 */
function applyMarks(phone) {
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
  if (phone.study && devices.mergeStudy(phone.study)) changed = true;
  // The theme picked on the phone, when it's newer than this computer's.
  const look = phone.look;
  if (look && typeof look.theme === 'string' && require('../themes.json')[look.theme] && look.at && look.at > settings.get('appearance.themeAt', '') && look.theme !== settings.get('appearance.theme', 'dark'))
    settings.set({ 'appearance.theme': look.theme, 'appearance.themeAt': look.at });
  // What the phone asked for (more questions, worked steps, a check now), each done once, through the same checks as
  // another computer's requests (devices.cjs).
  const asks = (Array.isArray(phone.requests) ? phone.requests : []).filter((r) => r && typeof r.id === 'string');
  if (asks.length) {
    const s2 = readState();
    const seen = new Set(s2.phoneRequests || []);
    const fresh = asks.filter((r) => !seen.has(r.id) && Date.now() - Date.parse(r.at || 0) < 7 * 864e5);
    if (fresh.length) {
      s2.phoneRequests = [...seen, ...fresh.map((r) => r.id)].slice(-500);
      writeState(s2);
      for (const r of fresh) devices.serveRequest({ ...r, from: 'your phone' }).then(() => syncSoon(5000));
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
  const courses = courseImages.withImages(await db.courses(P.db, P.textbooks, done));
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
  // The class site's mailbox, for the phone's Messages tab.
  const mail = require('./messages.cjs').phoneMail();
  return {
    // The theme (Settings → Appearance), so Kea on the phone looks the same; the newer choice wins either way.
    look: { theme: settings.get('appearance.theme', 'dark'), at: settings.get('appearance.themeAt', ''), classColors: settings.get('scholar.classColors', {}) },
    ...fix({ kea: 1, synced: new Date().toISOString(), profile: profiles.all().list.find((x) => x.id === profiles.active())?.name || '', home: browser.schoolInfo().home, platform: browser.schoolInfo().platform, courses, items, details, grades, inbox, inboxDeleted, mail, doneLog }),
    // The study folder as it is here (sets, saved questions, progress), for the phone to study from; its pictures are in
    // the library zip. A set still being written stays out until it's ready.
    study: studyFiles()
  };
}

/** The study folder's files (not its pictures) as { "sets/exam-x.json": contents }. */
function studyFiles() {
  const dir = path.join(profiles.paths().dir, 'study');
  const out = {};
  const walk = (d, rel) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name !== 'images') walk(path.join(d, e.name), `${rel}${e.name}/`);
      } else if (e.name.endsWith('.json')) {
        try {
          out[`${rel}${e.name}`] = JSON.parse(fs.readFileSync(path.join(d, e.name), 'utf8'));
        } catch {}
      }
    }
  };
  walk(dir, '');
  return out;
}
// The phone copy is written by the computer that scans; any other computer only sends its changes to that one.
const syncSoon = (delay) => {
  if (!devices.follower()) cloud.schedule(snapshot, delay);
  devices.soon(delay);
};
// A new theme goes to the phone with the next copy (the phone takes it when it's newer than its own).
const themeKey = (all) => `${all['appearance.theme'] || 'dark'}|${all['appearance.themeAt'] || ''}`;
let lastTheme = null;
settings.onChange((all) => {
  if (lastTheme === null) lastTheme = themeKey(all);
  else if (themeKey(all) !== lastTheme) {
    lastTheme = themeKey(all);
    syncSoon(3000);
  }
});

// ---------- Other computers (the same classes on more than one PC, scanned by only one of them) ----------
const devices = require('./devices.cjs');
devices.configure({ readState, writeState, applyMarks, syncSoon: (d) => syncSoon(d), ready: () => ready(), banks: () => keepBanks() });

// ---------- Tell the window when a scan changes the classes ----------
let watcher = null;
let studyWatcher = null;
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
  // Study sets and progress changing (a set finished, an answer, a star) go to the phone too.
  studyWatcher?.close();
  studyWatcher = null;
  const sd = path.join(profiles.paths().dir, 'study');
  try {
    fs.mkdirSync(sd, { recursive: true });
    studyWatcher = fs.watch(sd, { recursive: true }, () => syncSoon());
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
  return !!(c.claude && c.uv && c.account.loggedIn && c.engineReady && browser.schoolInfo().home && require('../account.cjs').verified());
}

/**
 * Once a day after the chosen time (5:00 by default, like the scheduled task it replaces): the class check (which
 * also imports any new class) and the readings-and-links update, each as often as chosen (every day by default), then
 * any textbook chapters still to write.
 */
let lastInbox = 0;
async function tick() {
  // Another computer does the scanning (and takes in the phone's changes); this one only follows it.
  if (devices.follower()) return;
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
      .catch((err) => console.error('Inbox check', err))
      // Then the class site's whole mailbox (the primary only: one device reads the class site).
      .then(() => !devices.follower() && require('./messages.cjs').syncMailbox())
      .catch((err) => console.error('Mailbox', err))
      // Then any class picture that's missing or a few weeks old (for the classes' cards on Home).
      .then(() => courseImages.refresh())
      .then((n) => n && (BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('scholar:changed')), syncSoon(5000)))
      .catch((err) => console.error('Class pictures', err));
  }
  try {
    // How often (days) the class check runs: every day unless the student chose otherwise; 0 = only when asked. (The
    // older on/off switch, if it was turned off, still means off.)
    const checkEvery = Number(settings.get('scholar.scanEvery', settings.get('scholar.autoScan', true) === false ? '0' : '1'));
    if (runner.status().running) return;
    // Runs set aside (a usage limit, a server problem, Kea closing mid-run) continue first, once their time comes, even
    // when scheduled checks are off (they were started already); nothing else starts until then.
    const waiting = runner.pending();
    if (waiting) {
      if (new Date(waiting.until) <= new Date() && (await ready())) runner.resume();
      return;
    }
    if (!checkEvery) return;
    const [h, m] = String(settings.get('scholar.scanTime', '05:00')).split(':').map(Number);
    const now = new Date();
    if (now.getHours() * 60 + now.getMinutes() < (h || 0) * 60 + (m || 0)) return;
    const s = readState();
    s.lastRuns = s.lastRuns || {};
    // Once a day at most, this decides what's due today.
    const today = localDate();
    // (Once today's checks are done, chapters short of questions get them, one at a time.)
    if (s.lastRuns.daily === today) {
      // (The syllabus check has its own day: it also runs on a day whose checks were done before it existed.)
      if (s.lastRuns.curriculum !== today && settings.get('scholar.curriculumCheck', true) !== false && (await ready())) {
        s.lastRuns.curriculum = today;
        writeState(s);
        await runner.curriculumCheck('schedule').catch((err) => console.error('Curriculum', err));
      }
      return keepBanks();
    }
    if (Date.now() < offlineUntil) return;
    if (!(await ready())) return;
    const daysSince = (d) => (d ? Math.round((new Date(`${today}T12:00`) - new Date(`${d}T12:00`)) / 864e5) : Infinity);
    const weekday = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][now.getDay()];
    const syncOn = settings.get('scholar.weeklyDay', 'daily');
    const checkDue = daysSince(s.lastRuns.check || s.lastRuns.daily) >= checkEvery;
    // The readings-and-links update: every day, or on its weekday (or once a week has gone by without one).
    const syncDue = daysSince(s.lastRuns.sync) >= 1 && (syncOn === 'daily' || syncOn === weekday || daysSince(s.lastRuns.sync) >= 7);
    const before = { ...s.lastRuns };
    s.lastRuns.daily = today;
    if (checkDue) s.lastRuns.check = today;
    if (syncDue) s.lastRuns.sync = today;
    writeState(s);
    if (checkDue) {
      const started = Date.now();
      await runner.run('daily', '', 'schedule');
      // Offline or asleep during the check: today isn't done, so the next tick tries again (in 15 minutes or more).
      const last = runner.activity().find((e) => e.task === 'daily' && Date.parse(e.start) >= started - 1000);
      if (last && /offline or asleep/.test(last.summary || '')) {
        const st = readState();
        st.lastRuns = { ...st.lastRuns, daily: before.daily, check: before.check, sync: before.sync };
        writeState(st);
        offlineUntil = Date.now() + 15 * 60e3;
        return;
      }
    }
    if (syncDue) await runner.run('sync', '', 'schedule');
    // Every class's chapters against its syllabus (Kea's own check; a curriculum run only for a class with gaps), before
    // textbook chapters and question banks are written from them.
    if (settings.get('scholar.curriculumCheck', true) !== false && !runner.pending()) {
      const st = readState();
      st.lastRuns = { ...st.lastRuns, curriculum: today };
      writeState(st);
      await runner.curriculumCheck('schedule').catch((err) => console.error('Curriculum', err));
    }
    if ((checkDue || syncDue) && settings.get('scholar.studyPdfs', true) !== false) await runner.run('study', '', 'schedule');
    keepBanks();
  } catch (err) {
    console.error('Scholar schedule', err);
  }
}

// ---------- Question banks ----------
// Every chapter with a textbook keeps a bank of saved questions (25 by default), and gets more when the student runs
// low. Made by the primary only, one chapter at a time, each bank written once and then reused on every device.
let banking = false;
let offlineUntil = 0;
// Question-bank runs allowed in one day.
const BANK_RUNS = 12;
let bankRuns = { day: '', n: 0 };
async function keepBanks() {
  if (banking || devices.follower() || settings.get('scholar.questionBanks', true) === false || !require('../account.cjs').verified()) return;
  if (!(await workspace.check().then((c) => c.account?.loggedIn).catch(() => false))) return;
  banking = true;
  try {
    const study = require('./study.cjs');
    for (let n = 0; n < 200; n++) {
      // At most BANK_RUNS a day, so nothing can turn into a loop that spends the student's Claude usage.
      const today = new Date().toDateString();
      if (bankRuns.day !== today) bankRuns = { day: today, n: 0 };
      if (bankRuns.n >= BANK_RUNS) break;
      const p = profiles.paths();
      const need = study.bankNeed(await db.textbookChapters(p.db, p.textbooks), Number(settings.get('scholar.bankSize', 25)) || 25);
      if (!need) break;
      const had = study.catalog('exam', need.courseId, need.chapters).length;
      bankRuns.n++;
      const { id } = await study.request(need);
      BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('scholar:changed'));
      const done = await runner.run('practice', id, 'schedule');
      BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('scholar:changed'));
      // Dropped (a usage-limit pause, a profile switch) or failed: try again on the next check.
      if (!done || study.list().find((e) => e.id === id)?.status !== 'ready') {
        if (!done) study.remove(id);
        break;
      }
      // A finished bank that didn't add to its chapter's count: stop rather than ask for the same chapter again.
      if (study.catalog('exam', need.courseId, need.chapters).length <= had) {
        console.error('Question banks: a run added no countable questions to', need.chapters.join(', '));
        break;
      }
    }
    // Picture questions for the chapters that test identification (lab practicals, structures), soonest test first.
    for (let n = 0; n < 40 && settings.get('scholar.pictureQuestions', true) !== false; n++) {
      const today = new Date().toDateString();
      if (bankRuns.day !== today) bankRuns = { day: today, n: 0 };
      if (bankRuns.n >= BANK_RUNS) break;
      const p = profiles.paths();
      const need = study.pictureNeed(await db.textbookChapters(p.db, p.textbooks), await db.identifyingChapters(p.db));
      if (!need) break;
      bankRuns.n++;
      const { id } = await study.request(need);
      BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('scholar:changed'));
      const done = await runner.run('practice', id, 'schedule');
      BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('scholar:changed'));
      if (!done || done.paused || study.list().find((e) => e.id === id)?.status !== 'ready') break;
    }
    // (Worked steps for missed questions are written by the depth review, in the same pass that fixes their explanations; a separate run
    // per chapter only when the student asks for one, from a missed question.)
    for (let n = 0; n < 50 && settings.get('scholar.workedStepsRuns', false) === true; n++) {
      const today = new Date().toDateString();
      if (bankRuns.day !== today) bankRuns = { day: today, n: 0 };
      if (bankRuns.n >= BANK_RUNS) break;
      const p = profiles.paths();
      const chapters = await db.textbookChapters(p.db, p.textbooks);
      const need = study.stepsNeed(chapters);
      if (!need) break;
      const code = (await db.courses(p.db, p.textbooks, {}).catch(() => [])).find((c) => c.id === need.courseId)?.code;
      if (!code) break;
      bankRuns.n++;
      const done = await runner.run('steps', `${code} ${need.label}`, 'schedule');
      // (No progress on that chapter: stop rather than ask again today.)
      if (!done || done.paused || study.stepsNeed([{ courseId: need.courseId, label: need.label }])?.missing >= need.missing) break;
    }
  } catch (err) {
    console.error('Question banks', err);
  } finally {
    banking = false;
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
  ipcMain.handle('scholar:courses', async () => courseImages.withImages(await db.courses(p().db, p().textbooks, readState().done || {})));
  // Each class's picture from the class site, read again now (Settings → Scholar).
  ipcMain.handle('scholar:courseImages', async () => {
    const n = await courseImages.refresh({ force: true });
    if (n) (BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('scholar:changed')), syncSoon(5000));
    return n;
  });
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
  ipcMain.handle('scholar:setSchoolHome', (_e, home, platform) => browser.setHome(home, platform));
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
  // On a device that isn't the primary, the primary is asked to (through the drive), so nothing runs twice.
  ipcMain.handle('scholar:run', (_e, task, arg) => {
    // School mode needs a Kea account with a verified email.
    if (!require('../account.cjs').verified()) throw new Error('Set up your Kea account with a verified email first (Scholar → your name → Your account).');
    if (task !== 'probe' && devices.follower()) return devices.relay({ task, arg: arg || '' });
    runner.run(task, arg || '', 'manual').then(() => task === 'study' && keepBanks());
    return true;
  });
  // Your devices: which one scans, the drive they sync through, and bringing classes in on a new one.
  const devicesChanged = () => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('scholar:changed'));
  ipcMain.handle('scholar:devices', () => devices.status());
  ipcMain.handle('scholar:devicesFind', () => devices.find());
  ipcMain.handle('scholar:devicesJoin', async (_e, choice) => {
    if (runner.status().running) throw new Error('A class scan is running here. Try again when it finishes.');
    const r = await devices.join(choice);
    watch();
    return r;
  });
  ipcMain.handle('scholar:makePrimary', (_e, id) => {
    if (runner.status().running && id !== require('../settings.cjs').get('scholar.pcId')) throw new Error('A class scan is running on this device. Make another device the primary when it finishes (or stop it first).');
    return devices.makePrimary(id);
  });
  ipcMain.handle('scholar:setDrive', async (_e, choice) => {
    settings.set({ 'scholar.cloud': choice });
    await devices.step();
    watch();
    devicesChanged();
    return devices.status();
  });
  ipcMain.handle('scholar:stop', () => {
    if (devices.follower()) return (devices.relay({ task: 'stop' }), true);
    runner.stop();
    return true;
  });
  ipcMain.handle('scholar:runStatus', () => runner.status());
  ipcMain.handle('scholar:activity', () => runner.activity());
  ipcMain.handle('scholar:news', () => runner.news());
  ipcMain.handle('scholar:markNewsRead', (_e, ids) => runner.markNewsRead(ids));
  ipcMain.handle('scholar:pending', () => runner.pending());

  // The Inbox: announcements (from the class site directly) and what scans found (messages, grades, deadlines).
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
  ipcMain.handle('scholar:checkInbox', () => {
    if (!devices.follower()) return precheck.pollAnnouncements();
    devices.relay({ task: 'inbox' });
    return true;
  });
  // Handing in a file: the folders it can go to, then the class site's own hand-in page with the file in its upload box.
  ipcMain.handle('scholar:handInTargets', async () => {
    let t = await precheck.handInTargets();
    // Nothing known yet: take a quick look at the class site first (no Claude).
    if (!t.some((c) => c.folders.length) && !devices.follower()) {
      await precheck.pollAnnouncements().catch(() => false);
      t = await precheck.handInTargets();
    }
    return t;
  });
  ipcMain.handle('scholar:handIn', (_e, ou, folderId, file) => browser.handIn(ou, folderId, file));
  // Grades: Kea's own check of the class site, or what the daily checks recorded before that ran.
  ipcMain.handle('scholar:grades', async (_e, courseId, code) => precheck.readGrades().byCourse[code] || (await db.gradesFromChecks(p().db, courseId)));
  // Links: class-site pages open in Kea's signed-in window; everything else in the web browser.
  // Reply to a class-site message: the message opens with its Reply already pressed (the student writes and sends).
  // Item history and "what changed" (the engine's append-only record of every change, with runs and reasons).
  const engineJson = async (args) => {
    const uv = await workspace.findUv();
    const r = await workspace.runHidden(uv, ['run', 'academic-sync', ...args], { cwd: p().workspace, env: { ...workspace.engineEnv(uv), KEA_TASK: 'view', KEA_RUN_ID: `${Date.now()}` } });
    const at = r.out.indexOf('{');
    if (at < 0) throw new Error((r.err || r.out || 'No answer from the engine.').slice(0, 300));
    return JSON.parse(r.out.slice(at));
  };
  // (Rules are worked out from every document, so each class's list is kept for ten minutes.)
  // A class's chapters against its syllabus: outcomes and the chapters that teach each, guidelines, what's missing.
  const curriculumCache = new Map();
  ipcMain.handle('scholar:curriculum', async (_e, code, fresh) => {
    const k = String(code).replace(/[^\w]/g, '');
    const hit = curriculumCache.get(k);
    if (!fresh && hit && Date.now() - hit.at < 10 * 60e3) return hit.value;
    const value = await engineJson(['curriculum', '--course', k, '--json']);
    curriculumCache.set(k, { at: Date.now(), value });
    return value;
  });
  const rulesCache = new Map();
  ipcMain.handle('scholar:courseRules', async (_e, code) => {
    const k = String(code).replace(/[^\w]/g, '');
    const hit = rulesCache.get(k);
    if (hit && Date.now() - hit.at < 10 * 60e3) return hit.value;
    const value = await engineJson(['course-rules', '--course', k, '--json']);
    rulesCache.set(k, { at: Date.now(), value });
    return value;
  });
  ipcMain.handle('scholar:itemHistory', (_e, id) => engineJson(['item-history', String(id).replace(/[^\w-]/g, ''), '--json']));
  ipcMain.handle('scholar:changes', (_e, opts = {}) => {
    const args = ['changes', '--json'];
    if (/^\d{4}-\d{2}-\d{2}$/.test(opts.since || '')) args.push('--since', opts.since);
    if (/^[A-Z]{2,5}\d{3,5}[A-Z]?$/i.test(opts.course || '')) args.push('--course', opts.course);
    return engineJson(args);
  });
  // Class-site messages like email: read in full, draft and send from Kea (messages.cjs).
  require('./messages.cjs').register({ browser, precheck, db });
  ipcMain.handle('scholar:replyMessage', async (_e, url, course) => {
    const ou = course ? (await db.watchList(p().db)).find((c) => c.code === course)?.ou : null;
    return browser.reply(typeof url === 'string' ? url : '', ou);
  });
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
    // (A set whose run is set aside to continue later is still being made.)
    const busy = new Set([running.running, ...(running.parallel || []), ...running.queued, ...(runner.pending()?.runs || [])].filter((j) => j && j.task === 'practice').map((j) => String(j.arg).split(/\s+/)[0]));
    // (Another device's sets are settled by the device making them.)
    if (!devices.follower()) study.settle((id) => busy.has(id));
    return study.list();
  });
  ipcMain.handle('scholar:studyGet', (_e, id) => study.get(id));
  ipcMain.handle('scholar:studyMake', async (_e, req) => {
    const { id, ready, pick } = await study.request(req);
    // Made by the computer that scans (it has the class files); the set comes back here when it's ready. A set from
    // saved questions is ready here at once, and the primary saves the same one (the same picks) for every device.
    if (devices.follower()) {
      devices.relay({ task: 'practice', req: { ...req, id, pick } });
      return id;
    }
    if (ready) {
      devices.soon();
      return id;
    }
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
  ipcMain.handle('scholar:studySaved', (_e, req) => study.saved(req));
  ipcMain.handle('scholar:studyImage', (_e, rel) => study.imageData(String(rel || '')));
  // Worked steps for a question's chapter, now (the student missed one that has none yet).
  ipcMain.handle('scholar:studyStepsFor', (_e, k) => {
    const w = study.whereIs(String(k));
    if (!w?.courseCode || !w.chapter) throw new Error('Kea couldn’t find which chapter this question is from.');
    const arg = `${w.courseCode} ${w.chapter}`;
    if (devices.follower()) return (devices.relay({ task: 'steps', arg }), { queued: true, ...w });
    const st = runner.status();
    if (![st.running, ...(st.parallel || []), ...st.queued].some((j) => j && j.task === 'steps' && j.arg === arg)) runner.run('steps', arg, 'manual');
    return { queued: true, ...w };
  });
  // The saved questions of some chapters with how each has gone, for choosing exactly what to study.
  ipcMain.handle('scholar:studyPool', (_e, { courseId, chapters }) => study.pool(String(courseId || ''), Array.isArray(chapters) ? chapters.map(String) : []));
  // The textbook PDF open in a tab: which class and chapters it is, for its Quiz me button.
  ipcMain.handle('scholar:textbookOf', (_e, file) => db.textbookOf(p().db, p().textbooks, file));
  // A chapter with no saved questions yet: write its bank now (on the primary). False when Claude isn't available.
  ipcMain.handle('scholar:studyBanks', async () => {
    if (devices.follower()) return (devices.relay({ task: 'banks', arg: '' }), true);
    const ok = await workspace.check().then((c) => !!c.account?.loggedIn).catch(() => false);
    if (ok) keepBanks();
    return ok;
  });
  ipcMain.handle('scholar:studyDelete', (_e, id) => study.remove(id));
  // Running low on a chapter's questions: more get written, ~5 s after an attempt. The Study stream saves every 10
  // answers, so its saves only check on leaving the stream (`final`) or once every 25 answers.
  let banksTimer = null;
  let streamAnswers = 0;
  const banksSoon = () => (clearTimeout(banksTimer), (banksTimer = setTimeout(keepBanks, 5000)));
  ipcMain.handle('scholar:studyAttempt', (_e, id, a) => {
    study.saveAttempt(id, a);
    if (!study.isStream(id)) banksSoon();
    else {
      streamAnswers += Array.isArray(a?.items) ? a.items.length : 0;
      if (a?.final || streamAnswers >= 25) (streamAnswers = 0), banksSoon();
    }
    return true;
  });
  ipcMain.handle('scholar:studyKnown', (_e, id, known) => study.setKnown(id, known));
  // The student's own sets, stars, Learn and Match progress, and spaced review (all kept on this computer).
  ipcMain.handle('scholar:studySaveMine', (_e, set) => study.saveMine(set));
  ipcMain.handle('scholar:studyStar', (_e, k, on) => study.star(String(k), !!on));
  ipcMain.handle('scholar:studyLearn', (_e, id, levels) => study.learnSet(id, levels));
  ipcMain.handle('scholar:studyMatch', (_e, id, ms) => study.matchBest(id, Number(ms)));
  ipcMain.handle('scholar:studyReview', (_e, opts) => study.reviewQueue(opts || {}));
  ipcMain.handle('scholar:studyReviewMark', (_e, k, grade, ctx) => study.reviewMark(String(k), ['again', 'good', 'easy'].includes(grade) ? grade : 'good', ctx || {}));
  ipcMain.handle('scholar:resume', (_e, task) => {
    if (devices.follower()) return (devices.relay({ task: 'resume', arg: task || '' }), true);
    // Nothing set aside: nothing to continue. (Falling back to the last run of a task could restart an import that
    // already finished.)
    return runner.pending() ? runner.resume() : false;
  });

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
  app.on('before-quit', () => runner.shutdown());
  ipcMain.handle('scholar:cloudDrives', () => ({ drives: cloud.drives(), target: cloud.target() }));
  ipcMain.handle('scholar:syncNow', async () => {
    await devices.step();
    return devices.follower() ? null : cloud.sync(snapshot);
  });
  syncSoon(90000);
  // Phone and other computers' changes arrive within about a minute of the drive bringing them down.
  setTimeout(() => devices.step(), 15000);
  setInterval(async () => {
    await devices.step();
    try {
      if (!devices.follower() && mergePhone()) syncSoon(5000);
    } catch {}
  }, 60000);
  setTimeout(tick, 60000);
  setInterval(tick, 5 * 60000);
}

module.exports = { register };
