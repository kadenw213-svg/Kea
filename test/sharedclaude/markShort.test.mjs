// Claude marks a typed answer (teach.cjs mark), with a stand-in for Claude Code.
// Run: node --test test/sharedclaude/markShort.test.mjs
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electron = require('../worker/electronStub.cjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-mark-test-'));
electron._paths.userData = dir;
electron._paths.appData = dir;
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const plan = require('../../electron/assistantPlan.cjs');
const teach = require('../../electron/scholar/teach.cjs');
const FAKE = [process.execPath, path.join(import.meta.dirname, 'fake-claude.cjs')];
const LOG = path.join(dir, 'claude.log');
process.env.FAKE_CLAUDE_LOG = LOG;
afterEach(() => {
  delete process.env.FAKE_CLAUDE_TEXT;
  fs.rmSync(LOG, { force: true });
});

const question = { type: 'short', q: 'Why does ice float?', answer: 'Ice is less dense than liquid water because hydrogen bonds hold it in an open lattice.', explain: 'Density.' };

test('a verdict is read from Claude’s one line of JSON, with or without words around it', () => {
  const { verdictOf } = teach._test;
  assert.deepEqual(verdictOf('{"right": true, "why": "Same idea."}'), { right: true, why: 'Same idea.' });
  assert.deepEqual(verdictOf('Here you go:\n{"right": false, "why": "Density is missing."}'), { right: false, why: 'Density is missing.' });
  assert.equal(verdictOf('{"right": "yes"}'), null);
  assert.equal(verdictOf('no json'), null);
});

test('Claude marks the answer: the question, the model answer and the student’s answer go in, the verdict comes out', async () => {
  plan.findClaude = async () => FAKE;
  process.env.FAKE_CLAUDE_TEXT = '{"right": true, "why": "You named the lower density and the lattice."}';
  const r = await teach.mark('t1', { question, answer: 'its less dense, the H bonds make an open structure' });
  assert.deepEqual(r, { right: true, why: 'You named the lower density and the lattice.' });
  const run = JSON.parse(fs.readFileSync(LOG, 'utf8').trim().split('\n').pop());
  assert.match(run.message, /Model answer: Ice is less dense/);
  assert.match(run.message, /Student's answer: its less dense/);
  assert.equal(run.args[run.args.indexOf('--effort') + 1], 'low');
  assert.match(run.args[run.args.indexOf('--system-prompt') + 1], /mark one college student's typed answer/);
});

test('without Claude on this PC, or with an empty answer, or an unreadable reply, the student marks it', async () => {
  plan.findClaude = async () => null;
  assert.ok((await teach.mark('t2', { question, answer: 'x' })).error);
  plan.findClaude = async () => FAKE;
  assert.ok((await teach.mark('t3', { question, answer: '  ' })).error);
  process.env.FAKE_CLAUDE_TEXT = 'I think it is right.';
  assert.ok((await teach.mark('t4', { question, answer: 'less dense' })).error);
});
