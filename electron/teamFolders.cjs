// Shared work folders in Kea (0.99): an organization's shared folders (KeaS 0.10 / KeaC 0.11) on this computer, kept
// up to date download-only by teamFoldersCore.cjs, plus the page's calls to list, make, share and send up.
//
// - Copies live in <Documents>/<Org>/<Folder>/ (Settings → Work → Shared folders → where, Advanced).
// - Every 2 minutes while Kea is open (teamFolders.every), and on demand, what changed comes down.
// - The page sends a file up after saving it in a shared folder it can edit (teamFolders.uploadOnSave, on).
// - The org JSON routes go through hubOrg (each to the server that holds the organization); file contents go straight
//   to that server with its session (the Kea account's, or a joined KeaS server's).
// - A server that doesn't offer shared folders (older KeaS or Kea account server) answers 404: that organization simply
//   has none.
const { app, ipcMain, net, BrowserWindow } = require('electron');
const path = require('path');
const { handleApp } = require('./ipcGuard.cjs');
const { createTeamFolders } = require('./teamFoldersCore.cjs');

const hub = () => require('./hub.cjs');
const hubOrg = () => require('./hubOrg.cjs');
const servers = () => require('./servers.cjs');
const settings = () => require('./settings.cjs');

const ID = /^[\w-]{1,80}$/;
const check = (v, what) => {
  if (!ID.test(String(v ?? ''))) throw Object.assign(new Error(`Kea doesn’t know which ${what} that is.`), { status: 400 });
  return String(v);
};
const enc = (p) => String(p).split('/').map(encodeURIComponent).join('/');
const base = (orgId, folderId) => `/v1/orgs/${encodeURIComponent(orgId)}/folders${folderId ? `/${encodeURIComponent(folderId)}` : ''}`;

/** The org server's address and session for a source ('hub' or a joined server's id). */
async function targetOf(src) {
  if (src === hubOrg().HUB) {
    const token = hub()._token();
    if (!token) throw Object.assign(new Error('Sign in to your Kea account to use shared folders.'), { status: 401 });
    return { base: hub().url(), token, renew: null };
  }
  return servers().store().target(src);
}
/** A streamed file call to the server that holds the organization (signing in again once if its session ended). */
async function raw(src, method, p, { body, headers = {} } = {}) {
  let t = await targetOf(src);
  const go = (tok) =>
    net.fetch(`${t.base.replace(/\/+$/, '')}${p}`, {
      method,
      headers: { authorization: `Bearer ${tok}`, 'x-kea': '1', 'x-kea-client': `Kea/${app.getVersion()}`, ...headers },
      ...(body !== undefined ? { body } : {})
    });
  let r;
  try {
    r = await go(t.token);
    if (r.status === 401 && t.renew) r = await go(await t.renew());
  } catch (e) {
    throw Object.assign(new Error('Couldn’t reach the organization’s server.'), { status: 0 });
  }
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw Object.assign(new Error(data.error || `The organization’s server said ${r.status}.`), { status: r.status, data });
  }
  return r;
}
const json = (src, m, p, body) => hubOrg().send(src, m, p, body);

const client = {
  async files(src, orgId, folderId, since) {
    return json(src, 'GET', `${base(orgId, folderId)}/files?since=${Number(since) || 0}`);
  },
  async get(src, orgId, folderId, p) {
    const r = await raw(src, 'GET', `${base(orgId, folderId)}/files/${enc(p)}`);
    return Buffer.from(await r.arrayBuffer());
  },
  async put(src, orgId, folderId, p, data, { ifMatch, ifNoneMatch } = {}) {
    const r = await raw(src, 'PUT', `${base(orgId, folderId)}/files/${enc(p)}`, { body: data, headers: { 'content-type': 'application/octet-stream', ...(ifMatch ? { 'if-match': `"${ifMatch}"` } : {}), ...(ifNoneMatch ? { 'if-none-match': '*' } : {}) } });
    return r.json();
  },
  async orgName(src, orgId) {
    const { orgs } = await hubOrg().listOrgs();
    return (orgs.find((o) => o.id === orgId) || {}).name || null;
  }
};

let tf = null;
function core() {
  if (tf) return tf;
  tf = createTeamFolders({
    stateFile: path.join(app.getPath('userData'), 'team-folders.json'),
    rootDir: () => settings().get('teamFolders.root', '') || app.getPath('documents'),
    client,
    log: (m) => {
      console.log(m);
      BrowserWindow.getAllWindows().forEach((w) => !w.isDestroyed() && w.webContents.send('teamFolders:note', m));
    }
  });
  return tf;
}

/** Every organization's shared folders I can see: [{ org: { id, name, src }, folders, canCreate, quota }]. */
async function listAll() {
  const { orgs } = await hubOrg().listOrgs();
  const out = [];
  await Promise.all(
    orgs
      .filter((o) => o.status === undefined || o.status === 'active')
      .map(async (o) => {
        const src = await hubOrg().sourceOf(o.id);
        try {
          const r = await json(src, 'GET', base(o.id));
          out.push({ org: { id: o.id, name: o.name, src }, folders: r.folders || [], canCreate: !!r.canCreate, quota: r.quota || null });
        } catch (e) {
          // (404: this server doesn't offer shared folders yet.)
          if (e.status !== 404 && e.status !== 405) out.push({ org: { id: o.id, name: o.name, src }, folders: [], canCreate: false, error: e.message });
        }
      })
  );
  const kept = core().list();
  for (const g of out) for (const f of g.folders) f.here = kept.find((k) => k.orgId === g.org.id && k.folderId === f.id) || null;
  return out.sort((a, b) => a.org.name.localeCompare(b.org.name));
}

let timer = null;
const wrap = (fn) => async (_e, arg) => {
  try {
    return { ok: true, value: await fn(arg || {}) };
  } catch (e) {
    return { ok: false, error: String(e.message || e), status: e.status ?? null, data: e.data ?? null };
  }
};

function register() {
  handleApp(ipcMain, 'teamFolders:list', wrap(() => listAll()));
  handleApp(ipcMain, 'teamFolders:here', wrap(() => core().list()));
  handleApp(ipcMain, 'teamFolders:create', wrap(async ({ orgId, name }) => {
    const oid = check(orgId, 'organization');
    const src = await hubOrg().sourceOf(oid);
    const r = await json(src, 'POST', base(oid), { name: String(name || '').trim().slice(0, 80) });
    return core().open({ src, orgId: oid, folderId: r.folder.id });
  }));
  handleApp(ipcMain, 'teamFolders:open', wrap(async ({ orgId, folderId }) => {
    const oid = check(orgId, 'organization');
    return core().open({ src: await hubOrg().sourceOf(oid), orgId: oid, folderId: check(folderId, 'shared folder') });
  }));
  handleApp(ipcMain, 'teamFolders:forget', wrap(async ({ orgId, folderId }) => core().forget({ src: await hubOrg().sourceOf(check(orgId, 'organization')), orgId: String(orgId), folderId: check(folderId, 'shared folder') })));
  handleApp(ipcMain, 'teamFolders:rename', wrap(async ({ orgId, folderId, name, claude }) => {
    const oid = check(orgId, 'organization');
    const body = {};
    if (name != null) body.name = String(name).trim().slice(0, 80);
    if (claude != null) body.claude = !!claude;
    const r = await json(await hubOrg().sourceOf(oid), 'PATCH', base(oid, check(folderId, 'shared folder')), body);
    core().syncAll().catch(() => {});
    return r;
  }));
  handleApp(ipcMain, 'teamFolders:remove', wrap(async ({ orgId, folderId }) => {
    const oid = check(orgId, 'organization');
    return json(await hubOrg().sourceOf(oid), 'DELETE', base(oid, check(folderId, 'shared folder')));
  }));
  handleApp(ipcMain, 'teamFolders:access', wrap(async ({ orgId, folderId, grants }) => {
    const oid = check(orgId, 'organization');
    const src = await hubOrg().sourceOf(oid);
    const p = `${base(oid, check(folderId, 'shared folder'))}/access`;
    if (!Array.isArray(grants)) return json(src, 'GET', p);
    const clean = grants.slice(0, 500).map((g) => ({ kind: ['account', 'role', 'org'].includes(g?.kind) ? g.kind : 'account', ...(g?.kind === 'org' ? {} : { id: String(g?.id ?? '') }), access: ['view', 'edit', 'manage'].includes(g?.access) ? g.access : 'view' }));
    const r = await json(src, 'PUT', p, { grants: clean });
    core().syncAll().catch(() => {});
    return r;
  }));
  handleApp(ipcMain, 'teamFolders:people', wrap(async ({ orgId }) => {
    const oid = check(orgId, 'organization');
    const src = await hubOrg().sourceOf(oid);
    const [m, r] = await Promise.all([json(src, 'GET', `/v1/orgs/${encodeURIComponent(oid)}/members`), json(src, 'GET', `/v1/orgs/${encodeURIComponent(oid)}/roles`).catch(() => ({ roles: [] }))]);
    return { members: (m.members || []).filter((x) => x.status === 'active').map((x) => ({ id: x.id, name: x.name, you: !!x.you })), roles: (r.roles || []).map((x) => ({ id: x.id, name: x.name })) };
  }));
  handleApp(ipcMain, 'teamFolders:fileClaude', wrap(async ({ file, claude }) => {
    const w = core().whereIs(String(file || ''));
    if (!w) throw Object.assign(new Error('That file isn’t in a shared folder.'), { status: 400 });
    const r = await json(w.src, 'PATCH', `${base(w.orgId, w.folderId)}/files/claude`, { path: w.rel, claude: claude == null ? null : !!claude });
    await core().syncAll();
    return r;
  }));
  handleApp(ipcMain, 'teamFolders:whereIs', wrap(({ file }) => core().whereIs(String(file || ''))));
  handleApp(ipcMain, 'teamFolders:upload', wrap(({ file }) => core().upload(String(file || ''))));
  handleApp(ipcMain, 'teamFolders:syncNow', wrap(() => core().syncAll().then(() => core().list())));
  // What changed comes down every 2 minutes (and soon after Kea starts), while anything is kept here.
  const every = () => Math.max(1, Math.min(60, Number(settings().get('teamFolders.every', 2)) || 2)) * 60_000;
  const tick = () => {
    if (core().list().length) core().syncAll().catch(() => {});
    timer = setTimeout(tick, every());
  };
  timer = setTimeout(tick, 20_000);
}

module.exports = { register, stop: () => clearTimeout(timer) };
