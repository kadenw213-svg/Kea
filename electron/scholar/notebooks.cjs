// Study notebooks: plain Markdown files the student writes beside a quiz, one file per notebook, in a Notebooks folder
// inside the profile's study folder. Every function takes that folder, so this file needs nothing from Electron.
//
// A notebook's name is its file name without ".md": letters, digits, spaces and - _ . ( ) only, at most 80 characters,
// no path separators and no "..". Every path is resolved and checked to be inside the folder before it's used.
const fs = require('fs');
const path = require('path');

const MAX_NAME = 80;
const MAX_TEXT = 5 * 1024 * 1024;
const NAME_OK = /^[A-Za-z0-9 _\-.()]+$/;

/** The name, trimmed, or an error saying what's wrong with it. */
function cleanName(name) {
  const n = String(name ?? '').trim();
  if (!n) throw new Error('Give the notebook a name.');
  if (n.length > MAX_NAME) throw new Error(`Notebook names can be at most ${MAX_NAME} characters.`);
  if (!NAME_OK.test(n)) throw new Error('Notebook names can only use letters, numbers, spaces and - _ . ( )');
  if (n.includes('..') || n.startsWith('.') || n.endsWith('.')) throw new Error('Notebook names can’t start or end with a dot, or have two dots in a row.');
  // (Names Windows keeps for devices.)
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(n)) throw new Error('Windows doesn’t allow that name. Pick another.');
  return n;
}

/** The notebook's file, checked to be directly inside the folder. */
function fileOf(dir, name) {
  const root = path.resolve(dir);
  const file = path.resolve(root, `${cleanName(name)}.md`);
  if (path.dirname(file) !== root) throw new Error('That notebook name isn’t allowed.');
  return file;
}

/** Every notebook, newest change first: [{ name, file, modified, size }]. */
function list(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && /\.md$/i.test(e.name)).map((e) => e.name.slice(0, -3));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    let file;
    try {
      file = fileOf(dir, name);
    } catch {
      continue; // (A file someone put there by hand with a name Kea wouldn't make: left alone.)
    }
    try {
      const st = fs.statSync(file);
      out.push({ name, file, modified: st.mtime.toISOString(), size: st.size });
    } catch {}
  }
  return out.sort((a, b) => b.modified.localeCompare(a.modified) || a.name.localeCompare(b.name));
}

/** A new, empty notebook. Fails when one with that name is already there. */
function create(dir, name) {
  const file = fileOf(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (exists(file)) throw new Error(`There’s already a notebook called “${cleanName(name)}”.`);
  fs.writeFileSync(file, '', { encoding: 'utf8', flag: 'wx' });
  return { name: cleanName(name), file };
}

/** A notebook's text ('' when it isn't there). */
function read(dir, name) {
  const file = fileOf(dir, name);
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return '';
    throw e;
  }
}

/**
 * Save a notebook's text (made if it isn't there), through a temporary file so a cut-off save never empties it.
 *
 * `base` (optional) is the text the writer started from (the notebook panel: what it last read or saved). When the file
 * holds something else by now (another device's change synced in, or an edit in another program), that text is kept
 * first as "<name> (changed elsewhere).md" and named in `kept`, so saving never silently loses it.
 */
function write(dir, name, text, base) {
  const file = fileOf(dir, name);
  const body = String(text ?? '');
  if (Buffer.byteLength(body, 'utf8') > MAX_TEXT) throw new Error('That notebook is too big to save (over 5 MB).');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let kept = null;
  if (typeof base === 'string') {
    let now = null;
    try {
      now = fs.readFileSync(file, 'utf8');
    } catch {}
    if (now != null && now !== base && now !== body) kept = keepAside(dir, cleanName(name), now);
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, file);
  return { name: cleanName(name), file, modified: fs.statSync(file).mtime.toISOString(), kept };
}

/** Save `text` as "<name> (changed elsewhere).md" (then "... 2" and up), shortening the name to fit. Returns its name. */
function keepAside(dir, name, text) {
  for (let n = 1; n < 1000; n++) {
    const tail = ` (changed elsewhere${n > 1 ? ` ${n}` : ''})`;
    const cand = `${name.slice(0, MAX_NAME - tail.length).replace(/[. ]+$/, '') || 'Notebook'}${tail}`;
    const f = fileOf(dir, cand);
    if (exists(f)) {
      // (The same text kept before: nothing more to save.)
      try {
        if (fs.readFileSync(f, 'utf8') === text) return cand;
      } catch {}
      continue;
    }
    fs.writeFileSync(f, text, { encoding: 'utf8', flag: 'wx' });
    return cand;
  }
  return null;
}

/** Rename a notebook. Fails when it isn't there or the new name is taken (a change of capitals only is allowed). */
function rename(dir, from, to) {
  const a = fileOf(dir, from);
  const b = fileOf(dir, to);
  if (!exists(a)) throw new Error(`There’s no notebook called “${cleanName(from)}”.`);
  if (a !== b && exists(b) && a.toLowerCase() !== b.toLowerCase()) throw new Error(`There’s already a notebook called “${cleanName(to)}”.`);
  fs.renameSync(a, b);
  return { name: cleanName(to), file: b };
}

function exists(file) {
  try {
    fs.statSync(file);
    return true;
  } catch {
    return false;
  }
}

module.exports = { MAX_NAME, MAX_TEXT, cleanName, fileOf, list, create, read, write, rename };
