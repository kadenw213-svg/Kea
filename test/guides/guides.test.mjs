// Assignment guides (electron/scholar/guides.cjs): which items get one, when one is written again, and how Claude's
// answer is checked. Run: node --test test/guides/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const guides = require('../../electron/scholar/guides.cjs');

const TODAY = '2026-11-01';
const item = (over = {}) => ({ id: 'a', type: 'assignment', title: 'Lab report #7', date: '2026-11-07', due: '23:59', points: 25, description: 'Submit the SI PDF and notebook.', sourceWording: '', links: [{ url: 'https://x.edu/folder' }], done: null, handIn: null, courseCode: 'CHE1011', ...over });

test('upcoming work and missing work get a guide; done, handed-in, past and lecture items do not', () => {
  const list = [
    item({ id: 'up' }),
    item({ id: 'missing', date: '2026-10-24', handIn: 'not_submitted' }),
    item({ id: 'past-unknown', date: '2026-10-24' }),
    item({ id: 'done', done: '2026-10-30' }),
    item({ id: 'graded', handIn: 'graded' }),
    item({ id: 'lecture', type: 'lecture' }),
    item({ id: 'reading', type: 'weekly_reading' })
  ];
  assert.deepEqual(guides.needing(list, {}, TODAY).map((i) => i.id), ['up', 'missing']);
});

test('a guide is written again only when the teacher changes the assignment', () => {
  const it = item({ id: 'x' });
  const have = { x: { hash: guides.hashOf(it), v: 4, at: '2026-11-01T12:00:00Z' } };
  assert.equal(guides.needing([it], have, TODAY).length, 0);
  assert.equal(guides.needing([{ ...it, description: 'Submit the SI PDF, notebook and photos.' }], have, TODAY).length, 1);
  assert.equal(guides.needing([{ ...it, date: '2026-11-08' }], have, TODAY).length, 1);
  // (Checking it off or reading it doesn't change the hash.)
  assert.equal(guides.hashOf({ ...it, readings: [{ chapter: 'Chapter 6' }] }), guides.hashOf(it));
});

test('Claude’s guide is cleaned: bad links dropped, kinds kept to the list, lengths capped, empty steps removed', () => {
  const g = guides.clean({
    kind: 'weird',
    summary: 'x'.repeat(2000),
    need: ['notebook', '', 5],
    steps: [
      { title: 'Prepare', text: 'Pages ready.', detail: '- header', links: [{ label: 'Notebook', url: 'https://x.edu/nb' }, { label: 'Bad', url: 'javascript:alert(1)' }, { label: 'Rel', url: '/d2l/x' }] },
      { title: '', text: 'no title' },
      { title: 'Empty' }
    ],
    submit: { what: 'SI PDF + notebook', where: 'Lab 7 folder', url: 'ftp://x' },
    graded: [{ criterion: 'Notebook', points: '6', how: 'signed pages' }, { criterion: '' }],
    gaps: ['No procedure posted'],
    sources: ['Syllabus', { label: 'Lab notebook page', url: 'https://x.edu/nb' }]
  });
  // (Never shown, so no longer kept.)
  assert.equal(g.sources, undefined);
  assert.equal(g.kind, 'other');
  assert.ok(g.summary.length <= 601);
  assert.deepEqual(g.need, ['notebook']);
  assert.equal(g.steps.length, 1);
  assert.deepEqual(g.steps[0].links, [{ label: 'Notebook', url: 'https://x.edu/nb' }]);
  assert.equal(g.submit.url, '');
  assert.deepEqual(g.graded, [{ criterion: 'Notebook', points: 6, how: 'signed pages' }]);
  assert.equal(guides.clean({ steps: [] }), null);
  assert.equal(guides.clean(null), null);
});

test('messages that mention an assignment are found by its number or its distinctive words', () => {
  const { marks, mentions } = guides._test;
  const m = marks('Lab report #7: Colligative Properties and Osmotic Pressure');
  assert.ok(mentions('Reminder: lab 7 notebook pages must be signed', m));
  assert.ok(mentions('Questions about osmotic pressure and colligative properties', m));
  assert.ok(!mentions('Lab 8 is due Saturday', m));
  assert.ok(!mentions('Exam 4 covers chapter 7', marks('Lab report #7: Colligative Properties')));
});

test('an older answer’s gate keeps only a direct https link, and nothing without what to do', () => {
  const step = [{ title: 'Prepare', text: 'Pages.' }];
  assert.deepEqual(guides.clean({ steps: step, gate: { what: 'x', label: 'Open it', url: 'javascript:alert(1)' } }).steps[0].links, []);
  assert.equal(guides.clean({ steps: step, gate: null }).steps.length, 1);
  assert.equal(guides.clean({ steps: step, gate: { url: 'https://x.edu' } }).steps.length, 1);
});

test('guides from before v0.66 (topic, goal, notes, lab procedure) are written once more, of every kind', () => {
  const it = item({ id: 'p' });
  const h = guides.hashOf(it);
  const at = '2026-11-01T12:00:00Z';
  assert.equal(guides.needing([it], { p: { hash: h, kind: 'paper', v: 2, at } }, TODAY).length, 1);
  assert.equal(guides.needing([it], { p: { hash: h, kind: 'lab', v: 2, at } }, TODAY).length, 1);
  assert.equal(guides.needing([it], { p: { hash: h, kind: 'lab', v: 3, at } }, TODAY).length, 1);
  assert.equal(guides.needing([it], { p: { hash: h, kind: 'lab', v: 4, at } }, TODAY).length, 0);
});

test('a guide written while the work was ahead is written once more when it turns missing', () => {
  const it = item({ id: 'm', date: '2026-10-30', handIn: 'not_submitted' });
  const h = guides.hashOf(it);
  assert.equal(guides.needing([it], { m: { hash: h, v: 4, at: '2026-10-28T12:00:00Z' } }, TODAY).length, 1);
  assert.equal(guides.needing([it], { m: { hash: h, v: 4, at: '2026-10-31T12:00:00Z' } }, TODAY).length, 0);
});

test('topic, goal, notes, procedure and notebook are kept; the writing focus keeps research and feedback', () => {
  const g = guides.clean({
    kind: 'paper',
    summary: 's',
    topic: 'Universal basic income',
    goal: 'Show how four groups see it.',
    notes: ['Draft goes to peer review Wed, Nov 4', 3],
    steps: [{ title: 'Find sources', text: 'Two on employers.' }],
    procedure: '### Exercise 1\n1. Fill wells A1-A3.',
    notebook: ['Header', { item: 'Reagent table', detail: 'acetic acid, sodium acetate' }, { detail: 'no item' }],
    focus: { research: [{ question: 'How do employers see it?', why: 'Missing view', search: '"basic income" AND employers' }, { why: 'no question' }], builds: 'dropped', fix: ['Compare sources, not one at a time'] }
  });
  assert.equal(g.topic, 'Universal basic income');
  assert.equal(g.goal, 'Show how four groups see it.');
  assert.deepEqual(g.notes, ['Draft goes to peer review Wed, Nov 4']);
  assert.ok(g.procedure.startsWith('### Exercise 1'));
  assert.deepEqual(g.notebook, [{ item: 'Header', detail: '' }, { item: 'Reagent table', detail: 'acetic acid, sodium acetate' }]);
  assert.deepEqual(Object.keys(g.focus), ['research', 'fix']);
  assert.equal(g.focus.research.length, 1);
  // (An older answer's focus topic and question still fill the top.)
  const old = guides.clean({ kind: 'paper', steps: [{ title: 'a', text: 'b' }], focus: { topic: 'UBI', question: 'Four groups' } });
  assert.equal(old.topic, 'UBI');
  assert.equal(old.goal, 'Four groups');
  assert.equal(guides.clean({ kind: 'lab', summary: 's', steps: [{ title: 'a', text: 'b' }], focus: { goals: [] } }).focus, null);
});

test('links Claude was not given are dropped; a lab platform reached by clicking is kept', () => {
  const known = (u) => ['https://x.edu/nb'].includes(u) || /holscience\.com/.test(u);
  const g = guides.clean({ steps: [{ title: 'a', text: 'b', links: [{ label: 'Known', url: 'https://x.edu/nb' }, { label: 'Guessed', url: 'https://www.ptable.com/' }, { label: 'SI', url: 'https://myhol.holscience.com/lesson/9' }] }], submit: { what: 'x', url: 'https://x.edu/made-up' } }, known);
  assert.deepEqual(g.steps[0].links.map((l) => l.label), ['Known', 'SI']);
  assert.equal(g.submit.url, '');
});

test('work that unlocks the instructions is a step marked unlocks; an older answer’s gate becomes that first step', () => {
  const g = guides.clean({ steps: [{ title: 'Do the Exploration in SI', text: 'It unlocks the procedure.', unlocks: true }, { title: 'Prepare the notebook', text: 'Header and reagent table.', unlocks: 'yes' }] });
  assert.equal(g.steps[0].unlocks, true);
  assert.equal(g.steps[1].unlocks, undefined);
  assert.equal(g.gate, null);
  const old = guides.clean({ steps: [{ title: 'Prepare', text: 'Pages.' }], gate: { what: 'Take the Lab 9 pre-lab quiz', url: 'https://myhol.holscience.com/quiz/9', label: 'Open the pre-lab quiz' } });
  assert.equal(old.steps.length, 2);
  assert.deepEqual(old.steps[0], { title: 'Open the pre-lab quiz', text: 'Take the Lab 9 pre-lab quiz', detail: '', links: [{ label: 'Open the pre-lab quiz', url: 'https://myhol.holscience.com/quiz/9' }], unlocks: true });
});
