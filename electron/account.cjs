// The Kea account as the rest of this computer sees it. There is one account, the Kea account on the Kea Hub: its
// email, name and "verified" come from there (hub.cjs keeps a copy for when the Hub is offline). Two things stay on
// this computer, in account.json, because the Hub has no place for them:
//   - the picture beside the name (and where it sits in its circle), kept for the account it was chosen for;
//   - for School mode, a second way to count the email as verified: the same email signed in here to the Claude account
//     Kea uses, a OneDrive or the Google account in Kea (checked when the person asks; nothing is sent anywhere).
// (Before Kea had the Hub, account.json was a separate local account with its own email and name. Those are no longer
// read: the Kea account's are used. Its picture is kept and goes with the first Kea account signed in here.)
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

function hubAccount() {
  try {
    return require('./hub.cjs').cached();
  } catch {
    return null;
  }
}

/** The picture and proof kept here, and whether they belong to this Kea account (an older local one is taken over once). */
function local(hub) {
  const a = read();
  if (!hub?.id) return { a, mine: false };
  if (!a.accountId && (a.avatar || a.email)) {
    a.accountId = hub.id;
    // (The old local account's proof only counts when it was for the same email.)
    const proof = a.verified?.email && norm(a.verified.email) === norm(hub.email) ? a.verified : null;
    for (const k of ['email', 'name', 'verified']) delete a[k];
    if (proof) a.proof = proof;
    write(a);
  }
  return { a, mine: a.accountId === hub.id };
}

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
/** { email, name, avatar, crop, verified, verifiedBy, verifiedHere, owner }, or null when signed out of the Kea account. */
function get() {
  const hub = hubAccount();
  if (!hub?.email) return null;
  const { a, mine } = local(hub);
  let avatar = null;
  if (mine && a.avatar) {
    try {
      avatar = `data:${MIME[path.extname(a.avatar).slice(1).toLowerCase()] || 'image/png'};base64,${fs.readFileSync(path.join(app.getPath('userData'), a.avatar)).toString('base64')}`;
    } catch {}
  }
  const proof = mine && a.proof?.email && norm(a.proof.email) === norm(hub.email) ? a.proof : null;
  const verified = !!hub.emailVerified || !!proof;
  const verifiedBy = hub.emailVerified ? hub.verifiedBy || 'Kea Hub' : proof ? `${proof.by}, on this computer` : null;
  return { email: hub.email, name: hub.name || '', avatar, crop: avatar ? a.crop || null : null, verified, verifiedBy, verifiedHere: !hub.emailVerified && !!proof, owner: !!hub.owner };
}
/** School mode's check: the Kea account's email is verified (on the Hub, or by a sign-in on this computer). */
const verified = () => !!get()?.verified;

/** Emails proven by sign-ins on this computer: [{ email, by }]. */
async function provenEmails() {
  const out = [];
  try {
    const ws = require('./scholar/workspace.cjs');
    const c = await ws.check();
    if (c.account?.loggedIn && c.account.email) out.push({ email: c.account.email, by: 'Claude' });
  } catch {}
  try {
    for (const d of require('./scholar/cloud.cjs').drives()) if (/@/.test(d.account || '')) out.push({ email: d.account, by: d.label });
  } catch {}
  try {
    const g = require('./google.cjs').signedInEmail();
    if (g) out.push({ email: g, by: 'Google' });
  } catch {}
  return out;
}

/** Looks for the Kea account's email among this computer's sign-ins (School mode accepts that as verified). */
async function verifyHere() {
  const hub = hubAccount();
  if (!hub?.id) throw new Error('Sign in to your Kea account first.');
  const all = await provenEmails();
  const hit = all.find((p) => norm(p.email) === norm(hub.email));
  if (!hit) {
    const seen = [...new Set(all.map((p) => p.email))];
    throw new Error(
      seen.length
        ? `${hub.email} isn’t signed in on this computer. Signed in here: ${seen.join(', ')}.`
        : `Nothing on this computer is signed in with ${hub.email}. Sign in to Claude, OneDrive or Google with it, then check again.`
    );
  }
  const { a, mine } = local(hub);
  write({ ...(mine ? a : {}), accountId: hub.id, proof: { email: hub.email, by: hit.by, at: new Date().toISOString() } });
  return get();
}

function register() {
  handleApp(ipcMain, 'account:get', () => get());
  handleApp(ipcMain, 'account:verifyHere', () => verifyHere());
  handleApp(ipcMain, 'account:avatar', async (e, clear) => {
    const hub = hubAccount();
    if (!hub?.id) throw new Error('Sign in to your Kea account first.');
    const { a, mine } = local(hub);
    const dir = app.getPath('userData');
    const drop = () => mine && a.avatar && fs.rmSync(path.join(dir, a.avatar), { force: true });
    if (clear) {
      drop();
      write({ ...(mine ? a : {}), accountId: hub.id, avatar: null, crop: null });
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
    write({ ...(mine ? a : {}), accountId: hub.id, avatar: name, crop: null });
    return get();
  });
  // Where the picture sits in the circle: the point at its centre (0–1 across and down), how far it's zoomed in (1 =
  // the short side just fills the circle), and the picture's own size.
  handleApp(ipcMain, 'account:crop', (_e, c) => {
    const { a, mine } = local(hubAccount());
    if (!mine || !a.avatar) throw new Error('Choose a picture first.');
    const num = (v, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : lo);
    write({ ...a, crop: c ? { x: num(c.x, 0, 1), y: num(c.y, 0, 1), zoom: num(c.zoom, 1, 8), w: num(c.w, 1, 1e5), h: num(c.h, 1, 1e5) } : null });
    return get();
  });
}

/** The Kea account was deleted: its picture and proof on this computer go too. */
function forget(accountId) {
  const a = read();
  if (!accountId || a.accountId !== accountId) return;
  if (a.avatar) fs.rmSync(path.join(app.getPath('userData'), a.avatar), { force: true });
  fs.rmSync(file(), { force: true });
}

module.exports = { register, get, verified, forget };
