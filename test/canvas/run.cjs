// Kea's Canvas reader, end to end, against Canvas API answers shaped as Canvas documents them (fixtures.cjs): every
// area translated, then run through the same pre-check code D2L's answers go through (hand-in evidence, places, platform
// links, grades, the Inbox, messages), then the engine's own reading of the saved files.
//   node test/canvas/run.cjs
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const F = require('./fixtures.cjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-canvas-'));
const dir = path.join(tmp, 'precheck');
fs.mkdirSync(dir, { recursive: true });

// ---------- Stand-ins for Electron, the profile, the database and the signed-in browser ----------
const unknown = [];
const posts = [];
const shown = [];
const route = (rel) => {
  const u = new URL(rel, F.HOST);
  const key = u.pathname + u.search;
  // (Canvas's own encoding of [] in a query is left as written.)
  const plain = decodeURIComponent(key);
  const hit = F.routes[key] || F.routes[plain] || (plain.startsWith(F.calendar.prefix) ? { body: F.calendar.body } : null);
  return { hit, key: plain };
};
const browser = {
  platformOf: () => 'canvas',
  schoolInfo: () => ({ home: F.HOST, host: new URL(F.HOST).host, platform: 'canvas' }),
  status: async () => ({ setUp: true, signedIn: true, platform: 'canvas' }),
  platformsRead: () => ({}),
  // Like browser.getJson: Canvas's "while(1);" guard is taken off and the Link header's next page passed on.
  getJson: async (rel) => {
    const { hit, key } = route(rel);
    if (!hit) {
      unknown.push(key);
      return { status: 404, data: null };
    }
    const text = `while(1);${JSON.stringify(hit.body)}`;
    return { status: 200, data: JSON.parse(text.replace(/^while\(1\);/, '')), next: hit.next || null };
  },
  postForm: async (rel, form) => {
    posts.push({ rel, form });
    return { status: 201, data: [{ id: 1 }] };
  },
  show: async (url) => shown.push(url)
};
const profiles = { paths: () => ({ dir: tmp, workspace: tmp, db: path.join(tmp, 'x.db'), textbooks: tmp, state: path.join(tmp, 'kea.json') }), active: () => 'test' };
const db = { watchList: async () => [{ code: 'BIO1112', ou: String(F.C) }], items: async () => [], courses: async () => [] };
const electron = { Notification: { isSupported: () => false }, BrowserWindow: { getAllWindows: () => [] }, ipcMain: { on() {}, handle() {} } };
const load = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electron;
  const base = path.basename(request);
  if (base === 'browser.cjs') return browser;
  if (base === 'profiles.cjs') return profiles;
  if (base === 'db.cjs') return db;
  if (base === 'workspace.cjs') return {};
  return load.apply(this, arguments);
};

const scholar = path.join(__dirname, '..', '..', 'electron', 'scholar');
const canvas = require(path.join(scholar, 'canvas.cjs'));
const precheck = require(path.join(scholar, 'precheck.cjs'));
const { cleanMessage } = require(path.join(scholar, 'messages.cjs'))._test;

let failed = 0;
const check = (what, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${!ok && detail !== undefined ? `\n     ${JSON.stringify(detail).slice(0, 600)}` : ''}`);
  if (!ok) failed++;
};

(async () => {
  // ---------- Each area, as D2L would answer it ----------
  const data = {};
  for (const area of Object.keys(precheck._test.AREAS)) {
    const r = await canvas.area(area, String(F.C));
    data[area] = r;
    if (r.data) fs.writeFileSync(path.join(dir, `BIO1112-${area}.json`), JSON.stringify(r.data));
  }
  const A = precheck._test.AREAS;
  const list = (area) => (data[area].data ? A[area].list(data[area].data) : []);

  const folders = list('dropbox');
  check('assignment folders: uploads, outside tools and on-paper work, not quizzes or discussions', JSON.stringify(folders.map((f) => f.Name).sort()) === JSON.stringify(['ALEKS Homework 4.5', 'Essay 1', 'Essay 2', 'Exam 1', 'Homework 1', 'Homework 2', 'Lab 3 Report'].sort()), folders.map((f) => f.Name));
  check('the second page of assignments was read (Link header)', folders.some((f) => f.Name === 'Essay 2'));
  const lab = folders.find((f) => f.Name === 'Lab 3 Report');
  check('a folder keeps its own page, dates, points and rubric', lab.KeaUrl === `${F.HOST}/courses/${F.C}/assignments/101` && lab.Availability.StartDate && lab.Assessment.ScoreDenominator === 20 && lab.Assessment.Rubrics[0].CriteriaGroups[0].Criteria[0].Cells[0].Description === 'Complete: Every trial recorded', lab);
  const quizzes = list('quizzes');
  check('quizzes: Classic, New Quizzes and the ungraded practice quiz', JSON.stringify(quizzes.map((q) => q.Name).sort()) === JSON.stringify(['Chapter 5 Quiz', 'Practice Quiz Ch 2', 'Quiz 1']), quizzes.map((q) => q.Name));
  check('a Classic quiz links to the quiz itself', quizzes.find((q) => q.Name === 'Quiz 1').KeaUrl === `${F.HOST}/courses/${F.C}/quizzes/9001`);
  const topics = list('discussions');
  check('discussion topics with the graded one\'s due date and points', topics.length === 2 && topics[0].DueDate && topics[0].ScoreOutOf === 10 && topics[0].GradeItemId === '106', topics);
  const grades = list('grades');
  const g = (n) => grades.find((x) => x.GradeObjectName === n);
  check('grades: real scores only', g('Essay 1').PointsNumerator === 88 && g('Exam 1').PointsNumerator === 76 && g('Essay 2').PointsNumerator === null && g('Essay 2').DisplayedGrade === '' && g('Lab 3 Report').DisplayedGrade === '', grades.map((x) => [x.GradeObjectName, x.PointsNumerator, x.DisplayedGrade]));
  check('instructor feedback comes with the grade (not the student\'s own comment)', g('Essay 1').Comments.Text === 'Strong thesis; cite more sources.', g('Essay 1').Comments);
  check('excused work shows as excused', g('Homework 1').DisplayedGrade === 'Excused');
  check('no grade categories (so no "hidden work" alerts on Canvas)', precheck._test.hiddenWork(data.grades.data).length === 0);
  check('overall grade', data.final.data.PointsNumerator === 87.5 && /B\+/.test(data.final.data.DisplayedGrade), data.final.data);
  const news = list('news');
  check('announcements, without one scheduled for later', news.length === 1 && news[0].Title === 'Exam 2 moved' && news[0].KeaUrl.endsWith('/discussion_topics/8001'), news);
  check('calendar events', list('calendar').length === 1 && list('calendar')[0].Title === 'Lab practical');
  const content = list('content');
  check('modules as content: items of a big module read on their own, no subheaders', content.some((t) => t.Title === 'Chapter 2 Review Sheet.pdf') && !content.some((t) => t.Title === 'Readings'), content.map((t) => t.Title));
  check('content items carry no due dates (compared through their assignments instead)', content.every((t) => !t.DueDate && !t.GradeItemId));
  check('a module that opens later says when', content.find((t) => t.Title === 'Chapter 2 Review Sheet.pdf').StartDateTime !== null);

  // ---------- Outside platforms the class links to ----------
  const plats = precheck._test.classPlatforms(data.content.data).map((p) => p.name).sort();
  check('outside platforms: Connect (a launch tool), Science Interactive (a link) and ALEKS (an assignment in a tool)', JSON.stringify(plats) === JSON.stringify(['ALEKS', 'McGraw Hill Connect', 'Science Interactive']), plats);
  const aleks = precheck._test.classPlatforms(data.content.data).find((p) => p.name === 'ALEKS');
  check('ALEKS opens through the class\'s own Canvas assignment', aleks.launch === `${F.HOST}/courses/${F.C}/assignments/107`, aleks);

  // ---------- Hand-in evidence (the same code as D2L's) ----------
  await precheck._test.refreshSubmissions(dir, null, [{ code: 'BIO1112', ou: String(F.C) }]);
  const subs = JSON.parse(fs.readFileSync(path.join(tmp, 'submissions.json'), 'utf8'));
  const s = subs.byCourse.BIO1112;
  const state = (t) => s.filter((x) => x.title === t).map((x) => x.state);
  check('graded work counts as graded', state('Essay 1').includes('graded') && state('Exam 1').includes('graded') && state('Quiz 1').includes('graded'), s);
  check('upcoming work is never graded or handed in', !state('Essay 2').length && !state('Lab 3 Report').length && !state('Chapter 5 Quiz').length && !state('ALEKS Homework 4.5').length, s.filter((x) => /Essay 2|Lab 3|Chapter 5|ALEKS/.test(x.title)));
  check('a handed-in essay is handed in', state('Essay 1').includes('submitted'));
  check('missed homework is missing', JSON.stringify(state('Homework 2')) === '["not_submitted"]', state('Homework 2'));
  check('excused work isn\'t missing', !state('Homework 1').includes('not_submitted'), state('Homework 1'));
  check('the quiz was taken', state('Quiz 1').includes('submitted'));
  check('discussion: initial post and reply both found', JSON.stringify(state('Week 3 Discussion initial post')) === '["submitted"]' && JSON.stringify(state('Week 3 Discussion response posts')) === '["submitted"]', s.filter((x) => /Week 3/.test(x.title)));
  check('open dates for work not open yet', subs.opens.BIO1112.some((o) => o.title === 'Lab 3 Report') && subs.opens.BIO1112.some((o) => o.title === 'Chapter 5 Quiz'), subs.opens.BIO1112);

  // ---------- Each piece of work's own page ----------
  precheck._test.saveD2lPlaces(dir, [{ code: 'BIO1112', ou: String(F.C) }], F.HOST);
  const places = JSON.parse(fs.readFileSync(path.join(tmp, 'd2l-places.json'), 'utf8')).byCourse.BIO1112;
  check('places link to Canvas pages, never D2L addresses', places.length > 0 && places.every((p) => p.url.startsWith(`${F.HOST}/courses/${F.C}/`) && !/d2l/i.test(p.url)), places);

  // ---------- Grades and the Inbox ----------
  precheck._test.updateGrades(dir, { BIO1112: String(F.C) });
  const gj = JSON.parse(fs.readFileSync(path.join(tmp, 'grades.json'), 'utf8')).byCourse.BIO1112;
  check('grades page and overall grade', gj.url === `${F.HOST}/courses/${F.C}/grades` && gj.final.percent === 87.5 && gj.items.some((i) => i.title === 'Essay 1' && i.score === '88 / 100'), gj);
  check('ungraded work isn\'t in the grades', !gj.items.some((i) => i.title === 'Essay 2' || i.title === 'Lab 3 Report'));
  precheck._test.updateInbox(dir, { BIO1112: String(F.C) });
  const inbox = JSON.parse(fs.readFileSync(path.join(tmp, 'inbox.json'), 'utf8')).items;
  check('announcement in the Inbox with its Canvas page and its links', inbox.length === 1 && inbox[0].url.endsWith('/discussion_topics/8001') && /\[the review\]\(https:\/\/school\.instructure\.com\/courses\/555\/pages\/exam-2\)/.test(inbox[0].body), inbox);

  // ---------- Messages ----------
  const box = await canvas.readMailbox();
  check('Inbox and Sent folders', box.inbox.length === 1 && box.sent.length === 1 && box.inbox[0].unread && box.inbox[0].from === 'Carley Knutsen' && box.inbox[0].url === `${F.HOST}/conversations/9100`, box);
  const msg = await canvas.readMessage(box.inbox[0].url);
  const clean = cleanMessage(msg.text);
  check('a message reads as just the message, the earlier one as quoted', /^Bring goggles\. Practice identifying glassware/.test(clean.body) && /glassware\.pdf/.test(clean.body) && /Do we need goggles tomorrow\?/.test(clean.quoted) && !/Subject|From /.test(clean.body), clean);
  await canvas.sendMessage({ url: box.inbox[0].url, body: 'Thanks, I will.' });
  check('a reply goes to the conversation', posts[0]?.rel === '/api/v1/conversations/9100/add_message' && posts[0].form.body === 'Thanks, I will.', posts[0]);
  await canvas.sendMessage({ ou: String(F.C), to: 'Carley Knutsen', subject: 'Lab 3', body: 'Is the template required?' });
  check('a new message finds its recipient in the class', posts[1]?.rel === '/api/v1/conversations' && JSON.stringify(posts[1].form['recipients[]']) === '["7"]' && posts[1].form.context_code === `course_${F.C}`, posts[1]);
  let refused = '';
  await canvas.sendMessage({ ou: String(F.C), to: 'Smith', body: 'Hi' }).catch((e) => (refused = e.message));
  check('an unclear recipient is asked about, not guessed', /More than one person/.test(refused) && posts.length === 2, refused);

  // ---------- Classes ----------
  const enr = await canvas.enrollments();
  fs.writeFileSync(path.join(tmp, 'enrollments.json'), JSON.stringify({ Items: enr }));
  check('enrollments, without a class closed by date', enr.length === 2 && enr[0].KeaHomePath === `/courses/${F.C}`, enr);

  check('every Canvas request Kea made is one Canvas has', unknown.length === 0, unknown);

  // ---------- The engine reads the saved files the same way it reads D2L's ----------
  const engine = path.join(__dirname, '..', '..', 'scholar', 'engine');
  const py = path.join(engine, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const script = `
import json, sys
from pathlib import Path
from academic_sync.cli import _d2l_objects
from academic_sync.enrollments import find_new_shells
objs = _d2l_objects(Path(sys.argv[1]), "BIO1112")
items = json.load(open(sys.argv[2]))["Items"]
print(json.dumps({"objects": [{k: (str(v) if k == "day" else v) for k, v in o.items() if k != "instructions"} for o in objs],
                  "instructions": {o["title"]: o.get("instructions", "") for o in objs},
                  "shells": [s.__dict__ for s in find_new_shells(items, set())]}))
`;
  const out = JSON.parse(execFileSync(py, ['-c', script, dir, path.join(tmp, 'enrollments.json')], { cwd: engine, encoding: 'utf8' }));
  const kinds = (k) => out.objects.filter((o) => o.kind === k).map((o) => o.title).sort();
  check('engine: folders, quizzes and graded discussion found', kinds('dropbox').length === 7 && kinds('quiz').length === 3 && JSON.stringify(kinds('discussion')) === '["Week 3 Discussion"]', out.objects);
  check('engine: no duplicates from modules or grade items (each grade belongs to its work)', !kinds('content').length && !kinds('grade').length, { content: kinds('content'), grade: kinds('grade') });
  check('engine: each one carries its Canvas page for hand-in', out.objects.filter((o) => o.kind !== 'grade').every((o) => o.url && o.url.startsWith(F.HOST)), out.objects.map((o) => o.url));
  check('engine: on-paper and outside-tool work isn\'t called a file hand-in', out.objects.find((o) => o.title === 'Exam 1').uploads === false && out.objects.find((o) => o.title === 'Lab 3 Report').uploads === true);
  check('engine: instructions and rubric read', /Upload your lab report/.test(out.instructions['Lab 3 Report']) && /Rubric/.test(out.instructions['Lab 3 Report']) && /Data table \(10 pts\)/.test(out.instructions['Lab 3 Report']), out.instructions['Lab 3 Report']);
  check('engine: the Canvas class is a new class (BIO1112, section 175), the orientation isn\'t', out.shells.length === 1 && out.shells[0].course_code === 'BIO1112' && out.shells[0].section === '175' && out.shells[0].home_url_path === `/courses/${F.C}` && out.shells[0].platform === 'canvas', out.shells);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
