// Kea's copy of a profile's Scholar data in the student's cloud drive (OneDrive by default, or Google Drive, or any
// folder), for Kea on their phone. Kept small and tidy on purpose: one folder per profile holding one data file and
// the textbook PDFs, rewritten only when something changed, and anything that no longer belongs is deleted.
//
//   <drive>/Kea/<profile>/kea-data.json      classes, calendar, grades, inbox, what's handed in
//   <drive>/Kea/<profile>/Textbooks/<CODE>/  the study PDFs
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const profiles = require('./profiles.cjs');
const settings = require('../settings.cjs');

/** Cloud drives found on this computer: { id, label, path }. */
function drives() {
  const out = [];
  const od = process.env.OneDriveConsumer || process.env.OneDrive;
  if (od && fs.existsSync(od)) out.push({ id: 'onedrive', label: 'OneDrive', path: od });
  // Google Drive for desktop: a drive letter with "My Drive", or the older folder in the home directory.
  for (const letter of 'DEFGHIJKLMNOPQRSTUVWXYZ') {
    const p = `${letter}:\\My Drive`;
    try {
      if (fs.existsSync(p)) {
        out.push({ id: 'google', label: 'Google Drive', path: p });
        break;
      }
    } catch {}
  }
  const gd = path.join(os.homedir(), 'Google Drive');
  if (!out.some((d) => d.id === 'google') && fs.existsSync(gd)) out.push({ id: 'google', label: 'Google Drive', path: gd });
  const db = path.join(os.homedir(), 'Dropbox');
  if (fs.existsSync(db)) out.push({ id: 'dropbox', label: 'Dropbox', path: db });
  return out;
}

/** The folder Kea syncs into for the active profile, or null when syncing is off or the drive isn't there. */
function target() {
  const choice = settings.get('scholar.cloud', 'onedrive');
  if (choice === 'off') return null;
  const root = choice === 'custom' ? settings.get('scholar.cloudPath', '') : drives().find((d) => d.id === choice)?.path;
  if (!root || !fs.existsSync(root)) return null;
  const name = (profiles.all().list.find((p) => p.id === profiles.active())?.name || profiles.active()).replace(/[<>:"/\\|?*]+/g, '').trim() || 'School';
  return path.join(root, 'Kea', name);
}

const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');

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
    if (strip(old) !== strip(body)) {
      fs.writeFileSync(file + '.tmp', body);
      fs.renameSync(file + '.tmp', file);
    }
    mirror(profiles.paths().textbooks, path.join(dir, 'Textbooks'));
    // Anything else in Kea's folder (left from an older version) goes too.
    // (phone.json is the phone's own file: what it checked off and read.)
    // (PCs is where computers sharing these classes keep in step: pcsync.cjs.)
    for (const e of fs.readdirSync(dir)) if (!['kea-data.json', 'Textbooks', 'phone.json', 'PCs'].includes(e)) fs.rmSync(path.join(dir, e), { recursive: true, force: true });
    return { dir, hash: sha(body) };
  } finally {
    running = false;
  }
}

module.exports = { drives, target, sync, schedule, mirror };
