// Fill gaps before asking the student. When Kea can't find what an upcoming assignment asks for (no instructions, no
// rubric, nothing in its files), it first sends Claude to look (the assignment's guide run, forced, which reads the
// class site, its files and outside platforms). The student hears about it only if that still doesn't find it, and then
// once, saying exactly what's missing and where to look.
//
// Limits (agent runs use the student's own Claude plan): each gap gets a set number of attempts (1 by default, at most
// 3: Settings → Classes → Advanced), recorded in gaps.json, so the same gap is never researched again on the next
// sync. What a run finds is saved with the guide, with links to where it came from; nothing is ever guessed (the guide
// rules in scholar/skills/kea-guides/SKILL.md).
const fs = require('fs');
const path = require('path');

const DAY = 864e5;
const WORK = new Set(['assignment', 'paper', 'project', 'presentation', 'lab_handout', 'discussion', 'peer_review', 'draft']);

/** What's missing for one item (null: nothing): no instructions at all, or instructions but no rubric. */
function missingFor(it, { hasRubric, hasFiles, guide }) {
  const own = `${it.description || ''} ${it.sourceWording || ''}`.trim();
  const instructions = own.length >= 60 || hasFiles || !!(guide && (guide.steps || []).length);
  if (!instructions) return 'instructions';
  // (A rubric is looked for only for written work that's graded on points.)
  if (!hasRubric && ['paper', 'project', 'presentation'].includes(it.type) && !(guide && (guide.graded || []).length)) return 'rubric';
  return null;
}

/**
 * Which upcoming items to research now and which to tell the student about. `items`: db.items shape (due in the next
 * `days`, not done); `facts(it)`: { hasRubric, hasFiles, guide }; `state`: gaps.json. Returns { research: [{ key, it,
 * what }], tell: [{ key, it, what }], state } (the new state to save).
 */
function plan(items, facts, state = {}, { now = new Date(), days = 14, attempts = 1 } = {}) {
  const today = now.toISOString().slice(0, 10);
  const until = new Date(now.getTime() + days * DAY).toISOString().slice(0, 10);
  const next = { ...state };
  const research = [];
  const tell = [];
  for (const it of items || []) {
    if (!WORK.has(it.type) || it.done || it.withdrawn || !it.date || it.date < today || it.date > until) continue;
    const what = missingFor(it, facts(it));
    const key = `${it.id}:${what || 'ok'}`;
    if (!what) {
      // Found since: the open gap for this item is closed.
      for (const k of Object.keys(next)) if (k.startsWith(`${it.id}:`) && !next[k].resolved) next[k] = { ...next[k], resolved: now.toISOString() };
      continue;
    }
    const s = next[key] || { tries: 0 };
    if (s.resolved || s.told) continue;
    if (s.tries < Math.max(1, Math.min(3, attempts))) {
      // (One attempt per day at most, so a run still going isn't queued again.)
      if (s.lastTry && now.getTime() - Date.parse(s.lastTry) < DAY) continue;
      next[key] = { ...s, tries: s.tries + 1, lastTry: now.toISOString(), what };
      research.push({ key, it, what });
    } else if (s.lastTry && now.getTime() - Date.parse(s.lastTry) >= 6 * 3600e3) {
      next[key] = { ...s, told: now.toISOString() };
      tell.push({ key, it, what });
    }
  }
  return { research, tell, state: next };
}

/** The one message when the research didn't find it: exactly what's missing and where to look. */
function message(it, what, site = 'your class site') {
  const where = (it.links || []).find((l) => l.kind === 'submit') || (it.links || [])[0];
  return {
    id: `gap:${it.id}:${what}`,
    kind: 'needs_you',
    course: it.courseCode,
    title: what === 'rubric' ? `No rubric found for ${it.title}` : `No instructions found for ${it.title}`,
    body:
      what === 'rubric'
        ? `Kea looked on ${site}, in the assignment's files and in the syllabus, and couldn't find how ${it.title} is graded. Check the assignment's page for a rubric (sometimes it's under "View rubric" or in a separate file), or ask your instructor. Once it's posted, Kea picks it up on the next check.`
        : `Kea looked on ${site} and in the class's files and couldn't find what ${it.title} asks you to do. Open its page on the class site, check the syllabus and announcements, or ask your instructor. Once it's posted, Kea picks it up on the next check.`,
    links: where ? [{ label: 'Open its page', url: where.url }] : []
  };
}

const file = (dir) => path.join(dir, 'gaps.json');
function read(dir) {
  try {
    return JSON.parse(fs.readFileSync(file(dir), 'utf8')) || {};
  } catch {
    return {};
  }
}
function write(dir, state) {
  // (Old, closed entries are dropped after two months.)
  const cutoff = Date.now() - 60 * DAY;
  const kept = Object.fromEntries(Object.entries(state).filter(([, s]) => Date.parse(s.resolved || s.told || s.lastTry || 0) > cutoff || (!s.resolved && !s.told)));
  fs.writeFileSync(file(dir), JSON.stringify(kept, null, 1));
}

module.exports = { missingFor, plan, message, read, write };
