// One calendar and one class list from every class site Kea has (electron/scholar/sites.cjs, profiles.cjs): an
// existing School folder with its classes and an empty Personal one are both read, as they are on disk; another
// school's site can be added beside them; ids from two sites never collide; and a checkmark goes to the site its item
// is from. Nothing in a site's academic_sync.db is ever written.
// Run: node --test test/scholar/oneCalendar.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electron = require('../worker/electronStub.cjs');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-one-calendar-test-'));
electron._paths.userData = path.join(base, 'user');
electron._paths.appData = path.join(base, 'user');
fs.mkdirSync(electron._paths.userData, { recursive: true });
// No phone copy, no other computers: nothing here leaves the test folder.
fs.writeFileSync(path.join(electron._paths.userData, 'settings.json'), JSON.stringify({ 'scholar.cloud': 'off', 'scholar.pcSync': false }));

// The IPC handlers, called as Kea's own page calls them.
const handlers = {};
electron.ipcMain.handle = (name, fn) => (handlers[name] = fn);
const page = { senderFrame: { url: 'app://kea/', parent: null }, sender: { send() {}, isDestroyed: () => false } };
const call = (name, ...args) => handlers[name](page, ...args);

const initSqlJs = require('sql.js');
const profiles = require('../../electron/scholar/profiles.cjs');
const sites = require('../../electron/scholar/sites.cjs');

const SCHEMA = `
CREATE TABLE courses (id TEXT PRIMARY KEY, course_code TEXT, name TEXT, term TEXT, instructor TEXT, instructor_contact TEXT, campus TEXT, delivery_format TEXT, d2l_url TEXT, start_date TEXT, end_date TEXT, status TEXT, is_synthetic INTEGER, d2l_identifier TEXT);
CREATE TABLE chapter_topics (course_id TEXT, chapter_label TEXT, title TEXT, summary TEXT, sections_json TEXT, objectives_json TEXT, added_objectives_json TEXT, vocabulary TEXT, added_vocabulary TEXT, reading_url TEXT, reading_label TEXT, depth_verdict TEXT, depth_note TEXT);
CREATE TABLE study_pdfs (course_id TEXT, chapters_json TEXT, source_path TEXT, file_path TEXT, page_count INTEGER, week_start TEXT);
CREATE TABLE academic_items (id TEXT PRIMARY KEY, course_id TEXT, item_type TEXT, title TEXT, date TEXT, date_range_end TEXT, start_time TEXT, end_time TEXT, due_time TEXT, status TEXT, description TEXT, source_wording TEXT, platform_location TEXT, location TEXT, instructor TEXT, points REAL, optional INTEGER, tentative INTEGER, module TEXT, covered_chapters_json TEXT, study_focus_json TEXT, weekly_links_json TEXT, submission_url TEXT, submission_url_label TEXT, reference_url TEXT, reference_url_label TEXT, resource_url TEXT, resource_url_label TEXT);
CREATE TABLE course_portal_links (course_id TEXT, kind TEXT, label TEXT, url TEXT);
CREATE TABLE digest_entries (course_id TEXT, kind TEXT, external_id TEXT, payload_json TEXT, first_seen TEXT);
CREATE TABLE course_grade_snapshots (course_id TEXT, overall_percent REAL, letter_grade TEXT, captured_at TEXT);
CREATE TABLE grade_snapshots (course_id TEXT, title TEXT, is_missing INTEGER);
`;
const day = (n) => {
  const d = new Date(Date.now() + n * 864e5);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** A class database with one class and two items. The same ids in two databases on purpose (they must not collide). */
async function makeDb(file, code, name) {
  const S = await initSqlJs();
  const d = new S.Database();
  d.run(SCHEMA);
  const ins = (table, row) => d.run(`INSERT INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`, Object.values(row));
  ins('courses', { id: 'c1', course_code: code, name, term: 'Fall 2026', status: 'active', is_synthetic: 0 });
  ins('academic_items', { id: 'i1', course_id: 'c1', item_type: 'assignment', title: `${code} homework`, date: day(2), due_time: '23:59', status: 'active' });
  ins('academic_items', { id: 'i2', course_id: 'c1', item_type: 'lecture', title: `${code} lecture`, date: day(3), start_time: '09:00', end_time: '10:15', status: 'active' });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(d.export()));
  d.close();
}
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

// Before: what an existing Kea left: a School profile with classes (and a class site), an empty Personal profile, and
// Personal picked as the open one.
const userProfiles = path.join(electron._paths.userData, 'profiles');
fs.mkdirSync(userProfiles, { recursive: true });
fs.writeFileSync(
  path.join(userProfiles, 'profiles.json'),
  JSON.stringify({ active: 'personal', list: [{ id: 'school', name: 'School', created: '2026-08-20T00:00:00Z' }, { id: 'personal', name: 'Personal', created: '2026-10-01T00:00:00Z' }] })
);
fs.mkdirSync(path.join(userProfiles, 'personal'), { recursive: true });
await makeDb(profiles.paths('school').db, 'BIO111', 'Biology');
const schoolDbSha = sha(profiles.paths('school').db);
fs.writeFileSync(profiles.paths('school').state, JSON.stringify({ done: { i1: '2026-11-01T10:00:00Z' }, doneLog: { i1: { on: true, at: '2026-11-01T10:00:00Z' } } }));

// The window's handlers (no long timers, no folder watching: nothing keeps the test running).
const realWatch = fs.watch;
const realInterval = global.setInterval;
const realTimeout = global.setTimeout;
fs.watch = () => ({ close() {} });
global.setInterval = () => 0;
global.setTimeout = (fn, ms, ...a) => (ms >= 10000 ? 0 : realTimeout(fn, ms, ...a));
require('../../electron/scholar/index.cjs').register();
global.setInterval = realInterval;
global.setTimeout = realTimeout;
// (Adding a site watches its folder too: still not here.)
after(() => {
  fs.watch = realWatch;
  fs.rmSync(base, { recursive: true, force: true });
});

test('ids: the first site’s stay as they are, another site’s carry it, and each id finds its way back', () => {
  assert.equal(profiles.home(), 'school');
  assert.equal(profiles.qualify('school', 'i1'), 'i1');
  assert.equal(profiles.qualify('personal', 'i1'), 'personal__i1');
  assert.equal(profiles.qualify('personal', 'personal__i1'), 'personal__i1');
  assert.deepEqual(profiles.split('personal__i1'), { ws: 'personal', id: 'i1' });
  assert.deepEqual(profiles.split('i1'), { ws: 'school', id: 'i1' });
  // (Something that only looks like a site's id stays the first site's.)
  assert.deepEqual(profiles.split('nosuch__i1'), { ws: 'school', id: 'nosuch__i1' });
  assert.deepEqual(sites.splitSet('stream-personal__c1'), { ws: 'personal', id: 'stream-c1' });
  // Kea classes and Work keep their own ids.
  assert.deepEqual(sites.tag('personal', { id: 'hub:9', courseId: 'work:3', itemId: 'x' }), { id: 'hub:9', courseId: 'work:3', itemId: 'personal__x' });
});

test('an existing School profile and an empty Personal one are both read, as one; the open-profile choice no longer matters', async () => {
  assert.equal(profiles.active(), 'school', 'the saved "personal" choice is not what Kea reads');
  const courses = await call('scholar:courses');
  assert.deepEqual(courses.map((c) => [c.id, c.code, c.site]), [['c1', 'BIO111', 'school']]);
  const items = await call('scholar:items', { from: day(-1), to: day(10) });
  assert.deepEqual(items.map((i) => i.id).sort(), ['i1', 'i2']);
  assert.ok(items.find((i) => i.id === 'i1').done, 'what was checked off before is still checked off');
  assert.equal((await call('scholar:status')).hasData, true);
  // Nothing was moved or rewritten.
  assert.equal(sha(profiles.paths('school').db), schoolDbSha);
  assert.ok(fs.existsSync(path.join(userProfiles, 'personal')));
});

test('another school’s class site: its classes join the same list and calendar, with no id shared', async () => {
  const { id, sites: list } = await call('scholar:addSite', 'Second school');
  assert.equal(id, 'second-school');
  assert.deepEqual(list.map((s) => s.id), ['school', 'personal', 'second-school']);
  // (The same ids inside its own database as the first school's.)
  await makeDb(profiles.paths(id).db, 'CHM101', 'Chemistry');
  const courses = await call('scholar:courses');
  assert.deepEqual(courses.map((c) => [c.id, c.code, c.site]).sort(), [['c1', 'BIO111', 'school'], ['second-school__c1', 'CHM101', 'second-school']]);
  assert.equal(courses.find((c) => c.code === 'CHM101').siteName, 'Second school');
  const items = await call('scholar:items', { from: day(-1), to: day(10) });
  const ids = items.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length, 'every id is different');
  assert.deepEqual(ids.slice().sort(), ['i1', 'i2', 'second-school__i1', 'second-school__i2']);
  // Each item's class is the one from its own site, and the calendar is in date order.
  assert.equal(items.find((i) => i.id === 'second-school__i2').courseId, 'second-school__c1');
  assert.deepEqual(items.map((i) => i.date), items.map((i) => i.date).slice().sort());
  // One class's own items, and its page, come from its site.
  const one = await call('scholar:items', { from: day(-1), to: day(10), courseId: 'second-school__c1' });
  assert.deepEqual(one.map((i) => i.id).sort(), ['second-school__i1', 'second-school__i2']);
  const page = await call('scholar:course', 'second-school__c1');
  assert.equal(page.code, 'CHM101');
  assert.equal(page.id, 'second-school__c1');
});

test('a checkmark goes to the site its item is from, and only there', async () => {
  const before = fs.readFileSync(profiles.paths('school').state, 'utf8');
  await call('scholar:setDone', 'second-school__i1', true);
  assert.equal(fs.readFileSync(profiles.paths('school').state, 'utf8'), before, 'the first school’s checkmarks are untouched');
  const theirs = JSON.parse(fs.readFileSync(profiles.paths('second-school').state, 'utf8'));
  assert.ok(theirs.done.i1, 'kept under the id its own site knows');
  const items = await call('scholar:items', { from: day(-1), to: day(10) });
  assert.ok(items.find((i) => i.id === 'second-school__i1').done);
  assert.ok(!items.find((i) => i.id === 'second-school__i2').done);
  assert.ok(items.find((i) => i.id === 'i1').done);
  // The databases themselves are never written.
  assert.equal(sha(profiles.paths('school').db), schoolDbSha);
});

test('the phone’s checkmarks come back to the right site', async () => {
  const idx = require('../../electron/scholar/index.cjs');
  assert.ok(idx._test, 'index.cjs exposes applyMarks for tests');
  idx._test.applyMarks({ done: { 'second-school__i2': { on: true, at: new Date().toISOString() } } });
  const theirs = JSON.parse(fs.readFileSync(profiles.paths('second-school').state, 'utf8'));
  assert.ok(theirs.done.i2);
  const mine = JSON.parse(fs.readFileSync(profiles.paths('school').state, 'utf8'));
  assert.ok(!mine.done.i2 && !mine.done['second-school__i2']);
});

test('the phone copy has every site’s classes and items, ids as Kea’s window has them', async () => {
  const snap = await require('../../electron/scholar/index.cjs')._test.snapshot();
  assert.deepEqual(snap.courses.map((c) => c.id).sort(), ['c1', 'second-school__c1']);
  assert.ok(snap.items.some((i) => i.id === 'second-school__i1'));
  assert.ok(snap.doneLog['second-school__i1'] && snap.doneLog.i1);
  assert.deepEqual(snap.sites.map((s) => s.id), ['school', 'personal', 'second-school']);
});

test('the old profile switch changes nothing anyone sees', async () => {
  await call('scholar:selectProfile', 'personal');
  const courses = await call('scholar:courses');
  assert.equal(courses.length, 2);
  assert.equal((await call('scholar:profiles')).active, 'school');
});

test('“How do you use Kea?” only turns parts of Kea on or off: it never makes, picks or hides class sites', () => {
  const modes = fs.readFileSync(new URL('../../src/lib/modes.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(modes, /api\.scholar|Profile/);
  const screen = fs.readFileSync(new URL('../../src/components/scholar/ScholarScreen.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(screen, /selectProfile|createProfile|isPersonalProfile/);
  assert.match(screen, /Add another class site/);
});
