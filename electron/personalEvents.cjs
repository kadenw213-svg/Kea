// Personal events on the Kea calendar ("Add to Kea calendar"): birthdays, appointments, personal deadlines, bills,
// recertifications, anything outside class or work. They can repeat (every week, month, year, or every few years) and
// remind ahead of time. Kept on this computer in personal-events.json; they show beside classes and work on the
// Calendar, in the calendar link and in Google Calendar sync like everything else.
const fs = require('node:fs');
const path = require('node:path');

const DAY = 864e5;
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s) => {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, m - 1, d);
};
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;
const REPEATS = new Set(['none', 'weekly', 'monthly', 'yearly', 'years']);

/** A saved event, cleaned: what the form sent, with nothing the calendar can't show. Throws a plain sentence. */
function clean(e, now = new Date()) {
  const title = String(e?.title || '').trim().slice(0, 200);
  if (!title) throw new Error('Give the event a name.');
  if (!DATE.test(String(e.date || ''))) throw new Error('Choose a date.');
  const allDay = e.allDay !== false || !TIME.test(String(e.start || ''));
  const repeat = REPEATS.has(e.repeat) ? e.repeat : 'none';
  const every = repeat === 'years' ? Math.max(2, Math.min(20, Math.round(Number(e.every) || 2))) : 1;
  const remind = (Array.isArray(e.remind) ? e.remind : [])
    .map(Number)
    .filter((m) => Number.isFinite(m) && m >= 0 && m <= 365 * 24 * 60)
    .slice(0, 3);
  return {
    id: String(e.id || `p${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`).replace(/[^\w-]/g, '').slice(0, 40),
    title,
    date: e.date,
    allDay,
    ...(allDay ? {} : { start: e.start, ...(TIME.test(String(e.end || '')) && e.end > e.start ? { end: e.end } : {}) }),
    repeat,
    ...(repeat === 'years' ? { every } : {}),
    ...(DATE.test(String(e.until || '')) && e.until >= e.date ? { until: e.until } : {}),
    remind,
    ...(String(e.notes || '').trim() ? { notes: String(e.notes).trim().slice(0, 2000) } : {}),
    ...(String(e.location || '').trim() ? { location: String(e.location).trim().slice(0, 200) } : {})
  };
}

/** The dates an event falls on between `from` and `to` (YYYY-MM-DD, both included), at most 400. */
function occurrences(e, from, to) {
  const out = [];
  const first = parse(e.date);
  const end = e.until && e.until < to ? e.until : to;
  if (e.date > end) return out;
  const step = (d, n) => {
    if (e.repeat === 'weekly') return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7 * n);
    // (Monthly on the 31st falls on the last day of shorter months; yearly on Feb 29 falls on Feb 28.)
    const months = e.repeat === 'monthly' ? n : e.repeat === 'yearly' ? 12 * n : e.repeat === 'years' ? 12 * (e.every || 2) * n : 0;
    const y = first.getFullYear() + Math.floor((first.getMonth() + months) / 12);
    const m = (first.getMonth() + months) % 12;
    const last = new Date(y, m + 1, 0).getDate();
    return new Date(y, m, Math.min(first.getDate(), last));
  };
  if (e.repeat === 'none') return e.date >= from && e.date <= end ? [e.date] : [];
  // Jump close to `from` instead of walking from the first date (a birthday from 1990).
  let n = 0;
  if (e.date < from) {
    const gap = (parse(from).getTime() - first.getTime()) / DAY;
    const per = e.repeat === 'weekly' ? 7 : e.repeat === 'monthly' ? 28 : e.repeat === 'yearly' ? 365 : 365 * (e.every || 2);
    n = Math.max(0, Math.floor(gap / per) - 1);
  }
  for (let i = 0; i < 2000 && out.length < 400; i++, n++) {
    const d = ymd(step(first, n));
    if (d > end) break;
    if (d >= from) out.push(d);
  }
  return out;
}

/** The events between two dates as Calendar items (the shape db.items gives), one per occurrence. */
function toItems(list, from, to) {
  const items = [];
  for (const e of list || [])
    for (const d of occurrences(e, from, to))
      items.push({
        id: `personal:${e.id}:${d}`,
        personalId: e.id,
        courseId: 'personal',
        courseCode: 'Personal',
        type: 'personal',
        title: e.title,
        date: d,
        dateEnd: null,
        start: e.allDay ? null : e.start,
        end: e.allDay ? null : e.end || null,
        due: null,
        module: null,
        location: e.location || null,
        locationUsual: false,
        instructor: null,
        contact: null,
        description: e.notes || null,
        sourceWording: null,
        links: [],
        weeklyLinks: [],
        covered: [],
        studyFocus: [],
        points: null,
        optional: true,
        repeat: e.repeat
      });
  return items;
}

/** Reminders that are due now: [{ key, event, date, minutes }] for occurrences whose reminder time has passed in the last `window` ms and isn't in `sent`. */
function dueReminders(list, sent, now = new Date(), window = 36 * 3600e3) {
  const out = [];
  const t = now.getTime();
  const from = ymd(new Date(t - 2 * DAY));
  const to = ymd(new Date(t + 366 * DAY));
  for (const e of list || [])
    for (const m of e.remind || [])
      for (const d of occurrences(e, from, to)) {
        const [h, mi] = e.allDay ? [9, 0] : String(e.start).split(':').map(Number);
        const at = parse(d);
        at.setHours(h, mi, 0, 0);
        const fire = at.getTime() - m * 60e3;
        const key = `${e.id}:${d}:${m}`;
        if (fire <= t && t - fire < window && !sent.has(key)) out.push({ key, event: e, date: d, minutes: m });
      }
  return out;
}

// ---------- Storage and the app (Electron) ----------
const file = () => path.join(require('electron').app.getPath('userData'), 'personal-events.json');
function read() {
  try {
    const v = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return { events: Array.isArray(v.events) ? v.events : [], sent: Array.isArray(v.sent) ? v.sent : [] };
  } catch {
    return { events: [], sent: [] };
  }
}
const write = (v) => fs.writeFileSync(file(), JSON.stringify({ events: v.events, sent: v.sent.slice(-2000) }, null, 1));
const changed = () => require('electron').BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('scholar:changed'));

function calendarItems({ from, to } = {}) {
  if (!DATE.test(String(from || '')) || !DATE.test(String(to || ''))) return [];
  return toItems(read().events, from, to);
}

let timer = null;
function checkReminders() {
  const v = read();
  const due = dueReminders(v.events, new Set(v.sent));
  if (!due.length) return;
  const { Notification } = require('electron');
  for (const r of due) {
    const when = new Date(`${r.date}T12:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const time = r.event.allDay ? '' : ` at ${r.event.start}`;
    if (Notification.isSupported()) new Notification({ title: r.event.title, body: r.minutes === 0 ? `Now${time ? ` (${r.event.start})` : ''}` : `${when}${time}` }).show();
    v.sent.push(r.key);
  }
  write(v);
}

function register() {
  const { ipcMain } = require('electron');
  const { handleApp } = require('./ipcGuard.cjs');
  handleApp(ipcMain, 'personal:list', () => read().events);
  handleApp(ipcMain, 'personal:save', (_e, ev) => {
    const v = read();
    const e = clean(ev);
    v.events = [...v.events.filter((x) => x.id !== e.id), e];
    write(v);
    changed();
    return e;
  });
  handleApp(ipcMain, 'personal:delete', (_e, id) => {
    const v = read();
    v.events = v.events.filter((x) => x.id !== String(id));
    write(v);
    changed();
    return true;
  });
  clearInterval(timer);
  timer = setInterval(() => {
    try {
      checkReminders();
    } catch {}
  }, 60_000);
  timer.unref?.();
  setTimeout(() => {
    try {
      checkReminders();
    } catch {}
  }, 15_000).unref?.();
}

module.exports = { register, calendarItems, read, _test: { clean, occurrences, toItems, dueReminders } };
