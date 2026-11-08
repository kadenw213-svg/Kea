// The Kea account as the rest of this computer sees it: the account signed in here (hub.cjs; made on this computer or
// online), its email and name, and "verified" when the online account's email is verified. One thing stays only on
// this computer, in account.json: the picture beside the name (and where it sits in its circle), kept for the account
// it was chosen for.
// (Before Kea had the Hub, account.json was a separate local account with its own email and name. Those are no longer
// read. Its picture is kept and goes with the first Kea account signed in here.)
const { app, ipcMain, dialog, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { handleApp } = require('./ipcGuard.cjs');

const file = () => path.join(app.getPath('userData'), 'account.json');
const norm = (e) => String(e || '').trim().toLowerCase();

function read() {
  try {
    const a = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return a && typeof a === 'object' ? a : {};
  } catch {
    return {};
  }
}
const write = (a) => fs.writeFileSync(file(), JSON.stringify(a, null, 1));

/**
 * The account signed in here: { id (this computer's), hubId (the online account's, once linked), email, name }, with
 * the online account's details when Kea has them. null when nobody is signed in.
 */
function who() {
  let hub;
  try {
    hub = require('./hub.cjs');
  } catch {
    return null;
  }
  const cur = hub.current?.() || null;
  const c = hub.cached?.() || null;
  if (!cur) return null;
  const online = c && c.email && norm(c.email) === norm(cur.email) ? c : null;
  return { id: cur.id, hubId: cur.hub?.id || online?.id || null, email: cur.email, name: online?.name || cur.name || '', online };
}

/** The picture kept here, and whether it belongs to this account (an older one is taken over once). */
function local(w) {
  const a = read();
  if (!w?.id) return { a, mine: false };
  if (!a.accountId && (a.avatar || a.email)) {
    a.accountId = w.id;
    for (const k of ['email', 'name', 'verified', 'proof']) delete a[k];
    write(a);
  }
  // (A picture chosen while this account was known by its online id, before Kea kept accounts here, is still its own.)
  return { a, mine: a.accountId === w.id || (!!w.hubId && a.accountId === w.hubId) };
}

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
/** { email, name, avatar, crop, verified, verifiedBy, owner }, or null when nobody is signed in here. */
function get() {
  const w = who();
  if (!w?.email) return null;
  const { a, mine } = local(w);
  let avatar = null;
  if (mine && a.avatar) {
    try {
      avatar = `data:${MIME[path.extname(a.avatar).slice(1).toLowerCase()] || 'image/png'};base64,${fs.readFileSync(path.join(app.getPath('userData'), a.avatar)).toString('base64')}`;
    } catch {}
  }
  const o = w.online;
  return { email: w.email, name: w.name, avatar, crop: avatar ? a.crop || null : null, verified: !!o?.emailVerified, verifiedBy: o?.emailVerified ? o.verifiedBy || 'Kea' : null, owner: !!o?.owner };
}

function register() {
  handleApp(ipcMain, 'account:get', () => get());
  handleApp(ipcMain, 'account:avatar', async (e, clear) => {
    const w = who();
    if (!w?.id) throw new Error('Sign in to your Kea account first.');
    const { a, mine } = local(w);
    const dir = app.getPath('userData');
    const drop = () => mine && a.avatar && fs.rmSync(path.join(dir, a.avatar), { force: true });
    if (clear) {
      drop();
      write({ ...(mine ? a : {}), accountId: w.id, avatar: null, crop: null });
      return get();
    }
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { title: 'Choose your picture', properties: ['openFile'], filters: [{ name: 'Images', extensions: Object.keys(MIME) }] });
    const src = r.filePaths?.[0];
    if (!src) return get();
    if (fs.statSync(src).size > 8 * 1024 * 1024) throw new Error('That picture is over 8 MB. Pick a smaller one.');
    const name = `account-avatar-${Date.now().toString(36)}${path.extname(src).toLowerCase()}`;
    fs.copyFileSync(src, path.join(dir, name));
    // The whole picture is kept, so where it sits in the circle can be changed again later.
    drop();
    // (A picture another account chose here is replaced: one picture per computer, for whoever is signed in.)
    write({ ...(mine ? a : {}), accountId: w.id, avatar: name, crop: null });
    return get();
  });
  // Where the picture sits in the circle: the point at its centre (0–1 across and down), how far it's zoomed in (1 =
  // the short side just fills the circle), and the picture's own size.
  handleApp(ipcMain, 'account:crop', (_e, c) => {
    const w = who();
    const { a, mine } = local(w);
    if (!mine || !a.avatar) throw new Error('Choose a picture first.');
    const num = (v, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : lo);
    write({ ...a, accountId: w.id, crop: c ? { x: num(c.x, 0, 1), y: num(c.y, 0, 1), zoom: num(c.zoom, 1, 8), w: num(c.w, 1, 1e5), h: num(c.h, 1, 1e5) } : null });
    return get();
  });
}

/** The Kea account was deleted: its picture on this computer goes too (ids: its online id and this computer's). */
function forget(...ids) {
  const a = read();
  if (!a.accountId || !ids.filter(Boolean).includes(a.accountId)) return;
  if (a.avatar) fs.rmSync(path.join(app.getPath('userData'), a.avatar), { force: true });
  fs.rmSync(file(), { force: true });
}

module.exports = { register, get, forget };
