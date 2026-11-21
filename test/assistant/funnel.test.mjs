// The model funnel: each message goes to the size of model it needs.
// Run: node --test test/assistant/funnel.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { route, modelLabel } from '../../src/lib/funnel.ts';

const msg = (text, more = {}) => ({ text, selection: 0, assignment: false, attachments: 0, noun: 'document', ...more });

test('a small change to highlighted text is quick', () => {
  for (const t of ['Rephrase this', 'make it shorter', 'Give me a synonym for this word', 'fix the grammar here', 'Simplify'])
    assert.equal(route(msg(t, { selection: 80 })).tier, 'quick', t);
  assert.equal(route(msg('Rephrase this', { selection: 80 })).model, 'claude-haiku-5-5');
});

test('a long highlighted passage is not quick', () => {
  assert.notEqual(route(msg('Rephrase this', { selection: 5000 })).tier, 'quick');
});

test('a short lookup with nothing highlighted is quick', () => {
  assert.equal(route(msg('What does ubiquitous mean?')).tier, 'quick');
  assert.equal(route(msg('define hegemony')).tier, 'quick');
});

test('grading, rubrics, whole-paper reviews, sources and outlines are deep, on the chosen model', () => {
  for (const t of [
    'Review this against my assignment’s rubric',
    'What grade would this get?',
    'Proofread my whole essay',
    'Check this before I submit it',
    'Help me with my thesis',
    'Find sources for this paragraph',
    'Make an outline I can fill in',
    'Make me a plan to finish this on time'
  ])
    assert.equal(route(msg(t), 'claude-fable-5-1', 'high').tier, 'deep', t);
  const r = route(msg('Review this against my rubric'), 'claude-fable-5-1', 'high');
  assert.equal(r.model, 'claude-fable-5-1');
  assert.equal(r.effort, 'high');
});

test('attachments and visual work are deep', () => {
  assert.equal(route(msg('Make this', { attachments: 1 })).tier, 'deep');
  assert.equal(route(msg('Add a title slide', { noun: 'presentation' })).tier, 'deep');
});

test('everything else is standard, on Sonnet', () => {
  const r = route(msg('Add a sentence after the second paragraph about the treaty'));
  assert.equal(r.tier, 'standard');
  assert.equal(r.model, 'claude-sonnet-5-5');
  assert.equal(r.effort, 'medium');
});

test('a long request on an assignment file is deep', () => {
  assert.equal(route(msg('x '.repeat(200), { assignment: true })).tier, 'deep');
});

test('model names read plainly', () => {
  assert.equal(modelLabel('claude-haiku-5-5'), 'Haiku 5.5');
  assert.equal(modelLabel('claude-opus-5-5'), 'Opus 5.5');
});
