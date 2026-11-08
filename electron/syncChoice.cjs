// Where your things sync: one choice for classes (Scholar), Kea Cloud documents and the phone's files.
//
//   kea-hub          Kea cloud: the storage that comes with an online Kea account (hub.cjs + scholar/hubsync.cjs)
//   google, onedrive, onedrive-<key>, dropbox   a cloud drive's folder on this computer (its own app syncs it)
//   custom           any synced folder (scholar.cloudPath)
//   keas:<serverId>  a KeaS server this account joined (its /v1/files, with the server session from servers.cjs)
//   off              nothing leaves this computer
//
// Stored in `scholar.cloud` (the ids cloud.cjs drives() already used). Switching copies: the new place gets your
// classes (written fresh from this computer), your documents and the phone's file; nothing is deleted anywhere, and
// the old place keeps its copy.
const fs = require('fs');
const path = require('path');

const DEFAULT = 'kea-hub';
const DOCS_IN_DRIVE = 'Kea Documents';

// ---------- Pure parts (tested in test/sync) ----------
const skipName = (name) => /\.(tmp|part|kea-tmp)$/i.test(name) || name.startsWith('~$');
/** Every file under a folder, as paths relative to it ('/'-separated). */
function filesUnder(dir) {
  const out = [];
  const walk = (d, rel) => {
    let es = [];
    try {
      es = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of es) {
      if (e.isDirectory()) walk(path.join(d, e.name), `${rel}${e.name}/`);
      else if (e.isFile() && !skipName(e.name)) out.push(`${rel}${e.name}`);
    }
  };
  walk(dir, '');
  return out;
}
/** "Essay.docx" -> "Essay (from Kea cloud).docx" (or "... 2" when that's taken). */
function copyName(rel, label, taken) {
  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : '';
  const file = rel.slice(dir.length);
  const dot = file.lastIndexOf('.');
  const [base, ext] = dot > 0 ? [file.slice(0, dot), file.slice(dot)] : [file, ''];
  for (let n = 1; ; n++) {
    const cand = `${dir}${base} (from ${label}${n > 1 ? ` ${n}` : ''})${ext}`;
    if (!taken(cand)) return cand;
  }
}
/**
 * Copies every file from src into dst without deleting or replacing anything: a file dst doesn't have is copied; the
 * same file (size and time) is left; a different file of the same name is kept as "name (from <label>)".
 * Returns { copied, same, kept }.
 */
function copyInto(src, dst, label) {
  const r = { copied: 0, same: 0, kept: 0 };
  if (!src || !dst || !fs.existsSync(src) || path.resolve(src).toLowerCase() === path.resolve(dst).toLowerCase()) return r;
  for (const rel of filesUnder(src)) {
    const a = path.join(src, ...rel.split('/'));
    let to = path.join(dst, ...rel.split('/'));
    const sa = fs.statSync(a);
    if (fs.existsSync(to)) {
      const sb = fs.statSync(to);
      if (sb.size === sa.size && Math.abs(sb.mtimeMs - sa.mtimeMs) < 2000) {
        r.same++;
        continue;
      }
      to = path.join(dst, ...copyName(rel, label, (c) => fs.existsSync(path.join(dst, ...c.split('/')))).split('/'));
      r.kept++;
    } else r.copied++;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(a, to);
    fs.utimesSync(to, sa.atime, sa.mtime);
  }
  return r;
}
/** Where Kea Cloud documents are kept for a place: { kind, root } -> folder (null: that place isn't here). */
function docsRootFor(place, userData) {
  if (!place) return null;
  if (place.kind === 'kea' || place.kind === 'keas') return place.root ? path.join(place.root, 'Documents') : null;
  if (place.kind === 'off') return path.join(userData, DOCS_IN_DRIVE);
  return place.root && fs.existsSync(place.root) ? path.join(place.root, DOCS_IN_DRIVE) : null;
}
/** The sentence shown before switching: what gets a copy where, and that nothing is deleted. */
function previewText({ from, to, documents, classes, phone }) {
  if (to.kind === 'off') return `Nothing new leaves this computer from now on. ${from.kind === 'off' ? '' : `The copy in ${from.label} stays as it is.`}`.trim();
  const what = [classes && 'your classes', documents > 0 && `${documents} document${documents === 1 ? '' : 's'}`].filter(Boolean);
  const one = !classes && documents === 1;
  const head = what.length ? `${what.join(' and ').replace(/^./, (c) => c.toUpperCase())} ${one ? 'gets' : 'get'} a copy in ${to.label}.` : `Your things sync through ${to.label} from now on.`;
  const keep = from.kind === 'off' || from.id === to.id ? '' : ` Nothing is deleted: the copy in ${from.label} stays as it is.`;
  const ph = phone ? ` On your phone, choose ${to.label} in Kea’s settings too.` : '';
  return `${head}${keep}${ph}`;
}

// ---------- Electron side ----------
const settings = () => require('./settings.cjs');
const hub = () => require('./hub.cjs');
const cloud = () => require('./scholar/cloud.cjs');
const servers = () => require('./servers.cjs');
const userData = () => require('electron').app.getPath('userData');
const keasRoot = (id) => path.join(userData(), 'keas-sync', id.replace(/[^\w-]/g, ''));
const isServer = (id) => id === 'kea-hub' || String(id || '').startsWith('keas:');

function current() {
  return String(settings().get('scholar.cloud', DEFAULT) || DEFAULT);
}
const LABEL = { 'kea-hub': 'Kea cloud', google: 'Google Drive', onedrive: 'OneDrive', dropbox: 'Dropbox', custom: 'Your folder', off: 'Off' };

/** One place: { id, kind, label, detail, root, available, locked, why }. */
function placeOf(id) {
  if (id === 'auto') return placeOf(cloud().autoDrive()?.id || DEFAULT);
  if (id === 'off') return { id, kind: 'off', label: 'Off', detail: 'Only on this computer', root: null, available: true, locked: false };
  if (id === 'kea-hub') {
    const on = hub().signedIn();
    return { id, kind: 'kea', label: 'Kea cloud', detail: on ? hub().cached()?.email || 'Your Kea account’s storage' : 'Your Kea account’s storage', root: hub().syncRoot(), available: true, locked: !on, why: on ? null : 'needsOnline' };
  }
  if (id.startsWith('keas:')) {
    const sid = id.slice(5);
    const s = servers().list().find((x) => x.serverId === sid);
    return { id, kind: 'keas', label: s?.name || 'Your organization’s server', detail: s ? s.url.replace(/^https?:\/\//, '') : 'Not joined on this computer', root: keasRoot(sid), available: !!s, locked: !s || s.signedOut, why: !s ? 'notJoined' : s.signedOut ? 'signedOut' : null };
  }
  if (id === 'custom') {
    const p = String(settings().get('scholar.cloudPath', '') || '');
    const there = !!p && fs.existsSync(p);
    return { id, kind: 'folder', label: 'Your folder', detail: p || 'Pick a folder', root: there ? p : null, available: there, locked: false, why: there ? null : 'noFolder' };
  }
  const d = cloud().drives().find((x) => x.id === id);
  const base = id.startsWith('onedrive') ? 'onedrive' : id;
  return { id, kind: 'drive', brand: base, label: d?.label || LABEL[base] || id, detail: d ? d.account || d.path : 'Not on this computer', root: d?.path ?? null, available: !!d, locked: false, why: d ? null : 'notHere' };
}

/** Every choice for the picker, in a fixed order (drives that aren't on this computer shown, but not pickable). */
function options() {
  const ds = cloud().drives().filter((d) => !isServer(d.id));
  const ids = ['kea-hub'];
  for (const brand of ['google', 'onedrive', 'dropbox']) {
    const here = ds.filter((d) => (brand === 'onedrive' ? d.id.startsWith('onedrive') : d.id === brand)).map((d) => d.id);
    ids.push(...(here.length ? here : [brand]));
  }
  ids.push('custom');
  for (const s of servers().list()) ids.push(`keas:${s.serverId}`);
  ids.push('off');
  return ids.map(placeOf);
}

/** For hub.cjs: the server place things sync with now ({ key, base, token, root, stateFile }), or null. */
function serverPlace() {
  const id = current() === 'auto' ? cloud().autoDrive()?.id || DEFAULT : current();
  if (id === 'kea-hub') {
    if (!hub().signedIn()) return null;
    return { key: 'hub', base: () => hub().url(), token: () => hub()._token(), root: hub().syncRoot(), stateFile: path.join(userData(), 'hub-sync-state.json'), hub: true };
  }
  if (id.startsWith('keas:')) {
    const sid = id.slice(5);
    const s = servers().list().find((x) => x.serverId === sid);
    if (!s || s.signedOut) return null;
    return { key: id, base: () => s.url, token: () => servers().store()._secretOf(sid).token, ensure: () => servers().store().session(sid), root: keasRoot(sid), stateFile: path.join(userData(), `keas-sync-state-${sid}.json`), hub: false };
  }
  return null;
}

/** Where Kea Cloud documents are now (null: that place isn't on this computer). */
const docsRoot = (id = current()) => docsRootFor(placeOf(id), userData());

function status() {
  const id = current();
  const place = placeOf(id);
  return { choice: place.id, place, options: options(), docsRoot: docsRoot(id) };
}

/** What switching to `to` would do. */
function preview(to) {
  const from = placeOf(current());
  const next = placeOf(String(to));
  const src = docsRoot(current());
  const documents = src ? filesUnder(src).length : 0;
  let classes = false;
  let phone = false;
  try {
    const t = cloud().target();
    classes = !!t;
    phone = !!t && fs.existsSync(path.join(t, 'phone.json'));
  } catch {}
  return { from, to: next, documents, classes, phone, text: previewText({ from, to: next, documents, classes, phone }) };
}

/**
 * Switch. `folder` is the synced folder picked for "custom". The documents and the phone's file are copied to the new
 * place (nothing deleted), classes are written there with the next sync, and the syncs restart.
 */
async function choose(to, folder) {
  const id = String(to || '');
  const known = options().map((o) => o.id);
  if (!known.includes(id)) throw Object.assign(new Error('Kea can’t sync there.'), { status: 400 });
  const patch = { 'scholar.cloud': id };
  if (id === 'custom') {
    const f = String(folder || settings().get('scholar.cloudPath', '') || '');
    if (!f || !/^([a-z]:[\\/]|\/)/i.test(f) || f.startsWith('\\\\') || !fs.existsSync(f)) throw Object.assign(new Error('Pick a folder on this computer first.'), { status: 400 });
    patch['scholar.cloudPath'] = f;
  }
  const from = placeOf(current());
  const oldDocs = docsRoot(current());
  let oldTarget = null;
  try {
    oldTarget = cloud().target();
  } catch {}
  const ahead = placeOf(id);
  if (ahead.kind === 'drive' && !ahead.available) throw Object.assign(new Error(`${ahead.label} isn’t on this computer. Install it and sign in, then choose it again.`), { status: 400 });
  if (ahead.kind === 'keas' && !ahead.available) throw Object.assign(new Error('Join that server in Work first.'), { status: 400 });
  settings().set(patch);
  const next = placeOf(id);
  const copied = { documents: null, phone: false };
  const newDocs = docsRoot(id);
  if (oldDocs && newDocs && !next.locked) {
    fs.mkdirSync(newDocs, { recursive: true });
    copied.documents = copyInto(oldDocs, newDocs, from.label);
  }
  try {
    const t = cloud().target();
    if (oldTarget && t && !next.locked && fs.existsSync(path.join(oldTarget, 'phone.json')) && !fs.existsSync(path.join(t, 'phone.json'))) {
      fs.mkdirSync(t, { recursive: true });
      fs.copyFileSync(path.join(oldTarget, 'phone.json'), path.join(t, 'phone.json'));
      copied.phone = true;
    }
  } catch {}
  hub().restartSync();
  try {
    await require('./scholar/index.cjs').driveChanged?.();
  } catch {}
  return { ...status(), copied };
}

/**
 * Once, on updating: a computer that never picked (or picked "Automatic") keeps syncing where it did. Kea cloud is
 * the default, but someone already syncing through a drive without an online Kea account stays on that drive.
 */
function migrate() {
  const S = settings();
  if (S.get('sync.migrated', false)) return;
  const raw = S.get('scholar.cloud', undefined);
  if (raw === undefined || raw === 'auto') {
    let pick = DEFAULT;
    try {
      const d = cloud().autoDrive(); // (the old "Automatic" rule)
      if (d && !isServer(d.id) && fs.existsSync(path.join(d.path, 'Kea'))) pick = d.id;
    } catch {}
    S.set({ 'scholar.cloud': pick, 'sync.migrated': true });
  } else S.set({ 'sync.migrated': true });
}

function register() {
  const { ipcMain, dialog, BrowserWindow } = require('electron');
  const { handleApp } = require('./ipcGuard.cjs');
  const wrap = (fn) => async (_e, arg) => {
    try {
      return { ok: true, value: await fn(arg || {}) };
    } catch (e) {
      return { ok: false, error: String(e.message || e), status: e.status ?? null };
    }
  };
  try {
    migrate();
  } catch {}
  handleApp(ipcMain, 'sync:status', wrap(() => status()));
  handleApp(ipcMain, 'sync:preview', wrap(({ choice }) => preview(choice)));
  handleApp(ipcMain, 'sync:choose', wrap(({ choice, folder }) => choose(choice, folder)));
  handleApp(ipcMain, 'sync:pickFolder', wrap(async () => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const r = await dialog.showOpenDialog(win, { title: 'Pick a synced folder', properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0] || null;
  }));
}

module.exports = { register, current, placeOf, options, status, preview, choose, migrate, serverPlace, docsRoot, isServer, keasRoot, DEFAULT, _pure: { copyInto, copyName, filesUnder, docsRootFor, previewText } };
