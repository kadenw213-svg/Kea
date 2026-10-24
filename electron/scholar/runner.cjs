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
// (Claude Code matches a domain exactly: "openstax.org" doesn't cover "www.openstax.org", so each site is allowed with
// its subdomains too.)
const fetchFrom = (domains) => domains.flatMap((d) => [`WebFetch(domain:${d})`, `WebFetch(domain:*.${d})`]);
const REFERENCE = fetchFrom(['wikipedia.org', 'wikimedia.org', 'openstax.org', 'libretexts.org', 'khanacademy.org', 'nih.gov', 'nist.gov']);

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
  practice: { prompt: (arg) => require('./study.cjs').prompt(arg), tools: [...BASE, 'mcp__kea__kea_progress'], label: 'Making study material' },
  // A class's chapters held to its syllabus: outcomes and topical outline recorded and each taught by a chapter whose
  // notes carry it, every chapter's notes complete (sections from the slides or the book), the textbook and testing
  // guidelines recorded. Reads the class site, the book's own contents and the school's published course outlines.
  // Worked step-by-step solutions for one chapter's saved questions that have none ("CODE Chapter 5").
  steps: { prompt: (arg) => `/kea-steps ${arg || ''}`.trim(), tools: [...BASE, 'mcp__kea__kea_progress'], label: 'Writing step-by-step solutions' },
  // Scanned (image-only) class documents, written out as text once from their page images ("CODE <file>|<file>").
  transcribe: {
    prompt: (arg) => {
      const [code, ...rest] = String(arg || '').split(' ');
      const files = rest.join(' ').split('|').filter(Boolean);
      return [
        `These ${code} class documents are scanned images with no text, so Kea's own checks can't read them:`,
        ...files.map((f) => `- ${f}`),
        '',
        'For each one:',
        '1. Run `uv run academic-sync doc-text "<file>"`. It renders every page without text to `<file>.page-N.png` and lists them.',
        '2. Read each page image (the Read tool shows it) and write everything on it, word for word, into `<file>.transcribed.txt` beside the file: headings, tables (one row per line, cells separated by " | "), every date, point value and due time. Mark each page with `--- page N ---`. Don’t summarize or leave anything out; write [unreadable] for anything you truly can’t make out.',
        '3. Call mcp__kea__kea_progress after each file.',
        `Then run \`uv run academic-sync coverage --course ${code}\` and report what it lists (don't change the calendar here: the weekly update handles anything it finds). End with one short paragraph for the student saying which files are now readable.`
      ].join('\n');
    },
    tools: [...BASE, 'mcp__kea__kea_progress'],
    label: 'Reading scanned documents'
  },
  curriculum: { prompt: (arg) => `/kea-curriculum ${arg || ''}`.trim(), tools: [...BASE, ...KEA_TOOLS, ...REFERENCE, 'WebSearch'], label: 'Matching chapters to the syllabus' }
};
// Publishers' contents pages, colleges' sites (published course outlines and master syllabi) and the course-catalog
// services colleges publish them through.
const PUBLISHERS = [...fetchFrom(['mheducation.com', 'mheducation.ca', 'pearson.com', 'cengage.com', 'wiley.com', 'macmillanlearning.com', 'norton.com', 'smartcatalogiq.com', 'acalog.com', 'coursedog.com', 'courseleaf.com']), 'WebFetch(domain:*.edu)'];

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
  // The computer was asleep or offline while checking: don't work from half the data (and don't record a check);
  // the next check tries again.
  if (r.offline) return { skip: `The computer was offline or asleep during the check (${r.offline}). Kea tries again shortly.`, ok: false };
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

// Only the classes whose chapters fall short of their syllabus (Kea's own check, no Claude), one class per run, with
// the list of what to fix. The school's own site may be read for its published course outlines.
// How many chapters one depth review reads (each is its textbook chapter, notes and question bank).
const DEPTH_PER_RUN = 6;
// How close a test must be for new material on it to start a depth review.
const DEPTH_DAYS = 21;

// A depth review is only justified by something new from the teacher (the student's rule, 2026-10-21: "rewriting hundreds
// of questions at a time feels like a waste, it needs to be justified"): a test's study focus or description, a review
// sheet, an answer key, on a chapter with a test still to come. Never on a timer, and never because Kea rewrote the
// chapter's textbook itself (that made each review start the next). What each chapter's last review saw is kept here.
const contextFile = () => path.join(profiles.paths().dir, 'depth-context.json');

/**
 * The engine's depth rows, with Kea's own `due`: a chapter with a textbook chapter and a test still to come whose
 * teacher material the last review hasn't seen (`fresh`), within DEPTH_DAYS of that test. `next_test` carries its id.
 */
async function depthRows(code) {
  const rows = (await engineJson(['depth-due', '--course', code, '--json']).catch(() => null)) || [];
  const ctx = await require('./study.cjs').teacherContext(code).catch(() => null);
  const seen = readJson(contextFile(), {});
  if (!seen[code]) {
    // (The first check under this rule: whatever reviewed chapters already had counts as seen.)
    seen[code] = {};
    for (const r of rows) if (r.reviewed_at) seen[code][r.label] = seenOf(ctx?.chapters.get(r.label)?.items || []);
    fs.writeFileSync(contextFile(), JSON.stringify(seen));
  }
  // Class files used to be keyed by path and size, now by name only: the files reviewed chapters had already count as
  // seen under the new key (once per class), so the change itself never starts a review.
  const filesKey = `${code}:files-by-name`;
  if (!seen[filesKey]) {
    for (const r of rows) if (r.reviewed_at && seen[code][r.label]) seen[code][r.label] = seenOf((ctx?.chapters.get(r.label)?.items || []).filter((i) => i.file), seen[code][r.label]);
    seen[filesKey] = true;
    fs.writeFileSync(contextFile(), JSON.stringify(seen));
  }
  return rows.map((r) => {
    const c = ctx?.chapters.get(r.label);
    const old = seen[code][r.label] || { h: [], w: [] };
    const fresh = (c?.items || []).filter((i) => !(old.h || []).includes(i.h) && !(i.words && (old.w || []).some((w) => alike(w, i.words))));
    // (Material for a test further off waits until it's within three weeks, when the student studies for it.)
    const soon = c && (Date.parse(c.test.date) - Date.now()) / 864e5 <= DEPTH_DAYS;
    const due = Boolean(r.textbook_source && fresh.length && soon);
    return { ...r, next_test: c?.test || null, fresh, items: c?.items || [], due, why: due ? `new from the teacher for ${c.test.title}` : null };
  });
}

// What a review saw: each piece's hash, and the words of written text.
const seenOf = (items, old = { h: [], w: [] }) => ({ h: [...new Set([...(old.h || []), ...items.map((i) => i.h)])], w: [...new Set([...(old.w || []), ...items.filter((i) => i.words).map((i) => i.words)])] });
// Written text counts as the same when most of its words were there before (a reworded study focus isn't new material).
const alike = (a, b) => {
  const x = new Set(a.split(' '));
  const y = b.split(' ').filter(Boolean);
  return y.length > 0 && y.filter((w) => x.has(w)).length / y.length >= 0.7;
};

/** After a review: these chapters' teacher material counts as seen (so the same material never starts another). */
function depthSeen(code, rows) {
  const seen = readJson(contextFile(), {});
  seen[code] = seen[code] || {};
  for (const r of rows) seen[code][r.label] = seenOf(r.items, seen[code][r.label]);
  fs.writeFileSync(contextFile(), JSON.stringify(seen));
}

/**
 * `CODE depth`: Claude reviews the chapters with new teacher material (soonest test first) against what that material
 * says will be tested: the chapter's notes, its textbook chapter and its saved questions. Kea writes each chapter's notes
 * and a readable copy of its questions first. Explanations are fixed only on questions the student has missed. A chapter
 * judged to have gaps gets a practice set aimed at its next test, and its textbook rewritten only when the textbook
 * itself is short of what the test asks.
 */
async function depthPre(job, step, code) {
  const due = (await depthRows(code))
    .filter((c) => c.due)
    .sort((a, b) => String(a.next_test?.date || '9999').localeCompare(String(b.next_test?.date || '9999')))
    .slice(0, DEPTH_PER_RUN);
  if (!due.length) return { skip: `${code}: nothing new from the teacher since the last depth review. Checked by Kea itself, so no Claude usage.`, ok: true };
  const uv = await workspace.findUv();
  const cwd = profiles.paths().workspace;
  const study = require('./study.cjs');
  step(`Gathering ${code}'s chapter notes and questions…`);
  await study.notesFor(code, (file) => docText(uv, cwd, file), step).catch((err) => console.error('Chapter notes', err));
  const course = (await db().courses(profiles.paths().db, profiles.paths().textbooks, {}).catch(() => [])).find((c) => c.code === code);
  const dir = path.join(cwd, 'data', 'study', 'depth', code);
  fs.mkdirSync(dir, { recursive: true });
  const rel = (f) => path.relative(cwd, f).replace(/\\/g, '/');
  const lines = [];
  const tried = study.history();
  for (const c of due) {
    const qs = course ? study.catalog('exam', course.id, [c.label]) : [];
    const file = path.join(dir, `${c.label}.md`);
    const levels = ['recall', 'apply', 'multistep'].map((l) => `${qs.filter((q) => q.level === l).length} ${l}`).join(', ');
    // Kea's own check of each explanation (math as code, formulas with unexplained symbols, too thin to learn from).
    const tmp = path.join(dir, `${c.label}.check.json`);
    fs.writeFileSync(tmp, JSON.stringify({ questions: qs }));
    const weak = new Map();
    try {
      const r = await workspace.runHidden(uv, ['run', 'academic-sync', 'practice-check', tmp], { cwd, env: workspace.engineEnv(uv) });
      for (const p of JSON.parse(r.out.slice(r.out.indexOf('{'))).problems || []) {
        const m = /^question (\d+) \([^)]*\): (.*)$/.exec(p);
        // (Explanation problems only: the fixes can't change the choices or their notes.)
        if (m && !/gives itself away by length|`wrong`|shuffles choices/.test(m[2])) weak.set(Number(m[1]) - 1, [...(weak.get(Number(m[1]) - 1) || []), m[2]]);
      }
    } catch {}
    fs.rmSync(tmp, { force: true });
    const missed = (q) => tried[q.k] && tried[q.k].lastRight === false;
    const answerOf = (q) => (q.type === 'mc' ? q.choices?.[q.answer] : q.type === 'multi' ? (q.answer || []).map((i) => q.choices?.[i]).join('; ') : String(q.answer));
    fs.writeFileSync(
      file,
      [
        `# ${code} ${c.label}: the ${qs.length} saved questions (${levels}; ${qs.filter(missed).length} MISSED by the student, ${qs.filter((q, i) => missed(q) && weak.has(i)).length} of them with explanations flagged WEAK by Kea's check)`,
        '',
        ...qs.map((q, i) =>
          [
            `${i + 1}. k=${q.k} [${q.type}${q.level ? `, ${q.level}` : ''}${q.section ? `, ${q.section}` : ''}]${missed(q) ? ' MISSED' : ''}${missed(q) && weak.has(i) ? ` WEAK: ${weak.get(i).join('; ')}` : ''}${missed(q) && q.type !== 'short' && !(q.steps || []).length ? ' NO-STEPS' : ''}`,
            `   Q: ${String(q.q).replace(/\s+/g, ' ')}`,
            ...(q.choices ? [`   Choices: ${q.choices.join(' | ')}`] : []),
            `   Answer: ${answerOf(q)}${q.unit ? ` ${q.unit}` : ''}`,
            `   Explanation: ${String(q.explain || '').replace(/\s+/g, ' ')}`,
            ...((q.steps || []).length ? [`   Steps: ${q.steps.join(' / ')}`] : [])
          ].join('\n')
        )
      ].join('\n')
    );
    const notes = path.join(cwd, 'data', 'study', 'notes', code, `${c.label}.md`);
    lines.push(`- ${c.label}${c.title ? `: ${c.title}` : ''} (next test: ${c.next_test.title} on ${c.next_test.date})\n  new from the teacher since the last review (what this review is for):\n${c.fresh.map((f) => `    - ${f.text}`).join('\n')}\n  notes: ${fs.existsSync(notes) ? rel(notes) : '(none)'}\n  textbook: ${c.textbook_source ? rel(c.textbook_source) : '(none)'}\n  questions: ${rel(file)} (${qs.length}, ${weak.size} WEAK)\n  explanation fixes go in: ${rel(path.join(dir, `${c.label}.fixes.json`))}`);
  }
  const started = localStamp();
  return {
    prompt: `/kea-curriculum ${code} depth\n\nThe chapters to review:\n${lines.join('\n')}`,
    after: (ok) => {
      if (!ok) return;
      depthSeen(code, due);
      return depthAfter(code, course, started);
    }
  };
}

// The engine stamps reviews in local time (YYYY-MM-DDTHH:MM:SS), so runs compare against the same.
const localStamp = (t = Date.now()) => new Date(t - new Date(t).getTimezoneOffset() * 60000).toISOString().slice(0, 19);

/** After a depth review: chapters with gaps get a practice set for their next test (and a textbook rewrite only when the note faults the textbook). */
async function depthAfter(code, course, started) {
  if (!course) course = (await db().courses(profiles.paths().db, profiles.paths().textbooks, {}).catch(() => [])).find((c) => c.code === code);
  // The explanations the review rewrote go into the saved questions (each keeps its key, so progress carries on).
  const dir = path.join(profiles.paths().workspace, 'data', 'study', 'depth', code);
  let fixed = 0;
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.endsWith('.fixes.json')) : []) {
    try {
      if (course) fixed += require('./study.cjs').applyFixes(course.id, readJson(path.join(dir, f), []));
      fs.renameSync(path.join(dir, f), path.join(dir, `${f}.applied-${Date.now()}`));
    } catch (err) {
      console.error('Explanation fixes', err);
    }
  }
  if (fixed) send('scholar:changed');
  // More chapters with new teacher material (over DEPTH_PER_RUN): the next review starts right after. Those just
  // reviewed are marked seen first (also after a resumed run), so this ends.
  depthSeen(code, (await depthRows(code)).filter((r) => r.reviewed_at && r.reviewed_at.slice(0, 19) >= started));
  const rows = await depthRows(code);
  if (rows.some((r) => r.due)) run('curriculum', `${code} depth`, 'depth');
  if (fixed)
    addNews({ course: code, kind: 'update', title: `${code}: ${fixed} explanation${fixed > 1 ? 's' : ''} improved on questions you missed`, body: 'Each now names what every symbol in its formula stands for and why each step is taken. Your progress on those questions is kept.' });
  const gaps = rows.filter((r) => r.verdict === 'gaps' && r.reviewed_at && r.reviewed_at.slice(0, 19) >= started);
  if (!gaps.length) return;
  const study = require('./study.cjs');
  // The textbook is rewritten only for chapters whose note faults the textbook itself ("Textbook: …").
  const books = gaps.filter((g) => /\btextbook\s*:/i.test(g.note || ''));
  if (books.length && settings().get('scholar.studyPdfs', true) !== false) run('study', `rewrite ${code} ${books.map((g) => g.label).join(', ')}`, 'depth');
  if (!course) return;
  // One practice set per upcoming test, on its chapters with gaps, aimed at the review's notes (they go in its brief).
  const byTest = new Map();
  for (const g of gaps) if (g.next_test?.id) byTest.set(g.next_test.id, [...(byTest.get(g.next_test.id) || []), g]);
  for (const [itemId, list] of byTest) {
    const r = await study.request({ kind: 'exam', courseId: course.id, itemId, chapters: list.map((g) => g.label), count: Math.min(40, 15 * list.length), mode: 'new' }).catch(() => null);
    if (r?.id) run('practice', r.id, 'depth');
  }
  addNews({
    course: code,
    kind: 'update',
    title: `${code}: new practice for ${[...new Set(gaps.map((g) => g.next_test?.title).filter(Boolean))].join(', ') || 'your next test'}`,
    body: `The teacher posted new material that these chapters didn't fully cover yet:\n${gaps.map((g) => `• ${g.label}: ${String(g.note || '').slice(0, 220)}`).join('\n')}${books.length ? `\nTextbook chapters being updated: ${books.map((g) => g.label).join(', ')}.` : ''}`
  });
}

// (A depth review continued after a stop still rewrites what it found: anything it judged in the last day.)
TASKS.curriculum.afterResume = (job) => (ok) => {
  if (ok && /\bdepth\b/.test(job.arg)) depthAfter(String(job.arg).trim().split(/\s+/)[0], null, localStamp(Date.now() - 864e5)).catch(() => {});
};

TASKS.curriculum.pre = async (job, step) => {
  const code = String(job.arg || '').trim().split(/\s+/)[0];
  if (/\bdepth\b/.test(job.arg)) return depthPre(job, step, code);
  const list = await db().watchList(profiles.paths().db);
  if (!code) {
    const due = [];
    for (const c of list) {
      step(`Checking ${c.code}'s chapters against its syllabus…`);
      const r = await engineJson(['curriculum', '--course', c.code, '--json']).catch(() => null);
      if (r && !r.ok) due.push(c.code);
    }
    if (!due.length) return { skip: 'Every class’s chapters match its syllabus. Checked by Kea itself, so no Claude usage.', ok: true };
    return { split: due, summary: `Matching ${due.join(', ')} to ${due.length > 1 ? 'their syllabi' : 'its syllabus'}, one class at a time.` };
  }
  step(`Checking ${code}'s chapters against its syllabus…`);
  const r = await engineJson(['curriculum', '--course', code, '--json']).catch(() => null);
  if (r && r.ok && !/\bresume\b/.test(job.arg)) return { skip: `${code}: its chapters match its syllabus. Checked by Kea itself, so no Claude usage.`, ok: true };
  const fix = (r?.problems || []).filter((p) => p.severity === 'fix');
  return {
    prompt: `/kea-curriculum ${job.arg.trim()}${fix.length ? `\n\nWhat Kea's check found (\`curriculum --course ${code} --json\` has the whole report):\n${fix.map((p) => `- ${p.key}: ${p.text}`).join('\n')}` : ''}`,
    tools: curriculumTools()
  };
};
/** What a syllabus run may read besides the class site: publishers' and colleges' pages, and the school's own site. */
function curriculumTools() {
  const site = require('./browser.cjs').schoolInfo().home || '';
  const root = (() => {
    try {
      return new URL(site).hostname.split('.').slice(-2).join('.');
    } catch {
      return '';
    }
  })();
  return [...PUBLISHERS, ...(root ? fetchFrom([root]) : [])];
}
// A run continued in its stopped conversation skips the pre-check, so the tools it gave come back here. (A depth review
// never had them.)
TASKS.curriculum.resumeTools = (job) => (/\bdepth\b/.test(job.arg) ? [] : curriculumTools());

TASKS.practice.afterResume = (job) => (ok) => require('./study.cjs').ingest(job.arg, ok);

// Steps: Kea lists the chapter's questions without a worked solution (with their answers and explanations); Claude
// writes the steps into a file; Kea saves them into the questions (each keeps its key, so progress carries on).
async function stepsTarget(arg) {
  const [code, ...rest] = String(arg || '').trim().replace(/\s+resume$/, '').split(/\s+/);
  const label = rest.join(' ');
  const course = (await db().courses(profiles.paths().db, profiles.paths().textbooks, {}).catch(() => [])).find((c) => c.code === code);
  return { code, label, course };
}
function stepsAfter(code, label, course) {
  if (!course) return;
  const study = require('./study.cjs');
  const out = path.join(profiles.paths().workspace, 'data', 'study', 'steps', code, `${label}.steps.json`);
  if (!fs.existsSync(out)) return;
  const n = study.applyFixes(course.id, readJson(out, []));
  fs.renameSync(out, `${out}.applied-${Date.now()}`);
  if (n) send('scholar:changed');
}
TASKS.steps.pre = async (job, step) => {
  const { code, label, course } = await stepsTarget(job.arg);
  if (!course || !label) return { skip: 'Kea couldn’t find that chapter.', ok: false };
  step(`Listing ${label}'s questions that need worked steps…`);
  const b = require('./study.cjs').stepsBrief(course.id, code, label);
  if (!b.count) return { skip: `${code} ${label}: every question already has its worked steps.`, ok: true };
  return { prompt: `/kea-steps ${b.brief} ${b.output}`, after: (ok) => ok && stepsAfter(code, label, course) };
};
TASKS.steps.afterResume = (job) => (ok) => {
  if (ok) stepsTarget(job.arg).then(({ code, label, course }) => stepsAfter(code, label, course));
};

TASKS.practice.pre = async (job, step) => {
  const study = require('./study.cjs');
  step('Gathering the chapters, review sheets and what the test covers…', 1);
  const id = String(job.arg || '').split(/\s+/)[0];
  const uv = await workspace.findUv();
  const cwd = profiles.paths().workspace;
  await study.prepare(id, (file) => docText(uv, cwd, file), step, engineJson);
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
    const r = await workspace.runHidden(uv, ['run', 'academic-sync', 'coverage', '--course', code, '--json'], { cwd, env: { ...workspace.engineEnv(uv), KEA_TASK: 'coverage', KEA_RUN_ID: `${Date.now()}` } });
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
    const site = require('./browser.cjs').platformOf() === 'canvas' ? 'Canvas' : 'D2L';
    const items = [
      ...(out.uncovered || []),
      ...(rec.unmatched || []).map((u) => ({ key: u.key, title: `${u.title} (in ${site}'s ${u.kind === 'dropbox' ? 'assignments' : u.kind === 'grade' ? 'grades' : `${u.kind}s`})`, date: u.d2l_date })),
      ...(rec.drift || []).map((d) => ({ key: d.key, title: `${d.title}: ${site} says ${d.d2l_date}, your calendar ${d.item_date}`, date: d.d2l_date })),
      // Taken off the calendar earlier although D2L grades it, or graded-looking and folded into a reading week.
      ...(rec.hidden || []).map((h) => ({ key: h.key, title: `${h.item_title} (taken off your calendar: ${h.how})`, date: h.d2l_date })),
      ...(rec.suspects || []).map((x) => ({ key: x.key, title: `${x.title} (folded into "${x.replaced_by}"; may be graded work)`, date: x.date }))
    ];
    const unreadable = out.unreadable || [];
    // Scanned files get transcribed by Claude once (from their page images); the alert only names what's left.
    const scanned = unreadable.filter((u) => /no text: scanned/.test(u)).map((u) => String(u).split(' (')[0]);
    // Told once per change (the same open gap isn't repeated after every update).
    const seenFile = path.join(profiles.paths().dir, 'coverage-told.json');
    const told = readJson(seenFile, {});
    // (Tried at most every three days per class, so a file Claude can't read doesn't use the plan over and over.)
    // (Counted as tried only once Claude starts on it or it's set aside to continue: a run stopped or never started
    // is tried again at the next check. One at a time per class.)
    const tKey = `transcribe:${code}`;
    if (scanned.length && Date.now() - new Date(told[tKey] || 0).getTime() > 3 * 864e5 && !queuedOrRunning('transcribe', (a) => a.startsWith(`${code} `))) {
      run('transcribe', `${code} ${scanned.slice(0, 4).join('|')}`, 'schedule').then((r) => {
        if (!tried(r)) return;
        const now = readJson(seenFile, {});
        now[tKey] = new Date().toISOString();
        fs.writeFileSync(seenFile, JSON.stringify(now));
      });
    }
    const sig = JSON.stringify([items.map((i) => i.key), unreadable]);
    if (told[code] === sig) continue;
    told[code] = sig;
    fs.writeFileSync(seenFile, JSON.stringify(told));
    if (!items.length && !unreadable.length) continue;
    const lines = [
      ...items.slice(0, 8).map((i) => `• ${i.title} (${i.date || 'no date found'})`),
      ...unreadable.slice(0, 4).map((u) => `• ${/no text: scanned/.test(u) ? 'Scanned, being transcribed now' : "Couldn't read"}: ${path.basename(String(u).split(' (')[0])}`)
    ];
    addNews({
      course: code,
      kind: 'needs_you',
      title: items.length ? `${items.length} piece${items.length > 1 ? 's' : ''} of graded work in ${code}'s documents ${items.length > 1 ? "aren't" : "isn't"} on your calendar` : `Kea couldn't read ${unreadable.length} of ${code}'s documents`,
      body: `${lines.join('\n')}\nThe next weekly update looks into each one; check your class site for any that are due soon.`
    });
  }
}

/**
 * Every class's chapters against its syllabus (Kea's own check, no Claude). A class with something to fix gets a
 * curriculum run, once per new set of problems (and again after a week if they're still open); what a run couldn't
 * close becomes one "needs you" message, once per change.
 */
async function curriculumCheck(why = 'schedule') {
  const list = await db().watchList(profiles.paths().db);
  const file = path.join(profiles.paths().dir, 'curriculum-told.json');
  const told = readJson(file, {});
  const due = [];
  for (const c of list) {
    const r = await engineJson(['curriculum', '--course', c.code, '--json']).catch(() => null);
    if (!r) continue;
    const fix = (r.problems || []).filter((p) => p.severity === 'fix');
    const sig = JSON.stringify(fix.map((p) => p.key).sort());
    const t = told[c.code] || {};
    if (!fix.length) {
      told[c.code] = { sig, at: new Date().toISOString() };
      continue;
    }
    const week = Date.now() - new Date(t.ranAt || 0).getTime() > 7 * 864e5;
    // A new version of Kea may read what the last run couldn't (PowerPoint slides, a new site): try again at once.
    const ver = require('electron').app.getVersion();
    if (t.ranSig !== sig || week || (t.ranVer && t.ranVer !== ver)) {
      // (Recorded as run once Claude starts on it or it's set aside to continue, below: a run that never started
      // isn't "already tried", so it's queued again at the next check.)
      if (!queuedOrRunning('curriculum', (a) => a === c.code)) due.push({ code: c.code, ran: { ranSig: sig, ranVer: ver } });
      told[c.code] = { ...t, sig };
    } else if (t.toldSig !== sig) {
      // A run already tried these: tell the student what's still open, once.
      told[c.code] = { ...t, sig, toldSig: sig };
      addNews({
        course: c.code,
        kind: 'needs_you',
        title: `${c.code}'s chapters don't fully match its syllabus yet`,
        body: `${fix.slice(0, 6).map((p) => `• ${p.text}`).join('\n')}${fix.length > 6 ? `\n…and ${fix.length - 6} more.` : ''}\nKea tries again next week; anything you can find (a syllabus page, the book's contents) helps.`
      });
    }
  }
  // Depth: a class gets a depth review when a chapter with a test still to come has new material from the teacher
  // (Kea's own check, no Claude), at most once a day.
  const deep = [];
  for (const c of settings().get('scholar.depthReviews', true) === false ? [] : list) {
    if (!(await depthRows(c.code)).some((r) => r.due)) continue;
    const t = told[c.code] || {};
    if (Date.now() - new Date(t.depthAt || 0).getTime() > 864e5 && !queuedOrRunning('curriculum', (a) => a === `${c.code} depth`)) deep.push(c.code);
  }
  fs.writeFileSync(file, JSON.stringify(told, null, 1));
  // What a run that really went (or waits to continue) records, read and written again then (the run ends later).
  const mark = (code, fields) => (r) => {
    if (!tried(r)) return;
    const now = readJson(file, {});
    now[code] = { ...(now[code] || {}), ...fields() };
    fs.writeFileSync(file, JSON.stringify(now, null, 1));
  };
  for (const d of due) run('curriculum', d.code, why).then(mark(d.code, () => ({ ...d.ran, ranAt: new Date().toISOString() })));
  for (const code of deep) run('curriculum', `${code} depth`, why).then(mark(code, () => ({ depthAt: new Date().toISOString() })));
  return due.map((d) => d.code);
}

function addNews(n) {
  const list = readJson(newsFile(), []);
  list.unshift({ id: `${Date.now()}`, at: new Date().toISOString(), read: false, ...n });
  fs.mkdirSync(path.dirname(newsFile()), { recursive: true });
  fs.writeFileSync(newsFile(), JSON.stringify(list.slice(0, 300), null, 1));
  send('scholar:news', n);
  if (Notification.isSupported()) new Notification({ title: n.course ? `${n.course}: ${n.title}` : n.title, body: n.body.slice(0, 220) }).show();
}

// ---------- A run stopped partway: pause, then continue where it stopped ----------
// A run can stop partway three ways: the student's Claude usage limit, a server or connection problem Claude Code
// couldn't get past, or Kea closing (or the computer shutting down) in the middle of it. In each, everything saved so far
// stays saved (every engine command is its own transaction, and the database is copied before the run). The stopped
// run is set aside with every run waiting behind it, and continues later in the same Claude conversation (`--resume`),
// so nothing it had read but not yet saved has to be found again.
const LIMIT = /hit your (?:session |usage |weekly |daily |5-hour |opus )?limit|usage limit reached|limit (?:will )?resets?|Claude AI usage limit/i;
// A problem that passes by itself (Claude Code has already retried it a few times by the time it gives up).
const TRANSIENT = /API Error|overloaded|\b(?:500|502|503|504|529)\b|internal server error|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|socket hang up|fetch failed|connection error|network error|request timed out|timed out|rate.?limit/i;
/**
 * The server or connection problem a run ended on (the matched words), or null. Read only from what reports errors:
 * Claude Code's error output, a failed result's kind, and an error message of Claude Code's own ("API Error: 529 …",
 * "Request timed out") as a failed result's text or the last message. Never Claude's own writing, where "500 points"
 * or "the quiz timed out" are just words.
 */
const ERROR_TEXT = /^\s*(?:API Error|[A-Za-z]*Error:|Request timed out|Connection error|fetch failed|overloaded|internal server error)/i;
function transientError(result, lastText, errText) {
  const resultText = String(result?.result || '');
  const sources = [
    errText,
    result?.is_error && ERROR_TEXT.test(resultText) ? resultText : '',
    result?.subtype && result.subtype !== 'success' ? String(result.subtype) : '',
    // (Claude Code's own message for a failed request, never anything Claude wrote.)
    /^\s*API Error\b/i.test(lastText || '') ? lastText : ''
  ];
  for (const s of sources) {
    const m = s && String(s).match(TRANSIENT);
    if (m) return m[0];
  }
  return null;
}
// How many times a run that hit server problems is tried again, and how long apart.
const RETRIES = 3;
const RETRY_MINUTES = [10, 30, 60];

/** When a "resets 8:10pm" message means the limit is over (local time), or in an hour when it can't be read. */
function resetTime(msg, now = new Date()) {
  // (Older Claude Code: "Claude AI usage limit reached|1760035200", the reset time in seconds.)
  const epoch = /\|(\d{10})\b/.exec(msg || '');
  if (epoch) return new Date(Number(epoch[1]) * 1000 + 3 * 60000);
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
// The run Claude is working on right now, kept on disk: if Kea closes in the middle of it, the next start knows.
const inflightFile = () => path.join(profiles.paths().dir, 'inflight.json');

/**
 * The runs waiting to continue, if any: { until, reason ('limit' | 'error' | 'closed'), runs: [{ task, arg, label,
 * session, started, tries }] }, plus the first run's task, arg and label (what the Scans page shows) and how many more.
 */
function pending() {
  const p = readJson(resumeFile(), null);
  if (!p) return null;
  // (Before v0.35 only one run waited: { task, arg, label, until }.)
  const runs = Array.isArray(p.runs) ? p.runs.filter((r) => TASKS[r.task]) : p.task ? [{ task: p.task, arg: p.arg || '', label: p.label, started: true }] : [];
  if (!runs.length) return null;
  return { until: p.until, reason: p.reason || 'limit', runs, task: runs[0].task, arg: runs[0].arg, label: runs[0].label || TASKS[runs[0].task].label, more: runs.length - 1 };
}
function setPending(p) {
  if (p) {
    const tmp = `${resumeFile()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ until: p.until, reason: p.reason, runs: p.runs }, null, 1));
    fs.renameSync(tmp, resumeFile());
  } else fs.rmSync(resumeFile(), { force: true });
  send('scholar:resume', pending());
}

/**
 * Set runs aside to continue at `until`: the one that stopped (with its Claude conversation) and every run queued
 * behind it, which would only stop the same way. Runs already waiting stay, each run once.
 */
function pause(until, reason, stopped) {
  const old = pending();
  const waiting = queue.splice(0);
  for (const j of waiting) {
    if (j.batch) batches.delete(j.batch);
    j.resolve({ paused: until.toISOString(), task: j.task, arg: j.arg });
  }
  const runs = [...(stopped ? [stopped] : []), ...(old?.runs || []), ...waiting.filter((j) => j.profile === profiles.active()).map(runOf)];
  // (The earliest of the two times when runs were already waiting for a later one.)
  const at = old && new Date(old.until) < until && old.reason === reason ? new Date(old.until) : until;
  setPending({ until: at.toISOString(), reason, runs: eachOnce(runs) });
}

/** A queued run as it's kept with the runs waiting to continue. */
const runOf = (j) => ({ task: j.task, arg: j.arg, label: TASKS[j.task].label, session: j.session || null, started: !!j.started, tries: j.tries || 0 });
/** Each run once (the first kept): a continued run's `resume` argument doesn't make it another run. */
function eachOnce(runs) {
  const seen = new Set();
  return runs.filter((r) => {
    const k = `${r.task}|${String(r.arg || '').replace(/\s*\bresume\b/, '').trim()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** A scheduled run reached while runs wait to continue: it joins them (same time, same reason) instead of being dropped. */
function setAside(job, p) {
  if (job.batch) batches.delete(job.batch);
  setPending({ until: p.until, reason: p.reason, runs: eachOnce([...p.runs, runOf(job)]) });
  job.resolve({ paused: p.until, task: job.task, arg: job.arg });
}

/** Whether a run of this task is queued or running now (its argument by `match`, `resume` aside). */
const queuedOrRunning = (task, match) => [current?.job, ...queue].some((j) => j && j.task === task && match(String(j.arg || '').replace(/\s*\bresume\b/, '').trim()));
/** Whether a run counts as tried: Claude started on it, or it was set aside to continue later (not stopped or dropped). */
const tried = (r) => Boolean(r && (r.paused || r.claude));

/** The argument that makes a task continue instead of starting over (see "Continuing a run" in Kea's CLAUDE.md). */
const resumeArg = (arg) => (/\bresume\b/.test(arg || '') ? arg : `${arg || ''} resume`.trim());

/** Continue the waiting runs now (the schedule calls this once their time comes; Scans has a button for it). */
function resume() {
  const p = pending();
  if (!p) return false;
  setPending(null);
  for (const r of p.runs) run(r.task, r.started ? resumeArg(r.arg) : r.arg, 'resume', null, { session: r.session || null, started: !!r.started, tries: r.tries || 0, stopReason: p.reason });
  return true;
}

/** Continue the last stopped run of a task (for a run that stopped before Kea could pause it). */
function resumeLast(task) {
  const last = readJson(activityFile(), []).find((e) => e.task === task);
  run(task, resumeArg(last?.arg || ''), 'resume', null, { session: last?.session || null, started: true });
  return true;
}

/**
 * At start: a run Kea was in the middle of when it closed (or the computer shut down) continues as soon as Kea is
 * ready; a run that stopped at a usage limit before Kea could pause runs (v0.21) is picked up the same way.
 */
function adoptStopped() {
  const f = readJson(inflightFile(), null);
  if (f && TASKS[f.task]) {
    fs.rmSync(inflightFile(), { force: true });
    const now = new Date();
    saveActivity({ id: `${Date.now()}`, task: f.task, label: TASKS[f.task].label, arg: f.arg || '', why: f.why || '', start: f.start || now.toISOString(), end: now.toISOString(), ok: false, paused: now.toISOString(), claude: true, session: f.session || null, summary: 'Interrupted: Kea closed (or the computer shut down) during this run. Everything it saved is kept, and it continues where it stopped.', steps: [] });
    pause(now, 'closed', { task: f.task, arg: f.arg || '', label: TASKS[f.task].label, session: f.session || null, started: true, tries: f.tries || 0 });
    return;
  }
  if (pending()) return;
  const last = readJson(activityFile(), [])[0];
  if (!last || last.ok || last.paused || !LIMIT.test(last.summary || '')) return;
  const until = resetTime(last.summary, new Date(last.end || last.start));
  last.paused = until.toISOString();
  saveActivity(last);
  setPending({ until: until.toISOString(), reason: 'limit', runs: [{ task: last.task, arg: last.arg || '', label: last.label, session: last.session || null, started: true }] });
}

/**
 * Kea is quitting: stop Claude (an orphaned run would keep writing with no one watching), but remember the run (its
 * inflight.json, picked up by adoptStopped at the next start) and every run waiting behind it, which continue then too.
 */
function shutdown() {
  if (quitting) return;
  quitting = true;
  const waiting = queue.splice(0).filter((j) => j.profile === profiles.active());
  // (A run still in Kea's own pre-check has no inflight.json yet: it waits with the others, first.)
  if (current && !current.entry.claude && current.job.profile === profiles.active()) waiting.unshift(current.job);
  if (waiting.length) {
    try {
      // Runs already waiting keep their time and reason (a usage limit still holds); else they go at the next start.
      const old = pending();
      setPending({ until: old ? old.until : new Date().toISOString(), reason: old ? old.reason : 'closed', runs: eachOnce([...(old?.runs || []), ...waiting.map(runOf)]) });
    } catch (err) {
      console.error('Saving the waiting runs', err);
    }
  }
  try {
    current?.child?.kill();
  } catch {}
}
let quitting = false;

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

/**
 * Queue a run. Resolves when it finishes, with its summary. `cont` continues a stopped run: { session (its Claude
 * conversation), started, tries }.
 */
function run(task, arg = '', why = 'manual', batch = null, cont = {}) {
  if (!TASKS[task]) throw new Error(`Unknown run: ${task}`);
  return new Promise((resolve) => {
    queue.push({ task, arg, why, resolve, batch, profile: profiles.active(), session: cont.session || null, started: !!cont.started, tries: cont.tries || 0, stopReason: cont.stopReason || null });
    next();
  });
}

// While a run goes, the computer doesn't fall asleep under it (a laptop that slept at 6 AM left the 10/20 daily check
// waiting five hours on one command). The screen may still turn off; only system sleep waits.
let awake = null;
function stayAwake(on) {
  try {
    const { powerSaveBlocker } = require('electron');
    if (on && (awake === null || !powerSaveBlocker.isStarted(awake))) awake = powerSaveBlocker.start('prevent-app-suspension');
    else if (!on && awake !== null) {
      if (powerSaveBlocker.isStarted(awake)) powerSaveBlocker.stop(awake);
      awake = null;
    }
  } catch {}
}

async function next() {
  if (quitting) return;
  if (current || !queue.length) {
    if (!current && !queue.length) stayAwake(false);
    return;
  }
  stayAwake(true);
  const job = queue.shift();
  // A run belongs to the profile it was queued for (profiles can't be switched while one runs).
  if (job.profile !== profiles.active()) {
    job.resolve(null);
    return next();
  }
  // While paused for a usage limit, scheduled runs wait (they'd only hit the same limit): each joins the runs set aside,
  // so it starts with them instead of being dropped. Runs the student starts still go.
  const p = pending();
  if (p && job.why === 'schedule' && new Date(p.until) > new Date()) {
    setAside(job, p);
    return next();
  }
  const t = TASKS[job.task];
  const est = estimate(job.task, job.arg);
  const b = job.batch && batches.get(job.batch);
  // phase: 'check' while Kea looks by itself, 'claude' once Claude is reading. turns: Claude's steps so far.
  const entry = { id: `${Date.now()}`, task: job.task, label: t.label, arg: job.arg, why: job.why, start: new Date().toISOString(), end: null, ok: null, summary: '', steps: [], phase: 'check', claudeStart: null, expectedMs: est.ms, expectedTurns: est.turns, turns: 0, percent: null, claude: false, batch: b ? { id: job.batch, done: b.done, total: b.total } : null };
  current = { entry, child: null, server: null, job };
  const step = (message, percent) => {
    entry.steps.push({ at: new Date().toISOString(), message });
    if (entry.steps.length > 200) entry.steps.shift();
    if (Number.isFinite(percent)) entry.percent = Math.max(0, Math.min(100, percent));
    send('scholar:run', { ...entry, running: true });
  };
  // (Once per run: a Claude Code that fails to start reports both 'error' and 'close'.)
  let finished = false;
  const finish = (ok, summary) => {
    if (finished || quitting) return;
    finished = true;
    fs.rmSync(inflightFile(), { force: true });
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
    // (Only this run's own: never another run's connection or slot.)
    if (current && current.job === job) {
      current.server?.close();
      current = null;
    }
    job.resolve(entry);
    next();
  };
  try {
    const claude = await workspace.findClaude();
    const uv = await workspace.findUv();
    if (!claude || !uv) return finish(false, 'Class scans aren’t set up yet (Claude Code and uv are needed).');
    const cwd = workspace.prepare();
    // Check folders and run logs older than two weeks go (at most once a day).
    try {
      precheck().prune(cwd);
    } catch (err) {
      console.error('Pruning old checks', err);
    }
    let prompt = t.prompt(job.arg);
    let after = null;
    let extraTools = [];
    // Continuing a stopped conversation: Claude already has its instructions and everything it read.
    if (job.session) {
      after = t.afterResume ? t.afterResume(job) : null;
      try {
        extraTools = t.resumeTools ? t.resumeTools(job) : [];
      } catch (err) {
        console.error('Resume tools', err);
      }
    } else if (t.pre) {
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
      extraTools = pre.tools || [];
    }
    // Kea started quitting during the pre-check: no Claude now (shutdown set this run aside to continue at next start).
    if (quitting) return;
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
    // Nor may it touch the database file or the run logs directly: every change goes through the engine, which keeps
    // the item history.
    const how = job.session
      ? ['-p', `Kea stopped this run partway (${{ limit: 'your Claude usage limit', error: 'a server or connection problem', closed: 'Kea closed' }[job.stopReason] || 'it was interrupted'}) and is continuing it now. Carry on exactly where you stopped: everything you saved is still saved, so don't start over or re-read what you already have. Call mcp__kea__kea_progress first if you have it (the connection to Kea is new).`, '--resume', job.session]
      : ['-p', prompt];
    const args = [...how, '--model', 'opus', '--output-format', 'stream-json', '--verbose', '--mcp-config', cfg, '--strict-mcp-config', '--permission-mode', 'dontAsk', '--allowedTools', ...t.tools, ...extraTools, '--disallowedTools', 'Read(**/*.pdf)', 'Read(./src/**/*.py)', 'Edit(data/*.db)', 'Write(data/*.db)', 'Edit(data/logs/**)', 'Write(data/logs/**)', 'Edit(data/backups/**)', 'Write(data/backups/**)'];
    // A copy of the database before every run that can change it (the newest 30 are kept), and the run's id for the
    // item history, so every change can be traced to this run and undone from its copy.
    if (['import', 'sync', 'daily', 'study'].includes(job.task)) {
      try {
        const dbFile = profiles.paths().db;
        const backups = path.join(path.dirname(dbFile), 'backups');
        fs.mkdirSync(backups, { recursive: true });
        const name = path.join(backups, `${new Date().toISOString().replace(/[:.]/g, '-')}-${job.task}-${entry.id}.db`);
        fs.copyFileSync(dbFile, name);
        // (With its journal files, if SQLite left any, so the copy is complete.)
        for (const x of ['-wal', '-shm', '-journal']) if (fs.existsSync(dbFile + x)) fs.copyFileSync(dbFile + x, name + x);
        const old = fs.readdirSync(backups).filter((f) => f.endsWith('.db')).sort();
        for (const f of old.slice(0, Math.max(0, old.length - 30))) fs.rmSync(path.join(backups, f), { force: true });
      } catch (err) {
        console.error('Backup before run', err);
      }
    }
    entry.phase = 'claude';
    entry.claude = true;
    entry.claudeStart = new Date().toISOString();
    entry.session = job.session || null;
    // On disk while Claude works, so a run cut off by Kea closing is found and continued at the next start.
    const inflight = () => {
      try {
        fs.writeFileSync(inflightFile(), JSON.stringify({ task: job.task, arg: job.arg, why: job.why, start: entry.start, session: entry.session, tries: job.tries || 0 }));
      } catch {}
    };
    inflight();
    step(`${job.session ? 'Continuing: ' : ''}${t.label}…`);
    const child = spawn(claude, args, { cwd, env: { ...workspace.engineEnv(uv), KEA_RUN_ID: String(entry.id), KEA_TASK: job.task }, windowsHide: true });
    current.child = child;
    let buf = '';
    let result = null;
    let errText = '';
    let lastText = '';
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
          // The conversation's id, as soon as Claude Code gives it: what a stopped run continues in.
          if (ev.session_id && ev.session_id !== entry.session) {
            entry.session = ev.session_id;
            inflight();
          }
          if (ev.type === 'assistant') for (const c of ev.message?.content || []) if (c.type === 'text' && c.text) lastText = String(c.text).slice(-2000);
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
    child.stderr.on('data', (d) => {
      out.write(d);
      errText = (errText + d).slice(-4000);
    });
    // Whichever of 'error' and 'close' comes first decides how the run ended (a failed start can send both).
    let settled = false;
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      out.end();
      fs.rmSync(cfg, { force: true });
      try {
        after?.(false);
      } catch {}
      finish(false, `Couldn’t start Claude Code: ${err.message}`);
    });
    child.on('close', (code) => {
      if (!out.writableEnded) {
        out.write(`\n=== exit ${code} ===\n`);
        out.end();
      }
      fs.rmSync(cfg, { force: true });
      // Kea is quitting: the in-flight record stays, and the next start continues this run.
      if (quitting || settled) return;
      settled = true;
      const text = String(result?.result || '');
      const said = `${text}\n${lastText}\n${errText}`;
      // A server or connection problem, read only from real error output (never Claude's own words: "500 points").
      const transient = transientError(result, lastText, errText);
      const stoppedRun = (tries) => ({ task: job.task, arg: job.arg, label: t.label, session: entry.session, started: true, tries });
      const atTime = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      const failed = !result || result.is_error;
      if (job.stopping) {
        try {
          after?.(false);
        } catch {}
        finish(false, 'Stopped.');
      } else if (LIMIT.test(text) || (failed && LIMIT.test(said))) {
        // Out of Claude usage: everything saved so far stays; continue once the limit resets.
        const until = resetTime(LIMIT.test(text) ? text : said);
        entry.paused = until.toISOString();
        pause(until, 'limit', stoppedRun(job.tries || 0));
        if (Notification.isSupported()) new Notification({ title: 'Class scan paused', body: `Your Claude usage limit was reached. Kea continues where it stopped at ${atTime(until)}.` }).show();
        finish(false, `Paused: your Claude usage limit was reached. Everything found so far is saved, and Kea continues where it stopped at ${atTime(until)}.`);
      } else if (job.session && failed && /no conversation found|session.{0,40}not found|could not (?:find|resume)/i.test(said)) {
        // The stopped conversation couldn't be reopened (Claude Code cleared it): continue from what's saved instead.
        queue.unshift({ ...job, session: null, resolve: () => {}, started: true, arg: resumeArg(job.arg) });
        finish(false, 'Couldn’t reopen the stopped conversation, so this run continues from what was saved.');
      } else if (failed && (transient || (!result && code !== 0 && code !== null)) && (job.tries || 0) < RETRIES) {
        // A server or connection problem (or Claude Code itself crashing): try again later, in the same conversation.
        const tries = (job.tries || 0) + 1;
        const until = new Date(Date.now() + RETRY_MINUTES[tries - 1] * 60000);
        entry.paused = until.toISOString();
        pause(until, 'error', stoppedRun(tries));
        finish(false, `Paused: Claude couldn’t be reached (${(transient || 'the connection dropped').trim()}). Everything found so far is saved, and Kea continues where it stopped at ${atTime(until)} (try ${tries} of ${RETRIES}).`);
      } else if (result && !result.is_error) {
        try {
          after?.(true);
        } catch {}
        // Every import and weekly update ends with Kea's own coverage check (not left to Claude remembering).
        if (job.task === 'import' || job.task === 'sync' || job.task === 'daily') coverageCheck(job.task === 'daily' ? '' : job.arg).catch((err) => console.error('Coverage', err));
        // A class's first scan is held to its syllabus straight away.
        if (job.task === 'import' && job.arg.trim() && !/\bresume\b/.test(job.arg)) run('curriculum', job.arg.trim().split(/\s+/)[0], job.why);
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

/** Stop the run (the student's choice: it isn't continued later) and clear the queue. */
function stop() {
  for (const j of queue.splice(0)) j.resolve(null);
  if (current?.child) {
    current.job.stopping = true;
    current.child.kill();
  }
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

module.exports = { run, stop, status, activity, news, markNewsRead, deleteNews, pending, resume, resumeLast, resetTime, adoptStopped, shutdown, curriculumCheck, TASKS, _test: { depthRows, transientError, eachOnce, queue: () => queue, current: () => current } };
