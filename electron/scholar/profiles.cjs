// Kea Scholar profiles ("School", "Personal"): each keeps its own classes, textbooks, scan engine and settings,
// in userData/profiles/<id>/. Profiles are local for now; a Kea server may sync them later.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const root = () => path.join(app.getPath('userData'), 'profiles');
const indexFile = () => path.join(root(), 'profiles.json');

// ---------- State files that must survive a crash or a full disk mid-write ----------
// Written to <file>.tmp and renamed over the file (a rename is all-or-nothing), with the last good copy kept as
// <file>.bak. A file cut short (Kea killed mid-write, a power cut) is read from the .bak instead, and one that can't be
// read at all is set aside (<file>.unreadable-<time>) before anything new is saved over it, never silently replaced.
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function renameRetry(a, b) {
  for (let i = 0; ; i++) {
    try {
      return fs.renameSync(a, b);
    } catch (err) {
      // (Windows: a virus scanner or the drive app can hold the file for a moment.)
      if (i >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      sleep(50 * (i + 1));
    }
  }
}
const parse = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

/**
 * Read a JSON state file. Returns { value, from }: from is 'file', 'bak' (the file was damaged or missing and its
 * backup was read), 'none' (neither exists yet; value is the fallback) or 'unreadable' (both damaged; value is the
 * fallback, and writeJsonSafe sets the damaged file aside before saving over it).
 */
function readJsonSafe(file, fallback) {
  try {
    return { value: parse(file), from: 'file' };
  } catch (err) {
    const missing = err.code === 'ENOENT';
    try {
      const value = parse(file + '.bak');
      console.error(`Kea: ${path.basename(file)} ${missing ? 'was missing' : 'could not be read'}; using its backup`);
      return { value, from: 'bak' };
    } catch {}
    if (missing) return { value: fallback, from: 'none' };
    console.error(`Kea: ${path.basename(file)} and its backup could not be read`, err.message);
    return { value: fallback, from: 'unreadable' };
  }
}

/** Write a JSON state file all-or-nothing, keeping the last good copy as .bak. */
function writeJsonSafe(file, value, space = 2) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = JSON.stringify(value, null, space);
  if (body === undefined) throw new Error(`Refusing to write nothing to ${path.basename(file)}`);
  if (fs.existsSync(file)) {
    let good = false;
    try {
      parse(file);
      good = true;
    } catch {}
    if (good) fs.copyFileSync(file, file + '.bak');
    else {
      // A damaged file is kept for a person to look at, and the good backup stays the backup.
      const aside = `${file}.unreadable-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      try {
        fs.copyFileSync(file, aside);
        console.error(`Kea: set aside a damaged ${path.basename(file)} as ${path.basename(aside)}`);
      } catch {}
    }
  }
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, body);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  renameRetry(tmp, file);
}

function read() {
  const { value: j, from } = readJsonSafe(indexFile(), null);
  if (j && Array.isArray(j.list) && j.list.length) return j;
  if (from !== 'none') {
    // The list was lost but the profiles' folders are still here: rebuild it from them rather than start over.
    try {
      const list = fs
        .readdirSync(root(), { withFileTypes: true })
        .filter((e) => e.isDirectory() && /^[a-z0-9-]+$/.test(e.name))
        .map((e) => ({ id: e.name, name: e.name === 'school' ? 'School' : e.name.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()), created: new Date().toISOString() }));
      if (list.length) {
        console.error(`Kea: rebuilt the profile list from ${list.length} profile folder(s)`);
        const j2 = { active: list.some((p) => p.id === 'school') ? 'school' : list[0].id, list };
        write(j2); // (the damaged file is set aside first)
        return j2;
      }
    } catch {}
  }
  return null;
}

function write(j) {
  writeJsonSafe(indexFile(), j);
}

/** The profile list, creating the first one ("School") the first time Scholar is used. */
function all() {
  let j = read();
  if (!j) {
    j = { active: 'school', list: [{ id: 'school', name: 'School', created: new Date().toISOString() }] };
    write(j);
  }
  if (!j.list.some((p) => p.id === j.active)) j.active = j.list[0].id;
  return j;
}

const active = () => all().active;

function create(name) {
  const j = all();
  const clean = String(name || '').trim().slice(0, 40) || 'Profile';
  let id = clean.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'profile';
  for (let n = 2; j.list.some((p) => p.id === id); n++) id = `${id.replace(/-\d+$/, '')}-${n}`;
  j.list.push({ id, name: clean, created: new Date().toISOString() });
  j.active = id;
  write(j);
  return j;
}

function select(id) {
  const j = all();
  if (j.list.some((p) => p.id === id)) j.active = id;
  write(j);
  return j;
}

function rename(id, name) {
  const j = all();
  const p = j.list.find((x) => x.id === id);
  if (p && String(name || '').trim()) p.name = String(name).trim().slice(0, 40);
  write(j);
  return j;
}

/** Where a profile's things live. */
function paths(id = active()) {
  const dir = path.join(root(), id);
  return {
    dir,
    /** The scan engine's workspace (its own copy of the engine, its database and downloads). */
    workspace: path.join(dir, 'scholar'),
    db: path.join(dir, 'scholar', 'data', 'academic_sync.db'),
    /** One folder per class with its study PDFs ("textbook" chapters). */
    textbooks: path.join(dir, 'textbooks'),
    /** Kea's own state for the profile: what's checked off, notes. The engine's database is never written by Kea. */
    state: path.join(dir, 'kea.json')
  };
}

module.exports = { all, active, create, select, rename, paths, readJsonSafe, writeJsonSafe };
