// The estimated grade (src/lib/gradeEstimate.ts): rubric rows from the scanned assignment, the prompt Claude gets,
// reading its answer (the rubric's own criteria and points win), the letter grade, and the cached result.
//   node --test test/office/gradeEstimate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rubricRows, buildGradePrompt, parseGradeAnswer, letterGrade, totalOf, textHash, gradeKey, readCached, checkedAgo, makeEstimate, GRADE_SYSTEM } from '../../src/lib/gradeEstimate.ts';

const guide = {
  rubric: {
    name: 'Essay rubric',
    total: 50,
    levels: ['Excellent', 'Good', 'Needs work'],
    criteria: [
      { name: 'Thesis', cells: [{ points: 20, text: 'Clear, arguable thesis' }, { points: 14, text: 'Thesis present' }, { points: 6, text: 'No thesis' }] },
      { name: 'Evidence', cells: [{ points: 20, text: 'Well chosen' }, { points: 12, text: 'Some' }, { points: 4, text: 'None' }] },
      { name: 'Mechanics', cells: [{ points: 10, text: 'Few errors' }, { points: null, text: '' }, { points: 2, text: 'Many errors' }] }
    ]
  }
};
const rows = rubricRows(guide);

test('rubric rows come from the scanned rubric: each criterion with its top points and level wording', () => {
  assert.deepEqual(rows.map((r) => [r.criterion, r.possible]), [['Thesis', 20], ['Evidence', 20], ['Mechanics', 10]]);
  assert.match(rows[0].levels, /Excellent \(20\): Clear, arguable thesis/);
  assert.doesNotMatch(rows[2].levels, /Good/);
  // A guide's graded list counts when it gives points; without points or anything, there's no rubric.
  assert.deepEqual(rubricRows({ graded: [{ criterion: 'Lab report', points: 30, how: 'Complete' }] }), [{ criterion: 'Lab report', possible: 30, levels: 'Complete' }]);
  assert.deepEqual(rubricRows({ graded: [{ criterion: 'Participation', points: null, how: 'Show up' }] }), []);
  assert.deepEqual(rubricRows(null), []);
});

test('the prompt carries the rubric rows, the document, and asks for JSON only', () => {
  const p = buildGradePrompt({ title: 'ENG 101 · Essay 2', noun: 'document', mode: 'rubric', rows, text: 'My essay argues that…' });
  assert.match(p, /Assignment: ENG 101 · Essay 2/);
  assert.match(p, /1\. Thesis — 20 points/);
  assert.match(p, /3\. Mechanics — 10 points/);
  assert.match(p, /<<<\nMy essay argues that…\n>>>/);
  assert.match(p, /JSON only/);
  assert.match(GRADE_SYSTEM, /Use no tools/);
  // Without a rubric: a rough estimate from the instructions, clearly asked as such.
  const rough = buildGradePrompt({ title: 'Lab 3', noun: 'presentation', mode: 'instructions', instructions: 'Present your findings in 5 slides.', text: 'Slide 1:\nFindings' });
  assert.match(rough, /There is no rubric\. Make a rough estimate/);
  assert.match(rough, /Present your findings in 5 slides\./);
  assert.match(rough, /student's presentation/);
  // A long file is cut, and said so.
  const long = buildGradePrompt({ title: 'x', noun: 'document', mode: 'rubric', rows, text: 'a'.repeat(500), maxChars: 100 });
  assert.match(long, /the rest of the document was cut off/);
});

test('Claude’s answer is read even inside a code block; the rubric’s criteria and points win', () => {
  const answer = 'Here you go:\n```json\n{"rows":[{"criterion":"Thesis","earned":17,"possible":25,"reason":"Clear but a little broad."},{"criterion":"evidence","earned":30,"possible":20,"reason":"Strong quotes."},{"criterion":"Mechanics","earned":"7","possible":10,"reason":"A few comma splices."}]}\n```';
  const got = parseGradeAnswer(answer, rows);
  assert.deepEqual(got.map((r) => [r.criterion, r.earned, r.possible]), [['Thesis', 17, 20], ['Evidence', 20, 20], ['Mechanics', 7, 10]]);
  assert.equal(got[2].reason, 'A few comma splices.');
  // A row missing, or nothing readable: no estimate (never a made-up one).
  assert.equal(parseGradeAnswer('{"rows":[{"criterion":"Thesis","earned":10,"possible":20}]}', rows), null);
  assert.equal(parseGradeAnswer('I think it is a B.', rows), null);
  // Rough (no rubric): Claude's own rows are kept, with earned kept within possible.
  const rough = parseGradeAnswer('{"rows":[{"criterion":"Covers the findings","earned":-3,"possible":50,"reason":"Missing."},{"criterion":"Five slides","earned":50,"possible":50,"reason":"Yes."}]}');
  assert.deepEqual(rough.map((r) => r.earned), [0, 50]);
});

test('the total is added up from the rows, with the usual letter', () => {
  const t = totalOf([{ criterion: 'a', earned: 17, possible: 20, reason: '' }, { criterion: 'b', earned: 18, possible: 20, reason: '' }, { criterion: 'c', earned: 8.8, possible: 10, reason: '' }]);
  assert.deepEqual(t, { earned: 43.8, possible: 50, percent: 88, letter: 'B+' });
  assert.equal(letterGrade(87), 'B+');
  assert.equal(letterGrade(93), 'A');
  assert.equal(letterGrade(59), 'F');
  assert.equal(totalOf([]).percent, 0);
});

test('the estimate is cached with the file and the assignment, and knows when the file changed', () => {
  const est = makeEstimate({ answer: '{"rows":[{"criterion":"Thesis","earned":18,"possible":20,"reason":"ok"},{"criterion":"Evidence","earned":17,"possible":20,"reason":"ok"},{"criterion":"Mechanics","earned":9,"possible":10,"reason":"ok"}]}', rows, rough: false, docText: 'My essay.', assignment: 'id:42', at: 1000 });
  assert.equal(est.letter, 'B+');
  assert.equal(est.percent, 88);
  assert.equal(est.rough, false);
  assert.equal(est.docHash, textHash('My  essay.'), 'spacing alone isn’t a change');
  assert.notEqual(est.docHash, textHash('My essay, revised.'));
  assert.equal(gradeKey('C:/x/essay.docx', 'id:42'), 'C:/x/essay.docx|id:42');
  // Read back: only for the same assignment, and never something damaged.
  const back = readCached(JSON.parse(JSON.stringify(est)), 'id:42');
  assert.deepEqual(back, est);
  assert.equal(readCached(est, 'id:43'), null);
  assert.equal(readCached({ rows: 'x' }, 'id:42'), null);
  assert.equal(readCached(undefined, 'id:42'), null);
  // An answer that can't be read gives no estimate.
  assert.equal(makeEstimate({ answer: 'no idea', rows, rough: false, docText: '', assignment: 'id:42' }), null);
});

test('when it was checked reads plainly', () => {
  const now = 10_000_000_000;
  assert.equal(checkedAgo(now - 5_000, now), 'just now');
  assert.equal(checkedAgo(now - 4 * 60_000, now), '4 min ago');
  assert.equal(checkedAgo(now - 2 * 3600_000, now), '2 h ago');
  assert.equal(checkedAgo(now - 30 * 3600_000, now), 'yesterday');
  assert.equal(checkedAgo(now - 5 * 86400_000, now), '5 days ago');
});
