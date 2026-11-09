// Kea Scholar: classes, their textbooks and the calendar, from every connected class site at once (sites.cjs). Each
// site keeps its own folder (profiles.cjs); what's read here is all of them together, and what's changed goes to the
// site it's from.
const { ipcMain, BrowserWindow, app } = require('electron');
const fs = require('fs');
const path = require('path');
const profiles = require('./profiles.cjs');
const sites = require('./sites.cjs');
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
const { handleApp } = require('../ipcGuard.cjs');

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
 *
 * The phone shows every class site, so each checkmark, read message and withdrawn class goes to the site its id says;
 * what's deleted (by content) to every site, and the rest (study progress, the theme, requests) to the first site.
 */
function applyMarks(phone) {
  if (!phone || typeof phone !== 'object') return false;
  const home = profiles.home();
  const parts = new Map([[home, { ...phone, done: {}, read: [], withdrawn: null }]]);
  const part = (ws) => parts.get(ws) || (parts.set(ws, { done: {}, read: [], deleted: phone.deleted }), parts.get(ws));
  for (const [k, e] of Object.entries(phone.done || {})) {
    const { ws, id } = profiles.split(k);
    part(ws).done[id] = e;
  }
  for (const k of phone.read || []) {
    if (typeof k !== 'string') continue;
    const { ws, id } = profiles.split(k);
    part(ws).read.push(id);
  }
  if (phone.withdrawn && typeof phone.withdrawn === 'object')
    for (const [k, e] of Object.entries(phone.withdrawn)) {
      const { ws, id } = profiles.split(k);
      part(ws).withdrawn = { ...(part(ws).withdrawn || {}), [id]: e };
    }
  // (What was deleted is matched by its content: every site checks.)
  for (const ws of profiles.ids()) if (phone.deleted) part(ws);
  let changed = false;
  for (const [ws, p] of parts) if (profiles.within(ws, () => applyMarksHere(p, ws === home))) changed = true;
  if (changed) BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('scholar:changed'));
  return changed;
}
function applyMarksHere(phone, first) {
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
  // Classes withdrawn from (or not) on the phone or another computer: the newer change wins (withdrawn.cjs).
  if (phone.withdrawn && require('./withdrawn.cjs').merge(profiles.paths().dir, phone.withdrawn)) changed = true;
  if (!first) return changed;
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
  return changed;
}

/** What a scan sent (kea_notify) as an Inbox item. Older scan messages (daily overviews) have no kind: "news". */
const scanItem = (n) => ({ id: `scan:${n.id}`, kind: n.kind || 'news', course: n.course || '', title: n.title, body: n.body || '', at: n.at, url: n.links?.[0]?.url || '', links: n.links || [], read: !!n.read });

/**
 * Everything the phone shows, in one object, from every class site (ids from a site other than the first carry it in
 * front, as in Kea's window; `sites` names them). Textbook paths become relative to the drive folder's Textbooks/.
 */
async function snapshot() {
  const parts = (await sites.each(() => snapshotSite())).filter((x) => x.value);
  const home = parts.find((x) => x.ws === profiles.home())?.value || parts[0]?.value;
  if (!home) return snapshotSite();
  if (parts.length === 1) return home;
  const join = (key) => parts.flatMap(({ ws, value }) => sites.tag(ws, value[key] || []));
  const keyed = (key) => Object.assign({}, ...parts.map(({ ws, value }) => sites.tagKeys(ws, value[key] || {})));
  return {
    ...home,
    sites: parts.map(({ ws, value }) => ({ id: ws, name: profiles.nameOf(ws), home: value.home || '', platform: value.platform || '' })),
    courses: join('courses'),
    items: join('items').sort((a, b) => String(a.date).localeCompare(String(b.date))),
    details: join('details'),
    // (Grades are by class code: a code two sites both have keeps the first site's.)
    grades: Object.assign({}, ...parts.map((x) => x.value.grades || {}).reverse()),
    inbox: join('inbox').sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 300),
    inboxDeleted: parts.flatMap((x) => x.value.inboxDeleted || []).slice(-1500),
    mail: join('mail'),
    doneLog: keyed('doneLog'),
    withdrawn: keyed('withdrawn')
  };
}
/** One class site's part of the phone copy. */
async function snapshotSite() {
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
    ...fix({ kea: 1, synced: new Date().toISOString(), profile: profiles.all().list.find((x) => x.id === profiles.active())?.name || '', home: browser.schoolInfo().home, platform: browser.schoolInfo().platform, courses, items, details, grades, inbox, inboxDeleted, mail, doneLog, withdrawn: require('./withdrawn.cjs').read(P.dir).log }),
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
  if (devices.publishes()) cloud.schedule(snapshot, delay);
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
devices.configure({ readState, writeState, applyMarks, syncSoon: (d) => syncSoon(d), ready: () => ready(), banks: () => keepBanks(), run: (t, a, w) => runAnywhere(t, a, w), pollAll: () => pollAll() });

// ---------- Tell the window when a scan changes the classes ----------
// (Every class site's database and study folder.)
let watchers = [];
function watch() {
  for (const w of watchers) w.close();
  watchers = [];
  let timer = null;
  for (const ws of profiles.ids()) {
    const P = profiles.paths(ws);
    const dir = path.dirname(P.db);
    if (fs.existsSync(dir))
      try {
        watchers.push(
          fs.watch(dir, (_e, name) => {
            if (!String(name || '').startsWith('academic_sync.db')) return;
            clearTimeout(timer);
            timer = setTimeout(() => {
              BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('scholar:changed'));
              syncSoon();
            }, 800);
          })
        );
      } catch {}
    // Study sets and progress changing (a set finished, an answer, a star) go to the phone too.
    const sd = path.join(P.dir, 'study');
    try {
      fs.mkdirSync(sd, { recursive: true });
      watchers.push(fs.watch(sd, { recursive: true }, () => syncSoon()));
    } catch {}
  }
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
 * Once a day after the chosen time (5:00 by default, like the scheduled task it replaces): the class check (which
 * also imports any new class) and the readings-and-links update, each as often as chosen (every day by default), then
 * any textbook chapters still to write.
 */
// (Per class site.)
const lastInbox = new Map();
async function tick() {
  // What the phone changed (checkmarks, read messages) comes in through the drive folder.
  try {
    // (Not the phone of another device whose classes this one hasn't joined, nor while another computer scans.)
    if (!devices.follower() && devices.publishes() && mergePhone()) syncSoon(5000);
  } catch (err) {
    console.error('Phone merge', err);
  }
  // Then each class site's own schedule, one after another.
  for (const ws of profiles.ids()) await profiles.within(ws, () => tickSite()).catch((err) => console.error('Scholar schedule', err));
}
async function tickSite() {
  // Another computer does the scanning (and takes in the phone's changes); this one only follows it.
  if (devices.follower()) return;
  // A site with no class site saved (classes only from Kea, or study on its own) has nothing to check.
  if (!browser.schoolInfo().home) return;
  // New announcements, every half hour or so (plain requests, no Claude), while nothing else is running.
  const every = Number(settings.get('scholar.inboxMinutes', 30)) || 0;
  const site = profiles.active();
  if (every && !runner.status().running && Date.now() - (lastInbox.get(site) || 0) >= every * 60000 - 30000) {
    lastInbox.set(site, Date.now());
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
      // Then a step-by-step guide for every assignment that has none yet (or that the teacher changed), once a day.
      if (s.lastRuns.guides !== today && settings.get('scholar.guides', true) !== false && !runner.pending() && (await ready())) {
        const st = readState();
        st.lastRuns = { ...st.lastRuns, guides: today };
        writeState(st);
        await runner.run('guides', '', 'schedule').catch((err) => console.error('Guides', err));
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
  if (banking || devices.follower() || settings.get('scholar.questionBanks', true) === false) return;
  if (!(await workspace.check().then((c) => c.account?.loggedIn).catch(() => false))) return;
  banking = true;
  try {
    // (Every class site's chapters, one site after another, within the same daily limit.)
    for (const ws of profiles.ids()) await profiles.within(ws, () => banksHere());
  } catch (err) {
    console.error('Question banks', err);
  } finally {
    banking = false;
  }
}
async function banksHere() {
  if (devices.follower()) return;
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
  }
}

// ---------- Every class site together ----------
const sortItems = (list) => list.sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.start || a.due || '').localeCompare(String(b.start || b.due || '')));

/** What a class site is called where its classes are shown: its own name, or its address when it has the default one. */
function siteLabel(ws, info = browser.schoolInfo()) {
  const n = profiles.nameOf(ws);
  return /^(school|personal|profile|class site \d+)$/i.test(n) && info.host ? info.host.replace(/^(d2l|elearn|elearning|online|learn|lms|canvas|brightspace|my|www)\./i, '') : n;
}

/** The class sites with each one's status: [{ id, name, label, home, host, platform, hasData, first, lastCheck }]. */
function sitesNow() {
  return profiles.ids().map((ws) =>
    profiles.within(ws, () => {
      const s = browser.schoolInfo();
      let last = null;
      try {
        last = runner.activity().find((e) => e.end) || null;
      } catch {}
      return { id: ws, name: profiles.nameOf(ws), label: siteLabel(ws, s), home: s.home, host: s.host, platform: s.platform, hasData: fs.existsSync(profiles.paths().db), first: ws === profiles.home(), lastCheck: last ? { at: last.end, ok: !!last.ok, label: last.label } : null };
    })
  );
}

/** Every class site's classes in one list, each saying which site it's from (`site`, `siteName`). */
async function coursesAll() {
  const parts = await sites.each(async (ws) => ({ label: siteLabel(ws), list: courseImages.withImages(await db.courses(profiles.paths().db, profiles.paths().textbooks, readState().done || {})) }), null);
  return parts.flatMap(({ ws, value }) => (value?.list || []).map((c) => ({ ...sites.tag(ws, c), site: ws, siteName: value.label })));
}

/**
 * Start a run from the window (or another device) on the right class site: the one named, the one with the study set
 * or class the argument names, or, for a check of everything, every site with a class site saved. Resolves when all
 * of them finish (with the first one's result).
 */
const CODE = /^[A-Z]{2,5}\d{3,5}[A-Z]?$/i;
async function runAnywhere(task, arg = '', why = 'manual', site = null) {
  arg = String(arg || '');
  if (site && profiles.exists(site)) return profiles.within(site, () => runner.run(task, arg, why));
  const words = arg.split(/\s+/).filter(Boolean);
  // A study set (practice) or an assignment (guides "<code> <item id>"): their ids say the site.
  if (task === 'practice' && words[0]) {
    const { ws, id } = sites.splitSet(words[0]);
    return profiles.within(ws, () => runner.run(task, [id, ...words.slice(1)].join(' '), why));
  }
  if (task === 'guides' && words[1]) {
    const { ws, id } = profiles.split(words[1]);
    return profiles.within(ws, () => runner.run(task, [words[0], id, ...words.slice(2)].join(' '), why));
  }
  // A class named by its code: the site that has it.
  const code = words.find((w) => CODE.test(w));
  if (code) {
    const has = (await sites.each(async () => (await db.watchList(profiles.paths().db).catch(() => [])).some((c) => c.code.toUpperCase() === code.toUpperCase()), false)).find((x) => x.value);
    return profiles.within(has ? has.ws : profiles.home(), () => runner.run(task, arg, why));
  }
  // Everything: each site with a class site saved (the first site always, so setup and probes behave as before).
  const targets = profiles.ids().filter((ws) => ws === profiles.home() || profiles.within(ws, () => !!browser.schoolInfo().home));
  const runs = targets.map((ws) => profiles.within(ws, () => runner.run(task, arg, why)));
  return (await Promise.all(runs))[0];
}
/** Each class site's announcements, one after another. True when any had something new. */
async function pollAll() {
  let any = false;
  for (const ws of profiles.ids()) if (await profiles.within(ws, () => (browser.schoolInfo().home ? precheck.pollAnnouncements() : false)).catch(() => false)) any = true;
  return any;
}

function register() {
  const p = () => profiles.paths();
  // (A class site named by the window: one Kea has, or the first.)
  const at = (site, fn) => profiles.within(typeof site === 'string' && profiles.exists(site) ? site : profiles.home(), fn);
  // The connected class sites, each with its own status (Scans → Class sites).
  handleApp(ipcMain, 'scholar:sites', () => sitesNow());
  // Another class site: a new folder of its own (its engine, database and sign-in), set up from Add a class.
  handleApp(ipcMain, 'scholar:addSite', (_e, name) => {
    const before = new Set(profiles.ids());
    profiles.create(String(name || '').trim() || `Class site ${before.size + 1}`);
    const id = profiles.ids().find((x) => !before.has(x));
    watch();
    return { id, sites: sitesNow() };
  });
  handleApp(ipcMain, 'scholar:renameSite', (_e, id, name) => (profiles.exists(id) && profiles.rename(id, name), sitesNow()));
  handleApp(ipcMain, 'scholar:status', async () => ({ hasData: (await sites.each(() => fs.existsSync(p().db), false)).some((x) => x.value), paths: profiles.paths(profiles.home()) }));
  handleApp(ipcMain, 'scholar:courses', async () => coursesAll());
  // Each class's picture from the class site, read again now (Settings → Scholar).
  handleApp(ipcMain, 'scholar:courseImages', async () => {
    const n = (await sites.each(() => courseImages.refresh({ force: true }), 0)).reduce((a, x) => a + (x.value || 0), 0);
    if (n) (BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('scholar:changed')), syncSoon(5000));
    return n;
  });
  // (With the Kea Hub's class sessions this person is in, from what hubClasses.cjs last read.)
  // Every class site's items on one calendar; one class's from its own site.
  handleApp(ipcMain, 'scholar:items', async (_e, q) => {
    q = q || {};
    const fromSite = /^(hub|work):/.test(String(q.courseId || ''))
      ? []
      : q.courseId
        ? await sites.routed(q.courseId, (courseId) => db.items(p().db, p().textbooks, readState().done || {}, { ...q, courseId }))
        : await sites.union(() => db.items(p().db, p().textbooks, readState().done || {}, q));
    let hub = [];
    try {
      hub = require('../hubClasses.cjs').calendarItems(q);
    } catch {}
    try {
      if (!q.courseId) hub = [...hub, ...require('../hubOrg.cjs').calendarItems(q)];
    } catch {}
    return hub.length || profiles.ids().length > 1 ? sortItems([...fromSite, ...hub]) : fromSite;
  });
  // The Claude tab's assignment picker: graded work to choose from, and one assignment written out whole.
  handleApp(ipcMain, 'scholar:assignments', () => sites.union(() => require('./assignmentBrief.cjs').list().catch(() => [])));
  // The Claude tab's class tools: search what Kea has, read one result, and send a lookup to read the class site.
  // (Every site is searched; a result's reference says its site, so reading it reads from there.)
  handleApp(ipcMain, 'scholar:classSearch', async (_e, q, course) => {
    const parts = await sites.each(() => require('./lookups.cjs').search(String(q || ''), String(course || '')), []);
    return parts.flatMap(({ ws, value }) => (value || []).map((h) => ({ ...h, ref: profiles.qualify(ws, h.ref) }))).sort((a, b) => (b.score || 0) - (a.score || 0));
  });
  handleApp(ipcMain, 'scholar:classRead', (_e, ref) => {
    const { ws, id } = profiles.split(String(ref || ''));
    return profiles.within(ws, () => require('./lookups.cjs').read(id));
  });
  handleApp(ipcMain, 'scholar:lookup', async (_e, req) => {
    const code = String(req?.course || '');
    const has = code ? (await sites.each(async () => (await db.watchList(p().db).catch(() => [])).some((c) => c.code === code), false)).find((x) => x.value) : null;
    const ws = has ? has.ws : profiles.home();
    const r = await profiles.within(ws, () => require('./lookups.cjs').start(req || {}));
    return r && typeof r === 'object' && r.id ? { ...r, id: profiles.qualify(ws, r.id) } : r;
  });
  handleApp(ipcMain, 'scholar:lookupWait', (_e, id, ms) => {
    const { ws, id: raw } = profiles.split(String(id || ''));
    return profiles.within(ws, () => require('./lookups.cjs').wait(raw, Math.min(Number(ms) || 240000, 270000)));
  });
  handleApp(ipcMain, 'scholar:assignmentBrief', (_e, id) => sites.routed(String(id || ''), (raw) => require('./assignmentBrief.cjs').brief(raw)).catch(() => null));
  handleApp(ipcMain, 'scholar:course', (_e, id) =>
    sites.routed(id, async (raw, ws) => {
      const c = await db.course(p().db, p().textbooks, readState().done || {}, raw);
      return c ? { ...c, site: ws, siteName: siteLabel(ws) } : c;
    })
  );
  // A checkmark is kept by the class site the item is from.
  handleApp(ipcMain, 'scholar:setDone', (_e, id, done) => {
    const { ws, id: raw } = profiles.split(id);
    profiles.within(ws, () => {
      const s = readState();
      setDone(s, raw, done);
      writeState(s);
    });
    syncSoon(5000);
    return true;
  });
  handleApp(ipcMain, 'scholar:importExisting', (_e, folder, site) => at(site, () => importExisting(folder)));

  // The class site and Kea's own sign-in. (`site`: which class site; the first one when none is named.)
  handleApp(ipcMain, 'scholar:school', (_e, site) => at(site, () => browser.schoolInfo()));
  handleApp(ipcMain, 'scholar:setSchoolHome', (_e, home, platform, site) => at(site, () => browser.setHome(home, platform)));
  handleApp(ipcMain, 'scholar:signIn', (_e, remember, site) => at(site, () => browser.signIn(remember)));
  handleApp(ipcMain, 'scholar:forgetLogin', (_e, site) => at(site, () => browser.forgetLogin()));
  handleApp(ipcMain, 'scholar:siteStatus', (_e, site) => at(site, () => browser.status()));
  ipcMain.on('class-site:login', browser.onLoginSubmitted);
  ipcMain.on('class-site:remembering', browser.remembering);

  // Setup: what's installed, and installing it.
  const lines = (e) => (line) => e.sender.send('scholar:setupLine', line);
  handleApp(ipcMain, 'scholar:check', (_e, site) => at(site, () => workspace.check()));
  handleApp(ipcMain, 'scholar:installUv', (e) => workspace.installUv(lines(e)));
  handleApp(ipcMain, 'scholar:installClaude', (e) => workspace.installClaude(lines(e)));
  handleApp(ipcMain, 'scholar:signInClaude', () => workspace.signInClaude());
  handleApp(ipcMain, 'scholar:setupEngine', (e, site) => at(site, () => workspace.setupEngine(browser.schoolInfo().home, lines(e))));

  // Scans.
  // On a device that isn't the primary, the primary is asked to (through the drive), so nothing runs twice.
  // (Starting a Claude run answers only Kea's own page: ipcGuard.cjs.)
  // Each run goes to its class site (runAnywhere): the one named, or the one its class or set is from, or every site.
  ipcMain.handle('scholar:run', require('../ipcGuard.cjs').appOnly((_e, task, arg, site) => {
    // (Scans with this computer's own Claude need no online account: only Kea's shared Claude does, hub.cjs.)
    if (task !== 'probe' && devices.follower() && !(site && site !== profiles.home())) return devices.relay({ task, arg: arg || '' });
    if (!runner.TASKS[task]) throw new Error(`Unknown run: ${task}`);
    runAnywhere(task, arg || '', 'manual', typeof site === 'string' ? site : null).then(() => task === 'study' && keepBanks());
    return true;
  }));
  // Your devices: which one scans, the drive they sync through, and bringing classes in on a new one.
  const devicesChanged = () => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('scholar:changed'));
  handleApp(ipcMain, 'scholar:devices', () => devices.status());
  handleApp(ipcMain, 'scholar:devicesFind', () => devices.find());
  handleApp(ipcMain, 'scholar:devicesJoin', async (_e, choice) => {
    if (runner.status().running) throw new Error('A class scan is running here. Try again when it finishes.');
    const r = await devices.join(choice);
    watch();
    return r;
  });
  handleApp(ipcMain, 'scholar:makePrimary', (_e, id) => {
    if (runner.status().running && id !== require('../settings.cjs').get('scholar.pcId')) throw new Error('A class scan is running on this device. Make another device the primary when it finishes (or stop it first).');
    return devices.makePrimary(id);
  });
  // (The same switch as Settings → Where your things sync: documents and the phone's file get a copy there too.)
  handleApp(ipcMain, 'scholar:setDrive', async (_e, choice) => {
    await require('../syncChoice.cjs').choose(choice);
    return devices.status();
  });
  handleApp(ipcMain, 'scholar:stop', () => {
    if (devices.follower()) return (devices.relay({ task: 'stop' }), true);
    runner.stop();
    return true;
  });
  handleApp(ipcMain, 'scholar:runStatus', () => runner.status());
  // Every site's runs, newest first, each saying its site.
  handleApp(ipcMain, 'scholar:activity', async () =>
    (await sites.each(() => runner.activity(), [])).flatMap(({ ws, value }) => (value || []).map((e) => ({ ...e, site: ws }))).sort((a, b) => String(b.start).localeCompare(String(a.start)))
  );
  handleApp(ipcMain, 'scholar:news', () => sites.union(() => runner.news()));
  // Runs set aside to continue later: the first site's that has any.
  handleApp(ipcMain, 'scholar:pending', async () => (await sites.each(() => runner.pending())).map((x) => x.value).find(Boolean) || null);

  // The Inbox: announcements (from the class site directly) and what scans found (messages, grades, deadlines), from
  // every class site.
  handleApp(ipcMain, 'scholar:inbox', async () =>
    (await sites.union(() => [...precheck.readInbox().items, ...runner.news().map(scanItem)])).sort((a, b) => String(b.at).localeCompare(String(a.at)))
  );
  const markRead = (ids) => {
    precheck.markInboxRead(ids ? ids.filter((i) => !i.startsWith('scan:')) : null);
    runner.markNewsRead(ids ? ids.filter((i) => i.startsWith('scan:')).map((i) => i.slice(5)) : null);
  };
  handleApp(ipcMain, 'scholar:markInboxRead', (_e, ids) => {
    if (!ids) for (const ws of profiles.ids()) profiles.within(ws, () => markRead(null));
    else for (const [ws, list] of sites.bySite(ids.map(String))) profiles.within(ws, () => markRead(list));
    syncSoon(5000);
    return true;
  });
  handleApp(ipcMain, 'scholar:deleteInbox', (_e, ids) => {
    const list = Array.isArray(ids) ? ids.map(String) : [];
    for (const [ws, mine] of sites.bySite(list))
      profiles.within(ws, () => {
        // What scans reported is remembered by its content too, so the phone hides its own copy of it.
        const scanKeys = runner.deleteNews(mine.filter((i) => i.startsWith('scan:')).map((i) => i.slice(5)));
        precheck.deleteInbox(mine.filter((i) => !i.startsWith('scan:')), scanKeys);
      });
    syncSoon(5000);
    return true;
  });
  handleApp(ipcMain, 'scholar:checkInbox', () => {
    if (!devices.follower()) return pollAll();
    devices.relay({ task: 'inbox' });
    // (Another class site of this computer's own is still checked here.)
    for (const ws of profiles.ids().slice(1)) profiles.within(ws, () => browser.schoolInfo().home && precheck.pollAnnouncements().catch(() => false));
    return true;
  });
  // Handing in a file: the folders it can go to, then the class site's own hand-in page with the file in its upload box.
  // (`peek`: only what is already known, for deciding whether to show a Hand in button at all.) Every site's classes;
  // a class's `ou` says its site, so the hand-in goes through that site.
  const targetsHere = async (opts) => {
    let t = await precheck.handInTargets();
    // Nothing known yet: take a quick look at the class site first (no Claude).
    if (!opts?.peek && !t.some((c) => c.folders.length) && !devices.follower() && browser.schoolInfo().home) {
      await precheck.pollAnnouncements().catch(() => false);
      t = await precheck.handInTargets();
    }
    return t;
  };
  handleApp(ipcMain, 'scholar:handInTargets', async (_e, opts) =>
    (await sites.each(() => targetsHere(opts), [])).flatMap(({ ws, value }) => (value || []).map((c) => ({ ...c, ou: profiles.qualify(ws, c.ou) })))
  );
  ipcMain.handle('scholar:handIn', require('../ipcGuard.cjs').appOnly((_e, ou, folderId, file) => {
    const { ws, id } = profiles.split(String(ou ?? ''));
    return profiles.within(ws, () => browser.handIn(id, folderId, file));
  }));
  // Grades: Kea's own check of the class site, or what the daily checks recorded before that ran.
  handleApp(ipcMain, 'scholar:grades', (_e, courseId, code) => sites.routed(courseId, async (raw) => precheck.readGrades().byCourse[code] || (await db.gradesFromChecks(p().db, raw))));
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
  // The class site a class code is on (the first that has it).
  const siteOfCode = async (code) => {
    const c = String(code || '').toUpperCase();
    if (!c || profiles.ids().length < 2) return profiles.home();
    const has = (await sites.each(async () => (await db.watchList(p().db).catch(() => [])).some((x) => String(x.code).toUpperCase() === c), false)).find((x) => x.value);
    return has ? has.ws : profiles.home();
  };
  // (Rules are worked out from every document, so each class's list is kept for ten minutes.)
  // A class's chapters against its syllabus: outcomes and the chapters that teach each, guidelines, what's missing.
  const curriculumCache = new Map();
  handleApp(ipcMain, 'scholar:curriculum', async (_e, code, fresh) => {
    const k = String(code).replace(/[^\w]/g, '');
    const ws = await siteOfCode(k);
    const hit = curriculumCache.get(`${ws}|${k}`);
    if (!fresh && hit && Date.now() - hit.at < 10 * 60e3) return hit.value;
    const value = await profiles.within(ws, () => engineJson(['curriculum', '--course', k, '--json']));
    curriculumCache.set(`${ws}|${k}`, { at: Date.now(), value });
    return value;
  });
  handleApp(ipcMain, 'scholar:itemHistory', (_e, id) => {
    const { ws, id: raw } = profiles.split(String(id));
    return profiles.within(ws, () => engineJson(['item-history', raw.replace(/[^\w-]/g, ''), '--json']));
  });
  handleApp(ipcMain, 'scholar:changes', async (_e, opts = {}) => {
    const args = ['changes', '--json'];
    if (/^\d{4}-\d{2}-\d{2}$/.test(opts.since || '')) args.push('--since', opts.since);
    if (/^[A-Z]{2,5}\d{3,5}[A-Z]?$/i.test(opts.course || '')) {
      args.push('--course', opts.course);
      return profiles.within(await siteOfCode(opts.course), () => engineJson(args));
    }
    return profiles.within(profiles.home(), () => engineJson(args));
  });
  // Class-site messages like email: read in full, draft and send from Kea (messages.cjs).
  require('./messages.cjs').register({ browser, precheck, db });
  // Withdrawn classes: the student's own say ("I withdrew from this class", undo, "No, I'm still in it"). Every
  // site's, with each class's id as the window knows it.
  const W = require('./withdrawn.cjs');
  const withdrawnNow = async () => {
    const parts = await sites.each(() => {
      const v = W.read(p().dir);
      return { log: v.log, ask: W.asking(v) };
    }, { log: {}, ask: [] });
    return { log: Object.assign({}, ...parts.map(({ ws, value }) => sites.tagKeys(ws, value.log))), ask: parts.flatMap(({ ws, value }) => sites.tag(ws, value.ask || [])) };
  };
  const withdrawnChanged = () => (BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('scholar:changed')), syncSoon(3000));
  handleApp(ipcMain, 'scholar:withdrawn', () => withdrawnNow());
  handleApp(ipcMain, 'scholar:setWithdrawn', (_e, courseId, on, code) => {
    if (typeof courseId !== 'string' || !/^[\w-]{1,120}$/.test(courseId)) throw new Error('Kea doesn’t know which class this is.');
    const { ws, id } = profiles.split(courseId);
    profiles.within(ws, () => W.set(p().dir, id, !!on, String(code || '').slice(0, 40)));
    withdrawnChanged();
    return withdrawnNow();
  });
  handleApp(ipcMain, 'scholar:withdrawDismiss', (_e, courseId) => {
    if (typeof courseId !== 'string' || !/^[\w-]{1,120}$/.test(courseId)) throw new Error('Kea doesn’t know which class this is.');
    const { ws, id } = profiles.split(courseId);
    profiles.within(ws, () => W.dismiss(p().dir, id));
    withdrawnChanged();
    return withdrawnNow();
  });
  handleApp(ipcMain, 'scholar:openLink', (_e, url) => {
    if (!/^https?:\/\//i.test(String(url))) return false;
    // (A class-site page opens signed in to the site it's on.)
    const ws = profiles.ids().find((x) => profiles.within(x, () => browser.isClassSite(url)));
    if (ws) return profiles.within(ws, () => browser.show(url));
    require('electron').shell.openExternal(url);
    return true;
  });
  // Study materials: practice exams and flashcards, made by Claude only when asked, then taken offline. Each set is
  // kept by the class site its class is on; every site's sets are listed together.
  const study = require('./study.cjs');
  const inSet = (id, fn) => {
    const { ws, id: raw } = sites.splitSet(id);
    return profiles.within(ws, async () => sites.tag(ws, await fn(raw)));
  };
  // A question's key is the same on every device but kept by one site: the first site that knows it.
  const siteOfKey = (k) => profiles.ids().find((ws) => profiles.within(ws, () => !!study.whereIs(String(k)))) || profiles.home();
  const inKey = (k, fn) => profiles.within(siteOfKey(k), () => fn());
  handleApp(ipcMain, 'scholar:studyList', () => {
    const running = runner.status();
    return sites.union(() => {
      // (A set whose run is set aside to continue later is still being made.)
      const busy = new Set([running.running, ...(running.parallel || []), ...running.queued, ...(runner.pending()?.runs || [])].filter((j) => j && j.task === 'practice').map((j) => String(j.arg).split(/\s+/)[0]));
      // (Another device's sets are settled by the device making them.)
      if (!devices.follower()) study.settle((id) => busy.has(id));
      return study.list();
    });
  });
  handleApp(ipcMain, 'scholar:studyGet', (_e, id) => inSet(id, (raw) => study.get(raw)));
  handleApp(ipcMain, 'scholar:studyMake', async (_e, req) => {
    const { ws, id: courseId } = profiles.split(req?.courseId || '');
    const own = { ...(req || {}), ...(req?.courseId ? { courseId } : {}) };
    return profiles.within(ws, async () => {
      const { id, ready, pick } = await study.request(own);
      const shown = profiles.qualify(ws, id);
      // Made by the computer that scans (it has the class files); the set comes back here when it's ready. A set from
      // saved questions is ready here at once, and the primary saves the same one (the same picks) for every device.
      if (devices.follower()) {
        devices.relay({ task: 'practice', req: { ...own, id, pick } });
        return shown;
      }
      if (ready) {
        devices.soon();
        return shown;
      }
      runner.run('practice', id, 'manual').then(() => {
        const e = study.list().find((x) => x.id === id);
        if (!e) return;
        const { Notification } = require('electron');
        const body = e.status === 'ready' ? `${e.count} ${e.kind === 'exam' ? 'questions' : 'cards'}, ready in My resources.` : e.error || 'It didn’t work. Try again.';
        if (Notification.isSupported()) new Notification({ title: e.status === 'ready' ? e.title : `Couldn’t make ${e.title}`, body }).show();
        BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('scholar:changed'));
      });
      return shown;
    });
  });
  handleApp(ipcMain, 'scholar:studySaved', (_e, req) => sites.routed(req?.courseId || '', (courseId) => study.saved({ ...(req || {}), ...(req?.courseId ? { courseId } : {}) })));
  // (A picture's path is relative to its site's study folder; any site that has it.)
  handleApp(ipcMain, 'scholar:studyImage', (_e, rel) => {
    for (const ws of profiles.ids()) {
      const v = profiles.within(ws, () => study.imageData(String(rel || '')));
      if (v) return v;
    }
    return null;
  });
  // Worked steps for a question's chapter, now (the student missed one that has none yet).
  handleApp(ipcMain, 'scholar:studyStepsFor', (_e, k) =>
    inKey(k, () => {
      const w = study.whereIs(String(k));
      if (!w?.courseCode || !w.chapter) throw new Error('Kea couldn’t find which chapter this question is from.');
      const arg = `${w.courseCode} ${w.chapter}`;
      const shown = sites.tag(profiles.active(), w);
      if (devices.follower()) return (devices.relay({ task: 'steps', arg }), { queued: true, ...shown });
      const st = runner.status();
      if (![st.running, ...(st.parallel || []), ...st.queued].some((j) => j && j.task === 'steps' && j.arg === arg)) runner.run('steps', arg, 'manual');
      return { queued: true, ...shown };
    })
  );
  // Teach: Claude's lesson on an answered question (streamed to the window as it's written), and follow-ups.
  handleApp(ipcMain, 'scholar:teach', (e, id, req) => inKey(id, () => require('./teach.cjs').teach(String(id), req || {}, (text) => !e.sender.isDestroyed() && e.sender.send('scholar:teach-event', { id: String(id), text }))));
  handleApp(ipcMain, 'scholar:teachStop', (_e, id) => require('./teach.cjs').stop(String(id)));
  handleApp(ipcMain, 'scholar:lessons', (_e, k) => inKey(k, () => study.lessons(String(k || ''))));
  // Every assignment's step-by-step guide (guides.cjs), by item id, from every site.
  handleApp(ipcMain, 'scholar:guides', async () => Object.assign({}, ...(await sites.each(() => study.guidesAll(), {})).map(({ ws, value }) => sites.tagKeys(ws, value || {}))));
  // Rescan one assignment's guide now (the student finished what unlocks its instructions).
  handleApp(ipcMain, 'scholar:guideRescan', (_e, id, code) => {
    const { ws, id: raw } = profiles.split(String(id || ''));
    const arg = `${String(code || '').replace(/[^\w-]/g, '')} ${raw.replace(/[^\w-]/g, '')} force`;
    if (!/^\S+ \S+ force$/.test(arg)) throw new Error('Kea doesn’t know which assignment this is.');
    return profiles.within(ws, () => {
      if (devices.follower()) return (devices.relay({ task: 'guides', arg }), { queued: true });
      runner.run('guides', arg, 'manual');
      return { queued: true };
    });
  });
  // The saved questions of some chapters with how each has gone, for choosing exactly what to study.
  handleApp(ipcMain, 'scholar:studyPool', (_e, { courseId, chapters }) => sites.routed(String(courseId || ''), (raw) => study.pool(raw, Array.isArray(chapters) ? chapters.map(String) : [])));
  // The textbook PDF open in a tab: which class and chapters it is, for its Quiz me button (whichever site has it).
  handleApp(ipcMain, 'scholar:textbookOf', async (_e, file) => {
    for (const { ws, value } of await sites.each(() => db.textbookOf(p().db, p().textbooks, file))) if (value) return sites.tag(ws, value);
    return null;
  });
  // A chapter with no saved questions yet: write its bank now (on the primary). False when Claude isn't available.
  handleApp(ipcMain, 'scholar:studyBanks', async () => {
    if (devices.follower()) return (devices.relay({ task: 'banks', arg: '' }), true);
    const ok = await workspace.check().then((c) => !!c.account?.loggedIn).catch(() => false);
    if (ok) keepBanks();
    return ok;
  });
  handleApp(ipcMain, 'scholar:studyDelete', (_e, id) => inSet(id, (raw) => study.remove(raw)));
  // Running low on a chapter's questions: more get written, ~5 s after an attempt. The Study stream saves every 10
  // answers, so its saves only check on leaving the stream (`final`) or once every 25 answers.
  let banksTimer = null;
  let streamAnswers = 0;
  const banksSoon = () => (clearTimeout(banksTimer), (banksTimer = setTimeout(keepBanks, 5000)));
  handleApp(ipcMain, 'scholar:studyAttempt', (_e, id, a) => {
    const { ws, id: raw } = sites.splitSet(id);
    profiles.within(ws, () => study.saveAttempt(raw, a));
    if (!study.isStream(raw)) banksSoon();
    else {
      streamAnswers += Array.isArray(a?.items) ? a.items.length : 0;
      if (a?.final || streamAnswers >= 25) (streamAnswers = 0), banksSoon();
    }
    return true;
  });
  handleApp(ipcMain, 'scholar:studyKnown', (_e, id, known) => inSet(id, (raw) => study.setKnown(raw, known)));
  // The student's own sets, stars, Learn and Match progress, and spaced review (all kept on this computer).
  // (A set the student makes goes with its class's site; one with no class, with the first site.)
  handleApp(ipcMain, 'scholar:studySaveMine', (_e, set) => {
    const { ws, id: courseId } = profiles.split(set?.courseId || '');
    const { id: own } = set?.id ? sites.splitSet(set.id) : { id: undefined };
    return profiles.within(ws, async () => sites.tag(ws, await study.saveMine({ ...(set || {}), ...(set?.courseId ? { courseId } : {}), ...(own ? { id: own } : {}) })));
  });
  handleApp(ipcMain, 'scholar:studyStar', (_e, k, on) => inKey(k, () => study.star(String(k), !!on)));
  handleApp(ipcMain, 'scholar:studyLearn', (_e, id, levels) => inSet(id, (raw) => study.learnSet(raw, levels)));
  handleApp(ipcMain, 'scholar:studyMatch', (_e, id, ms) => inSet(id, (raw) => study.matchBest(raw, Number(ms))));
  // Spaced review: one class's (from its site), or every site's together.
  handleApp(ipcMain, 'scholar:studyReview', async (_e, opts) => {
    const o = opts || {};
    if (o.courseId) return sites.routed(o.courseId, (courseId) => study.reviewQueue({ ...o, courseId }));
    const lists = (await sites.each(() => study.reviewQueue(o), null)).filter((x) => x.value).map(({ ws, value }) => sites.tag(ws, value));
    if (lists.length <= 1) return lists[0] || study.reviewQueue(o);
    // ({ due, fresh, counts, newToday } from each site, put together within the same limit.)
    const limit = Number(o.limit) || 40;
    const due = lists.flatMap((v) => v.due || []).slice(0, limit);
    const counts = {};
    for (const v of lists) for (const [k, n] of Object.entries(v.counts || {})) counts[k] = typeof n === 'number' ? (counts[k] || 0) + n : counts[k] ?? n;
    return { due, fresh: lists.flatMap((v) => v.fresh || []).slice(0, Math.max(0, limit - due.length)), counts, newToday: Math.max(...lists.map((v) => v.newToday || 0)) };
  });
  handleApp(ipcMain, 'scholar:studyReviewMark', (_e, k, grade, ctx) => {
    const c = ctx || {};
    const { id: courseId } = profiles.split(c.courseId || '');
    return inKey(k, () => study.reviewMark(String(k), ['again', 'good', 'easy'].includes(grade) ? grade : 'good', { ...c, ...(c.courseId ? { courseId } : {}) }));
  });
  handleApp(ipcMain, 'scholar:resume', async (_e, task) => {
    if (devices.follower()) return (devices.relay({ task: 'resume', arg: task || '' }), true);
    // Nothing set aside: nothing to continue. (Falling back to the last run of a task could restart an import that
    // already finished.)
    return (await sites.each(() => (runner.pending() ? runner.resume() : false), false)).some((x) => x.value);
  });

  // Developer aid (unpackaged builds only): read a page through the class-site browser.
  if (!require('electron').app.isPackaged) {
    handleApp(ipcMain, 'scholar:debugOpen', (_e, url) => browser.open(url));
    // The pre-check on its own, without starting Claude or saving a new baseline.
    handleApp(ipcMain, 'scholar:debugPrecheck', async () => {
      const r = await precheck.run();
      const { commit, ...rest } = r;
      return rest;
    });
  }

  watch();
  // (Runs each class site was in the middle of when Kea closed.)
  for (const ws of profiles.ids())
    try {
      profiles.within(ws, () => runner.adoptStopped());
    } catch {}
  app.on('before-quit', () => runner.shutdown());
  handleApp(ipcMain, 'scholar:syncNow', async () => {
    await devices.step();
    return devices.publishes() ? cloud.sync(snapshot) : null;
  });
  // Worker mode (a shared-Claude job for someone else): no schedule of its own; worker.cjs runs the one job.
  if (require('./remote.cjs').active()) return;
  syncSoon(90000);
  // Phone and other computers' changes arrive within about a minute of the drive bringing them down.
  setTimeout(() => devices.step(), 15000);
  setInterval(async () => {
    await devices.step();
    try {
      if (devices.publishes() && mergePhone()) syncSoon(5000);
    } catch {}
  }, 60000);
  setTimeout(tick, 60000);
  setInterval(tick, 5 * 60000);
}

/** Publish now: as the primary, share the classes (devices.cjs) and write the data file (cloud.cjs). */
async function publish() {
  await devices.step();
  return devices.publishes() ? cloud.sync(snapshot) : null;
}

/** The place things sync changed (syncChoice.cjs): the devices folder moves with it, and a fresh copy goes there. */
async function driveChanged() {
  await devices.step();
  watch();
  BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('scholar:changed'));
  syncSoon(3000);
}

module.exports = { register, publish, driveChanged, _test: { applyMarks, snapshot, runAnywhere } };
