// An assignment, written out whole for the Claude tab: when the student says which assignment a document or deck is
// for, Claude works against everything Kea has on it, not just the class site's short description: Kea's guide (steps,
// what to hand in, how it's graded), the class site's own instructions and rubric word for word, and the text of the
// assignment's files (the handout, the rubric PDF, the prompt).
const profiles = require('./profiles.cjs');
const db = require('./db.cjs');
const study = require('./study.cjs');

const NOT_WORK = new Set(['reading', 'weekly_reading', 'lecture', 'recitation', 'seminar', 'office_hours', 'break', 'no_class', 'administrative_deadline', 'lab']);
const MAX = 60000;
/** Things in an older guide's "have ready" list that aren't supplies to get (same rule as Guide.tsx). */
const NOT_SUPPLY = /(video|lecture|computer|laptop|chromebook|internet|wi-?fi|account|access|log ?in|sign ?in|password|browser|software|app|website|site|portal|d2l|canvas|aleks|lesson|open in|pdf|file|document|word|draft|powerpoint|notes|textbook|e-?text|chapter|section|reading|syllabus|rubric|handout|source|post|essay|questions?|minutes|hours|time|pen|pencil|calculator|phone|camera|scanner|printer)s?/i;

const iso = (d) => {
  const t = new Date(Date.now() + d * 864e5);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
};
const when = (it) => {
  const d = new Date(`${it.date}T${it.due || '23:59'}`);
  return `${d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}${it.due ? `, ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : ''}`;
};

async function graded(from = -120, to = 150) {
  const P = profiles.paths();
  return (await db.items(P.db, P.textbooks, {}, { from: iso(from), to: iso(to) })).filter((i) => !NOT_WORK.has(i.type));
}

/** The graded work the picker offers: [{ id, course, title, date, due, points, guide }], soonest due first. */
async function list() {
  const guides = study.guidesAll();
  const today = iso(0);
  const items = await graded(-60, 120);
  const rank = (i) => (i.date >= today ? 0 : 1);
  return items
    .sort((a, b) => rank(a) - rank(b) || (rank(a) ? b.date.localeCompare(a.date) : a.date.localeCompare(b.date)))
    .map((i) => ({ id: i.id, course: i.courseCode, title: i.title, date: i.date, due: i.due || null, points: i.points ?? null, guide: !!guides[i.id] }));
}

/** One assignment's full brief as text, or null when it isn't on the calendar. */
async function brief(id) {
  const P = profiles.paths();
  const it = (await graded(-365, 365)).find((i) => i.id === id);
  if (!it) return null;
  const g = study.guidesAll()[id];
  const out = [`Assignment: ${it.courseCode} — ${it.title}${it.points ? ` (${it.points} points)` : ''}, due ${when(it)}`];
  if (g) {
    const lines = ["Kea's guide to it (written from the class site's instructions, rubric and files):", g.summary];
    // (An older guide's "have ready" list: its physical supplies are the first step.)
    const get = g.kind === 'lab' || /^lab/.test(it.type || '') ? (g.need || []).filter((x) => x && !NOT_SUPPLY.test(x)) : [];
    const steps = [...(get.length ? [{ title: 'Get your supplies', text: get.join('; ') }] : []), ...(g.steps || [])];
    if (steps.length) lines.push('Steps:', ...steps.map((s, n) => `${n + 1}. ${s.title}: ${s.text}${s.detail ? `\n   ${s.detail.replace(/\n/g, '\n   ')}` : ''}`));
    if (g.submit) lines.push(`Hand in: ${[g.submit.what, g.submit.where, g.submit.format, g.submit.due].filter(Boolean).join(' · ')}`);
    if (g.graded?.length) lines.push("How it's graded:", ...g.graded.map((c) => `- ${c.criterion}${c.points != null ? ` (${c.points} pts)` : ''}: ${c.how}`));
    if (g.gaps?.length) lines.push(`Kea couldn't find: ${g.gaps.join('; ')}`);
    out.push(lines.filter(Boolean).join('\n'));
  }
  const own = [it.description, it.sourceWording && it.sourceWording !== it.description ? it.sourceWording : null].filter(Boolean).join('\n\n');
  if (own) out.push(`The class site's own instructions and rubric, word for word:\n${own}`);
  const files = ((await db.itemSources(P.db, [id], 20000))[id] || []).filter((s) => (s.text || '').trim().length > 40);
  for (const f of files) out.push(`Assignment file "${f.title || f.type}"${f.url ? ` (${f.url})` : ''}:\n${f.text.trim()}`);
  if (it.links?.length) out.push(`Links: ${it.links.map((l) => `${l.label} ${l.url}`).join('; ')}`);
  let text = out.join('\n\n---\n\n');
  if (text.length > MAX) text = `${text.slice(0, MAX)}\n[… cut here: the rest is on the class site]`;
  return { id, course: it.courseCode, title: it.title, due: when(it), points: it.points ?? null, guide: !!g, text };
}

module.exports = { list, brief };
