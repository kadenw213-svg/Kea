// Kea's shared Claude, Kea's side: the locked models (a worker runs scans only on Opus, lessons only on Sonnet with
// effort medium, and refuses a job naming any other model, Fable included), token accounting from Claude Code's
// stream-json usage events, the owner's Kea writing a lesson for someone else (with a stand-in claude, never the real
// one), and the sentence a refusal shows (which limit, when it resets, and the person's own Claude).
// Run: node --test test/sharedclaude/sharedclaude.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electron = require('../worker/electronStub.cjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-shared-claude-test-'));
electron._paths.userData = dir;
electron._paths.appData = dir;
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const usage = require('../../electron/scholar/usage.cjs');
const runner = require('../../electron/scholar/runner.cjs');
const teach = require('../../electron/scholar/teach.cjs');
const hub = require('../../electron/hub.cjs');
const settings = require('../../electron/settings.cjs');
const FAKE = [process.execPath, path.join(import.meta.dirname, 'fake-claude.cjs')];

// A sample of what Claude Code prints with --output-format stream-json (one run of a class scan).
const SAMPLE = [
  { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-opus-5-5', tools: [] },
  { type: 'assistant', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Reading the class.' }], usage: { input_tokens: 10, output_tokens: 5 } }, session_id: 's1' },
  { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] }, session_id: 's1' },
  {
    type: 'result', subtype: 'success', is_error: false, result: 'Done.', session_id: 's1', num_turns: 12, total_cost_usd: 1.9,
    usage: { input_tokens: 4321, output_tokens: 9876, cache_read_input_tokens: 1_234_567, cache_creation_input_tokens: 54_321, server_tool_use: { web_search_requests: 0 } },
    modelUsage: {
      'claude-opus-5-5': { inputTokens: 4300, outputTokens: 9800, cacheReadInputTokens: 1_234_567, cacheCreationInputTokens: 54_321, costUSD: 1.89 },
      'claude-haiku-5-5': { inputTokens: 21, outputTokens: 76, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01 },
    },
  },
];

test('token accounting from stream-json: result events only, per model, added up over a job’s runs', () => {
  const t = usage.tally();
  for (const ev of SAMPLE) t.add(ev);
  assert.deepEqual(t.get(), {
    byModel: {
      'claude-opus-5-5': { input: 4300, output: 9800, cacheRead: 1_234_567, cacheWrite: 54_321 },
      'claude-haiku-5-5': { input: 21, output: 76, cacheRead: 0, cacheWrite: 0 },
    },
  });
  // A second run (an older Claude Code with no modelUsage: the usage is the run's model's).
  t.add({ type: 'result', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 } });
  assert.deepEqual(t.get().byModel['claude-opus-5-5'], { input: 4400, output: 9850, cacheRead: 1_234_574, cacheWrite: 54_324 });
  // Nothing to count: no usage at all, or not a result.
  assert.equal(usage.usageOf({ type: 'assistant', usage: { input_tokens: 5 } }), null);
  assert.equal(usage.usageOf({ type: 'result' }), null);
  assert.deepEqual(usage.usageOf({ type: 'result', usage: { input_tokens: -4, output_tokens: 'x' } }, 'claude-sonnet-5-5'), { byModel: { 'claude-sonnet-5-5': { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } });
});

test('the locked models: Opus for scans, light checks, questions and guides; Sonnet (effort medium) for lessons', () => {
  for (const k of ['initial_scan', 'update_scan', 'more_questions', 'guide']) assert.deepEqual(usage.lockedFor(k), { model: 'claude-opus-5-5', effort: null }, k);
  assert.deepEqual(usage.lockedFor('explain'), { model: 'claude-sonnet-5-5', effort: 'medium' });
  // A job naming Fable, or another model, or another effort, is refused; one naming none (an older server) is fine.
  assert.throws(() => usage.checkJob({ kind: 'initial_scan', model: 'claude-fable-5-1' }), /claude-fable-5-1/);
  assert.throws(() => usage.checkJob({ kind: 'explain', model: 'claude-opus-5-5' }), /runs claude-sonnet-5-5/);
  assert.throws(() => usage.checkJob({ kind: 'explain', model: 'claude-sonnet-5-5', effort: 'max' }), /effort max/);
  assert.deepEqual(usage.checkJob({ kind: 'more_questions' }), { model: 'claude-opus-5-5', effort: null });
  assert.deepEqual(usage.checkJob({ kind: 'explain', model: 'claude-sonnet-5-5', effort: 'medium' }), { model: 'claude-sonnet-5-5', effort: 'medium' });
});

test('a worker run uses Opus whatever the task or settings pick; the owner’s own runs keep their settings', () => {
  const { TASKS } = runner;
  const model = (task) => {
    const a = runner._test.claudeArgs(['-p', 'x'], task, TASKS[task], [], 'cfg.json');
    return a[a.indexOf('--model') + 1];
  };
  settings.set({ 'scholar.guidesModel': 'sonnet', 'scholar.lookupModel': 'opus' });
  assert.equal(model('guides'), 'sonnet');
  const before = process.env.KEA_WORKER_JOB;
  process.env.KEA_WORKER_JOB = 'job-1';
  try {
    for (const task of Object.keys(TASKS)) assert.equal(model(task), 'claude-opus-5-5', task);
  } finally {
    if (before == null) delete process.env.KEA_WORKER_JOB;
    else process.env.KEA_WORKER_JOB = before;
    settings.set({ 'scholar.guidesModel': 'opus', 'scholar.lookupModel': 'sonnet' });
  }
});

const job = (extra = {}) => ({
  id: 'lesson-1', kind: 'explain', model: 'claude-sonnet-5-5', effort: 'medium', checks: 2,
  request: { question: { type: 'mc', q: 'What is the pH of pure water at 25 C?', choices: ['5', '7', '9'], answer: 1 }, courseCode: 'CHEM 1010', answer: 0, right: false, dunno: false, focus: '', again: false },
  ...extra,
});
const runs = (log) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

test('the owner’s Kea writes a lesson for someone else: Sonnet, effort medium, no tools, streamed, usage counted', async () => {
  const log = path.join(dir, 'claude-1.log');
  const pieces = [];
  const out = await teach.writeShared(job(), { claude: FAKE, cwd: dir, env: { ...process.env, FAKE_CLAUDE_LOG: log }, flushMs: 5, progress: async (t) => (pieces.push(t), { cancelled: false }) });
  assert.equal(out.ok, true, out.error);
  assert.equal(pieces.join(''), out.text);
  assert.match(out.text, /pH is 7/);
  assert.deepEqual(out.usage, { byModel: { 'claude-sonnet-5-5': { input: 1200, output: 640, cacheRead: 3000, cacheWrite: 450 } } });
  const [r] = runs(log);
  const arg = (f) => r.args[r.args.indexOf(f) + 1];
  assert.equal(arg('--model'), 'claude-sonnet-5-5');
  assert.equal(arg('--effort'), 'medium');
  assert.equal(arg('--tools'), '', 'no tools');
  assert.ok(r.args.includes('--strict-mcp-config'));
  assert.ok(!r.args.includes('--resume'));
  assert.match(r.message, /Question: What is the pH of pure water/);
  assert.match(r.message, /Student's answer: A\. 5 \(wrong\)/);
  // The owner's own Teach settings never apply to lessons for others.
  settings.set({ 'study.teach.model': 'claude-opus-5-5', 'study.teach.effort': 'high' });
  const log2 = path.join(dir, 'claude-2.log');
  await teach.writeShared(job(), { claude: FAKE, cwd: dir, env: { ...process.env, FAKE_CLAUDE_LOG: log2 }, flushMs: 5 });
  const [r2] = runs(log2);
  assert.deepEqual([r2.args[r2.args.indexOf('--model') + 1], r2.args[r2.args.indexOf('--effort') + 1]], ['claude-sonnet-5-5', 'medium']);
  settings.set({ 'study.teach.model': 'claude-sonnet-5-5', 'study.teach.effort': 'medium' });
});

test('a lesson job naming Fable (or not a lesson) is refused without running Claude', async () => {
  const log = path.join(dir, 'claude-3.log');
  const env = { ...process.env, FAKE_CLAUDE_LOG: log };
  const fable = await teach.writeShared(job({ model: 'claude-fable-5-1' }), { claude: FAKE, cwd: dir, env });
  assert.equal(fable.ok, false);
  assert.match(fable.error, /claude-fable-5-1/);
  const high = await teach.writeShared(job({ effort: 'high' }), { claude: FAKE, cwd: dir, env });
  assert.equal(high.ok, false);
  const scan = await teach.writeShared(job({ kind: 'initial_scan', model: 'claude-opus-5-5' }), { claude: FAKE, cwd: dir, env });
  assert.equal(scan.ok, false);
  assert.deepEqual(runs(log), [], 'Claude never ran');
});

test('a follow-up for someone else carries the lesson it follows; stopping it mid-way ends Claude', async () => {
  const log = path.join(dir, 'claude-4.log');
  const req = { ...job().request, followup: { ask: 'Why 25 C?', lesson: '## Neutral water\nIt is 7.', earlier: [{ ask: 'And at 50 C?', text: 'Lower.' }] } };
  const out = await teach.writeShared(job({ request: req }), { claude: FAKE, cwd: dir, env: { ...process.env, FAKE_CLAUDE_LOG: log }, flushMs: 5 });
  assert.equal(out.ok, true);
  const [r] = runs(log);
  assert.match(r.message, /lesson you wrote for this student earlier:\n\n## Neutral water/);
  assert.match(r.message, /The student asked: And at 50 C\?/);
  assert.match(r.message, /The student's follow-up: Why 25 C\?$/);
  // The person stops it: the next progress post says so, and Claude is ended.
  const stopped = await teach.writeShared(job({ id: 'lesson-2' }), { claude: FAKE, cwd: dir, env: { ...process.env, FAKE_CLAUDE_DELAY: '150' }, flushMs: 5, progress: async () => ({ cancelled: true }) });
  assert.equal(stopped.ok, false);
  assert.equal(stopped.cancelled, true);
});

test('the lesson writer takes a job from the owner console, posts it as it comes, and reports usage', async () => {
  const calls = [];
  let given = false;
  const call = async (p, body) => {
    calls.push([p, body]);
    if (p === '/owner/teach/next') return { job: given ? null : ((given = true), job({ id: 'abc' })) };
    if (p.endsWith('/progress')) return { ok: true, cancelled: false };
    return { ok: true };
  };
  const got = await hub._teach.teachOnce(call, { wait: 0, claude: FAKE, cwd: dir, env: process.env, flushMs: 5 });
  assert.equal(got.id, 'abc');
  const progress = calls.filter(([p]) => p === '/owner/teach/abc/progress').map(([, b]) => b.text).join('');
  const [, fin] = calls.find(([p]) => p === '/owner/teach/abc/finish');
  assert.equal(fin.ok, true);
  assert.equal(fin.text, progress);
  assert.deepEqual(fin.usage, { byModel: { 'claude-sonnet-5-5': { input: 1200, output: 640, cacheRead: 3000, cacheWrite: 450 } } });
  // Nothing waiting: null. An account server without lessons (older): 'unsupported', so the loop waits longer.
  assert.equal(await hub._teach.teachOnce(call, { wait: 0 }), null);
  assert.equal(await hub._teach.teachOnce(async () => ({ error: 'Not found.' }), { wait: 0 }), 'unsupported');
});

test('a refusal says which limit, when it opens again (this PC’s time) and points to the person’s own Claude', () => {
  const at = Date.now() + 3 * 3600_000;
  const err = (status, message, data) => Object.assign(new Error(message), { status, data });
  const day = hub.sharedClaudeMessage(err(429, 'That’s your 20 lessons for today on Kea’s shared Claude. More at midnight UTC, or use your own Claude.', { limit: 'explainersPerDay', code: 'teach_day', retryAt: at }));
  const t = new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  assert.ok(day.includes(`More ${new Date(at).toDateString() === new Date().toDateString() ? `at ${t}` : `${new Date(at).toLocaleDateString([], { weekday: 'long' })} at ${t}`}, or use your own Claude.`), day);
  assert.ok(!day.includes('UTC'));
  const light = hub.sharedClaudeMessage(err(429, 'This class was checked for new work 3 hours ago. Kea’s shared Claude checks each class at most once every 24 hours.', { limit: 'updateCooldownHours', retryAt: at }));
  assert.match(light, /It opens again .+\. Or use your own Claude: Settings → Claude Assistant\.$/);
  const busy = hub.sharedClaudeMessage(err(503, 'Kea’s shared Claude can’t write lessons right now. Try again later, or use your own Claude.', { code: 'no_worker' }));
  assert.equal(busy, 'Kea’s shared Claude can’t write lessons right now. Try again later, or use your own Claude.');
  // Not a refusal: as it was.
  assert.equal(hub.sharedClaudeMessage(err(0, 'You’re offline.', null)), 'You’re offline.');
});

test('Kea’s UI never names the account server: no “KeaC” in the Teach copy or settings', () => {
  for (const f of ['src/components/scholar/Teach.tsx', 'src/lib/settings.ts']) {
    const src = fs.readFileSync(path.join(import.meta.dirname, '..', '..', f), 'utf8');
    assert.equal(/KeaC/.test(src), false, f);
  }
  for (const f of ['electron/scholar/teach.cjs', 'electron/hub.cjs']) {
    // (Sentences people see are in quotes; none may say KeaC.)
    const src = fs.readFileSync(path.join(import.meta.dirname, '..', '..', f), 'utf8');
    assert.equal(/['`][^'`\n]*KeaC[^'`\n]*['`]/.test(src), false, f);
  }
});
