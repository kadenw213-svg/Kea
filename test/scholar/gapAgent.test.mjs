// Fill gaps before asking: research once (or a set number of times), never the same gap twice, tell the student only
// when the research didn't find it, once.
// Run: node --test test/scholar/gapAgent.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const G = require('../../electron/scholar/gapAgent.cjs');

const now = new Date('2026-11-21T12:00:00Z');
const later = (h) => new Date(now.getTime() + h * 3600e3);
const bare = { id: 'a1', type: 'paper', title: 'Essay 2', date: '2026-11-28', courseCode: 'ENG 102', description: '', links: [{ kind: 'submit', url: 'https://x/dropbox?db=1' }] };
const none = () => ({ hasRubric: false, hasFiles: false, guide: null });

test('an assignment with no instructions is researched first, not reported', () => {
  const r = G.plan([bare], none, {}, { now });
  assert.deepEqual(r.research.map((x) => x.what), ['instructions']);
  assert.equal(r.tell.length, 0);
});

test('the same gap is never researched twice; once the attempt fails, the student is told once', () => {
  let r = G.plan([bare], none, {}, { now });
  r = G.plan([bare], none, r.state, { now: later(2) });
  assert.equal(r.research.length, 0, 'not again');
  assert.equal(r.tell.length, 0, 'the run may still be going');
  r = G.plan([bare], none, r.state, { now: later(30) });
  assert.equal(r.research.length, 0);
  assert.equal(r.tell.length, 1);
  r = G.plan([bare], none, r.state, { now: later(60) });
  assert.equal(r.tell.length, 0, 'told once');
});

test('a set number of attempts, one a day', () => {
  let r = G.plan([bare], none, {}, { now, attempts: 2 });
  assert.equal(r.research.length, 1);
  r = G.plan([bare], none, r.state, { now: later(5), attempts: 2 });
  assert.equal(r.research.length, 0);
  r = G.plan([bare], none, r.state, { now: later(25), attempts: 2 });
  assert.equal(r.research.length, 1);
});

test('found since: the gap closes and nothing is said', () => {
  let r = G.plan([bare], none, {}, { now });
  const found = () => ({ hasRubric: true, hasFiles: true, guide: null });
  r = G.plan([bare], found, r.state, { now: later(30) });
  assert.equal(r.tell.length, 0);
  assert.ok(Object.values(r.state).every((s) => s.resolved));
});

test('a paper with instructions but no rubric gets a rubric search; a discussion doesn’t', () => {
  const withText = { ...bare, description: 'Write a 1,000-word argument essay about a local issue, using three sources and MLA format.' };
  assert.equal(G.missingFor(withText, none()), 'rubric');
  assert.equal(G.missingFor({ ...withText, type: 'discussion' }, none()), null);
});

test('past, far-off, done and dropped work is left alone', () => {
  for (const it of [{ ...bare, date: '2026-11-01' }, { ...bare, date: '2027-02-01' }, { ...bare, done: true }, { ...bare, withdrawn: true }, { ...bare, type: 'lecture' }])
    assert.equal(G.plan([it], none, {}, { now }).research.length, 0);
});

test('the message says exactly what’s missing and links its page', () => {
  const m = G.message(bare, 'rubric', 'D2L');
  assert.match(m.title, /No rubric found for Essay 2/);
  assert.equal(m.links[0].url, 'https://x/dropbox?db=1');
});
