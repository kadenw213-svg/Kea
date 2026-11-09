// Kea's shared Claude on the owner's API credits (electron/scholar/backend.cjs): which backend a job runs on, the API's
// billing error (and only it) moving an auto job to the owner's plan, a job that can't run on its backend refused,
// Teach lessons through the Messages API (a stand-in fetch answering with sample streaming events and usage), scans
// through the Agent SDK (a stand-in SDK), usage per backend, and the key never written anywhere.
// No real API calls and no real Claude: every answer here comes from a stand-in.
// Run: node --test test/sharedclaude/backend.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electron = require('../worker/electronStub.cjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-backend-test-'));
electron._paths.userData = dir;
electron._paths.appData = dir;
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const Anthropic = require('@anthropic-ai/sdk');
const B = require('../../electron/scholar/backend.cjs');
const teach = require('../../electron/scholar/teach.cjs');
const agentRun = require('../../electron/scholar/agentRun.cjs');
const runner = require('../../electron/scholar/runner.cjs');
const workspace = require('../../electron/scholar/workspace.cjs');
const hub = require('../../electron/hub.cjs');
const FAKE = [process.execPath, path.join(import.meta.dirname, 'fake-claude.cjs')];
// (Made up here: shaped like a key, never a real one.)
const KEY = `sk-ant-api03-${'k'.repeat(24)}TESTONLY`;

// ---------- Which backend ----------
test('backend choice: auto uses the API with a key (the plan without one), api needs a key, plan and older servers use the plan', () => {
  assert.deepEqual(B.choose({ backend: 'auto' }, { hasKey: true }), { run: 'api', auto: true });
  assert.deepEqual(B.choose({ backend: 'auto' }, { hasKey: false }), { run: 'plan', auto: true, noKey: true });
  assert.deepEqual(B.choose({ backend: 'api' }, { hasKey: true }), { run: 'api', auto: false });
  assert.deepEqual(B.choose({ backend: 'plan' }, { hasKey: true }), { run: 'plan', auto: false });
  assert.deepEqual(B.choose({}, { hasKey: true }), { run: 'plan', auto: false }, 'an older account server: the plan');
  // API credits only, and no key: refused with the reason (never quietly run on the plan).
  const r = B.choose({ backend: 'api' }, { hasKey: false });
  assert.ok(r.refuse && /no Claude API key is set/.test(r.refuse), JSON.stringify(r));
  assert.equal(B.wantsKey({ backend: 'plan' }), false);
  assert.equal(B.wantsKey({}), false);
  assert.equal(B.wantsKey({ backend: 'auto' }), true);
});

// ---------- The billing error ----------
const apiError = (status, type, message) => Anthropic.APIError.generate(status, { type: 'error', error: { type, message } }, message, new Headers());
test('the billing error is the API’s 402 billing_error (or its older 400 "credit balance is too low"), nothing else', () => {
  assert.equal(B.isBillingError(apiError(402, 'billing_error', 'Your credit balance is too low to access the Claude API.')), true);
  assert.equal(B.isBillingError(apiError(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.')), true);
  for (const [s, t, m] of [[400, 'invalid_request_error', 'messages: roles must alternate'], [401, 'authentication_error', 'invalid x-api-key'], [403, 'permission_error', 'not allowed'], [429, 'rate_limit_error', 'Number of request tokens has exceeded your per-minute rate limit'], [500, 'api_error', 'Internal server error'], [529, 'overloaded_error', 'Overloaded']])
    assert.equal(B.isBillingError(apiError(s, t, m)), false, `${s} ${t}`);
  assert.equal(B.isBillingError(new Error('credit balance is too low')), false, 'not an API error');
  // The Agent SDK's own name for it, and its failed result's text.
  assert.equal(B.isBillingMessage({ type: 'assistant', error: 'billing_error', message: { content: [] } }), true);
  assert.equal(B.isBillingMessage({ type: 'result', is_error: true, result: 'Credit balance is too low' }), true);
  assert.equal(B.isBillingMessage({ type: 'assistant', error: 'rate_limit' }), false);
  assert.equal(B.isBillingMessage({ type: 'result', is_error: true, result: 'API Error: 500 Internal server error' }), false);
  assert.equal(B.isBillingMessage({ type: 'result', is_error: false, result: 'The essay is about a credit balance is too low' }), false);
});

// ---------- Teach over the Messages API (a stand-in fetch) ----------
const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const LESSON = ['## Neutral water\n', 'Pure water has equal H+ and OH-, so its pH is 7.\n\n', '### Remember\nNeutral means 7 at 25 C.\n', '```check\n[{"q":"pH of 0.1 M HCl?","choices":["1","7","13"],"answer":0,"why":"Strong acid."}]\n```'];
function lessonEvents(model = 'claude-sonnet-5-5') {
  return [
    { type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 912, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ...LESSON.map((t) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } })),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 912, output_tokens: 433, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    { type: 'message_stop' },
  ];
}
/** A stand-in fetch: answers each call with `reply(call)` and keeps every call (url, headers, body). */
function fakeFetch(reply) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const headers = new Headers(init.headers);
    const call = { url: String(url), headers, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    return reply(call);
  };
  fn.calls = calls;
  return fn;
}
const okStream = () => fakeFetch(() => new Response(sse(lessonEvents()), { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_test' } }));
const errorReply = (status, type, message) => fakeFetch(() => new Response(JSON.stringify({ type: 'error', error: { type, message } }), { status, headers: { 'content-type': 'application/json' } }));

const job = (extra = {}) => ({
  id: 'lesson-api', kind: 'explain', model: 'claude-sonnet-5-5', effort: 'medium', checks: 2,
  request: { question: { type: 'mc', q: 'What is the pH of pure water at 25 C?', choices: ['5', '7', '9'], answer: 1 }, courseCode: 'CHEM 1010', answer: 0, right: false, dunno: false, focus: '', again: false },
  ...extra,
});
const runs = (log) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

test('a lesson on API credits: one streamed Messages API call (Sonnet, effort medium, no tools, the same prompt), usage counted', async () => {
  const f = okStream();
  const pieces = [];
  const out = await teach.writeShared(job({ backend: 'auto' }), { apiKey: async () => KEY, fetch: f, flushMs: 5, progress: async (t) => (pieces.push(t), { cancelled: false }) });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.text, LESSON.join(''));
  assert.equal(pieces.join(''), out.text, 'streamed as it came');
  assert.deepEqual(out.usage, { byModel: { 'claude-sonnet-5-5': { input: 912, output: 433, cacheRead: 0, cacheWrite: 0 } } });
  assert.deepEqual(out.run, { backend: 'api' });
  assert.equal(f.calls.length, 1);
  const [c] = f.calls;
  assert.match(c.url, /^https:\/\/api\.anthropic\.com\/v1\/messages/);
  assert.equal(c.headers.get('x-api-key'), KEY, 'the key goes to the Anthropic API');
  assert.equal(c.body.model, 'claude-sonnet-5-5');
  assert.equal(c.body.stream, true);
  assert.deepEqual(c.body.output_config, { effort: 'medium' });
  assert.equal(c.body.tools, undefined, 'no tools');
  assert.equal(c.body.system, teach._test.systemFor(2), 'the same system prompt as the plan');
  assert.equal(c.body.messages.length, 1);
  assert.match(c.body.messages[0].content, /Question: What is the pH of pure water/);
  assert.match(c.body.messages[0].content, /Student's answer: A\. 5 \(wrong\)/);
});

test('auto: the API’s billing error moves the lesson to the plan, and says so; API credits only: no move', async () => {
  const log = path.join(dir, 'plan-1.log');
  const env = { ...process.env, FAKE_CLAUDE_LOG: log };
  const billing = errorReply(402, 'billing_error', 'Your credit balance is too low to access the Claude API.');
  const auto = await teach.writeShared(job({ backend: 'auto' }), { apiKey: async () => KEY, fetch: billing, claude: FAKE, cwd: dir, env, flushMs: 5 });
  assert.equal(auto.ok, true, auto.error);
  assert.match(auto.text, /pH is 7/);
  assert.equal(auto.run.backend, 'plan');
  assert.match(auto.run.fallback.reason, /credit balance is too low/);
  assert.equal(runs(log).length, 1, 'written on the plan');
  // API credits only: the billing error is that lesson's error; it never moves to the plan.
  const log2 = path.join(dir, 'plan-2.log');
  const only = await teach.writeShared(job({ backend: 'api' }), { apiKey: async () => KEY, fetch: billing, claude: FAKE, cwd: dir, env: { ...process.env, FAKE_CLAUDE_LOG: log2 }, flushMs: 5 });
  assert.equal(only.ok, false);
  assert.equal(only.run.backend, 'api');
  assert.equal(only.run.fallback, undefined);
  assert.deepEqual(runs(log2), []);
});

test('other API errors never move a lesson to the plan', async () => {
  for (const [status, type, message] of [[400, 'invalid_request_error', 'messages: roles must alternate'], [401, 'authentication_error', 'invalid x-api-key'], [500, 'api_error', 'Internal server error']]) {
    const log = path.join(dir, `plan-${status}.log`);
    const out = await teach.writeShared(job({ backend: 'auto' }), { apiKey: async () => KEY, fetch: errorReply(status, type, message), claude: FAKE, cwd: dir, env: { ...process.env, FAKE_CLAUDE_LOG: log }, flushMs: 5 });
    assert.equal(out.ok, false, `${status}`);
    assert.equal(out.run.backend, 'api');
    assert.equal(out.run.fallback, undefined, `${status} isn't a billing error`);
    assert.deepEqual(runs(log), [], `${status}: the plan never ran`);
    // The person's sentence says nothing about the API; the details are the owner's, without the key.
    assert.doesNotMatch(out.error, /API|402|500|401/);
    assert.match(out.run.ownerNote, new RegExp(String(status)));
    assert.ok(!JSON.stringify(out).includes(KEY), 'the key is in nothing it reports');
  }
});

test('API credits only with no key set: refused with the reason, nothing runs; auto with no key: the plan', async () => {
  const log = path.join(dir, 'plan-nokey.log');
  const env = { ...process.env, FAKE_CLAUDE_LOG: log };
  const f = okStream();
  const refused = await teach.writeShared(job({ backend: 'api' }), { apiKey: async () => null, fetch: f, claude: FAKE, cwd: dir, env, flushMs: 5 });
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.run, { refused: 'backend' });
  assert.match(refused.error, /no Claude API key is set/);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(runs(log), []);
  const auto = await teach.writeShared(job({ backend: 'auto' }), { apiKey: async () => null, fetch: f, claude: FAKE, cwd: dir, env, flushMs: 5 });
  assert.equal(auto.ok, true);
  assert.deepEqual(auto.run, { backend: 'plan' });
  assert.equal(f.calls.length, 0);
  // An older account server (no backend): the plan, and nothing about backends in the report.
  const old = await teach.writeShared(job(), { apiKey: async () => KEY, fetch: f, claude: FAKE, cwd: dir, env, flushMs: 5 });
  assert.equal(old.ok, true);
  assert.equal(old.run, undefined);
  assert.equal(f.calls.length, 0, 'the key isn’t even used');
});

test('the lesson writer says it runs both backends, asks for the key only for that lesson, and reports where it ran', async () => {
  const calls = [];
  let given = false;
  const call = async (p, body) => {
    calls.push([p, body]);
    if (p === '/owner/teach/next') return { job: given ? null : ((given = true), job({ id: 'xyz', backend: 'auto' })) };
    if (p === '/owner/teach/xyz/api-key') return { key: KEY };
    if (p.endsWith('/progress')) return { ok: true, cancelled: false };
    return { ok: true };
  };
  const f = okStream();
  await hub._teach.teachOnce(call, { wait: 0, fetch: f, flushMs: 5 });
  assert.deepEqual(calls[0], ['/owner/teach/next', { wait: 0, backends: ['api', 'plan'] }]);
  const [, fin] = calls.find(([p]) => p === '/owner/teach/xyz/finish');
  assert.equal(fin.ok, true);
  assert.equal(fin.backend, 'api');
  assert.deepEqual(fin.usage.byModel['claude-sonnet-5-5'].output, 433);
  for (const [p, b] of calls) if (p !== '/owner/teach/xyz/api-key') assert.ok(!JSON.stringify(b ?? {}).includes(KEY), `the key went to ${p}`);
});

// ---------- Scans through the Agent SDK (a stand-in SDK) ----------
/** A stand-in for @anthropic-ai/claude-agent-sdk: query() answers with `messages(options)`, and keeps what it was given. */
function fakeSdk(messages) {
  const seen = [];
  return {
    seen,
    query({ prompt, options }) {
      seen.push({ prompt, options });
      return (async function* () {
        for (const m of messages(options)) yield m;
      })();
    },
  };
}
const RESULT = (extra = {}) => ({
  type: 'result', subtype: 'success', is_error: false, result: 'Done.', session_id: 'sdk-1', num_turns: 4, total_cost_usd: 0.42,
  usage: { input_tokens: 500, output_tokens: 250, cache_read_input_tokens: 9000, cache_creation_input_tokens: 800 },
  modelUsage: { 'claude-opus-5-5': { inputTokens: 500, outputTokens: 250, cacheReadInputTokens: 9000, cacheCreationInputTokens: 800, costUSD: 0.42 } },
  ...extra,
});

test('the Agent SDK run gets the claude command’s options: model, tools, deny list, isolation, MCP, the run’s environment and the key', () => {
  const cfg = path.join(dir, 'mcp.json');
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { kea: { type: 'http', url: 'http://127.0.0.1:5999/mcp', headers: { Authorization: 'Bearer t' } } } }));
  const prev = process.env.KEA_WORKER_JOB;
  process.env.KEA_WORKER_JOB = 'job-sdk';
  try {
    const args = runner._test.claudeArgs(['-p', '/academic-import BIO 1010'], 'import', runner.TASKS.import, [], cfg);
    const { prompt, options } = agentRun.optionsFrom(args, { cwd: dir, env: { PATH: 'x', KEA_TASK: 'import' }, apiKey: KEY, abortController: new AbortController(), stderr: () => {} });
    assert.equal(prompt, '/academic-import BIO 1010');
    assert.equal(options.model, 'claude-opus-5-5');
    assert.equal(options.permissionMode, 'dontAsk');
    assert.equal(options.strictMcpConfig, true);
    assert.deepEqual(options.settingSources, ['project']);
    assert.deepEqual(options.settings, { disableAllHooks: true, enableAllProjectMcpServers: false });
    assert.ok(options.maxTurns >= 10);
    assert.deepEqual(options.mcpServers, { kea: { type: 'http', url: 'http://127.0.0.1:5999/mcp', headers: { Authorization: 'Bearer t' } } });
    const list = (flag) => { const i = args.indexOf(flag); const o = []; for (let j = i + 1; j < args.length && !args[j].startsWith('--'); j++) o.push(args[j]); return o; };
    assert.deepEqual(options.allowedTools, list('--allowedTools'));
    assert.deepEqual(options.disallowedTools, runner._test.DENY);
    assert.ok(options.allowedTools.includes('mcp__kea__d2l_fetch') && !options.allowedTools.includes('WebSearch'));
    assert.deepEqual(options.systemPrompt, { type: 'preset', preset: 'claude_code' });
    assert.deepEqual(options.env, { PATH: 'x', KEA_TASK: 'import', ANTHROPIC_API_KEY: KEY, CLAUDE_AGENT_SDK_CLIENT_APP: 'kea-worker' });
    assert.equal(options.resume, undefined);
    const resumed = agentRun.optionsFrom(runner._test.claudeArgs(['-p', 'Carry on.', '--resume', 'sess-9'], 'import', runner.TASKS.import, [], cfg), { cwd: dir, env: {}, apiKey: KEY });
    assert.equal(resumed.options.resume, 'sess-9');
  } finally {
    if (prev == null) delete process.env.KEA_WORKER_JOB;
    else process.env.KEA_WORKER_JOB = prev;
  }
});

/** Runs one worker task through the real runner with stand-ins for the workspace, uv and Claude. */
async function workerRun(task, sdk) {
  const ws = fs.mkdtempSync(path.join(dir, 'ws-'));
  fs.mkdirSync(path.join(ws, 'data', 'logs'), { recursive: true });
  const saved = { prepare: workspace.prepare, findClaude: workspace.findClaude, findUv: workspace.findUv };
  Object.assign(workspace, { prepare: () => ws, findClaude: async () => null, findUv: async () => process.execPath });
  agentRun.useSdk(sdk);
  try {
    const entry = await runner.run(task, '', 'worker');
    while (runner.status().running || runner.status().queued.length) await new Promise((r) => setTimeout(r, 20));
    await logsWritten(ws);
    return { entry, ws };
  } finally {
    Object.assign(workspace, saved);
    agentRun.useSdk(null);
  }
}
/** Waits (a moment at most) until the run logs under `ws` are closed: a run's log is written as it goes. */
async function logsWritten(ws, runs = 1) {
  const logs = path.join(ws, 'data', 'logs');
  for (let i = 0; i < 150; i++) {
    const files = fs.existsSync(logs) ? fs.readdirSync(logs) : [];
    const ended = files.reduce((n, f) => n + (fs.readFileSync(path.join(logs, f), 'utf8').match(/=== exit/g) || []).length, 0);
    if (ended >= runs) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}
const filesUnder = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(path.join(d, e.name)) : [path.join(d, e.name)]));

test('a worker run on API credits goes through the Agent SDK: progress, result and usage as before, counted as API; the key in no file', async () => {
  const prev = process.env.KEA_WORKER_JOB;
  process.env.KEA_WORKER_JOB = 'job-sdk-run';
  try {
    // (The stand-in echoes the key it was given in a message, as a careless tool might: it must not reach the log.)
    const sdk = fakeSdk((o) => [
      { type: 'system', subtype: 'init', session_id: 'sdk-1', model: o.model, apiKeySource: 'ANTHROPIC_API_KEY' },
      { type: 'assistant', message: { model: o.model, content: [{ type: 'text', text: `Testing. key=${o.env.ANTHROPIC_API_KEY}` }] }, session_id: 'sdk-1' },
      RESULT(),
    ]);
    runner.useBackend({ run: 'api', apiKey: KEY });
    const { entry, ws } = await workerRun('probe', sdk);
    assert.equal(entry.ok, true, entry.summary);
    assert.equal(sdk.seen.length, 1);
    assert.equal(sdk.seen[0].options.env.ANTHROPIC_API_KEY, KEY);
    assert.equal(sdk.seen[0].options.model, 'claude-opus-5-5');
    const by = runner.workerUsageByBackend();
    assert.deepEqual(by.api, { byModel: { 'claude-opus-5-5': { input: 500, output: 250, cacheRead: 9000, cacheWrite: 800 } } });
    assert.equal(by.plan, null);
    // The run log, the activity record and everything else this Kea wrote: never the key.
    for (const f of [...filesUnder(ws), ...filesUnder(dir).filter((x) => !x.startsWith(ws))]) assert.ok(!fs.readFileSync(f, 'utf8').includes(KEY), `the key is in ${f}`);
    const log = filesUnder(ws).find((f) => /kea-probe-.*\.log$/.test(f));
    assert.ok(log && /\[api key\]/.test(fs.readFileSync(log, 'utf8')), 'the run was logged, with the key taken out');
  } finally {
    runner.useBackend(null);
    if (prev == null) delete process.env.KEA_WORKER_JOB;
    else process.env.KEA_WORKER_JOB = prev;
  }
});

test('a worker run the API says has no credit left is marked as a billing error (the worker moves an auto job to the plan)', async () => {
  const prev = process.env.KEA_WORKER_JOB;
  process.env.KEA_WORKER_JOB = 'job-sdk-billing';
  try {
    const sdk = fakeSdk(() => [
      { type: 'system', subtype: 'init', session_id: 'sdk-2' },
      { type: 'assistant', error: 'billing_error', message: { content: [{ type: 'text', text: 'Credit balance is too low' }] }, session_id: 'sdk-2' },
      RESULT({ subtype: 'success', is_error: true, result: 'Credit balance is too low', modelUsage: {}, usage: { input_tokens: 0, output_tokens: 0 } }),
    ]);
    runner.useBackend({ run: 'api', apiKey: KEY });
    const { entry } = await workerRun('probe', sdk);
    assert.equal(entry.ok, false);
    assert.equal(entry.billing, true);
    assert.equal(runner.activity()[0].billing, true);
    // An ordinary API failure (overloaded) isn't one.
    const sdk2 = fakeSdk(() => [{ type: 'assistant', error: 'overloaded', message: { content: [] } }, RESULT({ is_error: true, result: 'API Error: 529 Overloaded' })]);
    const r2 = await workerRun('probe', sdk2);
    assert.equal(r2.entry.ok, false);
    assert.equal(r2.entry.billing, undefined);
  } finally {
    runner.useBackend(null);
    if (prev == null) delete process.env.KEA_WORKER_JOB;
    else process.env.KEA_WORKER_JOB = prev;
  }
});

test('the worker: an auto job the API says has no credit runs again on the plan; API credits only fails; the finish says where it ran', async () => {
  const worker = require('../../electron/scholar/worker.cjs');
  const { how, extras, runTask } = worker._test;
  const prev = process.env.KEA_WORKER_JOB;
  process.env.KEA_WORKER_JOB = 'job-fallback';
  const billing = () => fakeSdk(() => [{ type: 'assistant', error: 'billing_error', message: { content: [] } }, RESULT({ is_error: true, result: 'Credit balance is too low', modelUsage: {} })]);
  const ws = fs.mkdtempSync(path.join(dir, 'ws-'));
  fs.mkdirSync(path.join(ws, 'data', 'logs'), { recursive: true });
  const saved = { prepare: workspace.prepare, findClaude: workspace.findClaude, findUv: workspace.findUv };
  // (No claude command here: the plan's run ends at once with "not set up", which shows it ran on the plan.)
  Object.assign(workspace, { prepare: () => ws, findClaude: async () => null, findUv: async () => process.execPath });
  try {
    const sdk = billing();
    agentRun.useSdk(sdk);
    Object.assign(how, { ranOn: 'api', auto: true, fallback: null, told: true });
    runner.useBackend({ run: 'api', apiKey: KEY });
    await assert.rejects(runTask('probe'), /aren’t set up/);
    await logsWritten(ws);
    assert.equal(sdk.seen.length, 1, 'the API was tried once');
    assert.equal(how.ranOn, 'plan');
    assert.match(how.fallback.reason, /credit balance is too low/);
    const ex = extras();
    assert.equal(ex.backend, 'plan');
    assert.match(ex.fallback.reason, /credit balance/);
    assert.ok(!JSON.stringify(ex).includes(KEY));
    // API credits only: the same billing error is the job's error, and nothing runs on the plan.
    const sdk2 = billing();
    agentRun.useSdk(sdk2);
    Object.assign(how, { ranOn: 'api', auto: false, fallback: null, told: true });
    runner.useBackend({ run: 'api', apiKey: KEY });
    await assert.rejects(runTask('probe'), (e) => e.fromRun === true && /credit balance/.test(e.message));
    await logsWritten(ws, 2);
    assert.equal(how.ranOn, 'api');
    assert.equal(how.fallback, null);
    // Refused (no key for API credits only): only that, for the account server.
    assert.deepEqual(extras({ refused: true }), { refused: 'backend' });
    // An older account server (it sent no backend): nothing about backends at all.
    Object.assign(how, { told: false });
    assert.deepEqual(extras(), {});
  } finally {
    Object.assign(workspace, saved);
    agentRun.useSdk(null);
    runner.useBackend(null);
    Object.assign(how, { ranOn: 'plan', auto: false, fallback: null, told: false });
    if (prev == null) delete process.env.KEA_WORKER_JOB;
    else process.env.KEA_WORKER_JOB = prev;
  }
});

test('"Use my own Claude": on, Kea never asks its shared Claude; the old Advanced setting carries over', () => {
  const settings = require('../../electron/settings.cjs');
  const route = require('../../electron/scholar/claudeRoute.cjs');
  settings.set({ 'claude.ownOnly': null, 'claude.sharedFallback': null });
  assert.equal(route.fallbackOn(), true, 'off by default: the shared Claude steps in when yours can’t');
  settings.set({ 'claude.ownOnly': true });
  assert.equal(route.fallbackOn(), false);
  settings.set({ 'claude.ownOnly': null, 'claude.sharedFallback': false });
  assert.equal(route.fallbackOn(), false, 'someone who had turned the fallback off');
  assert.equal(settings.get('claude.ownOnly'), true, 'and the switch now shows it');
  settings.set({ 'claude.ownOnly': null, 'claude.sharedFallback': null });
  // The switch is in Settings → Claude Assistant, not under Advanced, with its one-line why; the UI never says KeaC.
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'src', 'lib', 'settings.ts'), 'utf8');
  const line = src.split('\n').find((l) => l.includes("key: 'claude.ownOnly'"));
  assert.ok(line && !/advanced: true/.test(line) && /label: 'Use my own Claude'/.test(line), line);
  assert.match(src, /OWN_CLAUDE_WHY = 'More privacy and no shared limits\.'/);
  for (const f of ['src/components/account/OwnClaude.tsx', 'src/components/scholar/HubAccount.tsx', 'src/components/scholar/Teach.tsx'])
    // (Code comments aside: nothing shown says KeaC.)
    assert.equal(/\bKeaC\b/.test(fs.readFileSync(path.join(import.meta.dirname, '..', '..', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')), false, f);
});
