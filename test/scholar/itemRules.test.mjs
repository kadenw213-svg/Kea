// What each item offers (src/components/scholar/itemRules.ts), shared by the PC and the phone: buttons and links only
// where they fit the work, nothing lost, nothing on locked work, a hand-in line built from the button Kea shows, Study
// only where it helps, and the lab's parts tied together (electron/scholar/db.cjs relateItems).
// Run: node --test test/scholar/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { quickLink, panelLinks, handInText, platformLine, studyChapters, platformName, shorten, folderIdOf, typeLabel, willGuide, relatedText, isLocked } from '../../src/components/scholar/itemRules.ts';

const require = createRequire(import.meta.url);
require('../worker/electronStub.cjs');
const { relateItems } = require('../../electron/scholar/db.cjs')._test;

const item = (o) => ({ id: o.id || 'x', courseId: 'c1', courseCode: 'BIO111', type: 'assignment', title: 'Homework', date: '2026-11-10', dateEnd: null, start: null, end: null, due: '23:59', module: null, location: null, links: [], weeklyLinks: [], platformLinks: [], studyFocus: [], readings: [], ...o });
const D2L = 'https://d2l.example.edu/d2l';
const quizUrl = `${D2L}/lms/quizzing/user/quiz_summary.d2l?ou=1&qi=55`;
const topicUrl = `${D2L}/le/1/discussions/topics/77/View`;
const folderUrl = `${D2L}/lms/dropbox/user/folder_submit_files.d2l?db=905&ou=1`;

test('a discussion never gets a quiz button, and its quiz link shows nowhere', () => {
  const it = item({ type: 'discussion', title: 'Lab 7 Results Discussion', links: [{ kind: 'submit', label: 'Take the quiz', url: quizUrl }] });
  assert.equal(quickLink(it), null);
  assert.equal(panelLinks(it).rest.length, 0);
  const ok = item({ type: 'discussion', title: 'Discussion 6', links: [{ kind: 'submit', label: 'Post', url: topicUrl }, { kind: 'reference', label: 'Quiz 5', url: quizUrl }] });
  assert.equal(quickLink(ok).kind, 'discussion');
  assert.deepEqual(panelLinks(ok).rest, []);
});

test('a peer review keeps its only link: its Canvas assignment page is its button', () => {
  const it = item({ type: 'peer_review', title: 'Peer Review: Essay 2 Draft', links: [{ kind: 'submit', label: 'Submit', url: 'https://canvas.example.edu/courses/88/assignments/302' }] });
  const q = quickLink(it);
  assert.equal(q.label, 'Peer review');
  assert.match(handInText(it).text, /review/);
});

test('a hand-in link that doesn’t fit as the button is kept under More, never dropped', () => {
  // A paper whose submit link is a discussion topic but whose title doesn't say "discussion".
  const it = item({ type: 'paper', title: 'Reflection paper', links: [{ kind: 'submit', label: 'Submit', url: topicUrl }] });
  assert.equal(quickLink(it), null);
  const { rest } = panelLinks(it);
  assert.equal(rest.length, 1);
  assert.equal(rest[0].group, 'other');
  // A test whose submit link is a discussion.
  const t = item({ type: 'quiz', title: 'Quiz 3', links: [{ kind: 'submit', label: 'Submit', url: topicUrl }] });
  assert.equal(quickLink(t), null);
  assert.equal(panelLinks(t).rest.length, 1);
});

test('the main button is never repeated in the links below it', () => {
  const it = item({ title: 'Essay 2', links: [{ kind: 'submit', label: 'Hand-in folder', url: folderUrl }, { kind: 'reference', label: 'Prompt (PDF)', url: `${D2L}/content/prompt.pdf` }] });
  const p = panelLinks(it);
  assert.equal(p.quick.url, folderUrl);
  assert.equal(p.doc.url, `${D2L}/content/prompt.pdf`);
  assert.deepEqual(p.rest, []);
});

test('locked work has no buttons at all and says when it opens', () => {
  const it = item({ title: 'Homework 6', opensAt: new Date(Date.now() + 3 * 864e5).toISOString(), links: [{ kind: 'submit', label: 'Folder', url: folderUrl }], readings: [{ chapter: 'Chapter 11', title: null, pdf: null }] });
  assert.equal(isLocked(it), true);
  assert.equal(quickLink(it), null);
  const p = panelLinks(it);
  assert.equal(p.doc, null);
  assert.equal(p.rest.length + p.platforms.length, 0);
  assert.equal(handInText(it).opens, true);
  assert.deepEqual(studyChapters(it), []);
});

test('a lab discussion is posted in its topic, never "Hand in: on Science Interactive"', () => {
  const si = { kind: 'platform', label: 'Open Science Interactive', url: 'https://scienceinteractive.com/lab/9' };
  const it = item({ type: 'discussion', title: 'Lab 9 Discussion: Buffer capacity', links: [{ kind: 'submit', label: 'Post', url: topicUrl }], platformLinks: [si] });
  assert.match(handInText(it).text, /post in the discussion/);
  assert.equal(platformLine(it), 'About the lab on: Science Interactive');
  // With no topic found yet: still never the platform.
  const bare = item({ type: 'discussion', title: 'Lab 9 Discussion', platformLinks: [si] });
  assert.equal(quickLink(bare), null);
  assert.doesNotMatch(handInText(bare).text, /Science Interactive/);
});

test('in-class tests say where they’re taken; reminders never say "hidden or locked"', () => {
  const exam = item({ type: 'exam', title: 'Exam 2', start: '09:00', location: 'PPSC Rampart Range Campus, E112' });
  assert.equal(handInText(exam).text, 'Taken in class, E112');
  const prac = item({ type: 'lab_practical', title: 'Lab Practical 1', start: '13:00', location: 'Room 205' });
  assert.equal(handInText(prac).text, 'Taken in class, Room 205');
  assert.equal(handInText(item({ type: 'other_deadline', title: 'Bring lab coat and goggles' })), null);
  assert.match(handInText(item({ title: 'Homework 5' })).text, /hidden or locked/);
});

test('a platform is named, never cut mid-word, and named once', () => {
  const m = { kind: 'platform', label: 'Open Mastering Physics: Chapter 4 Homework', url: 'https://mastering.pearson.com/x' };
  const it = item({ title: 'Mastering Physics: Chapter 4 Homework', platformLinks: [m] });
  assert.equal(quickLink(it).label, 'Mastering');
  assert.equal(platformLine(it), null, 'the hand-in line already names it');
  assert.equal(handInText(it).text, 'Done on Mastering: the button below opens it');
  assert.equal(platformName('connect your thoughts to the reading'), null);
  assert.equal(platformName('https://connect.mheducation.com/class/x'), 'Connect');
  for (const [s, n] of [['MyLab Math', 'MyLab'], ['WileyPLUS', 'WileyPLUS'], ['MindTap', 'MindTap'], ['Macmillan Achieve', 'Achieve'], ['ALEKS', 'ALEKS']]) assert.equal(platformName(s), n);
  assert.equal(shorten('Mastering Physics: Chapter 4 Homework', 22), 'Mastering Physics…');
});

test('Study only where practice helps, and only on the item’s own chapters', () => {
  const ch = (chapter, o = {}) => ({ chapter, title: null, pdf: null, ...o });
  assert.deepEqual(studyChapters(item({ type: 'exam', title: 'Exam 2', readings: [ch('Chapter 8'), ch('Chapter 9')] })), ['Chapter 8', 'Chapter 9']);
  assert.deepEqual(studyChapters(item({ type: 'other_deadline', title: 'Bring lab coat and goggles', readings: [ch('Chapter 10', { inferred: true })] })), []);
  assert.deepEqual(studyChapters(item({ type: 'lab_handout', title: 'Lab 7 Handout', readings: [ch('Chapter 10')] })), []);
  assert.deepEqual(studyChapters(item({ type: 'paper', readings: [ch('Chapter 2')] })), []);
  assert.deepEqual(studyChapters(item({ title: 'Homework 5: Mendelian genetics', readings: [ch('Chapter 10', { inferred: true })] })), [], 'a week’s chapter is a guess');
  assert.deepEqual(studyChapters(item({ title: 'Chapter 4 Homework', readings: [ch('Chapter 4', { unlisted: true })] })), [], 'no textbook for the class');
});

test('the hand-in folder id comes from the link Kea already has', () => {
  assert.equal(folderIdOf(folderUrl), '905');
  assert.equal(folderIdOf('https://canvas.example.edu/courses/88/assignments/301'), '301');
  assert.equal(folderIdOf('https://example.edu/page'), null);
});

test('kinds always read as words, guides are promised only where they’ll be written', () => {
  assert.equal(typeLabel({ type: 'pre_lab_quiz', title: '' }), 'Pre-lab quiz');
  assert.equal(typeLabel({ type: 'some_new_kind', title: '' }), 'Some new kind');
  const now = new Date('2026-11-07T12:00:00');
  assert.equal(willGuide(item({ type: 'reading' }), now), false);
  assert.equal(willGuide(item({ type: 'other_deadline' }), now), false);
  assert.equal(willGuide(item({ date: '2026-11-01' }), now), false, 'past and not known to be missing');
  assert.equal(willGuide(item({ date: '2026-11-01', handIn: 'not_submitted' }), now), true);
  assert.equal(willGuide(item({ date: '2026-11-09' }), now), true);
});

test('a lab’s parts are tied together by its number, in the lab’s order', () => {
  const list = [
    item({ id: 'pre', type: 'pre_lab_quiz', title: 'Pre-lab Quiz 7', date: '2026-11-11' }),
    item({ id: 'hand', type: 'lab_handout', title: 'Lab 7 Handout', date: '2026-11-12' }),
    item({ id: 'sess', type: 'lab', title: 'Lab 7: Enzyme Activity', date: '2026-11-12', start: '13:00' }),
    item({ id: 'bring', type: 'other_deadline', title: 'Bring lab coat and goggles', date: '2026-11-12' }),
    item({ id: 'rep', type: 'assignment', title: 'Lab 7 Report', date: '2026-11-19' }),
    item({ id: 'disc', type: 'discussion', title: 'Lab 7 Results Discussion', date: '2026-11-20' }),
    item({ id: 'other', type: 'lab', title: 'Lab 8: Photosynthesis', date: '2026-11-19', start: '13:00' }),
    item({ id: 'prac', type: 'lab_practical', title: 'Lab Practical 1', date: '2026-11-13' }),
    item({ id: 'chm', courseId: 'c2', type: 'assignment', title: 'Lab report #9: Using Buffers', date: '2026-11-10' }),
    item({ id: 'oa', courseId: 'c2', type: 'assignment', title: 'Online Assignment 9: Buffers', date: '2026-11-09' }),
    item({ id: 'd1', type: 'discussion', title: 'Discussion 6 - Initial Post', date: '2026-11-05' }),
    item({ id: 'd2', type: 'discussion', title: 'Discussion 6 - Replies', date: '2026-11-08' })
  ];
  relateItems(list);
  const by = Object.fromEntries(list.map((i) => [i.id, i]));
  assert.deepEqual(by.sess.related.map((r) => r.id), ['pre', 'hand', 'bring', 'rep', 'disc']);
  assert.equal(by.sess.related[0].group, 'Lab 7');
  assert.ok(by.disc.related.some((r) => r.id === 'rep'), 'the results discussion goes with the report');
  assert.ok(!by.sess.related.some((r) => r.id === 'other' || r.id === 'prac'));
  assert.ok(by.oa.related.some((r) => r.id === 'chm'), 'a topic word ties the online assignment to the lab report');
  assert.deepEqual(by.d1.related.map((r) => r.id), ['d2']);
  assert.equal(relatedText(by.d1.related[0]).prefix, 'Replies: ');
  assert.equal(relatedText(by.d1.related[0]).title, 'Discussion 6');
});
