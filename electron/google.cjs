// Google Docs, Sheets and Slides support. Google Drive for desktop only puts small shortcut files
// (.gdoc/.gsheet/.gslides) on disk; the documents themselves live in Google's cloud. Kea asks Google once for access to
// the person's Drive (OAuth for desktop apps: system browser + loopback redirect + PKCE, incremental consent), finds
// the document, downloads it as .docx/.xlsx/.pptx, and uploads changes back so it stays a Google Doc.
// It uses Kea's built-in Google client, the same one as "Sign in with Google" (oauthClients.cjs), and prefers the
// Google account the person signed in to Kea with (login_hint). Nothing to set up. Tokens are encrypted with the OS
// keychain (safeStorage) and never leave this computer except to talk to Google. While Google hasn't reviewed Kea for
// Drive, only its listed test users get through; everyone else is told plainly and offered the browser instead.
const { app, ipcMain, shell, net, safeStorage } = require('electron');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const settings = require('./settings.cjs');
const { handleApp } = require('./ipcGuard.cjs');
const oauthClients = require('./oauthClients.cjs');

// (The scope the feature needs; with include_granted_scopes the person's earlier Kea sign-in stays part of it.)
const SCOPES = ['https://www.googleapis.com/auth/drive'];
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const TYPES = {
  gdoc: { google: 'application/vnd.google-apps.document', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx', kind: 'doc' },
  gsheet: { google: 'application/vnd.google-apps.spreadsheet', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx', kind: 'sheet' },
  gslides: { google: 'application/vnd.google-apps.presentation', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: 'pptx', kind: 'slides' }
};

const tokenFile = () => path.join(app.getPath('userData'), 'google-account.bin');
let session = null; // { refresh_token, access_token, expires_at, email }

function loadSession() {
  if (session) return session;
  try {
    const raw = fs.readFileSync(tokenFile());
    session = JSON.parse(safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8'));
  } catch {
    session = null;
  }
  return session;
}
function saveSession(s) {
  session = s;
  if (!s) return fs.rmSync(tokenFile(), { force: true });
  const json = JSON.stringify(s);
  fs.writeFileSync(tokenFile(), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : Buffer.from(json));
}

const coded = (code, message) => Object.assign(new Error(message), { code });
const NOT_HERE = 'Google Drive isn’t available in this copy of Kea. Google files open in your browser.';
const REFUSED = 'Google didn’t let Kea open your Drive yet. You can open the file in your browser instead.';
/** Kea's built-in Google client (the same as "Sign in with Google"). */
function client() {
  const g = oauthClients.clients().google;
  if (!g.id) throw coded('NO_CLIENT', NOT_HERE);
  return { id: g.id, secret: g.secret };
}
/**
 * The client a saved Drive connection renews with: the one it was made with. (Kea 0.83 and older made it with the
 * person's own client, google.clientId in settings: that keeps working until they disconnect.)
 */
function clientFor(s) {
  let built = null;
  try {
    built = client();
  } catch {}
  if (s?.clientId && built && s.clientId === built.id) return built;
  const ownId = String(settings.get('google.clientId', '') || '').trim();
  if (ownId && (!s?.clientId || s.clientId === ownId)) return { id: ownId, secret: String(settings.get('google.clientSecret', '') || '').trim() };
  throw coded('NO_ACCOUNT', 'Connect Google Drive again.');
}
/** The Google account the person signed in to Kea with, if it was with Google (for login_hint). */
function keaGoogleEmail() {
  try {
    const a = require('./hub.cjs').current();
    return a?.hub && a.hub.provider !== 'microsoft' ? a.email : null;
  } catch {
    return null;
  }
}
/** The address that asks Google for Drive access: one consent, added to what the person already allowed Kea. */
function driveAuthorizeUrl({ clientId, port, challenge, state, loginHint }) {
  const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  auth.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `http://127.0.0.1:${port}`,
    response_type: 'code',
    scope: SCOPES.join(' '),
    include_granted_scopes: 'true',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
    state,
    ...(loginHint ? { login_hint: loginHint } : {})
  }).toString();
  return auth.toString();
}
/** Google saying no (the app isn't reviewed for Drive and this account isn't a test user, or access was declined). */
const refusedError = (detail) => /access_denied|unauthorized_client|invalid_client|admin_policy|disallowed|org_internal/i.test(String(detail || '')) || !detail;

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function tokenRequest(params) {
  const res = await net.fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString()
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(j.error_description || j.error || `Google sign-in failed (${res.status})`), { oauthError: j.error || '' });
  return j;
}

let pendingLogin = null;
function signIn() {
  const { id, secret } = client();
  const loginHint = keaGoogleEmail();
  if (pendingLogin) pendingLogin.cancel();
  return new Promise((resolve, reject) => {
    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/') return res.writeHead(404).end();
      const done = (ok, msg) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          `<!doctype html><meta charset="utf-8"><title>Kea</title><body style="font-family:Segoe UI,system-ui,sans-serif;background:#131314;color:#e3e3e3;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2 style="font-weight:500">${ok ? 'Signed in to Google' : 'Sign-in did not finish'}</h2><p style="color:#9aa0a6">${msg}</p></div></body>`
        );
      };
      if (url.searchParams.get('state') !== state) return done(false, 'Please try again from Kea.');
      const code = url.searchParams.get('code');
      if (!code) {
        const err = url.searchParams.get('error') || '';
        done(false, 'You can close this tab and go back to Kea.');
        finish(refusedError(err) ? coded('REFUSED', REFUSED) : new Error('Google didn’t finish connecting. Try again from Kea.'));
        return;
      }
      try {
        const port = server.address().port;
        const t = await tokenRequest({ code, client_id: id, client_secret: secret, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: `http://127.0.0.1:${port}` });
        if (!t.refresh_token) throw new Error('Google didn’t give Kea lasting access. Try again from Kea.');
        const s = { clientId: id, refresh_token: t.refresh_token, access_token: t.access_token, expires_at: Date.now() + (t.expires_in - 60) * 1000 };
        saveSession(s);
        try {
          const about = await api('/about?fields=user(emailAddress,displayName)');
          s.email = about.user?.emailAddress;
          s.name = about.user?.displayName;
          saveSession(s);
        } catch {}
        done(true, 'You can close this tab and go back to Kea.');
        finish(null, { email: s.email, name: s.name });
      } catch (err) {
        done(false, String(err.message || err));
        finish(err.oauthError && refusedError(err.oauthError) ? coded('REFUSED', REFUSED) : err);
      }
    });
    // (Google's "access blocked" page never comes back to Kea: after a few minutes, the same plain message.)
    const timer = setTimeout(() => finish(coded('REFUSED', `Google didn’t finish connecting. ${REFUSED}`)), 3 * 60e3);
    const finish = (err, val) => {
      clearTimeout(timer);
      pendingLogin = null;
      setTimeout(() => server.close(), 500);
      err ? reject(err) : resolve(val);
    };
    pendingLogin = { cancel: () => finish(new Error('Replaced by a newer try.')) };
    server.listen(0, '127.0.0.1', () => {
      shell.openExternal(driveAuthorizeUrl({ clientId: id, port: server.address().port, challenge, state, loginHint }));
    });
  });
}

async function accessToken() {
  const s = loadSession();
  if (!s || !s.refresh_token) {
    const e = new Error('Connect Google Drive first.');
    e.code = 'NO_ACCOUNT';
    throw e;
  }
  if (s.access_token && Date.now() < s.expires_at) return s.access_token;
  const { id, secret } = clientFor(s);
  try {
    const t = await tokenRequest({ client_id: id, client_secret: secret, refresh_token: s.refresh_token, grant_type: 'refresh_token' });
    s.access_token = t.access_token;
    s.expires_at = Date.now() + (t.expires_in - 60) * 1000;
    saveSession(s);
    return s.access_token;
  } catch (err) {
    if (/invalid_grant|expired|revoked/i.test(err.message)) {
      saveSession(null);
      const e = new Error('Your Google Drive connection ended. Connect it again.');
      e.code = 'NO_ACCOUNT';
      throw e;
    }
    throw err;
  }
}

async function api(pathAndQuery, init = {}, raw = false) {
  const token = await accessToken();
  const url = pathAndQuery.startsWith('http') ? pathAndQuery : API + pathAndQuery;
  const res = await net.fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    const msg = j.error?.message || `Google Drive error ${res.status}`;
    const e = new Error(/exportSizeLimitExceeded|too large/i.test(msg) ? 'This file is too large for Google to export (over 10 MB).' : msg);
    e.status = res.status;
    throw e;
  }
  return raw ? res : res.json();
}

// Escape a value for a Drive search query string.
const q = (s) => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";

/**
 * Find the Drive file behind a local shortcut such as G:\My Drive\School\Essay.gdoc.
 * Older shortcut files contain the document id; newer ones can't be read, so walk the folder path.
 */
async function resolve(localPath) {
  const ext = path.extname(localPath).slice(1).toLowerCase();
  const type = TYPES[ext];
  if (!type) throw new Error('Not a Google Docs file.');
  try {
    const j = JSON.parse(fs.readFileSync(localPath, 'utf8'));
    const id = j.doc_id || (j.url && /[?&]id=([\w-]+)|\/d\/([\w-]+)/.exec(j.url)?.slice(1).find(Boolean));
    if (id) return { id, type };
  } catch {}

  const parts = path.resolve(localPath).split(/[\\/]/).filter(Boolean);
  let i = parts.findIndex((p) => p === 'My Drive' || p === 'Shared drives');
  if (i < 0) throw new Error("Kea couldn't tell where this file is in your Google Drive.");
  let parent = 'root';
  let driveId = null;
  if (parts[i] === 'Shared drives') {
    const drives = await api(`/drives?pageSize=100&q=${encodeURIComponent('name = ' + q(parts[i + 1]))}`);
    if (!drives.drives?.length) throw new Error(`Shared drive "${parts[i + 1]}" was not found.`);
    driveId = parent = drives.drives[0].id;
    i++;
  }
  const folders = parts.slice(i + 1, -1);
  const title = parts[parts.length - 1].replace(/\.(gdoc|gsheet|gslides)$/i, '');
  const extra = driveId ? `&corpora=drive&driveId=${driveId}&includeItemsFromAllDrives=true&supportsAllDrives=true` : '';
  for (const f of folders) {
    const r = await api(`/files?fields=files(id)&pageSize=5${extra}&q=${encodeURIComponent(`${q(parent)} in parents and name = ${q(f)} and mimeType = 'application/vnd.google-apps.folder' and trashed = false`)}`);
    if (!r.files?.length) throw new Error(`Folder "${f}" was not found in Google Drive.`);
    parent = r.files[0].id;
  }
  const r = await api(`/files?fields=files(id,name,modifiedTime)&orderBy=modifiedTime desc&pageSize=5${extra}&q=${encodeURIComponent(`${q(parent)} in parents and name = ${q(title)} and mimeType = ${q(type.google)} and trashed = false`)}`);
  if (!r.files?.length) throw new Error(`"${title}" was not found in Google Drive.`);
  return { id: r.files[0].id, type };
}

async function openFile(localPath) {
  const { id, type } = await resolve(localPath);
  const meta = await api(`/files/${id}?fields=id,name,modifiedTime,capabilities(canEdit)&supportsAllDrives=true`);
  const res = await api(`/files/${id}/export?mimeType=${encodeURIComponent(type.mime)}`, {}, true);
  const data = new Uint8Array(await res.arrayBuffer());
  return { id, name: meta.name, ext: type.ext, kind: type.kind, google: type.google, canEdit: meta.capabilities?.canEdit !== false, modifiedTime: meta.modifiedTime, data };
}

/** Upload new contents; Google converts the .docx/.xlsx/.pptx back into its own format. */
async function saveFile(id, kindExt, data) {
  const type = Object.values(TYPES).find((t) => t.ext === kindExt);
  if (!type) throw new Error('Unsupported format for Google Drive.');
  const boundary = 'kea' + crypto.randomBytes(8).toString('hex');
  const head = Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ mimeType: type.google })}\r\n--${boundary}\r\nContent-Type: ${type.mime}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--`);
  const body = Buffer.concat([head, Buffer.from(data), tail]);
  try {
    return await api(`${UPLOAD}/files/${id}?uploadType=multipart&supportsAllDrives=true&fields=id,modifiedTime`, { method: 'PATCH', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
  } catch (err) {
    // Some files reject changing metadata; a plain media upload converts the same way.
    if (err.status !== 400 && err.status !== 403) throw err;
    return api(`${UPLOAD}/files/${id}?uploadType=media&supportsAllDrives=true&fields=id,modifiedTime`, { method: 'PATCH', headers: { 'Content-Type': type.mime }, body: Buffer.from(data) });
  }
}

function register({ log }) {
  const wrap = (fn) => async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      log('google', err?.message);
      // Keep a machine-readable code at the front so the renderer can react.
      throw new Error(`${err.code ? `[${err.code}] ` : ''}${err.message || err}`);
    }
  };
  handleApp(ipcMain, 'google:status', () => status());
  handleApp(ipcMain, 'google:sign-in', wrap(() => signIn()));
  handleApp(ipcMain, 'google:sign-out', async () => {
    const s = loadSession();
    if (s?.refresh_token) net.fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(s.refresh_token)}`, { method: 'POST' }).catch(() => {});
    saveSession(null);
    // (The person's own client from Kea 0.83 and older was only kept for that connection.)
    if (settings.get('google.clientId', '') || settings.get('google.clientSecret', '')) settings.set({ 'google.clientId': null, 'google.clientSecret': null });
    return true;
  });
  handleApp(ipcMain, 'google:open', wrap((_e, p) => openFile(p)));
  handleApp(ipcMain, 'google:save', wrap((_e, id, ext, data) => saveFile(id, ext, data)));
}

/** Whether Drive can be used here (the built-in client), and who's connected. */
function status() {
  const s = loadSession();
  let configured = true;
  try {
    client();
  } catch {
    configured = false;
  }
  return { configured, signedIn: !!s?.refresh_token, email: s?.email || null, name: s?.name || null };
}

/** The Google account signed in to Kea, if any (its email). */
const signedInEmail = () => loadSession()?.email || null;

module.exports = { register, signedInEmail, _drive: { client, clientFor, driveAuthorizeUrl, status, keaGoogleEmail, refusedError, REFUSED, NOT_HERE } };
