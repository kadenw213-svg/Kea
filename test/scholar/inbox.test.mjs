import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inboxParts } from '../../src/components/scholar/inboxFormat.ts';

test('an announcement link button is named after the words just before it, never the whole sentence', () => {
  const p = inboxParts({ id: 'a', kind: 'announcement', title: 'Lab 7', body: 'Lab 7 this week meets in E114. Bring goggles. Handout: https://d2l.example.edu/content/lab7.pdf', at: '', read: false });
  assert.deepEqual(p.links.map((l) => l.label), ['Handout']);
  const q = inboxParts({ id: 'b', kind: 'announcement', title: 'x', body: 'Submit here: https://d2l.example.edu/d2l/lms/dropbox/folder_submit_files.d2l?db=1', at: '', read: false });
  assert.equal(q.links[0].label, 'Assignment');
});
