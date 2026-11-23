// Google Contacts for work projects: Claude can look people up ("who on the availability sheet hasn't answered, and
// how do I reach them?"). Read-only (contacts.readonly), its own connection (google-contacts.bin, encrypted), so it
// never grants Drive or Calendar. The list is read when Claude asks and kept in memory for ten minutes, never saved.
const fs = require('node:fs');
const path = require('node:path');

const SCOPE = 'https://www.googleapis.com/auth/contacts.readonly';

// ---------- Pure parts (tested in test/office/contacts.test.mjs) ----------
/** A People API person as { name, emails, phones, org }. */
function simplify(p) {
  return {
    name: p.names?.[0]?.displayName || '',
    emails: (p.emailAddresses || []).map((e) => e.value).filter(Boolean),
    phones: (p.phoneNumbers || []).map((e) => e.value).filter(Boolean),
    org: p.organizations?.[0]?.name || ''
  };
}
/** People matching every word of the query (in the name, emails, phones or organization); all of them for no query. */
function search(people, query, max = 50) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  return people.filter((p) => words.every((w) => `${p.name} ${p.emails.join(' ')} ${p.phones.join(' ')} ${p.org}`.toLowerCase().includes(w))).slice(0, max);
}

// ---------- Connection (Electron) ----------
let session = null;
const tokenFile = () => path.join(require('electron').app.getPath('userData'), 'google-contacts.bin');
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

let cache = null; // { at, people }
async function people() {
  if (cache && Date.now() - cache.at < 10 * 60e3) return cache.people;
  let s = load();
  if (!s?.refresh_token) throw Object.assign(new Error('Connect Google Contacts first (Settings → Google).'), { code: 'NO_ACCOUNT' });
  const r = await require('./google.cjs').refreshed(s);
  if (r.access_token !== s.access_token) save((s = { ...s, ...r }));
  const out = [];
  let page = '';
  for (let i = 0; i < 10; i++) {
    const url = `https://people.googleapis.com/v1/people/me/connections?personFields=names,emailAddresses,phoneNumbers,organizations&pageSize=1000${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`;
    const res = await require('electron').net.fetch(url, { headers: { Authorization: `Bearer ${s.access_token}` } });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error?.message || `Google Contacts error ${res.status}`);
    out.push(...(j.connections || []).map(simplify).filter((p) => p.name || p.emails.length));
    if (!j.nextPageToken) break;
    page = j.nextPageToken;
  }
  cache = { at: Date.now(), people: out };
  return out;
}

function register() {
  const { ipcMain, net } = require('electron');
  const { handleApp } = require('./ipcGuard.cjs');
  const wrap = (fn) => async (...a) => {
    try {
      return await fn(...a);
    } catch (err) {
      throw new Error(`${err.code ? `[${err.code}] ` : ''}${err.message || err}`);
    }
  };
  handleApp(ipcMain, 'contacts:status', () => ({ connected: !!load()?.refresh_token }));
  handleApp(
    ipcMain,
    'contacts:connect',
    wrap(async () => {
      save(await require('./google.cjs').authorize([SCOPE]));
      cache = null;
      return { connected: true };
    })
  );
  handleApp(ipcMain, 'contacts:disconnect', async () => {
    const s = load();
    if (s?.refresh_token) net.fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(s.refresh_token)}`, { method: 'POST' }).catch(() => {});
    save(null);
    cache = null;
    return { connected: false };
  });
  handleApp(ipcMain, 'contacts:search', wrap(async (_e, q) => search(await people(), String(q || ''))));
}

/** Use a connection made by Connect Google (one consent for Drive, Contacts and Gmail sending). */
function adopt(s) {
  save(s);
  cache = null;
}

module.exports = { register, adopt, _test: { simplify, search } };
