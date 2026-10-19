// Runs a class scan: Claude Code, started hidden in the profile's workspace with Kea's guidelines and skills, the Kea
// Connector's tools, and nothing else allowed. One run at a time; progress and news go to Kea as they happen.
const { BrowserWindow, Notification } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const profiles = require('./profiles.cjs');
const workspace = require('./workspace.cjs');
const mcp = require('./mcp.cjs');

const KEA_TOOLS = ['d2l_open', 'd2l_fetch', 'd2l_download', 'd2l_status', 'kea_progress', 'kea_notify'].map((t) => `mcp__kea__${t}`);
// Reading and searching stay inside this scan folder: course pages can carry planted instructions, and a scan must
// never be able to read the rest of the computer.
const BASE = ['Bash(uv run academic-sync:*)', 'Read(./**)', 'Glob(./**)', 'Grep(./**)', 'Skill', 'ToolSearch', 'Edit(data/**)', 'Write(data/**)'];
// The textbook writer may look things up only on reference sites (nothing it reads can be posted anywhere else).
const REFERENCE = ['en.wikipedia.org', 'commons.wikimedia.org', 'openstax.org', 'libretexts.org', 'chem.libretexts.org', 'bio.libretexts.org', 'math.libretexts.org', 'phys.libretexts.org', 'khanacademy.org', 'ncbi.nlm.nih.gov', 'nist.gov', 'webbook.nist.gov', 'pubchem.ncbi.nlm.nih.gov'].map((d) => `WebFetch(domain:${d})`);

/** What each kind of run does, and the only tools it may use. */
const TASKS = {
  // The daily check: news per class, new class shells (imported in full), small calendar upkeep.
  daily: { prompt: (arg) => `/daily-overview ${arg || ''}`.trim(), tools: [...BASE, ...KEA_TOOLS], label: 'Daily check' },
  // A class's first full scan (or every new class, with no argument).
  import: { prompt: (arg) => `/academic-import ${arg || ''}`.trim(), tools: [...BASE, ...KEA_TOOLS], label: 'Scanning a new class' },
  // The weekly re-scan: next weeks' readings, refreshed links.
  sync: { prompt: (arg) => `/academic-sync ${arg || ''}`.trim(), tools: [...BASE, ...KEA_TOOLS], label: 'Weekly class update' },
  // Setup's "Test connection": Claude Code reaches Kea's tools and says what it sees (a few seconds, tiny usage).
  probe: {
    prompt: () => 'This is a connection test from Kea. Call mcp__kea__kea_progress with the message "Connection test", then mcp__kea__d2l_status, then reply with one short sentence saying whether the class site is set up and signed in. Do nothing else.',
    tools: ['mcp__kea__kea_progress', 'mcp__kea__d2l_status'],
    label: 'Connection test'
  },
  // This week's textbook chapters (no class site needed; open educational sources for figures and checking facts).
  study: { prompt: (arg) => `/weekly-study-pdf ${arg || ''}`.trim(), tools: [...BASE, ...REFERENCE, 'WebSearch', 'mcp__kea__kea_progress', 'mcp__kea__kea_notify'], label: 'Writing textbook chapters' },
  // A practice exam or flashcard deck the student asked for, written from the brief Kea prepares (the tests' focus, the
  // chapters' notes and review sheets Kea downloaded itself): Claude only reads that and writes.
  practice: { prompt: (arg) => require('./study.cjs').prompt(arg), tools: [...BASE, 'mcp__kea__kea_progress'], label: 'Making study material' }
};

// ---------- Plain-code steps before a run (no Claude usage) ----------
// Each may answer { skip: summary } (nothing for Claude to do), { prompt, after(ok) } (run Claude with this prompt),
// or { split: [args] } (queue one run per class or chapter instead: each starts with a small, fresh conversation,
// which costs far less than one long one, and a usage-limit stop loses at most one of them).
const precheck = () => require('./precheck.cjs');
const settings = () => require('../settings.cjs');
const db = () => require('./db.cjs');

async function engineJson(args) {
  const uv = await workspace.findUv();
  const cwd = profiles.paths().workspace;
  const r = await workspace.runHidden(uv, ['run', 'academic-sync', ...args], { cwd, env: workspace.engineEnv(uv) });
  const at = r.out.search(/[[{]/);
  return at < 0 ? null : JSON.parse(r.out.slice(at));
}

TASKS.daily.pre = async (job, step) => {
  if (/\bresume\b/.test(job.arg) || job.arg.trim()) return {};
  step('Checking your classes for anything new…');
  const r = await precheck().run({ fullEveryDays: Number(settings().get('scholar.fullCheckDays', '1')) || 1 });
  if (!r.setUp) return { skip: 'No class site is set up yet.', ok: false };
  if (!r.signedIn) return { skip: 'Kea isn’t signed in to your class site, so nothing was checked. Sign in under Add a class → From your school.', ok: false };
  for (const s of r.newShells) run('import', `${s.course_code} -- new class shell: ${JSON.stringify(s)}`, job.why);
  const codes = Object.keys(r.changed);
  const shells = r.newShells.length ? ` Found ${r.newShells.length} new class${r.newShells.length > 1 ? 'es' : ''} to scan: ${r.newShells.map((s) => s.course_code).join(', ')}.` : '';
  if (!codes.length) {
    r.commit();
    return { skip: `Nothing new in ${r.quiet.join(', ') || 'your classes'}. Checked by Kea itself, so no Claude usage.${shells}`, ok: true };
  }
  const what = codes.map((c) => `${c}: ${r.changed[c].join('; ')}`).join('\n');
  step(`Something new in ${codes.join(', ')}: reading it…`);
  return {
    prompt: `/daily-overview only ${codes.join(' ')} -- Kea pre-check: ${r.dir.replace(/\\/g, '/')}\n\nWhat Kea saw change since its last check:\n${what}${r.quiet.length ? `\n\nNothing changed in: ${r.quiet.join(', ')} (skip them).` : ''}`,
    after: (ok) => ok && r.commit()
  };
};

TASKS.import.pre = async (job, step) => {
  // Never scan a class that already ended (an old enrollment can stay open for months): it's last year's class.
  const shell = /-- new class shell: (\{.*\})/s.exec(job.arg);
  if (shell) {
    try {
      const end = JSON.parse(shell[1]).end_date;
      if (end && end < new Date().toISOString().slice(0, 10)) return { skip: `Skipped ${JSON.parse(shell[1]).course_code}: that class ended on ${end}, so it isn't scanned.`, ok: true };
    } catch {}
  }
  if (job.arg.trim()) return {};
  step('Looking for classes Kea hasn’t scanned yet…');
  const r = await precheck().run({ fullEveryDays: 1e9 });
  if (!r.signedIn) return { skip: 'Kea isn’t signed in to your class site, so it couldn’t look for classes.', ok: false };
  if (!r.newShells.length) return { skip: 'Every class you’re enrolled in is already in Kea.', ok: true };
  return { split: r.newShells.map((s) => `${s.course_code} -- new class shell: ${JSON.stringify(s)}`), summary: `Scanning ${r.newShells.length} new class${r.newShells.length > 1 ? 'es' : ''}, one at a time: ${r.newShells.map((s) => s.course_code).join(', ')}.` };
};

// The weekly update: one run per class, each first checked by Kea itself (precheck.syncCheck). A class whose content,
// assignment folders, quizzes and calendar haven't moved since last week, with every coming week built and no link
// waiting to unlock, is skipped without Claude. Any other argument (`CODE full`, `resume`) always runs Claude.
TASKS.sync.pre = async (job, step) => {
  const arg = job.arg.trim();
  const list = await db().watchList(profiles.paths().db);
  if (!arg) {
    if (!list.length) return { skip: 'No classes to update yet.', ok: true };
    return { split: list.map((c) => c.code), summary: `Updating ${list.length} classes, one at a time: ${list.map((c) => c.code).join(', ')}.` };
  }
  const course = list.find((c) => c.code === arg);
  if (!course) return {};
  step(`Checking ${course.code} for changes…`);
  const r = await precheck().syncCheck(course.code, course.ou);
  // No baseline yet, right after a weekly update that ran with Claude: that run already saw all this.
  const last = readJson(activityFile(), []).find((e) => e.task === 'sync' && e.ok && e.arg === course.code && !/no Claude usage/.test(e.summary || ''));
  const recent = last && Date.now() - new Date(last.end || last.start).getTime() < 8 * 864e5;
  if (!r.reasons.length && (!r.first || recent)) {
    r.commit();
    return { skip: `${course.code}: nothing moved since the last update, every coming week is built and no link is waiting to unlock. Checked by Kea itself, so no Claude usage.`, ok: true };
  }
  step(`${course.code}: ${r.reasons[0] || 'first weekly check'}. Reading it…`);
  return {
    prompt: `/academic-sync ${course.code} -- Kea pre-check: ${r.dir.replace(/\\/g, '/')}\n\nWhat Kea saw since the last weekly update:\n${r.reasons.join('\n') || 'Nothing: this is the first weekly update Kea has checked, so do the usual light re-scan.'}`,
    after: (ok) => ok && r.commit()
  };
};

// Every chapter gets written, not only the coming week's: with no argument (the daily schedule) or `missing [CODE]`
// (after a class's first scan, or the Textbook tab's button), each chapter with no textbook yet is written in the first
// week that teaches it, one week per run; then the weeks starting soon (reviews before tests).
// `rewrite <CODE> <label>[, <label>…]` (the Textbook tab's Rewrite button) writes chapters again under the current
// guidelines, each in the week it was first written in, so the new PDF replaces the old one.
TASKS.study.pre = async (job, step) => {
  const arg = job.arg.trim();
  const m = /^missing(?:\s+(\S+))?$/.exec(arg);
  const re = /^rewrite\s+(\S+)\s+(.+)$/.exec(arg);
  if (arg && !m && !re) return {};
  step(re ? 'Finding the chapters to rewrite…' : 'Checking which chapters still need writing…');
  const missing = re
    ? (await engineJson(['study-pdf-due', '--course', re[1], '--rewrite', re[2]]).catch(() => null)) || []
    : (await engineJson(['study-pdf-due', '--missing', ...(m?.[1] ? ['--course', m[1]] : [])]).catch(() => null)) || [];
  const due = m || re ? [] : (await engineJson(['study-pdf-due']).catch(() => null)) || [];
  const runs = [
    ...missing.map((b) => ({ b, arg: `${b.banner_id} only ${(b.write_only || []).join(', ')}` })),
    ...due.filter((b) => !missing.some((x) => x.banner_id === b.banner_id)).map((b) => ({ b, arg: b.banner_id }))
  ];
  if (!runs.length) return { skip: re ? 'Kea couldn’t find the week that teaches that chapter.' : m ? 'Every chapter already has its textbook.' : 'Every chapter already has its textbook, and every week starting soon is ready.', ok: re ? false : true };
  // The chapters' notes (guided readings, review sheets and keys, every test's focus) as plain text, so the writer
  // teaches everything the instructor will ask. The same files practice sets use; Kea fetches and converts, no Claude.
  const uv = await workspace.findUv();
  const cwd = profiles.paths().workspace;
  for (const code of new Set(runs.map((r) => r.b.course?.code).filter(Boolean))) {
    step(`Gathering ${code}'s review sheets and test focus…`);
    await require('./study.cjs')
      .notesFor(code, (file) => docText(uv, cwd, file), step)
      .catch((err) => console.error('Chapter notes', err));
  }
  if (runs.length === 1) return { prompt: `/weekly-study-pdf ${runs[0].arg}` };
  const chapters = missing.reduce((n, b) => n + (b.write_only || []).length, 0);
  return { split: runs.map((r) => r.arg), summary: `Writing ${chapters ? `${chapters} chapter${chapters === 1 ? '' : 's'}` : `${runs.length} weeks' chapters`}, one week at a time.` };
};

TASKS.practice.pre = async (job, step) => {
  const study = require('./study.cjs');
  step('Gathering the chapters, review sheets and what the test covers…', 1);
  const id = String(job.arg || '').split(/\s+/)[0];
  const uv = await workspace.findUv();
  const cwd = profiles.paths().workspace;
  await study.prepare(id, (file) => docText(uv, cwd, file), step);
  step('Writing the set…', 10);
  return { prompt: study.prompt(job.arg), after: (ok) => study.ingest(job.arg, ok) };
};

/** A downloaded PDF or Word file's text, written next to it by the engine (`doc-text`). */
async function docText(uv, cwd, file) {
  const r = await workspace.runHidden(uv, ['run', 'academic-sync', 'doc-text', file], { cwd, env: workspace.engineEnv(uv) });
  const at = r.out.indexOf('{');
  return at < 0 ? null : JSON.parse(r.out.slice(at));
}

let current = null;
const queue = [];

const send = (channel, payload) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send(channel, payload));

// ---------- What Kea keeps about runs and news (per profile) ----------
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
const activityFile = () => path.join(profiles.paths().dir, 'activity.json');
const newsFile = () => path.join(profiles.paths().dir, 'news.json');
function saveActivity(entry) {
  const list = readJson(activityFile(), []).filter((e) => e.id !== entry.id);
  list.unshift(entry);
  fs.mkdirSync(path.dirname(activityFile()), { recursive: true });
  fs.writeFileSync(activityFile(), JSON.stringify(list.slice(0, 60), null, 1));
}
/**
 * After an import or weekly update: graded work written in a class's documents that still isn't on the calendar, or a
 * document Kea couldn't read, becomes a "needs you" message, so a gap is never silent.
 */
async function coverageCheck(arg) {
  const uv = await workspace.findUv();
  const cwd = profiles.paths().workspace;
  const first = String(arg || '').trim().split(/\s+/)[0];
  const codes = /^[A-Z]{2,5}\d{3,5}[A-Z]?$/i.test(first) ? [first.toUpperCase()] : (await db().watchList(profiles.paths().db)).map((c) => c.code);
  for (const code of codes) {
    const r = await workspace.runHidden(uv, ['run', 'academic-sync', 'coverage', '--course', code, '--json'], { cwd, env: workspace.engineEnv(uv) });
    let out;
    try {
      out = JSON.parse(r.out.slice(r.out.indexOf('{')));
    } catch {
      continue;
    }
    // Plus everything D2L itself lists (folders, quizzes, discussions, grade items) that the calendar lacks or has
    // on another day.
    let rec = {};
    try {
      const rr = await workspace.runHidden(uv, ['run', 'academic-sync', 'd2l-reconcile', '--course', code, '--json'], { cwd, env: workspace.engineEnv(uv) });
      rec = JSON.parse(rr.out.slice(rr.out.indexOf('{')));
    } catch {}
    const items = [
      ...(out.uncovered || []),
      ...(rec.unmatched || []).map((u) => ({ key: u.key, title: `${u.title} (in D2L's ${u.kind === 'dropbox' ? 'assignments' : u.kind === 'grade' ? 'grades' : `${u.kind}s`})`, date: u.d2l_date })),
      ...(rec.drift || []).map((d) => ({ key: d.key, title: `${d.title}: D2L says ${d.d2l_date}, your calendar ${d.item_date}`, date: d.d2l_date }))
    ];
    const unreadable = out.unreadable || [];
    // Told once per change (the same open gap isn't repeated after every update).
    const seenFile = path.join(profiles.paths().dir, 'coverage-told.json');
    const told = readJson(seenFile, {});
    const sig = JSON.stringify([items.map((i) => i.key), unreadable]);
    if (told[code] === sig) continue;
    told[code] = sig;
    fs.writeFileSync(seenFile, JSON.stringify(told));
    if (!items.length && !unreadable.length) continue;
    const lines = [
      ...items.slice(0, 8).map((i) => `• ${i.title} (${i.date || 'no date found'})`),
      ...unreadable.slice(0, 4).map((u) => `• Couldn't read ${path.basename(String(u).split(' (')[0])}`)
    ];
    addNews({
      course: code,
      kind: 'needs_you',
      title: items.length ? `${items.length} piece${items.length > 1 ? 's' : ''} of graded work in ${code}'s documents ${items.length > 1 ? "aren't" : "isn't"} on your calendar` : `Kea couldn't read ${unreadable.length} of ${code}'s documents`,
      body: `${lines.join('\n')}\nThe next weekly update looks into each one; check your class site for any that are due soon.`
    });
  }
}

function addNews(n) {
  const list = readJson(newsFile(), []);
  list.unshift({ id: `${Date.now()}`, at: new Date().toISOString(), read: false, ...n });
  fs.mkdirSync(path.dirname(newsFile()), { recursive: true });
  fs.writeFileSync(newsFile(), JSON.stringify(list.slice(0, 300), null, 1));
  send('scholar:news', n);
  if (Notification.isSupported()) new Notification({ title: n.course ? `${n.course}: ${n.title}` : n.title, body: n.body.slice(0, 220) }).show();
}

// ---------- Claude usage limits: pause, then continue where the run stopped ----------
const LIMIT = /hit your (?:session |usage |weekly |daily )?limit|usage limit reached|limit (?:will )?resets?/i;

/** When a "resets 8:10pm" message means the limit is over (local time), or in an hour when it can't be read. */
function resetTime(msg, now = new Date()) {
  const m = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(msg || '');
  if (!m) return new Date(now.getTime() + 60 * 60000);
  let h = Number(m[1]) % 12;
  if ((m[3] || '').toLowerCase() === 'pm') h += 12;
  if (!m[3] && Number(m[1]) === 12) h = 12;
  const at = new Date(now);
  at.setHours(h, Number(m[2] || 0), 0, 0);
  if (at <= now) at.setDate(at.getDate() + 1);
  // A couple of minutes' grace so the limit has really reset.
  return new Date(at.getTime() + 3 * 60000);
}

const resumeFile = () => path.join(profiles.paths().dir, 'resume.json');
/** The run waiting to continue after a usage limit, if any: { task, arg, until, label }. */
const pending = () => readJson(resumeFile(), null);
function setPending(p) {
  if (p) fs.writeFileSync(resumeFile(), JSON.stringify(p, null, 1));
  else fs.rmSync(resumeFile(), { force: true });
  send('scholar:resume', p);
}

/** The argument that makes a task continue instead of starting over (see "Continuing a run" in Kea's CLAUDE.md). */
const resumeArg = (arg) => (/\bresume\b/.test(arg || '') ? arg : `${arg || ''} resume`.trim());

/** Continue the waiting run now (the schedule calls this once its time comes; Scans has a button for it). */
function resume() {
  const p = pending();
  if (!p) return false;
  setPending(null);
  run(p.task, resumeArg(p.arg), 'resume');
  return true;
}

/** Continue the last stopped run of a task (for a run that stopped before Kea could pause it). */
function resumeLast(task) {
  const last = readJson(activityFile(), []).find((e) => e.task === task);
  run(task, resumeArg(last?.arg || ''), 'resume');
  return true;
}

/** A run that stopped at a usage limit before Kea could pause runs (v0.21) gets picked up the same way. */
function adoptStopped() {
  if (pending()) return;
  const last = readJson(activityFile(), [])[0];
  if (!last || last.ok || last.paused || !LIMIT.test(last.summary || '')) return;
  const until = resetTime(last.summary, new Date(last.end || last.start));
  last.paused = until.toISOString();
  saveActivity(last);
  setPending({ task: last.task, arg: last.arg || '', label: last.label, until: until.toISOString() });
}

// ---------- How long a run takes (for the progress bar and "about 4 min left") ----------
// Typical length of a run that used Claude, before Kea has seen one of its own: minutes.
const TYPICAL = { daily: 4, import: 25, sync: 6, study: 10, practice: 2, probe: 1 };
const classOf = (arg) => (/^([A-Z]{2,5}\d{3,5})\b/.exec(String(arg || '').trim()) || [])[1] || '';
// Old entries don't say whether Claude ran: a skip (Kea's own check found nothing) is short and says so.
const usedClaude = (e) =>
  e.claude !== undefined ? e.claude : !/no Claude usage|Dry run|one at a time|already has its textbook|already in Kea|^Skipped|isn’t signed in|aren’t set up|No classes to update/i.test(e.summary || '') && new Date(e.end) - new Date(e.start) > 20000;
const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);

/** What a run of this task (for this class, when known) usually takes: { ms, turns }. Learned from past runs. */
function estimate(task, arg) {
  if (task === 'practice') return estimatePractice(arg);
  const typical = (TYPICAL[task] || 5) * 60000;
  const took = (e) => new Date(e.end) - new Date(e.claudeStart || e.start);
  // A run far longer than usual (an early all-classes scan, a usage-limit pause) would throw every bar off.
  const past = readJson(activityFile(), []).filter((e) => e.task === task && e.ok && e.end && !e.paused && usedClaude(e) && took(e) < Math.max(6 * typical, 30 * 60000));
  const code = classOf(arg);
  const same = code ? past.filter((e) => classOf(e.arg) === code) : [];
  const pick = same.length ? same : past;
  const ms = median(pick.slice(0, 8).map(took)) || typical;
  const turns = median(pick.filter((e) => e.turns).slice(0, 8).map((e) => e.turns)) || 0;
  return { ms, turns };
}

// A study set's time grows with its size: learned as a fixed part plus time per question, from past sets.
function estimatePractice(arg) {
  const sizes = new Map(require('./study.cjs').list().map((e) => [e.id, e.count]));
  const idOf = (a) => String(a || '').split(/\s+/)[0];
  const n = sizes.get(idOf(arg)) || 50;
  const per = readJson(activityFile(), [])
    .filter((e) => e.task === 'practice' && e.ok && e.end && !e.paused && e.claudeStart && sizes.get(idOf(e.arg)))
    .slice(0, 8)
    .map((e) => (new Date(e.end) - new Date(e.claudeStart) - 40000) / sizes.get(idOf(e.arg)));
  // Before any: about 40 s to read the brief, then about 2.5 s a question (Claude writes each with its answer).
  const each = Math.max(1000, Math.min(15000, median(per) || 2500));
  return { ms: 40000 + n * each, turns: 0 };
}

// Runs split into one per class are a batch: "2 of 4" and one bar across all of them.
const batches = new Map();

/** Queue a run. Resolves when it finishes, with its summary. */
function run(task, arg = '', why = 'manual', batch = null) {
  if (!TASKS[task]) throw new Error(`Unknown run: ${task}`);
  return new Promise((resolve) => {
    queue.push({ task, arg, why, resolve, batch, profile: profiles.active() });
    next();
  });
}

async function next() {
  if (current || !queue.length) return;
  const job = queue.shift();
  // A run belongs to the profile it was queued for (profiles can't be switched while one runs).
  if (job.profile !== profiles.active()) {
    job.resolve(null);
    return next();
  }
  // While paused for a usage limit, scheduled runs wait (they'd only hit the same limit). Runs the student starts still go.
  const p = pending();
  if (p && job.why === 'schedule' && new Date(p.until) > new Date()) {
    job.resolve(null);
    return next();
  }
  const t = TASKS[job.task];
  const est = estimate(job.task, job.arg);
  const b = job.batch && batches.get(job.batch);
  // phase: 'check' while Kea looks by itself, 'claude' once Claude is reading. turns: Claude's steps so far.
  const entry = { id: `${Date.now()}`, task: job.task, label: t.label, arg: job.arg, why: job.why, start: new Date().toISOString(), end: null, ok: null, summary: '', steps: [], phase: 'check', claudeStart: null, expectedMs: est.ms, expectedTurns: est.turns, turns: 0, percent: null, claude: false, batch: b ? { id: job.batch, done: b.done, total: b.total } : null };
  current = { entry, child: null, server: null };
  const step = (message, percent) => {
    entry.steps.push({ at: new Date().toISOString(), message });
    if (entry.steps.length > 200) entry.steps.shift();
    if (Number.isFinite(percent)) entry.percent = Math.max(0, Math.min(100, percent));
    send('scholar:run', { ...entry, running: true });
  };
  const finish = (ok, summary) => {
    entry.end = new Date().toISOString();
    entry.ok = ok;
    entry.summary = summary;
    if (b) {
      b.done++;
      if (b.done >= b.total) batches.delete(job.batch);
    }
    saveActivity(entry);
    send('scholar:run', { ...entry, running: false });
    send('scholar:changed');
    current?.server?.close();
    current = null;
    job.resolve(entry);
    next();
  };
  try {
    const claude = await workspace.findClaude();
    const uv = await workspace.findUv();
    if (!claude || !uv) return finish(false, 'Class scans aren’t set up yet (Claude Code and uv are needed).');
    const cwd = workspace.prepare();
    let prompt = t.prompt(job.arg);
    let after = null;
    if (t.pre) {
      // A failing pre-check never blocks a run: it falls back to the full run Claude would have done anyway.
      const pre = await t.pre(job, step).catch((err) => {
        step(`Kea's own check didn't work (${String(err?.message || err).slice(0, 120)}), so this is a full check.`);
        return {};
      });
      if (pre.skip) return finish(pre.ok !== false, pre.skip);
      if (pre.split) {
        const id = `${entry.id}-batch`;
        batches.set(id, { done: 0, total: pre.split.length, label: t.label });
        for (const a of pre.split) run(job.task, a, job.why, id);
        return finish(true, pre.summary);
      }
      if (pre.prompt) prompt = pre.prompt;
      after = pre.after || null;
    }
    // Testing Kea's own checks: say what Claude would be asked, without starting it.
    if (process.env.KEA_DRY_RUN) return finish(true, `Dry run, Claude not started. Prompt: ${prompt}`);
    const server = await mcp.start({ progress: step, notify: (n) => addNews(n), docText: (file) => docText(uv, cwd, file) });
    current.server = server;
    // One connection file per run: a finished run's cleanup must never delete the next run's file.
    const cfg = path.join(cwd, 'data', `kea-mcp-${entry.id}.json`);
    fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { kea: { type: 'http', url: server.url, headers: { Authorization: `Bearer ${server.token}` } } } }));
    const log = path.join(cwd, 'data', 'logs', `kea-${job.task}-${entry.start.slice(0, 10)}.log`);
    fs.mkdirSync(path.dirname(log), { recursive: true });
    const out = fs.createWriteStream(log, { flags: 'a' });
    out.write(`\n=== ${entry.start} ${job.task} ${job.arg} (${job.why}) ===\n`);
    // Scans always run on Opus (the user's choice: accuracy over usage), whatever Claude Code's own default is.
    // PDFs are never read directly (every page would go to Claude as a picture): downloads come with a text copy.
    // Nor is the engine's source: its commands are listed in Kea's CLAUDE.md, and reading the code to find them was
    // the biggest waste in early runs.
    const args = ['-p', prompt, '--model', 'opus', '--output-format', 'stream-json', '--verbose', '--mcp-config', cfg, '--strict-mcp-config', '--permission-mode', 'dontAsk', '--allowedTools', ...t.tools, '--disallowedTools', 'Read(**/*.pdf)', 'Read(./src/**/*.py)'];
    entry.phase = 'claude';
    entry.claude = true;
    entry.claudeStart = new Date().toISOString();
    step(`${t.label}…`);
    const child = spawn(claude, args, { cwd, env: workspace.engineEnv(uv), windowsHide: true });
    current.child = child;
    let buf = '';
    let result = null;
    child.stdout.on('data', (d) => {
      out.write(d);
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'result') {
            result = ev;
            if (ev.num_turns) entry.turns = ev.num_turns;
          } else if (ev.type === 'assistant') {
            entry.turns++;
            // The bar moves with each of Claude's steps (not every one: a run takes dozens).
            if (entry.turns % 3 === 0) send('scholar:run', { ...entry, running: true });
          }
        } catch {}
      }
    });
    child.stderr.on('data', (d) => out.write(d));
    child.on('error', (err) => {
      out.end();
      try {
        after?.(false);
      } catch {}
      finish(false, `Couldn’t start Claude Code: ${err.message}`);
    });
    child.on('close', (code) => {
      out.write(`\n=== exit ${code} ===\n`);
      out.end();
      fs.rmSync(cfg, { force: true });
      const text = String(result?.result || '');
      if (LIMIT.test(text)) {
        // Out of Claude usage: everything saved so far stays; continue once the limit resets.
        const until = resetTime(text);
        const at = until.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        entry.paused = until.toISOString();
        setPending({ task: job.task, arg: job.arg, label: t.label, until: until.toISOString() });
        if (Notification.isSupported()) new Notification({ title: 'Class scan paused', body: `Your Claude usage limit was reached. Kea continues where it stopped at ${at}.` }).show();
        finish(false, `Paused: your Claude usage limit was reached. Everything found so far is saved, and Kea continues where it stopped at ${at}.`);
      } else if (result && !result.is_error) {
        try {
          after?.(true);
        } catch {}
        // Every import and weekly update ends with Kea's own coverage check (not left to Claude remembering).
        if (job.task === 'import' || job.task === 'sync' || job.task === 'daily') coverageCheck(job.task === 'daily' ? '' : job.arg).catch((err) => console.error('Coverage', err));
        // A class's first scan is followed by its whole textbook (one week per run).
        if (job.task === 'import' && job.arg.trim() && !/\bresume\b/.test(job.arg) && settings().get('scholar.studyPdfs', true) !== false) run('study', `missing ${job.arg.trim().split(/\s+/)[0]}`, job.why);
        finish(true, text.trim().slice(0, 4000) || 'Done.');
      } else {
        try {
          after?.(false);
        } catch {}
        finish(false, result?.result ? String(result.result).slice(0, 2000) : code === null ? 'Stopped.' : `The scan ended early (code ${code}). Details are in the scan log.`);
      }
    });
  } catch (err) {
    finish(false, String(err?.message || err));
  }
}

function stop() {
  queue.length = 0;
  if (current?.child) current.child.kill();
}

// Waiting runs carry their own estimate, so the time left covers the whole queue.
const status = () => ({ running: current ? { ...current.entry, running: true } : null, queued: queue.map((j) => ({ task: j.task, arg: j.arg, label: TASKS[j.task].label, expectedMs: estimate(j.task, j.arg).ms })) });
const activity = () => readJson(activityFile(), []);
const news = () => readJson(newsFile(), []);
function markNewsRead(ids) {
  const list = readJson(newsFile(), []);
  for (const n of list) if (!ids || ids.includes(n.id)) n.read = true;
  fs.writeFileSync(newsFile(), JSON.stringify(list, null, 1));
  return true;
}

/** Delete what scans reported, by id or by the Inbox's content key (deletions made on the phone). */
function deleteNews(ids = [], keys = []) {
  const { inboxKey } = require('./precheck.cjs');
  const idSet = new Set(ids);
  const keySet = new Set(keys);
  const list = readJson(newsFile(), []);
  const gone = list.filter((n) => idSet.has(n.id) || keySet.has(inboxKey({ course: n.course || '', title: n.title, body: n.body })));
  fs.writeFileSync(newsFile(), JSON.stringify(list.filter((n) => !gone.includes(n)), null, 1));
  return gone.map((n) => inboxKey({ course: n.course || '', title: n.title, body: n.body }));
}

module.exports = { run, stop, status, activity, news, markNewsRead, deleteNews, pending, resume, resumeLast, resetTime, adoptStopped, TASKS };
