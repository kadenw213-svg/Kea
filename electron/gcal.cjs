// Google Calendar sync: Kea's calendar (classes, assignments, work, personal events: the same events as the calendar
// link) copied into a calendar named "Kea" in the person's Google Calendar, kept up to date every 15 minutes.
// One way, Kea to Google. It asks Google only for calendar.app.created: Kea can make and change its own "Kea" calendar
// and nothing else in the person's Google Calendar. The connection is its own (google-calendar.bin, encrypted like
// the Drive one), so connecting the calendar never grants Drive and the other way round. Disconnecting removes the
// "Kea" calendar from Google. While Google hasn't reviewed Kea for this scope, only Kea's listed test users get through;
// everyone else is told plainly and can use the calendar link (calendarShare.cjs) instead.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';
const API = 'https://www.googleapis.com/calendar/v3';
const DAY = 864e5;

// ---------- Pure parts (tested in test/calendar/gcal.test.mjs) ----------
/** Google's event id for a Kea event: stable, and only the characters Google allows (0-9, a-v). */
const gid = (keaId) => `kea${crypto.createHash('sha1').update(String(keaId)).digest('hex')}`;
const nextDay = (d) => {
  const [y, m, dd] = d.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, dd + 1));
  return t.toISOString().slice(0, 10);
};

/** A calendar-link event (calendarShare.cjs toEvent) as a Google Calendar event. */
function toGoogle(e, timeZone = 'UTC') {
  const description = [e.notes, e.url].filter(Boolean).join('\n\n') || undefined;
  const base = { id: gid(e.id), summary: e.title, status: 'confirmed', ...(e.location ? { location: e.location } : {}), ...(description ? { description } : {}), extendedProperties: { private: { kea: String(e.id) } }, reminders: { useDefault: false } };
  if (e.allDay) return { ...base, start: { date: e.start }, end: { date: nextDay(e.end && e.end > e.start ? e.end : e.start) } };
  const end = e.end && Date.parse(e.end) > Date.parse(e.start) ? e.end : new Date(Date.parse(e.start) + 30 * 60e3).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return { ...base, start: { dateTime: e.start, timeZone }, end: { dateTime: end, timeZone } };
}

const hashOf = (g) => crypto.createHash('sha1').update(JSON.stringify(g)).digest('hex').slice(0, 16);

/**
 * What to send: `state` is { [googleId]: hash } from the last sync. Returns { upserts: [googleEvent], deletes:
 * [googleId], next } where `next` is the state once all of it went through.
 */
function diff(state, events, timeZone) {
  const next = {};
  const upserts = [];
  for (const e of events) {
    const g = toGoogle(e, timeZone);
    const h = hashOf(g);
    next[g.id] = h;
    if (state[g.id] !== h) upserts.push(g);
  }
  const deletes = Object.keys(state).filter((id) => !(id in next));
  return { upserts, deletes, next };
}

// ---------- The connection and the sync (Electron) ----------
let session = null; // { clientId, refresh_token, access_token, expires_at, calendarId, email }
let syncState = null; // { events: { [googleId]: hash }, lastSync, count, error }
const dir = () => require('electron').app.getPath('userData');
const tokenFile = () => path.join(dir(), 'google-calendar.bin');
const stateFile = () => path.join(dir(), 'google-calendar-sync.json');

function loadSession() {
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
function saveSession(s) {
  const { safeStorage } = require('electron');
  session = s;
  if (!s) return fs.rmSync(tokenFile(), { force: true });
  const json = JSON.stringify(s);
  fs.writeFileSync(tokenFile(), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : Buffer.from(json));
}
function loadState() {
  if (syncState) return syncState;
  try {
    syncState = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    syncState = { events: {}, lastSync: null, count: 0, error: null };
  }
  return syncState;
}
function saveState(s) {
  syncState = s;
  try {
    fs.writeFileSync(stateFile(), JSON.stringify(s));
  } catch {}
}

async function call(method, url, body) {
  const google = require('./google.cjs');
  const { net } = require('electron');
  let s = loadSession();
  if (!s?.refresh_token) throw Object.assign(new Error('Connect Google Calendar first.'), { code: 'NO_ACCOUNT' });
  try {
    const r = await google.refreshed(s);
    if (r.access_token !== s.access_token) saveSession((s = { ...s, ...r }));
  } catch (err) {
    if (/invalid_grant|expired|revoked/i.test(String(err.message))) {
      saveSession(null);
      throw Object.assign(new Error('Your Google Calendar connection ended. Connect it again.'), { code: 'NO_ACCOUNT' });
    }
    throw err;
  }
  const res = await net.fetch(url.startsWith('http') ? url : API + url, { method, headers: { Authorization: `Bearer ${s.access_token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (res.status === 204) return null;
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(j.error?.message || `Google Calendar error ${res.status}`), { status: res.status });
  return j;
}

const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** The "Kea" calendar in the person's Google Calendar (made the first time, or again if they deleted it). */
async function ensureCalendar() {
  const s = loadSession();
  if (s.calendarId) {
    try {
      await call('GET', `/calendars/${encodeURIComponent(s.calendarId)}`);
      return s.calendarId;
    } catch (err) {
      if (err.status !== 404 && err.status !== 410) throw err;
    }
  }
  const c = await call('POST', '/calendars', { summary: 'Kea', description: 'Your Kea calendar: classes, assignments, work and personal events. Kea keeps it up to date; changes made here are replaced.', timeZone: timeZone() });
  saveSession({ ...loadSession(), calendarId: c.id });
  saveState({ events: {}, lastSync: null, count: 0, error: null });
  return c.id;
}

let running = null;
/** Bring the "Kea" calendar up to date with Kea's calendar (only what changed). */
function sync() {
  if (running) return running;
  running = (async () => {
    if (!loadSession()?.refresh_token) return status();
    const st = loadState();
    try {
      const cal = encodeURIComponent(await ensureCalendar());
      const list = await require('./calendarShare.cjs').events();
      const d = diff(loadState().events, list, timeZone());
      const done = { ...loadState().events };
      // (Bounded per run so a first sync of thousands of events spreads over a few runs instead of hitting Google's limits.)
      for (const g of d.upserts.slice(0, 400)) {
        try {
          await call('PUT', `/calendars/${cal}/events/${g.id}`, g);
        } catch (err) {
          if (err.status !== 404) throw err;
          await call('POST', `/calendars/${cal}/events`, g);
        }
        done[g.id] = d.next[g.id];
      }
      for (const id of d.deletes.slice(0, 400)) {
        await call('DELETE', `/calendars/${cal}/events/${id}`).catch((err) => {
          if (err.status !== 404 && err.status !== 410) throw err;
        });
        delete done[id];
      }
      saveState({ events: done, lastSync: new Date().toISOString(), count: Object.keys(done).length, error: null });
    } catch (err) {
      saveState({ ...st, error: err.code === 'NO_ACCOUNT' ? err.message : `Kea couldn’t update Google Calendar: ${err.message}` });
    }
    return status();
  })().finally(() => (running = null));
  return running;
}

function status() {
  const s = loadSession();
  const st = loadState();
  return { connected: !!s?.refresh_token, email: s?.email || null, lastSync: st.lastSync, count: st.count || 0, error: st.error || null };
}

async function connect() {
  const google = require('./google.cjs');
  const t = await google.authorize([SCOPE]);
  saveSession({ ...t, email: google.signedInEmail?.() || null });
  schedule();
  return sync();
}

/** Disconnect: the "Kea" calendar is removed from Google (it would only go out of date) and access is revoked. */
async function disconnect() {
  const s = loadSession();
  if (s?.calendarId) await call('DELETE', `/calendars/${encodeURIComponent(s.calendarId)}`).catch(() => {});
  if (s?.refresh_token) require('electron').net.fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(s.refresh_token)}`, { method: 'POST' }).catch(() => {});
  saveSession(null);
  saveState({ events: {}, lastSync: null, count: 0, error: null });
  schedule();
  return status();
}

let timer = null;
function schedule() {
  clearInterval(timer);
  timer = null;
  if (!loadSession()?.refresh_token) return;
  timer = setInterval(() => sync().catch(() => {}), 15 * 60_000);
  timer.unref?.();
}

function register() {
  const { ipcMain } = require('electron');
  const { handleApp } = require('./ipcGuard.cjs');
  const wrap = (fn) => async () => {
    try {
      return await fn();
    } catch (err) {
      throw new Error(`${err.code ? `[${err.code}] ` : ''}${err.message || err}`);
    }
  };
  handleApp(ipcMain, 'gcal:status', () => status());
  handleApp(ipcMain, 'gcal:connect', wrap(connect));
  handleApp(ipcMain, 'gcal:disconnect', wrap(disconnect));
  handleApp(ipcMain, 'gcal:sync', wrap(sync));
  schedule();
  if (loadSession()?.refresh_token) setTimeout(() => sync().catch(() => {}), 30_000).unref?.();
}

module.exports = { register, sync, status, _test: { gid, toGoogle, diff } };
