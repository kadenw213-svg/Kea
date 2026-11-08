// Kea cloud: documents in the person's Kea storage on the Kea Hub.
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
 * The one-word state for the Kea cloud header: 'signedOut' | 'off' | 'offline' | 'full' | 'error' | 'syncing' | 'synced'.
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
const choice = () => require('./syncChoice.cjs');
const { handleApp } = require('./ipcGuard.cjs');
const enabled = () => settings().get('keaCloud.enabled', true) !== false;
// Documents follow Settings → Where your things sync (syncChoice.cjs): the Kea cloud folder (synced through the
// account's storage), a KeaS server's folder, "Kea Documents" in a cloud drive or synced folder, or on this PC only.
const placeNow = () => choice().placeOf(choice().current());
const root = () => choice().docsRoot() ?? path.join(hub().syncRoot(), FOLDER);
/** Documents can be used here now: Kea cloud signed in online, a server not signed out, a drive that's here. */
function ready(place = placeNow()) {
  if (place.kind === 'kea') return hub().signedIn();
  if (place.kind === 'keas') return !place.locked;
  if (place.kind === 'off') return true;
  return !!choice().docsRoot(place.id);
}

function readSyncState() {
  try {
    const sp = choice().serverPlace();
    if (!sp) return { files: {}, skip: {} };
    return JSON.parse(fs.readFileSync(sp.stateFile, 'utf8'));
  } catch {
    return { files: {}, skip: {} };
  }
}
/** The synced folder documents are relative to (the server mirror's root, or the documents folder itself). */
const baseOf = () => choice().serverPlace()?.root ?? path.dirname(root());

/** Every document under the folder, as full paths. */
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
const relOf = (p) => path.relative(baseOf(), p).split(path.sep).join('/');

function stateOf(p, st) {
  // (A cloud drive's own app syncs its folder; off keeps them here.)
  if (!choice().serverPlace()) return placeNow().kind === 'off' ? 'local' : 'synced';
  let stat = null;
  try {
    stat = fs.statSync(p);
  } catch {}
  const rel = relOf(p);
  return fileState(stat, st.files?.[rel], st.skip?.[rel]);
}

function status() {
  const h = hub();
  const place = placeNow();
  const ok = ready(place);
  const server = place.kind === 'kea' || place.kind === 'keas';
  if (ok && enabled()) fs.mkdirSync(root(), { recursive: true });
  const st = readSyncState();
  // A server place with Kea cloud on but the sync isn't running yet (just signed in, or terms just agreed to): start it.
  const s0 = h.syncState();
  if (server && ok && enabled() && !s0.on && (!s0.error || s0.offline)) h.startSync();
  const sync = h.syncState();
  const files = ok ? walk() : [];
  const pending = server ? files.filter((p) => stateOf(p, st) === 'pending').length : 0;
  const cached = h.cached();
  return {
    signedIn: ok,
    enabled: enabled(),
    email: place.kind === 'kea' ? cached?.email || null : null,
    root: root(),
    place: { id: place.id, kind: place.kind, label: place.label, brand: place.brand ?? null, why: place.why ?? null },
    state: server ? summarize({ signedIn: ok, enabled: enabled(), sync, st, pending }) : !ok ? 'signedOut' : !enabled() ? 'off' : place.kind === 'off' ? 'local' : 'drive',
    message: server ? st.full?.message || sync.error || null : null,
    last: server ? sync.last : null,
    pending,
    files: files.length,
    storage: server ? st.storage || null : null,
    conflicts: server ? (st.conflicts || []).filter((c) => c.rel.startsWith(`${FOLDER}/`)).slice(-5) : [],
  };
}

const notReady = () => (placeNow().kind === 'kea' ? 'Sign in to your Kea account to use Kea cloud.' : `${placeNow().label} isn’t on this computer right now.`);
function guard(p) {
  if (!ready()) throw new Error(notReady());
  if (!isInside(root(), p) || path.resolve(p) === path.resolve(root())) throw new Error('That isn’t in Kea cloud.');
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
  handleApp(ipcMain, 'keaCloud:status', wrap(() => status()));
  handleApp(ipcMain, 'keaCloud:states', wrap(({ paths }) => {
    const st = readSyncState();
    const out = {};
    for (const p of Array.isArray(paths) ? paths.slice(0, 2000) : []) if (typeof p === 'string' && isInside(root(), p)) out[p] = stateOf(p, st);
    return out;
  }));
  // Where a new document goes: Kea cloud's folder (made if needed), with a name not already taken.
  handleApp(ipcMain, 'keaCloud:newPath', wrap(({ name }) => {
    if (!ready()) throw new Error(notReady());
    if (!validName(name)) throw new Error('That name can’t be used for a file.');
    fs.mkdirSync(root(), { recursive: true });
    return path.join(root(), uniqueName(String(name).trim(), (n) => fs.existsSync(path.join(root(), n))));
  }));
  handleApp(ipcMain, 'keaCloud:rename', wrap(({ path: raw, name }) => {
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
  handleApp(ipcMain, 'keaCloud:remove', wrap(async ({ path: raw }) => {
    const p = path.resolve(String(raw));
    guard(p);
    await shell.trashItem(p);
    hub().syncNow();
    return true;
  }));
  handleApp(ipcMain, 'keaCloud:newFolder', wrap(({ parent, name }) => {
    const dir = parent || root();
    if (path.resolve(dir) !== path.resolve(root())) guard(dir);
    if (!validName(name)) throw new Error('That name can’t be used for a folder.');
    const to = path.join(dir, String(name).trim());
    fs.mkdirSync(to, { recursive: true });
    return to;
  }));
  handleApp(ipcMain, 'keaCloud:syncNow', wrap(async () => {
    await hub().startSync();
    await hub().syncNow();
    return status();
  }));
  handleApp(ipcMain, 'keaCloud:open', wrap(() => {
    fs.mkdirSync(root(), { recursive: true });
    return shell.openPath(root());
  }));
}

module.exports = { register, enabled, root, status, syncOptions, isInside, validName, uniqueName, fileState, summarize, FOLDER };
