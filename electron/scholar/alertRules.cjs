// When Kea interrupts the student, decided in one place (pure functions, tested in test/scholar/alertRules.test.mjs).
// The goal: every alert is worth reading, so nobody feels the need to mute them all.
//   - A grade of 95% or more with no instructor comment arrives quietly (in Notifications, no pop-up).
//   - A grade under 95%, any instructor comment, and missing or late work always pop up.
//   - A class that's dropped or over sends nothing.
//   - The same problem is one alert: a repeat updates it in place (no new pop-up) until it's resolved.

const DEFAULT_THRESHOLD = 95;

/** 'notify' (pop-up and Notifications) or 'quiet' (Notifications only) for a grade, feedback or hidden-work message. */
function gradeAlert({ kind, percent, comment }, threshold = DEFAULT_THRESHOLD) {
  if (kind === 'grade') {
    // (A grade with a comment pops up once, as its feedback message, which shows the score too.)
    if (comment) return 'quiet';
    if (percent == null || !Number.isFinite(Number(percent))) return 'notify';
    return Number(percent) >= threshold ? 'quiet' : 'notify';
  }
  return 'notify';
}

// Pop-ups are for what the student has to act on now: a message, missing or late work, a grade or feedback, and
// Kea being unable to reach the class site or Claude. Everything Kea does by itself (new study material, a curriculum
// check, a class marked dropped, a due date moved) is listed in Notifications without a pop-up (the student's rule,
// 2026-11-25: "no popup notifications for small kea actions").
const POPS_UP = new Set(['message', 'missed', 'late', 'grade', 'feedback', 'signin', 'urgent']);
/** Whether this alert gets a pop-up of its own (n.urgent always does). */
function popsUp(n) {
  return !!n && (n.urgent === true || POPS_UP.has(String(n.kind || '')));
}
/** Kea's own work done in the background (study material filed into its class): listed already read, never a pop-up. */
const FILED = new Set(['study']);
const isFiled = (n) => !!n && FILED.has(String(n.kind || ''));

/** Classes that are over or that the student dropped: no alerts for them at all. */
function inactiveCodes({ courses = [], withdrawnLog = {}, today }) {
  const out = new Set();
  for (const c of courses) if (c && c.code && c.end && today && c.end < today) out.add(String(c.code));
  for (const [, w] of Object.entries(withdrawnLog || {})) if (w && w.on && w.code) out.add(String(w.code));
  return out;
}

/** What makes two alerts the same problem: the class, the kind and the title with its numbers taken out. */
function newsKey(n) {
  if (n.key) return String(n.key);
  const title = String(n.title || '')
    .toLowerCase()
    .replace(/\d+(?:[.,]\d+)?/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
  return `${n.course || ''}|${n.kind || ''}|${title}`;
}

/**
 * Add an alert to a list (newest first), or update the open one for the same problem in place. An alert counts as
 * open until it's resolved or a fortnight passes without it coming up again. Returns { list, isNew, item }: only a new
 * one pops up.
 */
function mergeNews(list, n, now = new Date(), windowDays = 14) {
  const key = newsKey(n);
  const t = now.getTime();
  const i = list.findIndex((x) => (x.key || newsKey(x)) === key && !x.resolved && t - Date.parse(x.updatedAt || x.at) < windowDays * 864e5);
  if (i >= 0) {
    const old = list[i];
    const same = old.title === n.title && old.body === n.body;
    const item = { ...old, ...n, key, id: old.id, at: old.at, updatedAt: now.toISOString(), count: (old.count || 1) + 1, read: n.read === true ? true : same ? old.read : false };
    return { list: [item, ...list.slice(0, i), ...list.slice(i + 1)], isNew: false, item };
  }
  const item = { id: `${t}`, at: now.toISOString(), updatedAt: now.toISOString(), read: false, count: 1, ...n, key };
  return { list: [item, ...list], isNew: true, item };
}

/** Mark the open alert for a problem resolved (its next occurrence is a new alert). */
function resolveNews(list, key, now = new Date()) {
  return list.map((x) => ((x.key || newsKey(x)) === key && !x.resolved ? { ...x, resolved: now.toISOString() } : x));
}

// ---------- Missing and late work ----------
// The same rule as the screens' isMissing (src/components/scholar/kinds.tsx): past due, not checked off, not
// withdrawn, and not shown graded with a score on the class site.
const TODO = new Set(['exam', 'final_exam', 'lab_practical', 'quiz', 'assignment', 'discussion', 'project', 'presentation', 'paper', 'draft', 'peer_review', 'pre_lab_quiz', 'other_deadline', 'reading', 'lab_handout']);
const IN_CLASS = new Set(['exam', 'final_exam', 'lab_practical']);
const pad = (n) => String(n).padStart(2, '0');

function isMissing(it, now = new Date()) {
  if (!it || it.done || it.withdrawn || it.optional) return false;
  if (it.handIn === 'graded' && it.handScore) return false;
  if (!TODO.has(it.type) || IN_CLASS.has(it.type)) return false;
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const day = it.dateEnd && it.type === 'reading' ? it.dateEnd : it.date;
  if (!day) return false;
  if (day < today) return true;
  if (day > today) return false;
  const due = it.due || (it.type === 'reading' ? null : '23:59');
  return !!due && `${pad(now.getHours())}:${pad(now.getMinutes())}` > due;
}

/**
 * Missing work to tell the student about: each item once (`told` holds the ids already told), recent ones only
 * (due in the last `days`), never readings, never for an inactive class. Returns the items, oldest due first.
 */
function missingToTell(items, { told = [], inactive = new Set(), now = new Date(), days = 10 } = {}) {
  const since = new Date(now.getTime() - days * 864e5);
  const sinceDay = `${since.getFullYear()}-${pad(since.getMonth() + 1)}-${pad(since.getDate())}`;
  const seen = new Set(told);
  return (items || [])
    .filter((it) => it.type !== 'reading' && !seen.has(String(it.id)) && !inactive.has(String(it.courseCode || '')) && (it.date || '') >= sinceDay && isMissing(it, now))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

// The classes that are inactive right now, as the last daily check found them (it sets this; every alert reads it).
let inactiveNow = new Set();
const setInactive = (s) => void (inactiveNow = new Set(s));
const isInactive = (code) => !!code && inactiveNow.has(String(code));

module.exports = { DEFAULT_THRESHOLD, popsUp, isFiled, setInactive, isInactive, gradeAlert, inactiveCodes, newsKey, mergeNews, resolveNews, isMissing, missingToTell };
