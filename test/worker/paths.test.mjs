// Untrusted names in paths, and where a scan may go with the student's signed-in browser.
// - A course code from a class database someone else supplied ("BIO1010\..\..\x") never becomes a path: the database
//   is refused when it arrives, its classes are hidden from Kea, and every path built from a code stays inside its folder.
// - Shared material matches a class by its whole code, never by one code starting with another.
// - A scan reads hosts the class links to only from the teacher's own content, and on such a host only the exact
//   addresses linked; the school's domain comes from the Public Suffix List.
// Run: node --test test/worker/
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electron = require('./electronStub.cjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-paths-test-'));
electron._paths.userData = dir;
electron._paths.appData = dir;
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const B = String.fromCharCode(92);
const EVIL = `BIO1010${B}..${B}..${B}x`;
const { validCode, safeCode, within } = require('../../electron/scholar/safePaths.cjs');

test('course codes that can be folder names, and ones that can’t', () => {
  for (const ok of ['BIO1010', 'BIO 1010', 'CHEM 1110-002', 'MAT1340.01', 'ENG_1022']) assert.equal(validCode(ok), true, ok);
  for (const bad of [EVIL, 'BIO1010/../../x', '..', 'a..b', '', ' ', '.', 'x'.repeat(41), 'BIO:1010', `C:${B}Windows`, null, 42]) assert.equal(validCode(bad), false, String(bad));
  // Windows device names (any case, with or without an extension) and a final dot or space, which Windows drops.
  for (const bad of ['CON', 'con', 'Prn', 'AUX', 'nul', 'COM1', 'com9', 'LPT1', 'lpt9', 'CON.txt', 'nul.tar.gz', 'Aux.', 'CON .txt', 'BIO1010.', 'BIO1010 ']) assert.equal(validCode(bad), false, bad);
  for (const ok of ['CON 101', 'CONX', 'COM10', 'NULL1', 'AUX1010', 'PRN.101'.replace('.', '')]) assert.equal(validCode(ok), true, ok);
  assert.throws(() => safeCode(EVIL), /can’t be used as a folder name/);
  const root = path.join(dir, 'data', 'downloads');
  assert.equal(within(root, 'BIO1010', 'review'), path.join(root, 'BIO1010', 'review'));
  assert.throws(() => within(root, EVIL), /outside/);
  assert.throws(() => within(root, 'BIO1010', '..', '..', 'x'), /outside/);
  assert.throws(() => within(root, path.join(dir, 'elsewhere')), /outside/);
});

/** A class database (just its courses table) written with sql.js. */
async function classesDb(file, codes) {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs({ locateFile: (f) => path.join(path.dirname(require.resolve('sql.js')), f) });
  const db = new SQL.Database();
  db.run("CREATE TABLE courses (id TEXT, course_code TEXT, name TEXT, status TEXT DEFAULT 'active', is_synthetic INTEGER DEFAULT 0, d2l_identifier TEXT)");
  codes.forEach((c, i) => db.run('INSERT INTO courses (id, course_code, name, d2l_identifier) VALUES (?, ?, ?, ?)', [`c${i}`, c, `Course ${i}`, String(1000 + i)]));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(db.export()));
  db.close();
  return file;
}

test('a class database with a traversing course code is refused, and its classes never reach Kea', async () => {
  const db = require('../../electron/scholar/db.cjs');
  const good = await classesDb(path.join(dir, 'good.db'), ['BIO1010', 'CHE1011']);
  const bad = await classesDb(path.join(dir, 'bad.db'), ['BIO1010', EVIL]);
  assert.deepEqual(await db.badCourseCodes(good), []);
  assert.deepEqual(await db.badCourseCodes(bad), [EVIL]);
  // Read anyway (the profile's own database), the bad class is hidden from every query.
  assert.deepEqual((await db.watchList(bad)).map((c) => c.code), ['BIO1010']);
  assert.deepEqual((await db.watchList(good)).map((c) => c.code), ['BIO1010', 'CHE1011']);
  // (The file itself is never changed.)
  assert.deepEqual(await db.badCourseCodes(bad), [EVIL]);
});

test('devices.follow takes in a class database only after checking its course codes', () => {
  const src = fs.readFileSync(new URL('../../electron/scholar/devices.cjs', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('async function follow('), src.indexOf('st.pulled = st.pulled || {};'));
  assert.ok(body.indexOf('badCourseCodes') > 0 && body.indexOf('badCourseCodes') < body.indexOf('fs.renameSync(P.db'), 'checked before it replaces the database');
});

test('study paths built from a course code stay in the workspace', async () => {
  const study = require('../../electron/scholar/study.cjs');
  const profiles = require('../../electron/scholar/profiles.cjs');
  const ws = profiles.paths().workspace;
  fs.mkdirSync(path.join(ws, 'data', 'downloads', 'BIO1010'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'data', 'downloads', 'BIO1010', 'notes.txt'), 'x');
  // A file outside the downloads folder, where the traversing code would lead.
  fs.mkdirSync(path.join(ws, 'data', 'x'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'data', 'x', 'secret.txt'), 'secret');
  assert.deepEqual(study.classFiles('BIO1010').map((f) => f.path), ['data/downloads/BIO1010/notes.txt']);
  assert.deepEqual(study.classFiles(EVIL), []);
  assert.deepEqual(study.classFiles('..'), []);
  assert.throws(() => study.stepsBrief('c1', EVIL, 'Chapter 1'), /folder name/);
  assert.equal(fs.existsSync(path.join(ws, 'data', 'study', 'x')), false);
});

test('shared material matches a class by its whole code', () => {
  const { matchCourse, plan } = require('../../electron/scholar/sharedMaterial.cjs');
  const courses = [{ id: 'c1', code: 'BIO1010' }, { id: 'c2', code: 'CHEM 1110-002' }, { id: 'c3', code: 'MATH 120' }];
  assert.equal(matchCourse(courses, 'bio-1010').id, 'c1');
  assert.equal(matchCourse(courses, 'BIO 1010').id, 'c1');
  assert.equal(matchCourse(courses, 'CHEM1110').id, 'c2'); // the same class, without its section number
  assert.equal(matchCourse(courses, 'MATH 120 01').id, 'c3');
  // Never by one code starting with another: the audit's traversing code started with the job's own code.
  assert.equal(matchCourse(courses, EVIL), null);
  assert.equal(matchCourse(courses, 'BIO10101'), null);
  assert.equal(matchCourse(courses, 'BIO101'), null);
  assert.equal(matchCourse(courses, 'MATH 130'), null);
  assert.equal(matchCourse([{ id: 'x', code: EVIL }], 'BIO1010'), null);
  const steps = plan([{ rel: `Textbooks/${EVIL}/Chapter 1.pdf`, size: 1, mtime: 1 }, { rel: 'Textbooks/BIO1010/Chapter 1.pdf', size: 1, mtime: 1 }], {}, courses);
  assert.deepEqual(steps.map((s) => s.action), ['skip', 'textbook']);
});

test('a scan follows only the teacher’s own links, and on a linked-only host only the exact addresses', () => {
  const profiles = require('../../electron/scholar/profiles.cjs');
  const browser = require('../../electron/scholar/browser.cjs');
  const mcp = require('../../electron/scholar/mcp.cjs');
  browser.schoolInfo = () => ({ home: 'https://d2l.school.ac.uk/d2l/home', host: 'd2l.school.ac.uk' });
  const day = path.join(profiles.paths().workspace, 'data', 'digests', 'kea-precheck', '2026-11-06');
  fs.mkdirSync(day, { recursive: true });
  const write = (name, v) => fs.writeFileSync(path.join(day, name), JSON.stringify(v));
  write('BIO1010-content.json', { Modules: [{ Description: { Html: '<a href="https://labs.example.com/course/12?section=3&amp;view=1">Lab</a>' } }] });
  write('BIO1010-dropbox.json', [{ Instructions: 'Hand in at https://turnin.example.org/a/7.' }]);
  // Classmates can write in discussions; news is never trusted either.
  write('BIO1010-discussions.json', [{ Message: 'see https://evil.example.net/x' }]);
  write('BIO1010-news.json', [{ Body: 'https://evil2.example.net/' }]);
  mcp._test.reset();
  const ok = (u) => {
    try {
      return !!mcp.allowedUrl(u);
    } catch {
      return false;
    }
  };
  assert.ok(ok('https://labs.example.com/course/12?section=3&view=1'));
  assert.ok(ok('https://labs.example.com/course/12?section=3&view=1#top'));
  assert.ok(ok('https://turnin.example.org/a/7'));
  // Nothing added to a linked address, and no other page on that host.
  assert.ok(!ok('https://labs.example.com/course/12?section=3&view=1&data=stolen'));
  assert.ok(!ok('https://labs.example.com/course/12?data=stolen'));
  assert.ok(!ok('https://labs.example.com/'));
  assert.ok(!ok('https://evil.example.net/x'));
  assert.ok(!ok('https://evil2.example.net/'));
  // The school's domain from the Public Suffix List: school.ac.uk, never every .ac.uk.
  assert.equal(mcp.schoolDomain('d2l.school.ac.uk'), 'school.ac.uk');
  assert.ok(ok('https://www.school.ac.uk/courses'));
  assert.ok(ok('https://d2l.school.ac.uk/d2l/api/lp/1.0/users/whoami?x=1'));
  assert.ok(!ok('https://evil.ac.uk/collect?data=1'));
  assert.ok(!ok('http://d2l.school.ac.uk/'));
  assert.equal(mcp.schoolDomain('127.0.0.1'), '');
});
