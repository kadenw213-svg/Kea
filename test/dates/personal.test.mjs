// The student's own due dates read from their D2L Assignments and Quizzes pages (electron/scholar/personalDates.cjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pd = require('../../electron/scholar/personalDates.cjs');

// The class's dates, as D2L's data API gives them (UTC), for times on this computer's clock.
const iso = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).toISOString();
const row = (id, name, due) =>
  `<tr><th><a class="d2l-link" href="/d2l/lms/dropbox/user/folder_submit_files.d2l?db=${id}&amp;grpid=0&amp;isprv=0&amp;bp=0&amp;ou=1">${name}</a>` +
  `<div class="d2l-dates-text"><span>${due}</span></div></th><td><a href="/d2l/lms/dropbox/user/folder_submit_files.d2l?db=${id}&amp;ou=1">Not Submitted</a></td></tr>`;

test('reads each row\'s own "Due on" date', () => {
  const html = `<table>${row(1, 'Lab 4', 'Due on Nov 7, 2026 23:59')}${row(2, 'Lab 5', '')}${row(3, 'Lab 6', 'Due on November 14, 2026 11:59 PM')}</table>`;
  const got = pd.parseList(html, 'dropbox');
  assert.deepEqual(Object.keys(got).sort(), ['1', '3']);
  assert.equal(got[1].getTime(), new Date(2026, 10, 7, 23, 59).getTime());
  assert.equal(got[3].getTime(), new Date(2026, 10, 14, 23, 59).getTime());
});

test('an extension moves only that folder, keeping the class date', () => {
  const data = [
    { Id: 1, Name: 'Lab 4', DueDate: iso(2026, 10, 31, 23, 59) },
    { Id: 2, Name: 'Lab 5', DueDate: iso(2026, 11, 7, 23, 59) },
    { Id: 3, Name: 'Lab 6', DueDate: iso(2026, 11, 14, 23, 59) }
  ];
  const html = row(1, 'Lab 4', 'Due on Nov 7, 2026 23:59') + row(2, 'Lab 5', 'Due on Nov 7, 2026 23:59') + row(3, 'Lab 6', 'Due on Nov 14, 2026 23:59');
  const found = pd.apply('dropbox', data, html);
  assert.equal(found.length, 1);
  assert.equal(found[0].id, 1);
  assert.equal(data[0].KeaGeneralDue, iso(2026, 10, 31, 23, 59));
  assert.equal(data[0].DueDate, iso(2026, 11, 7, 23, 59));
  assert.equal(data[1].KeaGeneralDue, undefined);
});

test('seconds in the class date are not an extension', () => {
  const data = [{ Id: 1, DueDate: new Date(2026, 9, 31, 23, 59, 59).toISOString() }, { Id: 2, DueDate: iso(2026, 11, 7, 23, 59) }];
  assert.deepEqual(pd.apply('dropbox', data, row(1, 'a', 'Due on Oct 31, 2026 23:59') + row(2, 'b', 'Due on Nov 7, 2026 23:59')), []);
});

test("a site clock in another time zone isn't read as extensions", () => {
  // Every row two hours later than this computer's clock: the site's time zone, not extensions.
  const data = [1, 2, 3].map((n) => ({ Id: n, DueDate: iso(2026, 11, n, 21, 59) }));
  const html = [1, 2, 3].map((n) => row(n, `x${n}`, `Due on Nov ${n}, 2026 23:59`)).join('');
  assert.deepEqual(pd.apply('dropbox', data, html), []);
  // ... but one of them three days later still is one.
  const html2 = row(1, 'x1', 'Due on Nov 4, 2026 23:59') + row(2, 'x2', 'Due on Nov 2, 2026 23:59') + row(3, 'x3', 'Due on Nov 3, 2026 23:59');
  const found = pd.apply('dropbox', data, html2);
  assert.equal(found.length, 1);
  assert.equal(found[0].personal, iso(2026, 11, 4, 21, 59));
});

test('quizzes are matched by their quiz id', () => {
  const data = { Objects: [{ QuizId: 7, Name: 'Online Quiz 6', DueDate: iso(2026, 11, 15, 23, 59) }, { QuizId: 8, Name: 'Online Quiz 7', DueDate: iso(2026, 11, 29, 23, 59) }] };
  const q = (id, due) => `<tr><td><a href="/d2l/lms/quizzing/user/quiz_summary.d2l?qi=${id}&amp;ou=1">Quiz</a><div>${due}</div><div>Available on Nov 9, 2026 00:01</div></td></tr>`;
  const found = pd.apply('quizzes', data, q(7, 'Due on Nov 18, 2026 23:59') + q(8, 'Due on Nov 29, 2026 23:59'));
  assert.deepEqual(found.map((f) => f.id), [7]);
  assert.equal(data.Objects[0].DueDate, iso(2026, 11, 18, 23, 59));
});

test('a page with no dates changes nothing', () => {
  const data = [{ Id: 1, DueDate: iso(2026, 11, 7, 23, 59) }];
  assert.deepEqual(pd.apply('dropbox', data, '<html><body>Sign in</body></html>'), []);
  assert.equal(data[0].KeaGeneralDue, undefined);
});
