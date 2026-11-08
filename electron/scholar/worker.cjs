// Worker mode: one shared-Claude job for someone else, run by a separate, hidden copy of Kea on the Hub owner's PC
// (its own data folder, so the owner's own Kea and classes are never touched). Started by the owner's Kea
// (hub.cjs, launcher) with KEA_WORKER_JOB, KEA_WORKER_TASK, KEA_USERDATA, KEA_OWNER_KEY_FILE and KEA_HUB_OWNER_PORT.
//
// A scan (KEA_WORKER_TASK import or sync):
// 1. Read the job: the student's class-site address and profile name (never their password).
// 2. Set up a profile like theirs, bring in what their Kea folder on the Hub already has, and become its primary
//    device (devices.cjs), the role a student's second computer would follow.
// 3. Run the class import with the owner's Claude. Every class-site read goes through the relay to their own Kea.
// 4. Publish (classes, data file) into the folder, hand the primary role back, and send it to their Kea folder on the
//    Hub. A scan for one course section also puts its material (textbook chapters, question banks) in the section's
//    shared folder, for classmates who joined it or share the section later. Report done, and quit.
//
// 25 more questions (KEA_WORKER_TASK more_questions): no class site at all.
// 1. Bring in their Kea folder as a follower (their classes, textbooks and saved questions), never as the primary.
// 2. Write one batch of new questions for the chapter with the owner's Claude, different from every question they
//    already have and from the course section's shared pool.
// 3. Put the batch in the section's pool (material/questions/). When the job finishes, the Hub copies it into the Kea
//    folder of everyone who asked for it, and their Kea takes it in on its next sync (sharedMaterial.cjs).
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const remote = require('./remote.cjs');

const log = (...a) => {
  const line = `${new Date().toISOString()} worker ${remote.JOB}: ${a.join(' ')}`;
  console.log(line);
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'worker.log'), `${line}\n`);
  } catch {}
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// The longest one job may take (the owner's launcher passes Settings → Kea's shared Claude → longest job), then Claude
// and everything it started are ended and the job is reported as over time.
const LIMIT_MS = Number(process.env.KEA_WORKER_LIMIT_MS) || 45 * 60e3;
const TASK = process.env.KEA_WORKER_TASK || 'import';
const OVER_TIME = 'The job ran over its time limit.';
let overTime = false;

/** This copy's account and profile, and a sync of their Kea folder through the owner console. */
function setUp(profileName) {
  // The account this copy acts under: it only ever runs on the owner's PC, for the owner's queue.
  fs.writeFileSync(path.join(app.getPath('userData'), 'account.json'), JSON.stringify({ email: 'worker@kea.local', name: 'Kea worker', verified: { email: 'worker@kea.local', by: 'Kea worker' } }));
  const profiles = require('./profiles.cjs');
  profiles.rename(profiles.active(), String(profileName || 'School').slice(0, 40));
  const { createSync } = require('./hubsync.cjs');
  return createSync({ root: remote.syncRoot(), stateFile: path.join(app.getPath('userData'), 'hub-sync-state.json'), client: remote.syncClient(), log, now: () => Date.now() + 10_000 });
}

async function runTask(task, arg) {
  const runner = require('./runner.cjs');
  log('running', task, arg || '');
  await runner.run(task, arg || '', 'worker');
  while (runner.status().running || runner.status().queued.length) {
    if (overTime) throw new Error(OVER_TIME);
    await wait(5000);
  }
  if (overTime) throw new Error(OVER_TIME);
  const last = runner.activity?.()?.[0];
  if (last && last.ok === false) throw new Error(last.error || 'The run didn’t finish.');
}

/** The profile name from the Hub's "kea/Kea/<profile>/" (their Kea says where its folder is), else the fallback. */
function profileFromTarget(target, fallback) {
  const m = /^kea\/Kea\/([^/]+)\/$/.exec(target || '');
  if (!m) return fallback;
  // (A name that can't be decoded, an impossible code point, falls back: decodeSeg answers null, or threw before.)
  let name = null;
  try {
    name = require('./hubsync.cjs').decodeSeg(m[1]);
  } catch {}
  return typeof name === 'string' && name.trim() ? name : fallback;
}

/** Text a question is known by: the same question with different capitals or punctuation is still the same. */
const qText = (q) => String(q?.q ?? q?.front ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * The questions to send: new ones only (not in `known`, not repeated within the batch), at most `size`.
 * `known`: texts (qText) of every question they or the section already have.
 */
function freshQuestions(made, known, size) {
  const seen = new Set(known);
  const out = [];
  for (const q of made) {
    const t = qText(q);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(q);
    if (out.length >= size) break;
  }
  return out;
}

/** Course material from this workspace: its textbook chapters and question banks, as material/<path> files. */
function* materialFiles() {
  const P = require('./profiles.cjs').paths();
  const walk = function* (dir, rel) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) yield* walk(path.join(dir, e.name), `${rel}/${e.name}`);
      else if (!/\.(tmp|part)$/i.test(e.name)) yield { path: `material${rel}/${e.name}`, file: path.join(dir, e.name) };
    }
  };
  yield* walk(P.textbooks, '/Textbooks');
  const study = require('./study.cjs');
  for (const e of study.list().filter((x) => x.bank && x.status === 'ready' && x.source !== 'mine')) {
    const set = study.get(e.id)?.set;
    if (set) yield { path: `material/questions/${e.id}.json`, data: JSON.stringify({ entry: e, set, courseCode: e.courseCode, chapter: e.chapters?.[0] || null }) };
  }
}

async function shareMaterial(info) {
  const { encodeSeg } = require('./hubsync.cjs');
  let n = 0;
  for (const f of materialFiles()) {
    const p = f.path.split('/').map((s, i) => (i === 0 ? s : encodeSeg(s))).join('/');
    const data = f.data != null ? Buffer.from(f.data) : fs.readFileSync(f.file);
    if (data.length > 60 * 1024 * 1024) continue;
    try {
      await remote.putCourseFile(p, data);
      n++;
    } catch (e) {
      log('material not shared:', f.path, e.message);
    }
  }
  log(`shared ${n} material files with the course section (${info.members.length} joined)`);
}

async function scan(info) {
  const job = await remote.job();
  log('job', JSON.stringify({ home: job.home, platform: job.platform, profile: job.profile }));
  if (!/^https:\/\//.test(job.home || '')) throw new Error('The job has no class-site address.');
  const sync = setUp(job.profile);
  require('./browser.cjs').setHome(job.home, job.platform);

  // Their Kea folder: bring in what's there, then take the primary role for it.
  await sync.cycle();
  const devices = require('./devices.cjs');
  devices.claimHere();
  await sync.cycle();

  // Their Kea has to be there to browse for us.
  const st = await remote.status();
  if (!st?.signedIn) throw new Error('The student’s Kea isn’t signed in to their class site. Ask them to open Kea and sign in, then queue it again.');

  await runTask(TASK);

  // Publish into the folder (as the primary), hand the role back, and send it to their Kea folder on the Hub.
  await require('./index.cjs').publish();
  devices.releaseHere();
  devices.forgetHere();
  await sync.cycle();
  // A scan for one course section (not someone's own "all my classes" scan): its material is the section's.
  if (info.members.length || !/\|allclasses\|/.test(info.job.course || '')) await shareMaterial(info);
  return `${TASK} done`;
}

async function moreQuestions(info) {
  const j = info.job;
  const d = j.detail || {};
  const chapter = String(j.chapter || d.chapter || '').trim();
  const code = String(d.courseCode || '').trim();
  if (!chapter || !code) throw new Error('The request didn’t say which class and chapter.');
  const sync = setUp(profileFromTarget(j.target, d.profile));
  // Their classes, textbooks and saved questions, as a follower: the primary role stays theirs.
  await sync.cycle();
  const devices = require('./devices.cjs');
  await devices.step();
  devices.forgetHere();
  await sync.cycle();

  const P = require('./profiles.cjs').paths();
  const db = require('./db.cjs');
  const { matchCourse } = require('./sharedMaterial.cjs');
  const course = matchCourse((await db.courses(P.db, P.textbooks, {})).map((c) => ({ id: c.id, code: c.code })), code);
  if (!course) throw new Error(`Their Kea folder has no class ${code} yet. Their Kea has to have the class set up and synced to Kea Cloud first.`);

  // The section's shared pool for this chapter: questions classmates already got aren't written again.
  const pool = [];
  for (const f of await remote.courseFiles('material/questions/')) {
    try {
      const doc = JSON.parse((await remote.courseFile(f.path)).toString('utf8'));
      if ((doc.chapter || doc.entry?.chapters?.[0]) !== chapter) continue;
      pool.push(...(doc.set?.questions || []));
    } catch {}
  }

  const study = require('./study.cjs');
  const size = Number(j.batchSize) || 25;
  const before = study.catalog('exam', course.id, [chapter]);
  // A new set of `size` questions (none reused), told about every question already there (theirs and the pool's).
  const req = await study.request({ kind: 'exam', courseId: course.id, chapters: [chapter], count: size, mode: 'new', bank: true });
  const reqFile = path.join(P.workspace, 'data', 'study', 'requests', `${req.id}.json`);
  const brief = JSON.parse(fs.readFileSync(reqFile, 'utf8'));
  brief.count = size;
  brief.existing = [...(brief.existing || []), ...pool.map((q) => ({ k: q.k || null, chapter, topic: q.topic || null, text: String(q.q ?? '').slice(0, 140) }))];
  fs.writeFileSync(reqFile, JSON.stringify(brief, null, 1));

  await runTask('practice', req.id);
  const entry = study.list().find((e) => e.id === req.id);
  if (!entry || entry.status !== 'ready') throw new Error(entry?.error || 'The questions weren’t written.');
  const questions = freshQuestions(study.get(req.id)?.set?.questions || [], [...before, ...pool].map(qText), size);
  if (!questions.length) throw new Error('Every question that came back repeated one they already have.');

  const doc = {
    entry: { ...entry, title: `${questions.length} more questions: ${chapter}`, count: questions.length, sharedClaude: true },
    set: { questions },
    courseCode: course.code,
    chapter,
    madeAt: new Date().toISOString(),
  };
  await remote.putCourseFile(`material/questions/${req.id}.json`, Buffer.from(JSON.stringify(doc)));
  log(`${questions.length} new questions for ${course.code} ${chapter}`);
  return `${questions.length} new questions for ${chapter}`;
}

async function run() {
  let ok = false, note = '';
  let backstop = null;
  const deadline = setTimeout(() => {
    overTime = true;
    log('over the time limit: ending Claude and everything it started');
    require('./runner.cjs').stop().catch((e) => log('stopping:', e.message));
    // The job then ends the usual way (reported, then this copy quits). If something hangs (a relayed call that never
    // comes back), report it and quit anyway; Claude's process tree is already gone.
    backstop = setTimeout(() => {
      log('still running a minute after the time limit: quitting');
      remote.finish(false, OVER_TIME).catch(() => {}).finally(() => app.exit(2));
    }, 60_000);
  }, LIMIT_MS);
  try {
    const info = await remote.jobInfo();
    if (overTime) throw new Error(OVER_TIME);
    note = TASK === 'more_questions' ? await moreQuestions(info) : await scan(info);
    if (overTime) throw new Error(OVER_TIME);
    ok = true;
  } catch (e) {
    note = overTime ? OVER_TIME : e.message;
    log('failed:', note);
  } finally {
    clearTimeout(deadline);
  }
  try {
    await remote.finish(ok, note);
  } catch (e) {
    log('finish failed:', e.message);
  }
  log(ok ? 'done' : 'ended with an error');
  clearTimeout(backstop);
  app.exit(ok ? 0 : 1);
}

module.exports = { run, _test: { profileFromTarget, qText, freshQuestions } };
