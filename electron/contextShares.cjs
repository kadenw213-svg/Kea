// Sharing a context folder with other Kea accounts (Kea 0.102; KeaC 0.13 "contextShares", its protocol section 8).
//
// A shared context folder is a shared folder in the sharer's personal organization on the Kea account server. Sharing
// one the first time MOVES its contents there, so everyone it's shared with has the same, current files:
//   - the folder's files are uploaded (copies of linked files too);
//   - each linked Google Doc, Sheet or Slides is uploaded as an Office copy (.docx/.xlsx/.pptx): from then on that copy
//     is the one everyone edits, not the Google original (Kea warns before doing this);
//   - this PC keeps the folder the way it keeps any shared work folder (electron/teamFoldersCore.cjs): changes come
//     down every couple of minutes, files saved in Kea go up, and the old folder is left where it was, marked as moved.
// Storage counts against the sharer's Kea storage. Folders nobody else sees stay where they are (no upload).
// The logic is in contextSharesCore.cjs; this file connects it to the Kea account and the window.
const { ipcMain } = require('electron');
const { handleApp } = require('./ipcGuard.cjs');
const { createContextShares, base, enc, preview, sharedOf } = require('./contextSharesCore.cjs');

const tf = () => require('./teamFolders.cjs')._internal;
const hubOrg = () => require('./hubOrg.cjs');
let cs = null;
const shares = () =>
  (cs ||= createContextShares({
    json: (m, p, body) => hubOrg().send(hubOrg().HUB, m, p, body),
    client: tf().client,
    core: tf().core(),
    HUB: hubOrg().HUB,
    exportOffice: (id) => require('./google.cjs').exportOffice(id)
  }));

function register() {
  const wrap = (fn) => async (e, arg) => {
    try {
      return { ok: true, value: await fn(arg || {}, e) };
    } catch (err) {
      return { ok: false, error: String(err.message || err), status: err.status ?? null };
    }
  };
  handleApp(ipcMain, 'contextShare:available', wrap(async () => require('./hub.cjs').signedIn() && (await hubOrg().accountFeatures().catch(() => [])).includes('contextShares')));
  handleApp(ipcMain, 'contextShare:preview', wrap(({ dir }) => preview(String(dir))));
  handleApp(ipcMain, 'contextShare:status', wrap(async ({ dir }) => {
    const s = sharedOf(String(dir));
    if (!s) return { shared: false };
    return { shared: true, ...s, people: await shares().people(s.orgId, s.folderId).catch(() => []) };
  }));
  // Share with one person (moving the folder up the first time), telling the window how the upload goes.
  handleApp(ipcMain, 'contextShare:share', wrap((a, e) => shares().share(a, (msg, n, total) => {
    try {
      e.sender.send('contextShare:progress', { msg, n, total });
    } catch {}
  })));
  handleApp(ipcMain, 'contextShare:unshare', wrap((a) => shares().unshare(a)));
  handleApp(ipcMain, 'contextShare:withMe', wrap(() => shares().withMe()));
  handleApp(ipcMain, 'contextShare:add', wrap((a) => shares().add(a)));
  handleApp(ipcMain, 'contextShare:leave', wrap((a) => shares().leave(a)));
  // Take a file out of a shared context folder for everyone (to the server's 30-day bin), and out of this PC.
  handleApp(ipcMain, 'contextShare:removeFile', wrap(async ({ file }) => {
    const w = tf().core().whereIs(String(file));
    if (!w) throw new Error('That file isn’t in a shared folder.');
    await tf().raw(w.m.src, 'DELETE', `${base(w.m.orgId, w.m.folderId)}/files/${enc(w.rel)}`);
    await require('electron').shell.trashItem(String(file)).catch(() => {});
    await tf().core().syncAll().catch(() => {});
    return true;
  }));
}

module.exports = { register };
