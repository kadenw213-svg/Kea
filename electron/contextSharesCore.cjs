// Sharing a context folder with other Kea accounts (Kea 0.102): the logic, with the server calls passed in so it's
// tested against a real Kea account server (test/work/contextShares.test.mjs). electron/contextShares.cjs wires it up.
//   createContextShares({ json(method, path, body), client (teamFolders' put), core (teamFoldersCore), HUB, exportOffice(id) })
const fs = require('fs');
const path = require('path');

const PROJECT_FILE = '.kea-project.json';
const enc = (p) => String(p).split('/').map(encodeURIComponent).join('/');
const base = (orgId, folderId) => `/v1/orgs/${encodeURIComponent(orgId)}/folders${folderId ? `/${encodeURIComponent(folderId)}` : ''}`;

function readProject(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, PROJECT_FILE), 'utf8')) || {};
  } catch {
    return null;
  }
}

/** The folder's own files (not dot files or Office lock files), up to three levels down. */
function walk(dir) {
  const out = [];
  const go = (d, rel, depth) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name.startsWith('~$')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) depth < 3 && go(path.join(d, e.name), r, depth + 1);
      else if (e.isFile()) out.push({ abs: path.join(d, e.name), rel: r });
      if (out.length >= 1000) return;
    }
  };
  go(dir, '', 0);
  return out;
}

/** Where a context folder lives on the server, if it's shared already (this folder, or the one it moved to). */
function sharedOf(dir) {
  const j = readProject(dir);
  if (!j) return null;
  if (j.shared?.orgId && j.shared?.personal) return { orgId: j.shared.orgId, folderId: j.shared.folderId, root: dir };
  if (j.movedTo) return sharedOf(j.movedTo);
  return null;
}

/** What sharing would move, for the warning: files, linked files and Google files. */
function preview(dir) {
  const j = readProject(dir) || {};
  const files = sharedOf(dir) ? [] : walk(dir);
  return { shared: !!sharedOf(dir), files: files.length, bytes: files.reduce((s, f) => s + fs.statSync(f.abs).size, 0), refs: (j.refs || []).length, google: (j.links || []).map((l) => l.name) };
}

/** Move a context folder to the server (the first share). Returns { orgId, folderId, root }. */
function createContextShares({ json, client, core, HUB, exportOffice }) {
  async function moveUp(dir, progress = () => {}) {
  const j = readProject(dir);
  if (!j) throw new Error('That folder isn’t a context folder.');
  const { orgId } = await json('POST', '/v1/me/personal-org');
  const made = await json('POST', base(orgId), { name: String(j.name || path.basename(dir)).slice(0, 80) });
  const folderId = made.folder.id;
    const taken = new Set();
  const put = async (rel, data) => {
    let name = rel;
    const ext = path.extname(rel);
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${rel.slice(0, rel.length - ext.length)} (${i})${ext}`;
    taken.add(name.toLowerCase());
    await client.put(HUB, orgId, folderId, name, data, { ifNoneMatch: true });
  };
  const files = walk(dir);
  let n = 0;
  const total = files.length + (j.refs || []).length + (j.links || []).length;
  for (const f of files) {
    progress(`Uploading ${f.rel}`, ++n, total);
    await put(f.rel, fs.readFileSync(f.abs));
  }
  const skipped = [];
  for (const r of j.refs || []) {
    progress(`Uploading ${r.name}`, ++n, total);
    try {
      await put(r.name, fs.readFileSync(r.path));
    } catch {
      skipped.push(r.name);
    }
  }
  for (const l of j.links || []) {
    progress(`Copying ${l.name} from Google`, ++n, total);
    try {
      const g = await exportOffice(l.id);
      await put(g.name.replace(/[\\/:*?"<>|]+/g, '-'), g.data);
    } catch {
      skipped.push(l.name);
    }
  }
  const m = await core.open({ src: HUB, orgId, folderId });
  // The copy keeps the folder's own settings; its files are all in it now (no links).
  const mj = readProject(m.root) || {};
  const next = { ...mj, name: j.name || mj.name, kind: j.kind || 'work', exclude: [], ...(j.contacts ? { contacts: true } : {}), shared: { ...(mj.shared || {}), personal: true } };
  delete next.links;
  delete next.refs;
  fs.writeFileSync(path.join(m.root, PROJECT_FILE), JSON.stringify(next, null, 2));
  // The old folder stays (nothing is deleted), marked as moved.
  fs.writeFileSync(path.join(dir, PROJECT_FILE), JSON.stringify({ ...j, movedTo: m.root }, null, 2));
  return { orgId, folderId, root: m.root, skipped };
}

  async function people(orgId, folderId) {
  const r = await json('GET', `${base(orgId, folderId)}/access`);
  return (r.grants || []).filter((g) => g.kind === 'account').map((g) => ({ id: g.id, name: g.name || '', email: g.email || '', access: g.access }));
}


  /** Put a just-moved folder back: the server copy goes, this PC's copy goes, the folder is its own again. */
  async function undoMove(dir, m) {
    await json('DELETE', base(m.orgId, m.folderId)).catch(() => {});
    core.forget({ src: HUB, orgId: m.orgId, folderId: m.folderId });
    fs.rmSync(m.root, { recursive: true, force: true });
    const j = readProject(dir) || {};
    delete j.movedTo;
    fs.writeFileSync(path.join(dir, PROJECT_FILE), JSON.stringify(j, null, 2));
  }

  /** Share with one person (moving the folder up the first time). */
  async function share({ dir, email, access }, progress = () => {}) {
    let s = sharedOf(String(dir));
    let moved = null;
    if (!s) s = moved = await moveUp(String(dir), progress);
    try {
      if (email) await json('POST', `${base(s.orgId, s.folderId)}/share`, { email: String(email).trim(), access: access === 'edit' ? 'edit' : 'view' });
    } catch (err) {
      // Not shared after all (no such account, say): undo the move, so nothing changed.
      if (moved) await undoMove(String(dir), moved).catch(() => {});
      throw err;
    }
    return { orgId: s.orgId, folderId: s.folderId, root: s.root, moved: !!moved, skipped: moved?.skipped || [], people: await people(s.orgId, s.folderId).catch(() => []) };
  }
  async function unshare({ orgId, folderId, accountId }) {
    await json('DELETE', `${base(orgId, folderId)}/share/${encodeURIComponent(accountId)}`);
    return people(orgId, folderId);
  }
  const withMe = async () => (await json('GET', '/v1/shared-with-me')).folders || [];
  /** Add a folder someone shared: kept on this PC like a shared work folder. */
  async function add({ orgId, folderId }) {
    const m = await core.open({ src: HUB, orgId: String(orgId), folderId: String(folderId) });
    const j = readProject(m.root) || {};
    fs.writeFileSync(path.join(m.root, PROJECT_FILE), JSON.stringify({ ...j, shared: { ...(j.shared || {}), personal: true } }, null, 2));
    return m;
  }
  async function leave({ orgId, folderId }) {
    await json('POST', `/v1/shared-with-me/${encodeURIComponent(orgId)}/${encodeURIComponent(folderId)}/leave`);
    core.forget({ src: HUB, orgId, folderId });
    return true;
  }
  return { moveUp, people, share, unshare, withMe, add, leave, sharedOf, preview };
}

module.exports = { createContextShares, walk, sharedOf, preview, base, enc };
