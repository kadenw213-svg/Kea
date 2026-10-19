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
const { compact, htmlToText } = require('./compact.cjs');

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
 * A D2L answer with every page: lists like quizzes come 20 at a time with a `Next` address for the rest (CHE1011's
 * Final Exam and Practice Final were past the first page, so Kea never saw them).
 */
async function getAll(rel) {
  const r = await browser.getJson(rel);
  if (!r?.data || !Array.isArray(r.data.Objects)) return r;
  const objects = [...r.data.Objects];
  let next = r.data.Next;
  for (let i = 0; next && i < 20; i++) {
    let more;
    try {
      const u = new URL(next, browser.schoolInfo().home);
      more = await browser.getJson(u.pathname + u.search);
    } catch {
      break;
    }
    if (!more?.data || !Array.isArray(more.data.Objects)) break;
    objects.push(...more.data.Objects);
    next = more.data.Next;
  }
  return { ...r, data: { ...r.data, Objects: objects, Next: null } };
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
  // Discussion topics (graded "online assignments" are often discussions): every forum's topics, with their dates.
  discussions: {
    rel: (v, ou) => `/d2l/api/le/${v.le}/${ou}/discussions/forums/`,
    expand: async (v, ou, forums) => {
      const out = [];
      for (const f of (Array.isArray(forums) ? forums : []).filter((x) => !x.IsHidden).slice(0, 40)) {
        const r = await browser.getJson(`/d2l/api/le/${v.le}/${ou}/discussions/forums/${f.ForumId}/topics/`).catch(() => null);
        for (const t of Array.isArray(r?.data) ? r.data : []) out.push({ ...t, ForumName: f.Name });
      }
      return out;
    },
    list: (d) => (Array.isArray(d) ? d : []).filter((t) => !t.IsHidden),
    entry: (t) => ({ id: t.TopicId, title: `${t.ForumName}: ${t.Name}`, due: t.DueDate ?? null, start: t.StartDate ?? t.UnlockStartDate ?? null, end: t.EndDate ?? t.UnlockEndDate ?? null, points: t.ScoreOutOf ?? null, grade: t.GradeItemId ?? null }),
    label: 'discussion topic'
  },
  calendar: {
    rel: (v, ou) => {
      const from = new Date(Date.now() - 7 * 864e5).toISOString();
      const to = new Date(Date.now() + 240 * 864e5).toISOString();
      return `/d2l/api/le/${v.le}/${ou}/calendar/events/myEvents/?startDateTime=${from}&endDateTime=${to}`;
    },
    // Only what's still ahead: events dropping out of the window as days pass aren't changes.
    list: (d) => (Array.isArray(d) ? d : d?.Objects || []).filter((e) => new Date(e.EndDateTime || e.StartDateTime || 0) >= new Date(Date.now() - 864e5)),
    entry: (e) => ({ id: e.CalendarEventId, title: e.Title, start: e.StartDateTime, end: e.EndDateTime }),
    label: 'calendar date'
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
    // (Table-of-contents topics carry open and close dates and the graded tool they launch, not a due date.)
    entry: (t) => ({ id: t.TopicId ?? t.Identifier, title: `${t.module}: ${t.Title}`, at: t.LastModifiedDate, due: t.DueDate ?? null, start: t.StartDateTime ?? null, end: t.EndDateTime ?? null, tool: t.ToolId ?? null, grade: t.GradeItemId ?? null }),
    label: 'content page'
  }
};

/**
 * Graded work the student can't see: a grade category that counts more points than the graded items listed under it
 * (D2L lists each category followed by its items). CHE1011's Lab Reports read 10 / 155 while the lab items shown
 * added up to 30: 125 points of lab reports, done on an outside lab site with their D2L folders hidden, were counting
 * as zeros and nothing on Kea's calendar said they existed. Returns [{ category, counted, visible, hidden }].
 */
function hiddenWork(values) {
  const out = [];
  let cat = null;
  const close = () => {
    if (cat && cat.counted - cat.visible > 0.5) out.push({ category: cat.category, counted: cat.counted, visible: cat.visible, hidden: Math.round((cat.counted - cat.visible) * 100) / 100 });
  };
  for (const g of Array.isArray(values) ? values : []) {
    if (g.GradeObjectType === 9 || /category/i.test(g.GradeObjectTypeName || '')) {
      close();
      cat = g.PointsDenominator ? { category: String(g.GradeObjectName || '').trim(), counted: +g.PointsDenominator, visible: 0 } : null;
    } else if (cat && g.PointsDenominator) cat.visible += +g.PointsDenominator;
  }
  close();
  return out;
}
const hiddenWords = (h) => `the "${h.category}" grade category counts ${h.counted} points, but the graded items you can see under it add up to ${h.visible}: ${h.hidden} points of work you can't see are counting (hidden assignments, an outside platform, or zeros not shown yet)`;

// ---------- Outside platforms: every one a class links to, and when Kea last read it ----------
// Platforms where graded work (and its due dates) can live outside D2L. A class linking to one that no scan has opened
// in a week is a reason for the daily check to open it and match its assignments to the calendar: the CHE1011 lab
// reports lived on Science Interactive and were lost because nothing ever looked there.
const PLATFORM_KINDS = [
  { re: /aleks/i, host: 'aleks.com', name: 'ALEKS' },
  { re: /science ?interactive|holscience|\bhol\b|myhol/i, host: 'holscience.com', name: 'Science Interactive' },
  { re: /simple ?syllabus/i, host: 'simplesyllabus.com', name: 'Simple Syllabus' },
  { re: /connect|mcgraw|mheducation/i, host: 'mheducation.com', name: 'McGraw Hill Connect' },
  { re: /pearson|mylab|mastering/i, host: 'pearson.com', name: 'Pearson' },
  { re: /cengage|webassign|mindtap/i, host: 'cengage.com', name: 'Cengage' },
  { re: /zybooks/i, host: 'zybooks.com', name: 'zyBooks' },
  { re: /perusall/i, host: 'perusall.com', name: 'Perusall' },
  { re: /wileyplus|wiley/i, host: 'wiley.com', name: 'Wiley' },
  { re: /macmillan|achieve/i, host: 'macmillanlearning.com', name: 'Macmillan' },
  { re: /labster/i, host: 'labster.com', name: 'Labster' }
];
/** The outside platforms a class's content links to: [{ name, host, launch, title }]. */
function classPlatforms(toc) {
  const found = new Map();
  const walk = (mods) => {
    for (const m of mods || []) {
      if (m.IsHidden) continue;
      for (const t of m.Topics || []) {
        if (t.IsHidden) continue;
        const text = `${t.Title || ''} ${t.Url || ''}`;
        const lti = t.ActivityType === 7 || /type=lti|\/lti\//i.test(t.Url || '');
        // (A publisher's video or media file is something to watch, not a place work is assigned.)
        if (!lti && /:\/\/(media|video|player|cdn)[.-]|\.(mp4|mp3|pdf)(\?|$)/i.test(t.Url || '')) continue;
        const kind = PLATFORM_KINDS.find((k) => k.re.test(text));
        if (kind && (lti || /^https?:/i.test(t.Url || '')) && !found.has(kind.host)) found.set(kind.host, { ...kind, re: undefined, launch: t.Url || '', title: t.Title || '' });
      }
      walk(m.Modules);
    }
  };
  walk(toc?.Modules);
  return [...found.values()];
}
const lastRead = (host) =>
  Object.entries(browser.platformsRead())
    .filter(([h]) => h === host || h.endsWith(`.${host}`))
    .map(([, at]) => at)
    .sort()
    .pop() || null;

/** What changed in one area since last time, in words: "2 new announcements: Exam 3 moved; Lab 8 notes". */
function describe(area, before, now, label = AREAS[area].label) {
  const old = new Map((before || []).map((e) => [String(e.id), e]));
  const added = now.filter((e) => !old.has(String(e.id)));
  const changed = now.filter((e) => old.has(String(e.id)) && hash(old.get(String(e.id))) !== hash(e));
  const names = (list) => list.slice(0, 6).map((e) => e.title).join('; ') + (list.length > 6 ? `; and ${list.length - 6} more` : '');
  const parts = [];
  if (added.length) parts.push(`${added.length} new ${label}${added.length > 1 ? 's' : ''}: ${names(added)}`);
  if (changed.length) parts.push(`${changed.length} changed ${label}${changed.length > 1 ? 's' : ''}: ${names(changed)}`);
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
  const save = (name, data) => {
    fs.writeFileSync(path.join(dir, name), JSON.stringify(data, null, 1));
    // Claude reads the trimmed copy (a third of the size); Kea's own code reads the full answer.
    if (name !== 'summary.json') fs.writeFileSync(path.join(dir, name.replace(/\.json$/, '.min.json')), JSON.stringify(compact(data, browser.schoolInfo().home)));
  };

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
        r = await getAll(a.rel(v, c.ou));
        if (a.expand && r?.data) r = { ...r, data: await a.expand(v, c.ou, r.data) };
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
      // Points counting for work that isn't listed: the daily check finds out what it is when it first appears or
      // grows (the folders usually stay hidden, so the same gap isn't sent to Claude again every day).
      if (area === 'grades') {
        seen.hiddenWork = hiddenWork(r.data);
        const was = new Map((before.hiddenWork || []).map((h) => [h.category, h.hidden]));
        for (const h of seen.hiddenWork) if (was.get(h.category) !== h.hidden) reasons.push(`Hidden graded work: ${hiddenWords(h)}. Find what it is (course schedule, outside platform, hidden folders), make sure every piece is on the calendar, and tell the student which ones are missing`);
      }
    }
    // Everything D2L lists matched to the calendar (Kea's own check, no Claude), each item's D2L instructions and
    // rubric copied into its details (kept current when the instructor edits them); a missing or misdated item is a
    // reason for today's check to fix it, when it's new (an open one isn't re-sent every day; it's in the Inbox).
    try {
      const uv = await workspace.findUv();
      const rr = await workspace.runHidden(uv, ['run', 'academic-sync', 'd2l-reconcile', '--course', c.code, '--dir', dir, '--fill-instructions', '--json'], { cwd: p.workspace, env: workspace.engineEnv(uv) });
      const rec = JSON.parse(rr.out.slice(rr.out.indexOf('{')));
      const found = [...(rec.unmatched || []).map((u) => `${u.kind} "${u.title}" (${u.d2l_date || 'no date'}) isn't on the calendar [${u.key}]`), ...(rec.drift || []).map((d) => `"${d.title}" is on the calendar for ${d.item_date} but D2L says ${d.d2l_date} [${d.key}]`)];
      seen.reconcile = found;
      const was = new Set(before.reconcile || []);
      const fresh = found.filter((f) => !was.has(f));
      if (fresh.length) reasons.push(`D2L lists graded work the calendar doesn't match: ${fresh.slice(0, 8).join('; ')}. Add each one (extract it from a file with the D2L wording and date), correct its date, or dismiss it with coverage-dismiss --key <key> and the reason`);
    } catch (err) {
      console.error('Reconcile', err);
    }
    // Outside platforms this class uses that no scan has read in a week (asked once a week per platform).
    try {
      const toc = JSON.parse(fs.readFileSync(path.join(dir, `${c.code}-content.json`), 'utf8'));
      const told = { ...(before.platformTold || {}) };
      const plats = classPlatforms(toc);
      seen.platforms = plats.map((pl) => ({ name: pl.name, host: pl.host, launch: pl.launch, last: lastRead(pl.host) }));
      for (const pl of seen.platforms) {
        const stale = !pl.last || Date.now() - Date.parse(pl.last) > 7 * 864e5;
        const recently = told[pl.host] && Date.now() - Date.parse(told[pl.host]) < 7 * 864e5;
        if (stale && !recently) {
          reasons.push(`Outside platform not checked ${pl.last ? `since ${pl.last.slice(0, 10)}` : 'yet'}: ${pl.name} (${pl.host}). Open it with d2l_open through the class's own link (${pl.launch || 'find it in the course content'}), read its assignment list with due dates (and status), and make sure every one is on the calendar with the platform's date; if it needs its own sign-in, tell the student`);
          told[pl.host] = new Date().toISOString();
        }
      }
      seen.platformTold = told;
    } catch {}
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
  const deleted = new Set(box.deleted || []);
  // A class seen for the first time brings its history in as already read, without notifications (only what's new
  // from then on is news), and nothing older than two weeks ever counts as new.
  const seenCourses = new Set(box.items.map((i) => i.course));
  const isOld = (at) => !at || Date.now() - new Date(at).getTime() > 14 * 864e5;
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
      // Deleted by the student: it stays gone, even though the class site still lists it.
      if (deleted.has(id)) continue;
      const at = n.StartDate || n.CreatedDate || n.LastModifiedDate;
      // Shown with its links (as [text](address), which Kea turns into buttons); compared as plain text, the way older
      // items were saved, so keeping links doesn't make every old announcement look edited.
      const key = plain(n.Body?.Html || n.Body?.Text);
      const body = n.Body?.Html ? htmlToText(n.Body.Html, home) : key;
      const prev = known.get(id);
      const changed = prev && ((prev.bodyKey ?? prev.body) !== key || prev.title !== n.Title);
      const url = home && n.Id && ou ? new URL(`/d2l/le/news/${ou}/${n.Id}/view?ou=${ou}`, home).href : '';
      const quiet = !box.seeded || !seenCourses.has(code) || isOld(at);
      const item = { id, kind: 'announcement', course: code, title: n.Title || 'Announcement', body, bodyKey: key, at, url, read: prev ? prev.read && !changed : quiet, updated: !!changed };
      if ((!prev && !quiet) || changed) fresh.push(item);
      known.set(id, item);
    }
  }
  const items = [...known.values()].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 500);
  fs.writeFileSync(inboxFile(), JSON.stringify({ ...box, items, seeded: true }));
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

const notes = [];
async function updateAlerts(list) {
  const home = browser.schoolInfo().home;
  const homeOu = (home.match(/\/d2l\/home\/(\d+)/) || [])[1];
  if (!home || !homeOu) return;
  const box = readInbox();
  const known = new Set([...box.items.map((i) => i.id), ...(box.deleted || [])]);
  const fresh = [];
  for (const k of ALERT_KINDS) {
    const r = await browser
      .fetchText(new URL(`/d2l/MiniBar/${homeOu}/ActivityFeed/GetAlertsDaylight?Category=${k.cat}&_d2l_prc%24headingLevel=2&_d2l_prc%24scope=&_d2l_prc%24hasActiveForm=false&isXhr=true&requestId=1`, home).href, 0, true)
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
      // Grades and feedback already arrive as their own messages (from the gradebook, with the score and comment).
      if (k.kind === 'update' && /\b(grade|graded|feedback|evaluat)/i.test(a.text)) continue;
      const [first, ...rest] = a.text.split('\n');
      const course = list.find((c) => a.text.includes(c.code))?.code || '';
      fresh.push({ id, kind: k.kind, course, title: first.slice(0, 160), body: rest.join('\n').trim() || first, at: a.at || new Date().toISOString(), url: a.url, read: !box.seeded });
    }
  }
  if (!fresh.length) return;
  // Read again now: the student may have read or deleted messages while the menus were being fetched.
  const now = readInbox();
  const gone = new Set(now.deleted || []);
  const add = fresh.filter((n) => !gone.has(n.id) && !now.items.some((i) => i.id === n.id));
  now.items = [...add, ...now.items].sort((x, y) => String(y.at).localeCompare(String(x.at))).slice(0, 500);
  fs.writeFileSync(inboxFile(), JSON.stringify({ ...now, seeded: true }));
  if (box.seeded) {
    const { Notification } = require('electron');
    for (const n of fresh.slice(0, 5)) {
      if (!Notification.isSupported()) continue;
      const note = new Notification({ title: n.course ? `${n.course}: ${n.title}` : n.title, body: `${n.body.slice(0, 180)}${n.kind === 'message' ? ' (click to reply)' : ''}` });
      // Clicking a message's notification opens it with Reply pressed; anything else opens on the class site.
      note.on('click', () => {
        if (n.kind === 'message') {
          const ou = list.find((c) => c.code === n.course)?.ou;
          browser.reply(n.url, ou).catch(() => {});
        } else if (n.url) browser.show(n.url).catch(() => {});
      });
      note.show();
      // (Kept, or Windows can drop the click once the notification object is collected.)
      notes.push(note);
      notes.splice(0, Math.max(0, notes.length - 20));
    }
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
    // A class Kea is seeing for the first time: its grades so far are history, not news. Same for a grade first seen
    // weeks after it was given. A real regrade or new feedback always counts.
    const firstLook = !old.byCourse[code];
    for (const g of list) {
      const p = was.get(g.id);
      if (!p && (firstLook || (g.at && Date.now() - new Date(g.at).getTime() > 14 * 864e5))) continue;
      // Each is its own message: the grade, and (separately) the instructor's feedback when it's new or changed.
      if (!p || p.score !== g.score) fresh.push({ code, g, kind: 'grade', updated: !!p });
      if (g.comment && (!p || p.comment !== g.comment)) fresh.push({ code, g, kind: 'feedback', updated: !!p?.comment });
    }
    const pct = final?.PointsDenominator ? Math.round((final.PointsNumerator / final.PointsDenominator) * 1000) / 10 : null;
    const hidden = hiddenWork(items);
    // Hidden graded work goes straight to the Inbox, without waiting for Claude: when it first appears, and again if
    // it grows.
    const wasHidden = new Map((old.byCourse[code]?.hidden || []).map((h) => [h.category, h.hidden]));
    for (const h of hidden) if (!firstLook && wasHidden.get(h.category) !== h.hidden) fresh.push({ code, h, kind: 'hidden' });
    byCourse[code] = { final: final ? { shown: String(final.DisplayedGrade || '').trim(), percent: pct } : old.byCourse[code]?.final || null, items: list, hidden, url: home && ous[code] ? new URL(`/d2l/lms/grades/my_grades/main.d2l?ou=${ous[code]}`, home).href : '', checked: new Date().toISOString() };
  }
  fs.writeFileSync(gradesFile(), JSON.stringify({ byCourse, seeded: true }));
  if (!old.seeded || !fresh.length) return;
  // New grades and new feedback show in the Inbox as their own messages, like announcements.
  const box = readInbox();
  const deleted = new Set(box.deleted || []);
  const add = [];
  for (const { code, g, h, kind, updated } of fresh) {
    if (kind === 'hidden') {
      const id = `hidden:${code}:${h.category}:${h.hidden}`;
      if (!deleted.has(id))
        add.push({ id, kind: 'needs_you', course: code, title: `${h.category}: ${h.hidden} points counting for work you can't see`, body: `${hiddenWords(h)[0].toUpperCase()}${hiddenWords(h).slice(1)}. Check the course schedule and any outside platform for work in this category, and ask your instructor which items are counting.`, at: new Date().toISOString(), url: byCourse[code].url, links: byCourse[code].url ? [{ label: 'Open grades', url: byCourse[code].url }] : [], read: false });
      continue;
    }
    const shown = g.score || g.shown;
    const item =
      kind === 'grade'
        ? { id: `grade:${code}:${g.id}:${g.score}`, kind, title: `${updated ? 'Grade updated' : 'Graded'}: ${g.title}`, body: '', score: shown, percent: g.percent }
        : { id: `feedback:${code}:${g.id}:${hash(g.comment).slice(0, 12)}`, kind, title: `${updated ? 'Updated feedback' : 'Feedback'}: ${g.title}`, body: g.comment, score: shown, percent: g.percent };
    if (deleted.has(item.id)) continue;
    add.push({ ...item, course: code, at: g.at || new Date().toISOString(), url: byCourse[code].url, links: byCourse[code].url ? [{ label: 'Open grades', url: byCourse[code].url }] : [], read: false });
  }
  box.items.unshift(...add);
  fs.writeFileSync(inboxFile(), JSON.stringify({ ...box, items: box.items.slice(0, 500) }));
  const { Notification } = require('electron');
  for (const n of add.slice(0, 5)) if (Notification.isSupported()) new Notification({ title: `${n.course}: ${n.title}`, body: n.kind === 'grade' ? `${n.score}${n.percent != null ? ` (${n.percent}%)` : ''}` : n.body.slice(0, 200) }).show();
}

function markInboxRead(ids) {
  const box = readInbox();
  for (const i of box.items) if (!ids || ids.includes(i.id)) i.read = true;
  fs.writeFileSync(inboxFile(), JSON.stringify(box));
}

/** What identifies the same message on the PC and the phone (whose own checks give it a different id). */
const inboxKey = (i) => `${i.course}|${i.title}|${String(i.body || '').slice(0, 60)}`;

/**
 * Delete Inbox items, by id or by `inboxKey` (deletions made on the phone). They're remembered, so the next look at
 * the class site doesn't bring them back. Returns the keys of what was deleted.
 */
function deleteInbox(ids = [], keys = []) {
  const box = readInbox();
  const idSet = new Set(ids);
  const keySet = new Set(keys);
  const gone = box.items.filter((i) => idSet.has(i.id) || keySet.has(inboxKey(i)));
  box.items = box.items.filter((i) => !gone.includes(i));
  box.deleted = [...new Set([...(box.deleted || []), ...ids, ...gone.map((i) => i.id)])].slice(-3000);
  box.deletedKeys = [...new Set([...(box.deletedKeys || []), ...keys, ...gone.map(inboxKey)])].slice(-3000);
  fs.writeFileSync(inboxFile(), JSON.stringify(box));
  return gone.map(inboxKey);
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

// ---------- The weekly update's own check (no Claude) ----------
// The daily check already reads announcements, grades and links that just unlocked. What only the weekly update does
// is follow the class's structure: new or moved content, assignment folders, quizzes and calendar dates, and the next
// week's reading. Kea compares those with what it saw at the last weekly update and starts Claude only when one of them
// moved, a saved link may have unlocked, or the next week still needs building.
const syncStateFile = () => path.join(profiles.paths().dir, 'sync-state.json');
const readSyncState = () => {
  try {
    return JSON.parse(fs.readFileSync(syncStateFile(), 'utf8'));
  } catch {
    return { courses: {} };
  }
};

const SYNC_AREAS = {
  content: AREAS.content,
  dropbox: AREAS.dropbox,
  quizzes: AREAS.quizzes,
  discussions: AREAS.discussions,
  calendar: AREAS.calendar
};

/**
 * One class's weekly check: { dir, reasons: [what moved], brief, first, commit() }. `brief` is the engine's kea-brief
 * (saved links, links that may have unlocked, whether the next week needs building). `commit()` saves what was seen
 * as the new baseline: call it once the Claude run (or the decision to skip it) is settled.
 */
async function syncCheck(code, ou) {
  const p = profiles.paths();
  const dir = path.join(p.workspace, 'data', 'digests', 'kea-sync', day());
  fs.mkdirSync(dir, { recursive: true });
  const uv = await workspace.findUv();
  const r = await workspace.runHidden(uv, ['run', 'academic-sync', 'kea-brief', '--course', code], { cwd: p.workspace, env: workspace.engineEnv(uv) });
  const brief = JSON.parse(r.out.slice(r.out.indexOf('{')));
  fs.writeFileSync(path.join(dir, `${code}-brief.json`), JSON.stringify(brief, null, 1));

  const v = await versions();
  const before = readSyncState().courses[code] || null;
  const seen = {};
  const reasons = [];
  for (const [area, a] of Object.entries(SYNC_AREAS)) {
    let got;
    try {
      got = await getAll(a.rel(v, ou));
      if (a.expand && got?.data) got = { ...got, data: await a.expand(v, ou, got.data) };
    } catch (err) {
      reasons.push(`couldn't check ${area} (${String(err.message || err).slice(0, 80)})`);
      continue;
    }
    if (got.status === 403 || got.status === 404) continue;
    if (!got.data) {
      reasons.push(`couldn't check ${area} (D2L answered ${got.status})`);
      continue;
    }
    fs.writeFileSync(path.join(dir, `${code}-${area}.min.json`), JSON.stringify(compact(got.data, browser.schoolInfo().home)));
    seen[area] = a.list(got.data).map(a.entry);
    if (before?.[area]) reasons.push(...describe(area, before[area], seen[area], a.label));
  }
  const missing = brief.not_on_calendar || [];
  if (missing.length) reasons.push(`${missing.length} dated item${missing.length > 1 ? 's' : ''} written in the class's documents ${missing.length > 1 ? "aren't" : "isn't"} on the calendar: ${missing.map((i) => `${i.title} (${i.date})`).slice(0, 6).join('; ')}`);
  if (brief.next_banner_needed) reasons.push(`the next week's reading still needs building (weeks are built through ${brief.banners_through || 'none yet'})`);
  if (brief.needs_link_refresh.length) reasons.push(`${brief.needs_link_refresh.length} saved item${brief.needs_link_refresh.length > 1 ? 's' : ''} whose link may have unlocked: ${brief.needs_link_refresh.map((i) => i.title).slice(0, 6).join('; ')}`);
  return {
    dir: path.relative(p.workspace, dir),
    reasons,
    brief,
    first: !before,
    commit: () => {
      const st = readSyncState();
      st.courses[code] = { ...(st.courses[code] || {}), ...seen, at: new Date().toISOString() };
      fs.writeFileSync(syncStateFile(), JSON.stringify(st));
    }
  };
}

module.exports = { run, pollAnnouncements, readInbox, markInboxRead, deleteInbox, inboxKey, readGrades, handInTargets, syncCheck };
