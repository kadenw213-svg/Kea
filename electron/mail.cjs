// Sending messages Claude drafted, after the person approves them (Kea 0.101.2): "message everyone who hasn't sent
// their availability". Claude only drafts; the Claude page shows the message and every recipient, and nothing goes out
// until the person presses Send. Through Gmail (gmail.send: send only, never read), its own connection
// (google-mail.bin, encrypted), like Google Contacts. Each person gets their own email (no one sees the others).
const fs = require('node:fs');
const path = require('node:path');

const SCOPE = 'https://www.googleapis.com/auth/gmail.send';

// ---------- Pure parts (tested in test/office/mail.test.mjs) ----------
const clean = (s) => String(s || '').replace(/[\r\n]+/g, ' ').trim();
/** "Ava Brooks" <ava@x.org>, with the name quoted safely. */
function address(name, email) {
  const e = clean(email);
  if (!/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(e)) throw new Error(`“${e}” isn’t an email address.`);
  const n = clean(name).replace(/["\\]/g, '');
  return n ? `"${n}" <${e}>` : e;
}
/** {first} and {name} in the text become the person's first name and full name. */
function personal(text, name) {
  const full = clean(name);
  return String(text || '').replace(/\{first\}/g, full.split(/\s+/)[0] || 'there').replace(/\{name\}/g, full || 'there');
}
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
/** One email as Gmail's raw, base64url RFC 2822 message. */
function rawMessage({ to, subject, body }) {
  const lines = [`To: ${to}`, `Subject: =?UTF-8?B?${b64(clean(subject))}?=`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(String(body || '').replace(/\r?\n/g, '\r\n'))];
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------- Connection (Electron) ----------
let session = null;
const tokenFile = () => path.join(require('electron').app.getPath('userData'), 'google-mail.bin');
function load() {
  if (session) return session;
  const { safeStorage } = require('electron');
  try {
    const raw = fs.readFileSync(tokenFile());
    session = JSON.parse(safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8'));
  } catch {
    session = null;
  }
  return session;
}
function save(s) {
  const { safeStorage } = require('electron');
  session = s;
  if (!s) return fs.rmSync(tokenFile(), { force: true });
  const json = JSON.stringify(s);
  fs.writeFileSync(tokenFile(), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : Buffer.from(json));
}

/** Send each recipient their own copy. Returns who it went to and who it didn't (with why). */
async function send({ subject, body, recipients }) {
  let s = load();
  if (!s?.refresh_token) throw Object.assign(new Error('Connect Gmail first.'), { code: 'NO_ACCOUNT' });
  const r = await require('./google.cjs').refreshed(s);
  if (r.access_token !== s.access_token) save((s = { ...s, ...r }));
  const sent = [];
  const failed = [];
  for (const p of (recipients || []).slice(0, 200)) {
    try {
      const raw = rawMessage({ to: address(p.name, p.email), subject: personal(subject, p.name), body: personal(body, p.name) });
      const res = await require('electron').net.fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${s.access_token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ raw })
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error?.message || `Gmail error ${res.status}`);
      sent.push(p.email);
    } catch (err) {
      failed.push({ email: p.email, error: String(err?.message || err) });
    }
  }
  return { sent, failed };
}

function register() {
  const { ipcMain, net, shell } = require('electron');
  const { handleApp } = require('./ipcGuard.cjs');
  const wrap = (fn) => async (...a) => {
    try {
      return await fn(...a);
    } catch (err) {
      throw new Error(`${err.code ? `[${err.code}] ` : ''}${err.message || err}`);
    }
  };
  handleApp(ipcMain, 'mail:status', () => ({ connected: !!load()?.refresh_token }));
  handleApp(
    ipcMain,
    'mail:connect',
    wrap(async () => {
      save(await require('./google.cjs').authorize([SCOPE]));
      return { connected: true };
    })
  );
  handleApp(ipcMain, 'mail:disconnect', async () => {
    const s = load();
    if (s?.refresh_token) net.fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(s.refresh_token)}`, { method: 'POST' }).catch(() => {});
    save(null);
    return { connected: false };
  });
  handleApp(ipcMain, 'mail:send', wrap(async (_e, a) => send(a || {})));
  // Without Gmail: the person's own mail app, one message with everyone in Bcc.
  handleApp(ipcMain, 'mail:compose', async (_e, a = {}) => {
    const bcc = (a.recipients || []).map((p) => clean(p.email)).filter(Boolean).join(',');
    const url = `mailto:?bcc=${encodeURIComponent(bcc)}&subject=${encodeURIComponent(personal(a.subject, ''))}&body=${encodeURIComponent(personal(a.body, ''))}`;
    await shell.openExternal(url);
    return true;
  });
}

/** Use a connection made by Connect Google (one consent for Drive, Contacts and Gmail sending). */
function adopt(s) {
  save(s);
}

module.exports = { register, adopt, _test: { address, personal, rawMessage } };
