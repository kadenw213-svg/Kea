// Share the Kea calendar to Google Calendar (or Apple, Outlook): a private link they subscribe to.
// The person turns it on in Calendar; Kea sends its calendar (the same items the Calendar screen shows) to the Kea
// account server (KeaC, docs/protocol.md "Calendar link"), which serves it at the link as an .ics file. Off by default;
// turning it off deletes the copy on the server. The link is kept on this computer so it can be copied again.
const { app, ipcMain, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { handleApp } = require('./ipcGuard.cjs');

const DAY = 864e5;
const file = () => path.join(app.getPath('userData'), 'calendar-share.json');
const load = () => {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8')) || {};
  } catch {
    return {};
  }
};
const save = (s) => {
  try {
    fs.writeFileSync(file(), JSON.stringify(s));
  } catch {}
};

// The Calendar screen's items for a range ({ from, to } as YYYY-MM-DD): set by scholar/index.cjs.
let provider = async () => [];
const setProvider = (fn) => void (provider = fn);

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** "2026-11-20" and "23:59" on this computer's clock, as a UTC instant ("2026-11-21T06:59:00Z"). */
const instant = (date, hm) => {
  const [y, m, d] = String(date).split('-').map(Number);
  const [h, mi] = String(hm).split(':').map(Number);
  const t = new Date(y, m - 1, d, h, mi, 0, 0);
  return Number.isFinite(t.getTime()) ? t.toISOString().replace(/\.\d{3}Z$/, 'Z') : null;
};
const TYPE_NAME = {
  assignment: 'Assignment', exam: 'Exam', final_exam: 'Exam', quiz: 'Quiz', discussion: 'Discussion', lab: 'Lab', lab_practical: 'Lab', project: 'Project',
  paper: 'Paper', draft: 'Draft', presentation: 'Presentation', class_session: 'Class', work_shift: 'Work', lecture: 'Class', recitation: 'Class',
};

/** One Calendar item as an event for the feed (docs/protocol.md), or null when it can't be one. */
function toEvent(it) {
  if (!it || !it.id || !it.title || !/^\d{4}-\d{2}-\d{2}$/.test(String(it.date || ''))) return null;
  if (it.done || it.withdrawn) return null;
  const code = it.courseCode && !String(it.title).toLowerCase().includes(String(it.courseCode).toLowerCase()) ? `${it.courseCode}: ` : '';
  const url = (it.links || []).map((l) => l?.url).find((u) => /^https:\/\//i.test(String(u || '')));
  const notes = String(it.description || '').replace(/\s+/g, ' ').trim().slice(0, 400);
  const base = {
    id: String(it.id).replace(/[^\w.:@+-]/g, '_').slice(0, 120),
    title: `${code}${it.title}`.slice(0, 200),
    ...(it.location ? { location: String(it.location).slice(0, 200) } : {}),
    ...(url ? { url } : {}),
    ...(notes ? { notes } : {}),
    ...(TYPE_NAME[it.type] ? { kind: TYPE_NAME[it.type] } : {}),
  };
  const at = it.start || it.due;
  if (at) {
    const start = instant(it.date, at);
    // A meeting has its end; work due at a time is a point in time (the feed gives it 30 minutes).
    const end = it.start && it.end ? instant(it.dateEnd && it.dateEnd > it.date ? it.dateEnd : it.date, it.end) : null;
    if (!start) return null;
    return { ...base, start, ...(end && Date.parse(end) >= Date.parse(start) ? { end } : {}) };
  }
  return { ...base, allDay: true, start: it.date, ...(it.dateEnd && it.dateEnd > it.date ? { end: it.dateEnd } : {}) };
}

/** What the Calendar shows from a week ago to six months ahead, as feed events (de-duplicated, at most 3,000). */
async function events() {
  const from = ymd(new Date(Date.now() - 7 * DAY));
  const to = ymd(new Date(Date.now() + 180 * DAY));
  const items = await provider({ from, to });
  const seen = new Set();
  const out = [];
  for (const it of items || []) {
    const e = toEvent(it);
    if (e && !seen.has(e.id)) {
      seen.add(e.id);
      out.push(e);
    }
  }
  return out.slice(0, 3000);
}

const hub = () => require('./hub.cjs');
const NEEDS_UPDATE = 'Your Kea account server needs to update before it can share your calendar. It updates itself; try again in a few minutes.';
/** Turns a failed request into a sentence for the person. */
const explain = (err) => {
  if (err?.status === 404) return NEEDS_UPDATE;
  if (err?.status === 401) return 'Sign in to your Kea account online first (Settings, Kea account).';
  return err?.message || 'Kea couldn’t reach your account server.';
};

let timer = null;
let pushing = null;
let lastHash = '';
let lastAt = 0;

/** Sends the calendar now (only when it changed, or it has been six hours). Returns the new status. */
async function push({ force = false } = {}) {
  if (pushing) return pushing;
  pushing = (async () => {
    const s = load();
    if (!s.enabled) return status();
    try {
      const list = await events();
      const hash = crypto.createHash('sha256').update(JSON.stringify(list)).digest('hex');
      if (force || hash !== lastHash || Date.now() - lastAt > 6 * 3600_000) {
        const r = await hub().req('POST', '/v1/calendar/feed/events', { events: list });
        lastHash = hash;
        lastAt = Date.now();
        save({ ...load(), count: r.count ?? list.length, updatedAt: r.updatedAt ?? Date.now(), error: null });
      }
    } catch (err) {
      save({ ...load(), error: explain(err) });
    }
    return status();
  })().finally(() => (pushing = null));
  return pushing;
}

function schedule() {
  clearInterval(timer);
  timer = null;
  if (!load().enabled) return;
  timer = setInterval(() => push().catch(() => {}), 15 * 60_000);
  timer.unref?.();
}

function status() {
  const s = load();
  return { enabled: !!s.enabled, url: s.url || null, count: s.count || 0, updatedAt: s.updatedAt || null, error: s.error || null, signedIn: !!hub().signedIn() };
}

/** Turn sharing on (or make a new link, which stops the old one). */
async function turnOn() {
  try {
    const r = await hub().req('POST', '/v1/calendar/feed');
    lastHash = '';
    save({ enabled: true, url: r.url, count: r.count || 0, updatedAt: r.updatedAt || null, error: null });
    schedule();
    await push({ force: true });
  } catch (err) {
    save({ ...load(), error: explain(err) });
    throw new Error(explain(err));
  }
  return status();
}

/** Turn sharing off: the server deletes its copy and the link stops working. */
async function turnOff() {
  try {
    await hub().req('DELETE', '/v1/calendar/feed');
  } catch (err) {
    // (Already off on the server, or an older server that never had it: nothing to delete.)
    if (err?.status && err.status !== 404) throw new Error(explain(err));
    if (!err?.status) throw new Error(explain(err));
  }
  save({});
  schedule();
  return status();
}

function register() {
  handleApp(ipcMain, 'calendarShare:status', async () => {
    const s = load();
    if (s.enabled && hub().signedIn()) {
      try {
        const r = await hub().req('GET', '/v1/calendar/feed');
        // (Turned off elsewhere, or the account changed: this computer forgets the link.)
        if (!r.enabled) save({});
        else save({ ...load(), count: r.count, updatedAt: r.updatedAt });
      } catch {}
    }
    schedule();
    return status();
  });
  handleApp(ipcMain, 'calendarShare:on', () => turnOn());
  handleApp(ipcMain, 'calendarShare:off', () => turnOff());
  handleApp(ipcMain, 'calendarShare:now', () => push({ force: true }));
  // Kea started with sharing on: keep the copy fresh from the first minutes.
  if (load().enabled) {
    schedule();
    setTimeout(() => push().catch(() => {}), 60_000).unref?.();
  }
}

module.exports = { register, setProvider, status, push, turnOn, turnOff, toEvent, events, _test: { instant } };
