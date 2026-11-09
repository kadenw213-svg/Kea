// Which Claude does the work (electron/scholar/claudeRoute.cjs): the person's own Claude first, Kea's shared Claude
// only when this PC has none, or when their own run failed because Claude Code is signed out or at its plan's usage
// limit. Never after an ordinary failure or a run they stopped; never when the Advanced setting is off; and every
// fallback is an ordinary shared-Claude request (its limits and locked models apply on the server and the worker).
// A stand-in claude plays the person's own Claude Code; the Kea account is stubbed. No real Claude runs.
// Run: node --test test/sharedclaude/routing.test.mjs
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electron = require('../worker/electronStub.cjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-claude-route-test-'));
electron._paths.userData = dir;
electron._paths.appData = dir;
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const route = require('../../electron/scholar/claudeRoute.cjs');
const settings = require('../../electron/settings.cjs');
const plan = require('../../electron/assistantPlan.cjs');
const hub = require('../../electron/hub.cjs');
const hubOrg = require('../../electron/hubOrg.cjs');
const teach = require('../../electron/scholar/teach.cjs');
const runner = require('../../electron/scholar/runner.cjs');
const FAKE = [process.execPath, path.join(import.meta.dirname, 'fake-claude.cjs')];

const LIMIT_TEXT = 'Claude AI usage limit reached|1760035200';
const LIMIT_TEXT_2 = 'You’ve hit your session limit · resets 8:10pm';
const SIGNED_OUT = 'Invalid API key · Please run /login';

test('what allows the fallback: a usage limit or a signed-out Claude, read from Claude Code’s own output', () => {
  assert.equal(route.fallbackReason(LIMIT_TEXT), 'limit');
  assert.equal(route.fallbackReason(LIMIT_TEXT_2), 'limit');
  assert.equal(route.fallbackReason(SIGNED_OUT), 'signedOut');
  assert.equal(route.fallbackReason('Not logged in · Please run /login'), 'signedOut');
  // Ordinary failures: no fallback.
  for (const t of ['API Error: 529 overloaded', 'Request timed out', 'Prompt is too long', 'Error: tool failed', '', null]) assert.equal(route.fallbackReason(t), null, String(t));
  // A run that was stopped, whatever it said.
  assert.equal(route.fallbackReason(LIMIT_TEXT, { stopped: true }), null);
  assert.equal(route.noteFor('limit'), 'Used the shared Claude because yours is at its limit.');
  assert.equal(route.noteFor('signedOut'), 'Used the shared Claude because yours is signed out.');
});

// ---------- Teach ----------
const asked = [];
let ownClaude = FAKE;
beforeEach(() => {
  asked.length = 0;
  ownClaude = FAKE;
  delete process.env.FAKE_CLAUDE_FAIL;
  settings.set({ 'claude.ownOnly': false, 'study.teach.via': 'auto' });
});
plan.findClaude = async () => ownClaude;
hub.signedIn = () => true;
hubOrg.accountFeatures = async () => ['sharedTeach', 'usageTracking'];
hub.requestTeach = async (body, onText) => {
  asked.push(body);
  onText('## From the shared Claude\n');
  return { text: '## From the shared Claude\nIt is 7.', model: 'claude-sonnet-5-5' };
};
const question = { type: 'mc', q: 'What is the pH of pure water at 25 C?', choices: ['5', '7', '9'], answer: 1 };
let n = 0;
const lesson = () => teach.teach(`req-${++n}`, { k: `q${n}`, question, courseCode: 'CHEM 1010', answer: 0, right: false });

test('own Claude first: a lesson is written by it, and the shared Claude isn’t asked', async () => {
  const r = await lesson();
  assert.ok(r.lesson, r.error);
  assert.match(r.lesson.text, /Neutral water/);
  assert.equal(r.lesson.via, undefined);
  assert.equal(r.note, undefined);
  assert.equal(asked.length, 0);
});

test('own Claude at its usage limit: the shared Claude writes it, with the note', async () => {
  process.env.FAKE_CLAUDE_FAIL = LIMIT_TEXT_2;
  const r = await lesson();
  assert.ok(r.lesson, r.error);
  assert.equal(r.lesson.via, 'shared');
  assert.equal(r.lesson.model, 'claude-sonnet-5-5');
  assert.equal(r.note, 'Used the shared Claude because yours is at its limit.');
  assert.equal(asked.length, 1);
  // Only the question and answers go: never a model or effort.
  assert.equal('model' in asked[0] || 'effort' in asked[0], false);
});

test('own Claude signed out: the shared Claude, with its note', async () => {
  process.env.FAKE_CLAUDE_FAIL = SIGNED_OUT;
  const r = await lesson();
  assert.equal(r.note, 'Used the shared Claude because yours is signed out.');
  assert.equal(asked.length, 1);
});

test('an ordinary failure is not a reason: no fallback, the person sees their own Claude’s error', async () => {
  process.env.FAKE_CLAUDE_FAIL = 'API Error: 529 overloaded';
  const r = await lesson();
  assert.ok(r.error);
  assert.equal(asked.length, 0);
});

test('"Use my own Claude" on: no fallback, even at the limit or with no Claude on this PC', async () => {
  settings.set({ 'claude.ownOnly': true });
  process.env.FAKE_CLAUDE_FAIL = LIMIT_TEXT;
  const r = await lesson();
  assert.ok(r.error);
  ownClaude = null;
  const none = await lesson();
  assert.match(none.error, /isn’t installed/);
  assert.equal(asked.length, 0);
});

test('no Claude on this PC: the shared Claude writes it (and the Teach pane says so)', async () => {
  ownClaude = null;
  assert.equal((await teach.route()).via, 'shared');
  const r = await lesson();
  assert.equal(r.lesson.via, 'shared');
  assert.equal(asked.length, 1);
  // An account server without lessons (older): not offered.
  hubOrg.accountFeatures = async () => [];
  assert.equal((await teach.route()).via, 'none');
  hubOrg.accountFeatures = async () => ['sharedTeach', 'usageTracking'];
});

test('the shared Claude says no (a limit): the person sees which limit and their own Claude’s error', async () => {
  process.env.FAKE_CLAUDE_FAIL = LIMIT_TEXT;
  const real = hub.requestTeach;
  hub.requestTeach = async () => {
    throw Object.assign(new Error('That’s your 20 lessons for today on Kea’s shared Claude. More at midnight UTC, or use your own Claude.'), { status: 429, data: { limit: 'explainersPerDay', retryAt: Date.now() + 3600_000 } });
  };
  try {
    const r = await lesson();
    assert.match(r.error, /usage limit/);
    assert.match(r.error, /20 lessons for today/);
    assert.ok(!/UTC/.test(r.error));
  } finally {
    hub.requestTeach = real;
  }
});

// ---------- Scans and question batches ----------
const fakeHub = (over = {}) => ({ signedIn: () => true, requestScan: async () => (fakeHub.calls.push('scan'), { status: 'queued', message: '' }), requestQuestions: async (a) => (fakeHub.calls.push(['questions', a]), { status: 'queued' }), ...over });
fakeHub.calls = [];

test('a class scan or a question batch: handed to the shared Claude when own Claude can’t; with the note', async () => {
  const { sharedInstead, FALLBACK_TASKS } = runner._test;
  assert.deepEqual(FALLBACK_TASKS, ['import', 'practice']);
  fakeHub.calls.length = 0;
  const r = await sharedInstead({ task: 'import', arg: '' }, 'limit', fakeHub());
  assert.equal(r.ok, true);
  assert.match(r.note, /^Used the shared Claude because yours is at its limit\./);
  assert.deepEqual(fakeHub.calls, ['scan']);
  const none = await sharedInstead({ task: 'import', arg: 'BIO 1010' }, 'none', fakeHub());
  assert.match(none.note, /no Claude connected/);
  // Other runs (the daily check, textbooks, guides) aren't handed over.
  for (const task of ['daily', 'sync', 'study', 'guides', 'lookup']) assert.equal((await sharedInstead({ task, arg: '' }, 'limit', fakeHub())).ok, false, task);
  // Setting off, signed out of the Kea account, or the shared Claude says no: not handed over (the run pauses as before).
  settings.set({ 'claude.ownOnly': true });
  assert.equal((await sharedInstead({ task: 'import', arg: '' }, 'limit', fakeHub())).ok, false);
  settings.set({ 'claude.ownOnly': false });
  assert.equal((await sharedInstead({ task: 'import', arg: '' }, 'limit', fakeHub({ signedIn: () => false }))).ok, false);
  const no = await sharedInstead({ task: 'import', arg: '' }, 'limit', fakeHub({ requestScan: async () => { throw new Error('This class already had its full scan this term.'); } }));
  assert.deepEqual(no, { ok: false, error: 'This class already had its full scan this term.' });
  // Never in a worker copy (the owner's Claude already).
  process.env.KEA_WORKER_JOB = 'j';
  try {
    assert.equal((await sharedInstead({ task: 'import', arg: '' }, 'limit', fakeHub())).ok, false);
  } finally {
    delete process.env.KEA_WORKER_JOB;
  }
});
