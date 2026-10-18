// The Kea account: the student's email, name and picture, kept on this computer. School mode needs one, with the
// email verified. Kea has no server of its own, so an email counts as verified when it's the account of something
// already signed in here that proved it: the Claude account Kea uses, a OneDrive signed in on this computer, or the
// Google account signed in to Kea. Nothing is sent anywhere.
const { app, ipcMain, dialog, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

// Kea's creator: shown with their own badge.
const OWNER = 'kadenw213@gmail.com';
const file = () => path.join(app.getPath('userData'), 'account.json');
const norm = (e) => String(e || '').trim().toLowerCase();

function read() {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    return null;
  }
}
const write = (a) => (a ? fs.writeFileSync(file(), JSON.stringify(a, null, 1)) : fs.rmSync(file(), { force: true }));

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
function get() {
  const a = read();
  if (!a?.email) return null;
  let avatar = null;
  if (a.avatar) {
    try {
      avatar = `data:${MIME[path.extname(a.avatar).slice(1).toLowerCase()] || 'image/png'};base64,${fs.readFileSync(path.join(app.getPath('userData'), a.avatar)).toString('base64')}`;
    } catch {}
  }
  const verified = !!a.verified && norm(a.verified.email) === norm(a.email);
  return { email: a.email, name: a.name || '', avatar, verified, verifiedBy: verified ? a.verified.by : null, owner: verified && norm(a.email) === OWNER };
}
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

async function verify() {
  const a = read();
  if (!a?.email) throw new Error('Add your email first.');
  const all = await provenEmails();
  const hit = all.find((p) => norm(p.email) === norm(a.email));
  if (!hit) {
    const seen = [...new Set(all.map((p) => p.email))];
    throw new Error(
      seen.length
        ? `${a.email} isn't signed in on this computer. Signed in here: ${seen.join(', ')}. Use one of those, or sign in to Claude, OneDrive or Google with ${a.email}.`
        : `Nothing on this computer is signed in with ${a.email} yet. Sign in to Claude (under Add a class → From your school), OneDrive or Google with it, then verify again.`
    );
  }
  write({ ...a, verified: { email: a.email, by: hit.by, at: new Date().toISOString() } });
  return get();
}

function register() {
  ipcMain.handle('account:get', () => get());
  ipcMain.handle('account:suggest', async () => [...new Set((await provenEmails()).map((p) => p.email))]);
  ipcMain.handle('account:save', async (_e, { email, name }) => {
    const e = String(email || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error('That doesn’t look like an email address.');
    const a = read() || {};
    write({ ...a, email: e, name: String(name || '').trim().slice(0, 60), ...(norm(a.email) === norm(e) ? {} : { verified: null }) });
    // A new email is checked against what's signed in here straight away.
    return verify().catch(() => get());
  });
  ipcMain.handle('account:verify', () => verify());
  ipcMain.handle('account:avatar', async (e, clear) => {
    const a = read();
    if (!a) throw new Error('Add your email first.');
    if (a.avatar) fs.rmSync(path.join(app.getPath('userData'), a.avatar), { force: true });
    if (clear) {
      write({ ...a, avatar: null });
      return get();
    }
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { title: 'Choose your picture', properties: ['openFile'], filters: [{ name: 'Images', extensions: Object.keys(MIME) }] });
    const src = r.filePaths?.[0];
    if (!src) return get();
    if (fs.statSync(src).size > 8 * 1024 * 1024) throw new Error('That picture is over 8 MB. Pick a smaller one.');
    const name = `account-avatar-${Date.now().toString(36)}${path.extname(src).toLowerCase()}`;
    fs.copyFileSync(src, path.join(app.getPath('userData'), name));
    write({ ...a, avatar: name });
    return get();
  });
  ipcMain.handle('account:signOut', () => {
    const a = read();
    if (a?.avatar) fs.rmSync(path.join(app.getPath('userData'), a.avatar), { force: true });
    write(null);
    return true;
  });
}

module.exports = { register, get, verified };
