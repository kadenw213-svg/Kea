// Kea's own morning pre-check, done in plain code before any Claude run: it asks D2L's data feeds what each class has
// right now (announcements, grades, assignment folders, quizzes, the content list), compares that with what it saw
// last time, and finds new class shells. Claude is started only for classes where something changed, and reads the
// answers Kea saved here instead of fetching them again. A quiet day uses no Claude at all.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const profiles = require('./profiles.cjs');
const browser = require('./browser.cjs');
const workspace = require('./workspace.cjs');
const db = require('./db.cjs');

const stateFile = () => path.join(profiles.paths().dir, 'precheck.json');
const readState = () => {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    return { courses: {}, lastFull: null };
  }
};
const hash = (v) => crypto.createHash('sha1').update(JSON.stringify(v)).digest('hex');
const day = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** The newest version D2L offers of each API product ("le" for learning tools, "lp" for the platform). */
async function versions() {
  const r = await browser.getJson('/d2l/api/versions/');
  const out = { le: '1.74', lp: '1.47' };
  for (const p of r.data || []) if (p.ProductCode in out && p.LatestVersion) out[p.ProductCode] = p.LatestVersion;
  return out;
}

/** Every page of a D2L list that pages with a bookmark (enrollments). */
async function allPages(rel) {
  const items = [];
  let bookmark = '';
  for (let i = 0; i < 20; i++) {
    const r = await browser.getJson(rel + (bookmark ? `&bookmark=${encodeURIComponent(bookmark)}` : ''));
    if (!r.data) return r.status === 200 ? items : null;
    items.push(...(r.data.Items || []));
    if (!r.data.PagingInfo?.HasMoreItems) break;
    bookmark = r.data.PagingInfo.Bookmark;
  }
  return items;
}

/**
 * What each area looks like, reduced to the parts that matter (so a changed view counter doesn't count as news).
 * `key` names each entry for the "what's new" summary.
 */
const AREAS = {
  news: {
    rel: (v, ou) => `/d2l/api/le/${v.le}/${ou}/news/`,
    list: (d) => (Array.isArray(d) ? d : []).filter((n) => !n.IsHidden),
    entry: (n) => ({ id: n.Id, title: n.Title, at: n.LastModifiedDate || n.StartDate, body: hash(n.Body?.Text || n.Body?.Html || '') }),
    label: 'announcement'
  },
  grades: {
    rel: (v, ou) => `/d2l/api/le/${v.le}/${ou}/grades/values/myGradeValues/`,
    list: (d) => (Array.isArray(d) ? d : []),
    entry: (g) => ({ id: g.GradeObjectIdentifier, title: g.GradeObjectName, grade: g.DisplayedGrade, points: g.PointsNumerator, comment: hash(g.Comments?.Text || '') }),
    label: 'grade'
  },
  final: {
    rel: (v, ou) => `/d2l/api/le/${v.le}/${ou}/grades/final/values/myGradeValue`,
    list: (d) => (d ? [d] : []),
    entry: (g) => ({ id: 'final', title: 'Overall grade', grade: g.DisplayedGrade }),
    label: 'overall grade'
  },
  dropbox: {
    rel: (v, ou) => `/d2l/api/le/${v.le}/${ou}/dropbox/folders/`,
    list: (d) => (Array.isArray(d) ? d : []).filter((f) => !f.IsHidden),
    entry: (f) => ({ id: f.Id, title: f.Name, due: f.DueDate, start: f.Availability?.StartDate, end: f.Availability?.EndDate }),
    label: 'assignment'
  },
  quizzes: {
    rel: (v, ou) => `/d2l/api/le/${v.le}/${ou}/quizzes/`,
    list: (d) => (d?.Objects || []).filter((q) => q.IsActive !== false),
    entry: (q) => ({ id: q.QuizId, title: q.Name, due: q.DueDate, start: q.StartDate, end: q.EndDate }),
    label: 'quiz'
  },
  content: {
    rel: (v, ou) => `/d2l/api/le/${v.le}/${ou}/content/toc`,
    list: (d) => {
      const out = [];
      const walk = (mods) => {
        for (const m of mods || []) {
          if (m.IsHidden) continue;
          for (const t of m.Topics || []) if (!t.IsHidden) out.push({ ...t, module: m.Title });
          walk(m.Modules);
        }
      };
      walk(d?.Modules);
      return out;
    },
    entry: (t) => ({ id: t.TopicId ?? t.Identifier, title: `${t.module}: ${t.Title}`, at: t.LastModifiedDate, due: t.DueDate }),
    label: 'content page'
  }
};

/** What changed in one area since last time, in words: "2 new announcements: Exam 3 moved; Lab 8 notes". */
function describe(area, before, now) {
  const old = new Map((before || []).map((e) => [String(e.id), e]));
  const added = now.filter((e) => !old.has(String(e.id)));
  const changed = now.filter((e) => old.has(String(e.id)) && hash(old.get(String(e.id))) !== hash(e));
  const names = (list) => list.slice(0, 6).map((e) => e.title).join('; ') + (list.length > 6 ? `; and ${list.length - 6} more` : '');
  const parts = [];
  if (added.length) parts.push(`${added.length} new ${AREAS[area].label}${added.length > 1 ? 's' : ''}: ${names(added)}`);
  if (changed.length) parts.push(`${changed.length} changed ${AREAS[area].label}${changed.length > 1 ? 's' : ''}: ${names(changed)}`);
  return parts;
}

/**
 * The pre-check. Returns { signedIn, dir, newShells, changed: {CODE: [what changed]}, quiet: [CODE], full, commit() }.
 * `commit()` saves what was seen as the new baseline: call it only after the Claude run that handled it succeeded,
 * so a failed run is retried tomorrow instead of being forgotten.
 */
async function run({ fullEveryDays = 3, force = false } = {}) {
  const st = await browser.status();
  if (!st.setUp) return { signedIn: false, setUp: false };
  const p = profiles.paths();
  const dir = path.join(p.workspace, 'data', 'digests', 'kea-precheck', day());
  fs.mkdirSync(dir, { recursive: true });
  const save = (name, data) => fs.writeFileSync(path.join(dir, name), JSON.stringify(data, null, 1));

  const v = await versions();
  // A request that needs a signed-in student: when the session has expired, Kea signs in here (with the saved login,
  // or by showing its window), exactly as it would for a scan.
  if (!st.signedIn) await browser.getJson(`/d2l/api/lp/${v.lp}/users/whoami`).catch(() => null);
  if (!(await browser.status()).signedIn) return { signedIn: false, setUp: true };

  // New class shells: the engine decides which enrollments are real, not-yet-imported classes.
  let newShells = [];
  const enrollments = await allPages(`/d2l/api/lp/${v.lp}/enrollments/myenrollments/?orgUnitTypeId=3`);
  if (enrollments) {
    const file = path.join(p.workspace, 'data', 'digests', `enrollments-${day()}.json`);
    fs.writeFileSync(file, JSON.stringify({ Items: enrollments }));
    const uv = await workspace.findUv();
    const r = await workspace.runHidden(uv, ['run', 'academic-sync', 'shells-check', '--file', file], { cwd: p.workspace, env: workspace.engineEnv(uv) });
    try {
      newShells = JSON.parse(r.out.slice(r.out.indexOf('[')));
    } catch {}
  }

  const state = readState();
  const next = { courses: { ...state.courses }, lastFull: state.lastFull };
  const full = force || !state.lastFull || (Date.now() - new Date(state.lastFull).getTime()) / 864e5 >= fullEveryDays - 0.1;
  const changed = {};
  const quiet = [];
  for (const c of await db.watchList(p.db)) {
    const before = state.courses[c.code] || {};
    const seen = {};
    const reasons = [];
    for (const [area, a] of Object.entries(AREAS)) {
      let r;
      try {
        r = await browser.getJson(a.rel(v, c.ou));
      } catch (err) {
        reasons.push(`couldn't check ${area} (${String(err.message || err).slice(0, 80)})`);
        continue;
      }
      // Areas a class doesn't use, or students can't list, answer 403/404: nothing to watch there.
      if (r.status === 403 || r.status === 404) continue;
      if (!r.data) {
        reasons.push(`couldn't check ${area} (D2L answered ${r.status})`);
        continue;
      }
      save(`${c.code}-${area}.json`, r.data);
      seen[area] = a.list(r.data).map(a.entry);
      if (before[area]) reasons.push(...describe(area, before[area], seen[area]));
      else if (Object.keys(before).length) reasons.push(`first look at ${area}`);
    }
    next.courses[c.code] = { ...before, ...seen };
    if (!Object.keys(before).length) reasons.unshift('first check by Kea');
    if (reasons.length || full) changed[c.code] = reasons.length ? reasons : ['regular full check (messages and outside platforms)'];
    else quiet.push(c.code);
  }
  if (full) next.lastFull = new Date().toISOString();
  save('summary.json', { checked: new Date().toISOString(), full, changed, quiet, newShells });
  await refreshSubmissions(dir, v, await db.watchList(p.db)).catch((err) => console.error('Submissions', err));
  const ous = Object.fromEntries((await db.watchList(p.db)).map((c) => [c.code, c.ou]));
  updateGrades(dir, ous);
  updateInbox(dir, ous);
  return {
    signedIn: true,
    setUp: true,
    dir: path.relative(p.workspace, dir),
    newShells,
    changed,
    quiet,
    full,
    commit: () => fs.writeFileSync(stateFile(), JSON.stringify(next))
  };
}

// ---------- What's been handed in (so "missing" means missing) ----------
const submissionsFile = () => path.join(profiles.paths().dir, 'submissions.json');

/**
 * From the answers the pre-check saved: every graded item counts as handed in, and each assignment folder due in the
 * last four weeks (or the next two) is asked whether it has a submission from the student. Saved per class as
 * { title, state: 'graded' | 'submitted' | 'not_submitted' } for Kea's calendar to match against its items.
 */
async function refreshSubmissions(dir, v, list) {
  let prev = {};
  try {
    prev = JSON.parse(fs.readFileSync(submissionsFile(), 'utf8')).byCourse || {};
  } catch {}
  const byCourse = {};
  const now = Date.now();
  for (const c of list) {
    const out = [];
    const read = (area) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, `${c.code}-${area}.json`), 'utf8'));
      } catch {
        return null;
      }
    };
    for (const g of AREAS.grades.list(read('grades'))) {
      if (g.PointsNumerator != null || (g.DisplayedGrade && String(g.DisplayedGrade).trim() && !/^-+$/.test(g.DisplayedGrade))) out.push({ title: g.GradeObjectName, state: 'graded' });
    }
    const known = new Map((prev[c.code] || []).filter((x) => x.folder).map((x) => [x.folder, x]));
    for (const f of AREAS.dropbox.list(read('dropbox'))) {
      const due = f.DueDate ? new Date(f.DueDate).getTime() : null;
      if (!due || due < now - 28 * 864e5 || due > now + 14 * 864e5) {
        if (known.has(f.Id)) out.push(known.get(f.Id));
        continue;
      }
      // Once handed in, it stays handed in: no need to ask again.
      if (known.get(f.Id)?.state === 'submitted') {
        out.push(known.get(f.Id));
        continue;
      }
      const r = await browser.getJson(`/d2l/api/le/${v.le}/${c.ou}/dropbox/folders/${f.Id}/submissions/mysubmissions/`).catch(() => null);
      if (!r?.data) continue;
      const subs = (Array.isArray(r.data) ? r.data : []).flatMap((e) => e.Submissions || []);
      if (subs.length) out.push({ title: f.Name, folder: f.Id, state: 'submitted', at: subs[subs.length - 1].SubmissionDate });
      else if (due < now) out.push({ title: f.Name, folder: f.Id, state: 'not_submitted' });
    }
    byCourse[c.code] = out;
  }
  fs.writeFileSync(submissionsFile(), JSON.stringify({ checked: new Date().toISOString(), byCourse }));
}

// ---------- The Inbox: announcements, straight from D2L (no Claude) ----------
const inboxFile = () => path.join(profiles.paths().dir, 'inbox.json');
const readInbox = () => {
  try {
    return JSON.parse(fs.readFileSync(inboxFile(), 'utf8'));
  } catch {
    return { items: [], seeded: false };
  }
};
const plain = (html) =>
  String(html || '')
    .replace(/<(br|\/p|\/div|\/li|\/h\d)[^>]*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/**
 * Merge the announcements the pre-check just saved into the Inbox. New ones raise a Windows notification, except on
 * the very first check (when every old announcement would otherwise pop up at once).
 */
function updateInbox(dir, ous = {}) {
  const box = readInbox();
  const known = new Map(box.items.map((i) => [i.id, i]));
  const home = browser.schoolInfo().home;
  const fresh = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('-news.json'))) {
    const code = f.replace(/-news\.json$/, '');
    let list;
    try {
      list = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch {
      continue;
    }
    const ou = ous[code];
    for (const n of Array.isArray(list) ? list : []) {
      if (n.IsHidden) continue;
      const id = `news:${code}:${n.Id}`;
      const at = n.StartDate || n.CreatedDate || n.LastModifiedDate;
      const body = plain(n.Body?.Html || n.Body?.Text);
      const prev = known.get(id);
      const changed = prev && (prev.body !== body || prev.title !== n.Title);
      const url = home && n.Id && ou ? new URL(`/d2l/le/news/${ou}/${n.Id}/view?ou=${ou}`, home).href : '';
      const item = { id, kind: 'announcement', course: code, title: n.Title || 'Announcement', body, at, url, read: prev ? prev.read && !changed : !box.seeded ? true : false, updated: !!changed };
      if (!prev || changed) fresh.push(item);
      known.set(id, item);
    }
  }
  const items = [...known.values()].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 500);
  fs.writeFileSync(inboxFile(), JSON.stringify({ items, seeded: true }));
  if (box.seeded && fresh.length) {
    const { Notification, BrowserWindow } = require('electron');
    for (const n of fresh.slice(0, 5)) if (Notification.isSupported()) new Notification({ title: `${n.course}: ${n.title}`, body: n.body.slice(0, 200) }).show();
    BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('scholar:news', { course: '', title: '', body: '' }));
  }
}

/**
 * A light check for new announcements between daily checks: one request per class, only while Kea is already signed
 * in (it never opens a sign-in window for this), and no Claude.
 */
async function pollAnnouncements() {
  const st = await browser.status();
  if (!st.signedIn) return false;
  const p = profiles.paths();
  const dir = path.join(p.workspace, 'data', 'digests', 'kea-inbox');
  fs.mkdirSync(dir, { recursive: true });
  const v = await versions();
  const list = await db.watchList(p.db);
  for (const c of list) {
    for (const area of ['news', 'grades', 'final', 'dropbox']) {
      const r = await browser.getJson(AREAS[area].rel(v, c.ou)).catch(() => null);
      if (r?.data) fs.writeFileSync(path.join(dir, `${c.code}-${area}.json`), JSON.stringify(r.data));
    }
  }
  const ous = Object.fromEntries(list.map((c) => [c.code, c.ou]));
  updateGrades(dir, ous);
  updateInbox(dir, ous);
  await updateAlerts(list).catch((err) => console.error('Alerts', err));
  return true;
}

// ---------- Messages and replies: the class site's own alert menus ----------
/**
 * D2L's home page has alert menus: messages (the envelope) and updates (the bell: replies to your posts, feedback,
 * new grades). Kea reads them the way the page does and turns each new entry into an Inbox item and a notification.
 */
const ALERT_KINDS = [
  { cat: 1, kind: 'message', label: 'Message' },
  { cat: 2, kind: 'update', label: 'Update' },
  { cat: 0, kind: 'update', label: 'Update' }
];

/** Entries in an alert menu's HTML: { text, url, at }. */
function parseAlerts(html, home) {
  const out = [];
  for (const m of String(html || '').matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)) {
    const inner = m[1];
    const text = plain(inner).replace(/\s+\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
    if (!text || text.length < 4 || /no (new )?(alerts|messages|updates)/i.test(text)) continue;
    const href = (inner.match(/href="([^"]+)"/i) || [])[1] || '';
    const at = (inner.match(/data-date="([^"]+)"|title="([^"]*\d{4}[^"]*)"/i) || []).slice(1).find(Boolean) || '';
    let url = '';
    try {
      url = href && !href.startsWith('javascript') ? new URL(href.replace(/&amp;/g, '&'), home).href : '';
    } catch {}
    out.push({ text, url, at });
  }
  return out;
}

async function updateAlerts(list) {
  const home = browser.schoolInfo().home;
  const homeOu = (home.match(/\/d2l\/home\/(\d+)/) || [])[1];
  if (!home || !homeOu) return;
  const box = readInbox();
  const known = new Set(box.items.map((i) => i.id));
  const fresh = [];
  for (const k of ALERT_KINDS) {
    const r = await browser
      .fetchText(new URL(`/d2l/MiniBar/${homeOu}/ActivityFeed/GetAlertsDaylight?Category=${k.cat}&_d2l_prc%24headingLevel=2&_d2l_prc%24scope=&_d2l_prc%24hasActiveForm=false&isXhr=true&requestId=1`, home).href)
      .catch(() => null);
    if (!r || r.status !== 200) continue;
    // D2L answers these with a small JSON wrapper around the menu's HTML.
    let html = r.text;
    try {
      const j = JSON.parse(r.text.replace(/^while\(1\);/, ''));
      html = j.Payload?.Html || j.Html || html;
    } catch {}
    for (const a of parseAlerts(html, home)) {
      const id = `alert:${k.kind}:${crypto.createHash('sha1').update(a.text).digest('hex').slice(0, 16)}`;
      if (known.has(id)) continue;
      known.add(id);
      const [first, ...rest] = a.text.split('\n');
      const course = list.find((c) => a.text.includes(c.code))?.code || '';
      fresh.push({ id, kind: 'news', course, title: first.slice(0, 160), body: rest.join('\n').trim() || first, at: a.at || new Date().toISOString(), url: a.url, read: !box.seeded });
    }
  }
  if (!fresh.length) return;
  box.items = [...fresh, ...box.items].sort((x, y) => String(y.at).localeCompare(String(x.at))).slice(0, 500);
  fs.writeFileSync(inboxFile(), JSON.stringify({ ...box, seeded: true }));
  if (box.seeded) {
    const { Notification } = require('electron');
    for (const n of fresh.slice(0, 5)) if (Notification.isSupported()) new Notification({ title: n.course ? `${n.course}: ${n.title}` : n.title, body: n.body.slice(0, 200) }).show();
  }
}

// ---------- Grades (from D2L directly) ----------
const gradesFile = () => path.join(profiles.paths().dir, 'grades.json');
const readGrades = () => {
  try {
    return JSON.parse(fs.readFileSync(gradesFile(), 'utf8'));
  } catch {
    return { byCourse: {}, seeded: false };
  }
};

/** Each class's overall grade and graded items. A newly graded item goes to the Inbox (and a notification). */
function updateGrades(dir, ous) {
  const old = readGrades();
  const byCourse = { ...old.byCourse };
  const fresh = [];
  const home = browser.schoolInfo().home;
  for (const code of Object.keys(ous)) {
    let items, final;
    try {
      items = JSON.parse(fs.readFileSync(path.join(dir, `${code}-grades.json`), 'utf8'));
    } catch {
      continue;
    }
    try {
      final = JSON.parse(fs.readFileSync(path.join(dir, `${code}-final.json`), 'utf8'));
    } catch {}
    const was = new Map((old.byCourse[code]?.items || []).map((g) => [g.id, g]));
    const list = (Array.isArray(items) ? items : [])
      .filter((g) => g.PointsNumerator != null || (g.DisplayedGrade && !/^-+$/.test(String(g.DisplayedGrade).trim())))
      .map((g) => ({
        id: String(g.GradeObjectIdentifier),
        title: g.GradeObjectName,
        score: g.PointsDenominator ? `${+(+g.PointsNumerator).toFixed(2)} / ${+g.PointsDenominator}` : '',
        percent: g.PointsDenominator ? Math.round((g.PointsNumerator / g.PointsDenominator) * 1000) / 10 : null,
        shown: String(g.DisplayedGrade || '').trim(),
        comment: (g.Comments?.Text || '').trim(),
        at: g.LastModified || null
      }));
    for (const g of list) {
      const p = was.get(g.id);
      if (!p || p.score !== g.score || p.comment !== g.comment) fresh.push({ code, g, updated: !!p });
    }
    const pct = final?.PointsDenominator ? Math.round((final.PointsNumerator / final.PointsDenominator) * 1000) / 10 : null;
    byCourse[code] = { final: final ? { shown: String(final.DisplayedGrade || '').trim(), percent: pct } : old.byCourse[code]?.final || null, items: list, url: home && ous[code] ? new URL(`/d2l/lms/grades/my_grades/main.d2l?ou=${ous[code]}`, home).href : '', checked: new Date().toISOString() };
  }
  fs.writeFileSync(gradesFile(), JSON.stringify({ byCourse, seeded: true }));
  if (!old.seeded || !fresh.length) return;
  // New grades show in the Inbox like announcements.
  const box = readInbox();
  for (const { code, g, updated } of fresh) {
    box.items.unshift({ id: `grade:${code}:${g.id}:${g.score}`, kind: 'grade', course: code, title: `${updated ? 'Grade updated' : 'New grade'}: ${g.title}`, body: [g.score || g.shown, g.percent != null ? `(${g.percent}%)` : '', g.comment ? `\n\n${g.comment}` : ''].join(' ').trim(), at: g.at || new Date().toISOString(), url: byCourse[code].url, read: false });
  }
  fs.writeFileSync(inboxFile(), JSON.stringify({ ...box, items: box.items.slice(0, 500) }));
  const { Notification } = require('electron');
  for (const { code, g } of fresh.slice(0, 5)) if (Notification.isSupported()) new Notification({ title: `${code}: new grade`, body: `${g.title}: ${g.score || g.shown}${g.percent != null ? ` (${g.percent}%)` : ''}` }).show();
}

function markInboxRead(ids) {
  const box = readInbox();
  for (const i of box.items) if (!ids || ids.includes(i.id)) i.read = true;
  fs.writeFileSync(inboxFile(), JSON.stringify(box));
}

/**
 * Where work can be handed in: every class's assignment folders (from Kea's latest look at the class site), with
 * their due dates and whether something is already handed in. Soonest due first; closed folders last.
 */
async function handInTargets() {
  const p = profiles.paths();
  const base = path.join(p.workspace, 'data', 'digests');
  const dirs = [path.join(base, 'kea-inbox')];
  try {
    dirs.push(...fs.readdirSync(path.join(base, 'kea-precheck')).sort().reverse().map((d) => path.join(base, 'kea-precheck', d)));
  } catch {}
  let sub = {};
  try {
    sub = JSON.parse(fs.readFileSync(submissionsFile(), 'utf8')).byCourse || {};
  } catch {}
  const now = Date.now();
  const out = [];
  for (const c of await db.watchList(p.db)) {
    const dir = dirs.find((d) => fs.existsSync(path.join(d, `${c.code}-dropbox.json`)));
    if (!dir) continue;
    let folders = [];
    try {
      folders = AREAS.dropbox.list(JSON.parse(fs.readFileSync(path.join(dir, `${c.code}-dropbox.json`), 'utf8')));
    } catch {}
    const done = new Set((sub[c.code] || []).filter((x) => x.state === 'submitted').map((x) => x.folder));
    const list = folders
      .map((f) => {
        const end = f.Availability?.EndDate ? new Date(f.Availability.EndDate).getTime() : null;
        return { id: f.Id, name: f.Name, due: f.DueDate || null, closed: !!(end && end < now), submitted: done.has(f.Id) };
      })
      .sort((a, b) => Number(a.closed) - Number(b.closed) || Math.abs(new Date(a.due || 8e15) - now) - Math.abs(new Date(b.due || 8e15) - now));
    out.push({ code: c.code, ou: c.ou, folders: list });
  }
  return out;
}

module.exports = { run, pollAnnouncements, readInbox, markInboxRead, readGrades, handInTargets };
