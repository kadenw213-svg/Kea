// Course material from Kea's shared Claude, taken in from the sync folder's Shared/ (next to Devices/).
//
// The Kea Hub copies it into this person's own Kea storage when a shared job finishes: the 25 new questions they (or
// a classmate in the same course section) asked for, and a classmate's scan's textbook chapters when they joined it or
// share the section. It arrives with the next sync, like any other file:
//
//   <sync folder>/Kea/<profile>/Shared/questions/<set id>.json   { entry, set, courseCode, chapter }
//   <sync folder>/Kea/<profile>/Shared/Textbooks/<course>/<file>  a textbook chapter
//
// Only the device that runs this profile's classes (the primary, or a device on its own) takes it in; it then shares
// it with the others the usual way (devices.cjs), so it's taken in once. Course ids differ from person to person (each
// Kea makes its own), so the class is found by its course code.
const fs = require('fs');
const path = require('path');

const { validCode, safeFileName } = require('./safePaths.cjs');

const norm = (code) => String(code || '').toLowerCase().replace(/[^a-z0-9]/g, '');
/** The code without a section number written after it ("CHEM 1110-002", "CHEM 1110 002", "CHEM1110.01" → "CHEM 1110"). */
const unsectioned = (code) => String(code || '').replace(/^(.*\d)[\s.-]+[A-Za-z]?\d{1,3}$/, '$1');

/**
 * The class here with this course code: the same code however it's written ("BIO 1010" and "bio-1010"), else the same
 * code with a section number on only one side ("CHEM1110" and "CHEM 1110-002"), never another section ("-001" and "-002"). Whole codes are compared, never one code
 * starting with another, and a code that can't be a folder name ("BIO1010\..\..\x") never matches anything.
 */
function matchCourse(courses, code) {
  if (!validCode(code)) return null;
  const mine = courses.filter((c) => validCode(c.code));
  const want = norm(code);
  if (!want) return null;
  // (Two different sections, 001 and 002, are different classes: other instructors, schedules and tests. The code
  // without its section counts only when one of the two names no section at all.)
  const sectioned = (x) => norm(unsectioned(x)) !== norm(x);
  return mine.find((c) => norm(c.code) === want) || mine.find((c) => !(sectioned(c.code) && sectioned(code)) && norm(unsectioned(c.code)) === norm(unsectioned(code))) || null;
}

/** Every file under Shared/, relative to it (forward slashes), with its size and time. */
function listShared(dir) {
  const out = [];
  const walk = (d, rel) => {
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (!/\.(tmp|part)$/i.test(e.name)) {
        const s = fs.statSync(path.join(d, e.name));
        out.push({ rel: r, size: s.size, mtime: Math.round(s.mtimeMs) });
      }
    }
  };
  walk(dir, '');
  return out;
}

/**
 * What to do with each new file: { rel, sig, action: 'questions' | 'textbook' | 'skip' | 'wait', ... }.
 * `taken`: { [rel]: sig } already taken in. A question set or chapter whose class isn't here yet waits.
 */
function plan(files, taken, courses) {
  const out = [];
  for (const f of files) {
    const sig = `${f.size}:${f.mtime}`;
    if (taken[f.rel] === sig) continue;
    const parts = f.rel.split('/');
    if (parts[0] === 'questions' && parts.length === 2 && parts[1].endsWith('.json')) out.push({ rel: f.rel, sig, action: 'questions' });
    // (A textbook file's name is one plain file name, never a way out of the class's folder: made safe to write first,
    // safePaths.safeFileName. One with nothing usable left is skipped.)
    else if (parts[0] === 'Textbooks' && parts.length === 3 && !/^\.\.?$|[\\/:]/.test(parts[2]) && safeFileName(parts[2]) && !/[\\/:]|^\.\.?$/.test(parts[1])) {
      const course = matchCourse(courses, parts[1]);
      out.push(course ? { rel: f.rel, sig, action: 'textbook', folder: course.code, name: safeFileName(parts[2]) } : { rel: f.rel, sig, action: 'wait' });
    } else out.push({ rel: f.rel, sig, action: 'skip' });
  }
  return out;
}

/**
 * Take in what's new. deps (Kea's own modules, replaceable in tests): { sharedDir, stateFile, textbooks, courses(),
 * addSet(entry, set), follower() }. Returns { questions, textbooks } counts.
 */
async function takeIn(deps) {
  const counts = { questions: 0, textbooks: 0 };
  if (!deps.sharedDir || !fs.existsSync(deps.sharedDir) || deps.follower()) return counts;
  let taken = {};
  try {
    taken = JSON.parse(fs.readFileSync(deps.stateFile, 'utf8'));
  } catch {}
  const courses = await deps.courses();
  let changed = false;
  for (const step of plan(listShared(deps.sharedDir), taken, courses)) {
    if (step.action === 'wait') continue;
    const src = path.join(deps.sharedDir, ...step.rel.split('/'));
    try {
      if (step.action === 'questions') {
        const doc = JSON.parse(fs.readFileSync(src, 'utf8'));
        const course = matchCourse(courses, doc.courseCode || doc.entry?.courseCode);
        if (!course) continue; // the class isn't here yet: try again after the next scan
        const entry = { ...doc.entry, courseId: course.id, courseCode: course.code, sharedClaude: true };
        if (deps.addSet(entry, doc.set)) counts.questions++;
      } else if (step.action === 'textbook') {
        const dest = require('./safePaths.cjs').within(deps.textbooks, step.folder, step.name);
        let same = false;
        try {
          same = fs.statSync(dest).size === fs.statSync(src).size;
        } catch {}
        if (!same) {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(src, `${dest}.tmp`);
          fs.renameSync(`${dest}.tmp`, dest);
          counts.textbooks++;
        }
      }
    } catch (e) {
      console.error('Shared material', step.rel, e.message);
      continue;
    }
    taken[step.rel] = step.sig;
    changed = true;
  }
  if (changed) {
    fs.mkdirSync(path.dirname(deps.stateFile), { recursive: true });
    fs.writeFileSync(deps.stateFile, JSON.stringify(taken));
  }
  return counts;
}

/** Kea's own wiring: the active profile's Shared/ folder in its sync drive. */
async function run() {
  const cloud = require('./cloud.cjs');
  const profiles = require('./profiles.cjs');
  const devices = require('./devices.cjs');
  const db = require('./db.cjs');
  const t = cloud.target();
  if (!t) return { questions: 0, textbooks: 0 };
  const P = profiles.paths();
  const counts = await takeIn({
    sharedDir: path.join(t, 'Shared'),
    stateFile: path.join(P.dir, 'shared-material.json'),
    textbooks: P.textbooks,
    courses: async () => (await db.courses(P.db, P.textbooks, {}).catch(() => [])).map((c) => ({ id: c.id, code: c.code || c.course_code })),
    addSet: (entry, set) => require('./study.cjs').addSet(entry, set),
    follower: () => devices.follower(),
  });
  if (counts.questions || counts.textbooks) {
    devices.soon(2000);
    const { BrowserWindow, Notification } = require('electron');
    BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('scholar:changed'));
    if (counts.questions && Notification.isSupported()) new Notification({ title: 'New practice questions', body: `${counts.questions === 1 ? 'A new set' : `${counts.questions} new sets`} from Kea’s shared Claude, in My resources.` }).show();
  }
  return counts;
}

module.exports = { run, takeIn, plan, matchCourse, listShared };
