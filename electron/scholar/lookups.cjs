// The Claude tab's way into the student's classes. Asked about class work while writing ("list the procedure for
// Lab 9", "what does the essay rubric want"), Claude first searches what Kea already has: the calendar's assignments,
// their guides, the class site's documents and downloaded files, and earlier lookups. When it isn't there, Claude sends
// a lookup: a Kea run (runner task `lookup`, skill kea-lookup) that reads the class site and its platforms (Science
// Interactive, ALEKS…) the way the guides run does, read-only, and writes what it found to a file. Every lookup is
// kept (data/lookups), so the next question finds it without going out again.
const fs = require('fs');
const path = require('path');
const profiles = require('./profiles.cjs');
const db = require('./db.cjs');
const study = require('./study.cjs');

const P = () => profiles.paths();
const root = () => path.join(P().workspace, 'data', 'lookups');
const indexFile = () => path.join(root(), 'index.json');
const rel = (f) => path.relative(P().workspace, f).replace(/\\/g, '/');
const readJson = (f, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return fallback;
  }
};
const iso = (d) => {
  const t = new Date(Date.now() + d * 864e5);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
};
const lookupsAll = () => readJson(indexFile(), []);

const STOP = new Set(['the', 'and', 'for', 'with', 'what', 'how', 'list', 'from', 'this', 'that', 'my', 'me', 'all', 'of', 'to', 'in', 'on', 'do', 'i', 'a', 'an', 'is', 'are', 'need', 'find', 'give', 'show', 'tell']);
const wordsOf = (q) =>
  String(q || '')
    .toLowerCase()
    .replace(/#/g, ' ')
    .split(/[^a-z0-9.]+/)
    .filter((w) => (w.length > 1 || /\d/.test(w)) && !STOP.has(w));

/** How well a text matches (0 when it doesn't): words in the title count most, a number must match as a whole. */
function score(words, title, body = '') {
  const t = ` ${String(title).toLowerCase()} `;
  const b = String(body).toLowerCase();
  let s = 0;
  for (const w of words) {
    const re = /^\d/.test(w) ? new RegExp(`(^|[^0-9.])${w.replace('.', '\\.')}([^0-9]|$)`) : null;
    if (re ? re.test(t) : t.includes(w)) s += 3;
    // ("Quiz 6" isn't "Quiz 1": a number the title doesn't carry counts against it.)
    else if (re && /\d/.test(t)) s -= 3;
    else if (re ? re.test(b) : b.includes(w)) s += 1;
  }
  return s;
}
const snippet = (text, words) => {
  const s = String(text || '');
  const low = s.toLowerCase();
  const at = Math.max(0, Math.min(...words.map((w) => low.indexOf(w)).filter((i) => i >= 0), s.length));
  return s.slice(Math.max(0, at - 120), at + 280).replace(/\s+/g, ' ').trim();
};

/** The text files Kea downloaded for a class (handouts, lists, platform pages it read), newest first. */
function downloads(code) {
  const out = [];
  const walk = (d, depth) => {
    let list = [];
    try {
      list = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      const f = path.join(d, e.name);
      if (e.isDirectory() && depth < 4) walk(f, depth + 1);
      else if (/\.(txt|md|html?)$/i.test(e.name)) out.push(f);
    }
  };
  walk(path.join(P().workspace, 'data', 'downloads', code), 0);
  return out;
}

/** Search everything Kea has on the student's classes. Returns [{ ref, kind, course, title, snippet, score }]. */
async function search(query, course = '') {
  const words = wordsOf(query);
  if (!words.length) return [];
  const want = String(course || '').toUpperCase().replace(/\s+/g, '');
  const ok = (code) => !want || String(code || '').toUpperCase().includes(want);
  const hits = [];
  const items = (await db.items(P().db, P().textbooks, {}, { from: iso(-200), to: iso(200) })).filter((i) => ok(i.courseCode) && !['weekly_reading', 'break', 'no_class'].includes(i.type));
  const guides = study.guidesAll();
  for (const i of items) {
    const g = guides[i.id];
    const body = `${i.description || ''} ${i.sourceWording || ''} ${g ? JSON.stringify(g) : ''}`;
    const s = score(words, `${i.courseCode} ${i.title}`, body);
    if (s >= words.length + 1) hits.push({ ref: `item:${i.id}`, kind: g ? 'assignment (with Kea guide)' : 'assignment', course: i.courseCode, title: `${i.title} (due ${i.date})`, snippet: snippet(g?.summary || i.description || '', words), score: s + 1 });
  }
  for (const l of lookupsAll()) {
    if (!ok(l.course) || !l.ok) continue;
    let text = '';
    try {
      text = fs.readFileSync(path.join(root(), l.id, 'answer.md'), 'utf8');
    } catch {
      continue;
    }
    const s = score(words, l.question, text);
    if (s >= words.length) hits.push({ ref: `lookup:${l.id}`, kind: `earlier lookup (${l.at.slice(0, 10)})`, course: l.course, title: l.question, snippet: snippet(text, words), score: s + 2 });
  }
  const codes = [...new Set(items.map((i) => i.courseCode))];
  for (const code of codes) {
    for (const f of downloads(code)) {
      let text = '';
      try {
        text = fs.readFileSync(f, 'utf8').slice(0, 400000);
      } catch {
        continue;
      }
      const s = score(words, path.basename(f).replace(/[_-]+/g, ' '), text);
      if (s >= words.length) hits.push({ ref: `file:${rel(f)}`, kind: 'downloaded file', course: code, title: rel(f), snippet: snippet(text, words), score: s });
    }
  }
  for (const s of await db.searchSources(P().db, words).catch(() => [])) {
    if (!ok(s.course)) continue;
    const sc = score(words, s.title, s.text);
    if (sc >= words.length) hits.push({ ref: `source:${s.id}`, kind: `class site ${s.type.replace(/^d2l_/, '').replace(/_/g, ' ')}`, course: s.course, title: s.title || s.type, snippet: snippet(s.text, words), score: sc });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 15);
}

/** One search result in full (an assignment written out, a document's text, a lookup's answer). */
async function read(ref) {
  const [kind, ...rest] = String(ref || '').split(':');
  const id = rest.join(':');
  if (kind === 'item') return (await require('./assignmentBrief.cjs').brief(id))?.text || 'That assignment isn’t on the calendar any more.';
  if (kind === 'lookup') {
    try {
      return fs.readFileSync(path.join(root(), id.replace(/[^\w-]/g, ''), 'answer.md'), 'utf8');
    } catch {
      return 'That lookup has no answer saved.';
    }
  }
  if (kind === 'file') {
    const f = path.resolve(P().workspace, id);
    if (!f.startsWith(path.join(P().workspace, 'data') + path.sep)) return 'Only Kea’s own class files can be read.';
    const text = fs.readFileSync(f, 'utf8');
    return text.length > 60000 ? `${text.slice(0, 60000)}\n[… ${text.length - 60000} more characters]` : text;
  }
  if (kind === 'source') {
    const s = await db.sourceText(P().db, id);
    return s ? `${s.title || s.type}${s.url ? ` (${s.url})` : ''}\n\n${s.text}` : 'That document isn’t in Kea any more.';
  }
  return 'Unknown reference.';
}

// ---------- Lookups: a run that goes and reads the class site ----------
const running = new Map();

/** The run's brief: the question, the class, the assignment it's about, and where the class keeps things. */
function writeRequest(id, req) {
  const d = path.join(root(), id);
  fs.mkdirSync(d, { recursive: true });
  const L = [`# Lookup ${id}`, '', `**The student asked:** ${req.question}`, ''];
  if (req.course) L.push(`**Class:** ${req.course}`);
  if (req.context) L.push('', '## What Kea already has on it', '', req.context.slice(0, 40000));
  try {
    const outline = require('./guides.cjs').contentOutline(req.course || '');
    if (outline) {
      fs.writeFileSync(path.join(d, 'content.md'), `# ${req.course}: the class site's content (modules, files, links)\n\n${outline}\n`);
      L.push('', `The class site's whole content outline, with every link: \`${rel(path.join(d, 'content.md'))}\`. Grep it for the page, file or platform link you need.`);
    }
  } catch {}
  const places = readJson(path.join(P().dir, 'platform-links.json'), {});
  const mine = Object.entries(places.byCourse || {}).filter(([c, list]) => (!req.course || c === req.course) && Array.isArray(list) && list.length);
  if (mine.length) L.push('', '## Outside platforms the class uses (open them through these links)', '', ...mine.flatMap(([c, list]) => list.slice(0, 20).map((l) => `- ${c}: ${l.name || ''} (${l.title || ''}) ${l.url || ''}`)));
  L.push('', `Write the answer to \`${rel(path.join(d, 'answer.md'))}\`.`);
  fs.writeFileSync(path.join(d, 'request.md'), L.join('\n'));
  fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ id, ...req, at: new Date().toISOString() }));
  return { brief: rel(path.join(d, 'request.md')), answer: path.join(d, 'answer.md') };
}

/** Send a lookup: { question, course?, context? }. Returns its id; `wait` gives the answer. */
async function start(req) {
  const runner = require('./runner.cjs');
  const id = `${Date.now().toString(36)}`;
  const q = { question: String(req.question || '').slice(0, 2000), course: String(req.course || '').toUpperCase().replace(/\s+/g, ''), context: String(req.context || '') };
  if (!q.question.trim()) throw new Error('Say what to look up.');
  const { brief, answer } = writeRequest(id, q);
  const entry = { id, question: q.question, course: q.course, at: new Date().toISOString(), ok: null };
  const p = runner.run('lookup', `${id} ${brief}`, 'manual', null, { front: true }).then((summary) => {
    const ok = fs.existsSync(answer) && fs.statSync(answer).size > 40;
    const list = lookupsAll().filter((l) => l.id !== id);
    list.unshift({ ...entry, ok });
    fs.mkdirSync(root(), { recursive: true });
    fs.writeFileSync(indexFile(), JSON.stringify(list.slice(0, 300), null, 1));
    return { ok, text: ok ? fs.readFileSync(answer, 'utf8') : '', summary: summary || '' };
  });
  running.set(id, p);
  return id;
}

/** The lookup's answer, waiting up to `ms`: { done, ok, text, summary, progress }. */
async function wait(id, ms = 240000) {
  const p = running.get(id);
  if (!p) {
    try {
      return { done: true, ok: true, text: fs.readFileSync(path.join(root(), String(id).replace(/[^\w-]/g, ''), 'answer.md'), 'utf8') };
    } catch {
      return { done: true, ok: false, text: '', summary: 'No such lookup.' };
    }
  }
  const r = await Promise.race([p, new Promise((res) => setTimeout(() => res(null), ms))]);
  if (!r) {
    const st = require('./runner.cjs').status();
    const mine = [st.running, ...(st.parallel || [])].find((e) => e && e.task === 'lookup' && String(e.arg || '').startsWith(id));
    const progress = mine ? (mine.steps || []).slice(-3).map((s) => s.message).join(' · ') || 'Reading the class site…' : st.running ? `Waiting for "${st.running.label}" to finish first.` : 'Queued.';
    return { done: false, progress };
  }
  running.delete(id);
  return { done: true, ...r };
}

module.exports = { search, read, start, wait, _test: { writeRequest } };
