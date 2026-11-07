// Work mode: organizations on the Kea Hub (join codes, availability, schedules, certs, the to-do box).
// The page asks for Hub org routes through here, signed in with the same session as the rest of Kea (hub.cjs). Only
// org routes pass; payroll never goes to the Hub at all.
const { app, ipcMain, dialog, BrowserWindow, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const hub = require('./hub.cjs');
const { handleApp } = require('./ipcGuard.cjs');

// The routes the page may call, by method.
const ALLOWED = [
  /^\/v1\/orgs(\/|$|\?)/,
  /^\/v1\/orgs-calendar(\?|$)/,
  /^\/v1\/orgs-export$/,
  /^\/v1\/todo(\/snooze)?(\?|$)/,
  /^\/v1\/calendar(\?|$)/,
];
const ok = (p) => typeof p === 'string' && p.length < 2000 && !p.includes('..') && ALLOWED.some((re) => re.test(p));

const wrap = (fn) => async (_e, arg) => {
  try {
    return { ok: true, value: await fn(arg || {}) };
  } catch (e) {
    return { ok: false, error: String(e.message || e), status: e.status ?? null, data: e.data ?? null };
  }
};
const refuse = () => Object.assign(new Error('Kea can’t send that to the Hub.'), { status: 400 });

// Published shifts and org class sessions, kept on this PC so the calendar has them when the Hub is unreachable. The
// copy belongs to the account that fetched it: anyone else signed in here never sees it (hub.cjs also deletes it on
// signing out and when another account signs in).
const cacheFile = () => path.join(app.getPath('userData'), 'work-calendar.json');
const accountId = () => {
  try {
    return hub.cached?.()?.id ?? null;
  } catch {
    return null;
  }
};
function readCache() {
  try {
    const c = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
    if (!Array.isArray(c.events) || (c.account ?? null) !== accountId()) throw new Error('not this account’s');
    return c;
  } catch {
    return { events: [], at: 0 };
  }
}
/** Shifts and org class sessions between two times (ISO), from the Hub, or the copy on this PC when offline. */
async function events(from, to) {
  try {
    const q = new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) }).toString();
    const r = await hub.req('GET', `/v1/orgs-calendar${q ? `?${q}` : ''}`);
    // Keep what's known; replace the window just fetched.
    const old = readCache().events.filter((e) => (from && e.end < from) || (to && e.start > to));
    fs.writeFileSync(cacheFile(), JSON.stringify({ account: accountId(), events: [...old, ...r.events].sort((a, b) => (a.start < b.start ? -1 : 1)), at: Date.now() }));
    return { events: r.events, offline: false };
  } catch (e) {
    if (e.status !== 0) throw e;
    const c = readCache();
    return { events: c.events.filter((x) => (!from || x.end >= from) && (!to || x.start <= to)), offline: true, at: c.at };
  }
}

// iCalendar text for "Add to my calendar" (Outlook, Google Calendar, Apple Calendar all open .ics files).
const icsTime = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
// RFC 5545 TEXT: backslash, comma and semicolon escaped, any line break (CRLF, CR or LF) as \n, other control
// characters dropped, so nothing an org writes can start a new property or event.
const icsText = (s) =>
  String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .replace(/([,;])/g, '\\$1');
/** A meeting link for the URL property: https only, as the parsed address (no spaces or line breaks), else none. */
function icsUrl(s) {
  try {
    const u = new URL(String(s || '').trim());
    if (u.protocol !== 'https:' || /[\x00-\x20\x7f"\\]/.test(u.href)) return '';
    return u.href;
  } catch {
    return '';
  }
}
/** Lines longer than 75 octets folded (CRLF and a space), never inside a character. */
function icsFold(line) {
  const out = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}
function toIcs(list) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Kea//Work//EN', 'CALSCALE:GREGORIAN'];
  for (const e of list) {
    const url = icsUrl(e.meetingUrl);
    lines.push('BEGIN:VEVENT', `UID:${icsText(e.id)}@kea-work`, `DTSTAMP:${icsTime(new Date().toISOString())}`, `DTSTART:${icsTime(e.start)}`, `DTEND:${icsTime(e.end)}`,
      `SUMMARY:${icsText(`${e.title} (${e.orgName})`)}`, ...(e.location ? [`LOCATION:${icsText(e.location)}`] : []), ...(url ? [`URL:${url}`] : []), 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(icsFold).join('\r\n') + '\r\n';
}

async function saveAs(defaultName, filters, data) {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  const r = await dialog.showSaveDialog(win, { title: 'Save', defaultPath: path.join(app.getPath('documents'), defaultName.replace(/[\\/:*?"<>|]+/g, ' ')), filters });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, data);
  return r.filePath;
}

function register() {
  handleApp(ipcMain, 'hubOrg:call', wrap(async ({ method, path: p, body }) => {
    const m = String(method || 'GET').toUpperCase();
    if (!['GET', 'POST'].includes(m) || !ok(p)) throw refuse();
    return hub.req(m, p, m === 'POST' ? body ?? {} : undefined);
  }));
  // An availability form's answers as CSV (the Google-Sheets shape, or one row per date).
  handleApp(ipcMain, 'hubOrg:saveCsv', wrap(async ({ orgId, formId, format }) => {
    if (!/^[\w-]{1,80}$/.test(String(orgId)) || !/^[\w-]{1,80}$/.test(String(formId))) throw refuse();
    const r = await hub.req('GET', `/v1/orgs/${orgId}/forms/${formId}/export?as=json&format=${format === 'long' ? 'long' : 'sheets'}`);
    return saveAs(r.filename, [{ name: 'CSV', extensions: ['csv'] }], '\ufeff' + r.csv);
  }));
  handleApp(ipcMain, 'hubOrg:events', wrap(({ from, to }) => events(from, to)));
  handleApp(ipcMain, 'hubOrg:saveIcs', wrap(async ({ from, to }) => {
    const { events: list } = await events(from, to);
    if (!list.length) return null;
    return saveAs('Work schedule.ics', [{ name: 'Calendar', extensions: ['ics'] }], toIcs(list));
  }));
  handleApp(ipcMain, 'hubOrg:showFile', wrap(({ file }) => (file ? shell.showItemInFolder(String(file)) : null)));
}

const pad = (n) => String(n).padStart(2, '0');
const day = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
let lastRefresh = 0;
/**
 * Work mode's shifts and org class sessions as calendar items, for Kea's calendar beside classes. Read from the copy on
 * this PC so the calendar never waits on the Hub; the copy is refreshed in the background (at most every 10 minutes).
 */
function calendarItems({ from, to } = {}) {
  const settings = require('./settings.cjs');
  if (settings.get('modes.work', false) !== true || !hub.signedIn()) return [];
  if (Date.now() - lastRefresh > 10 * 60_000) {
    lastRefresh = Date.now();
    const a = new Date(Date.now() - 7 * 864e5).toISOString();
    const b = new Date(Date.now() + 60 * 864e5).toISOString();
    events(a, b)
      .then((r) => !r.offline && BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('scholar:changed')))
      .catch(() => {});
  }
  return readCache()
    .events.map((e) => {
      const s = new Date(e.start);
      const t = new Date(e.end);
      return {
        id: `work:${e.id}`,
        courseId: `work:${e.orgId}`,
        courseCode: e.orgName || 'Work',
        type: e.kind === 'class' ? 'class_session' : 'work_shift',
        title: e.title,
        date: day(s),
        dateEnd: day(new Date(t.getTime() - 1)) !== day(s) ? day(new Date(t.getTime() - 1)) : null,
        start: hm(s),
        end: hm(t),
        due: null,
        module: null,
        location: e.location || (e.meetingUrl ? 'Online' : null),
        locationUsual: false,
        instructor: null,
        contact: null,
        description: null,
        sourceWording: null,
        links: e.meetingUrl ? [{ label: 'Join the meeting', url: e.meetingUrl, kind: 'meeting' }] : [],
        weeklyLinks: [],
        covered: [],
        studyFocus: [],
        points: null,
        optional: false,
        tentative: false,
        done: null,
        handIn: null,
        readings: [],
      };
    })
    .filter((i) => i.date <= (to || '9999-99-99') && (i.dateEnd || i.date) >= (from || '0000-00-00'));
}

module.exports = { register, events, toIcs, calendarItems };
