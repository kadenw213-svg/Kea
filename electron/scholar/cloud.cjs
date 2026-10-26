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
  const zip = Buffer.concat([...parts, cd, end]);
  writeInPlace(dest, zip);
  return zip;
}

/**
 * Rewrite a file's contents without replacing the file (so the drive keeps it as the same file the phone holds). Every
 * byte is written (fs.writeSync may write less than asked), over the old contents first and only then cut to length,
 * so the file is never briefly empty. A copy cut short anyway (Kea killed mid-write) fails the phone's length and
 * sha256 check (see sync: `integrity` in kea-data.json, `library` for the zip).
 */
function writeInPlace(file, body) {
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  const fd = fs.openSync(file, fs.existsSync(file) ? 'r+' : 'w');
  try {
    let off = 0;
    while (off < buf.length) {
      const n = fs.writeSync(fd, buf, off, buf.length - off, off);
      if (n <= 0) throw new Error(`Could not write ${path.basename(file)} (${off} of ${buf.length} bytes)`);
      off += n;
    }
    fs.ftruncateSync(fd, buf.length);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * kea-data.json's text with its own check on the end: `"integrity":{"length":N,"sha256":"..."}` is the last key, and
 * covers the UTF-8 bytes of everything before `,"integrity":` plus the closing `}` (that is, JSON.stringify of the
 * data without it). The phone checks it before using the file.
 */
function withIntegrity(body) {
  const bytes = Buffer.from(body, 'utf8');
  return `${body.slice(0, -1)},"integrity":{"length":${bytes.length},"sha256":"${sha256(bytes)}"}}`;
}
/** The data part of a kea-data.json text (without the integrity key), or null when it fails its own check. */
function verified(text) {
  const i = text.lastIndexOf(',"integrity":');
  if (i < 0) return null;
  const core = text.slice(0, i) + '}';
  try {
    const { length, sha256: want } = JSON.parse(text.slice(i + 13, -1));
    const bytes = Buffer.from(core, 'utf8');
    return bytes.length === length && sha256(bytes) === want ? core : null;
  } catch {
    return null;
  }
}

/** What Kea last wrote as the library zip: { sig, size, sha256 } (profile folder, never shared). */
const libMetaFile = () => path.join(profiles.paths().dir, 'library.json');
function readLibMeta() {
  try {
    return JSON.parse(fs.readFileSync(libMetaFile(), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Read a library zip Kea wrote (stored entries only) after checking it whole against `want` ({ size, sha256 } from
 * kea-data.json). Returns [{ name, data }] with each entry's CRC checked, or null when the zip isn't complete yet.
 */
function readLibrary(file, want) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return null;
  }
  if (!want || buf.length !== want.size || sha256(buf) !== want.sha256) return null;
  const end = buf.length - 22;
  if (end < 0 || buf.readUInt32LE(end) !== 0x06054b50) return null;
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extra + comment;
    if (method !== 0 || buf.readUInt32LE(local) !== 0x04034b50) return null;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    if (data.length !== size || crc32(data) !== crc) return null;
    out.push({ name, data });
  }
  return out;
}

let timer = null;
let running = false;
// A sync asked for while one was running: run again after it, so a change made meanwhile isn't left out.
let again = null;
/** Sync soon (several changes in a row become one sync). */
function schedule(build, delay = 20000) {
  clearTimeout(timer);
  timer = setTimeout(() => sync(build).catch((err) => console.error('Cloud sync', err)), delay);
}

/** Write the data file (if it changed) and mirror the textbooks. `build()` returns the snapshot object. */
async function sync(build) {
  const dir = target();
  if (!dir) return null;
  if (running) {
    again = build;
    return null;
  }
  running = true;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const snap = await build();
    // The library first, only when a textbook or picture changed (its list of names, sizes and times), so the data
    // file can name the zip it goes with: { size, sha256 }, checked by the phone and other computers before unpacking.
    const lib = libraryFiles();
    const sig = sha(JSON.stringify(lib.map((f) => [f.name, f.size, f.mtime])));
    const libFile = path.join(dir, 'kea-library.zip');
    let meta = readLibMeta();
    let onDrive = -1;
    try {
      onDrive = fs.statSync(libFile).size;
    } catch {}
    if (lib.length && (!meta || meta.sig !== sig || sig !== readSig() || onDrive !== meta.size)) {
      const zip = writeZip(lib, libFile);
      meta = { sig, size: zip.length, sha256: sha256(zip) };
      fs.writeFileSync(path.join(profiles.paths().dir, 'library.sig'), sig);
      fs.writeFileSync(libMetaFile(), JSON.stringify(meta));
    }
    const body = JSON.stringify({ ...snap, library: lib.length && meta ? { size: meta.size, sha256: meta.sha256 } : null });
    const file = path.join(dir, 'kea-data.json');
    let old = '';
    try {
      old = fs.readFileSync(file, 'utf8');
    } catch {}
    // The time stamp alone changing isn't a change worth uploading (nor is a copy that fails its own check left alone).
    const strip = (s) => (s || '').replace(/"synced":"[^"]*"/, '');
    if (strip(verified(old)) !== strip(body)) writeInPlace(file, withIntegrity(body));
    // The phone's own file is made here, empty, so it can be chosen with the other two when the phone is set up.
    const phone = path.join(dir, 'phone.json');
    if (!fs.existsSync(phone)) fs.writeFileSync(phone, '{}');
    // Anything else in Kea's folder (left from an older version, like the Textbooks folder before the library) goes too.
    // (Devices is where computers sharing these classes keep in step: devices.cjs. An older version's PCs folder goes.)
    for (const e of fs.readdirSync(dir)) if (!['kea-data.json', 'kea-library.zip', 'phone.json', 'Devices'].includes(e)) fs.rmSync(path.join(dir, e), { recursive: true, force: true });
    return { dir, hash: sha(body) };
  } finally {
    running = false;
    if (again) {
      const b = again;
      again = null;
      schedule(b, 5000);
    }
  }
}

module.exports = { drives, drive, target, sync, schedule, mirror, libraryFiles, writeZip, readLibrary, verified, _test: { writeInPlace, withIntegrity } };
