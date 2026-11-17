// Study notebooks between devices, through the same Devices folder as the rest of study data (devices.cjs). Nothing
// here needs Electron: every function takes the folders and the device names.
//
// - The primary publishes its notebooks in Devices/shared/study/Notebooks (publish). It is the one copy everyone
//   agrees on.
// - Every other computer brings those in (pull) and sends its own changed or new notebooks back in its device card
//   (outgoing: { name: { text, base } }), which the primary takes in (takeIn).
// - `base` is the text (as a sha1) both sides last agreed on, kept per notebook on each follower. With it each side
//   can tell "only the other side changed it" (take theirs) from "only I changed it" (keep mine, it goes out) from
//   "both changed it" (a clash).
// - A clash keeps both: the other side's text is saved beside this one as "<name> (from <device>).md". No text is
//   ever overwritten unless it is the agreed text the other side started from.
// - Deletions and renames don't travel: a notebook deleted here and unchanged elsewhere stays deleted here; if it
//   changes elsewhere, it comes back (with that text).
// - The phone only reads them (forPhone, in the phone copy).
//
// Names are checked with notebooks.cjs's rules on the side that receives them, every path stays directly inside the
// Notebooks folder, and nothing over notebooks.cjs's 5 MB is sent or taken in.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const notebooks = require('./notebooks.cjs');

const MAX_TEXT = notebooks.MAX_TEXT;
// (At most this many notebooks are taken in from one card, so a bad card can't fill the disk.)
const MAX_COUNT = 1000;
// The phone keeps its copy in the web view's storage, which is small: notebooks past this many bytes stay off it.
const PHONE_BUDGET = 2 * 1024 * 1024;

const sha = (text) => crypto.createHash('sha1').update(String(text), 'utf8').digest('hex');

/** The name when it's one notebooks.cjs would make itself (already trimmed), else null. */
function validName(name) {
  try {
    return typeof name === 'string' && notebooks.cleanName(name) === name ? name : null;
  } catch {
    return null;
  }
}

/** A notebook's text, or null when it isn't there, can't be read or is over the size limit. */
function readText(dir, name) {
  try {
    const file = notebooks.fileOf(dir, name);
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_TEXT) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Whether a file for that notebook is there at all (even one too big to travel). */
function exists(dir, name) {
  try {
    fs.statSync(notebooks.fileOf(dir, name));
    return true;
  } catch {
    return false;
  }
}

/** Every notebook in the folder that may travel: { name: text }. */
function readAll(dir) {
  const out = {};
  for (const e of notebooks.list(dir)) {
    if (e.size > MAX_TEXT) continue;
    const t = readText(dir, e.name);
    if (t != null) out[e.name] = t;
  }
  return out;
}

/** "Ana's PC #2" -> "Ana s PC 2": only characters notebook names may have. */
function deviceLabel(name) {
  const s = String(name || '')
    .replace(/[^A-Za-z0-9 _\-()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 30)
    .trim();
  return s || 'another device';
}

/**
 * A free name for the other side's copy: "<name> (from <device>)", then "... 2" and up. The name is shortened to stay
 * within notebooks.cjs's 80 characters. `taken(name)` says whether a notebook has that name already.
 */
function copyName(name, device, taken) {
  const who = deviceLabel(device);
  for (let n = 1; n < 1000; n++) {
    const tail = ` (from ${who}${n > 1 ? ` ${n}` : ''})`;
    let head = name.slice(0, Math.max(1, notebooks.MAX_NAME - tail.length)).trim();
    // (A dot left at the end by shortening isn't allowed in a name.)
    head = head.replace(/[. ]+$/, '') || 'Notebook';
    const cand = validName(`${head}${tail}`);
    if (cand && !taken(cand)) return cand;
  }
  return null;
}

/**
 * Save the other side's text beside this one. Returns the copy's name, true when a notebook here already has exactly
 * that text (nothing to save), or null when no free name was found.
 */
function keepBoth(dir, name, text, device, have) {
  if (Object.values(have).some((t) => t === text)) return true;
  const to = copyName(name, device, (n) => n in have || exists(dir, n));
  if (!to) return null;
  notebooks.write(dir, to, text);
  have[to] = text;
  return to;
}

/**
 * The primary: make Devices/shared/study/Notebooks match its own notebooks (written only when the text changed). That
 * folder is the primary's own, so a notebook it no longer has goes from there; followers never delete theirs because
 * of it. Returns whether anything changed.
 */
function publish(localDir, sharedDir) {
  const mine = readAll(localDir);
  let changed = false;
  for (const [name, text] of Object.entries(mine)) {
    if (readText(sharedDir, name) === text) continue;
    notebooks.write(sharedDir, name, text);
    changed = true;
  }
  let entries = [];
  try {
    entries = fs.readdirSync(sharedDir, { withFileTypes: true });
  } catch {}
  for (const e of entries) {
    if (!e.isFile()) continue;
    const name = /\.md$/i.test(e.name) ? validName(e.name.slice(0, -3)) : null;
    if (name && name in mine) continue;
    fs.rmSync(path.join(sharedDir, e.name), { force: true });
    changed = true;
  }
  return changed;
}

/**
 * Another computer: bring in the primary's notebooks (from `sharedDir`). `base` ({ name: sha1 }, this device's own
 * record) is updated in place. `from` is the primary's name, for a clash copy. Returns { changed, copies }.
 */
function pull(localDir, sharedDir, base, from) {
  const theirs = readAll(sharedDir);
  const have = readAll(localDir);
  const copies = [];
  let changed = false;
  const clashes = [];
  for (const [name, text] of Object.entries(theirs)) {
    const sh = sha(text);
    const local = name in have ? have[name] : null;
    // (A file here that can't travel, too big or named with other capitals: never written over.)
    if (local == null && exists(localDir, name)) continue;
    if (local == null) {
      // Deleted (or renamed) here and unchanged there: it stays gone here. New, or changed there since: it comes in.
      if (base[name] === sh) continue;
      notebooks.write(localDir, name, text);
      have[name] = text;
      base[name] = sh;
      changed = true;
    } else if (local === text) base[name] = sh;
    else if (base[name] === sh) continue; // (Only changed here: it goes out with this device's card.)
    else if (base[name] === sha(local)) {
      // Only changed there.
      notebooks.write(localDir, name, text);
      have[name] = text;
      base[name] = sh;
      changed = true;
    } else clashes.push([name, text, sh]);
  }
  // Both sides changed it. (After the rest, so a copy the primary already made of this device's text is here first.)
  for (const [name, text, sh] of clashes) {
    const local = have[name];
    if (Object.entries(have).some(([n, t]) => n !== name && t === local)) {
      // This device's text is already here under another name (the primary kept it as a copy, and that copy has just
      // come in): take the primary's version of this one too.
      notebooks.write(localDir, name, text);
      have[name] = text;
    } else {
      const to = keepBoth(localDir, name, text, from, have);
      // (No free name for a copy: left as a clash, so this device's text isn't sent over the primary's.)
      if (!to) continue;
      if (typeof to === 'string') copies.push({ name, copy: to });
    }
    // (Either way, the primary's text is now the one this device started from: this device's own goes out next.)
    base[name] = sh;
    changed = true;
  }
  return { changed, copies };
}

/** Another computer: its notebooks that changed (or are new) since they were last agreed, for its device card. */
function outgoing(localDir, base) {
  const out = {};
  for (const [name, text] of Object.entries(readAll(localDir))) {
    if (base[name] === sha(text)) continue;
    out[name] = { text, base: base[name] || null };
  }
  return out;
}

/**
 * The primary: another computer's notebooks (`incoming`, from its card) taken in here. `from` is that computer's name,
 * for a clash copy. `seen` ({ name: version }, kept per device by the caller, updated in place) is what was already taken
 * in from that computer, so the same card read again later (its heartbeat) doesn't count as a new change: a notebook
 * changed here since would otherwise get a needless copy of the old text. Returns { changed, copies }.
 */
function takeIn(localDir, incoming, from, seen = {}) {
  const copies = [];
  let changed = false;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return { changed, copies };
  const have = readAll(localDir);
  let n = 0;
  for (const [raw, v] of Object.entries(incoming)) {
    if (++n > MAX_COUNT) break;
    const name = validName(raw);
    if (!name || !v || typeof v.text !== 'string' || Buffer.byteLength(v.text, 'utf8') > MAX_TEXT) continue;
    const text = v.text;
    const base = typeof v.base === 'string' ? v.base : null;
    const version = `${sha(text)}:${base || ''}`;
    if (seen[name] === version) continue;
    const local = name in have ? have[name] : null;
    // (A file here that can't travel, too big or named with other capitals: never written over.)
    if (local == null && exists(localDir, name)) continue;
    if (local !== text) {
      if (local == null || sha(local) === base) {
        // New here, or changed only there (from the text this device has now).
        notebooks.write(localDir, name, text);
        have[name] = text;
        changed = true;
      } else {
        // Both changed it: this device's text stays, theirs goes beside it.
        const to = keepBoth(localDir, name, text, from, have);
        if (!to) continue; // (No free name: looked at again with the next card.)
        if (typeof to === 'string') {
          copies.push({ name, copy: to });
          changed = true;
        }
      }
    }
    seen[name] = version;
  }
  return { changed, copies };
}

/**
 * The notebooks for the phone copy, newest first: [{ name, modified, text }]. Past the phone's budget a notebook is
 * listed with `text: null, tooBig: true`, so the phone can say where to read it.
 */
function forPhone(dir) {
  let left = PHONE_BUDGET;
  const out = [];
  for (const e of notebooks.list(dir)) {
    const text = e.size <= left ? readText(dir, e.name) : null;
    if (text != null) {
      left -= Buffer.byteLength(text, 'utf8');
      out.push({ name: e.name, modified: e.modified, text });
    } else out.push({ name: e.name, modified: e.modified, text: null, tooBig: true });
  }
  return out;
}

module.exports = { sha, validName, deviceLabel, copyName, publish, pull, outgoing, takeIn, forPhone, PHONE_BUDGET };
