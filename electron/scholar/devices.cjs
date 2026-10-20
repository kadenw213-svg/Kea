// Your devices, one set of classes. Every computer running Kea with the same drive (OneDrive or Google Drive) keeps in
// step through one folder in it, and only the PRIMARY device ever looks at the class site or runs Claude, so a second
// install never doubles the usage. Any device can be made the primary with one button.
//
//   <drive>/Kea/<profile>/Devices/primary.json        which device scans { id, name, since, at, db, run, queue }
//   <drive>/Kea/<profile>/Devices/classes.db          the primary's class database
//   <drive>/Kea/<profile>/Devices/shared/...          its Inbox, scan news, grades, hand-ins, study sets, check baselines
//   <drive>/Kea/<profile>/Devices/devices/<id>.json   each device: name, when it was last on, its drive, and its own
//                                                     changes (checkmarks, read, deleted, study progress)
//   <drive>/Kea/<profile>/Devices/requests/*.json     scans, study sets and stops asked for on another device
//
// The others copy the primary's results in (textbooks come from the phone copy's Textbooks/ folder next to Devices) and
// send what was done on them back, the way the phone does. Their scan buttons ask the primary to run things, and they
// show the primary's progress bar live.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, Notification } = require('electron');
const profiles = require('./profiles.cjs');
const settings = require('../settings.cjs');
const cloud = require('./cloud.cjs');
const runner = require('./runner.cjs');
const precheck = require('./precheck.cjs');

// What the primary shares, relative to the profile folder. (kea.json and study progress are merged, not copied.)
const FILES = ['inbox.json', 'news.json', 'grades.json', 'submissions.json', 'precheck.json', 'sync-state.json', 'activity.json'];
const DIRS = [path.join('scholar', 'data', 'digests', 'kea-inbox'), path.join('study', 'sets'), path.join('study', 'images')];
const MERGED = ['kea.json', path.join('study', 'index.json'), path.join('study', 'attempts.json'), path.join('study', 'cards.json')];
const HEARTBEAT = 5 * 60000;
// A device not heard from in this long shows as off.
const ONLINE = 3 * HEARTBEAT;

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
const ago = (iso) => Date.now() - new Date(iso || 0).getTime();

/** This device's id (made once) and the name other devices see. */
function me() {
  let id = settings.get('scholar.pcId', '');
  if (!id) {
    id = crypto.randomUUID().slice(0, 8);
    settings.set({ 'scholar.pcId': id });
  }
  return id;
}
const myName = () => settings.get('scholar.deviceName', '') || os.hostname();

/** The Devices folder for the active profile, or null when syncing between devices is off or there's no drive. */
function folder() {
  if (settings.get('scholar.pcSync', true) === false) return null;
  const t = cloud.target();
  return t ? path.join(t, 'Devices') : null;
}
const primaryInfo = (dir = folder()) => (dir ? readJson(path.join(dir, 'primary.json'), null) : null);
// This device's own record of syncing (per profile, never shared).
const stateFile = () => path.join(profiles.paths().dir, 'devices.json');

/** True when another device is the primary, so this one mustn't scan, poll the class site or write the phone copy. */
function follower() {
  const p = primaryInfo();
  if (p && p.id) {
    // Remembered, so a drive that isn't mounted yet (or a file mid-sync) never turns this device into a scanner.
    if (settings.get('scholar.lastPrimary', '') !== p.id) settings.set({ 'scholar.lastPrimary': p.id });
    return p.id !== me();
  }
  const last = settings.get('scholar.lastPrimary', '');
  return settings.get('scholar.pcSync', true) !== false && !!last && last !== me();
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
  // A shared folder that isn't there (the drive not caught up yet) is never a reason to delete what's here.
  if (!fs.existsSync(src)) return false;
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

// ---------- This device's card in the folder ----------
const readIds = (read) => [...precheck.readInbox().items.filter((i) => !!i.read === read).map((i) => i.id), ...runner.news().filter((n) => !!n.read === read).map((n) => `scan:${n.id}`)];

/**
 * This device's changes for the primary. Read: only what was still unread in the primary's last copy (so an
 * announcement the teacher edits, which comes back unread, isn't marked read again by an old read here).
 */
function marksOf(st) {
  const s = hooks.readState();
  const study = path.join(profiles.paths().dir, 'study');
  const wasUnread = new Set(st.unread || []);
  return {
    done: s.doneLog || {},
    read: readIds(true).filter((id) => wasUnread.has(id)),
    deleted: precheck.readInbox().deletedKeys || [],
    study: { attempts: readJson(path.join(study, 'attempts.json'), {}), cards: readJson(path.join(study, 'cards.json'), {}) }
  };
}

/** Write this device's card: who it is, that it's on, which drive it uses, and (on other devices) its changes. */
function writeCard(dir, marks) {
  const file = path.join(dir, 'devices', `${me()}.json`);
  const d = cloud.drive();
  const card = { id: me(), name: myName(), version: app.getVersion(), drive: d ? { label: d.label, account: d.account } : null, ...(marks ? { marks } : {}) };
  const old = readJson(file, null);
  const { at, ...rest } = old || {};
  if (old && JSON.stringify(rest) === JSON.stringify(card) && ago(at) < HEARTBEAT) return;
  writeJson(file, { ...card, at: new Date().toISOString() });
}

// ---------- Which device is the primary ----------
function claim(dir, id = me(), name = myName()) {
  const p = primaryInfo(dir);
  writeJson(path.join(dir, 'primary.json'), { id, name, since: new Date().toISOString(), at: new Date().toISOString(), db: p?.db || null, run: null, queue: [] });
  console.log(`Devices: ${id === me() ? 'this device' : name} is now the primary`);
}

/** Decide (and, when nobody is, take) the primary role. Returns 'primary' or 'follower'. */
async function decide(dir) {
  const p = primaryInfo(dir);
  const hasDb = fs.existsSync(profiles.paths().db);
  if (p?.id === me()) return 'primary';
  if (!p) {
    // Kea 0.27 kept this in a PCs folder: the device that scanned there stays the primary.
    const old = readJson(path.join(path.dirname(dir), 'PCs', 'scanner.json'), null);
    if (old?.id && old.id !== me() && ago(old.at) < 864e5) return 'follower';
    // Another device scanned before and its file just can't be read right now (mid-sync): stay a follower.
    const last = settings.get('scholar.lastPrimary', '');
    if (last && last !== me()) return 'follower';
    // Nobody scans yet: the first device with classes does.
    if (hasDb) return claim(dir), 'primary';
    return 'follower';
  }
  // Taking over from a primary that's been off for a long time, only if the student chose that (Settings → Advanced).
  const hours = Number(settings.get('scholar.pcTakeover', '0'));
  if (hours > 0 && ago(p.at) > hours * 3600e3 && hasDb && (await hooks.ready())) return claim(dir), 'primary';
  return 'follower';
}

/** Make a device the primary (this one, or another listed in the folder). That device starts scanning; this one follows. */
function makePrimary(id) {
  const dir = folder();
  if (!dir) throw new Error('Choose a drive to sync through first.');
  const card = readJson(path.join(dir, 'devices', `${id}.json`), null);
  if (id !== me() && !card) throw new Error('That device isn’t in the folder any more.');
  if (id === me() && !fs.existsSync(profiles.paths().db)) throw new Error('This device has no classes yet. Bring them in from your other device first, then make it the primary.');
  claim(dir, id, id === me() ? myName() : card.name);
  soon(500);
  changed();
  return status();
}

// ---------- The primary: share results, take in the others' changes, run what they asked for ----------
let lastRunWrite = 0;
async function lead(dir) {
  const P = profiles.paths();
  const st = readJson(stateFile(), {});
  st.seen = st.seen || {};
  writeCard(dir, null);
  // What the other devices did (checkmarks, read and deleted messages, study progress), each version taken in once.
  const cards = path.join(dir, 'devices');
  if (fs.existsSync(cards)) {
    for (const f of fs.readdirSync(cards).filter((x) => x.endsWith('.json') && x !== `${me()}.json`)) {
      const m = fs.statSync(path.join(cards, f)).mtimeMs;
      if (st.seen[f] === m) continue;
      st.seen[f] = m;
      writeJson(stateFile(), st);
      const marks = readJson(path.join(cards, f), null)?.marks;
      if (marks && hooks.applyMarks(marks)) hooks.syncSoon(5000);
    }
  }
  // Scans, study sets and stops asked for on another device.
  const reqDir = path.join(dir, 'requests');
  if (fs.existsSync(reqDir)) {
    for (const f of fs.readdirSync(reqDir).filter((x) => x.endsWith('.json')).sort()) {
      const full = path.join(reqDir, f);
      const r = readJson(full, null);
      fs.rmSync(full, { force: true });
      if (!r?.task) continue;
      // Only from a device that's part of this sync, only Kea's own kinds of request, and only an argument shaped like
      // the ones Kea's own buttons send (a class code, "missing CODE", chapter names), never free text: an argument
      // becomes the start of a Claude prompt, and the folder is only as private as the cloud account.
      const from = f.replace(/\.json$/, '').split('-').slice(1).join('-');
      if (!from || !fs.existsSync(path.join(dir, 'devices', `${from}.json`))) {
        console.error(`Devices: ignored a request from an unknown device (${f})`);
        continue;
      }
      const TASKS = ['stop', 'resume', 'banks', 'inbox', 'practice', 'daily', 'sync', 'import', 'study', 'curriculum', 'steps', 'transcribe'];
      const arg = String(r.arg || '');
      if (!TASKS.includes(r.task) || arg.length > 300 || /[\r\n<>`$|;]/.test(arg) || (arg && !/^[\w .,:#()&'/+-]+$/.test(arg))) {
        console.error(`Devices: ignored a request it doesn't recognize (${r.task})`);
        continue;
      }
      console.log(`Devices: ${r.from || 'another device'} asked for ${r.task}`);
      try {
        if (r.task === 'stop') runner.stop();
        else if (r.task === 'resume') runner.pending() ? runner.resume() : runner.resumeLast(r.arg || 'import');
        else if (r.task === 'banks') hooks.banks?.();
        else if (r.task === 'inbox') precheck.pollAnnouncements().then((ok) => ok && hooks.syncSoon(5000)).catch(() => {});
        else if (r.task === 'practice') {
          const { id, ready } = await require('./study.cjs').request(r.req || {});
          if (ready) soon(1000);
          else runner.run('practice', id, 'manual').then(() => soon(3000));
        } else if (runner.TASKS[r.task] && r.task !== 'probe') runner.run(r.task, r.arg || '', 'manual').then(() => soon(3000));
      } catch (err) {
        console.error('Devices request', err);
      }
    }
  }
  const p = primaryInfo(dir) || {};
  const now = runner.status();
  let db = p.db || null;
  // Results are shared between runs only, never half-written.
  if (!now.running && fs.existsSync(P.db)) {
    const ds = fs.statSync(P.db);
    if (!db || db.mtime !== ds.mtimeMs || db.size !== ds.size) {
      fs.copyFileSync(P.db, path.join(dir, 'classes.db.tmp'));
      fs.renameSync(path.join(dir, 'classes.db.tmp'), path.join(dir, 'classes.db'));
      db = { mtime: ds.mtimeMs, size: ds.size, sha: sha(P.db) };
    }
    for (const f of [...FILES, ...MERGED]) if (fs.existsSync(path.join(P.dir, f))) copyIfChanged(path.join(P.dir, f), path.join(dir, 'shared', f));
    for (const d of DIRS) copyTree(path.join(P.dir, d), path.join(dir, 'shared', d));
  }
  // What's running (for the other devices' progress bars) and that this device is still on.
  const r = now.running;
  const run = r ? { label: r.label, arg: r.arg, start: r.start, phase: r.phase, claudeStart: r.claudeStart, expectedMs: r.expectedMs, expectedTurns: r.expectedTurns, turns: r.turns, percent: r.percent, batch: r.batch, step: r.steps[r.steps.length - 1]?.message || '' } : null;
  const queue = now.queued.map((q) => ({ label: q.label, arg: q.arg, expectedMs: q.expectedMs }));
  const runChanged = JSON.stringify(run && { ...run, turns: Math.floor(run.turns / 3) }) !== JSON.stringify(p.run && { ...p.run, turns: Math.floor(p.run.turns / 3) }) || JSON.stringify(queue) !== JSON.stringify(p.queue || []);
  if (db !== p.db || (runChanged && Date.now() - lastRunWrite > 15000) || (!run && p.run) || p.name !== myName() || ago(p.at) > HEARTBEAT) {
    lastRunWrite = Date.now();
    writeJson(path.join(dir, 'primary.json'), { ...p, id: me(), name: myName(), at: new Date().toISOString(), db, run, queue, pending: runner.pending() });
  }
  // The 0.27 folder isn't used any more.
  fs.rmSync(path.join(path.dirname(dir), 'PCs'), { recursive: true, force: true });
}

// ---------- Another device: copy the results in, send this one's changes out ----------
/** Study progress from another device: every attempt kept, and the newer flashcard progress per set. */
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
  // This device's own changes first, so nothing done here is lost when the primary's copies come in.
  const mine = marksOf(st);
  writeCard(dir, mine);

  const p = primaryInfo(dir);
  let any = false;
  const shared = path.join(dir, 'classes.db');
  // The class database, once it has fully arrived (the drive may still be bringing it down).
  st.waiting = null;
  if (p?.db?.sha && p.db.sha !== st.pulledSha) {
    const size = fs.existsSync(shared) ? fs.statSync(shared).size : -1;
    if (size === p.db.size && sha(shared) === p.db.sha) {
      fs.mkdirSync(path.dirname(P.db), { recursive: true });
      // The first time, this device's own database is kept aside in case it's wanted back.
      if (!st.pulledSha && fs.existsSync(P.db)) fs.copyFileSync(P.db, P.db.replace(/\.db$/, '.before-device-sync.db'));
      fs.copyFileSync(shared, P.db + '.tmp');
      fs.renameSync(P.db + '.tmp', P.db);
      st.pulledSha = p.db.sha;
      st.pulledAt = new Date().toISOString();
      any = true;
    } else st.waiting = { since: st.waiting?.since || new Date().toISOString(), have: Math.max(0, size), of: p.db.size };
  }
  st.pulled = st.pulled || {};
  for (const f of FILES) {
    const a = path.join(dir, 'shared', f);
    if (!fs.existsSync(a)) continue;
    const m = fs.statSync(a).mtimeMs;
    if (st.pulled[f] === m || readJson(a, undefined) === undefined) continue;
    fs.copyFileSync(a, path.join(P.dir, f));
    st.pulled[f] = m;
    any = true;
  }
  const study = path.join(P.dir, 'study');
  const before = new Map(readJson(path.join(study, 'index.json'), []).map((e) => [e.id, e]));
  for (const d of DIRS) if (copyTree(path.join(dir, 'shared', d), path.join(P.dir, d))) any = true;
  // Study sets: the primary's list, plus ones asked for here that it hasn't started yet.
  const theirs = readJson(path.join(dir, 'shared', 'study', 'index.json'), null);
  if (theirs) {
    // Sets the student made or imported belong to the device they were made on (kept in study/mine, never synced
    // over): this device's own stay, and the primary's own aren't listed here.
    const shared = theirs.filter((e) => e.source !== 'mine');
    const ids = new Set(shared.map((e) => e.id));
    // (A set from saved questions is ready here at once; it stays until the primary's copy of it arrives.)
    const waiting = [...before.values()].filter((e) => !ids.has(e.id) && (((e.status === 'making' || e.source === 'saved') && ago(e.createdAt) < 6 * 3600e3) || e.source === 'mine'));
    const list = [...shared, ...waiting];
    if (JSON.stringify(list) !== JSON.stringify([...before.values()])) {
      writeJson(path.join(study, 'index.json'), list);
      any = true;
      for (const e of shared) {
        if (e.status === 'ready' && before.get(e.id)?.status === 'making' && Notification.isSupported()) new Notification({ title: e.title, body: `${e.count} ${e.kind === 'exam' ? 'questions' : 'cards'}, ready in My resources.` }).show();
      }
    }
  }
  if (mergeStudy({ attempts: readJson(path.join(dir, 'shared', 'study', 'attempts.json'), {}), cards: readJson(path.join(dir, 'shared', 'study', 'cards.json'), {}) })) any = true;
  // Checkmarks: newest change wins; when checks last ran comes from the primary (so a new primary doesn't rescan today).
  const theirState = readJson(path.join(dir, 'shared', 'kea.json'), null);
  if (theirState) {
    if (hooks.applyMarks({ done: theirState.doneLog || {} })) any = true;
    const ks = hooks.readState();
    if (JSON.stringify(ks.lastRuns || {}) !== JSON.stringify(theirState.lastRuns || {})) {
      ks.lastRuns = theirState.lastRuns || {};
      hooks.writeState(ks);
    }
  }
  // Textbooks: the phone copy's folder holds the primary's textbooks. (Not pruned until the classes have come in, so
  // nothing of this device's own is deleted first.)
  const books = path.join(path.dirname(dir), 'Textbooks');
  if (fs.existsSync(books)) {
    if (st.pulledSha) cloud.mirror(books, P.textbooks);
    else for (const cls of fs.readdirSync(books)) for (const f of fs.readdirSync(path.join(books, cls))) copyIfChanged(path.join(books, cls, f), path.join(P.textbooks, cls, f));
  }
  if (any) {
    st.unread = readIds(false);
    // What was done here and the primary hasn't taken in yet stays done here.
    hooks.applyMarks({ ...mine, study: null });
    writeCard(dir, marksOf(st));
  }
  writeJson(stateFile(), st);
  if (any) changed();
}

// ---------- Finding classes shared by another device ----------
/** The places a Devices folder could be: every drive on this computer, plus the chosen other folder. */
function places() {
  const out = cloud.drives().map((d) => ({ drive: d.id, label: d.label, account: d.account, root: d.path }));
  const custom = settings.get('scholar.cloudPath', '');
  if (custom && fs.existsSync(custom)) out.push({ drive: 'custom', label: 'Your folder', account: '', root: custom });
  return out;
}

/**
 * Look in every drive for classes another device shares: each Kea/<profile>/Devices with its primary and whether its
 * classes have fully arrived. Also says what's missing when nothing is found, so the student knows what to fix.
 */
function find() {
  const found = [];
  const notes = [];
  const drives = places();
  if (!drives.length) notes.push('No OneDrive or Google Drive was found on this computer. Install one, sign in with the same account as your other device and let it finish syncing.');
  for (const d of drives) {
    const kea = path.join(d.root, 'Kea');
    const who = d.account ? `${d.label} (${d.account})` : d.label;
    if (!fs.existsSync(kea)) {
      notes.push(`${who}: no Kea folder. If your other device uses ${d.label}, sign in here with the same account and let it finish syncing.`);
      continue;
    }
    for (const name of fs.readdirSync(kea)) {
      const pdir = path.join(kea, name);
      try {
        if (!fs.statSync(pdir).isDirectory()) continue;
      } catch {
        continue;
      }
      const dir = path.join(pdir, 'Devices');
      const p = readJson(path.join(dir, 'primary.json'), null);
      if (!p?.id) {
        if (fs.existsSync(path.join(pdir, 'PCs'))) notes.push(`${who}: “${name}” is shared by an older Kea. Update Kea on your other device and leave it open for a minute.`);
        continue;
      }
      let ready = false;
      try {
        ready = !!p.db && fs.statSync(path.join(dir, 'classes.db')).size === p.db.size;
      } catch {}
      found.push({ drive: d.drive, label: d.label, account: d.account, root: d.root, profile: name, primary: p.name, at: p.at, mine: p.id === me(), ready });
    }
  }
  return { found, notes, me: myName() };
}

/**
 * Use the classes shared in that folder on this device: Kea syncs through that drive and profile from now on and
 * follows the primary (this device's own older classes, if any, are kept aside), and the first copy is made right away.
 */
async function join({ drive, root, profile }) {
  const patch = { 'scholar.pcSync': true, 'scholar.cloud': drive };
  if (drive === 'custom') patch['scholar.cloudPath'] = root;
  // A share this device started by itself (under another drive or profile name) stops, so it doesn't keep scanning.
  const old = folder();
  if (old && path.resolve(old) !== path.resolve(root, 'Kea', profile, 'Devices') && primaryInfo(old)?.id === me()) {
    fs.rmSync(old, { recursive: true, force: true });
    try {
      if (!fs.readdirSync(path.dirname(old)).length) fs.rmdirSync(path.dirname(old));
    } catch {}
  }
  settings.set(patch);
  // The drive folder is named after the profile, so this profile takes that name.
  if (profiles.all().list.find((x) => x.id === profiles.active())?.name !== profile) profiles.rename(profiles.active(), profile);
  const dir = folder();
  if (!dir || !fs.existsSync(path.join(dir, 'primary.json'))) throw new Error('That folder isn’t there any more. Check the drive is still syncing, then try again.');
  const p = primaryInfo(dir);
  if (p.id === me()) return { ok: true, primary: true };
  while (busy) await new Promise((r) => setTimeout(r, 200));
  await step();
  const got = readJson(stateFile(), {}).pulledSha === p.db?.sha && fs.existsSync(profiles.paths().db);
  return got ? { ok: true, from: p.name } : { ok: false, from: p.name, waiting: `Your classes from ${p.name} are still downloading from the drive. Leave Kea open; they appear by themselves.` };
}

// ---------- Running it ----------
let busy = false;
let lastRole = null;
async function step() {
  const dir = folder();
  if (!dir || busy || !hooks) return;
  busy = true;
  try {
    // A new device with no classes of its own, whose profile isn't shared yet but exactly one other is in the same
    // drive (its profile has another name): that's this student's classes, so it joins them by itself.
    if (!fs.existsSync(path.join(dir, 'primary.json')) && !fs.existsSync(profiles.paths().db)) {
      const d = cloud.drive();
      const others = find().found.filter((x) => !x.mine && x.drive === d?.id);
      if (others.length === 1) {
        busy = false;
        return void (await join(others[0]));
      }
    }
    fs.mkdirSync(dir, { recursive: true });
    const role = await decide(dir);
    if (role !== lastRole) {
      lastRole = role;
      changed();
    }
    if (role === 'primary') await lead(dir);
    else await follow(dir);
  } catch (err) {
    console.error('Devices', err);
  } finally {
    busy = false;
  }
}
let timer = null;
function soon(delay = 5000) {
  clearTimeout(timer);
  timer = setTimeout(step, delay);
}

/** Ask the primary to run something (a scan, a study set, a stop). Returns its name and whether it's on. */
function relay(req) {
  const dir = folder();
  const p = primaryInfo(dir);
  if (!dir || !p) throw new Error('No device is set to scan your classes yet.');
  writeJson(path.join(dir, 'requests', `${Date.now()}-${me()}.json`), { ...req, from: myName(), at: new Date().toISOString() });
  return { relayed: p.name, online: ago(p.at) < ONLINE };
}

/**
 * Everything the Devices card shows: the drive (and its account), every device with the primary marked and whether
 * it's on, the phone, what the primary is running (for this device's progress bar), and anything needing attention.
 */
function status() {
  const d = cloud.drive();
  const base = { on: settings.get('scholar.pcSync', true) !== false, me: { id: me(), name: myName() }, drive: d, drives: cloud.drives(), choice: settings.get('scholar.cloud', 'auto') };
  const dir = folder();
  if (!dir) return { ...base, role: 'alone', devices: [], primary: null, phone: null, run: null, queue: [], elsewhere: [], waiting: null };
  const p = primaryInfo(dir);
  const devices = [];
  try {
    for (const f of fs.readdirSync(path.join(dir, 'devices')).filter((x) => x.endsWith('.json'))) {
      const c = readJson(path.join(dir, 'devices', f), null);
      if (!c?.id) continue;
      devices.push({ id: c.id, name: c.name, at: c.at, version: c.version, drive: c.drive, primary: c.id === p?.id, me: c.id === me(), online: c.id === me() || ago(c.at) < ONLINE });
    }
  } catch {}
  if (!devices.some((x) => x.me)) devices.push({ id: me(), name: myName(), at: new Date().toISOString(), version: app.getVersion(), drive: d ? { label: d.label, account: d.account } : null, primary: p?.id === me(), me: true, online: true });
  devices.sort((a, b) => Number(b.primary) - Number(a.primary) || Number(b.me) - Number(a.me));
  let phone = null;
  try {
    phone = { at: fs.statSync(path.join(path.dirname(dir), 'phone.json')).mtime.toISOString() };
  } catch {}
  let elsewhere = [];
  try {
    elsewhere = find().found.filter((x) => !x.mine && path.resolve(x.root, 'Kea', x.profile, 'Devices') !== path.resolve(dir));
  } catch {}
  const st = readJson(stateFile(), {});
  const role = !p ? 'alone' : p.id === me() ? 'primary' : 'follower';
  return { ...base, role, folder: path.dirname(dir), primary: p ? { id: p.id, name: p.name, at: p.at, online: p.id === me() || ago(p.at) < ONLINE } : null, devices, phone, run: role === 'follower' ? p.run || null : null, queue: role === 'follower' ? p.queue || [] : [], pending: role === 'follower' ? p.pending || null : null, elsewhere, waiting: role === 'follower' ? st.waiting || null : null, pulledAt: st.pulledAt || null };
}

module.exports = { configure, follower, step, soon, relay, status, mergeStudy, find, join, makePrimary };
