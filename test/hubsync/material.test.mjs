// "25 more questions" and course material, end to end against a real Kea Hub: two classmates ask for the same chapter
// (the second joins), the worker side (remote.cjs) reads the job and the section's pool and adds a batch, the Hub copies
// it into both Kea folders, each Kea's sync brings it down (hubsync.cjs), and sharedMaterial.cjs takes it in under that
// Kea's own course id. Plus the pure parts: matching classes by course code, the plan, and the worker's new-only filter.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerAndSignIn } from '../hubRegister.mjs';
import { ofetch } from '../ownerFetch.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const HUB = [process.env.KEAS_DIR && path.join(process.env.KEAS_DIR, 'hub/index.mjs'), path.resolve(here, '../../../KeaS/hub/index.mjs')].find((p) => p && fs.existsSync(p)) || '';
const haveHub = !!HUB;
const material = require('../../electron/scholar/sharedMaterial.cjs');
const { createSync, httpClient } = require('../../electron/scholar/hubsync.cjs');
const worker = require('../../electron/scholar/worker.cjs')._test;

let hub, base, ownerBase, dir;
const tokens = {};
const http = (t) => (p, init = {}) => fetch(base + p, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${t}`, ...(init.headers || {}) } }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const owner = (p, init = {}) => ofetch(ownerBase + p, { ...init, headers: { 'content-type': 'application/json', 'x-kea-owner-key': hub.ownerKey, ...(init.headers || {}) } }).then((r) => r.json());

before(async () => {
  if (!haveHub) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-material-'));
  const { createHub } = await import(pathToFileURL(HUB).href);
  hub = createHub({ dataDir: path.join(dir, 'hub'), log: false });
  const p = await hub.listen({ port: 0, ownerPort: 0 });
  base = `http://127.0.0.1:${p.port}`;
  ownerBase = `http://127.0.0.1:${p.ownerPort}`;
  const t = (await (await fetch(`${base}/v1/terms`)).json()).terms;
  for (const who of ['ana', 'ben']) {
    const r = await registerAndSignIn(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `${who}@example.com`, password: 'lantern velvet orbit', displayName: who, age13: true, birthYear: 2001, termsVersion: t.version, termsSections: t.sections.map((s) => s.id) }) });
    tokens[who] = (await r.json()).token;
    await owner(`/owner/accounts/${who}@example.com`, { method: 'POST', body: '{"emailVerified":true}' });
  }
});
after(async () => {
  if (!haveHub) return;
  await hub.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('classes match by course code, however it is written', () => {
  const courses = [{ id: 'c1', code: 'BIO 1010' }, { id: 'c2', code: 'CHEM 1110-002' }];
  assert.equal(material.matchCourse(courses, 'bio-1010').id, 'c1');
  assert.equal(material.matchCourse(courses, 'CHEM1110').id, 'c2');
  assert.equal(material.matchCourse(courses, 'MATH 1120'), null);
  assert.equal(material.matchCourse(courses, ''), null);
});

test('the plan: question sets, textbook chapters for a class here, the rest waits or is skipped; nothing twice', () => {
  const files = [
    { rel: 'questions/exam-a.json', size: 10, mtime: 1 },
    { rel: 'Textbooks/BIO 1010/Chapter 1.pdf', size: 5, mtime: 2 },
    { rel: 'Textbooks/PHYS 2010/Chapter 9.pdf', size: 5, mtime: 2 },
    { rel: 'notes.txt', size: 1, mtime: 3 },
  ];
  const steps = material.plan(files, { 'questions/exam-a.json': '10:1' }, [{ id: 'c1', code: 'BIO1010' }]);
  assert.deepEqual(steps.map((s) => [s.rel, s.action]), [
    ['Textbooks/BIO 1010/Chapter 1.pdf', 'textbook'],
    ['Textbooks/PHYS 2010/Chapter 9.pdf', 'wait'],
    ['notes.txt', 'skip'],
  ]);
  assert.equal(steps[0].folder, 'BIO1010', 'into the folder of the class as it is named here');
});

test('the worker sends only new questions, at most a batch', () => {
  const { freshQuestions, qText, profileFromTarget } = worker;
  const made = [{ q: 'What is ATP?' }, { q: 'what is   ATP' }, { q: 'Name the organelle.' }, { q: 'Define osmosis.' }, { q: '' }];
  assert.deepEqual(freshQuestions(made, [qText({ q: 'Define osmosis!' })], 25).map((q) => q.q), ['What is ATP?', 'Name the organelle.']);
  assert.equal(freshQuestions(made, [], 1).length, 1);
  assert.equal(profileFromTarget('kea/Kea/My~3a~School/', 'School'), 'My:School');
  assert.equal(profileFromTarget(null, 'School'), 'School');
});

test('25 more questions: asked by two classmates, written once, taken in by both Keas under their own class', { skip: !haveHub && 'KeaS repo not found (set KEAS_DIR)' }, async () => {
  const course = { school: 'd2l.example.edu', code: 'BIO 1010', term: 'Spring 2027' };
  const a = http(tokens.ana), b = http(tokens.ben);
  const qa = await a('/v1/scan', { method: 'POST', body: JSON.stringify({ kind: 'more_questions', course, chapter: 'Chapter 4', target: 'kea/Kea/School/', detail: { courseCode: 'BIO 1010', chapter: 'Chapter 4', profile: 'School' } }) });
  assert.equal(qa.body.status, 'queued');
  // Ben isn't in Ana's course section on the Hub yet: asking sends Ana a request; once she lets him in, he joins.
  const askBen = () => b('/v1/scan', { method: 'POST', body: JSON.stringify({ kind: 'more_questions', course, chapter: 'Chapter 4', target: 'kea/Kea/Spring/' }) });
  assert.equal((await askBen()).body.status, 'pending');
  const incoming = (await a('/v1/course-sections/requests')).body.incoming;
  assert.equal(incoming.length, 1);
  await a(`/v1/course-sections/requests/${incoming[0].id}/decide`, { method: 'POST', body: JSON.stringify({ approve: true }) });
  assert.equal((await askBen()).body.status, 'joined');
  const next = await owner('/owner/scan/next', { method: 'POST' });
  assert.equal(next.job.id, qa.body.job.id);

  // The worker's side, as worker.cjs does it.
  fs.writeFileSync(path.join(dir, 'owner.key'), hub.ownerKey);
  process.env.KEA_WORKER_JOB = next.job.id;
  process.env.KEA_OWNER_KEY_FILE = path.join(dir, 'owner.key');
  process.env.KEA_HUB_OWNER_PORT = new URL(ownerBase).port;
  delete require.cache[require.resolve('../../electron/scholar/remote.cjs')];
  const remote = require('../../electron/scholar/remote.cjs');
  const info = await remote.jobInfo();
  assert.deepEqual([info.job.kind, info.job.chapter, info.job.target, info.job.batchSize, info.job.detail.courseCode], ['more_questions', 'Chapter 4', 'kea/Kea/School/', 25, 'BIO 1010']);
  assert.equal(worker.profileFromTarget(info.job.target, 'x'), 'School');
  assert.deepEqual(await remote.courseFiles('material/questions/'), [], 'nothing in the pool yet');
  const questions = Array.from({ length: 25 }, (_, i) => ({ q: `Question ${i + 1} about cells?`, choices: ['yes', 'no'], answer: 0, why: 'Because.' }));
  const doc = { entry: { id: 'exam-batch1', kind: 'exam', title: '25 more questions: Chapter 4', chapters: ['Chapter 4'], courseId: 'worker-local-id', courseCode: 'BIO 1010', bank: true }, set: { questions }, courseCode: 'BIO 1010', chapter: 'Chapter 4' };
  await remote.putCourseFile('material/questions/exam-batch1.json', Buffer.from(JSON.stringify(doc)));
  assert.equal(JSON.parse((await remote.courseFile('material/questions/exam-batch1.json')).toString()).set.questions.length, 25);
  const fin = await (await remote.finish(true, '25 new questions for Chapter 4')).json();
  assert.equal(fin.delivered, 2);

  // Each Kea: a sync brings Shared/ down, and the primary takes it in under its own id for BIO 1010.
  for (const [who, profile, localId] of [['ana', 'School', 'ana-bio'], ['ben', 'Spring', 'ben-bio']]) {
    const root = path.join(dir, `${who}-sync`);
    const sync = createSync({ root, stateFile: path.join(dir, `${who}-state.json`), client: httpClient({ base: () => base, token: () => tokens[who], fetchFn: fetch }) });
    await sync.cycle();
    const shared = path.join(root, 'Kea', profile, 'Shared');
    assert.ok(fs.existsSync(path.join(shared, 'questions', 'exam-batch1.json')));
    const added = [];
    const deps = {
      sharedDir: shared,
      stateFile: path.join(dir, `${who}-material.json`),
      textbooks: path.join(dir, `${who}-books`),
      courses: async () => [{ id: localId, code: 'BIO 1010' }],
      addSet: (entry, set) => (added.push({ entry, set }), entry),
      follower: () => false,
    };
    assert.deepEqual(await material.takeIn(deps), { questions: 1, textbooks: 0 });
    assert.equal(added[0].entry.courseId, localId);
    assert.equal(added[0].entry.sharedClaude, true);
    assert.equal(added[0].set.questions.length, 25);
    assert.deepEqual(await material.takeIn(deps), { questions: 0, textbooks: 0 }, 'only once');
    // A device following another one leaves it to the primary.
    assert.deepEqual(await material.takeIn({ ...deps, stateFile: path.join(dir, `${who}-f.json`), follower: () => true }), { questions: 0, textbooks: 0 });
  }

  // Asked again for the same chapter: the pool already holds that batch, so the next worker sees it.
  const again = await a('/v1/scan', { method: 'POST', body: JSON.stringify({ kind: 'more_questions', course, chapter: 'Chapter 4', target: 'kea/Kea/School/', detail: { courseCode: 'BIO 1010', chapter: 'Chapter 4' } }) });
  assert.equal(again.body.status, 'queued');
  const n2 = await owner('/owner/scan/next', { method: 'POST' });
  process.env.KEA_WORKER_JOB = n2.job.id;
  delete require.cache[require.resolve('../../electron/scholar/remote.cjs')];
  const remote2 = require('../../electron/scholar/remote.cjs');
  assert.deepEqual((await remote2.courseFiles('material/questions/')).map((f) => f.path), ['material/questions/exam-batch1.json']);
  await remote2.finish(false, 'test over');
});
