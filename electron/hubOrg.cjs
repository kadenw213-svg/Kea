// Work mode: organizations (join codes, availability, schedules, certs, roles, the time clock, pay codes, the to-do
// box), on the Kea account server and on any KeaS servers this account joined (servers.cjs, signed in with a server
// pass). The Kea account server is an org server like any other whose session is the account session itself (hub.cjs),
// with no pass (protocol section 5, "Hosted organizations"); one that lists 'hostedOrgs' in /v1/health hosts orgs only
// from an approved application (POST /v1/apply), and an older one (Hub 0.5) makes them with POST /v1/orgs. The page
// calls org routes as if there were one server; each call goes to the server that holds that organization, and the
// lists (organizations, to-dos, the calendar) are put together from all of them. Only org routes and applications
// pass; payroll (the pay feed, SSNs, pay runs) never goes through here.
const { app, ipcMain, dialog, BrowserWindow, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const hub = require('./hub.cjs');
const { handleApp } = require('./ipcGuard.cjs');
const servers = () => require('./servers.cjs');

// ---------- which server holds what ----------
// 'hub' is the Kea account server; anything else is a joined server's id.
const HUB = 'hub';
const orgSource = new Map(); // org id -> source
const todoSource = new Map(); // to-do key -> source
const sourceInfo = new Map(); // source -> { id, name, url } (null for the Kea account server)
/** Where Work's organizations can be: the Kea account server when signed in online, and every joined server. */
function sources() {
  const out = [];
  if (hub.signedIn()) out.push(HUB);
  for (const s of servers().list()) {
    sourceInfo.set(s.serverId, { id: s.serverId, name: s.name, url: s.url });
    out.push(s.serverId);
  }
  return out;
}
const serverList = () => {
  try {
    return servers().list();
  } catch {
    return [];
  }
};
/**
 * What the Kea account server says it can do (GET /v1/health features), kept for 10 minutes. Offline: what it said
 * last (or nothing yet). An older server without the list answers [].
 */
let feats = { at: 0, list: null };
async function accountFeatures() {
  if (feats.list && Date.now() - feats.at < 10 * 60_000) return feats.list;
  try {
    const r = await hub.req('GET', '/v1/health', undefined, { auth: false });
    feats = { at: Date.now(), list: Array.isArray(r?.features) ? r.features.map(String) : [] };
  } catch (e) {
    if (e.status === 0) return feats.list ?? [];
    feats = { at: Date.now(), list: [] };
  }
  return feats.list;
}
/** What Work needs to know about the Kea account server: does it host orgs (made by application), take applications. */
async function accountInfo() {
  const f = await accountFeatures();
  return { hostedOrgs: f.includes('hostedOrgs'), applications: f.includes('applications') || f.includes('hostedOrgs') };
}
const send = (src, method, p, body) => (src === HUB ? hub.req(method, p, body) : servers().req(src, method, p, body));
/** Every source at once: [{ src, ok, value | error }]. */
const all = (method, p, body) => Promise.all(sources().map((src) => send(src, method, p, body).then((value) => ({ src, ok: true, value }), (error) => ({ src, ok: false, error }))));
/** The first error worth showing when nothing answered (offline over anything else, so the calendar falls back). */
function noneAnswered(results) {
  const errs = results.filter((r) => !r.ok).map((r) => r.error);
  return errs.find((e) => e.status !== 0) ?? errs[0] ?? Object.assign(new Error('Sign in to your Kea account to use Work.'), { status: 401 });
}
const sortTodo = (items) =>
  items.sort((a, b) => Number(!!b.overdue) - Number(!!a.overdue) || (b.urgency ?? 0) - (a.urgency ?? 0) || (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity));

/** My organizations on every server, each with the server it's on (null: the Kea account server). */
async function listOrgs() {
  const [res, account] = await Promise.all([all('GET', '/v1/orgs'), hub.signedIn() ? accountInfo().catch(() => null) : null]);
  const orgs = [];
  for (const r of res) {
    if (!r.ok) continue;
    for (const o of r.value.orgs || []) {
      orgSource.set(o.id, r.src);
      // (hosted: on the Kea account server, signed in with the account itself.)
      orgs.push({ ...o, server: r.src === HUB ? null : sourceInfo.get(r.src) ?? { id: r.src }, ...(r.src === HUB && account?.hostedOrgs ? { hosted: true } : {}) });
    }
  }
  // (A Kea account server without organizations answers 404: that's simply none.)
  const failed = res.filter((r) => !r.ok && !(r.src === HUB && r.error.status === 404));
  if (!orgs.length && failed.length && failed.length === res.length) throw noneAnswered(res);
  const by = new Map(serverList().map((s) => [s.serverId, s]));
  return {
    orgs,
    account,
    servers: [...by.values()].map((s) => {
      const r = res.find((x) => x.src === s.serverId);
      return { ...s, offline: !!r && !r.ok && r.error.status === 0, signedOut: s.signedOut || (!!r && !r.ok && !!r.error.data?.signedOut), error: r && !r.ok && r.error.status !== 0 ? r.error.message : null };
    }),
  };
}
/** The server holding an organization (looked up again from the lists when Kea doesn't know it yet). */
async function sourceOf(orgId) {
  if (!orgSource.has(orgId)) await listOrgs().catch(() => null);
  return orgSource.get(orgId) ?? HUB;
}
async function todo() {
  const res = await all('GET', '/v1/todo');
  if (!res.some((r) => r.ok)) throw noneAnswered(res);
  const out = { now: Date.now(), items: [], snoozed: [] };
  for (const r of res.filter((x) => x.ok)) {
    for (const it of [...(r.value.items || []), ...(r.value.snoozed || [])]) todoSource.set(it.key, r.src);
    out.items.push(...(r.value.items || []));
    out.snoozed.push(...(r.value.snoozed || []));
    out.now = r.value.now ?? out.now;
  }
  sortTodo(out.items);
  return out;
}
/** One org route, sent to the server that holds it. */
async function route(m, p, body) {
  const orgId = /^\/v1\/orgs\/([^/?]+)/.exec(p)?.[1];
  if (m === 'GET' && /^\/v1\/orgs(\?|$)/.test(p)) return listOrgs();
  if (m === 'GET' && /^\/v1\/todo(\?|$)/.test(p)) return todo();
  if (m === 'POST' && p === '/v1/todo/snooze') return send(todoSource.get(body?.key) ?? HUB, m, p, body);
  // Joining with a plain code, making an organization (an older account server) and applications (to host an
  // organization or list classes): on the Kea account server. A join link goes through servers:join instead.
  if (orgId && !['join'].includes(orgId)) return send(await sourceOf(decodeURIComponent(orgId)), m, p, body);
  return send(HUB, m, p, body);
}

// The routes the page may call, by method.
const ALLOWED = [
  /^\/v1\/orgs(\/|$|\?)/,
  /^\/v1\/orgs-calendar(\?|$)/,
  /^\/v1\/orgs-export$/,
  /^\/v1\/todo(\/snooze)?(\?|$)/,
  /^\/v1\/calendar(\?|$)/,
  /^\/v1\/apply$/,
];
// (The pay feed is for the payroll vault, never for Kea.)
const PAYROLL = /^\/v1\/orgs\/[^/?]+\/pay-feed(\?|$)/;
const ok = (p) => typeof p === 'string' && p.length < 2000 && !p.includes('..') && ALLOWED.some((re) => re.test(p)) && !PAYROLL.test(p);

const wrap = (fn) => async (_e, arg) => {
  try {
    return { ok: true, value: await fn(arg || {}) };
  } catch (e) {
    return { ok: false, error: String(e.message || e), status: e.status ?? null, data: e.data ?? null };
  }
};
const refuse = () => Object.assign(new Error('Kea can’t send that to an organization’s server.'), { status: 400 });

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
    const res = await all('GET', `/v1/orgs-calendar${q ? `?${q}` : ''}`);
    if (!res.some((x) => x.ok)) throw noneAnswered(res);
    const r = { events: res.filter((x) => x.ok).flatMap((x) => (x.value.events || []).map((e) => ({ ...e, source: x.src }))) };
    // Keep what's known; replace the window just fetched (a server that didn't answer keeps its copy).
    const missed = new Set(res.filter((x) => !x.ok).map((x) => x.src));
    const old = readCache().events.filter((e) => (from && e.end < from) || (to && e.start > to) || missed.has(e.source ?? HUB));
    const kept = old.filter((e) => missed.has(e.source ?? HUB) && (!from || e.end >= from) && (!to || e.start <= to));
    fs.writeFileSync(cacheFile(), JSON.stringify({ account: accountId(), events: [...old, ...r.events].sort((a, b) => (a.start < b.start ? -1 : 1)), at: Date.now() }));
    return { events: [...r.events, ...kept].sort((a, b) => (a.start < b.start ? -1 : 1)), offline: false, ...(kept.length || missed.size ? { partial: true } : {}) };
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
    return route(m, p, m === 'POST' ? body ?? {} : undefined);
  }));
  // An availability form's answers as CSV (the Google-Sheets shape, or one row per date).
  handleApp(ipcMain, 'hubOrg:saveCsv', wrap(async ({ orgId, formId, format }) => {
    if (!/^[\w-]{1,80}$/.test(String(orgId)) || !/^[\w-]{1,80}$/.test(String(formId))) throw refuse();
    const r = await send(await sourceOf(orgId), 'GET', `/v1/orgs/${orgId}/forms/${formId}/export?as=json&format=${format === 'long' ? 'long' : 'sheets'}`);
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
  if (settings.get('modes.work', false) !== true || !sources().length) return [];
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

module.exports = { register, events, toIcs, calendarItems, route, listOrgs, accountInfo, _resetFeatures: () => (feats = { at: 0, list: null }) };
