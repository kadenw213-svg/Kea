// Several computers, one set of classes: they keep in step through the same drive folder as the phone copy, and only
// ONE of them (the "scanner") ever looks at the class site or runs Claude, so a second install never doubles the usage.
//
//   <drive>/Kea/<profile>/PCs/scanner.json       which computer scans { id, name, at, forced, db: { mtime, size, sha }, running }
//   <drive>/Kea/<profile>/PCs/academic_sync.db   the scanner's class database
//   <drive>/Kea/<profile>/PCs/files/...          its Inbox, scan news, grades, hand-ins, check baselines, study sets
//   <drive>/Kea/<profile>/PCs/pc-<id>.json       each other computer's own changes (checkmarks, read, deleted, study progress)
//   <drive>/Kea/<profile>/PCs/requests/*.json    scans and study sets asked for on another computer, run by the scanner
//
// The others copy the scanner's results in (the textbooks come from the phone copy's Textbooks/ folder) and send
// what the student did there back, the same way the phone does. Pressing a scan button on one of them asks the scanner
// to run it. Only when the scanner hasn't been heard from for a long while (Settings → Scholar → Advanced) does the next
// computer that can scan take over.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BrowserWindow, Notification } = require('electron');
const profiles = require('./profiles.cjs');
const settings = require('../settings.cjs');
const cloud = require('./cloud.cjs');
const runner = require('./runner.cjs');
const precheck = require('./precheck.cjs');

// What the scanner shares, relative to the profile folder. (kea.json and study progress are merged, not copied.)
const FILES = ['inbox.json', 'news.json', 'grades.json', 'submissions.json', 'precheck.json', 'sync-state.json', 'activity.json'];
const DIRS = [path.join('scholar', 'data', 'digests', 'kea-inbox'), path.join('study', 'sets')];
const HEARTBEAT = 10 * 60000;

let hooks = null;
/** index.cjs hands over what lives there: Kea's state for the profile, applying another device's changes, readiness to scan. */
function configure(h) {
  hooks = h;
}

function readJson(f, fallback) {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJson(f, v) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f + '.tmp', JSON.stringify(v));
  fs.renameSync(f + '.tmp', f);
}
const sha = (f) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
const changed = () => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('scholar:changed'));

/** This computer's id (made once) and the name other computers see. */
function me() {
  let id = settings.get('scholar.pcId', '');
  if (!id) {
    id = crypto.randomUUID().slice(0, 8);
    settings.set({ 'scholar.pcId': id });
  }
  return id;
}
const myName = () => os.hostname();

/** The drive folder computers share for the active profile, or null when that's off. */
function folder() {
  if (settings.get('scholar.pcSync', true) === false) return null;
  const t = cloud.target();
  return t ? path.join(t, 'PCs') : null;
}
const scannerInfo = (dir = folder()) => (dir ? readJson(path.join(dir, 'scanner.json'), null) : null);
// This computer's own record of syncing (per profile, never shared).
const stateFile = () => path.join(profiles.paths().dir, 'pcsync.json');

/** True when another computer does the scanning, so this one mustn't scan, poll the class site or write the phone copy. */
function follower() {
  const s = scannerInfo();
  return !!(s && s.id && s.id !== me());
}

function copyIfChanged(a, b) {
  const sa = fs.statSync(a);
  try {
    const sb = fs.statSync(b);
    if (sb.size === sa.size && Math.abs(sb.mtimeMs - sa.mtimeMs) < 2000) return false;
  } catch {}
  fs.mkdirSync(path.dirname(b), { recursive: true });
  fs.copyFileSync(a, b + '.tmp');
  fs.utimesSync(b + '.tmp', sa.atime, sa.mtime);
  fs.renameSync(b + '.tmp', b);
  return true;
}

/** Make dst match src (files copied only when changed; anything src lacks is deleted). Returns whether anything changed. */
function copyTree(src, dst) {
  let any = false;
  const keep = new Set();
  const walk = (s, d) => {
    if (!fs.existsSync(s)) return;
    for (const e of fs.readdirSync(s, { withFileTypes: true })) {
      if (e.name.endsWith('.tmp')) continue;
      const a = path.join(s, e.name);
      const b = path.join(d, e.name);
      if (e.isDirectory()) walk(a, b);
      else {
        keep.add(path.resolve(b));
        if (copyIfChanged(a, b)) any = true;
      }
    }
  };
  walk(src, dst);
  const prune = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        prune(p);
        if (!fs.readdirSync(p).length) fs.rmdirSync(p);
      } else if (!keep.has(path.resolve(p))) {
        fs.rmSync(p, { force: true });
        any = true;
      }
    }
  };
  prune(dst);
  return any;
}

// ---------- Who scans ----------
function claim(dir) {
  const s = { id: me(), name: myName(), at: new Date().toISOString(), forced: settings.get('scholar.pcRole', 'auto') === 'main', db: scannerInfo(dir)?.db || null };
  writeJson(path.join(dir, 'scanner.json'), s);
  console.log('PC sync: this computer now does the scans');
  return s;
}

/** Decide (and if it's this computer's turn, take) the scanner role. Returns 'scanner' or 'follower'. */
async function decide(dir) {
  const s = scannerInfo(dir);
  const role = settings.get('scholar.pcRole', 'auto');
  const P = profiles.paths();
  const hasDb = fs.existsSync(P.db);
  if (s?.id === me()) return 'scanner';
  if (!s) {
    // Nobody scans yet: the first computer with classes does.
    if (role !== 'viewer' && hasDb) return claim(dir), 'scanner';
    return 'follower';
  }
  const hours = Number(settings.get('scholar.pcTakeover', '48'));
  const stale = hours > 0 && Date.now() - new Date(s.at).getTime() > hours * 3600e3;
  const st = readJson(stateFile(), {});
  if (role === 'main' && (!s.forced || stale)) return claim(dir), 'scanner';
  // Joining for the first time with newer classes than the drive has (this computer scanned more recently), unless the
  // student chose to bring that computer's classes in here.
  if (role !== 'viewer' && !st.pulledSha && !st.chosen && hasDb && fs.statSync(P.db).mtimeMs > (s.db?.mtime || 0) + 60000) return claim(dir), 'scanner';
  if (role === 'auto' && stale && hasDb && (await hooks.ready())) return claim(dir), 'scanner';
  return 'follower';
}

// ---------- The scanner: share results, take in the others' changes, run what they asked for ----------
async function lead(dir) {
  const P = profiles.paths();
  // What the other computers did (checkmarks, read and deleted messages, study progress), each version taken in once.
  const st = readJson(stateFile(), {});
  st.seen = st.seen || {};
  for (const f of fs.readdirSync(dir).filter((x) => /^pc-.+\.json$/.test(x) && x !== `pc-${me()}.json`)) {
    const m = fs.statSync(path.join(dir, f)).mtimeMs;
    if (st.seen[f] === m) continue;
    st.seen[f] = m;
    writeJson(stateFile(), st);
    const marks = readJson(path.join(dir, f), null);
    if (marks && hooks.applyMarks(marks)) hooks.syncSoon(5000);
  }
  // Scans and study sets asked for on another computer.
  const reqDir = path.join(dir, 'requests');
  if (fs.existsSync(reqDir)) {
    for (const f of fs.readdirSync(reqDir).filter((x) => x.endsWith('.json')).sort()) {
      const full = path.join(reqDir, f);
      const r = readJson(full, null);
      fs.rmSync(full, { force: true });
      if (!r?.task) continue;
      console.log(`PC sync: ${r.from || 'another computer'} asked for ${r.task}`);
      try {
        if (r.task === 'inbox') precheck.pollAnnouncements().then((ok) => ok && hooks.syncSoon(5000)).catch(() => {});
        else if (r.task === 'practice') {
          const id = await require('./study.cjs').request(r.req || {});
          runner.run('practice', id, 'manual').then(() => soon(3000));
        } else if (runner.TASKS[r.task] && r.task !== 'probe') runner.run(r.task, r.arg || '', 'manual').then(() => soon(3000));
      } catch (err) {
        console.error('PC sync request', err);
      }
    }
  }
  const s = scannerInfo(dir) || {};
  const now = runner.status();
  const running = now.running ? now.running.label : null;
  let db = s.db || null;
  // Results are shared between runs only, never half-written.
  if (!running && fs.existsSync(P.db)) {
    const ds = fs.statSync(P.db);
    if (!db || db.mtime !== ds.mtimeMs || db.size !== ds.size) {
      fs.copyFileSync(P.db, path.join(dir, 'academic_sync.db.tmp'));
      fs.renameSync(path.join(dir, 'academic_sync.db.tmp'), path.join(dir, 'academic_sync.db'));
      db = { mtime: ds.mtimeMs, size: ds.size, sha: sha(P.db) };
    }
    for (const f of FILES) if (fs.existsSync(path.join(P.dir, f))) copyIfChanged(path.join(P.dir, f), path.join(dir, 'files', f));
    for (const d of DIRS) copyTree(path.join(P.dir, d), path.join(dir, 'files', d));
    for (const f of ['kea.json', path.join('study', 'index.json'), path.join('study', 'attempts.json'), path.join('study', 'cards.json')]) {
      if (fs.existsSync(path.join(P.dir, f))) copyIfChanged(path.join(P.dir, f), path.join(dir, 'files', f));
    }
  }
  // Tell the others this computer is still here (and what it's doing), every few minutes or when something changed.
  if (db !== s.db || running !== (s.running || null) || s.name !== myName() || Date.now() - new Date(s.at || 0).getTime() > HEARTBEAT) {
    writeJson(path.join(dir, 'scanner.json'), { ...s, id: me(), name: myName(), at: new Date().toISOString(), db, running });
  }
}

// ---------- Another computer: copy the results in, send this one's changes out ----------
const readIds = (read) => [...precheck.readInbox().items.filter((i) => !!i.read === read).map((i) => i.id), ...runner.news().filter((n) => !!n.read === read).map((n) => `scan:${n.id}`)];

/**
 * This computer's changes for the scanner. Read: only what was still unread in the scanner's last copy (so an
 * announcement the teacher edits, which comes back unread, isn't marked read again by an old read here).
 */
function marksOf(st) {
  const s = hooks.readState();
  const study = path.join(profiles.paths().dir, 'study');
  const wasUnread = new Set(st.unread || []);
  return {
    pc: me(),
    name: myName(),
    done: s.doneLog || {},
    read: readIds(true).filter((id) => wasUnread.has(id)),
    deleted: precheck.readInbox().deletedKeys || [],
    study: { attempts: readJson(path.join(study, 'attempts.json'), {}), cards: readJson(path.join(study, 'cards.json'), {}) }
  };
}

/** Study progress from another computer: every attempt kept, and the newer flashcard progress per set. */
function mergeStudy(other) {
  if (!other) return false;
  const study = path.join(profiles.paths().dir, 'study');
  const attempts = readJson(path.join(study, 'attempts.json'), {});
  const cards = readJson(path.join(study, 'cards.json'), {});
  let any = false;
  for (const [id, list] of Object.entries(other.attempts || {})) {
    const have = new Set((attempts[id] || []).map((a) => a.at));
    const add = (list || []).filter((a) => a?.at && !have.has(a.at));
    if (add.length) {
      attempts[id] = [...(attempts[id] || []), ...add].sort((a, b) => String(a.at).localeCompare(String(b.at)));
      any = true;
    }
  }
  for (const [id, c] of Object.entries(other.cards || {})) {
    if (c && (!cards[id] || String(c.at || '') > String(cards[id].at || ''))) {
      if (JSON.stringify(c) !== JSON.stringify(cards[id])) any = true;
      cards[id] = c;
    }
  }
  if (any) {
    writeJson(path.join(study, 'attempts.json'), attempts);
    writeJson(path.join(study, 'cards.json'), cards);
  }
  return any;
}

async function follow(dir) {
  const P = profiles.paths();
  const st = readJson(stateFile(), {});
  // This computer's own changes first, so nothing done here is lost when the scanner's copies come in.
  const mine = marksOf(st);
  const minePath = path.join(dir, `pc-${me()}.json`);
  if (JSON.stringify(readJson(minePath, null)) !== JSON.stringify(mine)) writeJson(minePath, mine);

  const s = scannerInfo(dir);
  let any = false;
  const shared = path.join(dir, 'academic_sync.db');
  // The class database, once it has fully arrived (OneDrive may still be bringing it down).
  if (s?.db?.sha && s.db.sha !== st.pulledSha && fs.existsSync(shared) && fs.statSync(shared).size === s.db.size && sha(shared) === s.db.sha) {
    fs.mkdirSync(path.dirname(P.db), { recursive: true });
    // The first time, this computer's own database is kept aside in case it's wanted back.
    if (!st.pulledSha && fs.existsSync(P.db)) fs.copyFileSync(P.db, P.db.replace(/\.db$/, '.before-pc-sync.db'));
    fs.copyFileSync(shared, P.db + '.tmp');
    fs.renameSync(P.db + '.tmp', P.db);
    st.pulledSha = s.db.sha;
    any = true;
  }
  st.pulled = st.pulled || {};
  for (const f of FILES) {
    const a = path.join(dir, 'files', f);
    if (!fs.existsSync(a)) continue;
    const m = fs.statSync(a).mtimeMs;
    if (st.pulled[f] === m || readJson(a, undefined) === undefined) continue;
    fs.copyFileSync(a, path.join(P.dir, f));
    st.pulled[f] = m;
    any = true;
  }
  const study = path.join(P.dir, 'study');
  const before = new Map(readJson(path.join(study, 'index.json'), []).map((e) => [e.id, e]));
  for (const d of DIRS) if (copyTree(path.join(dir, 'files', d), path.join(P.dir, d))) any = true;
  // Study sets: the scanner's list, plus ones asked for here that it hasn't started yet.
  const theirs = readJson(path.join(dir, 'files', 'study', 'index.json'), null);
  if (theirs) {
    const ids = new Set(theirs.map((e) => e.id));
    const waiting = [...before.values()].filter((e) => !ids.has(e.id) && e.status === 'making' && Date.now() - new Date(e.createdAt).getTime() < 6 * 3600e3);
    const list = [...theirs, ...waiting];
    if (JSON.stringify(list) !== JSON.stringify([...before.values()])) {
      writeJson(path.join(study, 'index.json'), list);
      any = true;
      for (const e of theirs) {
        if (e.status === 'ready' && before.get(e.id)?.status === 'making' && Notification.isSupported()) new Notification({ title: e.title, body: `${e.count} ${e.kind === 'exam' ? 'questions' : 'cards'}, ready in My resources.` }).show();
      }
    }
  }
  if (mergeStudy({ attempts: readJson(path.join(dir, 'files', 'study', 'attempts.json'), {}), cards: readJson(path.join(dir, 'files', 'study', 'cards.json'), {}) })) any = true;
  // Checkmarks: newest change wins; when checks last ran comes from the scanner (so a takeover doesn't rescan today).
  const theirState = readJson(path.join(dir, 'files', 'kea.json'), null);
  if (theirState) {
    if (hooks.applyMarks({ done: theirState.doneLog || {} })) any = true;
    const ks = hooks.readState();
    if (JSON.stringify(ks.lastRuns || {}) !== JSON.stringify(theirState.lastRuns || {})) {
      ks.lastRuns = theirState.lastRuns || {};
      hooks.writeState(ks);
    }
  }
  // Textbooks: the phone copy's folder is the scanner's textbooks. (Not pruned the first time, so nothing of this
  // computer's own is deleted before its classes have come in.)
  const books = path.join(path.dirname(dir), 'Textbooks');
  if (fs.existsSync(books)) {
    if (st.pulledSha) cloud.mirror(books, P.textbooks);
    else for (const cls of fs.readdirSync(books)) for (const f of fs.readdirSync(path.join(books, cls))) copyIfChanged(path.join(books, cls, f), path.join(P.textbooks, cls, f));
  }
  if (any) {
    st.unread = readIds(false);
    // What was done here and the scanner hasn't taken in yet stays done here.
    hooks.applyMarks({ ...mine, study: null });
    const now = marksOf(st);
    if (JSON.stringify(now) !== JSON.stringify(mine)) writeJson(minePath, now);
  }
  writeJson(stateFile(), st);
  if (any) changed();
}

// ---------- Running it ----------
let busy = false;
let lastRole = null;
async function step() {
  const dir = folder();
  if (!dir || busy || !hooks) return;
  busy = true;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const role = await decide(dir);
    if (role !== lastRole) {
      lastRole = role;
      changed();
    }
    if (role === 'scanner') await lead(dir);
    else await follow(dir);
  } catch (err) {
    console.error('PC sync', err);
  } finally {
    busy = false;
  }
}
let timer = null;
function soon(delay = 5000) {
  clearTimeout(timer);
  timer = setTimeout(step, delay);
}

/** Ask the scanner to run something (a scan, a study set, a look for announcements). Returns its name. */
function relay(req) {
  const dir = folder();
  const s = scannerInfo(dir);
  if (!dir || !s) throw new Error('No computer is set to scan your classes yet.');
  writeJson(path.join(dir, 'requests', `${Date.now()}-${me()}.json`), { ...req, from: myName(), at: new Date().toISOString() });
  const online = Date.now() - new Date(s.at).getTime() < 3 * HEARTBEAT;
  return { relayed: s.name, online };
}

// ---------- Bringing classes in on a new computer, by hand ----------
/** The places a sync folder could be: every drive found on this computer, plus the chosen other folder. */
function places() {
  const out = cloud.drives().map((d) => ({ drive: d.id, label: d.label, root: d.path }));
  const custom = settings.get('scholar.cloudPath', '');
  if (custom && fs.existsSync(custom)) out.push({ drive: 'custom', label: custom, root: custom });
  return out;
}

/**
 * Look in every drive for classes another computer shares: each Kea/<profile>/PCs with who scans it and whether its
 * class database has fully arrived. Also says what's missing when nothing is found, so the student knows what to fix.
 */
function find() {
  const found = [];
  const notes = [];
  const drives = places();
  if (!drives.length) notes.push('No OneDrive, Google Drive or Dropbox folder was found on this computer. Sign in to the same drive app as your other computer, let it finish syncing, then check again.');
  for (const d of drives) {
    const kea = path.join(d.root, 'Kea');
    if (!fs.existsSync(kea)) {
      notes.push(`${d.label}: no Kea folder yet. If your other computer uses ${d.label}, check that this computer is signed in to the same account and has finished syncing.`);
      continue;
    }
    for (const name of fs.readdirSync(kea)) {
      const dir = path.join(kea, name, 'PCs');
      if (!fs.existsSync(path.join(kea, name)) || !fs.statSync(path.join(kea, name)).isDirectory()) continue;
      const s = readJson(path.join(dir, 'scanner.json'), null);
      if (!s?.id) {
        notes.push(`${d.label}: “${name}” has a phone copy but no computer sharing it yet. Update Kea on your other computer to 0.27 or later and leave it open for a minute.`);
        continue;
      }
      const db = path.join(dir, 'academic_sync.db');
      let ready = false;
      try {
        ready = !!s.db && fs.statSync(db).size === s.db.size;
      } catch {}
      found.push({ drive: d.drive, label: d.label, root: d.root, profile: name, scanner: s.name, at: s.at, mine: s.id === me(), ready });
    }
  }
  return { found, notes, me: myName() };
}

/**
 * Use the classes shared in that folder on this computer: Kea syncs through that drive and profile from now on, this
 * computer follows the one that scans (even if it has older classes of its own; those are kept aside), and the first
 * copy is made right away. Says whether the classes came in, or what it's still waiting for.
 */
async function join({ drive, root, profile }) {
  const patch = { 'scholar.pcSync': true, 'scholar.cloud': drive };
  if (drive === 'custom') patch['scholar.cloudPath'] = root;
  if (settings.get('scholar.pcRole', 'auto') === 'main') patch['scholar.pcRole'] = 'auto';
  // A share this computer started by itself (under another drive or profile name) stops, so it doesn't keep scanning.
  const old = folder();
  if (old && path.resolve(old) !== path.resolve(root, 'Kea', profile, 'PCs') && scannerInfo(old)?.id === me()) {
    fs.rmSync(old, { recursive: true, force: true });
    try {
      if (!fs.readdirSync(path.dirname(old)).length) fs.rmdirSync(path.dirname(old));
    } catch {}
  }
  settings.set(patch);
  // The drive folder is named after the profile, so this profile takes that name.
  if (profiles.all().list.find((p) => p.id === profiles.active())?.name !== profile) profiles.rename(profiles.active(), profile);
  const dir = folder();
  if (!dir || !fs.existsSync(path.join(dir, 'scanner.json'))) throw new Error('That folder isn’t there any more. Check the drive is still syncing, then try again.');
  const s = scannerInfo(dir);
  if (s.id === me()) return { ok: true, scanner: true };
  const st = readJson(stateFile(), {});
  st.chosen = true;
  writeJson(stateFile(), st);
  while (busy) await new Promise((r) => setTimeout(r, 200));
  await step();
  const P = profiles.paths();
  const got = readJson(stateFile(), {}).pulledSha === s.db?.sha && fs.existsSync(P.db);
  return got ? { ok: true, from: s.name } : { ok: false, from: s.name, waiting: `Your classes from ${s.name} are still downloading from the drive. Leave Kea open; they appear by themselves within a few minutes.` };
}

/** For the Scans page: who scans, when it was last heard from, and what it's doing. */
function status() {
  const dir = folder();
  if (!dir) return { on: false };
  const s = scannerInfo(dir);
  let others = 0;
  try {
    others = fs.readdirSync(dir).filter((x) => /^pc-.+\.json$/.test(x) && x !== `pc-${me()}.json`).length;
  } catch {}
  // Classes another computer shares elsewhere in the drives (most often: the same classes under another profile name).
  let elsewhere = [];
  try {
    elsewhere = find().found.filter((x) => !x.mine && path.resolve(x.root, 'Kea', x.profile, 'PCs') !== path.resolve(dir));
  } catch {}
  return { on: true, me: myName(), role: !s ? 'none' : s.id === me() ? 'scanner' : 'follower', scanner: s ? { name: s.name, at: s.at, running: s.running || null } : null, others, elsewhere };
}

module.exports = { configure, follower, step, soon, relay, status, mergeStudy, find, join };
