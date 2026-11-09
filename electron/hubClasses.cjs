// Kea Hub classes in Kea: joining with a code or link, the class pages, instructor tools, Hub study sets and
// leaderboards, and the class sessions on Kea's calendar with reminders.
//
// Everything goes through hub.cjs (the session token never reaches the page). What Kea last saw is kept in
// userData/hub-classes.json, so My classes, a class page and the calendar still show when the Hub is offline (the
// owner's PC asleep or updating); the page is told it's offline and changes wait until the Hub is back.
const { app, ipcMain, BrowserWindow, Notification } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const settings = require('./settings.cjs');
const { handleApp } = require('./ipcGuard.cjs');

const DAY = 86400_000;
// Invite codes use these letters only (no 0/O/1/I/L), 10 of them; the Hub's /join/<code> page is the invite link.
const CODE_ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

// ---------- Pure helpers (tested in test/hubclasses) ----------

/** The invite code in what someone pasted: the code (any case, with dashes or spaces) or an invite link. */
function parseInvite(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  let raw = s;
  const link = /\/join\/([A-Za-z0-9 -]{10,20})(?:[/?#]|$)/.exec(s) || /[?&]code=([A-Za-z0-9-]{10,20})/.exec(s);
  if (link) raw = link[1];
  else if (/^[a-z]+:\/\//i.test(s)) return null;
  const code = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 10 || [...code].some((c) => !CODE_ALPHA.includes(c))) return null;
  return code;
}

/** The link to share for a code: the Hub's own page that explains how to join in Kea. */
const inviteLink = (base, code) => `${String(base).replace(/\/+$/, '')}/join/${code}`;

/** A fresh Jitsi Meet room (free, no account): the class name plus random letters so strangers can't guess it. */
function jitsiLink(title, rand = crypto.randomBytes(6).toString('hex')) {
  const slug = String(title || 'Class')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 5)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('')
    .slice(0, 40);
  return `https://meet.jit.si/Kea${slug || 'Class'}${rand}`;
}

const pad = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** A Hub class session as an item on Kea's calendar (the same shape as a class-site item). */
function sessionItem(s) {
  const a = new Date(s.start);
  const b = new Date(s.end);
  const endDate = localDate(new Date(b.getTime() - 1));
  return {
    id: `hub:${s.id}`,
    courseId: `hub:${s.classId}`,
    courseCode: s.classTitle || 'Class',
    type: 'class_session',
    title: s.title,
    date: localDate(a),
    dateEnd: endDate !== localDate(a) ? endDate : null,
    start: localTime(a),
    end: localTime(b),
    due: null,
    module: null,
    location: s.location || (s.meetingUrl ? 'Online' : null),
    locationUsual: false,
    instructor: null,
    contact: null,
    description: s.notes || null,
    sourceWording: null,
    links: s.meetingUrl ? [{ label: 'Join the meeting', url: s.meetingUrl, kind: 'meeting' }] : [],
    weeklyLinks: [],
    covered: [],
    studyFocus: [],
    points: null,
    optional: false,
    tentative: false,
    done: null,
    handIn: null,
    readings: [],
    hub: { classId: s.classId, sessionId: s.id, meetingUrl: s.meetingUrl || null, startAt: s.start, endAt: s.end },
  };
}

/** The sessions on the calendar between two dates (YYYY-MM-DD, inclusive), as items. */
function itemsBetween(sessions, from, to, classId) {
  return (sessions || [])
    .filter((s) => !classId || `hub:${s.classId}` === classId)
    .map(sessionItem)
    .filter((i) => i.date <= to && (i.dateEnd || i.date) >= from);
}

/** Sessions starting within `minutes` that haven't been announced yet. A moved session is announced again. */
function dueReminders(sessions, nowMs, minutes, notified = {}) {
  if (!(minutes > 0)) return [];
  return (sessions || []).filter((s) => {
    const t = Date.parse(s.start);
    return t > nowMs && t - nowMs <= minutes * 60_000 && !notified[`${s.id}@${s.start}`];
  });
}

/**
 * A Kea study set (practice exam or flashcards) as Hub questions: one right answer out of 2 to 8 choices.
 * Multiple choice and true/false carry over as they are. A flashcard becomes "front → which is right?" with up to three
 * other cards' backs as the wrong answers. Kinds the Hub can't grade by choice (select-all, typed answers, matching)
 * are skipped and counted.
 */
function toHubQuestions(set, rand = Math.random) {
  const out = [];
  let skipped = 0;
  const clip = (s, n) => String(s ?? '').trim().slice(0, n);
  for (const q of set?.questions || []) {
    if (q.type === 'mc' && Array.isArray(q.choices) && q.choices.length >= 2 && q.choices.length <= 8 && Number.isInteger(q.answer)) {
      out.push({ q: clip(q.q, 2000), choices: q.choices.map((c) => clip(c, 500)), answer: q.answer, why: clip(q.explain, 2000) || undefined });
    } else if (q.type === 'tf') {
      out.push({ q: clip(q.q, 2000), choices: ['True', 'False'], answer: q.answer ? 0 : 1, why: clip(q.explain, 2000) || undefined });
    } else skipped++;
  }
  const cards = (set?.cards || []).filter((c) => c.front && c.back && !c.image);
  skipped += (set?.cards || []).length - cards.length;
  const backs = [...new Set(cards.map((c) => clip(c.back, 500)))];
  for (const c of cards) {
    const right = clip(c.back, 500);
    // A card made from a question keeps its own wrong answers.
    let wrong = Array.isArray(c.choices) && !c.multi ? c.choices.map((x) => clip(x, 500)).filter((x) => x && x !== right) : [];
    if (!wrong.length) {
      const pool = backs.filter((b) => b !== right);
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      wrong = pool.slice(0, 3);
    }
    wrong = wrong.slice(0, 7);
    if (!wrong.length) {
      skipped++;
      continue;
    }
    const at = Math.floor(rand() * (wrong.length + 1));
    const choices = [...wrong.slice(0, at), right, ...wrong.slice(at)];
    out.push({ q: clip(c.front, 2000), choices, answer: at, why: clip(c.explain, 2000) || undefined });
  }
  return { questions: out.slice(0, 500), skipped: skipped + Math.max(0, out.length - 500) };
}

// ---------- What Kea last saw (per account) ----------
const storeFile = () => path.join(app.getPath('userData'), 'hub-classes.json');
let store = null;
function load() {
  if (store) return store;
  try {
    store = JSON.parse(fs.readFileSync(storeFile(), 'utf8')) || {};
  } catch {
    store = {};
  }
  return store;
}
function save() {
  try {
    fs.writeFileSync(storeFile() + '.tmp', JSON.stringify(store));
    fs.renameSync(storeFile() + '.tmp', storeFile());
  } catch {}
}
/** The store for the account signed in now; another account (or none) starts empty. */
function mine() {
  const hub = require('./hub.cjs');
  const id = hub.cached()?.id || null;
  const s = load();
  if (s.account !== id) {
    store = { account: id, classes: null, details: {}, boards: {}, calendar: null, notified: s.notified || {} };
    save();
  }
  return store;
}

class OfflineError extends Error {}
/** Ask the Hub; when it can't be reached, use what Kea last saw (marked offline), or say plainly it's offline. */
async function live(key, fn, put) {
  const s = mine();
  try {
    const v = await fn();
    put ? put(s, v) : (s[key] = v);
    save();
    return { ...v, offline: false };
  } catch (e) {
    if (e.status !== 0) throw e;
    const was = typeof key === 'function' ? key(s) : s[key];
    if (was) return { ...was, offline: true };
    throw new OfflineError("Can’t reach the Kea account server right now. Try again in a bit.");
  }
}

function broadcast(channel, ...args) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, ...args);
}

// ---------- Calendar and reminders ----------
// School mode (src/lib/modes.ts): until "How do you use Kea?" is answered, School is on unless Scholar was turned off.
const schoolOn = () => (settings.get('modes.asked', false) === true ? settings.get('modes.school', false) === true : settings.get('scholar.enabled', true) !== false);
let calTimer = null;
async function syncCalendar() {
  const hub = require('./hub.cjs');
  if (!hub.signedIn()) return null;
  const s = mine();
  const from = new Date(Date.now() - 45 * DAY).toISOString();
  const to = new Date(Date.now() + 180 * DAY).toISOString();
  try {
    const r = await hub.req('GET', `/v1/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    const before = JSON.stringify(s.calendar?.sessions || []);
    s.calendar = { sessions: r.sessions, at: Date.now() };
    save();
    // The calendar reads them with the class-site items: tell it to read again.
    if (JSON.stringify(r.sessions) !== before) broadcast('scholar:changed');
    return s.calendar;
  } catch {
    return s.calendar;
  }
}
function syncSoon(ms = 500) {
  clearTimeout(calTimer);
  calTimer = setTimeout(() => syncCalendar().finally(() => syncSoon(10 * 60_000)), ms);
}
/** Items for the calendar (scholar:items adds these to the class-site ones). Empty when School is off. */
function calendarItems({ from, to, courseId } = {}) {
  if (!schoolOn() || settings.get('hub.onCalendar', true) === false) return [];
  if (courseId && !String(courseId).startsWith('hub:')) return [];
  const sessions = mine().calendar?.sessions || [];
  return itemsBetween(sessions, from || '0000-00-00', to || '9999-99-99', courseId);
}

const notes = [];
function remindTick() {
  const minutes = Number(settings.get('hub.remindMinutes', 15));
  if (!schoolOn() || !Notification.isSupported()) return;
  const s = mine();
  const due = dueReminders(s.calendar?.sessions, Date.now(), minutes, s.notified);
  if (!due.length) return;
  const notify = require('./scholar/notify.cjs');
  for (const x of due) {
    s.notified[`${x.id}@${x.start}`] = Date.now();
    const at = new Date(x.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const note = new Notification({
      title: `${x.classTitle}: ${x.title}`,
      body: `Starts at ${at}${x.location ? ` · ${x.location}` : ''}${x.meetingUrl ? '\nClick to open the class and its meeting link.' : ''}`,
      silent: notify.silent(),
    });
    note.on('click', () => {
      const w = BrowserWindow.getAllWindows()[0];
      if (w) {
        if (w.isMinimized()) w.restore();
        w.focus();
        w.webContents.send('hubc:open', x.classId);
      }
    });
    note.show();
    notes.push(note);
    notes.splice(0, Math.max(0, notes.length - 20));
  }
  // Forget reminders older than two weeks.
  for (const [k, t] of Object.entries(s.notified)) if (Date.now() - t > 14 * DAY) delete s.notified[k];
  save();
}

// ---------- The calls the page makes ----------
const enc = encodeURIComponent;
async function classDetail(id) {
  const hub = require('./hub.cjs');
  return live(
    (s) => s.details[id],
    async () => {
      const [c, members, sessions, sets] = await Promise.all([
        hub.req('GET', `/v1/classes/${enc(id)}`),
        hub.req('GET', `/v1/classes/${enc(id)}/members`),
        hub.req('GET', `/v1/classes/${enc(id)}/sessions`),
        hub.req('GET', `/v1/classes/${enc(id)}/sets`),
      ]);
      const teacher = ['instructor', 'ta'].includes(c.class.role);
      const invites = teacher ? (await hub.req('GET', `/v1/classes/${enc(id)}/invites`)).invites : [];
      return { class: c.class, progress: c.progress, members: members.members, sessions: sessions.sessions, sets: sets.sets, invites, inviteBase: inviteLink(hub.url(), '') };
    },
    (s, v) => (s.details[id] = v)
  );
}

/** Kea's own study sets that can become Hub sets, newest first, with how many of their questions carry over. */
function importable() {
  const study = require('./scholar/study.cjs');
  return study
    .list()
    .filter((x) => x.status === 'ready' && x.count > 0)
    .map((x) => ({ id: x.id, title: x.title, kind: x.kind, courseCode: x.courseCode, count: x.count, createdAt: x.createdAt }));
}
function importSet(id) {
  const study = require('./scholar/study.cjs');
  const set = study.get(id);
  if (!set) throw new Error('That set is gone.');
  return { title: set.title, ...toHubQuestions(set) };
}

const wrap = (fn) => async (_e, arg) => {
  try {
    return { ok: true, value: await fn(arg || {}) };
  } catch (e) {
    return { ok: false, error: String(e.message || e), status: e instanceof OfflineError ? 0 : e.status ?? null, data: e.data ?? null };
  }
};

function register() {
  const hub = require('./hub.cjs');
  const R = (name, fn) => handleApp(ipcMain, `hubc:${name}`, wrap(fn));
  /** After a change the calendar shows: read the calendar again now. */
  const changed = (v) => (syncSoon(300), broadcast('hubc:changed'), v);

  R('classes', () => live('classes', () => hub.req('GET', '/v1/classes')));
  R('class', ({ id }) => classDetail(String(id)));
  R('preview', async ({ text }) => {
    const code = parseInvite(text);
    if (!code) throw new Error('That isn’t a class code or invite link. A code is 10 letters and numbers.');
    return { code, ...(await hub.req('GET', `/v1/invites/${code}`)) };
  });
  R('join', async ({ code }) => changed(await hub.req('POST', '/v1/join', { code: parseInvite(code) || code })));
  R('leave', async ({ id }) => {
    const r = await hub.req('POST', `/v1/classes/${enc(id)}/leave`, {});
    const s = mine();
    delete s.details[id];
    if (s.classes) s.classes.classes = s.classes.classes.filter((c) => c.id !== id);
    save();
    return changed(r);
  });
  R('setMine', ({ id, board, nickname }) => hub.req('POST', `/v1/classes/${enc(id)}/me`, { board, ...(nickname !== undefined ? { nickname } : {}) }));
  R('create', async (a) => changed(await hub.req('POST', '/v1/classes', { title: a.title, description: a.description || '', meetingUrl: a.meetingUrl || null })));
  R('update', async ({ id, ...patch }) => changed(await hub.req('POST', `/v1/classes/${enc(id)}`, patch)));
  R('invite', async ({ id, role, maxUses, expiresDays }) => {
    const r = await hub.req('POST', `/v1/classes/${enc(id)}/invites`, { role: role || 'student', maxUses: maxUses || undefined, expiresDays: expiresDays || undefined });
    return { ...r, link: inviteLink(hub.url(), r.code) };
  });
  R('revoke', ({ code }) => hub.req('POST', `/v1/invites/${enc(code)}/revoke`, {}));
  R('removeMember', ({ id, accountId }) => hub.req('POST', `/v1/classes/${enc(id)}/members/${enc(accountId)}/remove`, {}));
  R('saveSession', async ({ classId, id, title, start, end, location, meetingUrl, notes }) => {
    const body = { title, start, end, location: location || null, meetingUrl: meetingUrl || null, notes: notes || null };
    return changed(id ? await hub.req('POST', `/v1/class-sessions/${enc(id)}`, body) : await hub.req('POST', `/v1/classes/${enc(classId)}/sessions`, body));
  });
  R('deleteSession', async ({ id }) => changed(await hub.req('POST', `/v1/class-sessions/${enc(id)}/delete`, {})));
  R('jitsi', ({ title }) => jitsiLink(title));
  R('set', ({ id }) => hub.req('GET', `/v1/sets/${enc(id)}`));
  R('createSet', ({ classId, title, questions, leaderboard }) => hub.req('POST', `/v1/classes/${enc(classId)}/sets`, { title, questions, leaderboard: leaderboard !== false }));
  R('deleteSet', ({ id }) => hub.req('POST', `/v1/sets/${enc(id)}/delete`, {}));
  R('answer', async ({ setId, questionId, choice }) => {
    try {
      return await hub.req('POST', `/v1/sets/${enc(setId)}/answer`, { questionId, choice });
    } catch (e) {
      if (e.status === 0) throw new OfflineError('Your Kea account is offline right now, so answers can’t be checked. Your progress is safe; try again when it’s back.');
      throw e;
    }
  });
  R('leaderboard', ({ id, period }) =>
    live(
      (s) => s.boards[`${id}:${period}`],
      () => hub.req('GET', `/v1/classes/${enc(id)}/leaderboard?period=${period === 'all' ? 'all' : 'week'}`),
      (s, v) => (s.boards[`${id}:${period}`] = v)
    )
  );
  // Applying to have classes in the public list (a creator application, protocol section 5): POST /v1/apply on a
  // newer account server, /v1/hosting on an older one (Hub 0.5). Both answer the same shape here.
  R('hosting', async () => {
    try {
      return creatorStatus(await hub.req('GET', '/v1/apply'));
    } catch (e) {
      if (e.status !== 404 && e.status !== 405) throw e;
      return { ...(await hub.req('GET', '/v1/hosting')), older: true };
    }
  });
  R('applyHosting', async ({ reason, note, organization }) => {
    const text = String(note ?? reason ?? '').trim();
    try {
      const r = await hub.req('POST', '/v1/apply', { kind: 'creator', note: text, organization: String(organization ?? '').trim() });
      return r.status === 'approved' ? { status: 'approved' } : creatorStatus({ applications: [r.application].filter(Boolean) });
    } catch (e) {
      if (e.status !== 404 && e.status !== 405) throw e;
      return hub.req('POST', '/v1/hosting/apply', { reason: text });
    }
  });
  R('setBoard', async ({ show, nickname, everyClass }) => {
    await hub.req('POST', '/v1/me/leaderboard', { show, nickname: nickname || null, everyClass: everyClass !== false });
    return hub.refreshStatus();
  });
  R('importable', () => importable());
  R('importSet', ({ id }) => importSet(String(id)));
  R('calendarSync', async () => (await syncCalendar(), true));

  if (process.env.KEA_WORKER_JOB) return;
  syncSoon(6000);
  setInterval(remindTick, 60_000);
}

/**
 * A creator application's state from GET /v1/apply ({ creator, applications }): approved, pending, rejected (with the
 * owner's note) or none, in the shape the older /v1/hosting answered.
 */
function creatorStatus(r) {
  if (r?.creator) return { status: 'approved' };
  const a = (Array.isArray(r?.applications) ? r.applications : []).filter((x) => x && x.kind === 'creator').sort((x, y) => (y.createdAt ?? 0) - (x.createdAt ?? 0))[0];
  if (!a) return { status: 'none' };
  return { status: a.status === 'declined' || a.status === 'denied' ? 'rejected' : a.status, note: a.decisionNote ?? null, appliedAt: a.createdAt ?? null, organization: a.organization ?? null };
}

module.exports = { register, calendarItems, syncCalendar, _test: { creatorStatus, parseInvite, inviteLink, jitsiLink, sessionItem, itemsBetween, dueReminders, toHubQuestions } };
