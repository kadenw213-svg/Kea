// Kea Cloud: documents in the person's Kea storage on the Kea Hub.
//
// They're ordinary files in "Documents/" inside the Hub sync folder (hub.cjs syncRoot), so every editor opens and
// saves them like files on this PC, and hubsync.cjs mirrors them to "kea/Documents/" on the Hub, where the person's
// other computers and phone pick them up. This module adds what the page needs on top: where the folder is, how the
// sync is doing (synced / syncing / offline / storage full), each file's state, and rename and delete kept inside the
// folder.
//
// Settings: keaCloud.enabled (default on; documents sync whenever a Kea account is signed in).
const fs = require('fs');
const path = require('path');

const FOLDER = 'Documents';

// ---------- Pure parts (tested in test/keacloud) ----------

/** Is `p` the folder `root` or inside it? (Case-insensitive on Windows.) */
function isInside(root, p) {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/** A file name a person can give a document: no folders, nothing Windows refuses, not empty or dots only. */
function validName(name) {
  const n = String(name || '').trim();
  if (!n || n.length > 200 || /^\.+$/.test(n)) return false;
  if (/[<>:"/\\|?*\x00-\x1f]/.test(n)) return false;
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) return false;
  return !/[. ]$/.test(n);
}

/** "Essay.docx" in a folder that has it already -> "Essay (2).docx", and up. */
function uniqueName(name, taken) {
  if (!taken(name)) return name;
  const dot = name.lastIndexOf('.');
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let n = 2; ; n++) {
    const cand = `${base} (${n})${ext}`;
    if (!taken(cand)) return cand;
  }
}

/** One file against what hubsync last recorded for it: on the Hub as it is here, waiting to go up, or kept here. */
function fileState(stat, rec, skip) {
  if (skip === 'full') return 'full';
  if (skip === 'name' || (typeof skip === 'number' && stat && skip === stat.size)) return 'local';
  if (stat && rec && stat.size === rec.size && Math.abs(stat.mtimeMs - rec.mtime) < 1) return 'synced';
  return 'pending';
}

/**
 * The one-word state for the Kea Cloud header: 'signedOut' | 'off' | 'offline' | 'full' | 'error' | 'syncing' | 'synced'.
 * `sync` is hub.cjs's syncState, `st` hubsync's saved state, `pending` the number of documents waiting to go up.
 */
function summarize({ signedIn, enabled, sync, st, pending }) {
  if (!signedIn) return 'signedOut';
  if (!enabled || !sync?.on) return 'off';
  if (sync.error) return sync.offline ? 'offline' : 'error';
  if (st?.full) return 'full';
  if (pending > 0 || !sync.last) return 'syncing';
  return 'synced';
}

/** hubsync options for Documents/: synced on its own when Scholar uses another drive; a clash keeps both copies. */
function syncOptions(scholarOnHub) {
  const inDocs = (rel) => rel === FOLDER || rel.startsWith(`${FOLDER}/`);
  return {
    scope: () => (scholarOnHub() ? () => true : inDocs),
    keepBoth: inDocs,
  };
}

// ---------- Electron side ----------
const settings = () => require('./settings.cjs');
const hub = () => require('./hub.cjs');
const enabled = () => settings().get('keaCloud.enabled', true) !== false;
const root = () => path.join(hub().syncRoot(), FOLDER);

function readSyncState() {
  try {
    const { app } = require('electron');
    return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'hub-sync-state.json'), 'utf8'));
  } catch {
    return { files: {}, skip: {} };
  }
}

/** Every document under the folder, as paths relative to the sync root ("Documents/Essay.docx"). */
function walk(dir = root(), out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (!require('./scholar/hubsync.cjs').skipName(e.name)) out.push(full);
  }
  return out;
}
const relOf = (p) => path.relative(hub().syncRoot(), p).split(path.sep).join('/');

function stateOf(p, st) {
  let stat = null;
  try {
    stat = fs.statSync(p);
  } catch {}
  const rel = relOf(p);
  return fileState(stat, st.files?.[rel], st.skip?.[rel]);
}

function status() {
  const h = hub();
  const signedIn = h.signedIn();
  if (signedIn && enabled()) fs.mkdirSync(root(), { recursive: true });
  const st = readSyncState();
  const sync = h.syncState();
  const files = signedIn ? walk() : [];
  const pending = files.filter((p) => stateOf(p, st) === 'pending').length;
  const cached = h.cached();
  return {
    signedIn,
    enabled: enabled(),
    email: cached?.email || null,
    root: root(),
    state: summarize({ signedIn, enabled: enabled(), sync, st, pending }),
    message: st.full?.message || sync.error || null,
    last: sync.last,
    pending,
    files: files.length,
    storage: st.storage || null,
    conflicts: (st.conflicts || []).filter((c) => c.rel.startsWith(`${FOLDER}/`)).slice(-5),
  };
}

function guard(p) {
  if (!hub().signedIn()) throw new Error('Sign in to your Kea account to use Kea Cloud.');
  if (!isInside(root(), p) || path.resolve(p) === path.resolve(root())) throw new Error('That isn’t in Kea Cloud.');
}

function register() {
  const { ipcMain, shell } = require('electron');
  const wrap = (fn) => async (_e, arg) => {
    try {
      return { ok: true, value: await fn(arg || {}) };
    } catch (e) {
      return { ok: false, error: String(e.message || e), status: e.status ?? null };
    }
  };
  ipcMain.handle('keaCloud:status', wrap(() => status()));
  ipcMain.handle('keaCloud:states', wrap(({ paths }) => {
    const st = readSyncState();
    const out = {};
    for (const p of Array.isArray(paths) ? paths.slice(0, 2000) : []) if (typeof p === 'string' && isInside(root(), p)) out[p] = stateOf(p, st);
    return out;
  }));
  // Where a new document goes: Kea Cloud's folder (made if needed), with a name not already taken.
  ipcMain.handle('keaCloud:newPath', wrap(({ name }) => {
    if (!hub().signedIn()) throw new Error('Sign in to your Kea account to use Kea Cloud.');
    if (!validName(name)) throw new Error('That name can’t be used for a file.');
    fs.mkdirSync(root(), { recursive: true });
    return path.join(root(), uniqueName(String(name).trim(), (n) => fs.existsSync(path.join(root(), n))));
  }));
  ipcMain.handle('keaCloud:rename', wrap(({ path: raw, name }) => {
    const p = path.resolve(String(raw));
    guard(p);
    if (!validName(name)) throw new Error('That name can’t be used for a file.');
    const to = path.join(path.dirname(p), String(name).trim());
    if (to.toLowerCase() !== p.toLowerCase() && fs.existsSync(to)) throw new Error(`There’s already a file called ${name}.`);
    fs.renameSync(p, to);
    hub().syncNow();
    return to;
  }));
  // Deleted documents go to the Recycle Bin here (and from Kea storage with the next sync).
  ipcMain.handle('keaCloud:remove', wrap(async ({ path: raw }) => {
    const p = path.resolve(String(raw));
    guard(p);
    await shell.trashItem(p);
    hub().syncNow();
    return true;
  }));
  ipcMain.handle('keaCloud:newFolder', wrap(({ parent, name }) => {
    const dir = parent || root();
    if (path.resolve(dir) !== path.resolve(root())) guard(dir);
    if (!validName(name)) throw new Error('That name can’t be used for a folder.');
    const to = path.join(dir, String(name).trim());
    fs.mkdirSync(to, { recursive: true });
    return to;
  }));
  ipcMain.handle('keaCloud:syncNow', wrap(async () => {
    hub().startSync();
    await hub().syncNow();
    return status();
  }));
  ipcMain.handle('keaCloud:open', wrap(() => {
    fs.mkdirSync(root(), { recursive: true });
    return shell.openPath(root());
  }));
}

module.exports = { register, enabled, root, status, syncOptions, isInside, validName, uniqueName, fileState, summarize, FOLDER };
