// Classes the student withdrew from. A withdrawn class shows as "Withdrew" for the rest of its term: no upcoming work,
// guides, reminders, Missing items or Study prompts from it, and it isn't counted as due anywhere; its history (grades,
// files, past work) stays readable under the class. Another term's classes are other classes, never affected.
//
// Kept in the profile's withdrawn.json:
//   log:       { [courseId]: { on, at, by, code } }   the student's choice (or a W grade), newest change winning across
//                                                      devices and the phone, like checkmarks
//   suspects:  { [courseId]: { reason, days: [day], code } }   what a check saw, never acted on by itself
//   dismissed: { [courseId]: reason }                 "No, I'm still in it": not asked again for the same reason
//
// Kea marks a class withdrawn by itself only on a withdrawal grade the class site shows ("W"). Anything else it only
// suspects (the class gone from the class site's list of enrollments for its current term, or its access ended early),
// and then it asks the student, after seeing it on two different days. A check that failed (the class site down, an
// empty or unreadable list, a list that doesn't have any of the student's current classes) never decides anything.
const fs = require('fs');
const path = require('path');

const FILE = 'withdrawn.json';
const file = (dir) => path.join(dir, FILE);
const empty = () => ({ log: {}, suspects: {}, dismissed: {} });
function read(dir) {
  try {
    const v = JSON.parse(fs.readFileSync(file(dir), 'utf8'));
    return { ...empty(), ...(v && typeof v === 'object' ? v : {}) };
  } catch {
    return empty();
  }
}
function write(dir, v) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file(dir) + '.tmp', JSON.stringify(v, null, 1));
  fs.renameSync(file(dir) + '.tmp', file(dir));
}

/** The classes withdrawn from now: Map courseId → { at, by }. */
function activeOf(v) {
  const out = new Map();
  for (const [id, e] of Object.entries(v?.log || {})) if (e && e.on) out.set(id, { at: e.at, by: e.by || 'student' });
  return out;
}
/** Withdrawn classes for a profile folder (read by db.cjs from the class database's path). */
const active = (dir) => activeOf(read(dir));

/** Merge another device's (or the phone's) log in: the newer change wins. Returns whether anything changed. */
function merge(dir, theirs) {
  if (!theirs || typeof theirs !== 'object') return false;
  const v = read(dir);
  let changed = false;
  for (const [id, e] of Object.entries(theirs)) {
    if (!e || typeof e.at !== 'string' || typeof e.on !== 'boolean' || !/^[\w-]{1,80}$/.test(id)) continue;
    const cur = v.log[id];
    if (!cur || e.at > cur.at) {
      v.log[id] = { on: e.on, at: e.at, by: e.by === 'grade' ? 'grade' : 'student', code: String(e.code || cur?.code || '').slice(0, 40) };
      if (e.on) delete v.suspects[id];
      changed = true;
    }
  }
  if (changed) write(dir, v);
  return changed;
}

/** The student says they withdrew (on) or didn't (off: undo, or "I'm still in it"). */
function set(dir, courseId, on, code = '', now = new Date()) {
  const v = read(dir);
  v.log[courseId] = { on: !!on, at: now.toISOString(), by: 'student', code };
  const s = v.suspects[courseId];
  if (s) {
    // ("No, I'm still in it": not asked again for the same reason.)
    if (!on) v.dismissed[courseId] = s.reason;
    delete v.suspects[courseId];
  }
  write(dir, v);
  return v;
}
/** "No, I'm still in it" for a suspicion (nothing is logged: the class simply stays). */
function dismiss(dir, courseId) {
  const v = read(dir);
  const s = v.suspects[courseId];
  if (s) v.dismissed[courseId] = s.reason;
  delete v.suspects[courseId];
  write(dir, v);
  return v;
}

const W_GRADE = /^\s*(w|wd|wx|wp|wf|withdr[a-z]*)\b(?!\s*\d)/i;
/**
 * What one check of the class site says, as a pure function (tested on its own):
 *   courses:     Kea's classes [{ id, code, ou, start, end, synthetic }]
 *   enrollments: the class site's list of the student's enrollments (D2L myenrollments Items, or Canvas's active ones
 *                in the same shape), or null when the check couldn't read it
 *   grades:      { [code]: { final: { shown } } } as Kea read them
 * Returns { failed, withdraw: [{ courseId, code, reason }], suspect: [{ courseId, code, reason }], listed: [courseId] }.
 */
function assess({ courses, enrollments, grades = {}, today }) {
  const out = { failed: false, withdraw: [], suspect: [], listed: [] };
  const current = (courses || []).filter((c) => c && c.id && !c.synthetic && c.ou && (!c.start || c.start <= today) && (!c.end || c.end >= today));
  // (The withdrawal grade is the class site's own word, whatever the list says.)
  for (const c of current) {
    const shown = String(grades?.[c.code]?.final?.shown || '');
    if (W_GRADE.test(shown)) out.withdraw.push({ courseId: c.id, code: c.code, reason: 'grade' });
  }
  if (!Array.isArray(enrollments) || !enrollments.length) return { ...out, failed: true };
  const byOu = new Map(enrollments.filter((e) => e?.OrgUnit?.Id != null).map((e) => [String(e.OrgUnit.Id), e]));
  // A list without any of the student's current classes is a list Kea can't trust (another account, a page of it).
  if (current.length && !current.some((c) => byOu.has(String(c.ou)))) return { ...out, failed: true };
  for (const c of current) {
    if (out.withdraw.some((w) => w.courseId === c.id)) continue;
    const e = byOu.get(String(c.ou));
    if (!e) out.suspect.push({ courseId: c.id, code: c.code, reason: 'not listed' });
    else if (e.Access && (e.Access.IsActive === false || e.Access.CanAccess === false) && (!c.end || c.end > today)) out.suspect.push({ courseId: c.id, code: c.code, reason: 'no access' });
    else out.listed.push(c.id);
  }
  return out;
}

/**
 * Take one check's assessment in: a withdrawal grade marks the class (unless the student said otherwise after it);
 * a suspicion is remembered by day and asked about from its second day; a class listed again is no longer suspected.
 * A failed check changes nothing. Returns { changed, ask: [suspects to ask about] }.
 */
function record(dir, a, today, now = new Date()) {
  if (!a) return { changed: false, ask: [] };
  const v = read(dir);
  let changed = false;
  for (const w of a.withdraw) {
    const cur = v.log[w.courseId];
    // (The student's own say wins: an undo stays undone.)
    if (cur) continue;
    v.log[w.courseId] = { on: true, at: now.toISOString(), by: 'grade', code: w.code };
    delete v.suspects[w.courseId];
    changed = true;
  }
  if (!a.failed) {
    for (const s of a.suspect) {
      if (v.log[s.courseId]?.on || v.dismissed[s.courseId] === s.reason) continue;
      const cur = v.suspects[s.courseId];
      const days = cur && cur.reason === s.reason ? cur.days : [];
      if (!days.includes(today)) {
        v.suspects[s.courseId] = { reason: s.reason, code: s.code, days: [...days, today].slice(-5) };
        changed = true;
      }
    }
    for (const id of a.listed) {
      if (v.suspects[id]) {
        delete v.suspects[id];
        changed = true;
      }
      // (Listed and active again: a "still in it" answer can be asked again if it changes later.)
      if (v.dismissed[id]) {
        delete v.dismissed[id];
        changed = true;
      }
    }
  }
  if (changed) write(dir, v);
  return { changed, ask: asking(v) };
}
/** The suspicions to ask the student about: seen on two different days, not answered. */
const asking = (v) => Object.entries(v.suspects || {}).filter(([, s]) => (s.days || []).length >= 2).map(([courseId, s]) => ({ courseId, code: s.code, reason: s.reason }));

module.exports = { FILE, read, active, activeOf, merge, set, dismiss, assess, record, asking };
