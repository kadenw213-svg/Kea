// Kea's shared Claude on the owner's PC (and every class scan): Claude Code runs isolated from the owner's own Claude
// settings, with only its task's engine commands, a minimal environment and a turn cap; a job at its time limit ends
// with Claude's whole process tree; a finished job's folder is deleted; and the student's Kea answers relayed
// class-site reads only for scan jobs it asked for itself, for a limited time, with only the operations a scan needs.
// Run: node --test test/worker/
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electron = require('./electronStub.cjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-worker-test-'));
electron._paths.userData = dir;
electron._paths.appData = dir;

const runnerMod = require('../../electron/scholar/runner.cjs');
const R = runnerMod._test;
const { TASKS } = runnerMod;
const { killTree } = require('../../electron/scholar/procTree.cjs');

after(() => fs.rmSync(dir, { recursive: true, force: true }));

const argsFor = (task, extra = []) => R.claudeArgs(['-p', 'x'], task, TASKS[task], extra, 'cfg.json');
const listAfter = (args, flag) => {
  const i = args.indexOf(flag);
  const out = [];
  for (let j = i + 1; j < args.length && !args[j].startsWith('--'); j++) out.push(args[j]);
  return out;
};

test('every run loads only the workspace’s own settings, no hooks, and has a turn cap', () => {
  for (const task of Object.keys(TASKS)) {
    const a = argsFor(task);
    assert.equal(a[a.indexOf('--setting-sources') + 1], 'project', task);
    assert.deepEqual(JSON.parse(a[a.indexOf('--settings') + 1]), { disableAllHooks: true, enableAllProjectMcpServers: false });
    assert.ok(Number(a[a.indexOf('--max-turns') + 1]) >= 10, task);
    assert.ok(a.includes('--strict-mcp-config'));
    assert.equal(a[a.indexOf('--permission-mode') + 1], 'dontAsk');
  }
});

test('Bash is only the engine commands each task needs, never the whole engine', () => {
  for (const task of Object.keys(TASKS)) {
    const allowed = listAfter(argsFor(task), '--allowedTools');
    assert.ok(!allowed.includes('Bash(uv run academic-sync:*)'), task);
    for (const t of allowed.filter((x) => x.startsWith('Bash')))
      assert.match(t, /^Bash\(uv run academic-sync [a-z0-9 -]+:\*\)$/, `${task}: ${t}`);
    assert.ok(!allowed.some((t) => /study-pdf-plot|db-init/.test(t)), task);
  }
  const has = (task, cmd) => listAfter(argsFor(task), '--allowedTools').includes(`Bash(uv run academic-sync ${cmd}:*)`);
  assert.ok(has('study', 'study-pdf-figure') && has('study', 'study-pdf-build') && !has('study', 'extract'));
  assert.ok(has('import', 'extract') && has('import', 'course add') && !has('import', 'study-pdf-build'));
  assert.ok(has('practice', 'practice-check') && !has('practice', 'doc-text'));
  assert.ok(has('transcribe', 'doc-text') && has('transcribe', 'coverage'));
  assert.equal(listAfter(argsFor('probe'), '--allowedTools').filter((t) => t.startsWith('Bash')).length, 0);
  const denied = listAfter(argsFor('daily'), '--disallowedTools');
  for (const d of ['PowerShell', 'Bash(npm:*)', 'Bash(node:*)', 'Bash(uv run python:*)', 'Bash(uv run academic-sync study-pdf-plot:*)', 'Write(./.claude/**)', 'Edit(data/*.db)']) assert.ok(denied.includes(d), d);
  // (No deny that would also cover data/**, where every run writes: denies win over allows.)
  assert.ok(listAfter(argsFor('daily'), '--allowedTools').includes('Write(data/**)'));
  for (const d of denied.filter((x) => /^(Edit|Write)\(/.test(x))) assert.match(d, /^(Edit|Write)\((data\/(\*\.db|logs\/\*\*|backups\/\*\*)|\.\/\.claude\/\*\*)\)$/, d);
});

test('a worker run (the owner’s Claude, someone else’s class) never searches the web or reads college sites', () => {
  const before = { ...process.env };
  try {
    const own = listAfter(argsFor('curriculum', ['WebFetch(domain:*.edu)', 'WebFetch(domain:school.edu)']), '--allowedTools');
    assert.ok(own.includes('WebSearch') && own.includes('WebFetch(domain:*.edu)'));
    process.env.KEA_WORKER_JOB = 'job1';
    for (const task of Object.keys(TASKS)) {
      const a = argsFor(task, ['WebFetch(domain:*.edu)']);
      const allowed = listAfter(a, '--allowedTools');
      assert.ok(!allowed.includes('WebSearch'), task);
      assert.ok(!allowed.includes('WebFetch(domain:*.edu)'), task);
      assert.equal(a[a.indexOf('--max-turns') + 1], '200', task);
    }
  } finally {
    process.env = before;
  }
});

test('Claude’s environment has no tokens, keys, secrets or Kea’s own variables', () => {
  const before = { ...process.env };
  try {
    Object.assign(process.env, {
      GH_TOKEN: 'ghp_x', GITHUB_TOKEN: 'x', KEA_OWNER_KEY_FILE: 'C:/keas/owner.key', KEA_WORKER_JOB: 'j', KEA_HUB_OWNER_PORT: '4861',
      ANTHROPIC_API_KEY: 'sk-x', OPENAI_API_KEY: 'x', AWS_SECRET_ACCESS_KEY: 'x', MY_SECRET: 'x', SOME_PASSWORD: 'x', NPM_TOKEN: 'x', RANDOM_THING: 'x'
    });
    const env = R.runEnv('C:/uv/uv.exe', 7, 'study');
    for (const k of Object.keys(env)) assert.ok(!/TOKEN|KEY|SECRET|PASSWORD|^GH_|^GITHUB_|^ANTHROPIC|^AWS/i.test(k), k);
    assert.ok(!('KEA_OWNER_KEY_FILE' in env) && !('KEA_WORKER_JOB' in env) && !('KEA_HUB_OWNER_PORT' in env) && !('RANDOM_THING' in env));
    assert.equal(env.KEA_RUN_ID, '7');
    assert.equal(env.KEA_TASK, 'study');
    assert.ok(env.KEA_TEXTBOOK_DIR && env.PYTHONUTF8 === '1');
    assert.ok(env.PATH.startsWith('C:/uv'));
    const sysRoot = Object.keys(before).find((k) => k.toUpperCase() === 'SYSTEMROOT');
    if (sysRoot) assert.equal(env[sysRoot], before[sysRoot]);
  } finally {
    process.env = before;
  }
});

/** A node process that starts a child node process; resolves { parent, childPid }. */
function tree() {
  return new Promise((resolve) => {
    const parent = spawn(process.execPath, ['-e', "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
    parent.stdout.once('data', (d) => resolve({ parent, childPid: Number(String(d).trim()) }));
  });
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (fn, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return fn();
};

test('killTree ends a program and everything it started', async () => {
  const { parent, childPid } = await tree();
  assert.ok(alive(parent.pid) && alive(childPid));
  assert.equal(await killTree(parent.pid), true);
  assert.ok(await until(() => !alive(parent.pid) && !alive(childPid)), 'both ended');
  assert.equal(await killTree(parent.pid), true, 'an ended process counts as ended');
});

test('stopping a run (the time limit, or the student) ends Claude’s whole tree', async () => {
  const { parent, childPid } = await tree();
  const slot = { child: parent, job: {}, entry: {} };
  R.side().add(slot);
  try {
    await runnerMod.stop();
    assert.equal(slot.job.stopping, true);
    assert.ok(await until(() => !alive(parent.pid) && !alive(childPid)), 'Claude and its children ended');
  } finally {
    R.side().delete(slot);
  }
});

test('the worker’s own time limit defaults to 45 minutes and stops through runner.stop, not app.exit', () => {
  const src = fs.readFileSync(new URL('../../electron/scholar/worker.cjs', import.meta.url), 'utf8');
  assert.match(src, /KEA_WORKER_LIMIT_MS\) \|\| 45 \* 60e3/);
  const deadline = src.slice(src.indexOf('const deadline = setTimeout'), src.indexOf('}, LIMIT_MS);'));
  assert.match(deadline, /runner\.cjs'\)\.stop\(\)/);
  // (app.exit only in the backstop a minute later, after the tree is gone.)
  assert.ok(deadline.indexOf('app.exit') > deadline.indexOf('backstop = setTimeout'));
});

// ---------- The owner's launcher and the student's relay (hub.cjs) ----------
let hubMod, fake, fakeUrl;
const calls = [];
const results = [];
before(async () => {
  // A stand-in Kea Hub: one running job's queued calls, then "finished".
  let served = 0;
  fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push(`${req.method} ${req.url}`);
      const m = /^\/v1\/scan\/([^/]+)\/calls(?:\/([^/]+)\/result)?$/.exec(req.url);
      if (m && req.method === 'POST') {
        results.push({ job: m[1], call: m[2], ...JSON.parse(body) });
        return res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      }
      if (m && served++ < 1)
        return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ calls: [{ id: 'c1', op: 'request', args: { url: 'https://evil.example/?data=secret' } }, { id: 'c2', op: 'download', args: {} }, { id: 'c3', op: 'status', args: {} }] }));
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"finished"}');
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  fakeUrl = `http://127.0.0.1:${fake.address().port}`;
  process.env.KEA_HUB_URL = fakeUrl;
  fs.writeFileSync(path.join(dir, 'hub-session.bin'), 'token-1');
  hubMod = require('../../electron/hub.cjs');
  // The student's own browser, as relayOp uses it.
  const browser = require('../../electron/scholar/browser.cjs');
  browser.status = async () => ({ setUp: true, signedIn: true });
  browser.schoolInfo = () => ({ home: 'https://d2l.school.edu/d2l/home', host: 'd2l.school.edu' });
});
after(() => fake?.close());

test('relayed operations are limited to what the job kind needs', async () => {
  const { relayOp, RELAY_OPS } = hubMod._relay;
  assert.deepEqual(RELAY_OPS.initial_scan, ['request', 'open', 'click', 'status']);
  await assert.rejects(relayOp('request', { url: 'https://d2l.school.edu/' }, 'more_questions'), /Not allowed/);
  await assert.rejects(relayOp('download', {}, 'initial_scan'), /Not allowed/);
  await assert.rejects(relayOp('request', { url: 'file:///C:/Windows/win.ini' }, 'initial_scan'), /https/);
  await assert.rejects(relayOp('request', { url: 'https://evil.example/?q=secret' }, 'initial_scan'), /isn't the class site/);
});

test('a job this device didn’t ask for is never served', async () => {
  calls.length = 0;
  await hubMod._relay.answerCalls('someone-elses-job', 'initial_scan');
  assert.equal(calls.length, 0);
  // Nor a job it asked for under another kind, nor a kind that needs no class site.
  hubMod._relay.myJobs.add('qjob', 'more_questions');
  await hubMod._relay.answerCalls('qjob', 'more_questions');
  await hubMod._relay.answerCalls('qjob', 'initial_scan');
  assert.equal(calls.length, 0);
});

test('its own scan job is served, read-only, with a notice, until the job ends', async () => {
  calls.length = 0;
  results.length = 0;
  electron._shown.length = 0;
  hubMod._relay.myJobs.add('myjob', 'initial_scan');
  await hubMod._relay.answerCalls('myjob', 'initial_scan');
  assert.deepEqual(results.map((r) => [r.call, r.ok]), [['c1', false], ['c2', false], ['c3', true]]);
  assert.match(results[0].error, /isn't the class site/);
  assert.match(results[1].error, /Not allowed: download/);
  assert.equal(electron._shown[0].title, 'Kea’s shared Claude is reading your class site');
  assert.deepEqual(hubMod._relay.servingNow(), []);
});

test('serving stops at the time limit, counted from the first time this device served the job', async () => {
  calls.length = 0;
  const { myJobs } = hubMod._relay;
  myJobs.add('oldjob', 'initial_scan');
  const all = myJobs.read();
  all.oldjob.servedFrom = Date.now() - 61 * 60e3; // the default limit is 60 minutes
  myJobs.write(all);
  await hubMod._relay.answerCalls('oldjob', 'initial_scan');
  assert.equal(calls.length, 0);
});

test('a finished worker folder is deleted, leaving a short summary', async () => {
  const w = path.join(dir, 'workers', 'job-42');
  fs.mkdirSync(path.join(w, 'Profiles', 'School', 'scholar', 'data'), { recursive: true });
  fs.writeFileSync(path.join(w, 'Profiles', 'School', 'scholar', 'data', 'academic_sync.db'), 'student data');
  fs.writeFileSync(path.join(w, 'worker.log'), 'a\nb\nworker job-42: failed: The job ran over its time limit.\nworker job-42: ended with an error\n');
  assert.equal(await hubMod._relay.endWorkerFolder(w, 'job job-42 initial_scan: ended at the time limit after 45 min'), true);
  assert.equal(fs.existsSync(w), false);
  const summary = fs.readFileSync(path.join(dir, 'workers', 'summary.log'), 'utf8');
  assert.match(summary, /job job-42 initial_scan: ended at the time limit/);
  assert.match(summary, /ended with an error/);
  assert.doesNotMatch(summary, /student data/);
});
