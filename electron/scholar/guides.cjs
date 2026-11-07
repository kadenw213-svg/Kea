// Assignment guides: for every assignment still ahead (and any that's missing), Claude writes a clean, step-by-step
// guide to doing it: what it is, what to have ready, each step in the order you'd do it (before lab, in lab, the
// write-up; a paper's research and drafting; "open ALEKS and finish X"), what to hand in and where, and how it's graded.
// It's written ahead of time by the `guides` run (runner.cjs), never on a button, and again only when the teacher
// changes the assignment (its hash). Saved in the study folder (study.cjs guides.json), so the phone has them too.
//
// Kea gathers everything first, in plain code (no Claude): the item's own instructions and rubric, the documents it
// was read from, the class's downloaded files (lab handouts, the syllabus), its course-content outline, discussion
// topics, and announcements and messages that mention it. Claude reads that brief, keeps one template per kind of
// assignment per class (data/guides/<CODE>/templates.json: the class's lab-notebook rules, report sections, paper
// style, policies), and may download a document the assignment points to that Kea doesn't have yet.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const profiles = require('./profiles.cjs');
const db = require('./db.cjs');
const study = require('./study.cjs');

const KINDS = ['lab', 'paper', 'platform-homework', 'written-homework', 'discussion', 'quiz', 'exam', 'project', 'presentation', 'other'];
// Calendar entries that aren't work to do.
const NOT_WORK = new Set(['reading', 'weekly_reading', 'lecture', 'recitation', 'seminar', 'office_hours', 'break', 'no_class', 'administrative_deadline', 'other_deadline']);
const DAY = 864e5;
const MAX_BRIEF = 90000;
// Guides for writing work are about the student's own topic and the teacher's feedback (v2, 2026-11-03). v3
// (2026-11-04): every guide opens with its topic and goal and the special notes; labs carry the whole procedure and
// what this lab's notebook must hold; the class site's rubric comes with it. Older guides are written once more. v4
// (2026-11-05): no "have ready" list or lecture-video steps, every question a discussion asks spelled out in its steps,
// a discussion built on a lab tied to that lab, and no hand-in link inside a step. v5 (2026-11-07): a step can point at
// other work in Kea (`item`: the lab a discussion needs), the brief gives each related item's id and links, and a
// quiz's guide has no step that only says to take it.
const GUIDE_V = 5;
const FOCUS_KINDS = new Set(['paper', 'discussion', 'project', 'presentation']);
const outdated = (g) => !!g && (g.v || 1) < GUIDE_V;
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** What the guide depends on: when the teacher changes any of it, the guide is written again. */
function hashOf(it) {
  const src = [it.type, it.title, it.date, it.due, it.points, it.description || '', it.sourceWording || '', (it.links || []).map((l) => l.url).join(' ')];
  return crypto.createHash('sha1').update(JSON.stringify(src)).digest('hex').slice(0, 16);
}

/**
 * The items that need a guide: work (not lectures or readings) due from today on, or past due in the last four weeks
 * and still not handed in; none checked off by the student. `all`: the items (db.items shape).
 */
function needing(all, guides = study.guidesAll(), today = localDay()) {
  return all.filter((it) => {
    // (Only the student's checkmark ends it: a class-site match can be the wrong part, like a discussion's initial
    // post for its response posts.)
    if (NOT_WORK.has(it.type) || it.done || !it.date) return false;
    // (Past: only work Kea knows wasn't handed in.)
    if (it.date < today && it.handIn !== 'not_submitted') return false;
    const g = guides[it.id];
    // (A guide written while the work was still ahead reads wrong once it's missing: written once more.)
    const turnedMissing = !!g && it.date < today && String(g.at || '').slice(0, 10) <= it.date;
    return g?.hash !== hashOf(it) || outdated(g) || turnedMissing;
  });
}

/** The items to look at: the last four weeks to the end of the term. */
async function current() {
  const P = profiles.paths();
  const { value } = profiles.readJsonSafe(P.state, null);
  const done = (value && value.done) || {};
  return db.items(P.db, P.textbooks, done, { from: localDay(new Date(Date.now() - 28 * DAY)), to: localDay(new Date(Date.now() + 150 * DAY)) });
}

const dir = (code) => path.join(profiles.paths().workspace, 'data', 'guides', code);
const rel = (f) => path.relative(profiles.paths().workspace, f).replace(/\\/g, '/');
const readJson = (f, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return fallback;
  }
};
const cut = (s, n) => {
  const t = String(s || '').replace(/\r/g, '').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** The latest copy of one of the class site's areas Kea saved ("discussions", "content"), or null. */
function digest(code, area) {
  const root = path.join(profiles.paths().workspace, 'data', 'digests', 'kea-precheck');
  try {
    for (const d of fs.readdirSync(root).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)).sort().reverse()) {
      for (const f of [`${code}-${area}.min.json`, `${code}-${area}.json`]) {
        const p = path.join(root, d, f);
        if (fs.existsSync(p)) return readJson(p, null);
      }
    }
  } catch {}
  return null;
}

/** The newest full (not trimmed) pre-check answer for a class's area. */
function digestFull(code, area) {
  const root = path.join(profiles.paths().workspace, 'data', 'digests', 'kea-precheck');
  try {
    for (const d of fs.readdirSync(root).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)).sort().reverse()) {
      const p = path.join(root, d, `${code}-${area}.json`);
      if (fs.existsSync(p)) return readJson(p, null);
    }
  } catch {}
  return null;
}

const plain = (rich) => {
  const r = rich && typeof rich === 'object' ? rich.Text || String(rich.Html || '').replace(/<[^>]+>/g, ' ') : String(rich || '');
  return r.replace(/&nbsp;/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
};

/**
 * What the student has done in this class so far, read from the class site (D2L): their own discussion posts (where a
 * research topic is usually chosen and argued over) with the replies they got, the instructor's feedback and rubric
 * marks on each graded assignment, and what they handed in. Guides for papers and discussions are written from it, so
 * they're about the student's own topic and what the teacher wants them to fix, not writing advice for anyone.
 * Written to data/guides/<CODE>/own-work.md; returns its text ('' when there's nothing or the site can't be read).
 */
async function ownWork(code) {
  const browser = require('./browser.cjs');
  if (browser.platformOf() === 'canvas') return '';
  const precheck = require('./precheck.cjs');
  const course = (await db.watchList(profiles.paths().db)).find((c) => c.code === code);
  if (!course?.ou) return '';
  const v = await precheck.versions();
  const me = await precheck.whoami(v);
  if (!me) return '';
  const get = async (rel) => (await browser.getJson(rel).catch(() => null))?.data ?? null;
  const L = [];
  // Discussion posts: the student's own, and what others replied to them.
  const topics = (digestFull(code, 'discussions') || []).filter((t) => t && t.ForumId && t.TopicId && !t.IsHidden).slice(0, 40);
  const posts = [];
  for (const t of topics) {
    const all = await get(`/d2l/api/le/${v.le}/${course.ou}/discussions/forums/${t.ForumId}/topics/${t.TopicId}/posts/`);
    if (!Array.isArray(all)) continue;
    const mine = all.filter((p) => String(p.PostingUserId) === String(me));
    if (!mine.length) continue;
    const ids = new Set(mine.map((p) => p.PostId));
    const replies = all.filter((p) => ids.has(p.ParentPostId) && String(p.PostingUserId) !== String(me));
    posts.push(`### ${t.ForumName ? `${t.ForumName}: ` : ''}${t.Name}`);
    for (const p of mine) posts.push(`**Your post${p.Subject ? ` "${p.Subject}"` : ''}** (${String(p.DatePosted || '').slice(0, 10)}):`, cut(plain(p.Message), 2500), '');
    for (const r of replies.slice(0, 4)) posts.push(`*Reply from ${r.PostingUserDisplayName || 'someone'}:* ${cut(plain(r.Message), 600)}`, '');
  }
  if (posts.length) L.push('## Your discussion posts', '', ...posts);
  // What was handed in to each assignment folder, and the feedback on it with the rubric's own criterion and level names.
  const fb = [];
  for (const f of (digestFull(code, 'dropbox') || []).filter((x) => x && x.Id && !x.IsHidden).slice(0, 40)) {
    const subs = await get(`/d2l/api/le/${v.le}/${course.ou}/dropbox/folders/${f.Id}/submissions/mysubmissions/`);
    const handed = (Array.isArray(subs) ? subs : []).flatMap((e) => e.Submissions || []);
    const back = handed.length ? await get(`/d2l/api/le/${v.le}/${course.ou}/dropbox/folders/${f.Id}/feedback/user/${me}`) : null;
    if (!handed.length) continue;
    const lines = [`### ${f.Name}`];
    for (const s of handed.slice(-2)) lines.push(`- You handed in ${String(s.SubmissionDate || '').slice(0, 10)}: ${(s.Files || []).map((x) => x.FileName).join(', ') || 'text'}${plain(s.Comment) ? ` (your note: ${cut(plain(s.Comment), 300)})` : ''}`);
    if (back) {
      if (back.Score != null) lines.push(`- Score: ${back.Score}`);
      if (plain(back.Feedback)) lines.push(`- Instructor's feedback: ${cut(plain(back.Feedback), 3000)}`);
      const rubrics = f.Assessment?.Rubrics || [];
      for (const ra of back.RubricAssessments || []) {
        const r = rubrics.find((x) => x.RubricId === ra.RubricId) || rubrics[0] || {};
        const crit = new Map((r.CriteriaGroups || []).flatMap((g) => (g.Criteria || []).map((c) => [c.Id, c.Name])));
        const levels = new Map((r.CriteriaGroups || []).flatMap((g) => (g.Levels || []).map((l) => [l.Id, l.Name])));
        for (const c of ra.CriteriaOutcome || []) {
          const note = plain(c.Feedback);
          lines.push(`- Rubric, ${crit.get(c.CriterionId) || `criterion ${c.CriterionId}`}: ${levels.get(c.LevelId) || ''}${c.Score != null ? ` (${c.Score} pts)` : ''}${note ? `: ${cut(note, 800)}` : ''}`);
        }
      }
    }
    fb.push(...lines, '');
  }
  if (fb.length) L.push('## Your assignments: what you handed in and the feedback you got', '', ...fb);
  const text = L.length ? `# Your own work in ${code} so far\n\n${L.join('\n')}` : '';
  const d = dir(code);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'own-work.md'), cut(text, 60000));
  return text;
}

/** The class's content tree as an outline (module › title — url), written to a file Claude can search. */
function contentOutline(code) {
  const c = digest(code, 'content');
  if (!c) return null;
  const lines = [];
  const walk = (mods, trail) => {
    for (const m of mods || []) {
      const here = [...trail, m.Title].filter(Boolean);
      lines.push(`## ${here.join(' › ')}`);
      if (m.Description) lines.push(cut(m.Description, 600));
      for (const t of m.Topics || []) lines.push(`- ${t.Title}${t.TypeIdentifier ? ` [${t.TypeIdentifier}]` : ''}${t.Url && /^https?:/.test(t.Url) ? ` — ${t.Url}` : ''}${t.Description ? `\n  ${cut(t.Description, 300).replace(/\n+/g, ' ')}` : ''}`);
      walk(m.Modules, here);
    }
  };
  walk(c.Modules || (Array.isArray(c) ? c : []), []);
  return lines.join('\n');
}

/**
 * The rubric the class site attaches to an item's assignment folder, whole: every criterion with every level's points
 * and wording ({ name, total, levels, criteria: [{ name, cells: [{ points, text }] }] }), or null.
 */
function rubricFor(code, it) {
  const ids = (it.links || []).map((l) => String(l.url || '').match(/[?&]db=(\d+)/)?.[1]).filter(Boolean);
  if (!ids.length) return null;
  const folder = (digestFull(code, 'dropbox') || []).find((f) => f && ids.includes(String(f.Id)));
  const r = folder?.Assessment?.Rubrics?.[0];
  if (!r) return null;
  // (Its lines kept apart: "Reagent table present; Headers filled out; …".)
  const text = (x) =>
    plain(x)
      .split(/\s*\n\s*/)
      .filter(Boolean)
      .map((l, i, all) => (i < all.length - 1 && !/[.;:!?]$/.test(l) ? `${l};` : l))
      .join(' ')
      .trim();
  const groups = r.CriteriaGroups || [];
  const levels = (groups[0]?.Levels || []).map((l) => cut(l.Name, 80));
  const criteria = groups.flatMap((g) =>
    (g.Criteria || []).map((c) => ({
      name: cut(c.Name, 160),
      cells: (c.Cells || []).map((x) => ({ points: Number.isFinite(x.Points) ? x.Points : null, text: cut(text(x.Description), 600) }))
    }))
  );
  if (!criteria.length) return null;
  const total = criteria.reduce((n, c) => n + Math.max(0, ...c.cells.map((x) => x.points || 0)), 0);
  return { name: cut(r.Name, 160), total, levels, criteria: criteria.slice(0, 20) };
}

const rubricText = (r) =>
  [`**${r.name}** (${r.total} points). Levels: ${r.levels.join(' · ')}`, ...r.criteria.map((c) => `- ${c.name}: ${c.cells.map((x, i) => `[${r.levels[i] || i + 1}${x.points != null ? `, ${x.points} pts` : ''}] ${x.text}`).join(' ')}`)].join('\n');

/** Lab procedures read from the lab's platform on an earlier run, kept by item id (they don't change). */
const procedureFile = (code, id) => path.join(dir(code), 'procedures', `${String(id).replace(/[^\w-]/g, '')}.md`);

const STOP = new Set('the and for with from your this that week lab labs part assignment homework quiz exam test due submit upload final report post posts initial reply replies chapter discussion'.split(' '));
/** Words that pick out an item in a message: its number ("lab 5") and its distinctive words. */
function marks(title) {
  const t = String(title).toLowerCase();
  // ("Lab report #7" is lab 7.)
  const nums = [...t.matchAll(/\b(lab|exam|test|quiz|chapter|ch|unit|module|project|paper|essay|homework|hw|assignment)\b(?:\s+[a-z]+)?\s*#?\s*(\d+)\b/g)].map((m) => `${m[1]} ${m[2]}`);
  const words = (t.match(/[a-z]{4,}/g) || []).filter((w) => !STOP.has(w));
  return { nums, words: [...new Set(words)] };
}
function mentions(text, m) {
  const t = String(text).toLowerCase().replace(/\s+/g, ' ');
  // (Its number on its own: "lab 7" or "lab #7", not "lab 70".)
  if (m.nums.some((n) => { const [w, d] = n.split(' '); return new RegExp(`\\b${w}\\b(?:\\s+[a-z]+)?\\s*#?\\s*${d}\\b`).test(t); })) return true;
  return m.words.length >= 2 && m.words.filter((w) => t.includes(w)).length >= Math.min(3, m.words.length);
}

/** Announcements and messages from the class that mention the item (newest first). */
function related(code, it) {
  const P = profiles.paths();
  const m = marks(it.title);
  const out = [];
  try {
    const inbox = require('./precheck.cjs').readInbox().items || [];
    for (const n of inbox) if ((n.course || '') === code && /announcement|news|message/.test(n.kind || '') && mentions(`${n.title}\n${n.body}`, m)) out.push({ at: n.at, from: 'Announcement', title: n.title, text: cut(n.body, 1500) });
  } catch {}
  try {
    const box = readJson(path.join(P.dir, 'messages.json'), {});
    for (const x of box.box?.inbox || []) {
      if (x.course && x.course !== code) continue;
      const body = box.bodies?.[x.id]?.text || x.preview || '';
      if (mentions(`${x.subject}\n${body}`, m)) out.push({ at: x.first || x.date, from: `Message from ${String(x.from || '').replace(/<[^>]*>/g, '').trim()}`, title: x.subject, text: cut(body, 1500) });
    }
  } catch {}
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 6);
}

/**
 * Write one class's brief (data/guides/<CODE>/brief.md, with content.md beside it) for the items given, and say where
 * Claude writes its answer. Returns { brief, output, count } (workspace-relative paths).
 */
async function brief(code, items, { rescan = false, own = '' } = {}) {
  const P = profiles.paths();
  const d = dir(code);
  fs.mkdirSync(d, { recursive: true });
  const templates = readJson(path.join(d, 'templates.json'), {});
  const sources = await db.itemSources(P.db, items.map((it) => it.id)).catch(() => ({}));
  const outline = contentOutline(code);
  if (outline) fs.writeFileSync(path.join(d, 'content.md'), `# ${code}: the class site's content (modules, files, links)\n\n${outline}\n`);
  const discussions = (digest(code, 'discussions') || []).map((t) => `- **${t.Name}**${t.ForumName && t.ForumName !== t.Name ? ` (in ${t.ForumName})` : ''}: ${cut(t.Description, 500).replace(/\n+/g, ' ')}`);
  const files = study.classFiles(code).filter((f) => !f.needs_text);
  const course = items[0] || {};
  const L = [];
  L.push(`# Guides to write: ${code}`, '');
  L.push(`Class: ${code}${course.instructor ? ` · instructor ${course.instructor}` : ''}${course.contact ? ` (${course.contact})` : ''}. Today is ${localDay()}.`, '');
  L.push(`Write your answer to \`${rel(path.join(d, 'out.json'))}\`, and keep the class's templates in \`${rel(path.join(d, 'templates.json'))}\`.`, '');
  if (rescan) L.push('**The student asked to rescan these assignments:** they just completed what unlocks the instructions (or think something changed). Open each one again on the class site and its platform, read everything now unlocked, and write the whole guide.', '');
  L.push('## Templates already kept for this class', '');
  L.push(Object.keys(templates).length ? '```json\n' + JSON.stringify(templates, null, 1).slice(0, 12000) + '\n```' : '(none yet: write one for each kind of assignment below before its guides)', '');
  L.push('## Where to look for class-wide rules and documents', '');
  if (outline) L.push(`- The class site's whole content outline (modules, files, links, with their URLs): \`${rel(path.join(d, 'content.md'))}\`. Grep it for lab manuals, notebook guidelines, report templates, paper guidelines.`);
  for (const f of files.slice(0, 80)) L.push(`- \`${f.path}\` (${Math.round(f.bytes / 1024)} KB)`);
  if (!outline && !files.length) L.push('- (Kea has no class files downloaded for this class.)');
  L.push('');
  if (discussions.length) L.push('## Discussion topics in this class', '', ...discussions.slice(0, 40), '');
  // The student's own posts, hand-ins and feedback (ownWork): what papers and discussions are written from.
  if (own) L.push("## The student's own work in this class (their posts, what they handed in, the instructor's feedback)", '', `Read in full: \`${rel(path.join(d, 'own-work.md'))}\`. The start of it:`, '', cut(own, 14000), '');
  else L.push("## The student's own work in this class", '', "Kea couldn't read it this time. For papers and discussions, fetch it yourself with d2l_fetch: the student's posts in the related discussion topics (`/d2l/api/le/<le>/<ou>/discussions/forums/<forum>/topics/<topic>/posts/`, their own by PostingUserId) and the feedback on graded folders (`/dropbox/folders/<id>/feedback/user/<their id>`).", '');
  // A document several assignments were read from (a lab schedule, the syllabus) is given once, here.
  const seen = new Map();
  for (const it of items) for (const s of sources[it.id] || []) if (s.text) seen.set(s.text, [...(seen.get(s.text) || []), it.id]);
  const shared = [...seen].filter(([, ids]) => ids.length > 1).map(([t]) => t);
  const name = (s) => `${s.type}${s.title ? `: ${s.title}` : ''}`;
  if (shared.length) {
    L.push('## Documents several of these assignments come from', '');
    for (const t of shared) {
      const s = items.flatMap((it) => sources[it.id] || []).find((x) => x.text === t);
      L.push(`### ${name(s)}${s.path ? ` (${s.path})` : ''}`, '```', cut(t, 4000), '```', '');
    }
  }
  L.push(`## The assignments (${items.length})`, '');
  // (Related work may not need a guide itself: it's looked up among all of this class's items.)
  const byId = new Map((await current().catch(() => items)).map((x) => [x.id, x]));
  for (const it of items) {
    L.push(`### ${it.title}`);
    L.push(`- id: \`${it.id}\``);
    L.push(`- type: ${it.type}${it.points ? ` · ${it.points} points` : ''} · due ${it.date}${it.due ? ` ${it.due}` : it.start ? ` ${it.start}` : ''}${it.handIn === 'not_submitted' && it.date < localDay() ? ' · **MISSING (past due, not handed in)**' : ''}`);
    if (it.location) L.push(`- where: ${it.location}`);
    if (it.module) L.push(`- module: ${it.module}`);
    // (A hand-in link of the wrong kind, a quiz on a discussion, is never offered: the guide would repeat it.)
    const post = it.type === 'discussion' || it.type === 'peer_review';
    for (const l of it.links || []) if (!(post && /quiz_summary|quizzing/i.test(l.url))) L.push(`- link (${l.kind}): ${l.label} — ${l.url}${l.kind === 'submit' ? ' (its hand-in place: Kea shows it as a button, so never link it in a step)' : ''}`);
    // (Each with its Kea id, for a step's `item`, and its own links, for a step that reads it.)
    for (const r of it.related || []) {
      const what = r.why === 'post' ? 'the other half of this discussion' : r.group ? `part of ${r.group}` : r.why === 'lab' ? 'the lab' : 'related work';
      L.push(`- **Goes with** ${what}: "${r.title}" (${r.type}, ${r.date}) · Kea id \`${r.id}\`${r.done ? ' · checked off' : ''}`);
      const other = byId.get(r.id);
      for (const l of [...(other?.links || []), ...(other?.platformLinks || [])].slice(0, 6)) L.push(`  - its link (${l.kind}): ${l.label} — ${l.url}`);
    }
    for (const l of it.platformLinks || []) L.push(`- done on: ${l.label || l.name || ''} — ${l.url || ''}`);
    if (it.readings?.length) L.push(`- readings: ${it.readings.map((r) => `${r.chapter}${r.title ? ` ${r.title}` : ''}`).join('; ')}`);
    if (it.studyFocus?.length) L.push(`- what it covers: ${it.studyFocus.join(' | ')}`);
    const own = [it.description, it.sourceWording].filter(Boolean);
    if (own.length) L.push('', 'From the class site:', '```', cut(own.join('\n\n'), 6000), '```');
    const r = rubricFor(code, it);
    if (r) L.push('', 'Its rubric on the class site, complete (Kea shows it under the guide as it is):', rubricText(r));
    if (fs.existsSync(procedureFile(code, it.id))) L.push('', `Its procedure, read from the lab platform on an earlier run: \`${rel(procedureFile(code, it.id))}\`. Read it; open the platform again only if this is a rescan or the file says something was missing.`);
    for (const s of sources[it.id] || []) {
      if (!s.text || own.some((o) => o.includes(s.text.slice(0, 80)))) continue;
      if (shared.includes(s.text)) L.push(`- also from: ${name(s)} (given above)`);
      else L.push('', `Source document (${name(s)}${s.path ? `, ${s.path}` : ''}):`, '```', cut(s.text, 3000), '```');
    }
    const rel2 = related(code, it);
    if (rel2.length) L.push('', 'Mentioned in:', ...rel2.map((r) => `- ${r.from}, ${String(r.at || '').slice(0, 10)} — ${r.title}: ${r.text.replace(/\n+/g, ' ')}`));
    L.push('');
  }
  const text = L.join('\n');
  // (Long documents are listed as paths above, for Claude to read only what it needs. A brief still over about 90k
  // characters is too much for one run: the runner splits the class's items in two instead.)
  if (text.length > MAX_BRIEF && items.length > 1) return { tooLong: true, count: items.length };
  const file = path.join(d, 'brief.md');
  fs.writeFileSync(file, text.length > MAX_BRIEF ? `${text.slice(0, MAX_BRIEF)}\n\n(Cut here: read the rest of this assignment's documents yourself.)\n` : text);
  return { brief: rel(file), output: rel(path.join(d, 'out.json')), count: items.length };
}

// ---------- What Claude wrote, checked ----------
const str = (v, n) => (typeof v === 'string' ? cut(v, n) : '');
const strings = (v, n, max) => (Array.isArray(v) ? v : []).map((x) => str(x, n)).filter(Boolean).slice(0, max);

/** Writing work: what to research for the student's topic, and what the teacher's feedback says to fix. */
function focusOf(f) {
  if (!f || typeof f !== 'object') return null;
  const out = {
    research: (Array.isArray(f.research) ? f.research : [])
      .map((r) => ({ question: str(r?.question, 300), why: str(r?.why, 300), search: str(r?.search, 200) }))
      .filter((r) => r.question)
      .slice(0, 8),
    fix: strings(f.fix, 400, 6)
  };
  return out.research.length || out.fix.length ? out : null;
}

/**
 * One guide from Claude's answer, cleaned (or null when it's unusable). `ok(url)` says whether a link may stay: in Kea
 * only links that were in what Claude was given (or on a class platform) do, so a guessed address never shows.
 */
function clean(g, ok = () => true, okItem = () => false) {
  if (!g || typeof g !== 'object') return null;
  const url = (v) => (typeof v === 'string' && /^https?:\/\/\S+$/i.test(v.trim()) && ok(v.trim()) ? v.trim() : '');
  // Other work in Kea a step is about (`{ id, label }`, or just the id): kept only when `okItem` knows that id.
  const stepItem = (v) => {
    const id = typeof v === 'string' ? v : typeof v?.id === 'string' ? v.id : '';
    if (!id || !okItem(id)) return {};
    return { item: { id, label: str(typeof v === 'object' ? v.label : '', 80) || 'Open it in Kea' } };
  };
  const links = (v) =>
    (Array.isArray(v) ? v : [])
      .map((l) => ({ label: str(l?.label, 80), url: url(l?.url) }))
      .filter((l) => l.label && l.url)
      .slice(0, 6);
  const steps = (Array.isArray(g.steps) ? g.steps : [])
    // (`unlocks`: work the platform wants done before it shows the rest; checking it off asks Kea to read the rest.)
    .map((s) => ({ title: str(s?.title, 120), text: str(s?.text, 600), detail: str(s?.detail, 4000), links: links(s?.links), ...(s?.unlocks === true ? { unlocks: true } : {}), ...stepItem(s?.item) }))
    .filter((s) => s.title && (s.text || s.detail))
    .slice(0, 14);
  // (An answer in the older shape, with a separate `gate`: it becomes the first step.)
  const gate = g.gate && typeof g.gate === 'object' && str(g.gate.what, 300) ? g.gate : null;
  if (gate && !steps.some((s) => s.unlocks)) steps.unshift({ title: str(gate.label, 120) || 'Do this first', text: str(gate.what, 600), detail: '', links: links([{ label: gate.label || 'Open it', url: gate.url }]), unlocks: true });
  if (!steps.length) return null;
  const sub = g.submit && typeof g.submit === 'object' ? g.submit : {};
  const f = g.focus && typeof g.focus === 'object' ? g.focus : {};
  return {
    kind: KINDS.includes(g.kind) ? g.kind : 'other',
    // What it's about (the student's own topic for writing work) and what it must achieve to earn full marks.
    topic: str(g.topic || f.topic, 900),
    goal: str(g.goal || f.question, 900),
    summary: str(g.summary, 600),
    // What's easy to miss: the teacher's announcements and policies for it, conflicts between sources, what's missing.
    notes: strings(g.notes, 400, 8),
    need: strings(g.need, 120, 12),
    steps,
    // Labs: the whole procedure, as the platform gives it, and what this lab's notebook pages must hold.
    procedure: str(g.procedure, 30000),
    notebook: (Array.isArray(g.notebook) ? g.notebook : [])
      .map((n) => (typeof n === 'string' ? { item: str(n, 200), detail: '' } : { item: str(n?.item, 200), detail: str(n?.detail, 800) }))
      .filter((n) => n.item)
      .slice(0, 30),
    submit: { what: str(sub.what, 400), where: str(sub.where, 400), format: str(sub.format, 400), due: str(sub.due, 300), url: url(sub.url) },
    graded: (Array.isArray(g.graded) ? g.graded : [])
      .map((c) => ({ criterion: str(c?.criterion, 160), points: Number.isFinite(Number(c?.points)) && c?.points !== '' && c?.points != null ? Number(c.points) : null, how: str(c?.how, 500) }))
      .filter((c) => c.criterion)
      .slice(0, 16),
    gaps: strings(g.gaps, 300, 6),
    focus: focusOf(f),
    // (Work that unlocks the instructions is now a step marked `unlocks`.)
    gate: null
  };
}

/** The links Claude was given for a class (brief, content outline, own work, templates, procedures, platforms). */
function knownLinks(code, items) {
  const d = dir(code);
  const read = (f) => {
    try {
      return fs.readFileSync(f, 'utf8');
    } catch {
      return '';
    }
  };
  let text = ['brief.md', 'content.md', 'own-work.md', 'templates.json'].map((f) => read(path.join(d, f))).join('\n');
  try {
    for (const f of fs.readdirSync(path.join(d, 'procedures'))) text += read(path.join(d, 'procedures', f));
  } catch {}
  text += read(path.join(profiles.paths().dir, 'platform-links.json'));
  for (const it of items) text += (it.links || []).concat(it.platformLinks || [], it.weeklyLinks || []).map((l) => ` ${l.url} `).join('');
  // (Compared by path and query, decoded: the same page is written "pH%20and%20Buffers.html", "pH and Buffers.html" or
  // "/content/enforced/…" in different places.)
  const norm = (u) => {
    let s = String(u).replace(/&amp;/g, '&').replace(/^https?:\/\/[^/]+/i, '').replace(/[).,;:'"]+$/, '');
    try {
      s = decodeURIComponent(s);
    } catch {}
    return s.replace(/\s+/g, ' ').toLowerCase();
  };
  const seen = new Set();
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>\]`]+|(?<![\w.])\/(?:d2l|content)\/[^\s"'<>\]`]+/gi)) {
    const n = norm(m[0]);
    seen.add(n);
    seen.add(n.split('?')[0]);
  }
  // (A path with spaces in it, as content.md writes some: "/content/enforced/…/pH and Buffers.html".)
  const spaced = norm(text);
  let plat = /$^/;
  try {
    plat = require('./browser.cjs').SCHOOL_PLATFORMS;
  } catch {}
  const school = new Set(items.flatMap((it) => (it.links || []).map((l) => (String(l.url).match(/^https?:\/\/([^/]+)\/d2l\//) || [])[1]).filter(Boolean)));
  return (u) => {
    const n = norm(u);
    if (n.length > 1 && (seen.has(n) || (!n.includes('?') && spaced.includes(n)))) return true;
    const host = (String(u).match(/^https?:\/\/([^/:]+)/) || [])[1] || '';
    // (A lab platform's own pages, found by clicking through it, are fine; the class site's must have been seen.)
    return !school.has(host) && plat.test(host);
  };
}

/**
 * Take in a class's answer (data/guides/<CODE>/out.json: { guides: { [itemId]: guide } } or an array with `id`s):
 * clean each guide for an item that was asked about, stamp it with the item's hash, and save. Returns how many.
 */
async function apply(code, model = 'opus') {
  const d = dir(code);
  const out = path.join(d, 'out.json');
  if (!fs.existsSync(out)) return 0;
  const raw = readJson(out, null);
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.guides) ? raw.guides : raw?.guides && typeof raw.guides === 'object' ? Object.entries(raw.guides).map(([id, g]) => ({ ...g, id })) : [];
  const items = new Map((await current()).filter((it) => it.courseCode === code).map((it) => [it.id, it]));
  const ok = knownLinks(code, [...items.values()]);
  const patch = {};
  const at = new Date().toISOString();
  for (const g of list) {
    const it = items.get(String(g?.id || ''));
    // (A step's other work must be an item of this class Kea knows, never this one itself.)
    const c = it && clean(g, ok, (id) => id !== it.id && items.has(id));
    if (!c) continue;
    // (The hand-in page Kea knows for it wins over one Claude names, when it's a place of the work's own kind: a
    // discussion's topic, never a quiz.)
    const post = it.type === 'discussion' || it.type === 'peer_review';
    // (A peer review is done on its assignment page, Canvas's usual place, as well as in a discussion topic.)
    const fitting = (u) => (it.type === 'peer_review' ? /discussions\/topics\/\d|discussion_topics\/\d|dropbox|folder_submit|\/assignments\/\d/i.test(u) : post ? /discussions\/topics\/\d|discussion_topics\/\d/i.test(u) : /dropbox|folder_submit|discussions\/topics|quiz_summary|quizzing/i.test(u));
    const handIn = (it.links || []).find((l) => l.kind === 'submit' && fitting(l.url));
    if (handIn) c.submit.url = handIn.url;
    else if (post && c.submit.url && !fitting(c.submit.url)) c.submit.url = '';
    // A step never links the hand-in page (the panel's button opens it), nor a quiz in a discussion.
    const own = new Set([c.submit.url, ...(it.links || []).filter((l) => l.kind === 'submit').map((l) => l.url)].filter(Boolean));
    for (const s of c.steps) s.links = s.links.filter((l) => !own.has(l.url) && !(post && /quiz_summary|quizzing/i.test(l.url)));
    c.rubric = rubricFor(code, it);
    // A lab's procedure is kept for later runs (the platform doesn't change it).
    if (c.procedure.length > 400) {
      fs.mkdirSync(path.dirname(procedureFile(code, it.id)), { recursive: true });
      fs.writeFileSync(procedureFile(code, it.id), `# ${it.title}: procedure\n\n${c.procedure}\n`);
    }
    patch[it.id] = { ...c, title: it.title, hash: hashOf(it), at, model, v: GUIDE_V };
  }
  if (Object.keys(patch).length) study.saveGuides(patch);
  fs.renameSync(out, `${out}.applied-${Date.now()}`);
  return Object.keys(patch).length;
}

/** Guides for items that are gone from the calendar or finished long ago are dropped (the file stays small). */
async function prune() {
  const keep = new Set((await current()).map((it) => it.id));
  const all = study.guidesAll();
  const gone = Object.keys(all).filter((id) => !keep.has(id));
  if (gone.length) study.saveGuides(Object.fromEntries(gone.map((id) => [id, null])));
  return gone.length;
}

module.exports = { KINDS, FOCUS_KINDS, hashOf, needing, current, brief, clean, apply, prune, contentOutline, ownWork, rubricFor, _test: { marks, mentions, knownLinks } };
