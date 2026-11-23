// Shared work folders (Kea 0.99): an organization's shared folder (KeaS 0.10 / KeaC 0.11, protocol section 8) kept as
// a copy on this computer, download-only. Pure Node (no Electron), so it can be tested with node:test against a real
// KeaS server.
//
// - Everyone with access gets a copy: <root>/<Org>/<Folder>/, with a .kea-project.json (a work project, "shared").
// - Changes come from "what changed since <time>" every pass; deletions from a full listing every 15 minutes.
// - Nothing here ever deletes or changes anything on the server by itself. A file goes up only through upload(), when
//   someone who can edit saves it in Kea (or uses "Save to the shared folder"). A file removed on the server is
//   deleted here only if it wasn't changed here since it came; otherwise it's kept, renamed "… (removed from shared
//   folder)". A file changed here and on the server is kept both ways: theirs as the file, yours as "… (your copy)".
// - View-only copies are marked read-only on disk.
// - The project file lists the files Claude may not use (the folder's and each file's setting, from the server), so
//   Claude never sees them; a person's own "leave out" can only leave more out.
//
//   const tf = createTeamFolders({ stateFile, rootDir, client, now, log })
//   client: { list(src, orgId), files(src, orgId, folderId, since?), get(src, orgId, folderId, path) -> Buffer,
//             put(src, orgId, folderId, path, data, { ifMatch, ifNoneMatch }) -> { version, sha256, ... },
//             orgName(src, orgId) }
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROJECT_FILE = '.kea-project.json';
const FULL_EVERY = 15 * 60_000;
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
/** A name that's safe as one folder on Windows and elsewhere. */
const safeName = (s, fallback) => {
  const n = String(s || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, '-')
    .replace(/[. ]+$/, '')
    .trim()
    .slice(0, 80);
  return n || fallback;
};
const keyOf = (src, orgId, folderId) => `${src}|${orgId}|${folderId}`;
/** "Essay.docx" -> "Essay (your copy).docx", "… 2" and up when taken. */
function besideName(rel, label, exists) {
  const ext = path.posix.extname(rel);
  const base = rel.slice(0, rel.length - ext.length);
  for (let i = 1; i < 100; i++) {
    const c = `${base} (${label}${i > 1 ? ` ${i}` : ''})${ext}`;
    if (!exists(c)) return c;
  }
  return `${base} (${label} ${Date.now()})${ext}`;
}

function createTeamFolders({ stateFile, rootDir, client, now = Date.now, log = () => {} }) {
  let state = read();
  function read() {
    try {
      const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      return s && typeof s === 'object' && s.folders ? s : { folders: {} };
    } catch {
      return { folders: {} };
    }
  }
  function save() {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const tmp = `${stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
    fs.renameSync(tmp, stateFile);
  }
  const root = () => (typeof rootDir === 'function' ? rootDir() : rootDir);
  const local = (m, rel) => {
    const full = path.resolve(m.root, ...rel.split('/'));
    // (Never outside the folder, whatever the server sends.)
    if (!full.startsWith(path.resolve(m.root) + path.sep)) throw new Error('That path isn’t inside the shared folder.');
    return full;
  };
  const exists = (m) => (rel) => fs.existsSync(local(m, rel));
  const fileSha = (full) => {
    try {
      return sha256(fs.readFileSync(full));
    } catch {
      return null;
    }
  };
  const writable = (full, on) => {
    try {
      fs.chmodSync(full, on ? 0o666 : 0o444);
    } catch {}
  };
  function writeFileSafe(m, rel, data) {
    const full = local(m, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (fs.existsSync(full)) writable(full, true);
    const tmp = `${full}.kea-tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, full);
    if (m.access === 'view') writable(full, false);
  }
  function moveAside(m, rel, label) {
    const to = besideName(rel, label, exists(m));
    const from = local(m, rel);
    writable(from, true);
    fs.renameSync(from, local(m, to));
    return to;
  }

  /** The project file in the copy: the shared folder's details and the files Claude may not use; the rest is kept. */
  function writeProject(m) {
    const f = path.join(m.root, PROJECT_FILE);
    let j = {};
    try {
      j = JSON.parse(fs.readFileSync(f, 'utf8')) || {};
    } catch {}
    const off = Object.entries(m.files)
      .filter(([, v]) => v.claude === false)
      .map(([rel]) => rel)
      .sort();
    const next = {
      ...j,
      name: j.name || m.name,
      // (A shared context folder keeps its own kind; Kea 0.102.)
      kind: j.shared?.personal && j.kind ? j.kind : 'work',
      exclude: Array.isArray(j.exclude) ? j.exclude : [],
      shared: { src: m.src, orgId: m.orgId, orgName: m.orgName, folderId: m.folderId, folderName: m.name, access: m.access, claude: m.claude !== false, off, ...(j.shared?.personal ? { personal: true } : {}) },
    };
    const text = JSON.stringify(next, null, 2);
    try {
      if (fs.readFileSync(f, 'utf8') === text) return;
    } catch {}
    fs.mkdirSync(m.root, { recursive: true });
    fs.writeFileSync(f, text);
  }

  /** Start keeping a copy of a shared folder here (or return the one kept). */
  async function open({ src, orgId, folderId }) {
    const k = keyOf(src, orgId, folderId);
    if (state.folders[k]) return view(state.folders[k]);
    const listing = await client.files(src, orgId, folderId, 0);
    const orgName = (await client.orgName(src, orgId).catch(() => null)) || 'Organization';
    const f = listing.folder || {};
    const taken = new Set(Object.values(state.folders).map((x) => path.resolve(x.root).toLowerCase()));
    let dir = path.join(root(), safeName(orgName, 'Organization'), safeName(f.name, 'Shared folder'));
    for (let i = 2; taken.has(path.resolve(dir).toLowerCase()); i++) dir = path.join(root(), safeName(orgName, 'Organization'), `${safeName(f.name, 'Shared folder')} ${i}`);
    const m = { src, orgId, folderId, orgName, name: f.name || 'Shared folder', access: f.access || 'view', claude: f.claude !== false, root: dir, files: {}, since: 0, fullAt: 0, lastError: null, lastSync: 0, gone: false };
    state.folders[k] = m;
    fs.mkdirSync(dir, { recursive: true });
    save();
    await syncOne(m, listing).catch((e) => ((m.lastError = e.message), save()));
    return view(m);
  }

  /** One pass for one folder: what changed comes down; a full listing (deletions) every 15 minutes. */
  async function syncOne(m, given = null) {
    if (m.gone) return;
    const full = !m.fullAt || now() - m.fullAt > FULL_EVERY;
    let listing;
    try {
      // (Two seconds of overlap: a change made in the same moment as the last listing is never missed; versions
      // already here are simply skipped.)
      listing = given && full ? given : await client.files(m.src, m.orgId, m.folderId, full ? 0 : Math.max(0, (m.since || 0) - 2000));
    } catch (e) {
      // Access taken away, the folder deleted, or no longer a member: stop updating, keep everything here.
      if (e.status === 404 || e.status === 403) return lose(m, e.status === 403 ? 'You can’t see this shared folder any more.' : 'This shared folder was removed, or you no longer have access to it.');
      m.lastError = e.status === 0 || !e.status ? `Couldn’t reach ${m.orgName}. Your copy is kept and catches up when it can.` : e.message;
      save();
      return;
    }
    const f = listing.folder || {};
    if (f.access && f.access !== m.access) {
      m.access = f.access;
      // (Edit rights given or taken: every file's read-only mark follows.)
      for (const rel of Object.keys(m.files)) writable(local(m, rel), m.access !== 'view');
    }
    // The folder's Claude switch changed: every file's resolved setting may have, so read the whole list again.
    if (f.claude != null && (f.claude !== false) !== m.claude) {
      m.claude = f.claude !== false;
      if (!full) return syncOne(Object.assign(m, { fullAt: 0 }));
    }
    if (f.name && f.name !== m.name) m.name = f.name;
    const seen = new Set();
    for (const r of listing.files || []) {
      seen.add(r.path);
      const had = m.files[r.path];
      const claude = r.claude !== false;
      if (had && had.version === r.version) {
        if (had.claude !== claude) had.claude = claude;
        continue;
      }
      let rel = r.path;
      try {
        local(m, rel);
      } catch {
        continue;
      }
      const target = local(m, rel);
      // Changed here since it came (an editor who hasn't saved it up yet, or a copy someone edited outside Kea):
      // theirs becomes the file, yours is kept beside it.
      const cur = fs.existsSync(target) ? fileSha(target) : null;
      let keptAs = null;
      if (cur && cur !== (had?.sha256 ?? null) && cur !== r.sha256) keptAs = moveAside(m, rel, 'your copy');
      const data = await client.get(m.src, m.orgId, m.folderId, r.path);
      writeFileSafe(m, rel, data);
      m.files[rel] = { version: r.version, sha256: sha256(data), size: data.length, claude, updatedBy: r.updatedByName || null };
      if (keptAs) log(`Kept your changes to ${rel} as ${keptAs}: someone else changed it in ${m.name}.`);
    }
    if (full) {
      for (const rel of Object.keys(m.files)) {
        if (seen.has(rel)) continue;
        const target = local(m, rel);
        const cur = fs.existsSync(target) ? fileSha(target) : null;
        if (cur && cur === m.files[rel].sha256) {
          writable(target, true);
          fs.rmSync(target, { force: true });
        } else if (cur) moveAside(m, rel, 'removed from shared folder');
        delete m.files[rel];
      }
      m.fullAt = now();
    }
    m.since = Math.max(m.since || 0, Number(listing.now) || 0);
    m.lastError = null;
    m.lastSync = now();
    writeProject(m);
    save();
  }

  /** Access is gone: the copy stops updating and moves to "<Org> (no longer shared)", nothing deleted. */
  function lose(m, why) {
    m.gone = true;
    m.lastError = why;
    try {
      const to = path.join(root(), `${safeName(m.orgName, 'Organization')} (no longer shared)`, path.basename(m.root));
      if (fs.existsSync(m.root) && !fs.existsSync(to)) {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        for (const rel of Object.keys(m.files)) writable(local(m, rel), true);
        fs.renameSync(m.root, to);
        m.root = to;
      }
      // (It's an ordinary project now: no "shared" in its project file.)
      const pf = path.join(m.root, PROJECT_FILE);
      const j = JSON.parse(fs.readFileSync(pf, 'utf8'));
      delete j.shared;
      fs.writeFileSync(pf, JSON.stringify(j, null, 2));
    } catch {}
    save();
  }

  let running = null;
  /** A pass over every folder kept here (one at a time; a second call waits for the running one). */
  async function syncAll() {
    if (running) return running;
    running = (async () => {
      for (const m of Object.values(state.folders)) await syncOne(m).catch((e) => log(`Shared folder ${m.name}: ${e.message}`));
    })().finally(() => (running = null));
    return running;
  }

  /** The kept folder a file is in, and its path inside it (null when it isn't in one). */
  function whereIs(file) {
    const full = path.resolve(file);
    for (const m of Object.values(state.folders)) {
      const r = path.resolve(m.root);
      if (full.toLowerCase().startsWith(r.toLowerCase() + path.sep)) return { m, rel: full.slice(r.length + 1).split(path.sep).join('/') };
    }
    return null;
  }

  /**
   * Send one file up (someone who can edit saved it). Resolves { ok } or { conflict, keptAs } when someone else
   * changed it first (theirs is now the file; yours is kept beside it), or throws (view only, offline, full).
   */
  async function upload(file) {
    const w = whereIs(file);
    if (!w) throw Object.assign(new Error('That file isn’t in a shared folder.'), { status: 400 });
    const { m, rel } = w;
    if (m.gone) throw Object.assign(new Error('This folder isn’t shared with you any more.'), { status: 403 });
    if (m.access === 'view') throw Object.assign(new Error(`You can only view ${m.name}. Save a copy to your own files to keep your changes.`), { status: 403 });
    if (rel === PROJECT_FILE || rel.split('/').some((s) => s.startsWith('.kea-') || s.startsWith('~$'))) return { ok: true, skipped: true };
    const data = fs.readFileSync(file);
    const had = m.files[rel];
    if (had && had.sha256 === sha256(data)) return { ok: true, same: true };
    try {
      const r = await client.put(m.src, m.orgId, m.folderId, rel, data, had ? { ifMatch: had.version } : { ifNoneMatch: true });
      m.files[rel] = { version: r.version, sha256: r.sha256 || sha256(data), size: data.length, claude: r.claude !== false, updatedBy: null };
      save();
      writeProject(m);
      return { ok: true, version: r.version };
    } catch (e) {
      if (e.status !== 412) throw e;
      // Someone else changed it first: keep both.
      const keptAs = moveAside(m, rel, 'your copy');
      const listing = await client.files(m.src, m.orgId, m.folderId, 0);
      const theirs = (listing.files || []).find((x) => x.path === rel);
      if (theirs) {
        const d = await client.get(m.src, m.orgId, m.folderId, rel);
        writeFileSafe(m, rel, d);
        m.files[rel] = { version: theirs.version, sha256: sha256(d), size: d.length, claude: theirs.claude !== false, updatedBy: theirs.updatedByName || null };
      }
      save();
      return { conflict: true, keptAs };
    }
  }

  /** Stop keeping a copy here (the files stay, as an ordinary folder). */
  function forget({ src, orgId, folderId }) {
    const k = keyOf(src, orgId, folderId);
    const m = state.folders[k];
    if (!m) return false;
    for (const rel of Object.keys(m.files)) writable(local(m, rel), true);
    delete state.folders[k];
    save();
    return true;
  }

  const view = (m) => ({ src: m.src, orgId: m.orgId, folderId: m.folderId, orgName: m.orgName, name: m.name, access: m.access, claude: m.claude, root: m.root, files: Object.keys(m.files).length, lastSync: m.lastSync, lastError: m.lastError, gone: !!m.gone });
  return {
    open,
    syncAll,
    syncOne: (k) => (state.folders[k] ? syncOne(state.folders[k]) : Promise.resolve()),
    upload,
    forget,
    whereIs: (file) => {
      const w = whereIs(file);
      return w ? { ...view(w.m), rel: w.rel } : null;
    },
    list: () => Object.values(state.folders).map(view),
    _state: () => state,
  };
}

module.exports = { createTeamFolders, besideName, safeName, keyOf, PROJECT_FILE };
