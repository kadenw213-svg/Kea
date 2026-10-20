// Kea's copy of a profile's Scholar data in the student's cloud drive (OneDrive by default, or Google Drive, or any
// folder), for Kea on their phone. Kept small and tidy on purpose: one folder per profile holding one data file and
// the textbook PDFs, rewritten only when something changed, and anything that no longer belongs is deleted.
//
//   <drive>/Kea/<profile>/kea-data.json      classes, calendar, grades, inbox, what's handed in, study sets and progress
//   <drive>/Kea/<profile>/kea-library.zip    the textbook PDFs (Textbooks/<CODE>/...) and question pictures (study/images/...)
//   <drive>/Kea/<profile>/phone.json         what the phone did (checkmarks, read, study progress, requests)
//
// The phone holds these three files by themselves (Android's Google Drive and OneDrive apps can't share a folder), so
// each is rewritten in place, never replaced: a replaced file is a new file to the drive, and the phone would lose it.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const profiles = require('./profiles.cjs');
const settings = require('../settings.cjs');

/**
 * OneDrive accounts signed in on this computer, from OneDrive's own settings (the OneDrive environment variables aren't
 * always there for apps): [{ id, label, path, account }]. The account (email) shows which OneDrive it is, since two
 * computers only see each other's files when they're signed in to the same one.
 */
function oneDrives() {
  const out = [];
  try {
    const raw = require('child_process').execSync('reg query "HKCU\\Software\\Microsoft\\OneDrive\\Accounts" /s', { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    let cur = null;
    const accounts = [];
    for (const line of raw.split(/\r?\n/)) {
      const key = /\\Accounts\\([^\\]+)$/.exec(line.trim());
      if (key) accounts.push((cur = { key: key[1] }));
      const v = /^\s+(UserFolder|UserEmail|DisplayName)\s+REG_SZ\s+(.*)$/.exec(line);
      if (v && cur) cur[v[1]] = v[2].trim();
    }
    for (const a of accounts) {
      if (!a.UserFolder || !fs.existsSync(a.UserFolder)) continue;
      const personal = a.key === 'Personal';
      out.push({ id: personal ? 'onedrive' : `onedrive-${a.key.toLowerCase()}`, label: personal ? 'OneDrive' : `OneDrive (${a.DisplayName || 'work or school'})`, path: a.UserFolder, account: a.UserEmail || '' });
    }
  } catch {}
  const env = process.env.OneDriveConsumer || process.env.OneDrive;
  if (!out.length && env && fs.existsSync(env)) out.push({ id: 'onedrive', label: 'OneDrive', path: env, account: '' });
  return out;
}

let found = { at: 0, list: [] };
/** Cloud drives found on this computer: { id, label, path, account }. (Looked up at most once a minute.) */
function drives() {
  if (Date.now() - found.at < 60000) return found.list;
  const out = oneDrives();
  // Google Drive for desktop: a drive letter with "My Drive", or the older folder in the home directory.
  for (const letter of 'DEFGHIJKLMNOPQRSTUVWXYZ') {
    const p = `${letter}:\\My Drive`;
    try {
      if (fs.existsSync(p)) {
        out.push({ id: 'google', label: 'Google Drive', path: p, account: `${letter}: drive` });
        break;
      }
    } catch {}
  }
  for (const gd of [path.join(os.homedir(), 'Google Drive', 'My Drive'), path.join(os.homedir(), 'My Drive'), path.join(os.homedir(), 'Google Drive')]) {
    if (!out.some((d) => d.id === 'google') && fs.existsSync(gd)) out.push({ id: 'google', label: 'Google Drive', path: gd, account: '' });
  }
  const db = path.join(os.homedir(), 'Dropbox');
  if (fs.existsSync(db)) out.push({ id: 'dropbox', label: 'Dropbox', path: db, account: '' });
  found = { at: Date.now(), list: out };
  return out;
}

/** The drive Kea syncs through ({ id, label, path, account }), or null when syncing is off or that drive isn't here. */
function drive() {
  const choice = settings.get('scholar.cloud', 'auto');
  if (choice === 'off') return null;
  if (choice === 'custom') {
    const p = settings.get('scholar.cloudPath', '');
    return p && fs.existsSync(p) ? { id: 'custom', label: 'Your folder', path: p, account: '' } : null;
  }
  const list = drives();
  // Automatic: OneDrive if it's here, otherwise Google Drive.
  if (choice === 'auto') return list.find((d) => d.id === 'onedrive') || list.find((d) => d.id === 'google') || list[0] || null;
  return list.find((d) => d.id === choice) || null;
}

/** The folder Kea syncs into for the active profile, or null when syncing is off or the drive isn't there. */
function target() {
  const root = drive()?.path;
  if (!root || !fs.existsSync(root)) return null;
  const name = (profiles.all().list.find((p) => p.id === profiles.active())?.name || profiles.active()).replace(/[<>:"/\\|?*]+/g, '').trim() || 'School';
  return path.join(root, 'Kea', name);
}

const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');
const readSig = () => {
  try {
    return fs.readFileSync(path.join(profiles.paths().dir, 'library.sig'), 'utf8');
  } catch {
    return '';
  }
};

/** Copy src → dst only when it changed (size or time), then delete everything in dst that src doesn't have. */
function mirror(src, dst) {
  const keep = new Set();
  if (fs.existsSync(src)) {
    for (const cls of fs.readdirSync(src)) {
      const from = path.join(src, cls);
      if (!fs.statSync(from).isDirectory()) continue;
      for (const f of fs.readdirSync(from).filter((x) => x.toLowerCase().endsWith('.pdf'))) {
        const a = path.join(from, f);
        const b = path.join(dst, cls, f);
        keep.add(path.resolve(b));
        const sa = fs.statSync(a);
        let same = false;
        try {
          const sb = fs.statSync(b);
          same = sb.size === sa.size && Math.abs(sb.mtimeMs - sa.mtimeMs) < 2000;
        } catch {}
        if (!same) {
          fs.mkdirSync(path.dirname(b), { recursive: true });
          fs.copyFileSync(a, b);
          fs.utimesSync(b, sa.atime, sa.mtime);
        }
      }
    }
  }
  // Clean up: files Kea put here that no longer exist, then empty folders.
  if (!fs.existsSync(dst)) return;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
        if (!fs.readdirSync(p).length) fs.rmdirSync(p);
      } else if (!keep.has(path.resolve(p))) fs.rmSync(p, { force: true });
    }
  };
  walk(dst);
}

// ---------- The library: one zip the phone unpacks (stored, not compressed: PDFs and JPEGs are compressed already) ----------
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Every file the library holds: [{ name (in the zip), file (on disk), size, mtime }], in a fixed order. */
function libraryFiles() {
  const P = profiles.paths();
  const out = [];
  const walk = (dir, prefix, keep) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, `${prefix}${e.name}/`, keep);
      else if (keep(e.name)) {
        const st = fs.statSync(full);
        out.push({ name: `${prefix}${e.name}`, file: full, size: st.size, mtime: Math.round(st.mtimeMs) });
      }
    }
  };
  walk(P.textbooks, 'Textbooks/', (n) => /\.pdf$/i.test(n));
  walk(path.join(P.dir, 'study', 'images'), 'study/images/', (n) => /\.(jpe?g|png|webp|gif|svg)$/i.test(n));
  return out;
}

/** Write a zip of `files` (stored) to `dest`, in place. */
function writeZip(files, dest) {
  const parts = [];
  const central = [];
  let offset = 0;
  const dos = (ms) => {
    const d = new Date(ms);
    return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
  };
  for (const f of files) {
    const data = fs.readFileSync(f.file);
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(data);
    const { time, date } = dos(f.mtime);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(0, 10);
    c.writeUInt16LE(time, 12);
    c.writeUInt16LE(date, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  writeInPlace(dest, Buffer.concat([...parts, cd, end]));
}

/** Rewrite a file's contents without replacing the file (so the drive keeps it as the same file the phone holds). */
function writeInPlace(file, body) {
  const fd = fs.openSync(file, fs.existsSync(file) ? 'r+' : 'w');
  try {
    fs.ftruncateSync(fd, 0);
    const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
    fs.writeSync(fd, buf, 0, buf.length, 0);
  } finally {
    fs.closeSync(fd);
  }
}

let timer = null;
let running = false;
/** Sync soon (several changes in a row become one sync). */
function schedule(build, delay = 20000) {
  clearTimeout(timer);
  timer = setTimeout(() => sync(build).catch((err) => console.error('Cloud sync', err)), delay);
}

/** Write the data file (if it changed) and mirror the textbooks. `build()` returns the snapshot object. */
async function sync(build) {
  const dir = target();
  if (!dir || running) return null;
  running = true;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const snap = await build();
    const body = JSON.stringify(snap);
    const file = path.join(dir, 'kea-data.json');
    let old = '';
    try {
      old = fs.readFileSync(file, 'utf8');
    } catch {}
    // The time stamp alone changing isn't a change worth uploading.
    const strip = (s) => s.replace(/"synced":"[^"]*"/, '');
    if (strip(old) !== strip(body)) writeInPlace(file, body);
    // The library, only when a textbook or picture changed (its list of names, sizes and times).
    const lib = libraryFiles();
    const sig = sha(JSON.stringify(lib.map((f) => [f.name, f.size, f.mtime])));
    const libFile = path.join(dir, 'kea-library.zip');
    if (lib.length && (sig !== readSig() || !fs.existsSync(libFile))) {
      writeZip(lib, libFile);
      fs.writeFileSync(path.join(profiles.paths().dir, 'library.sig'), sig);
    }
    // The phone's own file is made here, empty, so it can be chosen with the other two when the phone is set up.
    const phone = path.join(dir, 'phone.json');
    if (!fs.existsSync(phone)) fs.writeFileSync(phone, '{}');
    // Anything else in Kea's folder (left from an older version, like the Textbooks folder before the library) goes too.
    // (Devices is where computers sharing these classes keep in step: devices.cjs. An older version's PCs folder goes.)
    for (const e of fs.readdirSync(dir)) if (!['kea-data.json', 'kea-library.zip', 'phone.json', 'Devices'].includes(e)) fs.rmSync(path.join(dir, e), { recursive: true, force: true });
    return { dir, hash: sha(body) };
  } finally {
    running = false;
  }
}

module.exports = { drives, drive, target, sync, schedule, mirror, libraryFiles, writeZip };
